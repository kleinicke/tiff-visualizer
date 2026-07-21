/**
 * Layer compositor for the GIMP-style layer stack.
 *
 * The compositor is intentionally framework-free and DOM-free so it can be
 * imported both by the webview and by Node-based unit tests. It works entirely
 * in float space: layers are combined into a single Float32Array which is then
 * handed to `ImageRenderer.render()` for visualization. Keeping everything in
 * one float buffer is what lets the pixel inspector, histogram, gamma and PNG
 * export keep working on the composite for free.
 *
 * Design decisions (see issue #2 discussion):
 *  - Arithmetic blend modes (add/subtract/difference/multiply/divide/min/max/
 *    average) operate on RAW float values, so `error = image - gt` is exact.
 *  - `normal` blends with per-layer opacity (display-style transparency).
 *  - Layers may have different sizes; they are positioned by a per-layer
 *    (offsetX, offsetY). The canvas size is provided by the caller (defaults to
 *    the background layer). Negative offsets / overhang are allowed.
 *  - A per-pixel coverage flag distinguishes "no layer overlaps here" (stays
 *    no-data) from "a layer has an actual NaN value here". NaN is transparent
 *    for `normal` (the layer below shows through) and propagates for arithmetic.
 */

export interface Layer {
	id?: string;
	name?: string;
	uri?: string;
	/** Source-document hierarchy metadata used by the Layers panel. */
	groupPath?: string[];
	groupIds?: string[];
	sourceNodeId?: string;
	sourceSupport?: 'native' | 'cached-raster' | 'approximate' | 'inspect-only' | 'unsupported';
	sourceBlendMode?: string;
	/** Raw pixel data (interleaved by channel). */
	data: ArrayLike<number>;
	width: number;
	height: number;
	/** 1, 3 or 4. RGBA alpha participates in normal display compositing. */
	channels: number;
	/** Whether the source was floating point. */
	isFloat?: boolean;
	/** 255 / 65535 / 1.0 — used for visualization. */
	typeMax?: number;
	/** Canvas x of the layer's left edge (may be negative). */
	offsetX?: number;
	/** Canvas y of the layer's top edge (may be negative). */
	offsetY?: number;
	/** 0..1, default 1. */
	opacity?: number;
	/** One of BLEND_MODES, default 'normal'. */
	blendMode?: string;
	/** Default true. */
	visible?: boolean;
	/** Only for blendMode 'mask'. */
	maskCondition?: { op: string; threshold?: number };
}

export interface CompositeResult {
	data: Float32Array;
	width: number;
	height: number;
	/** 1, 3 or 4. */
	channels: number;
	isFloat: boolean;
	typeMax: number;
	stats: { min: number; max: number };
	/** Number of pixels that had at least one layer. */
	coveredCount: number;
}

/**
 * Blend mode metadata. `arithmetic: true` means the mode combines raw float
 * values (NaN propagates); `arithmetic: false` is display-style alpha blending
 * (NaN is treated as transparent).
 */
export const BLEND_MODES: { id: string; label: string; arithmetic: boolean; mask?: boolean }[] = [
	{ id: 'normal', label: 'Normal', arithmetic: false },
	{ id: 'add', label: 'Add', arithmetic: true },
	{ id: 'subtract', label: 'Subtract', arithmetic: true },
	{ id: 'difference', label: 'Difference (|a − b|)', arithmetic: true },
	{ id: 'multiply', label: 'Multiply', arithmetic: true },
	{ id: 'divide', label: 'Divide', arithmetic: true },
	{ id: 'min', label: 'Darken (min)', arithmetic: true },
	{ id: 'max', label: 'Lighten (max)', arithmetic: true },
	{ id: 'average', label: 'Average', arithmetic: true },
	{ id: 'mask', label: 'Mask (hide below)', arithmetic: false, mask: true },
];

const BLEND_MODE_IDS = new Set(BLEND_MODES.map(m => m.id));
const ARITHMETIC_MODES = new Set(BLEND_MODES.filter(m => m.arithmetic).map(m => m.id));

/** Mask condition operators shown in the UI. */
export const MASK_CONDITIONS = [
	{ id: 'gt', label: '>', needsThreshold: true },
	{ id: 'ge', label: '≥', needsThreshold: true },
	{ id: 'lt', label: '<', needsThreshold: true },
	{ id: 'le', label: '≤', needsThreshold: true },
	{ id: 'eq', label: '=', needsThreshold: true },
	{ id: 'isfinite', label: 'is finite', needsThreshold: false },
	{ id: 'isnan', label: 'is NaN/Inf', needsThreshold: false },
];

export function isArithmeticMode(mode: string): boolean {
	return ARITHMETIC_MODES.has(mode);
}

/**
 * Evaluate a mask condition: returns true where the content below should be
 * KEPT (visible), false where it should be hidden.
 * @param v Mask layer value at the pixel.
 */
export function evalMaskCondition(v: number, cond: { op: string; threshold?: number } | undefined): boolean {
	if (!cond) { return true; }
	const t = cond.threshold ?? 0;
	switch (cond.op) {
		case 'gt': return v > t;
		case 'ge': return v >= t;
		case 'lt': return v < t;
		case 'le': return v <= t;
		case 'eq': return v === t;
		case 'isfinite': return Number.isFinite(v);
		case 'isnan': return !Number.isFinite(v);
		default: return true;
	}
}

/**
 * Combine two raw channel values according to a blend mode.
 * Callers handle coverage and opacity; this is the pure value combination.
 * @param below  Accumulated value beneath this layer.
 * @param src    This layer's value.
 */
export function blendValue(below: number, src: number, mode: string): number {
	switch (mode) {
		case 'add': return below + src;
		case 'subtract': return below - src;
		case 'difference': return Math.abs(below - src);
		case 'multiply': return below * src;
		case 'divide': return src === 0 ? NaN : below / src;
		case 'min': return Math.min(below, src);
		case 'max': return Math.max(below, src);
		case 'average': return (below + src) * 0.5;
		case 'normal':
		default:
			return src;
	}
}

/**
 * Determine the composite channel count: 3 if any visible layer is colour,
 * otherwise 1.
 */
function compositeChannels(visibleLayers: Layer[]): number {
	if (visibleLayers.some(layer => ARITHMETIC_MODES.has(layer.blendMode ?? 'normal'))) {
		return visibleLayers.some(layer => layer.channels >= 3) ? 3 : 1;
	}
	if (visibleLayers.some(layer => layer.channels === 4)) { return 4; }
	return visibleLayers.some(layer => layer.channels >= 3) ? 3 : 1;
}

/**
 * Read a layer's channel values at local pixel (lx, ly) into `out`, broadcasting
 * grayscale to colour and truncating colour-with-alpha to the composite channels.
 * @param out  Scratch array of length outChannels.
 */
function sampleLayer(layer: Layer, lx: number, ly: number, outChannels: number, out: Float32Array): void {
	const base = (ly * layer.width + lx) * layer.channels;
	if (layer.channels === 1) {
		const v = layer.data[base];
		for (let c = 0; c < outChannels; c++) out[c] = v;
	} else {
		for (let c = 0; c < outChannels; c++) {
			// If the layer has fewer channels than the composite, replicate the last.
			out[c] = layer.data[base + Math.min(c, layer.channels - 1)];
		}
	}
}

/**
 * Fast path for the overwhelmingly common interactive case: display-style
 * normal blending. Avoids per-pixel scratch arrays and per-channel dispatch.
 */
function compositeNormalLayerFast(layer: Layer, data: Float32Array, covered: Float32Array, outChannels: number, canvasWidth: number, xStart: number, yStart: number, xEnd: number, yEnd: number, offsetX: number, offsetY: number, opacity: number, coveredCount: number): number {
	const srcData = layer.data;
	const layerChannels = layer.channels;
	const opaque = opacity >= 1;

	if (outChannels === 4 && layerChannels >= 3) {
		for (let y = yStart; y < yEnd; y++) {
			let pixel = y * canvasWidth + xStart;
			let di = pixel * 4;
			let si = ((y - offsetY) * layer.width + (xStart - offsetX)) * layerChannels;
			for (let x = xStart; x < xEnd; x++, pixel++, di += 4, si += layerChannels) {
				const sourceAlpha = layerChannels === 4 ? Number(srcData[si + 3]) / (layer.typeMax || 255) : 1;
				const sa = Math.max(0, Math.min(1, sourceAlpha * opacity));
				if (sa <= 0) { continue; }
				const da = covered[pixel];
				const oa = sa + da * (1 - sa);
				const s0 = srcData[si], s1 = srcData[si + 1], s2 = srcData[si + 2];
				if (da <= 0) {
					data[di] = s0; data[di + 1] = s1; data[di + 2] = s2;
					coveredCount++;
				} else {
					data[di] = (s0 * sa + data[di] * da * (1 - sa)) / oa;
					data[di + 1] = (s1 * sa + data[di + 1] * da * (1 - sa)) / oa;
					data[di + 2] = (s2 * sa + data[di + 2] * da * (1 - sa)) / oa;
				}
				covered[pixel] = oa;
				data[di + 3] = oa; // normalized until the final typeMax is known
			}
		}
		return coveredCount;
	}

	if (outChannels === 1 && layerChannels === 1) {
		for (let y = yStart; y < yEnd; y++) {
			let pixel = y * canvasWidth + xStart;
			let si = (y - offsetY) * layer.width + (xStart - offsetX);
			for (let x = xStart; x < xEnd; x++, pixel++, si++) {
				const s = srcData[si];
				if (!covered[pixel]) {
					data[pixel] = s;
					covered[pixel] = 1;
					coveredCount++;
				} else if (Number.isFinite(s)) {
					const below = data[pixel];
					data[pixel] = opaque || !Number.isFinite(below)
						? s
						: below + (s - below) * opacity;
				}
			}
		}
		return coveredCount;
	}

	if (outChannels === 3 && layerChannels === 1) {
		for (let y = yStart; y < yEnd; y++) {
			let pixel = y * canvasWidth + xStart;
			let di = pixel * 3;
			let si = (y - offsetY) * layer.width + (xStart - offsetX);
			for (let x = xStart; x < xEnd; x++, pixel++, di += 3, si++) {
				const s = srcData[si];
				if (!covered[pixel]) {
					data[di] = s;
					data[di + 1] = s;
					data[di + 2] = s;
					covered[pixel] = 1;
					coveredCount++;
				} else if (Number.isFinite(s)) {
					if (opaque) {
						data[di] = s;
						data[di + 1] = s;
						data[di + 2] = s;
					} else {
						const b0 = data[di];
						const b1 = data[di + 1];
						const b2 = data[di + 2];
						data[di] = Number.isFinite(b0) ? b0 + (s - b0) * opacity : s;
						data[di + 1] = Number.isFinite(b1) ? b1 + (s - b1) * opacity : s;
						data[di + 2] = Number.isFinite(b2) ? b2 + (s - b2) * opacity : s;
					}
				}
			}
		}
		return coveredCount;
	}

	if (outChannels === 3 && layerChannels === 4) {
		for (let y = yStart; y < yEnd; y++) {
			let pixel = y * canvasWidth + xStart;
			let di = pixel * 3;
			let si = ((y - offsetY) * layer.width + (xStart - offsetX)) * 4;
			for (let x = xStart; x < xEnd; x++, pixel++, di += 3, si += 4) {
				const alpha = Math.max(0, Math.min(1, (Number(srcData[si + 3]) / (layer.typeMax || 255)) * opacity));
				if (alpha <= 0) { continue; }
				const s0 = srcData[si], s1 = srcData[si + 1], s2 = srcData[si + 2];
				if (!covered[pixel]) {
					data[di] = s0; data[di + 1] = s1; data[di + 2] = s2;
					covered[pixel] = 1; coveredCount++;
				} else {
					const b0 = data[di], b1 = data[di + 1], b2 = data[di + 2];
					data[di] = Number.isFinite(b0) ? b0 + (s0 - b0) * alpha : s0;
					data[di + 1] = Number.isFinite(b1) ? b1 + (s1 - b1) * alpha : s1;
					data[di + 2] = Number.isFinite(b2) ? b2 + (s2 - b2) * alpha : s2;
				}
			}
		}
		return coveredCount;
	}

	if (outChannels === 3 && layerChannels >= 3) {
		for (let y = yStart; y < yEnd; y++) {
			let pixel = y * canvasWidth + xStart;
			let di = pixel * 3;
			let si = ((y - offsetY) * layer.width + (xStart - offsetX)) * layerChannels;
			for (let x = xStart; x < xEnd; x++, pixel++, di += 3, si += layerChannels) {
				const s0 = srcData[si];
				const s1 = srcData[si + 1];
				const s2 = srcData[si + 2];
				if (!covered[pixel]) {
					data[di] = s0;
					data[di + 1] = s1;
					data[di + 2] = s2;
					covered[pixel] = 1;
					coveredCount++;
				} else if (opaque) {
					if (Number.isFinite(s0)) data[di] = s0;
					if (Number.isFinite(s1)) data[di + 1] = s1;
					if (Number.isFinite(s2)) data[di + 2] = s2;
				} else {
					if (Number.isFinite(s0)) {
						const b = data[di];
						data[di] = Number.isFinite(b) ? b + (s0 - b) * opacity : s0;
					}
					if (Number.isFinite(s1)) {
						const b = data[di + 1];
						data[di + 1] = Number.isFinite(b) ? b + (s1 - b) * opacity : s1;
					}
					if (Number.isFinite(s2)) {
						const b = data[di + 2];
						data[di + 2] = Number.isFinite(b) ? b + (s2 - b) * opacity : s2;
					}
				}
			}
		}
	}

	return coveredCount;
}

/**
 * Composite an ordered layer stack (index 0 = bottom / background) into a single
 * float buffer of the given canvas size.
 */
export function composite(layers: Layer[], canvasWidth: number, canvasHeight: number): CompositeResult {
	const visibleLayers = layers.filter(l => l && l.visible !== false && (l.opacity ?? 1) > 0 && l.data);
	const outChannels = visibleLayers.length ? compositeChannels(visibleLayers) : 1;
	const pixelCount = canvasWidth * canvasHeight;
	const data = new Float32Array(pixelCount * outChannels);
	data.fill(NaN); // No-data until covered.
	const covered = new Float32Array(pixelCount);

	const src = new Float32Array(outChannels);
	let coveredCount = 0;

	for (const layer of visibleLayers) {
		const offsetX = Math.round(layer.offsetX ?? 0);
		const offsetY = Math.round(layer.offsetY ?? 0);
		const opacity = Math.max(0, Math.min(1, layer.opacity ?? 1));
		const mode = BLEND_MODE_IDS.has(layer.blendMode ?? 'normal') ? (layer.blendMode ?? 'normal') : 'normal';
		const arithmetic = ARITHMETIC_MODES.has(mode);
		const isMask = mode === 'mask';
		const maskCondition = layer.maskCondition;

		// Canvas range that this layer overlaps.
		const xStart = Math.max(0, offsetX);
		const yStart = Math.max(0, offsetY);
		const xEnd = Math.min(canvasWidth, offsetX + layer.width);
		const yEnd = Math.min(canvasHeight, offsetY + layer.height);

		if (!arithmetic && !isMask && (outChannels === 1 || outChannels === 3 || outChannels === 4)) {
			coveredCount = compositeNormalLayerFast(layer, data, covered, outChannels, canvasWidth, xStart, yStart, xEnd, yEnd, offsetX, offsetY, opacity, coveredCount);
			continue;
		}

		for (let y = yStart; y < yEnd; y++) {
			const ly = y - offsetY;
			for (let x = xStart; x < xEnd; x++) {
				const lx = x - offsetX;
				const pixel = y * canvasWidth + x;
				sampleLayer(layer, lx, ly, outChannels, src);

				const di = pixel * outChannels;

				if (isMask) {
					// A mask layer never draws colour; it hides the content below
					// wherever its condition is false. With nothing below, it does
					// nothing.
					if (!covered[pixel]) { continue; }
					if (!evalMaskCondition(src[0], maskCondition)) {
						for (let c = 0; c < outChannels; c++) data[di + c] = NaN;
					}
					continue;
				}

				if (!covered[pixel]) {
					// First layer to reach this pixel establishes the base value;
					// there is nothing beneath to blend with, so opacity/mode are moot.
					for (let c = 0; c < outChannels; c++) data[di + c] = src[c];
					covered[pixel] = 1;
					coveredCount++;
					continue;
				}

				for (let c = 0; c < outChannels; c++) {
					const below = data[di + c];
					const s = src[c];
					if (arithmetic) {
						// Arithmetic: NaN propagates (standard float semantics).
						const result = blendValue(below, s, mode);
						data[di + c] = opacity >= 1
							? result
							: (Number.isFinite(result) && Number.isFinite(below))
								? below + (result - below) * opacity
								: NaN; // propagate NaN rather than letting NaN*0 leak.
					} else {
						// Normal: NaN in this layer is transparent (keep below).
						if (!Number.isFinite(s)) continue;
						data[di + c] = Number.isFinite(below)
							? below + (s - below) * opacity
							: s; // nothing valid below → take the layer value.
					}
				}
			}
		}
	}

	const base = visibleLayers[0];
	const isFloat = visibleLayers.some(l => l.isFloat) || visibleLayers.some(l => ARITHMETIC_MODES.has(l.blendMode ?? 'normal'));
	const typeMax = base?.typeMax ?? 1.0;
	if (outChannels === 4 && !isFloat) {
		for (let pixel = 0; pixel < pixelCount; pixel++) { data[pixel * 4 + 3] *= typeMax; }
	}

	// Composite statistics over finite color values (alpha does not affect range).
	let min = Infinity;
	let max = -Infinity;
	for (let i = 0; i < data.length; i++) {
		if (outChannels === 4 && i % 4 === 3) { continue; }
		const v = data[i];
		if (Number.isFinite(v)) {
			if (v < min) min = v;
			if (v > max) max = v;
		}
	}
	if (min === Infinity) { min = 0; max = 0; }

	return { data, width: canvasWidth, height: canvasHeight, channels: outChannels, isFloat, typeMax, stats: { min, max }, coveredCount };
}

/**
 * Default offset that centers a layer of the given size on the canvas.
 */
export function centeredOffset(layerWidth: number, layerHeight: number, canvasWidth: number, canvasHeight: number): { offsetX: number; offsetY: number } {
	return {
		offsetX: Math.round((canvasWidth - layerWidth) / 2),
		offsetY: Math.round((canvasHeight - layerHeight) / 2),
	};
}

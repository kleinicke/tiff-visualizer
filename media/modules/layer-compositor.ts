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
	/** First-class compositor node type. Raster is the backwards-compatible default. */
	kind?: 'raster' | 'group';
	/** Parent group id. Group children remain in the manager's ordered flat list. */
	parentId?: string;
	/** Source-document hierarchy metadata used by the Layers panel. */
	groupPath?: string[];
	groupIds?: string[];
	sourceNodeId?: string;
	sourceSupport?: 'native' | 'cached-raster' | 'approximate' | 'inspect-only' | 'unsupported';
	sourceBlendMode?: string;
	/** Raw pixel data (interleaved by channel). */
	data?: ArrayLike<number>;
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
	/** Restrict this node to the alpha of the nearest unclipped sibling below it. */
	clipped?: boolean;
	/** Non-destructive grayscale/alpha mask attached to this node. */
	rasterMask?: {
		data: ArrayLike<number>;
		width: number;
		height: number;
		channels?: number;
		typeMax?: number;
		offsetX?: number;
		offsetY?: number;
		invert?: boolean;
	};
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
	{ id: 'multiply', label: 'Multiply', arithmetic: false },
	{ id: 'screen', label: 'Screen', arithmetic: false },
	{ id: 'overlay', label: 'Overlay', arithmetic: false },
	{ id: 'darken', label: 'Darken', arithmetic: false },
	{ id: 'lighten', label: 'Lighten', arithmetic: false },
	{ id: 'difference', label: 'Difference', arithmetic: false },
	{ id: 'exclusion', label: 'Exclusion', arithmetic: false },
	{ id: 'add', label: 'Add', arithmetic: true },
	{ id: 'subtract', label: 'Subtract', arithmetic: true },
	{ id: 'raw-difference', label: 'Difference (raw)', arithmetic: true },
	{ id: 'raw-multiply', label: 'Multiply (raw)', arithmetic: true },
	{ id: 'divide', label: 'Divide', arithmetic: true },
	{ id: 'min', label: 'Darken (min)', arithmetic: true },
	{ id: 'max', label: 'Lighten (max)', arithmetic: true },
	{ id: 'average', label: 'Average', arithmetic: true },
	{ id: 'mask', label: 'Mask (hide below)', arithmetic: false, mask: true },
];

const BLEND_MODE_IDS = new Set(BLEND_MODES.map(m => m.id));
const ARITHMETIC_MODES = new Set(BLEND_MODES.filter(m => m.arithmetic).map(m => m.id));
const DOCUMENT_MODES = new Set(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'exclusion']);

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
		case 'difference':
		case 'raw-difference': return Math.abs(below - src);
		case 'raw-multiply': return below * src;
		case 'divide': return src === 0 ? NaN : below / src;
		case 'min': return Math.min(below, src);
		case 'max': return Math.max(below, src);
		case 'average': return (below + src) * 0.5;
		case 'normal':
		default:
			return src;
	}
}

/** Photoshop/OpenRaster-style blend math in the node's native value range. */
export function blendDocumentValue(below: number, src: number, mode: string, typeMax = 1): number {
	const max = Number.isFinite(typeMax) && typeMax > 0 ? typeMax : 1;
	switch (mode) {
		case 'multiply': return below * src / max;
		case 'screen': return max - ((max - below) * (max - src) / max);
		case 'overlay': return below <= max * 0.5
			? 2 * below * src / max
			: max - 2 * (max - below) * (max - src) / max;
		case 'darken': return Math.min(below, src);
		case 'lighten': return Math.max(below, src);
		case 'difference': return Math.abs(below - src);
		case 'exclusion': return below + src - 2 * below * src / max;
		case 'normal':
		default: return src;
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
	const layerData = layer.data!;
	if (layer.channels === 1) {
		const v = layerData[base];
		for (let c = 0; c < outChannels; c++) out[c] = v;
	} else {
		for (let c = 0; c < outChannels; c++) {
			// If the layer has fewer channels than the composite, replicate the last.
			out[c] = layerData[base + Math.min(c, layer.channels - 1)];
		}
	}
}

/**
 * Fast path for the overwhelmingly common interactive case: display-style
 * normal blending. Avoids per-pixel scratch arrays and per-channel dispatch.
 */
function compositeNormalLayerFast(layer: Layer, data: Float32Array, covered: Float32Array, outChannels: number, canvasWidth: number, xStart: number, yStart: number, xEnd: number, yEnd: number, offsetX: number, offsetY: number, opacity: number, coveredCount: number): number {
	const srcData = layer.data!;
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

function rasterMaskFactor(layer: Layer, canvasX: number, canvasY: number): number {
	const mask = layer.rasterMask;
	if (!mask) { return 1; }
	const mx = canvasX - Math.round(mask.offsetX ?? layer.offsetX ?? 0);
	const my = canvasY - Math.round(mask.offsetY ?? layer.offsetY ?? 0);
	if (mx < 0 || my < 0 || mx >= mask.width || my >= mask.height) { return mask.invert ? 1 : 0; }
	const channels = Math.max(1, mask.channels ?? 1);
	const value = Number(mask.data[(my * mask.width + mx) * channels]);
	let factor = Number.isFinite(value) ? value / (mask.typeMax || 255) : 0;
	factor = Math.max(0, Math.min(1, factor));
	return mask.invert ? 1 - factor : factor;
}

function sourceAlphaAt(layer: Layer, canvasX: number, canvasY: number): number {
	const lx = canvasX - Math.round(layer.offsetX ?? 0);
	const ly = canvasY - Math.round(layer.offsetY ?? 0);
	if (lx < 0 || ly < 0 || lx >= layer.width || ly >= layer.height || !layer.data) { return 0; }
	const base = (ly * layer.width + lx) * layer.channels;
	const alpha = layer.channels === 4 ? Number(layer.data[base + 3]) / (layer.typeMax || 255) : 1;
	return Math.max(0, Math.min(1, alpha * rasterMaskFactor(layer, canvasX, canvasY) * Math.max(0, Math.min(1, layer.opacity ?? 1))));
}

function layerAlphaSurface(layer: Layer, canvasWidth: number, canvasHeight: number): Float32Array {
	const alpha = new Float32Array(canvasWidth * canvasHeight);
	const xStart = Math.max(0, Math.round(layer.offsetX ?? 0));
	const yStart = Math.max(0, Math.round(layer.offsetY ?? 0));
	const xEnd = Math.min(canvasWidth, Math.round(layer.offsetX ?? 0) + layer.width);
	const yEnd = Math.min(canvasHeight, Math.round(layer.offsetY ?? 0) + layer.height);
	for (let y = yStart; y < yEnd; y++) for (let x = xStart; x < xEnd; x++) {
		alpha[y * canvasWidth + x] = sourceAlphaAt(layer, x, y);
	}
	return alpha;
}

/** Render group children to an isolated surface and replace each group with it. */
function materializeGroupSurfaces(layers: Layer[], canvasWidth: number, canvasHeight: number, parentId?: string, ancestors = new Set<string>()): Layer[] {
	const siblings = layers.filter(layer => (layer.parentId || undefined) === parentId);
	const output: Layer[] = [];
	for (const node of siblings) {
		if (node.kind !== 'group') {
			if (node.data) { output.push(node); }
			continue;
		}
		const id = node.id || '';
		if (!id || ancestors.has(id)) { continue; }
		const nextAncestors = new Set(ancestors); nextAncestors.add(id);
		const children = materializeGroupSurfaces(layers, canvasWidth, canvasHeight, id, nextAncestors);
		const surface = compositeFlat(children, canvasWidth, canvasHeight);
		if (surface.coveredCount === 0) { continue; }
		output.push({
			...node,
			kind: 'raster',
			parentId: undefined,
			data: surface.data,
			width: canvasWidth,
			height: canvasHeight,
			channels: surface.channels,
			isFloat: surface.isFloat,
			typeMax: surface.typeMax,
			offsetX: 0,
			offsetY: 0,
		});
	}
	return output;
}

function compositeFlat(layers: Layer[], canvasWidth: number, canvasHeight: number): CompositeResult {
	const visibleLayers = layers.filter(l => l && l.visible !== false && (l.opacity ?? 1) > 0 && l.data);
	const outChannels = visibleLayers.length ? compositeChannels(visibleLayers) : 1;
	const pixelCount = canvasWidth * canvasHeight;
	const data = new Float32Array(pixelCount * outChannels);
	data.fill(NaN);
	const covered = new Float32Array(pixelCount);
	const src = new Float32Array(outChannels);
	let coveredCount = 0;
	let clippingBase: Float32Array | null = null;

	for (let layerIndex = 0; layerIndex < visibleLayers.length; layerIndex++) {
		const layer = visibleLayers[layerIndex];
		const offsetX = Math.round(layer.offsetX ?? 0);
		const offsetY = Math.round(layer.offsetY ?? 0);
		const opacity = Math.max(0, Math.min(1, layer.opacity ?? 1));
		const mode = BLEND_MODE_IDS.has(layer.blendMode ?? 'normal') ? (layer.blendMode ?? 'normal') : 'normal';
		const arithmetic = ARITHMETIC_MODES.has(mode);
		const documentBlend = DOCUMENT_MODES.has(mode);
		const isMask = mode === 'mask';
		const xStart = Math.max(0, offsetX), yStart = Math.max(0, offsetY);
		const xEnd = Math.min(canvasWidth, offsetX + layer.width), yEnd = Math.min(canvasHeight, offsetY + layer.height);
		const clipSurface = layer.clipped ? clippingBase : null;

		if (layer.clipped && !clipSurface) { continue; }
		if (mode === 'normal' && !layer.rasterMask && !layer.clipped) {
			coveredCount = compositeNormalLayerFast(layer, data, covered, outChannels, canvasWidth, xStart, yStart, xEnd, yEnd, offsetX, offsetY, opacity, coveredCount);
		} else {
			for (let y = yStart; y < yEnd; y++) {
				const ly = y - offsetY;
				for (let x = xStart; x < xEnd; x++) {
					const lx = x - offsetX, pixel = y * canvasWidth + x, di = pixel * outChannels;
					sampleLayer(layer, lx, ly, outChannels, src);
					if (isMask) {
						if (covered[pixel] && !evalMaskCondition(src[0], layer.maskCondition)) {
							for (let c = 0; c < outChannels; c++) { data[di + c] = NaN; }
							covered[pixel] = 0; coveredCount--;
						}
						continue;
					}
					const maskAlpha = rasterMaskFactor(layer, x, y);
					const clippedAlpha = clipSurface ? clipSurface[pixel] : 1;
					if (arithmetic) {
						const effectiveOpacity = opacity * maskAlpha * clippedAlpha;
						if (effectiveOpacity <= 0) { continue; }
						if (!covered[pixel]) {
							for (let c = 0; c < outChannels; c++) { data[di + c] = src[c]; }
							covered[pixel] = 1; coveredCount++;
							continue;
						}
						for (let c = 0; c < outChannels; c++) {
							const below = data[di + c], result = blendValue(below, src[c], mode);
							data[di + c] = effectiveOpacity >= 1 ? result
								: Number.isFinite(result) && Number.isFinite(below) ? below + (result - below) * effectiveOpacity : NaN;
						}
						continue;
					}
					if (!documentBlend) { continue; }
					const sourceAlpha = sourceAlphaAt(layer, x, y) * clippedAlpha;
					if (sourceAlpha <= 0) { continue; }
					const destinationAlpha = covered[pixel];
					const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
					const colorChannels = outChannels === 4 ? 3 : outChannels;
					for (let c = 0; c < colorChannels; c++) {
						const s = src[c], below = data[di + c];
						if (!Number.isFinite(s)) { continue; }
						if (destinationAlpha <= 0 || !Number.isFinite(below)) { data[di + c] = s; continue; }
						const blended = blendDocumentValue(below, s, mode, layer.typeMax || visibleLayers[0]?.typeMax || 1);
						data[di + c] = ((1 - sourceAlpha) * destinationAlpha * below + (1 - destinationAlpha) * sourceAlpha * s + destinationAlpha * sourceAlpha * blended) / outputAlpha;
					}
					if (!destinationAlpha) { coveredCount++; }
					covered[pixel] = outputAlpha;
					if (outChannels === 4) { data[di + 3] = outputAlpha; }
				}
			}
		}

		if (!layer.clipped) {
			clippingBase = visibleLayers[layerIndex + 1]?.clipped ? layerAlphaSurface(layer, canvasWidth, canvasHeight) : null;
		}
	}

	const base = visibleLayers[0];
	const isFloat = visibleLayers.some(l => l.isFloat) || visibleLayers.some(l => ARITHMETIC_MODES.has(l.blendMode ?? 'normal'));
	const typeMax = base?.typeMax ?? 1.0;
	if (outChannels === 4 && !isFloat) {
		for (let pixel = 0; pixel < pixelCount; pixel++) { data[pixel * 4 + 3] *= typeMax; }
	}
	let min = Infinity, max = -Infinity;
	for (let i = 0; i < data.length; i++) {
		if (outChannels === 4 && i % 4 === 3) { continue; }
		const value = data[i];
		if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
	}
	if (min === Infinity) { min = 0; max = 0; }
	return { data, width: canvasWidth, height: canvasHeight, channels: outChannels, isFloat, typeMax, stats: { min, max }, coveredCount };
}

/** Composite an ordered stack (index 0 = bottom), including isolated groups. */
export function composite(layers: Layer[], canvasWidth: number, canvasHeight: number): CompositeResult {
	return compositeFlat(materializeGroupSurfaces(layers, canvasWidth, canvasHeight), canvasWidth, canvasHeight);
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

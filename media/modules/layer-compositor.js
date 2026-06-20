// @ts-check
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

/**
 * @typedef {Object} Layer
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [uri]
 * @property {ArrayLike<number>} data       Raw pixel data (interleaved by channel).
 * @property {number} width
 * @property {number} height
 * @property {number} channels              1, 3 or 4 (alpha is ignored in value space).
 * @property {boolean} [isFloat]            Whether the source was floating point.
 * @property {number} [typeMax]             255 / 65535 / 1.0 — used for visualization.
 * @property {number} [offsetX]             Canvas x of the layer's left edge (may be negative).
 * @property {number} [offsetY]             Canvas y of the layer's top edge (may be negative).
 * @property {number} [opacity]             0..1, default 1.
 * @property {string} [blendMode]           One of BLEND_MODES, default 'normal'.
 * @property {boolean} [visible]            Default true.
 * @property {{op:string, threshold?:number}} [maskCondition]  Only for blendMode 'mask'.
 * @property {string} [group]               Optional flat group name.
 * @property {number} [rawMin]              Finite source minimum, used by UI defaults.
 * @property {number} [rawMax]              Finite source maximum, used by UI defaults.
 * @property {boolean} [transformEnabled]   Whether to normalize this layer before blending.
 * @property {number} [transformMin]        Per-layer normalization input minimum.
 * @property {number} [transformMax]        Per-layer normalization input maximum.
 * @property {boolean} [transformInvert]    Invert the normalized layer value before blending.
 */

/**
 * @typedef {Object} CompositeResult
 * @property {Float32Array} data
 * @property {number} width
 * @property {number} height
 * @property {number} channels              1 or 3.
 * @property {boolean} isFloat
 * @property {number} typeMax
 * @property {{min:number,max:number}} stats
 * @property {number} coveredCount          Number of pixels that had at least one layer.
 */

/**
 * Blend mode metadata. `arithmetic: true` means the mode combines raw float
 * values (NaN propagates); `arithmetic: false` is display-style alpha blending
 * (NaN is treated as transparent).
 * @type {{id:string,label:string,arithmetic:boolean,mask?:boolean}[]}
 */
export const BLEND_MODES = [
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

/** @param {string} mode */
export function isArithmeticMode(mode) {
	return ARITHMETIC_MODES.has(mode);
}

/**
 * Evaluate a mask condition: returns true where the content below should be
 * KEPT (visible), false where it should be hidden.
 * @param {number} v Mask layer value at the pixel.
 * @param {{op:string, threshold?:number}|undefined} cond
 * @returns {boolean}
 */
export function evalMaskCondition(v, cond) {
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
 * @param {number} below  Accumulated value beneath this layer.
 * @param {number} src    This layer's value.
 * @param {string} mode
 * @returns {number}
 */
export function blendValue(below, src, mode) {
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
 * @param {Layer[]} visibleLayers
 */
function compositeChannels(visibleLayers) {
	return visibleLayers.some(l => l.channels >= 3) ? 3 : 1;
}

/**
 * Read a layer's channel values at local pixel (lx, ly) into `out`, broadcasting
 * grayscale to colour and truncating colour-with-alpha to the composite channels.
 * @param {Layer} layer
 * @param {number} lx
 * @param {number} ly
 * @param {number} outChannels
 * @param {Float32Array} out  Scratch array of length outChannels.
 */
function sampleLayer(layer, lx, ly, outChannels, out) {
	const base = (ly * layer.width + lx) * layer.channels;
	if (layer.channels === 1) {
		const v = transformLayerValue(layer, layer.data[base]);
		for (let c = 0; c < outChannels; c++) out[c] = v;
	} else {
		for (let c = 0; c < outChannels; c++) {
			// If the layer has fewer channels than the composite, replicate the last.
			out[c] = transformLayerValue(layer, layer.data[base + Math.min(c, layer.channels - 1)]);
		}
	}
}

/**
 * Apply the optional per-layer value transform before compositing.
 * @param {Layer} layer
 * @param {number} value
 * @returns {number}
 */
function transformLayerValue(layer, value) {
	if (!layer.transformEnabled || !Number.isFinite(value)) { return value; }
	const min = Number.isFinite(layer.transformMin) ? Number(layer.transformMin) : Number(layer.rawMin ?? 0);
	const max = Number.isFinite(layer.transformMax) ? Number(layer.transformMax) : Number(layer.rawMax ?? 1);
	const denom = max - min;
	let v = denom === 0 ? 0 : (value - min) / denom;
	if (v < 0) { v = 0; }
	else if (v > 1) { v = 1; }
	return layer.transformInvert ? 1 - v : v;
}

/**
 * Fast path for the overwhelmingly common interactive case: display-style
 * normal blending. Avoids per-pixel scratch arrays and per-channel dispatch.
 * @param {Layer} layer
 * @param {Float32Array} data
 * @param {Uint8Array} covered
 * @param {number} outChannels
 * @param {number} canvasWidth
 * @param {number} xStart
 * @param {number} yStart
 * @param {number} xEnd
 * @param {number} yEnd
 * @param {number} offsetX
 * @param {number} offsetY
 * @param {number} opacity
 * @param {number} coveredCount
 * @returns {number}
 */
function compositeNormalLayerFast(layer, data, covered, outChannels, canvasWidth, xStart, yStart, xEnd, yEnd, offsetX, offsetY, opacity, coveredCount) {
	const srcData = layer.data;
	const layerChannels = layer.channels;
	const opaque = opacity >= 1;
	const transform = layer.transformEnabled === true;

	if (outChannels === 1 && layerChannels === 1) {
		for (let y = yStart; y < yEnd; y++) {
			let pixel = y * canvasWidth + xStart;
			let si = (y - offsetY) * layer.width + (xStart - offsetX);
			for (let x = xStart; x < xEnd; x++, pixel++, si++) {
				const s = transform ? transformLayerValue(layer, srcData[si]) : srcData[si];
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
				const s = transform ? transformLayerValue(layer, srcData[si]) : srcData[si];
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

	if (outChannels === 3 && layerChannels >= 3) {
		for (let y = yStart; y < yEnd; y++) {
			let pixel = y * canvasWidth + xStart;
			let di = pixel * 3;
			let si = ((y - offsetY) * layer.width + (xStart - offsetX)) * layerChannels;
			for (let x = xStart; x < xEnd; x++, pixel++, di += 3, si += layerChannels) {
				const s0 = transform ? transformLayerValue(layer, srcData[si]) : srcData[si];
				const s1 = transform ? transformLayerValue(layer, srcData[si + 1]) : srcData[si + 1];
				const s2 = transform ? transformLayerValue(layer, srcData[si + 2]) : srcData[si + 2];
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
 *
 * @param {Layer[]} layers
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @returns {CompositeResult}
 */
export function composite(layers, canvasWidth, canvasHeight) {
	const visibleLayers = layers.filter(l => l && l.visible !== false && (l.opacity ?? 1) > 0 && l.data);
	const outChannels = visibleLayers.length ? compositeChannels(visibleLayers) : 1;
	const pixelCount = canvasWidth * canvasHeight;
	const data = new Float32Array(pixelCount * outChannels);
	data.fill(NaN); // No-data until covered.
	const covered = new Uint8Array(pixelCount);

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

		if (!arithmetic && !isMask && (outChannels === 1 || outChannels === 3)) {
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

	// Composite statistics over finite values.
	let min = Infinity;
	let max = -Infinity;
	for (let i = 0; i < data.length; i++) {
		const v = data[i];
		if (Number.isFinite(v)) {
			if (v < min) min = v;
			if (v > max) max = v;
		}
	}
	if (min === Infinity) { min = 0; max = 0; }

	const base = visibleLayers[0];
	const isFloat = visibleLayers.some(l => l.isFloat) || visibleLayers.some(l => ARITHMETIC_MODES.has(l.blendMode ?? 'normal'));
	const typeMax = base?.typeMax ?? 1.0;

	return { data, width: canvasWidth, height: canvasHeight, channels: outChannels, isFloat, typeMax, stats: { min, max }, coveredCount };
}

/**
 * Default offset that centers a layer of the given size on the canvas.
 * @param {number} layerWidth
 * @param {number} layerHeight
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @returns {{offsetX:number, offsetY:number}}
 */
export function centeredOffset(layerWidth, layerHeight, canvasWidth, canvasHeight) {
	return {
		offsetX: Math.round((canvasWidth - layerWidth) / 2),
		offsetY: Math.round((canvasHeight - layerHeight) / 2),
	};
}

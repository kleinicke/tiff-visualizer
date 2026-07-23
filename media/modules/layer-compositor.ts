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

export type AdjustmentChannel = { shadowInput?: number; highlightInput?: number; shadowOutput?: number; highlightOutput?: number; midtoneInput?: number } | { input: number; output: number }[];
export type MixerChannel = { red?: number; green?: number; blue?: number; constant?: number };
export type BalanceRange = { cyanRed?: number; magentaGreen?: number; yellowBlue?: number };
export type GradientStop = { position: number; color: { r: number; g: number; b: number } };
export type LayerAdjustment =
	| { type: 'levels'; rgb?: AdjustmentChannel; red?: AdjustmentChannel; green?: AdjustmentChannel; blue?: AdjustmentChannel }
	| { type: 'curves'; rgb?: AdjustmentChannel; red?: AdjustmentChannel; green?: AdjustmentChannel; blue?: AdjustmentChannel }
	| { type: 'hue/saturation'; master?: Record<string, number>; reds?: Record<string, number>; yellows?: Record<string, number>; greens?: Record<string, number>; cyans?: Record<string, number>; blues?: Record<string, number>; magentas?: Record<string, number>; colorize?: { hue: number; saturation: number; lightness: number }; colorizeEnabled?: boolean }
	| { type: 'brightness/contrast'; brightness?: number; contrast?: number; useLegacy?: boolean }
	| { type: 'exposure'; exposure?: number; offset?: number; gamma?: number }
	| { type: 'invert' }
	| { type: 'channel mixer'; monochrome?: boolean; red?: MixerChannel; green?: MixerChannel; blue?: MixerChannel; gray?: MixerChannel }
	| { type: 'color balance'; shadows?: BalanceRange; midtones?: BalanceRange; highlights?: BalanceRange; preserveLuminosity?: boolean }
	| { type: 'black & white'; reds?: number; yellows?: number; greens?: number; cyans?: number; blues?: number; magentas?: number }
	| { type: 'threshold'; level?: number }
	| { type: 'posterize'; levels?: number }
	| { type: 'gradient map'; stops?: GradientStop[]; reverse?: boolean };

export interface Layer {
	id?: string;
	name?: string;
	uri?: string;
	/** First-class compositor node type. Raster is the backwards-compatible default. */
	kind?: 'raster' | 'group' | 'adjustment';
	adjustment?: LayerAdjustment;
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
	{ id: 'mask', label: 'Brightness Mask', arithmetic: false, mask: true },
];

const BLEND_MODE_IDS = new Set(BLEND_MODES.map(m => m.id));
const ARITHMETIC_MODES = new Set(BLEND_MODES.filter(m => m.arithmetic).map(m => m.id));
const DOCUMENT_MODES = new Set(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'exclusion']);

/** Mask condition operators shown in the UI. */
export const MASK_CONDITIONS = [
	{ id: 'gt', label: 'brighter than', needsThreshold: true },
	{ id: 'ge', label: 'at least', needsThreshold: true },
	{ id: 'lt', label: 'darker than', needsThreshold: true },
	{ id: 'le', label: 'at most', needsThreshold: true },
	{ id: 'eq', label: 'equal to', needsThreshold: true },
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

/** Fast path for full-document RGBA creative layers using common blend modes. */
function compositeDocumentLayerFast(layer: Layer, data: Float32Array, covered: Float32Array, mode: string, opacity: number, coveredCount: number): number {
	const source = layer.data!, maximum = layer.typeMax || 255;
	for (let pixel = 0, offset = 0; pixel < covered.length; pixel++, offset += 4) {
		const sourceAlpha = Math.max(0, Math.min(1, Number(source[offset + 3]) / maximum * opacity));
		if (sourceAlpha <= 0) { continue; }
		const destinationAlpha = covered[pixel];
		const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
		if (destinationAlpha <= 0) {
			data[offset] = source[offset]; data[offset + 1] = source[offset + 1]; data[offset + 2] = source[offset + 2];
			coveredCount++;
		} else {
			for (let channel = 0; channel < 3; channel++) {
				const foreground = Number(source[offset + channel]), background = data[offset + channel];
				const blended = blendDocumentValue(background, foreground, mode, maximum);
				data[offset + channel] = ((1 - sourceAlpha) * destinationAlpha * background
					+ (1 - destinationAlpha) * sourceAlpha * foreground + destinationAlpha * sourceAlpha * blended) / outputAlpha;
			}
		}
		covered[pixel] = outputAlpha;
		data[offset + 3] = outputAlpha;
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
			if (node.data || (node.kind === 'adjustment' && node.adjustment)) { output.push(node); }
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
			offsetX: node.offsetX ?? 0,
			offsetY: node.offsetY ?? 0,
		});
	}
	return output;
}

export function evaluateCurvePoints(channel: { input: number; output: number }[], input: number): number {
	const points = channel.filter(point => Number.isFinite(point.input) && Number.isFinite(point.output)).sort((a, b) => a.input - b.input)
		.filter((point, index, all) => index === 0 || point.input !== all[index - 1].input);
	if (!points.length) { return input; }
	if (input <= points[0].input) { return points[0].output; }
	for (let index = 1; index < points.length; index++) if (input <= points[index].input) {
			const low = points[index - 1], high = points[index], span = high.input - low.input;
			if (!span) { return high.output; }
			const before = points[Math.max(0, index - 2)], after = points[Math.min(points.length - 1, index + 1)];
			const slope = (a: typeof low, b: typeof low) => (b.output - a.output) / Math.max(1e-6, b.input - a.input);
			const segmentSlope = slope(low, high);
			let lowTangent = index === 1 ? segmentSlope : (slope(before, low) + segmentSlope) / 2;
			let highTangent = index === points.length - 1 ? segmentSlope : (segmentSlope + slope(high, after)) / 2;
			// Photoshop-style smooth curves must remain monotone between monotone
			// control points; suppress spline overshoot around extrema.
			if (!segmentSlope || lowTangent * segmentSlope < 0) { lowTangent = 0; }
			if (!segmentSlope || highTangent * segmentSlope < 0) { highTangent = 0; }
			const t = (input - low.input) / span, t2 = t * t, t3 = t2 * t;
			const output = (2 * t3 - 3 * t2 + 1) * low.output + (t3 - 2 * t2 + t) * span * lowTangent
				+ (-2 * t3 + 3 * t2) * high.output + (t3 - t2) * span * highTangent;
			return Math.max(Math.min(low.output, high.output), Math.min(Math.max(low.output, high.output), output));
		}
	return points[points.length - 1].output;
}

function adjustmentCurve(value: number, channel: AdjustmentChannel | undefined, typeMax: number): number {
	if (!channel) { return value; }
	if (Array.isArray(channel)) {
		return evaluateCurvePoints(channel, value * 255 / typeMax) * typeMax / 255;
	}
	const input = value * 255 / typeMax;
	const low = channel.shadowInput ?? 0, high = channel.highlightInput ?? 255;
	const gamma = Math.max(0.01, channel.midtoneInput ?? 1);
	const normalized = Math.max(0, Math.min(1, (input - low) / Math.max(1e-6, high - low)));
	const outputLow = channel.shadowOutput ?? 0, outputHigh = channel.highlightOutput ?? 255;
	return (outputLow + Math.pow(normalized, 1 / gamma) * (outputHigh - outputLow)) * typeMax / 255;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
	const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
	let hue = 0; const lightness = (max + min) / 2;
	if (delta) { hue = 60 * (max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4); }
	const saturation = delta ? delta / (1 - Math.abs(2 * lightness - 1)) : 0;
	return [(hue + 360) % 360, saturation, lightness];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
	const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
	return [r + m, g + m, b + m];
}

function hueRangeWeight(hue: number, center: number): number {
	const distance = Math.abs(((hue - center + 540) % 360) - 180);
	return distance <= 30 ? 1 : distance >= 60 ? 0 : (60 - distance) / 30;
}

function configuredHueRangeWeight(hue: number, settings: Record<string, number> | undefined, fallbackCenter: number): number {
	if (!settings || !['a', 'b', 'c', 'd'].every(name => Number.isFinite(settings[name]))) { return hueRangeWeight(hue, fallbackCenter); }
	let a = settings.a, b = settings.b, c = settings.c, d = settings.d;
	while (b < a) { b += 360; } while (c < b) { c += 360; } while (d < c) { d += 360; }
	let weight = 0;
	for (let candidate = hue - 360; candidate <= hue + 720; candidate += 360) {
		if (candidate < a || candidate > d) { continue; }
		weight = Math.max(weight, candidate < b ? (candidate - a) / Math.max(1e-6, b - a)
			: candidate <= c ? 1 : (d - candidate) / Math.max(1e-6, d - c));
	}
	return Math.max(0, Math.min(1, weight));
}

type PreparedAdjustment = { kind: 'lut'; tables: Float32Array[] }
	| { kind: 'hue'; value: Extract<LayerAdjustment, { type: 'hue/saturation' }> }
	| { kind: 'direct'; value: Exclude<LayerAdjustment, { type: 'levels' | 'curves' | 'hue/saturation' }> };
const preparedAdjustmentCache = new WeakMap<object, Map<number, PreparedAdjustment>>();

function prepareAdjustment(adjustment: LayerAdjustment, typeMax: number): PreparedAdjustment {
	let byMaximum = preparedAdjustmentCache.get(adjustment as object);
	if (!byMaximum) { byMaximum = new Map(); preparedAdjustmentCache.set(adjustment as object, byMaximum); }
	const cached = byMaximum.get(typeMax);
	if (cached) { return cached; }
	let prepared: PreparedAdjustment;
	if (adjustment.type === 'levels' || adjustment.type === 'curves') {
		const names = ['red', 'green', 'blue'] as const;
		const tables = names.map(name => {
			const table = new Float32Array(256);
			for (let input = 0; input < 256; input++) {
				const value = input * typeMax / 255;
				table[input] = adjustmentCurve(adjustmentCurve(value, adjustment.rgb, typeMax), adjustment[name], typeMax);
			}
			return table;
		});
		prepared = { kind: 'lut', tables };
	} else if (adjustment.type === 'hue/saturation') { prepared = { kind: 'hue', value: adjustment }; }
	else { prepared = { kind: 'direct', value: adjustment }; }
	byMaximum.set(typeMax, prepared);
	return prepared;
}

function sampleAdjustmentLut(table: Float32Array, value: number, typeMax: number): number {
	const position = Math.max(0, Math.min(255, value * 255 / typeMax));
	const low = Math.floor(position), high = Math.min(255, low + 1), fraction = position - low;
	return table[low] + (table[high] - table[low]) * fraction;
}

function clampUnit(value: number): number { return Math.max(0, Math.min(1, value)); }

function sampleGradient(stops: GradientStop[] | undefined, value: number, reverse = false): [number, number, number] {
	const defaults: GradientStop[] = [{ position: 0, color: { r: 0, g: 0, b: 0 } }, { position: 1, color: { r: 255, g: 255, b: 255 } }];
	const sorted = (stops?.length ? stops : defaults).map(stop => ({ ...stop, position: clampUnit(stop.position) })).sort((a, b) => a.position - b.position);
	const position = reverse ? 1 - value : value;
	if (position <= sorted[0].position) { const color = sorted[0].color; return [color.r / 255, color.g / 255, color.b / 255]; }
	for (let index = 1; index < sorted.length; index++) if (position <= sorted[index].position) {
		const low = sorted[index - 1], high = sorted[index], amount = (position - low.position) / Math.max(1e-6, high.position - low.position);
		return [low.color.r + (high.color.r - low.color.r) * amount, low.color.g + (high.color.g - low.color.g) * amount,
			low.color.b + (high.color.b - low.color.b) * amount].map(channel => channel / 255) as [number, number, number];
	}
	const color = sorted[sorted.length - 1].color; return [color.r / 255, color.g / 255, color.b / 255];
}

function applyDirectAdjustment(adjustment: Extract<PreparedAdjustment, { kind: 'direct' }>['value'], red: number, green: number, blue: number): [number, number, number] {
	let r = red, g = green, b = blue;
	const luminance = () => 0.2126 * r + 0.7152 * g + 0.0722 * b;
	if (adjustment.type === 'brightness/contrast') {
		const brightness = (adjustment.brightness || 0) / 100, contrast = Math.max(-0.99, Math.min(0.99, (adjustment.contrast || 0) / 100));
		const factor = (1 + contrast) / (1 - contrast);
		r = (r - 0.5) * factor + 0.5 + brightness; g = (g - 0.5) * factor + 0.5 + brightness; b = (b - 0.5) * factor + 0.5 + brightness;
	} else if (adjustment.type === 'exposure') {
		const multiplier = Math.pow(2, adjustment.exposure || 0), offset = adjustment.offset || 0, gamma = Math.max(0.01, adjustment.gamma ?? 1);
		r = Math.pow(Math.max(0, r * multiplier + offset), 1 / gamma); g = Math.pow(Math.max(0, g * multiplier + offset), 1 / gamma); b = Math.pow(Math.max(0, b * multiplier + offset), 1 / gamma);
	} else if (adjustment.type === 'invert') { r = 1 - r; g = 1 - g; b = 1 - b; }
	else if (adjustment.type === 'channel mixer') {
		const mix = (channel: MixerChannel | undefined, fallback: MixerChannel) => {
			const value = channel || fallback;
			return r * (value.red ?? 0) / 100 + g * (value.green ?? 0) / 100 + b * (value.blue ?? 0) / 100 + (value.constant ?? 0) / 100;
		};
		if (adjustment.monochrome) { const gray = mix(adjustment.gray, { red: 40, green: 40, blue: 20 }); r = g = b = gray; }
		else [r, g, b] = [mix(adjustment.red, { red: 100 }), mix(adjustment.green, { green: 100 }), mix(adjustment.blue, { blue: 100 })];
	} else if (adjustment.type === 'color balance') {
		const originalLightness = rgbToHsl(r, g, b)[2], light = luminance();
		const weights = [{ value: adjustment.shadows, weight: clampUnit((0.5 - light) * 2) }, { value: adjustment.midtones, weight: 1 - Math.abs(light - 0.5) * 2 }, { value: adjustment.highlights, weight: clampUnit((light - 0.5) * 2) }];
		for (const { value, weight } of weights) if (value && weight > 0) {
			r += (value.cyanRed || 0) / 100 * weight; g += (value.magentaGreen || 0) / 100 * weight; b += (value.yellowBlue || 0) / 100 * weight;
		}
		if (adjustment.preserveLuminosity) { const [hue, saturation] = rgbToHsl(clampUnit(r), clampUnit(g), clampUnit(b)); [r, g, b] = hslToRgb(hue, saturation, originalLightness); }
	} else if (adjustment.type === 'black & white') {
		const [hue, saturation] = rgbToHsl(r, g, b), centers = [0, 60, 120, 180, 240, 300];
		const values = [adjustment.reds ?? 40, adjustment.yellows ?? 60, adjustment.greens ?? 40, adjustment.cyans ?? 60, adjustment.blues ?? 20, adjustment.magentas ?? 80];
		let weighted = 0, total = 0;
		for (let index = 0; index < centers.length; index++) { const weight = hueRangeWeight(hue, centers[index]); weighted += values[index] * weight; total += weight; }
		const gray = luminance() + (((total ? weighted / total : 50) - 50) / 100) * saturation * 0.5; r = g = b = gray;
	} else if (adjustment.type === 'threshold') { const value = luminance() * 255 >= (adjustment.level ?? 128) ? 1 : 0; r = g = b = value; }
	else if (adjustment.type === 'posterize') {
		const levels = Math.max(2, Math.min(255, Math.round(adjustment.levels ?? 4))), quantize = (value: number) => Math.round(value * (levels - 1)) / (levels - 1);
		r = quantize(r); g = quantize(g); b = quantize(b);
	} else if (adjustment.type === 'gradient map') { [r, g, b] = sampleGradient(adjustment.stops, clampUnit(luminance()), adjustment.reverse); }
	return [clampUnit(r), clampUnit(g), clampUnit(b)];
}

function applyAdjustmentPixel(data: Float32Array, index: number, channels: number, prepared: PreparedAdjustment, typeMax: number, amount: number): void {
	const colorChannels = channels === 4 ? 3 : channels;
	if (prepared.kind === 'lut') {
		for (let channel = 0; channel < colorChannels; channel++) {
			const original = data[index + channel], adjusted = sampleAdjustmentLut(prepared.tables[Math.min(channel, 2)], original, typeMax);
			data[index + channel] = original + (adjusted - original) * amount;
		}
		return;
	}
	if (prepared.kind === 'direct') {
		if (colorChannels >= 3) {
			const originalRed = data[index], originalGreen = data[index + 1], originalBlue = data[index + 2];
			const adjusted = applyDirectAdjustment(prepared.value, originalRed / typeMax, originalGreen / typeMax, originalBlue / typeMax);
			data[index] = originalRed + (adjusted[0] * typeMax - originalRed) * amount;
			data[index + 1] = originalGreen + (adjusted[1] * typeMax - originalGreen) * amount;
			data[index + 2] = originalBlue + (adjusted[2] * typeMax - originalBlue) * amount;
		}
		return;
	}
	if (colorChannels >= 3) {
		const adjustment = prepared.value;
		const originalRed = data[index], originalGreen = data[index + 1], originalBlue = data[index + 2];
		let [hue, saturation, lightness] = rgbToHsl(originalRed / typeMax, originalGreen / typeMax, originalBlue / typeMax);
		if (adjustment.colorize && adjustment.colorizeEnabled !== false) {
			hue = (adjustment.colorize.hue + 360) % 360;
			saturation = Math.max(0, Math.min(1, adjustment.colorize.saturation / 100));
			const delta = Math.max(-1, Math.min(1, adjustment.colorize.lightness / 100));
			lightness = delta < 0 ? lightness * (1 + delta) : lightness + (1 - lightness) * delta;
		} else {
			const sourceHue = hue;
			const apply = (settings: Record<string, number> | undefined, weight: number) => {
				if (!settings || weight <= 0) { return; }
				hue = (hue + (settings.hue || 0) * weight + 360) % 360;
				saturation = Math.max(0, Math.min(1, saturation + (settings.saturation || 0) / 100 * weight));
				lightness = Math.max(0, Math.min(1, lightness + (settings.lightness || 0) / 100 * weight));
			};
			apply(adjustment.master, 1);
			const ranges: [keyof typeof adjustment, number][] = [['reds', 0], ['yellows', 60], ['greens', 120], ['cyans', 180], ['blues', 240], ['magentas', 300]];
			for (const [name, center] of ranges) {
				const settings = adjustment[name] as Record<string, number> | undefined;
				apply(settings, configuredHueRangeWeight(sourceHue, settings, center));
			}
		}
		const rgb = hslToRgb(hue, saturation, lightness);
		const adjustedRed = rgb[0] * typeMax, adjustedGreen = rgb[1] * typeMax, adjustedBlue = rgb[2] * typeMax;
		data[index] = originalRed + (adjustedRed - originalRed) * amount;
		data[index + 1] = originalGreen + (adjustedGreen - originalGreen) * amount;
		data[index + 2] = originalBlue + (adjustedBlue - originalBlue) * amount;
	}
}

type LayerSnapshot = {
	layer: Layer; data: ArrayLike<number> | undefined; adjustment: LayerAdjustment | undefined;
	visible: boolean | undefined; opacity: number | undefined; blendMode: string | undefined;
	offsetX: number | undefined; offsetY: number | undefined; clipped: boolean | undefined;
	width: number; height: number; channels: number; typeMax: number | undefined;
	mask: Layer['rasterMask']; maskData: ArrayLike<number> | undefined;
};

type ClippingSurfaceCacheEntry = { snapshots: LayerSnapshot[]; width: number; height: number; surface: CompositeResult };
const clippingSurfaceCache = new WeakMap<Layer, ClippingSurfaceCacheEntry>();

function takeLayerSnapshot(layer: Layer, clippingBase = false): LayerSnapshot {
	return {
		layer, data: layer.data, adjustment: layer.adjustment, visible: clippingBase ? true : layer.visible, opacity: clippingBase ? 1 : layer.opacity,
		blendMode: clippingBase ? 'normal' : layer.blendMode, offsetX: layer.offsetX, offsetY: layer.offsetY, clipped: clippingBase ? false : layer.clipped,
		width: layer.width, height: layer.height, channels: layer.channels, typeMax: layer.typeMax,
		mask: layer.rasterMask, maskData: layer.rasterMask?.data,
	};
}

function snapshotsMatch(left: LayerSnapshot[], right: LayerSnapshot[]): boolean {
	if (left.length !== right.length) { return false; }
	for (let index = 0; index < left.length; index++) {
		const a = left[index], b = right[index];
		if (a.layer !== b.layer || a.data !== b.data || a.adjustment !== b.adjustment || a.visible !== b.visible || a.opacity !== b.opacity
			|| a.blendMode !== b.blendMode || a.offsetX !== b.offsetX || a.offsetY !== b.offsetY || a.clipped !== b.clipped
			|| a.width !== b.width || a.height !== b.height || a.channels !== b.channels || a.typeMax !== b.typeMax
			|| a.mask !== b.mask || a.maskData !== b.maskData) { return false; }
	}
	return true;
}

/**
 * Turn a base plus its contiguous clipped siblings into one reusable surface.
 * Adjustments therefore affect the base before the base blend mode is applied
 * to the parent stack, matching PSD clipping-group scope.
 */
function materializeClippingSurfaces(layers: Layer[], canvasWidth: number, canvasHeight: number): Layer[] {
	const output: Layer[] = [];
	for (let index = 0; index < layers.length;) {
		const base = layers[index];
		if (base.clipped || !base.data) { output.push(base); index++; continue; }
		let end = index + 1;
		while (end < layers.length && layers[end].clipped) { end++; }
		if (end === index + 1) { output.push(base); index++; continue; }
		const stack = layers.slice(index, end), snapshots = stack.map((layer, stackIndex) => takeLayerSnapshot(layer, stackIndex === 0));
		const cached = clippingSurfaceCache.get(base);
		let surface: CompositeResult;
		if (cached && cached.width === canvasWidth && cached.height === canvasHeight && snapshotsMatch(cached.snapshots, snapshots)) {
			surface = cached.surface;
		} else {
			const internalBase: Layer = { ...base, visible: true, opacity: 1, blendMode: 'normal', clipped: false };
			surface = compositePrepared([internalBase, ...stack.slice(1)], canvasWidth, canvasHeight);
			clippingSurfaceCache.set(base, { snapshots, width: canvasWidth, height: canvasHeight, surface });
		}
		output.push({
			...base,
			data: surface.data,
			width: canvasWidth,
			height: canvasHeight,
			channels: surface.channels,
			isFloat: surface.isFloat,
			typeMax: surface.typeMax,
			offsetX: 0,
			offsetY: 0,
			rasterMask: undefined,
			clipped: false,
		});
		index = end;
	}
	return output;
}

function compositeFlat(layers: Layer[], canvasWidth: number, canvasHeight: number): CompositeResult {
	return compositePrepared(materializeClippingSurfaces(layers, canvasWidth, canvasHeight), canvasWidth, canvasHeight);
}

function compositePrepared(layers: Layer[], canvasWidth: number, canvasHeight: number): CompositeResult {
	const visibleLayers = layers.filter(l => l && l.visible !== false && (l.opacity ?? 1) > 0 && (l.data || (l.kind === 'adjustment' && l.adjustment)));
	const outChannels = visibleLayers.length ? compositeChannels(visibleLayers) : 1;
	const pixelCount = canvasWidth * canvasHeight;
	const data = new Float32Array(pixelCount * outChannels);
	// Scientific scalar/RGB composites use NaN to represent uncovered no-data.
	// Authored RGBA documents have a distinct representation for the same area:
	// transparent black. Keeping the zero-initialized RGBA buffer preserves that
	// distinction for rendering, pixel inspection, and export.
	if (outChannels !== 4) { data.fill(NaN); }
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
		if (layer.kind === 'adjustment' && layer.adjustment) {
			const max = visibleLayers.find(candidate => candidate.data)?.typeMax || 255;
			const prepared = prepareAdjustment(layer.adjustment, max);
			for (let y = 0; y < canvasHeight; y++) for (let x = 0; x < canvasWidth; x++) {
				const pixel = y * canvasWidth + x;
				if (!covered[pixel]) { continue; }
				const amount = opacity * rasterMaskFactor(layer, x, y) * (clipSurface ? clipSurface[pixel] : 1);
				if (amount > 0) { applyAdjustmentPixel(data, pixel * outChannels, outChannels, prepared, max, amount); }
			}
			continue;
		}
		if (mode === 'normal' && !layer.rasterMask && !layer.clipped) {
			coveredCount = compositeNormalLayerFast(layer, data, covered, outChannels, canvasWidth, xStart, yStart, xEnd, yEnd, offsetX, offsetY, opacity, coveredCount);
		} else if (documentBlend && outChannels === 4 && layer.channels === 4 && !layer.rasterMask && !layer.clipped
			&& offsetX === 0 && offsetY === 0 && layer.width === canvasWidth && layer.height === canvasHeight) {
			coveredCount = compositeDocumentLayerFast(layer, data, covered, mode, opacity, coveredCount);
		} else {
			for (let y = yStart; y < yEnd; y++) {
				const ly = y - offsetY;
				for (let x = xStart; x < xEnd; x++) {
					const lx = x - offsetX, pixel = y * canvasWidth + x, di = pixel * outChannels;
					sampleLayer(layer, lx, ly, outChannels, src);
					if (isMask) {
						const maskValue = layer.channels >= 3
							? 0.2126 * src[0] + 0.7152 * src[1] + 0.0722 * src[2]
							: src[0];
						if (covered[pixel] && !evalMaskCondition(maskValue, layer.maskCondition)) {
							for (let c = 0; c < outChannels; c++) { data[di + c] = outChannels === 4 ? 0 : NaN; }
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
	const colorChannels = outChannels === 4 ? 3 : outChannels;
	for (let pixel = 0; pixel < pixelCount; pixel++) {
		// Transparent RGBA storage is finite zero, but it must not affect image
		// statistics any more than an uncovered NaN scientific pixel does.
		if (!covered[pixel]) { continue; }
		for (let channel = 0; channel < colorChannels; channel++) {
			const value = data[pixel * outChannels + channel];
			if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
		}
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

"use strict";

import { toScalarPlane, type MeasurementSource } from './types.js';
import { initWasm } from '../tiff-wasm-wrapper.js';

/**
 * Thresholding.
 *
 * All global methods operate on a 256-bin histogram of the scalar image and
 * return a **bin index**, which the caller maps back to a data value. Binning
 * is what makes the whole auto-threshold gallery affordable to recompute live:
 * the histogram is built once and every method is then a few hundred
 * operations, so eleven previews cost roughly one.
 *
 * The methods are the classical ones catalogued by Sezgin & Sankur and shipped
 * in ImageJ's Auto Threshold plugin; the implementations below follow those
 * published formulations so numbers are comparable with what users already
 * have.
 *
 * The compute cores (`buildHistogram`, `autoThresholdBin`, `globalThresholdMask`,
 * `localThresholdMask`, `localAutoThresholdMask`, `computeStabilityCurve`) live
 * in Rust (`wasm/tiff-decoder/src/measure/threshold.rs`): the local/window
 * methods run over the full image on every keystroke in the range fields, so
 * they are the hottest thing in the Measure panel. This file is now a thin
 * `async` delegation to that module, with NO TypeScript implementation left
 * behind for the ported functions.
 *
 * `binToValue`, `thresholdValueFromBin` and `valueToBin` stay in TypeScript:
 * they are O(1) scalar arithmetic called synchronously from canvas-drawing
 * code (the histogram widget, the stability-curve marker) on every render, and
 * making them `async` would only add a microtask hop with no compute to hide
 * it behind.
 */

export type ThresholdMethod =
	| 'otsu'
	| 'isodata'
	| 'li'
	| 'triangle'
	| 'yen'
	| 'huang'
	| 'maxEntropy'
	| 'mean'
	| 'moments'
	| 'percentile'
	| 'shanbhag'
	| 'minimum'
	| 'intermodes';

export const THRESHOLD_METHODS: { id: ThresholdMethod; label: string; hint: string }[] = [
	{ id: 'otsu', label: 'Otsu', hint: 'Maximises between-class variance. The safe default for bimodal data.' },
	{ id: 'isodata', label: 'IsoData', hint: 'Iterative midpoint between the two class means. ImageJ\'s "Default".' },
	{ id: 'li', label: 'Li', hint: 'Minimum cross-entropy. Good when the object is a small fraction of the frame.' },
	{ id: 'triangle', label: 'Triangle', hint: 'Geometric; strong when one peak dominates and objects are faint.' },
	{ id: 'yen', label: 'Yen', hint: 'Maximum correlation criterion. Tends to keep more of the object.' },
	{ id: 'huang', label: 'Huang', hint: 'Fuzzy-set measure. Tolerant of a broad background peak.' },
	{ id: 'maxEntropy', label: 'MaxEntropy', hint: 'Kapur-Sahoo-Wong entropy split. Favours faint structure.' },
	{ id: 'mean', label: 'Mean', hint: 'The image mean. Crude, but a useful sanity reference.' },
	{ id: 'moments', label: 'Moments', hint: 'Preserves the first three histogram moments.' },
	{ id: 'percentile', label: 'Percentile', hint: 'Assumes a fixed 50% foreground fraction.' },
	{ id: 'shanbhag', label: 'Shanbhag', hint: 'Information-measure variant of MaxEntropy.' },
	{ id: 'minimum', label: 'Minimum', hint: 'Valley between two peaks after smoothing. Needs a truly bimodal histogram.' },
	{ id: 'intermodes', label: 'Intermodes', hint: 'Midpoint between two peaks after smoothing.' },
];

export const HISTOGRAM_BINS = 256;

export interface ScalarHistogram {
	counts: Int32Array;
	min: number;
	max: number;
	/** Total finite samples binned. */
	total: number;
	nonFiniteCount: number;
}

/** Map a bin index back to the data value at the bin's lower edge. */
export function binToValue(histogram: ScalarHistogram, bin: number): number {
	if (histogram.max === histogram.min) { return histogram.min; }
	return histogram.min + (bin / HISTOGRAM_BINS) * (histogram.max - histogram.min);
}

/**
 * Turn a method's bin index into a usable cut value.
 *
 * Every method above returns the last bin that belongs to the *background*, so
 * the cut sits at that bin's upper edge — the convention ImageJ uses when it
 * says foreground is "> threshold". Using the lower edge instead would put the
 * cut on top of the background peak, and on a cleanly bimodal image (where
 * every split between the two modes scores identically and the first one wins)
 * that would select the entire image.
 */
export function thresholdValueFromBin(histogram: ScalarHistogram, bin: number): number {
	return binToValue(histogram, bin + 1);
}

/** Map a data value to its bin index. */
export function valueToBin(histogram: ScalarHistogram, value: number): number {
	if (histogram.max === histogram.min) { return 0; }
	const bin = Math.floor(((value - histogram.min) / (histogram.max - histogram.min)) * HISTOGRAM_BINS);
	return Math.min(HISTOGRAM_BINS - 1, Math.max(0, bin));
}

function requireWasm(fn: string, name: string): never {
	throw new Error(`${name} requires the Rust/WASM module (${fn}), which failed to load.`);
}

/**
 * Build the 256-bin histogram of a scalar plane.
 *
 * `step` subsamples for interactive use. Every method below is scale-invariant
 * in the counts, so a subsampled histogram picks the same threshold as the full
 * one to within a bin on any realistic image.
 */
export async function buildHistogram(plane: Float32Array, step = 1): Promise<ScalarHistogram> {
	const wasm = await initWasm();
	if (!wasm || typeof wasm.build_histogram_fast !== 'function') { requireWasm('build_histogram_fast', 'buildHistogram'); }
	const result = wasm.build_histogram_fast(plane, step);
	return {
		counts: result.counts,
		min: result.min,
		max: result.max,
		total: result.total,
		nonFiniteCount: result.non_finite_count,
	};
}

/** Apply one auto-threshold method. Returns a bin index, or -1 on failure. */
export async function autoThresholdBin(counts: Int32Array, method: ThresholdMethod): Promise<number> {
	const wasm = await initWasm();
	if (!wasm || typeof wasm.auto_threshold_bin_fast !== 'function') { requireWasm('auto_threshold_bin_fast', 'autoThresholdBin'); }
	return wasm.auto_threshold_bin_fast(counts, method);
}

// ---------------------------------------------------------------------------
// Stability curve
// ---------------------------------------------------------------------------

export interface StabilityPoint {
	bin: number;
	value: number;
	/** Number of connected components at this threshold. */
	objectCount: number;
	/** Fraction of the image above the threshold. */
	areaFraction: number;
}

export interface StabilityCurve {
	points: StabilityPoint[];
	/** Bins at the centre of the widest plateau in object count. */
	suggestedBin: number;
	/** Width of that plateau, in bins. Wider means a more robust answer. */
	plateauWidth: number;
}

/**
 * Object count and area as a function of threshold.
 *
 * This is the part that changes the workflow rather than reproducing it. A user
 * dragging a threshold slider has no way to know whether the value they landed
 * on is a knife edge or a broad plateau; the curve shows it directly, and the
 * widest plateau is exactly the "the answer does not depend on my guess"
 * region. It is the same stability idea MSER uses for region selection, applied
 * to the choice a human is making.
 *
 * Cost is kept bounded by measuring on a downsampled image: plateau structure
 * is a property of the intensity distribution, not of resolution, so a preview
 * grid resolves it perfectly well.
 */
export async function computeStabilityCurve(
	plane: Float32Array,
	width: number,
	height: number,
	histogram: ScalarHistogram,
	options: { samples?: number; maxPixels?: number; darkBackground?: boolean } = {},
): Promise<StabilityCurve> {
	const wasm = await initWasm();
	if (!wasm || typeof wasm.compute_stability_curve_fast !== 'function') { requireWasm('compute_stability_curve_fast', 'computeStabilityCurve'); }
	const result = wasm.compute_stability_curve_fast(
		plane, width, height, histogram.min, histogram.max,
		options.samples ?? 64, options.maxPixels ?? 250_000, options.darkBackground !== false,
	);
	const bins: Int32Array = result.bins;
	const values: Float64Array = result.values;
	const objectCounts: Uint32Array = result.object_counts;
	const areaFractions: Float64Array = result.area_fractions;
	const points: StabilityPoint[] = [];
	for (let i = 0; i < bins.length; i++) {
		points.push({ bin: bins[i], value: values[i], objectCount: objectCounts[i], areaFraction: areaFractions[i] });
	}
	return { points, suggestedBin: result.suggested_bin, plateauWidth: result.plateau_width };
}

// ---------------------------------------------------------------------------
// Local adaptive thresholding
// ---------------------------------------------------------------------------

export type LocalMethod = 'none' | 'sauvola' | 'niblack' | 'phansalkar' | 'mean' | 'median';

export const LOCAL_METHODS: { id: LocalMethod; label: string; hint: string }[] = [
	{ id: 'none', label: 'Global', hint: 'One threshold for the whole image.' },
	{ id: 'sauvola', label: 'Sauvola', hint: 'Local mean and standard deviation. The usual first choice for uneven illumination.' },
	{ id: 'niblack', label: 'Niblack', hint: 'Local mean minus k·σ. Sensitive in flat background regions.' },
	{ id: 'phansalkar', label: 'Phansalkar', hint: 'Sauvola variant tuned for low-contrast stained images.' },
	{ id: 'mean', label: 'Local mean', hint: 'Local mean minus a constant offset.' },
	{ id: 'median', label: 'Local median', hint: 'Local median minus a constant offset. Robust to speckle.' },
];

export interface LocalThresholdOptions {
	method: LocalMethod;
	/** Window radius in pixels. */
	radius: number;
	/** Sauvola/Niblack/Phansalkar sensitivity. */
	k: number;
	/** Sauvola dynamic range term. */
	r?: number;
	/** Constant offset for the mean/median variants. */
	offset?: number;
	darkBackground?: boolean;
}

/**
 * Per-pixel threshold surface.
 *
 * Uneven illumination is the single most common reason a global threshold
 * "has no right value" — the correct value at the top of the frame is wrong at
 * the bottom. Local methods fix that at the source instead of asking the user
 * to keep hunting.
 *
 * **Polarity is normalised first.** Sauvola, Niblack and Phansalkar are all
 * published for document binarisation, where the foreground is *darker* than
 * its surroundings; every one of them puts the threshold below the local mean,
 * so applying them unchanged to bright objects selects the entire flat
 * background. When the caller says objects are brighter, the plane is inverted
 * before the formulas run and the comparison stays `value <= threshold`. That
 * way each method behaves exactly as published, in both polarities.
 *
 * A positive `k` always means "stricter" here, including for Niblack, whose
 * literature convention is a negative k for the same effect.
 *
 * Mean and variance come from summed-area tables, so cost is independent of the
 * window radius and a slider over it stays interactive.
 */
export async function localThresholdMask(
	inputPlane: Float32Array,
	width: number,
	height: number,
	options: LocalThresholdOptions,
): Promise<Uint8Array> {
	const wasm = await initWasm();
	if (!wasm || typeof wasm.local_threshold_mask_fast !== 'function') { requireWasm('local_threshold_mask_fast', 'localThresholdMask'); }
	return wasm.local_threshold_mask_fast(
		inputPlane, width, height, options.method, options.radius, options.k,
		options.r ?? NaN, options.offset ?? NaN, options.darkBackground !== false,
	);
}

/**
 * Run any of the global methods **per neighbourhood** instead of once.
 *
 * The thirteen statistical methods above are all functions of a histogram, so
 * there is nothing global about them in principle — feed each one the histogram
 * of a local window and it becomes an adaptive threshold. That is what ImageJ's
 * "Auto Local Threshold" does, and it is a genuinely different tool from
 * Sauvola/Niblack: those model the local mean and σ directly, whereas this keeps
 * whichever criterion you already decided suits your data and only stops
 * applying it globally.
 *
 * Computing a full histogram centred on every pixel would be quadratic in the
 * radius. Instead the threshold is evaluated on a grid of tiles and bilinearly
 * interpolated between them, which is the standard approximation: the threshold
 * surface of a real image varies on the scale of the illumination, not per
 * pixel, so interpolating it loses nothing while making the cost linear.
 */
export async function localAutoThresholdMask(
	plane: Float32Array,
	width: number,
	height: number,
	options: {
		method: ThresholdMethod;
		radius: number;
		darkBackground?: boolean;
		/**
		 * Minimum window contrast, as a fraction of the image's full range,
		 * before a window is allowed to split at all.
		 *
		 * Without this the mode is unusable: every method above *always* returns
		 * a threshold, including for a window containing nothing but background,
		 * so uniform regions get carved into spurious objects. Requiring real
		 * contrast before splitting is Bernsen's criterion, and it is what turns
		 * "apply Otsu per window" from a curiosity into a tool.
		 */
		minContrast?: number;
	},
): Promise<Uint8Array> {
	const wasm = await initWasm();
	if (!wasm || typeof wasm.local_auto_threshold_mask_fast !== 'function') { requireWasm('local_auto_threshold_mask_fast', 'localAutoThresholdMask'); }
	return wasm.local_auto_threshold_mask_fast(
		plane, width, height, options.method, options.radius,
		options.darkBackground !== false, options.minContrast ?? NaN,
	);
}

/** Binary mask from a global value window. */
export async function globalThresholdMask(
	plane: Float32Array,
	low: number,
	high: number,
): Promise<Uint8Array> {
	const wasm = await initWasm();
	if (!wasm || typeof wasm.global_threshold_mask_fast !== 'function') { requireWasm('global_threshold_mask_fast', 'globalThresholdMask'); }
	return wasm.global_threshold_mask_fast(plane, low, high);
}

/** Convenience wrapper that materialises the scalar plane for a source. */
export function scalarPlaneOf(source: MeasurementSource): Float32Array {
	return toScalarPlane(source);
}

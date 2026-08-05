"use strict";

import { toScalarPlane, type MeasurementSource } from './types.js';

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

/**
 * Build the 256-bin histogram of a scalar plane.
 *
 * `step` subsamples for interactive use. Every method below is scale-invariant
 * in the counts, so a subsampled histogram picks the same threshold as the full
 * one to within a bin on any realistic image.
 */
export function buildHistogram(plane: Float32Array, step = 1): ScalarHistogram {
	let min = Infinity;
	let max = -Infinity;
	let nonFinite = 0;
	for (let i = 0; i < plane.length; i += step) {
		const v = plane[i];
		if (!Number.isFinite(v)) { nonFinite++; continue; }
		if (v < min) { min = v; }
		if (v > max) { max = v; }
	}
	const counts = new Int32Array(HISTOGRAM_BINS);
	if (!Number.isFinite(min) || !Number.isFinite(max)) {
		return { counts, min: 0, max: 0, total: 0, nonFiniteCount: nonFinite };
	}
	let total = 0;
	if (max === min) {
		for (let i = 0; i < plane.length; i += step) {
			if (Number.isFinite(plane[i])) { counts[0]++; total++; }
		}
		return { counts, min, max, total, nonFiniteCount: nonFinite };
	}
	const scale = HISTOGRAM_BINS / (max - min);
	for (let i = 0; i < plane.length; i += step) {
		const v = plane[i];
		if (!Number.isFinite(v)) { continue; }
		let bin = Math.floor((v - min) * scale);
		if (bin >= HISTOGRAM_BINS) { bin = HISTOGRAM_BINS - 1; }
		counts[bin]++;
		total++;
	}
	return { counts, min, max, total, nonFiniteCount: nonFinite };
}

/** Apply one auto-threshold method. Returns a bin index, or -1 on failure. */
export function autoThresholdBin(counts: Int32Array, method: ThresholdMethod): number {
	switch (method) {
		case 'otsu': return otsu(counts);
		case 'isodata': return isoData(counts);
		case 'li': return li(counts);
		case 'triangle': return triangle(counts);
		case 'yen': return yen(counts);
		case 'huang': return huang(counts);
		case 'maxEntropy': return maxEntropy(counts);
		case 'mean': return meanThreshold(counts);
		case 'moments': return moments(counts);
		case 'percentile': return percentile(counts);
		case 'shanbhag': return shanbhag(counts);
		case 'minimum': return minimum(counts);
		case 'intermodes': return intermodes(counts);
		default: return otsu(counts);
	}
}

function total(counts: Int32Array): number {
	let sum = 0;
	for (let i = 0; i < counts.length; i++) { sum += counts[i]; }
	return sum;
}

/** Otsu 1979: maximise between-class variance. */
function otsu(counts: Int32Array): number {
	const n = total(counts);
	if (n === 0) { return -1; }
	let sum = 0;
	for (let i = 0; i < counts.length; i++) { sum += i * counts[i]; }
	let sumBackground = 0;
	let weightBackground = 0;
	let best = -1;
	let bestVariance = -1;
	for (let t = 0; t < counts.length; t++) {
		weightBackground += counts[t];
		if (weightBackground === 0) { continue; }
		const weightForeground = n - weightBackground;
		if (weightForeground === 0) { break; }
		sumBackground += t * counts[t];
		const meanBackground = sumBackground / weightBackground;
		const meanForeground = (sum - sumBackground) / weightForeground;
		const delta = meanBackground - meanForeground;
		const variance = weightBackground * weightForeground * delta * delta;
		if (variance > bestVariance) { bestVariance = variance; best = t; }
	}
	return best;
}

/** Ridler-Calvard iterative isodata, as used by ImageJ's "Default". */
function isoData(counts: Int32Array): number {
	let t = 0;
	for (let i = 0; i < counts.length; i++) { if (counts[i] > 0) { t = i; break; } }
	let previous = -1;
	let guard = 0;
	let threshold = Math.floor(counts.length / 2);
	while (threshold !== previous && guard++ < 1000) {
		previous = threshold;
		let sumBelow = 0, countBelow = 0, sumAbove = 0, countAbove = 0;
		for (let i = 0; i <= threshold; i++) { sumBelow += i * counts[i]; countBelow += counts[i]; }
		for (let i = threshold + 1; i < counts.length; i++) { sumAbove += i * counts[i]; countAbove += counts[i]; }
		if (countBelow === 0 || countAbove === 0) { break; }
		threshold = Math.round((sumBelow / countBelow + sumAbove / countAbove) / 2);
	}
	return threshold < t ? t : threshold;
}

/** Li & Tam: iterative minimum cross-entropy. */
function li(counts: Int32Array): number {
	const n = total(counts);
	if (n === 0) { return -1; }
	let mean = 0;
	for (let i = 0; i < counts.length; i++) { mean += i * counts[i]; }
	mean /= n;

	let newThreshold = mean;
	let oldThreshold: number;
	let guard = 0;
	do {
		oldThreshold = newThreshold;
		const t = Math.floor(oldThreshold + 0.5);
		let sumBack = 0, countBack = 0;
		for (let i = 0; i <= t; i++) { sumBack += i * counts[i]; countBack += counts[i]; }
		let sumFore = 0, countFore = 0;
		for (let i = t + 1; i < counts.length; i++) { sumFore += i * counts[i]; countFore += counts[i]; }
		// Zero is not a valid argument to log; the +1 offset is the usual guard
		// and shifts both means identically, so the crossing point is unaffected.
		const meanBack = countBack > 0 ? sumBack / countBack : 0;
		const meanFore = countFore > 0 ? sumFore / countFore : 0;
		const a = meanBack > 0 ? meanBack : 1e-9;
		const b = meanFore > 0 ? meanFore : 1e-9;
		newThreshold = (b - a) / (Math.log(b) - Math.log(a));
		if (!Number.isFinite(newThreshold)) { break; }
	} while (Math.abs(newThreshold - oldThreshold) > 0.5 && guard++ < 1000);
	return Math.floor(newThreshold);
}

/** Zack's triangle method: farthest point from the peak-to-tail chord. */
function triangle(counts: Int32Array): number {
	let peak = 0;
	for (let i = 1; i < counts.length; i++) { if (counts[i] > counts[peak]) { peak = i; } }

	let first = 0;
	while (first < counts.length && counts[first] === 0) { first++; }
	let last = counts.length - 1;
	while (last > 0 && counts[last] === 0) { last--; }
	if (first >= last) { return -1; }

	// Work on whichever side of the peak is longer; that is where the tail is.
	let flip = false;
	let lo = first, hi = last;
	if (peak - first < last - peak) {
		flip = true;
		const reversed = new Int32Array(counts.length);
		for (let i = 0; i < counts.length; i++) { reversed[i] = counts[counts.length - 1 - i]; }
		const result = triangleOneSided(reversed);
		return result < 0 ? result : counts.length - 1 - result;
	}
	void lo; void hi; void flip;
	return triangleOneSided(counts);
}

function triangleOneSided(counts: Int32Array): number {
	let peak = 0;
	for (let i = 1; i < counts.length; i++) { if (counts[i] > counts[peak]) { peak = i; } }
	let last = counts.length - 1;
	while (last > peak && counts[last] === 0) { last--; }
	if (last <= peak) { return peak; }

	const dx = last - peak;
	const dy = counts[last] - counts[peak];
	const norm = Math.hypot(dx, dy) || 1;
	let best = peak;
	let bestDistance = -1;
	for (let i = peak; i <= last; i++) {
		const distance = Math.abs(dy * (i - peak) - dx * (counts[i] - counts[peak])) / norm;
		if (distance > bestDistance) { bestDistance = distance; best = i; }
	}
	return best;
}

/** Yen, Chang & Chang maximum-correlation criterion. */
function yen(counts: Int32Array): number {
	const n = total(counts);
	if (n === 0) { return -1; }
	const p = new Float64Array(counts.length);
	for (let i = 0; i < counts.length; i++) { p[i] = counts[i] / n; }

	const p1 = new Float64Array(counts.length);
	const p1Squared = new Float64Array(counts.length);
	p1[0] = p[0];
	p1Squared[0] = p[0] * p[0];
	for (let i = 1; i < counts.length; i++) {
		p1[i] = p1[i - 1] + p[i];
		p1Squared[i] = p1Squared[i - 1] + p[i] * p[i];
	}
	const p2Squared = new Float64Array(counts.length);
	p2Squared[counts.length - 1] = 0;
	for (let i = counts.length - 2; i >= 0; i--) { p2Squared[i] = p2Squared[i + 1] + p[i + 1] * p[i + 1]; }

	let best = -1;
	let bestCriterion = -Infinity;
	for (let t = 0; t < counts.length; t++) {
		const a = p1Squared[t] * p2Squared[t];
		const b = p1[t] * (1 - p1[t]);
		const criterion =
			(a > 0 ? -1 * Math.log(a) : 0) +
			(b > 0 ? 2 * Math.log(b) : 0);
		if (criterion > bestCriterion) { bestCriterion = criterion; best = t; }
	}
	return best;
}

/** Huang & Wang fuzzy-membership minimisation. */
function huang(counts: Int32Array): number {
	let first = 0;
	while (first < counts.length && counts[first] === 0) { first++; }
	let last = counts.length - 1;
	while (last > first && counts[last] === 0) { last--; }
	if (first === last) { return first; }

	const cumulative = new Float64Array(counts.length);
	const weighted = new Float64Array(counts.length);
	cumulative[first] = counts[first];
	weighted[first] = first * counts[first];
	for (let i = Math.max(first, 1); i <= last; i++) {
		cumulative[i] = cumulative[i - 1] + counts[i];
		weighted[i] = weighted[i - 1] + i * counts[i];
	}

	const c = last - first;
	const membershipCost = new Float64Array(counts.length);
	for (let i = 0; i < counts.length; i++) {
		const membership = 1 / (1 + Math.abs(i) / c);
		membershipCost[i] = -membership * Math.log(membership) - (1 - membership) * Math.log(1 - membership);
	}

	let best = first;
	let bestEntropy = Infinity;
	for (let t = first; t <= last; t++) {
		let entropy = 0;
		const meanLow = cumulative[t] > 0 ? Math.round(weighted[t] / cumulative[t]) : 0;
		for (let i = first; i <= t; i++) { entropy += membershipCost[Math.abs(i - meanLow)] * counts[i]; }
		const highCount = cumulative[last] - cumulative[t];
		const meanHigh = highCount > 0 ? Math.round((weighted[last] - weighted[t]) / highCount) : 0;
		for (let i = t + 1; i <= last; i++) { entropy += membershipCost[Math.abs(i - meanHigh)] * counts[i]; }
		if (entropy < bestEntropy) { bestEntropy = entropy; best = t; }
	}
	return best;
}

/** Kapur, Sahoo & Wong maximum entropy. */
function maxEntropy(counts: Int32Array): number {
	const n = total(counts);
	if (n === 0) { return -1; }
	const p = new Float64Array(counts.length);
	for (let i = 0; i < counts.length; i++) { p[i] = counts[i] / n; }

	const cumulative = new Float64Array(counts.length);
	cumulative[0] = p[0];
	for (let i = 1; i < counts.length; i++) { cumulative[i] = cumulative[i - 1] + p[i]; }

	let best = -1;
	let bestEntropy = -Infinity;
	for (let t = 0; t < counts.length; t++) {
		const pBackground = cumulative[t];
		const pForeground = 1 - pBackground;
		if (pBackground <= 0 || pForeground <= 0) { continue; }
		let backgroundEntropy = 0;
		for (let i = 0; i <= t; i++) {
			if (p[i] > 0) { backgroundEntropy -= (p[i] / pBackground) * Math.log(p[i] / pBackground); }
		}
		let foregroundEntropy = 0;
		for (let i = t + 1; i < counts.length; i++) {
			if (p[i] > 0) { foregroundEntropy -= (p[i] / pForeground) * Math.log(p[i] / pForeground); }
		}
		const entropy = backgroundEntropy + foregroundEntropy;
		if (entropy > bestEntropy) { bestEntropy = entropy; best = t; }
	}
	return best;
}

function meanThreshold(counts: Int32Array): number {
	const n = total(counts);
	if (n === 0) { return -1; }
	let sum = 0;
	for (let i = 0; i < counts.length; i++) { sum += i * counts[i]; }
	return Math.floor(sum / n);
}

/** Tsai's moment-preserving threshold. */
function moments(counts: Int32Array): number {
	const n = total(counts);
	if (n === 0) { return -1; }
	let m1 = 0, m2 = 0, m3 = 0;
	for (let i = 0; i < counts.length; i++) {
		const p = counts[i] / n;
		m1 += i * p;
		m2 += i * i * p;
		m3 += i * i * i * p;
	}
	const cd = m2 - m1 * m1;
	if (cd === 0) { return -1; }
	const c0 = (-m2 * m2 + m1 * m3) / cd;
	const c1 = (-m3 + m2 * m1) / cd;
	const discriminant = c1 * c1 - 4 * c0;
	if (discriminant < 0) { return -1; }
	const root = Math.sqrt(discriminant);
	const z0 = 0.5 * (-c1 - root);
	const z1 = 0.5 * (-c1 + root);
	const pd = z1 - z0;
	if (pd === 0) { return -1; }
	const p0 = (z1 - m1) / pd;

	let cumulative = 0;
	for (let i = 0; i < counts.length; i++) {
		cumulative += counts[i] / n;
		if (cumulative > p0) { return i; }
	}
	return -1;
}

/** Doyle's percentile method, assuming half the image is foreground. */
function percentile(counts: Int32Array): number {
	const n = total(counts);
	if (n === 0) { return -1; }
	const target = 0.5;
	let best = -1;
	let bestDistance = Infinity;
	let cumulative = 0;
	for (let i = 0; i < counts.length; i++) {
		cumulative += counts[i];
		const distance = Math.abs(cumulative / n - target);
		if (distance < bestDistance) { bestDistance = distance; best = i; }
	}
	return best;
}

/** Shanbhag's information-measure threshold. */
function shanbhag(counts: Int32Array): number {
	const n = total(counts);
	if (n === 0) { return -1; }
	const p = new Float64Array(counts.length);
	for (let i = 0; i < counts.length; i++) { p[i] = counts[i] / n; }
	const cumulative = new Float64Array(counts.length);
	cumulative[0] = p[0];
	for (let i = 1; i < counts.length; i++) { cumulative[i] = cumulative[i - 1] + p[i]; }

	let best = -1;
	let bestDistance = Infinity;
	for (let t = 0; t < counts.length; t++) {
		const pBackground = cumulative[t];
		const pForeground = 1 - pBackground;
		if (pBackground <= 0 || pForeground <= 0) { continue; }

		let backgroundTerm = 0;
		let running = 1;
		for (let i = 1; i <= t; i++) {
			running *= (pBackground - p[t - i + 1]) / pBackground;
			if (!(running > 0)) { break; }
			backgroundTerm -= p[i] * Math.log(running);
		}
		backgroundTerm /= pBackground;

		let foregroundTerm = 0;
		running = 1;
		for (let i = 1; t + i < counts.length; i++) {
			running *= (pForeground - p[t + i]) / pForeground;
			if (!(running > 0)) { break; }
			foregroundTerm -= p[t + i] * Math.log(running);
		}
		foregroundTerm /= pForeground;

		const distance = Math.abs(backgroundTerm - foregroundTerm);
		if (distance < bestDistance) { bestDistance = distance; best = t; }
	}
	return best;
}

/** Smooth the histogram until it has exactly two local maxima. */
function smoothToBimodal(counts: Int32Array): Float64Array | null {
	let smoothed = Float64Array.from(counts);
	for (let iteration = 0; iteration < 10000; iteration++) {
		let peaks = 0;
		for (let i = 1; i + 1 < smoothed.length; i++) {
			if (smoothed[i - 1] < smoothed[i] && smoothed[i + 1] < smoothed[i]) { peaks++; }
		}
		if (peaks <= 2) { return peaks === 2 ? smoothed : null; }
		const next = new Float64Array(smoothed.length);
		for (let i = 0; i < smoothed.length; i++) {
			const a = smoothed[Math.max(0, i - 1)];
			const b = smoothed[i];
			const c = smoothed[Math.min(smoothed.length - 1, i + 1)];
			next[i] = (a + b + c) / 3;
		}
		smoothed = next;
	}
	return null;
}

/** Prewitt & Mendelsohn minimum: the valley between the two smoothed peaks. */
function minimum(counts: Int32Array): number {
	const smoothed = smoothToBimodal(counts);
	if (!smoothed) { return -1; }
	for (let i = 1; i + 1 < smoothed.length; i++) {
		if (smoothed[i - 1] > smoothed[i] && smoothed[i + 1] >= smoothed[i]) { return i; }
	}
	return -1;
}

/** Prewitt & Mendelsohn intermodes: the midpoint between the two peaks. */
function intermodes(counts: Int32Array): number {
	const smoothed = smoothToBimodal(counts);
	if (!smoothed) { return -1; }
	const peaks: number[] = [];
	for (let i = 1; i + 1 < smoothed.length; i++) {
		if (smoothed[i - 1] < smoothed[i] && smoothed[i + 1] < smoothed[i]) { peaks.push(i); }
	}
	if (peaks.length !== 2) { return -1; }
	return Math.floor((peaks[0] + peaks[1]) / 2);
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
export function computeStabilityCurve(
	plane: Float32Array,
	width: number,
	height: number,
	histogram: ScalarHistogram,
	options: { samples?: number; maxPixels?: number; darkBackground?: boolean } = {},
): StabilityCurve {
	const samples = Math.max(8, Math.min(128, options.samples ?? 64));
	const maxPixels = options.maxPixels ?? 250_000;
	const darkBackground = options.darkBackground !== false;

	const { plane: small, width: smallWidth, height: smallHeight } =
		downsample(plane, width, height, maxPixels);

	const points: StabilityPoint[] = [];
	const mask = new Uint8Array(smallWidth * smallHeight);
	for (let s = 0; s < samples; s++) {
		const bin = Math.round((s / (samples - 1)) * (HISTOGRAM_BINS - 1));
		const value = thresholdValueFromBin(histogram, bin);
		let inside = 0;
		for (let i = 0; i < small.length; i++) {
			const v = small[i];
			const on = Number.isFinite(v) && (darkBackground ? v >= value : v <= value);
			mask[i] = on ? 1 : 0;
			if (on) { inside++; }
		}
		points.push({
			bin,
			value,
			objectCount: countComponents(mask, smallWidth, smallHeight),
			areaFraction: inside / mask.length,
		});
	}

	// The useful plateau is a run where the object count barely moves *and*
	// something is actually selected — the empty and the fully-saturated ends
	// are perfectly stable and completely useless.
	let bestStart = 0;
	let bestLength = 0;
	let runStart = 0;
	for (let i = 1; i <= points.length; i++) {
		const ended = i === points.length ||
			Math.abs(points[i].objectCount - points[runStart].objectCount) >
			Math.max(1, points[runStart].objectCount * 0.1);
		if (!ended) { continue; }
		const length = i - runStart;
		const midpoint = points[Math.floor(runStart + length / 2)];
		const usable = midpoint.objectCount > 0 &&
			midpoint.areaFraction > 0.0005 && midpoint.areaFraction < 0.95;
		if (usable && length > bestLength) { bestLength = length; bestStart = runStart; }
		runStart = i;
	}

	const suggestedIndex = bestLength > 0
		? Math.floor(bestStart + bestLength / 2)
		: Math.floor(points.length / 2);

	return {
		points,
		suggestedBin: points[suggestedIndex]?.bin ?? 128,
		plateauWidth: bestLength,
	};
}

/** Box-average downsample to at most `maxPixels`, preserving aspect ratio. */
export function downsample(
	plane: Float32Array,
	width: number,
	height: number,
	maxPixels: number,
): { plane: Float32Array; width: number; height: number } {
	const pixels = width * height;
	if (pixels <= maxPixels) { return { plane, width, height }; }
	const factor = Math.ceil(Math.sqrt(pixels / maxPixels));
	const outWidth = Math.max(1, Math.floor(width / factor));
	const outHeight = Math.max(1, Math.floor(height / factor));
	const out = new Float32Array(outWidth * outHeight);
	for (let y = 0; y < outHeight; y++) {
		for (let x = 0; x < outWidth; x++) {
			let sum = 0;
			let n = 0;
			for (let dy = 0; dy < factor; dy++) {
				const sy = y * factor + dy;
				if (sy >= height) { break; }
				for (let dx = 0; dx < factor; dx++) {
					const sx = x * factor + dx;
					if (sx >= width) { break; }
					const v = plane[sy * width + sx];
					if (Number.isFinite(v)) { sum += v; n++; }
				}
			}
			out[y * outWidth + x] = n > 0 ? sum / n : NaN;
		}
	}
	return { plane: out, width: outWidth, height: outHeight };
}

/** Four-connected component count of a binary mask. */
function countComponents(mask: Uint8Array, width: number, height: number): number {
	const visited = new Uint8Array(mask.length);
	const stack = new Int32Array(mask.length);
	let components = 0;
	for (let start = 0; start < mask.length; start++) {
		if (!mask[start] || visited[start]) { continue; }
		components++;
		let top = 0;
		stack[top++] = start;
		visited[start] = 1;
		while (top > 0) {
			const index = stack[--top];
			const x = index % width;
			const y = (index / width) | 0;
			if (x > 0 && mask[index - 1] && !visited[index - 1]) { visited[index - 1] = 1; stack[top++] = index - 1; }
			if (x + 1 < width && mask[index + 1] && !visited[index + 1]) { visited[index + 1] = 1; stack[top++] = index + 1; }
			if (y > 0 && mask[index - width] && !visited[index - width]) { visited[index - width] = 1; stack[top++] = index - width; }
			if (y + 1 < height && mask[index + width] && !visited[index + width]) { visited[index + width] = 1; stack[top++] = index + width; }
		}
	}
	return components;
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
export function localThresholdMask(
	inputPlane: Float32Array,
	width: number,
	height: number,
	options: LocalThresholdOptions,
): Uint8Array {
	const radius = Math.max(1, Math.round(options.radius));
	const k = options.k;
	const brightObjects = options.darkBackground !== false;
	const out = new Uint8Array(width * height);

	let sourceMin = Infinity;
	let sourceMax = -Infinity;
	for (let i = 0; i < inputPlane.length; i++) {
		const v = inputPlane[i];
		if (!Number.isFinite(v)) { continue; }
		if (v < sourceMin) { sourceMin = v; }
		if (v > sourceMax) { sourceMax = v; }
	}
	if (!Number.isFinite(sourceMin) || !Number.isFinite(sourceMax)) { return out; }

	// Reflect about the data range so bright objects become dark ones. The
	// reflection preserves distances, so every local mean and σ below is the
	// same as it would have been, only mirrored.
	let plane = inputPlane;
	if (brightObjects) {
		plane = new Float32Array(inputPlane.length);
		const pivot = sourceMin + sourceMax;
		for (let i = 0; i < inputPlane.length; i++) {
			plane[i] = Number.isFinite(inputPlane[i]) ? pivot - inputPlane[i] : NaN;
		}
	}

	if (options.method === 'median') {
		return localMedianMask(plane, width, height, radius, options.offset || 0);
	}

	// Summed-area tables over finite samples only; the count table lets windows
	// that overlap NaN regions normalise correctly instead of biasing to zero.
	const sum = new Float64Array((width + 1) * (height + 1));
	const sumSquares = new Float64Array((width + 1) * (height + 1));
	const counts = new Float64Array((width + 1) * (height + 1));
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const v = plane[y * width + x];
			const finite = Number.isFinite(v);
			const value = finite ? v : 0;
			const i = (y + 1) * (width + 1) + (x + 1);
			const up = y * (width + 1) + (x + 1);
			const left = (y + 1) * (width + 1) + x;
			const upLeft = y * (width + 1) + x;
			sum[i] = value + sum[up] + sum[left] - sum[upLeft];
			sumSquares[i] = value * value + sumSquares[up] + sumSquares[left] - sumSquares[upLeft];
			counts[i] = (finite ? 1 : 0) + counts[up] + counts[left] - counts[upLeft];
		}
	}

	const rectSum = (table: Float64Array, x0: number, y0: number, x1: number, y1: number) =>
		table[(y1 + 1) * (width + 1) + (x1 + 1)]
		- table[y0 * (width + 1) + (x1 + 1)]
		- table[(y1 + 1) * (width + 1) + x0]
		+ table[y0 * (width + 1) + x0];

	// Dynamic range for Sauvola's r term. The reflection above preserves it, so
	// the source range is still the right normaliser.
	const globalMin = brightObjects ? sourceMin : sourceMin;
	const range = sourceMax > sourceMin ? sourceMax - sourceMin : 1;
	const r = options.r ?? range / 2;
	const offset = options.offset || 0;

	for (let y = 0; y < height; y++) {
		const y0 = Math.max(0, y - radius);
		const y1 = Math.min(height - 1, y + radius);
		for (let x = 0; x < width; x++) {
			const value = plane[y * width + x];
			if (!Number.isFinite(value)) { continue; }
			const x0 = Math.max(0, x - radius);
			const x1 = Math.min(width - 1, x + radius);
			const n = rectSum(counts, x0, y0, x1, y1);
			if (n <= 0) { continue; }
			const mean = rectSum(sum, x0, y0, x1, y1) / n;
			const meanSquares = rectSum(sumSquares, x0, y0, x1, y1) / n;
			const variance = Math.max(0, meanSquares - mean * mean);
			const sigma = Math.sqrt(variance);

			let threshold: number;
			switch (options.method) {
				case 'sauvola':
					threshold = mean * (1 + k * (sigma / r - 1));
					break;
				case 'niblack':
					// Published as mean + k*sigma with a negative k; the sign is
					// flipped here so a positive k means "stricter" for every
					// method the panel offers.
					threshold = mean - k * sigma;
					break;
				case 'phansalkar': {
					// Phansalkar's p = 2 and q = 10, as published.
					const normalized = range > 0 ? (mean - globalMin) / range : 0;
					threshold = mean * (1 + 2 * Math.exp(-10 * normalized) + k * (sigma / r - 1));
					break;
				}
				case 'mean':
				default:
					threshold = mean - offset;
					break;
			}

			// Foreground is darker in the normalised polarity, always.
			if (value <= threshold) { out[y * width + x] = 1; }
		}
	}

	return out;
}

/**
 * Local median threshold. Operates on the polarity-normalised plane, so
 * foreground is whatever falls at or below the local median minus the offset.
 */
function localMedianMask(
	plane: Float32Array,
	width: number,
	height: number,
	radius: number,
	offset: number,
): Uint8Array {
	const out = new Uint8Array(width * height);
	let min = Infinity, max = -Infinity;
	for (let i = 0; i < plane.length; i++) {
		const v = plane[i];
		if (!Number.isFinite(v)) { continue; }
		if (v < min) { min = v; }
		if (v > max) { max = v; }
	}
	if (!Number.isFinite(min) || max <= min) { return out; }
	const bins = 64;
	const scale = bins / (max - min);

	for (let y = 0; y < height; y++) {
		const y0 = Math.max(0, y - radius);
		const y1 = Math.min(height - 1, y + radius);
		for (let x = 0; x < width; x++) {
			const value = plane[y * width + x];
			if (!Number.isFinite(value)) { continue; }
			const x0 = Math.max(0, x - radius);
			const x1 = Math.min(width - 1, x + radius);
			const counts = new Int32Array(bins);
			let n = 0;
			for (let wy = y0; wy <= y1; wy++) {
				for (let wx = x0; wx <= x1; wx++) {
					const v = plane[wy * width + wx];
					if (!Number.isFinite(v)) { continue; }
					let bin = Math.floor((v - min) * scale);
					if (bin >= bins) { bin = bins - 1; }
					counts[bin]++;
					n++;
				}
			}
			if (n === 0) { continue; }
			let cumulative = 0;
			let medianBin = 0;
			for (let b = 0; b < bins; b++) {
				cumulative += counts[b];
				if (cumulative * 2 >= n) { medianBin = b; break; }
			}
			const median = min + (medianBin + 0.5) / scale;
			if (value <= median - offset) { out[y * width + x] = 1; }
		}
	}
	return out;
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
export function localAutoThresholdMask(
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
): Uint8Array {
	const radius = Math.max(4, Math.round(options.radius));
	const darkBackground = options.darkBackground !== false;
	const minContrastFraction = options.minContrast ?? 0.25;
	const out = new Uint8Array(width * height);

	let min = Infinity;
	let max = -Infinity;
	for (let i = 0; i < plane.length; i++) {
		const v = plane[i];
		if (!Number.isFinite(v)) { continue; }
		if (v < min) { min = v; }
		if (v > max) { max = v; }
	}
	if (!Number.isFinite(min) || max <= min) { return out; }
	const binScale = HISTOGRAM_BINS / (max - min);

	// One tile per radius, so a window spans three tiles and neighbouring tiles
	// see overlapping data — without that the interpolated surface shows the
	// tile grid.
	const tile = radius;
	const tilesX = Math.max(2, Math.ceil(width / tile) + 1);
	const tilesY = Math.max(2, Math.ceil(height / tile) + 1);
	const grid = new Float64Array(tilesX * tilesY);
	// Whether a tile contained enough contrast to be split at all. Kept separate
	// from the threshold grid because it must *not* be interpolated: blending a
	// real threshold into an empty neighbour drags a usable cut out over blank
	// background and carves objects out of it.
	const valid = new Uint8Array(tilesX * tilesY);
	const counts = new Int32Array(HISTOGRAM_BINS);

	for (let ty = 0; ty < tilesY; ty++) {
		const centreY = ty * tile;
		const y0 = Math.max(0, centreY - radius);
		const y1 = Math.min(height - 1, centreY + radius);
		for (let tx = 0; tx < tilesX; tx++) {
			const centreX = tx * tile;
			const x0 = Math.max(0, centreX - radius);
			const x1 = Math.min(width - 1, centreX + radius);

			counts.fill(0);
			let total = 0;
			let windowMin = Infinity;
			let windowMax = -Infinity;
			for (let y = y0; y <= y1; y++) {
				const row = y * width;
				for (let x = x0; x <= x1; x++) {
					const v = plane[row + x];
					if (!Number.isFinite(v)) { continue; }
					if (v < windowMin) { windowMin = v; }
					if (v > windowMax) { windowMax = v; }
					let bin = Math.floor((v - min) * binScale);
					if (bin >= HISTOGRAM_BINS) { bin = HISTOGRAM_BINS - 1; }
					if (bin < 0) { bin = 0; }
					counts[bin]++;
					total++;
				}
			}

			// A cut above the window's maximum leaves it empty, which is the
			// correct answer for a window that holds no object.
			const empty = max + Math.abs(max - min) + 1;
			let value = empty;
			let isValid = false;
			if (total > 0 && (windowMax - windowMin) >= minContrastFraction * (max - min)) {
				const bin = autoThresholdBin(counts, options.method);
				if (bin >= 0) {
					value = min + ((bin + 1) / HISTOGRAM_BINS) * (max - min);
					isValid = true;
				}
			}
			grid[ty * tilesX + tx] = value;
			valid[ty * tilesX + tx] = isValid ? 1 : 0;
		}
	}

	for (let y = 0; y < height; y++) {
		const gy = y / tile;
		const ty0 = Math.min(tilesY - 1, Math.floor(gy));
		const ty1 = Math.min(tilesY - 1, ty0 + 1);
		const fy = gy - ty0;
		const nearestY = Math.min(tilesY - 1, Math.round(gy));
		for (let x = 0; x < width; x++) {
			const value = plane[y * width + x];
			if (!Number.isFinite(value)) { continue; }
			const gx = x / tile;
			const nearestX = Math.min(tilesX - 1, Math.round(gx));
			// Validity is taken from the nearest tile alone, so blank regions stay
			// blank right up to the tile that actually contains an object.
			if (!valid[nearestY * tilesX + nearestX]) { continue; }

			const tx0 = Math.min(tilesX - 1, Math.floor(gx));
			const tx1 = Math.min(tilesX - 1, tx0 + 1);
			const fx = gx - tx0;

			// Interpolate only over tiles that produced a real threshold; an empty
			// neighbour would otherwise pull the surface towards its sentinel.
			let weighted = 0;
			let weight = 0;
			const corners: [number, number, number][] = [
				[ty0, tx0, (1 - fx) * (1 - fy)],
				[ty0, tx1, fx * (1 - fy)],
				[ty1, tx0, (1 - fx) * fy],
				[ty1, tx1, fx * fy],
			];
			for (const [cy, cx, w] of corners) {
				const index = cy * tilesX + cx;
				if (!valid[index] || w <= 0) { continue; }
				weighted += grid[index] * w;
				weight += w;
			}
			if (weight <= 0) { continue; }
			const threshold = weighted / weight;

			if (darkBackground ? value >= threshold : value <= threshold) { out[y * width + x] = 1; }
		}
	}

	return out;
}

/** Binary mask from a global value window. */
export function globalThresholdMask(
	plane: Float32Array,
	low: number,
	high: number,
): Uint8Array {
	const out = new Uint8Array(plane.length);
	for (let i = 0; i < plane.length; i++) {
		const v = plane[i];
		if (Number.isFinite(v) && v >= low && v <= high) { out[i] = 1; }
	}
	return out;
}

/** Convenience wrapper that materialises the scalar plane for a source. */
export function scalarPlaneOf(source: MeasurementSource): Float32Array {
	return toScalarPlane(source);
}

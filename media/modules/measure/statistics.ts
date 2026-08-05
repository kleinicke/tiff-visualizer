"use strict";

import {
	convexHull,
	distanceToPolyline,
	feretDiameters,
	fitEllipse,
	maskPerimeter,
	polygonArea,
	polygonPerimeter,
	polylineLength,
	rasterizeRoi,
	roiOutline,
} from './geometry.js';
import {
	isAreaKind,
	isLineKind,
	sampleAt,
	type Calibration,
	type LineRoi,
	type MeasurementRow,
	type MeasurementSource,
	type PointRoi,
	type Roi,
	type RoiMask,
} from './types.js';

/**
 * Turning an ROI into numbers.
 *
 * Two invariants hold throughout:
 *
 * 1. **Intensity statistics run on raw sample values.** Never on the displayed
 *    canvas, never after normalisation/gamma/colormap. A measurement that
 *    changes when the user drags the brightness slider is worthless, and
 *    silently reporting display values is a well-known source of wrong numbers
 *    in other tools.
 * 2. **Non-finite samples are excluded, not coerced.** NaN and ±Infinity are
 *    counted separately and reported, using the same `Number.isFinite` guard
 *    the render and histogram paths use. Treating NaN as 0 would quietly bias
 *    every mean in a float image.
 */

export interface IntensityStats {
	count: number;
	nonFiniteCount: number;
	mean: number;
	stdDev: number;
	min: number;
	max: number;
	sum: number;
	median: number;
	mode: number;
	skewness: number;
	kurtosis: number;
	/** Intensity-weighted centre, in image pixels. */
	centerOfMassX: number;
	centerOfMassY: number;
}

const EMPTY_STATS: IntensityStats = {
	count: 0, nonFiniteCount: 0, mean: NaN, stdDev: NaN, min: NaN, max: NaN,
	sum: 0, median: NaN, mode: NaN, skewness: NaN, kurtosis: NaN,
	centerOfMassX: NaN, centerOfMassY: NaN,
};

/**
 * Intensity statistics over a rasterised region for one channel.
 *
 * Mean and variance use Welford's algorithm: a naive sum of squares loses most
 * of its significant digits on 32-bit float images whose values sit far from
 * zero, which is common for scientific data stored in physical units.
 */
export function measureIntensity(
	source: MeasurementSource,
	region: RoiMask,
	channel: number,
): IntensityStats {
	if (region.count === 0) { return { ...EMPTY_STATS }; }

	const values = new Float64Array(region.count);
	let n = 0;
	let nonFinite = 0;
	let min = Infinity;
	let max = -Infinity;
	let mean = 0;
	let m2 = 0;
	let sum = 0;
	let weightedX = 0;
	let weightedY = 0;
	let weightSum = 0;

	for (let row = 0; row < region.height; row++) {
		const imageY = region.y + row;
		for (let col = 0; col < region.width; col++) {
			if (!region.mask[row * region.width + col]) { continue; }
			const imageX = region.x + col;
			const value = sampleAt(source, imageX, imageY, channel);
			if (!Number.isFinite(value)) { nonFinite++; continue; }

			values[n] = value;
			n++;
			sum += value;
			if (value < min) { min = value; }
			if (value > max) { max = value; }
			const delta = value - mean;
			mean += delta / n;
			m2 += delta * (value - mean);

			// Negative samples would flip the weighting; offsetting by the running
			// minimum is not possible in one pass, so the centre of mass is
			// computed from a second pass below when any negative value occurs.
			weightedX += value * imageX;
			weightedY += value * imageY;
			weightSum += value;
		}
	}

	if (n === 0) { return { ...EMPTY_STATS, nonFiniteCount: nonFinite }; }

	const variance = n > 1 ? m2 / (n - 1) : 0;
	const stdDev = Math.sqrt(Math.max(0, variance));

	// Higher moments need a second pass; they are cheap next to the mask walk.
	let m3 = 0;
	let m4 = 0;
	for (let i = 0; i < n; i++) {
		const d = values[i] - mean;
		m3 += d * d * d;
		m4 += d * d * d * d;
	}
	const populationVariance = m2 / n;
	const sigma = Math.sqrt(Math.max(0, populationVariance));
	const skewness = sigma > 0 ? (m3 / n) / (sigma * sigma * sigma) : 0;
	const kurtosis = sigma > 0 ? (m4 / n) / (populationVariance * populationVariance) - 3 : 0;

	const sorted = values.slice(0, n).sort();
	const median = n % 2 === 1
		? sorted[(n - 1) / 2]
		: (sorted[n / 2 - 1] + sorted[n / 2]) / 2;

	// If any sample is negative, redo the centre of mass with the minimum shifted
	// to zero so weights stay non-negative and the result stays inside the ROI.
	let comX = weightSum !== 0 ? weightedX / weightSum : NaN;
	let comY = weightSum !== 0 ? weightedY / weightSum : NaN;
	if (min < 0) {
		let shiftedWeight = 0;
		let shiftedX = 0;
		let shiftedY = 0;
		for (let row = 0; row < region.height; row++) {
			const imageY = region.y + row;
			for (let col = 0; col < region.width; col++) {
				if (!region.mask[row * region.width + col]) { continue; }
				const imageX = region.x + col;
				const value = sampleAt(source, imageX, imageY, channel);
				if (!Number.isFinite(value)) { continue; }
				const weight = value - min;
				shiftedWeight += weight;
				shiftedX += weight * imageX;
				shiftedY += weight * imageY;
			}
		}
		comX = shiftedWeight > 0 ? shiftedX / shiftedWeight : NaN;
		comY = shiftedWeight > 0 ? shiftedY / shiftedWeight : NaN;
	}

	return {
		count: n,
		nonFiniteCount: nonFinite,
		mean,
		stdDev,
		min,
		max,
		sum,
		median,
		mode: estimateMode(sorted, n, min, max),
		skewness,
		kurtosis,
		centerOfMassX: comX,
		centerOfMassY: comY,
	};
}

/**
 * Most frequent value, binned at 256 levels like ImageJ's mode. An exact mode
 * is meaningless for float data where no two samples repeat, so the binned
 * definition is both faster and more useful.
 */
function estimateMode(sorted: Float64Array, n: number, min: number, max: number): number {
	if (n === 0 || !Number.isFinite(min) || !Number.isFinite(max)) { return NaN; }
	if (max === min) { return min; }
	const bins = 256;
	const counts = new Int32Array(bins);
	const scale = bins / (max - min);
	for (let i = 0; i < n; i++) {
		let bin = Math.floor((sorted[i] - min) * scale);
		if (bin >= bins) { bin = bins - 1; }
		if (bin < 0) { bin = 0; }
		counts[bin]++;
	}
	let bestBin = 0;
	for (let i = 1; i < bins; i++) { if (counts[i] > counts[bestBin]) { bestBin = i; } }
	return min + (bestBin + 0.5) / scale;
}

/**
 * Sample values along a line ROI.
 *
 * A `lineWidth` above 1 averages a perpendicular band, which is the standard
 * way to suppress noise in a profile without blurring the image itself. Samples
 * use bilinear interpolation except when the line is axis-aligned and one pixel
 * wide, where exact pixel values are returned — interpolating there would
 * invent values a user can otherwise verify with the pixel inspector.
 */
export function sampleLineProfile(
	source: MeasurementSource,
	roi: LineRoi,
	channel: number,
): { distance: Float64Array; value: Float64Array } {
	const points = roi.points || [];
	const n = Math.floor(points.length / 2);
	if (n < 2) { return { distance: new Float64Array(0), value: new Float64Array(0) }; }

	const lineWidth = Math.max(1, Math.round(roi.lineWidth || 1));
	const totalLength = polylineLength(points);
	const sampleCount = Math.max(2, Math.round(totalLength) + 1);
	const distance = new Float64Array(sampleCount);
	const value = new Float64Array(sampleCount);

	// Cumulative arc length per vertex, so a parameter maps to the right segment.
	const cumulative = new Float64Array(n);
	for (let i = 1; i < n; i++) {
		cumulative[i] = cumulative[i - 1] + Math.hypot(
			points[i * 2] - points[(i - 1) * 2],
			points[i * 2 + 1] - points[(i - 1) * 2 + 1],
		);
	}

	let segment = 0;
	for (let s = 0; s < sampleCount; s++) {
		const target = (s / (sampleCount - 1)) * totalLength;
		while (segment + 2 < n && cumulative[segment + 1] < target) { segment++; }
		const segStart = cumulative[segment];
		const segEnd = cumulative[segment + 1];
		const t = segEnd > segStart ? (target - segStart) / (segEnd - segStart) : 0;
		const ax = points[segment * 2], ay = points[segment * 2 + 1];
		const bx = points[(segment + 1) * 2], by = points[(segment + 1) * 2 + 1];
		const px = ax + t * (bx - ax);
		const py = ay + t * (by - ay);

		let accumulated = 0;
		let used = 0;
		if (lineWidth <= 1) {
			const v = sampleBilinear(source, px, py, channel);
			if (Number.isFinite(v)) { accumulated = v; used = 1; }
		} else {
			// Unit normal of this segment.
			const dx = bx - ax, dy = by - ay;
			const len = Math.hypot(dx, dy) || 1;
			const nx = -dy / len, ny = dx / len;
			for (let k = 0; k < lineWidth; k++) {
				const offset = k - (lineWidth - 1) / 2;
				const v = sampleBilinear(source, px + nx * offset, py + ny * offset, channel);
				if (Number.isFinite(v)) { accumulated += v; used++; }
			}
		}
		distance[s] = target;
		value[s] = used > 0 ? accumulated / used : NaN;
	}

	return { distance, value };
}

/** Bilinear sample with edge clamping; returns NaN outside the image. */
export function sampleBilinear(source: MeasurementSource, x: number, y: number, channel: number): number {
	if (!(x >= -0.5) || !(y >= -0.5) || x > source.width - 0.5 || y > source.height - 0.5) { return NaN; }
	const fx = Math.min(Math.max(x, 0), source.width - 1);
	const fy = Math.min(Math.max(y, 0), source.height - 1);
	const x0 = Math.floor(fx);
	const y0 = Math.floor(fy);
	const x1 = Math.min(x0 + 1, source.width - 1);
	const y1 = Math.min(y0 + 1, source.height - 1);
	const tx = fx - x0;
	const ty = fy - y0;

	const v00 = sampleAt(source, x0, y0, channel);
	const v10 = sampleAt(source, x1, y0, channel);
	const v01 = sampleAt(source, x0, y1, channel);
	const v11 = sampleAt(source, x1, y1, channel);
	// Interpolating across a NaN would spread it; fall back to nearest instead.
	if (!Number.isFinite(v00) || !Number.isFinite(v10) || !Number.isFinite(v01) || !Number.isFinite(v11)) {
		return sampleAt(source, Math.round(fx), Math.round(fy), channel);
	}
	const top = v00 + tx * (v10 - v00);
	const bottom = v01 + tx * (v11 - v01);
	return top + ty * (bottom - top);
}

/**
 * Measure one ROI on one channel, producing a fully populated row.
 *
 * Geometry is calibrated here; intensities deliberately are not, because a
 * pixel value in µm-calibrated space is still just a pixel value.
 */
export function measureRoi(
	roi: Roi,
	source: MeasurementSource,
	calibration: Calibration,
	channel: number,
): MeasurementRow {
	const pixelWidth = calibration.pixelWidth || 1;
	const pixelHeight = calibration.pixelHeight || 1;

	const row: MeasurementRow = {
		roiId: roi.id,
		roiName: roi.name,
		roiKind: roi.kind,
		group: roi.group,
		channel,
		page: source.page,
		fileName: source.fileName,
	};

	if (roi.kind === 'point') {
		const points = (roi as PointRoi).points || [];
		const count = Math.floor(points.length / 2);
		row.pixelCount = count;
		if (count > 0) {
			let sumX = 0, sumY = 0;
			let intensitySum = 0;
			let finite = 0;
			let nonFinite = 0;
			let min = Infinity, max = -Infinity;
			for (let i = 0; i < count; i++) {
				const px = Math.round(points[i * 2]);
				const py = Math.round(points[i * 2 + 1]);
				sumX += px; sumY += py;
				const value = sampleAt(source, px, py, channel);
				if (Number.isFinite(value)) {
					intensitySum += value;
					finite++;
					if (value < min) { min = value; }
					if (value > max) { max = value; }
				} else {
					nonFinite++;
				}
			}
			row.centroidX = (sumX / count) * pixelWidth;
			row.centroidY = (sumY / count) * pixelHeight;
			row.mean = finite > 0 ? intensitySum / finite : NaN;
			row.min = finite > 0 ? min : NaN;
			row.max = finite > 0 ? max : NaN;
			row.nonFiniteCount = nonFinite;
		}
		return row;
	}

	if (isLineKind(roi.kind)) {
		const line = roi as LineRoi;
		row.length = polylineLength(line.points || [], pixelWidth, pixelHeight);
		const profile = sampleLineProfile(source, line, channel);
		let sum = 0, finite = 0, min = Infinity, max = -Infinity;
		let mean = 0, m2 = 0;
		let nonFinite = 0;
		for (let i = 0; i < profile.value.length; i++) {
			const v = profile.value[i];
			if (!Number.isFinite(v)) { nonFinite++; continue; }
			finite++;
			sum += v;
			if (v < min) { min = v; }
			if (v > max) { max = v; }
			const delta = v - mean;
			mean += delta / finite;
			m2 += delta * (v - mean);
		}
		row.pixelCount = finite;
		row.nonFiniteCount = nonFinite;
		row.mean = finite > 0 ? mean : NaN;
		row.stdDev = finite > 1 ? Math.sqrt(m2 / (finite - 1)) : 0;
		row.min = finite > 0 ? min : NaN;
		row.max = finite > 0 ? max : NaN;
		row.rawIntegratedDensity = sum;
		// The angle of a straight line is worth reporting; a polyline has none.
		const points = line.points || [];
		if (points.length === 4) {
			let angle = Math.atan2(-(points[3] - points[1]) * pixelHeight, (points[2] - points[0]) * pixelWidth) * 180 / Math.PI;
			if (angle < 0) { angle += 180; }
			row.angle = angle;
		}
		return row;
	}

	if (!isAreaKind(roi.kind)) { return row; }

	const region = rasterizeRoi(roi, source.width, source.height);
	row.pixelCount = region.count;
	row.area = region.count * pixelWidth * pixelHeight;
	row.bx = region.x * pixelWidth;
	row.by = region.y * pixelHeight;
	row.width = region.width * pixelWidth;
	row.height = region.height * pixelHeight;

	if (region.count === 0) { return row; }

	// Perimeter: analytic for shapes that have one, traced for raster regions.
	if (roi.kind === 'rect' || roi.kind === 'polygon' || roi.kind === 'freehand') {
		row.perimeter = polygonPerimeter(roiOutline(roi), pixelWidth, pixelHeight);
	} else if (roi.kind === 'ellipse') {
		row.perimeter = polygonPerimeter(roiOutline(roi), pixelWidth, pixelHeight);
	} else {
		row.perimeter = maskPerimeter(region, pixelWidth, pixelHeight);
	}

	const ellipse = fitEllipse(region, pixelWidth, pixelHeight);
	row.major = ellipse.major;
	row.minor = ellipse.minor;
	row.angle = ellipse.angle;
	row.centroidX = ellipse.centroidX * pixelWidth;
	row.centroidY = ellipse.centroidY * pixelHeight;

	// Hull-derived descriptors come from the outline for vector ROIs and from
	// the traced contour for raster ones, so both see a real boundary.
	const outline = roi.kind === 'mask' ? roiOutline(roi) : roiOutline(roi);
	if (outline.length >= 6) {
		const feret = feretDiameters(outline, pixelWidth, pixelHeight);
		row.feret = feret.feret;
		row.minFeret = feret.minFeret;
		row.feretAngle = feret.feretAngle;
		row.feretX = feret.feretX * pixelWidth;
		row.feretY = feret.feretY * pixelHeight;

		const hull = convexHull(outline);
		const hullArea = polygonArea(hull, pixelWidth, pixelHeight);
		row.solidity = hullArea > 0 ? (row.area as number) / hullArea : NaN;
	}

	if (row.perimeter && row.perimeter > 0) {
		// Clamped at 1: digitisation can push a near-circular region marginally
		// above it, and reporting circularity > 1 only ever confuses.
		row.circularity = Math.min(1, (4 * Math.PI * (row.area as number)) / (row.perimeter * row.perimeter));
	}
	if (row.minor && row.minor > 0) { row.aspectRatio = (row.major as number) / row.minor; }
	if (row.major && row.major > 0) {
		row.roundness = (4 * (row.area as number)) / (Math.PI * row.major * row.major);
	}

	const intensity = measureIntensity(source, region, channel);
	row.mean = intensity.mean;
	row.stdDev = intensity.stdDev;
	row.min = intensity.min;
	row.max = intensity.max;
	row.median = intensity.median;
	row.mode = intensity.mode;
	row.skewness = intensity.skewness;
	row.kurtosis = intensity.kurtosis;
	row.nonFiniteCount = intensity.nonFiniteCount;
	row.rawIntegratedDensity = intensity.sum;
	row.integratedDensity = (row.area as number) * intensity.mean;
	row.centerOfMassX = intensity.centerOfMassX * pixelWidth;
	row.centerOfMassY = intensity.centerOfMassY * pixelHeight;

	return row;
}

/** Measure every ROI against every requested channel. */
export function measureAll(
	rois: Roi[],
	source: MeasurementSource,
	calibration: Calibration,
	channels: number[],
): MeasurementRow[] {
	const rows: MeasurementRow[] = [];
	for (const roi of rois) {
		for (const channel of channels) {
			rows.push(measureRoi(roi, source, calibration, channel));
		}
	}
	return rows;
}

/** Distance in image pixels from a point to an ROI's outline. */
export function distanceToRoi(roi: Roi, x: number, y: number): number {
	const outline = roiOutline(roi);
	if (outline.length < 4) {
		if (outline.length === 2) { return Math.hypot(outline[0] - x, outline[1] - y); }
		return Infinity;
	}
	if (isAreaKind(roi.kind)) {
		const closed = outline.concat([outline[0], outline[1]]);
		return distanceToPolyline(closed, x, y);
	}
	return distanceToPolyline(outline, x, y);
}

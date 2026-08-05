"use strict";

import {
	isAreaKind,
	type EllipseRoi,
	type PolygonRoi,
	type RectRoi,
	type Roi,
	type RoiMask,
} from './types.js';

/**
 * ROI geometry: rasterisation, contour extraction, and the shape descriptors
 * that ImageJ reports.
 *
 * Everything here works in image pixel coordinates with (x, y) naming the
 * centre of a pixel. A pixel is inside an area ROI when its centre is inside —
 * the same rule ImageJ applies, which matters because area counts must agree
 * with what people already have in their notebooks.
 */

const EMPTY_MASK: RoiMask = { x: 0, y: 0, width: 0, height: 0, mask: new Uint8Array(0), count: 0 };

/** Axis-aligned bounds of any ROI, clipped to nothing. */
export function roiBounds(roi: Roi): { x: number; y: number; width: number; height: number } {
	switch (roi.kind) {
		case 'rect':
		case 'ellipse':
		case 'mask': {
			const r = roi as RectRoi;
			return { x: r.x, y: r.y, width: r.width, height: r.height };
		}
		default: {
			const points = (roi as PolygonRoi).points || [];
			if (points.length < 2) { return { x: 0, y: 0, width: 0, height: 0 }; }
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (let i = 0; i + 1 < points.length; i += 2) {
				if (points[i] < minX) { minX = points[i]; }
				if (points[i] > maxX) { maxX = points[i]; }
				if (points[i + 1] < minY) { minY = points[i + 1]; }
				if (points[i + 1] > maxY) { maxY = points[i + 1]; }
			}
			return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
		}
	}
}

/** Rotate a point about a centre. */
function rotate(px: number, py: number, cx: number, cy: number, angle: number): [number, number] {
	if (!angle) { return [px, py]; }
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const dx = px - cx;
	const dy = py - cy;
	return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

/** Corner points of a (possibly rotated) rectangle ROI. */
export function rectCorners(roi: RectRoi): number[] {
	const { x, y, width, height } = roi;
	const cx = x + width / 2;
	const cy = y + height / 2;
	const angle = roi.angle || 0;
	const corners: number[] = [];
	for (const [px, py] of [
		[x, y],
		[x + width, y],
		[x + width, y + height],
		[x, y + height],
	] as [number, number][]) {
		const [rx, ry] = rotate(px, py, cx, cy, angle);
		corners.push(rx, ry);
	}
	return corners;
}

/** Polyline approximation of an ellipse ROI, for overlay drawing and hulls. */
export function ellipsePoints(roi: EllipseRoi, segments = 96): number[] {
	const rx = roi.width / 2;
	const ry = roi.height / 2;
	const cx = roi.x + rx;
	const cy = roi.y + ry;
	const angle = roi.angle || 0;
	const points: number[] = [];
	for (let i = 0; i < segments; i++) {
		const t = (i / segments) * Math.PI * 2;
		const [px, py] = rotate(cx + rx * Math.cos(t), cy + ry * Math.sin(t), cx, cy, angle);
		points.push(px, py);
	}
	return points;
}

/** Outline of an ROI as a flat point list, for drawing and hull computation. */
export function roiOutline(roi: Roi): number[] {
	switch (roi.kind) {
		case 'rect': return rectCorners(roi as RectRoi);
		case 'ellipse': return ellipsePoints(roi as EllipseRoi);
		case 'polygon':
		case 'freehand':
		case 'line':
		case 'polyline':
		case 'point': return ((roi as PolygonRoi).points || []).slice();
		case 'mask': return maskContour(roi as unknown as RoiMask & { mask: Uint8Array });
		default: return [];
	}
}

/**
 * Rasterise an area ROI to a bounding box plus inclusion mask.
 *
 * Polygons use an even-odd scanline test evaluated at pixel centres. The
 * classic half-open comparison (`y0 <= cy < y1`) is what keeps shared edges
 * between adjacent polygons from being counted twice.
 */
export function rasterizeRoi(roi: Roi, imageWidth: number, imageHeight: number): RoiMask {
	if (!isAreaKind(roi.kind)) { return EMPTY_MASK; }

	if (roi.kind === 'mask') {
		const m = roi as unknown as { x: number; y: number; width: number; height: number; mask: Uint8Array };
		// Segmentation output is already pixel-aligned; only clip it.
		return clipMask(m.x, m.y, m.width, m.height, m.mask, imageWidth, imageHeight);
	}

	if (roi.kind === 'rect' && !(roi as RectRoi).angle) {
		const r = roi as RectRoi;
		const x0 = Math.max(0, Math.round(r.x));
		const y0 = Math.max(0, Math.round(r.y));
		const x1 = Math.min(imageWidth, Math.round(r.x + r.width));
		const y1 = Math.min(imageHeight, Math.round(r.y + r.height));
		const width = Math.max(0, x1 - x0);
		const height = Math.max(0, y1 - y0);
		const mask = new Uint8Array(width * height);
		mask.fill(1);
		return { x: x0, y: y0, width, height, mask, count: width * height };
	}

	const outline = roi.kind === 'ellipse'
		? ellipsePoints(roi as EllipseRoi, 256)
		: roi.kind === 'rect'
			? rectCorners(roi as RectRoi)
			: (roi as PolygonRoi).points || [];

	return rasterizePolygon(outline, imageWidth, imageHeight);
}

/** Even-odd scanline fill of a closed polygon at pixel centres. */
export function rasterizePolygon(points: number[], imageWidth: number, imageHeight: number): RoiMask {
	const n = Math.floor(points.length / 2);
	if (n < 3) { return EMPTY_MASK; }

	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (let i = 0; i < n; i++) {
		const px = points[i * 2];
		const py = points[i * 2 + 1];
		if (px < minX) { minX = px; }
		if (px > maxX) { maxX = px; }
		if (py < minY) { minY = py; }
		if (py > maxY) { maxY = py; }
	}

	const x0 = Math.max(0, Math.floor(minX));
	const y0 = Math.max(0, Math.floor(minY));
	const x1 = Math.min(imageWidth, Math.ceil(maxX) + 1);
	const y1 = Math.min(imageHeight, Math.ceil(maxY) + 1);
	const width = Math.max(0, x1 - x0);
	const height = Math.max(0, y1 - y0);
	if (width === 0 || height === 0) { return EMPTY_MASK; }

	const mask = new Uint8Array(width * height);
	let count = 0;
	const crossings: number[] = [];

	for (let row = 0; row < height; row++) {
		const cy = y0 + row + 0.5;
		crossings.length = 0;
		for (let i = 0; i < n; i++) {
			const ax = points[i * 2];
			const ay = points[i * 2 + 1];
			const j = (i + 1) % n;
			const bx = points[j * 2];
			const by = points[j * 2 + 1];
			// Half-open in y so a vertex shared by two edges crosses exactly once.
			if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) {
				crossings.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
			}
		}
		if (crossings.length < 2) { continue; }
		crossings.sort((a, b) => a - b);
		for (let k = 0; k + 1 < crossings.length; k += 2) {
			const spanStart = Math.max(x0, Math.ceil(crossings[k] - 0.5));
			const spanEnd = Math.min(x1 - 1, Math.floor(crossings[k + 1] - 0.5));
			for (let px = spanStart; px <= spanEnd; px++) {
				const index = row * width + (px - x0);
				if (!mask[index]) { mask[index] = 1; count++; }
			}
		}
	}

	return { x: x0, y: y0, width, height, mask, count };
}

/** Clip an existing mask to the image, tightening the bounding box. */
function clipMask(
	x: number, y: number, width: number, height: number,
	mask: Uint8Array, imageWidth: number, imageHeight: number,
): RoiMask {
	const x0 = Math.max(0, x);
	const y0 = Math.max(0, y);
	const x1 = Math.min(imageWidth, x + width);
	const y1 = Math.min(imageHeight, y + height);
	const outWidth = Math.max(0, x1 - x0);
	const outHeight = Math.max(0, y1 - y0);
	if (outWidth === width && outHeight === height && x0 === x && y0 === y) {
		let count = 0;
		for (let i = 0; i < mask.length; i++) { if (mask[i]) { count++; } }
		return { x, y, width, height, mask, count };
	}
	const out = new Uint8Array(outWidth * outHeight);
	let count = 0;
	for (let row = 0; row < outHeight; row++) {
		const srcRow = (row + y0 - y) * width + (x0 - x);
		for (let col = 0; col < outWidth; col++) {
			const value = mask[srcRow + col];
			if (value) { out[row * outWidth + col] = 1; count++; }
		}
	}
	return { x: x0, y: y0, width: outWidth, height: outHeight, mask: out, count };
}

/**
 * Moore-neighbourhood contour of the largest connected component of a mask,
 * returned in image coordinates. Used to draw segmentation ROIs and to give
 * them a polygon form for hull-based descriptors.
 */
export function maskContour(m: { x: number; y: number; width: number; height: number; mask: Uint8Array }): number[] {
	const { width, height, mask } = m;
	const inside = (cx: number, cy: number) =>
		cx >= 0 && cy >= 0 && cx < width && cy < height && mask[cy * width + cx] !== 0;

	let startX = -1, startY = -1;
	for (let y = 0; y < height && startX < 0; y++) {
		for (let x = 0; x < width; x++) {
			if (inside(x, y)) { startX = x; startY = y; break; }
		}
	}
	if (startX < 0) { return []; }

	// Eight-connected Moore tracing. Neighbours are indexed in a fixed circular
	// order starting at west, so "one step past where we came from" is a simple
	// modular offset.
	const dx = [-1, -1, 0, 1, 1, 1, 0, -1];
	const dy = [0, -1, -1, -1, 0, 1, 1, 1];
	const contour: number[] = [];
	let cx = startX, cy = startY;
	// The scan that found the start pixel went left to right, top to bottom, so
	// its western neighbour is background. Pretending we arrived travelling east
	// puts the backtrack there and makes the first probe start just past it.
	let dir = 4;
	const maxSteps = width * height * 8 + 16;
	for (let step = 0; step < maxSteps; step++) {
		contour.push(m.x + cx, m.y + cy);
		let found = false;
		// The pixel we came from lies at (dir + 4); resume the sweep at the very
		// next neighbour. Starting any later skips candidates and lets the trace
		// cut back across the interior instead of following the boundary.
		for (let k = 0; k < 8; k++) {
			const probe = (dir + 5 + k) % 8;
			const nx = cx + dx[probe];
			const ny = cy + dy[probe];
			if (inside(nx, ny)) {
				cx = nx; cy = ny; dir = probe; found = true;
				break;
			}
		}
		if (!found) { break; }
		if (cx === startX && cy === startY) { break; }
	}
	return contour;
}

/** Length of a closed polygon. */
export function polygonPerimeter(points: number[], pixelWidth = 1, pixelHeight = 1): number {
	const n = Math.floor(points.length / 2);
	if (n < 2) { return 0; }
	let total = 0;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		const dx = (points[j * 2] - points[i * 2]) * pixelWidth;
		const dy = (points[j * 2 + 1] - points[i * 2 + 1]) * pixelHeight;
		total += Math.hypot(dx, dy);
	}
	return total;
}

/** Length of an open polyline. */
export function polylineLength(points: number[], pixelWidth = 1, pixelHeight = 1): number {
	const n = Math.floor(points.length / 2);
	if (n < 2) { return 0; }
	let total = 0;
	for (let i = 0; i + 1 < n; i++) {
		const dx = (points[(i + 1) * 2] - points[i * 2]) * pixelWidth;
		const dy = (points[(i + 1) * 2 + 1] - points[i * 2 + 1]) * pixelHeight;
		total += Math.hypot(dx, dy);
	}
	return total;
}

/** Signed area of a closed polygon (shoelace); positive for CCW. */
export function polygonArea(points: number[], pixelWidth = 1, pixelHeight = 1): number {
	const n = Math.floor(points.length / 2);
	if (n < 3) { return 0; }
	let sum = 0;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		sum += points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
	}
	return Math.abs(sum) / 2 * pixelWidth * pixelHeight;
}

/**
 * Perimeter of a rasterised region, traced on the mask boundary.
 *
 * Raw staircase tracing overestimates a smooth boundary by up to ~4/π. ImageJ
 * corrects this by weighting the straight and diagonal steps of the traced
 * outline; we do the same, which keeps circularity of a digital disc near 1
 * instead of near 0.8.
 */
export function maskPerimeter(
	m: { x: number; y: number; width: number; height: number; mask: Uint8Array },
	pixelWidth = 1,
	pixelHeight = 1,
): number {
	const contour = maskContour(m);
	const n = Math.floor(contour.length / 2);
	if (n < 2) { return 0; }
	let straight = 0;
	let diagonal = 0;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		const dx = Math.abs(contour[j * 2] - contour[i * 2]);
		const dy = Math.abs(contour[j * 2 + 1] - contour[i * 2 + 1]);
		if (dx && dy) { diagonal++; } else if (dx || dy) { straight++; }
	}
	const scale = (pixelWidth + pixelHeight) / 2;
	// Weights from the standard corrected-perimeter estimator for 8-connected
	// chain codes (Vossepoel & Smeulders): straight 0.948, diagonal 1.340.
	return (straight * 0.948 + diagonal * 1.340) * scale;
}

/** Monotone-chain convex hull. Returns a flat CCW point list. */
export function convexHull(points: number[]): number[] {
	const n = Math.floor(points.length / 2);
	if (n < 3) { return points.slice(); }
	const sorted: [number, number][] = [];
	for (let i = 0; i < n; i++) { sorted.push([points[i * 2], points[i * 2 + 1]]); }
	sorted.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

	const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
		(a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

	const lower: [number, number][] = [];
	for (const p of sorted) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) { lower.pop(); }
		lower.push(p);
	}
	const upper: [number, number][] = [];
	for (let i = sorted.length - 1; i >= 0; i--) {
		const p = sorted[i];
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) { upper.pop(); }
		upper.push(p);
	}
	lower.pop();
	upper.pop();
	const hull: number[] = [];
	for (const p of lower.concat(upper)) { hull.push(p[0], p[1]); }
	return hull;
}

export interface FeretResult {
	feret: number;
	feretAngle: number;
	minFeret: number;
	/** Start point of the maximum calliper span, in image pixels. */
	feretX: number;
	feretY: number;
}

/**
 * Maximum and minimum calliper diameters.
 *
 * The maximum is an all-pairs search on the hull (hulls here are small, and it
 * avoids the antipodal-pair edge cases that make rotating callipers fiddly).
 * The minimum uses the standard result that the minimum width is attained with
 * one hull edge flush against the calliper.
 *
 * Calibration is applied to the coordinates before measuring, so anisotropic
 * pixels give correct diameters rather than a scaled pixel answer.
 */
export function feretDiameters(points: number[], pixelWidth = 1, pixelHeight = 1): FeretResult {
	const hull = convexHull(points);
	const n = Math.floor(hull.length / 2);
	const result: FeretResult = { feret: 0, feretAngle: 0, minFeret: 0, feretX: 0, feretY: 0 };
	if (n === 0) { return result; }
	if (n === 1) { return result; }

	const hx = new Float64Array(n);
	const hy = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		hx[i] = hull[i * 2] * pixelWidth;
		hy[i] = hull[i * 2 + 1] * pixelHeight;
	}

	let best = -1;
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const d = Math.hypot(hx[j] - hx[i], hy[j] - hy[i]);
			if (d > best) {
				best = d;
				result.feret = d;
				// Report the angle in the conventional 0–180° range with y up,
				// matching how ImageJ prints FeretAngle.
				let angle = Math.atan2(-(hy[j] - hy[i]), hx[j] - hx[i]) * 180 / Math.PI;
				if (angle < 0) { angle += 180; }
				result.feretAngle = angle;
				result.feretX = hull[i * 2];
				result.feretY = hull[i * 2 + 1];
			}
		}
	}

	if (n < 3) {
		result.minFeret = 0;
		return result;
	}

	let minWidth = Infinity;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		const ex = hx[j] - hx[i];
		const ey = hy[j] - hy[i];
		const len = Math.hypot(ex, ey);
		if (len === 0) { continue; }
		// Distance of the farthest hull vertex from this edge's supporting line.
		let maxDistance = 0;
		for (let k = 0; k < n; k++) {
			const distance = Math.abs((hx[k] - hx[i]) * ey - (hy[k] - hy[i]) * ex) / len;
			if (distance > maxDistance) { maxDistance = distance; }
		}
		if (maxDistance < minWidth) { minWidth = maxDistance; }
	}
	result.minFeret = Number.isFinite(minWidth) ? minWidth : 0;
	return result;
}

export interface EllipseFit {
	major: number;
	minor: number;
	/** Degrees, 0–180, y-up convention. */
	angle: number;
	centroidX: number;
	centroidY: number;
}

/**
 * Best-fit ellipse from the second-order moments of a rasterised region — the
 * same construction ImageJ's "Fit ellipse" uses. The axes are scaled so the
 * ellipse has the same area as the region, which is what makes major/minor
 * comparable to a physical object's extent rather than to its variance.
 */
export function fitEllipse(m: RoiMask, pixelWidth = 1, pixelHeight = 1): EllipseFit {
	const { width, height, mask } = m;
	let n = 0, sumX = 0, sumY = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (!mask[y * width + x]) { continue; }
			n++; sumX += x; sumY += y;
		}
	}
	if (n === 0) { return { major: 0, minor: 0, angle: 0, centroidX: 0, centroidY: 0 }; }

	const meanX = sumX / n;
	const meanY = sumY / n;
	let xx = 0, yy = 0, xy = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (!mask[y * width + x]) { continue; }
			const dx = (x - meanX) * pixelWidth;
			const dy = (y - meanY) * pixelHeight;
			xx += dx * dx; yy += dy * dy; xy += dx * dy;
		}
	}
	xx /= n; yy /= n; xy /= n;
	// A single-pixel-wide region has zero variance across its width; the 1/12
	// term is the variance of a unit pixel and keeps the minor axis from
	// collapsing to zero.
	xx += (pixelWidth * pixelWidth) / 12;
	yy += (pixelHeight * pixelHeight) / 12;

	const common = Math.sqrt(Math.max(0, (xx - yy) * (xx - yy) + 4 * xy * xy));
	const lambda1 = (xx + yy + common) / 2;
	const lambda2 = (xx + yy - common) / 2;
	let major = 4 * Math.sqrt(Math.max(0, lambda1));
	let minor = 4 * Math.sqrt(Math.max(0, lambda2));

	// Normalise so π/4·major·minor equals the measured area.
	const area = n * pixelWidth * pixelHeight;
	const ellipseArea = (Math.PI / 4) * major * minor;
	if (ellipseArea > 0) {
		const scale = Math.sqrt(area / ellipseArea);
		major *= scale;
		minor *= scale;
	}

	let angle = 0.5 * Math.atan2(2 * xy, xx - yy) * 180 / Math.PI;
	// Screen y grows downward; report the angle the way a user sees it.
	angle = -angle;
	if (angle < 0) { angle += 180; }
	if (angle >= 180) { angle -= 180; }

	return {
		major,
		minor,
		angle,
		centroidX: m.x + meanX,
		centroidY: m.y + meanY,
	};
}

/** Point-in-ROI test used for hit testing and for wand-inside checks. */
export function roiContains(roi: Roi, x: number, y: number): boolean {
	if (!isAreaKind(roi.kind)) { return false; }
	if (roi.kind === 'mask') {
		const m = roi as unknown as { x: number; y: number; width: number; height: number; mask: Uint8Array };
		const lx = Math.floor(x) - m.x;
		const ly = Math.floor(y) - m.y;
		if (lx < 0 || ly < 0 || lx >= m.width || ly >= m.height) { return false; }
		return m.mask[ly * m.width + lx] !== 0;
	}
	if (roi.kind === 'rect' && !(roi as RectRoi).angle) {
		const r = roi as RectRoi;
		return x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height;
	}
	const outline = roiOutline(roi);
	return pointInPolygon(outline, x, y);
}

export function pointInPolygon(points: number[], x: number, y: number): boolean {
	const n = Math.floor(points.length / 2);
	let inside = false;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const xi = points[i * 2], yi = points[i * 2 + 1];
		const xj = points[j * 2], yj = points[j * 2 + 1];
		if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
	}
	return inside;
}

/** Squared distance from a point to a polyline, for line-ROI hit testing. */
export function distanceToPolyline(points: number[], x: number, y: number): number {
	const n = Math.floor(points.length / 2);
	if (n === 0) { return Infinity; }
	if (n === 1) { return Math.hypot(points[0] - x, points[1] - y); }
	let best = Infinity;
	for (let i = 0; i + 1 < n; i++) {
		const ax = points[i * 2], ay = points[i * 2 + 1];
		const bx = points[(i + 1) * 2], by = points[(i + 1) * 2 + 1];
		const dx = bx - ax, dy = by - ay;
		const lengthSquared = dx * dx + dy * dy;
		let t = lengthSquared === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / lengthSquared;
		t = Math.max(0, Math.min(1, t));
		const distance = Math.hypot(ax + t * dx - x, ay + t * dy - y);
		if (distance < best) { best = distance; }
	}
	return best;
}

/**
 * Reduce a freehand trace to its significant vertices (Ramer-Douglas-Peucker).
 * Freehand drawing produces one point per mouse event; storing all of them
 * makes the JSON sidecar unreadable and slows hit testing for no visual gain.
 */
export function simplifyPolyline(points: number[], tolerance = 0.75): number[] {
	const n = Math.floor(points.length / 2);
	if (n < 3) { return points.slice(); }
	const keep = new Uint8Array(n);
	keep[0] = 1;
	keep[n - 1] = 1;

	const stack: [number, number][] = [[0, n - 1]];
	while (stack.length) {
		const [first, last] = stack.pop()!;
		if (last <= first + 1) { continue; }
		const ax = points[first * 2], ay = points[first * 2 + 1];
		const bx = points[last * 2], by = points[last * 2 + 1];
		const dx = bx - ax, dy = by - ay;
		const lengthSquared = dx * dx + dy * dy;
		let worst = -1;
		let worstIndex = -1;
		for (let i = first + 1; i < last; i++) {
			const px = points[i * 2], py = points[i * 2 + 1];
			let distance: number;
			if (lengthSquared === 0) {
				distance = Math.hypot(px - ax, py - ay);
			} else {
				let t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
				t = Math.max(0, Math.min(1, t));
				distance = Math.hypot(ax + t * dx - px, ay + t * dy - py);
			}
			if (distance > worst) { worst = distance; worstIndex = i; }
		}
		if (worst > tolerance && worstIndex > 0) {
			keep[worstIndex] = 1;
			stack.push([first, worstIndex], [worstIndex, last]);
		}
	}

	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		if (keep[i]) { out.push(points[i * 2], points[i * 2 + 1]); }
	}
	return out;
}

"use strict";

import type { MaskRoi } from './types.js';

/**
 * Particle analysis: turning a binary mask into individual objects.
 *
 * The pipeline is the familiar one — label, optionally split touching objects,
 * filter by size and shape, emit one ROI per surviving object — but the whole
 * thing runs on typed arrays with no per-pixel allocation, because it is
 * re-run on every threshold change and has to stay interactive.
 */

export interface LabelResult {
	/** 0 means background; labels are 1..count. */
	labels: Int32Array;
	count: number;
	width: number;
	height: number;
}

/**
 * Connected-component labelling by union-find over a single raster pass.
 *
 * Eight-connectivity is the default because objects that touch only at a corner
 * are almost always one object in practice; four-connectivity is offered for
 * users who need to match an existing ImageJ pipeline.
 */
export function labelComponents(
	mask: Uint8Array,
	width: number,
	height: number,
	connectivity: 4 | 8 = 8,
): LabelResult {
	const labels = new Int32Array(width * height);
	// Worst case is one provisional label per two pixels (checkerboard).
	const parent = new Int32Array(Math.floor(width * height / 2) + 2);
	let nextLabel = 1;

	const find = (a: number): number => {
		let root = a;
		while (parent[root] !== root) { root = parent[root]; }
		// Path compression keeps the second pass near-linear on striped shapes.
		let node = a;
		while (parent[node] !== root) {
			const next = parent[node];
			parent[node] = root;
			node = next;
		}
		return root;
	};
	const union = (a: number, b: number): void => {
		const rootA = find(a);
		const rootB = find(b);
		if (rootA !== rootB) { parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB); }
	};

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const index = y * width + x;
			if (!mask[index]) { continue; }

			let best = 0;
			const consider = (nx: number, ny: number) => {
				if (nx < 0 || ny < 0 || nx >= width || ny >= height) { return; }
				const neighbour = labels[ny * width + nx];
				if (!neighbour) { return; }
				if (best === 0) { best = neighbour; } else { union(best, neighbour); best = Math.min(best, neighbour); }
			};

			consider(x - 1, y);
			consider(x, y - 1);
			if (connectivity === 8) {
				consider(x - 1, y - 1);
				consider(x + 1, y - 1);
			}

			if (best === 0) {
				if (nextLabel >= parent.length) { break; }
				parent[nextLabel] = nextLabel;
				labels[index] = nextLabel;
				nextLabel++;
			} else {
				labels[index] = best;
			}
		}
	}

	// Second pass: resolve to root labels and renumber them densely.
	const remap = new Int32Array(nextLabel);
	let count = 0;
	for (let i = 0; i < labels.length; i++) {
		const label = labels[i];
		if (!label) { continue; }
		const root = find(label);
		if (remap[root] === 0) { remap[root] = ++count; }
		labels[i] = remap[root];
	}

	return { labels, count, width, height };
}

export interface ParticleFilter {
	/** Minimum/maximum area in pixels. */
	minArea?: number;
	maxArea?: number;
	minCircularity?: number;
	maxCircularity?: number;
	/** Drop objects that touch the image border — they are cut off, so their
	 *  area and shape are not measurable. */
	excludeEdges?: boolean;
	/** Fill interior holes before measuring. */
	fillHoles?: boolean;
	connectivity?: 4 | 8;
}

export interface Particle {
	label: number;
	x: number;
	y: number;
	width: number;
	height: number;
	mask: Uint8Array;
	area: number;
	touchesEdge: boolean;
}

/** Split a labelled image into per-object bounding-box masks. */
export function extractParticles(labelResult: LabelResult): Particle[] {
	const { labels, count, width, height } = labelResult;
	if (count === 0) { return []; }

	const minX = new Int32Array(count + 1).fill(width);
	const minY = new Int32Array(count + 1).fill(height);
	const maxX = new Int32Array(count + 1).fill(-1);
	const maxY = new Int32Array(count + 1).fill(-1);
	const area = new Int32Array(count + 1);
	const edge = new Uint8Array(count + 1);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const label = labels[y * width + x];
			if (!label) { continue; }
			if (x < minX[label]) { minX[label] = x; }
			if (x > maxX[label]) { maxX[label] = x; }
			if (y < minY[label]) { minY[label] = y; }
			if (y > maxY[label]) { maxY[label] = y; }
			area[label]++;
			if (x === 0 || y === 0 || x === width - 1 || y === height - 1) { edge[label] = 1; }
		}
	}

	const particles: Particle[] = [];
	for (let label = 1; label <= count; label++) {
		if (maxX[label] < 0) { continue; }
		const bx = minX[label];
		const by = minY[label];
		const bw = maxX[label] - bx + 1;
		const bh = maxY[label] - by + 1;
		const mask = new Uint8Array(bw * bh);
		for (let row = 0; row < bh; row++) {
			const sourceRow = (by + row) * width + bx;
			for (let col = 0; col < bw; col++) {
				if (labels[sourceRow + col] === label) { mask[row * bw + col] = 1; }
			}
		}
		particles.push({
			label,
			x: bx, y: by, width: bw, height: bh,
			mask,
			area: area[label],
			touchesEdge: edge[label] !== 0,
		});
	}
	return particles;
}

/**
 * Fill interior holes of a per-object mask.
 *
 * Implemented as a flood fill of the background from a one-pixel border added
 * around the object: anything the fill cannot reach is enclosed, and therefore
 * a hole. Padding is what makes objects that touch their own bounding box work.
 */
export function fillMaskHoles(mask: Uint8Array, width: number, height: number): Uint8Array {
	const paddedWidth = width + 2;
	const paddedHeight = height + 2;
	const outside = new Uint8Array(paddedWidth * paddedHeight);
	const stack = new Int32Array(paddedWidth * paddedHeight);
	let top = 0;
	stack[top++] = 0;
	outside[0] = 1;

	const isBackground = (px: number, py: number): boolean => {
		const x = px - 1;
		const y = py - 1;
		if (x < 0 || y < 0 || x >= width || y >= height) { return true; }
		return mask[y * width + x] === 0;
	};

	while (top > 0) {
		const index = stack[--top];
		const px = index % paddedWidth;
		const py = (index / paddedWidth) | 0;
		const push = (nx: number, ny: number) => {
			if (nx < 0 || ny < 0 || nx >= paddedWidth || ny >= paddedHeight) { return; }
			const neighbour = ny * paddedWidth + nx;
			if (outside[neighbour] || !isBackground(nx, ny)) { return; }
			outside[neighbour] = 1;
			stack[top++] = neighbour;
		};
		push(px - 1, py); push(px + 1, py); push(px, py - 1); push(px, py + 1);
	}

	const filled = new Uint8Array(mask.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const index = y * width + x;
			filled[index] = (mask[index] || !outside[(y + 1) * paddedWidth + (x + 1)]) ? 1 : 0;
		}
	}
	return filled;
}

/**
 * Squared Euclidean distance transform (Felzenszwalb & Huttenlocher).
 *
 * Exact and linear in the pixel count, unlike the chamfer approximations that
 * make watershed seeds drift on elongated objects.
 */
export function distanceTransform(mask: Uint8Array, width: number, height: number): Float64Array {
	const INF = 1e20;
	const result = new Float64Array(width * height);
	for (let i = 0; i < result.length; i++) { result[i] = mask[i] ? INF : 0; }

	const size = Math.max(width, height);
	const f = new Float64Array(size);
	const d = new Float64Array(size);
	const v = new Int32Array(size);
	const z = new Float64Array(size + 1);

	const transform1d = (n: number) => {
		let k = 0;
		v[0] = 0;
		z[0] = -INF;
		z[1] = INF;
		for (let q = 1; q < n; q++) {
			let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
			while (s <= z[k]) {
				k--;
				s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
			}
			k++;
			v[k] = q;
			z[k] = s;
			z[k + 1] = INF;
		}
		k = 0;
		for (let q = 0; q < n; q++) {
			while (z[k + 1] < q) { k++; }
			d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
		}
	};

	for (let x = 0; x < width; x++) {
		for (let y = 0; y < height; y++) { f[y] = result[y * width + x]; }
		transform1d(height);
		for (let y = 0; y < height; y++) { result[y * width + x] = d[y]; }
	}
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) { f[x] = result[y * width + x]; }
		transform1d(width);
		for (let x = 0; x < width; x++) { result[y * width + x] = d[x]; }
	}
	return result;
}

/**
 * Watershed by basin dynamics, over an arbitrary height map.
 *
 * Pixels are flooded in order of decreasing height, so each peak creates a
 * basin before its slopes are reached. Where two basins meet, the decision to
 * split or merge is made on the depth of the saddle below the *shallower* of the
 * two peaks: a real boundary between two objects sits deep, while a ragged
 * outline or a noisy plateau produces two peaks a hair apart and is kept whole.
 *
 * `tolerance` is that depth, in the units of `height`. Comparing the two
 * adjacent pixels' heights instead — the obvious-looking alternative — always
 * merges, because neighbouring pixels of a smooth height map never differ by
 * much.
 *
 * The same routine drives two very different tools, which is the point of
 * factoring it out: run it on a distance transform and `tolerance` is a shape
 * criterion in pixels; run it on the image itself and `tolerance` is prominence,
 * the intensity a peak must rise above its surroundings to count as its own
 * object.
 */
export function dynamicsWatershed(
	height: Float64Array | Float32Array,
	mask: Uint8Array,
	width: number,
	imageHeight: number,
	tolerance: number,
): { labels: Int32Array; count: number } {
	const size = width * imageHeight;
	const labels = new Int32Array(size);

	let maxHeight = -Infinity;
	let minHeight = Infinity;
	for (let i = 0; i < size; i++) {
		if (!mask[i]) { continue; }
		const value = height[i];
		if (!Number.isFinite(value)) { continue; }
		if (value > maxHeight) { maxHeight = value; }
		if (value < minHeight) { minHeight = value; }
	}
	if (!Number.isFinite(maxHeight) || maxHeight === minHeight) {
		// Nothing to split: hand back a single basin covering the mask.
		let any = 0;
		for (let i = 0; i < size; i++) { if (mask[i]) { labels[i] = 1; any = 1; } }
		return { labels, count: any };
	}

	// Counting sort over quantised heights: an O(n log n) comparison sort on a
	// megapixel image would dominate the whole pass.
	const levels = 4096;
	const scale = (levels - 1) / (maxHeight - minHeight);
	const bucketCounts = new Int32Array(levels + 1);
	const quantised = new Int32Array(size);
	for (let i = 0; i < size; i++) {
		if (!mask[i] || !Number.isFinite(height[i])) { quantised[i] = -1; continue; }
		const level = Math.round((height[i] - minHeight) * scale);
		quantised[i] = level;
		bucketCounts[level]++;
	}
	const bucketStart = new Int32Array(levels + 2);
	// Descending, so the peaks are flooded first.
	for (let level = levels - 1; level >= 0; level--) {
		bucketStart[level] = bucketStart[level + 1] + bucketCounts[level + 1];
	}
	const order = new Int32Array(size);
	const cursor = bucketStart.slice();
	let ordered = 0;
	for (let i = 0; i < size; i++) {
		const level = quantised[i];
		if (level < 0) { continue; }
		order[cursor[level]++] = i;
		ordered++;
	}

	const WATERSHED = -1;
	const peaks: number[] = [0];
	const parent: number[] = [0];
	const find = (label: number): number => {
		let root = label;
		while (parent[root] !== root) { root = parent[root]; }
		let node = label;
		while (parent[node] !== root) { const next = parent[node]; parent[node] = root; node = next; }
		return root;
	};

	let nextLabel = 0;
	for (let k = 0; k < ordered; k++) {
		const index = order[k];
		const x = index % width;
		const y = (index / width) | 0;
		const own = height[index];

		let assigned = 0;
		let conflict = false;
		for (let dy = -1; dy <= 1; dy++) {
			const ny = y + dy;
			if (ny < 0 || ny >= imageHeight) { continue; }
			for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) { continue; }
				const nx = x + dx;
				if (nx < 0 || nx >= width) { continue; }
				const raw = labels[ny * width + nx];
				if (raw <= 0) { continue; }
				const neighbour = find(raw);
				if (assigned === 0) { assigned = neighbour; continue; }
				if (assigned === neighbour) { continue; }

				const depth = Math.min(peaks[assigned], peaks[neighbour]) - own;
				if (depth <= tolerance) {
					const to = Math.min(assigned, neighbour);
					const from = Math.max(assigned, neighbour);
					parent[from] = to;
					peaks[to] = Math.max(peaks[to], peaks[from]);
					assigned = to;
				} else {
					conflict = true;
				}
			}
		}

		if (conflict) {
			labels[index] = WATERSHED;
		} else if (assigned === 0) {
			nextLabel++;
			parent[nextLabel] = nextLabel;
			peaks[nextLabel] = own;
			labels[index] = nextLabel;
		} else {
			labels[index] = assigned;
		}
	}

	// Renumber to dense roots so the caller gets a usable component count.
	const remap = new Int32Array(nextLabel + 1);
	let count = 0;
	for (let i = 0; i < size; i++) {
		const label = labels[i];
		if (label <= 0) { labels[i] = label === WATERSHED ? 0 : 0; continue; }
		const root = find(label);
		if (remap[root] === 0) { remap[root] = ++count; }
		labels[i] = remap[root];
	}

	return { labels, count };
}

/**
 * Split touching objects by a distance-transform watershed.
 *
 * The classic shape-based separation: two round cells that overlap have two
 * distinct distance-to-background peaks with a saddle between them, so they come
 * apart even though thresholding merged them. `tolerance` is in pixels.
 */
export function watershedSplit(
	mask: Uint8Array,
	width: number,
	height: number,
	tolerance = 0.5,
): Uint8Array {
	// The transform returns squared distances; take the root so `tolerance`
	// means pixels rather than pixels squared.
	const squared = distanceTransform(mask, width, height);
	const distance = new Float64Array(squared.length);
	for (let i = 0; i < squared.length; i++) { distance[i] = Math.sqrt(squared[i]); }

	const { labels } = dynamicsWatershed(distance, mask, width, height, tolerance);
	const out = new Uint8Array(mask.length);
	for (let i = 0; i < out.length; i++) { out[i] = labels[i] > 0 ? 1 : 0; }
	return out;
}

/**
 * Split by intensity maxima — the equivalent of ImageJ's "Find Maxima" with
 * output "Segmented Particles", restricted to a thresholded mask.
 *
 * Where the distance transform separates by *shape*, this separates by
 * *brightness*: each local intensity maximum that rises at least `prominence`
 * above the saddle connecting it to a brighter one becomes its own object. That
 * is the right tool when cells touch without their outline pinching — nuclei
 * packed edge to edge, where a distance-transform watershed finds one blob.
 *
 * In ImageJ this workflow needs two images and an AND in the Image Calculator:
 * one from Find Maxima, one from the threshold. Here the threshold mask is
 * simply the region the maxima are computed in, so the combination is implicit
 * and there is nothing to keep in sync.
 */
export function splitByIntensityMaxima(
	plane: Float32Array,
	mask: Uint8Array,
	width: number,
	height: number,
	prominence: number,
): Uint8Array {
	const { labels } = dynamicsWatershed(plane, mask, width, height, prominence);
	const out = new Uint8Array(mask.length);
	for (let i = 0; i < out.length; i++) { out[i] = labels[i] > 0 ? 1 : 0; }
	return out;
}

/**
 * Count the intensity maxima a given prominence would accept.
 *
 * Used to report "this prominence finds N centres" while the value is being
 * adjusted, which is how ImageJ's preview point selection is normally used —
 * turn the number until the count matches what you can see.
 */
export function countIntensityMaxima(
	plane: Float32Array,
	mask: Uint8Array,
	width: number,
	height: number,
	prominence: number,
): number {
	return dynamicsWatershed(plane, mask, width, height, prominence).count;
}

export interface AnalyzeParticlesResult {
	particles: Particle[];
	/** Objects dropped by each filter, for the "why did my count change" line. */
	rejected: { tooSmall: number; tooLarge: number; shape: number; edge: number };
	totalBeforeFilters: number;
}

export type SplitMode = 'none' | 'shape' | 'intensity';

export interface AnalyzeParticlesOptions {
	/**
	 * How to separate objects that thresholding merged.
	 *
	 * - `shape` — distance-transform watershed; for round objects that overlap.
	 * - `intensity` — split at intensity maxima; for objects that touch without
	 *   their outline pinching, where a shape watershed finds one blob.
	 */
	split?: SplitMode;
	/** Saddle depth in pixels for `shape`. */
	watershedTolerance?: number;
	/** Prominence in data units for `intensity`. */
	prominence?: number;
	/** Required for `intensity`: the scalar image the mask was thresholded from. */
	plane?: Float32Array;
	/** Back-compatible alias for `split: 'shape'`. */
	watershed?: boolean;
}

/** Full particle pass: optional hole filling and splitting, then filtering. */
export function analyzeParticles(
	mask: Uint8Array,
	width: number,
	height: number,
	filter: ParticleFilter = {},
	options: AnalyzeParticlesOptions = {},
): AnalyzeParticlesResult {
	let working = mask;

	const split: SplitMode = options.split ?? (options.watershed ? 'shape' : 'none');
	if (split === 'shape') {
		working = watershedSplit(working, width, height, options.watershedTolerance ?? 0.5);
	} else if (split === 'intensity' && options.plane) {
		working = splitByIntensityMaxima(
			options.plane, working, width, height, options.prominence ?? 0,
		);
	}

	const labelResult = labelComponents(working, width, height, filter.connectivity ?? 8);
	let particles = extractParticles(labelResult);
	const totalBeforeFilters = particles.length;

	if (filter.fillHoles) {
		for (const particle of particles) {
			particle.mask = fillMaskHoles(particle.mask, particle.width, particle.height);
			let area = 0;
			for (let i = 0; i < particle.mask.length; i++) { if (particle.mask[i]) { area++; } }
			particle.area = area;
		}
	}

	const rejected = { tooSmall: 0, tooLarge: 0, shape: 0, edge: 0 };
	particles = particles.filter(particle => {
		if (filter.excludeEdges && particle.touchesEdge) { rejected.edge++; return false; }
		if (filter.minArea !== undefined && particle.area < filter.minArea) { rejected.tooSmall++; return false; }
		if (filter.maxArea !== undefined && particle.area > filter.maxArea) { rejected.tooLarge++; return false; }
		if (filter.minCircularity !== undefined || filter.maxCircularity !== undefined) {
			const circularity = approximateCircularity(particle);
			if (filter.minCircularity !== undefined && circularity < filter.minCircularity) { rejected.shape++; return false; }
			if (filter.maxCircularity !== undefined && circularity > filter.maxCircularity) { rejected.shape++; return false; }
		}
		return true;
	});

	return { particles, rejected, totalBeforeFilters };
}

/**
 * Circularity from a boundary-pixel count.
 *
 * Only used to *filter*; the reported circularity of a surviving object comes
 * from the full traced perimeter in `statistics.ts`. Using the cheap estimate
 * here keeps the filter responsive when a slider is being dragged over
 * thousands of objects.
 */
function approximateCircularity(particle: Particle): number {
	const { mask, width, height, area } = particle;
	let boundaryStraight = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (!mask[y * width + x]) { continue; }
			if (x === 0 || !mask[y * width + x - 1]) { boundaryStraight++; }
			if (x === width - 1 || !mask[y * width + x + 1]) { boundaryStraight++; }
			if (y === 0 || !mask[(y - 1) * width + x]) { boundaryStraight++; }
			if (y === height - 1 || !mask[(y + 1) * width + x]) { boundaryStraight++; }
		}
	}
	const perimeter = boundaryStraight * 0.95;
	if (perimeter <= 0) { return 0; }
	return Math.min(1, (4 * Math.PI * area) / (perimeter * perimeter));
}

/** Wrap a particle as a mask ROI ready for the ROI list. */
export function particleToRoi(particle: Particle, id: string, name: string): MaskRoi {
	return {
		id,
		name,
		kind: 'mask',
		source: 'threshold',
		x: particle.x,
		y: particle.y,
		width: particle.width,
		height: particle.height,
		mask: particle.mask,
	};
}

"use strict";
import { initWasm } from '../tiff-wasm-wrapper.js';

/**
 * Interactive, click-driven segmentation.
 *
 * The premise: for "I just want to mark this one cell", a global threshold is
 * the wrong instrument entirely. Everything here is seeded by a click and
 * bounded to a local neighbourhood, so a user gets a result without ever
 * choosing a number that applies to the whole image.
 *
 * Three tools live here:
 *
 * - `growRegion` — flood-style region growing with a tolerance derived from the
 *   local noise level rather than a fixed global constant.
 * - `growRegionAuto` — the same, swept over tolerance, choosing the value at
 *   which the region's area is most stable. This is the wand a user actually
 *   wants: a click produces the object, not a guess.
 * - `traceBoundary` — livewire/intelligent-scissors path snapping for objects
 *   region growing cannot separate.
 */

export interface RegionResult {
	x: number;
	y: number;
	width: number;
	height: number;
	mask: Uint8Array;
	count: number;
	/** Tolerance actually used, so the panel can show and let the user nudge it. */
	tolerance: number;
}

const EMPTY_REGION: RegionResult = { x: 0, y: 0, width: 0, height: 0, mask: new Uint8Array(0), count: 0, tolerance: 0 };

/**
 * Robust local noise estimate around a seed: the median absolute deviation of a
 * small window, scaled to a standard-deviation equivalent.
 *
 * MAD rather than the standard deviation because the window around a seed near
 * an object edge contains both object and background, and a plain σ there
 * reports the contrast between them instead of the noise within them — which
 * would open the tolerance far too wide exactly where precision matters.
 */
export function localNoise(
	plane: Float32Array,
	width: number,
	height: number,
	seedX: number,
	seedY: number,
	radius = 4,
): number {
	const values: number[] = [];
	for (let y = Math.max(0, seedY - radius); y <= Math.min(height - 1, seedY + radius); y++) {
		for (let x = Math.max(0, seedX - radius); x <= Math.min(width - 1, seedX + radius); x++) {
			const v = plane[y * width + x];
			if (Number.isFinite(v)) { values.push(v); }
		}
	}
	if (values.length < 3) { return 0; }
	values.sort((a, b) => a - b);
	const median = values[Math.floor(values.length / 2)];
	const deviations = values.map(v => Math.abs(v - median));
	deviations.sort((a, b) => a - b);
	const mad = deviations[Math.floor(deviations.length / 2)];
	// 1.4826 converts a MAD into the equivalent σ for normally distributed noise.
	return mad * 1.4826;
}

export interface GrowOptions {
	/** Absolute tolerance in data units. When omitted, derived from local noise. */
	tolerance?: number;
	/** Multiple of the local noise σ used when `tolerance` is omitted. */
	noiseMultiple?: number;
	connectivity?: 4 | 8;
	/** Hard cap on region size, as a fraction of the image. */
	maxAreaFraction?: number;
	/**
	 * Compare each candidate against the running region mean rather than the
	 * seed value. Better on gradients, worse on objects that abut a bright
	 * neighbour, so it is off by default.
	 */
	adaptive?: boolean;
}

/**
 * Flood-style region growing from a seed.
 *
 * Growth is bounded by a maximum area so a click on the background cannot walk
 * the entire image and freeze the UI — it returns whatever it had instead,
 * which reads to the user as "that selection was too loose".
 */
export function growRegion(
	plane: Float32Array,
	width: number,
	height: number,
	seedX: number,
	seedY: number,
	options: GrowOptions = {},
): RegionResult {
	if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) { return { ...EMPTY_REGION }; }
	const seedValue = plane[seedY * width + seedX];
	if (!Number.isFinite(seedValue)) { return { ...EMPTY_REGION }; }

	const noise = localNoise(plane, width, height, seedX, seedY);
	const tolerance = options.tolerance !== undefined
		? options.tolerance
		: Math.max(noise * (options.noiseMultiple ?? 3), 1e-9);

	const maxArea = Math.floor(width * height * (options.maxAreaFraction ?? 0.5));
	const connectivity = options.connectivity ?? 8;
	const adaptive = options.adaptive === true;

	const visited = new Uint8Array(width * height);
	const stack = new Int32Array(width * height);
	let top = 0;
	const seedIndex = seedY * width + seedX;
	stack[top++] = seedIndex;
	visited[seedIndex] = 1;

	let count = 0;
	let sum = 0;
	let minX = seedX, maxX = seedX, minY = seedY, maxY = seedY;
	const member = new Uint8Array(width * height);

	while (top > 0 && count < maxArea) {
		const index = stack[--top];
		const value = plane[index];
		const reference = adaptive && count > 0 ? sum / count : seedValue;
		if (!Number.isFinite(value) || Math.abs(value - reference) > tolerance) { continue; }

		member[index] = 1;
		count++;
		sum += value;
		const x = index % width;
		const y = (index / width) | 0;
		if (x < minX) { minX = x; }
		if (x > maxX) { maxX = x; }
		if (y < minY) { minY = y; }
		if (y > maxY) { maxY = y; }

		const push = (nx: number, ny: number) => {
			if (nx < 0 || ny < 0 || nx >= width || ny >= height) { return; }
			const neighbour = ny * width + nx;
			if (visited[neighbour]) { return; }
			visited[neighbour] = 1;
			stack[top++] = neighbour;
		};
		push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
		if (connectivity === 8) {
			push(x - 1, y - 1); push(x + 1, y - 1); push(x - 1, y + 1); push(x + 1, y + 1);
		}
	}

	if (count === 0) { return { ...EMPTY_REGION, tolerance }; }

	const bw = maxX - minX + 1;
	const bh = maxY - minY + 1;
	const mask = new Uint8Array(bw * bh);
	for (let y = minY; y <= maxY; y++) {
		for (let x = minX; x <= maxX; x++) {
			if (member[y * width + x]) { mask[(y - minY) * bw + (x - minX)] = 1; }
		}
	}

	return { x: minX, y: minY, width: bw, height: bh, mask, count, tolerance };
}

/**
 * Region growing with the tolerance chosen automatically.
 *
 * The area of a grown region as a function of tolerance is flat while the
 * tolerance stays inside the object and jumps when it spills into the
 * background. Picking the widest flat stretch therefore picks the object
 * boundary without the user naming a number — the same stability argument the
 * threshold curve makes, applied to a single click.
 *
 * `maxAreaFraction` doubles as the spill detector: a candidate that exceeds it
 * has clearly leaked, and everything at or above that tolerance is discarded.
 */
export function growRegionAuto(
	plane: Float32Array,
	width: number,
	height: number,
	seedX: number,
	seedY: number,
	options: GrowOptions & { steps?: number } = {},
): RegionResult {
	const noise = Math.max(localNoise(plane, width, height, seedX, seedY), 1e-9);
	const steps = options.steps ?? 14;
	const candidates: RegionResult[] = [];

	for (let i = 0; i < steps; i++) {
		// Geometric sweep: object contrast spans orders of magnitude, and a
		// linear sweep wastes almost all its samples at one end.
		const tolerance = noise * Math.pow(1.5, i);
		const region = growRegion(plane, width, height, seedX, seedY, { ...options, tolerance });
		if (region.count === 0) { continue; }
		const fraction = region.count / (width * height);
		if (fraction > (options.maxAreaFraction ?? 0.5)) { break; }
		candidates.push(region);
	}

	if (candidates.length === 0) {
		return growRegion(plane, width, height, seedX, seedY, options);
	}
	if (candidates.length <= 2) { return candidates[candidates.length - 1]; }

	// Score each candidate by how little the area changes across the step that
	// follows it; the flattest step is the object.
	let bestIndex = 0;
	let bestGrowth = Infinity;
	for (let i = 0; i + 1 < candidates.length; i++) {
		const growth = (candidates[i + 1].count - candidates[i].count) / Math.max(1, candidates[i].count);
		// Regions of a handful of pixels are flat for trivial reasons; require a
		// plausible object before trusting the flatness.
		if (candidates[i].count < 12) { continue; }
		if (growth < bestGrowth) { bestGrowth = growth; bestIndex = i; }
	}
	return candidates[bestIndex];
}

/** Gradient magnitude by central differences, NaN-safe. */
export function gradientMagnitude(plane: Float32Array, width: number, height: number): Float32Array {
	const out = new Float32Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const index = y * width + x;
			const left = plane[y * width + Math.max(0, x - 1)];
			const right = plane[y * width + Math.min(width - 1, x + 1)];
			const up = plane[Math.max(0, y - 1) * width + x];
			const down = plane[Math.min(height - 1, y + 1) * width + x];
			if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(up) || !Number.isFinite(down)) {
				out[index] = 0;
				continue;
			}
			out[index] = Math.hypot((right - left) / 2, (down - up) / 2);
		}
	}
	return out;
}

/**
 * Livewire ("intelligent scissors") path between two points.
 *
 * Cost is the inverse of the normalised gradient magnitude, so a shortest path
 * hugs the strongest edge between the endpoints. Diagonal steps are charged
 * √2 to keep the path from preferring staircases.
 *
 * The search is a Dijkstra over a bucketed priority queue, restricted to a
 * corridor around the straight line between the endpoints — an unrestricted
 * search over a large image would be both slow and prone to taking a scenic
 * route along an unrelated strong edge.
 */
export function traceBoundary(
	gradient: Float32Array,
	width: number,
	height: number,
	fromX: number,
	fromY: number,
	toX: number,
	toY: number,
	corridor = 64,
): number[] {
	const x0 = Math.max(0, Math.min(fromX, toX) - corridor);
	const y0 = Math.max(0, Math.min(fromY, toY) - corridor);
	const x1 = Math.min(width - 1, Math.max(fromX, toX) + corridor);
	const y1 = Math.min(height - 1, Math.max(fromY, toY) + corridor);
	const w = x1 - x0 + 1;
	const h = y1 - y0 + 1;
	if (w <= 0 || h <= 0) { return [fromX, fromY, toX, toY]; }

	let maxGradient = 0;
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			const g = gradient[y * width + x];
			if (g > maxGradient) { maxGradient = g; }
		}
	}
	if (maxGradient <= 0) { return [fromX, fromY, toX, toY]; }

	// Quantised step cost in [1, 1024]; low cost where the edge is strong.
	const cost = new Uint16Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const g = gradient[(y + y0) * width + (x + x0)] / maxGradient;
			cost[y * w + x] = 1 + Math.round((1 - g) * 1023);
		}
	}

	const total = new Float64Array(w * h).fill(Infinity);
	const previous = new Int32Array(w * h).fill(-1);
	const done = new Uint8Array(w * h);

	const startIndex = (fromY - y0) * w + (fromX - x0);
	const endIndex = (toY - y0) * w + (toX - x0);
	total[startIndex] = 0;

	// Bucket queue: costs are small integers, so this beats a binary heap and
	// never allocates during the search.
	const maxCost = 1024 * 2;
	const buckets: number[][] = [];
	const bucketFor = (value: number) => Math.min(buckets.length - 1, Math.floor(value));
	const capacity = maxCost * (w + h) + 4;
	void capacity;
	for (let i = 0; i <= maxCost; i++) { buckets.push([]); }
	let rotation = 0;
	buckets[0].push(startIndex);

	const dx = [-1, 0, 1, -1, 1, -1, 0, 1];
	const dy = [-1, -1, -1, 0, 0, 1, 1, 1];
	const stepScale = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];

	let remaining = w * h;
	let scanned = 0;
	while (remaining > 0 && scanned <= maxCost * 4) {
		const bucket = buckets[rotation % buckets.length];
		if (bucket.length === 0) { rotation++; scanned++; continue; }
		const index = bucket.pop()!;
		if (done[index]) { continue; }
		done[index] = 1;
		remaining--;
		if (index === endIndex) { break; }

		const cx = index % w;
		const cy = (index / w) | 0;
		for (let k = 0; k < 8; k++) {
			const nx = cx + dx[k];
			const ny = cy + dy[k];
			if (nx < 0 || ny < 0 || nx >= w || ny >= h) { continue; }
			const neighbour = ny * w + nx;
			if (done[neighbour]) { continue; }
			const candidate = total[index] + cost[neighbour] * stepScale[k];
			if (candidate < total[neighbour]) {
				total[neighbour] = candidate;
				previous[neighbour] = index;
				const target = bucketFor(candidate - total[index] + rotation);
				buckets[Math.max(rotation % buckets.length, target)].push(neighbour);
			}
		}
	}

	if (previous[endIndex] < 0 && endIndex !== startIndex) {
		return [fromX, fromY, toX, toY];
	}

	const path: number[] = [];
	let cursor = endIndex;
	let guard = 0;
	while (cursor >= 0 && guard++ < w * h) {
		path.push((cursor % w) + x0, ((cursor / w) | 0) + y0);
		if (cursor === startIndex) { break; }
		cursor = previous[cursor];
	}
	path.reverse();
	// `path` was built end-to-start in pairs; reversing the flat array swaps x
	// and y, so rebuild it in point order instead.
	const ordered: number[] = [];
	for (let i = path.length - 2; i >= 0; i -= 2) { ordered.push(path[i], path[i + 1]); }
	return ordered.length >= 4 ? ordered : [fromX, fromY, toX, toY];
}

/**
 * Paint or erase a disc into a mask, growing its bounding box as needed.
 *
 * Refinement is not a luxury: automatic segmentation is never perfect, and a
 * tool without a brush forces the user to start over instead of fixing the one
 * wrong edge.
 */
export function brushStroke(
	region: { x: number; y: number; width: number; height: number; mask: Uint8Array },
	centerX: number,
	centerY: number,
	radius: number,
	erase: boolean,
	imageWidth: number,
	imageHeight: number,
): { x: number; y: number; width: number; height: number; mask: Uint8Array; count: number } {
	const strokeMinX = Math.max(0, Math.floor(centerX - radius));
	const strokeMinY = Math.max(0, Math.floor(centerY - radius));
	const strokeMaxX = Math.min(imageWidth - 1, Math.ceil(centerX + radius));
	const strokeMaxY = Math.min(imageHeight - 1, Math.ceil(centerY + radius));

	// Erasing never needs to grow the box; painting does.
	const newX = erase ? region.x : Math.min(region.x, strokeMinX);
	const newY = erase ? region.y : Math.min(region.y, strokeMinY);
	const newRight = erase ? region.x + region.width : Math.max(region.x + region.width, strokeMaxX + 1);
	const newBottom = erase ? region.y + region.height : Math.max(region.y + region.height, strokeMaxY + 1);
	const newWidth = Math.max(0, newRight - newX);
	const newHeight = Math.max(0, newBottom - newY);

	let mask = region.mask;
	if (newX !== region.x || newY !== region.y || newWidth !== region.width || newHeight !== region.height) {
		const grown = new Uint8Array(newWidth * newHeight);
		for (let row = 0; row < region.height; row++) {
			const targetRow = (row + region.y - newY) * newWidth + (region.x - newX);
			for (let col = 0; col < region.width; col++) {
				if (region.mask[row * region.width + col]) { grown[targetRow + col] = 1; }
			}
		}
		mask = grown;
	} else {
		mask = region.mask.slice();
	}

	const radiusSquared = radius * radius;
	for (let y = strokeMinY; y <= strokeMaxY; y++) {
		const ly = y - newY;
		if (ly < 0 || ly >= newHeight) { continue; }
		for (let x = strokeMinX; x <= strokeMaxX; x++) {
			const lx = x - newX;
			if (lx < 0 || lx >= newWidth) { continue; }
			const dx = x - centerX;
			const dy = y - centerY;
			if (dx * dx + dy * dy > radiusSquared) { continue; }
			mask[ly * newWidth + lx] = erase ? 0 : 1;
		}
	}

	let count = 0;
	for (let i = 0; i < mask.length; i++) { if (mask[i]) { count++; } }
	return { x: newX, y: newY, width: newWidth, height: newHeight, mask, count };
}

/**
 * Rolling-ball background subtraction, applied to the segmentation copy only.
 *
 * The displayed image is never touched — this exists so that a threshold can
 * succeed on unevenly illuminated data, not to alter what the user is looking
 * at. Implemented as a grayscale morphological opening with a ball-shaped
 * structuring element, approximated by a min-then-max filter over a disc, which
 * is the standard cheap equivalent.
 */
export async function subtractBackground(
	plane: Float32Array,
	width: number,
	height: number,
	radius: number,
	lightBackground = false,
): Promise<Float32Array> {
	const wasm = await initWasm();
	if (!wasm || typeof wasm.subtract_background_fast !== 'function') {
		throw new Error('Background subtraction requires the Rust/WASM module, which failed to load.');
	}
	return wasm.subtract_background_fast(plane, width, height, radius, lightBackground);
}

function negate(plane: Float32Array): Float32Array {
	const out = new Float32Array(plane.length);
	for (let i = 0; i < plane.length; i++) { out[i] = Number.isFinite(plane[i]) ? -plane[i] : NaN; }
	return out;
}

/** Separable min/max filter over a square window approximating a disc. */
function discFilter(plane: Float32Array, width: number, height: number, radius: number, minimum: boolean): Float32Array {
	const horizontal = new Float32Array(plane.length);
	const pick = minimum
		? (a: number, b: number) => (b < a ? b : a)
		: (a: number, b: number) => (b > a ? b : a);
	const seed = minimum ? Infinity : -Infinity;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let best = seed;
			const x0 = Math.max(0, x - radius);
			const x1 = Math.min(width - 1, x + radius);
			for (let k = x0; k <= x1; k++) {
				const v = plane[y * width + k];
				if (Number.isFinite(v)) { best = pick(best, v); }
			}
			horizontal[y * width + x] = Number.isFinite(best) ? best : NaN;
		}
	}

	const out = new Float32Array(plane.length);
	for (let y = 0; y < height; y++) {
		const y0 = Math.max(0, y - radius);
		const y1 = Math.min(height - 1, y + radius);
		for (let x = 0; x < width; x++) {
			let best = seed;
			for (let k = y0; k <= y1; k++) {
				const v = horizontal[k * width + x];
				if (Number.isFinite(v)) { best = pick(best, v); }
			}
			out[y * width + x] = Number.isFinite(best) ? best : NaN;
		}
	}
	return out;
}

/** Separable Gaussian blur, for pre-threshold noise suppression. */
export async function gaussianBlur(plane: Float32Array, width: number, height: number, sigma: number): Promise<Float32Array> {
	const wasm = await initWasm();
	if (!wasm || typeof wasm.gaussian_blur_fast !== 'function') {
		throw new Error('Gaussian blur requires the Rust/WASM module, which failed to load.');
	}
	return wasm.gaussian_blur_fast(plane, width, height, sigma);
}

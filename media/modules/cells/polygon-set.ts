/** Polygons from a long-format vertex table, stored flat for fast drawing and picking. */

export interface PolygonSet {
	count: number;
	/** Vertex offsets into `xy` (in vertices), `count + 1` long. */
	offsets: Uint32Array;
	/** x, y pairs. */
	xy: Float32Array;
	/** minX, minY, maxX, maxY per polygon. */
	bounds: Float32Array;
	/** Table row of each polygon, or -1 when the polygon has no table row. */
	rows: Int32Array;
}

/**
 * Group consecutive vertices with the same id into polygons. `scale`
 * converts the file's units to scene pixels (1 / pixel size for micron files).
 */
export function buildPolygonSet(
	ids: ArrayLike<string>,
	xs: ArrayLike<number>,
	ys: ArrayLike<number>,
	rowOfId: (id: string) => number,
	scale: number,
): PolygonSet {
	const total = ids.length;
	let count = 0;
	for (let index = 0; index < total; index++) { if (index === 0 || ids[index] !== ids[index - 1]) { count++; } }
	const offsets = new Uint32Array(count + 1);
	const xy = new Float32Array(total * 2);
	const bounds = new Float32Array(count * 4);
	const rows = new Int32Array(count);
	let polygon = -1;
	for (let index = 0; index < total; index++) {
		if (index === 0 || ids[index] !== ids[index - 1]) {
			polygon++;
			offsets[polygon] = index;
			rows[polygon] = rowOfId(ids[index]);
			bounds[polygon * 4] = bounds[polygon * 4 + 1] = Infinity;
			bounds[polygon * 4 + 2] = bounds[polygon * 4 + 3] = -Infinity;
		}
		const x = xs[index] * scale, y = ys[index] * scale;
		xy[index * 2] = x;
		xy[index * 2 + 1] = y;
		const at = polygon * 4;
		if (x < bounds[at]) { bounds[at] = x; }
		if (y < bounds[at + 1]) { bounds[at + 1] = y; }
		if (x > bounds[at + 2]) { bounds[at + 2] = x; }
		if (y > bounds[at + 3]) { bounds[at + 3] = y; }
	}
	offsets[count] = total;
	return { count, offsets, xy, bounds, rows };
}

/** Even-odd containment, with a bounds shortcut. */
export function polygonContains(set: PolygonSet, polygon: number, x: number, y: number): boolean {
	const at = polygon * 4;
	if (x < set.bounds[at] || x > set.bounds[at + 2] || y < set.bounds[at + 1] || y > set.bounds[at + 3]) { return false; }
	const start = set.offsets[polygon], end = set.offsets[polygon + 1];
	let inside = false;
	for (let i = start, j = end - 1; i < end; j = i++) {
		const xi = set.xy[i * 2], yi = set.xy[i * 2 + 1], xj = set.xy[j * 2], yj = set.xy[j * 2 + 1];
		if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) { inside = !inside; }
	}
	return inside;
}

/** Shoelace area in squared scene pixels. */
export function polygonArea(set: PolygonSet, polygon: number): number {
	const start = set.offsets[polygon], end = set.offsets[polygon + 1];
	let sum = 0;
	for (let i = start, j = end - 1; i < end; j = i++) {
		sum += set.xy[j * 2] * set.xy[i * 2 + 1] - set.xy[i * 2] * set.xy[j * 2 + 1];
	}
	return Math.abs(sum) / 2;
}

/** Outline length in scene pixels. */
export function polygonPerimeter(set: PolygonSet, polygon: number): number {
	const start = set.offsets[polygon], end = set.offsets[polygon + 1];
	let sum = 0;
	for (let i = start, j = end - 1; i < end; j = i++) {
		sum += Math.hypot(set.xy[i * 2] - set.xy[j * 2], set.xy[i * 2 + 1] - set.xy[j * 2 + 1]);
	}
	return sum;
}

/** Mean bounding-box edge, a cheap measure of how large a cell looks. */
export function meanPolygonSize(set: PolygonSet): number {
	if (set.count === 0) { return 0; }
	let sum = 0;
	const step = Math.max(1, Math.floor(set.count / 2000));
	let seen = 0;
	for (let polygon = 0; polygon < set.count; polygon += step) {
		sum += (set.bounds[polygon * 4 + 2] - set.bounds[polygon * 4] + set.bounds[polygon * 4 + 3] - set.bounds[polygon * 4 + 1]) / 2;
		seen++;
	}
	return sum / seen;
}

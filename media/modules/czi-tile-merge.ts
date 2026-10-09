/**
 * Splitting a CZI region into one job per subblock and merging the results
 * (strip-parallel-decode.ts `decodeCziTilesParallel`). Each job decodes a
 * single subblock into exactly the output pixels it covers — computed with
 * the composer's own clipping rule (formats/czi.rs `compose_region`) — and
 * the merge copies them in plan (directory) order, so later tiles overwrite
 * earlier ones where a mosaic overlaps, as the single decode does.
 */

export interface CziTileJob {
	/** Output pixels this tile covers, [x0, x1) x [y0, y1). */
	x0: number; y0: number; x1: number; y1: number;
	/** The full-resolution rectangle to ask the decoder for. */
	rect: { x: number; y: number; width: number; height: number };
}

/** Jobs for `rects` (each [x, y, w, h] from the plane's top-left); null where a tile covers nothing. */
export function cziTileJobs(region: { x: number; y: number }, factor: number, width: number, height: number,
	rects: [number, number, number, number][]): (CziTileJob | null)[] {
	const ceilDiv = (a: number, b: number) => Math.ceil(a / b);
	return rects.map(([tx, ty, tw, th]) => {
		const x0 = ceilDiv(Math.max(tx - region.x, 0), factor);
		const y0 = ceilDiv(Math.max(ty - region.y, 0), factor);
		const x1 = Math.min(ceilDiv(tx + tw - region.x, factor), width);
		const y1 = Math.min(ceilDiv(ty + th - region.y, factor), height);
		if (x0 >= x1 || y0 >= y1) { return null; }
		return { x0, y0, x1, y1, rect: { x: region.x + x0 * factor, y: region.y + y0 * factor, width: (x1 - x0) * factor, height: (y1 - y0) * factor } };
	});
}

/** Copy one tile's samples into `output` (width `width`, `channels` interleaved). False on a size mismatch. */
export function mergeCziTile(output: Float32Array, width: number, channels: number, job: CziTileJob,
	part: { width: number; height: number; samples: Float32Array }): boolean {
	if (part.width !== job.x1 - job.x0 || part.height !== job.y1 - job.y0) { return false; }
	const rowLength = part.width * channels;
	for (let row = 0; row < part.height; row++) {
		output.set(part.samples.subarray(row * rowLength, (row + 1) * rowLength), ((job.y0 + row) * width + job.x0) * channels);
	}
	return true;
}

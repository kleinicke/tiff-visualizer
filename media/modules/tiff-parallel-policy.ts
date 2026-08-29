"use strict";

/** Below this many strips the worker pool costs more than it saves. */
export const MIN_PARALLEL_TIFF_STRIPS = 16;

/**
 * The same floor for a TILED file, counted in tile ROWS.
 *
 * Strips are fine-grained — `RowsPerStrip` is often 1 — so a stripped file
 * needs a good number of them before the split is worth anything. A tile row
 * is coarse by comparison: a 512-pixel tile makes one unit out of 512 image
 * rows, so a 4000-row image has eight, and the strip floor would reject
 * exactly the large tiled GeoTIFFs the pool helps most (measured 3.5x on four
 * cores). The pixel-count gate below is what actually decides whether there is
 * enough work to share.
 */
export const MIN_PARALLEL_TIFF_TILE_ROWS = 2;

/** Below this many pixels a single worker is already fast enough. */
export const MIN_PARALLEL_TIFF_PIXELS = 2_000_000;

/**
 * Shared policy for speculative routing and the actual strip-pool decoder.
 * Keeping this in one module prevents the bootstrap worker from preempting a
 * file that the webview would otherwise decode in parallel.
 */
export function shouldUseParallelTiffPlan(plan: any): boolean {
	const units = Number(plan?.strip_count || 0);
	const width = Number(plan?.width || 0);
	const height = Number(plan?.height || 0);
	const minUnits = Number(plan?.tile_length || 0) > 0
		? MIN_PARALLEL_TIFF_TILE_ROWS
		: MIN_PARALLEL_TIFF_STRIPS;
	return units >= minUnits &&
		width > 0 && height > 0 && width * height >= MIN_PARALLEL_TIFF_PIXELS;
}

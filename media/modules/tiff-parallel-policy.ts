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

/** TIFF compression tag for LZMA (Adobe extension). */
export const TIFF_COMPRESSION_LZMA = 34925;

/**
 * LZMA is expensive enough that even two independently compressed strips can
 * repay worker dispatch. Keep roughly 2 MiB of decoded output per worker so a
 * handful of very large strips still receives useful concurrency without
 * treating every strip as a reason to create another worker.
 */
const LZMA_DECODED_BYTES_PER_WORKER = 2 * 1024 * 1024;
export const MAX_PARALLEL_TIFF_WORKERS = 8;

function decodedByteEstimate(plan: any): number {
	const width = Number(plan?.width || 0);
	const height = Number(plan?.height || 0);
	const channels = Math.max(1, Number(plan?.channels || 1));
	const bytesPerSample = Math.max(1, Math.ceil(Number(plan?.bits_per_sample || 8) / 8));
	return width * height * channels * bytesPerSample;
}

/**
 * Return useful concurrency for a plan, before applying the machine's core
 * limit. A TIFF with 100 strips therefore still requests at most eight
 * workers, while a two-strip LZMA file can request exactly two.
 */
export function parallelTiffWorkerCount(plan: any, maximum = MAX_PARALLEL_TIFF_WORKERS): number {
	const units = Math.max(0, Number(plan?.strip_count || 0));
	const limit = Math.max(0, Math.min(MAX_PARALLEL_TIFF_WORKERS, Math.floor(maximum)));
	if (units < 2 || limit < 2) { return 0; }

	if (Number(plan?.compression) === TIFF_COMPRESSION_LZMA) {
		const byWork = Math.max(2, Math.ceil(decodedByteEstimate(plan) / LZMA_DECODED_BYTES_PER_WORKER));
		return Math.min(units, limit, byWork);
	}

	return Math.min(units, limit);
}

/**
 * Shared policy for speculative routing and the actual strip-pool decoder.
 * Keeping this in one module prevents the bootstrap worker from preempting a
 * file that the webview would otherwise decode in parallel.
 */
export function shouldUseParallelTiffPlan(plan: any): boolean {
	const units = Number(plan?.strip_count || 0);
	const width = Number(plan?.width || 0);
	const height = Number(plan?.height || 0);
	// Raw unsigned 8/16-bit strips are memory copies, not CPU-bound decode.
	// In the warm Node candidate benchmark on the same 4032x3024 RGB8 file, a
	// pool was 33ms versus 8ms for the whole-image worker. Float32 is deliberately
	// excluded: the same-file result was 38ms versus 115ms because conversion
	// still dominates. The real VS Code route check agrees for RGB8 (81ms).
	if (Number(plan?.compression) === 1 && Number(plan?.sample_format || 1) === 1
		&& Number(plan?.bits_per_sample || 8) <= 16) {
		return false;
	}
	const minUnits = Number(plan?.compression) === TIFF_COMPRESSION_LZMA
		? 2
		: Number(plan?.tile_length || 0) > 0
		? MIN_PARALLEL_TIFF_TILE_ROWS
		: MIN_PARALLEL_TIFF_STRIPS;
	return units >= minUnits &&
		width > 0 && height > 0 && width * height >= MIN_PARALLEL_TIFF_PIXELS &&
		parallelTiffWorkerCount(plan) >= 2;
}

"use strict";

/** Below this many strips the worker pool costs more than it saves. */
export const MIN_PARALLEL_TIFF_STRIPS = 16;

/** Below this many pixels a single worker is already fast enough. */
export const MIN_PARALLEL_TIFF_PIXELS = 2_000_000;

/**
 * Shared policy for speculative routing and the actual strip-pool decoder.
 * Keeping this in one module prevents the bootstrap worker from preempting a
 * file that the webview would otherwise decode in parallel.
 */
export function shouldUseParallelTiffPlan(plan: any): boolean {
	const strips = Number(plan?.strip_count || 0);
	const width = Number(plan?.width || 0);
	const height = Number(plan?.height || 0);
	return strips >= MIN_PARALLEL_TIFF_STRIPS &&
		width > 0 && height > 0 && width * height >= MIN_PARALLEL_TIFF_PIXELS;
}

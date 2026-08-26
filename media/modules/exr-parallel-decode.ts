"use strict";

import type { DecodeWorkerLike } from './decode-worker-client.js';
import { decodeExrZipBlocks } from './strip-parallel-decode.js';
import { PerfTrace } from './perf-trace.js';

export interface ParallelExrResult {
	width: number;
	height: number;
	data: Float32Array;
	format: number;
	type: number;
	channelNames: string[];
	displayedChannels: string[];
	flipY: boolean;
	allTagsJson: string;
	stats: { min: number; max: number };
	channels: number;
	decodedWith: string;
	decodeTimings: { name: string; durationMs: number }[];
}

/** Decode guarded one-channel Float32 ZIP16 scanline EXRs across workers. */
export async function tryParallelExrDecode(
	buffer: ArrayBuffer,
	worker: DecodeWorkerLike | null | undefined,
): Promise<{ result: ParallelExrResult | null; source: ArrayBuffer }> {
	if (!worker?.canDecode('exr-zip-plan') || buffer.byteLength === 0) {
		return { result: null, source: buffer };
	}
	const response = await worker.decode('exr-zip-plan', buffer);
	const plan = response?.ok ? response.result : null;
	const source = plan?.source instanceof ArrayBuffer
		? plan.source
		: response?.buffer instanceof ArrayBuffer ? response.buffer : new ArrayBuffer(0);
	if (!plan?.supported) { return { result: null, source }; }

	const decoded = await decodeExrZipBlocks({
		width: Number(plan.width),
		height: Number(plan.height),
		dataY: Number(plan.dataY),
		counts: plan.counts,
		yCoordinates: plan.yCoordinates,
		compressed: plan.compressed,
	});
	if (!decoded) { return { result: null, source }; }
	worker.retireAfterDecode?.();
	PerfTrace.mark('decode-worker(exr)');
	PerfTrace.detail('decode-exr-zip-plan', Number(plan.planMs || 0));
	PerfTrace.detail('decode-exr-zip-workers', decoded.durationMs);
	const channelName = String(plan.channelName || 'Y');
	return {
		// The parallel result is complete; do not retain the original 44-100MB
		// source through deferred rendering.
		source: new ArrayBuffer(0),
		result: {
			width: Number(plan.width),
			height: Number(plan.height),
			data: decoded.data,
			format: 1028,
			type: 1015,
			channelNames: [channelName],
			displayedChannels: [channelName],
			flipY: false,
			allTagsJson: String(plan.allTagsJson || '[]'),
			stats: { min: decoded.min, max: decoded.max },
			channels: 1,
			decodedWith: `wasm (${decoded.workers} EXR ZIP workers)`,
			decodeTimings: [
				{ name: 'decode-exr-zip-plan', durationMs: Number(plan.planMs || 0) },
				{ name: 'decode-exr-zip-workers', durationMs: decoded.durationMs },
			],
		},
	};
}

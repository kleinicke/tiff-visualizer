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

/** Decode guarded ZIP16 scanline EXRs (any channels, half or float) across workers. */
export async function tryParallelExrDecode(
	buffer: ArrayBuffer,
	worker: DecodeWorkerLike | null | undefined,
): Promise<{ result: ParallelExrResult | null; source: ArrayBuffer }> {
	// A source that arrives before the worker has booted (a file picked in the
	// standalone viewer does) would otherwise skip the parallel path entirely.
	if (worker && !worker.canDecode('exr-zip-plan')) { await worker.whenBooting?.(); }
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
		channelKinds: plan.channelKinds instanceof Uint32Array ? plan.channelKinds : undefined,
		selection: plan.selection instanceof Int32Array ? plan.selection : undefined,
	});
	if (!decoded) { return { result: null, source }; }
	worker.retireAfterDecode?.();
	PerfTrace.mark('decode-worker(exr)');
	PerfTrace.detail('decode-exr-zip-plan', Number(plan.planMs || 0));
	PerfTrace.detail('decode-exr-zip-workers', decoded.durationMs);
	const channelName = String(plan.channelName || 'Y');
	// As decode_exr_fast reports them: every channel, and the displayed ones.
	const channelNames: string[] = Array.isArray(plan.channelNames) ? plan.channelNames.map(String) : [channelName];
	const displayedChannels: string[] = Array.isArray(plan.displayedChannels) ? plan.displayedChannels.map(String) : [channelName];
	return {
		// The parallel result is complete; do not retain the original 44-100MB
		// source through deferred rendering.
		source: new ArrayBuffer(0),
		result: {
			width: Number(plan.width),
			height: Number(plan.height),
			data: decoded.data,
			format: decoded.channels === 1 ? 1028 : 1023,
			type: 1015,
			channelNames,
			displayedChannels,
			flipY: false,
			allTagsJson: String(plan.allTagsJson || '[]'),
			stats: { min: decoded.min, max: decoded.max },
			channels: decoded.channels,
			decodedWith: `wasm (${decoded.workers} EXR ZIP workers)`,
			decodeTimings: [
				{ name: 'decode-exr-zip-plan', durationMs: Number(plan.planMs || 0) },
				{ name: 'decode-exr-zip-workers', durationMs: decoded.durationMs },
			],
		},
	};
}

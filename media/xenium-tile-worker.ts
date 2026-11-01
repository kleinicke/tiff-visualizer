"use strict";

/**
 * Region decoder for one pyramidal OME-TIFF, off the UI thread.
 *
 * One worker holds one channel file and answers rectangle reads of any of its
 * levels. It uses the heavy-codec WebAssembly module (a superset of the core
 * one) because Xenium morphology images are JPEG 2000 tiled. The compiled
 * module arrives from the page: a blob worker cannot fetch webview-resource
 * URLs, so the page fetches and compiles it once and shares it with each worker.
 *
 * Protocol (every reply carries the request id):
 *   init    { module }                  -> ready
 *   open    { bytes }                   -> { directory, description, linkedLevels }
 *   region  { page, x, y, width, height } -> { width, height, bitsPerSample, sampleFormat, data }
 *   close                               -> frees the decoder
 */

import initCodecWasm, { TiffRegionDecoder, tiff_page_directory } from './wasm/codec-wasm.js';
import { chainSubIfds, inspectTiffRoot } from './modules/scene/tiff-subifd.js';

let decoder: TiffRegionDecoder | null = null;
let ready: Promise<void> | null = null;

function reply(id: number, payload: Record<string, unknown>, transfer: Transferable[] = []): void {
	(self as unknown as Worker).postMessage({ id, ...payload }, transfer);
}

self.onmessage = async (event: MessageEvent): Promise<void> => {
	const message = event.data;
	const id = Number(message?.id ?? 0);
	try {
		switch (message?.type) {
			case 'init': {
				ready = initCodecWasm({ module_or_path: message.module }).then((): void => undefined);
				await ready;
				reply(id, { ok: true });
				return;
			}
			case 'open': {
				await ready;
				decoder?.free();
				decoder = null;
				const bytes = new Uint8Array(message.bytes as ArrayBuffer);
				const description = inspectTiffRoot(bytes)?.description;
				const linkedLevels = chainSubIfds(bytes);
				const directory = tiff_page_directory(bytes);
				decoder = new TiffRegionDecoder(bytes);
				reply(id, { ok: true, directory, description, linkedLevels });
				return;
			}
			case 'region': {
				if (!decoder) { throw new Error('No TIFF is open in this worker'); }
				const region = decoder.decode(Number(message.page), Number(message.x), Number(message.y), Number(message.width), Number(message.height));
				const data = region.take_data_as_f32() as Float32Array;
				reply(id, {
					ok: true,
					width: Number(region.width),
					height: Number(region.height),
					channels: Number(region.channels),
					bitsPerSample: Number(region.bits_per_sample),
					sampleFormat: Number(region.sample_format),
					data,
				}, [data.buffer]);
				return;
			}
			case 'close': {
				decoder?.free();
				decoder = null;
				reply(id, { ok: true });
				return;
			}
			default:
				throw new Error(`Unknown request ${String(message?.type)}`);
		}
	} catch (error) {
		reply(id, { ok: false, error: error instanceof Error ? error.message : String(error) });
	}
};

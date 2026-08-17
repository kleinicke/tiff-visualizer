"use strict";

import { decodeBinaryNetpbmFast, decodeNativeF32NpyFast, decodeNativePfmFast } from './modules/fast-raw-decoders.js';

declare const self: any;

self.onmessage = (event: MessageEvent<any>) => {
	const message = event.data;
	if (message.type === 'init') {
		self.postMessage({ type: 'ready' });
		return;
	}
	const { id, format, buffer, options } = message;
	try {
		const result = format === 'ppm' ? decodeBinaryNetpbmFast(buffer)
			: format === 'npy' ? decodeNativeF32NpyFast(buffer, options?.computeStats !== false)
				: format === 'pfm' ? decodeNativePfmFast(buffer)
				: null;
		if (!result) {
			self.postMessage({ id, ok: false, error: 'fast path unsupported', buffer }, [buffer]);
			return;
		}
		self.postMessage({ id, ok: true, result }, [buffer]);
	} catch (error) {
		self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error), buffer }, [buffer]);
	}
};

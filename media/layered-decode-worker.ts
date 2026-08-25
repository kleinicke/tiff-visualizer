"use strict";

import { decodeLayeredPreview } from './modules/layered-preview-decoders.js';

declare const self: any;

function collectTransferables(value: any, buffers: Set<ArrayBuffer> = new Set(), depth = 0): ArrayBuffer[] {
	if (value === null || value === undefined || depth > 5) { return [...buffers]; }
	if (value instanceof ArrayBuffer) { buffers.add(value); }
	else if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) { buffers.add(value.buffer); }
	else if (Array.isArray(value)) {
		for (const item of value) { collectTransferables(item, buffers, depth + 1); }
	} else if (typeof value === 'object' && value.constructor === Object) {
		for (const item of Object.values(value)) { collectTransferables(item, buffers, depth + 1); }
	}
	return [...buffers];
}

self.onmessage = async (event: MessageEvent<any>) => {
	const msg = event.data;
	if (msg.type === 'init') {
		self.postMessage({ type: 'ready', caps: { layered: true } });
		return;
	}
	const { id, format, buffer, options } = msg;
	try {
		const result = await decodeLayeredPreview(format, buffer, options || {});
		self.postMessage({ id, ok: true, result }, collectTransferables(result));
	} catch (error) {
		self.postMessage({ id, ok: false, error: String((error as Error)?.message || error), buffer }, [buffer]);
	}
};

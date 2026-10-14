"use strict";

/**
 * A TIFF source that is still being read: `bytes` is the whole file's buffer,
 * valid up to `received`. Provided by the webview bootstrap for large TIFFs so
 * decoding can start before the read ends.
 */
export interface TiffImageStream {
	total: number;
	received: number;
	bytes: Uint8Array | null;
	error: Error | null;
	whenAvailable(end: number): Promise<void>;
}

/** Bytes per value of each TIFF field type; 0 marks a type this walker does not know. */
const TYPE_BYTES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4, 0, 0, 8, 8, 8];
const SUB_IFDS_TAG = 330;

/**
 * How many leading bytes hold the first IFD AND every out-of-line value its
 * entries point at, and whether that IFD is the file's only image.
 *
 * The strip plan and the tag metadata read nothing else, so once this prefix
 * has arrived they are exactly what the whole file would give. Requiring every
 * out-of-line value (not just the ones the planner needs today) means a tag
 * can never be silently read as missing. Returns null for anything unexpected:
 * the caller then waits for the whole file as before.
 */
export async function tiffFirstIfdPrefix(stream: TiffImageStream): Promise<{ needed: number; singleImage: boolean } | null> {
	const total = stream.total;
	if (total < 16) { return null; }
	await stream.whenAvailable(16);
	const bytes = stream.bytes;
	if (!bytes) { return null; }
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const order = view.getUint16(0);
	if (order !== 0x4949 && order !== 0x4d4d) { return null; }
	const little = order === 0x4949;
	const version = view.getUint16(2, little);
	const big = version === 43;
	if (!big && version !== 42) { return null; }
	if (big && (view.getUint16(4, little) !== 8 || view.getUint16(6, little) !== 0)) { return null; }
	const readOffset = (at: number): number => {
		if (!big) { return view.getUint32(at, little); }
		const value = view.getBigUint64(at, little);
		return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.POSITIVE_INFINITY : Number(value);
	};

	const ifdOffset = readOffset(big ? 8 : 4);
	const countBytes = big ? 8 : 2;
	const entryBytes = big ? 20 : 12;
	const valueBytes = big ? 8 : 4;
	if (ifdOffset < (big ? 16 : 8) || ifdOffset + countBytes > total) { return null; }
	await stream.whenAvailable(ifdOffset + countBytes);
	const entries = big ? readOffset(ifdOffset) : view.getUint16(ifdOffset, little);
	if (!Number.isFinite(entries) || entries === 0 || entries > 4096) { return null; }
	const ifdEnd = ifdOffset + countBytes + entries * entryBytes + valueBytes;
	if (ifdEnd > total) { return null; }
	await stream.whenAvailable(ifdEnd);

	let needed = ifdEnd;
	let singleImage = true;
	for (let index = 0; index < entries; index++) {
		const entry = ifdOffset + countBytes + index * entryBytes;
		const tag = view.getUint16(entry, little);
		const type = view.getUint16(entry + 2, little);
		const count = big ? readOffset(entry + 4) : view.getUint32(entry + 4, little);
		const typeBytes = TYPE_BYTES[type] || 0;
		if (!typeBytes || !Number.isFinite(count)) { return null; }
		if (tag === SUB_IFDS_TAG) { singleImage = false; }
		const size = count * typeBytes;
		if (size > valueBytes) {
			const end = readOffset(entry + (big ? 12 : 8)) + size;
			if (!Number.isFinite(end) || end > total) { return null; }
			needed = Math.max(needed, end);
		}
	}
	if (readOffset(ifdEnd - valueBytes) !== 0) { singleImage = false; }
	return { needed, singleImage };
}

/**
 * Read a response body into one buffer of `total` bytes, exposing it as a
 * TiffImageStream while it arrives. `done` resolves with the whole file, or
 * rejects (after failing every pending range) if the body ends early, grows
 * or errors.
 */
export function readResponseAsStream(body: ReadableStream<Uint8Array>, total: number): { stream: TiffImageStream; done: Promise<ArrayBuffer> } {
	const waiters: { end: number; resolve: () => void; reject: (error: Error) => void }[] = [];
	const stream: TiffImageStream = {
		total,
		received: 0,
		bytes: new Uint8Array(total),
		error: null,
		whenAvailable(end: number) {
			if (this.error) { return Promise.reject(this.error); }
			if (this.received >= Math.min(end, this.total)) { return Promise.resolve(); }
			return new Promise((resolve, reject) => waiters.push({ end, resolve, reject }));
		},
	};
	const settle = () => {
		for (let i = waiters.length - 1; i >= 0; i--) {
			const waiter = waiters[i];
			if (stream.error) { waiter.reject(stream.error); }
			else if (stream.received >= Math.min(waiter.end, total)) { waiter.resolve(); }
			else { continue; }
			waiters.splice(i, 1);
		}
	};
	const done = (async () => {
		const bytes = stream.bytes!;
		try {
			const reader = body.getReader();
			for (;;) {
				const { done: finished, value } = await reader.read();
				if (finished) { break; }
				if (stream.received + value.byteLength > total) { throw new Error('image grew while it was read'); }
				bytes.set(value, stream.received);
				stream.received += value.byteLength;
				settle();
			}
			if (stream.received !== total) { throw new Error('image shrank while it was read'); }
			return bytes.buffer as ArrayBuffer;
		} catch (error) {
			stream.error = error instanceof Error ? error : new Error(String(error));
			settle();
			throw stream.error;
		}
	})();
	return { stream, done };
}

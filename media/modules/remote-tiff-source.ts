"use strict";
import { RequestScheduler } from './request-scheduler.js';

/** HTTP orchestration only. TIFF byte interpretation lives in the Rust core. */
type Slice = { offset: number, length: number };
type IndexTable = { tag: number, count: number, offset: number, itemBytes: number };
type IfdPlan = { length: number, nextOffset: number, tables: IndexTable[], patches: { offset: number, bytes: number[] }[] };
const INDEX_NAMES: Record<number, string> = { 273: 'StripOffsets', 279: 'StripByteCounts', 324: 'TileOffsets', 325: 'TileByteCounts' };
const HEADER_BLOCK = 16 * 1024;
const CACHE_BYTES = 16 * 1024 * 1024;

function aborted(signal?: AbortSignal): void {
	if (signal?.aborted) { throw new DOMException('TIFF request cancelled', 'AbortError'); }
}

/** A bounded in-memory range cache; partial HTTP responses never enter disk cache. */
export class TiffRangeSource {
	private readonly cache = new Map<string, { promise: Promise<ArrayBuffer>, size: number }>();
	private bytes = 0;
	private size: number | null = null;
	private readonly scheduler = new RequestScheduler(16);
	constructor(private readonly url: string, private loadSignal?: AbortSignal) {}
	get fileSize(): number | null { return this.size; }
	setLoadSignal(signal?: AbortSignal): void {
		if (this.loadSignal?.aborted) { this.cache.clear(); this.bytes = 0; }
		this.loadSignal = signal;
	}

	private request(offset: number, length: number, signal?: AbortSignal, priority = 0): Promise<ArrayBuffer> {
		return this.scheduler.run(() => this.networkRequest(offset, length, signal), signal, priority);
	}

	private async networkRequest(offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer> {
		aborted(signal);
		if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
			|| !Number.isSafeInteger(offset + length)) { throw new Error('Invalid TIFF byte range'); }
		if (!length) { return new ArrayBuffer(0); }
		const response = await fetch(this.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` }, cache: 'no-store', signal });
		if (response.status !== 206) {
			await response.body?.cancel();
			throw new Error(`TIFF server must support byte ranges (HTTP ${response.status})`);
		}
		const range = response.headers.get('content-range');
		if (range) {
			const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(range);
			if (!match || Number(match[1]) !== offset || Number(match[2]) >= offset + length) {
				await response.body?.cancel(); throw new Error('TIFF server returned an unexpected range');
			}
			if (match[3] !== '*') { this.size = Number(match[3]); }
		}
		// Content-Range may be hidden by CORS. Content-Length is never the file size.
		const data = await response.arrayBuffer();
		if (data.byteLength < length && this.size === null) { this.size = offset + data.byteLength; }
		if (data.byteLength > length) { throw new Error('TIFF range response exceeds requested length'); }
		return data;
	}

	private cached(offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer> {
		aborted(signal);
		const key = `${offset}:${length}`;
		const existing = this.cache.get(key);
		if (existing) {
			this.cache.delete(key); this.cache.set(key, existing);
			return existing.promise.then(data => { aborted(signal); return data; });
		}
		// Shared header/index reads belong to the image load, not a single viewport.
		// A cancelled pan must not poison an index request needed by the next pan.
		const promise = this.request(offset, length, this.loadSignal, 1).catch(error => {
			if (this.cache.get(key)?.promise === promise) { this.cache.delete(key); this.bytes -= length; }
			throw error;
		});
		this.cache.set(key, { promise, size: length }); this.bytes += length;
		while (this.bytes > CACHE_BYTES && this.cache.size > 1) {
			const oldest = this.cache.keys().next().value!;
			this.bytes -= this.cache.get(oldest)!.size; this.cache.delete(oldest);
		}
		return promise.then(data => { aborted(signal); return data; });
	}

	async header(offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer> {
		if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > CACHE_BYTES) { throw new Error('TIFF metadata range is too large or invalid'); }
		if (this.size !== null) { length = Math.min(length, Math.max(0, this.size - offset)); }
		const start = Math.floor(offset / HEADER_BLOCK) * HEADER_BLOCK;
		const chunks = await Promise.all(Array.from({ length: Math.ceil((offset + length - start) / HEADER_BLOCK) }, (_, i) =>
			this.cached(start + i * HEADER_BLOCK, HEADER_BLOCK, signal)));
		const joined = new Uint8Array(chunks.reduce((sum, data) => sum + data.byteLength, 0));
		let at = 0; for (const data of chunks) { joined.set(new Uint8Array(data), at); at += data.byteLength; }
		return joined.slice(offset - start, offset - start + length).buffer;
	}

	async fetch(slices: Slice[], signal?: AbortSignal): Promise<ArrayBuffer[]> {
		// Pixel ranges remain exact and cancellable. Decoded viewport tiles are
		// already cached by the scene and picker; don't retain another pixel copy.
		return Promise.all(slices.map(slice => this.request(slice.offset, slice.length, signal || this.loadSignal)));
	}
	async close(): Promise<void> { this.cache.clear(); this.bytes = 0; }
}

/** Keep the existing geotiff.js compatibility path, but bypass its HTTP disk cache. */
async function ordinaryRemote(url: string, GeoTIFF: any, signal?: AbortSignal): Promise<any> {
	let activeSignal = signal;
	const tiff = await GeoTIFF.fromCustomClient({ request: async ({ headers, signal: requestSignal }: any) => {
		const response = await fetch(url, { headers, signal: requestSignal || activeSignal, cache: 'no-store' });
		if (response.status !== 206) { await response.body?.cancel(); throw new Error(`TIFF server must support byte ranges (HTTP ${response.status})`); }
		return { ok: response.ok, status: response.status,
			getHeader: (name: string) => response.headers.get(name), getData: () => response.arrayBuffer() };
	} }, { blockSize: 64 * 1024, cacheSize: 256, allowFullFile: false }, signal);
	tiff.setLoadSignal = (next?: AbortSignal) => { activeSignal = next; };
	return tiff;
}

export async function openRemoteTiff(url: string, GeoTIFF: any, wasm: any, signal?: AbortSignal): Promise<any> {
	if (!wasm?.remote_tiff_ifd || !GeoTIFF.GeoTIFF?.fromSource || !GeoTIFF.GeoTIFFImage?.prototype?.getTileOrStrip) { return ordinaryRemote(url, GeoTIFF, signal); }
	const source = new TiffRangeSource(url, signal);
	const header = new Uint8Array(await source.header(0, 16, signal));
	const layout = JSON.parse(wasm.remote_tiff_header(header));
	const plans: IfdPlan[] = [];
	const visited = new Set<number>();
	let offset = layout.firstOffset;
	try {
		while (offset) {
			aborted(signal);
			if (visited.has(offset) || plans.length >= 4096) { throw new Error('Invalid TIFF directory chain'); }
			visited.add(offset);
			let data = new Uint8Array(await source.header(offset, 8, signal));
			let plan = JSON.parse(wasm.remote_tiff_ifd(header, data, offset));
			if (data.length < plan.length) {
				data = new Uint8Array(await source.header(offset, plan.length, signal));
				plan = JSON.parse(wasm.remote_tiff_ifd(header, data, offset));
			}
			if (!plan.tables) { throw new Error('Truncated TIFF directory'); }
			plans.push(plan); offset = plan.nextOffset;
		}
	} catch (error) {
		aborted(signal);
		await source.close();
		if (!String(error).includes('Unsupported TIFF block index type')) { throw error; }
		console.warn('[RemoteTIFF] Lazy index unsupported; using existing directory reader:', error);
		return ordinaryRemote(url, GeoTIFF, signal);
	}
	const patches = plans.flatMap(plan => plan.patches);
	const metadataSource = {
		get fileSize() { return source.fileSize; }, close: () => source.close(),
		fetch: async (slices: Slice[], requestSignal?: AbortSignal) => Promise.all(slices.map(async slice => {
			const bytes = new Uint8Array(await source.header(slice.offset, slice.length, requestSignal));
			for (const patch of patches) {
				const start = Math.max(slice.offset, patch.offset);
				const end = Math.min(slice.offset + bytes.length, patch.offset + patch.bytes.length);
				if (end > start) { bytes.set(patch.bytes.slice(start - patch.offset, end - patch.offset), start - slice.offset); }
			}
			return bytes.buffer;
		})),
	};
	const tiff = await GeoTIFF.GeoTIFF.fromSource(metadataSource, { cache: false }, signal);
	tiff.setLoadSignal = (next?: AbortSignal) => source.setLoadSignal(next);
	const originalGetImage = tiff.getImage.bind(tiff);
	const images = new Map<number, Promise<any>>();
	tiff.getImage = (index = 0) => {
		if (!images.has(index)) {
			images.set(index, (async () => {
				const image = await originalGetImage(index);
				const tables = plans[index]?.tables || [];
				image.source = source;
				for (const table of tables) {
					const values = Object.create(null);
					Object.defineProperties(values, { length: { value: table.count }, lazyTiffIndex: { value: true } });
					image.fileDirectory[INDEX_NAMES[table.tag]] = values;
				}
				const loadedIndices = new Map<number, number[]>();
				const decodeBlock = image.getTileOrStrip.bind(image);
				image.getTileOrStrip = async (x: number, y: number, sample: number, pool: any, requestSignal?: AbortSignal) => {
					const columns = Math.ceil(image.getWidth() / image.getTileWidth());
					const rows = Math.ceil(image.getHeight() / image.getTileHeight());
					const block = y * columns + x + (image.planarConfiguration === 2 ? sample * columns * rows : 0);
					await Promise.all(tables.map(async table => {
						if (!Number.isSafeInteger(block) || block < 0 || block >= table.count) { throw new Error('TIFF block index out of bounds'); }
						const values = image.fileDirectory[INDEX_NAMES[table.tag]];
						if (values[block] !== undefined) { return; }
						const bytes = await source.header(table.offset + block * table.itemBytes, table.itemBytes, requestSignal);
						const value = wasm.remote_tiff_index_values(new Uint8Array(bytes), table.itemBytes, layout.littleEndian)[0];
						// Non-enumerable indices need not be cloned into every decode worker:
						// the worker receives compressed bytes and only codec metadata.
						if (values[block] !== undefined) { return; }
						Object.defineProperty(values, block, { value, configurable: true });
						const retained = loadedIndices.get(table.tag) || [];
						retained.push(block);
						if (retained.length > 4096) { delete values[retained.shift()!]; }
						loadedIndices.set(table.tag, retained);
					}));
					aborted(requestSignal);
					return decodeBlock(x, y, sample, pool, requestSignal);
				};
				return image;
			})());
		}
		return images.get(index);
	};
	console.log(`[RemoteTIFF] Lazy directory: ${plans.length} images`);
	return tiff;
}

/** More downloads than decoders, bounded by the worst in-flight tile memory. */
export function remoteTileConcurrency(blockWidth: number, blockHeight: number, channels: number): number {
	const bytes = Math.max(1, blockWidth * blockHeight * Math.max(1, channels) * 16);
	return Math.max(1, Math.min(16, Math.floor(64 * 1024 * 1024 / bytes)));
}

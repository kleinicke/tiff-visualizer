/**
 * Partial reads of a local file for decoders that need only part of it.
 *
 * The VS Code webview resource server and the standalone viewer's blob: URLs
 * both answer HTTP Range requests with 206. `readRange` reads one range;
 * `RangedFile` drives decoders written against Rust's `SparseFile`
 * (formats/scientific_common.rs): the worker decodes from the pieces read so
 * far, and a decoder that needs more answers `[need-range:OFFSET:LENGTH]`,
 * which is read and the decode retried. Small pieces (headers, chunk maps,
 * metadata) stay cached per file, so a plane change usually costs one read.
 */
import type { DecodeWorkerLike } from './decode-worker-client.js';

export class RangeUnavailable extends Error {}

export async function readRange(src: string, position: number, length: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array, total: number }> {
	const response = await fetch(src, { headers: { Range: `bytes=${position}-${position + length - 1}` }, signal });
	if (response.status !== 206) {
		// Never read a whole-file 200 body just to discard it.
		void response.body?.cancel().catch((): void => undefined);
		throw new RangeUnavailable(`Range request answered ${response.status}`);
	}
	const total = Number(/\/(\d+)\s*$/.exec(response.headers.get('content-range') || '')?.[1]);
	return { bytes: new Uint8Array(await response.arrayBuffer()), total };
}

const NEED_RANGE = /\[need-range:(\d+):(\d+)\]/;
/** Pieces up to this size are kept for later decodes of the same file. */
const RETAINED_PIECE_BYTES = 4 * 1024 * 1024;
const RETAINED_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ROUND_TRIPS = 256;

interface Piece { offset: number, bytes: Uint8Array }

export class RangedFile {
	readonly src: string;
	readonly size: number;
	private _retained: Piece[] = [];
	/** Bytes read so far, for the load's `[Perf]` line. */
	bytesRead = 0;
	/** Round trips of the last decode. */
	lastRoundTrips = 0;

	private constructor(src: string, size: number) {
		this.src = src;
		this.size = size;
	}

	/** Open `src` for ranged reads, or null when its host answers none. */
	static async open(src: string, signal?: AbortSignal): Promise<RangedFile | null> {
		try {
			const { bytes, total } = await readRange(src, 0, 1, signal);
			if (!(total > 0) || bytes.length !== 1) { return null; }
			return new RangedFile(src, total);
		} catch (error) {
			if (signal?.aborted) { throw error; }
			return null;
		}
	}

	private _retain(piece: Piece): void {
		if (piece.bytes.length > RETAINED_PIECE_BYTES) { return; }
		this._retained.push(piece);
		let total = this._retained.reduce((sum, p) => sum + p.bytes.length, 0);
		while (total > RETAINED_TOTAL_BYTES && this._retained.length > 1) {
			total -= this._retained.shift()!.bytes.length;
		}
	}

	/**
	 * Decode with `format` in the worker (`<format>-ranged`), reading what the
	 * decoder asks for. Resolves to the worker's result; rejects with the
	 * decoder's error, or when the decode needs more round trips than any
	 * supported file does.
	 */
	async decode(worker: DecodeWorkerLike, format: string, options: Record<string, any>, signal?: AbortSignal): Promise<any> {
		const fresh: Piece[] = [];
		for (let trip = 0; trip <= MAX_ROUND_TRIPS; trip++) {
			const pieces = [...this._retained, ...fresh];
			const total = pieces.reduce((sum, piece) => sum + piece.bytes.length, 0);
			const blob = new Uint8Array(total);
			const offsets: number[] = [];
			const lengths: number[] = [];
			let at = 0;
			for (const piece of pieces) {
				blob.set(piece.bytes, at);
				offsets.push(piece.offset);
				lengths.push(piece.bytes.length);
				at += piece.bytes.length;
			}
			const response = await worker.decode(`${format}-ranged`, blob.buffer, {
				...options, rangedOffsets: offsets, rangedLengths: lengths, fileSize: this.size,
			});
			if (signal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
			if (!response) { throw new Error('Decode worker unavailable'); }
			if (response.ok) {
				this.lastRoundTrips = trip;
				for (const piece of fresh) { this._retain(piece); }
				return response.result;
			}
			const need = NEED_RANGE.exec(String(response.error || ''));
			if (!need) { throw new Error(String(response.error || `${format} decode failed`)); }
			const offset = Number(need[1]);
			const length = Number(need[2]);
			const { bytes } = await readRange(this.src, offset, length, signal);
			this.bytesRead += bytes.length;
			fresh.push({ offset, bytes });
		}
		throw new Error(`${format} needed more than ${MAX_ROUND_TRIPS} reads`);
	}
}

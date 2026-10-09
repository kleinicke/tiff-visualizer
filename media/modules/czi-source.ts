/**
 * Ranged access to a Zeiss CZI file. Opening reads the 512-byte file header,
 * the subblock directory and the metadata segment (a few hundred KB even for
 * a 1.4 GB mosaic); each view then reads only the subblocks it needs, at the
 * stored pyramid level it asks for. The VS Code webview and the standalone
 * viewer's blob: URLs both answer HTTP Range requests with 206; a source that
 * does not is reported as unavailable and the caller reads the file whole.
 *
 * Parsing, planning and decoding are Rust (`formats/czi.rs`) in the decode
 * worker; this module only moves bytes. JPEG XR subblocks need the
 * heavy-codec module, which the worker client hands over on demand.
 */
import type { DecodeWorkerLike } from './decode-worker-client.js';
import { readRange } from './ranged-source.js';
import { decodeCziTilesParallel } from './strip-parallel-decode.js';

const HEAD_BYTES = 512;
/** First read of a segment whose size is not known yet. */
const SEGMENT_PROBE_BYTES = 256 * 1024;
/** A planned subblock range runs to the next known segment, which can be far. */
const SUBBLOCK_PROBE_BYTES = 4 * 1024 * 1024;
const PARALLEL_READS = 6;

export interface CziLayout {
	width: number;
	height: number;
	channels: number;
	bitsPerSample: number;
	sampleFormat: 1 | 2 | 3;
	typeMin: number;
	typeMax: number;
	sourceNumericType: string;
	/** Stored pyramid reduction factors of this plane, 1 first. */
	factors: number[];
	needsJpegXr: boolean;
	metadataJson: string;
}

export interface CziRegionRequest {
	indices: Record<string, number>;
	/** Output pixel spacing in full-resolution pixels (a stored factor reads that level). */
	factor: number;
	/** Full-resolution rectangle from the plane's top-left; the whole plane when absent. */
	rect?: { x: number, y: number, width: number, height: number };
	/** Decode the tiles across the strip pool (samples only; no statistics). */
	parallel?: boolean;
}

/** Bytes 24..32 of a segment header: the size of its data after the 32-byte header. */
function segmentLength(bytes: Uint8Array): number {
	if (bytes.length < 32) { return bytes.length; }
	const used = Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(24, true));
	return 32 + Math.max(0, used);
}

export class CziSource {
	readonly src: string;
	readonly size: number;
	readonly directory: ArrayBuffer;
	readonly metadata: ArrayBuffer;
	readonly boundaries: number[];
	private readonly _layouts = new Map<string, CziLayout>();
	private readonly _worker: DecodeWorkerLike;
	/** Ranges read by this source, for the load's `[Perf]` line. */
	bytesRead = 0;

	private constructor(src: string, size: number, directory: ArrayBuffer, metadata: ArrayBuffer, boundaries: number[], worker: DecodeWorkerLike) {
		this.src = src;
		this.size = size;
		this.directory = directory;
		this.metadata = metadata;
		this.boundaries = boundaries;
		this._worker = worker;
	}

	/**
	 * Open `src` for ranged reads, or null when its host answers no ranges, it
	 * is not a CZI with a subblock directory, or there is no decode worker.
	 */
	static async open(src: string, worker: DecodeWorkerLike | null | undefined, signal?: AbortSignal): Promise<CziSource | null> {
		try {
			const booting = worker?.whenBooting?.();
			if (booting) { await booting; }
			if (!worker?.canDecode('czi-layout')) { return null; }
			const { bytes: head, total } = await readRange(src, 0, HEAD_BYTES, signal);
			if (!(total > 0) || head.length < 32 + 0x50) { return null; }
			const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
			if (new TextDecoder().decode(head.subarray(0, 10)) !== 'ZISRAWFILE') { return null; }
			// ZISRAWFILE data: FilePart at 0x30, DirectoryPosition 0x34, MetadataPosition 0x3c,
			// UpdatePending 0x44, AttachmentDirectoryPosition 0x48.
			if (view.getInt32(32 + 0x30, true) !== 0) { return null; }
			const directoryPosition = Number(view.getBigInt64(32 + 0x34, true));
			const metadataPosition = Number(view.getBigInt64(32 + 0x3c, true));
			const attachmentsPosition = Number(view.getBigInt64(32 + 0x48, true));
			if (!(directoryPosition > 0 && directoryPosition < total)) { return null; }
			let bytesRead = head.length;
			const readSegment = async (position: number): Promise<Uint8Array> => {
				const probe = (await readRange(src, position, Math.min(SEGMENT_PROBE_BYTES, total - position), signal)).bytes;
				bytesRead += probe.length;
				const length = Math.min(segmentLength(probe), total - position);
				if (length <= probe.length) { return probe.subarray(0, length); }
				const rest = (await readRange(src, position + probe.length, length - probe.length, signal)).bytes;
				bytesRead += rest.length;
				const whole = new Uint8Array(length);
				whole.set(probe);
				whole.set(rest, probe.length);
				return whole;
			};
			const [directory, metadata] = await Promise.all([
				readSegment(directoryPosition),
				metadataPosition > 0 && metadataPosition < total ? readSegment(metadataPosition) : Promise.resolve(new Uint8Array(0)),
			]);
			const copy = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer;
			const source = new CziSource(src, total, copy(directory), copy(metadata),
				[directoryPosition, metadataPosition, attachmentsPosition].filter(position => position > 0), worker);
			source.bytesRead = bytesRead;
			return source;
		} catch (error) {
			if (signal?.aborted) { throw error; }
			return null;
		}
	}

	private async _request(format: string, buffer: ArrayBuffer, options: Record<string, any>): Promise<any> {
		const response = await this._worker.decode(format, buffer, {
			...options,
			key: this.src,
			// Sent every time: a worker restarted by navigation keeps nothing.
			directory: this.directory,
			metadata: this.metadata,
		});
		if (!response?.ok) { throw new Error(String(response?.error || `CZI ${format} failed`)); }
		return response.result;
	}

	async layout(indices: Record<string, number>): Promise<CziLayout> {
		const key = JSON.stringify(indices || {});
		const cached = this._layouts.get(key);
		if (cached) { return cached; }
		const layout = await this._request('czi-layout', new ArrayBuffer(0), { indices }) as CziLayout;
		this._layouts.set(key, layout);
		return layout;
	}

	/**
	 * Decode one region: plan it in the worker, read the planned subblock
	 * ranges, decode. Resolves to the worker's decoded-array result (Float32
	 * samples, numeric domain, statistics).
	 */
	async region(request: CziRegionRequest, signal?: AbortSignal): Promise<any> {
		const layout = await this.layout(request.indices);
		const options = {
			indices: request.indices,
			factor: Math.max(1, Math.round(request.factor)),
			...(request.rect ? { rect: request.rect } : {}),
			fileSize: this.size,
			boundaries: this.boundaries,
			codec: layout.needsJpegXr,
		};
		const plan = await this._request('czi-plan', new ArrayBuffer(0), options);
		if (signal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
		const ranges = plan.ranges as [number, number][];
		const parts: Uint8Array[] = new Array(ranges.length);
		let next = 0;
		const readNext = async (): Promise<void> => {
			while (next < ranges.length) {
				const index = next++;
				const [position, length] = ranges[index];
				const probe = (await readRange(this.src, position, Math.min(length, SUBBLOCK_PROBE_BYTES), signal)).bytes;
				const needed = Math.min(segmentLength(probe), length);
				let bytes = probe.subarray(0, Math.min(needed, probe.length));
				if (needed > probe.length) {
					const rest = (await readRange(this.src, position + probe.length, needed - probe.length, signal)).bytes;
					const whole = new Uint8Array(needed);
					whole.set(probe);
					whole.set(rest, probe.length);
					bytes = whole;
				}
				parts[index] = bytes;
			}
		};
		await Promise.all(Array.from({ length: Math.min(PARALLEL_READS, ranges.length) }, readNext));
		if (signal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
		const total = parts.reduce((sum, part) => sum + part.length, 0);
		this.bytesRead += total;
		if (request.parallel && parts.length > 1) {
			const clamp = (value: number, max: number) => Math.min(Math.max(0, Math.floor(value)), max);
			const parallel = await decodeCziTilesParallel({
				directory: this.directory,
				options: { indices: request.indices, fileSize: this.size, boundaries: this.boundaries },
				codec: layout.needsJpegXr,
				region: { x: clamp(request.rect?.x ?? 0, layout.width), y: clamp(request.rect?.y ?? 0, layout.height) },
				factor: options.factor,
				width: plan.width,
				height: plan.height,
				tiles: parts.map((bytes, index) => ({ position: ranges[index][0], bytes, rect: plan.rects[index] })),
			});
			if (signal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
			if (parallel) {
				return { width: plan.width, height: plan.height, channels: parallel.channels, data: parallel.data, sourceFactor: plan.sourceFactor, workers: parallel.workers };
			}
		}
		const blob = new Uint8Array(total);
		const offsets = new Uint32Array(parts.length);
		let at = 0;
		parts.forEach((part, index) => { offsets[index] = at; blob.set(part, at); at += part.length; });
		const result = await this._request('czi-region', blob.buffer, { ...options, offsets: Array.from(offsets) });
		result.sourceFactor = plan.sourceFactor;
		return result;
	}
}

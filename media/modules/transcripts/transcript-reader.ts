/**
 * Reads a transcripts.parquet in pieces, so a whole slide never has to fit in
 * memory.
 *
 * `openTranscripts` makes one pass over the `feature_name` column (a small,
 * dictionary-encoded column) one row group at a time, keeping only the count
 * per gene and which row groups each gene appears in. `readGenes` then reads
 * the position columns of just those row groups for the genes asked for and
 * keeps only their rows, into arrays sized from the counts.
 *
 * Decoding is CPU-bound, so row groups can be handed to a `GroupDecoder` (a
 * pool of workers, see transcript-pool.ts); without one they are decoded here,
 * a few at a time. Either way results are used in file order. Each decoded row
 * group is kept as compact typed arrays (up to a memory budget), so genes
 * added later are read from memory without decoding anything again.
 */

import { parquetMetadataAsync, parquetRead } from 'hyparquet';
import { decompress } from 'fzstd';
import { NativeDecoder } from './transcript-native.js';
import { buildGenePoints, type GenePoints, type TranscriptIndex } from './transcript-data.js';

/** Anything hyparquet can read ranges from. */
export interface RangeFile { byteLength: number; slice(start: number, end?: number): Promise<ArrayBuffer> }

export interface Group { start: number; end: number }

/** The gene rows of one row group: gene codes are positions in `index.genes`. */
export interface PackedGroup { gene: Uint16Array | Uint32Array; x: Float32Array; y: Float32Array; q: Uint8Array; bytes: number }

/** The genes of one row group, with how many transcripts each has there. */
export interface GroupScan { names: string[]; counts: number[] }

/** What a decoder needs to know about the file. */
export interface DecoderSetup { metadata: unknown; hasIsGene: boolean; byteLength: number; groups: Group[]; wasm?: WebAssembly.Module }

/** Decodes row groups somewhere else (workers). `size` is how many it works on at once. */
export interface GroupDecoder {
	readonly size: number;
	scan(at: number): Promise<GroupScan>;
	/** Call before the first `pack`: the gene list that codes refer to. */
	setGenes(genes: string[]): void;
	pack(at: number): Promise<PackedGroup>;
	terminate(): void;
}

export type DecoderFactory = (setup: DecoderSetup) => GroupDecoder | null;

export interface TranscriptHandle {
	file: RangeFile;
	metadata: unknown;
	groups: Group[];
	index: TranscriptIndex;
	geneIndex: Map<string, number>;
	/** Bit g * stride-bytes + gene: row group g holds that gene. */
	presence: Uint8Array;
	bytesPerGroup: number;
	scale: number;
	decoder: GroupDecoder | null;
	/** Decodes in this thread with WebAssembly when no pool does; null if unavailable. */
	native: NativeDecoder | null;
	/** Decoded row groups kept in compact form, by row-group number, so a later gene needs no decoding. */
	packed: Map<number, PackedGroup>;
	packedBytes: number;
}

/** Most memory the packed row groups may use; beyond it row groups are decoded again each time. */
const PACKED_BUDGET = 256 * 1024 * 1024;

/** Row groups in flight when decoding in this thread. */
const READ_AHEAD = 3;

const compressors = {
	ZSTD: (input: Uint8Array, outputLength: number): Uint8Array => decompress(input, new Uint8Array(outputLength)),
};

const REQUIRED = ['feature_name', 'x_location', 'y_location', 'qv'];

interface Chunk { rowStart: number; data: ArrayLike<unknown> }

/** The named columns of one row group, merged into one array each. */
async function readGroup(file: RangeFile, metadata: unknown, group: Group, columns: string[]): Promise<Map<string, ArrayLike<unknown>>> {
	const chunks = new Map<string, Chunk[]>();
	await parquetRead({
		file, metadata, columns, rowStart: group.start, rowEnd: group.end, compressors,
		onChunk: (chunk: { columnName: string; columnData: ArrayLike<unknown>; rowStart: number }) => {
			const list = chunks.get(chunk.columnName) ?? [];
			list.push({ rowStart: chunk.rowStart, data: chunk.columnData });
			chunks.set(chunk.columnName, list);
		},
	} as Parameters<typeof parquetRead>[0]);
	const out = new Map<string, ArrayLike<unknown>>();
	for (const [name, list] of chunks) {
		list.sort((a, b) => a.rowStart - b.rowStart);
		const total = list.reduce((sum, chunk) => sum + chunk.data.length, 0);
		const first = list[0].data;
		const merged: { [index: number]: unknown; length: number } = ArrayBuffer.isView(first) && !(first instanceof DataView)
			? new (first.constructor as new (length: number) => Float32Array)(total) : new Array<unknown>(total);
		let at = 0;
		for (const chunk of list) { for (let index = 0; index < chunk.data.length; index++) { merged[at++] = chunk.data[index]; } }
		out.set(name, merged);
	}
	return out;
}

/** Row groups of a file, as [start, end) row ranges. */
export function groupsOf(metadata: { row_groups: { num_rows: number | bigint }[] }): Group[] {
	const groups: Group[] = [];
	let start = 0;
	for (const group of metadata.row_groups) { const end = start + Number(group.num_rows); groups.push({ start, end }); start = end; }
	return groups;
}

/** Which genes a row group holds, and how many transcripts of each. */
export async function scanGroup(file: RangeFile, metadata: unknown, group: Group, hasIsGene: boolean, native?: { decoder: NativeDecoder; at: number } | null): Promise<GroupScan> {
	const fast = await native?.decoder.scan(file, metadata, native.at, group, hasIsGene);
	if (fast) { return fast; }
	const columns = await readGroup(file, metadata, group, hasIsGene ? ['feature_name', 'is_gene'] : ['feature_name']);
	const feature = columns.get('feature_name') ?? [];
	const isGene = columns.get('is_gene');
	const seen = new Map<string, number>();
	// Controls and unassigned codewords are probes, not genes.
	for (let row = 0; row < feature.length; row++) {
		if (isGene && !isGene[row]) { continue; }
		const name = String(feature[row]);
		seen.set(name, (seen.get(name) ?? 0) + 1);
	}
	return { names: [...seen.keys()], counts: [...seen.values()] };
}

/** Decode one row group and keep only the rows of known genes, in typed arrays (about 11 bytes a row). */
export async function packGroup(file: RangeFile, metadata: unknown, group: Group, geneIndex: Map<string, number>, native?: { decoder: NativeDecoder; at: number } | null): Promise<PackedGroup> {
	const fast = await native?.decoder.pack(file, metadata, native.at, group);
	if (fast) { return fast; }
	const columns = await readGroup(file, metadata, group, REQUIRED);
	const feature = columns.get('feature_name') ?? [], xs = columns.get('x_location') ?? [], ys = columns.get('y_location') ?? [], qv = columns.get('qv') ?? [];
	const rows = feature.length;
	const gene = geneIndex.size < 65535 ? new Uint16Array(rows) : new Uint32Array(rows);
	const x = new Float32Array(rows), y = new Float32Array(rows), q = new Uint8Array(rows);
	let kept = 0;
	for (let row = 0; row < rows; row++) {
		const code = geneIndex.get(feature[row] as string);
		if (code === undefined) { continue; }
		gene[kept] = code; x[kept] = Number(xs[row]); y[kept] = Number(ys[row]);
		const quality = Number(qv[row]);
		q[kept++] = quality >= 255 ? 255 : quality > 0 ? Math.round(quality) : 0;
	}
	const packed = { gene: gene.slice(0, kept), x: x.slice(0, kept), y: y.slice(0, kept), q: q.slice(0, kept), bytes: 0 };
	packed.bytes = packed.gene.byteLength + packed.x.byteLength + packed.y.byteLength + packed.q.byteLength;
	return packed;
}

/** Load `groups` with up to `ahead` in flight, handing each result to `use` in order. */
async function eachGroup<T>(groups: number[], load: (at: number) => Promise<T>, use: (value: T, at: number) => void, ahead: number): Promise<void> {
	const pending = new Map<number, Promise<T>>();
	const start = (position: number): void => {
		if (position >= groups.length || pending.has(position)) { return; }
		const loading = load(groups[position]);
		loading.catch((): void => undefined);
		pending.set(position, loading);
	};
	for (let position = 0; position < ahead; position++) { start(position); }
	for (let position = 0; position < groups.length; position++) {
		const value = await pending.get(position)!;
		pending.delete(position);
		start(position + ahead);
		use(value, groups[position]);
	}
}

const aheadOf = (decoder: GroupDecoder | null): number => decoder ? decoder.size + 2 : READ_AHEAD;

/**
 * Count genes and note which row groups hold each. `scale` converts file units to scene pixels.
 * `decoders`, if given, may return a worker pool to decode with; null decodes here.
 */
export async function openTranscripts(file: RangeFile, scale: number, onProgress?: (done: number, total: number) => void, decoders?: DecoderFactory, wasm?: WebAssembly.Module): Promise<TranscriptHandle> {
	const metadata = await parquetMetadataAsync(file) as { schema: { name: string; num_children?: number }[]; row_groups: { num_rows: number | bigint }[] };
	const names = metadata.schema.slice(1).filter(entry => !entry.num_children).map(entry => entry.name);
	const missing = REQUIRED.filter(name => !names.includes(name));
	if (missing.length) { throw new Error(`The transcripts file has no ${missing.join(', ')} column.`); }
	const hasIsGene = names.includes('is_gene');
	const groups = groupsOf(metadata);
	const decoder = decoders?.({ metadata, hasIsGene, byteLength: file.byteLength, groups, wasm }) ?? null;
	let native: NativeDecoder | null = null;
	try { native = wasm ? new NativeDecoder(wasm) : null; } catch { native = null; }
	const viaNative = (at: number): { decoder: NativeDecoder; at: number } | null => native ? { decoder: native, at } : null;
	const counts = new Map<string, number>();
	const perGroup: string[][] = [];
	let read = 0;
	const scan = (at: number): Promise<GroupScan> => decoder
		? decoder.scan(at).catch(() => scanGroup(file, metadata, groups[at], hasIsGene, viaNative(at)))
		: scanGroup(file, metadata, groups[at], hasIsGene, viaNative(at));
	await eachGroup(groups.map((_group, at) => at), scan, (result, at) => {
		for (let position = 0; position < result.names.length; position++) { counts.set(result.names[position], (counts.get(result.names[position]) ?? 0) + result.counts[position]); }
		perGroup[at] = result.names;
		onProgress?.(++read, groups.length);
	}, aheadOf(decoder));
	const genes = [...counts.keys()].sort();
	const geneIndex = new Map(genes.map((gene, position) => [gene, position]));
	decoder?.setGenes(genes);
	native?.setGenes(genes);
	const bytesPerGroup = Math.ceil(genes.length / 8);
	const presence = new Uint8Array(bytesPerGroup * groups.length);
	perGroup.forEach((present, group) => { for (const gene of present) { const position = geneIndex.get(gene)!; presence[group * bytesPerGroup + (position >> 3)] |= 1 << (position & 7); } });
	let total = 0;
	const countList = genes.map(gene => { const count = counts.get(gene)!; total += count; return count; });
	return { file, metadata, groups, index: { genes, counts: countList, total }, geneIndex, presence, bytesPerGroup, scale, decoder, native, packed: new Map(), packedBytes: 0 };
}

/** Stop any workers decoding for this file. */
export function closeTranscripts(handle: TranscriptHandle): void { handle.decoder?.terminate(); handle.decoder = null; }

interface Wanted { x: Float64Array; y: Float64Array; q: Float32Array; filled: number }

function grow<T extends Float64Array | Float32Array>(array: T, length: number): T {
	const bigger = new (array.constructor as new (length: number) => T)(length);
	bigger.set(array);
	return bigger;
}

/** The points of the named genes, reading only the row groups that hold them. */
export async function readGenes(handle: TranscriptHandle, names: string[], onProgress?: (done: number, total: number) => void): Promise<Map<string, GenePoints>> {
	const wanted = new Map<string, Wanted>();
	const slot = new Int32Array(handle.index.genes.length).fill(-1);
	const slots: Wanted[] = [];
	for (const name of names) {
		const position = handle.geneIndex.get(name);
		if (position === undefined || wanted.has(name)) { continue; }
		const size = handle.index.counts[position];
		const gene = { x: new Float64Array(size), y: new Float64Array(size), q: new Float32Array(size), filled: 0 };
		wanted.set(name, gene);
		slot[position] = slots.push(gene) - 1;
	}
	const positions = [...wanted.keys()].map(name => handle.geneIndex.get(name)!);
	const groups = handle.groups.map((_group, at) => at).filter(at => positions.some(position => handle.presence[at * handle.bytesPerGroup + (position >> 3)] & (1 << (position & 7))));
	let done = 0;
	const decode = (at: number): Promise<PackedGroup> => {
		const here = (): Promise<PackedGroup> => packGroup(handle.file, handle.metadata, handle.groups[at], handle.geneIndex, handle.native ? { decoder: handle.native, at } : null);
		return handle.decoder ? handle.decoder.pack(at).catch(here) : here();
	};
	const load = (at: number): Promise<PackedGroup> => {
		const kept = handle.packed.get(at);
		if (kept) { return Promise.resolve(kept); }
		return decode(at).then(packed => {
			if (handle.packedBytes + packed.bytes <= PACKED_BUDGET && !handle.packed.has(at)) { handle.packed.set(at, packed); handle.packedBytes += packed.bytes; }
			return packed;
		});
	};
	await eachGroup(groups, load, packed => {
		const { gene: codes, x, y, q } = packed;
		for (let row = 0; row < codes.length; row++) {
			const found = slot[codes[row]];
			if (found < 0) { continue; }
			const gene = slots[found];
			if (gene.filled === gene.x.length) {
				const length = Math.max(16, gene.x.length * 2);
				gene.x = grow(gene.x, length); gene.y = grow(gene.y, length); gene.q = grow(gene.q, length);
			}
			const at = gene.filled++;
			gene.x[at] = x[row]; gene.y[at] = y[row]; gene.q[at] = q[row];
		}
		onProgress?.(++done, groups.length);
	}, aheadOf(handle.decoder));
	const out = new Map<string, GenePoints>();
	for (const [name, gene] of wanted) { out.set(name, buildGenePoints(gene.x.subarray(0, gene.filled), gene.y.subarray(0, gene.filled), gene.q.subarray(0, gene.filled), handle.scale)); }
	return out;
}

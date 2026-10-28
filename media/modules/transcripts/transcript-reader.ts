/**
 * Reads a transcripts.parquet in pieces, so a whole slide never has to fit in
 * memory.
 *
 * `openTranscripts` makes one pass over the `feature_name` column (a small,
 * dictionary-encoded column) one row group at a time, keeping only the count
 * per gene and which row groups each gene appears in. `readGenes` then reads
 * the position columns of just those row groups for the genes asked for and
 * keeps only their rows. Nothing proportional to the whole file stays in
 * memory except those two small tables.
 */

import { parquetMetadataAsync, parquetRead } from 'hyparquet';
import { decompress } from 'fzstd';
import { buildGenePoints, type GenePoints, type TranscriptIndex } from './transcript-data.js';

/** Anything hyparquet can read ranges from. */
export interface RangeFile { byteLength: number; slice(start: number, end?: number): Promise<ArrayBuffer> }

interface Group { start: number; end: number }

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
}

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
function groupsOf(metadata: { row_groups: { num_rows: number | bigint }[] }): Group[] {
	const groups: Group[] = [];
	let start = 0;
	for (const group of metadata.row_groups) { const end = start + Number(group.num_rows); groups.push({ start, end }); start = end; }
	return groups;
}

/** Count genes and note which row groups hold each. `scale` converts file units to scene pixels. */
export async function openTranscripts(file: RangeFile, scale: number, onProgress?: (done: number, total: number) => void): Promise<TranscriptHandle> {
	const metadata = await parquetMetadataAsync(file) as { schema: { name: string; num_children?: number }[]; row_groups: { num_rows: number | bigint }[] };
	const names = metadata.schema.slice(1).filter(entry => !entry.num_children).map(entry => entry.name);
	const missing = REQUIRED.filter(name => !names.includes(name));
	if (missing.length) { throw new Error(`The transcripts file has no ${missing.join(', ')} column.`); }
	const hasIsGene = names.includes('is_gene');
	const groups = groupsOf(metadata);
	const counts = new Map<string, number>();
	const perGroup: Set<string>[] = [];
	for (let at = 0; at < groups.length; at++) {
		const columns = await readGroup(file, metadata, groups[at], hasIsGene ? ['feature_name', 'is_gene'] : ['feature_name']);
		const feature = columns.get('feature_name') ?? [];
		const isGene = columns.get('is_gene');
		const present = new Set<string>();
		// Controls and unassigned codewords are probes, not genes.
		for (let row = 0; row < feature.length; row++) {
			if (isGene && !isGene[row]) { continue; }
			const name = String(feature[row]);
			counts.set(name, (counts.get(name) ?? 0) + 1);
			present.add(name);
		}
		perGroup.push(present);
		onProgress?.(at + 1, groups.length);
	}
	const genes = [...counts.keys()].sort();
	const geneIndex = new Map(genes.map((gene, position) => [gene, position]));
	const bytesPerGroup = Math.ceil(genes.length / 8);
	const presence = new Uint8Array(bytesPerGroup * groups.length);
	perGroup.forEach((present, group) => { for (const gene of present) { const position = geneIndex.get(gene)!; presence[group * bytesPerGroup + (position >> 3)] |= 1 << (position & 7); } });
	let total = 0;
	const countList = genes.map(gene => { const count = counts.get(gene)!; total += count; return count; });
	return { file, metadata, groups, index: { genes, counts: countList, total }, geneIndex, presence, bytesPerGroup, scale };
}

/** The points of the named genes, reading only the row groups that hold them. */
export async function readGenes(handle: TranscriptHandle, names: string[], onProgress?: (done: number, total: number) => void): Promise<Map<string, GenePoints>> {
	const wanted = new Map<string, { x: number[]; y: number[]; q: number[] }>();
	for (const name of names) { if (handle.geneIndex.has(name)) { wanted.set(name, { x: [], y: [], q: [] }); } }
	const positions = [...wanted.keys()].map(name => handle.geneIndex.get(name)!);
	const groups = handle.groups.map((_group, at) => at).filter(at => positions.some(position => handle.presence[at * handle.bytesPerGroup + (position >> 3)] & (1 << (position & 7))));
	let done = 0;
	for (const at of groups) {
		const columns = await readGroup(handle.file, handle.metadata, handle.groups[at], REQUIRED);
		const feature = columns.get('feature_name') ?? [], xs = columns.get('x_location') ?? [], ys = columns.get('y_location') ?? [], qv = columns.get('qv') ?? [];
		for (let row = 0; row < feature.length; row++) {
			const gene = wanted.get(feature[row] as string);
			if (!gene) { continue; }
			gene.x.push(Number(xs[row])); gene.y.push(Number(ys[row])); gene.q.push(Number(qv[row]));
		}
		onProgress?.(++done, groups.length);
	}
	const out = new Map<string, GenePoints>();
	for (const [name, gene] of wanted) { out.set(name, buildGenePoints(gene.x, gene.y, gene.q, handle.scale)); }
	return out;
}

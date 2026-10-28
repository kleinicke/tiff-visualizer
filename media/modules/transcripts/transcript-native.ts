/**
 * Decodes transcripts.parquet row groups with the Rust/WASM module (wasm/transcripts-decoder).
 * It reads the column chunks' bytes straight into typed arrays, several times faster than
 * hyparquet plus fzstd. It handles the layout Xenium files have (flat columns, no nulls, plain or
 * dictionary pages, uncompressed or zstd); for anything else `scan` and `pack` resolve to null and
 * the caller uses the general reader for that row group.
 */

import type { Group, GroupScan, PackedGroup, RangeFile } from './transcript-reader.js';

interface Exports {
	memory: WebAssembly.Memory;
	tx_alloc(length: number): number;
	tx_free(pointer: number, length: number): void;
	tx_set_genes(blob: number, blobLength: number, offsets: number, count: number): number;
	tx_scan(table: number): number;
	tx_pack(table: number): number;
	tx_scan_count(): number;
	tx_scan_names_len(): number;
	tx_scan_names_ptr(): number;
	tx_scan_offsets_ptr(): number;
	tx_scan_counts_ptr(): number;
	tx_out_rows(): number;
	tx_out_wide(): number;
	tx_out_gene_ptr(): number;
	tx_out_x_ptr(): number;
	tx_out_y_ptr(): number;
	tx_out_q_ptr(): number;
}

interface ColumnMeta {
	path_in_schema: string[];
	type: string;
	codec: string;
	num_values: number | bigint;
	total_compressed_size: number | bigint;
	data_page_offset: number | bigint;
	dictionary_page_offset?: number | bigint;
}
interface Metadata { schema: { name: string; repetition_type?: string; num_children?: number }[]; row_groups: { columns: { meta_data?: ColumnMeta }[] }[] }

const CODECS: Record<string, number> = { UNCOMPRESSED: 0, ZSTD: 6 };
const TYPES: Record<string, number> = { BOOLEAN: 0, FLOAT: 4, DOUBLE: 5, BYTE_ARRAY: 6 };

interface Fetched { pointer: number; length: number; codec: number; type: number; max: number }

export class NativeDecoder {
	private readonly wasm: Exports;
	private broken = false;
	private encoder = new TextEncoder();
	private decoder = new TextDecoder();

	constructor(module: WebAssembly.Module) {
		this.wasm = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
	}

	private bytes(): Uint8Array { return new Uint8Array(this.wasm.memory.buffer); }

	private put(data: Uint8Array): number {
		const pointer = this.wasm.tx_alloc(data.length);
		this.bytes().set(data, pointer);
		return pointer;
	}

	setGenes(genes: string[]): void {
		if (this.broken) { return; }
		const parts = genes.map(gene => this.encoder.encode(gene));
		const offsets = new Uint32Array(genes.length + 1);
		parts.forEach((part, index) => { offsets[index + 1] = offsets[index] + part.length; });
		const blob = new Uint8Array(offsets[genes.length]);
		parts.forEach((part, index) => blob.set(part, offsets[index]));
		const blobPointer = this.put(blob);
		const offsetPointer = this.put(new Uint8Array(offsets.buffer));
		const status = this.wasm.tx_set_genes(blobPointer, blob.length, offsetPointer, genes.length);
		this.wasm.tx_free(blobPointer, blob.length);
		this.wasm.tx_free(offsetPointer, offsets.byteLength);
		if (status !== 0) { this.broken = true; }
	}

	/** Fetch the named columns of a row group into wasm memory and run `call` on them. */
	private async run<T>(file: RangeFile, metadata: Metadata, at: number, group: Group, names: (string | null)[], call: (table: number) => number, read: () => T): Promise<T | null> {
		if (this.broken) { return null; }
		const columns = metadata.row_groups[at]?.columns;
		const fetched: (Fetched | null)[] = [];
		try {
			const wanted = names.map(name => {
				if (name === null) { return null; }
				const meta = columns?.find(column => column.meta_data?.path_in_schema.length === 1 && column.meta_data.path_in_schema[0] === name)?.meta_data;
				const schema = metadata.schema.find(entry => entry.name === name && !entry.num_children);
				const codec = meta ? CODECS[meta.codec] : undefined, type = meta ? TYPES[meta.type] : undefined;
				if (!meta || !schema || codec === undefined || type === undefined || schema.repetition_type === 'REPEATED') { throw new Error('unsupported'); }
				const dictionary = meta.dictionary_page_offset ? Number(meta.dictionary_page_offset) : 0;
				const start = dictionary > 0 ? dictionary : Number(meta.data_page_offset);
				return { start, end: start + Number(meta.total_compressed_size), codec, type, max: schema.repetition_type === 'OPTIONAL' ? 1 : 0 };
			});
			const buffers = await Promise.all(wanted.map(item => item ? file.slice(item.start, Math.min(item.end, file.byteLength)) : null));
			for (let index = 0; index < wanted.length; index++) {
				const item = wanted[index], buffer = buffers[index];
				if (!item || !buffer) { fetched.push({ pointer: 0, length: 0, codec: 0, type: 0, max: 0 }); continue; }
				fetched.push({ pointer: this.put(new Uint8Array(buffer)), length: buffer.byteLength, codec: item.codec, type: item.type, max: item.max });
			}
			const rows = group.end - group.start;
			const table = new Uint32Array(fetched.length * 6);
			fetched.forEach((item, index) => { table.set([item!.pointer, item!.length, item!.codec, item!.type, item!.length ? rows : 0, item!.max], index * 6); });
			const tablePointer = this.put(new Uint8Array(table.buffer));
			const status = call(tablePointer);
			this.wasm.tx_free(tablePointer, table.byteLength);
			return status === 0 ? read() : null;
		} catch (error) {
			if (error instanceof WebAssembly.RuntimeError) { this.broken = true; }
			return null;
		} finally {
			for (const item of fetched) { if (item?.length) { this.wasm.tx_free(item.pointer, item.length); } }
		}
	}

	async scan(file: RangeFile, metadata: unknown, at: number, group: Group, hasIsGene: boolean): Promise<GroupScan | null> {
		return this.run(file, metadata as Metadata, at, group, hasIsGene ? ['feature_name', 'is_gene'] : ['feature_name', null], table => this.wasm.tx_scan(table), () => {
			const count = this.wasm.tx_scan_count();
			const names = this.bytes().slice(this.wasm.tx_scan_names_ptr(), this.wasm.tx_scan_names_ptr() + this.wasm.tx_scan_names_len());
			const offsets = new Uint32Array(this.wasm.memory.buffer, this.wasm.tx_scan_offsets_ptr(), count + 1).slice();
			const counts = new Uint32Array(this.wasm.memory.buffer, this.wasm.tx_scan_counts_ptr(), count).slice();
			const list: string[] = [];
			for (let index = 0; index < count; index++) { list.push(this.decoder.decode(names.subarray(offsets[index], offsets[index + 1]))); }
			return { names: list, counts: Array.from(counts) };
		});
	}

	async pack(file: RangeFile, metadata: unknown, at: number, group: Group): Promise<PackedGroup | null> {
		return this.run(file, metadata as Metadata, at, group, ['feature_name', 'x_location', 'y_location', 'qv'], table => this.wasm.tx_pack(table), () => {
			const rows = this.wasm.tx_out_rows();
			const buffer = this.wasm.memory.buffer;
			const wide = this.wasm.tx_out_wide() !== 0;
			const gene = wide ? new Uint32Array(buffer, this.wasm.tx_out_gene_ptr(), rows).slice() : new Uint16Array(buffer, this.wasm.tx_out_gene_ptr(), rows).slice();
			const x = new Float32Array(buffer, this.wasm.tx_out_x_ptr(), rows).slice();
			const y = new Float32Array(buffer, this.wasm.tx_out_y_ptr(), rows).slice();
			const q = new Uint8Array(buffer, this.wasm.tx_out_q_ptr(), rows).slice();
			return { gene, x, y, q, bytes: gene.byteLength + x.byteLength + y.byteLength + q.byteLength };
		});
	}
}

/**
 * Reads Parquet columns of a file held in memory with the Rust/WASM decoder (see
 * wasm/transcripts-decoder): zstd, dictionary and plain pages straight into typed arrays.
 * Columns it cannot handle (nulls, other codecs or types) are left out of the result so the
 * caller reads them with hyparquet.
 */

import { parquetMetadata } from 'hyparquet';
import { NativeDecoder, type ColumnPiece } from '../transcripts/transcript-native.js';

interface ColumnMeta {
	path_in_schema: string[]; type: string; codec: string; num_values: number | bigint; total_compressed_size: number | bigint;
	data_page_offset: number | bigint; dictionary_page_offset?: number | bigint;
}
interface Metadata { schema: { name: string; repetition_type?: string; num_children?: number }[]; row_groups: { columns: { meta_data?: ColumnMeta }[] }[] }

const CODECS: Record<string, number> = { UNCOMPRESSED: 0, ZSTD: 6 };
const TYPES: Record<string, number> = { BOOLEAN: 0, INT32: 1, INT64: 2, FLOAT: 4, DOUBLE: 5, BYTE_ARRAY: 6 };

/** A decoded column: numbers in a typed array (INT64 as BigInt64Array), or one string per row. */
export type NativeColumn = Float32Array | Float64Array | Int32Array | BigInt64Array | Uint8Array | string[];

export interface NativeReader {
	/** Names of the leaf columns, in file order. */
	names: string[];
	/** The columns it could decode; INT64 becomes INT32 when `narrow` (null where a value does not fit). */
	read(names: string[], narrow?: boolean): Map<string, NativeColumn>;
}

export function nativeReader(buffer: ArrayBuffer, module: WebAssembly.Module): NativeReader | null {
	let decoder: NativeDecoder;
	let metadata: Metadata;
	try { decoder = new NativeDecoder(module); metadata = parquetMetadata(buffer) as unknown as Metadata; } catch { return null; }
	const bytes = new Uint8Array(buffer);
	const leaves = metadata.schema.slice(1).filter(entry => !entry.num_children);
	const names = leaves.map(entry => entry.name);
	const pieces = (name: string): { pieces: ColumnPiece[]; type: string } | null => {
		const schema = leaves.find(entry => entry.name === name);
		if (!schema || schema.repetition_type === 'REPEATED') { return null; }
		const list: ColumnPiece[] = [];
		let type = '';
		for (const group of metadata.row_groups) {
			const meta = group.columns.find(column => column.meta_data?.path_in_schema.length === 1 && column.meta_data.path_in_schema[0] === name)?.meta_data;
			const code = meta ? CODECS[meta.codec] : undefined, kind = meta ? TYPES[meta.type] : undefined;
			if (!meta || code === undefined || kind === undefined) { return null; }
			const dictionary = meta.dictionary_page_offset ? Number(meta.dictionary_page_offset) : 0;
			const start = dictionary > 0 ? dictionary : Number(meta.data_page_offset);
			type = meta.type;
			list.push({ bytes: bytes.subarray(start, Math.min(start + Number(meta.total_compressed_size), bytes.length)), codec: code, type: kind, rows: Number(meta.num_values), max: schema.repetition_type === 'OPTIONAL' ? 1 : 0 });
		}
		return list.length ? { pieces: list, type } : null;
	};
	return {
		names,
		read(wanted, narrow = false) {
			const out = new Map<string, NativeColumn>();
			for (const name of wanted) {
				const found = pieces(name);
				if (!found) { continue; }
				if (found.type === 'BYTE_ARRAY') {
					const strings = decoder.strings(found.pieces);
					if (!strings) { continue; }
					const values = new Array<string>(strings.ids.length);
					for (let row = 0; row < values.length; row++) { values[row] = strings.names[strings.ids[row]]; }
					out.set(name, values);
					continue;
				}
				const raw = decoder.fixed(found.pieces, narrow);
				if (!raw) { continue; }
				const copy = raw.byteOffset % 8 === 0 ? raw : raw.slice();
				const view = (Type: { new (buffer: ArrayBufferLike, offset: number, length: number): NativeColumn; BYTES_PER_ELEMENT: number }): NativeColumn => new Type(copy.buffer, copy.byteOffset, copy.byteLength / Type.BYTES_PER_ELEMENT);
				out.set(name, found.type === 'FLOAT' ? view(Float32Array) : found.type === 'DOUBLE' ? view(Float64Array) : found.type === 'INT32' || (found.type === 'INT64' && narrow) ? view(Int32Array) : found.type === 'INT64' ? view(BigInt64Array) : copy);
			}
			return out;
		},
	};
}

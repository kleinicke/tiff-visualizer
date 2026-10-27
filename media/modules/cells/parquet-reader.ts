/**
 * Column reader for Parquet files, used for Xenium cell tables and
 * boundaries. hyparquet does the decoding; Xenium writes ZSTD, which needs the
 * decompressor passed in. Chunks are collected per column so no per-row
 * objects are built for the (very long) boundary tables.
 */

import { parquetRead } from 'hyparquet';
import { decompress } from 'fzstd';

export type ParquetColumn = ArrayLike<unknown> & { length: number };

interface Chunk { rowStart: number; data: ArrayLike<unknown> }

const compressors = {
	ZSTD: (input: Uint8Array, outputLength: number): Uint8Array => decompress(input, new Uint8Array(outputLength)),
};

/** Read the named columns (all when omitted) as plain arrays, in file order. */
export async function readParquetColumns(buffer: ArrayBuffer, columns?: string[]): Promise<Map<string, unknown[]>> {
	const chunks = new Map<string, Chunk[]>();
	await parquetRead({
		file: buffer,
		columns,
		compressors,
		onChunk: (chunk: { columnName: string; columnData: ArrayLike<unknown>; rowStart: number }) => {
			const list = chunks.get(chunk.columnName) ?? [];
			list.push({ rowStart: chunk.rowStart, data: chunk.columnData });
			chunks.set(chunk.columnName, list);
		},
	} as Parameters<typeof parquetRead>[0]);
	const result = new Map<string, unknown[]>();
	for (const [name, list] of chunks) {
		list.sort((a, b) => a.rowStart - b.rowStart);
		const total = list.reduce((sum, chunk) => sum + chunk.data.length, 0);
		const merged = new Array<unknown>(total);
		let at = 0;
		for (const chunk of list) {
			for (let index = 0; index < chunk.data.length; index++) { merged[at++] = chunk.data[index]; }
		}
		result.set(name, merged);
	}
	return result;
}

/** Numbers from a decoded column; bigint (INT64) and missing values are handled. */
export function toFloat64(values: ArrayLike<unknown>): Float64Array {
	const out = new Float64Array(values.length);
	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		out[index] = typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : value === null || value === undefined ? NaN : Number(value);
	}
	return out;
}

export function toStrings(values: ArrayLike<unknown>): string[] {
	const out = new Array<string>(values.length);
	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		out[index] = value === null || value === undefined ? '' : String(value);
	}
	return out;
}

/** Kind of a decoded column, from its first present value. */
export function columnKind(values: ArrayLike<unknown>): 'string' | 'integer' | 'float' | 'boolean' | 'empty' {
	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		if (value === null || value === undefined) { continue; }
		if (typeof value === 'string') { return 'string'; }
		if (typeof value === 'boolean') { return 'boolean'; }
		if (typeof value === 'bigint') { return 'integer'; }
		if (typeof value === 'number') { return 'float'; }
		return 'string';
	}
	return 'empty';
}

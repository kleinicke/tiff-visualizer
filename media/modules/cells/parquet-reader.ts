/**
 * Column reader for Parquet files, used for Xenium cell tables and
 * boundaries. hyparquet does the decoding; Xenium writes ZSTD, which needs the
 * decompressor passed in. Chunks are collected per column so no per-row
 * objects are built for the (very long) boundary tables.
 */

import { parquetMetadata, parquetRead } from 'hyparquet';
import { decompress } from 'fzstd';

interface Chunk { rowStart: number; data: ArrayLike<unknown> }

const compressors = {
	ZSTD: (input: Uint8Array, outputLength: number): Uint8Array => decompress(input, new Uint8Array(outputLength)),
};

/** Read the named columns (all when omitted) as plain arrays, in file order. */
export async function readParquetColumns(buffer: ArrayBuffer, columns?: string[], rowEnd?: number): Promise<Map<string, unknown[]>> {
	const chunks = new Map<string, Chunk[]>();
	await parquetRead({
		file: buffer,
		columns,
		rowEnd,
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

/** Names of the leaf columns, from the file footer only. */
export function parquetColumnNames(buffer: ArrayBuffer): string[] {
	return parquetMetadata(buffer).schema.slice(1).filter(entry => !entry.num_children).map(entry => entry.name);
}

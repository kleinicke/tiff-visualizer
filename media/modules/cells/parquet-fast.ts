/**
 * Fast path for the long boundary tables: required, PLAIN-encoded numeric
 * columns (Xenium's vertex_x, vertex_y and label_id) are decompressed page by
 * page straight into typed arrays. hyparquet builds a JavaScript array per
 * column, which costs seconds and gigabytes at tens of millions of vertices.
 *
 * Anything else (optional columns, dictionaries, snappy) throws
 * `FastPathUnavailable` and the caller falls back to `readParquetColumns`.
 */

import { parquetMetadata } from 'hyparquet';
import { decompress } from 'fzstd';

export class FastPathUnavailable extends Error {}

type Typed = Float32Array | Float64Array | Int32Array;

interface PageHeader {
	type: number;
	uncompressedSize: number;
	compressedSize: number;
	numValues: number;
	encoding: number;
	levelBytes: number;
	numNulls: number;
	isCompressed: boolean;
	headerLength: number;
}

/** Just enough Thrift compact protocol to read a Parquet page header. */
function readPageHeader(bytes: Uint8Array, start: number): PageHeader {
	let at = start;
	const varint = (): number => {
		let result = 0, shift = 0;
		for (;;) {
			const byte = bytes[at++];
			result += (byte & 0x7f) * 2 ** shift;
			if ((byte & 0x80) === 0) { return result; }
			shift += 7;
		}
	};
	const zigzag = (): number => { const value = varint(); return value % 2 === 0 ? value / 2 : -(value + 1) / 2; };
	const skip = (type: number): void => {
		switch (type) {
			case 1: case 2: return;
			case 3: at += 1; return;
			case 4: case 5: case 6: zigzag(); return;
			case 7: at += 8; return;
			case 8: { const length = varint(); at += length; return; }
			case 9: case 10: {
				const head = bytes[at++];
				let count = head >> 4;
				const elementType = head & 0x0f;
				if (count === 15) { count = varint(); }
				for (let index = 0; index < count; index++) { skip(elementType); }
				return;
			}
			case 12: readStruct(() => undefined); return;
			default: throw new FastPathUnavailable(`thrift type ${type}`);
		}
	};
	const readStruct = (onField: (id: number, type: number) => boolean | void): void => {
		let id = 0;
		for (;;) {
			const head = bytes[at++];
			if (head === 0) { return; }
			const type = head & 0x0f;
			const delta = head >> 4;
			id = delta === 0 ? zigzag() : id + delta;
			if (!onField(id, type)) { skip(type); }
		}
	};
	const header: PageHeader = { type: -1, uncompressedSize: 0, compressedSize: 0, numValues: 0, encoding: -1, levelBytes: 0, numNulls: 0, isCompressed: true, headerLength: 0 };
	readStruct((id, type) => {
		if (id === 1) { header.type = zigzag(); return true; }
		if (id === 2) { header.uncompressedSize = zigzag(); return true; }
		if (id === 3) { header.compressedSize = zigzag(); return true; }
		if (id === 5 && type === 12) {
			readStruct((inner, innerType) => {
				if (inner === 1) { header.numValues = zigzag(); return true; }
				if (inner === 2) { header.encoding = zigzag(); return true; }
				void innerType; return false;
			});
			return true;
		}
		if (id === 8 && type === 12) {
			readStruct((inner, innerType) => {
				if (inner === 1) { header.numValues = zigzag(); return true; }
				if (inner === 2) { header.numNulls = zigzag(); return true; }
				if (inner === 4) { header.encoding = zigzag(); return true; }
				if (inner === 5 || inner === 6) { header.levelBytes += zigzag(); return true; }
				if (inner === 7) { header.isCompressed = innerType === 1; return true; }
				return false;
			});
			return true;
		}
		return false;
	});
	header.headerLength = at - start;
	return header;
}

function inflate(page: Uint8Array, codec: string, outputLength: number): Uint8Array {
	if (codec === 'UNCOMPRESSED') { return page; }
	if (codec === 'ZSTD') { return decompress(page, new Uint8Array(outputLength)); }
	throw new FastPathUnavailable(`codec ${codec}`);
}

/** Read the named required PLAIN columns as typed arrays. INT64 columns are returned as their low 32 bits. */
export function readPlainColumns(buffer: ArrayBuffer, names: string[]): Map<string, Typed> {
	const metadata = parquetMetadata(buffer);
	const bytes = new Uint8Array(buffer);
	const out = new Map<string, Typed>();
	const sizes = new Map<string, number>();
	for (const group of metadata.row_groups) {
		for (const column of group.columns) {
			const name = column.meta_data?.path_in_schema.join('.') ?? '';
			if (names.includes(name)) { sizes.set(name, (sizes.get(name) ?? 0) + Number(column.meta_data!.num_values)); }
		}
	}
	for (const name of names) {
		if (!sizes.has(name)) { throw new FastPathUnavailable(`no column ${name}`); }
		const element = metadata.schema.find(entry => entry.name === name);
		if (!element || element.repetition_type === 'REPEATED') { throw new FastPathUnavailable(`${name} is repeated`); }
		const type = element.type;
		const total = sizes.get(name)!;
		out.set(name, type === 'FLOAT' ? new Float32Array(total) : type === 'DOUBLE' ? new Float64Array(total) : type === 'INT32' || type === 'INT64' ? new Int32Array(total) : (() => { throw new FastPathUnavailable(`type ${String(type)}`); })());
	}
	const filled = new Map<string, number>();
	for (const group of metadata.row_groups) {
		for (const column of group.columns) {
			const meta = column.meta_data!;
			const name = meta.path_in_schema.join('.');
			if (!names.includes(name)) { continue; }
			if (meta.dictionary_page_offset !== undefined && Number(meta.dictionary_page_offset) > 0) { throw new FastPathUnavailable('dictionary'); }
			const target = out.get(name)!;
			const type = metadata.schema.find(entry => entry.name === name)!.type;
			let at = Number(meta.data_page_offset);
			let remaining = Number(meta.num_values);
			while (remaining > 0) {
				const header = readPageHeader(bytes, at);
				const body = bytes.subarray(at + header.headerLength, at + header.headerLength + header.compressedSize);
				at += header.headerLength + header.compressedSize;
				if (header.type !== 0 && header.type !== 3) { throw new FastPathUnavailable(`page type ${header.type}`); }
				if (header.encoding !== 0) { throw new FastPathUnavailable(`encoding ${header.encoding}`); }
				const optional = metadata.schema.find(entry => entry.name === name)!.repetition_type === 'OPTIONAL';
				let values: Uint8Array;
				if (header.type === 3) {
					// Version 2 keeps the level bytes uncompressed in front of the values.
					if (header.numNulls !== 0) { throw new FastPathUnavailable('nulls'); }
					const region = body.subarray(header.levelBytes);
					values = header.isCompressed ? inflate(region, meta.codec, header.uncompressedSize - header.levelBytes) : region;
				} else {
					values = inflate(body, meta.codec, header.uncompressedSize);
					if (optional) {
						// Version 1: a length-prefixed level run; accept only "every value defined".
						const view = new DataView(values.buffer, values.byteOffset, values.byteLength);
						const levelLength = view.getUint32(0, true);
						const runHeader = values[4];
						if (runHeader !== (header.numValues << 1) % 256 && header.numValues < 64) { throw new FastPathUnavailable('nulls'); }
						if (levelLength > 16 || values[4 + levelLength - 1] !== 1) { throw new FastPathUnavailable('nulls'); }
						values = values.subarray(4 + levelLength);
					}
				}
				const count = header.numValues;
				const position = filled.get(name) ?? 0;
				const width = type === 'FLOAT' || type === 'INT32' ? 4 : 8;
				if (values.byteLength < count * width) { throw new FastPathUnavailable('short page'); }
				const aligned = values.byteOffset % 4 === 0 ? values : values.slice();
				if (type === 'INT64') {
					const words = new Int32Array(aligned.buffer, aligned.byteOffset, count * 2);
					for (let index = 0; index < count; index++) {
						if (words[index * 2 + 1] !== 0) { throw new FastPathUnavailable('int64 above 32 bits'); }
						(target as Int32Array)[position + index] = words[index * 2];
					}
				} else if (type === 'DOUBLE') {
					(target as Float64Array).set(new Float64Array(aligned.buffer, aligned.byteOffset, count), position);
				} else if (type === 'FLOAT') {
					(target as Float32Array).set(new Float32Array(aligned.buffer, aligned.byteOffset, count), position);
				} else {
					(target as Int32Array).set(new Int32Array(aligned.buffer, aligned.byteOffset, count), position);
				}
				filled.set(name, position + count);
				remaining -= count;
			}
		}
	}
	return out;
}

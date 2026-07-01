// @ts-check
"use strict";

import pako from 'pako';

/**
 * Shared helpers for the TIFF tag/metadata dump surfaced in the Metadata panel.
 *
 * The Rust/WASM decoder (default path) walks the raw IFD generically and
 * returns every tag it finds — including Exif/GPS sub-IFD tags — as a JSON
 * string via `TiffResult.all_tags_json`. `parseAllTagsJson` just parses that.
 *
 * The geotiff.js fallback path (used when the Rust decoder rejects a TIFF
 * variant) doesn't expose an equivalent raw-tag walk, so `buildTagsFromGeotiffImage`
 * enumerates whatever geotiff.js already parsed into `image.fileDirectory` /
 * `image.geoKeys` generically — no curated tag list on this path either.
 */

/** @typedef {{tag: number|null, name: string, group: string, value: string}} TagEntry */

/**
 * @param {string|undefined|null} json
 * @returns {TagEntry[]}
 */
export function parseAllTagsJson(json) {
	if (!json) { return []; }
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * @param {any} value
 * @returns {string}
 */
function stringifyTagValue(value) {
	if (value === null || value === undefined) { return ''; }
	if (Array.isArray(value) || ArrayBuffer.isView(value)) {
		return Array.from(/** @type {ArrayLike<any>} */ (value)).join(', ');
	}
	if (typeof value === 'object') {
		try { return JSON.stringify(value); } catch { return String(value); }
	}
	return String(value);
}

/**
 * Enumerate every tag geotiff.js has already parsed for an image, generically
 * (no curated subset) — used only on the geotiff.js compatibility fallback
 * path, since the Rust/WASM decoder path has its own raw-IFD walk.
 * @param {any} image - geotiff.js GeoTIFFImage instance
 * @returns {TagEntry[]}
 */
export function buildTagsFromGeotiffImage(image) {
	/** @type {TagEntry[]} */
	const out = [];
	const fileDirectory = image?.fileDirectory || {};
	for (const [name, rawValue] of Object.entries(fileDirectory)) {
		out.push({ tag: null, name, group: 'TIFF', value: stringifyTagValue(rawValue) });
	}
	// geotiff.js resolves the GeoKeyDirectory into a plain object when present.
	let geoKeys = null;
	try { geoKeys = typeof image?.getGeoKeys === 'function' ? image.getGeoKeys() : image?.geoKeys; } catch { /* not a GeoTIFF */ }
	if (geoKeys && typeof geoKeys === 'object') {
		for (const [name, rawValue] of Object.entries(geoKeys)) {
			out.push({ tag: null, name, group: 'GeoKeys', value: stringifyTagValue(rawValue) });
		}
	}
	return out;
}

/**
 * Flatten an arbitrary nested metadata object (e.g. libraw-wasm's `Metadata`)
 * into {tag,name,group,value} rows, generically — nested plain objects
 * become dotted name prefixes (e.g. "lens.MinFocal"), so every field the
 * decoder returns is included, however deeply nested, without a curated list
 * of known fields. Binary sample blobs (e.g. an embedded ICC profile) are
 * skipped since they aren't meaningful as text.
 * @param {any} obj
 * @param {string} group
 * @returns {TagEntry[]}
 */
export function flattenObjectToTags(obj, group) {
	/** @type {TagEntry[]} */
	const out = [];

	/** @param {string} prefix @param {any} value */
	function walk(prefix, value) {
		if (value === null || value === undefined) { return; }
		if (value instanceof Date) {
			out.push({ tag: null, name: prefix, group, value: value.toISOString() });
			return;
		}
		if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
			const typedArray = /** @type {Uint8Array} */ (/** @type {unknown} */ (value));
			if (typedArray.length > 64) { return; } // binary blob, not useful as text
			out.push({ tag: null, name: prefix, group, value: stringifyTagValue(typedArray) });
			return;
		}
		if (Array.isArray(value)) {
			out.push({ tag: null, name: prefix, group, value: stringifyTagValue(value) });
			return;
		}
		if (typeof value === 'object') {
			for (const [key, v] of Object.entries(value)) {
				walk(prefix ? `${prefix}.${key}` : key, v);
			}
			return;
		}
		out.push({ tag: null, name: prefix, group, value: String(value) });
	}

	walk('', obj);
	return out;
}

/**
 * Locate a JPEG's embedded Exif blob (the APP1 segment's payload, minus its
 * "Exif\0\0" prefix) by scanning markers linearly. Returns the raw TIFF-
 * structured bytes ready for the WASM decoder's generic tag walker, or null
 * if the file isn't a JPEG or carries no Exif APP1 segment.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array|null}
 */
export function findJpegExifBlob(bytes) {
	if (!(bytes instanceof Uint8Array) || bytes.length < 4) { return null; }
	if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) { return null; } // not a JPEG (no SOI)

	let offset = 2;
	while (offset + 4 <= bytes.length) {
		if (bytes[offset] !== 0xFF) { break; } // not a marker — malformed, stop scanning
		const marker = bytes[offset + 1];
		offset += 2;
		// Markers with no payload: TEM (0x01) and RST0-7 (0xD0-0xD7).
		if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { continue; }
		if (marker === 0xD9) { break; } // EOI
		if (marker === 0xDA) { break; } // SOS — entropy-coded data follows, no more markers to scan
		if (offset + 2 > bytes.length) { break; }
		const segmentLength = (bytes[offset] << 8) | bytes[offset + 1]; // includes these 2 length bytes
		const payloadStart = offset + 2;
		const payloadEnd = offset + segmentLength;
		if (segmentLength < 2 || payloadEnd > bytes.length) { break; }

		if (marker === 0xE1 && payloadEnd - payloadStart >= 6) { // APP1
			const sig = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
			let matches = true;
			for (let i = 0; i < 6; i++) {
				if (bytes[payloadStart + i] !== sig[i]) { matches = false; break; }
			}
			if (matches) {
				return bytes.subarray(payloadStart + 6, payloadEnd);
			}
		}
		offset = payloadEnd;
	}
	return null;
}

/** @param {Uint8Array} bytes */
function latin1Decode(bytes) {
	let s = '';
	for (let i = 0; i < bytes.length; i++) { s += String.fromCharCode(bytes[i]); }
	return s;
}

/**
 * @typedef {Object} PngChunkMetadata
 * @property {Uint8Array|null} exifBlob - raw TIFF-structured bytes from the eXIf chunk, if present
 * @property {{name:string,value:string}[]} textEntries - tEXt/zTXt/iTXt keyword+text pairs
 */

/**
 * Scan a PNG byte stream's chunks for the eXIf chunk (a raw Exif/TIFF blob,
 * no "Exif\0\0" prefix — unlike JPEG's APP1) and any tEXt/zTXt/iTXt text
 * chunks (PNG's own native key/value metadata), decompressing zTXt/iTXt
 * payloads with pako where needed. Malformed/unsupported individual chunks
 * are skipped rather than aborting the whole scan.
 * @param {Uint8Array} bytes
 * @returns {PngChunkMetadata}
 */
export function parsePngChunks(bytes) {
	/** @type {PngChunkMetadata} */
	const result = { exifBlob: null, textEntries: [] };
	const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
	if (!(bytes instanceof Uint8Array) || bytes.length < 8) { return result; }
	for (let i = 0; i < 8; i++) {
		if (bytes[i] !== sig[i]) { return result; }
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 8;
	while (offset + 12 <= bytes.length) {
		const length = view.getUint32(offset, false);
		const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;
		if (dataEnd + 4 > bytes.length) { break; }
		const chunk = bytes.subarray(dataStart, dataEnd);

		try {
			if (type === 'eXIf') {
				result.exifBlob = chunk;
			} else if (type === 'tEXt') {
				const nullIdx = chunk.indexOf(0);
				if (nullIdx >= 0) {
					result.textEntries.push({
						name: latin1Decode(chunk.subarray(0, nullIdx)),
						value: latin1Decode(chunk.subarray(nullIdx + 1))
					});
				}
			} else if (type === 'zTXt') {
				const nullIdx = chunk.indexOf(0);
				if (nullIdx >= 0) {
					const keyword = latin1Decode(chunk.subarray(0, nullIdx));
					const compressed = chunk.subarray(nullIdx + 2); // skip null + 1-byte compression method
					const text = new TextDecoder('utf-8').decode(pako.inflate(compressed));
					result.textEntries.push({ name: keyword, value: text });
				}
			} else if (type === 'iTXt') {
				let p = chunk.indexOf(0);
				const keyword = latin1Decode(chunk.subarray(0, p));
				const compressionFlag = chunk[p + 1];
				p += 3; // null + compression flag + compression method
				const langEnd = chunk.indexOf(0, p);
				p = langEnd + 1;
				const translatedEnd = chunk.indexOf(0, p);
				p = translatedEnd + 1;
				const textBytes = chunk.subarray(p);
				const text = compressionFlag === 1
					? new TextDecoder('utf-8').decode(pako.inflate(textBytes))
					: new TextDecoder('utf-8').decode(textBytes);
				result.textEntries.push({ name: keyword, value: text });
			} else if (type === 'IEND') {
				break;
			}
		} catch {
			// Skip malformed/unsupported individual chunk, keep scanning.
		}

		offset = dataEnd + 4; // skip CRC
	}
	return result;
}

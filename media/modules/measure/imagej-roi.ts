"use strict";

import pako from 'pako';
import { simplifyPolyline } from './geometry.js';
import { isAreaKind, type LineRoi, type PointRoi, type PolygonRoi, type Roi } from './types.js';

/**
 * ImageJ `.roi` and `RoiSet.zip` interop.
 *
 * Import is the adoption path — people arrive with ROI sets they already
 * measured against — and export is the escape hatch that makes trying this
 * viewer risk-free. Both matter more than any feature we could add on top of
 * our own JSON sidecar, because neither requires the user to commit to us.
 *
 * The binary layout is ImageJ's `RoiDecoder`/`RoiEncoder`: a 64-byte
 * big-endian header, coordinates as int16 offsets from the bounding box, and an
 * optional second header carrying the name, stroke width, and stack position.
 * Everything here is written against that layout; fields we do not model are
 * preserved as zero, which ImageJ reads back as "unset".
 */

const HEADER_SIZE = 64;
const HEADER2_SIZE = 64;
const MAGIC = 0x496f7574; // "Iout"

/** ImageJ ROI type codes. */
const TYPE_POLYGON = 0;
const TYPE_RECT = 1;
const TYPE_OVAL = 2;
const TYPE_LINE = 3;
const TYPE_FREELINE = 4;
const TYPE_POLYLINE = 5;
const TYPE_NO_ROI = 6;
const TYPE_FREEHAND = 7;
const TYPE_TRACED = 8;
const TYPE_ANGLE = 9;
const TYPE_POINT = 10;

const OPTION_SUB_PIXEL_RESOLUTION = 128;

export interface ImageJRoiImport {
	roi: Roi;
	/** Warnings that do not prevent import, surfaced in the panel. */
	notes: string[];
}

/**
 * Decode a single `.roi` file.
 *
 * Returns null for the handful of ROI types that have no counterpart here
 * (angle tools, shape ROIs built from Java `Shape` objects) rather than
 * inventing an approximation the user would then measure by mistake.
 */
export function decodeImageJRoi(bytes: Uint8Array, fallbackName = 'ROI'): ImageJRoiImport | null {
	if (bytes.length < HEADER_SIZE) { return null; }
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(0, false) !== MAGIC) { return null; }

	const notes: string[] = [];
	const version = view.getUint16(4, false);
	const type = view.getUint8(6);
	const top = view.getInt16(8, false);
	const left = view.getInt16(10, false);
	const bottom = view.getInt16(12, false);
	const right = view.getInt16(14, false);
	let coordinateCount = view.getUint16(16, false);
	const options = view.getUint16(50, false);
	const position = view.getInt32(56, false);
	const header2Offset = view.getInt32(60, false);

	const subPixel = (options & OPTION_SUB_PIXEL_RESOLUTION) !== 0;

	let name = fallbackName;
	if (header2Offset > 0 && header2Offset + HEADER2_SIZE <= bytes.length) {
		const nameOffset = view.getInt32(header2Offset + 16, false);
		const nameLength = view.getInt32(header2Offset + 20, false);
		if (nameOffset > 0 && nameLength > 0 && nameOffset + nameLength * 2 <= bytes.length) {
			// ImageJ stores names as UTF-16 code units, big-endian.
			let decoded = '';
			for (let i = 0; i < nameLength; i++) {
				decoded += String.fromCharCode(view.getUint16(nameOffset + i * 2, false));
			}
			if (decoded) { name = decoded; }
		}
	}

	const common = {
		id: newId(),
		name,
		source: 'imagej' as const,
		page: position > 0 ? position - 1 : undefined,
	};

	const width = right - left;
	const height = bottom - top;

	switch (type) {
		case TYPE_RECT:
			return { roi: { ...common, kind: 'rect', x: left, y: top, width, height }, notes };

		case TYPE_OVAL:
			return { roi: { ...common, kind: 'ellipse', x: left, y: top, width, height }, notes };

		case TYPE_LINE: {
			const x1 = view.getFloat32(18, false);
			const y1 = view.getFloat32(22, false);
			const x2 = view.getFloat32(26, false);
			const y2 = view.getFloat32(30, false);
			const strokeWidth = view.getUint16(34, false);
			return {
				roi: { ...common, kind: 'line', points: [x1, y1, x2, y2], lineWidth: strokeWidth || 1 },
				notes,
			};
		}

		case TYPE_POLYGON:
		case TYPE_FREEHAND:
		case TYPE_TRACED:
		case TYPE_POLYLINE:
		case TYPE_FREELINE:
		case TYPE_POINT: {
			if (coordinateCount <= 0) { return null; }
			const needed = HEADER_SIZE + coordinateCount * 4;
			if (needed > bytes.length) {
				// Truncated file: keep whatever coordinates are actually present
				// rather than dropping the ROI entirely.
				coordinateCount = Math.floor((bytes.length - HEADER_SIZE) / 4);
				notes.push('Coordinate list was truncated; imported the readable part.');
				if (coordinateCount < 2) { return null; }
			}

			const points: number[] = [];
			if (subPixel && HEADER_SIZE + coordinateCount * 4 + coordinateCount * 8 <= bytes.length) {
				// Sub-pixel ROIs carry float coordinates after the integer ones.
				const floatBase = HEADER_SIZE + coordinateCount * 4;
				for (let i = 0; i < coordinateCount; i++) {
					points.push(
						view.getFloat32(floatBase + i * 4, false),
						view.getFloat32(floatBase + coordinateCount * 4 + i * 4, false),
					);
				}
			} else {
				for (let i = 0; i < coordinateCount; i++) {
					points.push(
						left + view.getInt16(HEADER_SIZE + i * 2, false),
						top + view.getInt16(HEADER_SIZE + coordinateCount * 2 + i * 2, false),
					);
				}
			}

			if (type === TYPE_POINT) {
				return { roi: { ...common, kind: 'point', points }, notes };
			}
			if (type === TYPE_POLYLINE || type === TYPE_FREELINE) {
				return { roi: { ...common, kind: 'polyline', points, lineWidth: view.getUint16(34, false) || 1 }, notes };
			}
			return {
				roi: {
					...common,
					kind: type === TYPE_POLYGON ? 'polygon' : 'freehand',
					points,
				},
				notes,
			};
		}

		case TYPE_ANGLE:
			// An angle ROI measures three points, which has no equivalent here and
			// would silently become a meaningless polyline length.
			return null;

		case TYPE_NO_ROI:
		default:
			if (version > 300) { notes.push(`Unsupported ImageJ ROI type ${type}.`); }
			return null;
	}
}

/**
 * Encode an ROI as ImageJ `.roi` bytes.
 *
 * Mask ROIs have no ImageJ counterpart that preserves holes, so they are
 * exported as their traced outline — lossy, and the caller is expected to say
 * so. Everything else round-trips exactly.
 */
export function encodeImageJRoi(roi: Roi, outlineForMask?: number[]): Uint8Array | null {
	let type: number;
	let points: number[] | null = null;
	let bounds = { left: 0, top: 0, right: 0, bottom: 0 };
	let lineEndpoints: [number, number, number, number] | null = null;

	switch (roi.kind) {
		case 'rect':
			type = TYPE_RECT;
			bounds = {
				left: Math.round(roi.x), top: Math.round(roi.y),
				right: Math.round(roi.x + roi.width), bottom: Math.round(roi.y + roi.height),
			};
			break;
		case 'ellipse':
			type = TYPE_OVAL;
			bounds = {
				left: Math.round(roi.x), top: Math.round(roi.y),
				right: Math.round(roi.x + roi.width), bottom: Math.round(roi.y + roi.height),
			};
			break;
		case 'line': {
			type = TYPE_LINE;
			const p = (roi as LineRoi).points;
			if (!p || p.length < 4) { return null; }
			lineEndpoints = [p[0], p[1], p[2], p[3]];
			bounds = {
				left: Math.floor(Math.min(p[0], p[2])), top: Math.floor(Math.min(p[1], p[3])),
				right: Math.ceil(Math.max(p[0], p[2])), bottom: Math.ceil(Math.max(p[1], p[3])),
			};
			break;
		}
		case 'polygon': type = TYPE_POLYGON; points = (roi as PolygonRoi).points; break;
		case 'freehand': type = TYPE_FREEHAND; points = (roi as PolygonRoi).points; break;
		case 'polyline': type = TYPE_POLYLINE; points = (roi as LineRoi).points; break;
		case 'point': type = TYPE_POINT; points = (roi as PointRoi).points; break;
		case 'mask':
			type = TYPE_TRACED;
			points = outlineForMask || null;
			if (!points || points.length < 6) { return null; }
			break;
		default:
			return null;
	}

	if (points) {
		if (points.length < 4) { return null; }
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (let i = 0; i + 1 < points.length; i += 2) {
			minX = Math.min(minX, points[i]);
			maxX = Math.max(maxX, points[i]);
			minY = Math.min(minY, points[i + 1]);
			maxY = Math.max(maxY, points[i + 1]);
		}
		bounds = {
			left: Math.floor(minX), top: Math.floor(minY),
			right: Math.ceil(maxX), bottom: Math.ceil(maxY),
		};
	}

	const coordinateCount = points ? Math.floor(points.length / 2) : 0;
	// int16 coordinates plus float32 duplicates, so ImageJ reads sub-pixel
	// positions back at full precision instead of snapping our geometry.
	const coordinateBytes = points ? coordinateCount * 4 + coordinateCount * 8 : 0;
	const nameChars = roi.name ? Array.from(roi.name).slice(0, 512) : [];
	const header2Offset = HEADER_SIZE + coordinateBytes;
	const nameOffset = header2Offset + HEADER2_SIZE;
	const totalSize = nameOffset + nameChars.length * 2;

	const bytes = new Uint8Array(totalSize);
	const view = new DataView(bytes.buffer);

	view.setUint32(0, MAGIC, false);
	view.setUint16(4, 228, false);
	view.setUint8(6, type);
	view.setInt16(8, clampInt16(bounds.top), false);
	view.setInt16(10, clampInt16(bounds.left), false);
	view.setInt16(12, clampInt16(bounds.bottom), false);
	view.setInt16(14, clampInt16(bounds.right), false);
	view.setUint16(16, coordinateCount, false);

	if (lineEndpoints) {
		view.setFloat32(18, lineEndpoints[0], false);
		view.setFloat32(22, lineEndpoints[1], false);
		view.setFloat32(26, lineEndpoints[2], false);
		view.setFloat32(30, lineEndpoints[3], false);
	}

	const strokeWidth = (roi as { lineWidth?: number }).lineWidth || 0;
	view.setUint16(34, Math.min(255, Math.max(0, Math.round(strokeWidth))), false);
	view.setUint16(50, points ? OPTION_SUB_PIXEL_RESOLUTION : 0, false);
	view.setInt32(56, (roi.page !== undefined ? roi.page + 1 : 0), false);
	view.setInt32(60, header2Offset, false);

	if (points) {
		for (let i = 0; i < coordinateCount; i++) {
			view.setInt16(HEADER_SIZE + i * 2, clampInt16(Math.round(points[i * 2] - bounds.left)), false);
			view.setInt16(HEADER_SIZE + coordinateCount * 2 + i * 2, clampInt16(Math.round(points[i * 2 + 1] - bounds.top)), false);
		}
		const floatBase = HEADER_SIZE + coordinateCount * 4;
		for (let i = 0; i < coordinateCount; i++) {
			view.setFloat32(floatBase + i * 4, points[i * 2], false);
			view.setFloat32(floatBase + coordinateCount * 4 + i * 4, points[i * 2 + 1], false);
		}
	}

	if (nameChars.length > 0) {
		view.setInt32(header2Offset + 16, nameOffset, false);
		view.setInt32(header2Offset + 20, nameChars.length, false);
		for (let i = 0; i < nameChars.length; i++) {
			view.setUint16(nameOffset + i * 2, nameChars[i].charCodeAt(0), false);
		}
	}

	return bytes;
}

// ---------------------------------------------------------------------------
// RoiSet.zip container
// ---------------------------------------------------------------------------

interface ZipEntry {
	name: string;
	bytes: Uint8Array;
}

/**
 * Read the entries of a ROI set archive.
 *
 * A minimal ZIP reader rather than a dependency: ImageJ writes plain stored or
 * deflated entries with no encryption, no ZIP64, and no data descriptors, so
 * the central directory alone is enough. pako handles the inflate.
 */
export function readRoiZip(bytes: Uint8Array): ZipEntry[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	// Locate the end-of-central-directory record by scanning backwards; the
	// comment field means it is not at a fixed offset.
	let eocd = -1;
	for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 65536; i--) {
		if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
	}
	if (eocd < 0) { return []; }

	const entryCount = view.getUint16(eocd + 10, true);
	let pointer = view.getUint32(eocd + 16, true);
	const entries: ZipEntry[] = [];

	for (let i = 0; i < entryCount; i++) {
		if (pointer + 46 > bytes.length || view.getUint32(pointer, true) !== 0x02014b50) { break; }
		const method = view.getUint16(pointer + 10, true);
		const compressedSize = view.getUint32(pointer + 20, true);
		const nameLength = view.getUint16(pointer + 28, true);
		const extraLength = view.getUint16(pointer + 30, true);
		const commentLength = view.getUint16(pointer + 32, true);
		const localOffset = view.getUint32(pointer + 42, true);
		const name = new TextDecoder().decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));

		if (localOffset + 30 <= bytes.length && view.getUint32(localOffset, true) === 0x04034b50) {
			const localNameLength = view.getUint16(localOffset + 26, true);
			const localExtraLength = view.getUint16(localOffset + 28, true);
			const dataStart = localOffset + 30 + localNameLength + localExtraLength;
			const raw = bytes.subarray(dataStart, dataStart + compressedSize);
			try {
				const content = method === 0 ? raw.slice() : pako.inflateRaw(raw);
				entries.push({ name, bytes: content });
			} catch {
				// A single unreadable member must not lose the rest of the set.
			}
		}

		pointer += 46 + nameLength + extraLength + commentLength;
	}

	return entries;
}

/** Write a ROI set archive that ImageJ's "Open" accepts. */
export function writeRoiZip(entries: ZipEntry[]): Uint8Array {
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBytes = new TextEncoder().encode(entry.name);
		const compressed = pako.deflateRaw(entry.bytes);
		const crc = crc32(entry.bytes);

		const local = new Uint8Array(30 + nameBytes.length + compressed.length);
		const localView = new DataView(local.buffer);
		localView.setUint32(0, 0x04034b50, true);
		localView.setUint16(4, 20, true);
		localView.setUint16(6, 0, true);
		localView.setUint16(8, 8, true); // deflate
		localView.setUint16(10, 0, true);
		localView.setUint16(12, 0, true);
		localView.setUint32(14, crc, true);
		localView.setUint32(18, compressed.length, true);
		localView.setUint32(22, entry.bytes.length, true);
		localView.setUint16(26, nameBytes.length, true);
		localView.setUint16(28, 0, true);
		local.set(nameBytes, 30);
		local.set(compressed, 30 + nameBytes.length);
		locals.push(local);

		const central = new Uint8Array(46 + nameBytes.length);
		const centralView = new DataView(central.buffer);
		centralView.setUint32(0, 0x02014b50, true);
		centralView.setUint16(4, 20, true);
		centralView.setUint16(6, 20, true);
		centralView.setUint16(8, 0, true);
		centralView.setUint16(10, 8, true);
		centralView.setUint32(16, crc, true);
		centralView.setUint32(20, compressed.length, true);
		centralView.setUint32(24, entry.bytes.length, true);
		centralView.setUint16(28, nameBytes.length, true);
		centralView.setUint32(42, offset, true);
		central.set(nameBytes, 46);
		centrals.push(central);

		offset += local.length;
	}

	const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
	const eocd = new Uint8Array(22);
	const eocdView = new DataView(eocd.buffer);
	eocdView.setUint32(0, 0x06054b50, true);
	eocdView.setUint16(8, entries.length, true);
	eocdView.setUint16(10, entries.length, true);
	eocdView.setUint32(12, centralSize, true);
	eocdView.setUint32(16, offset, true);

	const totalSize = offset + centralSize + eocd.length;
	const out = new Uint8Array(totalSize);
	let cursor = 0;
	for (const local of locals) { out.set(local, cursor); cursor += local.length; }
	for (const central of centrals) { out.set(central, cursor); cursor += central.length; }
	out.set(eocd, cursor);
	return out;
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let i = 0; i < 256; i++) {
			let value = i;
			for (let k = 0; k < 8; k++) {
				value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
			}
			crcTable[i] = value >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** Import every ROI from a `.roi` file or a `RoiSet.zip`. */
export function importImageJRois(bytes: Uint8Array, fileName: string): ImageJRoiImport[] {
	// A ZIP always starts with "PK\x03\x04"; a .roi always starts with "Iout".
	const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
	if (!isZip) {
		const single = decodeImageJRoi(bytes, stripExtension(fileName));
		return single ? [single] : [];
	}

	const results: ImageJRoiImport[] = [];
	for (const entry of readRoiZip(bytes)) {
		const decoded = decodeImageJRoi(entry.bytes, stripExtension(entry.name));
		if (decoded) { results.push(decoded); }
	}
	return results;
}

/** Export ROIs as a `RoiSet.zip` payload. */
export function exportImageJRois(
	rois: Roi[],
	outlineProvider: (roi: Roi) => number[],
): { bytes: Uint8Array; exported: number; skipped: string[] } {
	const entries: ZipEntry[] = [];
	const skipped: string[] = [];
	const usedNames = new Set<string>();

	for (const roi of rois) {
		// Mask ROIs lose their holes on the way out; simplifying the traced
		// outline first keeps the file from ballooning to one vertex per
		// boundary pixel.
		const outline = roi.kind === 'mask'
			? simplifyPolyline(outlineProvider(roi), 0.5)
			: undefined;
		const encoded = encodeImageJRoi(roi, outline);
		if (!encoded) { skipped.push(roi.name); continue; }

		let name = `${sanitizeName(roi.name)}.roi`;
		let suffix = 2;
		while (usedNames.has(name)) { name = `${sanitizeName(roi.name)}-${suffix++}.roi`; }
		usedNames.add(name);
		entries.push({ name, bytes: encoded });
	}

	return { bytes: writeRoiZip(entries), exported: entries.length, skipped };
}

function sanitizeName(name: string): string {
	return (name || 'roi').replace(/[^\w.\- ]+/g, '_').slice(0, 100) || 'roi';
}

function stripExtension(name: string): string {
	const base = name.split('/').pop() || name;
	return base.replace(/\.roi$/i, '');
}

function clampInt16(value: number): number {
	return Math.max(-32768, Math.min(32767, Math.round(value)));
}

let idCounter = 0;
function newId(): string {
	idCounter++;
	return `roi-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/** True when an ROI survives a round trip through the ImageJ format intact. */
export function isLosslessForImageJ(roi: Roi): boolean {
	if (roi.kind === 'mask') { return false; }
	if (isAreaKind(roi.kind) && (roi as { angle?: number }).angle) { return false; }
	return true;
}

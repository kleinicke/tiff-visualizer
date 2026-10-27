"use strict";

/**
 * Reading the pyramid of an OME-TIFF that stores its levels as SubIFDs.
 *
 * Pyramidal OME-TIFF (the 10x Xenium morphology images, bioformats2raw output,
 * tifffile's `subifds=`) hangs each reduced-resolution level off the full
 * resolution page through tag 330 instead of chaining it in the main IFD list.
 * The Rust page classifier counts those levels (`subIfdCount`) but cannot yet
 * select them, so a decoder opened on such a file sees one image.
 *
 * This module is the bridge until `crates/image-decoders/.../pages.rs` reads
 * tag 330 itself: it walks only the first directory, and on an IN-MEMORY COPY
 * of the file points that directory's "next IFD" field at the first SubIFD (and
 * each SubIFD at the next). The decoder then sees an ordinary chain whose later
 * entries carry NewSubfileType = reduced-resolution, which it already
 * classifies as overviews. No pixel data and no file on disk is touched.
 *
 * Deliberately narrow: only a file whose main chain holds a single directory
 * is rewritten. A multi-page file with per-page SubIFDs needs the real fix.
 */

export interface TiffRootInfo {
	/** Offsets of the SubIFDs of the first directory, finest first as stored. */
	subIfdOffsets: number[];
	/** ImageDescription (tag 270) of the first directory, when present. */
	description?: string;
	/** Whether the main IFD chain holds more than one directory. */
	hasFurtherPages: boolean;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 6: 1, 7: 1, 8: 2, 9: 4, 13: 4, 16: 8, 17: 8, 18: 8 };
const TAG_DESCRIPTION = 270;
const TAG_SUBIFDS = 330;
/** More levels than this is a corrupt file, not a pyramid. */
const MAX_SUBIFDS = 64;

interface Layout {
	view: DataView;
	little: boolean;
	big: boolean;
	first: number;
}

function layoutOf(bytes: Uint8Array): Layout | null {
	if (bytes.byteLength < 16) { return null; }
	const little = bytes[0] === 0x49 && bytes[1] === 0x49;
	if (!little && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) { return null; }
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const magic = view.getUint16(2, little);
	if (magic === 42) { return { view, little, big: false, first: view.getUint32(4, little) }; }
	if (magic === 43 && view.getUint16(4, little) === 8) {
		const first = Number(view.getBigUint64(8, little));
		return Number.isSafeInteger(first) ? { view, little, big: true, first } : null;
	}
	return null;
}

function readOffset(layout: Layout, position: number): number | null {
	const width = layout.big ? 8 : 4;
	if (position < 0 || position + width > layout.view.byteLength) { return null; }
	const value = layout.big ? Number(layout.view.getBigUint64(position, layout.little)) : layout.view.getUint32(position, layout.little);
	return Number.isSafeInteger(value) ? value : null;
}

function writeOffset(layout: Layout, position: number, value: number): void {
	if (layout.big) { layout.view.setBigUint64(position, BigInt(value), layout.little); }
	else { layout.view.setUint32(position, value, layout.little); }
}

/** Directory geometry: where the entries start, and where its "next IFD" field sits. */
function directory(layout: Layout, offset: number): { entries: number; entriesAt: number; nextAt: number } | null {
	const countWidth = layout.big ? 8 : 2;
	const entrySize = layout.big ? 20 : 12;
	if (offset <= 0 || offset + countWidth > layout.view.byteLength) { return null; }
	const entries = layout.big ? Number(layout.view.getBigUint64(offset, layout.little)) : layout.view.getUint16(offset, layout.little);
	const nextAt = offset + countWidth + entries * entrySize;
	if (!Number.isSafeInteger(nextAt) || nextAt + (layout.big ? 8 : 4) > layout.view.byteLength) { return null; }
	return { entries, entriesAt: offset + countWidth, nextAt };
}

/** The first directory's SubIFD offsets and description, or null if `bytes` is not a TIFF. */
export function inspectTiffRoot(bytes: Uint8Array): TiffRootInfo | null {
	const layout = layoutOf(bytes);
	if (!layout) { return null; }
	const root = directory(layout, layout.first);
	if (!root) { return null; }
	const entrySize = layout.big ? 20 : 12;
	const inlineSize = layout.big ? 8 : 4;
	const valueOffset = layout.big ? 12 : 8;
	const info: TiffRootInfo = { subIfdOffsets: [], hasFurtherPages: (readOffset(layout, root.nextAt) ?? 0) !== 0 };

	for (let index = 0; index < root.entries; index++) {
		const entry = root.entriesAt + index * entrySize;
		const tag = layout.view.getUint16(entry, layout.little);
		if (tag !== TAG_SUBIFDS && tag !== TAG_DESCRIPTION) { continue; }
		const type = layout.view.getUint16(entry + 2, layout.little);
		const count = layout.big ? Number(layout.view.getBigUint64(entry + 4, layout.little)) : layout.view.getUint32(entry + 4, layout.little);
		const size = TYPE_SIZE[type];
		if (!size || !Number.isSafeInteger(count) || count < 1) { continue; }
		const total = size * count;
		const at = total <= inlineSize ? entry + valueOffset : readOffset(layout, entry + valueOffset);
		if (at === null || at < 0 || at + total > bytes.byteLength) { continue; }
		if (tag === TAG_DESCRIPTION && type === 2) {
			info.description = new TextDecoder('utf-8').decode(bytes.subarray(at, at + total)).replace(/\0+$/g, '');
		} else if (tag === TAG_SUBIFDS && count <= MAX_SUBIFDS && (size === 4 || size === 8)) {
			for (let k = 0; k < count; k++) {
				const value = size === 8
					? Number(layout.view.getBigUint64(at + k * 8, layout.little))
					: layout.view.getUint32(at + k * 4, layout.little);
				if (Number.isSafeInteger(value) && value > 0) { info.subIfdOffsets.push(value); }
			}
		}
	}
	return info;
}

/**
 * Link the SubIFDs of a single-directory TIFF into its main IFD chain, in place.
 * Returns how many levels were linked (0 when the file needed or allowed none).
 */
export function chainSubIfds(bytes: Uint8Array): number {
	const layout = layoutOf(bytes);
	const info = inspectTiffRoot(bytes);
	if (!layout || !info || info.hasFurtherPages || info.subIfdOffsets.length === 0) { return 0; }
	const offsets = info.subIfdOffsets;
	if (new Set(offsets).size !== offsets.length || offsets.includes(layout.first)) { return 0; }

	const subs = offsets.map(offset => directory(layout, offset));
	if (subs.some(sub => sub === null)) { return 0; }
	const root = directory(layout, layout.first)!;

	writeOffset(layout, root.nextAt, offsets[0]);
	for (let index = 0; index < offsets.length; index++) {
		writeOffset(layout, subs[index]!.nextAt, index + 1 < offsets.length ? offsets[index + 1] : 0);
	}
	return offsets.length;
}

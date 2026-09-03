"use strict";

/**
 * What a TIFF's images ARE, as opposed to how many there are.
 *
 * The Rust decoder classifies the IFD chain (see
 * `crates/image-decoders/src/formats/tiff/pages.rs`, which is where the
 * NewSubfileType reading lives and the only place it should live). This module
 * is the consumer side: parse that JSON, and answer the two questions the UI
 * asks of it — "is this a pyramid or a stack of pages?" and "which entry do I
 * decode for a given zoom?".
 *
 * The distinction matters because a pyramid's later images are the SAME data,
 * downsampled. Anything that reports values — pixel inspection, statistics,
 * measurement, export — must read the full-resolution page, never a level that
 * was chosen for display speed.
 */

export type TiffPageKind = 'image' | 'overview' | 'mask';

export interface TiffPageEntry {
	/** Index in the IFD chain — what `decode_tiff_page` takes. */
	index: number;
	width: number;
	height: number;
	samplesPerPixel: number;
	subfileType: number;
	kind: TiffPageKind;
	/** For an overview or mask, the page it belongs to. */
	parent: number | null;
	/** Linear downsample factor against the parent (2 = half size). */
	reduction: number;
	/** Overviews hung off tag 330, counted but not yet selectable. */
	subIfdCount: number;
}

export function parsePageDirectory(json: string | undefined | null): TiffPageEntry[] {
	if (!json) { return []; }
	let parsed: unknown;
	try { parsed = JSON.parse(json); } catch { return []; }
	if (!Array.isArray(parsed)) { return []; }
	return parsed
		.filter((entry): entry is Record<string, any> => !!entry && typeof entry === 'object')
		.map(entry => ({
			index: Number(entry.index) || 0,
			width: Number(entry.width) || 0,
			height: Number(entry.height) || 0,
			samplesPerPixel: Number(entry.samplesPerPixel) || 1,
			subfileType: Number(entry.subfileType) || 0,
			kind: (entry.kind === 'overview' || entry.kind === 'mask') ? entry.kind : 'image',
			parent: entry.parent === null || entry.parent === undefined ? null : Number(entry.parent),
			reduction: Math.max(1, Number(entry.reduction) || 1),
			subIfdCount: Number(entry.subIfdCount) || 0,
		}));
}

/** The entries that are pages in their own right, in chain order. */
export function imagePages(directory: TiffPageEntry[]): TiffPageEntry[] {
	return Array.isArray(directory) ? directory.filter(entry => entry.kind === 'image') : [];
}

/**
 * The resolution levels available for one page: the page itself first, then
 * its overviews largest-first. A file with no overviews yields just the page,
 * which lets callers treat "no pyramid" as the one-level case rather than a
 * separate branch.
 */
export function levelsForPage(directory: TiffPageEntry[], pageIndex: number): TiffPageEntry[] {
	if (!Array.isArray(directory)) { return []; }
	const page = directory.find(entry => entry.index === pageIndex && entry.kind === 'image');
	if (!page) { return []; }
	const overviews = directory
		.filter(entry => entry.kind === 'overview' && entry.parent === page.index)
		.sort((a, b) => b.width - a.width);
	return [page, ...overviews];
}

/**
 * The page an IFD belongs to: itself when it is a page, its parent when it is
 * an overview or a mask. Lets the UI answer "which image am I looking at?"
 * without caring which level is currently decoded.
 */
export function pageOwningIfd(directory: TiffPageEntry[], ifdIndex: number): number {
	if (!Array.isArray(directory)) { return ifdIndex; }
	const entry = directory.find(item => item.index === ifdIndex);
	if (!entry) { return ifdIndex; }
	return entry.kind === 'image' ? entry.index : (entry.parent ?? entry.index);
}

/** Whether this file stores any page at more than one resolution. */
export function isPyramidal(directory: TiffPageEntry[]): boolean {
	// Callers reach for this on a processor that may not have opened a TIFF at
	// all, so an absent directory is a legitimate "no", not a programming error.
	return Array.isArray(directory) && directory.some(entry => entry.kind === 'overview');
}

/**
 * Pick the smallest level whose pixels still cover `displayWidth` on screen.
 *
 * Decoding a level below the display size would show interpolated pixels the
 * file did not contain, so the rule is one-directional: never choose a level
 * coarser than what is being displayed. `oversample` guards the boundary —
 * at 1.0 a window one pixel wider than a level forces the level above it,
 * which thrashes on a slow drag.
 *
 * Returns the full-resolution page when nothing smaller qualifies, and null
 * when the page is not in the directory at all.
 */
export function levelForDisplayWidth(
	directory: TiffPageEntry[],
	pageIndex: number,
	displayWidth: number,
	oversample = 1.0,
): TiffPageEntry | null {
	const levels = levelsForPage(directory, pageIndex);
	if (levels.length === 0) { return null; }
	if (!Number.isFinite(displayWidth) || displayWidth <= 0) { return levels[0]; }
	const needed = displayWidth * oversample;
	// levels[0] is full resolution and the rest descend, so the last entry that
	// still covers `needed` is the cheapest acceptable one.
	let chosen = levels[0];
	for (const level of levels) {
		if (level.width >= needed) { chosen = level; }
	}
	return chosen;
}

/**
 * The level to decode when a pyramidal file is FIRST opened.
 *
 * The default is full resolution, deliberately: this is an inspector, and a
 * silently downsampled image is a worse failure than a slow one. A reduced
 * level is chosen only when full resolution cannot be shown at all — beyond
 * the browser's canvas ceiling, or beyond what the decoder can hold in memory
 * — which `canDisplay` decides for the caller.
 *
 * When that happens the choice is bounded twice over: the level must be
 * displayable, and it should not be larger than the window that will show it.
 * That second bound is what makes an unopenable 40000x40000 scene open at
 * once — it lands on a level sized for the screen rather than on the largest
 * one that technically fits a canvas, and zooming in refines from there.
 *
 * Returns null when the page has no levels at all, and the full-resolution
 * entry whenever it is displayable.
 */
export function chooseOpenLevel(
	directory: TiffPageEntry[],
	pageIndex: number,
	displayWidth: number,
	canDisplay: (width: number, height: number) => boolean,
	oversample = 1,
): TiffPageEntry | null {
	const levels = levelsForPage(directory, pageIndex);
	if (levels.length === 0) { return null; }
	if (canDisplay(levels[0].width, levels[0].height)) { return levels[0]; }

	const wanted = levelForDisplayWidth(directory, pageIndex, displayWidth, oversample) ?? levels[0];
	// Walk down from the viewport-sized choice until something is displayable;
	// levels descend in size, so this stops at the largest one that works.
	const startIndex = Math.max(0, levels.indexOf(wanted));
	for (const level of levels.slice(startIndex)) {
		if (canDisplay(level.width, level.height)) { return level; }
	}
	return null;
}

/** "Full", "1/2", "1/4" … — how a level is named in the UI and the log. */
export function levelLabel(level: TiffPageEntry): string {
	const scale = level.reduction <= 1 ? 'Full' : `1/${level.reduction}`;
	return `${scale} · ${level.width}x${level.height}`;
}

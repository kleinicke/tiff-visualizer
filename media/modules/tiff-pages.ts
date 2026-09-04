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
	/**
	 * The smallest independently decodable unit of this level — a tile, or the
	 * full width by RowsPerStrip. A region read costs whole blocks, so this is
	 * what a requested rectangle snaps to.
	 */
	blockWidth: number;
	blockHeight: number;
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
			blockWidth: Math.max(1, Number(entry.blockWidth) || Number(entry.width) || 1),
			blockHeight: Math.max(1, Number(entry.blockHeight) || Number(entry.height) || 1),
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
 * Beyond this many pixels, a full-resolution decode is slow enough to notice
 * and is skipped in favour of a level that matches the window.
 *
 * The number is a judgement, not a measurement of one machine: a 120-megapixel
 * Sentinel-2 band takes about four seconds to decode and draw, a 30-megapixel
 * one about one. Below the threshold the wait is not worth trading real values
 * for, above it the reader is looking at a fit-to-window view where a matched
 * level is visually identical anyway.
 */
export const FULL_RESOLUTION_PIXEL_BUDGET = 40_000_000;
/** Above this size the viewer uses a stable overview plus streamed viewport tiles. */
export const LARGE_PYRAMID_SCENE_THRESHOLD = 50_000_000;

/**
 * The level to decode when a pyramidal file is FIRST opened.
 *
 * Two things are true at once, and this is where they are reconciled. At
 * fit-to-window a level matched to the window is VISUALLY identical to full
 * resolution, so decoding the whole 10980x10980 band to draw 900 pixels of it
 * is waste the reader feels as a four-second wait. But the values under the
 * cursor come from whatever was decoded, so a reduced level is an approximate
 * readout — which is not something to do behind someone's back.
 *
 * So: full resolution whenever it is displayable AND cheap enough that nobody
 * waits for it. Past `FULL_RESOLUTION_PIXEL_BUDGET`, or when it cannot be
 * displayed at all, take the level that matches the window — and the caller is
 * expected to SAY so, both in the log and in the pixel readout. Zooming in
 * then refines back towards full resolution, which is where the missing detail
 * would actually become visible.
 *
 * Returns null when the page has no levels at all.
 */
export function chooseOpenLevel(
	directory: TiffPageEntry[],
	pageIndex: number,
	displayWidth: number,
	canDisplay: (width: number, height: number) => boolean,
	oversample = 1,
	pixelBudget = FULL_RESOLUTION_PIXEL_BUDGET,
): TiffPageEntry | null {
	const levels = levelsForPage(directory, pageIndex);
	if (levels.length === 0) { return null; }
	const full = levels[0];
	if (canDisplay(full.width, full.height) && full.width * full.height <= pixelBudget) {
		return full;
	}

	const wanted = levelForDisplayWidth(directory, pageIndex, displayWidth, oversample) ?? full;
	// Walk down from the window-sized choice until something is displayable;
	// levels descend in size, so this stops at the largest one that works.
	const startIndex = Math.max(0, levels.indexOf(wanted));
	for (const level of levels.slice(startIndex)) {
		if (canDisplay(level.width, level.height)) { return level; }
	}
	return null;
}

/**
 * A range-backed COG can establish context from its cheapest complete overview
 * and stream the window-matched blocks next. Local files keep `chooseOpenLevel`
 * because their bytes are already resident and a second-stage read saves no IO.
 */
export function chooseRemoteOpenLevel(
	directory: TiffPageEntry[],
	pageIndex: number,
	displayWidth: number,
	canDisplay: (width: number, height: number) => boolean,
	pixelBudget = FULL_RESOLUTION_PIXEL_BUDGET,
): TiffPageEntry | null {
	const ordinary = chooseOpenLevel(directory, pageIndex, displayWidth, canDisplay, 1, pixelBudget);
	const levels = levelsForPage(directory, pageIndex);
	const full = levels[0];
	if (!full || full.width * full.height <= LARGE_PYRAMID_SCENE_THRESHOLD) { return ordinary; }
	return [...levels].reverse().find(level => canDisplay(level.width, level.height)) || ordinary;
}

/**
 * The level to hold as the base for a view, given the one already held, or null
 * to keep what is there.
 *
 * Both directions of a zoom, and the reasons they are not symmetrical:
 *
 * **Finer.** Take the largest level that covers the view, that can be drawn,
 * and that is within `pixelBudget`. The budget is what changes when the viewer
 * can also draw a PATCH of a finer level over the visible area: without patches
 * the decoded level is the only detail there is, so it is worth decoding a large
 * one; with them, a 120-megapixel decode to show 1.6 megapixels is a wait with
 * no visible effect, and the base can stop at a level that is cheap to hold
 * while the patch supplies what is actually on screen.
 *
 * **Coarser.** Only when the view has dropped at least a full level below what
 * is held. Detail already decoded is free to keep, so the only reasons to let it
 * go are memory and the zoom range — and a view sitting near a boundary must not
 * switch back and forth on every small change.
 */
export function levelForZoom(
	directory: TiffPageEntry[],
	pageIndex: number,
	currentIndex: number,
	displayWidth: number,
	canDisplay: (width: number, height: number) => boolean,
	pixelBudget = Infinity,
): TiffPageEntry | null {
	const levels = levelsForPage(directory, pageIndex);
	const current = levels.find(level => level.index === currentIndex);
	const wanted = levelForDisplayWidth(directory, pageIndex, displayWidth);
	if (!current || !wanted) { return null; }

	if (wanted.width > current.width) {
		const target = levels.find(level =>
			level.width <= wanted.width
			&& level.width * level.height <= pixelBudget
			&& canDisplay(level.width, level.height));
		return target && target.width > current.width ? target : null;
	}
	return wanted.width * 2 <= current.width ? wanted : null;
}

/**
 * What the display side tells the decoder about the view it is opening into.
 *
 * Plain numbers, because the decision is made in the decode worker — where the
 * bytes and the decoder already are — and a "can this be drawn?" predicate
 * cannot cross that boundary. The main thread measures the limits once (it has
 * the canvas) and sends the answers.
 */
export interface TiffLevelHint {
	/** Device pixels the image will span at fit-to-window. */
	displayWidth: number;
	/** Largest canvas axis this browser accepts. */
	maxAxis: number;
	/** Largest canvas area, in pixels. */
	maxArea: number;
	/** Largest ImageData backing store, in bytes. */
	maxBytes: number;
	/** Past this many pixels, full resolution is not decoded on open. */
	pixelBudget: number;
}

/** "Full", "1/2", "1/4" … — how a level is named in the UI and the log. */
export function levelLabel(level: TiffPageEntry): string {
	const scale = level.reduction <= 1 ? 'Full' : `1/${level.reduction}`;
	return `${scale} · ${level.width}x${level.height}`;
}

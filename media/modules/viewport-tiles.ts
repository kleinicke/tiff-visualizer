"use strict";

/**
 * Deciding WHICH rectangle of a large image to decode for the current view.
 *
 * The decoder can now read a rectangle instead of a whole page
 * (`decode_tiff_region`), which makes the cost of looking at an image follow
 * the window rather than the file: a 1600x1000 viewport onto a 10980x10980
 * band is 26 ms and four tiles, against 974 ms and 121 tiles for the page. This
 * module holds the part of that which is a judgement rather than a decode —
 * what to ask for, and when the answer already in hand will do.
 *
 * Three decisions, and the reasoning for each:
 *
 * 1. **Snap outward to block boundaries.** A block is the smallest thing the
 *    decoder can read, so asking for a rectangle inside one costs the same as
 *    asking for all of it. Snapping makes the request the honest unit of work
 *    and makes two nearby viewports produce the SAME request, which is what
 *    lets the cache hit at all.
 *
 * 2. **Ask for more than the window.** Panning is continuous and decoding is
 *    not; a margin of roughly half a screen means a small drag stays inside
 *    what is already decoded instead of stalling on every pixel of movement.
 *
 * 3. **Never ask for more than the page.** Past a certain fraction of the
 *    image the region path stops being a saving — it decodes nearly everything
 *    while giving up the whole-page result the rest of the viewer expects — so
 *    the caller is told to decode the page instead.
 *
 * Nothing here touches the DOM or the decoder: it is arithmetic over
 * rectangles, so it can be tested exactly (test/viewport-tiles-test.js) rather
 * than by looking at pictures.
 */

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface BlockGeometry {
	/** Page size in pixels. */
	imageWidth: number;
	imageHeight: number;
	/** Block size in pixels: a tile, or the full width by RowsPerStrip. */
	blockWidth: number;
	blockHeight: number;
}

/** How much beyond the window to decode, as a fraction of the window size. */
export const DEFAULT_MARGIN = 0.5;

/**
 * Above this fraction of the page's pixels, decoding the page wins: the region
 * would cover nearly all of it anyway, and the whole-page path produces the
 * statistics, histogram and inspection buffer the rest of the viewer expects.
 */
export const WHOLE_PAGE_FRACTION = 0.6;

function clampRect(rect: Rect, width: number, height: number): Rect {
	const x = Math.max(0, Math.min(Math.floor(rect.x), Math.max(0, width - 1)));
	const y = Math.max(0, Math.min(Math.floor(rect.y), Math.max(0, height - 1)));
	return {
		x,
		y,
		width: Math.max(1, Math.min(Math.ceil(rect.width), width - x)),
		height: Math.max(1, Math.min(Math.ceil(rect.height), height - y)),
	};
}

/**
 * The visible part of the image, in the image's own pixels.
 *
 * `scale` is CSS pixels per image pixel; `offsetX/Y` is how far the image's
 * top-left corner sits outside the viewport's top-left, in CSS pixels (what a
 * scroll position gives you).
 */
export function visibleImageRect(
	geometry: Pick<BlockGeometry, 'imageWidth' | 'imageHeight'>,
	viewportWidth: number,
	viewportHeight: number,
	scale: number,
	offsetX: number,
	offsetY: number,
): Rect {
	if (!(scale > 0)) {
		return { x: 0, y: 0, width: geometry.imageWidth, height: geometry.imageHeight };
	}
	return clampRect({
		x: offsetX / scale,
		y: offsetY / scale,
		width: viewportWidth / scale,
		height: viewportHeight / scale,
	}, geometry.imageWidth, geometry.imageHeight);
}

/** Grow a rectangle by `margin` times its size, then clamp to the image. */
export function withMargin(rect: Rect, geometry: BlockGeometry, margin = DEFAULT_MARGIN): Rect {
	const growX = rect.width * margin;
	const growY = rect.height * margin;
	const x = Math.max(0, rect.x - growX / 2);
	const y = Math.max(0, rect.y - growY / 2);
	return clampRect({
		x,
		y,
		width: rect.width + growX,
		height: rect.height + growY,
	}, geometry.imageWidth, geometry.imageHeight);
}

/** Expand a rectangle to the blocks it touches. */
export function snapToBlocks(rect: Rect, geometry: BlockGeometry): Rect {
	const blockWidth = Math.max(1, geometry.blockWidth);
	const blockHeight = Math.max(1, geometry.blockHeight);
	const x = Math.floor(rect.x / blockWidth) * blockWidth;
	const y = Math.floor(rect.y / blockHeight) * blockHeight;
	const right = Math.min(geometry.imageWidth,
		Math.ceil((rect.x + rect.width) / blockWidth) * blockWidth);
	const bottom = Math.min(geometry.imageHeight,
		Math.ceil((rect.y + rect.height) / blockHeight) * blockHeight);
	return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

export function rectContains(outer: Rect, inner: Rect): boolean {
	return inner.x >= outer.x
		&& inner.y >= outer.y
		&& inner.x + inner.width <= outer.x + outer.width
		&& inner.y + inner.height <= outer.y + outer.height;
}

export function rectsEqual(a: Rect | null, b: Rect | null): boolean {
	if (!a || !b) { return a === b; }
	return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export type RegionPlan =
	| { kind: 'region'; rect: Rect }
	/** The view already sits inside what was decoded; nothing to do. */
	| { kind: 'keep' }
	/** The region would cover most of the page; decode the page instead. */
	| { kind: 'whole-page' };

/**
 * What to decode for a view, given what is already decoded.
 *
 * `decoded` is the rectangle currently held (null when nothing is), and the
 * answer is one of: keep it, read a new rectangle, or give up on regions for
 * this view and decode the page.
 */
export function planRegionForView(
	geometry: BlockGeometry,
	visible: Rect,
	decoded: Rect | null,
	margin = DEFAULT_MARGIN,
	wholePageFraction = WHOLE_PAGE_FRACTION,
): RegionPlan {
	const pagePixels = geometry.imageWidth * geometry.imageHeight;
	if (pagePixels <= 0) { return { kind: 'whole-page' }; }

	// Judge "is this worth a region read?" on the VISIBLE rectangle, before the
	// margin and the block snapping inflate it — otherwise a view of a third of
	// the image is rejected because its padded, snapped form covers most of it.
	if ((visible.width * visible.height) / pagePixels >= wholePageFraction) {
		return { kind: 'whole-page' };
	}

	// Already covered: a pan inside the margin needs no decode at all, which is
	// the whole reason for asking for more than the window in the first place.
	if (decoded && rectContains(decoded, visible)) { return { kind: 'keep' }; }

	const wanted = snapToBlocks(withMargin(visible, geometry, margin), geometry);
	if (decoded && rectsEqual(decoded, wanted)) { return { kind: 'keep' }; }
	if (wanted.width * wanted.height >= pagePixels) { return { kind: 'whole-page' }; }
	return { kind: 'region', rect: wanted };
}

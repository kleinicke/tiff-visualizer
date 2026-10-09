/**
 * Row bands of a layer composite, so independent workers can each composite
 * part of a document. Every operation in `composite` is per pixel (blends,
 * masks, clipping, group surfaces, adjustments), so a band composited from
 * band-sized layers equals the same rows of the full composite; the bytes a
 * worker receives are only the rows its band covers.
 *
 * A group's children are composited into a canvas-sized surface that is then
 * placed at the group's offset; with a non-zero offset that surface's rows
 * are not the band's rows (and for arithmetic modes even its transparent
 * rectangle counts), so such stacks are not banded (`canComposeInBands`).
 * XCF groups always sit at the origin. A layer or mask that misses the band
 * keeps one row placed just outside it, so the layer list (and with it the
 * output channels, type and clipping chains) stays the same in every band.
 */
import type { CompositeResult, Layer } from './layer-compositor.js';

type Mask = NonNullable<Layer['rasterMask']>;

/** Rows `first .. first + rows` of interleaved `data`, `width` pixels of `channels` each. */
function rowsOf(data: ArrayLike<number>, width: number, channels: number, first: number, rows: number): ArrayLike<number> {
	const start = first * width * channels, end = start + rows * width * channels;
	const source = data as ArrayLike<number> & { slice?: (start: number, end: number) => ArrayLike<number> };
	return typeof source.slice === 'function' ? source.slice(start, end) : Array.prototype.slice.call(data, start, end);
}

/** The rows of a `height`-row raster at band-relative `offsetY` that fall inside `bandRows`. */
function bandWindow(offsetY: number, height: number, bandRows: number): { first: number; rows: number; offsetY: number } {
	const top = Math.round(offsetY);
	const first = Math.max(0, -top), last = Math.min(height, bandRows - top);
	if (last > first) { return { first, rows: last - first, offsetY: top + first }; }
	// Outside the band: one row, placed just above it.
	return { first: 0, rows: Math.min(1, height), offsetY: -1 };
}

/** Whether `sliceLayersForBand` reproduces the full composite: no group is offset. */
export function canComposeInBands(layers: Layer[]): boolean {
	return layers.every(layer => layer.kind !== 'group' || (!layer.offsetX && !layer.offsetY));
}

/**
 * Layers for compositing canvas rows `y0 .. y1` as a `canvasWidth` × `(y1 - y0)`
 * canvas. Only for stacks that `canComposeInBands` accepts.
 */
export function sliceLayersForBand(layers: Layer[], y0: number, y1: number): Layer[] {
	const bandRows = y1 - y0;
	return layers.map(layer => {
		const rasterMask = sliceMask(layer.rasterMask, layer, y0, bandRows);
		// A group's surface comes from its children; its own data is never read
		// (and must not travel: it may be the decoded document's buffer).
		if (layer.kind === 'group') { return { ...layer, data: undefined as Layer['data'], rasterMask }; }
		const offsetY = (layer.offsetY || 0) - y0;
		if (!layer.data) { return { ...layer, offsetY, rasterMask }; }
		const window = bandWindow(offsetY, layer.height, bandRows);
		return {
			...layer,
			data: rowsOf(layer.data, layer.width, layer.channels, window.first, window.rows),
			height: window.rows,
			offsetY: window.offsetY,
			rasterMask,
		};
	});
}

function sliceMask(mask: Mask | undefined, owner: Layer, y0: number, bandRows: number): Mask | undefined {
	if (!mask) { return undefined; }
	const offsetX = mask.offsetX ?? owner.offsetX ?? 0;
	const offsetY = (mask.offsetY ?? owner.offsetY ?? 0) - y0;
	const window = bandWindow(offsetY, mask.height, bandRows);
	return {
		...mask,
		data: rowsOf(mask.data, mask.width, mask.channels ?? 1, window.first, window.rows),
		height: window.rows,
		offsetX,
		offsetY: window.offsetY,
	};
}

/**
 * `composite`'s range rule for one result: finite colour values of covered
 * pixels, where an uncovered pixel is NaN without alpha and has zero alpha
 * with it. Infinity..-Infinity when there are none, so ranges can be merged.
 * (`composite` itself reports 0..0 then, which a merge cannot tell apart from
 * a real range.)
 */
export function finiteRangeOf(result: { data: Float32Array; channels: number }): { min: number; max: number } {
	const { data, channels } = result;
	let min = Infinity, max = -Infinity;
	const colorChannels = channels === 4 ? 3 : channels;
	for (let base = 0; base < data.length; base += channels) {
		if (channels === 4 && !data[base + 3]) { continue; }
		for (let channel = 0; channel < colorChannels; channel++) {
			const value = data[base + channel];
			if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
		}
	}
	return { min, max };
}

/**
 * Stack band composites (top to bottom, in order) into the full composite.
 * `ranges` are the bands' `finiteRangeOf` (computed where the bands were);
 * without them the range is computed here over the merged data.
 */
export function mergeBands(bands: CompositeResult[], width: number, height: number, ranges?: { min: number; max: number }[]): CompositeResult {
	const { channels, isFloat, typeMax } = bands[0];
	const data = new Float32Array(width * height * channels);
	let offset = 0, coveredCount = 0;
	for (const band of bands) {
		if (band.channels !== channels || band.width !== width) { throw new Error('Composite bands disagree'); }
		data.set(band.data, offset);
		offset += band.data.length;
		coveredCount += band.coveredCount;
	}
	if (offset !== data.length) { throw new Error('Composite bands do not cover the canvas'); }
	let min = Infinity, max = -Infinity;
	for (const range of ranges ?? [finiteRangeOf({ data, channels })]) {
		if (range.min < min) { min = range.min; }
		if (range.max > max) { max = range.max; }
	}
	if (min === Infinity) { min = 0; max = 0; }
	return { data, width, height, channels, isFloat, typeMax, stats: { min, max }, coveredCount };
}

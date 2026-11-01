import type { CellTable } from './cell-table.js';
import type { TracedMask } from './mask-trace.js';
import type { PolygonSet } from './polygon-set.js';

/**
 * Cells from a traced mask: one table row per polygon, named by the mask's label, with the outlines
 * scaled from mask pixels to scene pixels (`scale` is 1 when the mask has the image's size).
 */
export function cellsFromTrace(traced: TracedMask, scale: number): { table: CellTable; cells: PolygonSet } {
	const count = traced.labels.length;
	const xy = new Float32Array(traced.xy.length);
	const bounds = new Float32Array(count * 4);
	const rows = new Int32Array(count);
	const ids = new Array<string>(count);
	for (let polygon = 0; polygon < count; polygon++) {
		rows[polygon] = polygon;
		ids[polygon] = String(traced.labels[polygon]);
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (let vertex = traced.offsets[polygon]; vertex < traced.offsets[polygon + 1]; vertex++) {
			const x = traced.xy[vertex * 2] * scale, y = traced.xy[vertex * 2 + 1] * scale;
			xy[vertex * 2] = x; xy[vertex * 2 + 1] = y;
			if (x < minX) { minX = x; } if (x > maxX) { maxX = x; }
			if (y < minY) { minY = y; } if (y > maxY) { maxY = y; }
		}
		bounds.set([minX, minY, maxX, maxY], polygon * 4);
	}
	const rowOfId = new Map<string, number>();
	ids.forEach((id, row) => rowOfId.set(id, row));
	return { table: { count, ids, columns: [], rowOfId }, cells: { count, offsets: traced.offsets, xy, bounds, rows } };
}

/**
 * Scene pixels per mask pixel: 1 for a mask the size of the image, a whole-image ratio for a
 * downsampled one (a mask saved from a pyramid level). Throws when the shapes disagree.
 */
export function maskScaleFor(mask: { width: number; height: number }, image: { width: number; height: number } | null): number {
	if (!image) { return 1; }
	const x = image.width / mask.width, y = image.height / mask.height;
	if (!(Math.abs(x - y) <= 0.01 * Math.max(x, y))) {
		throw new Error(`The mask is ${mask.width} × ${mask.height} pixels but the image is ${image.width} × ${image.height}, so they do not line up.`);
	}
	return (x + y) / 2;
}

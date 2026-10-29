/**
 * Draws cell (and nucleus) polygons over a pan/zoom canvas and answers
 * clicks. The host owns the canvas; the layer only needs a 2D context whose
 * transform maps scene pixels to device pixels, which is what a scene
 * overlay receives.
 */

import { meanPolygonSize, polygonContains, type PolygonSet } from './polygon-set.js';
import { SpatialIndex } from './spatial-index.js';
import type { BucketPlan, CellShow } from './cell-style.js';
import { TileCache, type TilePainter } from './cells-tiles.js';
import { planNone } from './cell-style.js';

const NUCLEUS_OUTLINE = '#6cc8ff';
export const CELL_OUTLINE = '#ffffff';
const SELECTED_OUTLINE = '#ffd400';
/**
 * Cells at least this wide on screen, with few in view, are drawn live as
 * vectors (crisp at any zoom); everything else comes from the tile pyramid.
 */
const LIVE_MIN_PX = 40;
const LIVE_MAX_POLYGONS = 600;
/**
 * A tile draws a cell narrower than DOT_PX (in tile pixels) as a centroid dot,
 * one up to SIMPLE_PX as a rough polygon, and anything wider as its outline. Both are sized so the layer's brightness
 * does not change from one level to the next:
 *
 *  - Outlines are one pixel wide, which covers 4 / width of the area. Below
 *    the width where that reaches OUTLINE_INK the line is thinned to keep the
 *    coverage at OUTLINE_INK instead of climbing towards solid white.
 *  - A dot carries the ink the outline would (OUTLINE_INK x the cell's area, or
 *    the fill opacity when colouring). Cells beyond MAX_DOTS_PER_TILE are
 *    thinned at random, and each survivor takes the ink of the cells it stands
 *    for, so thinning changes the speckle but not the brightness.
 */
const DOT_PX = 2;
/** Cells narrower than this are drawn as rough, solid polygons of about six vertices (filling is far cheaper than stroking at this size). */
const SIMPLE_PX = 4;
/** Nucleus outlines need room: below this width they are not drawn. */
const NUCLEUS_MIN_PX = 12;
const OUTLINE_INK = 0.18;
const MAX_DOTS_PER_TILE = 6000;
/** Building a Path2D slows down quadratically with its size, so polygons go into many small paths. */
const POLYGONS_PER_PATH = 100;
const DOT_ALPHA = 0.9;
/** A tile is drawn 0.71-1x its size on screen; this is the mean, used to keep line weight steady. */
const TILE_DOWNSCALE = 0.85;
/** Vertices closer than this (tile pixels) to the last one kept change nothing visible. */
const MIN_VERTEX_GAP_PX = 0.7;
/** Time a frame may spend painting new tiles. */
const TILE_BUDGET_MS = 8;

export interface CellsLayerOptions {
	cells: PolygonSet;
	nuclei?: PolygonSet | null;
	rowCount: number;
	/** Ask the host to redraw. */
	invalidate: () => void;
	onSelectionChange?: () => void;
	/** Extra text for the cursor readout, for a row. */
	describeRow?: (row: number) => string;
	/** Outline colour of the cells; white when absent. */
	outline?: string;
	/** Canvas factory for tiles (tests, or an offscreen canvas). */
	createTileCanvas?: () => HTMLCanvasElement | OffscreenCanvas;
}

interface Prepared { set: PolygonSet; index: SpatialIndex; meanSize: number; polygonOfRow: Map<number, number> }

function prepare(set: PolygonSet): Prepared {
	const polygonOfRow = new Map<number, number>();
	for (let polygon = 0; polygon < set.count; polygon++) { if (set.rows[polygon] >= 0 && !polygonOfRow.has(set.rows[polygon])) { polygonOfRow.set(set.rows[polygon], polygon); } }
	return { set, index: new SpatialIndex(set), meanSize: meanPolygonSize(set), polygonOfRow };
}

export class CellsLayer {
	private readonly cells: Prepared;
	private nuclei: Prepared | null;
	private show: CellShow = 'cells';
	private plan: BucketPlan;
	private opacity = 0.55;
	private outlineColor: string;
	private hidden = false;
	private readonly selected = new Set<number>();
	private readonly scratch: number[] = [];
	private readonly tiles: TileCache;
	private lastStats = { drawn: 0, painted: 0, pending: 0, fallback: 0 };

	constructor(private readonly options: CellsLayerOptions) {
		this.outlineColor = options.outline ?? CELL_OUTLINE;
		this.cells = prepare(options.cells);
		this.nuclei = options.nuclei && options.nuclei.count > 0 ? prepare(options.nuclei) : null;
		this.plan = planNone(options.rowCount);
		const painter: TilePainter = { paint: (context, scale, rect) => this.paintTile(context, scale, rect) };
		this.tiles = new TileCache(painter, 640, options.createTileCanvas);
	}

	/** What the last frame did, for tests and the status line. */
	frameStats(): { drawn: number; painted: number; pending: number; fallback: number } { return this.lastStats; }

	hasNuclei(): boolean { return this.nuclei !== null; }
	getShow(): CellShow { return this.show; }
	setShow(show: CellShow): void { this.show = show; this.tiles.invalidate(); this.options.invalidate(); }
	setPlan(plan: BucketPlan): void { this.plan = plan; this.tiles.invalidate(); this.options.invalidate(); }
	/** Replace the nucleus outlines (null removes them). */
	setNuclei(set: PolygonSet | null): void {
		this.nuclei = set && set.count > 0 ? prepare(set) : null;
		this.tiles.invalidate();
		this.options.invalidate();
	}
	setOutline(color: string): void { this.outlineColor = color; this.tiles.invalidate(); this.options.invalidate(); }
	setHidden(hidden: boolean): void { this.hidden = hidden; this.options.invalidate(); }
	isHidden(): boolean { return this.hidden; }
	setOpacity(opacity: number): void { this.opacity = opacity; this.tiles.invalidate(); this.options.invalidate(); }
	selectedRows(): number[] { return [...this.selected]; }

	select(rows: number[], mode: 'replace' | 'toggle'): void {
		if (mode === 'replace') { this.selected.clear(); }
		for (const row of rows) { if (mode === 'toggle' && this.selected.has(row)) { this.selected.delete(row); } else { this.selected.add(row); } }
		this.options.invalidate();
		this.options.onSelectionChange?.();
	}

	clearSelection(): void {
		if (this.selected.size === 0) { return; }
		this.selected.clear();
		this.options.invalidate();
		this.options.onSelectionChange?.();
	}

	private primary(): Prepared | null {
		if (this.show === 'none' || this.hidden) { return null; }
		if (this.show === 'nucleus') { return this.nuclei ?? this.cells; }
		return this.cells;
	}

	private visibleRect(context: CanvasRenderingContext2D): [number, number, number, number] {
		const inverse = context.getTransform().inverse();
		const width = context.canvas.width, height = context.canvas.height;
		const a = inverse.transformPoint(new DOMPoint(0, 0)), b = inverse.transformPoint(new DOMPoint(width, height));
		return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
	}

	/** Scene overlay entry point. */
	draw(context: CanvasRenderingContext2D, _camera: unknown, scale: number): void {
		const primary = this.primary();
		if (!primary) { return; }
		const visible = this.visibleRect(context);
		context.save();
		context.lineJoin = 'round';
		const polygons = primary.meanSize * scale >= LIVE_MIN_PX ? primary.index.visible(visible[0], visible[1], visible[2], visible[3], this.scratch) : null;
		if (polygons && polygons.length <= LIVE_MAX_POLYGONS) {
			this.paintOutlines(context, primary, polygons, scale, 1 / scale, 0, this.show === 'both' ? this.nuclei : null);
			this.lastStats = { drawn: 0, painted: 0, pending: 0, fallback: 0 };
		} else {
			this.lastStats = this.tiles.draw(context, scale, visible, TILE_BUDGET_MS);
			if (this.lastStats.pending > 0) { this.options.invalidate(); }
		}
		this.drawSelection(context, primary, scale);
		context.restore();
	}

	/** Paint one pyramid tile. The context maps scene pixels to tile pixels; `scale` is tile pixels per scene pixel. */
	private paintTile(context: CanvasRenderingContext2D, scale: number, rect: [number, number, number, number]): void {
		const primary = this.primary();
		if (!primary) { return; }
		const pad = 3 / scale;
		const window: [number, number, number, number] = [rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad];
		const polygons = primary.index.visible(window[0], window[1], window[2], window[3], []);
		context.lineJoin = 'round';
		const width = primary.meanSize * scale;
		if (width < DOT_PX) { this.paintDots(context, primary, polygons, scale, width); return; }
		const lineWidth = Math.min(1 / TILE_DOWNSCALE, OUTLINE_INK * width / 4) / scale;
		this.paintOutlines(context, primary, polygons, scale, lineWidth, (width < SIMPLE_PX ? width / 2 : Math.min(2, Math.max(MIN_VERTEX_GAP_PX, width / 10))) / scale, width >= NUCLEUS_MIN_PX && this.show === 'both' ? this.nuclei : null, window, width < SIMPLE_PX);
	}

	/** Polygons grouped by colour bucket; hidden ones (bucket 0) are left out. */
	private groupByBucket(primary: Prepared, polygons: ArrayLike<number>, keep: number): Map<number, number[]> {
		const groups = new Map<number, number[]>();
		const limit = keep * 4294967296;
		for (let at = 0; at < polygons.length; at++) {
			const polygon = polygons[at];
			// A hash of the polygon, not its position in the list: the same cells survive in every tile.
			if (keep < 1 && (Math.imul(polygon, 2654435761) >>> 0) >= limit) { continue; }
			const row = primary.set.rows[polygon];
			const bucket = row >= 0 ? this.plan.bucket[row] : 0;
			if (bucket === 0) { continue; }
			const list = groups.get(bucket);
			if (list) { list.push(polygon); } else { groups.set(bucket, [polygon]); }
		}
		return groups;
	}

	/** One square per cell at its centre, carrying the ink of the cells it stands for. */
	private paintDots(context: CanvasRenderingContext2D, primary: Prepared, polygons: ArrayLike<number>, scale: number, width: number): void {
		const keep = Math.min(1, MAX_DOTS_PER_TILE / Math.max(1, polygons.length));
		const groups = this.groupByBucket(primary, polygons, keep);
		const fills = this.plan.fill;
		const ink = (fills ? 0.8 * this.opacity + OUTLINE_INK / 2 : OUTLINE_INK * 0.62) * width * width / keep;
		const side = Math.max(1, Math.sqrt(ink / DOT_ALPHA));
		const alpha = Math.min(DOT_ALPHA, ink / (side * side));
		const size = side / scale;
		const outline = primary.set === this.nuclei?.set ? NUCLEUS_OUTLINE : this.outlineColor;
		context.globalAlpha = alpha;
		for (const [bucket, members] of groups) {
			context.fillStyle = fills ? this.plan.colors[bucket - 1] : outline;
			context.beginPath();
			for (const polygon of members) {
				const at = polygon * 4, b = primary.set.bounds;
				context.rect((b[at] + b[at + 2]) / 2 - size / 2, (b[at + 1] + b[at + 3]) / 2 - size / 2, size, size);
			}
			context.fill();
		}
	}

	/** Cell outlines (and fills when colouring) at `lineWidth` scene pixels; nuclei on top when given. */
	private paintOutlines(
		context: CanvasRenderingContext2D, primary: Prepared, polygons: ArrayLike<number>, scale: number, lineWidth: number, minGap: number,
		nuclei: Prepared | null, nucleusWindow?: [number, number, number, number], solid = false,
	): void {
		const groups = this.groupByBucket(primary, polygons, 1);
		const fills = this.plan.fill;
		const outline = primary.set === this.nuclei?.set ? NUCLEUS_OUTLINE : this.outlineColor;
		context.lineWidth = lineWidth;
		for (const [bucket, members] of groups) {
			for (let from = 0; from < members.length; from += POLYGONS_PER_PATH) {
				const path = new Path2D();
				const to = Math.min(members.length, from + POLYGONS_PER_PATH);
				for (let at = from; at < to; at++) { this.tracePolygon(path, primary.set, members[at], minGap); }
				if (solid) {
					context.globalAlpha = Math.min(0.95, (fills ? 0.8 * this.opacity + OUTLINE_INK / 2 : OUTLINE_INK * 0.62) / 0.785);
					context.fillStyle = fills ? this.plan.colors[bucket - 1] : outline;
					context.fill(path);
					continue;
				}
				if (fills) {
					context.globalAlpha = this.opacity;
					context.fillStyle = this.plan.colors[bucket - 1];
					context.fill(path);
				}
				context.globalAlpha = fills ? 0.85 : 0.9;
				context.strokeStyle = outline;
				context.stroke(path);
			}
		}
		if (nuclei) { this.paintNuclei(context, nuclei, scale, nucleusWindow ?? this.windowOf(context)); }
	}

	private windowOf(context: CanvasRenderingContext2D): [number, number, number, number] { return this.visibleRect(context); }

	private paintNuclei(context: CanvasRenderingContext2D, nuclei: Prepared, scale: number, window: [number, number, number, number]): void {
		const visible = nuclei.index.visible(window[0], window[1], window[2], window[3], []);
		const path = new Path2D();
		for (const polygon of visible) {
			const row = nuclei.set.rows[polygon];
			if (row >= 0 && this.plan.bucket[row] === 0) { continue; }
			this.tracePolygon(path, nuclei.set, polygon);
		}
		context.globalAlpha = 0.9;
		context.lineWidth = 1 / scale;
		context.strokeStyle = NUCLEUS_OUTLINE;
		context.stroke(path);
	}

	/** Add a polygon to a path, skipping vertices closer than `minGap` to the last one kept. */
	private tracePolygon(path: Path2D, set: PolygonSet, polygon: number, minGap = 0): void {
		const start = set.offsets[polygon], end = set.offsets[polygon + 1];
		let lastX = set.xy[start * 2], lastY = set.xy[start * 2 + 1];
		path.moveTo(lastX, lastY);
		const gapSquared = minGap * minGap;
		for (let vertex = start + 1; vertex < end; vertex++) {
			const x = set.xy[vertex * 2], y = set.xy[vertex * 2 + 1];
			if ((x - lastX) * (x - lastX) + (y - lastY) * (y - lastY) < gapSquared) { continue; }
			path.lineTo(x, y);
			lastX = x; lastY = y;
		}
		path.closePath();
	}

	private drawSelection(context: CanvasRenderingContext2D, primary: Prepared, scale: number): void {
		if (this.selected.size === 0) { return; }
		const path = new Path2D();
		for (const row of this.selected) {
			const polygon = primary.polygonOfRow.get(row);
			if (polygon !== undefined) { this.tracePolygon(path, primary.set, polygon); }
		}
		context.globalAlpha = 1;
		context.lineWidth = 2.5 / scale;
		context.strokeStyle = SELECTED_OUTLINE;
		context.stroke(path);
	}

	/** Table row of the visible cell under a scene point, or -1. */
	pick(x: number, y: number): number {
		const primary = this.primary();
		if (!primary) { return -1; }
		const candidates = primary.index.visible(x, y, x, y, []);
		for (const polygon of candidates) {
			const row = primary.set.rows[polygon];
			if (row < 0 || this.plan.bucket[row] === 0) { continue; }
			if (polygonContains(primary.set, polygon, x, y)) { return row; }
		}
		return -1;
	}

	/** Scene overlay hook: a click without a drag. Returns true when it was used. */
	onClick(point: { x: number; y: number }, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): boolean {
		const row = this.pick(point.x, point.y);
		if (row < 0) {
			if (!event.shiftKey && !event.ctrlKey && !event.metaKey) { this.clearSelection(); }
			return false;
		}
		this.select([row], event.shiftKey || event.ctrlKey || event.metaKey ? 'toggle' : 'replace');
		return true;
	}

	/** Scene overlay hook: text for the cursor readout. */
	describe(point: { x: number; y: number }): string | undefined {
		const row = this.pick(point.x, point.y);
		return row < 0 ? undefined : this.options.describeRow?.(row);
	}
}

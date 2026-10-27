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
const CELL_OUTLINE = '#ffffff';
const SELECTED_OUTLINE = '#ffd400';
/**
 * Cells at least this wide on screen, with few in view, are drawn live as
 * vectors (crisp at any zoom); everything else comes from the tile pyramid.
 */
const LIVE_MIN_PX = 40;
const LIVE_MAX_POLYGONS = 600;
/**
 * How a tile draws a cell by its width in tile pixels: a dot, a box the size of
 * its bounds, a polygon cut to a few corners, then the full outline. Building a
 * path costs per corner, so detail is spent only where cells are few per tile.
 */
const DOT_PX = 2;
const BOX_PX = 8;
const FULL_PX = 16;
const SIMPLE_VERTICES = 8;
/** Time a frame may spend painting new tiles. */
const TILE_BUDGET_MS = 8;
type Detail = 'dots' | 'boxes' | 'simple' | 'full';

export interface CellsLayerOptions {
	cells: PolygonSet;
	nuclei?: PolygonSet | null;
	rowCount: number;
	/** Ask the host to redraw. */
	invalidate: () => void;
	onSelectionChange?: () => void;
	/** Extra text for the cursor readout, for a row. */
	describeRow?: (row: number) => string;
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
	private readonly nuclei: Prepared | null;
	private show: CellShow = 'cells';
	private plan: BucketPlan;
	private opacity = 0.55;
	private readonly selected = new Set<number>();
	private readonly scratch: number[] = [];
	private readonly tiles: TileCache;
	private lastStats = { drawn: 0, painted: 0, pending: 0, fallback: 0 };

	constructor(private readonly options: CellsLayerOptions) {
		this.cells = prepare(options.cells);
		this.nuclei = options.nuclei && options.nuclei.count > 0 ? prepare(options.nuclei) : null;
		this.plan = planNone(options.rowCount);
		const painter: TilePainter = { paint: (context, level, rect) => this.paintTile(context, level, rect) };
		this.tiles = new TileCache(painter, 640, options.createTileCanvas);
	}

	/** What the last frame did, for tests and the status line. */
	frameStats(): { drawn: number; painted: number; pending: number; fallback: number } { return this.lastStats; }

	hasNuclei(): boolean { return this.nuclei !== null; }
	getShow(): CellShow { return this.show; }
	setShow(show: CellShow): void { this.show = show; this.tiles.invalidate(); this.options.invalidate(); }
	setPlan(plan: BucketPlan): void { this.plan = plan; this.tiles.invalidate(); this.options.invalidate(); }
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
		if (this.show === 'none') { return null; }
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
			this.paint(context, primary, polygons, scale, 'full', this.show === 'both' ? this.nuclei : null);
			this.lastStats = { drawn: 0, painted: 0, pending: 0, fallback: 0 };
		} else {
			this.lastStats = this.tiles.draw(context, scale, visible, TILE_BUDGET_MS);
			if (this.lastStats.pending > 0) { this.options.invalidate(); }
		}
		this.drawSelection(context, primary, scale);
		context.restore();
	}

	/** Paint one pyramid tile. The context maps scene pixels to tile pixels. */
	private paintTile(context: CanvasRenderingContext2D, level: number, rect: [number, number, number, number]): void {
		const primary = this.primary();
		if (!primary) { return; }
		const scale = 2 ** level;
		const pad = 2 / scale;
		const polygons = primary.index.visible(rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad, []);
		context.lineJoin = 'round';
		const pixels = primary.meanSize * scale;
		const detail: Detail = pixels < DOT_PX ? 'dots' : pixels < BOX_PX ? 'boxes' : pixels < FULL_PX ? 'simple' : 'full';
		this.paint(context, primary, polygons, scale, detail, detail === 'full' && this.show === 'both' ? this.nuclei : null, [rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad]);
	}

	/** Draw polygons grouped by colour bucket: one fill and one stroke per bucket. */
	private paint(
		context: CanvasRenderingContext2D, primary: Prepared, polygons: ArrayLike<number>, scale: number, detail: Detail,
		nuclei: Prepared | null, nucleusWindow?: [number, number, number, number],
	): void {
		const groups = new Map<number, number[]>();
		// Several cells to a pixel add nothing: draw an even share of them.
		const pixelsPerCell = (primary.meanSize * scale) ** 2;
		const stride = detail === 'dots' ? Math.max(1, Math.floor(2 / pixelsPerCell)) : 1;
		for (let at = 0; at < polygons.length; at++) {
			const polygon = polygons[at];
			if (stride > 1 && polygon % stride !== 0) { continue; }
			const row = primary.set.rows[polygon];
			const bucket = row >= 0 ? this.plan.bucket[row] : 0;
			if (bucket === 0) { continue; }
			const list = groups.get(bucket);
			if (list) { list.push(polygon); } else { groups.set(bucket, [polygon]); }
		}
		const fills = this.plan.fill;
		const isNucleus = primary.set === this.nuclei?.set;
		const outline = isNucleus ? NUCLEUS_OUTLINE : CELL_OUTLINE;
		if (detail === 'dots') {
			const size = Math.max(2 / scale, primary.meanSize * 0.6);
			context.globalAlpha = fills ? Math.max(this.opacity, 0.8) : 0.9;
			for (const [bucket, members] of groups) {
				context.fillStyle = fills ? this.plan.colors[bucket - 1] : outline;
				context.beginPath();
				for (const polygon of members) {
					const at = polygon * 4;
					context.rect((primary.set.bounds[at] + primary.set.bounds[at + 2]) / 2 - size / 2, (primary.set.bounds[at + 1] + primary.set.bounds[at + 3]) / 2 - size / 2, size, size);
				}
				context.fill();
			}
		} else if (detail === 'boxes') {
			context.lineWidth = 1 / scale;
			for (const [bucket, members] of groups) {
				const path = new Path2D();
				for (const polygon of members) {
					const at = polygon * 4, b = primary.set.bounds;
					path.rect(b[at], b[at + 1], Math.max(b[at + 2] - b[at], 1 / scale), Math.max(b[at + 3] - b[at + 1], 1 / scale));
				}
				if (fills) {
					context.globalAlpha = this.opacity;
					context.fillStyle = this.plan.colors[bucket - 1];
					context.fill(path);
				} else {
					context.globalAlpha = 0.9;
					context.strokeStyle = outline;
					context.stroke(path);
				}
			}
		} else {
			context.lineWidth = 1 / scale;
			for (const [bucket, members] of groups) {
				const path = new Path2D();
				for (const polygon of members) { this.tracePolygon(path, primary.set, polygon, detail === 'simple' ? SIMPLE_VERTICES : Infinity); }
				if (fills) {
					context.globalAlpha = this.opacity;
					context.fillStyle = this.plan.colors[bucket - 1];
					context.fill(path);
				}
				if (detail === 'full' || !fills) {
					context.globalAlpha = fills ? 0.85 : 0.9;
					context.strokeStyle = outline;
					context.stroke(path);
				}
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
			this.tracePolygon(path, nuclei.set, polygon, Infinity);
		}
		context.globalAlpha = 0.9;
		context.lineWidth = 1 / scale;
		context.strokeStyle = NUCLEUS_OUTLINE;
		context.stroke(path);
	}

	/** Add a polygon to a path, keeping at most `maxVertices` of its corners. */
	private tracePolygon(path: Path2D, set: PolygonSet, polygon: number, maxVertices = Infinity): void {
		const start = set.offsets[polygon], end = set.offsets[polygon + 1];
		const stride = end - start > maxVertices ? Math.ceil((end - start) / maxVertices) : 1;
		path.moveTo(set.xy[start * 2], set.xy[start * 2 + 1]);
		for (let vertex = start + stride; vertex < end; vertex += stride) { path.lineTo(set.xy[vertex * 2], set.xy[vertex * 2 + 1]); }
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

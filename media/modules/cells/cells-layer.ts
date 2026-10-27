/**
 * Draws cell (and nucleus) polygons over a pan/zoom canvas and answers
 * clicks. The host owns the canvas; the layer only needs a 2D context whose
 * transform maps scene pixels to device pixels, which is what a scene
 * overlay receives.
 */

import { meanPolygonSize, polygonContains, type PolygonSet } from './polygon-set.js';
import { SpatialIndex } from './spatial-index.js';
import type { BucketPlan, CellShow } from './cell-style.js';
import { planNone } from './cell-style.js';

const NUCLEUS_OUTLINE = '#6cc8ff';
const CELL_OUTLINE = '#ffffff';
const SELECTED_OUTLINE = '#ffd400';
/** Below this many device pixels across, polygons are drawn as dots. */
const DOT_SIZE = 3;
const MAX_POLYGONS = 120_000;

export interface CellsLayerOptions {
	cells: PolygonSet;
	nuclei?: PolygonSet | null;
	rowCount: number;
	/** Ask the host to redraw. */
	invalidate: () => void;
	onSelectionChange?: () => void;
	/** Extra text for the cursor readout, for a row. */
	describeRow?: (row: number) => string;
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

	constructor(private readonly options: CellsLayerOptions) {
		this.cells = prepare(options.cells);
		this.nuclei = options.nuclei && options.nuclei.count > 0 ? prepare(options.nuclei) : null;
		this.plan = planNone(options.rowCount);
	}

	hasNuclei(): boolean { return this.nuclei !== null; }
	getShow(): CellShow { return this.show; }
	setShow(show: CellShow): void { this.show = show; this.options.invalidate(); }
	setPlan(plan: BucketPlan): void { this.plan = plan; this.options.invalidate(); }
	setOpacity(opacity: number): void { this.opacity = opacity; this.options.invalidate(); }
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
		const [x0, y0, x1, y1] = this.visibleRect(context);
		const visible = primary.index.visible(x0, y0, x1, y1, this.scratch);
		context.save();
		context.lineJoin = 'round';
		const dots = primary.meanSize * scale < DOT_SIZE || visible.length > MAX_POLYGONS;
		const groups = new Map<number, number[]>();
		for (const polygon of visible) {
			const row = primary.set.rows[polygon];
			const bucket = row >= 0 ? this.plan.bucket[row] : 0;
			if (bucket === 0) { continue; }
			const list = groups.get(bucket);
			if (list) { list.push(polygon); } else { groups.set(bucket, [polygon]); }
		}
		if (dots) { this.drawDots(context, primary, groups, scale); }
		else { this.drawPolygons(context, primary, groups, scale); }
		if (this.show === 'both' && this.nuclei && !dots) { this.drawNuclei(context, this.nuclei, x0, y0, x1, y1, scale); }
		if (!dots || this.selected.size < 200) { this.drawSelection(context, primary, scale); }
		context.restore();
	}

	private drawDots(context: CanvasRenderingContext2D, primary: Prepared, groups: Map<number, number[]>, scale: number): void {
		const size = Math.max(DOT_SIZE / scale, primary.meanSize * 0.8);
		context.globalAlpha = this.plan.fill ? Math.max(this.opacity, 0.7) : 0.9;
		for (const [bucket, polygons] of groups) {
			context.fillStyle = this.plan.fill ? this.plan.colors[bucket - 1] : CELL_OUTLINE;
			context.beginPath();
			for (const polygon of polygons) {
				const at = polygon * 4;
				context.rect((primary.set.bounds[at] + primary.set.bounds[at + 2]) / 2 - size / 2, (primary.set.bounds[at + 1] + primary.set.bounds[at + 3]) / 2 - size / 2, size, size);
			}
			context.fill();
		}
	}

	private tracePolygon(path: Path2D, set: PolygonSet, polygon: number): void {
		const start = set.offsets[polygon], end = set.offsets[polygon + 1];
		path.moveTo(set.xy[start * 2], set.xy[start * 2 + 1]);
		for (let vertex = start + 1; vertex < end; vertex++) { path.lineTo(set.xy[vertex * 2], set.xy[vertex * 2 + 1]); }
		path.closePath();
	}

	private drawPolygons(context: CanvasRenderingContext2D, primary: Prepared, groups: Map<number, number[]>, scale: number): void {
		context.lineWidth = 1 / scale;
		for (const [bucket, polygons] of groups) {
			const path = new Path2D();
			for (const polygon of polygons) { this.tracePolygon(path, primary.set, polygon); }
			if (this.plan.fill) {
				context.globalAlpha = this.opacity;
				context.fillStyle = this.plan.colors[bucket - 1];
				context.fill(path);
			}
			context.globalAlpha = this.plan.fill ? 0.85 : 0.9;
			context.strokeStyle = primary.set === this.nuclei?.set ? NUCLEUS_OUTLINE : CELL_OUTLINE;
			context.stroke(path);
		}
	}

	private drawNuclei(context: CanvasRenderingContext2D, nuclei: Prepared, x0: number, y0: number, x1: number, y1: number, scale: number): void {
		const visible = nuclei.index.visible(x0, y0, x1, y1, []);
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

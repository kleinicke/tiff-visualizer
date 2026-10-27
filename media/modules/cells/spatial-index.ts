import type { PolygonSet } from './polygon-set.js';

/** Uniform grid over polygon bounds: view culling and click picking. */
export class SpatialIndex {
	private readonly minX: number;
	private readonly minY: number;
	private readonly cellSize: number;
	private readonly columns: number;
	private readonly rowsCount: number;
	private readonly starts: Uint32Array;
	private readonly items: Uint32Array;
	private readonly stamp: Uint32Array;
	private query = 0;

	constructor(set: PolygonSet) {
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (let polygon = 0; polygon < set.count; polygon++) {
			minX = Math.min(minX, set.bounds[polygon * 4]);
			minY = Math.min(minY, set.bounds[polygon * 4 + 1]);
			maxX = Math.max(maxX, set.bounds[polygon * 4 + 2]);
			maxY = Math.max(maxY, set.bounds[polygon * 4 + 3]);
		}
		if (!Number.isFinite(minX)) { minX = minY = 0; maxX = maxY = 1; }
		const width = Math.max(1e-6, maxX - minX), height = Math.max(1e-6, maxY - minY);
		const target = Math.max(1, Math.round(set.count / 3));
		this.cellSize = Math.max(Math.sqrt(width * height / target), 1e-3);
		this.columns = Math.max(1, Math.min(4096, Math.ceil(width / this.cellSize)));
		this.rowsCount = Math.max(1, Math.min(4096, Math.ceil(height / this.cellSize)));
		this.cellSize = Math.max(width / this.columns, height / this.rowsCount);
		this.minX = minX;
		this.minY = minY;
		this.stamp = new Uint32Array(set.count);
		const counts = new Uint32Array(this.columns * this.rowsCount + 1);
		const spans: number[] = [];
		for (let polygon = 0; polygon < set.count; polygon++) {
			const [c0, r0, c1, r1] = this.span(set.bounds[polygon * 4], set.bounds[polygon * 4 + 1], set.bounds[polygon * 4 + 2], set.bounds[polygon * 4 + 3]);
			spans.push(c0, r0, c1, r1);
			for (let r = r0; r <= r1; r++) { for (let c = c0; c <= c1; c++) { counts[r * this.columns + c + 1]++; } }
		}
		for (let i = 1; i < counts.length; i++) { counts[i] += counts[i - 1]; }
		this.starts = counts;
		this.items = new Uint32Array(counts[counts.length - 1]);
		const fill = counts.slice(0, -1);
		for (let polygon = 0; polygon < set.count; polygon++) {
			const at = polygon * 4;
			for (let r = spans[at + 1]; r <= spans[at + 3]; r++) { for (let c = spans[at]; c <= spans[at + 2]; c++) { this.items[fill[r * this.columns + c]++] = polygon; } }
		}
	}

	private span(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
		const clampColumn = (value: number) => Math.max(0, Math.min(this.columns - 1, Math.floor((value - this.minX) / this.cellSize)));
		const clampRow = (value: number) => Math.max(0, Math.min(this.rowsCount - 1, Math.floor((value - this.minY) / this.cellSize)));
		return [clampColumn(x0), clampRow(y0), clampColumn(x1), clampRow(y1)];
	}

	/** Polygons whose grid cells overlap the rectangle (a superset of the exact overlap). */
	visible(x0: number, y0: number, x1: number, y1: number, out: number[] = []): number[] {
		out.length = 0;
		this.query++;
		const [c0, r0, c1, r1] = this.span(x0, y0, x1, y1);
		for (let r = r0; r <= r1; r++) {
			for (let c = c0; c <= c1; c++) {
				const cell = r * this.columns + c;
				for (let at = this.starts[cell]; at < this.starts[cell + 1]; at++) {
					const polygon = this.items[at];
					if (this.stamp[polygon] !== this.query) { this.stamp[polygon] = this.query; out.push(polygon); }
				}
			}
		}
		return out;
	}
}

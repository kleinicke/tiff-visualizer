import { derivedColumn, findColumn, type CellTable } from './cell-table.js';
import { polygonArea, polygonPerimeter, type PolygonSet } from './polygon-set.js';

/** Measurements that come from the outlines themselves; micron units when the size is known. */
export function addShapeColumns(table: CellTable, set: PolygonSet, pixelSizeUm: number): void {
	const perRow = (compute: (polygon: number) => number): ((row: number) => number) => {
		const values = new Float64Array(table.count).fill(NaN);
		// A cell drawn as several polygons measures as their sum.
		for (let polygon = 0; polygon < set.count; polygon++) {
			const row = set.rows[polygon];
			if (row >= 0) { values[row] = (Number.isNaN(values[row]) ? 0 : values[row]) + compute(polygon); }
		}
		return row => values[row];
	};
	const area = perRow(polygon => polygonArea(set, polygon) * pixelSizeUm * pixelSizeUm);
	const perimeter = perRow(polygon => polygonPerimeter(set, polygon) * pixelSizeUm);
	table.columns.push(
		derivedColumn('outline_area_um2', table, area),
		derivedColumn('outline_perimeter_um', table, perimeter),
		derivedColumn('circularity', table, row => {
			const length = perimeter(row);
			return length > 0 ? Math.min(1, 4 * Math.PI * area(row) / (length * length)) : NaN;
		}),
	);
	const cell = findColumn(table, 'cell_area'), nucleus = findColumn(table, 'nucleus_area');
	if (cell?.kind === 'continuous' && nucleus?.kind === 'continuous') {
		table.columns.push(derivedColumn('nucleus_to_cell_area', table, row => cell.values[row] > 0 ? nucleus.values[row] / cell.values[row] : NaN));
	}
}

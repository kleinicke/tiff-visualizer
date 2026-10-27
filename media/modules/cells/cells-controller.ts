/**
 * Owns the Cells section state (what to show, which metric, category and
 * range choices) and keeps the layer's colours in step with it. Independent
 * of Xenium: any viewer that can build a polygon set and a table can use it.
 */

import { getColormapLut, COLORMAP_NAMES } from '../colormaps.js';
import { findColumn, formatValue, formatNumber, type CellColumn, type CellTable, type ContinuousColumn, type DiscreteColumn, histogram } from './cell-table.js';
import { categoryColor, planContinuous, planDiscrete, planNone, type CellShow } from './cell-style.js';
import type { CellsLayer } from './cells-layer.js';
import type { CellsModel, CellsSelectionRow } from './cells-model.js';

const MAX_LEGEND_ROWS = 60;
const MAX_SELECTION_ROWS = 60;
const HISTOGRAM_BINS = 40;

interface DiscreteState { enabled: boolean[]; colors: string[] }
interface ContinuousState { low: number; high: number; colormap: string }

export interface CellsControllerState {
	show: CellShow;
	metric: string | null;
	opacity: number;
}

export class CellsController {
	private show: CellShow = 'cells';
	private metric: string | null = null;
	private opacity = 0.55;
	private readonly discrete = new Map<string, DiscreteState>();
	private readonly continuous = new Map<string, ContinuousState>();

	constructor(
		private readonly table: CellTable,
		private readonly layer: CellsLayer,
		/** Re-render the panel after a change. */
		private readonly notify: () => void,
		initial?: Partial<CellsControllerState>,
	) {
		if (initial?.show) { this.show = initial.show; }
		if (initial?.metric !== undefined && (initial.metric === null || findColumn(table, initial.metric))) { this.metric = initial.metric; }
		if (typeof initial?.opacity === 'number') { this.opacity = initial.opacity; }
		this.layer.setShow(this.show);
		this.layer.setOpacity(this.opacity);
		this.apply();
	}

	getState(): CellsControllerState { return { show: this.show, metric: this.metric, opacity: this.opacity }; }

	private discreteState(column: DiscreteColumn): DiscreteState {
		let state = this.discrete.get(column.name);
		if (!state) {
			state = { enabled: column.labels.map(() => true), colors: column.labels.map((_label, index) => categoryColor(index)) };
			this.discrete.set(column.name, state);
		}
		return state;
	}

	private continuousState(column: ContinuousColumn): ContinuousState {
		let state = this.continuous.get(column.name);
		if (!state) {
			const low = Number.isFinite(column.low) ? column.low : column.min;
			const high = Number.isFinite(column.high) && column.high > low ? column.high : column.max;
			state = { low, high, colormap: 'viridis' };
			this.continuous.set(column.name, state);
		}
		return state;
	}

	private apply(): void {
		const column = findColumn(this.table, this.metric);
		if (!column) { this.layer.setPlan(planNone(this.table.count)); return; }
		if (column.kind === 'discrete') {
			const state = this.discreteState(column);
			this.layer.setPlan(planDiscrete(column, state.enabled, state.colors));
		} else {
			const state = this.continuousState(column);
			this.layer.setPlan(planContinuous(column, state.low, state.high, getColormapLut(state.colormap)));
		}
	}

	private change(): void { this.apply(); this.notify(); }

	private selectionSummary(): CellsModel['selection'] {
		const rows = this.layer.selectedRows();
		if (rows.length === 0) { return null; }
		const out: CellsSelectionRow[] = [];
		if (rows.length === 1) {
			const row = rows[0];
			out.push({ label: 'cell_id', value: this.table.ids[row] });
			for (const column of this.table.columns) { if (out.length < MAX_SELECTION_ROWS) { out.push({ label: column.name, value: formatValue(column, row) }); } }
			return { count: 1, title: this.table.ids[row], rows: out };
		}
		for (const column of this.table.columns) {
			if (out.length >= MAX_SELECTION_ROWS) { break; }
			out.push({ label: column.name, value: summarize(column, rows) });
		}
		return { count: rows.length, title: `${rows.length} cells`, rows: out };
	}

	snapshot(): CellsModel {
		const column = findColumn(this.table, this.metric);
		let discrete: CellsModel['discrete'] = null;
		let continuous: CellsModel['continuous'] = null;
		if (column?.kind === 'discrete') {
			const state = this.discreteState(column);
			const shown = Math.min(column.labels.length, MAX_LEGEND_ROWS);
			discrete = {
				rows: column.labels.slice(0, shown).map((label, index) => ({ label, count: column.counts[index], color: state.colors[index], enabled: state.enabled[index] })),
				more: column.labels.length - shown,
			};
		} else if (column?.kind === 'continuous') {
			const state = this.continuousState(column);
			continuous = {
				min: column.min, max: column.max, low: state.low, high: state.high, colormap: state.colormap, colormaps: COLORMAP_NAMES,
				histogram: histogram(column.values, column.min, column.max, HISTOGRAM_BINS),
			};
		}
		return {
			status: null, count: this.table.count, hasNuclei: this.layer.hasNuclei(), show: this.show, metric: this.metric,
			metrics: this.table.columns.map(entry => ({ name: entry.name, kind: entry.kind })), opacity: this.opacity, discrete, continuous,
			selection: this.selectionSummary(),
			setShow: show => { this.show = show; this.layer.setShow(show); this.notify(); },
			setMetric: name => { this.metric = name; this.change(); },
			setOpacity: opacity => { this.opacity = opacity; this.layer.setOpacity(opacity); this.notify(); },
			setCategory: (label, patch) => {
				const target = findColumn(this.table, this.metric);
				if (target?.kind !== 'discrete') { return; }
				const index = target.labels.indexOf(label);
				if (index < 0) { return; }
				const state = this.discreteState(target);
				if (patch.enabled !== undefined) { state.enabled[index] = patch.enabled; }
				if (patch.color) { state.colors[index] = patch.color; }
				this.change();
			},
			setAllCategories: enabled => {
				const target = findColumn(this.table, this.metric);
				if (target?.kind !== 'discrete') { return; }
				this.discreteState(target).enabled.fill(enabled);
				this.change();
			},
			setRange: (low, high) => {
				const target = findColumn(this.table, this.metric);
				if (target?.kind !== 'continuous') { return; }
				const state = this.continuousState(target);
				state.low = Math.min(low, high);
				state.high = Math.max(low, high);
				this.change();
			},
			setColormap: name => {
				const target = findColumn(this.table, this.metric);
				if (target?.kind !== 'continuous') { return; }
				this.continuousState(target).colormap = name;
				this.change();
			},
			clearSelection: () => this.layer.clearSelection(),
		};
	}
}

function summarize(column: CellColumn, rows: number[]): string {
	if (column.kind === 'continuous') {
		let sum = 0, seen = 0;
		for (const row of rows) { const value = column.values[row]; if (Number.isFinite(value)) { sum += value; seen++; } }
		return seen ? `mean ${formatNumber(sum / seen)}` : '—';
	}
	const tally = new Map<number, number>();
	for (const row of rows) { const code = column.codes[row]; if (code >= 0) { tally.set(code, (tally.get(code) ?? 0) + 1); } }
	if (tally.size === 0) { return '—'; }
	const [code] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
	return tally.size === 1 ? column.labels[code] : `${column.labels[code]} +${tally.size - 1} more`;
}

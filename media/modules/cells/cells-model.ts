/** What the Cells section shows and can do; the Svelte components only see this. */

import type { CellShow } from './cell-style.js';

export interface CellsMetricOption { name: string; kind: 'discrete' | 'continuous' }

export interface CellsDiscreteRow { label: string; count: number; color: string; enabled: boolean }

export interface CellsSelectionRow { label: string; value: string }

/** The display controls of one cell set: outlines, Colour by, legend or range, and the selection. */
export interface CellsModel {
	count: number;
	hasNuclei: boolean;
	show: CellShow;
	metric: string | null;
	metrics: CellsMetricOption[];
	opacity: number;
	discrete: { rows: CellsDiscreteRow[]; more: number } | null;
	continuous: { min: number; max: number; low: number; high: number; histogram: number[]; colormap: string; colormaps: string[] } | null;
	selection: { count: number; title: string; rows: CellsSelectionRow[] } | null;
	setShow: (show: CellShow) => void;
	setMetric: (name: string | null) => void;
	setOpacity: (opacity: number) => void;
	setCategory: (label: string, patch: { enabled?: boolean; color?: string }) => void;
	setAllCategories: (enabled: boolean) => void;
	setRange: (low: number, high: number) => void;
	setColormap: (name: string) => void;
	clearSelection: () => void;
}

/** A table file belonging to one cell set. */
export interface CellsTableRow {
	id: string;
	name: string;
	/** Where it comes from, for the tooltip. */
	path: string;
	origin: 'settings' | 'added';
	state: 'available' | 'loading' | 'loaded' | 'missing' | 'error';
	/** Columns added and cells matched, or the reason for a failure. */
	detail: string;
}

/** One loaded cell set: a panel of its own, like a channel. */
export interface CellSetModel {
	id: string;
	name: string;
	/** Where it comes from, for the tooltip. */
	path: string;
	origin: 'native' | 'settings' | 'added';
	color: string;
	visible: boolean;
	count: number;
	tables: CellsTableRow[];
	/** The last failure to add a table by path, or null. */
	tableMessage: string | null;
	view: CellsModel;
	setVisible: (visible: boolean) => void;
	setColor: (color: string) => void;
	remove: () => void;
	addTable: (text: string) => void;
	browseTable: () => void;
	loadTable: (tableId: string) => void;
	removeTable: (tableId: string) => void;
}

/** A boundaries file that is listed but not loaded (yet). */
export interface CellsPendingRow {
	id: string;
	name: string;
	path: string;
	origin: 'settings' | 'added';
	state: 'available' | 'loading' | 'missing' | 'error';
	detail: string;
}

/** The whole Cells section. */
export interface CellsPanelModel {
	/** Progress or failure text for the bundle's own cells, shown while there are no cell sets. */
	status: string | null;
	sets: CellSetModel[];
	pending: CellsPendingRow[];
	/** The last failure to add a file by path, or null. */
	sourceMessage: string | null;
	addSource: (text: string) => void;
	browseSource: () => void;
	loadSource: (id: string) => void;
	removeSource: (id: string) => void;
}

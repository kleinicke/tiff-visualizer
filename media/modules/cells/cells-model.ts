/** What the Cells section shows and can do; the Svelte components only see this. */

import type { CellShow } from './cell-style.js';

export interface CellsMetricOption { name: string; kind: 'discrete' | 'continuous' }

export interface CellsDiscreteRow { label: string; count: number; color: string; enabled: boolean }

export interface CellsSelectionRow { label: string; value: string }

/** One entry in the Segmentations list: a segmentation, or a table merged into one. */
export interface CellsSourceRow {
	id: string;
	name: string;
	kind: 'segmentation' | 'table';
	/** Where it comes from, for the tooltip. */
	path: string;
	origin: 'native' | 'settings' | 'added';
	state: 'available' | 'loading' | 'loaded' | 'missing' | 'error';
	/** Cell count, match count or the reason for a failure. */
	detail: string;
	visible: boolean;
	active: boolean;
	color: string;
}

export interface CellsModel {
	/** Progress or failure text while there is nothing to control yet. */
	status: string | null;
	count: number;
	hasNuclei: boolean;
	show: CellShow;
	metric: string | null;
	metrics: CellsMetricOption[];
	opacity: number;
	discrete: { rows: CellsDiscreteRow[]; more: number } | null;
	continuous: { min: number; max: number; low: number; high: number; histogram: number[]; colormap: string; colormaps: string[] } | null;
	selection: { count: number; title: string; rows: CellsSelectionRow[] } | null;
	sources: CellsSourceRow[];
	/** The last failure to add a file by path, or null. */
	sourceMessage: string | null;
	addSource: (text: string) => void;
	browseSource: () => void;
	loadSource: (id: string) => void;
	removeSource: (id: string) => void;
	activateSource: (id: string) => void;
	showSource: (id: string, visible: boolean) => void;
	colorSource: (id: string, color: string) => void;
	setShow: (show: CellShow) => void;
	setMetric: (name: string | null) => void;
	setOpacity: (opacity: number) => void;
	setCategory: (label: string, patch: { enabled?: boolean; color?: string }) => void;
	setAllCategories: (enabled: boolean) => void;
	setRange: (low: number, high: number) => void;
	setColormap: (name: string) => void;
	clearSelection: () => void;
}

const nothing = (): void => undefined;

/** A section with nothing to control: loading, or the reason it is unavailable. */
export function statusCellsModel(status: string): CellsModel {
	return {
		status, count: 0, hasNuclei: false, show: 'cells', metric: null, metrics: [], opacity: 0.55,
		discrete: null, continuous: null, selection: null,
		sources: [], sourceMessage: null,
		addSource: nothing, browseSource: nothing, loadSource: nothing, removeSource: nothing,
		activateSource: nothing, showSource: nothing, colorSource: nothing,
		setShow: nothing, setMetric: nothing, setOpacity: nothing, setCategory: nothing,
		setAllCategories: nothing, setRange: nothing, setColormap: nothing, clearSelection: nothing,
	};
}

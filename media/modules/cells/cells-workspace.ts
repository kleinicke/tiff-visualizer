/**
 * The cell sets shown over an image. Each set is a segmentation (outlines
 * plus its own table) with its own display controls, like a channel; table
 * files are merged into one set by cell id and listed under it.
 *
 * Independent of Xenium: the viewer supplies loading, overlays and messaging
 * through `CellsWorkspaceHost`.
 */

import type { CellTable } from './cell-table.js';
import { findColumn, formatValue } from './cell-table.js';
import { dropColumns, mergeTable } from './cells-merge.js';
import { CellsController, type CellsControllerState } from './cells-controller.js';
import { CELL_OUTLINE, CellsLayer } from './cells-layer.js';
import type { CellSetModel, CellsPanelModel, CellsPendingRow, CellsTableRow } from './cells-model.js';
import type { PolygonSet } from './polygon-set.js';

/** A file the host has located. */
export interface WorkspaceFile {
	name: string;
	kind: 'table' | 'boundaries' | 'unknown';
	path: string;
	found: boolean;
	/** For a configured table: the name of the one cell set it belongs to. */
	parent?: string;
	src?: string;
	bytes?: ArrayBuffer;
}

export type LoadedFile =
	| { kind: 'table'; table: CellTable }
	| { kind: 'boundaries'; table: CellTable; cells: PolygonSet };

export interface CellsWorkspaceHost {
	load(file: WorkspaceFile): Promise<LoadedFile>;
	/** Locate a typed path. Rejects with a message for the user. */
	resolve(text: string): Promise<WorkspaceFile>;
	/** Show the file dialog; null when cancelled. */
	browse(): Promise<WorkspaceFile | null>;
	addOverlay(layer: CellsLayer): void;
	removeOverlay(layer: CellsLayer): void;
	requestRender(): void;
	/** Re-render the panel and save state. */
	notify(): void;
}

export interface PersistedCellSource { path: string; origin: 'settings' | 'added'; loaded: boolean }
export interface PersistedCellTable { set: string; path: string; origin: 'settings' | 'added'; loaded: boolean }
export interface CellsWorkspaceState { native?: CellsControllerState; sources?: PersistedCellSource[]; tables?: PersistedCellTable[] }

const PALETTE = ['#ff9f43', '#1dd1a1', '#ff6b9d', '#a29bfe', '#feca57', '#48dbfb'];

type State = 'available' | 'loading' | 'loaded' | 'missing' | 'error';

interface Segmentation { table: CellTable; layer: CellsLayer; controller: CellsController }

interface TableEntry {
	id: string;
	name: string;
	file: WorkspaceFile;
	origin: 'native' | 'settings' | 'added';
	state: State;
	detail: string;
	columns: string[];
}

interface Entry {
	id: string;
	name: string;
	file: WorkspaceFile | null;
	origin: 'native' | 'settings' | 'added';
	state: State;
	detail: string;
	color: string;
	visible: boolean;
	segmentation: Segmentation | null;
	tables: TableEntry[];
	tableMessage: string | null;
}

const missing = (file: WorkspaceFile): string => `Not found: ${file.path}`;

export class CellsWorkspace {
	private readonly entries: Entry[] = [];
	private readonly configuredTables: WorkspaceFile[] = [];
	private counter = 0;
	private message: string | null = null;

	constructor(private readonly host: CellsWorkspaceHost, private readonly pixelSizeUm: number) { }

	// --- building the lists -------------------------------------------------

	private uniqueName(wanted: string, taken: readonly string[]): string {
		let name = wanted, suffix = 2;
		while (taken.includes(name)) { name = `${wanted} (${suffix++})`; }
		return name;
	}

	private makeEntry(file: WorkspaceFile | null, name: string, origin: Entry['origin']): Entry {
		const entry: Entry = {
			id: `set-${++this.counter}`, name: this.uniqueName(name, this.entries.map(candidate => candidate.name)), file, origin,
			state: file && !file.found ? 'missing' : 'available', detail: file && !file.found ? missing(file) : '',
			color: PALETTE[this.entries.length % PALETTE.length], visible: true, segmentation: null, tables: [], tableMessage: null,
		};
		this.entries.push(entry);
		return entry;
	}

	private makeTable(entry: Entry, file: WorkspaceFile, origin: TableEntry['origin'], state?: { state: State; detail: string }): TableEntry {
		const table: TableEntry = {
			id: `table-${++this.counter}`, name: this.uniqueName(file.name, entry.tables.map(candidate => candidate.name)), file, origin,
			state: state?.state ?? (file.found ? 'available' : 'missing'), detail: state?.detail ?? (file.found ? '' : missing(file)), columns: [],
		};
		entry.tables.push(table);
		return table;
	}

	/** The cell set the bundle itself provides. */
	addNative(name: string, loaded: { table: CellTable; cells: PolygonSet; nuclei: PolygonSet | null }, restored?: CellsControllerState): void {
		const entry = this.makeEntry(null, name, 'native');
		entry.color = CELL_OUTLINE;
		entry.state = 'loaded';
		this.attach(entry, loaded.table, loaded.cells, loaded.nuclei, restored);
		// The native set goes first in the list however late it finishes loading.
		this.entries.splice(this.entries.indexOf(entry), 1);
		this.entries.unshift(entry);
	}

	/** Files from the settings: boundaries are listed to load; each table is offered under its parent cell set only. */
	addConfigured(files: readonly WorkspaceFile[]): void {
		for (const file of files) {
			if (file.kind === 'table') { this.configuredTables.push(file); }
			else { this.makeEntry(file, file.name, 'settings'); }
		}
	}

	private attach(entry: Entry, table: CellTable, cells: PolygonSet, nuclei: PolygonSet | null, restored?: CellsControllerState): void {
		const layer: CellsLayer = new CellsLayer({
			cells, nuclei, rowCount: table.count, outline: entry.color,
			invalidate: () => this.host.requestRender(),
			onSelectionChange: () => this.selectionChanged(entry),
			describeRow: row => {
				const column = findColumn(table, controller.getState().metric);
				return column ? `${entry.name} · ${table.ids[row]} · ${column.name} ${formatValue(column, row)}` : `${entry.name} · ${table.ids[row]}`;
			},
		});
		const controller: CellsController = new CellsController(table, layer, () => this.host.notify(), restored);
		entry.segmentation = { table, layer, controller };
		entry.tables = [];
		if (entry.origin === 'native') {
			this.makeTable(entry, { name: 'cells', kind: 'table', path: 'cells.parquet', found: true }, 'native', { state: 'loaded', detail: `${table.count.toLocaleString()} cells` });
		}
		for (const file of this.configuredTables) { if (file.parent === entry.name) { this.makeTable(entry, file, 'settings'); } }
		layer.setHidden(!entry.visible);
		this.host.addOverlay(layer);
	}

	/** Selecting in one set clears the others. */
	private selectionChanged(entry: Entry): void {
		if (entry.segmentation && entry.segmentation.layer.selectedRows().length > 0) {
			for (const other of this.entries) { if (other !== entry) { other.segmentation?.layer.clearSelection(); } }
		}
		this.host.notify();
	}

	// --- saving and restoring ------------------------------------------------

	getState(): CellsWorkspaceState {
		return {
			native: this.entries.find(entry => entry.origin === 'native')?.segmentation?.controller.getState(),
			sources: this.entries.filter(entry => entry.file && entry.origin !== 'native').map(entry => ({
				path: entry.file!.path, origin: entry.origin as 'settings' | 'added', loaded: entry.state === 'loaded',
			})),
			tables: this.entries.flatMap(entry => entry.tables.filter(table => table.origin !== 'native').map(table => ({
				set: entry.name, path: table.file.path, origin: table.origin as 'settings' | 'added', loaded: table.state === 'loaded',
			}))),
		};
	}

	/** Bring back what an earlier session of this editor had loaded or added. */
	async restore(state: CellsWorkspaceState | undefined): Promise<void> {
		for (const item of state?.sources ?? []) {
			try {
				let entry = item.origin === 'settings' ? this.entries.find(candidate => candidate.origin === 'settings' && candidate.file?.path === item.path) : undefined;
				if (!entry && item.origin === 'added') {
					const file = await this.host.resolve(item.path);
					entry = this.makeEntry({ ...file, kind: 'boundaries' }, file.name, 'added');
				}
				if (entry && item.loaded) { await this.load(entry.id); }
			} catch { /* a file that has gone is simply not listed */ }
		}
		for (const item of state?.tables ?? []) {
			try {
				const entry = this.entries.find(candidate => candidate.name === item.set && candidate.segmentation);
				if (!entry) { continue; }
				let table = entry.tables.find(candidate => candidate.file.path === item.path);
				if (!table && item.origin === 'added') {
					const file = await this.host.resolve(item.path);
					table = this.makeTable(entry, { ...file, kind: 'table' }, 'added');
				}
				if (table && item.loaded) { await this.loadTable(entry, table); }
			} catch { /* as above */ }
		}
		this.host.notify();
	}

	// --- actions --------------------------------------------------------------

	private async load(id: string): Promise<void> {
		const entry = this.entries.find(candidate => candidate.id === id);
		if (!entry?.file || entry.state === 'loading' || entry.state === 'loaded' || !entry.file.found) { return; }
		this.message = null;
		entry.state = 'loading';
		entry.detail = 'Loading…';
		this.host.notify();
		try {
			const loaded = await this.host.load({ ...entry.file, kind: 'boundaries' });
			if (loaded.kind !== 'boundaries') { throw new Error('This file is a table, not a boundaries file.'); }
			this.attach(entry, loaded.table, loaded.cells, null);
			entry.state = 'loaded';
			entry.detail = `${loaded.table.count.toLocaleString()} cells`;
		} catch (error) {
			entry.state = 'error';
			entry.detail = error instanceof Error ? error.message : String(error);
		}
		this.host.notify();
	}

	private async loadTable(entry: Entry, table: TableEntry): Promise<void> {
		if (!entry.segmentation || table.state === 'loading' || table.state === 'loaded' || !table.file.found) { return; }
		entry.tableMessage = null;
		table.state = 'loading';
		table.detail = 'Loading…';
		this.host.notify();
		try {
			const loaded = await this.host.load({ ...table.file, kind: 'table' });
			if (loaded.kind !== 'table') { throw new Error('This file is a boundaries file, not a table.'); }
			const result = mergeTable(entry.segmentation.table, loaded.table, table.name);
			if (result.matched === 0) { throw new Error(`None of its ${result.total.toLocaleString()} cell ids match ${entry.name}.`); }
			table.columns = result.added;
			table.state = 'loaded';
			table.detail = `${result.added.length} columns · ${result.matched.toLocaleString()} of ${result.total.toLocaleString()} cells matched`;
		} catch (error) {
			table.state = 'error';
			table.detail = error instanceof Error ? error.message : String(error);
		}
		this.host.notify();
	}

	private unloadTable(entry: Entry, table: TableEntry): void {
		if (entry.segmentation && table.columns.length) {
			dropColumns(entry.segmentation.table, table.columns);
			entry.segmentation.controller.forgetMetrics(table.columns);
		}
		table.columns = [];
		table.state = table.file.found ? 'available' : 'missing';
		table.detail = table.file.found ? '' : missing(table.file);
	}

	private removeTable(entry: Entry, tableId: string): void {
		const table = entry.tables.find(candidate => candidate.id === tableId);
		if (!table || table.origin === 'native') { return; }
		this.unloadTable(entry, table);
		if (table.origin === 'added') { entry.tables.splice(entry.tables.indexOf(table), 1); }
		this.host.notify();
	}

	private removeSet(entry: Entry): void {
		if (entry.origin === 'native') { return; }
		if (entry.segmentation) { this.host.removeOverlay(entry.segmentation.layer); entry.segmentation = null; }
		entry.tables = [];
		if (entry.origin === 'added') { this.entries.splice(this.entries.indexOf(entry), 1); }
		else { entry.state = entry.file?.found === false ? 'missing' : 'available'; entry.detail = entry.file?.found === false ? missing(entry.file) : ''; }
		this.host.notify();
	}

	private async addBoundaries(promise: Promise<WorkspaceFile | null>): Promise<void> {
		this.message = null;
		try {
			const file = await promise;
			if (!file) { return; }
			const entry = this.makeEntry({ ...file, kind: 'boundaries' }, file.name, 'added');
			this.host.notify();
			await this.load(entry.id);
		} catch (error) {
			this.message = error instanceof Error ? error.message : String(error);
			this.host.notify();
		}
	}

	private async addTable(entry: Entry, promise: Promise<WorkspaceFile | null>): Promise<void> {
		entry.tableMessage = null;
		try {
			const file = await promise;
			if (!file) { return; }
			const table = this.makeTable(entry, { ...file, kind: 'table' }, 'added');
			this.host.notify();
			await this.loadTable(entry, table);
		} catch (error) {
			entry.tableMessage = error instanceof Error ? error.message : String(error);
			this.host.notify();
		}
	}

	// --- what the panel sees ---------------------------------------------------

	private tableRows(entry: Entry): CellsTableRow[] {
		return entry.tables.map(table => ({ id: table.id, name: table.name, path: table.file.path, origin: table.origin, state: table.state, detail: table.detail }));
	}

	private setModel(entry: Entry): CellSetModel {
		const segmentation = entry.segmentation!;
		return {
			id: entry.id, name: entry.name, path: entry.file?.path ?? 'This bundle', origin: entry.origin, color: entry.color, visible: entry.visible,
			count: segmentation.table.count, tables: this.tableRows(entry), tableMessage: entry.tableMessage, view: segmentation.controller.snapshot(),
			setVisible: visible => { entry.visible = visible; segmentation.layer.setHidden(!visible); this.host.notify(); },
			setColor: color => { entry.color = color; segmentation.layer.setOutline(color); this.host.notify(); },
			remove: () => this.removeSet(entry),
			addTable: text => { if (text.trim()) { void this.addTable(entry, this.host.resolve(text)); } },
			browseTable: () => { void this.addTable(entry, this.host.browse()); },
			loadTable: tableId => { const table = entry.tables.find(candidate => candidate.id === tableId); if (table) { void this.loadTable(entry, table); } },
			removeTable: tableId => this.removeTable(entry, tableId),
		};
	}

	snapshot(status: string | null): CellsPanelModel {
		const pending: CellsPendingRow[] = this.entries.filter(entry => !entry.segmentation && entry.origin !== 'native').map(entry => ({
			id: entry.id, name: entry.name, path: entry.file?.path ?? '', origin: entry.origin as 'settings' | 'added',
			state: entry.state === 'loaded' ? 'available' : entry.state, detail: entry.detail,
		}));
		return {
			status,
			sets: this.entries.filter(entry => entry.segmentation).map(entry => this.setModel(entry)),
			pending, sourceMessage: this.message,
			addSource: text => { if (text.trim()) { void this.addBoundaries(this.host.resolve(text)); } },
			browseSource: () => { void this.addBoundaries(this.host.browse()); },
			loadSource: id => { void this.load(id); },
			removeSource: id => {
				const entry = this.entries.find(candidate => candidate.id === id);
				if (entry?.origin === 'added' && !entry.segmentation) { this.entries.splice(this.entries.indexOf(entry), 1); this.host.notify(); }
			},
		};
	}

	/** Esc: clear the selection everywhere. */
	clearSelection(): void { for (const entry of this.entries) { entry.segmentation?.layer.clearSelection(); } }
}

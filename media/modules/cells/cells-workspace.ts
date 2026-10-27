/**
 * The segmentations shown over an image and the tables merged into them.
 * Independent of Xenium: the viewer supplies loading, overlays and messaging
 * through `CellsWorkspaceHost`.
 *
 * One segmentation is active at a time; the Cells section shows its Colour by,
 * legend and measurements. A table-only file is merged (by cell id) into the
 * segmentation that is active when it is loaded.
 */

import type { CellTable } from './cell-table.js';
import { dropColumns, mergeTable } from './cells-merge.js';
import { CellsController, type CellsControllerState } from './cells-controller.js';
import { CELL_OUTLINE, CellsLayer } from './cells-layer.js';
import { statusCellsModel, type CellsModel, type CellsSourceRow } from './cells-model.js';
import { findColumn, formatValue } from './cell-table.js';
import type { PolygonSet } from './polygon-set.js';

/** A file the host has located. */
export interface WorkspaceFile {
	name: string;
	kind: 'table' | 'boundaries' | 'unknown';
	path: string;
	found: boolean;
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

export interface PersistedCellSource { path: string; kind: 'table' | 'boundaries' | 'unknown'; loaded: boolean }

export interface CellsWorkspaceState { native?: CellsControllerState; added: PersistedCellSource[] }

const PALETTE = ['#ff9f43', '#1dd1a1', '#ff6b9d', '#a29bfe', '#feca57', '#48dbfb'];

interface Segmentation {
	table: CellTable;
	layer: CellsLayer;
	controller: CellsController;
}

interface Entry {
	id: string;
	name: string;
	file: WorkspaceFile | null;
	origin: 'native' | 'settings' | 'added';
	state: CellsSourceRow['state'];
	detail: string;
	color: string;
	visible: boolean;
	segmentation: Segmentation | null;
	/** For a loaded table: where it was merged and which columns it added. */
	merged: { into: string; columns: string[] } | null;
	/** What the entry is, once known. */
	kind: 'segmentation' | 'table' | 'unknown';
}

export class CellsWorkspace {
	private readonly entries: Entry[] = [];
	private activeId: string | null = null;
	private counter = 0;
	private message: string | null = null;

	constructor(private readonly host: CellsWorkspaceHost, private readonly pixelSizeUm: number) { }

	// --- building the list ------------------------------------------------

	private uniqueName(wanted: string): string {
		let name = wanted, suffix = 2;
		while (this.entries.some(entry => entry.name === name)) { name = `${wanted} (${suffix++})`; }
		return name;
	}

	private makeEntry(file: WorkspaceFile | null, name: string, origin: Entry['origin']): Entry {
		const kind = file?.kind === 'boundaries' ? 'segmentation' : file?.kind === 'table' ? 'table' : 'unknown';
		const entry: Entry = {
			id: `source-${++this.counter}`, name: this.uniqueName(name), file, origin,
			state: file && !file.found ? 'missing' : 'available', detail: file && !file.found ? `Not found: ${file.path}` : '',
			color: PALETTE[this.entries.length % PALETTE.length], visible: true, segmentation: null, merged: null, kind,
		};
		this.entries.push(entry);
		return entry;
	}

	/** The segmentation the bundle itself provides. */
	addNative(name: string, loaded: { table: CellTable; cells: PolygonSet; nuclei: PolygonSet | null }, restored?: CellsControllerState): void {
		const entry = this.makeEntry(null, name, 'native');
		entry.color = CELL_OUTLINE;
		entry.state = 'loaded';
		entry.kind = 'segmentation';
		this.attach(entry, loaded.table, loaded.cells, loaded.nuclei, restored);
		this.activeId = entry.id;
	}

	/** List files from the settings; they load when the user asks. */
	addConfigured(files: readonly WorkspaceFile[]): void {
		for (const file of files) { this.makeEntry(file, file.name, 'settings'); }
	}

	/** Bring back files the user added in an earlier session of this editor. */
	async restore(saved: readonly PersistedCellSource[]): Promise<void> {
		for (const item of saved) {
			try {
				const file = await this.host.resolve(item.path);
				const entry = this.makeEntry({ ...file, kind: item.kind }, file.name, 'added');
				if (item.loaded) { void this.load(entry.id); }
			} catch { /* a file that has gone is simply not listed */ }
		}
		this.host.notify();
	}

	getState(): CellsWorkspaceState {
		const native = this.entries.find(entry => entry.origin === 'native')?.segmentation?.controller.getState();
		return {
			native,
			added: this.entries.filter(entry => entry.origin === 'added' && entry.file).map(entry => ({
				path: entry.file!.path, kind: entry.kind === 'segmentation' ? 'boundaries' : entry.kind === 'table' ? 'table' : 'unknown',
				loaded: entry.state === 'loaded',
			})),
		};
	}

	// --- segmentations ------------------------------------------------------

	private attach(entry: Entry, table: CellTable, cells: PolygonSet, nuclei: PolygonSet | null, restored?: CellsControllerState): void {
		const layer: CellsLayer = new CellsLayer({
			cells, nuclei, rowCount: table.count, outline: entry.color,
			invalidate: () => this.host.requestRender(),
			onSelectionChange: () => this.selectionChanged(entry),
			describeRow: row => {
				const column = findColumn(table, controller.getState().metric);
				return column ? `${table.ids[row]} · ${column.name} ${formatValue(column, row)}` : table.ids[row];
			},
		});
		const controller: CellsController = new CellsController(table, layer, () => this.host.notify(), restored);
		entry.segmentation = { table, layer, controller };
		layer.setHidden(!entry.visible);
		this.host.addOverlay(layer);
	}

	/** Selecting in one segmentation clears the others and makes it the active one. */
	private selectionChanged(entry: Entry): void {
		if (entry.segmentation && entry.segmentation.layer.selectedRows().length > 0) {
			this.activeId = entry.id;
			for (const other of this.entries) { if (other !== entry) { other.segmentation?.layer.clearSelection(); } }
		}
		this.host.notify();
	}

	private active(): Entry | null {
		return this.entries.find(entry => entry.id === this.activeId && entry.segmentation) ?? null;
	}

	// --- actions ------------------------------------------------------------------

	private async load(id: string): Promise<void> {
		const entry = this.entries.find(candidate => candidate.id === id);
		if (!entry?.file || entry.state === 'loading' || entry.state === 'loaded' || !entry.file.found) { return; }
		this.message = null;
		entry.state = 'loading';
		entry.detail = 'Loading…';
		this.host.notify();
		try {
			const target = this.active();
			const loaded = await this.host.load(entry.file);
			if (loaded.kind === 'boundaries') {
				entry.kind = 'segmentation';
				this.attach(entry, loaded.table, loaded.cells, null);
				entry.state = 'loaded';
				entry.detail = `${loaded.table.count.toLocaleString()} cells`;
				this.activeId = entry.id;
			} else {
				entry.kind = 'table';
				if (!target?.segmentation) { throw new Error('Load a segmentation first: a table is merged into the active one.'); }
				const result = mergeTable(target.segmentation.table, loaded.table, entry.name);
				if (result.matched === 0) { throw new Error(`None of its ${result.total.toLocaleString()} cell ids match ${target.name}.`); }
				entry.merged = { into: target.id, columns: result.added };
				entry.state = 'loaded';
				entry.detail = `${result.added.length} columns into ${target.name} · ${result.matched.toLocaleString()} of ${result.total.toLocaleString()} cells matched`;
			}
		} catch (error) {
			entry.state = 'error';
			entry.detail = error instanceof Error ? error.message : String(error);
		}
		this.host.notify();
	}

	private unload(entry: Entry): void {
		if (entry.segmentation) {
			for (const other of this.entries) {
				if (other.merged?.into === entry.id) { this.unload(other); this.reset(other); }
			}
			this.host.removeOverlay(entry.segmentation.layer);
			entry.segmentation = null;
			if (this.activeId === entry.id) { this.activeId = this.entries.find(candidate => candidate.segmentation)?.id ?? null; }
		}
		if (entry.merged) {
			const into = this.entries.find(candidate => candidate.id === entry.merged!.into)?.segmentation;
			if (into) { dropColumns(into.table, entry.merged.columns); into.controller.forgetMetrics(entry.merged.columns); }
			entry.merged = null;
		}
	}

	private reset(entry: Entry): void {
		entry.state = entry.file?.found === false ? 'missing' : 'available';
		entry.detail = entry.file?.found === false ? `Not found: ${entry.file.path}` : '';
	}

	private remove(id: string): void {
		const entry = this.entries.find(candidate => candidate.id === id);
		if (!entry || entry.origin === 'native') { return; }
		this.unload(entry);
		if (entry.origin === 'added') { this.entries.splice(this.entries.indexOf(entry), 1); } else { this.reset(entry); }
		this.host.notify();
	}

	private async addFile(promise: Promise<WorkspaceFile | null>): Promise<void> {
		this.message = null;
		try {
			const file = await promise;
			if (!file) { return; }
			const entry = this.makeEntry(file, file.name, 'added');
			this.host.notify();
			await this.load(entry.id);
		} catch (error) {
			this.message = error instanceof Error ? error.message : String(error);
			this.host.notify();
		}
	}

	// --- what the panel sees -------------------------------------------------------

	private rows(): CellsSourceRow[] {
		const ordered = [...this.entries.filter(entry => entry.origin === 'native'), ...this.entries.filter(entry => entry.origin !== 'native')];
		return ordered.map(entry => ({
			id: entry.id, name: entry.name, kind: entry.kind === 'table' ? 'table' : 'segmentation',
			path: entry.file?.path ?? 'This bundle', origin: entry.origin, state: entry.state,
			detail: entry.origin === 'native' ? `${entry.segmentation?.table.count.toLocaleString() ?? 0} cells` : entry.detail,
			visible: entry.visible, active: entry.id === this.activeId, color: entry.color,
		}));
	}

	snapshot(status: string | null): CellsModel {
		const active = this.active();
		const base = active?.segmentation ? active.segmentation.controller.snapshot() : statusCellsModel(status ?? 'Add a cell boundaries file to show cells.');
		return {
			...base,
			sources: this.rows(), sourceMessage: this.message,
			addSource: text => { if (text.trim()) { void this.addFile(this.host.resolve(text)); } },
			browseSource: () => { void this.addFile(this.host.browse()); },
			loadSource: id => { void this.load(id); },
			removeSource: id => this.remove(id),
			activateSource: id => {
				const entry = this.entries.find(candidate => candidate.id === id);
				if (entry?.segmentation) { this.activeId = id; this.host.notify(); }
			},
			showSource: (id, visible) => {
				const entry = this.entries.find(candidate => candidate.id === id);
				if (!entry) { return; }
				entry.visible = visible;
				entry.segmentation?.layer.setHidden(!visible);
				this.host.notify();
			},
			colorSource: (id, color) => {
				const entry = this.entries.find(candidate => candidate.id === id);
				if (!entry) { return; }
				entry.color = color;
				entry.segmentation?.layer.setOutline(color);
				this.host.notify();
			},
		};
	}

	/** Esc: clear the selection everywhere. */
	clearSelection(): void { for (const entry of this.entries) { entry.segmentation?.layer.clearSelection(); } }
}

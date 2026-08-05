"use strict";

import type { Roi } from './types.js';

/**
 * ROI collection state: ordering, selection, naming, and undo.
 *
 * Undo is a full history rather than the single level ImageJ offers. ROI
 * editing is fiddly by nature — a mis-dragged vertex or an over-eager wand
 * click is normal — and without real undo the recovery path is redrawing from
 * scratch, which is how people end up not trusting the tool.
 *
 * History stores whole snapshots of the ROI list. ROI lists are small (hundreds
 * of entries, each a few hundred bytes plus any mask), so snapshotting is far
 * simpler than a command log and cannot drift out of sync with the live state.
 */

const HISTORY_LIMIT = 100;

/** Distinguishable overlay colours, cycled as ROIs are created. */
export const ROI_PALETTE = [
	'#ffd400', '#00d4ff', '#ff6ec7', '#7cff5a', '#ff8c42',
	'#b58cff', '#4cd4a0', '#ff5a5a', '#5a9cff', '#d4c65a',
];

export interface RoiChangeEvent {
	rois: Roi[];
	selectedIds: string[];
	/** True while a gesture is in progress, so listeners can skip heavy work. */
	interactive: boolean;
}

export class RoiManager {
	private rois: Roi[] = [];
	private selected = new Set<string>();
	private undoStack: string[] = [];
	private redoStack: string[] = [];
	private listeners: ((event: RoiChangeEvent) => void)[] = [];
	private counter = 0;
	private paletteIndex = 0;
	private suppressHistory = false;

	onChange(listener: (event: RoiChangeEvent) => void): void {
		this.listeners.push(listener);
	}

	private emit(interactive = false): void {
		const event: RoiChangeEvent = {
			rois: this.rois,
			selectedIds: Array.from(this.selected),
			interactive,
		};
		for (const listener of this.listeners) { listener(event); }
	}

	list(): Roi[] { return this.rois; }
	count(): number { return this.rois.length; }
	get(id: string): Roi | undefined { return this.rois.find(roi => roi.id === id); }
	selectedIds(): string[] { return Array.from(this.selected); }
	selectedRois(): Roi[] { return this.rois.filter(roi => this.selected.has(roi.id)); }
	isSelected(id: string): boolean { return this.selected.has(id); }

	nextId(): string {
		this.counter++;
		return `roi-${Date.now().toString(36)}-${this.counter.toString(36)}`;
	}

	nextColor(): string {
		const color = ROI_PALETTE[this.paletteIndex % ROI_PALETTE.length];
		this.paletteIndex++;
		return color;
	}

	/** Default name for a new ROI, numbered per kind so lists stay readable. */
	nextName(kind: Roi['kind']): string {
		const prefix = kind === 'point' ? 'Points'
			: kind === 'line' || kind === 'polyline' ? 'Line'
				: kind === 'mask' ? 'Object'
					: 'ROI';
		let index = 1;
		const taken = new Set(this.rois.map(roi => roi.name));
		while (taken.has(`${prefix} ${index}`)) { index++; }
		return `${prefix} ${index}`;
	}

	// --- history ------------------------------------------------------------

	/**
	 * Snapshot before a mutation. Callers wrap a logical edit in
	 * `beginEdit()`/mutation so a multi-step gesture lands as one undo step.
	 */
	beginEdit(): void {
		if (this.suppressHistory) { return; }
		this.undoStack.push(this.snapshot());
		if (this.undoStack.length > HISTORY_LIMIT) { this.undoStack.shift(); }
		this.redoStack.length = 0;
	}

	private snapshot(): string {
		return JSON.stringify(this.rois, (key, value) => {
			// Typed arrays do not survive JSON; masks are stored as plain arrays
			// inside the snapshot only, never in the sidecar format.
			if (value instanceof Uint8Array) { return { __mask: Array.from(value) }; }
			return value;
		});
	}

	private restore(snapshot: string): void {
		this.rois = JSON.parse(snapshot, (key, value) => {
			if (value && typeof value === 'object' && Array.isArray((value as { __mask?: number[] }).__mask)) {
				return Uint8Array.from((value as { __mask: number[] }).__mask);
			}
			return value;
		});
		const ids = new Set(this.rois.map(roi => roi.id));
		for (const id of Array.from(this.selected)) { if (!ids.has(id)) { this.selected.delete(id); } }
	}

	canUndo(): boolean { return this.undoStack.length > 0; }
	canRedo(): boolean { return this.redoStack.length > 0; }

	undo(): void {
		const snapshot = this.undoStack.pop();
		if (snapshot === undefined) { return; }
		this.redoStack.push(this.snapshot());
		this.restore(snapshot);
		this.emit();
	}

	redo(): void {
		const snapshot = this.redoStack.pop();
		if (snapshot === undefined) { return; }
		this.undoStack.push(this.snapshot());
		this.restore(snapshot);
		this.emit();
	}

	/** Run a mutation without recording history (used while restoring state). */
	withoutHistory(work: () => void): void {
		const previous = this.suppressHistory;
		this.suppressHistory = true;
		try { work(); } finally { this.suppressHistory = previous; }
	}

	// --- mutation -----------------------------------------------------------

	add(roi: Roi, options: { select?: boolean; interactive?: boolean } = {}): Roi {
		this.beginEdit();
		if (!roi.color) { roi.color = this.nextColor(); }
		this.rois.push(roi);
		if (options.select !== false) {
			this.selected.clear();
			this.selected.add(roi.id);
		}
		this.emit(options.interactive === true);
		return roi;
	}

	addMany(rois: Roi[], options: { select?: boolean } = {}): void {
		if (rois.length === 0) { return; }
		this.beginEdit();
		for (const roi of rois) {
			if (!roi.color) { roi.color = this.nextColor(); }
			this.rois.push(roi);
		}
		if (options.select) {
			this.selected.clear();
			for (const roi of rois) { this.selected.add(roi.id); }
		}
		this.emit();
	}

	/**
	 * Replace an ROI in place.
	 *
	 * `interactive` suppresses the history snapshot, so dragging a vertex across
	 * fifty mouse-move events produces one undo step rather than fifty.
	 */
	update(id: string, updater: (roi: Roi) => Roi, options: { interactive?: boolean } = {}): void {
		const index = this.rois.findIndex(roi => roi.id === id);
		if (index < 0) { return; }
		if (!options.interactive) { this.beginEdit(); }
		this.rois[index] = updater(this.rois[index]);
		this.emit(options.interactive === true);
	}

	remove(ids: string[]): void {
		if (ids.length === 0) { return; }
		this.beginEdit();
		const removing = new Set(ids);
		this.rois = this.rois.filter(roi => !removing.has(roi.id));
		for (const id of ids) { this.selected.delete(id); }
		this.emit();
	}

	clear(): void {
		if (this.rois.length === 0) { return; }
		this.beginEdit();
		this.rois = [];
		this.selected.clear();
		this.emit();
	}

	rename(id: string, name: string): void {
		this.update(id, roi => ({ ...roi, name }));
	}

	setGroup(ids: string[], group: string | undefined): void {
		if (ids.length === 0) { return; }
		this.beginEdit();
		const target = new Set(ids);
		this.rois = this.rois.map(roi => (target.has(roi.id) ? { ...roi, group } : roi));
		this.emit();
	}

	setColor(id: string, color: string): void {
		this.update(id, roi => ({ ...roi, color }));
	}

	/** Move an ROI within the list, which is also its overlay draw order. */
	reorder(id: string, targetIndex: number): void {
		const index = this.rois.findIndex(roi => roi.id === id);
		if (index < 0 || targetIndex === index) { return; }
		this.beginEdit();
		const [roi] = this.rois.splice(index, 1);
		this.rois.splice(Math.max(0, Math.min(this.rois.length, targetIndex)), 0, roi);
		this.emit();
	}

	// --- selection ----------------------------------------------------------

	select(ids: string[], options: { additive?: boolean } = {}): void {
		if (!options.additive) { this.selected.clear(); }
		for (const id of ids) { this.selected.add(id); }
		this.emit();
	}

	toggleSelection(id: string): void {
		if (this.selected.has(id)) { this.selected.delete(id); } else { this.selected.add(id); }
		this.emit();
	}

	selectAll(): void {
		this.selected.clear();
		for (const roi of this.rois) { this.selected.add(roi.id); }
		this.emit();
	}

	clearSelection(): void {
		if (this.selected.size === 0) { return; }
		this.selected.clear();
		this.emit();
	}

	/** Replace the whole collection, e.g. when loading a sidecar. */
	replaceAll(rois: Roi[], options: { recordHistory?: boolean } = {}): void {
		if (options.recordHistory !== false) { this.beginEdit(); }
		this.rois = rois.slice();
		this.selected.clear();
		// Keep the palette advancing past what was just loaded, so newly drawn
		// ROIs do not immediately repeat the colours already on screen.
		this.paletteIndex = rois.length;
		this.emit();
	}

	/** Sequential renumbering, for tidying a list after deletions. */
	renumber(): void {
		this.beginEdit();
		const counters = new Map<string, number>();
		this.rois = this.rois.map(roi => {
			const prefix = roi.name.replace(/\s*\d+$/, '') || 'ROI';
			const next = (counters.get(prefix) || 0) + 1;
			counters.set(prefix, next);
			return { ...roi, name: `${prefix} ${next}` };
		});
		this.emit();
	}
}

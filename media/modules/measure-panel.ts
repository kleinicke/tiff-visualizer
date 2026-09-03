"use strict";

import { areaUnit, calibrationFromKnownDistance, describeCalibration, formatNumber } from './measure/calibration.js';
import { maskContour } from './measure/geometry.js';
import { compileExpression, ExpressionError } from './measure/expression.js';
import { analyzeParticles, countIntensityMaxima, particleToRoi, type SplitMode } from './measure/particles.js';
import type { RoiManager } from './measure/roi-manager.js';
import {
	buildPandasScript,
	buildSidecar,
	matchFilenamePattern,
	rowsToDelimitedText,
	summarizeByGroup,
	summarizeRows,
	type DerivedColumn,
} from './measure/roi-io.js';
import type { MeasureTool, RoiOverlay } from './measure/roi-overlay.js';
import { measureAll, sampleLineProfile } from './measure/statistics.js';
import { gaussianBlur, subtractBackground } from './measure/segmentation.js';
import {
	autoThresholdBin,
	buildHistogram,
	computeStabilityCurve,
	globalThresholdMask,
	localAutoThresholdMask,
	localThresholdMask,
	LOCAL_METHODS,
	THRESHOLD_METHODS,
	thresholdValueFromBin,
	valueToBin,
	type LocalMethod,
	type ScalarHistogram,
	type StabilityCurve,
	type ThresholdMethod,
} from './measure/threshold.js';
import { buildXlsx } from './measure/xlsx-writer.js';
import {
	COLUMN_GROUPS,
	COLUMN_LABELS,
	DEFAULT_COLUMNS,
	isLineKind,
	LENGTH_COLUMNS,
	type Calibration,
	type LineRoi,
	type MeasurementColumn,
	type MeasurementProvenance,
	type MeasurementRow,
	type MeasurementSource,
	type Roi,
} from './measure/types.js';

/**
 * The Measure panel.
 *
 * One surface for the whole subsystem, opened from a single context-menu entry
 * and a status-bar toggle. That is the entire visible footprint: someone who
 * opens a TIFF to look at it sees nothing of any of this, which was the design
 * constraint the feature had to satisfy before anything else.
 *
 * Structurally it follows the panel pattern already established by
 * `debayer-panel.ts` and `metadata-panel.ts` — its own DOM tree on
 * `document.body`, theme variables for styling, drag by the header, visibility
 * persisted by the caller — so it adds a surface, not a paradigm.
 */

export type MeasureTab = 'tools' | 'rois' | 'results' | 'segment' | 'setup';

/**
 * Escape a value for use inside an attribute selector.
 *
 * ROI ids are generated here and contain only safe characters, but ids also
 * arrive from imported ImageJ sets and hand-edited sidecars, where they are
 * whatever the file said.
 */
function cssEscape(value: string): string {
	const native = (window as unknown as { CSS?: { escape?: (v: string) => string } }).CSS;
	if (native && typeof native.escape === 'function') { return native.escape(value); }
	return value.replace(/["\\]/g, '\\$&');
}

export interface MeasurePanelHost {
	manager: RoiManager;
	overlay: RoiOverlay;
	getSource: () => MeasurementSource | null;
	getScalarPlane: () => Float32Array | null;
	getCalibration: () => Calibration;
	setCalibration: (calibration: Calibration) => void;
	/** Ask the extension host to write a file and open it in an editor tab. */
	saveTextFile: (fileName: string, content: string, options?: { open?: boolean }) => void;
	saveBinaryFile: (fileName: string, bytes: Uint8Array) => void;
	/** Ask the extension host to open a file picker and return its bytes. */
	requestImport: (kind: 'imagej' | 'sidecar') => void;
	/** Persist the ROI sidecar next to the image. */
	saveSidecar: (json: string) => void;
	extensionVersion?: string;
}

interface ThresholdState {
	method: ThresholdMethod;
	localMethod: LocalMethod;
	/** Run the selected global method per window instead of once. */
	localizeGlobal: boolean;
	localRadius: number;
	localK: number;
	low: number;
	high: number;
	darkBackground: boolean;
	blurSigma: number;
	backgroundRadius: number;
	split: SplitMode;
	prominence: number;
	fillHoles: boolean;
	excludeEdges: boolean;
	minArea: number;
	maxArea: number;
	minCircularity: number;
	maxCircularity: number;
	manual: boolean;
}

const DEFAULT_THRESHOLD: ThresholdState = {
	method: 'otsu',
	localMethod: 'none',
	localizeGlobal: false,
	localRadius: 15,
	localK: 0.25,
	low: 0,
	high: 1,
	darkBackground: true,
	blurSigma: 0,
	backgroundRadius: 0,
	split: 'none',
	prominence: 0,
	fillHoles: true,
	excludeEdges: false,
	minArea: 10,
	maxArea: Number.POSITIVE_INFINITY,
	minCircularity: 0,
	maxCircularity: 1,
	manual: false,
};

const TOOLS: { id: MeasureTool; label: string; key?: string }[] = [
	{ id: 'select', label: 'Select', key: 'V' },
	{ id: 'rect', label: 'Rect', key: 'R' },
	{ id: 'ellipse', label: 'Ellipse', key: 'E' },
	{ id: 'polygon', label: 'Polygon', key: 'P' },
	{ id: 'freehand', label: 'Freehand', key: 'F' },
	{ id: 'line', label: 'Line', key: 'L' },
	{ id: 'polyline', label: 'Polyline' },
	{ id: 'point', label: 'Points', key: 'N' },
	{ id: 'wand', label: 'Wand', key: 'W' },
	{ id: 'brush', label: 'Brush', key: 'B' },
	{ id: 'livewire', label: 'Trace edge' },
];

export class MeasurePanel {
	private overlayRoot: HTMLDivElement;
	private body: HTMLDivElement;
	private hintLine: HTMLDivElement;
	private tabButtons = new Map<MeasureTab, HTMLButtonElement>();
	private tab: MeasureTab = 'tools';
	private host: MeasurePanelHost;

	private rows: MeasurementRow[] = [];
	private derivedColumns: DerivedColumn[] = [];
	private visibleColumns: MeasurementColumn[] = [...DEFAULT_COLUMNS];
	/**
	 * Measure a whole folder into one table.
	 *
	 * Each image's rows are snapshotted together with the provenance that
	 * produced them, so an export spanning several images reports each row's own
	 * scale and threshold rather than whichever image happens to be open.
	 */
	private collecting = false;
	private collected = new Map<string, {
		rows: MeasurementRow[];
		provenance: MeasurementProvenance;
		extraColumns: Record<string, string>;
	}>();
	private groupPattern = '';
	private channelMode: 'first' | 'all' = 'first';
	private threshold: ThresholdState = { ...DEFAULT_THRESHOLD };
	private histogram: ScalarHistogram | null = null;
	private stability: StabilityCurve | null = null;
	private thresholdMask: Uint8Array | null = null;
	private previewPlane: Float32Array | null = null;
	/**
	 * Rises on every threshold-affecting change (preprocessing, method, range).
	 * `buildHistogram`/`autoThresholdBin`/the mask builders now reach the
	 * Rust/WASM module, so their callers are lazy-async: a stale in-flight
	 * result is dropped by comparing against this token when it resolves,
	 * exactly like `particleToken` below. Eager precomputation on every
	 * keystroke would stall the range-field inputs, which is why these stay
	 * lazy rather than being awaited inline.
	 */
	private thresholdToken = 0;
	private thresholdPrepareBusy = false;
	private thresholdApplyBusy = false;
	private stabilityBusy = false;
	/** Auto-threshold bin per method, cached per histogram for the gallery. */
	private methodBins: Map<ThresholdMethod, number> | null = null;
	private methodBinsBusy = false;
	/** Discards a stale hover-preview mask that resolves after the pointer left. */
	private hoverToken = 0;
	private pendingCalibrationDistance = 0;
	private measureHandle = 0;
	/** Cached particle pass, so the stats line and the preview agree and the
	 *  analysis is not run twice per render. */
	private particleResult: Awaited<ReturnType<typeof analyzeParticles>> | null = null;
	/** Rises on every invalidation so a late analysis can be discarded. */
	private particleToken = 0;
	private particleAnalysisRunning = false;
	private showMaskOverlay = true;

	private isDragging = false;
	private dragOffset = { x: 0, y: 0 };
	private maskToggle: HTMLButtonElement | null = null;
	private roiToggle: HTMLButtonElement | null = null;
	/** Scroll offsets carried across the full rebuild every render performs. */
	private scrollOffsets = new Map<string, number>();
	/** Set while a table row is handling its own click. */
	private selectionFromTable = false;
	/** Selection key at the last render, to detect changes made elsewhere. */
	private lastSelectionKey = '';
	/** ROI whose row should be brought into view after the next render. */
	private pendingRowReveal: string | null = null;

	constructor(host: MeasurePanelHost) {
		this.host = host;

		this.overlayRoot = document.createElement('div');
		this.overlayRoot.className = 'measure-panel';
		this.overlayRoot.style.display = 'none';

		const header = document.createElement('div');
		header.className = 'measure-header';
		const title = document.createElement('div');
		title.className = 'measure-title';
		title.textContent = 'Measure';
		const spacer = document.createElement('div');
		spacer.className = 'measure-spacer';

		// Visibility lives in the header, not inside a tab: turning the overlay
		// off to look at the image underneath is something you do constantly and
		// from wherever you happen to be, so it must not be three clicks away in
		// another tab.
		const maskToggle = document.createElement('button');
		maskToggle.className = 'measure-chip';
		maskToggle.textContent = 'Mask';
		maskToggle.title = 'Show the threshold over the image (M)';
		maskToggle.onclick = () => {
			this.showMaskOverlay = !this.showMaskOverlay;
			this.refreshMaskOverlay();
			this.syncHeaderToggles();
		};
		const roiToggle = document.createElement('button');
		roiToggle.className = 'measure-chip';
		roiToggle.textContent = 'ROIs';
		roiToggle.title = 'Show the ROI outlines (O). Hiding them does not delete anything.';
		roiToggle.onclick = () => {
			this.host.overlay.setShowRois(!this.host.overlay.getShowRois());
			this.syncHeaderToggles();
		};
		this.maskToggle = maskToggle;
		this.roiToggle = roiToggle;

		const closeButton = document.createElement('button');
		closeButton.className = 'measure-close';
		closeButton.textContent = '×';
		closeButton.title = 'Close the measure panel';
		closeButton.onclick = () => this.hide();
		header.append(title, spacer, maskToggle, roiToggle, closeButton);
		header.style.cursor = 'move';
		header.onmousedown = event => this.startDrag(event);

		const tabs = document.createElement('div');
		tabs.className = 'measure-tabs';
		const tabDefinitions: { id: MeasureTab; label: string }[] = [
			{ id: 'tools', label: 'Tools' },
			{ id: 'rois', label: 'ROIs' },
			{ id: 'results', label: 'Results' },
			{ id: 'segment', label: 'Segment' },
			{ id: 'setup', label: 'Scale' },
		];
		for (const definition of tabDefinitions) {
			const button = document.createElement('button');
			button.className = 'measure-tab';
			button.textContent = definition.label;
			button.onclick = () => this.setTab(definition.id);
			tabs.appendChild(button);
			this.tabButtons.set(definition.id, button);
		}

		this.body = document.createElement('div');
		this.body.className = 'measure-body';

		this.hintLine = document.createElement('div');
		this.hintLine.className = 'measure-hint';

		this.overlayRoot.append(header, tabs, this.body, this.hintLine);

		// Panel interaction must not reach the image's pan/zoom handlers. The
		// omission of 'mouseup' matches debayer-panel.ts: swallowing it strands
		// the drag listeners and glues the panel to the cursor.
		for (const type of ['mousedown', 'click', 'dblclick', 'wheel', 'contextmenu']) {
			this.overlayRoot.addEventListener(type, event => event.stopPropagation());
		}

		document.body.appendChild(this.overlayRoot);
		this.setTab('tools');
		this.syncHeaderToggles();
	}

	private syncHeaderToggles(): void {
		this.maskToggle?.classList.toggle('active', this.showMaskOverlay);
		this.roiToggle?.classList.toggle('active', this.host.overlay.getShowRois());
	}

	// --- visibility ---------------------------------------------------------

	show(): void {
		this.overlayRoot.style.display = 'flex';
		this.host.overlay.setActive(true);
		this.refresh();
	}

	hide(): void {
		this.overlayRoot.style.display = 'none';
		this.host.overlay.setActive(false);
		this.host.overlay.setTool('select');
		this.host.overlay.setMaskPreview(null);
	}

	isVisible(): boolean { return this.overlayRoot.style.display !== 'none'; }

	toggle(): void { if (this.isVisible()) { this.hide(); } else { this.show(); } }

	setHint(text: string): void { this.hintLine.textContent = text; }

	setTab(tab: MeasureTab): void {
		this.tab = tab;
		for (const [id, button] of this.tabButtons) { button.classList.toggle('active', id === tab); }
		// Arriving at the table with something already selected should land on it
		// rather than at row one.
		if (tab === 'results') {
			const selected = this.host.manager.selectedIds();
			if (selected.length > 0) { this.pendingRowReveal = selected[0]; }
		}
		this.render();
	}

	/** Called when the displayed image changes. */
	onImageChanged(): void {
		this.histogram = null;
		this.stability = null;
		this.thresholdMask = null;
		this.previewPlane = null;
		this.particleResult = null;
		this.particleToken++;
		this.showMaskOverlay = true;
		this.host.overlay.invalidateImage();
		this.scheduleMeasure();
	}

	// --- measurement --------------------------------------------------------

	/**
	 * Recompute the results table.
	 *
	 * Coalesced through a frame callback because it is driven by ROI edits,
	 * which arrive once per mouse move while a vertex is being dragged.
	 */
	scheduleMeasure(): void {
		if (this.measureHandle) { return; }
		this.measureHandle = requestAnimationFrame(() => {
			this.measureHandle = 0;
			this.measure();
			if (this.tab === 'results' || this.tab === 'rois' || this.tab === 'tools') { this.render(); }
		});
	}

	private measure(): void {
		const source = this.host.getSource();
		if (!source) { this.rows = []; return; }
		const channels = this.channelMode === 'all'
			? Array.from({ length: source.channels || 1 }, (_, i) => i)
			: [0];
		this.rows = measureAll(this.host.manager.list(), source, this.host.getCalibration(), channels);

		if (this.collecting && source.fileName && this.rows.length > 0) {
			this.collected.set(source.fileName, {
				rows: this.rows.map(row => ({ ...row })),
				provenance: this.provenance(),
				extraColumns: this.extraColumns(),
			});
		}
	}

	/** Rows an export should cover: the collected set, or just this image. */
	private exportRows(): MeasurementRow[] {
		if (!this.collecting) { return this.rows; }
		const all: MeasurementRow[] = [];
		for (const snapshot of this.collected.values()) { all.push(...snapshot.rows); }
		return all;
	}

	/** Look up the snapshot a row came from, for its own provenance. */
	private snapshotFor(row: MeasurementRow) {
		return row.fileName ? this.collected.get(row.fileName) : undefined;
	}

	getRows(): MeasurementRow[] { return this.rows; }

	// --- rendering ----------------------------------------------------------

	refresh(): void {
		this.measure();
		this.render();
	}

	private render(): void {
		this.syncHeaderToggles();
		this.captureScrollOffsets();
		this.noteSelectionChange();

		this.body.textContent = '';
		switch (this.tab) {
			case 'tools': this.renderTools(); break;
			case 'rois': this.renderRois(); break;
			case 'results': this.renderResults(); break;
			case 'segment': this.renderSegment(); break;
			case 'setup': this.renderSetup(); break;
		}

		this.restoreScrollOffsets();
	}

	/**
	 * Scrolling containers rebuilt on every render.
	 *
	 * The panel re-renders on any change, including a selection, and a rebuilt
	 * list starts at the top. Without carrying the offset across, clicking row
	 * 200 in a table of 465 objects throws you back to row 1 — which makes the
	 * table unusable for exactly the case it exists for.
	 */
	private static readonly SCROLLABLES = ['.measure-results-wrapper', '.measure-roi-list'];

	private captureScrollOffsets(): void {
		for (const selector of MeasurePanel.SCROLLABLES) {
			const element = this.body.querySelector(selector);
			if (element) { this.scrollOffsets.set(selector, element.scrollTop); }
		}
	}

	private restoreScrollOffsets(): void {
		for (const selector of MeasurePanel.SCROLLABLES) {
			const element = this.body.querySelector(selector) as HTMLElement | null;
			const offset = this.scrollOffsets.get(selector);
			if (element && offset !== undefined) { element.scrollTop = offset; }
		}

		// A selection made on the image should bring its row into view; one made
		// in the table must leave the table exactly where it is.
		if (this.pendingRowReveal) {
			const id = this.pendingRowReveal;
			this.pendingRowReveal = null;
			const wrapper = this.body.querySelector('.measure-results-wrapper') as HTMLElement | null;
			const row = wrapper?.querySelector(`[data-roi-id="${cssEscape(id)}"]`) as HTMLElement | null;
			if (wrapper && row) {
				// Centre it rather than using scrollIntoView, which would also
				// scroll the panel body and move the whole table out from under
				// the cursor.
				const target = row.offsetTop - (wrapper.clientHeight - row.offsetHeight) / 2;
				wrapper.scrollTop = Math.max(0, target);
				this.scrollOffsets.set('.measure-results-wrapper', wrapper.scrollTop);
			}
		}
	}

	private noteSelectionChange(): void {
		const key = this.host.manager.selectedIds().join(',');
		if (key !== this.lastSelectionKey) {
			// Only reveal when the change came from somewhere other than the table
			// itself — otherwise every click would re-centre the row under the
			// cursor and shift the next one out from under it.
			if (!this.selectionFromTable && key) { this.pendingRowReveal = key.split(',')[0]; }
			this.lastSelectionKey = key;
		}
		this.selectionFromTable = false;
	}

	private renderTools(): void {
		const strip = this.section('Tool');
		const grid = document.createElement('div');
		grid.className = 'measure-tool-grid';
		for (const tool of TOOLS) {
			const button = document.createElement('button');
			button.className = 'measure-tool';
			button.textContent = tool.label;
			button.title = tool.key ? `${tool.label} (${tool.key})` : tool.label;
			button.classList.toggle('active', this.host.overlay.getTool() === tool.id);
			button.onclick = () => {
				this.host.overlay.setTool(tool.id);
				this.render();
			};
			grid.appendChild(button);
		}
		strip.appendChild(grid);

		const tool = this.host.overlay.getTool();

		if (tool === 'wand') {
			const settings = this.section('Wand');
			const auto = this.host.overlay.getWandTolerance() === null;
			settings.appendChild(this.checkbox(
				'Choose tolerance automatically', auto,
				checked => {
					this.host.overlay.setWandTolerance(checked ? null : 1);
					this.render();
				},
				'Sweeps the tolerance and keeps the value at which the region stops growing — the object boundary — instead of asking you to guess one.',
			));
			if (!auto) {
				settings.appendChild(this.numberRow(
					'Tolerance', this.host.overlay.getWandTolerance() ?? 1,
					value => this.host.overlay.setWandTolerance(value),
					{ step: 'any', min: 0 },
				));
			}
			settings.appendChild(this.note('Hover to preview, scroll to adjust, Shift-click to merge into the selected object.'));
		}

		if (tool === 'brush') {
			const settings = this.section('Brush');
			settings.appendChild(this.numberRow(
				'Radius (px)', this.host.overlay.getBrushRadius(),
				value => this.host.overlay.setBrushRadius(value),
				{ step: '1', min: 1 },
			));
			settings.appendChild(this.note('Paints into the selected object. Alt-drag erases, scroll resizes.'));
		}

		const display = this.section('Overlay');
		display.appendChild(this.checkbox(
			'Show all ROI names', false,
			checked => this.host.overlay.setShowLabels(checked),
			'Off by default: only the object you point at or have selected is named, so a segmented field stays readable.',
		));
		display.appendChild(this.note(
			'Mask and ROIs toggle from the header, or with M and O. The scale bar toggles from the image right-click menu. Hold H to hide everything and look at the raw image.',
		));

		const selected = this.host.manager.selectedRois();
		const lineRoi = selected.find(roi => isLineKind(roi.kind)) as LineRoi | undefined;
		if (lineRoi) { this.body.appendChild(this.buildProfileSection(lineRoi)); }
		else if (selected.length === 1) { this.body.appendChild(this.buildQuickStats(selected[0])); }
	}

	private renderRois(): void {
		const manager = this.host.manager;
		const list = this.section(`ROIs (${manager.count()})`);

		if (manager.count() === 0) {
			list.appendChild(this.note('No ROIs yet. Pick a tool and draw on the image, or import an ImageJ ROI set below.'));
		} else {
			const container = document.createElement('div');
			container.className = 'measure-roi-list';
			for (const roi of manager.list()) {
				container.appendChild(this.buildRoiRow(roi));
			}
			list.appendChild(container);
		}

		const actions = this.section('Edit');
		const buttons = document.createElement('div');
		buttons.className = 'measure-button-row';
		buttons.append(
			this.button('Undo', () => manager.undo(), !manager.canUndo()),
			this.button('Redo', () => manager.redo(), !manager.canRedo()),
			this.button('Delete selected', () => manager.remove(manager.selectedIds()), manager.selectedIds().length === 0),
			this.button('Renumber', () => manager.renumber(), manager.count() === 0),
			this.button('Clear all', () => manager.clear(), manager.count() === 0),
		);
		actions.appendChild(buttons);

		const io = this.section('Store and exchange');
		const ioButtons = document.createElement('div');
		ioButtons.className = 'measure-button-row';
		ioButtons.append(
			this.button('Save ROIs', () => this.saveSidecar(), manager.count() === 0),
			this.button('Load ROIs', () => this.host.requestImport('sidecar')),
			this.button('Import ImageJ…', () => this.host.requestImport('imagej')),
			this.button('Export ImageJ', () => this.exportImageJ(), manager.count() === 0),
		);
		io.appendChild(ioButtons);
		io.appendChild(this.note(
			'ROIs are saved as a readable JSON file next to the image, so they diff in review and can be edited by hand. '
			+ 'ImageJ .roi / RoiSet.zip is supported for exchange.',
		));
	}

	private buildRoiRow(roi: Roi): HTMLElement {
		const manager = this.host.manager;
		const row = document.createElement('div');
		row.className = 'measure-roi-row';
		row.classList.toggle('selected', manager.isSelected(roi.id));

		const swatch = document.createElement('span');
		swatch.className = 'measure-roi-swatch';
		swatch.style.background = roi.color || '#ffd400';

		const name = document.createElement('input');
		name.className = 'measure-roi-name';
		name.value = roi.name;
		name.onchange = () => manager.rename(roi.id, name.value.trim() || roi.name);
		// Typing a name must not be interpreted as a tool shortcut.
		name.onkeydown = event => event.stopPropagation();

		const kind = document.createElement('span');
		kind.className = 'measure-roi-kind';
		kind.textContent = roi.kind;

		const remove = document.createElement('button');
		remove.className = 'measure-roi-remove';
		remove.textContent = '×';
		remove.title = 'Delete this ROI';
		remove.onclick = event => {
			event.stopPropagation();
			manager.remove([roi.id]);
		};

		row.append(swatch, name, kind, remove);
		// Selecting from the list highlights it on the image; the results table
		// does the same. Keeping the row, the overlay, and the table pointing at
		// one object is the thing a spreadsheet copy destroys permanently.
		row.onmouseenter = () => this.host.overlay.setHoveredRoi(roi.id);
		row.onmouseleave = () => this.host.overlay.setHoveredRoi(null);
		row.onclick = event => {
			if (event.target === name) { return; }
			const additive = event.shiftKey || event.ctrlKey || event.metaKey;
			this.selectionFromTable = true;
			manager.select([roi.id], { additive });
			if (!additive) { this.host.overlay.revealRoi(roi.id); }
		};
		return row;
	}

	private buildQuickStats(roi: Roi): HTMLElement {
		const section = document.createElement('div');
		section.className = 'measure-section';
		const heading = document.createElement('div');
		heading.className = 'measure-section-title';
		heading.textContent = roi.name;
		section.appendChild(heading);

		const row = this.rows.find(candidate => candidate.roiId === roi.id);
		if (!row) { section.appendChild(this.note('Not measurable on this image.')); return section; }

		const calibration = this.host.getCalibration();
		const table = document.createElement('div');
		table.className = 'measure-quick-stats';
		const entries: [string, string][] = [];
		if (row.area !== undefined) { entries.push(['Area', `${formatNumber(row.area)} ${areaUnit(calibration)}`]); }
		if (row.length !== undefined) { entries.push(['Length', `${formatNumber(row.length)} ${calibration.unit}`]); }
		if (row.perimeter !== undefined) { entries.push(['Perimeter', `${formatNumber(row.perimeter)} ${calibration.unit}`]); }
		if (row.mean !== undefined) { entries.push(['Mean', formatNumber(row.mean, 6)]); }
		if (row.stdDev !== undefined) { entries.push(['StdDev', formatNumber(row.stdDev, 6)]); }
		if (row.min !== undefined) { entries.push(['Min / Max', `${formatNumber(row.min, 6)} / ${formatNumber(row.max as number, 6)}`]); }
		if (row.circularity !== undefined) { entries.push(['Circularity', formatNumber(row.circularity, 3)]); }
		if (row.feret !== undefined) { entries.push(['Feret', `${formatNumber(row.feret)} ${calibration.unit}`]); }
		if (row.pixelCount !== undefined) { entries.push(['Pixels', String(row.pixelCount)]); }
		if (row.nonFiniteCount) { entries.push(['NaN / Inf pixels', String(row.nonFiniteCount)]); }

		for (const [label, value] of entries) {
			const cellLabel = document.createElement('div');
			cellLabel.className = 'measure-quick-label';
			cellLabel.textContent = label;
			const cellValue = document.createElement('div');
			cellValue.className = 'measure-quick-value';
			cellValue.textContent = value;
			table.append(cellLabel, cellValue);
		}
		section.appendChild(table);
		return section;
	}

	/**
	 * Intensity profile along a line ROI.
	 *
	 * Drawn on a canvas rather than assembled from DOM nodes: a profile has one
	 * sample per pixel of line length, and a thousand `<div>`s would be both
	 * slower and unreadable.
	 */
	private buildProfileSection(roi: LineRoi): HTMLElement {
		const section = document.createElement('div');
		section.className = 'measure-section';
		const heading = document.createElement('div');
		heading.className = 'measure-section-title';
		heading.textContent = `Profile — ${roi.name}`;
		section.appendChild(heading);

		const source = this.host.getSource();
		if (!source) { section.appendChild(this.note('No image loaded.')); return section; }

		const calibration = this.host.getCalibration();
		const channels = Math.min(source.channels || 1, 4);
		const series: { values: Float64Array; color: string }[] = [];
		const colors = ['#ff6b6b', '#5ac85a', '#5a9cff', '#cccccc'];
		let distances: Float64Array = new Float64Array(0);
		for (let channel = 0; channel < channels; channel++) {
			const profile = sampleLineProfile(source, roi, channel);
			distances = profile.distance;
			series.push({ values: profile.value, color: channels === 1 ? '#ffd400' : colors[channel] });
		}

		const canvas = document.createElement('canvas');
		canvas.className = 'measure-profile';
		canvas.width = 460;
		canvas.height = 150;
		this.drawProfile(canvas, distances, series, calibration);
		section.appendChild(canvas);

		const controls = document.createElement('div');
		controls.className = 'measure-row';
		controls.appendChild(this.numberRow(
			'Line width (px)', roi.lineWidth || 1,
			value => this.host.manager.update(roi.id, current => ({ ...current, lineWidth: Math.max(1, Math.round(value)) } as Roi)),
			{ step: '1', min: 1 },
		));
		section.appendChild(controls);

		section.appendChild(this.button('Export profile as CSV', () => this.exportProfile(roi)));
		return section;
	}

	private drawProfile(
		canvas: HTMLCanvasElement,
		distances: Float64Array,
		series: { values: Float64Array; color: string }[],
		calibration: Calibration,
	): void {
		const ctx = canvas.getContext('2d');
		if (!ctx || distances.length === 0) { return; }
		const width = canvas.width;
		const height = canvas.height;
		const padding = { left: 46, right: 8, top: 8, bottom: 20 };

		let min = Infinity;
		let max = -Infinity;
		for (const entry of series) {
			for (let i = 0; i < entry.values.length; i++) {
				const value = entry.values[i];
				if (!Number.isFinite(value)) { continue; }
				if (value < min) { min = value; }
				if (value > max) { max = value; }
			}
		}
		if (!Number.isFinite(min) || !Number.isFinite(max)) { return; }
		if (max === min) { max = min + 1; }

		ctx.clearRect(0, 0, width, height);
		const plotWidth = width - padding.left - padding.right;
		const plotHeight = height - padding.top - padding.bottom;

		ctx.strokeStyle = 'rgba(128, 128, 128, 0.4)';
		ctx.lineWidth = 1;
		ctx.strokeRect(padding.left, padding.top, plotWidth, plotHeight);

		ctx.fillStyle = 'rgba(160, 160, 160, 0.9)';
		ctx.font = '10px var(--vscode-editor-font-family, monospace)';
		ctx.textAlign = 'right';
		ctx.fillText(formatNumber(max, 4), padding.left - 4, padding.top + 8);
		ctx.fillText(formatNumber(min, 4), padding.left - 4, padding.top + plotHeight);
		ctx.textAlign = 'center';
		const totalDistance = distances[distances.length - 1] * calibration.pixelWidth;
		ctx.fillText('0', padding.left, height - 6);
		ctx.fillText(`${formatNumber(totalDistance, 4)} ${calibration.unit}`, padding.left + plotWidth, height - 6);

		for (const entry of series) {
			ctx.strokeStyle = entry.color;
			ctx.lineWidth = 1.25;
			ctx.beginPath();
			let started = false;
			for (let i = 0; i < entry.values.length; i++) {
				const value = entry.values[i];
				if (!Number.isFinite(value)) { started = false; continue; }
				const x = padding.left + (i / Math.max(1, entry.values.length - 1)) * plotWidth;
				const y = padding.top + plotHeight - ((value - min) / (max - min)) * plotHeight;
				if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
			}
			ctx.stroke();
		}
	}

	// --- results ------------------------------------------------------------

	private renderResults(): void {
		const source = this.host.getSource();
		const calibration = this.host.getCalibration();

		const options = this.section('Table');
		if (source && (source.channels || 1) > 1) {
			options.appendChild(this.checkbox(
				'Measure every channel', this.channelMode === 'all',
				checked => {
					this.channelMode = checked ? 'all' : 'first';
					this.refresh();
				},
				'One row per ROI per channel. Off measures only the first channel.',
			));
		}
		options.appendChild(this.note(describeCalibration(calibration)));

		const chooser = this.section('Columns');
		chooser.appendChild(this.note(
			'What the table shows. Exports always contain every measured column — a results file that quietly omits a number because of a display setting is a trap.',
		));
		const grid = document.createElement('div');
		grid.className = 'measure-column-grid';
		for (const group of COLUMN_GROUPS) {
			grid.appendChild(this.checkbox(
				group.label,
				this.visibleColumns.indexOf(group.id) >= 0,
				checked => {
					const index = this.visibleColumns.indexOf(group.id);
					if (checked && index < 0) { this.visibleColumns.push(group.id); }
					if (!checked && index >= 0) { this.visibleColumns.splice(index, 1); }
					this.render();
				},
			));
		}
		chooser.appendChild(grid);

		const tableSection = this.section(`Measurements (${this.rows.length} rows)`);
		if (this.rows.length === 0) {
			tableSection.appendChild(this.note('Draw or import an ROI to populate the table.'));
		} else {
			tableSection.appendChild(this.buildResultsTable());
		}

		const derived = this.section('Derived columns');
		derived.appendChild(this.note(
			'Expressions over the columns above, e.g. rawIntegratedDensity / area. Saved with the ROIs and included in exports.',
		));
		for (let index = 0; index < this.derivedColumns.length; index++) {
			derived.appendChild(this.buildDerivedRow(index));
		}
		derived.appendChild(this.button('Add column', () => {
			this.derivedColumns.push({ name: `derived${this.derivedColumns.length + 1}`, expression: 'mean' });
			this.render();
		}));

		const grouping = this.section('Grouping');
		grouping.appendChild(this.textRow(
			'Filename pattern', this.groupPattern,
			value => { this.groupPattern = value; this.render(); },
			'e.g. {condition}_{replicate}_{index}.tif — braces become columns.',
		));
		const groups = this.groupPattern && source?.fileName
			? matchFilenamePattern(source.fileName, this.groupPattern)
			: null;
		if (this.groupPattern) {
			grouping.appendChild(this.note(groups
				? `Matched: ${Object.entries(groups).map(([key, value]) => `${key}=${value}`).join(', ')}`
				: 'The pattern does not match this filename.'));
		}
		if (groups && this.rows.length > 0) {
			const summaries = summarizeByGroup(this.rows, 'area', () => Object.values(groups).join(' / '));
			for (const summary of summaries) {
				grouping.appendChild(this.note(
					`${summary.key}: n=${summary.n}, mean area ${formatNumber(summary.mean)} ± ${formatNumber(summary.sem)} (SEM)`,
				));
			}
		}

		const across = this.section('Across images');
		across.appendChild(this.checkbox(
			'Collect results from every image I measure', this.collecting,
			checked => {
				this.collecting = checked;
				if (!checked) { this.collected.clear(); }
				this.refresh();
			},
			'Keeps each image\'s rows as you step through a collection, so one export covers the whole folder. Each row keeps the scale and threshold it was measured with.',
		));
		if (this.collecting) {
			const images = this.collected.size;
			const total = this.exportRows().length;
			across.appendChild(this.note(images === 0
				? 'Nothing collected yet. Step to the next image and its rows are added.'
				: `${total} row(s) from ${images} image(s). The table below still shows this image, so clicking a row still finds its object.`));
			if (images > 0) {
				across.appendChild(this.button('Forget collected rows', () => {
					this.collected.clear();
					this.refresh();
				}));
			}
		}

		const summaryRows = this.exportRows();
		if (summaryRows.length > 1) {
			const summary = this.section('Summary');
			summary.appendChild(this.note(
				this.collecting && this.collected.size > 1
					? `${summaryRows.length} row(s) across ${this.collected.size} images. This is the line you actually write down.`
					: `${summaryRows.length} measured row(s). This is the line you actually write down.`,
			));
			summary.appendChild(this.buildSummaryTable(summaryRows));
		}

		const exportSection = this.section('Export');
		const exportButtons = document.createElement('div');
		exportButtons.className = 'measure-button-row';
		exportButtons.append(
			this.button('CSV', () => this.exportTable('csv'), summaryRows.length === 0),
			this.button('CSV (de)', () => this.exportTable('csv-de'), summaryRows.length === 0),
			this.button('Excel .xlsx', () => this.exportTable('xlsx'), summaryRows.length === 0),
			this.button('pandas script', () => this.exportPandasScript(), summaryRows.length === 0),
		);
		exportSection.appendChild(exportButtons);
		exportSection.appendChild(this.note(
			'Long/tidy form: one row per ROI per channel with provenance on every row, so several exports concatenate without manual bookkeeping. '
			+ '"CSV (de)" uses a semicolon separator and a comma decimal mark for German-locale Excel. '
			+ 'The pandas script is written from this session — the columns that exist, the scale in force, the threshold used, and your derived columns as real expressions.',
		));
	}

	/**
	 * The results table.
	 *
	 * Clicking a row selects its ROI on the image. That link is the thing a
	 * spreadsheet copy destroys permanently — "which object was row 47?" becomes
	 * unanswerable the moment the numbers leave the tool.
	 */
	private buildResultsTable(): HTMLElement {
		const calibration = this.host.getCalibration();
		const wrapper = document.createElement('div');
		wrapper.className = 'measure-table-wrapper measure-results-wrapper';

		const table = document.createElement('table');
		table.className = 'measure-table';

		const columns: { key: keyof MeasurementRow; label: string; digits?: number }[] = [
			{ key: 'roiName', label: 'ROI' },
			{ key: 'channel', label: 'Ch' },
		];
		// Column order follows the group list, not the user's clicking order, so
		// the table looks the same whichever way a set was assembled.
		for (const group of COLUMN_GROUPS) {
			if (this.visibleColumns.indexOf(group.id) < 0) { continue; }
			for (const key of group.keys) {
				const label = COLUMN_LABELS[key] || String(key);
				const unit = key === 'area'
					? ` (${areaUnit(calibration)})`
					: (LENGTH_COLUMNS.indexOf(key) >= 0 ? ` (${calibration.unit})` : '');
				const digits = ['mean', 'stdDev', 'min', 'max', 'median', 'mode'].indexOf(String(key)) >= 0
					? 6
					: (['circularity', 'aspectRatio', 'roundness', 'solidity'].indexOf(String(key)) >= 0 ? 3 : undefined);
				columns.push({ key, label: label + unit, digits });
			}
		}

		const present = columns.filter(column =>
			column.key === 'roiName' || column.key === 'channel'
			|| this.rows.some(row => row[column.key] !== undefined && row[column.key] !== null));

		const head = document.createElement('thead');
		const headRow = document.createElement('tr');
		for (const column of present) {
			const cell = document.createElement('th');
			cell.textContent = column.label;
			headRow.appendChild(cell);
		}
		for (const derived of this.derivedColumns) {
			const cell = document.createElement('th');
			cell.textContent = derived.name;
			headRow.appendChild(cell);
		}
		head.appendChild(headRow);
		table.appendChild(head);

		const bodyElement = document.createElement('tbody');
		const compiled = this.derivedColumns.map(column => {
			try { return compileExpression(column.expression); } catch { return null; }
		});

		for (const row of this.rows) {
			const tr = document.createElement('tr');
			tr.dataset.roiId = row.roiId;
			tr.classList.toggle('selected', this.host.manager.isSelected(row.roiId));
			// Hover is the cheap half of "which object is this row?" — no click, no
			// selection change, just a highlight that follows the cursor.
			tr.onmouseenter = () => this.host.overlay.setHoveredRoi(row.roiId);
			tr.onmouseleave = () => this.host.overlay.setHoveredRoi(null);
			tr.onclick = event => {
				const additive = event.shiftKey || event.ctrlKey || event.metaKey;
				// Marks the selection as originating here, so the re-render keeps
				// the table where it is instead of scrolling to the new row.
				this.selectionFromTable = true;
				this.host.manager.select([row.roiId], { additive });
				// Selecting from the table is exactly the case where the object
				// may be off-screen, so bring it into view.
				if (!additive) { this.host.overlay.revealRoi(row.roiId); }
			};
			for (const column of present) {
				const cell = document.createElement('td');
				const value = row[column.key];
				cell.textContent = typeof value === 'number'
					? formatNumber(value, column.digits ?? 4)
					: (value === undefined || value === null ? '' : String(value));
				tr.appendChild(cell);
			}
			const scope: Record<string, number> = {};
			for (const key of Object.keys(row)) {
				const value = row[key as keyof MeasurementRow];
				if (typeof value === 'number') { scope[key] = value; }
			}
			for (const evaluate of compiled) {
				const cell = document.createElement('td');
				let text = '';
				if (evaluate) {
					try { text = formatNumber(evaluate(scope), 5); } catch { text = ''; }
				}
				cell.textContent = text;
				tr.appendChild(cell);
			}
			bodyElement.appendChild(tr);
		}
		table.appendChild(bodyElement);
		wrapper.appendChild(table);
		return wrapper;
	}

	/**
	 * ImageJ's "Summarize": one line per measured column across every ROI.
	 *
	 * The per-object table is the evidence, but the sentence that ends up in a
	 * methods section is "465 cells, mean area 212 µm² ± 8". Computing it here
	 * rather than leaving it to a spreadsheet is the difference between the tool
	 * answering the question and merely supplying the raw material.
	 */
	private buildSummaryTable(rows: MeasurementRow[]): HTMLElement {
		const calibration = this.host.getCalibration();
		const wrapper = document.createElement('div');
		wrapper.className = 'measure-table-wrapper';
		const table = document.createElement('table');
		table.className = 'measure-table';

		const head = document.createElement('thead');
		const headRow = document.createElement('tr');
		for (const label of ['Column', 'n', 'Mean', 'SD', 'SEM', 'Min', 'Max']) {
			const cell = document.createElement('th');
			cell.textContent = label;
			headRow.appendChild(cell);
		}
		head.appendChild(headRow);
		table.appendChild(head);

		const body = document.createElement('tbody');
		const unitFor = (column: string): string => {
			if (column === 'area') { return ` ${areaUnit(calibration)}`; }
			if (['perimeter', 'length', 'feret', 'minFeret', 'major', 'minor', 'width', 'height'].indexOf(column) >= 0) {
				return ` ${calibration.unit}`;
			}
			return '';
		};

		for (const entry of summarizeRows(rows)) {
			const tr = document.createElement('tr');
			const unit = unitFor(entry.column);
			const cells = [
				entry.column + unit,
				String(entry.summary.n),
				formatNumber(entry.summary.mean, 5),
				formatNumber(entry.summary.stdDev, 5),
				formatNumber(entry.summary.sem, 5),
				formatNumber(entry.summary.min, 5),
				formatNumber(entry.summary.max, 5),
			];
			for (const text of cells) {
				const td = document.createElement('td');
				td.textContent = text;
				tr.appendChild(td);
			}
			body.appendChild(tr);
		}
		table.appendChild(body);
		wrapper.appendChild(table);
		return wrapper;
	}

	private buildDerivedRow(index: number): HTMLElement {
		const column = this.derivedColumns[index];
		const row = document.createElement('div');
		row.className = 'measure-derived-row';

		const name = document.createElement('input');
		name.className = 'measure-input measure-derived-name';
		name.value = column.name;
		name.onchange = () => { column.name = name.value.trim() || column.name; this.render(); };
		name.onkeydown = event => event.stopPropagation();

		const expression = document.createElement('input');
		expression.className = 'measure-input measure-derived-expression';
		expression.value = column.expression;
		expression.onkeydown = event => event.stopPropagation();
		const error = document.createElement('div');
		error.className = 'measure-error';
		const validate = () => {
			try {
				compileExpression(expression.value);
				error.textContent = '';
				expression.classList.remove('invalid');
			} catch (thrown) {
				const message = thrown instanceof ExpressionError
					? `${thrown.message} at position ${thrown.position + 1}`
					: (thrown as Error).message;
				error.textContent = message;
				expression.classList.add('invalid');
			}
		};
		expression.oninput = validate;
		expression.onchange = () => { column.expression = expression.value; validate(); this.render(); };
		validate();

		const remove = document.createElement('button');
		remove.className = 'measure-roi-remove';
		remove.textContent = '×';
		remove.onclick = () => { this.derivedColumns.splice(index, 1); this.render(); };

		row.append(name, expression, remove);
		const container = document.createElement('div');
		container.append(row, error);
		return container;
	}

	// --- segmentation -------------------------------------------------------

	private renderSegment(): void {
		const source = this.host.getSource();
		const plane = this.host.getScalarPlane();
		if (!source || !plane) {
			this.section('Threshold').appendChild(this.note('No measurable image is loaded.'));
			return;
		}

		if (!this.histogram) { this.prepareThreshold(); }

		this.body.appendChild(this.buildHistogramSlider());

		const pre = this.section('Preprocess (segmentation only)');
		pre.appendChild(this.note(
			'Applied to a copy used for thresholding. The displayed image is never modified.',
		));
		pre.appendChild(this.numberRow('Gaussian blur σ', this.threshold.blurSigma, value => {
			this.threshold.blurSigma = Math.max(0, value);
			this.prepareThreshold();
			this.render();
		}, { step: '0.5', min: 0 }));
		pre.appendChild(this.numberRow('Background radius', this.threshold.backgroundRadius, value => {
			this.threshold.backgroundRadius = Math.max(0, Math.round(value));
			this.prepareThreshold();
			this.render();
		}, { step: '5', min: 0 }, 'Rolling-ball background subtraction. 0 disables it. Fixes uneven illumination, the usual reason a global threshold appears to have no right value.'));

		const methods = this.section('Method');
		methods.appendChild(this.checkbox('Objects are brighter than the background', this.threshold.darkBackground, checked => {
			this.threshold.darkBackground = checked;
			this.applyThreshold();
			this.render();
		}));
		methods.appendChild(this.note(
			this.threshold.manual
				? 'Range set by hand. Pick a method below to go back to an automatic cut.'
				: 'Hover any entry to see it on the image; click to keep it.',
		));
		methods.appendChild(this.checkbox(
			'Apply the chosen method per window', this.threshold.localizeGlobal,
			checked => {
				this.threshold.localizeGlobal = checked;
				if (checked) {
					// The two are alternatives: Sauvola and friends are their own
					// criteria, not a mode of Otsu.
					this.threshold.localMethod = 'none';
					this.threshold.manual = false;
				}
				this.applyThreshold();
				this.render();
			},
			'Runs the selected method on the histogram of a local neighbourhood instead of the whole image — ImageJ\'s "Auto Local Threshold". Use it when the same criterion is right but the illumination is not even.',
		));
		methods.appendChild(this.buildMethodGallery());

		if (this.threshold.localMethod !== 'none' || this.threshold.localizeGlobal) {
			const local = this.section('Neighbourhood');
			local.appendChild(this.numberRow('Window radius', this.threshold.localRadius, value => {
				this.threshold.localRadius = Math.max(1, Math.round(value));
				this.applyThreshold();
				this.render();
			}, { step: '1', min: 1 }, 'Somewhat larger than your objects: the window has to contain both object and background to tell them apart.'));
			if (this.threshold.localMethod !== 'none') {
				local.appendChild(this.numberRow('Sensitivity (k)', this.threshold.localK, value => {
					this.threshold.localK = value;
					this.applyThreshold();
					this.render();
				}, { step: '0.05' }, 'Higher is stricter — fewer pixels pass. 0.25 is a good starting point.'));
			}
		}

		this.body.appendChild(this.buildStabilitySection());

		const particles = this.section('Particles');
		// Every filter re-runs the analysis and repaints, so the effect of a
		// filter is visible on the image rather than only as a changed count.
		const refilter = () => {
			this.particleResult = null;
		this.particleToken++;
			this.refreshMaskOverlay();
			this.render();
		};

		const splitSelect = document.createElement('select');
		splitSelect.className = 'measure-select';
		const splitModes: { id: SplitMode; label: string; title: string }[] = [
			{ id: 'none', label: 'Do not split', title: 'Each connected region is one object.' },
			{ id: 'shape', label: 'By shape (watershed)', title: 'Distance-transform watershed. Separates round objects that overlap.' },
			{ id: 'intensity', label: 'By intensity maxima', title: 'Splits at local intensity peaks — ImageJ\'s Find Maxima with "Segmented Particles", restricted to the threshold mask. Use when objects touch without their outline pinching.' },
		];
		for (const mode of splitModes) {
			const option = document.createElement('option');
			option.value = mode.id;
			option.textContent = mode.label;
			option.title = mode.title;
			splitSelect.appendChild(option);
		}
		splitSelect.value = this.threshold.split;
		splitSelect.onchange = () => {
			this.threshold.split = splitSelect.value as SplitMode;
			if (this.threshold.split === 'intensity' && this.threshold.prominence <= 0) {
				// A prominence of zero splits at every pixel of noise. Start from
				// a tenth of the data range, which is a usable first guess on
				// almost any image and is then tuned against the live count.
				const histogram = this.histogram;
				this.threshold.prominence = histogram ? (histogram.max - histogram.min) / 10 : 1;
			}
			refilter();
		};
		particles.appendChild(this.labelled('Split touching', splitSelect));

		if (this.threshold.split === 'intensity') {
			particles.appendChild(this.numberRow('Prominence', this.threshold.prominence, value => {
				this.threshold.prominence = Math.max(0, value);
				refilter();
			}, { step: 'any', min: 0 }, 'How far a peak must rise above the saddle joining it to a brighter one before it counts as its own object. Raise it until the centre count matches what you see.'));
			const centres = this.countMaxima();
			if (centres !== null) {
				particles.appendChild(this.note(`${centres} centre(s) at this prominence.`));
			}
		}
		particles.appendChild(this.checkbox('Fill holes', this.threshold.fillHoles, checked => {
			this.threshold.fillHoles = checked;
			refilter();
		}));
		particles.appendChild(this.checkbox('Exclude objects touching the edge', this.threshold.excludeEdges, checked => {
			this.threshold.excludeEdges = checked;
			refilter();
		}, 'Edge objects are cut off, so their area and shape are not measurable.'));
		particles.appendChild(this.numberRow('Min area (px)', this.threshold.minArea, value => {
			this.threshold.minArea = Math.max(0, value);
			refilter();
		}, { step: '1', min: 0 }));
		particles.appendChild(this.numberRow(
			'Max area (px)',
			Number.isFinite(this.threshold.maxArea) ? this.threshold.maxArea : 0,
			value => {
				// 0 means "no upper limit", so the field has a way to express the
				// default without needing a separate checkbox.
				this.threshold.maxArea = value > 0 ? value : Number.POSITIVE_INFINITY;
				refilter();
			},
			{ step: '1', min: 0 },
			'0 means no upper limit. Use it to drop merged clumps that survived splitting.',
		));
		particles.appendChild(this.numberRow('Min circularity', this.threshold.minCircularity, value => {
			this.threshold.minCircularity = value;
			refilter();
		}, { step: '0.05', min: 0, max: 1 }));

		particles.appendChild(this.note(this.currentMaskStats()));
		// The two colours on the image are the only way to tell "filtered out"
		// from "never selected", and nothing else on screen explains them.
		particles.appendChild(this.buildOverlayLegend());

		// Committing the objects is the step the whole tab exists for, and a
		// plain button at the bottom of a list of filters does not read as one.
		// It gets its own block, its own weight, and a label that names the
		// number — so it reads as "you have 465 objects, take them" rather than
		// as one more option.
		this.body.appendChild(this.buildCommitAction());

		// The analysis above is cached, so adding the accepted-objects layer to
		// the preview costs nothing beyond building the overlay bitmap.
		this.refreshMaskOverlay();
	}

	/**
	 * Legend for the two overlay colours.
	 *
	 * Swatches rather than prose, and placed next to the object count, because
	 * the question the colours answer — "why is the count lower than what I can
	 * see?" — is asked while looking at that number.
	 */
	private buildOverlayLegend(): HTMLElement {
		const legend = document.createElement('div');
		legend.className = 'measure-legend';

		const entries: [string, string, string][] = [
			['rgb(40, 220, 120)', 'Green', 'part of an object that will be added'],
			['rgb(255, 60, 60)', 'Red', 'passed the threshold but was filtered out — too small or large, wrong shape, on the edge, or a line where two touching objects were split'],
		];
		for (const [swatchColor, label, meaning] of entries) {
			const row = document.createElement('div');
			row.className = 'measure-legend-row';
			const swatch = document.createElement('span');
			swatch.className = 'measure-legend-swatch';
			swatch.style.background = swatchColor;
			const text = document.createElement('span');
			text.textContent = `${label} — ${meaning}`;
			row.append(swatch, text);
			legend.appendChild(row);
		}
		return legend;
	}

	/** The call to action that turns the segmentation into measurable ROIs. */
	private buildCommitAction(): HTMLElement {
		const block = document.createElement('div');
		block.className = 'measure-cta';

		const result = this.thresholdMask ? this.ensureParticles() : null;
		const pending = !!this.thresholdMask && !result;
		const count = result ? result.particles.length : 0;

		const button = document.createElement('button');
		button.className = 'measure-cta-button';
		button.disabled = pending || count === 0;
		button.textContent = pending
			? 'Analyzing objects…'
			: count === 0
				? 'No objects to add'
				: `Add ${count} object${count === 1 ? '' : 's'} as ROIs`;
		button.onclick = () => this.commitParticles();
		block.appendChild(button);

		const caption = document.createElement('div');
		caption.className = 'measure-cta-caption';
		caption.textContent = pending
			? 'Applying the size, shape, edge, and splitting settings to the current mask.'
			: count === 0
			? (this.thresholdMask
				? 'Every object was filtered out. Loosen the size or shape limits above.'
				: 'Pick a threshold method above first.')
			: 'They become measurable ROIs: the Results table fills in, and each one can be renamed, exported, or measured on another channel.';
		block.appendChild(caption);

		return block;
	}

	/**
	 * Histogram with draggable threshold handles.
	 *
	 * This is the control people arrive expecting, and it was the piece missing
	 * from the first version: the stability curve answers "is this value
	 * robust?", but the everyday question is "where in the distribution am I
	 * cutting?", and that needs the histogram itself with the cut drawn on it and
	 * grabbable. Dragging updates the mask on the image continuously, so the
	 * threshold is chosen by watching the image, not by typing numbers.
	 */
	private buildHistogramSlider(): HTMLElement {
		const section = document.createElement('div');
		section.className = 'measure-section';
		const heading = document.createElement('div');
		heading.className = 'measure-section-title';
		heading.textContent = 'Histogram';
		section.appendChild(heading);

		const histogram = this.histogram;
		if (!histogram) { return section; }

		const canvas = document.createElement('canvas');
		canvas.className = 'measure-histogram';
		canvas.width = 460;
		canvas.height = 120;
		section.appendChild(canvas);

		const padding = { left: 8, right: 8, top: 6, bottom: 14 };
		const plotWidth = canvas.width - padding.left - padding.right;

		const valueAt = (clientX: number): number => {
			const rect = canvas.getBoundingClientRect();
			// Map through the *plot* area, not the canvas: ignoring the padding is
			// what makes a click land a few units off the value under the cursor.
			const fraction = ((clientX - rect.left) / rect.width * canvas.width - padding.left) / plotWidth;
			const clamped = Math.max(0, Math.min(1, fraction));
			return histogram.min + clamped * (histogram.max - histogram.min);
		};

		const draw = () => this.drawHistogramSlider(canvas, padding);
		draw();

		// Grab whichever handle is nearer, then track until release. Pointer
		// capture keeps the drag alive when the cursor leaves the small canvas,
		// which it will constantly at this size.
		let dragging: 'low' | 'high' | null = null;
		canvas.addEventListener('pointerdown', event => {
			const value = valueAt(event.clientX);
			dragging = Math.abs(value - this.threshold.low) <= Math.abs(value - this.threshold.high) ? 'low' : 'high';
			canvas.setPointerCapture(event.pointerId);
			// Dragging the range is a global, manual cut. An adaptive method
			// computes its own threshold per pixel and would simply ignore these
			// handles, so taking hold of them has to switch it off — otherwise the
			// control silently does nothing.
			this.threshold.manual = true;
			this.threshold.localMethod = 'none';
			this.threshold.localizeGlobal = false;
			if (dragging === 'low') { this.threshold.low = value; } else { this.threshold.high = value; }
			this.applyThreshold();
			draw();
			event.preventDefault();
		});
		canvas.addEventListener('pointermove', event => {
			if (!dragging) { return; }
			const value = valueAt(event.clientX);
			if (dragging === 'low') { this.threshold.low = Math.min(value, this.threshold.high); }
			else { this.threshold.high = Math.max(value, this.threshold.low); }
			this.applyThreshold();
			draw();
		});
		const endDrag = () => {
			if (!dragging) { return; }
			dragging = null;
			// Re-render once at the end so the object count and the green accepted
			// layer catch up; doing that per pointermove would stall a large image.
			this.render();
		};
		canvas.addEventListener('pointerup', endDrag);
		canvas.addEventListener('pointercancel', endDrag);

		const adaptive = this.threshold.localMethod !== 'none' || this.threshold.localizeGlobal;
		section.appendChild(this.note(adaptive
			? 'An adaptive method is active, so it computes its own threshold per neighbourhood and this range is not in use. Drag a handle to take manual control.'
			: `Drag either edge of the shaded band to set the range. Currently ${formatNumber(this.threshold.low, 4)} – ${formatNumber(this.threshold.high, 4)}.`));
		if (adaptive) { canvas.classList.add('measure-histogram-inactive'); }
		return section;
	}

	private drawHistogramSlider(canvas: HTMLCanvasElement, padding: { left: number; right: number; top: number; bottom: number }): void {
		const ctx = canvas.getContext('2d');
		const histogram = this.histogram;
		if (!ctx || !histogram) { return; }

		const plotWidth = canvas.width - padding.left - padding.right;
		const plotHeight = canvas.height - padding.top - padding.bottom;
		ctx.clearRect(0, 0, canvas.width, canvas.height);

		let peak = 1;
		for (let i = 0; i < histogram.counts.length; i++) {
			if (histogram.counts[i] > peak) { peak = histogram.counts[i]; }
		}
		// Log scale: a sparse foreground next to a background peak two orders of
		// magnitude taller would otherwise be a flat line at the axis.
		const barHeight = (count: number) => (Math.log1p(count) / Math.log1p(peak)) * plotHeight;

		const toX = (value: number) => {
			const span = histogram.max - histogram.min;
			const fraction = span > 0 ? (value - histogram.min) / span : 0;
			return padding.left + Math.max(0, Math.min(1, fraction)) * plotWidth;
		};

		const lowX = toX(this.threshold.low);
		const highX = toX(this.threshold.high);

		// Selected band behind the bars, so the cut reads as a region of the
		// distribution rather than as two unrelated lines.
		ctx.fillStyle = 'rgba(255, 80, 80, 0.18)';
		ctx.fillRect(lowX, padding.top, Math.max(1, highX - lowX), plotHeight);

		for (let x = 0; x < plotWidth; x++) {
			const index = Math.floor((x / plotWidth) * histogram.counts.length);
			const height = barHeight(histogram.counts[index]);
			const value = histogram.min + (index / histogram.counts.length) * (histogram.max - histogram.min);
			const inside = value >= this.threshold.low && value <= this.threshold.high;
			ctx.fillStyle = inside ? 'rgba(255, 110, 110, 0.95)' : 'rgba(150, 150, 150, 0.65)';
			ctx.fillRect(padding.left + x, padding.top + plotHeight - height, 1, height);
		}

		for (const x of [lowX, highX]) {
			ctx.strokeStyle = '#ffffff';
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			ctx.moveTo(x, padding.top);
			ctx.lineTo(x, padding.top + plotHeight);
			ctx.stroke();
			// A grip, so the line reads as draggable rather than decorative.
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(x - 3, padding.top + plotHeight / 2 - 7, 6, 14);
		}

		ctx.fillStyle = 'rgba(160, 160, 160, 0.9)';
		ctx.font = '10px var(--vscode-editor-font-family, monospace)';
		ctx.textAlign = 'left';
		ctx.fillText(formatNumber(histogram.min, 4), padding.left, canvas.height - 3);
		ctx.textAlign = 'right';
		ctx.fillText(formatNumber(histogram.max, 4), padding.left + plotWidth, canvas.height - 3);
	}

	/**
	 * The auto-threshold gallery.
	 *
	 * Every method is evaluated against the same 256-bin histogram, so showing
	 * all of them costs about as much as showing one. ImageJ's equivalent
	 * produces a static montage in a separate window; here each entry is a live
	 * button that reports what it selected, which turns method choice into
	 * looking rather than guessing.
	 *
	 * Global and local methods live in the same list because they are the same
	 * choice: only one of them is ever in force. Splitting them across two
	 * controls made the gallery lie — it kept previewing a global cut while a
	 * local method was the one actually applied.
	 */
	private buildMethodGallery(): HTMLElement {
		const grid = document.createElement('div');
		grid.className = 'measure-method-grid';
		const histogram = this.histogram;
		const source = this.host.getSource();
		if (!histogram || !source) { return grid; }

		// Cached per histogram: `autoThresholdBin` now reaches Rust/WASM, and
		// evaluating all thirteen methods synchronously on every render would
		// mean thirteen blocking round trips per keystroke. `ensureMethodBins`
		// returns the cached map immediately once computed, and triggers a
		// background recompute (with a re-render on completion) otherwise —
		// the same lazy-async pattern `ensureParticles` uses.
		const methodBins = this.ensureMethodBins();

		for (const method of THRESHOLD_METHODS) {
			const bin = methodBins?.get(method.id) ?? -1;
			const pending = !methodBins;
			const localized = this.threshold.localizeGlobal;
			const active = !this.threshold.manual
				&& this.threshold.localMethod === 'none'
				&& this.threshold.method === method.id;
			const button = this.methodButton({
				label: localized ? `${method.label} · per window` : method.label,
				hint: pending
					? `${method.hint}\n\nComputing…`
					: (bin < 0 ? `${method.hint}\n\nNo threshold found for this histogram.` : method.hint),
				value: localized
					? `r=${this.threshold.localRadius}`
					: (pending ? '…' : (bin < 0 ? '—' : formatNumber(thresholdValueFromBin(histogram, bin), 4))),
				active,
				disabled: pending || (bin < 0 && !localized),
				spark: localized || pending ? undefined : this.buildHistogramSpark(histogram, bin),
				computeMask: async () => {
					if (!this.previewPlane) { return null; }
					if (localized) {
						return localAutoThresholdMask(this.previewPlane, source.width, source.height, {
							method: method.id,
							radius: this.threshold.localRadius,
							darkBackground: this.threshold.darkBackground,
						});
					}
					if (bin < 0) { return null; }
					const value = thresholdValueFromBin(histogram, bin);
					return this.threshold.darkBackground
						? globalThresholdMask(this.previewPlane, value, histogram.max)
						: globalThresholdMask(this.previewPlane, histogram.min, value);
				},
				apply: () => {
					this.threshold.method = method.id;
					this.threshold.localMethod = 'none';
					this.threshold.manual = false;
				},
			});
			grid.appendChild(button);
		}

		// Local methods are the same choice as the global ones — only one is ever
		// applied — so they belong in the same list. Keeping them in a separate
		// dropdown made this gallery preview a global cut while a local method
		// was what actually ran.
		for (const method of LOCAL_METHODS) {
			if (method.id === 'none') { continue; }
			const active = this.threshold.localMethod === method.id;
			const button = this.methodButton({
				label: `${method.label} (local)`,
				hint: method.hint,
				value: `r=${this.threshold.localRadius}, k=${formatNumber(this.threshold.localK, 2)}`,
				active,
				disabled: false,
				computeMask: async () => this.previewPlane
					? localThresholdMask(this.previewPlane, source.width, source.height, {
						method: method.id,
						radius: this.threshold.localRadius,
						k: this.threshold.localK,
						darkBackground: this.threshold.darkBackground,
					})
					: null,
				apply: () => {
					this.threshold.localMethod = method.id;
					this.threshold.localizeGlobal = false;
					this.threshold.manual = false;
				},
			});
			grid.appendChild(button);
		}

		return grid;
	}

	/** Cached auto-threshold bin per method; see `buildMethodGallery` above. */
	private ensureMethodBins(): Map<ThresholdMethod, number> | null {
		if (this.methodBins) { return this.methodBins; }
		void this.computeMethodBins(this.thresholdToken);
		return null;
	}

	private async computeMethodBins(token: number): Promise<void> {
		if (this.methodBinsBusy) { return; }
		const histogram = this.histogram;
		if (!histogram) { return; }
		this.methodBinsBusy = true;
		try {
			const bins = new Map<ThresholdMethod, number>();
			for (const method of THRESHOLD_METHODS) {
				const bin = await autoThresholdBin(histogram.counts, method.id);
				if (token !== this.thresholdToken) { return; }
				bins.set(method.id, bin);
			}
			this.methodBins = bins;
			this.render();
		} finally {
			this.methodBinsBusy = false;
		}
	}

	/**
	 * One entry of the method gallery.
	 *
	 * `computeMask` is what the entry would actually produce, so the hover
	 * preview and the click can never disagree about the result — the bug that
	 * made local methods preview as global ones came from having those two paths
	 * written separately.
	 */
	private methodButton(spec: {
		label: string;
		hint: string;
		value: string;
		active: boolean;
		disabled: boolean;
		spark?: HTMLCanvasElement;
		computeMask: () => Promise<Uint8Array | null>;
		apply: () => void;
	}): HTMLButtonElement {
		const button = document.createElement('button');
		button.className = 'measure-method';
		button.classList.toggle('active', spec.active);
		button.disabled = spec.disabled;
		button.title = spec.hint;

		const label = document.createElement('div');
		label.className = 'measure-method-label';
		label.textContent = spec.label;
		const value = document.createElement('div');
		value.className = 'measure-method-value';
		value.textContent = spec.value;
		button.append(label, value);
		if (spec.spark) { button.appendChild(spec.spark); }

		// `computeMask` now reaches Rust/WASM, so the preview is a single async
		// call rather than an inline one. `hoverToken` discards a mask that
		// resolves after the pointer has already left the button.
		button.onmouseenter = () => {
			if (spec.disabled) { return; }
			const token = ++this.hoverToken;
			void (async () => {
				const mask = await spec.computeMask();
				if (token !== this.hoverToken || !mask) { return; }
				this.showTemporaryMask(mask);
				this.setHint(`${spec.label}: preview in red — click to keep it, then the filters mark kept objects green.`);
			})();
		};
		button.onmouseleave = () => {
			this.hoverToken++;
			this.showTemporaryMask(null);
		};
		button.onclick = () => {
			spec.apply();
			this.applyThreshold();
			this.render();
		};
		return button;
	}

	/** A tiny histogram with the candidate threshold marked. */
	private buildHistogramSpark(histogram: ScalarHistogram, bin: number): HTMLCanvasElement {
		const canvas = document.createElement('canvas');
		canvas.className = 'measure-spark';
		canvas.width = 96;
		canvas.height = 24;
		const ctx = canvas.getContext('2d');
		if (!ctx) { return canvas; }

		let peak = 1;
		for (let i = 0; i < histogram.counts.length; i++) { if (histogram.counts[i] > peak) { peak = histogram.counts[i]; } }
		// A log scale keeps a sparse foreground visible next to a background peak
		// that is typically two orders of magnitude taller.
		const scale = (value: number) => Math.log1p(value) / Math.log1p(peak);

		ctx.fillStyle = 'rgba(140, 140, 140, 0.55)';
		for (let x = 0; x < canvas.width; x++) {
			const index = Math.floor((x / canvas.width) * histogram.counts.length);
			const height = scale(histogram.counts[index]) * canvas.height;
			ctx.fillRect(x, canvas.height - height, 1, height);
		}
		if (bin >= 0) {
			ctx.fillStyle = '#ff6b6b';
			const x = (bin / histogram.counts.length) * canvas.width;
			ctx.fillRect(x, 0, 1.5, canvas.height);
		}
		return canvas;
	}

	/**
	 * The stability curve.
	 *
	 * Object count against threshold, with the widest plateau marked. A user
	 * dragging a slider cannot otherwise tell whether the value they picked sits
	 * on a knife edge or in a broad basin where the answer does not depend on
	 * the guess — this shows it directly, and clicking the plateau adopts it.
	 */
	private buildStabilitySection(): HTMLElement {
		const section = document.createElement('div');
		section.className = 'measure-section';
		const heading = document.createElement('div');
		heading.className = 'measure-section-title';
		heading.textContent = 'How robust is this threshold?';
		section.appendChild(heading);

		if (!this.stability || !this.histogram) {
			section.appendChild(this.note(
				'Sweeps the threshold across the whole range and plots how many objects each value gives. '
				+ 'Flat stretches are values where the count does not depend on your exact choice — pick one of those and the result stops being a guess.',
			));
			section.appendChild(this.button('Compute', () => {
				this.computeStability();
				this.render();
			}));
			return section;
		}

		const canvas = document.createElement('canvas');
		canvas.className = 'measure-stability';
		canvas.width = 460;
		canvas.height = 120;
		this.drawStability(canvas);
		// Click *and* drag, mapped through the plot area rather than the whole
		// canvas. Using the raw canvas width put every pick off by the left
		// padding — small, but enough to land beside the plateau you aimed at.
		const padding = { left: 34, right: 8 };
		const plotWidth = canvas.width - padding.left - padding.right;
		const pickAt = (clientX: number) => {
			const rect = canvas.getBoundingClientRect();
			const canvasX = (clientX - rect.left) / rect.width * canvas.width;
			const fraction = (canvasX - padding.left) / plotWidth;
			const points = this.stability!.points;
			const index = Math.round(Math.max(0, Math.min(1, fraction)) * (points.length - 1));
			return points[index];
		};

		let scrubbing = false;
		canvas.addEventListener('pointerdown', event => {
			scrubbing = true;
			canvas.setPointerCapture(event.pointerId);
			this.adoptThresholdValue(pickAt(event.clientX).value);
			this.drawStability(canvas);
			event.preventDefault();
		});
		canvas.addEventListener('pointermove', event => {
			if (!scrubbing) { return; }
			this.adoptThresholdValue(pickAt(event.clientX).value);
			this.drawStability(canvas);
		});
		const endScrub = () => {
			if (!scrubbing) { return; }
			scrubbing = false;
			this.render();
		};
		canvas.addEventListener('pointerup', endScrub);
		canvas.addEventListener('pointercancel', endScrub);
		section.appendChild(canvas);

		const suggested = thresholdValueFromBin(this.histogram, this.stability.suggestedBin);
		section.appendChild(this.note(
			this.stability.plateauWidth > 1
				? `Widest plateau spans ${this.stability.plateauWidth} of ${this.stability.points.length} sampled thresholds; its centre is ${formatNumber(suggested, 4)}.`
				: 'No clear plateau — the object count changes continuously, so this image may need local adaptive thresholding instead.',
		));
		section.appendChild(this.note('Click or drag across the plot to set the threshold.'));
		section.appendChild(this.button('Use the most stable threshold', () => {
			this.adoptThresholdValue(suggested);
			this.render();
		}));
		return section;
	}

	private drawStability(canvas: HTMLCanvasElement): void {
		const ctx = canvas.getContext('2d');
		const curve = this.stability;
		if (!ctx || !curve || curve.points.length === 0) { return; }

		const width = canvas.width;
		const height = canvas.height;
		const padding = { left: 34, right: 8, top: 8, bottom: 18 };
		const plotWidth = width - padding.left - padding.right;
		const plotHeight = height - padding.top - padding.bottom;

		let maxCount = 1;
		for (const point of curve.points) { if (point.objectCount > maxCount) { maxCount = point.objectCount; } }

		ctx.clearRect(0, 0, width, height);
		ctx.strokeStyle = 'rgba(128, 128, 128, 0.4)';
		ctx.strokeRect(padding.left, padding.top, plotWidth, plotHeight);

		// Area fraction as a filled backdrop, object count as the line on top.
		ctx.fillStyle = 'rgba(90, 156, 255, 0.18)';
		ctx.beginPath();
		ctx.moveTo(padding.left, padding.top + plotHeight);
		curve.points.forEach((point, index) => {
			const x = padding.left + (index / (curve.points.length - 1)) * plotWidth;
			ctx.lineTo(x, padding.top + plotHeight - point.areaFraction * plotHeight);
		});
		ctx.lineTo(padding.left + plotWidth, padding.top + plotHeight);
		ctx.closePath();
		ctx.fill();

		ctx.strokeStyle = '#ffd400';
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		curve.points.forEach((point, index) => {
			const x = padding.left + (index / (curve.points.length - 1)) * plotWidth;
			const y = padding.top + plotHeight - (point.objectCount / maxCount) * plotHeight;
			if (index === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
		});
		ctx.stroke();

		// Mark the currently selected threshold.
		if (this.histogram) {
			const bin = valueToBin(this.histogram, this.threshold.darkBackground ? this.threshold.low : this.threshold.high);
			const index = curve.points.findIndex(point => point.bin >= bin);
			if (index >= 0) {
				const x = padding.left + (index / (curve.points.length - 1)) * plotWidth;
				ctx.strokeStyle = '#ff6b6b';
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(x, padding.top);
				ctx.lineTo(x, padding.top + plotHeight);
				ctx.stroke();
			}
		}

		ctx.fillStyle = 'rgba(160, 160, 160, 0.9)';
		ctx.font = '10px var(--vscode-editor-font-family, monospace)';
		ctx.textAlign = 'right';
		ctx.fillText(String(maxCount), padding.left - 4, padding.top + 8);
		ctx.fillText('0', padding.left - 4, padding.top + plotHeight);
		ctx.textAlign = 'left';
		ctx.fillText('objects (line) · area (fill)', padding.left + 2, height - 5);
	}

	// --- threshold plumbing -------------------------------------------------

	private async preprocessedPlane(): Promise<Float32Array | null> {
		const plane = this.host.getScalarPlane();
		const source = this.host.getSource();
		if (!plane || !source) { return null; }
		let working = plane;
		if (this.threshold.blurSigma > 0) {
			working = await gaussianBlur(working, source.width, source.height, this.threshold.blurSigma);
		}
		if (this.threshold.backgroundRadius > 0) {
			working = await subtractBackground(
				working, source.width, source.height,
				this.threshold.backgroundRadius, !this.threshold.darkBackground,
			);
		}
		return working;
	}

	/**
	 * Lazy trigger: rebuilds the histogram (and, unless manual, the threshold
	 * mask) in the background and re-renders when it lands. Synchronous
	 * callers keep calling this exactly as before `buildHistogram` moved to
	 * Rust/WASM — the async work now happens off to the side rather than
	 * inline, per the lazy-async + staleness-token pattern `ensureParticles`
	 * already uses below.
	 */
	private prepareThreshold(): void {
		this.thresholdToken++;
		this.histogram = null;
		this.stability = null;
		this.methodBins = null;
		void this.runPrepareThreshold(this.thresholdToken);
	}

	private async runPrepareThreshold(token: number): Promise<void> {
		if (this.thresholdPrepareBusy) { return; }
		this.thresholdPrepareBusy = true;
		try {
			const source = this.host.getSource();
			const plane = await this.preprocessedPlane();
			if (!source || !plane) { return; }
			// Subsample the histogram on large images; every method below is
			// scale-invariant in the counts, so the chosen bin does not move.
			const step = Math.max(1, Math.floor(plane.length / 1_000_000));
			const histogram = await buildHistogram(plane, step);
			if (token !== this.thresholdToken) { return; }
			this.previewPlane = plane;
			this.histogram = histogram;
			if (!this.threshold.manual) {
				await this.runApplyThreshold(token);
				if (token !== this.thresholdToken) { return; }
			}
			this.render();
		} finally {
			this.thresholdPrepareBusy = false;
		}
	}

	/** Lazy trigger for `runApplyThreshold`; see `prepareThreshold` above. */
	private applyThreshold(): void {
		this.thresholdToken++;
		void this.runApplyThreshold(this.thresholdToken);
	}

	private async runApplyThreshold(token: number): Promise<void> {
		if (this.thresholdApplyBusy) { return; }
		this.thresholdApplyBusy = true;
		try {
			const source = this.host.getSource();
			const plane = this.previewPlane;
			const histogram = this.histogram;
			if (!source || !plane || !histogram) { return; }

			const usingGlobalAuto = !this.threshold.manual
				&& this.threshold.localMethod === 'none'
				&& !this.threshold.localizeGlobal;

			if (usingGlobalAuto) {
				const bin = await autoThresholdBin(histogram.counts, this.threshold.method);
				if (token !== this.thresholdToken) { return; }
				if (bin >= 0) {
					const value = thresholdValueFromBin(histogram, bin);
					if (this.threshold.darkBackground) {
						this.threshold.low = value;
						this.threshold.high = histogram.max;
					} else {
						this.threshold.low = histogram.min;
						this.threshold.high = value;
					}
				}
			}

			let mask: Uint8Array;
			if (this.threshold.localMethod !== 'none') {
				mask = await localThresholdMask(plane, source.width, source.height, {
					method: this.threshold.localMethod,
					radius: this.threshold.localRadius,
					k: this.threshold.localK,
					darkBackground: this.threshold.darkBackground,
				});
			} else if (this.threshold.localizeGlobal && !this.threshold.manual) {
				mask = await localAutoThresholdMask(plane, source.width, source.height, {
					method: this.threshold.method,
					radius: this.threshold.localRadius,
					darkBackground: this.threshold.darkBackground,
				});
			} else {
				mask = await globalThresholdMask(plane, this.threshold.low, this.threshold.high);
			}
			if (token !== this.thresholdToken) { return; }
			this.thresholdMask = mask;
			this.particleResult = null;
			this.particleToken++;
			// Raw mask only: this runs on every keystroke in the range fields, and a
			// full labelling pass per keystroke would stall a large image. The green
			// accepted layer is added once per render, where the particle analysis
			// has to happen anyway for the object count.
			this.refreshMaskOverlay({ withParticles: false });
			this.render();
		} finally {
			this.thresholdApplyBusy = false;
		}
	}

	/**
	 * Paint the current threshold over the image.
	 *
	 * Without this a threshold is chosen blind: the object count and the
	 * stability curve say how many things were found, but not *which* things,
	 * and a user has no way to tell a correct segmentation from a plausible
	 * number. Red is everything the threshold selected, green the subset that
	 * survives the particle filters — so "selected but filtered out" is visible
	 * rather than merely implied by a smaller count.
	 *
	 * `analyzeParticles` is only run when a result is already cached or cheap to
	 * obtain; the hover previews below deliberately show the raw mask alone so
	 * that sweeping the method gallery stays instant on large images.
	 */
	private refreshMaskOverlay(options: { withParticles?: boolean } = {}): void {
		const source = this.host.getSource();
		if (!this.showMaskOverlay || !this.thresholdMask || !source) {
			this.host.overlay.setMaskPreview(null);
			return;
		}

		let accepted: Uint8Array | null = null;
		if (options.withParticles !== false) {
			const result = this.ensureParticles();
			if (result) {
				accepted = new Uint8Array(source.width * source.height);
				for (const particle of result.particles) {
					for (let row = 0; row < particle.height; row++) {
						const target = (particle.y + row) * source.width + particle.x;
						for (let col = 0; col < particle.width; col++) {
							if (particle.mask[row * particle.width + col]) { accepted[target + col] = 1; }
						}
					}
				}
			}
		}

		this.host.overlay.setMaskPreview({
			width: source.width,
			height: source.height,
			mask: this.thresholdMask,
			accepted,
		});
	}

	/** Temporarily show another mask, e.g. while hovering a method button. */
	private showTemporaryMask(mask: Uint8Array | null): void {
		const source = this.host.getSource();
		if (!this.showMaskOverlay || !source) { return; }
		if (!mask) { this.refreshMaskOverlay(); return; }
		this.host.overlay.setMaskPreview({
			width: source.width,
			height: source.height,
			mask,
			accepted: null,
		});
	}

	private adoptThresholdValue(value: number): void {
		if (!this.histogram) { return; }
		this.threshold.manual = true;
		if (this.threshold.darkBackground) {
			this.threshold.low = value;
			this.threshold.high = this.histogram.max;
		} else {
			this.threshold.low = this.histogram.min;
			this.threshold.high = value;
		}
		this.applyThreshold();
	}

	/** Lazy trigger, invoked from the "Compute" button; see `prepareThreshold`. */
	private computeStability(): void {
		void this.runComputeStability(this.thresholdToken);
	}

	private async runComputeStability(token: number): Promise<void> {
		if (this.stabilityBusy) { return; }
		this.stabilityBusy = true;
		try {
			const source = this.host.getSource();
			const plane = this.previewPlane;
			const histogram = this.histogram;
			if (!source || !plane || !histogram) { return; }
			const curve = await computeStabilityCurve(plane, source.width, source.height, histogram, {
				darkBackground: this.threshold.darkBackground,
			});
			if (token !== this.thresholdToken) { return; }
			this.stability = curve;
			this.render();
		} finally {
			this.stabilityBusy = false;
		}
	}

	private currentMaskStats(): string {
		const source = this.host.getSource();
		if (!this.thresholdMask || !source) { return 'No threshold applied yet.'; }
		const result = this.ensureParticles();
		if (!result) { return 'Analyzing objects…'; }
		const rejected = result.rejected;
		const dropped = rejected.tooSmall + rejected.tooLarge + rejected.shape + rejected.edge;
		const parts = [`${result.particles.length} objects`];
		if (dropped > 0) {
			const reasons: string[] = [];
			if (rejected.tooSmall) { reasons.push(`${rejected.tooSmall} too small`); }
			if (rejected.tooLarge) { reasons.push(`${rejected.tooLarge} too large`); }
			if (rejected.shape) { reasons.push(`${rejected.shape} by shape`); }
			if (rejected.edge) { reasons.push(`${rejected.edge} on the edge`); }
			parts.push(`${dropped} filtered out (${reasons.join(', ')})`);
		}
		return parts.join(' · ');
	}

	/**
	 * Particle analysis for the current threshold mask, or null while it is
	 * still being computed.
	 *
	 * Deliberately LAZY, not eager. The threshold mask is rebuilt on every
	 * keystroke in the range fields, and labelling a full-resolution mask costs
	 * ~280 ms at 5120x5120 even in Rust (it was ~1 s in JavaScript) — so
	 * recomputing on every mask change would stall exactly the interaction the
	 * mask exists to serve. Instead the work starts on first USE after an
	 * invalidation, runs off the UI thread, and the panel re-renders when it
	 * lands. Every caller already handles a null result, which is what makes
	 * that safe.
	 */
	private ensureParticles() {
		if (this.particleResult) { return this.particleResult; }
		void this.startParticleAnalysis();
		return null;
	}

	/**
	 * Runs one particle analysis at a time and discards stale results.
	 *
	 * `particleToken` rises on every invalidation, so a pass that finishes
	 * after the user has moved the threshold on is dropped rather than
	 * overwriting a newer answer with an older one.
	 */
	private async startParticleAnalysis(): Promise<void> {
		if (this.particleAnalysisRunning) { return; }
		const token = this.particleToken;
		this.particleAnalysisRunning = true;
		try {
			const result = await this.runParticles();
			if (token !== this.particleToken) { return; }
			this.particleResult = result;
			// The count, CTA, and green accepted-object preview are one result and
			// must update together. Refreshing only the canvas left the panel saying
			// "No objects" even while accepted objects were visibly green.
			if (result && this.isVisible()) { this.render(); }
		} catch (error) {
			console.warn('[MeasurePanel] Particle analysis failed:', error);
		} finally {
			this.particleAnalysisRunning = false;
			// A filter can change while the worker/WASM pass is in flight. The old
			// result is correctly discarded above; immediately service the newer
			// request so the panel cannot remain stuck in its pending state.
			if (token !== this.particleToken && this.thresholdMask && this.isVisible()) {
				void this.startParticleAnalysis();
			}
		}
	}

	private async runParticles() {
		const source = this.host.getSource();
		if (!this.thresholdMask || !source) { return null; }
		return await analyzeParticles(this.thresholdMask, source.width, source.height, {
			minArea: this.threshold.minArea,
			maxArea: Number.isFinite(this.threshold.maxArea) ? this.threshold.maxArea : undefined,
			minCircularity: this.threshold.minCircularity > 0 ? this.threshold.minCircularity : undefined,
			maxCircularity: this.threshold.maxCircularity < 1 ? this.threshold.maxCircularity : undefined,
			excludeEdges: this.threshold.excludeEdges,
			fillHoles: this.threshold.fillHoles,
		}, {
			split: this.threshold.split,
			prominence: this.threshold.prominence,
			plane: this.previewPlane || undefined,
		});
	}

	/** Centres the current prominence would accept, for the live readout. */
	private countMaxima(): number | null {
		const source = this.host.getSource();
		if (!this.thresholdMask || !this.previewPlane || !source) { return null; }
		return countIntensityMaxima(
			this.previewPlane, this.thresholdMask, source.width, source.height, this.threshold.prominence,
		);
	}

	private commitParticles(): void {
		const result = this.ensureParticles();
		if (!result || result.particles.length === 0) { return; }
		const manager = this.host.manager;
		const rois: Roi[] = result.particles.map((particle, index) =>
			particleToRoi(particle, manager.nextId(), `Object ${index + 1}`));
		manager.addMany(rois, { select: false });
		// The objects are real ROIs now and are drawn as outlines; leaving the
		// filled preview underneath would double up and hide their boundaries.
		this.showMaskOverlay = false;
		this.host.overlay.setMaskPreview(null);
		this.setHint(`Added ${rois.length} objects as ROIs. Their outlines are on the image; click a table row to highlight one.`);
		this.setTab('results');
	}

	// --- calibration --------------------------------------------------------

	private renderSetup(): void {
		const calibration = this.host.getCalibration();
		const section = this.section('Spatial calibration');
		section.appendChild(this.note(describeCalibration(calibration)));

		section.appendChild(this.numberRow('Pixel width', calibration.pixelWidth, value => {
			this.host.setCalibration({ ...calibration, pixelWidth: value, origin: 'manual' });
			this.refresh();
		}, { step: 'any', min: 0 }));
		section.appendChild(this.numberRow('Pixel height', calibration.pixelHeight, value => {
			this.host.setCalibration({ ...calibration, pixelHeight: value, origin: 'manual' });
			this.refresh();
		}, { step: 'any', min: 0 }));
		section.appendChild(this.textRow('Unit', calibration.unit, value => {
			this.host.setCalibration({ ...calibration, unit: value || 'px', origin: 'manual' });
			this.refresh();
		}));

		const fromLine = this.section('Set scale from a known distance');
		fromLine.appendChild(this.note(
			'Draw a line along a feature whose real length you know — a scale bar, a calibration grid — and enter that length.',
		));
		fromLine.appendChild(this.button('Draw calibration line', () => {
			this.host.overlay.setTool('calibrate');
			this.setTab('setup');
		}));
		if (this.pendingCalibrationDistance > 0) {
			fromLine.appendChild(this.note(`Measured ${formatNumber(this.pendingCalibrationDistance, 5)} px.`));
			const lengthInput = document.createElement('input');
			lengthInput.className = 'measure-input';
			lengthInput.type = 'number';
			lengthInput.step = 'any';
			lengthInput.placeholder = 'Known length';
			lengthInput.onkeydown = event => event.stopPropagation();
			const unitInput = document.createElement('input');
			unitInput.className = 'measure-input measure-unit-input';
			unitInput.value = calibration.unit === 'px' ? 'µm' : calibration.unit;
			unitInput.onkeydown = event => event.stopPropagation();
			const apply = this.button('Apply', () => {
				const updated = calibrationFromKnownDistance(
					this.pendingCalibrationDistance, parseFloat(lengthInput.value), unitInput.value.trim(),
				);
				if (updated) {
					this.host.setCalibration(updated);
					this.pendingCalibrationDistance = 0;
					this.host.overlay.setTool('select');
					this.refresh();
				}
			});
			const row = document.createElement('div');
			row.className = 'measure-button-row';
			row.append(lengthInput, unitInput, apply);
			fromLine.appendChild(row);
		}

		const reset = this.section('Reset');
		reset.appendChild(this.button('Back to pixels', () => {
			this.host.setCalibration({ pixelWidth: 1, pixelHeight: 1, unit: 'px', origin: 'none' });
			this.refresh();
		}));
	}

	/** Called by the overlay when a calibration line is finished. */
	onCalibrationLine(pixelDistance: number): void {
		this.pendingCalibrationDistance = pixelDistance;
		this.setTab('setup');
	}

	// --- export -------------------------------------------------------------

	private provenance(): MeasurementProvenance {
		const calibration = this.host.getCalibration();
		const source = this.host.getSource();
		const preprocessing: string[] = [];
		if (this.threshold.blurSigma > 0) { preprocessing.push(`gaussian:${this.threshold.blurSigma}`); }
		if (this.threshold.backgroundRadius > 0) { preprocessing.push(`rollingBall:${this.threshold.backgroundRadius}`); }

		return {
			fileName: source?.fileName,
			unit: calibration.unit,
			pixelWidth: calibration.pixelWidth,
			pixelHeight: calibration.pixelHeight,
			calibrationOrigin: calibration.origin,
			thresholdMethod: this.thresholdMask
				? (this.threshold.localMethod !== 'none'
					? `local:${this.threshold.localMethod}`
					: (this.threshold.manual ? 'manual' : this.threshold.method))
				: undefined,
			thresholdLow: this.thresholdMask ? this.threshold.low : undefined,
			thresholdHigh: this.thresholdMask ? this.threshold.high : undefined,
			preprocessing: [
				...preprocessing,
				this.threshold.split === 'shape' ? 'watershed' : '',
				this.threshold.split === 'intensity' ? `maxima:${this.threshold.prominence}` : '',
			].filter(Boolean).join(' ') || undefined,
			extensionVersion: this.host.extensionVersion,
		};
	}

	private baseName(): string {
		const source = this.host.getSource();
		const name = source?.fileName || 'image';
		return (name.split('/').pop() || name).replace(/\.[^.]+$/, '');
	}

	private extraColumns(): Record<string, string> {
		const source = this.host.getSource();
		if (!this.groupPattern || !source?.fileName) { return {}; }
		return matchFilenamePattern(source.fileName, this.groupPattern) || {};
	}

	private exportTable(format: 'csv' | 'csv-de' | 'xlsx'): void {
		const provenance = this.provenance();
		const extraColumns = this.extraColumns();
		const rows = this.exportRows();
		// Per-row lookups only when collecting; a single-image export has one
		// provenance and does not need the indirection.
		const provenanceForRow = this.collecting
			? (row: MeasurementRow) => this.snapshotFor(row)?.provenance
			: undefined;
		const extraColumnsForRow = this.collecting
			? (row: MeasurementRow) => this.snapshotFor(row)?.extraColumns
			: undefined;

		if (format === 'xlsx') {
			const text = rowsToDelimitedText(rows, provenance, {
				delimiter: '\t',
				derivedColumns: this.derivedColumns,
				extraColumns,
				provenanceForRow,
				extraColumnsForRow,
			});
			const lines = text.trimEnd().split('\n');
			const sheetRows = lines.map(line => line.split('\t').map(cell => {
				const unquoted = cell.replace(/^"|"$/g, '').replace(/""/g, '"');
				const asNumber = Number(unquoted);
				return unquoted !== '' && Number.isFinite(asNumber) ? asNumber : unquoted;
			}));
			this.host.saveBinaryFile(`${this.baseName()}-results.xlsx`, buildXlsx({ name: 'Results', rows: sheetRows }));
			return;
		}

		const german = format === 'csv-de';
		const text = rowsToDelimitedText(rows, provenance, {
			delimiter: german ? ';' : ',',
			decimal: german ? ',' : '.',
			bom: true,
			derivedColumns: this.derivedColumns,
			extraColumns,
			provenanceForRow,
			extraColumnsForRow,
		});
		this.host.saveTextFile(`${this.baseName()}-results.csv`, text, { open: true });
	}

	private exportPandasScript(): void {
		const calibration = this.host.getCalibration();
		const source = this.host.getSource();
		// Only columns the rows actually populate, so the script never refers to
		// a column that is not in the CSV next to it.
		const columns = new Set<string>();
		for (const row of this.exportRows()) {
			for (const key of Object.keys(row)) {
				const value = row[key as keyof MeasurementRow];
				if (value !== undefined && value !== null) { columns.add(key); }
			}
		}
		const provenance = this.provenance();

		const script = buildPandasScript({
			csvName: `${this.baseName()}-results.csv`,
			columns: Array.from(columns).sort(),
			unit: calibration.unit,
			pixelWidth: calibration.pixelWidth,
			pixelHeight: calibration.pixelHeight,
			calibrationOrigin: calibration.origin,
			groupColumns: Object.keys(this.extraColumns()),
			derivedColumns: this.derivedColumns,
			thresholdMethod: provenance.thresholdMethod,
			roiCount: this.collecting ? this.exportRows().length : this.host.manager.count(),
			channelCount: this.channelMode === 'all' ? (source?.channels || 1) : 1,
		});
		this.host.saveTextFile(`${this.baseName()}-analysis.py`, script, { open: true });
	}

	private exportProfile(roi: LineRoi): void {
		const source = this.host.getSource();
		if (!source) { return; }
		const calibration = this.host.getCalibration();
		const channels = source.channels || 1;
		const profiles = Array.from({ length: channels }, (_, channel) => sampleLineProfile(source, roi, channel));
		const header = ['distance_px', `distance_${calibration.unit}`]
			.concat(Array.from({ length: channels }, (_, i) => `channel_${i}`));
		const lines = [header.join(',')];
		const samples = profiles[0]?.distance.length || 0;
		for (let i = 0; i < samples; i++) {
			const distance = profiles[0].distance[i];
			const cells = [
				String(distance),
				String(distance * calibration.pixelWidth),
				...profiles.map(profile => String(profile.value[i])),
			];
			lines.push(cells.join(','));
		}
		this.host.saveTextFile(`${this.baseName()}-profile.csv`, lines.join('\n') + '\n', { open: true });
	}

	private saveSidecar(): void {
		const source = this.host.getSource();
		const sidecar = buildSidecar(this.host.manager.list(), this.host.getCalibration(), {
			image: source?.fileName,
			imageWidth: source?.width,
			imageHeight: source?.height,
			columns: this.visibleColumns,
			derivedColumns: this.derivedColumns,
			version: this.host.extensionVersion,
		});
		this.host.saveSidecar(JSON.stringify(sidecar, null, 2));
	}

	private async exportImageJ(): Promise<void> {
		const url = (window as any).__tiffVisualizerVendorAssets?.imagejRoi;
		if (!url) { throw new Error('ImageJ ROI asset is unavailable'); }
		const { exportImageJRois } = await import(url) as typeof import('./measure/imagej-roi.js');
		const result = exportImageJRois(this.host.manager.list(), roi =>
			roi.kind === 'mask' ? maskContour(roi as never) : []);
		this.host.saveBinaryFile(`${this.baseName()}-RoiSet.zip`, result.bytes);
		this.setHint(result.skipped.length > 0
			? `Exported ${result.exported} ROIs. Skipped: ${result.skipped.join(', ')}.`
			: `Exported ${result.exported} ROIs as RoiSet.zip.`);
	}

	/** Adopt a loaded sidecar's derived columns; ROIs are applied by the caller. */
	applyLoadedDerivedColumns(columns: DerivedColumn[] | undefined, visible?: MeasurementColumn[]): void {
		if (columns && columns.length > 0) { this.derivedColumns = columns.slice(); }
		if (visible && visible.length > 0) { this.visibleColumns = visible.slice(); }
		this.refresh();
	}

	// --- keyboard -----------------------------------------------------------

	/** Release half of the held-key peek. */
	handleKeyUp(event: KeyboardEvent): boolean {
		if (!this.isVisible()) { return false; }
		if (event.key.toLowerCase() === 'h' && this.host.overlay.isPeeking()) {
			this.host.overlay.setPeeking(false);
			return true;
		}
		return false;
	}

	/** Tool shortcuts. Returns true when the key was consumed. */
	handleKey(event: KeyboardEvent): boolean {
		if (!this.isVisible()) { return false; }
		if (this.host.overlay.handleKey(event)) { return true; }
		if (event.ctrlKey || event.metaKey || event.altKey) {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
				if (event.shiftKey) { this.host.manager.redo(); } else { this.host.manager.undo(); }
				return true;
			}
			return false;
		}
		const key = event.key.toLowerCase();
		if (key === 'm') {
			this.showMaskOverlay = !this.showMaskOverlay;
			this.refreshMaskOverlay();
			this.syncHeaderToggles();
			return true;
		}
		if (key === 'o') {
			this.host.overlay.setShowRois(!this.host.overlay.getShowRois());
			this.syncHeaderToggles();
			return true;
		}
		if (key === 'h' && !event.repeat) {
			// Held, not toggled: comparing against the raw image is a glance.
			this.host.overlay.setPeeking(true);
			this.setHint('Holding H — release to bring the overlay back.');
			return true;
		}

		const match = TOOLS.find(tool => tool.key && tool.key.toLowerCase() === event.key.toLowerCase());
		if (match) {
			this.host.overlay.setTool(match.id);
			this.render();
			return true;
		}
		return false;
	}

	// --- small DOM helpers --------------------------------------------------

	private section(title: string): HTMLDivElement {
		const section = document.createElement('div');
		section.className = 'measure-section';
		const heading = document.createElement('div');
		heading.className = 'measure-section-title';
		heading.textContent = title;
		section.appendChild(heading);
		this.body.appendChild(section);
		return section;
	}

	private note(text: string): HTMLDivElement {
		const note = document.createElement('div');
		note.className = 'measure-note';
		note.textContent = text;
		return note;
	}

	private button(label: string, onClick: () => void, disabled = false): HTMLButtonElement {
		const button = document.createElement('button');
		button.className = 'measure-button';
		button.textContent = label;
		button.disabled = disabled;
		button.onclick = onClick;
		return button;
	}

	private labelled(label: string, control: HTMLElement): HTMLDivElement {
		const row = document.createElement('div');
		row.className = 'measure-row';
		const text = document.createElement('div');
		text.className = 'measure-label';
		text.textContent = label;
		row.append(text, control);
		return row;
	}

	private checkbox(
		label: string,
		checked: boolean,
		onChange: (checked: boolean) => void,
		title?: string,
	): HTMLLabelElement {
		const wrapper = document.createElement('label');
		wrapper.className = 'measure-checkbox';
		if (title) { wrapper.title = title; }
		const input = document.createElement('input');
		input.type = 'checkbox';
		input.checked = checked;
		input.onchange = () => onChange(input.checked);
		wrapper.append(input, document.createTextNode(label));
		return wrapper;
	}

	private numberRow(
		label: string,
		value: number,
		onChange: (value: number) => void,
		attributes: { step?: string; min?: number; max?: number } = {},
		title?: string,
	): HTMLDivElement {
		const input = document.createElement('input');
		input.type = 'number';
		input.className = 'measure-input';
		input.value = Number.isFinite(value) ? String(value) : '';
		if (attributes.step) { input.step = attributes.step; }
		if (attributes.min !== undefined) { input.min = String(attributes.min); }
		if (attributes.max !== undefined) { input.max = String(attributes.max); }
		input.onkeydown = event => event.stopPropagation();
		input.onchange = () => {
			const parsed = parseFloat(input.value);
			if (Number.isFinite(parsed)) { onChange(parsed); }
		};
		const row = this.labelled(label, input);
		if (title) { row.title = title; }
		return row;
	}

	private textRow(
		label: string,
		value: string,
		onChange: (value: string) => void,
		placeholder?: string,
	): HTMLDivElement {
		const input = document.createElement('input');
		input.type = 'text';
		input.className = 'measure-input';
		input.value = value;
		if (placeholder) { input.placeholder = placeholder; }
		input.onkeydown = event => event.stopPropagation();
		input.onchange = () => onChange(input.value);
		return this.labelled(label, input);
	}

	private startDrag(event: MouseEvent): void {
		const rect = this.overlayRoot.getBoundingClientRect();
		this.isDragging = true;
		this.dragOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };

		const onMouseMove = (moveEvent: MouseEvent) => {
			if (!this.isDragging) { return; }
			const x = moveEvent.clientX - this.dragOffset.x;
			const y = moveEvent.clientY - this.dragOffset.y;
			const maxX = window.innerWidth - this.overlayRoot.offsetWidth;
			const maxY = window.innerHeight - this.overlayRoot.offsetHeight;
			this.overlayRoot.style.left = `${Math.max(0, Math.min(x, maxX))}px`;
			this.overlayRoot.style.top = `${Math.max(0, Math.min(y, maxY))}px`;
			this.overlayRoot.style.right = 'auto';
			this.overlayRoot.style.bottom = 'auto';
		};
		const onMouseUp = () => {
			this.isDragging = false;
			document.removeEventListener('mousemove', onMouseMove, true);
			document.removeEventListener('mouseup', onMouseUp, true);
			window.removeEventListener('blur', onMouseUp);
		};
		// Capture phase, and a blur fallback: releasing outside the webview never
		// delivers a mouseup, which would otherwise leave the panel stuck.
		document.addEventListener('mousemove', onMouseMove, true);
		document.addEventListener('mouseup', onMouseUp, true);
		window.addEventListener('blur', onMouseUp);
	}
}

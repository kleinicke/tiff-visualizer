import { MeasurementResults } from './measure/results';
import { MeasurementAnalysis } from './measure/analysis';
import Measure from '../../ui/components/Measure.svelte';
import { mountView } from '../../ui/mount';
"use strict";

import { areaUnit, formatNumber } from './measure/calibration.js';
import { maskContour } from './measure/geometry.js';
import { particleToRoi } from './measure/particles.js';
import type { RoiManager } from './measure/roi-manager.js';
import {
	buildPandasScript,
	buildSidecar,
	matchFilenamePattern,
	rowsToDelimitedText,
	type DerivedColumn,
} from './measure/roi-io.js';
import type { MeasureTool, RoiOverlay } from './measure/roi-overlay.js';
import { sampleLineProfile } from './measure/statistics.js';
import {
	globalThresholdMask,
	localAutoThresholdMask,
	localThresholdMask,
	LOCAL_METHODS,
	THRESHOLD_METHODS,
	thresholdValueFromBin,
	valueToBin,
	type ScalarHistogram,
	type StabilityCurve,
	type ThresholdMethod,
} from './measure/threshold.js';
import { buildXlsx } from './measure/xlsx-writer.js';
import {
	COLUMN_GROUPS,
	COLUMN_LABELS,
	DEFAULT_COLUMNS,
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
 * Svelte owns the five tab views. This controller coordinates view snapshots,
 * exports and canvas plots. MeasurementAnalysis owns asynchronous numerical
 * work; MeasurementResults owns rows and provenance. Pixel arrays stay outside
 * reactive state; host callbacks own ROIs and calibration.
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

export const TOOLS: { id: MeasureTool; label: string; key?: string }[] = [
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
	readonly analysis: MeasurementAnalysis;
	readonly results: MeasurementResults;
	overlayRoot!: HTMLDivElement;
	body!: HTMLDivElement;
	private hint = "";
	private visible = false;
	view: ReturnType<typeof mountView<MeasureModel>>;
	tab: MeasureTab = 'tools';
	host: MeasurePanelHost;

	derivedColumns: DerivedColumn[] = [];
	visibleColumns: MeasurementColumn[] = [...DEFAULT_COLUMNS];
	groupPattern = '';
	pendingCalibrationDistance = 0;
	showMaskOverlay = true;

	/** Scroll offsets retained while the panel updates its view snapshot. */
	scrollOffsets = new Map<string, number>();
	/** Set while a table row is handling its own click. */
	selectionFromTable = false;
	/** Selection key at the last render, to detect changes made elsewhere. */
	lastSelectionKey = '';
	/** ROI whose row should be brought into view after the next render. */
	pendingRowReveal: string | null = null;

	constructor(host: MeasurePanelHost) {
		this.host = host;
		this.analysis = new MeasurementAnalysis({
			getSource: host.getSource, getScalarPlane: host.getScalarPlane,
			changed: () => this.render(), isVisible: () => this.isVisible(),
			maskChanged: () => this.refreshMaskOverlay({ withParticles: false }),
		});
		this.results = new MeasurementResults({
			getSource: host.getSource, getCalibration: host.getCalibration, getRois: () => host.manager.list(),
			provenance: () => this.provenance(), extraColumns: () => this.extraColumns(),
			changed: () => { if (['results', 'rois', 'tools'].includes(this.tab)) this.render(); },
		});
		this.view = mountView(Measure, this.snapshot());
		this.syncHeaderToggles();
	}

	private snapshot(): MeasureModel {
		const source = this.visible ? this.host.getSource() : null;
		const particles = this.tab === 'segment' && this.analysis.thresholdMask ? this.analysis.ensureParticles() : null;
		return { panel: this, tab: this.tab,
			results: this.tab === 'results' ? {
				source: source ? { channels: source.channels, fileName: source.fileName } : null,
				calibration: { ...this.host.getCalibration() }, columns: this.resultColumns(), rows: this.results.rows,
				derivedColumns: this.derivedColumns.map(column => ({ ...column })), visibleColumns: [...this.visibleColumns],
				groupPattern: this.groupPattern, channelMode: this.results.channelMode, collecting: this.results.collecting,
				collectedCount: this.results.collected.size, summaryRows: this.results.exportRows(), selectedIds: new Set(this.host.manager.selectedIds()),
			} : null,
			segment: this.tab === 'segment' ? {
				threshold: { ...this.analysis.threshold }, hasSource: !!source && !!this.host.getScalarPlane(),
				methods: this.methodSpecs(), pending: !!this.analysis.thresholdMask && !particles, count: particles?.particles.length ?? 0,
				hasMask: !!this.analysis.thresholdMask, hasHistogram: !!this.analysis.histogram,
				histogramRange: this.analysis.histogram ? this.analysis.histogram.max - this.analysis.histogram.min : 1,
				stability: this.analysis.stability ? { plateauWidth: this.analysis.stability.plateauWidth, count: this.analysis.stability.points.length,
					suggested: this.analysis.histogram ? thresholdValueFromBin(this.analysis.histogram, this.analysis.stability.suggestedBin) : 0 } : null,
				maskStats: this.currentMaskStats(), maxima: this.analysis.threshold.split === 'intensity' ? this.analysis.countMaxima() : null,
			} : null,
			visible: this.visible, hint: this.hint, maskVisible: this.showMaskOverlay,
			roisVisible: this.host.overlay.getShowRois(),
			tools: { tool: this.host.overlay.getTool(), selected: this.host.manager.selectedRois(),
				rois: this.host.manager.list(), selectedIds: new Set(this.host.manager.selectedIds()),
				canUndo: this.host.manager.canUndo(), canRedo: this.host.manager.canRedo(),
				calibration: { ...this.host.getCalibration() }, pendingDistance: this.pendingCalibrationDistance,
				wandTolerance: this.host.overlay.getWandTolerance(), brushRadius: this.host.overlay.getBrushRadius(),
				hasSource: !!source },
			toggleMask: () => { this.showMaskOverlay = !this.showMaskOverlay; this.refreshMaskOverlay(); this.syncHeaderToggles(); },
			toggleRois: () => { this.host.overlay.setShowRois(!this.host.overlay.getShowRois()); this.syncHeaderToggles(); },
		};
	}

	syncHeaderToggles(): void { this.view?.update(this.snapshot()); }

	// --- visibility ---------------------------------------------------------

	show(): void {
		this.visible = true;
		this.host.overlay.setActive(true);
		this.refresh();
	}

	hide(): void {
		this.visible = false;
		this.syncHeaderToggles();
		this.host.overlay.setActive(false);
		this.host.overlay.setTool('select');
		this.host.overlay.setMaskPreview(null);
	}

	isVisible(): boolean { return this.visible; }

	toggle(): void { if (this.isVisible()) { this.hide(); } else { this.show(); } }

	setHint(text: string): void { this.hint = text; this.syncHeaderToggles(); }

	setTab(tab: MeasureTab): void {
		this.tab = tab;
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
		this.analysis.invalidateImage();
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
	scheduleMeasure(): void { this.results.schedule(); }
	measure(): void { this.results.measure(); }

	// --- rendering ----------------------------------------------------------

	refresh(): void {
		this.measure();
		this.render();
	}

	render(): void {
		this.captureScrollOffsets();
		this.noteSelectionChange();

		if (this.tab === 'segment' && this.host.getSource() && this.host.getScalarPlane() && !this.analysis.histogram) this.analysis.prepareThreshold();
		this.view.update(this.snapshot());
		if (this.tab === 'segment') this.refreshMaskOverlay();

		this.restoreScrollOffsets();
	}

	/** Preserve each tab's scroll position and reveal selections made on the image. */
	static readonly SCROLLABLES = ['.measure-results-wrapper', '.measure-roi-list'];

	captureScrollOffsets(): void {
		for (const selector of MeasurePanel.SCROLLABLES) {
			const element = this.body.querySelector(selector);
			if (element) { this.scrollOffsets.set(selector, element.scrollTop); }
		}
	}

	restoreScrollOffsets(): void {
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

	noteSelectionChange(): void {
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

	/**
	 * Intensity profile along a line ROI.
	 *
	 * Drawn on a canvas rather than assembled from DOM nodes: a profile has one
	 * sample per pixel of line length, and a thousand `<div>`s would be both
	 * slower and unreadable.
	 */

	drawProfile(
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

	// --- segmentation -------------------------------------------------------

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

	drawHistogramSlider(canvas: HTMLCanvasElement, padding: { left: number; right: number; top: number; bottom: number }): void {
		const ctx = canvas.getContext('2d');
		const histogram = this.analysis.histogram;
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

		const lowX = toX(this.analysis.threshold.low);
		const highX = toX(this.analysis.threshold.high);

		// Selected band behind the bars, so the cut reads as a region of the
		// distribution rather than as two unrelated lines.
		ctx.fillStyle = 'rgba(255, 80, 80, 0.18)';
		ctx.fillRect(lowX, padding.top, Math.max(1, highX - lowX), plotHeight);

		for (let x = 0; x < plotWidth; x++) {
			const index = Math.floor((x / plotWidth) * histogram.counts.length);
			const height = barHeight(histogram.counts[index]);
			const value = histogram.min + (index / histogram.counts.length) * (histogram.max - histogram.min);
			const inside = value >= this.analysis.threshold.low && value <= this.analysis.threshold.high;
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
	 * The stability curve.
	 *
	 * Object count against threshold, with the widest plateau marked. A user
	 * dragging a slider cannot otherwise tell whether the value they picked sits
	 * on a knife edge or in a broad basin where the answer does not depend on
	 * the guess — this shows it directly, and clicking the plateau adopts it.
	 */

	drawStability(canvas: HTMLCanvasElement): void {
		const ctx = canvas.getContext('2d');
		const curve = this.analysis.stability;
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
		if (this.analysis.histogram) {
			const bin = valueToBin(this.analysis.histogram, this.analysis.threshold.darkBackground ? this.analysis.threshold.low : this.analysis.threshold.high);
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
	refreshMaskOverlay(options: { withParticles?: boolean } = {}): void {
		const source = this.host.getSource();
		if (!this.showMaskOverlay || !this.analysis.thresholdMask || !source) {
			this.host.overlay.setMaskPreview(null);
			return;
		}

		let accepted: Uint8Array | null = null;
		if (options.withParticles !== false) {
			const result = this.analysis.ensureParticles();
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
			mask: this.analysis.thresholdMask,
			accepted,
		});
	}

	/** Temporarily show another mask, e.g. while hovering a method button. */
	showTemporaryMask(mask: Uint8Array | null): void {
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

	currentMaskStats(): string {
		const source = this.host.getSource();
		if (!this.analysis.thresholdMask || !source) { return 'No threshold applied yet.'; }
		const result = this.analysis.ensureParticles();
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

	commitParticles(): void {
		const result = this.analysis.ensureParticles();
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

	/** Called by the overlay when a calibration line is finished. */
	onCalibrationLine(pixelDistance: number): void {
		this.pendingCalibrationDistance = pixelDistance;
		this.setTab('setup');
	}

	// --- export -------------------------------------------------------------

	provenance(): MeasurementProvenance {
		const calibration = this.host.getCalibration();
		const source = this.host.getSource();
		const preprocessing: string[] = [];
		if (this.analysis.threshold.blurSigma > 0) { preprocessing.push(`gaussian:${this.analysis.threshold.blurSigma}`); }
		if (this.analysis.threshold.backgroundRadius > 0) { preprocessing.push(`rollingBall:${this.analysis.threshold.backgroundRadius}`); }

		return {
			fileName: source?.fileName,
			unit: calibration.unit,
			pixelWidth: calibration.pixelWidth,
			pixelHeight: calibration.pixelHeight,
			calibrationOrigin: calibration.origin,
			thresholdMethod: this.analysis.thresholdMask
				? (this.analysis.threshold.localMethod !== 'none'
					? `local:${this.analysis.threshold.localMethod}`
					: (this.analysis.threshold.manual ? 'manual' : this.analysis.threshold.method))
				: undefined,
			thresholdLow: this.analysis.thresholdMask ? this.analysis.threshold.low : undefined,
			thresholdHigh: this.analysis.thresholdMask ? this.analysis.threshold.high : undefined,
			preprocessing: [
				...preprocessing,
				this.analysis.threshold.split === 'shape' ? 'watershed' : '',
				this.analysis.threshold.split === 'intensity' ? `maxima:${this.analysis.threshold.prominence}` : '',
			].filter(Boolean).join(' ') || undefined,
			extensionVersion: this.host.extensionVersion,
		};
	}

	baseName(): string {
		const source = this.host.getSource();
		const name = source?.fileName || 'image';
		return (name.split('/').pop() || name).replace(/\.[^.]+$/, '');
	}

	extraColumns(): Record<string, string> {
		const source = this.host.getSource();
		if (!this.groupPattern || !source?.fileName) { return {}; }
		return matchFilenamePattern(source.fileName, this.groupPattern) || {};
	}

	exportTable(format: 'csv' | 'csv-de' | 'xlsx'): void {
		const provenance = this.provenance();
		const extraColumns = this.extraColumns();
		const rows = this.results.exportRows();
		// Per-row lookups only when collecting; a single-image export has one
		// provenance and does not need the indirection.
		const provenanceForRow = this.results.collecting
			? (row: MeasurementRow) => this.results.snapshotFor(row)?.provenance
			: undefined;
		const extraColumnsForRow = this.results.collecting
			? (row: MeasurementRow) => this.results.snapshotFor(row)?.extraColumns
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

	exportPandasScript(): void {
		const calibration = this.host.getCalibration();
		const source = this.host.getSource();
		// Only columns the rows actually populate, so the script never refers to
		// a column that is not in the CSV next to it.
		const columns = new Set<string>();
		for (const row of this.results.exportRows()) {
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
			roiCount: this.results.collecting ? this.results.exportRows().length : this.host.manager.count(),
			channelCount: this.results.channelMode === 'all' ? (source?.channels || 1) : 1,
		});
		this.host.saveTextFile(`${this.baseName()}-analysis.py`, script, { open: true });
	}

	exportProfile(roi: LineRoi): void {
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

	saveSidecar(): void {
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

	async exportImageJ(): Promise<void> {
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

	// --- component view data and canvas bindings -----------------------------

	selectRoi(id: string, event: MouseEvent): void {
		const additive = event.shiftKey || event.ctrlKey || event.metaKey;
		this.selectionFromTable = true;
		this.host.manager.select([id], { additive });
		if (!additive) this.host.overlay.revealRoi(id);
	}
	quickStats(roi: Roi): [string,string][] {
		const row = this.results.rows.find(candidate => candidate.roiId === roi.id);
		if (!row) return [];
		const calibration = this.host.getCalibration();
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

		return entries;
	}
	paintProfile(canvas: HTMLCanvasElement, roi: LineRoi): void {
		const source = this.host.getSource();
		if (!source) return;
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

		this.drawProfile(canvas, distances, series, calibration);
	}
	resultColumns() {
		const calibration = this.host.getCalibration();
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
			|| this.results.rows.some(row => row[column.key] !== undefined && row[column.key] !== null));

		return present;
	}
	bindHistogram(canvas: HTMLCanvasElement): void {
		if (!this.analysis.histogram) return;
		const padding = { left: 8, right: 8, top: 6, bottom: 14 };
		const plotWidth = canvas.width - padding.left - padding.right;

		const valueAt = (clientX: number): number => {
			const rect = canvas.getBoundingClientRect();
			// Map through the *plot* area, not the canvas: ignoring the padding is
			// what makes a click land a few units off the value under the cursor.
			const fraction = ((clientX - rect.left) / rect.width * canvas.width - padding.left) / plotWidth;
			const clamped = Math.max(0, Math.min(1, fraction));
			const histogram = this.analysis.histogram!;
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
			dragging = Math.abs(value - this.analysis.threshold.low) <= Math.abs(value - this.analysis.threshold.high) ? 'low' : 'high';
			canvas.setPointerCapture(event.pointerId);
			// Dragging the range is a global, manual cut. An adaptive method
			// computes its own threshold per pixel and would simply ignore these
			// handles, so taking hold of them has to switch it off — otherwise the
			// control silently does nothing.
			this.analysis.threshold.manual = true;
			this.analysis.threshold.localMethod = 'none';
			this.analysis.threshold.localizeGlobal = false;
			if (dragging === 'low') { this.analysis.threshold.low = value; } else { this.analysis.threshold.high = value; }
			this.analysis.applyThreshold();
			draw();
			event.preventDefault();
		});
		canvas.addEventListener('pointermove', event => {
			if (!dragging) { return; }
			const value = valueAt(event.clientX);
			if (dragging === 'low') { this.analysis.threshold.low = Math.min(value, this.analysis.threshold.high); }
			else { this.analysis.threshold.high = Math.max(value, this.analysis.threshold.low); }
			this.analysis.applyThreshold();
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

	}
	bindStability(canvas: HTMLCanvasElement): void {
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
			const points = this.analysis.stability!.points;
			const index = Math.round(Math.max(0, Math.min(1, fraction)) * (points.length - 1));
			return points[index];
		};

		let scrubbing = false;
		canvas.addEventListener('pointerdown', event => {
			scrubbing = true;
			canvas.setPointerCapture(event.pointerId);
			this.analysis.adoptThresholdValue(pickAt(event.clientX).value);
			this.drawStability(canvas);
			event.preventDefault();
		});
		canvas.addEventListener('pointermove', event => {
			if (!scrubbing) { return; }
			this.analysis.adoptThresholdValue(pickAt(event.clientX).value);
			this.drawStability(canvas);
		});
		const endScrub = () => {
			if (!scrubbing) { return; }
			scrubbing = false;
			this.render();
		};
		canvas.addEventListener('pointerup', endScrub);
		canvas.addEventListener('pointercancel', endScrub);
	}
	methodSpecs(): ThresholdMethodView[] {
		const histogram = this.analysis.histogram, source = this.host.getSource();
		if (!histogram || !source) return [];
		const specs: ThresholdMethodView[] = [];
		// Cached per histogram: `autoThresholdBin` now reaches Rust/WASM, and
		// evaluating all thirteen methods synchronously on every render would
		// mean thirteen blocking round trips per keystroke. `ensureMethodBins`
		// returns the cached map immediately once computed, and triggers a
		// background recompute (with a re-render on completion) otherwise —
		// the same lazy-async pattern `ensureParticles` uses.
		const methodBins = this.analysis.ensureMethodBins();

		for (const method of THRESHOLD_METHODS) {
			const bin = methodBins?.get(method.id) ?? -1;
			const pending = !methodBins;
			const localized = this.analysis.threshold.localizeGlobal;
			const active = !this.analysis.threshold.manual
				&& this.analysis.threshold.localMethod === 'none'
				&& this.analysis.threshold.method === method.id;
			const button: ThresholdMethodView = ({
				label: localized ? `${method.label} · per window` : method.label,
				hint: pending
					? `${method.hint}\n\nComputing…`
					: (bin < 0 ? `${method.hint}\n\nNo threshold found for this histogram.` : method.hint),
				value: localized
					? `r=${this.analysis.threshold.localRadius}`
					: (pending ? '…' : (bin < 0 ? '—' : formatNumber(thresholdValueFromBin(histogram, bin), 4))),
				active,
				disabled: pending || (bin < 0 && !localized),
				spark: localized || pending ? undefined : bin,
				computeMask: async () => {
					if (!this.analysis.previewPlane) { return null; }
					if (localized) {
						return localAutoThresholdMask(this.analysis.previewPlane, source.width, source.height, {
							method: method.id,
							radius: this.analysis.threshold.localRadius,
							darkBackground: this.analysis.threshold.darkBackground,
						});
					}
					if (bin < 0) { return null; }
					const value = thresholdValueFromBin(histogram, bin);
					return this.analysis.threshold.darkBackground
						? globalThresholdMask(this.analysis.previewPlane, value, histogram.max)
						: globalThresholdMask(this.analysis.previewPlane, histogram.min, value);
				},
				apply: () => {
					this.analysis.threshold.method = method.id;
					this.analysis.threshold.localMethod = 'none';
					this.analysis.threshold.manual = false;
				},
			});
			specs.push(button);
		}

		// Local methods are the same choice as the global ones — only one is ever
		// applied — so they belong in the same list. Keeping them in a separate
		// dropdown made this gallery preview a global cut while a local method
		// was what actually ran.
		for (const method of LOCAL_METHODS) {
			if (method.id === 'none') { continue; }
			const active = this.analysis.threshold.localMethod === method.id;
			const button: ThresholdMethodView = ({
				label: `${method.label} (local)`,
				hint: method.hint,
				value: `r=${this.analysis.threshold.localRadius}, k=${formatNumber(this.analysis.threshold.localK, 2)}`,
				active,
				disabled: false,
				computeMask: async () => this.analysis.previewPlane
					? localThresholdMask(this.analysis.previewPlane, source.width, source.height, {
						method: method.id,
						radius: this.analysis.threshold.localRadius,
						k: this.analysis.threshold.localK,
						darkBackground: this.analysis.threshold.darkBackground,
					})
					: null,
				apply: () => {
					this.analysis.threshold.localMethod = method.id;
					this.analysis.threshold.localizeGlobal = false;
					this.analysis.threshold.manual = false;
				},
			});
			specs.push(button);
		}

		return specs;
	}
	previewMethod(spec: ThresholdMethodView): void {
		if (spec.disabled) return;
		const token = ++this.analysis.hoverToken;
		void spec.computeMask().then(mask => {
			if (token !== this.analysis.hoverToken || !mask) return;
			this.showTemporaryMask(mask);
			this.setHint(`${spec.label}: preview in red — click to keep it, then the filters mark kept objects green.`);
		});
	}
	paintSpark(canvas: HTMLCanvasElement, bin: number): void {
		const histogram = this.analysis.histogram;
		if (!histogram) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) { return; }

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
		return;
	}

}

export interface MeasureModel {
  panel: MeasurePanel; tab: MeasureTab;
  visible: boolean; hint: string; maskVisible: boolean; roisVisible: boolean;
  toggleMask(): void; toggleRois(): void;
  results: {
    source: { channels: number; fileName?: string } | null; calibration: Calibration;
    columns: ReturnType<MeasurePanel['resultColumns']>; rows: MeasurementRow[];
    derivedColumns: DerivedColumn[]; visibleColumns: MeasurementColumn[];
    groupPattern: string; channelMode: MeasurementResults['channelMode']; collecting: boolean;
    collectedCount: number; summaryRows: ReturnType<MeasurementResults['exportRows']>; selectedIds: Set<string>;
  } | null;
  segment: {
    threshold: MeasurementAnalysis['threshold']; hasSource: boolean; methods: ThresholdMethodView[];
    pending: boolean; count: number; hasMask: boolean; hasHistogram: boolean; histogramRange: number;
    stability: { plateauWidth: number; count: number; suggested: number } | null;
    maskStats: string; maxima: number | null;
  } | null;
  tools: {
    tool: MeasureTool; selected: Roi[]; rois: Roi[]; selectedIds: Set<string>;
    canUndo: boolean; canRedo: boolean; calibration: Calibration; pendingDistance: number;
    wandTolerance: number | null; brushRadius: number; hasSource: boolean;
  };
}
export interface ThresholdMethodView { label: string; hint: string; value: string; active: boolean; disabled: boolean; spark?: number; computeMask: () => Promise<Uint8Array | null>; apply: () => void }

/**
 * LayerManager — owns the layer stack for the GIMP-style compositing feature
 * and turns it into an ImageData for the main canvas.
 *
 * It is deliberately decode-agnostic: the host (imagePreview.js) decodes image
 * URIs into raw float layers and hands them in. The manager only knows about
 * the stack, the compositor, and the central ImageRenderer — so the composite
 * flows through exactly the same visualization path (normalization / gamma /
 * NaN color) as a normal image.
 */

import { composite, compositeRegion, centeredOffset, BLEND_MODES, Layer, CompositeResult, LayerAdjustment } from './layer-compositor.js';
import { ImageRenderer } from './normalization-helper.js';
import { PerfTrace } from './perf-trace.js';
import type { ImageSettings } from './settings-manager.js';

export interface LayerInput {
	data?: ArrayLike<number>;
	width: number;
	height: number;
	channels: number;
	isFloat: boolean;
	typeMax: number;
	name?: string;
	uri?: string;
	groupPath?: string[];
	groupIds?: string[];
	sourceNodeId?: string;
	sourceSupport?: Layer['sourceSupport'];
	sourceBlendMode?: string;
	sourceNumericType?: Layer['sourceNumericType'];
	kind?: Layer['kind'];
	adjustment?: LayerAdjustment;
	parentId?: string;
	clipped?: boolean;
	rasterMask?: Layer['rasterMask'];
}

let _nextLayerId = 1;

interface LayerHistorySnapshot {
	layers: Layer[];
	documentExpanded: boolean;
}

function cloneHistoryLayer(layer: Layer): Layer {
	return {
		...layer,
		groupPath: layer.groupPath ? [...layer.groupPath] : undefined,
		groupIds: layer.groupIds ? [...layer.groupIds] : undefined,
		maskCondition: layer.maskCondition ? { ...layer.maskCondition } : undefined,
		rasterMask: layer.rasterMask ? { ...layer.rasterMask } : undefined,
		// Pixel arrays are immutable after decode and can be shared. Adjustment
		// descriptors are small mutable value objects and must be copied.
		adjustment: layer.adjustment ? JSON.parse(JSON.stringify(layer.adjustment)) as LayerAdjustment : undefined,
	};
}

export class LayerManager {
	layers: Layer[];
	active: boolean;
	canvasWidth: number;
	canvasHeight: number;
	_lastComposite: CompositeResult | null;
	documentExpanded: boolean;
	private _undoStack: LayerHistorySnapshot[];
	private _redoStack: LayerHistorySnapshot[];
	private _historyGroupDepth: number;
	private _historyGroupStart: LayerHistorySnapshot | null;
	private _historyGroupChanged: boolean;

	constructor() {
		this.layers = [];
		this.active = false;
		this.canvasWidth = 0;
		this.canvasHeight = 0;
		this._lastComposite = null;
		this.documentExpanded = false;
		this._undoStack = [];
		this._redoStack = [];
		this._historyGroupDepth = 0;
		this._historyGroupStart = null;
		this._historyGroupChanged = false;
	}

	private _snapshot(): LayerHistorySnapshot {
		return { layers: this.layers.map(cloneHistoryLayer), documentExpanded: this.documentExpanded };
	}

	private _pushUndo(snapshot: LayerHistorySnapshot): void {
		this._undoStack.push(snapshot);
		if (this._undoStack.length > 50) { this._undoStack.shift(); }
	}

	private _recordHistory(): void {
		if (this._historyGroupDepth > 0) {
			if (!this._historyGroupChanged) { this._redoStack = []; }
			this._historyGroupChanged = true;
			return;
		}
		this._redoStack = [];
		this._pushUndo(this._snapshot());
	}

	/** Coalesce a continuous UI gesture (slider/curve/drag) into one undo step. */
	beginHistoryGroup(): void {
		if (this._historyGroupDepth++ === 0) {
			this._historyGroupStart = this._snapshot();
			this._historyGroupChanged = false;
		}
	}

	endHistoryGroup(): void {
		if (this._historyGroupDepth <= 0) { return; }
		if (--this._historyGroupDepth === 0) {
			if (this._historyGroupChanged && this._historyGroupStart) { this._pushUndo(this._historyGroupStart); }
			this._historyGroupStart = null;
			this._historyGroupChanged = false;
		}
	}

	canUndo(): boolean {
		return this._undoStack.length > 0 || (this._historyGroupDepth > 0 && this._historyGroupChanged);
	}

	canRedo(): boolean {
		return this._redoStack.length > 0;
	}

	undo(): boolean {
		while (this._historyGroupDepth > 0) { this.endHistoryGroup(); }
		const snapshot = this._undoStack.pop();
		if (!snapshot) { return false; }
		this._redoStack.push(this._snapshot());
		if (this._redoStack.length > 50) { this._redoStack.shift(); }
		this.layers = snapshot.layers.map(cloneHistoryLayer);
		this.documentExpanded = snapshot.documentExpanded;
		this._lastComposite = null;
		return true;
	}

	redo(): boolean {
		while (this._historyGroupDepth > 0) { this.endHistoryGroup(); }
		const snapshot = this._redoStack.pop();
		if (!snapshot) { return false; }
		this._pushUndo(this._snapshot());
		this.layers = snapshot.layers.map(cloneHistoryLayer);
		this.documentExpanded = snapshot.documentExpanded;
		this._lastComposite = null;
		return true;
	}

	clearHistory(): void {
		this._undoStack = [];
		this._redoStack = [];
		this._historyGroupDepth = 0;
		this._historyGroupStart = null;
		this._historyGroupChanged = false;
	}

	/** True if there is more than just the base layer. */
	hasExtraLayers(): boolean {
		return this.layers.length > 1;
	}

	/** True when the canvas should be owned by the layer compositor. */
	hasCompositeStack(): boolean {
		return this.hasExtraLayers() || this.documentExpanded;
	}

	isEmpty(): boolean {
		return this.layers.length === 0;
	}

	invalidateComposite(): void {
		this._lastComposite = null;
	}

	/**
	 * Reset the stack to a single base (background) layer. The canvas size is
	 * defined by this layer. Called whenever the primary image (re)loads.
	 */
	setBaseLayer(layer: LayerInput): void {
		const base = this._toLayer(layer, 0, 0);
		base.name = layer.name || 'Background';
		this.canvasWidth = layer.width;
		this.canvasHeight = layer.height;
		this.layers = [base];
		this._lastComposite = null;
		this.documentExpanded = false;
		this.clearHistory();
	}

	/**
	 * Add a layer on top, centered on the canvas by default.
	 * @returns The new layer's id.
	 */
	addLayer(layer: LayerInput): string {
		this._recordHistory();
		const { offsetX, offsetY } = centeredOffset(layer.width, layer.height, this.canvasWidth || layer.width, this.canvasHeight || layer.height);
		const l = this._toLayer(layer, offsetX, offsetY);
		l.name = layer.name || `Layer ${this.layers.length}`;
		l.blendMode = 'normal';
		this.layers.push(l);
		this._lastComposite = null;
		return l.id as string;
	}

	/** Add a non-destructive adjustment immediately above a layer's clipping stack. */
	addAdjustmentLayer(targetId: string, type: LayerAdjustment['type']): string | null {
		const targetIndex = this.layers.findIndex(layer => layer.id === targetId);
		if (targetIndex < 0) { return null; }
		this._recordHistory();
		const target = this.layers[targetIndex];
		const defaults: Record<LayerAdjustment['type'], () => LayerAdjustment> = {
			'levels': () => ({ type: 'levels', rgb: { shadowInput: 0, highlightInput: 255, shadowOutput: 0, highlightOutput: 255, midtoneInput: 1 } }),
			'curves': () => ({ type: 'curves', rgb: [{ input: 0, output: 0 }, { input: 255, output: 255 }] }),
			'hue/saturation': () => ({ type: 'hue/saturation', master: { hue: 0, saturation: 0, lightness: 0 }, colorize: { hue: 0, saturation: 100, lightness: 0 }, colorizeEnabled: false }),
			'brightness/contrast': () => ({ type: 'brightness/contrast', brightness: 0, contrast: 0 }),
			'exposure': () => ({ type: 'exposure', exposure: 0, offset: 0, gamma: 1 }),
			'invert': () => ({ type: 'invert' }),
			'channel mixer': () => ({ type: 'channel mixer', red: { red: 100, green: 0, blue: 0, constant: 0 }, green: { red: 0, green: 100, blue: 0, constant: 0 }, blue: { red: 0, green: 0, blue: 100, constant: 0 } }),
			'color balance': () => ({ type: 'color balance', shadows: {}, midtones: {}, highlights: {}, preserveLuminosity: true }),
			'black & white': () => ({ type: 'black & white', reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 }),
			'threshold': () => ({ type: 'threshold', level: 128 }),
			'posterize': () => ({ type: 'posterize', levels: 4 }),
			'gradient map': () => ({ type: 'gradient map', stops: [{ position: 0, color: { r: 0, g: 0, b: 0 } }, { position: 1, color: { r: 255, g: 255, b: 255 } }] }),
		};
		const adjustment = defaults[type]();
		const labels: Record<LayerAdjustment['type'], string> = {
			levels: 'Levels', curves: 'Curves', 'hue/saturation': 'Hue/Saturation', 'brightness/contrast': 'Brightness/Contrast', exposure: 'Exposure', invert: 'Invert',
			'channel mixer': 'Channel Mixer', 'color balance': 'Color Balance', 'black & white': 'Black & White', threshold: 'Threshold', posterize: 'Posterize', 'gradient map': 'Gradient Map',
		};
		const label = labels[type];
		const existingCount = this.layers.filter(layer => layer.kind === 'adjustment' && layer.adjustment?.type === type).length;
		const created = this.createLayer({
			width: 1, height: 1, channels: 4, isFloat: false, typeMax: target.typeMax || 255,
			name: `${label} ${existingCount + 1}`, kind: 'adjustment', adjustment,
			parentId: target.parentId, clipped: true, groupPath: target.groupPath, groupIds: target.groupIds,
		}, { adjustment, clipped: true, parentId: target.parentId });
		let insertAt = targetIndex + 1;
		while (insertAt < this.layers.length && this.layers[insertAt].clipped
			&& (this.layers[insertAt].parentId || undefined) === (target.parentId || undefined)) { insertAt++; }
		this.layers.splice(insertAt, 0, created);
		this._lastComposite = null;
		return created.id as string;
	}

	/** Duplicate a raster layer and the clipped adjustment layers it owns. */
	duplicateLayerWithAdjustments(id: string): string | null {
		const sourceIndex = this.layers.findIndex(layer => layer.id === id);
		const source = this.layers[sourceIndex];
		if (sourceIndex < 0 || !source || source.kind === 'adjustment' || !source.data) { return null; }
		this._recordHistory();
		let end = sourceIndex + 1;
		while (end < this.layers.length && this.layers[end].kind === 'adjustment' && this.layers[end].clipped
			&& (this.layers[end].parentId || undefined) === (source.parentId || undefined)) { end++; }
		const copies = this.layers.slice(sourceIndex, end).map((layer, index) => {
			const copy = cloneHistoryLayer(layer);
			copy.id = `layer-${_nextLayerId++}`;
			copy.sourceNodeId = undefined;
			if (index === 0) { copy.name = `${layer.name || 'Layer'} copy`; }
			return copy;
		});
		this.layers.splice(end, 0, ...copies);
		this._lastComposite = null;
		return copies[0].id as string;
	}

	/** Copy one adjustment, preserving its parameters, onto another raster layer. */
	copyAdjustmentLayer(adjustmentId: string, targetId: string): string | null {
		const source = this.layers.find(layer => layer.id === adjustmentId);
		const targetIndex = this.layers.findIndex(layer => layer.id === targetId);
		const target = this.layers[targetIndex];
		if (!source?.adjustment || source.kind !== 'adjustment' || targetIndex < 0 || !target?.data || target.kind === 'adjustment') { return null; }
		this._recordHistory();
		const copy = cloneHistoryLayer(source);
		copy.id = `layer-${_nextLayerId++}`;
		copy.name = `${source.name || 'Filter'} copy`;
		copy.parentId = target.parentId;
		copy.groupPath = target.groupPath ? [...target.groupPath] : undefined;
		copy.groupIds = target.groupIds ? [...target.groupIds] : undefined;
		copy.clipped = true;
		copy.sourceNodeId = undefined;
		copy.typeMax = target.typeMax || copy.typeMax;
		let insertAt = targetIndex + 1;
		while (insertAt < this.layers.length && this.layers[insertAt].kind === 'adjustment'
			&& this.layers[insertAt].clipped
			&& (this.layers[insertAt].parentId || undefined) === (target.parentId || undefined)) { insertAt++; }
		this.layers.splice(insertAt, 0, copy);
		this._lastComposite = null;
		return copy.id as string;
	}

	removeLayer(id: string): void {
		const idx = this.layers.findIndex(l => l.id === id);
		// Keep at least one layer (it defines the canvas).
		if (idx >= 0 && this.layers.length > 1) {
			this._recordHistory();
			const descendants = new Set([id]);
			if (!this.layers[idx].clipped) {
				for (let attached = idx + 1; attached < this.layers.length && this.layers[attached].clipped
					&& (this.layers[attached].parentId || undefined) === (this.layers[idx].parentId || undefined); attached++) {
					descendants.add(this.layers[attached].id as string);
				}
			}
			let changed = true;
			while (changed) {
				changed = false;
				for (const layer of this.layers) if (layer.parentId && descendants.has(layer.parentId) && !descendants.has(layer.id as string)) {
					descendants.add(layer.id as string); changed = true;
				}
			}
			const remaining = this.layers.filter(layer => !descendants.has(layer.id as string));
			if (remaining.length) { this.layers = remaining; this._lastComposite = null; }
		}
	}

	/**
	 * Update arbitrary properties of a layer (blendMode, opacity, visible, offset).
	 */
	updateLayer(id: string, props: Partial<Layer>): void {
		const layer = this.layers.find(l => l.id === id);
		if (layer && Object.entries(props).some(([key, value]) => layer[key as keyof Layer] !== value)) {
			this._recordHistory();
			Object.assign(layer, props);
			this._lastComposite = null;
		}
	}

	/** Toggle a layer between solo and an all-visible stack. */
	showOnlyLayer(id: string): void {
		const target = this.layers.find(layer => layer.id === id);
		if (target?.data && target.kind !== 'adjustment' && target.kind !== 'group') {
			this.toggleSoloImageLayers(new Set([id]));
		} else {
			this.toggleSoloLayers(new Set([id]));
		}
	}

	/**
	 * Toggle image/raster visibility without changing filters or group nodes.
	 * This keeps an image's attached filter switches intact while the image is
	 * temporarily soloed; the filters simply have no effect while it is hidden.
	 */
	toggleSoloImageLayers(ids: Set<string>): void {
		const images = this.layers.filter(layer =>
			!!layer.data && layer.kind !== 'adjustment' && layer.kind !== 'group');
		if (!images.length) { return; }
		const alreadySolo = images.every(layer =>
			ids.has(layer.id as string) ? layer.visible !== false : layer.visible === false);
		const changed = images.some(layer => layer.visible !== (alreadySolo || ids.has(layer.id as string)));
		if (!changed) { return; }
		this._recordHistory();
		for (const layer of images) {
			layer.visible = alreadySolo || ids.has(layer.id as string);
		}
		this._lastComposite = null;
	}

	/** Toggle a set of layers between solo and an all-visible stack. */
	toggleSoloLayers(ids: Set<string>): void {
		const alreadySolo = this.layers.length > 0 && this.layers.every(layer =>
			ids.has(layer.id as string) ? layer.visible !== false : layer.visible === false);
		const changed = this.layers.some(layer => layer.visible !== (alreadySolo || ids.has(layer.id as string)));
		if (!changed) { return; }
		this._recordHistory();
		for (const layer of this.layers) {
			layer.visible = alreadySolo || ids.has(layer.id as string);
		}
		this._lastComposite = null;
	}

	/**
	 * Nudge a layer's offset by (dx, dy) canvas pixels (used by the move tool).
	 */
	moveLayer(id: string, dx: number, dy: number): void {
		const layer = this.layers.find(l => l.id === id);
		if (layer && (dx !== 0 || dy !== 0)) {
			this._recordHistory();
			layer.offsetX = (layer.offsetX ?? 0) + dx;
			layer.offsetY = (layer.offsetY ?? 0) + dy;
			this._lastComposite = null;
		}
	}

	/**
	 * Reorder a layer within the stack (0 = bottom). Raster layers move together
	 * with their clipped adjustments; clipped adjustments remain inside their
	 * owner's filter stack.
	 */
	reorderLayer(id: string, newIndex: number): void {
		const idx = this.layers.findIndex(l => l.id === id);
		if (idx < 0) { return; }
		const layer = this.layers[idx];
		const direction = Math.sign(newIndex - idx);
		if (!direction) { return; }

		if (layer.kind === 'adjustment' && layer.clipped) {
			let ownerIndex = idx - 1;
			while (ownerIndex >= 0 && this.layers[ownerIndex].clipped
				&& (this.layers[ownerIndex].parentId || undefined) === (layer.parentId || undefined)) { ownerIndex--; }
			if (ownerIndex < 0) { return; }
			let end = ownerIndex + 1;
			while (end < this.layers.length && this.layers[end].kind === 'adjustment' && this.layers[end].clipped
				&& (this.layers[end].parentId || undefined) === (layer.parentId || undefined)) { end++; }
			const clamped = Math.max(ownerIndex + 1, Math.min(end - 1, newIndex));
			if (clamped === idx) { return; }
			this._recordHistory();
			const [adjustment] = this.layers.splice(idx, 1);
			this.layers.splice(clamped, 0, adjustment);
			this._lastComposite = null;
			return;
		}

		let bundleEnd = idx + 1;
		while (bundleEnd < this.layers.length && this.layers[bundleEnd].kind === 'adjustment'
			&& this.layers[bundleEnd].clipped
			&& (this.layers[bundleEnd].parentId || undefined) === (layer.parentId || undefined)) { bundleEnd++; }
		let candidateIndex = direction > 0 ? bundleEnd : idx - 1;
		while (candidateIndex >= 0 && candidateIndex < this.layers.length) {
			const candidate = this.layers[candidateIndex];
			if ((candidate.parentId || undefined) === (layer.parentId || undefined) && candidate.kind !== 'adjustment' && candidate.data) { break; }
			candidateIndex += direction;
		}
		if (candidateIndex < 0 || candidateIndex >= this.layers.length) { return; }
		const target = this.layers[candidateIndex];
		this._recordHistory();
		const bundle = this.layers.splice(idx, bundleEnd - idx);
		const targetIndex = this.layers.indexOf(target);
		if (direction > 0) {
			let targetEnd = targetIndex + 1;
			while (targetEnd < this.layers.length && this.layers[targetEnd].kind === 'adjustment'
				&& this.layers[targetEnd].clipped
				&& (this.layers[targetEnd].parentId || undefined) === (target.parentId || undefined)) { targetEnd++; }
			this.layers.splice(targetEnd, 0, ...bundle);
		} else {
			this.layers.splice(targetIndex, 0, ...bundle);
		}
		this._lastComposite = null;
	}

	/**
	 * Composite the stack into a float buffer.
	 */
	getComposite(): CompositeResult | null {
		if (!this.canvasWidth || !this.canvasHeight) { return null; }
		if (!this._lastComposite) { this._lastComposite = composite(this.layers, this.canvasWidth, this.canvasHeight); }
		return this._lastComposite;
	}

	/**
	 * Composite and render to ImageData via the central ImageRenderer, so the
	 * result honors the current normalization/gamma/NaN settings.
	 */
	renderToImageData(settings: ImageSettings, options: { nanColor?: { r: number; g: number; b: number } } = {}): ImageData | null {
		const compositeStart = performance.now();
		const c = this.getComposite();
		if (!c) { return null; }
		PerfTrace.detail('layer-composite', performance.now() - compositeStart);
		this._lastComposite = c; // cache for pixel inspection
		const renderStart = performance.now();
		const imageData = ImageRenderer.render(
			c.data,
			c.width,
			c.height,
			c.channels,
			c.isFloat,
			c.stats,
			settings,
			{ nanColor: options.nanColor, typeMax: c.typeMax }
		);
		PerfTrace.detail('layer-render-total', performance.now() - renderStart);
		return imageData;
	}

	/**
	 * Render a composite produced off-thread. Full-resolution worker results
	 * become the pixel-inspection/export cache; scaled interaction previews do
	 * not replace that authoritative surface.
	 */
	renderCompositeToImageData(compositeResult: CompositeResult, settings: ImageSettings, options: { nanColor?: { r: number; g: number; b: number }; cache?: boolean } = {}): ImageData {
		if (options.cache !== false) { this._lastComposite = compositeResult; }
		return ImageRenderer.render(
			compositeResult.data,
			compositeResult.width,
			compositeResult.height,
			compositeResult.channels,
			compositeResult.isFloat,
			compositeResult.stats,
			settings,
			{ nanColor: options.nanColor, typeMax: compositeResult.typeMax },
		);
	}

	/**
	 * Sample the composited float value(s) at a canvas pixel, for the pixel
	 * inspector. Returns null if outside the canvas or no-data.
	 */
	getCompositeValueAt(x: number, y: number): number[] | null {
		if (x < 0 || y < 0 || x >= this.canvasWidth || y >= this.canvasHeight) { return null; }
		// Large documents deliberately keep only a scaled display composite.
		// Preserve exact pixel inspection by evaluating just the requested source
		// pixel whenever no authoritative full-resolution cache is available.
		const c = this._lastComposite || compositeRegion(
			this.layers,
			this.canvasWidth,
			this.canvasHeight,
			{ x, y, width: 1, height: 1 },
		);
		const sampleX = c === this._lastComposite ? x : 0;
		const sampleY = c === this._lastComposite ? y : 0;
		const base = (sampleY * c.width + sampleX) * c.channels;
		const out: number[] = [];
		for (let i = 0; i < c.channels; i++) { out.push(c.data[base + i]); }
		return out;
	}

	/**
	 * Build a layer object with explicit settings (used when restoring a saved
	 * stack). Does not add it to the stack.
	 */
	createLayer(input: LayerInput, settings: Partial<Layer> = {}): Layer {
		const l = this._toLayer(input, settings.offsetX ?? 0, settings.offsetY ?? 0);
		l.opacity = settings.opacity ?? 1;
		l.blendMode = settings.blendMode ?? 'normal';
		l.visible = settings.visible !== false;
		l.maskCondition = settings.maskCondition;
		l.name = settings.name ?? input.name;
		l.groupPath = settings.groupPath ?? input.groupPath;
		l.groupIds = settings.groupIds ?? input.groupIds;
		l.sourceNodeId = settings.sourceNodeId ?? input.sourceNodeId;
		l.sourceSupport = settings.sourceSupport ?? input.sourceSupport;
		l.sourceBlendMode = settings.sourceBlendMode ?? input.sourceBlendMode;
		l.kind = settings.kind ?? input.kind ?? 'raster';
		l.adjustment = settings.adjustment ?? input.adjustment;
		l.parentId = settings.parentId ?? input.parentId;
		l.clipped = settings.clipped ?? input.clipped;
		l.rasterMask = settings.rasterMask ?? input.rasterMask;
		return l;
	}

	/**
	 * Replace the whole stack at once (used when restoring after a reload).
	 */
	setLayers(layers: Layer[], canvasWidth: number, canvasHeight: number): void {
		this.layers = layers;
		this.canvasWidth = canvasWidth;
		this.canvasHeight = canvasHeight;
		this._lastComposite = null;
		this.clearHistory();
	}

	/**
	 * Build an internal layer object with a fresh id and default appearance.
	 */
	_toLayer(layer: LayerInput, offsetX: number, offsetY: number): Layer {
		return {
			id: `layer-${_nextLayerId++}`,
			data: layer.data,
			width: layer.width,
			height: layer.height,
			channels: layer.channels,
			isFloat: layer.isFloat,
			typeMax: layer.typeMax,
			offsetX,
			offsetY,
			opacity: 1,
			blendMode: 'normal',
			visible: true,
			name: layer.name,
			uri: layer.uri,
			groupPath: layer.groupPath,
			groupIds: layer.groupIds,
			sourceNodeId: layer.sourceNodeId,
			sourceSupport: layer.sourceSupport,
			sourceBlendMode: layer.sourceBlendMode,
			sourceNumericType: layer.sourceNumericType,
			kind: layer.kind ?? 'raster',
			adjustment: layer.adjustment,
			parentId: layer.parentId,
			clipped: layer.clipped,
			rasterMask: layer.rasterMask,
		};
	}
}

export { BLEND_MODES };

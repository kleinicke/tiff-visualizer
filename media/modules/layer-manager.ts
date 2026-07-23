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

import { composite, centeredOffset, BLEND_MODES, Layer, CompositeResult, LayerAdjustment } from './layer-compositor.js';
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
	kind?: Layer['kind'];
	adjustment?: LayerAdjustment;
	parentId?: string;
	clipped?: boolean;
	rasterMask?: Layer['rasterMask'];
}

let _nextLayerId = 1;

export class LayerManager {
	layers: Layer[];
	active: boolean;
	canvasWidth: number;
	canvasHeight: number;
	_lastComposite: CompositeResult | null;
	documentExpanded: boolean;

	constructor() {
		this.layers = [];
		this.active = false;
		this.canvasWidth = 0;
		this.canvasHeight = 0;
		this._lastComposite = null;
		this.documentExpanded = false;
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
		this.documentExpanded = false;
	}

	/**
	 * Add a layer on top, centered on the canvas by default.
	 * @returns The new layer's id.
	 */
	addLayer(layer: LayerInput): string {
		const { offsetX, offsetY } = centeredOffset(layer.width, layer.height, this.canvasWidth || layer.width, this.canvasHeight || layer.height);
		const l = this._toLayer(layer, offsetX, offsetY);
		l.name = layer.name || `Layer ${this.layers.length}`;
		l.blendMode = 'normal';
		this.layers.push(l);
		return l.id as string;
	}

	/** Add a non-destructive adjustment immediately above a layer's clipping stack. */
	addAdjustmentLayer(targetId: string, type: LayerAdjustment['type']): string | null {
		const targetIndex = this.layers.findIndex(layer => layer.id === targetId);
		if (targetIndex < 0) { return null; }
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
		return created.id as string;
	}

	removeLayer(id: string): void {
		const idx = this.layers.findIndex(l => l.id === id);
		// Keep at least one layer (it defines the canvas).
		if (idx >= 0 && this.layers.length > 1) {
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
			if (remaining.length) { this.layers = remaining; }
		}
	}

	/**
	 * Update arbitrary properties of a layer (blendMode, opacity, visible, offset).
	 */
	updateLayer(id: string, props: Partial<Layer>): void {
		const layer = this.layers.find(l => l.id === id);
		if (layer) { Object.assign(layer, props); }
	}

	/** Toggle a layer between solo and an all-visible stack. */
	showOnlyLayer(id: string): void {
		this.toggleSoloLayers(new Set([id]));
	}

	/** Toggle a set of layers between solo and an all-visible stack. */
	toggleSoloLayers(ids: Set<string>): void {
		const alreadySolo = this.layers.length > 0 && this.layers.every(layer =>
			ids.has(layer.id as string) ? layer.visible !== false : layer.visible === false);
		for (const layer of this.layers) {
			layer.visible = alreadySolo || ids.has(layer.id as string);
		}
	}

	/**
	 * Nudge a layer's offset by (dx, dy) canvas pixels (used by the move tool).
	 */
	moveLayer(id: string, dx: number, dy: number): void {
		const layer = this.layers.find(l => l.id === id);
		if (layer) {
			layer.offsetX = (layer.offsetX ?? 0) + dx;
			layer.offsetY = (layer.offsetY ?? 0) + dy;
		}
	}

	/**
	 * Reorder a layer within the stack (0 = bottom).
	 */
	reorderLayer(id: string, newIndex: number): void {
		const idx = this.layers.findIndex(l => l.id === id);
		if (idx < 0) { return; }
		const clamped = Math.max(0, Math.min(this.layers.length - 1, newIndex));
		if (clamped === idx) { return; }
		const [layer] = this.layers.splice(idx, 1);
		this.layers.splice(clamped, 0, layer);
	}

	/**
	 * Composite the stack into a float buffer.
	 */
	getComposite(): CompositeResult | null {
		if (!this.canvasWidth || !this.canvasHeight) { return null; }
		return composite(this.layers, this.canvasWidth, this.canvasHeight);
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
	 * Sample the composited float value(s) at a canvas pixel, for the pixel
	 * inspector. Returns null if outside the canvas or no-data.
	 */
	getCompositeValueAt(x: number, y: number): number[] | null {
		// Use the most recently rendered composite to avoid recompositing the
		// whole stack on every pointer move.
		const c = this._lastComposite;
		if (!c || x < 0 || y < 0 || x >= c.width || y >= c.height) { return null; }
		const base = (y * c.width + x) * c.channels;
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
			kind: layer.kind ?? 'raster',
			adjustment: layer.adjustment,
			parentId: layer.parentId,
			clipped: layer.clipped,
			rasterMask: layer.rasterMask,
		};
	}
}

export { BLEND_MODES };

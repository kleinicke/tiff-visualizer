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

import { composite, centeredOffset, BLEND_MODES, Layer, CompositeResult } from './layer-compositor.js';
import { ImageRenderer } from './normalization-helper.js';
import { PerfTrace } from './perf-trace.js';
import type { ImageSettings } from './settings-manager.js';

export interface LayerInput {
	data: ArrayLike<number>;
	width: number;
	height: number;
	channels: number;
	isFloat: boolean;
	typeMax: number;
	name?: string;
	uri?: string;
}

let _nextLayerId = 1;

export class LayerManager {
	layers: Layer[];
	active: boolean;
	canvasWidth: number;
	canvasHeight: number;
	_lastComposite: CompositeResult | null;

	constructor() {
		this.layers = [];
		this.active = false;
		this.canvasWidth = 0;
		this.canvasHeight = 0;
		this._lastComposite = null;
	}

	/** True if there is more than just the base layer. */
	hasExtraLayers(): boolean {
		return this.layers.length > 1;
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

	removeLayer(id: string): void {
		const idx = this.layers.findIndex(l => l.id === id);
		// Keep at least one layer (it defines the canvas).
		if (idx >= 0 && this.layers.length > 1) { this.layers.splice(idx, 1); }
	}

	/**
	 * Update arbitrary properties of a layer (blendMode, opacity, visible, offset).
	 */
	updateLayer(id: string, props: Partial<Layer>): void {
		const layer = this.layers.find(l => l.id === id);
		if (layer) { Object.assign(layer, props); }
	}

	/**
	 * Make one layer visible and hide every other layer.
	 */
	showOnlyLayer(id: string): void {
		for (const layer of this.layers) {
			layer.visible = layer.id === id;
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
		};
	}
}

export { BLEND_MODES };

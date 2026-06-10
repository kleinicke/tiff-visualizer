// @ts-check
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

import { composite, centeredOffset, BLEND_MODES } from './layer-compositor.js';
import { ImageRenderer } from './normalization-helper.js';

/**
 * @typedef {Object} LayerInput
 * @property {ArrayLike<number>} data
 * @property {number} width
 * @property {number} height
 * @property {number} channels
 * @property {boolean} isFloat
 * @property {number} typeMax
 * @property {string} [name]
 * @property {string} [uri]
 */

let _nextLayerId = 1;

export class LayerManager {
	constructor() {
		/** @type {import('./layer-compositor.js').Layer[]} */
		this.layers = [];
		this.active = false;
		this.canvasWidth = 0;
		this.canvasHeight = 0;
	}

	/** @returns {boolean} True if there is more than just the base layer. */
	hasExtraLayers() {
		return this.layers.length > 1;
	}

	/** @returns {boolean} */
	isEmpty() {
		return this.layers.length === 0;
	}

	/**
	 * Reset the stack to a single base (background) layer. The canvas size is
	 * defined by this layer. Called whenever the primary image (re)loads.
	 * @param {LayerInput} layer
	 */
	setBaseLayer(layer) {
		const base = this._toLayer(layer, 0, 0);
		base.name = layer.name || 'Background';
		this.canvasWidth = layer.width;
		this.canvasHeight = layer.height;
		this.layers = [base];
	}

	/**
	 * Add a layer on top, centered on the canvas by default.
	 * @param {LayerInput} layer
	 * @returns {string} The new layer's id.
	 */
	addLayer(layer) {
		const { offsetX, offsetY } = centeredOffset(layer.width, layer.height, this.canvasWidth || layer.width, this.canvasHeight || layer.height);
		const l = this._toLayer(layer, offsetX, offsetY);
		l.name = layer.name || `Layer ${this.layers.length}`;
		l.blendMode = 'normal';
		this.layers.push(l);
		return /** @type {string} */ (l.id);
	}

	/** @param {string} id */
	removeLayer(id) {
		const idx = this.layers.findIndex(l => l.id === id);
		// Keep at least one layer (it defines the canvas).
		if (idx >= 0 && this.layers.length > 1) { this.layers.splice(idx, 1); }
	}

	/**
	 * Update arbitrary properties of a layer (blendMode, opacity, visible, offset).
	 * @param {string} id
	 * @param {Partial<import('./layer-compositor.js').Layer>} props
	 */
	updateLayer(id, props) {
		const layer = this.layers.find(l => l.id === id);
		if (layer) { Object.assign(layer, props); }
	}

	/**
	 * Nudge a layer's offset by (dx, dy) canvas pixels (used by the move tool).
	 * @param {string} id
	 * @param {number} dx
	 * @param {number} dy
	 */
	moveLayer(id, dx, dy) {
		const layer = this.layers.find(l => l.id === id);
		if (layer) {
			layer.offsetX = (layer.offsetX ?? 0) + dx;
			layer.offsetY = (layer.offsetY ?? 0) + dy;
		}
	}

	/**
	 * Reorder a layer within the stack (0 = bottom).
	 * @param {string} id
	 * @param {number} newIndex
	 */
	reorderLayer(id, newIndex) {
		const idx = this.layers.findIndex(l => l.id === id);
		if (idx < 0) { return; }
		const clamped = Math.max(0, Math.min(this.layers.length - 1, newIndex));
		if (clamped === idx) { return; }
		const [layer] = this.layers.splice(idx, 1);
		this.layers.splice(clamped, 0, layer);
	}

	/**
	 * Composite the stack into a float buffer.
	 * @returns {import('./layer-compositor.js').CompositeResult|null}
	 */
	getComposite() {
		if (!this.canvasWidth || !this.canvasHeight) { return null; }
		return composite(this.layers, this.canvasWidth, this.canvasHeight);
	}

	/**
	 * Composite and render to ImageData via the central ImageRenderer, so the
	 * result honors the current normalization/gamma/NaN settings.
	 * @param {any} settings
	 * @param {{nanColor?: {r:number,g:number,b:number}}} [options]
	 * @returns {ImageData|null}
	 */
	renderToImageData(settings, options = {}) {
		const c = this.getComposite();
		if (!c) { return null; }
		return ImageRenderer.render(
			c.data,
			c.width,
			c.height,
			c.channels,
			c.isFloat,
			c.stats,
			settings,
			{ nanColor: options.nanColor, typeMax: c.typeMax }
		);
	}

	/**
	 * Sample the composited float value(s) at a canvas pixel, for the pixel
	 * inspector. Returns null if outside the canvas or no-data.
	 * @param {number} x
	 * @param {number} y
	 * @returns {number[]|null}
	 */
	getCompositeValueAt(x, y) {
		const c = this.getComposite();
		if (!c || x < 0 || y < 0 || x >= c.width || y >= c.height) { return null; }
		const base = (y * c.width + x) * c.channels;
		const out = [];
		for (let i = 0; i < c.channels; i++) { out.push(c.data[base + i]); }
		return out;
	}

	/**
	 * Build an internal layer object with a fresh id and default appearance.
	 * @param {LayerInput} layer
	 * @param {number} offsetX
	 * @param {number} offsetY
	 * @returns {import('./layer-compositor.js').Layer}
	 */
	_toLayer(layer, offsetX, offsetY) {
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

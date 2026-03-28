// @ts-check
"use strict";

/**
 * Colormap Legend Module
 * Renders a vertical colorbar with value labels on the right side of the viewport.
 */
export class ColormapLegend {
	/**
	 * @param {HTMLElement} container - Parent element to append the legend to
	 */
	constructor(container) {
		/** @type {HTMLElement} */
		this._container = container;
		/** @type {HTMLElement|null} */
		this._legendElement = null;
		/** @type {HTMLCanvasElement|null} */
		this._canvas = null;

		this._createLegend();
	}

	/**
	 * Create the legend DOM structure
	 * @private
	 */
	_createLegend() {
		const legend = document.createElement('div');
		legend.className = 'colormap-legend';
		legend.style.display = 'none';

		const canvas = document.createElement('canvas');
		canvas.className = 'colormap-legend-canvas';
		canvas.width = 30;
		canvas.height = 256;

		const labelsContainer = document.createElement('div');
		labelsContainer.className = 'colormap-legend-labels';

		legend.appendChild(canvas);
		legend.appendChild(labelsContainer);

		this._legendElement = legend;
		this._canvas = canvas;
		this._container.appendChild(legend);
	}

	/**
	 * Render the colormap legend
	 * @param {string} colormapName - Colormap name
	 * @param {number} min - Minimum value
	 * @param {number} max - Maximum value
	 * @param {boolean} includeNegative - Whether to use symmetric range
	 * @param {Object|null} colormapConverter - ColormapConverter instance (for named colormaps)
	 */
	show(colormapName, min, max, includeNegative, colormapConverter) {
		if (!this._legendElement || !this._canvas) return;

		// Adjust range for symmetric display
		let displayMin = min;
		let displayMax = max;
		if (includeNegative && min < 0) {
			const absMax = Math.max(Math.abs(min), Math.abs(max));
			displayMin = -absMax;
			displayMax = absMax;
		}

		this._renderGradient(colormapName, colormapConverter);
		this._renderLabels(displayMin, displayMax);
		this._legendElement.style.display = 'flex';
	}

	/**
	 * Hide the legend
	 */
	hide() {
		if (this._legendElement) {
			this._legendElement.style.display = 'none';
		}
	}

	/**
	 * @returns {boolean}
	 */
	isVisible() {
		return this._legendElement ? this._legendElement.style.display !== 'none' : false;
	}

	/**
	 * Render the gradient bar on the canvas
	 * @private
	 * @param {string} colormapName
	 * @param {Object|null} colormapConverter
	 */
	_renderGradient(colormapName, colormapConverter) {
		if (!this._canvas) return;

		const ctx = this._canvas.getContext('2d');
		if (!ctx) return;

		const width = this._canvas.width;
		const height = this._canvas.height;

		// Get the colormap lookup table for named colormaps
		let colormapLUT = null;
		if (colormapName !== 'original' && colormapName !== 'scaled' && colormapName !== 'gray'
			&& colormapConverter && colormapConverter.colormaps && colormapConverter.colormaps[colormapName]) {
			colormapLUT = colormapConverter.colormaps[colormapName];
		}

		// Draw gradient from top (max) to bottom (min)
		for (let y = 0; y < height; y++) {
			const normalized = 1 - (y / (height - 1)); // Top = 1 (max), Bottom = 0 (min)
			const idx = Math.round(normalized * 255);

			let r, g, b;
			if (colormapLUT) {
				[r, g, b] = colormapLUT[idx];
			} else {
				// Grayscale
				r = g = b = idx;
			}

			ctx.fillStyle = `rgb(${r},${g},${b})`;
			ctx.fillRect(0, y, width, 1);
		}
	}

	/**
	 * Render value labels alongside the gradient
	 * @private
	 * @param {number} min
	 * @param {number} max
	 */
	_renderLabels(min, max) {
		if (!this._legendElement) return;
		const labelsContainer = this._legendElement.querySelector('.colormap-legend-labels');
		if (!labelsContainer) return;

		labelsContainer.innerHTML = '';

		const numLabels = 7;
		for (let i = 0; i < numLabels; i++) {
			const fraction = i / (numLabels - 1);
			const value = max - fraction * (max - min); // Top = max, bottom = min

			const label = document.createElement('span');
			label.className = 'colormap-legend-label';
			label.textContent = this._formatValue(value);
			labelsContainer.appendChild(label);
		}
	}

	/**
	 * Format a value for display
	 * @private
	 * @param {number} value
	 * @returns {string}
	 */
	_formatValue(value) {
		if (Math.abs(value) < 0.001 && value !== 0) {
			return value.toExponential(1);
		}
		if (Math.abs(value) >= 1000) {
			return value.toExponential(1);
		}
		// Use up to 3 significant figures
		return parseFloat(value.toPrecision(3)).toString();
	}

	/**
	 * Destroy the legend and clean up
	 */
	destroy() {
		if (this._legendElement) {
			this._legendElement.remove();
			this._legendElement = null;
		}
		this._canvas = null;
	}
}

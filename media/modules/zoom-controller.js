// @ts-check
"use strict";

/**
 * Zoom Controller Module
 * Handles zoom, scale, pan, and viewport management
 */
export class ZoomController {
	constructor(settingsManager, vscode) {
		this.settingsManager = settingsManager;
		this.vscode = vscode;
		
		// Initialize state from VS Code
		const initialState = vscode.getState() || { scale: 'fit', offsetX: 0, offsetY: 0 };
		this.scale = initialState.scale;
		this.initialState = initialState;
		
		// DOM elements
		this.container = document.body;
		this.imageElement = null;
		this.canvas = null;
		this.hasLoadedImage = false;
	}

	/**
	 * Set the image element reference
	 * @param {HTMLElement} element
	 */
	setImageElement(element) {
		this.imageElement = element;
	}

	/**
	 * Set the canvas reference
	 * @param {HTMLCanvasElement} canvas
	 */
	setCanvas(canvas) {
		this.canvas = canvas;
	}

	/**
	 * Mark that image has been loaded
	 */
	setImageLoaded() {
		this.hasLoadedImage = true;
	}

	/**
	 * Update scale with new value
	 * @param {number|string} newScale
	 */
	updateScale(newScale) {
		if (!this.imageElement || !this.hasLoadedImage || !this.imageElement.parentElement) {
			return;
		}

		const constants = this.settingsManager.constants;
		const isTiff = !!this.canvas;
		const wasInFitMode = this.scale === 'fit';

		if (newScale === 'fit') {
			this.scale = 'fit';
			this.imageElement.classList.add('scale-to-fit');
			this.imageElement.classList.remove('pixelated');
			if (isTiff) {
				this.imageElement.style.transform = '';
				this.imageElement.style.transformOrigin = '';
			} else {
				// @ts-ignore Non-standard CSS property
				this.imageElement.style.zoom = 'normal';
			}
			this.vscode.setState(undefined);
		} else {
			this.scale = this._clamp(newScale, constants.MIN_SCALE, constants.MAX_SCALE);
			if (this.scale >= constants.PIXELATION_THRESHOLD) {
				this.imageElement.classList.add('pixelated');
			} else {
				this.imageElement.classList.remove('pixelated');
			}

			let dx, dy;
			
			if (wasInFitMode) {
				// When transitioning from 'fit' mode, center the image
				// Since the image was centered in fit mode, we want to keep it centered
				dx = 0.5; // Center horizontally
				dy = 0.5; // Center vertically
			} else {
				// Normal zoom operation - maintain current viewport center
				dx = (window.scrollX + this.container.clientWidth / 2) / this.container.scrollWidth;
				dy = (window.scrollY + this.container.clientHeight / 2) / this.container.scrollHeight;
			}

			this.imageElement.classList.remove('scale-to-fit');
			
			if (isTiff) {
				// Set transform origin to top-left to make scaling behavior consistent
				this.imageElement.style.transformOrigin = '0 0';
				this.imageElement.style.transform = `scale(${this.scale})`;
			} else {
				// @ts-ignore Non-standard CSS property
				this.imageElement.style.zoom = this.scale;
			}

			// Calculate new scroll position to maintain the center point
			const newScrollX = this.container.scrollWidth * dx - this.container.clientWidth / 2;
			const newScrollY = this.container.scrollHeight * dy - this.container.clientHeight / 2;

			window.scrollTo(newScrollX, newScrollY);

			this.vscode.setState({ scale: this.scale, offsetX: newScrollX, offsetY: newScrollY });
		}

		this.vscode.postMessage({
			type: 'zoom',
			value: this.scale
		});
	}

	/**
	 * Zoom in to next level
	 */
	zoomIn() {
		if (!this.imageElement || !this.hasLoadedImage) {
			return;
		}

		if (this.scale === 'fit') {
			this.firstZoom();
		}

		const zoomLevels = this.settingsManager.constants.ZOOM_LEVELS;
		let i = 0;
		for (; i < zoomLevels.length; ++i) {
			if (zoomLevels[i] > this.scale) {
				break;
			}
		}
		this.updateScale(zoomLevels[i] || this.settingsManager.constants.MAX_SCALE);
	}

	/**
	 * Zoom out to previous level
	 */
	zoomOut() {
		if (!this.imageElement || !this.hasLoadedImage) {
			return;
		}

		if (this.scale === 'fit') {
			this.firstZoom();
		}

		const zoomLevels = this.settingsManager.constants.ZOOM_LEVELS;
		let i = zoomLevels.length - 1;
		for (; i >= 0; --i) {
			if (zoomLevels[i] < this.scale) {
				break;
			}
		}
		this.updateScale(zoomLevels[i] || this.settingsManager.constants.MIN_SCALE);
	}

	/**
	 * Calculate first zoom level based on current display size
	 */
	firstZoom() {
		if (!this.imageElement || !this.hasLoadedImage) {
			return;
		}
		// For all image types, imageElement is the canvas.
		// The current scale is the ratio of its displayed size to its intrinsic size.
		const canvas = /** @type {HTMLCanvasElement} */ (this.imageElement);
		this.scale = canvas.clientWidth / canvas.width;
		this.updateScale(this.scale);
	}

	/**
	 * Reset zoom to fit
	 */
	resetZoom() {
		this.updateScale('fit');
	}

	/**
	 * Handle mouse wheel events for zooming
	 * @param {WheelEvent} e
	 * @param {boolean} ctrlPressed
	 * @param {boolean} altPressed
	 */
	handleWheelZoom(e, ctrlPressed, altPressed) {
		if (!this.imageElement || !this.hasLoadedImage) {
			return;
		}

		const isScrollWheelKeyPressed = this.settingsManager.isMac ? altPressed : ctrlPressed;
		if (!isScrollWheelKeyPressed && !e.ctrlKey) { // pinching is reported as scroll wheel + ctrl
			return;
		}

		e.preventDefault();
		e.stopPropagation();

		if (this.scale === 'fit') {
			this.firstZoom();
		}

		const delta = e.deltaY > 0 ? 1 : -1;
		this.updateScale(this.scale * (1 - delta * this.settingsManager.constants.SCALE_PINCH_FACTOR));
	}

	/**
	 * Apply initial zoom and scroll position
	 */
	applyInitialZoom() {
		this.updateScale(this.scale);

		if (this.initialState.scale !== 'fit') {
			window.scrollTo(this.initialState.offsetX, this.initialState.offsetY);
		}
	}

	/**
	 * Save current state
	 */
	saveState() {
		const entry = this.vscode.getState();
		if (entry) {
			this.vscode.setState(entry);
		}
	}

	/**
	 * Clamp a value between min and max
	 * @private
	 */
	_clamp(value, min, max) {
		return Math.min(Math.max(value, min), max);
	}
} 
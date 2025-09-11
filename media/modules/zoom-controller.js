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
		const wasInFitMode = this.scale === 'fit';

		if (newScale === 'fit') {
			this.scale = 'fit';
			this.imageElement.classList.add('scale-to-fit');
			this.imageElement.classList.remove('pixelated');
			// Clear inline sizing and transforms when returning to fit
			this.imageElement.style.transform = '';
			this.imageElement.style.transformOrigin = '';
			this.imageElement.style.width = '';
			this.imageElement.style.height = '';
			this.imageElement.style.margin = '';
			this.vscode.setState(undefined);
		} else {
			const oldScale = this.scale;
			this.scale = this._clamp(newScale, constants.MIN_SCALE, constants.MAX_SCALE);
			if (this.scale >= constants.PIXELATION_THRESHOLD) {
				this.imageElement.classList.add('pixelated');
			} else {
				this.imageElement.classList.remove('pixelated');
			}

			// Compute the image-space point under the viewport center before scaling
			const canvas = /** @type {HTMLCanvasElement} */ (this.imageElement);
			const naturalWidth = canvas.width;
			const naturalHeight = canvas.height;
			const prevScale = (wasInFitMode)
				? (canvas.clientWidth / naturalWidth)
				: /** @type {number} */ (oldScale);

			// Viewport center in document coordinates
			const viewportCenterX = window.scrollX + this.container.clientWidth / 2;
			const viewportCenterY = window.scrollY + this.container.clientHeight / 2;
			// Element top-left in document coordinates
			const rectBefore = this.imageElement.getBoundingClientRect();
			const elemLeftDoc = window.scrollX + rectBefore.left;
			const elemTopDoc = window.scrollY + rectBefore.top;
			// Image-space center point
			const centerXImage = (viewportCenterX - elemLeftDoc) / prevScale;
			const centerYImage = (viewportCenterY - elemTopDoc) / prevScale;

			// Switch to layout-based scaling: remove fit class and set explicit size
			this.imageElement.classList.remove('scale-to-fit');
			this.imageElement.style.transform = '';
			this.imageElement.style.transformOrigin = '';
			this.imageElement.style.width = `${naturalWidth * this.scale}px`;
			this.imageElement.style.height = `${naturalHeight * this.scale}px`;

			// Center when smaller than viewport, remove margins when scrollable
			const canScrollX = this.container.scrollWidth > this.container.clientWidth + 1;
			const canScrollY = this.container.scrollHeight > this.container.clientHeight + 1;
			this.imageElement.style.marginLeft = canScrollX ? '0' : 'auto';
			this.imageElement.style.marginRight = canScrollX ? '0' : 'auto';
			this.imageElement.style.marginTop = canScrollY ? '0' : 'auto';
			this.imageElement.style.marginBottom = canScrollY ? '0' : 'auto';

			// Recalculate element position after layout change
			const rectAfter = this.imageElement.getBoundingClientRect();
			const elemLeftDocAfter = window.scrollX + rectAfter.left;
			const elemTopDocAfter = window.scrollY + rectAfter.top;

			// Calculate new scroll position to keep the same image point centered
			let newScrollX = centerXImage * this.scale + elemLeftDocAfter - this.container.clientWidth / 2;
			let newScrollY = centerYImage * this.scale + elemTopDocAfter - this.container.clientHeight / 2;

			// Clamp scroll positions to valid ranges
			const maxScrollX = Math.max(0, this.container.scrollWidth - this.container.clientWidth);
			const maxScrollY = Math.max(0, this.container.scrollHeight - this.container.clientHeight);
			newScrollX = Math.min(Math.max(0, newScrollX), maxScrollX);
			newScrollY = Math.min(Math.max(0, newScrollY), maxScrollY);

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
	 * Get current zoom state for image switching
	 */
	getCurrentState() {
		return {
			scale: this.scale,
			x: window.scrollX,
			y: window.scrollY
		};
	}

	/**
	 * Restore zoom state after image switching
	 */
	restoreState(state) {
		if (state && state.scale !== undefined) {
			this.updateScale(state.scale);
			if (state.x !== undefined && state.y !== undefined) {
				// Use setTimeout to ensure the new image is fully rendered
				setTimeout(() => {
					window.scrollTo(state.x, state.y);
				}, 50);
			}
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
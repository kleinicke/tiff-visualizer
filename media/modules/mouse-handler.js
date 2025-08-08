// @ts-check
"use strict";

/**
 * Mouse Handler Module
 * Handles mouse interactions, pixel reading, and cursor state
 */
export class MouseHandler {
	constructor(settingsManager, vscode, tiffProcessor) {
		this.settingsManager = settingsManager;
		this.vscode = vscode;
		this.tiffProcessor = tiffProcessor;
		
		// State
		this.ctrlPressed = false;
		this.altPressed = false;
		this.isActive = false;
		this.consumeClick = true;
		
		// DOM elements
		this.container = document.body;
		this.imageElement = null;
		
		this._setupKeyboardListeners();
	}

	/**
	 * Set the image element reference
	 * @param {HTMLElement} element
	 */
	setImageElement(element) {
		this.imageElement = element;
	}

	/**
	 * Set active state
	 * @param {boolean} value
	 */
	setActive(value) {
		this.isActive = value;
		if (value) {
			if (this.settingsManager.isMac ? this.altPressed : this.ctrlPressed) {
				this.container.classList.remove('zoom-in');
				this.container.classList.add('zoom-out');
			} else {
				this.container.classList.remove('zoom-out');
				this.container.classList.add('zoom-in');
			}
		} else {
			this.ctrlPressed = false;
			this.altPressed = false;
			this.container.classList.remove('zoom-out');
			this.container.classList.remove('zoom-in');
		}
	}

	/**
	 * Add mouse listeners to an element
	 * @param {HTMLElement} element
	 */
	addMouseListeners(element) {
		element.addEventListener('mouseenter', (e) => this._handleMouseEnter(e));
		element.addEventListener('mousemove', (e) => this._handleMouseMove(e));
		element.addEventListener('mouseleave', (e) => this._handleMouseLeave(e));
	}

	/**
	 * Handle mouse enter event
	 * @private
	 */
	_handleMouseEnter(e) {
		if (!this.imageElement) return;
		const pixelInfo = this._getPixelInfo(e);
		if (pixelInfo) {
			this.vscode.postMessage({ type: 'pixelFocus', value: pixelInfo });
		} else {
			this.vscode.postMessage({ type: 'pixelBlur' });
		}
	}

	/**
	 * Handle mouse move event
	 * @private
	 */
	_handleMouseMove(e) {
		if (!this.imageElement) return;
		const pixelInfo = this._getPixelInfo(e);
		if (pixelInfo) {
			this.vscode.postMessage({ type: 'pixelFocus', value: pixelInfo });
		} else {
			this.vscode.postMessage({ type: 'pixelBlur' });
		}
	}

	/**
	 * Handle mouse leave event
	 * @private
	 */
	_handleMouseLeave(e) {
		this.vscode.postMessage({
			type: 'pixelBlur'
		});
	}

	/**
	 * Get pixel information at mouse position
	 * @private
	 */
	_getPixelInfo(e) {
		if (!this.imageElement) return '';
		
		const rect = this.imageElement.getBoundingClientRect();
		const canvas = /** @type {HTMLCanvasElement} */ (this.imageElement);
		const naturalWidth = canvas.width;
		const naturalHeight = canvas.height;
		// Ignore when outside the element's content box
		if (
			e.clientX < rect.left || e.clientX > rect.right ||
			e.clientY < rect.top || e.clientY > rect.bottom ||
			rect.width <= 0 || rect.height <= 0
		) {
			return '';
		}
		const ratioX = (e.clientX - rect.left) / rect.width;
		const ratioY = (e.clientY - rect.top) / rect.height;
		let x = Math.floor(ratioX * naturalWidth);
		let y = Math.floor(ratioY * naturalHeight);
		// Clamp to valid pixel indices
		x = Math.min(Math.max(0, x), Math.max(0, naturalWidth - 1));
		y = Math.min(Math.max(0, y), Math.max(0, naturalHeight - 1));
		const color = this._getColorAtPixel(x, y, naturalWidth, naturalHeight);
		
		return `${x}x${y} ${color}`;
	}

	/**
	 * Get color at specific pixel coordinates
	 * @private
	 */
	_getColorAtPixel(x, y, naturalWidth, naturalHeight) {
		// Try TIFF processor first
		if (this.tiffProcessor) {
			const tiffColor = this.tiffProcessor.getColorAtPixel(x, y, naturalWidth, naturalHeight);
			if (tiffColor) {
				return tiffColor;
			}
		}

		// Fallback to canvas pixel reading for standard images
		if (this.imageElement) {
			const canvas = /** @type {HTMLCanvasElement} */ (this.imageElement);
			const ctx = canvas.getContext('2d');
			if (ctx) {
				const pixel = ctx.getImageData(x, y, 1, 1).data;
				return `${pixel[0].toString().padStart(3, '0')} ${pixel[1].toString().padStart(3, '0')} ${pixel[2].toString().padStart(3, '0')}`;
			}
		}
		
		return '';
	}

	/**
	 * Setup keyboard event listeners
	 * @private
	 */
	_setupKeyboardListeners() {
		window.addEventListener('keydown', (e) => this._handleKeyDown(e));
		window.addEventListener('keyup', (e) => this._handleKeyUp(e));
		window.addEventListener('blur', () => this._handleBlur());
	}

	/**
	 * Handle key down events
	 * @private
	 */
	_handleKeyDown(e) {
		if (!this.imageElement) return;

		if (e.key === 'Control') {
			this.ctrlPressed = true;
		} else if (e.key === 'Alt') {
			this.altPressed = true;
		}

		this._updateCursorState();
	}

	/**
	 * Handle key up events
	 * @private
	 */
	_handleKeyUp(e) {
		if (!this.imageElement) return;

		if (e.key === 'Control') {
			this.ctrlPressed = false;
		} else if (e.key === 'Alt') {
			this.altPressed = false;
		}

		this._updateCursorState();
	}

	/**
	 * Handle window blur (lost focus)
	 * @private
	 */
	_handleBlur() {
		this.ctrlPressed = false;
		this.altPressed = false;
		this._updateCursorState();
	}

	/**
	 * Update cursor state based on key presses
	 * @private
	 */
	_updateCursorState() {
		if (!this.isActive) return;

		if (this.settingsManager.isMac ? this.altPressed : this.ctrlPressed) {
			this.container.classList.remove('zoom-in');
			this.container.classList.add('zoom-out');
		} else {
			this.container.classList.remove('zoom-out');
			this.container.classList.add('zoom-in');
		}
	}

	/**
	 * Get current keyboard state
	 */
	getKeyboardState() {
		return {
			ctrlPressed: this.ctrlPressed,
			altPressed: this.altPressed
		};
	}
} 
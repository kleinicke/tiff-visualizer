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
		this.exrProcessor = null;
		this.npyProcessor = null;
		this.pfmProcessor = null;
		this.ppmProcessor = null;
		this.pngProcessor = null;
		
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

	setExrProcessor(proc) { this.exrProcessor = proc; }
	setNpyProcessor(proc) { this.npyProcessor = proc; }
	setPfmProcessor(proc) { this.pfmProcessor = proc; }
	setPpmProcessor(proc) { this.ppmProcessor = proc; }
	setPngProcessor(proc) { this.pngProcessor = proc; }

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
	 * Apply gamma and brightness transformations to a pixel value
	 * The correct order is: remove input gamma → apply exposure in linear space → apply output gamma
	 * @private
	 * @param {number} value - Normalized pixel value (0-1)
	 * @returns {number} - Transformed value
	 */
	_applyGammaBrightness(value) {
		const gamma = this.settingsManager.settings.gamma || { in: 1.0, out: 1.0 };
		const brightness = this.settingsManager.settings.brightness || { offset: 0 };

		// Step 1: Remove input gamma (linearize) - raise to gammaIn power
		let linear = Math.pow(value, gamma.in);

		// Step 2: Apply exposure compensation in linear space (in stops: 2^stops)
		const exposureStops = brightness.offset;
		linear = linear * Math.pow(2, exposureStops);

		// Step 3: Apply output gamma - raise to 1/gammaOut power
		let corrected = Math.pow(Math.max(0, linear), 1.0 / gamma.out);

		// Note: Do NOT clamp here - allow values outside [0,1] for float images
		return corrected;
	}

	/**
	 * Get color at specific pixel coordinates
	 * @private
	 */
	_getColorAtPixel(x, y, naturalWidth, naturalHeight) {
		// Check if we should show modified values
		const showModified = this.settingsManager.settings.colorPickerShowModified || false;

		// Try TIFF processor first
		if (this.tiffProcessor) {
			const tiffColor = this.tiffProcessor.getColorAtPixel(x, y, naturalWidth, naturalHeight);
			if (tiffColor) {
				if (showModified) {
					// Apply gamma and brightness to TIFF values
					const values = this._parseTiffColor(tiffColor);
					if (values) {
						const transformed = values.map(v => this._applyGammaBrightness(v));
						return this._formatColorValues(transformed, values.length);
					}
				}
				return tiffColor;
			}
		}

		// Try EXR processor for HDR images
		if (this.exrProcessor && this.exrProcessor.rawExrData) {
			const pixelValues = this.exrProcessor.getPixelValue(x, y);
			if (pixelValues) {
				if (showModified) {
					// Apply gamma and brightness to HDR values
					const transformed = pixelValues.map(v => {
						if (isNaN(v) || !isFinite(v)) return v;
						return this._applyGammaBrightness(v);
					});

					// Format HDR values with more precision
					if (transformed.length === 1) {
						// Grayscale
						return transformed[0].toFixed(6);
					} else if (transformed.length === 3) {
						// RGB
						return `${transformed[0].toFixed(6)} ${transformed[1].toFixed(6)} ${transformed[2].toFixed(6)}`;
					} else if (transformed.length === 4) {
						// RGBA
						return `${transformed[0].toFixed(6)} ${transformed[1].toFixed(6)} ${transformed[2].toFixed(6)} A:${transformed[3].toFixed(6)}`;
					}
				} else {
					// Show original values
					if (pixelValues.length === 1) {
						return pixelValues[0].toFixed(6);
					} else if (pixelValues.length === 3) {
						return `${pixelValues[0].toFixed(6)} ${pixelValues[1].toFixed(6)} ${pixelValues[2].toFixed(6)}`;
					} else if (pixelValues.length === 4) {
						return `${pixelValues[0].toFixed(6)} ${pixelValues[1].toFixed(6)} ${pixelValues[2].toFixed(6)} A:${pixelValues[3].toFixed(6)}`;
					}
				}
			}
		}

		// Try NPY/PFM/PPM processors for other image formats
		if (this.npyProcessor) {
			const v = this.npyProcessor.getColorAtPixel(x, y, naturalWidth, naturalHeight);
			if (v) {
				if (showModified) {
					const values = this._parseFloatColor(v);
					if (values) {
						const transformed = values.map(val => this._applyGammaBrightness(val));
						return this._formatColorValues(transformed, values.length);
					}
				}
				return v;
			}
		}
		if (this.pfmProcessor) {
			const v = this.pfmProcessor.getColorAtPixel(x, y, naturalWidth, naturalHeight);
			if (v) {
				if (showModified) {
					const values = this._parseFloatColor(v);
					if (values) {
						const transformed = values.map(val => this._applyGammaBrightness(val));
						return this._formatColorValues(transformed, values.length);
					}
				}
				return v;
			}
		}
		if (this.ppmProcessor) {
			const v = this.ppmProcessor.getColorAtPixel(x, y, naturalWidth, naturalHeight);
			if (v) {
				if (showModified) {
					const values = this._parseIntColor(v);
					if (values) {
						// For PPM, normalize to 0-1, apply transforms, then scale back
						const normalized = values.map(val => val / 255);
						const transformed = normalized.map(val => this._applyGammaBrightness(val));
						const scaled = transformed.map(val => Math.round(Math.max(0, Math.min(1, val)) * 255));
						return this._formatColorValues(scaled, values.length, true);
					}
				}
				return v;
			}
		}
		if (this.pngProcessor) {
			const v = this.pngProcessor.getColorAtPixel(x, y, naturalWidth, naturalHeight);
			if (v) {
				if (showModified) {
					const values = this._parseIntColor(v);
					if (values) {
						// For PNG, normalize to 0-1, apply transforms, then scale back
						const normalized = values.map(val => val / 255);
						const transformed = normalized.map(val => this._applyGammaBrightness(val));
						const scaled = transformed.map(val => Math.round(Math.max(0, Math.min(1, val)) * 255));
						return this._formatColorValues(scaled, values.length, true);
					}
				}
				return v;
			}
		}

		// Fallback to canvas pixel reading for standard images
		if (this.imageElement) {
			const canvas = /** @type {HTMLCanvasElement} */ (this.imageElement);
			const ctx = canvas.getContext('2d', { willReadFrequently: true });
			if (ctx) {
				const pixel = ctx.getImageData(x, y, 1, 1).data;
				if (showModified) {
					// Normalize to 0-1, apply transforms, then scale back to 0-255
					const normalized = Array.from(pixel.slice(0, 3)).map(v => v / 255);
					const transformed = normalized.map(val => this._applyGammaBrightness(val));
					const scaled = transformed.map(val => Math.round(Math.max(0, Math.min(1, val)) * 255));
					return `${scaled[0].toString().padStart(3, '0')} ${scaled[1].toString().padStart(3, '0')} ${scaled[2].toString().padStart(3, '0')}`;
				}
				return `${pixel[0].toString().padStart(3, '0')} ${pixel[1].toString().padStart(3, '0')} ${pixel[2].toString().padStart(3, '0')}`;
			}
		}

		return '';
	}

	/**
	 * Parse TIFF color string to array of values
	 * @private
	 * @param {string} colorStr - Color string from TIFF processor
	 * @returns {Array<number>|null} - Array of numeric values or null
	 */
	_parseTiffColor(colorStr) {
		try {
			// TIFF colors are space-separated numbers
			const parts = colorStr.trim().split(/\s+/);
			const values = parts.map(p => {
				const num = parseFloat(p);
				return isNaN(num) ? null : num;
			});
			return values.every(v => v !== null) ? values : null;
		} catch (e) {
			return null;
		}
	}

	/**
	 * Parse float color string to array of values (space-separated floats)
	 * @private
	 * @param {string} colorStr - Color string
	 * @returns {Array<number>|null} - Array of numeric values or null
	 */
	_parseFloatColor(colorStr) {
		try {
			// Float colors are space-separated numbers (possibly with A: prefix for alpha)
			const parts = colorStr.trim().split(/\s+/);
			const values = parts.map(p => {
				// Handle "A:0.5" format
				const num = parseFloat(p.replace('A:', ''));
				return isNaN(num) ? null : num;
			});
			return values.every(v => v !== null) ? values : null;
		} catch (e) {
			return null;
		}
	}

	/**
	 * Parse integer color string to array of values (0-255)
	 * @private
	 * @param {string} colorStr - Color string like "255 128 64"
	 * @returns {Array<number>|null} - Array of numeric values or null
	 */
	_parseIntColor(colorStr) {
		try {
			// Integer colors are padded 3-digit numbers like "255 128 064"
			const parts = colorStr.trim().split(/\s+/);
			const values = parts.map(p => {
				const num = parseInt(p, 10);
				return isNaN(num) ? null : num;
			});
			return values.every(v => v !== null) ? values : null;
		} catch (e) {
			return null;
		}
	}

	/**
	 * Format color values back to string
	 * @private
	 * @param {Array<number>} values - Color values
	 * @param {number} count - Number of values (for formatting)
	 * @param {boolean} [asIntegers] - If true, format as padded integers
	 * @returns {string} - Formatted color string
	 */
	_formatColorValues(values, count, asIntegers = false) {
		if (asIntegers) {
			return values.slice(0, count).map(v => Math.round(v).toString().padStart(3, '0')).join(' ');
		} else {
			// Float format with 6 decimal places
			return values.slice(0, count).map(v => v.toFixed(6)).join(' ');
		}
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
"use strict";

import type { SettingsManager } from './settings-manager.js';

type VsCodeApi = { postMessage: (msg: any) => any };

/**
 * Mouse Handler Module
 * Handles mouse interactions, pixel reading, and cursor state
 */
export class MouseHandler {
	settingsManager: SettingsManager;
	vscode: VsCodeApi;
	tiffProcessor: any;
	exrProcessor: any;
	npyProcessor: any;
	pfmProcessor: any;
	ppmProcessor: any;
	pngProcessor: any;
	hdrProcessor: any;
	tgaProcessor: any;
	webImageProcessor: any;
	jxlProcessor: any;
	rawProcessor: any;

	// State
	ctrlPressed: boolean;
	altPressed: boolean;
	isActive: boolean;
	consumeClick: boolean;

	/**
	 * Optional provider that returns the composited float value(s) at a pixel
	 * when layer compositing is active. When set and it returns a value, the
	 * pixel inspector shows the composite value (e.g. a subtraction result,
	 * which may be negative) instead of a single source image's value.
	 */
	compositeValueProvider: ((x: number, y: number) => number[] | null) | null;

	/**
	 * Optional provider for the decoded scalar value at a pixel, set when a
	 * colormapped image has been decoded to float. When set and it returns a
	 * finite value, the pixel inspector shows that scalar.
	 */
	decodedValueProvider: ((x: number, y: number) => number | null) | null;
	physicalPixelSize: { x?: number; y?: number; xUnit?: string; yUnit?: string } | null;

	// DOM elements
	container: HTMLElement;
	imageElement: HTMLElement | null;

	constructor(settingsManager: SettingsManager, vscode: VsCodeApi, tiffProcessor: any) {
		this.settingsManager = settingsManager;
		this.vscode = vscode;
		this.tiffProcessor = tiffProcessor;
		this.exrProcessor = null;
		this.npyProcessor = null;
		this.pfmProcessor = null;
		this.ppmProcessor = null;
		this.pngProcessor = null;
		this.hdrProcessor = null;
		this.tgaProcessor = null;
		this.webImageProcessor = null;
		this.jxlProcessor = null;
		this.rawProcessor = null;

		// State
		this.ctrlPressed = false;
		this.altPressed = false;
		this.isActive = false;
		this.consumeClick = true;

		this.compositeValueProvider = null;

		this.decodedValueProvider = null;
		this.physicalPixelSize = null;

		// DOM elements
		this.container = document.body;
		this.imageElement = null;

		this._setupKeyboardListeners();
	}

	/**
	 * Set the image element reference
	 */
	setImageElement(element: HTMLElement) {
		this.imageElement = element;
	}

	setPhysicalPixelSize(spacing: { x?: number; y?: number; xUnit?: string; yUnit?: string } | null): void {
		this.physicalPixelSize = spacing;
	}

	setExrProcessor(proc: any) { this.exrProcessor = proc; }
	setNpyProcessor(proc: any) { this.npyProcessor = proc; }
	setPfmProcessor(proc: any) { this.pfmProcessor = proc; }
	setPpmProcessor(proc: any) { this.ppmProcessor = proc; }
	setPngProcessor(proc: any) { this.pngProcessor = proc; }
	setHdrProcessor(proc: any) { this.hdrProcessor = proc; }
	setTgaProcessor(proc: any) { this.tgaProcessor = proc; }
	setWebImageProcessor(proc: any) { this.webImageProcessor = proc; }
	setJxlProcessor(proc: any) { this.jxlProcessor = proc; }
	setRawProcessor(proc: any) { this.rawProcessor = proc; }

	/**
	 * Set active state
	 */
	setActive(value: boolean) {
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
	 */
	addMouseListeners(element: HTMLElement) {
		element.addEventListener('mouseenter', (e) => this._handleMouseEnter(e));
		element.addEventListener('mousemove', (e) => this._handleMouseMove(e));
		element.addEventListener('mouseleave', (e) => this._handleMouseLeave(e));
	}

	/**
	 * Handle mouse enter event
	 * @private
	 */
	_handleMouseEnter(e: MouseEvent) {
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
	_handleMouseMove(e: MouseEvent) {
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
	_handleMouseLeave(_e: MouseEvent) {
		this.vscode.postMessage({
			type: 'pixelBlur'
		});
	}

	/**
	 * Get pixel information at mouse position
	 * @private
	 */
	_getPixelInfo(e: MouseEvent): string {
		if (!this.imageElement) return '';

		const rect = this.imageElement.getBoundingClientRect();
		const anyElement = this.imageElement as any;
		const naturalWidth = anyElement.naturalWidth || anyElement.width;
		const naturalHeight = anyElement.naturalHeight || anyElement.height;
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

		const spacing = this.physicalPixelSize;
		if (spacing && Number.isFinite(spacing.x) && Number.isFinite(spacing.y)) {
			const physicalX = x * Number(spacing.x);
			const physicalY = y * Number(spacing.y);
			const xUnit = spacing.xUnit || '';
			const yUnit = spacing.yUnit || xUnit;
			const physical = xUnit === yUnit
				? `${physicalX.toPrecision(5)}×${physicalY.toPrecision(5)} ${xUnit}`.trim()
				: `${physicalX.toPrecision(5)} ${xUnit} × ${physicalY.toPrecision(5)} ${yUnit}`.trim();
			return `${x}x${y} (${physical}) ${color}`;
		}
		return `${x}x${y} ${color}`;
	}

	/**
	 * Apply gamma and brightness transformations to a pixel value
	 * The correct order is: remove input gamma → apply exposure in linear space → apply output gamma
	 * @private
	 * @param value - Normalized pixel value (0-1)
	 * @returns Transformed value
	 */
	_applyGammaBrightness(value: number): number {
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
	 * Format composited float channel values for display (handles negatives,
	 * NaN and Infinity).
	 * @private
	 */
	_formatCompositeValues(values: number[]): string {
		const fmt = (v: number) => {
			if (Number.isNaN(v)) return 'NaN';
			if (v === Infinity) return 'Inf';
			if (v === -Infinity) return '-Inf';
			return parseFloat(v.toFixed(6)).toString();
		};
		if (values.length === 4) {
			return `${fmt(values[0])} ${fmt(values[1])} ${fmt(values[2])} α:${fmt(values[3])}`;
		}
		return values.map(fmt).join(' ');
	}

	/**
	 * Get color at specific pixel coordinates
	 * @private
	 */
	_getColorAtPixel(x: number, y: number, naturalWidth: number, naturalHeight: number): string {
		// When layer compositing is active, always report the composited value at
		// this pixel (works for subtraction/negative results, NaN, etc.).
		if (this.compositeValueProvider) {
			const composite = this.compositeValueProvider(x, y);
			if (composite) {
				return this._formatCompositeValues(composite);
			}
		}

		// When a colormapped image has been decoded to float, report the decoded
		// scalar (works regardless of which colormap is now applied for display).
		if (this.decodedValueProvider) {
			const decoded = this.decodedValueProvider(x, y);
			if (decoded !== null && decoded !== undefined) {
				return this._formatCompositeValues([decoded]);
			}
		}

		// Check if we should show modified values
		// ONLY allow showing modified values if we are in Gamma Mode
		const isGammaMode = this.settingsManager.settings.normalization && this.settingsManager.settings.normalization.gammaMode;
		const showModified = isGammaMode && (this.settingsManager.settings.colorPickerShowModified || false);

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
					// Apply gamma and brightness to HDR values (but NOT to alpha)
					const transformed = [];
					for (let i = 0; i < pixelValues.length; i++) {
						const v = pixelValues[i];
						if (isNaN(v) || !isFinite(v)) {
							transformed.push(v);
						} else if (i === 3 && pixelValues.length === 4) {
							// Alpha channel: do NOT apply gamma/brightness
							transformed.push(v);
						} else {
							// RGB channels: apply gamma/brightness
							transformed.push(this._applyGammaBrightness(v));
						}
					}

					// Format HDR values with more precision
					if (transformed.length === 1) {
						// Grayscale
						return transformed[0].toFixed(6);
					} else if (transformed.length === 3) {
						// RGB
						return `${transformed[0].toFixed(6)} ${transformed[1].toFixed(6)} ${transformed[2].toFixed(6)}`;
					} else if (transformed.length === 4) {
						// RGBA - alpha is shown unmodified
						return `${transformed[0].toFixed(6)} ${transformed[1].toFixed(6)} ${transformed[2].toFixed(6)} α:${transformed[3].toFixed(6)}`;
					}
				} else {
					// Show original values
					if (pixelValues.length === 1) {
						return pixelValues[0].toFixed(6);
					} else if (pixelValues.length === 3) {
						return `${pixelValues[0].toFixed(6)} ${pixelValues[1].toFixed(6)} ${pixelValues[2].toFixed(6)}`;
					} else if (pixelValues.length === 4) {
						// RGBA - consistent format with α: prefix for alpha
						return `${pixelValues[0].toFixed(6)} ${pixelValues[1].toFixed(6)} ${pixelValues[2].toFixed(6)} α:${pixelValues[3].toFixed(6)}`;
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
						const normalized = values.map(val => val / 255);
						const transformed = normalized.map((val, idx) => idx === 3 ? val : this._applyGammaBrightness(val));
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
						// Normalize to 0-1, apply gamma/brightness to RGB only (skip alpha at index 3)
						const normalized = values.map(val => val / 255);
						const transformed = normalized.map((val, idx) => idx === 3 ? val : this._applyGammaBrightness(val));
						const scaled = transformed.map(val => Math.round(Math.max(0, Math.min(1, val)) * 255));
						return this._formatColorValues(scaled, values.length, true);
					}
				}
				return v;
			}
		}

		if (this.hdrProcessor) {
			const v = this.hdrProcessor.getColorAtPixel(x, y, naturalWidth, naturalHeight);
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
		if (this.tgaProcessor) {
			const v = this.tgaProcessor.getColorAtPixel(x, y, naturalWidth, naturalHeight);
			if (v) {
				if (showModified) {
					const values = this._parseIntColor(v);
					if (values) {
						const normalized = values.map(val => val / 255);
						const transformed = normalized.map((val, idx) => idx === 3 ? val : this._applyGammaBrightness(val));
						const scaled = transformed.map(val => Math.round(Math.max(0, Math.min(1, val)) * 255));
						return this._formatColorValues(scaled, values.length, true);
					}
				}
				return v;
			}
		}
		if (this.webImageProcessor) {
			const v = this.webImageProcessor.getColorAtPixel(x, y, naturalWidth, naturalHeight);
			if (v) {
				if (showModified) {
					const values = this._parseIntColor(v);
					if (values) {
						const normalized = values.map(val => val / 255);
						const transformed = normalized.map((val, idx) => idx === 3 ? val : this._applyGammaBrightness(val));
						const scaled = transformed.map(val => Math.round(Math.max(0, Math.min(1, val)) * 255));
						return this._formatColorValues(scaled, values.length, true);
					}
				}
				return v;
			}
		}
		if (this.jxlProcessor) {
			const v = this.jxlProcessor.getColorAtPixel(x, y, naturalWidth, naturalHeight);
			if (v) {
				if (showModified) {
					const values = this._parseIntColor(v);
					if (values) {
						const normalized = values.map(val => val / 255);
						const transformed = normalized.map((val, idx) => idx === 3 ? val : this._applyGammaBrightness(val));
						const scaled = transformed.map(val => Math.round(Math.max(0, Math.min(1, val)) * 255));
						return this._formatColorValues(scaled, values.length, true);
					}
				}
				return v;
			}
		}
		if (this.rawProcessor) {
			const v = this.rawProcessor.getColorAtPixel(x, y, naturalWidth, naturalHeight);
			if (v) {
				if (showModified) {
					const values = this._parseIntColor(v);
					if (values) {
						// RAW has no alpha - all channels are RGB
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
			const canvas = this.imageElement as unknown as HTMLCanvasElement;
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
	 * @param colorStr - Color string from TIFF processor
	 * @returns Array of numeric values or null
	 */
	_parseTiffColor(colorStr: string): number[] | null {
		try {
			// TIFF colors are space-separated numbers
			const parts = colorStr.trim().split(/\s+/);
			const values = parts.map(p => {
				const num = parseFloat(p);
				return isNaN(num) ? null : num;
			});
			return values.every(v => v !== null) ? (values as number[]) : null;
		} catch (e) {
			return null;
		}
	}

	/**
	 * Parse float color string to array of values (space-separated floats or NaN/Inf)
	 * Handles formats like: "1.234 2.345 3.456" or "1.234 2.345 3.456 A:4.567" or "NaN Inf -Inf"
	 * @private
	 * @param colorStr - Color string
	 * @returns Array of numeric values or null
	 */
	_parseFloatColor(colorStr: string): number[] | null {
		try {
			// Float colors are space-separated numbers (possibly with A: prefix for alpha)
			const parts = colorStr.trim().split(/\s+/);
			const values = parts.map(p => {
				// Remove α: or A: prefix (alpha channel marker)
				const cleanPart = p.replace(/^[Aα]:/, '');
				// Handle special values
				if (cleanPart === 'NaN') return NaN;
				if (cleanPart === 'Inf') return Infinity;
				if (cleanPart === '-Inf') return -Infinity;
				const num = parseFloat(cleanPart);
				return isNaN(num) && cleanPart !== 'NaN' ? null : num;
			});
			return values.every(v => v !== null) ? (values as number[]) : null;
		} catch (e) {
			return null;
		}
	}

	/**
	 * Parse integer color string to array of values (0-255).
	 * Handles RGB strings like "255 128 064" and RGBA strings like "255 128 064 α:0.50".
	 * The α: prefix carries a 0-1 float that is scaled to 0-255 for uniform processing.
	 * @private
	 */
	_parseIntColor(colorStr: string): number[] | null {
		try {
			const parts = colorStr.trim().split(/\s+/);
			const values = parts.map(p => {
				if (p.startsWith('α:')) {
					// Alpha is a 0-1 normalized float; convert to 0-255 integer range
					const num = parseFloat(p.slice(2));
					return isNaN(num) ? null : Math.round(num * 255);
				}
				const num = parseInt(p, 10);
				return isNaN(num) ? null : num;
			});
			return values.every(v => v !== null) ? (values as number[]) : null;
		} catch (e) {
			return null;
		}
	}

	/**
	 * Format color values back to string
	 * Handles both integer and float formats consistently
	 * @private
	 * @param values - Color values
	 * @param count - Number of values (for formatting)
	 * @param asIntegers - If true, format as padded integers
	 * @returns Formatted color string
	 */
	_formatColorValues(values: number[], count: number, asIntegers = false): string {
		// RGB channels (indices 0-2)
		const rgb = values.slice(0, Math.min(3, count)).map(v => {
			if (asIntegers) {
				return Math.round(v).toString().padStart(3, '0');
			}
			return v.toFixed(6);
		});

		if (count === 4) {
			// Alpha channel (index 3): always displayed as 0-1 float regardless of mode,
			// because getColorAtPixel stores it as a 0-255 int but displays it as α:0.00-1.00
			const alphaStr = asIntegers
				? (values[3] / 255).toFixed(2)
				: values[3].toFixed(6);
			return `${rgb.join(' ')} α:${alphaStr}`;
		}
		return rgb.join(' ');
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
	_handleKeyDown(e: KeyboardEvent) {
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
	_handleKeyUp(e: KeyboardEvent) {
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

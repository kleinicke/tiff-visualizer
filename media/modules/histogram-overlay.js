// @ts-check
"use strict";

/**
 * Histogram Overlay Module
 * Provides interactive histogram visualization for images
 */
export class HistogramOverlay {
	constructor(settingsManager, vscode) {
		this.settingsManager = settingsManager;
		this.vscode = vscode;

		this.overlay = null;
		this.canvas = null;
		this.ctx = null;
		this.isVisible = false;
		this.histogramData = null;
		this.numBins = 256;
		this.scaleMode = 'sqrt'; // 'linear', 'sqrt'

		// Value range for bin labeling (set during computation)
		this.valueRange = { min: 0, max: 255, isFloat: false };
		// Original value stats (before gamma/brightness transformation)
		this.originalStats = null;

		// UI state
		this.isDragging = false;
		this.dragOffset = { x: 0, y: 0 };
		this.hoveredBin = -1;

		this.createOverlay();
	}

	/**
	 * Create the histogram overlay DOM structure
	 */
	createOverlay() {
		this.overlay = document.createElement('div');
		this.overlay.className = 'histogram-overlay';
		this.overlay.style.display = 'none';

		// Header with controls
		const header = document.createElement('div');
		header.className = 'histogram-header';

		const title = document.createElement('div');
		title.className = 'histogram-title';
		title.textContent = 'Histogram';

		// Scale mode toggle
		const scaleToggle = document.createElement('button');
		scaleToggle.className = 'histogram-button';
		scaleToggle.textContent = 'Sqrt Mode';
		scaleToggle.title = 'Toggle Linear/Sqrt scale';
		scaleToggle.onclick = () => this.toggleScaleMode(scaleToggle);

		// Close button
		const closeBtn = document.createElement('button');
		closeBtn.className = 'histogram-close';
		closeBtn.textContent = '×';
		closeBtn.title = 'Close histogram';
		closeBtn.onclick = () => this.hide();

		header.appendChild(title);
		header.appendChild(scaleToggle);
		header.appendChild(closeBtn);

		// Canvas for histogram
		this.canvas = document.createElement('canvas');
		this.canvas.className = 'histogram-canvas';
		this.canvas.width = 300;
		this.canvas.height = 150;
		this.ctx = this.canvas.getContext('2d');

		// Add mouse event listeners for hover effect
		this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
		this.canvas.addEventListener('mouseleave', () => this.handleMouseLeave());

		// Min/Max labels container
		const labels = document.createElement('div');
		labels.className = 'histogram-labels';
		labels.style.display = 'flex';
		labels.style.justifyContent = 'space-between';
		labels.style.padding = '0 5px';
		labels.style.fontSize = '10px';
		labels.style.color = '#cccccc';
		labels.style.marginTop = '2px';

		this.minLabel = document.createElement('span');
		this.minLabel.textContent = '0';
		this.maxLabel = document.createElement('span');
		this.maxLabel.textContent = '255';

		labels.appendChild(this.minLabel);
		labels.appendChild(this.maxLabel);

		// Stats display
		const stats = document.createElement('div');
		stats.className = 'histogram-stats';
		stats.id = 'histogram-stats';

		// Tooltip
		this.tooltip = document.createElement('div');
		this.tooltip.className = 'histogram-tooltip';
		this.tooltip.style.position = 'absolute';
		this.tooltip.style.display = 'none';
		this.tooltip.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
		this.tooltip.style.color = 'white';
		this.tooltip.style.padding = '4px 8px';
		this.tooltip.style.borderRadius = '4px';
		this.tooltip.style.fontSize = '11px';
		this.tooltip.style.pointerEvents = 'none';
		this.tooltip.style.zIndex = '1000';

		this.overlay.appendChild(header);
		this.overlay.appendChild(this.canvas);
		this.overlay.appendChild(labels);
		this.overlay.appendChild(stats);
		this.overlay.appendChild(this.tooltip);

		// Make draggable
		header.style.cursor = 'move';
		header.onmousedown = (e) => this.startDrag(e);

		document.body.appendChild(this.overlay);

		// Observe theme changes
		this.themeObserver = new MutationObserver(() => {
			this.render();
			this.updateStatsDisplay();
		});
		this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
	}

	/**
	 * Handle mouse move over canvas
	 */
	handleMouseMove(e) {
		if (!this.histogramData) return;

		const rect = this.canvas.getBoundingClientRect();
		const scaleX = this.canvas.width / rect.width;
		const x = (e.clientX - rect.left) * scaleX;
		const width = this.canvas.width;
		const padding = 5;
		const graphWidth = width - 2 * padding;

		// Calculate bin index
		// x = padding + binIndex * binWidth
		// binIndex = (x - padding) / binWidth
		const binWidth = graphWidth / this.numBins;
		let binIndex = Math.floor((x - padding) / binWidth);

		// Clamp bin index
		binIndex = Math.max(0, Math.min(binIndex, this.numBins - 1));

		if (this.hoveredBin !== binIndex) {
			this.hoveredBin = binIndex;
			this.render();
		}

		// Update tooltip
		this.updateTooltip(e.clientX, e.clientY, binIndex);
	}

	/**
	 * Handle mouse leave canvas
	 */
	handleMouseLeave() {
		this.hoveredBin = -1;
		this.tooltip.style.display = 'none';
		this.render();
	}

	/**
	 * Format a value for display based on whether it's float or integer
	 * @param {number} value - The value to format
	 * @param {boolean} isFloat - Whether to format as float
	 * @returns {string} Formatted value
	 */
	formatValue(value, isFloat) {
		if (isFloat) {
			// For float values, use appropriate precision
			if (Math.abs(value) < 0.001 || Math.abs(value) >= 1000) {
				return value.toExponential(2);
			}
			return value.toPrecision(4);
		}
		return Math.round(value).toString();
	}

	/**
	 * Convert bin index to original value
	 * @param {number} binIndex - Bin index (0-255)
	 * @returns {number} Original value
	 */
	binToValue(binIndex) {
		const { min, max } = this.valueRange;
		return min + (binIndex / 255) * (max - min);
	}

	/**
	 * Update tooltip content and position
	 */
	updateTooltip(clientX, clientY, binIndex) {
		if (!this.histogramData || binIndex < 0) return;

		const rCount = this.histogramData.r[binIndex];
		const gCount = this.histogramData.g[binIndex];
		const bCount = this.histogramData.b[binIndex];

		// Clear existing content
		this.tooltip.innerHTML = '';

		// Calculate the value range for this bin
		const { min, max, isFloat } = this.valueRange;
		const totalRange = max - min;
		const binWidth = totalRange / 256;
		const binStart = min + binIndex * binWidth;
		const binEnd = binStart + binWidth;

		const valueDiv = document.createElement('div');
		const valueStrong = document.createElement('strong');
		
		// Check if we have a 1:1 mapping (256 integer values for 256 bins)
		// This is true when: range is 255 (0-255) or 65535 (0-65535) and not float
		const isOneToOne = !isFloat && (totalRange === 255 || totalRange === 256);
		
		if (isFloat) {
			// Float: always show range
			valueStrong.textContent = `Value: ${this.formatValue(binStart, true)} - ${this.formatValue(binEnd, true)}`;
		} else if (isOneToOne) {
			// 1:1 mapping (e.g., uint8 0-255): show single value
			valueStrong.textContent = `Value: ${binIndex + Math.round(min)}`;
		} else {
			// Integer with range mapping: show range
			const startInt = Math.floor(binStart);
			const endInt = Math.floor(binEnd);
			if (startInt === endInt) {
				valueStrong.textContent = `Value: ${startInt}`;
			} else {
				valueStrong.textContent = `Value: ${startInt} - ${endInt}`;
			}
		}
		valueDiv.appendChild(valueStrong);
		this.tooltip.appendChild(valueDiv);

		// Check if image is grayscale (all channels have same count for this bin)
		const isGrayscale = rCount === gCount && gCount === bCount;

		const createRow = (label, count, color) => {
			const div = document.createElement('div');
			const span = document.createElement('span');
			if (color) span.style.color = color;
			span.textContent = `${label}: ${count.toLocaleString()}`;
			div.appendChild(span);
			return div;
		};

		if (isGrayscale) {
			// Grayscale: show single count
			this.tooltip.appendChild(createRow('Count', rCount, null));
		} else {
			// RGB: show separate channel counts
		this.tooltip.appendChild(createRow('R', rCount, '#ff8888'));
		this.tooltip.appendChild(createRow('G', gCount, '#88ff88'));
		this.tooltip.appendChild(createRow('B', bCount, '#8888ff'));
		}

		this.tooltip.style.display = 'block';

		// Position tooltip near mouse but keep within viewport
		const overlayRect = this.overlay.getBoundingClientRect();
		const tooltipX = clientX - overlayRect.left + 10;
		const tooltipY = clientY - overlayRect.top + 10;

		this.tooltip.style.left = `${tooltipX}px`;
		this.tooltip.style.top = `${tooltipY}px`;
	}

	/**
	 * Show the histogram overlay
	 * @param {boolean} [skipNotification=false] - Skip sending visibility notification (used when restoring state)
	 */
	show(skipNotification = false) {
		this.isVisible = true;
		this.overlay.style.display = 'flex';
		// Trigger computation if we have image data
		this.vscode.postMessage({ type: 'requestHistogram' });
		if (!skipNotification) {
			this.vscode.postMessage({ type: 'histogramVisibilityChanged', isVisible: true });
		}
	}

	/**
	 * Hide the histogram overlay
	 * @param {boolean} [skipNotification=false] - Skip sending visibility notification (used when restoring state)
	 */
	hide(skipNotification = false) {
		this.isVisible = false;
		this.overlay.style.display = 'none';
		if (!skipNotification) {
			this.vscode.postMessage({ type: 'histogramVisibilityChanged', isVisible: false });
		}
	}

	/**
	 * Toggle histogram visibility
	 */
	toggle() {
		if (this.isVisible) {
			this.hide();
		} else {
			this.show();
		}
	}

	/**
	 * Toggle between linear and sqrt scale
	 */
	toggleScaleMode(button) {
		const modes = ['linear', 'sqrt'];
		const currentIndex = modes.indexOf(this.scaleMode);
		this.scaleMode = modes[(currentIndex + 1) % modes.length];

		let label = 'Linear';
		if (this.scaleMode === 'sqrt') label = 'Sqrt';

		button.textContent = `${label} Mode`;
		this.render();
		
		// Notify extension of scale mode change for global persistence
		this.vscode.postMessage({
			type: 'histogramScaleModeChanged',
			mode: this.scaleMode
		});
	}

	/**
	 * Generate a Look-Up Table for gamma/brightness transformation.
	 * Maps input values (0-inputMax) to output bins (0-255).
	 * This is the same transformation as NormalizationHelper.generateLut.
	 * @param {Object} settings - Settings with gamma and brightness
	 * @param {number} inputMax - Maximum input value (255, 65535)
	 * @returns {Uint8Array} LUT mapping input -> output bin
	 */
	generateTransformLUT(settings, inputMax) {
		const lutSize = inputMax + 1;
		const lut = new Uint8Array(lutSize);
		
		const gammaIn = settings.gamma?.in ?? 1.0;
		const gammaOut = settings.gamma?.out ?? 1.0;
		const exposureMultiplier = Math.pow(2, settings.brightness?.offset ?? 0);
		const invGammaOut = 1.0 / gammaOut;
		
		for (let i = 0; i < lutSize; i++) {
			const normalized = i / inputMax;
			let linear = Math.pow(normalized, gammaIn);
			linear *= exposureMultiplier;
			const output = Math.pow(Math.max(0, linear), invGammaOut);
			lut[i] = Math.max(0, Math.min(255, (output * 255) | 0));
		}
		
		return lut;
	}

	/**
	 * Generate a 16-bit LUT for float data.
	 * Quantizes float range to 65536 steps and applies gamma/brightness.
	 * @param {Object} settings - Settings with gamma and brightness  
	 * @returns {Uint8Array} LUT mapping quantized float (0-65535) -> output bin (0-255)
	 */
	generateFloatLUT(settings) {
		const lut = new Uint8Array(65536);
		
		const gammaIn = settings.gamma?.in ?? 1.0;
		const gammaOut = settings.gamma?.out ?? 1.0;
		const exposureMultiplier = Math.pow(2, settings.brightness?.offset ?? 0);
		const invGammaOut = 1.0 / gammaOut;
		
		for (let i = 0; i < 65536; i++) {
			const normalized = i / 65535;
			let linear = Math.pow(normalized, gammaIn);
			linear *= exposureMultiplier;
			const output = Math.pow(Math.max(0, linear), invGammaOut);
			lut[i] = Math.max(0, Math.min(255, (output * 255) | 0));
		}
		
		return lut;
	}

	/**
	 * Compute histogram from raw image data.
	 * OPTIMIZED: Uses LUT for integers, TypedArrays, and inlined processing.
	 * Processes ALL pixels (no sampling) for exact results.
	 * 
	 * @param {ImageData} imageData - Canvas ImageData (fallback if no raw data)
	 * @param {Object} options - Raw data and settings
	 */
	computeHistogram(imageData, options = {}) {
		if (!imageData && !options.rawData && !options.planarData) return null;

		const startTime = performance.now();

		// Use TypedArrays for bins (much faster than regular arrays)
		const histR = new Uint32Array(256);
		const histG = new Uint32Array(256);
		const histB = new Uint32Array(256);
		const histLum = new Uint32Array(256);
		let nanCount = 0;

		const settings = options.settings || this.settingsManager.settings;
		const isGammaMode = settings.normalization?.gammaMode || false;
		const isAutoNormalize = settings.normalization?.autoNormalize || false;
		const isFloat = options.isFloat || false;
		const typeMax = options.typeMax ?? (isFloat ? 1.0 : 255);

		// Determine the value range for binning
		let normMin, normMax;
		if (isAutoNormalize && options.stats) {
			normMin = options.stats.min;
			normMax = options.stats.max;
		} else if (isGammaMode) {
			normMin = 0;
			normMax = typeMax;
		} else if (settings.normalization?.min !== undefined && settings.normalization?.max !== undefined) {
			normMin = settings.normalization.min;
			normMax = settings.normalization.max;
		} else {
			normMin = 0;
			normMax = typeMax;
		}

		this.valueRange = { min: normMin, max: normMax, isFloat: isFloat };

		const range = normMax - normMin;
		const invRange = range > 0 ? 1.0 / range : 0;

		const hasRawData = !!(options.rawData || options.planarData);
		let totalPixels = 0;
		if (options.planarData) {
			totalPixels = options.planarData[0].length;
		} else if (options.rawData) {
			totalPixels = options.rawData.length / (options.channels || 3);
		} else if (imageData) {
			totalPixels = imageData.width * imageData.height;
		}

		// Track stats
		let origMinR = Infinity, origMaxR = -Infinity, origSumR = 0, origCountR = 0;
		let origMinG = Infinity, origMaxG = -Infinity, origSumG = 0, origCountG = 0;
		let origMinB = Infinity, origMaxB = -Infinity, origSumB = 0, origCountB = 0;

		// For gamma mode, use LUT for speed (both integer and float)
		let lut = options.lut || null;
		const intTypeMax = typeMax | 0;
		const useIntegerLUT = isGammaMode && !isFloat && hasRawData && (intTypeMax === 255 || intTypeMax === 65535);
		const useFloatLUT = isGammaMode && isFloat && hasRawData;
		
		if (useIntegerLUT && !lut) {
			lut = this.generateTransformLUT(settings, intTypeMax);
		} else if (useFloatLUT && !lut) {
			// For float, use 16-bit quantization LUT (same as image rendering)
			lut = this.generateFloatLUT(settings);
		}
		
		// For float LUT, precompute the quantization scale
		const floatToLutScale = useFloatLUT ? (65535 / range) : 0;

		// Process raw data if available
		if (options.rawData || options.planarData) {
			const { rawData, planarData } = options;
			const channels = options.channels || 3;
			const isGrayscale = channels === 1 || (planarData && planarData.length === 1);

			if (planarData) {
				const len = planarData[0].length;
				const rCh = planarData[0];
				const gCh = planarData.length > 1 ? planarData[1] : rCh;
				const bCh = planarData.length > 2 ? planarData[2] : rCh;

				if (useIntegerLUT) {
					// Fast path: integer data with LUT - process ALL pixels
				for (let i = 0; i < len; i++) {
						const rv = rCh[i], gv = gCh[i], bv = bCh[i];
						if (rv !== rv || gv !== gv || bv !== bv) { nanCount++; continue; }
						
						histR[lut[Math.max(0, Math.min(intTypeMax, rv | 0))]]++;
						histG[lut[Math.max(0, Math.min(intTypeMax, gv | 0))]]++;
						histB[lut[Math.max(0, Math.min(intTypeMax, bv | 0))]]++;
						
						if (rv < origMinR) origMinR = rv;
						if (rv > origMaxR) origMaxR = rv;
						origSumR += rv; origCountR++;
						if (!isGrayscale) {
							if (gv < origMinG) origMinG = gv;
							if (gv > origMaxG) origMaxG = gv;
							origSumG += gv; origCountG++;
							if (bv < origMinB) origMinB = bv;
							if (bv > origMaxB) origMaxB = bv;
							origSumB += bv; origCountB++;
						}
					}
				} else if (useFloatLUT) {
					// Float data with LUT - quantize to 16-bit and lookup
					for (let i = 0; i < len; i++) {
						const rv = rCh[i], gv = gCh[i], bv = bCh[i];
						if (rv !== rv || gv !== gv || bv !== bv) { nanCount++; continue; }
						
						// Quantize to 0-65535 and lookup in LUT
						const rIdx = Math.max(0, Math.min(65535, ((rv - normMin) * floatToLutScale) | 0));
						const gIdx = Math.max(0, Math.min(65535, ((gv - normMin) * floatToLutScale) | 0));
						const bIdx = Math.max(0, Math.min(65535, ((bv - normMin) * floatToLutScale) | 0));
						
						histR[lut[rIdx]]++;
						histG[lut[gIdx]]++;
						histB[lut[bIdx]]++;
						
						if (rv < origMinR) origMinR = rv;
						if (rv > origMaxR) origMaxR = rv;
						origSumR += rv; origCountR++;
						if (!isGrayscale) {
							if (gv < origMinG) origMinG = gv;
							if (gv > origMaxG) origMaxG = gv;
							origSumG += gv; origCountG++;
							if (bv < origMinB) origMinB = bv;
							if (bv > origMaxB) origMaxB = bv;
							origSumB += bv; origCountB++;
						}
				}
			} else {
					// Non-gamma mode (no transformation needed) - process ALL pixels
					for (let i = 0; i < len; i++) {
						const rv = rCh[i], gv = gCh[i], bv = bCh[i];
						if (rv !== rv || gv !== gv || bv !== bv) { nanCount++; continue; }
						
						// Just normalize to 0-255 bins
						const rBin = Math.max(0, Math.min(255, ((rv - normMin) * invRange * 255) | 0));
						const gBin = Math.max(0, Math.min(255, ((gv - normMin) * invRange * 255) | 0));
						const bBin = Math.max(0, Math.min(255, ((bv - normMin) * invRange * 255) | 0));
						
						histR[rBin]++;
						histG[gBin]++;
						histB[bBin]++;
						
						if (rv < origMinR) origMinR = rv;
						if (rv > origMaxR) origMaxR = rv;
						origSumR += rv; origCountR++;
						if (!isGrayscale) {
							if (gv < origMinG) origMinG = gv;
							if (gv > origMaxG) origMaxG = gv;
							origSumG += gv; origCountG++;
							if (bv < origMinB) origMinB = bv;
							if (bv > origMaxB) origMaxB = bv;
							origSumB += bv; origCountB++;
						}
					}
				}
			} else if (rawData) {
				const len = rawData.length;

				if (useIntegerLUT) {
					// Fast path with LUT - process ALL pixels
				for (let i = 0; i < len; i += channels) {
						const rv = rawData[i];
						const gv = channels > 1 ? rawData[i + 1] : rv;
						const bv = channels > 2 ? rawData[i + 2] : rv;
						if (rv !== rv || gv !== gv || bv !== bv) { nanCount++; continue; }
						
						histR[lut[Math.max(0, Math.min(intTypeMax, rv | 0))]]++;
						histG[lut[Math.max(0, Math.min(intTypeMax, gv | 0))]]++;
						histB[lut[Math.max(0, Math.min(intTypeMax, bv | 0))]]++;
						
						if (rv < origMinR) origMinR = rv;
						if (rv > origMaxR) origMaxR = rv;
						origSumR += rv; origCountR++;
						if (channels > 1) {
							if (gv < origMinG) origMinG = gv;
							if (gv > origMaxG) origMaxG = gv;
							origSumG += gv; origCountG++;
							if (channels > 2) {
								if (bv < origMinB) origMinB = bv;
								if (bv > origMaxB) origMaxB = bv;
								origSumB += bv; origCountB++;
							}
				}
			}
				} else if (useFloatLUT) {
					// Float data with LUT - quantize and lookup
					for (let i = 0; i < len; i += channels) {
						const rv = rawData[i];
						const gv = channels > 1 ? rawData[i + 1] : rv;
						const bv = channels > 2 ? rawData[i + 2] : rv;
						if (rv !== rv || gv !== gv || bv !== bv) { nanCount++; continue; }
						
						const rIdx = Math.max(0, Math.min(65535, ((rv - normMin) * floatToLutScale) | 0));
						const gIdx = Math.max(0, Math.min(65535, ((gv - normMin) * floatToLutScale) | 0));
						const bIdx = Math.max(0, Math.min(65535, ((bv - normMin) * floatToLutScale) | 0));
						
						histR[lut[rIdx]]++;
						histG[lut[gIdx]]++;
						histB[lut[bIdx]]++;
						
						if (rv < origMinR) origMinR = rv;
						if (rv > origMaxR) origMaxR = rv;
						origSumR += rv; origCountR++;
						if (channels > 1) {
							if (gv < origMinG) origMinG = gv;
							if (gv > origMaxG) origMaxG = gv;
							origSumG += gv; origCountG++;
							if (channels > 2) {
								if (bv < origMinB) origMinB = bv;
								if (bv > origMaxB) origMaxB = bv;
								origSumB += bv; origCountB++;
							}
						}
					}
				} else {
					// Non-gamma mode - just normalize to bins
					for (let i = 0; i < len; i += channels) {
						const rv = rawData[i];
						const gv = channels > 1 ? rawData[i + 1] : rv;
						const bv = channels > 2 ? rawData[i + 2] : rv;
						if (rv !== rv || gv !== gv || bv !== bv) { nanCount++; continue; }
						
						const rBin = Math.max(0, Math.min(255, ((rv - normMin) * invRange * 255) | 0));
						const gBin = Math.max(0, Math.min(255, ((gv - normMin) * invRange * 255) | 0));
						const bBin = Math.max(0, Math.min(255, ((bv - normMin) * invRange * 255) | 0));
						
						histR[rBin]++;
						histG[gBin]++;
						histB[bBin]++;
						
						if (rv < origMinR) origMinR = rv;
						if (rv > origMaxR) origMaxR = rv;
						origSumR += rv; origCountR++;
						if (channels > 1) {
							if (gv < origMinG) origMinG = gv;
							if (gv > origMaxG) origMaxG = gv;
							origSumG += gv; origCountG++;
							if (channels > 2) {
								if (bv < origMinB) origMinB = bv;
								if (bv > origMaxB) origMaxB = bv;
								origSumB += bv; origCountB++;
							}
						}
					}
				}
			}

			// For grayscale, copy R stats to G and B
			if (isGrayscale) {
				origMinG = origMinB = origMinR;
				origMaxG = origMaxB = origMaxR;
				origSumG = origSumB = origSumR;
				origCountG = origCountB = origCountR;
			}
		} else {
			// Fallback: use 8-bit Canvas ImageData (already transformed)
			this.valueRange = { min: 0, max: 255, isFloat: false };
			const data = imageData.data;
			const len = data.length;
			
			// Process ALL pixels
			for (let i = 0; i < len; i += 4) {
				if (data[i + 3] === 0) continue;
				const rv = data[i], gv = data[i + 1], bv = data[i + 2];
				histR[rv]++; histG[gv]++; histB[bv]++;
				
				if (rv < origMinR) origMinR = rv;
				if (rv > origMaxR) origMaxR = rv;
				origSumR += rv; origCountR++;
				if (gv < origMinG) origMinG = gv;
				if (gv > origMaxG) origMaxG = gv;
				origSumG += gv; origCountG++;
				if (bv < origMinB) origMinB = bv;
				if (bv > origMaxB) origMaxB = bv;
				origSumB += bv; origCountB++;
			}
		}

		// Calculate bin-based stats
		const calculateBinStats = (hist) => {
			let minBin = 0, maxBin = 255, sum = 0, count = 0;
			for (let i = 0; i < 256; i++) {
				if (hist[i] > 0) {
					if (count === 0) minBin = i;
					maxBin = i;
				sum += i * hist[i];
				count += hist[i];
			}
			}
			return { minBin, maxBin, meanBin: count > 0 ? sum / count : 0, total: count };
		};

		// Store original value statistics
		this.originalStats = {
			r: { min: origCountR > 0 ? origMinR : 0, max: origCountR > 0 ? origMaxR : 0, mean: origCountR > 0 ? origSumR / origCountR : 0, total: origCountR },
			g: { min: origCountG > 0 ? origMinG : 0, max: origCountG > 0 ? origMaxG : 0, mean: origCountG > 0 ? origSumG / origCountG : 0, total: origCountG },
			b: { min: origCountB > 0 ? origMinB : 0, max: origCountB > 0 ? origMaxB : 0, mean: origCountB > 0 ? origSumB / origCountB : 0, total: origCountB }
		};

		// Luminance histogram
		const isGrayscale = histR.every((v, i) => v === histG[i] && v === histB[i]);
		if (isGrayscale) {
			histLum.set(histR);
		} else {
			for (let i = 0; i < 256; i++) {
				histLum[i] = Math.round(0.299 * histR[i] + 0.587 * histG[i] + 0.114 * histB[i]);
			}
		}

		console.log(`[Histogram] ${(performance.now() - startTime).toFixed(1)}ms (${totalPixels} pixels)`);

		return {
			r: histR, g: histG, b: histB, luminance: histLum,
			nanCount,
			stats: {
				r: calculateBinStats(histR),
				g: calculateBinStats(histG),
				b: calculateBinStats(histB),
				luminance: calculateBinStats(histLum)
			}
		};
	}

	/**
	 * Update histogram with new data
	 */
	update(imageData, options = {}) {
		this.histogramData = this.computeHistogram(imageData, options);
		if (this.isVisible) {
			this.render();
		}
	}

	/**
	 * Render the histogram to canvas
	 */
	render() {
		if (!this.histogramData || !this.ctx) return;

		const width = this.canvas.width;
		const height = this.canvas.height;
		const padding = 5;
		const graphHeight = height - 2 * padding;
		const graphWidth = width - 2 * padding;

		// Check if dark theme
		const bgColor = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background') || '#1e1e1e';
		let isDarkTheme = true;

		// Simple brightness check
		if (bgColor.startsWith('#')) {
			const r = parseInt(bgColor.substr(1, 2), 16);
			const g = parseInt(bgColor.substr(3, 2), 16);
			const b = parseInt(bgColor.substr(5, 2), 16);
			isDarkTheme = (r + g + b) < 384; // < 128 * 3
		} else if (bgColor.startsWith('rgb')) {
			const rgb = bgColor.match(/\d+/g);
			if (rgb && rgb.length >= 3) {
				isDarkTheme = (parseInt(rgb[0]) + parseInt(rgb[1]) + parseInt(rgb[2])) < 384;
			}
		}

		// Clear canvas
		this.ctx.fillStyle = bgColor;
		this.ctx.fillRect(0, 0, width, height);

		// Always use combined RGB histogram
		const histograms = [this.histogramData.r, this.histogramData.g, this.histogramData.b];
		// Use lighter colors for light theme to avoid "too black" look in multiply mode
		const colors = isDarkTheme
			? ['rgba(255, 100, 100, 0.5)', 'rgba(100, 255, 100, 0.5)', 'rgba(100, 100, 255, 0.5)']
			: ['rgba(255, 180, 180, 0.8)', 'rgba(180, 255, 180, 0.8)', 'rgba(180, 180, 255, 0.8)'];

		// Find max value for scaling
		let maxValue = 0;
		for (const hist of histograms) {
			let channelMax = 0;
			for (let i = 0; i < hist.length; i++) {
				if (hist[i] > channelMax) {
					channelMax = hist[i];
				}
			}
			maxValue = Math.max(maxValue, channelMax);
		}

		// Apply scale
		const scaleValue = (val) => {
			if (this.scaleMode === 'sqrt') {
				return Math.sqrt(val); // Square root
			}
			return val;
		};

		const scaledMax = scaleValue(maxValue);

		// Setup context for styles
		this.ctx.shadowBlur = 0;
		// Use screen for dark theme (additive -> white/grey overlap)
		// Use multiply for light theme (subtractive -> black/grey overlap)
		this.ctx.globalCompositeOperation = isDarkTheme ? 'screen' : 'multiply';

		const binWidth = graphWidth / this.numBins;

		for (let h = 0; h < histograms.length; h++) {
			const hist = histograms[h];
			let color = colors[h];

			// Adjust colors for smooth style
			// Pure RGB for additive blending to work correctly (R+G=Y, R+G+B=W)
			if (h === 0) color = '#ff0000'; // Red
			else if (h === 1) color = '#00ff00'; // Green
			else if (h === 2) color = '#0000ff'; // Blue
			else color = '#888888'; // Luminance

			this.ctx.fillStyle = color;
			this.ctx.strokeStyle = color;
			this.ctx.lineWidth = 2;
			this.ctx.beginPath();

			// Smooth (Curve based)
			this.ctx.moveTo(padding, height - padding); // Start at bottom-left

			// Collect points for smoothing
			const points = [];
			points.push({ x: padding, y: height - padding }); // Start point

			for (let i = 0; i < this.numBins; i++) {
				const x = padding + i * binWidth + (binWidth / 2);
				const scaledValue = scaleValue(hist[i]);
				// Scale to 95% of height as requested
				const barHeight = scaledMax > 0 ? (scaledValue / scaledMax) * graphHeight * 0.95 : 0;
				const y = height - padding - barHeight;
				points.push({ x, y });
			}

			points.push({ x: padding + graphWidth, y: height - padding }); // End point

			// Draw smooth curve using quadratic bezier curves
			if (points.length > 2) {
				this.ctx.moveTo(points[0].x, points[0].y);

				for (let i = 1; i < points.length - 2; i++) {
					const xc = (points[i].x + points[i + 1].x) / 2;
					const yc = (points[i].y + points[i + 1].y) / 2;
					this.ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
				}

				// Curve through the last two points
				this.ctx.quadraticCurveTo(
					points[points.length - 2].x,
					points[points.length - 2].y,
					points[points.length - 1].x,
					points[points.length - 1].y
				);
			} else {
				// Fallback for not enough points
				for (const p of points) {
					this.ctx.lineTo(p.x, p.y);
				}
			}

			this.ctx.lineTo(padding + graphWidth, height - padding); // Ensure closed loop at bottom right
			this.ctx.lineTo(padding, height - padding); // Ensure closed loop at bottom left
			this.ctx.closePath();

			// Smooth mode (normal blending)
			this.ctx.fill();
			this.ctx.stroke();
		}

		// Reset context effects
		this.ctx.shadowBlur = 0;
		this.ctx.globalCompositeOperation = 'source-over';

		// Highlight hovered bin
		if (this.hoveredBin >= 0 && this.hoveredBin < this.numBins) {
			const x = padding + this.hoveredBin * binWidth;

			// Draw a brighter highlight over the hovered bin
			this.ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
			this.ctx.fillRect(x, padding, Math.max(1, binWidth - 0.5), graphHeight);

			// Draw a vertical line indicator
			this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
			this.ctx.lineWidth = 1;
			this.ctx.beginPath();
			this.ctx.moveTo(x + binWidth / 2, padding);
			this.ctx.lineTo(x + binWidth / 2, height - padding);
			this.ctx.stroke();
		}

		// Update stats display
		this.updateStatsDisplay();
	}

	/**
	 * Update statistics display - shows stats in original value units
	 */
	updateStatsDisplay() {
		if (!this.histogramData) return;

		const statsEl = document.getElementById('histogram-stats');
		if (!statsEl) return;

		// Use original value stats if available, otherwise fall back to bin stats
		const origStats = this.originalStats;
		const { isFloat } = this.valueRange;

		// Check if image is grayscale (all channels have same stats)
		const isGrayscale = origStats && 
			Math.abs(origStats.r.min - origStats.g.min) < 0.001 && 
			Math.abs(origStats.g.min - origStats.b.min) < 0.001 &&
			Math.abs(origStats.r.max - origStats.g.max) < 0.001 && 
			Math.abs(origStats.g.max - origStats.b.max) < 0.001;

		// Clear existing content
		statsEl.innerHTML = '';

		// Helper to format stat values
		const formatStat = (value) => {
			if (isFloat) {
				if (Math.abs(value) < 0.001 || Math.abs(value) >= 10000) {
					return value.toExponential(2);
				}
				return value.toPrecision(4);
			}
			return Math.round(value).toString();
		};

		// For grayscale images, show single channel stats, otherwise show RGB
		if (isGrayscale && origStats) {
			const s = origStats.r;

			const createSpan = (text) => {
				const span = document.createElement('span');
				span.textContent = text;
				return span;
			};

			statsEl.appendChild(createSpan(`Min: ${formatStat(s.min)}`));
			statsEl.appendChild(createSpan(`Max: ${formatStat(s.max)}`));
			statsEl.appendChild(createSpan(`Mean: ${formatStat(s.mean)}`));
		} else if (origStats) {
			// Show RGB stats in original values
			const createStatSpan = (label, stat, color) => {
				const span = document.createElement('span');
				span.style.color = color;
				span.textContent = `${label}: ${formatStat(stat.min)}-${formatStat(stat.max)} (μ=${formatStat(stat.mean)})`;
				return span;
			};

			statsEl.appendChild(createStatSpan('R', origStats.r, '#ff6666'));
			statsEl.appendChild(createStatSpan('G', origStats.g, '#66ff66'));
			statsEl.appendChild(createStatSpan('B', origStats.b, '#6666ff'));
		} else {
			// Fallback to bin-based stats (when no raw data available)
			const stats = this.histogramData.stats;
			const createStatSpan = (label, stat, color) => {
				const span = document.createElement('span');
				span.style.color = color;
				span.textContent = `${label}: ${stat.minBin}-${stat.maxBin}`;
				return span;
			};

			statsEl.appendChild(createStatSpan('R', stats.r, '#ff6666'));
			statsEl.appendChild(createStatSpan('G', stats.g, '#66ff66'));
			statsEl.appendChild(createStatSpan('B', stats.b, '#6666ff'));
		}

		// Show NaN count if present
		if (this.histogramData.nanCount > 0) {
			const nanSpan = document.createElement('span');
			nanSpan.style.color = '#ffcc00';
			nanSpan.style.marginLeft = '10px';
			nanSpan.textContent = `NaN: ${this.histogramData.nanCount.toLocaleString()}`;
			statsEl.appendChild(nanSpan);
		}

		// Update picker background and position
		const bgColor = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background') || '#1e1e1e';
		let isDarkTheme = true;
		if (bgColor.startsWith('#')) {
			const r = parseInt(bgColor.substr(1, 2), 16);
			const g = parseInt(bgColor.substr(3, 2), 16);
			const b = parseInt(bgColor.substr(5, 2), 16);
			isDarkTheme = (r + g + b) < 384;
		} else if (bgColor.startsWith('rgb')) {
			const rgb = bgColor.match(/\d+/g);
			if (rgb && rgb.length >= 3) {
				isDarkTheme = (parseInt(rgb[0]) + parseInt(rgb[1]) + parseInt(rgb[2])) < 384;
			}
		}

		// Set background color based on theme
		statsEl.style.backgroundColor = isDarkTheme ? 'rgba(0, 0, 0, 0.8)' : 'rgba(255, 255, 255, 0.8)';
		statsEl.style.color = isDarkTheme ? '#ffffff' : '#000000';

		// Smart positioning
		const overlayRect = this.overlay.getBoundingClientRect();
		const windowWidth = window.innerWidth;

		// If close to right edge, move to left
		if (overlayRect.right > windowWidth - 200) { // Increased threshold
			statsEl.style.left = 'auto';
			statsEl.style.right = '100%';
			statsEl.style.marginRight = '10px';
			statsEl.style.marginLeft = '0';
		} else {
			statsEl.style.right = 'auto';
			statsEl.style.left = '100%';
			statsEl.style.marginLeft = '10px';
			statsEl.style.marginRight = '0';
		}

		// Update min/max labels at bottom of histogram
		this.updateRangeLabels();
	}

	/**
	 * Update the min/max labels below the histogram to show actual value range
	 */
	updateRangeLabels() {
		if (!this.minLabel || !this.maxLabel) return;

		const { min, max, isFloat } = this.valueRange;

		if (isFloat) {
			// For float, show with appropriate precision
			if (Math.abs(min) < 0.001 && Math.abs(max) < 10) {
				this.minLabel.textContent = min.toPrecision(3);
				this.maxLabel.textContent = max.toPrecision(3);
			} else if (Math.abs(max) >= 10000 || Math.abs(min) >= 10000) {
				this.minLabel.textContent = min.toExponential(1);
				this.maxLabel.textContent = max.toExponential(1);
			} else {
				this.minLabel.textContent = min.toPrecision(4);
				this.maxLabel.textContent = max.toPrecision(4);
			}
		} else {
			// For integers, show as integers
			this.minLabel.textContent = Math.round(min).toString();
			this.maxLabel.textContent = Math.round(max).toString();
		}
	}

	/**
	 * Start dragging the overlay
	 */
	startDrag(e) {
		const rect = this.overlay.getBoundingClientRect();
		this.isDragging = true;
		this.dragOffset = {
			x: e.clientX - rect.left,
			y: e.clientY - rect.top
		};

		const onMouseMove = (e) => {
			if (!this.isDragging) return;

			const x = e.clientX - this.dragOffset.x;
			const y = e.clientY - this.dragOffset.y;

			// Keep within viewport bounds
			const maxX = window.innerWidth - this.overlay.offsetWidth;
			const maxY = window.innerHeight - this.overlay.offsetHeight;

			this.overlay.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
			this.overlay.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
			this.overlay.style.right = 'auto';
			this.overlay.style.bottom = 'auto';
		};

		const onMouseUp = () => {
			this.isDragging = false;
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
			
			// Notify extension of position change for global persistence
			const position = this.getPosition();
			if (position) {
				this.vscode.postMessage({
					type: 'histogramPositionChanged',
					position: position
				});
			}
		};

		document.addEventListener('mousemove', onMouseMove);
		document.addEventListener('mouseup', onMouseUp);

		e.preventDefault();
	}

	/**
	 * Get current visibility state
	 */
	getVisibility() {
		return this.isVisible;
	}

	/**
	 * Set the position of the histogram overlay
	 * @param {number} left - Left position in pixels
	 * @param {number} top - Top position in pixels
	 */
	setPosition(left, top) {
		if (this.overlay) {
			this.overlay.style.left = `${left}px`;
			this.overlay.style.top = `${top}px`;
			this.overlay.style.right = 'auto';
			this.overlay.style.bottom = 'auto';
		}
	}

	/**
	 * Get the current position of the histogram overlay
	 * @returns {{left: number, top: number} | null}
	 */
	getPosition() {
		if (this.overlay) {
			const rect = this.overlay.getBoundingClientRect();
			return { left: rect.left, top: rect.top };
		}
		return null;
	}

	/**
	 * Set the scale mode (linear or sqrt)
	 * @param {'linear' | 'sqrt'} mode
	 */
	setScaleMode(mode) {
		if (mode === 'linear' || mode === 'sqrt') {
			this.scaleMode = mode;
			// Update button text
			const button = this.overlay?.querySelector('.histogram-button');
			if (button) {
				button.textContent = mode === 'sqrt' ? 'Sqrt Mode' : 'Linear Mode';
			}
			this.render();
		}
	}

	/**
	 * Get the current scale mode
	 * @returns {'linear' | 'sqrt'}
	 */
	getScaleMode() {
		return this.scaleMode;
	}
}

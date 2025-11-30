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
	 * Update tooltip content and position
	 */
	updateTooltip(clientX, clientY, binIndex) {
		if (!this.histogramData || binIndex < 0) return;

		const rCount = this.histogramData.r[binIndex];
		const gCount = this.histogramData.g[binIndex];
		const bCount = this.histogramData.b[binIndex];
		const lumCount = this.histogramData.luminance[binIndex];

		// Clear existing content
		this.tooltip.innerHTML = '';

		const valueDiv = document.createElement('div');
		const valueStrong = document.createElement('strong');
		valueStrong.textContent = `Value: ${binIndex}`;
		valueDiv.appendChild(valueStrong);
		this.tooltip.appendChild(valueDiv);

		// Always show RGB channels
		const createRow = (label, count, color) => {
			const div = document.createElement('div');
			const span = document.createElement('span');
			span.style.color = color;
			span.textContent = `${label}: ${count.toLocaleString()}`;
			div.appendChild(span);
			return div;
		};

		this.tooltip.appendChild(createRow('R', rCount, '#ff8888'));
		this.tooltip.appendChild(createRow('G', gCount, '#88ff88'));
		this.tooltip.appendChild(createRow('B', bCount, '#8888ff'));

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
	 */
	show() {
		this.isVisible = true;
		this.overlay.style.display = 'flex';
		// Trigger computation if we have image data
		this.vscode.postMessage({ type: 'requestHistogram' });
	}

	/**
	 * Hide the histogram overlay
	 */
	hide() {
		this.isVisible = false;
		this.overlay.style.display = 'none';
		this.vscode.postMessage({ type: 'histogramClosed' });
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
	}

	/**
	 * Compute histogram from image data or raw data
	 * @param {ImageData} imageData - Canvas ImageData object
	 * @param {Object} options - Optional settings (rawData, format, normalization)
	 */
	computeHistogram(imageData, options = {}) {
		if (!imageData && !options.rawData) return null;

		// Initialize bins
		const histR = new Array(this.numBins).fill(0);
		const histG = new Array(this.numBins).fill(0);
		const histB = new Array(this.numBins).fill(0);
		const histLum = new Array(this.numBins).fill(0);
		let nanCount = 0;

		// Helper to add value to histogram
		const addToHist = (r, g, b) => {
			// Check for NaN
			if (isNaN(r) || isNaN(g) || isNaN(b)) {
				nanCount++;
				return;
			}

			// Clamp to 0-255 for binning
			const binR = Math.max(0, Math.min(255, Math.floor(r)));
			const binG = Math.max(0, Math.min(255, Math.floor(g)));
			const binB = Math.max(0, Math.min(255, Math.floor(b)));

			histR[binR]++;
			histG[binG]++;
			histB[binB]++;

			const lum = Math.floor(0.299 * r + 0.587 * g + 0.114 * b);
			const binLum = Math.max(0, Math.min(255, lum));
			histLum[binLum]++;
		};

		if (options.rawData || options.planarData) {
			// Use raw data (interleaved or planar)
			const { rawData, planarData, format, normalization } = options;
			const channels = options.channels || 3;

			// If we have normalization, use it to map values to 0-255
			const min = normalization?.min ?? 0;
			const max = normalization?.max ?? (format === 'uint16' ? 65535 : (format === 'uint8' ? 255 : 1));
			const range = max - min;
			const scale = range > 0 ? 255 / range : 0;

			if (planarData) {
				// Planar data (e.g. from TIFF rasters: [R[], G[], B[]])
				const len = planarData[0].length;
				// Ensure we have enough channels
				const rCh = planarData[0];
				const gCh = planarData.length > 1 ? planarData[1] : planarData[0];
				const bCh = planarData.length > 2 ? planarData[2] : planarData[0];

				for (let i = 0; i < len; i++) {
					let r = rCh[i];
					let g = gCh[i];
					let b = bCh[i];

					// Apply normalization
					r = (r - min) * scale;
					g = (g - min) * scale;
					b = (b - min) * scale;

					addToHist(r, g, b);
				}
			} else {
				// Interleaved raw data
				const len = rawData.length;
				for (let i = 0; i < len; i += channels) {
					let r = rawData[i];
					let g = channels > 1 ? rawData[i + 1] : r;
					let b = channels > 2 ? rawData[i + 2] : r;

					// Apply normalization
					r = (r - min) * scale;
					g = (g - min) * scale;
					b = (b - min) * scale;

					addToHist(r, g, b);
				}
			}
		} else {
			// Use 8-bit Canvas ImageData
			const data = imageData.data;
			for (let i = 0; i < data.length; i += 4) {
				// Skip fully transparent pixels
				if (data[i + 3] === 0) continue;
				addToHist(data[i], data[i + 1], data[i + 2]);
			}
		}

		// Calculate stats
		const calculateStats = (hist) => {
			let min = 0;
			let max = 255;
			let sum = 0;
			let count = 0;

			// Find min
			for (let i = 0; i < this.numBins; i++) {
				if (hist[i] > 0) {
					min = i;
					break;
				}
			}

			// Find max
			for (let i = this.numBins - 1; i >= 0; i--) {
				if (hist[i] > 0) {
					max = i;
					break;
				}
			}

			// Calculate mean
			for (let i = 0; i < this.numBins; i++) {
				sum += i * hist[i];
				count += hist[i];
			}

			return {
				min,
				max,
				mean: count > 0 ? sum / count : 0,
				total: count
			};
		};

		return {
			r: histR,
			g: histG,
			b: histB,
			luminance: histLum,
			nanCount,
			stats: {
				r: calculateStats(histR),
				g: calculateStats(histG),
				b: calculateStats(histB),
				luminance: calculateStats(histLum)
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
	 * Update statistics display
	 */
	updateStatsDisplay() {
		if (!this.histogramData) return;

		const statsEl = document.getElementById('histogram-stats');
		if (!statsEl) return;

		const stats = this.histogramData.stats;

		// Check if image is grayscale (all channels equal)
		const isGrayscale = stats.r.min === stats.g.min && stats.g.min === stats.b.min &&
			stats.r.max === stats.g.max && stats.g.max === stats.b.max;

		// Clear existing content
		statsEl.innerHTML = '';

		// For grayscale images, show single channel stats, otherwise show RGB
		if (isGrayscale) {
			// Show single channel stats
			const s = stats.r;

			const createSpan = (text) => {
				const span = document.createElement('span');
				span.textContent = text;
				return span;
			};

			statsEl.appendChild(createSpan(`Min: ${s.min}`));
			statsEl.appendChild(createSpan(`Max: ${s.max}`));
			statsEl.appendChild(createSpan(`Mean: ${s.mean.toFixed(1)}`));
		} else {
			// Show RGB stats
			const createStatSpan = (label, stat, color) => {
				const span = document.createElement('span');
				span.style.color = color;
				span.textContent = `${label}: ${stat.min}-${stat.max} (${stat.mean.toFixed(0)})`;
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
			nanSpan.textContent = `NaN: ${this.histogramData.nanCount}`;
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
}

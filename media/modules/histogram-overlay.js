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
		this.scaleMode = 'linear'; // 'linear' or 'log'
		this.channelMode = 'combined'; // 'combined', 'separate', or 'luminance'

		// Histogram computation settings
		this.numBins = 256;

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
		scaleToggle.textContent = 'Linear Mode';
		scaleToggle.title = 'Toggle Linear/Log scale';
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

		let content = `<strong>Value: ${binIndex}</strong><br>`;

		if (this.channelMode === 'combined' || this.channelMode === 'separate') {
			content += `<span style="color: #ff8888">R: ${rCount.toLocaleString()}</span><br>`;
			content += `<span style="color: #88ff88">G: ${gCount.toLocaleString()}</span><br>`;
			content += `<span style="color: #8888ff">B: ${bCount.toLocaleString()}</span>`;
		} else {
			content += `Count: ${lumCount.toLocaleString()}`;
		}

		this.tooltip.innerHTML = content;
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
	 * Toggle between linear and log scale
	 */
	toggleScaleMode(button) {
		this.scaleMode = this.scaleMode === 'linear' ? 'log' : 'linear';
		button.textContent = this.scaleMode === 'linear' ? 'Linear Mode' : 'Log Mode';
		this.render();
	}

	/**
	 * Compute histogram from image data
	 * @param {ImageData} imageData - Canvas ImageData object
	 */
	computeHistogram(imageData) {
		if (!imageData) return null;

		const data = imageData.data;
		const width = imageData.width;
		const height = imageData.height;
		const numPixels = width * height;

		// Initialize bins
		const histR = new Array(this.numBins).fill(0);
		const histG = new Array(this.numBins).fill(0);
		const histB = new Array(this.numBins).fill(0);
		const histLum = new Array(this.numBins).fill(0);

		// Compute histogram
		for (let i = 0; i < data.length; i += 4) {
			const r = data[i];
			const g = data[i + 1];
			const b = data[i + 2];
			const a = data[i + 3];

			// Skip fully transparent pixels
			if (a === 0) continue;

			histR[r]++;
			histG[g]++;
			histB[b]++;

			// Compute luminance (standard weights for RGB)
			const lum = Math.floor(0.299 * r + 0.587 * g + 0.114 * b);
			histLum[lum]++;
		}

		// Compute statistics
		const stats = this.computeStats(data);

		return {
			r: histR,
			g: histG,
			b: histB,
			luminance: histLum,
			stats: stats,
			numPixels: numPixels
		};
	}

	/**
	 * Compute statistics from raw pixel data
	 */
	computeStats(data) {
		let minR = 255, maxR = 0, sumR = 0;
		let minG = 255, maxG = 0, sumG = 0;
		let minB = 255, maxB = 0, sumB = 0;
		let count = 0;

		for (let i = 0; i < data.length; i += 4) {
			const a = data[i + 3];
			if (a === 0) continue; // Skip transparent pixels

			const r = data[i];
			const g = data[i + 1];
			const b = data[i + 2];

			minR = Math.min(minR, r);
			maxR = Math.max(maxR, r);
			sumR += r;

			minG = Math.min(minG, g);
			maxG = Math.max(maxG, g);
			sumG += g;

			minB = Math.min(minB, b);
			maxB = Math.max(maxB, b);
			sumB += b;

			count++;
		}

		return {
			r: { min: minR, max: maxR, mean: sumR / count },
			g: { min: minG, max: maxG, mean: sumG / count },
			b: { min: minB, max: maxB, mean: sumB / count }
		};
	}

	/**
	 * Update histogram with new data
	 */
	update(imageData) {
		this.histogramData = this.computeHistogram(imageData);
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

		// Clear canvas
		this.ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background') || '#1e1e1e';
		this.ctx.fillRect(0, 0, width, height);

		// Determine which histogram to draw
		let histograms = [];
		let colors = [];

		if (this.channelMode === 'combined') {
			// Combined RGB histogram
			histograms = [this.histogramData.r, this.histogramData.g, this.histogramData.b];
			colors = ['rgba(255, 100, 100, 0.5)', 'rgba(100, 255, 100, 0.5)', 'rgba(100, 100, 255, 0.5)'];
		} else if (this.channelMode === 'separate') {
			// Separate RGB histograms (stacked)
			histograms = [this.histogramData.r, this.histogramData.g, this.histogramData.b];
			colors = ['rgba(255, 50, 50, 0.7)', 'rgba(50, 255, 50, 0.7)', 'rgba(50, 50, 255, 0.7)'];
		} else {
			// Luminance only
			histograms = [this.histogramData.luminance];
			colors = ['rgba(200, 200, 200, 0.8)'];
		}

		// Find max value for scaling
		let maxValue = 0;
		for (const hist of histograms) {
			for (let i = 0; i < hist.length; i++) {
				maxValue = Math.max(maxValue, hist[i]);
			}
		}

		// Apply log scale if needed
		const scaleValue = (val) => {
			if (this.scaleMode === 'log') {
				return val > 0 ? Math.log10(val + 1) : 0;
			}
			return val;
		};

		const scaledMax = scaleValue(maxValue);

		// Draw histograms
		const binWidth = graphWidth / this.numBins;

		for (let h = 0; h < histograms.length; h++) {
			const hist = histograms[h];
			const color = colors[h];

			this.ctx.fillStyle = color;
			this.ctx.beginPath();

			for (let i = 0; i < this.numBins; i++) {
				const x = padding + i * binWidth;
				const scaledValue = scaleValue(hist[i]);
				const barHeight = scaledMax > 0 ? (scaledValue / scaledMax) * graphHeight : 0;
				const y = height - padding - barHeight;

				this.ctx.fillRect(x, y, Math.max(1, binWidth - 0.5), barHeight);
			}
		}

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

		// Draw border
		this.ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--vscode-panel-border') || '#454545';
		this.ctx.lineWidth = 1;
		this.ctx.strokeRect(padding, padding, graphWidth, graphHeight);

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

		if (isGrayscale || this.channelMode === 'luminance') {
			// Show single channel stats
			const s = stats.r;
			statsEl.innerHTML = `
				<span>Min: ${s.min}</span>
				<span>Max: ${s.max}</span>
				<span>Mean: ${s.mean.toFixed(1)}</span>
			`;
		} else {
			// Show RGB stats
			statsEl.innerHTML = `
				<span style="color: #ff6666;">R: ${stats.r.min}-${stats.r.max} (${stats.r.mean.toFixed(0)})</span>
				<span style="color: #66ff66;">G: ${stats.g.min}-${stats.g.max} (${stats.g.mean.toFixed(0)})</span>
				<span style="color: #6666ff;">B: ${stats.b.min}-${stats.b.max} (${stats.b.mean.toFixed(0)})</span>
			`;
		}
	}

	/**
	 * Start dragging the overlay
	 */
	startDrag(e) {
		this.isDragging = true;
		const rect = this.overlay.getBoundingClientRect();
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

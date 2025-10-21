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
		scaleToggle.textContent = 'Lin';
		scaleToggle.title = 'Toggle Linear/Log scale';
		scaleToggle.onclick = () => this.toggleScaleMode(scaleToggle);

		// Channel mode toggle (for RGB images)
		const channelToggle = document.createElement('button');
		channelToggle.className = 'histogram-button';
		channelToggle.id = 'histogram-channel-toggle';
		channelToggle.textContent = 'All';
		channelToggle.title = 'Toggle channel display mode';
		channelToggle.onclick = () => this.toggleChannelMode(channelToggle);

		// Close button
		const closeBtn = document.createElement('button');
		closeBtn.className = 'histogram-close';
		closeBtn.textContent = '×';
		closeBtn.title = 'Close histogram';
		closeBtn.onclick = () => this.hide();

		header.appendChild(title);
		header.appendChild(scaleToggle);
		header.appendChild(channelToggle);
		header.appendChild(closeBtn);

		// Canvas for histogram
		this.canvas = document.createElement('canvas');
		this.canvas.className = 'histogram-canvas';
		this.canvas.width = 300;
		this.canvas.height = 150;
		this.ctx = this.canvas.getContext('2d');

		// Stats display
		const stats = document.createElement('div');
		stats.className = 'histogram-stats';
		stats.id = 'histogram-stats';

		this.overlay.appendChild(header);
		this.overlay.appendChild(this.canvas);
		this.overlay.appendChild(stats);

		// Make draggable
		header.style.cursor = 'move';
		header.onmousedown = (e) => this.startDrag(e);

		document.body.appendChild(this.overlay);
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
		button.textContent = this.scaleMode === 'linear' ? 'Lin' : 'Log';
		this.render();
	}

	/**
	 * Toggle between channel display modes
	 */
	toggleChannelMode(button) {
		const modes = ['combined', 'separate', 'luminance'];
		const currentIndex = modes.indexOf(this.channelMode);
		const nextIndex = (currentIndex + 1) % modes.length;
		this.channelMode = modes[nextIndex];

		const labels = { 'combined': 'All', 'separate': 'RGB', 'luminance': 'Lum' };
		button.textContent = labels[this.channelMode];

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

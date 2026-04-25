// @ts-check
"use strict";

import { SettingsManager } from './modules/settings-manager.js';
import { TiffProcessor } from './modules/tiff-processor.js';
import { ExrProcessor } from './modules/exr-processor.js';
import { NpyProcessor } from './modules/npy-processor.js';
import { PfmProcessor } from './modules/pfm-processor.js';
import { PpmProcessor } from './modules/ppm-processor.js';
import { PngProcessor } from './modules/png-processor.js';
import { HdrProcessor } from './modules/hdr-processor.js';
import { TgaProcessor } from './modules/tga-processor.js';
import { WebImageProcessor } from './modules/web-image-processor.js';
import { JxlProcessor } from './modules/jxl-processor.js';
import { RawProcessor } from './modules/raw-processor.js';
import { ZoomController } from './modules/zoom-controller.js';
import { MouseHandler } from './modules/mouse-handler.js';
import { HistogramOverlay } from './modules/histogram-overlay.js';
import { ColormapConverter } from './modules/colormap-converter.js';

/**
 * Main Image Preview Application
 * Orchestrates all modules to provide image viewing functionality
 */
(function () {
	/**
	 * @typedef {{parametersOnly: boolean, changedMasks: boolean, changedStructure: boolean}} SettingsChanges
	 * @typedef {{relativeX: number, relativeY: number, sourceWidth: number, sourceHeight: number, scale: number|string}} CopiedPosition
	 * @typedef {{colormapName: string, minValue: number, maxValue: number, inverted: boolean, logarithmic: boolean}} ColormapConversionState
	 * @typedef {{width?: number, height?: number, samplesPerPixel?: number, bitsPerSample?: number, sampleFormat?: number, formatType?: string, [key: string]: any}} FormatInfo
	 */

	// @ts-ignore
	const originalVscode = acquireVsCodeApi();

	// Format info tracking for context menu
	/** @type {FormatInfo|null} */
	let currentFormatInfo = null;

	// Wrap vscode.postMessage to track formatInfo
	const vscode = {
		/** @param {{type: string, [key: string]: any}} message */
		postMessage: (message) => {
			// Track formatInfo when it's sent
			if (message.type === 'formatInfo' && message.value) {
				currentFormatInfo = message.value;
			}
			return originalVscode.postMessage(message);
		},
		setState: originalVscode.setState,
		getState: originalVscode.getState
	};

	// Initialize all modules
	const settingsManager = new SettingsManager();
	const tiffProcessor = new TiffProcessor(settingsManager, vscode);
	const exrProcessor = new ExrProcessor(settingsManager, vscode);
	const zoomController = new ZoomController(settingsManager, vscode);
	const mouseHandler = new MouseHandler(settingsManager, vscode, tiffProcessor);
	const npyProcessor = new NpyProcessor(settingsManager, vscode);
	const pfmProcessor = new PfmProcessor(settingsManager, vscode);
	const ppmProcessor = new PpmProcessor(settingsManager, vscode);
	const pngProcessor = new PngProcessor(settingsManager, vscode);
	const hdrProcessor = new HdrProcessor(settingsManager, vscode);
	const tgaProcessor = new TgaProcessor(settingsManager, vscode);
	const webImageProcessor = new WebImageProcessor(settingsManager, vscode);
	const jxlProcessor = new JxlProcessor(settingsManager, vscode);
	const rawProcessor = new RawProcessor(settingsManager, vscode);
	const histogramOverlay = new HistogramOverlay(settingsManager, vscode);
	const colormapConverter = new ColormapConverter();
	mouseHandler.setNpyProcessor(npyProcessor);
	mouseHandler.setPfmProcessor(pfmProcessor);
	mouseHandler.setPpmProcessor(ppmProcessor);
	mouseHandler.setPngProcessor(pngProcessor);
	mouseHandler.setHdrProcessor(hdrProcessor);
	mouseHandler.setTgaProcessor(tgaProcessor);
	mouseHandler.setWebImageProcessor(webImageProcessor);
	mouseHandler.setJxlProcessor(jxlProcessor);
	mouseHandler.setRawProcessor(rawProcessor);
	mouseHandler.setExrProcessor(exrProcessor);

	/** Camera RAW file extensions supported by RawProcessor */
	const RAW_EXTENSIONS = ['.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.rw2', '.orf', '.pef', '.srw', '.3fr', '.rwl', '.nrw', '.raw'];
	/** @param {string} lower @returns {boolean} */
	const isRawExtension = (lower) => RAW_EXTENSIONS.some(ext => lower.endsWith(ext));

	// Application state
	let hasLoadedImage = false;
	/** @type {HTMLCanvasElement|null} */
	let canvas = null;
	/** @type {HTMLCanvasElement|null} */
	let imageElement = null;
	/** @type {ImageData|null} */
	let primaryImageData = null;
	/** @type {ImageData|null} */
	let peerImageData = null;
	/** @type {any} */
	let peerRawTiffData = null;      // Raw TIFF data for peer image (kept separate from primary)
	/** @type {any} */
	let peerLastStatistics = null;   // Statistics for peer TIFF image
	/** @type {any} */
	let peerRawExrData = null;       // Raw EXR data for peer image
	/** @type {any} */
	let peerExrStats = null;         // Cached stats for peer EXR image
	/** @type {string[]} */
	let peerImageUris = []; // Track peer URIs for comparison state
	/** @type {{scale: number|string, [key: string]: any}|null} */
	let _pendingZoomState = null; // Zoom state to restore after next image load
	let _loadGeneration = 0;     // Incremented on every switchToNewImage; stale loads bail out
	let isShowingPeer = false;
	let initialLoadStartTime = 0;
	let extensionLoadStartTime = 0; // Time when extension started loading (from settings)
	let currentLoadFormat = '';

	// Colormap conversion state
	/** @type {ColormapConversionState|null} */
	let colormapConversionState = null;

	// Original image state (for reverting from conversions)
	/** @type {ImageData|null} */
	let originalImageData = null;
	let hasAppliedConversion = false;

	// Copied position state (for paste position feature)
	// Stores position as relative coordinates (0-1) for cross-resolution compatibility
	/** @type {CopiedPosition|null} */
	let copiedPositionState = null;

	// Restore persisted state if available
	const persistedState = vscode.getState();
	if (persistedState) {
		peerImageUris = persistedState.peerImageUris || [];
		isShowingPeer = persistedState.isShowingPeer || false;
		colormapConversionState = persistedState.colormapConversionState || null;
		// Note: Histogram visibility is now managed globally by the extension
		// and restored via restoreHistogramState message when webview becomes active
	}

	// Image collection state
	let imageCollection = {
		totalImages: 1,
		currentIndex: 0,
		show: false
	};
	/** @type {HTMLElement | null} */
	let overlayElement = null;
	/** @type {HTMLElement | null} */
	let filenameBadge = null;
	/** @type {HTMLInputElement | null} */
	let activeCounterInput = null;

	/**
	 * Save current state to VS Code webview state for persistence across tab switches
	 */
	function saveState() {
		// Only save serializable state (no ImageData/Canvas objects)
		const zoomState = zoomController.getCurrentState();
		const state = {
			peerImageUris: peerImageUris,
			isShowingPeer: isShowingPeer,
			currentResourceUri: settingsManager.settings.resourceUri,
			colormapConversionState: colormapConversionState,
			isHistogramVisible: histogramOverlay.getVisibility(),
			// Include zoom so it isn't erased when the app-level state is written
			scale: zoomState.scale,
			offsetX: zoomState.x,
			offsetY: zoomState.y,
			timestamp: Date.now()
		};
		vscode.setState(state);
	}

	// DOM elements
	const container = document.body;
	const image = document.createElement('img');

	/**
	 * Initialize the application
	 */
	function initialize() {
		initialLoadStartTime = performance.now();
		// Get the extension start time from settings (for total elapsed measurement)
		extensionLoadStartTime = settingsManager.settings.loadStartTime || 0;
		setupImageLoading();
		setupMessageHandling();
		setupEventListeners();
		createImageCollectionOverlay();
	createFilenameBadge();

		// Save state when webview might be disposed
		window.addEventListener('beforeunload', saveState);
		window.addEventListener('pagehide', saveState);

		// Start loading the image
		const settings = settingsManager.settings;
		const resourceUri = settings.resourceUri ?? '';

		// Load image based on file extension
		const src = settings.src ?? '';
		if (resourceUri.toLowerCase().endsWith('.tif') || resourceUri.toLowerCase().endsWith('.tiff')) {
			handleTiff(src);
		} else if (resourceUri.toLowerCase().endsWith('.exr')) {
			handleExr(src);
		} else if (resourceUri.toLowerCase().endsWith('.pfm')) {
			handlePfm(src);
		} else if (resourceUri.toLowerCase().endsWith('.ppm') || resourceUri.toLowerCase().endsWith('.pgm') || resourceUri.toLowerCase().endsWith('.pbm')) {
			handlePpm(src);
		} else if (resourceUri.toLowerCase().endsWith('.png') || resourceUri.toLowerCase().endsWith('.jpg') || resourceUri.toLowerCase().endsWith('.jpeg')) {
			handlePng(src);
		} else if (resourceUri.toLowerCase().endsWith('.npy') || resourceUri.toLowerCase().endsWith('.npz')) {
			handleNpy(src);
		} else if (resourceUri.toLowerCase().endsWith('.hdr')) {
			handleHdr(src);
		} else if (resourceUri.toLowerCase().endsWith('.tga')) {
			handleTga(src);
		} else if (resourceUri.toLowerCase().match(/\.(webp|avif|bmp|ico)$/)) {
			handleWebImage(src);
		} else if (resourceUri.toLowerCase().endsWith('.jxl')) {
			handleJxl(src);
		} else if (isRawExtension(resourceUri.toLowerCase())) {
			handleRaw(src);
		} else {
			image.src = src;
		}

		// Restore comparison state if we have peer images
		if (peerImageUris.length > 0) {
			// Notify extension about restored peer images so it can update the image collection
			for (const peerUri of peerImageUris) {
				vscode.postMessage({
					type: 'restorePeerImage',
					peerUri: peerUri
				});
			}

			// Reload comparison images after main image loads
			setTimeout(() => {
				for (const peerUri of peerImageUris) {
					handleStartComparison(peerUri);
				}
			}, 1000); // Give main image time to load
		}

		// Restore colormap conversion if it was previously applied
		if (colormapConversionState) {
			// Capture in const so TypeScript can narrow through async callbacks
			const savedColormapState = colormapConversionState;
			// Wait for image to load, then reapply colormap conversion
			// Use polling to detect when image is ready to minimize visual flash
			const checkAndApplyColormap = async () => {
				if (hasLoadedImage && canvas) {
					// Apply colormap conversion immediately
					await handleColormapConversion(
						savedColormapState.colormapName,
						savedColormapState.minValue,
						savedColormapState.maxValue,
						savedColormapState.inverted,
						savedColormapState.logarithmic
					);
				} else {
					// Check again in 50ms if not ready yet
					setTimeout(checkAndApplyColormap, 50);
				}
			};

			// Start checking after a brief delay to allow initial setup
			setTimeout(checkAndApplyColormap, 100);
		}
	}

	/**
	 * Reload image when file changes on disk
	 * Always resets zoom to 'fit' when file is rewritten to avoid dimension mismatch issues
	 */
	function reloadImage() {
		// Reset the state
		hasLoadedImage = false;
		canvas = null;
		imageElement = null;
		primaryImageData = null;
		peerImageData = null;

		// Clear stats in UI to prevent stale values
		vscode.postMessage({ type: 'stats', value: null });

		// Clear the container
		container.className = 'container image';

		// Remove any existing image/canvas elements, but NOT the histogram overlay canvas
		const existingImages = container.querySelectorAll('img, canvas');
		existingImages.forEach(el => {
			if (!el.closest('.histogram-overlay')) {
				el.remove();
			}
		});

		// Remove loading indicator if present
		const loadingIndicator = container.querySelector('.loading-indicator');
		if (loadingIndicator) {
			loadingIndicator.remove();
		}

		// Show loading state (clear any previous error)
		container.classList.add('loading');
		container.classList.remove('error');

		// Load the image based on file type
		const settings = settingsManager.settings;
		const resourceUri = settings.resourceUri || '';

		// When file is rewritten, always reset zoom to 'fit' to avoid dimension mismatches
		// The file on disk may have changed size, so preserving zoom state would cause
		// incorrect calculations in zoomController.updateScale() which uses canvas.width/height
		zoomController.resetZoom();

		// Load image based on file extension
		const reloadSrc = settings.src ?? '';
		if (resourceUri.toLowerCase().endsWith('.tif') || resourceUri.toLowerCase().endsWith('.tiff')) {
			handleTiff(reloadSrc);
		} else if (resourceUri.toLowerCase().endsWith('.exr')) {
			handleExr(reloadSrc);
		} else if (resourceUri.toLowerCase().endsWith('.pfm')) {
			handlePfm(reloadSrc);
		} else if (resourceUri.toLowerCase().endsWith('.ppm') || resourceUri.toLowerCase().endsWith('.pgm') || resourceUri.toLowerCase().endsWith('.pbm')) {
			handlePpm(reloadSrc);
		} else if (resourceUri.toLowerCase().endsWith('.png') || resourceUri.toLowerCase().endsWith('.jpg') || resourceUri.toLowerCase().endsWith('.jpeg')) {
			handlePng(reloadSrc);
		} else if (resourceUri.toLowerCase().endsWith('.npy') || resourceUri.toLowerCase().endsWith('.npz')) {
			handleNpy(reloadSrc);
		} else if (resourceUri.toLowerCase().endsWith('.hdr')) {
			handleHdr(reloadSrc);
		} else if (resourceUri.toLowerCase().endsWith('.tga')) {
			handleTga(reloadSrc);
		} else if (resourceUri.toLowerCase().match(/\.(webp|avif|bmp|ico)$/)) {
			handleWebImage(reloadSrc);
		} else if (resourceUri.toLowerCase().endsWith('.jxl')) {
			handleJxl(reloadSrc);
		} else if (isRawExtension(resourceUri.toLowerCase())) {
			handleRaw(reloadSrc);
		} else {
			image.src = reloadSrc;
		}
	}

	/**
	 * Helper function to send formatInfo (tracking happens automatically in vscode wrapper)
	 * @param {object} formatInfo
	 */
	function sendFormatInfo(formatInfo) {
		vscode.postMessage({
			type: 'formatInfo',
			value: formatInfo
		});
	}

	/**
	 * Helper to log to VS Code Output
	 * @param {string} message
	 */
	function logToOutput(message) {
		vscode.postMessage({
			type: 'log',
			value: message
		});
	}

	/**
	 * Helper to render ImageData to canvas using createImageBitmap for performance
	 * @param {ImageData} imageData
	 * @param {CanvasRenderingContext2D} ctx
	 */
	async function renderImageDataToCanvas(imageData, ctx) {
		if (!ctx) return;
		try {
			const bitmap = await createImageBitmap(imageData);
			ctx.drawImage(bitmap, 0, 0);
			bitmap.close(); // Release memory
		} catch (e) {
			console.error("Error creating ImageBitmap, falling back to putImageData", e);
			ctx.putImageData(imageData, 0, 0);
		}
	}

	/**
	 * Setup image loading handlers
	 */
	function setupImageLoading() {
		container.classList.add('image');
		image.classList.add('scale-to-fit');

		image.addEventListener('load', () => {
			if (hasLoadedImage) return;
			onLoadSuccess();
		});

		image.addEventListener('error', () => {
			if (hasLoadedImage) return;
			onImageError();
		});
	}

	/**
	 * Handle successful image load for non-TIFF images
	 */
	async function onLoadSuccess() {
		hasLoadedImage = true;

		// Create a canvas and draw the image to it for unified rendering
		canvas = document.createElement('canvas');
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		canvas.classList.add('scale-to-fit');

		const ctx = canvas.getContext('2d');
		if (!ctx) {
			onImageError();
			return;
		}
		ctx.drawImage(image, 0, 0);

		imageElement = canvas;
		finalizeImageSetup();
	}

	/**
	 * Handle image loading error, with optional specific message.
	 */
	function onImageError(/** @type {string} */ message = '') {
		hasLoadedImage = true;
		// Remove previous image/canvas so the error message shows on a clean background
		container.querySelectorAll('img, canvas').forEach(el => {
			if (!el.closest('.histogram-overlay')) {
				el.remove();
			}
		});
		container.classList.add('error');
		container.classList.remove('loading');
		const errorEl = container.querySelector('.image-load-error p');
		if (errorEl) {
			errorEl.textContent = message || 'An error occurred while loading the image.';
		}
	}

	/**
	 * Handle TIFF file loading
	 * @param {string} src
	 * @param {number} [gen]
	 */
	async function handleTiff(src, gen = _loadGeneration) {
		currentLoadFormat = 'TIFF';
		try {
			const result = await tiffProcessor.processTiff(src);
			if (gen !== _loadGeneration) { return; }

			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;

			// Draw the processed image data to canvas
			const ctx = canvas.getContext('2d');
			if (ctx) {
				await renderImageDataToCanvas(primaryImageData, ctx);
			}

			hasLoadedImage = true;
			if (!tiffProcessor._pendingRenderData) {
				finalizeImageSetup();
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logToOutput(`[Perf] TIFF Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
			}
			// else: finalizeImageSetup called after deferred render in updateSettings handler

		} catch (error) {
			console.error('Error handling TIFF:', error);
			const msg = String(error instanceof Error ? error.message : error);
			if (msg.includes('50000') || msg.toLowerCase().includes('zstd')) {
				onImageError('ZSTD compression (method 50000) is not supported. Re-save the TIFF with LZW, Deflate, or no compression.');
			} else if (msg.toLowerCase().includes('compression')) {
				onImageError(`Unsupported TIFF compression: ${msg}`);
			} else {
				onImageError(`Failed to load TIFF: ${msg}`);
			}
		}
	}

	/**
	 * Handle EXR file loading
	 * @param {string} src
	 * @param {number} [gen]
	 */
	async function handleExr(src, gen = _loadGeneration) {
		currentLoadFormat = 'EXR';
		try {
			const result = await exrProcessor.processExr(src);
			if (gen !== _loadGeneration) { return; }

			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;

			// Draw the processed image data to canvas
			const ctx = canvas.getContext('2d');
			if (ctx) {
				await renderImageDataToCanvas(primaryImageData, ctx);
			}

			hasLoadedImage = true;
			if (!exrProcessor._pendingRenderData) {
				finalizeImageSetup();
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logToOutput(`[Perf] EXR Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
			}
			// else: finalizeImageSetup called after deferred render in updateSettings handler

		} catch (error) {
			console.error('Error handling EXR:', error);
			onImageError();
		}
	}

	/**
	 * Handle PFM file loading
	 * @param {string} src
	 * @param {number} [gen]
	 */
	async function handlePfm(src, gen = _loadGeneration) {
		currentLoadFormat = 'PFM';
		try {
			const result = await pfmProcessor.processPfm(src);
			if (gen !== _loadGeneration) { return; }
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				await renderImageDataToCanvas(primaryImageData, ctx);
			}
			hasLoadedImage = true;
			if (!pfmProcessor._pendingRenderData) {
				finalizeImageSetup();
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logToOutput(`[Perf] PFM Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
			}
			// else: finalizeImageSetup called after deferred render in updateSettings handler
		} catch (error) {
			console.error('Error handling PFM:', error);
			onImageError();
		}
	}

	/**
	 * Handle PPM/PGM file loading
	 * @param {string} src
	 * @param {number} [gen]
	 */
	async function handlePpm(src, gen = _loadGeneration) {
		currentLoadFormat = 'PPM/PGM';
		try {
			const result = await ppmProcessor.processPpm(src);
			if (gen !== _loadGeneration) { return; }
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				await renderImageDataToCanvas(primaryImageData, ctx);
			}
			hasLoadedImage = true;
			if (!ppmProcessor._pendingRenderData) {
				finalizeImageSetup();
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logToOutput(`[Perf] PPM/PGM Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
			}
			// else: finalizeImageSetup called after deferred render in updateSettings handler
		} catch (error) {
			console.error('Error handling PPM/PGM:', error);
			onImageError();
		}
	}

	/**
	 * Handle PNG/JPEG file loading
	 * @param {string} src
	 * @param {number} [gen]
	 */
	async function handlePng(src, gen = _loadGeneration) {
		currentLoadFormat = 'PNG/JPEG';
		try {
			const result = await pngProcessor.processPng(src);
			if (gen !== _loadGeneration) { return; }
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				await renderImageDataToCanvas(primaryImageData, ctx);
			}
			hasLoadedImage = true;
			if (!pngProcessor._pendingRenderData) {
				finalizeImageSetup();
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logToOutput(`[Perf] PNG/JPEG Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
			}
			// else: finalizeImageSetup called after deferred render in updateSettings handler
		} catch (error) {
			console.error('Error handling PNG/JPEG:', error);
			onImageError();
		}
	}

	/**
	 * Handle NPY/NPZ file loading
	 * @param {string} src
	 * @param {number} [gen]
	 */
	async function handleNpy(src, gen = _loadGeneration) {
		currentLoadFormat = 'NPY/NPZ';
		try {
			const result = await npyProcessor.processNpy(src);
			if (gen !== _loadGeneration) { return; }
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				await renderImageDataToCanvas(primaryImageData, ctx);
			}
			hasLoadedImage = true;
			if (!npyProcessor._pendingRenderData) {
				finalizeImageSetup();
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logToOutput(`[Perf] NPY/NPZ Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
			}
			// else: finalizeImageSetup called after deferred render in updateSettings handler
		} catch (error) {
			console.error('Error handling NPY/NPZ:', error);
			onImageError();
		}
	}

	/** @param {string} src @param {number} [gen] */
	async function handleHdr(src, gen = _loadGeneration) {
		currentLoadFormat = 'HDR';
		try {
			const result = await hdrProcessor.processHdr(src);
			if (gen !== _loadGeneration) { return; }
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				await renderImageDataToCanvas(primaryImageData, ctx);
			}
			hasLoadedImage = true;
			if (!hdrProcessor._pendingRenderData) {
				finalizeImageSetup();
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logToOutput(`[Perf] HDR Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
			}
		} catch (error) {
			if (gen !== _loadGeneration) { return; }
			console.error('Error handling HDR:', error);
			onImageError();
		}
	}

	/** @param {string} src @param {number} [gen] */
	async function handleTga(src, gen = _loadGeneration) {
		currentLoadFormat = 'TGA';
		try {
			const result = await tgaProcessor.processTga(src);
			if (gen !== _loadGeneration) { return; }
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				await renderImageDataToCanvas(primaryImageData, ctx);
			}
			hasLoadedImage = true;
			if (!tgaProcessor._pendingRenderData) {
				finalizeImageSetup();
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logToOutput(`[Perf] TGA Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
			}
		} catch (error) {
			if (gen !== _loadGeneration) { return; }
			console.error('Error handling TGA:', error);
			onImageError();
		}
	}

	/** @param {string} src @param {number} [gen] */
	async function handleWebImage(src, gen = _loadGeneration) {
		currentLoadFormat = 'Web Image';
		try {
			const result = await webImageProcessor.processWebImage(src);
			if (gen !== _loadGeneration) { return; }
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				await renderImageDataToCanvas(primaryImageData, ctx);
			}
			hasLoadedImage = true;
			if (!webImageProcessor._pendingRenderData) {
				finalizeImageSetup();
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logToOutput(`[Perf] Web Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
			}
		} catch (error) {
			if (gen !== _loadGeneration) { return; }
			console.error('Error handling Web Image:', error);
			onImageError();
		}
	}

	/** @param {string} src @param {number} [gen] */
	async function handleJxl(src, gen = _loadGeneration) {
		currentLoadFormat = 'JXL';
		try {
				const result = await jxlProcessor.processJxl(src);
			if (gen !== _loadGeneration) { return; }
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				await renderImageDataToCanvas(primaryImageData, ctx);
			}
			hasLoadedImage = true;
			if (!jxlProcessor._pendingRenderData) {
				finalizeImageSetup();
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logToOutput(`[Perf] JXL Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
			}
		} catch (error) {
			if (gen !== _loadGeneration) { return; }
			console.error('Error handling JXL:', error);
			onImageError(`Failed to load JXL: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** @param {string} src @param {number} [gen] */
	async function handleRaw(src, gen = _loadGeneration) {
		currentLoadFormat = 'Camera RAW';
		try {
			const result = await rawProcessor.processRaw(src);
			if (gen !== _loadGeneration) { return; }
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				await renderImageDataToCanvas(primaryImageData, ctx);
			}
			hasLoadedImage = true;
			if (!rawProcessor._pendingRenderData) {
				finalizeImageSetup();
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logToOutput(`[Perf] Camera RAW Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
			}
		} catch (error) {
			if (gen !== _loadGeneration) { return; }
			console.error('Error handling Camera RAW:', error);
			onImageError(`Failed to load RAW: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Finalize image setup after loading
	 */
	function finalizeImageSetup() {
		if (!imageElement || !canvas) return;
		// Update all controllers with references
		zoomController.setImageElement(imageElement);
		zoomController.setCanvas(canvas);
		zoomController.setImageLoaded();
		mouseHandler.setImageElement(imageElement);

		// Send size information to VS Code
		vscode.postMessage({
			type: 'size',
			value: `${imageElement.width}x${imageElement.height}`,
		});

		// Remove any previous image/canvas elements now that the new one is ready,
		// but preserve the histogram overlay canvas
		const existingImages = container.querySelectorAll('img, canvas');
		existingImages.forEach(el => {
			if (!el.closest('.histogram-overlay')) {
				el.remove();
			}
		});

		// Update UI
		container.classList.remove('loading');
		container.classList.remove('error');
		container.classList.add('ready');
		container.append(imageElement);

		// Apply zoom: restore saved state from before the switch, or fit if none
		if (_pendingZoomState && _pendingZoomState.scale !== 'fit') {
			zoomController.restoreState(_pendingZoomState);
		} else {
			zoomController.applyInitialZoom();
		}
		_pendingZoomState = null;

		// Restore overlay counter from loading state — but only if no deferred render is still pending.
		// Deferred renders (EXR, NPY, TIFF with per-format settings, etc.) call finalizeImageSetup
		// with a placeholder canvas; the real render happens later in the updateSettings handler.
		// Clearing the loading indicator here would make it disappear before the actual image shows.
		const hasPendingDeferred = tiffProcessor._pendingRenderData ||
			npyProcessor._pendingRenderData ||
			pngProcessor._pendingRenderData ||
			ppmProcessor._pendingRenderData ||
			pfmProcessor._pendingRenderData ||
			exrProcessor._pendingRenderData ||
			hdrProcessor._pendingRenderData ||
			tgaProcessor._pendingRenderData ||
			webImageProcessor._pendingRenderData ||
			jxlProcessor._pendingRenderData ||
			rawProcessor._pendingRenderData;
		if (!hasPendingDeferred) {
			clearCollectionLoadingState();
		}

		mouseHandler.addMouseListeners(imageElement);

		// Note: Histogram visibility is restored via restoreHistogramState message
		// when webview becomes active (sent from ImagePreview.sendHistogramState)

		// Update histogram if visible
		updateHistogramData();
	}

	/**
	 * Clear the collection loading indicators (overlay dot + badge highlight).
	 * Called once the final image pixels are rendered — either directly in
	 * finalizeImageSetup (no deferred render) or after performDeferredRender completes.
	 */
	function clearCollectionLoadingState() {
		if (overlayElement && imageCollection.show) {
			const counter = overlayElement.querySelector('.image-counter');
			if (counter) counter.textContent = `${imageCollection.currentIndex + 1} of ${imageCollection.totalImages}`;
		}
		if (filenameBadge) filenameBadge.classList.remove('filename-badge--loading');
	}

	/**
	 * Setup VS Code message handling
	 */
	function setupMessageHandling() {
		window.addEventListener('message', async (e) => {
			if (e.origin !== window.origin) {
				console.error('Dropping message from unknown origin in image preview');
				return;
			}

			await handleVSCodeMessage(e.data);
		});

		// Send ready message to VS Code
		vscode.postMessage({ type: 'get-initial-data' });
	}

	/**
	 * Handle messages from VS Code
	 * @param {{type: string, [key: string]: any}} message
	 */
	async function handleVSCodeMessage(message) {
		switch (message.type) {
			case 'setScale':
				zoomController.updateScale(message.scale);
				break;

			case 'setActive':
				mouseHandler.setActive(message.value);
				break;

			case 'zoomIn':
				zoomController.zoomIn();
				break;

			case 'zoomOut':
				zoomController.zoomOut();
				break;

			case 'resetZoom':
				zoomController.resetZoom();
				break;

			case 'exportAsPng':
				exportAsPng();
				break;

			case 'start-comparison':
				handleStartComparison(message.peerUri);
				break;

			case 'copyImage':
				copyImage();
				break;

			case 'pastePosition':
				// Pass the state from the extension (for cross-webview paste)
				pastePosition(message.state);
				break;

			case 'updateSettings':
				// Handle real-time settings updates
				const oldResourceUri = settingsManager.settings.resourceUri;
				const changes = settingsManager.updateSettings(message.settings);
				const newResourceUri = settingsManager.settings.resourceUri;

				// Check if this is a deferred render trigger (initial load)
				if (message.isInitialRender && canvas) {
					// Trigger deferred rendering for the appropriate processor
					let deferredImageData = null;

					if (tiffProcessor._pendingRenderData) {
						deferredImageData = await tiffProcessor.performDeferredRender();
					} else if (npyProcessor._pendingRenderData) {
						deferredImageData = npyProcessor.performDeferredRender();
					} else if (pngProcessor._pendingRenderData) {
						deferredImageData = pngProcessor.performDeferredRender();
					} else if (ppmProcessor._pendingRenderData) {
						deferredImageData = ppmProcessor.performDeferredRender();
					} else if (pfmProcessor._pendingRenderData) {
						deferredImageData = pfmProcessor.performDeferredRender();
					} else if (exrProcessor._pendingRenderData) {
						deferredImageData = exrProcessor.updateSettings(settingsManager.settings);
					} else if (hdrProcessor._pendingRenderData) {
						deferredImageData = hdrProcessor.performDeferredRender();
					} else if (tgaProcessor._pendingRenderData) {
						deferredImageData = tgaProcessor.performDeferredRender();
					} else if (webImageProcessor._pendingRenderData) {
						deferredImageData = webImageProcessor.performDeferredRender();
					} else if (jxlProcessor._pendingRenderData) {
						deferredImageData = jxlProcessor.performDeferredRender();
					} else if (rawProcessor._pendingRenderData) {
						deferredImageData = rawProcessor.performDeferredRender();
					}

					if (deferredImageData) {
						const ctx = canvas.getContext('2d', { willReadFrequently: true });
						if (ctx) {
							await renderImageDataToCanvas(deferredImageData, ctx);
							primaryImageData = deferredImageData;
						}

						// Canvas now has real pixels — swap out old canvas and finalize
						finalizeImageSetup();
						// Deferred render is done — clear loading indicators now
						clearCollectionLoadingState();

						// Log deferred render completion (only if we actually rendered deferred data)
						if (initialLoadStartTime > 0) {
							const endTime = performance.now();
							const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
							const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
							logToOutput(`[Perf] ${currentLoadFormat} Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
							initialLoadStartTime = 0; // Reset
						}
					}
				}
				// If resource URI changed, reload the entire image.
				// Guard with hasLoadedImage: if a collection switch is already in flight
				// (hasLoadedImage=false), a stale sendSettingsUpdate from the extension
				// can carry a different resourceUri — don't let it hijack the in-progress load.
				else if (oldResourceUri !== newResourceUri && hasLoadedImage) {
					reloadImage();
				} else {
					// Update rendering with new settings, using optimization hints
					// Only re-render if we have an image loaded AND it's not waiting for a deferred render
					const hasPendingRender = tiffProcessor._pendingRenderData ||
						(npyProcessor && npyProcessor._pendingRenderData) ||
						(pngProcessor && pngProcessor._pendingRenderData) ||
						(ppmProcessor && ppmProcessor._pendingRenderData) ||
						(pfmProcessor && pfmProcessor._pendingRenderData) ||
						(exrProcessor && exrProcessor._pendingRenderData) ||
						(hdrProcessor && hdrProcessor._pendingRenderData) ||
						(tgaProcessor && tgaProcessor._pendingRenderData) ||
						(webImageProcessor && webImageProcessor._pendingRenderData) ||
						(jxlProcessor && jxlProcessor._pendingRenderData) ||
						(rawProcessor && rawProcessor._pendingRenderData);

					if (hasLoadedImage && !hasPendingRender) {
						const startTime = performance.now();
						await updateImageWithNewSettings(changes);
						const endTime = performance.now();
						logToOutput(`[Perf] Re-render (Gamma/Brightness) took ${(endTime - startTime).toFixed(2)}ms`);
					}
				}
				break;

			case 'updateLoadStartTime':
				extensionLoadStartTime = message.timestamp;
				break;

			case 'mask-filter-settings':
				// Handle mask filter settings updates
				const maskChanges = settingsManager.updateSettings(message.settings);
				updateImageWithNewSettings(maskChanges);
				break;

			case 'updateImageCollectionOverlay':
				updateImageCollectionOverlay(message.data);
				break;

			case 'getZoomState':
				// Send current zoom state back to extension
				const zoomState = zoomController.getCurrentState();
				vscode.postMessage({
					type: 'zoomStateResponse',
					state: zoomState
				});
				break;

			case 'getComparisonState':
				// Send current comparison state back to extension
				const comparisonState = {
					peerUris: peerImageUris,
					isShowingPeer: isShowingPeer
				};
				vscode.postMessage({
					type: 'comparisonStateResponse',
					state: comparisonState
				});
				break;

			case 'restoreZoomState':
				// Restore zoom state after image change
				if (message.state) {
					zoomController.restoreState(message.state);
				}
				break;

			case 'restoreComparisonState':
				// Restore comparison state after image change
				if (message.state && message.state.peerUris && message.state.peerUris.length > 0) {
					peerImageUris = message.state.peerUris;
					isShowingPeer = message.state.isShowingPeer;

					// Reload peer images for comparison
					for (const peerUri of peerImageUris) {
						handleStartComparison(peerUri);
					}
				}
				break;

			case 'switchToImage':
				// Prefer zoom state injected by the extension (set before the webview
				// reloaded, so it's always accurate). Fall back to live state on the
				// first switch in a rapid in-session burst.
				if (_pendingZoomState === null) {
					const liveZoom = zoomController.getCurrentState();
					// After a webview reload the page hasn't scrolled yet so x/y are 0,
					// but vscode.getState() still holds the offsets saved before unload.
					// Prefer those persisted offsets so the position is fully restored.
					if (liveZoom.scale !== 'fit' && liveZoom.x === 0 && liveZoom.y === 0) {
						const saved = vscode.getState();
						if (saved && saved.scale === liveZoom.scale) {
							liveZoom.x = saved.offsetX || 0;
							liveZoom.y = saved.offsetY || 0;
						}
					}
					_pendingZoomState = message.zoomState || liveZoom;
				}
				switchToNewImage(message.uri, message.resourceUri);
				break;

			case 'toggleHistogram':
				// Toggle histogram visibility
				histogramOverlay.toggle();
				updateHistogramData();
				// Notify extension of new state
				vscode.postMessage({
					type: 'histogramVisibilityChanged',
					isVisible: histogramOverlay.getVisibility()
				});
				break;

			case 'restoreHistogramState':
				// Restore histogram state from extension (global state)
				// Skip notification since extension already knows the state
				if (message.isVisible && !histogramOverlay.getVisibility()) {
					histogramOverlay.show(true); // Skip notification
					updateHistogramData();
				} else if (!message.isVisible && histogramOverlay.getVisibility()) {
					histogramOverlay.hide(true); // Skip notification
				}
				// Restore position if provided
				if (message.position) {
					histogramOverlay.setPosition(message.position.left, message.position.top);
				}
				// Restore scale mode if provided
				if (message.scaleMode) {
					histogramOverlay.setScaleMode(message.scaleMode);
				}
				break;

			case 'requestHistogram':
				// Extension requested histogram update
				updateHistogramData();
				break;

			case 'convertColormapToFloat':
				// Convert colormap image to float values
				await handleColormapConversion(
					message.colormap,
					message.min,
					message.max,
					message.inverted || false,
					message.logarithmic || false
				);
				break;

			case 'revertToOriginal':
				// Revert to the original image
				handleRevertToOriginal();
				break;
		}
	}

	/**
	 * Update histogram with current image data.
	 * Uses raw image data when available for accurate value representation.
	 */
	function updateHistogramData() {
		if (!canvas || !hasLoadedImage) {
			return;
		}

		// Only update histogram if it's visible - this is expensive
		if (!histogramOverlay.getVisibility()) {
			return;
		}
		try {
			const settings = settingsManager.settings;
			/** @type {object} */
			let histogramOptions = {
				settings: settings
			};

			// Try to get raw data from the appropriate processor
			if (tiffProcessor.rawTiffData) {
				// TIFF raw data
				const ifd = tiffProcessor.rawTiffData.ifd;
				const rasters = tiffProcessor.rawTiffData.rasters;
				const format = ifd.t339; // SampleFormat: 1=uint, 2=int, 3=float
				const bitsPerSample = ifd.t258 || 8;
				const samples = ifd.t277 || 1;
				const isFloat = format === 3;
				
				// Determine typeMax based on format
				let typeMax;
				if (isFloat) {
					typeMax = 1.0;
				} else if (bitsPerSample === 16) {
					typeMax = 65535;
				} else {
					typeMax = 255;
				}

				// Get stats if available
				const stats = tiffProcessor._lastStatistics || null;

				histogramOptions = {
					...histogramOptions,
					planarData: rasters,
					channels: samples,
					isFloat: isFloat,
					typeMax: typeMax,
					stats: stats
				};
			} else if (exrProcessor && exrProcessor.rawExrData) {
				// EXR raw data (always float)
				const { width, height, data, channels } = exrProcessor.rawExrData;
				const stats = exrProcessor._cachedStats || null;

				histogramOptions = {
					...histogramOptions,
					rawData: data,
					channels: channels,
					isFloat: true,
					typeMax: 1.0,
					stats: stats
				};
			} else if (npyProcessor && npyProcessor._lastRaw) {
				// NPY raw data
				const { width, height, data, dtype, channels } = npyProcessor._lastRaw;
				const isFloat = dtype.includes('f');
				const stats = npyProcessor._cachedStats || null;

				let typeMax;
				if (isFloat) {
					typeMax = 1.0;
				} else if (dtype.includes('16') || dtype.includes('u2') || dtype.includes('i2')) {
					typeMax = 65535;
				} else {
					typeMax = 255;
				}

				histogramOptions = {
					...histogramOptions,
					rawData: data,
					channels: channels,
					isFloat: isFloat,
					typeMax: typeMax,
					stats: stats
				};
			} else if (pfmProcessor && pfmProcessor._lastRaw) {
				// PFM raw data (always float)
				const { width, height, data, channels } = pfmProcessor._lastRaw;
				const stats = pfmProcessor._cachedStats || null;

				histogramOptions = {
					...histogramOptions,
					rawData: data,
					channels: channels,
					isFloat: true,
					typeMax: 1.0,
					stats: stats
				};
			} else if (ppmProcessor && ppmProcessor._lastRaw) {
				// PPM/PGM raw data
				const { width, height, data, maxval, channels } = ppmProcessor._lastRaw;
				const stats = ppmProcessor._cachedStats || null;

				histogramOptions = {
					...histogramOptions,
					rawData: data,
					channels: channels,
					isFloat: false,
					typeMax: maxval,
					stats: stats
				};
			} else if (pngProcessor && pngProcessor._lastRaw) {
				// PNG raw data
				const { width, height, data, channels, bitDepth, maxValue } = pngProcessor._lastRaw;
				const stats = pngProcessor._cachedStats || null;

				histogramOptions = {
					...histogramOptions,
					rawData: data,
					channels: channels,
					isFloat: false,
					typeMax: maxValue || 255,
					stats: stats
				};
			}

			// Get canvas image data as fallback
			const ctx = canvas.getContext('2d', { willReadFrequently: true });
			if (!ctx) return;
			const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

			// Update histogram overlay
			histogramOverlay.update(imageData, histogramOptions);
		} catch (error) {
			console.error('Error updating histogram:', error);
		}
	}

	/**
	 * Convert colormap image to float values
	 * @param {string} colormapName - Name of the colormap to use
	 * @param {number} minValue - Minimum value to map to
	 * @param {number} maxValue - Maximum value to map to
	 * @param {boolean} inverted - Whether to invert the mapping
	 * @param {boolean} logarithmic - Whether to use logarithmic mapping
	 */
	async function handleColormapConversion(colormapName, minValue, maxValue, inverted, logarithmic) {
		if (!canvas || !hasLoadedImage) {
			console.error('No image loaded for colormap conversion');
			return;
		}

		try {
			const ctx = canvas.getContext('2d', { willReadFrequently: true });
			if (!ctx) {
				console.error('Could not get canvas context');
				return;
			}

			// Get the current image data from canvas
			const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

			// Convert to float using the colormap
			const floatData = colormapConverter.convertToFloat(
				imageData,
				colormapName,
				minValue,
				maxValue,
				inverted,
				logarithmic
			);

			// Create a new ImageData for the float visualization
			// We'll render it as if it's a float TIFF
			const width = imageData.width;
			const height = imageData.height;

			// Store the float data for display
			// Create a temporary processor-like object to handle the float data
			const floatImageData = new ImageData(width, height);

			// Enable auto-normalization and set the range
			if (settingsManager.settings.normalization) {
				settingsManager.settings.normalization.autoNormalize = true;
				settingsManager.settings.normalization.min = minValue;
				settingsManager.settings.normalization.max = maxValue;
			}

			// Normalize float values to 0-255 for display
			for (let i = 0; i < floatData.length; i++) {
				const value = floatData[i];
				// Normalize to 0-255
				const normalized = ((value - minValue) / (maxValue - minValue)) * 255;
				const clamped = Math.max(0, Math.min(255, normalized));

				const offset = i * 4;
				floatImageData.data[offset] = clamped;     // R
				floatImageData.data[offset + 1] = clamped; // G
				floatImageData.data[offset + 2] = clamped; // B
				floatImageData.data[offset + 3] = 255;     // A
			}

			// Display the converted float image
			await renderImageDataToCanvas(floatImageData, ctx);
			primaryImageData = floatImageData;

			// Force a visual update by triggering a reflow
			// This ensures the canvas changes are actually displayed
			if (imageElement === canvas) {
				// Canvas is already in DOM, force a repaint
				canvas.style.display = 'none';
				canvas.offsetHeight; // Trigger reflow
				canvas.style.display = '';
			}

			// Update zoom controller to refresh the display
			zoomController.updateScale(zoomController.scale || 'fit');

			// Store the float data for pixel inspection
			// Store converted float data in a custom property (dynamic property)
			// @ts-ignore - Adding dynamic property for converted colormap data
			tiffProcessor._convertedFloatData = {
				floatData: floatData,
				width: width,
				height: height,
				min: minValue,
				max: maxValue
			};

			// Clear the raw processor data to prevent re-rendering from original data
			// After colormap conversion, we want to work with the converted float data
			tiffProcessor.rawTiffData = null;
			if (exrProcessor) exrProcessor.rawExrData = undefined;
			if (npyProcessor) npyProcessor._lastRaw = null;
			if (ppmProcessor) ppmProcessor._lastRaw = null;
			if (pfmProcessor) pfmProcessor._lastRaw = null;
			if (pngProcessor) pngProcessor._lastRaw = null;
			if (hdrProcessor) hdrProcessor._lastRaw = null;
			if (tgaProcessor) tgaProcessor._lastRaw = null;
			if (webImageProcessor) webImageProcessor._lastRaw = null;
			if (jxlProcessor) jxlProcessor._lastRaw = null;
			if (rawProcessor) rawProcessor._lastRaw = null;

			// Update settings display
			vscode.postMessage({
				type: 'stats',
				value: { min: minValue, max: maxValue }
			});

			// Send format info
			sendFormatInfo({
				width: width,
				height: height,
				bitsPerSample: 32,
				sampleFormat: 3, // Float
				samplesPerPixel: 1,
				formatType: 'colormap-converted',
				isInitialLoad: false
			});

			// Update histogram
			updateHistogramData();

			// Save the colormap conversion state for persistence
			colormapConversionState = {
				colormapName: colormapName,
				minValue: minValue,
				maxValue: maxValue,
				inverted: inverted,
				logarithmic: logarithmic
			};
			hasAppliedConversion = true;
			saveState();

			console.log(`Colormap conversion complete: ${colormapName} [${minValue}, ${maxValue}]`);
		} catch (error) {
			console.error('Error during colormap conversion:', error);
			vscode.postMessage({
				type: 'error',
				message: `Colormap conversion failed: ${/** @type {any} */ (error).message}`
			});
		}
	}

	/**
	 * Revert to the original image before any conversions
	 */
	function handleRevertToOriginal() {
		if (!canvas || !hasLoadedImage) {
			console.error('No image loaded to revert');
			return;
		}

		try {
			// Reload the original image based on file type
			const settings = settingsManager.settings;
			const resourceUri = settings.resourceUri || '';

			// Reset the conversion state
			colormapConversionState = null;
			hasAppliedConversion = false;
			originalImageData = null;

			// Clear converted data from processors
			tiffProcessor.rawTiffData = null;
			if (exrProcessor) exrProcessor.rawExrData = undefined;
			if (npyProcessor) npyProcessor._lastRaw = null;
			if (ppmProcessor) ppmProcessor._lastRaw = null;
			if (pfmProcessor) pfmProcessor._lastRaw = null;
			if (pngProcessor) pngProcessor._lastRaw = null;
			if (tgaProcessor) tgaProcessor._lastRaw = null;
			if (webImageProcessor) webImageProcessor._lastRaw = null;
			if (jxlProcessor) jxlProcessor._lastRaw = null;
			if (rawProcessor) rawProcessor._lastRaw = null;
			// @ts-ignore
			tiffProcessor._convertedFloatData = null;

			// Reload the image
			reloadImage();

			vscode.postMessage({
				type: 'notifyRevert',
				message: 'Reverted to original image'
			});

			console.log('Reverted to original image');
		} catch (error) {
			console.error('Error reverting to original image:', error);
			vscode.postMessage({
				type: 'error',
				message: `Failed to revert to original image: ${/** @type {any} */ (error).message}`
			});
		}
	}

	/**
	 * Update image rendering with new settings
	 * @param {SettingsChanges|null} [changes] - Changed settings
	 */
	async function updateImageWithNewSettings(changes) {
		if (!canvas || !primaryImageData) {
			return;
		}

		// Default to full update if no change info provided
		if (!changes) {
			changes = { parametersOnly: false, changedMasks: false, changedStructure: false };
		}

		// If masks changed, clear the mask cache
		if (changes.changedMasks && tiffProcessor._maskCache) {
			tiffProcessor.clearMaskCache();
		}

		// For TIFF images, optimize based on what changed
		if (primaryImageData && tiffProcessor.rawTiffData) {
			try {
				// If only parameters changed (gamma/brightness/normalization), use optimized path
				if (changes.parametersOnly) {
					// Skip mask loading and statistics recalculation
					// Just re-render with new parameters from raw data
					const newImageData = await tiffProcessor.renderTiffWithSettingsFast(
						tiffProcessor.rawTiffData.image,
						tiffProcessor.rawTiffData.rasters,
						true // skipMasks flag
					);

					// Update the canvas with new image data
					const ctx = canvas.getContext('2d');
					if (ctx && newImageData) {
						await renderImageDataToCanvas(newImageData, ctx);
						primaryImageData = newImageData;
						updateHistogramData();
					}
					return;
				}

				// Fallback to full re-render for structural changes or mask changes
				const newImageData = await tiffProcessor.renderTiffWithSettings(
					tiffProcessor.rawTiffData.image,
					tiffProcessor.rawTiffData.rasters
				);

				// Update the canvas with new image data
				const ctx = canvas.getContext('2d');
				if (ctx && newImageData) {
					console.log('✅ CANVAS UPDATE (TIFF slow path): Applying new ImageData to canvas');
					await renderImageDataToCanvas(newImageData, ctx);
					primaryImageData = newImageData;
					updateHistogramData();
				}
				console.log('✨ Slow path complete, returning');
				return; // Don't fall through to other processors
			} catch (error) {
				console.error('❌ Error updating TIFF image with new settings:', error);
			}
			console.log('↩️ Returning after TIFF processing (even on error)');
			return; // Return even on error to prevent fall-through
		}

		// Re-render based on which processor was used (mutually exclusive)
		// Check in order: EXR -> PGM -> PNG/JPEG -> NPY

		// For EXR images, re-render with new settings
		if (primaryImageData && exrProcessor && exrProcessor.rawExrData) {
			console.log('📄 Processing EXR update');
			try {
				// Re-render the EXR with current settings
				const newImageData = exrProcessor.updateSettings(settingsManager.settings);

				if (newImageData) {
					// Update the canvas with new image data
					const ctx = canvas.getContext('2d');
					if (ctx) {
						console.log('✅ CANVAS UPDATE (EXR): Applying new ImageData to canvas');
						await renderImageDataToCanvas(newImageData, ctx);
						primaryImageData = newImageData;
						updateHistogramData();
					}
				}
			} catch (error) {
				console.error('❌ Error updating EXR image with new settings:', error);
			}
			return;
		}
		// For PGM images, re-render with new settings
		if (primaryImageData && ppmProcessor && ppmProcessor._lastRaw) {
			try {
				// Re-render the PGM with current settings
				const newImageData = ppmProcessor.renderPgmWithSettings();

				if (newImageData) {
					// Update the canvas with new image data
					const ctx = canvas.getContext('2d');
					if (ctx) {
						await renderImageDataToCanvas(newImageData, ctx);
						primaryImageData = newImageData;
						updateHistogramData();
					}
				}
			} catch (error) {
				console.error('Error updating PGM image with new settings:', error);
			}
			return;
		}

		// For PFM images, re-render with new settings
		if (primaryImageData && pfmProcessor && pfmProcessor._lastRaw) {
			try {
				// Re-render the PFM with current settings
				const newImageData = pfmProcessor.renderPfmWithSettings();

				if (newImageData) {
					// Update the canvas with new image data
					const ctx = canvas.getContext('2d');
					if (ctx) {
						await renderImageDataToCanvas(newImageData, ctx);
						primaryImageData = newImageData;
						updateHistogramData();
					}
				}
			} catch (error) {
				console.error('Error updating PFM image with new settings:', error);
			}
			return;
		}

		// For NPY images, re-render with new settings
		if (primaryImageData && npyProcessor && npyProcessor._lastRaw) {
			try {
				// Re-render the NPY with current settings
				const newImageData = npyProcessor.renderNpyWithSettings();

				if (newImageData) {
					// Update the canvas with new image data
					const ctx = canvas.getContext('2d');
					if (ctx) {
						await renderImageDataToCanvas(newImageData, ctx);
						primaryImageData = newImageData;
						updateHistogramData();
					}
				}
			} catch (error) {
				console.error('Error updating NPY image with new settings:', error);
			}
			return;
		}

		// For PNG/JPEG images, re-render with new settings
		if (primaryImageData && pngProcessor && pngProcessor._lastRaw) {
			try {
				// Re-render the PNG with current settings
				const newImageData = pngProcessor.renderPngWithSettings();

				if (newImageData) {
					// Update the canvas with new image data
					const ctx = canvas.getContext('2d');
					if (ctx) {
						await renderImageDataToCanvas(newImageData, ctx);
						primaryImageData = newImageData;
						updateHistogramData();
					}
				}
			} catch (error) {
				console.error('Error updating PNG/JPEG image with new settings:', error);
			}
			return;
		}

		// For HDR images, re-render with new settings
		if (primaryImageData && hdrProcessor && hdrProcessor._lastRaw) {
			try {
				const newImageData = hdrProcessor.renderHdrWithSettings();
				if (newImageData) {
					const ctx = canvas.getContext('2d');
					if (ctx) {
						await renderImageDataToCanvas(newImageData, ctx);
						primaryImageData = newImageData;
						updateHistogramData();
					}
				}
			} catch (error) {
				console.error('Error updating HDR image with new settings:', error);
			}
			return;
		}

		// For TGA images, re-render with new settings
		if (primaryImageData && tgaProcessor && tgaProcessor._lastRaw) {
			try {
				const newImageData = tgaProcessor.renderTgaWithSettings();
				if (newImageData) {
					const ctx = canvas.getContext('2d');
					if (ctx) {
						await renderImageDataToCanvas(newImageData, ctx);
						primaryImageData = newImageData;
						updateHistogramData();
					}
				}
			} catch (error) {
				console.error('Error updating TGA image with new settings:', error);
			}
			return;
		}

		// For WebP/AVIF/BMP/ICO images, re-render with new settings
		if (primaryImageData && webImageProcessor && webImageProcessor._lastRaw) {
			try {
				const newImageData = webImageProcessor.renderWebImageWithSettings();
				if (newImageData) {
					const ctx = canvas.getContext('2d');
					if (ctx) {
						await renderImageDataToCanvas(newImageData, ctx);
						primaryImageData = newImageData;
						updateHistogramData();
					}
				}
			} catch (error) {
				console.error('Error updating Web Image with new settings:', error);
			}
			return;
		}

		// For JXL images, re-render with new settings
		if (primaryImageData && jxlProcessor && jxlProcessor._lastRaw) {
			try {
				const newImageData = jxlProcessor.renderJxlWithSettings();
				if (newImageData) {
					const ctx = canvas.getContext('2d');
					if (ctx) {
						await renderImageDataToCanvas(newImageData, ctx);
						primaryImageData = newImageData;
						updateHistogramData();
					}
				}
			} catch (error) {
				console.error('Error updating JXL image with new settings:', error);
			}
			return;
		}

		// For Camera RAW images, re-render with new settings
		if (primaryImageData && rawProcessor && rawProcessor._lastRaw) {
			try {
				const newImageData = rawProcessor.renderRawWithSettings();
				if (newImageData) {
					const ctx = canvas.getContext('2d');
					if (ctx) {
						await renderImageDataToCanvas(newImageData, ctx);
						primaryImageData = newImageData;
						updateHistogramData();
					}
				}
			} catch (error) {
				console.error('Error updating Camera RAW image with new settings:', error);
			}
			return;
		}
	}

	/**
	 * Setup additional event listeners
	 */
	function setupEventListeners() {
		// Wheel zoom handling
		container.addEventListener('wheel', (e) => {
			// Prevent pinch to zoom
			if (e.ctrlKey) {
				e.preventDefault();
			}

			const keyState = mouseHandler.getKeyboardState();
			zoomController.handleWheelZoom(e, keyState.ctrlPressed, keyState.altPressed);
		}, { passive: false });

		// Mouse click handling for zoom
		container.addEventListener('mousedown', (e) => {
			if (!imageElement || !hasLoadedImage) {
				return;
			}

			if (e.button !== 0) {
				return;
			}

			const keyState = mouseHandler.getKeyboardState();
			mouseHandler.consumeClick = !mouseHandler.isActive;
		});

		container.addEventListener('click', (e) => {
			if (!imageElement || !hasLoadedImage) {
				return;
			}

			if (e.button !== 0) {
				return;
			}

			if (mouseHandler.consumeClick) {
				mouseHandler.consumeClick = false;
				return;
			}

			// left click zoom
			if (zoomController.scale === 'fit') {
				zoomController.firstZoom();
			}

			const keyState = mouseHandler.getKeyboardState();
			if (!(settingsManager.isMac ? keyState.altPressed : keyState.ctrlPressed)) { // zoom in
				zoomController.zoomIn();
			} else {
				zoomController.zoomOut();
			}
		});

		// Scroll state saving
		window.addEventListener('scroll', () => {
			if (!imageElement || !hasLoadedImage || !imageElement.parentElement || zoomController.scale === 'fit') {
				return;
			}

			const entry = vscode.getState();
			if (entry) {
				vscode.setState({ ...entry, offsetX: window.scrollX, offsetY: window.scrollY });
			}
		}, { passive: true });

		// Copy handling
		document.addEventListener('copy', () => {
			copyImage();
		});

		// Custom context menu with various commands
		document.addEventListener('contextmenu', (e) => {
			e.preventDefault();

			// Remove any existing custom context menu
			const existingMenu = document.querySelector('.custom-context-menu');
			if (existingMenu) {
				existingMenu.remove();
			}

			// Create custom context menu
			const menu = document.createElement('div');
			menu.className = 'custom-context-menu';
			menu.style.left = `${e.clientX}px`;
			menu.style.top = `${e.clientY}px`;

			// Helper function to create menu items
			const createMenuItem = (/** @type {string} */ text, /** @type {() => void} */ action) => {
				const item = document.createElement('div');
				item.className = 'context-menu-item';
				item.textContent = text;
				item.addEventListener('click', (e) => {
					e.stopPropagation(); // Prevent event bubbling
					menu.remove();
					// Execute action after removing menu to avoid timing issues
					setTimeout(() => action(), 0);
				});
				return item;
			};

			// Helper function to create separator
			const createSeparator = () => {
				const separator = document.createElement('div');
				separator.className = 'context-menu-separator';
				return separator;
			};

			// Add Copy option (triggers command via extension for logging)
			menu.appendChild(createMenuItem('Copy Image and Position', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.copyImage' });
			}));

			// Add Paste Position option (uses extension command for cross-webview support)
			menu.appendChild(createMenuItem('Paste Position', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.pastePosition' });
			}));

			// Add Export as PNG option (triggers command via extension)
			menu.appendChild(createMenuItem('Export as PNG', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.exportAsPng' });
			}));

			menu.appendChild(createSeparator());

			// Add Images to Collection option
			menu.appendChild(createMenuItem('Add Images to Collection', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.browseAndAddToCollection' });
			}));

			menu.appendChild(createSeparator());

			// Add Toggle Histogram option (triggers command via extension for logging)
			menu.appendChild(createMenuItem('Toggle Histogram', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.toggleHistogram' });
			}));

			// Check if image is 8-bit uint RGB for interpretation options
			const isRgb8BitUint = currentFormatInfo &&
				(currentFormatInfo.samplesPerPixel ?? 0) >= 3 &&
				currentFormatInfo.bitsPerSample === 8 &&
				currentFormatInfo.sampleFormat !== 3; // Not float
			const isRgbImage = currentFormatInfo && (currentFormatInfo.samplesPerPixel ?? 0) >= 3;

			if (isRgb8BitUint) {
				menu.appendChild(createSeparator());

				const rgb24Active = settingsManager.settings.rgbAs24BitGrayscale || false;
				menu.appendChild(createMenuItem(rgb24Active ? '✓ Interpret as 24-bit Grayscale' : 'Interpret as 24-bit Grayscale', () => {
					vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.toggleRgb24Mode' });
				}));
			}

			if (isRgbImage) {
				if (!isRgb8BitUint) {
					menu.appendChild(createSeparator());
				}

				// Add Convert Colormap to Float option (uses command - needs user input)
				menu.appendChild(createMenuItem('Convert Colormap to Float', () => {
					vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.convertColormapToFloat' });
				}));
			}

			// Show revert option if a colormap conversion has been applied
			if (hasAppliedConversion) {
				menu.appendChild(createSeparator());

				menu.appendChild(createMenuItem('Revert to Original', () => {
					vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.revertToOriginal' });
				}));
			}

			menu.appendChild(createSeparator());

			// Add Filter by Mask option (uses command - needs user input)
			menu.appendChild(createMenuItem('Filter by Mask (beta)', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.filterByMask' });
			}));


			menu.appendChild(createSeparator());

			// Add Open Comparison Panel option
			// menu.appendChild(createMenuItem('Open Comparison Panel', () => {
			// 	vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.openComparisonPanel' });
			// }));

			// Add Toggle NaN Color option
			const currentNanColor = settingsManager.settings.nanColor || 'black';
			const nextNanColor = currentNanColor === 'black' ? 'fuchsia' : 'black';
			menu.appendChild(createMenuItem(`Show NaN Color as ${nextNanColor}`, () => {
				vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.toggleNanColor' });
			}));

			// Add Toggle Color Picker Mode option - ONLY in Gamma Mode
			// In other modes, we always show original values
			const isGammaMode = settingsManager.settings.normalization && settingsManager.settings.normalization.gammaMode;
			if (isGammaMode) {
				const isShowingModified = settingsManager.settings.colorPickerShowModified || false;
				const nextColorMode = isShowingModified ? 'Original Values' : 'Modified Values';
				menu.appendChild(createMenuItem(`Color Picker: Show ${nextColorMode}`, () => {
					vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.toggleColorPickerMode' });
				}));
			}

			// Open as Point Cloud — only when ply-visualizer is installed and format is supported
			const plyFormats = ['tiff-float', 'tiff-int', 'pfm', 'npy', 'npy-float', 'npy-uint', 'png'];
			if (settingsManager.settings.plyVisualizerInstalled && currentFormatInfo && plyFormats.includes(currentFormatInfo.formatType ?? '')) {
				menu.appendChild(createSeparator());
				menu.appendChild(createMenuItem('Open as Point Cloud', () => {
					vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.openAsPointCloud' });
				}));
			}

			document.body.appendChild(menu);

			// Remove menu when clicking outside
			const removeMenu = (/** @type {MouseEvent} */ event) => {
				if (!menu.contains(/** @type {Node} */ (event.target))) {
					menu.remove();
					document.removeEventListener('click', removeMenu);
				}
			};

			// Use setTimeout to avoid immediate removal
			setTimeout(() => {
				document.addEventListener('click', removeMenu);
			}, 0);
		});

		// Prevent cut operation (only copy makes sense for image viewer)
		document.addEventListener('cut', (e) => {
			e.preventDefault();
		});

		// Handle paste for position pasting (Ctrl+V / Cmd+V)
		// Uses extension command for cross-webview support
		document.addEventListener('paste', (e) => {
			e.preventDefault();
			// Use extension command for cross-webview paste support
			vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.pastePosition' });
		});

		// Comparison toggle
		document.addEventListener('keydown', async (e) => {
			if (e.key === 'c' && peerImageData) {
				isShowingPeer = !isShowingPeer;

				// Swap raw data so histogram and re-renders use the correct image's data.
				// Both TIFF and EXR slots are swapped — whichever is non-null will be
				// picked up by updateHistogramData for the currently shown image.
				const tempRawTiffData = tiffProcessor.rawTiffData;
				const tempLastStatistics = tiffProcessor._lastStatistics;
				tiffProcessor.rawTiffData = peerRawTiffData;
				tiffProcessor._lastStatistics = peerLastStatistics;
				peerRawTiffData = tempRawTiffData;
				peerLastStatistics = tempLastStatistics;

				const tempRawExrData = exrProcessor.rawExrData;
				const tempExrStats = exrProcessor._cachedStats;
				exrProcessor.rawExrData = peerRawExrData;
				exrProcessor._cachedStats = peerExrStats;
				peerRawExrData = tempRawExrData;
				peerExrStats = tempExrStats;

				const imageData = isShowingPeer ? peerImageData : primaryImageData;
				const ctx = canvas && canvas.getContext('2d');
				if (ctx && imageData) {
					await renderImageDataToCanvas(imageData, ctx);
					updateHistogramData();
				}

				// Save state after toggling comparison
				saveState();
			}
		});

		// Error link handling
		document.querySelector('.open-file-link')?.addEventListener('click', (e) => {
			e.preventDefault();
			vscode.postMessage({ type: 'reopen-as-text' });
		});

		// Keyboard handling for image toggling
		window.addEventListener('keydown', (e) => {
			if (imageCollection.totalImages > 1) {
				if (e.code === 'ArrowRight') {
					e.preventDefault();
					vscode.postMessage({ type: 'toggleImage' });
				} else if (e.code === 'ArrowLeft') {
					e.preventDefault();
					vscode.postMessage({ type: 'toggleImageReverse' });
				}
			}
		});

		// Window beforeunload
		window.addEventListener('beforeunload', () => {
			zoomController.saveState();
		});
	}

	/**
	 * Create image collection overlay
	 */
	function createImageCollectionOverlay() {
		overlayElement = document.createElement('div');
		overlayElement.classList.add('image-collection-overlay');
		overlayElement.style.display = 'none';

		overlayElement.innerHTML = `
			<div class="overlay-content">
				<div class="overlay-controls">
					<span class="image-counter" title="Click to jump to image">1 of 1</span>
					<button class="collection-remove-btn" title="Remove from collection">&#x2715;</button>
				</div>
				<span class="toggle-hint">← → to navigate</span>
			</div>
		`;

		// Click on counter → inline number input to jump to any image
		const counterEl = /** @type {HTMLElement} */ (overlayElement.querySelector('.image-counter'));

		counterEl.addEventListener('click', () => {
			const total = imageCollection.totalImages;

			const input = document.createElement('input');
			input.type = 'number';
			input.min = '1';
			input.max = String(total);
			input.value = String(imageCollection.currentIndex + 1);
			input.className = 'image-counter-input';
			input.title = `1 – ${total}`;

			activeCounterInput = input;
			counterEl.replaceWith(input);
			input.select();

			const close = () => {
				if (!input.isConnected) return;
				activeCounterInput = null;
				counterEl.textContent = `${imageCollection.currentIndex + 1} of ${imageCollection.totalImages}`;
				input.replaceWith(counterEl);
			};

			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					e.stopPropagation();
					const index = parseInt(input.value, 10);
					if (!isNaN(index) && index >= 1 && index <= imageCollection.totalImages) {
						vscode.postMessage({ type: 'jumpToCollectionIndex', index: index - 1 });
					}
					close();
				} else if (e.key === 'Escape') {
					activeCounterInput = null;
					input.replaceWith(counterEl);
				} else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
					e.preventDefault();
					e.stopPropagation();
					const cur = parseInt(input.value, 10);
					const base = isNaN(cur) ? imageCollection.currentIndex + 1 : cur;
					const total = imageCollection.totalImages;
					const next = e.key === 'ArrowRight'
						? (base >= total ? 1 : base + 1)
						: (base <= 1 ? total : base - 1);
					input.value = String(next);
					input.select();
					vscode.postMessage({ type: 'jumpToCollectionIndex', index: next - 1 });
				}
			});

			input.addEventListener('blur', close);
		});

		/** @type {ReturnType<typeof setTimeout> | null} */
		let removeConfirmTimer = null;

		overlayElement.addEventListener('mousedown', (e) => {
			if (/** @type {HTMLElement} */ (e.target).classList.contains('collection-remove-btn')) {
				e.preventDefault(); // prevent text selection on repeated clicks
			}
		});

		overlayElement.addEventListener('click', (e) => {
			const target = /** @type {HTMLButtonElement} */ (e.target);
			if (!target.classList.contains('collection-remove-btn')) return;
			e.stopPropagation();

			if (target.classList.contains('collection-remove-btn--confirm')) {
				// Second click — confirmed
				if (removeConfirmTimer !== null) clearTimeout(removeConfirmTimer);
				removeConfirmTimer = null;
				target.classList.remove('collection-remove-btn--confirm');
				target.textContent = '\u2715';
				target.title = 'Remove from collection';
				vscode.postMessage({ type: 'removeFromCollection' });
			} else {
				// First click — enter confirm state
				target.classList.add('collection-remove-btn--confirm');
				target.textContent = '\u2713';
				target.title = 'Click to confirm removal';
				removeConfirmTimer = setTimeout(() => {
					target.classList.remove('collection-remove-btn--confirm');
					target.textContent = '\u2715';
					target.title = 'Remove from collection';
					removeConfirmTimer = null;
				}, 1500);
			}
		});

		document.body.appendChild(overlayElement);
	}

	/**
	 * Create filename badge (bottom-left, hidden until collection has >1 image)
	 */
	function createFilenameBadge() {
		filenameBadge = document.createElement('div');
		filenameBadge.classList.add('filename-badge');
		filenameBadge.style.display = 'none';
		document.body.appendChild(filenameBadge);
		updateFilenameBadge(settingsManager.settings.resourceUri || '');

		// JS tooltip — appended to body to avoid overflow clipping
		/** @type {HTMLElement | null} */
		let tooltipEl = null;

		const badge = filenameBadge;
		badge.addEventListener('mouseenter', () => {
			const fullPath = badge.dataset.tooltip;
			if (!fullPath) return;
			tooltipEl = document.createElement('div');
			tooltipEl.className = 'filename-tooltip';
			tooltipEl.textContent = fullPath;
			document.body.appendChild(tooltipEl);
			const rect = badge.getBoundingClientRect();
			tooltipEl.style.left = rect.left + 'px';
			// Use bottom so we don't need to know tooltip height (offsetHeight may be 0 immediately after append)
			tooltipEl.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
		});

		badge.addEventListener('mouseleave', () => {
			tooltipEl?.remove();
			tooltipEl = null;
		});
	}

	/**
	 * @param {string} resourceUri
	 */
	function updateFilenameBadge(resourceUri) {
		if (!filenameBadge || !resourceUri) return;
		// Extract filename from URI or path (handles file:// URIs, vscode-resource URIs and plain paths)
		const decoded = decodeURIComponent(resourceUri);
		const filename = decoded.split(/[/\\]/).filter(Boolean).pop() || decoded;
		// Strip any query string that vscode-resource URIs may append
		const cleanFilename = filename.split('?')[0];
		const fullPath = decoded.replace(/^[a-z-]+:\/\/[^/]*/i, '').split('?')[0];
		filenameBadge.textContent = cleanFilename;
		filenameBadge.dataset.tooltip = fullPath;
		// If a tooltip is currently visible (mouse is hovering), update it live
		const liveTooltip = document.querySelector('.filename-tooltip');
		if (liveTooltip) {
			liveTooltip.textContent = fullPath;
		}
	}

	/**
	 * Update image collection overlay
	 * @param {{show: boolean, currentIndex: number, totalImages: number}} data
	 */
	function updateImageCollectionOverlay(data) {
		if (!overlayElement) return;

		imageCollection = data;

		if (data.show && data.totalImages > 1) {
			if (activeCounterInput) {
				activeCounterInput.value = String(data.currentIndex + 1);
				activeCounterInput.select();
			} else {
				const counter = overlayElement.querySelector('.image-counter');
				if (counter) {
					counter.textContent = `${data.currentIndex + 1} of ${data.totalImages}`;
				}
			}
			overlayElement.style.display = 'block';
			if (filenameBadge) filenameBadge.style.display = 'block';
		} else {
			overlayElement.style.display = 'none';
			if (filenameBadge) filenameBadge.style.display = 'none';
		}
	}

	/**
	 * Switch to a new image in the collection (legacy - for fallback)
	 * @param {string} uri
	 * @param {string} resourceUri
	 */
	function switchToNewImage(uri, resourceUri) {
		// Every switch gets a new generation so any in-flight load from a
		// previous rapid press can detect it is stale and bail out.
		const gen = ++_loadGeneration;

		// Update the settings with the new resource URI
		settingsManager.settings.resourceUri = resourceUri;
		settingsManager.settings.src = uri;
		updateFilenameBadge(resourceUri);

		// Reset zoom to fit so applyInitialZoom uses a clean state while the
		// correct zoom is restored via restoreZoomState once the image is ready.
		// Also reset initialState so applyInitialZoom doesn't scroll to stale offsets.
		zoomController.scale = 'fit';
		zoomController.initialState = { scale: 'fit', offsetX: 0, offsetY: 0 };

		// Show loading indicator in the overlay badge (dot before counter text) and badge
		if (overlayElement && imageCollection.show) {
			const counter = overlayElement.querySelector('.image-counter');
			if (counter) counter.innerHTML = `<span class="collection-loading-dot"></span>${imageCollection.currentIndex + 1} of ${imageCollection.totalImages}`;
		}
		if (filenameBadge) filenameBadge.classList.add('filename-badge--loading');

		// Reset the state
		hasLoadedImage = false;
		canvas = null;
		imageElement = null;
		primaryImageData = null;

		// Reset each processor's initial-load flag so they re-send formatInfo and
		// trigger the extension to apply the correct per-format settings for the
		// new image (e.g. switching from TIFF-int to EXR-float needs different
		// normalization defaults). The AppStateManager caches settings per-format
		// so any user adjustments are preserved when switching back.
		tiffProcessor._isInitialLoad = true;
		exrProcessor._isInitialLoad = true;
		npyProcessor._isInitialLoad = true;
		pfmProcessor._isInitialLoad = true;
		ppmProcessor._isInitialLoad = true;
		pngProcessor._isInitialLoad = true;
		hdrProcessor._isInitialLoad = true;
		tgaProcessor._isInitialLoad = true;
		webImageProcessor._isInitialLoad = true;
		jxlProcessor._isInitialLoad = true;
		rawProcessor._isInitialLoad = true;

		// Clear each processor's stale raw data so the mouse handler and histogram
		// don't read pixels from the previous image. Without this, the TIFF-first
		// checks in mouse-handler.js and updateHistogramData() would return values
		// from the old image while the new one is loading/rendering.
		tiffProcessor.rawTiffData = null;
		tiffProcessor._lastStatistics = null;
		tiffProcessor._convertedFloatData = null;
		exrProcessor.rawExrData = undefined;
		exrProcessor._cachedStats = undefined;
		npyProcessor._lastRaw = null;
		pfmProcessor._lastRaw = null;
		ppmProcessor._lastRaw = null;
		pngProcessor._lastRaw = null;
		hdrProcessor._lastRaw = null;
		tgaProcessor._lastRaw = null;
		webImageProcessor._lastRaw = null;
		jxlProcessor._lastRaw = null;
		rawProcessor._lastRaw = null;
		rawProcessor._arrayBuffer = null;

		// Keep existing image/canvas visible while the new image loads to avoid
		// a black flash. They will be removed in finalizeImageSetup once the new
		// image is ready to be shown.

		// Load the new image based on file type
		loadImageByType(uri, resourceUri, gen);
	}

	/**
	 * Load image by type (wrapper function)
	 * @param {string} uri
	 * @param {string} resourceUri
	 * @param {number} gen
	 */
	function loadImageByType(uri, resourceUri, gen) {
		const lower = resourceUri.toLowerCase();
		if (lower.endsWith('.tif') || lower.endsWith('.tiff')) {
			handleTiff(uri, gen);
		} else if (lower.endsWith('.exr')) {
			handleExr(uri, gen);
		} else if (lower.endsWith('.pfm')) {
			handlePfm(uri, gen);
		} else if (lower.endsWith('.ppm') || lower.endsWith('.pgm') || lower.endsWith('.pbm')) {
			handlePpm(uri, gen);
		} else if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
			handlePng(uri, gen);
		} else if (lower.endsWith('.npy') || lower.endsWith('.npz')) {
			handleNpy(uri, gen);
		} else if (lower.endsWith('.hdr')) {
			handleHdr(uri, gen);
		} else if (lower.endsWith('.tga')) {
			handleTga(uri, gen);
		} else if (lower.match(/\.(webp|avif|bmp|ico)$/)) {
			handleWebImage(uri, gen);
		} else if (lower.endsWith('.jxl')) {
			handleJxl(uri, gen);
		} else if (isRawExtension(lower)) {
			handleRaw(uri, gen);
		} else {
			// Fallback to regular image loading
			const newImage = document.createElement('img');
			newImage.classList.add('scale-to-fit');
			newImage.src = uri;

			newImage.addEventListener('load', () => {
				if (gen !== _loadGeneration) return;

				// Create canvas and draw image
				canvas = document.createElement('canvas');
				canvas.width = newImage.naturalWidth;
				canvas.height = newImage.naturalHeight;
				canvas.classList.add('scale-to-fit');

				const ctx = canvas.getContext('2d');
				if (ctx) {
					ctx.drawImage(newImage, 0, 0);
				}

				imageElement = canvas;
				finalizeImageSetup();
			});

			newImage.addEventListener('error', () => {
				if (gen !== _loadGeneration) return;
				onImageError();
			});
		}
	}

	/**
	 * Export canvas as PNG
	 */
	function exportAsPng() {
		if (canvas) {
			vscode.postMessage({
				type: 'didExportAsPng',
				payload: canvas.toDataURL('image/png')
			});
		} else if (image && image.src) {
			// If no canvas, create a temporary canvas from the image element
			const tempCanvas = document.createElement('canvas');
			tempCanvas.width = image.naturalWidth;
			tempCanvas.height = image.naturalHeight;
			const ctx = tempCanvas.getContext('2d');
			if (ctx) {
				ctx.drawImage(image, 0, 0);
				vscode.postMessage({
					type: 'didExportAsPng',
					payload: tempCanvas.toDataURL('image/png')
				});
				tempCanvas.remove();
			}
		}
	}

	/**
	 * Show a notification message
	 * @param {string} message - The message to display
	 * @param {string} type - The type of notification ('success' or 'error')
	 */
	function showNotification(message, type = 'success') {
		// Remove any existing notification
		const existingNotification = document.querySelector('.copy-notification');
		if (existingNotification) {
			existingNotification.remove();
		}

		// Create notification element
		const notification = document.createElement('div');
		notification.className = `copy-notification copy-notification-${type}`;
		notification.textContent = message;

		// Add to document
		document.body.appendChild(notification);

		// Auto-dismiss success notifications after 3 seconds
		if (type === 'success') {
			setTimeout(() => {
				notification.classList.add('copy-notification-fadeout');
				setTimeout(() => {
					if (notification.parentElement) {
						notification.remove();
					}
				}, 300); // Match the CSS transition duration
			}, 3000);
		}

		// Allow manual dismissal by clicking
		notification.addEventListener('click', () => {
			notification.classList.add('copy-notification-fadeout');
			setTimeout(() => {
				if (notification.parentElement) {
					notification.remove();
				}
			}, 300);
		});
	}

	/**
	 * Copy image to clipboard and store position/zoom state
	 */
	async function copyImage() {
		if (!canvas) return;
		// The original code had `(retries = 5)` here, but the instruction's example removed it.
		// To maintain functionality, `retries` is now defined internally if needed.
		let retries = 5;
		if (!document.hasFocus() && retries > 0) {
			setTimeout(() => { copyImage(); }, 20);
			return;
		}

		// Check if we have an image to copy
		if (!canvas && (!image || !image.naturalWidth)) {
			showNotification('No image loaded to copy', 'error');
			console.error('Copy failed: No image available');
			return;
		}

		// Store the current position and zoom state for paste position feature
		// Position is stored as relative coordinates (0-1) for cross-resolution compatibility
		if (canvas && imageElement) {
			const zoomState = zoomController.getCurrentState();
			const imageWidth = canvas.width;
			const imageHeight = canvas.height;
			
			// Calculate the center point of the viewport in image coordinates
			// This is what the user is looking at
			let centerXImage, centerYImage;
			
			if (zoomState.scale === 'fit') {
				// In fit mode, the center is simply the image center
				centerXImage = imageWidth / 2;
				centerYImage = imageHeight / 2;
			} else {
				// In zoomed mode, calculate the visible center point
				const displayedWidth = imageWidth * zoomState.scale;
				const displayedHeight = imageHeight * zoomState.scale;
				
				// Get the element's position
				const rect = imageElement.getBoundingClientRect();
				const elemLeftDoc = window.scrollX + rect.left;
				const elemTopDoc = window.scrollY + rect.top;
				
				// Viewport center in document coordinates
				const viewportCenterX = window.scrollX + container.clientWidth / 2;
				const viewportCenterY = window.scrollY + container.clientHeight / 2;
				
				// Convert to image coordinates
				centerXImage = (viewportCenterX - elemLeftDoc) / zoomState.scale;
				centerYImage = (viewportCenterY - elemTopDoc) / zoomState.scale;
				
				// Clamp to valid image bounds
				centerXImage = Math.max(0, Math.min(imageWidth, centerXImage));
				centerYImage = Math.max(0, Math.min(imageHeight, centerYImage));
			}
			
			// Store as relative position (0-1) for cross-resolution compatibility
			copiedPositionState = {
				relativeX: centerXImage / imageWidth,
				relativeY: centerYImage / imageHeight,
				scale: zoomState.scale,
				sourceWidth: imageWidth,
				sourceHeight: imageHeight
			};
			
			// Send position to extension for cross-webview paste support
			vscode.postMessage({
				type: 'positionCopied',
				state: copiedPositionState
			});
			
			console.log('Position copied:', copiedPositionState);
		}

		try {
			await navigator.clipboard.write([new ClipboardItem({
				'image/png': new Promise((resolve, reject) => {
					const copyCanvas = document.createElement('canvas');
					const ctx = copyCanvas.getContext('2d');
					if (!ctx) {
						return reject(new Error('Could not get canvas context'));
					}

					if (canvas) {
						copyCanvas.width = canvas.width;
						copyCanvas.height = canvas.height;
						ctx.drawImage(canvas, 0, 0);
					} else {
						copyCanvas.width = image.naturalWidth;
						copyCanvas.height = image.naturalHeight;
						ctx.drawImage(image, 0, 0);
					}

					copyCanvas.toBlob((blob) => {
						if (blob) {
							resolve(blob);
						} else {
							reject(new Error('Could not create blob'));
						}
						copyCanvas.remove();
					}, 'image/png');
				})
			})]);

			// Show success notification - include position info
			const positionInfo = copiedPositionState ? ' + position' : '';
			showNotification(`Image${positionInfo} copied to clipboard`, 'success');
		} catch (e) {
			console.error('Copy failed:', e);
			showNotification(`Failed to copy image: ${/** @type {any} */ (e).message}`, 'error');
		}
	}

	/**
	 * Paste position from previously copied state
	 * Scales the position for images of different sizes
	 * @param {CopiedPosition|null} positionState - Position state (from extension for cross-webview, or local)
	 */
	function pastePosition(positionState) {
		// Use provided state (from extension) or fall back to local state
		const state = positionState || copiedPositionState;
		
		if (!state) {
			showNotification('No position copied. Copy an image first (Ctrl+C)', 'error');
			return;
		}

		if (!canvas || !imageElement || !hasLoadedImage) {
			showNotification('No image loaded to apply position to', 'error');
			return;
		}

		const targetWidth = canvas.width;
		const targetHeight = canvas.height;
		const sourceWidth = state.sourceWidth;
		const sourceHeight = state.sourceHeight;

		// Calculate the target position using relative coordinates
		const targetCenterX = state.relativeX * targetWidth;
		const targetCenterY = state.relativeY * targetHeight;

		// Calculate the new zoom level
		// For same-size images, use the same zoom
		// For different sizes, scale the zoom proportionally based on the geometric mean
		// This ensures that the "visual coverage" is similar
		let targetScale = state.scale;
		
		if (targetScale !== 'fit') {
			// Scale factor based on the geometric mean of width and height ratios
			// This gives balanced scaling for images with different aspect ratios
			const widthRatio = targetWidth / sourceWidth;
			const heightRatio = targetHeight / sourceHeight;
			const scaleRatio = Math.sqrt(widthRatio * heightRatio);
			
			targetScale = /** @type {number} */ (state.scale) * scaleRatio;
			
			// Clamp to valid zoom range
			const constants = settingsManager.constants;
			targetScale = Math.max(constants.MIN_SCALE, Math.min(constants.MAX_SCALE, targetScale));
		}

		// Apply the zoom and position
		if (targetScale === 'fit') {
			zoomController.updateScale('fit');
		} else {
			// First set the scale (this will center on current view)
			zoomController.updateScale(targetScale);
			
			// Then scroll to center on the target point
			// We need to wait a tick for the scale to be applied
			setTimeout(() => {
				if (!imageElement) return;
				const rect = imageElement.getBoundingClientRect();
				const elemLeftDoc = window.scrollX + rect.left;
				const elemTopDoc = window.scrollY + rect.top;
				
				// Calculate where the target center should be in document coordinates
				const targetDocX = elemLeftDoc + targetCenterX * /** @type {number} */ (targetScale);
				const targetDocY = elemTopDoc + targetCenterY * /** @type {number} */ (targetScale);
				
				// Scroll to center this point in the viewport
				const newScrollX = targetDocX - container.clientWidth / 2;
				const newScrollY = targetDocY - container.clientHeight / 2;
				
				// Clamp to valid scroll range
				const maxScrollX = Math.max(0, document.documentElement.scrollWidth - container.clientWidth);
				const maxScrollY = Math.max(0, document.documentElement.scrollHeight - container.clientHeight);
				
				window.scrollTo(
					Math.max(0, Math.min(maxScrollX, newScrollX)),
					Math.max(0, Math.min(maxScrollY, newScrollY))
				);
			}, 50);
		}

		// Show success notification with info about any scaling applied
		const sameSize = sourceWidth === targetWidth && sourceHeight === targetHeight;
		if (sameSize) {
			showNotification('Position applied', 'success');
		} else {
			const scalePercent = Math.round((targetWidth / sourceWidth) * 100);
			showNotification(`Position applied (scaled to ${scalePercent}% size)`, 'success');
		}

		console.log('Position pasted:', {
			targetCenter: { x: targetCenterX, y: targetCenterY },
			targetScale,
			sameSize,
			sourceSize: { w: sourceWidth, h: sourceHeight },
			targetSize: { w: targetWidth, h: targetHeight }
		});
	}

	/**
	 * Check if a position has been copied (local state only - for context menu)
	 * Note: Cross-webview paste uses extension-stored state
	 */
	function hasPositionCopied() {
		return copiedPositionState !== null;
	}

	/**
	 * Handle comparison setup
	 * @param {string} peerUri
	 */
	async function handleStartComparison(peerUri) {
		try {
			vscode.postMessage({ type: 'show-loading' });

			// Track peer URI for state persistence
			if (!peerImageUris.includes(peerUri)) {
				peerImageUris.push(peerUri);
			}

			const lower = peerUri.toLowerCase();
			let result;

			if (lower.includes('.exr')) {
				// EXR peer — use exrProcessor, preserve primary's raw data
				const savedExrData = exrProcessor.rawExrData;
				const savedExrStats = exrProcessor._cachedStats;

				result = await exrProcessor.processExr(peerUri);
				peerImageData = result.imageData;

				peerRawExrData = exrProcessor.rawExrData;
				peerExrStats = exrProcessor._cachedStats;
				exrProcessor.rawExrData = savedExrData;
				exrProcessor._cachedStats = savedExrStats;
			} else {
				// TIFF / other — use tiffProcessor, preserve primary's raw data
				const savedRawTiffData = tiffProcessor.rawTiffData;
				const savedLastStatistics = tiffProcessor._lastStatistics;

				result = await tiffProcessor.processTiff(peerUri);
				peerImageData = result.imageData;

				peerRawTiffData = tiffProcessor.rawTiffData;
				peerLastStatistics = tiffProcessor._lastStatistics;
				tiffProcessor.rawTiffData = savedRawTiffData;
				tiffProcessor._lastStatistics = savedLastStatistics;
			}

			// Save state after adding peer image
			saveState();

			vscode.postMessage({ type: 'comparison-ready' });
		} catch (error) {
			console.error('Failed to load peer image for comparison:', error);
			vscode.postMessage({ type: 'show-error', message: 'Failed to load comparison image.' });
		}
	}

	// Start the application
	initialize();
}()); 
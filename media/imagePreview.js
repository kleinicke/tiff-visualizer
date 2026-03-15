// @ts-check
"use strict";

import { SettingsManager } from './modules/settings-manager.js';
import { TiffProcessor } from './modules/tiff-processor.js';
import { ExrProcessor } from './modules/exr-processor.js';
import { NpyProcessor } from './modules/npy-processor.js';
import { PfmProcessor } from './modules/pfm-processor.js';
import { PpmProcessor } from './modules/ppm-processor.js';
import { PngProcessor } from './modules/png-processor.js';
import { ZoomController } from './modules/zoom-controller.js';
import { MouseHandler } from './modules/mouse-handler.js';
import { HistogramOverlay } from './modules/histogram-overlay.js';
import { ColormapConverter, COLORMAP_NAMES } from './modules/colormap-converter.js';

/**
 * Main Image Preview Application
 * Orchestrates all modules to provide image viewing functionality
 */
(function () {
	// @ts-ignore
	const originalVscode = acquireVsCodeApi();

	// Format info tracking for context menu
	let currentFormatInfo = null;

	// Wrap vscode.postMessage to track formatInfo
	const vscode = {
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
	const histogramOverlay = new HistogramOverlay(settingsManager, vscode);
	const colormapConverter = new ColormapConverter();
	mouseHandler.setNpyProcessor(npyProcessor);
	mouseHandler.setPfmProcessor(pfmProcessor);
	mouseHandler.setPpmProcessor(ppmProcessor);
	mouseHandler.setPngProcessor(pngProcessor);
	mouseHandler.setExrProcessor(exrProcessor);

	// Application state
	let hasLoadedImage = false;
	let canvas = null;
	let imageElement = null;
	let primaryImageData = null;
	let peerImageData = null;
	let peerImageUris = []; // Track peer URIs for comparison state
	let isShowingPeer = false;
	let initialLoadStartTime = 0;
	let extensionLoadStartTime = 0; // Time when extension started loading (from settings)
	let currentLoadFormat = '';

	// Layer system
	let layers = []; // Array of layer objects
	let activeLayerIndex = 0;

	// Control panel state
	let panelCollapsed = false;
	let currentChannels = 1; // Track channels of base image for colormap enable/disable
	let currentImageStats = { min: 0, max: 1 }; // Stats of the most recently loaded image
	let currentTypeMax = 1.0; // Type max of the most recently loaded image
	let currentIsFloat = true; // Whether the most recently loaded image is float

	// Colormap conversion state
	let colormapConversionState = null;

	// Original image state (for reverting from conversions)
	let originalImageData = null;
	let hasAppliedConversion = false;

	// Copied position state (for paste position feature)
	// Stores position as relative coordinates (0-1) for cross-resolution compatibility
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
	let overlayElement = null;

	/**
	 * Save current state to VS Code webview state for persistence across tab switches
	 */
	function saveState() {
		// Only save serializable state (no ImageData/Canvas objects)
		const state = {
			peerImageUris: peerImageUris,
			isShowingPeer: isShowingPeer,
			currentResourceUri: settingsManager.settings.resourceUri,
			colormapConversionState: colormapConversionState,
			isHistogramVisible: histogramOverlay.getVisibility(),
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
		createControlPanel();

		// Save state when webview might be disposed
		window.addEventListener('beforeunload', saveState);
		window.addEventListener('pagehide', saveState);

		// Start loading the image
		const settings = settingsManager.settings;
		const resourceUri = settings.resourceUri;

		// Load image based on file extension
		if (resourceUri.toLowerCase().endsWith('.tif') || resourceUri.toLowerCase().endsWith('.tiff')) {
			handleTiff(settings.src);
		} else if (resourceUri.toLowerCase().endsWith('.exr')) {
			handleExr(settings.src);
		} else if (resourceUri.toLowerCase().endsWith('.pfm')) {
			handlePfm(settings.src);
		} else if (resourceUri.toLowerCase().endsWith('.ppm') || resourceUri.toLowerCase().endsWith('.pgm') || resourceUri.toLowerCase().endsWith('.pbm')) {
			handlePpm(settings.src);
		} else if (resourceUri.toLowerCase().endsWith('.png') || resourceUri.toLowerCase().endsWith('.jpg') || resourceUri.toLowerCase().endsWith('.jpeg')) {
			handlePng(settings.src);
		} else if (resourceUri.toLowerCase().endsWith('.npy') || resourceUri.toLowerCase().endsWith('.npz')) {
			handleNpy(settings.src);
		} else {
			image.src = settings.src;
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
			// Wait for image to load, then reapply colormap conversion
			// Use polling to detect when image is ready to minimize visual flash
			const checkAndApplyColormap = async () => {
				if (hasLoadedImage && canvas) {
					// Apply colormap conversion immediately
					await handleColormapConversion(
						colormapConversionState.colormapName,
						colormapConversionState.minValue,
						colormapConversionState.maxValue,
						colormapConversionState.inverted,
						colormapConversionState.logarithmic
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

		// Remove any existing image/canvas elements
		const existingImages = container.querySelectorAll('img, canvas');
		existingImages.forEach(el => el.remove());

		// Remove loading indicator if present
		const loadingIndicator = container.querySelector('.loading-indicator');
		if (loadingIndicator) {
			loadingIndicator.remove();
		}

		// Show loading state
		container.classList.add('loading');

		// Load the image based on file type
		const settings = settingsManager.settings;
		const resourceUri = settings.resourceUri || '';

		// When file is rewritten, always reset zoom to 'fit' to avoid dimension mismatches
		// The file on disk may have changed size, so preserving zoom state would cause
		// incorrect calculations in zoomController.updateScale() which uses canvas.width/height
		zoomController.resetZoom();

		// Load image based on file extension
		if (resourceUri.toLowerCase().endsWith('.tif') || resourceUri.toLowerCase().endsWith('.tiff')) {
			handleTiff(settings.src);
		} else if (resourceUri.toLowerCase().endsWith('.pfm')) {
			handlePfm(settings.src);
		} else if (resourceUri.toLowerCase().endsWith('.ppm') || resourceUri.toLowerCase().endsWith('.pgm') || resourceUri.toLowerCase().endsWith('.pbm')) {
			handlePpm(settings.src);
		} else if (resourceUri.toLowerCase().endsWith('.png') || resourceUri.toLowerCase().endsWith('.jpg') || resourceUri.toLowerCase().endsWith('.jpeg')) {
			handlePng(settings.src);
		} else if (resourceUri.toLowerCase().endsWith('.npy') || resourceUri.toLowerCase().endsWith('.npz')) {
			handleNpy(settings.src);
		} else {
			image.src = settings.src || '';
		}
	}

	/**
	 * Helper function to send formatInfo (tracking happens automatically in vscode wrapper)
	 */
	function sendFormatInfo(formatInfo) {
		vscode.postMessage({
			type: 'formatInfo',
			value: formatInfo
		});
	}

	/**
	 * Helper to log to VS Code Output
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
			onImageLoaded();
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
	 * Handle image loading error
	 */
	function onImageError() {
		hasLoadedImage = true;
		container.classList.add('error');
		container.classList.remove('loading');
	}

	/**
	 * Handle TIFF file loading
	 */
	async function handleTiff(src) {
		currentLoadFormat = 'TIFF';
		try {
			const result = await tiffProcessor.processTiff(src);

			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;

			// Draw the processed image data to canvas
			const ctx = canvas.getContext('2d');
			if (ctx) {
				await renderImageDataToCanvas(primaryImageData, ctx);
			}

			hasLoadedImage = true;
			finalizeImageSetup();

			if (!tiffProcessor._pendingRenderData) {
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logToOutput(`[Perf] TIFF Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
			}

		} catch (error) {
			console.error('Error handling TIFF:', error);
			onImageError();
		}
	}

	/**
	 * Handle EXR file loading
	 */
	async function handleExr(src) {
		currentLoadFormat = 'EXR';
		try {
			const result = await exrProcessor.processExr(src);

			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;

			// Draw the processed image data to canvas
			const ctx = canvas.getContext('2d');
			if (ctx) {
				await renderImageDataToCanvas(primaryImageData, ctx);
			}

			hasLoadedImage = true;
			finalizeImageSetup();

			if (!exrProcessor._pendingRenderData) {
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logToOutput(`[Perf] EXR Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
			}

		} catch (error) {
			console.error('Error handling EXR:', error);
			onImageError();
		}
	}

	/**
	 * Handle PFM file loading
	 */
	async function handlePfm(src) {
		currentLoadFormat = 'PFM';
		try {
			const result = await pfmProcessor.processPfm(src);
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				await renderImageDataToCanvas(primaryImageData, ctx);
			}
			hasLoadedImage = true;
			finalizeImageSetup();

			if (!pfmProcessor._pendingRenderData) {
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logToOutput(`[Perf] PFM Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
			}
		} catch (error) {
			console.error('Error handling PFM:', error);
			onImageError();
		}
	}

	/**
	 * Handle PPM/PGM file loading
	 */
	async function handlePpm(src) {
		currentLoadFormat = 'PPM/PGM';
		try {
			const result = await ppmProcessor.processPpm(src);
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				await renderImageDataToCanvas(primaryImageData, ctx);
			}
			hasLoadedImage = true;
			finalizeImageSetup();

			if (!ppmProcessor._pendingRenderData) {
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logToOutput(`[Perf] PPM/PGM Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
			}
		} catch (error) {
			console.error('Error handling PPM/PGM:', error);
			onImageError();
		}
	}

	/**
	 * Handle PNG/JPEG file loading
	 */
	async function handlePng(src) {
		currentLoadFormat = 'PNG/JPEG';
		try {
			const result = await pngProcessor.processPng(src);
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				await renderImageDataToCanvas(primaryImageData, ctx);
			}
			hasLoadedImage = true;
			finalizeImageSetup();

			if (!pngProcessor._pendingRenderData) {
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logToOutput(`[Perf] PNG/JPEG Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
			}
		} catch (error) {
			console.error('Error handling PNG/JPEG:', error);
			onImageError();
		}
	}

	/**
	 * Handle NPY/NPZ file loading
	 */
	async function handleNpy(src) {
		currentLoadFormat = 'NPY/NPZ';
		try {
			const result = await npyProcessor.processNpy(src);
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				await renderImageDataToCanvas(primaryImageData, ctx);
			}
			hasLoadedImage = true;
			finalizeImageSetup();

			if (!npyProcessor._pendingRenderData) {
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logToOutput(`[Perf] NPY/NPZ Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
			}
		} catch (error) {
			console.error('Error handling NPY/NPZ:', error);
			onImageError();
		}
	}

	/**
	 * Finalize image setup after loading
	 */
	function finalizeImageSetup() {
		// Detect channels, typeMax and float flag from whichever processor was used
		currentChannels = 1;
		currentTypeMax = 1.0;
		currentIsFloat = true;
		if (tiffProcessor.rawTiffData) {
			currentChannels = tiffProcessor.rawTiffData.ifd.t277 || 1;
			const _bps = tiffProcessor.rawTiffData.ifd.t258 || 8;
			const _sf = tiffProcessor.rawTiffData.ifd.t339 || 1; // 1=uint, 2=int, 3=float
			currentIsFloat = _sf === 3;
			currentTypeMax = currentIsFloat ? 1.0 : (_bps >= 16 ? 65535 : 255);
		} else if (exrProcessor && exrProcessor.rawExrData) {
			currentChannels = exrProcessor.rawExrData.channels || 1;
			currentIsFloat = true;
			currentTypeMax = 1.0;
		} else if (npyProcessor && npyProcessor._lastRaw) {
			currentChannels = npyProcessor._lastRaw.channels || 1;
			currentIsFloat = npyProcessor._lastRaw.isFloat !== false;
			currentTypeMax = npyProcessor._lastRaw.typeMax || (currentIsFloat ? 1.0 : 255);
		} else if (pfmProcessor && pfmProcessor._lastRaw) {
			currentChannels = pfmProcessor._lastRaw.channels || 1;
			currentIsFloat = true;
			currentTypeMax = 1.0;
		} else if (ppmProcessor && ppmProcessor._lastRaw) {
			currentChannels = ppmProcessor._lastRaw.channels || 1;
			currentIsFloat = false;
			currentTypeMax = 255;
		}
		// Update colormap select disabled state
		const cmSelect = document.getElementById('iv-colormap-select');
		if (cmSelect) cmSelect.disabled = currentChannels !== 1;

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

		// Update UI
		container.classList.remove('loading');
		container.classList.add('ready');
		container.append(imageElement);

		// Apply initial zoom and setup mouse handling
		zoomController.applyInitialZoom();
		mouseHandler.addMouseListeners(imageElement);

		// Note: Histogram visibility is restored via restoreHistogramState message
		// when webview becomes active (sent from ImagePreview.sendHistogramState)

		// Update histogram if visible
		updateHistogramData();

		// Collect stats from whichever processor was used
		const _activeProcessorStats =
			(tiffProcessor && tiffProcessor._cachedStats) ||
			(exrProcessor && exrProcessor._cachedStats) ||
			(npyProcessor && npyProcessor._cachedStats) ||
			(pfmProcessor && pfmProcessor._cachedStats) ||
			null;
		if (_activeProcessorStats) {
			currentImageStats = _activeProcessorStats;
		}

		// Initialize base layer
		const _baseLayerSettings = {
			normalization: { ...settingsManager.settings.normalization },
			gamma: { ...settingsManager.settings.gamma },
			brightness: { ...settingsManager.settings.brightness }
		};
		if (layers.length === 0) {
			layers.push({
				id: settingsManager.settings.resourceUri || 'base',
				name: (settingsManager.settings.resourceUri || 'base').split('/').pop() || 'Base',
				visible: true,
				opacity: 1.0,
				imageData: primaryImageData,
				rawData: null,
				settings: _baseLayerSettings,
				stats: currentImageStats,
				typeMax: currentTypeMax,
				isFloat: currentIsFloat,
				channels: currentChannels,
				colormap: settingsManager.settings.colormap || null
			});
		} else {
			layers[0].imageData = primaryImageData;
			layers[0].settings = _baseLayerSettings;
			layers[0].stats = currentImageStats;
			layers[0].typeMax = currentTypeMax;
			layers[0].isFloat = currentIsFloat;
			layers[0].channels = currentChannels;
			layers[0].colormap = settingsManager.settings.colormap || null;
		}

		// Set slider bounds to match the loaded image data range
		updateRangeSliderBounds(currentImageStats.min, currentImageStats.max, currentTypeMax, currentIsFloat);
		syncPanelToSettings(layers[0].settings, layers[0].colormap);
		updateLayerListUI();
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
				syncPanelToSettings(settingsManager.settings);
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
					}

					if (deferredImageData) {
						const ctx = canvas.getContext('2d', { willReadFrequently: true });
						if (ctx) {
							await renderImageDataToCanvas(deferredImageData, ctx);
							primaryImageData = deferredImageData;
							updateHistogramData();
						}

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
				// If resource URI changed, reload the entire image
				else if (oldResourceUri !== newResourceUri) {
					// Reload the image - zoom will be reset to 'fit' to handle dimension changes
					reloadImage();
				} else {
					// Update rendering with new settings, using optimization hints
					// Only re-render if we have an image loaded AND it's not waiting for a deferred render
					const hasPendingRender = tiffProcessor._pendingRenderData ||
						(npyProcessor && npyProcessor._pendingRenderData) ||
						(pngProcessor && pngProcessor._pendingRenderData) ||
						(ppmProcessor && ppmProcessor._pendingRenderData) ||
						(pfmProcessor && pfmProcessor._pendingRenderData) ||
						(exrProcessor && exrProcessor._pendingRenderData);

					if (hasLoadedImage && !hasPendingRender) {
						const startTime = performance.now();
						await updateImageWithNewSettings(changes);
						const endTime = performance.now();
						logToOutput(`[Perf] Re-render (Gamma/Brightness) took ${(endTime - startTime).toFixed(2)}ms`);
						// Update base layer imageData and settings snapshot for compositing
						if (layers.length > 0) {
							layers[0].imageData = primaryImageData;
							// Keep base layer settings in sync with global settings (from status bar etc.)
							if (layers[0].settings) {
								Object.assign(layers[0].settings.normalization, settingsManager.settings.normalization);
								layers[0].settings.gamma.in = settingsManager.settings.gamma.in;
								layers[0].settings.gamma.out = settingsManager.settings.gamma.out;
								layers[0].settings.brightness.offset = settingsManager.settings.brightness.offset;
								layers[0].colormap = settingsManager.settings.colormap || null;
							}
							if (layers.length > 1) {
								compositeLayers();
							}
						}
						// Sync panel to active layer's settings
						const _aLayer = layers[activeLayerIndex];
						syncPanelToSettings((_aLayer && _aLayer.settings) ? _aLayer.settings : settingsManager.settings);
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
				// Switch to a different image
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

			case 'addLayerData': {
				// Load and add a new layer from file data sent by extension
				const { layerId, filename, fileData, formatHint } = message;
				try {
					const ext = (formatHint || filename || '').toLowerCase();
					let layerResult = null;

					if (ext.endsWith('.tif') || ext.endsWith('.tiff')) {
						layerResult = await tiffProcessor.processTiffFromBuffer(fileData);
					} else if (ext.endsWith('.exr')) {
						layerResult = exrProcessor.processExrFromBuffer(fileData);
					} else if (ext.endsWith('.npy') || ext.endsWith('.npz')) {
						layerResult = npyProcessor.processNpyFromBuffer(fileData);
					} else if (ext.endsWith('.pfm')) {
						layerResult = pfmProcessor.processPfmFromBuffer(fileData);
					} else if (ext.endsWith('.ppm') || ext.endsWith('.pgm') || ext.endsWith('.pbm')) {
						layerResult = ppmProcessor.processPpmFromBuffer(fileData);
					} else if (ext.endsWith('.png') || ext.endsWith('.jpg') || ext.endsWith('.jpeg')) {
						layerResult = await pngProcessor.processPngFromBuffer(fileData, filename || '');
					}

					if (layerResult && layerResult.imageData) {
						let layerImageData = layerResult.imageData;
						if (layers.length > 0 && canvas) {
							if (layerImageData.width !== canvas.width || layerImageData.height !== canvas.height) {
								const tmpCanvas = document.createElement('canvas');
								tmpCanvas.width = canvas.width;
								tmpCanvas.height = canvas.height;
								const tmpCtx = tmpCanvas.getContext('2d');
								const srcCanvas = document.createElement('canvas');
								srcCanvas.width = layerImageData.width;
								srcCanvas.height = layerImageData.height;
								srcCanvas.getContext('2d').putImageData(layerImageData, 0, 0);
								tmpCtx.drawImage(srcCanvas, 0, 0, canvas.width, canvas.height);
								layerImageData = tmpCtx.getImageData(0, 0, canvas.width, canvas.height);
							}
						}
						const _layerStats = layerResult.stats || { min: 0, max: 1 };
						const _layerIsFloat = layerResult.isFloat !== false;
						const _layerTypeMax = layerResult.typeMax || (_layerIsFloat ? 1.0 : 255);
						const _layerChannels = layerResult.channels || 1;
						layers.push({
							id: layerId,
							name: filename || 'Layer ' + layers.length,
							visible: true,
							opacity: 1.0,
							imageData: layerImageData,
							rawData: layerResult.rawData || null,
							settings: {
								normalization: { min: _layerStats.min, max: _layerStats.max, autoNormalize: false, gammaMode: false },
								gamma: { in: 1.0, out: 1.0 },
								brightness: { offset: 0 }
							},
							stats: _layerStats,
							typeMax: _layerTypeMax,
							isFloat: _layerIsFloat,
							channels: _layerChannels,
							colormap: null
						});
						updateLayerListUI();
						compositeLayers();
					}
				} catch (err) {
					console.error('Failed to load layer:', err);
				}
				break;
			}
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
			if (exrProcessor) exrProcessor.rawExrData = null;
			if (npyProcessor) npyProcessor._lastRaw = null;
			if (ppmProcessor) ppmProcessor._lastRaw = null;
			if (pfmProcessor) pfmProcessor._lastRaw = null;
			if (pngProcessor) pngProcessor._lastRaw = null;

			// Update settings display
			vscode.postMessage({
				type: 'stats',
				value: { min: minValue, max: maxValue }
			});
			updateRangeSliderBounds(minValue, maxValue, 1.0, true);

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
				message: `Colormap conversion failed: ${error.message}`
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
			if (exrProcessor) exrProcessor.rawExrData = null;
			if (npyProcessor) npyProcessor._lastRaw = null;
			if (ppmProcessor) ppmProcessor._lastRaw = null;
			if (pfmProcessor) pfmProcessor._lastRaw = null;
			if (pngProcessor) pngProcessor._lastRaw = null;
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
				message: `Failed to revert to original image: ${error.message}`
			});
		}
	}

	/**
	 * Update image rendering with new settings
	 * @param {Object} changes - Changed settings
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
				vscode.setState({ scale: entry.scale, offsetX: window.scrollX, offsetY: window.scrollY });
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
			const createMenuItem = (text, action) => {
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
			menu.appendChild(createMenuItem('Copy', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'imageVisualizer.copyImage' });
			}));

			// Add Paste Position option (uses extension command for cross-webview support)
			menu.appendChild(createMenuItem('Paste Position', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'imageVisualizer.pastePosition' });
			}));

			// Add Export as PNG option (triggers command via extension)
			menu.appendChild(createMenuItem('Export as PNG', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'imageVisualizer.exportAsPng' });
			}));

			menu.appendChild(createSeparator());

			// Add Toggle Histogram option (triggers command via extension for logging)
			menu.appendChild(createMenuItem('Toggle Histogram', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'imageVisualizer.toggleHistogram' });
			}));

			// Check if image is RGB (3+ channels) for RGB-specific options
			// Only show for images that we know are RGB (need formatInfo)
			const isRgbImage = currentFormatInfo && currentFormatInfo.samplesPerPixel >= 3;

			if (isRgbImage) {
				menu.appendChild(createSeparator());

				// Add Convert Colormap to Float option (uses command - needs user input)
				menu.appendChild(createMenuItem('Convert Colormap to Float', () => {
					vscode.postMessage({ type: 'executeCommand', command: 'imageVisualizer.convertColormapToFloat' });
				}));
			}

			// Show revert option if a colormap conversion has been applied
			if (hasAppliedConversion) {
				menu.appendChild(createSeparator());

				menu.appendChild(createMenuItem('Revert to Original', () => {
					vscode.postMessage({ type: 'executeCommand', command: 'imageVisualizer.revertToOriginal' });
				}));
			}

			menu.appendChild(createSeparator());

			// Add Filter by Mask option (uses command - needs user input)
			menu.appendChild(createMenuItem('Filter by Mask (beta)', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'imageVisualizer.filterByMask' });
			}));


			menu.appendChild(createSeparator());

			// Add Open Comparison Panel option
			// menu.appendChild(createMenuItem('Open Comparison Panel', () => {
			// 	vscode.postMessage({ type: 'executeCommand', command: 'imageVisualizer.openComparisonPanel' });
			// }));

			// Add Toggle NaN Color option
			const currentNanColor = settingsManager.settings.nanColor || 'black';
			const nextNanColor = currentNanColor === 'black' ? 'fuchsia' : 'black';
			menu.appendChild(createMenuItem(`Show NaN Color as ${nextNanColor}`, () => {
				vscode.postMessage({ type: 'executeCommand', command: 'imageVisualizer.toggleNanColor' });
			}));

			// Add Toggle Color Picker Mode option - ONLY in Gamma Mode
			// In other modes, we always show original values
			const isGammaMode = settingsManager.settings.normalization && settingsManager.settings.normalization.gammaMode;
			if (isGammaMode) {
				const isShowingModified = settingsManager.settings.colorPickerShowModified || false;
				const nextColorMode = isShowingModified ? 'Original Values' : 'Modified Values';
				menu.appendChild(createMenuItem(`Color Picker: Show ${nextColorMode}`, () => {
					vscode.postMessage({ type: 'executeCommand', command: 'imageVisualizer.toggleColorPickerMode' });
				}));
			}
			document.body.appendChild(menu);

			// Remove menu when clicking outside
			const removeMenu = (event) => {
				if (!menu.contains(event.target)) {
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
			vscode.postMessage({ type: 'executeCommand', command: 'imageVisualizer.pastePosition' });
		});

		// Comparison toggle
		document.addEventListener('keydown', async (e) => {
			if (e.key === 'c' && peerImageData) {
				isShowingPeer = !isShowingPeer;
				const imageData = isShowingPeer ? peerImageData : primaryImageData;
				const ctx = canvas.getContext('2d');
				if (ctx && imageData) {
					await renderImageDataToCanvas(imageData, ctx);
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
				// 't' key to toggle forward through images
				if (e.key.toLowerCase() === 't') {
					e.preventDefault();
					vscode.postMessage({ type: 'toggleImage' });
				}
				// 'r' key to toggle backward through images
				else if (e.key.toLowerCase() === 'r') {
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
				<span class="image-counter">1 of 1</span>
				<span class="toggle-hint">Press 't'/'r' to navigate</span>
			</div>
		`;

		document.body.appendChild(overlayElement);
	}

	/**
	 * Create the in-webview control panel
	 */
	function createControlPanel() {
		const panel = document.createElement('div');
		panel.className = 'iv-panel';
		panel.id = 'iv-control-panel';

		// Header
		const header = document.createElement('div');
		header.className = 'iv-panel-header';
		header.innerHTML = `<span class="iv-panel-title">&#9776; Controls</span>`;
		const toggleBtn = document.createElement('button');
		toggleBtn.className = 'iv-panel-toggle';
		toggleBtn.textContent = '−';
		toggleBtn.title = 'Collapse panel';
		header.appendChild(toggleBtn);
		panel.appendChild(header);

		// Body
		const body = document.createElement('div');
		body.className = 'iv-panel-body';
		body.id = 'iv-panel-body';
		panel.appendChild(body);

		// Toggle collapse
		header.addEventListener('click', () => {
			panelCollapsed = !panelCollapsed;
			body.classList.toggle('iv-collapsed', panelCollapsed);
			toggleBtn.textContent = panelCollapsed ? '+' : '−';
		});

		// --- LAYERS section ---
		const layerSectionLabel = document.createElement('div');
		layerSectionLabel.className = 'iv-section-label';
		layerSectionLabel.textContent = 'Layers';
		body.appendChild(layerSectionLabel);

		const layerList = document.createElement('div');
		layerList.className = 'iv-layer-list';
		layerList.id = 'iv-layer-list';
		body.appendChild(layerList);

		const addLayerBtn = document.createElement('button');
		addLayerBtn.className = 'iv-add-layer-btn';
		addLayerBtn.textContent = '+ Add Layer';
		addLayerBtn.addEventListener('click', () => {
			vscode.postMessage({ type: 'requestAddLayer' });
		});
		body.appendChild(addLayerBtn);

		// --- ADJUSTMENTS section ---
		const adjSectionLabel = document.createElement('div');
		adjSectionLabel.className = 'iv-section-label';
		adjSectionLabel.textContent = 'Adjustments';
		body.appendChild(adjSectionLabel);

		// Colormap row
		const cmRow = createControlRow('Colormap', null);
		const cmSelect = document.createElement('select');
		cmSelect.className = 'iv-select';
		cmSelect.id = 'iv-colormap-select';
		// Add "None" option
		const noneOpt = document.createElement('option');
		noneOpt.value = '';
		noneOpt.textContent = 'None (gray)';
		cmSelect.appendChild(noneOpt);
		// Add colormap options
		for (const name of COLORMAP_NAMES) {
			if (name === 'gray') continue; // Skip gray, covered by None
			const opt = document.createElement('option');
			opt.value = name;
			opt.textContent = name.charAt(0).toUpperCase() + name.slice(1);
			cmSelect.appendChild(opt);
		}
		cmSelect.addEventListener('change', () => {
			const colormap = cmSelect.value || null;
			const layer = layers[activeLayerIndex];
			if (!layer) return;
			layer.colormap = colormap;
			applyLayerSettings(activeLayerIndex);
			vscode.postMessage({ type: 'layerSettingsChanged', colormap: colormap });
		});
		cmRow.querySelector('.iv-control-label').after(cmSelect);
		body.appendChild(cmRow);

		// Norm Min row
		const minRow = createSliderRow('Range Min', 'iv-norm-min', 0, 1, 0, 0.001, (val) => {
			const layer = layers[activeLayerIndex];
			if (!layer) return;
			// Switch to manual range mode so min/max values are actually used
			layer.settings.normalization.gammaMode = false;
			layer.settings.normalization.autoNormalize = false;
			layer.settings.normalization.min = parseFloat(val);
			applyLayerSettings(activeLayerIndex);
			vscode.postMessage({ type: 'layerSettingsChanged', normMin: parseFloat(val) });
		});
		body.appendChild(minRow);

		// Norm Max row
		const maxRow = createSliderRow('Range Max', 'iv-norm-max', 0, 1, 1, 0.001, (val) => {
			const layer = layers[activeLayerIndex];
			if (!layer) return;
			// Switch to manual range mode so min/max values are actually used
			layer.settings.normalization.gammaMode = false;
			layer.settings.normalization.autoNormalize = false;
			layer.settings.normalization.max = parseFloat(val);
			applyLayerSettings(activeLayerIndex);
			vscode.postMessage({ type: 'layerSettingsChanged', normMax: parseFloat(val) });
		});
		body.appendChild(maxRow);

		// Gamma row (single slider — sets gamma.out; gamma.in is always 1.0)
		const gammaRow = createSliderRow('Gamma', 'iv-gamma', 0.1, 5.0, 1.0, 0.01, (val) => {
			const layer = layers[activeLayerIndex];
			if (!layer) return;
			layer.settings.gamma.in = 1.0;
			layer.settings.gamma.out = parseFloat(val);
			applyLayerSettings(activeLayerIndex);
			vscode.postMessage({ type: 'layerSettingsChanged', gammaOut: parseFloat(val) });
		});
		const gammaDesc = document.createElement('div');
		gammaDesc.className = 'iv-control-desc';
		gammaDesc.textContent = 'output = input^\u03b3 \u2014 \u03b3<1 brighter, \u03b3>1 darker. Applied after range, before colormap.';
		const gammaGroup = document.createElement('div');
		gammaGroup.appendChild(gammaRow);
		gammaGroup.appendChild(gammaDesc);
		body.appendChild(gammaGroup);

		// Brightness row
		const brightnessRow = createSliderRow('Brightness', 'iv-brightness', -5.0, 5.0, 0, 0.1, (val) => {
			const layer = layers[activeLayerIndex];
			if (!layer) return;
			layer.settings.brightness.offset = parseFloat(val);
			applyLayerSettings(activeLayerIndex);
			vscode.postMessage({ type: 'layerSettingsChanged', brightness: parseFloat(val) });
		});
		body.appendChild(brightnessRow);

		document.body.appendChild(panel);
		return panel;
	}

	/**
	 * Create a control row with a label placeholder (for select/custom controls)
	 */
	function createControlRow(label, _unused) {
		const row = document.createElement('div');
		row.className = 'iv-control-row';
		const labelEl = document.createElement('span');
		labelEl.className = 'iv-control-label';
		labelEl.textContent = label;
		row.appendChild(labelEl);
		return row;
	}

	/**
	 * Create a slider control row
	 */
	function createSliderRow(label, id, min, max, value, step, onChange) {
		const row = document.createElement('div');
		row.className = 'iv-control-row';

		const labelEl = document.createElement('span');
		labelEl.className = 'iv-control-label';
		labelEl.textContent = label;
		row.appendChild(labelEl);

		const slider = document.createElement('input');
		slider.type = 'range';
		slider.className = 'iv-slider';
		slider.id = id;
		slider.min = min;
		slider.max = max;
		slider.value = value;
		slider.step = step;
		row.appendChild(slider);

		const valueEl = document.createElement('span');
		valueEl.className = 'iv-control-value';
		valueEl.id = id + '-val';
		valueEl.textContent = value.toFixed(step < 0.1 ? 3 : 1);
		row.appendChild(valueEl);

		slider.addEventListener('input', () => {
			const v = slider.value;
			valueEl.textContent = parseFloat(v).toFixed(step < 0.1 ? 3 : 1);
			onChange(v);
		});

		return row;
	}

	/**
	 * Update range slider bounds to match the loaded image's data range.
	 * For float images: slider spans [statsMin, statsMax].
	 * For integer images: slider spans [0, typeMax].
	 * Also initialises the slider values to show the full range (no clipping by default).
	 * @param {number} statsMin - Minimum value in image data
	 * @param {number} statsMax - Maximum value in image data
	 * @param {number} typeMax - Maximum for data type (255, 65535, or 1.0 for float)
	 * @param {boolean} isFloat - Whether the image is floating-point
	 */
	function updateRangeSliderBounds(statsMin, statsMax, typeMax, isFloat) {
		const lo = isFloat ? statsMin : 0;
		const hi = isFloat ? statsMax : typeMax;
		const range = hi - lo;
		const step = range > 0 ? range / 1000 : 0.001;
		const decimals = isFloat ? 4 : 0;

		const minSlider = document.getElementById('iv-norm-min');
		const maxSlider = document.getElementById('iv-norm-max');
		const minVal = document.getElementById('iv-norm-min-val');
		const maxVal = document.getElementById('iv-norm-max-val');

		if (minSlider) {
			minSlider.min = lo;
			minSlider.max = hi;
			minSlider.step = step;
			minSlider.value = lo;
			if (minVal) minVal.textContent = isFloat ? lo.toFixed(decimals) : String(Math.round(lo));
		}
		if (maxSlider) {
			maxSlider.min = lo;
			maxSlider.max = hi;
			maxSlider.step = step;
			maxSlider.value = hi;
			if (maxVal) maxVal.textContent = isFloat ? hi.toFixed(decimals) : String(Math.round(hi));
		}
	}

	/**
	 * Apply the active layer's settings to the rendered output.
	 * For layer 0 (base): syncs settings to AppStateManager and triggers re-render via existing path.
	 * For additional layers: re-renders from stored raw data directly.
	 * @param {number} layerIndex - Index into the layers array
	 */
	function applyLayerSettings(layerIndex) {
		if (!hasLoadedImage) return;

		const hasPendingRender = tiffProcessor._pendingRenderData ||
			(npyProcessor && npyProcessor._pendingRenderData) ||
			(pngProcessor && pngProcessor._pendingRenderData) ||
			(ppmProcessor && ppmProcessor._pendingRenderData) ||
			(pfmProcessor && pfmProcessor._pendingRenderData) ||
			(exrProcessor && exrProcessor._pendingRenderData);
		if (hasPendingRender) return;

		if (layerIndex === 0) {
			// Base layer: sync per-layer settings to global settingsManager so processors pick them up
			const layer = layers[0];
			if (layer && layer.settings) {
				Object.assign(settingsManager.settings.normalization, layer.settings.normalization);
				settingsManager.settings.gamma.in = layer.settings.gamma.in;
				settingsManager.settings.gamma.out = layer.settings.gamma.out;
				settingsManager.settings.brightness.offset = layer.settings.brightness.offset;
				settingsManager.settings.colormap = layer.colormap || null;
			}
			updateImageWithNewSettings({ parametersOnly: true, changedMasks: false, changedStructure: false })
				.then(() => {
					if (layers[0]) layers[0].imageData = primaryImageData;
					if (layers.length > 1) compositeLayers();
				});
		} else {
			// Additional layer: re-render from stored raw data
			rerenderAdditionalLayer(layerIndex);
			compositeLayers();
		}
	}

	/**
	 * Re-render an additional layer (index > 0) from its stored raw data using its per-layer settings.
	 * @param {number} i - Layer index (must be > 0)
	 */
	function rerenderAdditionalLayer(i) {
		const layer = layers[i];
		if (!layer || !layer.rawData) return;
		layer.imageData = ImageRenderer.render(
			layer.rawData, layer.width, layer.height, layer.channels,
			layer.isFloat, layer.stats, layer.settings,
			{ typeMax: layer.typeMax, colormap: layer.colormap }
		);
	}

	/**
	 * Update the control panel sliders/selects to match current settings
	 */
	function syncPanelToSettings(settings, colormap) {
		if (!settings) return;

		// Colormap — use explicit colormap arg when provided (layer.colormap lives outside layer.settings)
		const cmSelect = document.getElementById('iv-colormap-select');
		if (cmSelect) {
			cmSelect.value = (colormap !== undefined ? colormap : settings.colormap) || '';
			// Enable only for single-channel images
			cmSelect.disabled = currentChannels !== 1;
		}

		// Norm min/max
		if (settings.normalization) {
			const minSlider = document.getElementById('iv-norm-min');
			const maxSlider = document.getElementById('iv-norm-max');
			const minVal = document.getElementById('iv-norm-min-val');
			const maxVal = document.getElementById('iv-norm-max-val');

			if (!settings.normalization.autoNormalize) {
				if (minSlider) {
					const v = parseFloat(settings.normalization.min) || 0;
					if (v < parseFloat(minSlider.min)) minSlider.min = v;
					if (v > parseFloat(minSlider.max)) minSlider.max = v;
					minSlider.value = v;
					if (minVal) minVal.textContent = v.toFixed(3);
				}
				if (maxSlider) {
					const v = parseFloat(settings.normalization.max) || 1;
					if (v < parseFloat(maxSlider.min)) maxSlider.min = v;
					if (v > parseFloat(maxSlider.max)) maxSlider.max = v;
					maxSlider.value = v;
					if (maxVal) maxVal.textContent = v.toFixed(3);
				}
			}
		}

		// Gamma (single slider — reflects gamma.out)
		if (settings.gamma) {
			const gammaSlider = document.getElementById('iv-gamma');
			const gammaVal = document.getElementById('iv-gamma-val');
			if (gammaSlider) {
				gammaSlider.value = settings.gamma.out;
				if (gammaVal) gammaVal.textContent = parseFloat(settings.gamma.out).toFixed(2);
			}
		}

		// Brightness
		if (settings.brightness !== undefined) {
			const bSlider = document.getElementById('iv-brightness');
			const bVal = document.getElementById('iv-brightness-val');
			if (bSlider) {
				bSlider.value = settings.brightness.offset || 0;
				if (bVal) bVal.textContent = parseFloat(settings.brightness.offset || 0).toFixed(1);
			}
		}
	}

	/**
	 * Update the layer list UI
	 */
	function updateLayerListUI() {
		const layerList = document.getElementById('iv-layer-list');
		if (!layerList) return;
		layerList.innerHTML = '';

		layers.forEach((layer, i) => {
			const entry = document.createElement('div');
			entry.className = 'iv-layer-entry' + (i === activeLayerIndex ? ' iv-layer-active' : '');

			// Visibility checkbox
			const visCheck = document.createElement('input');
			visCheck.type = 'checkbox';
			visCheck.className = 'iv-layer-vis';
			visCheck.checked = layer.visible;
			visCheck.title = 'Toggle visibility';
			visCheck.addEventListener('change', () => {
				layers[i].visible = visCheck.checked;
				compositeLayers();
			});
			entry.appendChild(visCheck);

			// Name
			const nameEl = document.createElement('span');
			nameEl.className = 'iv-layer-name';
			nameEl.textContent = layer.name;
			nameEl.title = layer.name;
			nameEl.addEventListener('click', () => {
				activeLayerIndex = i;
				updateLayerListUI();
				// Sync panel controls to the newly selected layer's settings
				if (layers[i] && layers[i].settings) {
					syncPanelToSettings(layers[i].settings);
					const cmSelect = document.getElementById('iv-colormap-select');
					if (cmSelect) {
						cmSelect.value = layers[i].colormap || '';
						cmSelect.disabled = (layers[i].channels || 1) !== 1;
					}
					if (layers[i].stats) {
						updateRangeSliderBounds(
							layers[i].stats.min, layers[i].stats.max,
							layers[i].typeMax || 1.0, layers[i].isFloat !== false
						);
					}
				}
			});
			entry.appendChild(nameEl);

			// Opacity slider
			const opSlider = document.createElement('input');
			opSlider.type = 'range';
			opSlider.className = 'iv-layer-opacity';
			opSlider.min = 0;
			opSlider.max = 1;
			opSlider.step = 0.05;
			opSlider.value = layer.opacity;
			opSlider.title = `Opacity: ${Math.round(layer.opacity * 100)}%`;
			opSlider.addEventListener('input', () => {
				layers[i].opacity = parseFloat(opSlider.value);
				opSlider.title = `Opacity: ${Math.round(layers[i].opacity * 100)}%`;
				compositeLayers();
			});
			entry.appendChild(opSlider);

			// Delete button (not for base layer)
			if (i > 0) {
				const delBtn = document.createElement('button');
				delBtn.className = 'iv-layer-delete';
				delBtn.textContent = '×';
				delBtn.title = 'Remove layer';
				delBtn.addEventListener('click', () => {
					const removedId = layers[i].id;
					layers.splice(i, 1);
					if (activeLayerIndex >= layers.length) activeLayerIndex = layers.length - 1;
					updateLayerListUI();
					compositeLayers();
					vscode.postMessage({ type: 'removeLayer', layerId: removedId });
				});
				entry.appendChild(delBtn);
			}

			layerList.appendChild(entry);
		});
	}

	/**
	 * Composite all visible layers onto the canvas
	 */
	async function compositeLayers() {
		if (!canvas || layers.length === 0) return;

		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) return;

		// Clear canvas
		ctx.clearRect(0, 0, canvas.width, canvas.height);

		for (const layer of layers) {
			if (!layer.visible || !layer.imageData) continue;

			// Use OffscreenCanvas if available, else fallback to ImageData
			try {
				const offscreen = new OffscreenCanvas(layer.imageData.width, layer.imageData.height);
				const offCtx = offscreen.getContext('2d');
				offCtx.putImageData(layer.imageData, 0, 0);
				ctx.globalAlpha = layer.opacity;
				ctx.drawImage(offscreen, 0, 0);
			} catch (e) {
				// Fallback: just put image data (no opacity blending)
				ctx.putImageData(layer.imageData, 0, 0);
			}
		}
		ctx.globalAlpha = 1.0;

		// Update histogram
		updateHistogramData();
	}

	/**
	 * Update image collection overlay
	 */
	function updateImageCollectionOverlay(data) {
		if (!overlayElement) return;

		imageCollection = data;

		if (data.show && data.totalImages > 1) {
			const counter = overlayElement.querySelector('.image-counter');
			if (counter) {
				counter.textContent = `${data.currentIndex + 1} of ${data.totalImages}`;
			}
			overlayElement.style.display = 'block';
		} else {
			overlayElement.style.display = 'none';
		}
	}

	/**
	 * Switch to a new image in the collection (legacy - for fallback)
	 */
	function switchToNewImage(uri, resourceUri) {
		// Update the settings with the new resource URI
		settingsManager.settings.resourceUri = resourceUri;
		settingsManager.settings.src = uri;

		// Reset the state
		hasLoadedImage = false;
		canvas = null;
		imageElement = null;
		primaryImageData = null;

		// Clear the container
		const container = document.body;
		container.className = 'container';

		// Remove any existing image/canvas elements
		const existingImages = container.querySelectorAll('img, canvas');
		existingImages.forEach(el => el.remove());

		// Show loading state
		container.classList.add('loading');

		// Load the new image based on file type
		loadImageByType(uri, resourceUri);
	}

	/**
	 * Load image by type (wrapper function)
	 */
	function loadImageByType(uri, resourceUri) {
		const lower = resourceUri.toLowerCase();
		if (lower.endsWith('.tif') || lower.endsWith('.tiff')) {
			handleTiff(uri);
		} else if (lower.endsWith('.pfm')) {
			handlePfm(uri);
		} else if (lower.endsWith('.ppm') || lower.endsWith('.pgm') || lower.endsWith('.pbm')) {
			handlePpm(uri);
		} else if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
			handlePng(uri);
		} else if (lower.endsWith('.npy') || lower.endsWith('.npz')) {
			handleNpy(uri);
		} else {
			// Fallback to regular image loading
			const newImage = document.createElement('img');
			newImage.classList.add('scale-to-fit');
			newImage.src = uri;

			newImage.addEventListener('load', () => {
				if (hasLoadedImage) return;

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
				if (hasLoadedImage) return;
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
			setTimeout(() => { copyImage(retries - 1); }, 20);
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
			showNotification(`Failed to copy image: ${e.message}`, 'error');
		}
	}

	/**
	 * Paste position from previously copied state
	 * Scales the position for images of different sizes
	 * @param {Object} positionState - Position state (from extension for cross-webview, or local)
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
			
			targetScale = state.scale * scaleRatio;
			
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
				const rect = imageElement.getBoundingClientRect();
				const elemLeftDoc = window.scrollX + rect.left;
				const elemTopDoc = window.scrollY + rect.top;
				
				// Calculate where the target center should be in document coordinates
				const targetDocX = elemLeftDoc + targetCenterX * targetScale;
				const targetDocY = elemTopDoc + targetCenterY * targetScale;
				
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
	 */
	async function handleStartComparison(peerUri) {
		try {
			vscode.postMessage({ type: 'show-loading' });


			// Track peer URI for state persistence
			if (!peerImageUris.includes(peerUri)) {
				peerImageUris.push(peerUri);
			}

			const result = await tiffProcessor.processTiff(peerUri);
			peerImageData = result.imageData;

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
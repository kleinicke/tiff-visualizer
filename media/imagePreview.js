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
import { ColormapConverter } from './modules/colormap-converter.js';

/**
 * Main Image Preview Application
 * Orchestrates all modules to provide image viewing functionality
 */
(function () {
	// @ts-ignore
	const vscode = acquireVsCodeApi();
	
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
	
	// Colormap conversion state
	let colormapConversionState = null;

	// Restore persisted state if available
	const persistedState = vscode.getState();
	if (persistedState) {
		peerImageUris = persistedState.peerImageUris || [];
		isShowingPeer = persistedState.isShowingPeer || false;
		colormapConversionState = persistedState.colormapConversionState || null;
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
		setupImageLoading();
		setupMessageHandling();
		setupEventListeners();
		createImageCollectionOverlay();

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
	 * Reload image when file changes on disk (preserves zoom state)
	 * @param {any} savedZoomState - The zoom state to restore after reload
	 */
	function reloadImage(savedZoomState) {
		// Reset the state
		hasLoadedImage = false;
		canvas = null;
		imageElement = null;
		primaryImageData = null;
		peerImageData = null;

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

		// Track whether we should restore zoom
		const shouldRestoreZoom = savedZoomState && savedZoomState.scale !== 'fit';

		// Store the zoom state to restore after image loads
		if (shouldRestoreZoom) {
			// Wait for image to load, then restore zoom
			const checkAndRestore = setInterval(() => {
				// @ts-ignore - imageElement is set during image loading
				if (hasLoadedImage && imageElement) {
					clearInterval(checkAndRestore);
					setTimeout(() => {
						zoomController.restoreState(savedZoomState);
					}, 100);
				}
			}, 50);

			// Safety timeout to prevent infinite checking
			setTimeout(() => clearInterval(checkAndRestore), 5000);
		}

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
	 * Handle successful image load
	 */
	function onImageLoaded() {
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
		try {
			const result = await tiffProcessor.processTiff(src);
			
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;

			// Draw the processed image data to canvas
			const ctx = canvas.getContext('2d');
			if (ctx) {
				ctx.putImageData(primaryImageData, 0, 0);
			}

			hasLoadedImage = true;
			finalizeImageSetup();

		} catch (error) {
			console.error('Error handling TIFF:', error);
			onImageError();
		}
	}

	/**
	 * Handle EXR file loading
	 */
	async function handleExr(src) {
		try {
			const result = await exrProcessor.processExr(src);

			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;

			// Draw the processed image data to canvas
			const ctx = canvas.getContext('2d');
			if (ctx) {
				ctx.putImageData(primaryImageData, 0, 0);
			}

			hasLoadedImage = true;
			finalizeImageSetup();

		} catch (error) {
			console.error('Error handling EXR:', error);
			onImageError();
		}
	}

	/**
	 * Handle PFM file loading
	 */
	async function handlePfm(src) {
		try {
			const result = await pfmProcessor.processPfm(src);
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				ctx.putImageData(primaryImageData, 0, 0);
			}
			hasLoadedImage = true;
			finalizeImageSetup();
		} catch (error) {
			console.error('Error handling PFM:', error);
			onImageError();
		}
	}

	/**
	 * Handle PPM/PGM file loading
	 */
	async function handlePpm(src) {
		try {
			const result = await ppmProcessor.processPpm(src);
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				ctx.putImageData(primaryImageData, 0, 0);
			}
			hasLoadedImage = true;
			finalizeImageSetup();
		} catch (error) {
			console.error('Error handling PPM/PGM:', error);
			onImageError();
		}
	}

	/**
	 * Handle PNG/JPEG file loading
	 */
	async function handlePng(src) {
		try {
			const result = await pngProcessor.processPng(src);
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				ctx.putImageData(primaryImageData, 0, 0);
			}
			hasLoadedImage = true;
			finalizeImageSetup();
		} catch (error) {
			console.error('Error handling PNG/JPEG:', error);
			onImageError();
		}
	}

	/**
	 * Handle NPY/NPZ file loading
	 */
	async function handleNpy(src) {
		try {
			const result = await npyProcessor.processNpy(src);
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = canvas.getContext('2d');
			if (ctx) {
				ctx.putImageData(primaryImageData, 0, 0);
			}
			hasLoadedImage = true;
			finalizeImageSetup();
		} catch (error) {
			console.error('Error handling NPY/NPZ:', error);
			onImageError();
		}
	}

	/**
	 * Finalize image setup after loading
	 */
	function finalizeImageSetup() {
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

		// Update histogram if visible
		updateHistogramData();
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
					}

					if (deferredImageData) {
						const ctx = canvas.getContext('2d');
						if (ctx) {
							ctx.putImageData(deferredImageData, 0, 0);
							primaryImageData = deferredImageData;
							updateHistogramData();
						}
					}
				}
				// If resource URI changed, reload the entire image
				else if (oldResourceUri !== newResourceUri) {
					// Save current zoom state before reloading (for file recreation case)
					const currentZoomState = zoomController.getCurrentState();

					// Reload the image without reinitializing event listeners
					reloadImage(currentZoomState);
				} else {
					// Update rendering with new settings, using optimization hints
					updateImageWithNewSettings(changes);
				}
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
		}
	}

	/**
	 * Update histogram with current image data
	 */
	function updateHistogramData() {
		if (!canvas || !hasLoadedImage) {
			return;
		}

		try {
			const ctx = canvas.getContext('2d');
			if (!ctx) return;

			// Get current image data from canvas
			const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

			// Update histogram overlay
			histogramOverlay.update(imageData);
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
			const ctx = canvas.getContext('2d');
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
			ctx.putImageData(floatImageData, 0, 0);
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

			// Send format info
			vscode.postMessage({
				type: 'formatInfo',
				value: {
					width: width,
					height: height,
					bitsPerSample: 32,
					sampleFormat: 3, // Float
					samplesPerPixel: 1,
					formatType: 'colormap-converted',
					isInitialLoad: false
				}
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
	 * Update image rendering with new settings
	 * @param {Object} changes - What changed in settings (from settingsManager.updateSettings)
	 */
	async function updateImageWithNewSettings(changes) {
		if (!canvas || !hasLoadedImage) {
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
						ctx.putImageData(newImageData, 0, 0);
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
					ctx.putImageData(newImageData, 0, 0);
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
						ctx.putImageData(newImageData, 0, 0);
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
		else if (primaryImageData && ppmProcessor && ppmProcessor._lastRaw) {
			try {
				// Re-render the PGM with current settings
				const newImageData = ppmProcessor.renderPgmWithSettings();

				if (newImageData) {
					// Update the canvas with new image data
					const ctx = canvas.getContext('2d');
					if (ctx) {
						ctx.putImageData(newImageData, 0, 0);
						primaryImageData = newImageData;
						updateHistogramData();
					}
				}
			} catch (error) {
				console.error('Error updating PGM image with new settings:', error);
			}
		}
		// For NPY images, re-render with new settings
		else if (primaryImageData && npyProcessor && npyProcessor._lastRaw) {
			try {
				// Re-render the NPY with current settings
				const newImageData = npyProcessor.renderNpyWithSettings();

				if (newImageData) {
					// Update the canvas with new image data
					const ctx = canvas.getContext('2d');
					if (ctx) {
						ctx.putImageData(newImageData, 0, 0);
						primaryImageData = newImageData;
						updateHistogramData();
					}
				}
			} catch (error) {
				console.error('Error updating NPY image with new settings:', error);
			}
		}
		// For PNG/JPEG images, re-render with new settings
		else if (primaryImageData && pngProcessor && pngProcessor._lastRaw) {
			try {
				// Re-render the PNG with current settings
				const newImageData = pngProcessor.renderPngWithSettings();

				if (newImageData) {
					// Update the canvas with new image data
					const ctx = canvas.getContext('2d');
					if (ctx) {
						ctx.putImageData(newImageData, 0, 0);
						primaryImageData = newImageData;
					}
				}
			} catch (error) {
				console.error('Error updating PNG/JPEG image with new settings:', error);
			}
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

		// Comparison toggle
		document.addEventListener('keydown', (e) => {
			if (e.key === 'c' && peerImageData) {
				isShowingPeer = !isShowingPeer;
				const imageData = isShowingPeer ? peerImageData : primaryImageData;
				const ctx = canvas.getContext('2d');
				if (ctx && imageData) {
					ctx.putImageData(imageData, 0, 0);
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
		}
	}

	/**
	 * Copy image to clipboard
	 */
	async function copyImage(retries = 5) {
		if (!document.hasFocus() && retries > 0) {
			setTimeout(() => { copyImage(retries - 1); }, 20);
			return;
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
		} catch (e) {
			console.error('Copy failed:', e);
		}
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
// @ts-check
"use strict";

import { SettingsManager } from './modules/settings-manager.js';
import { TiffProcessor } from './modules/tiff-processor.js';
import { ZoomController } from './modules/zoom-controller.js';
import { MouseHandler } from './modules/mouse-handler.js';

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
	const zoomController = new ZoomController(settingsManager, vscode);
	const mouseHandler = new MouseHandler(settingsManager, vscode, tiffProcessor);

	// Application state
	let hasLoadedImage = false;
	let canvas = null;
	let imageElement = null;
	let primaryImageData = null;
	let peerImageData = null;
	let isShowingPeer = false;

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
		
		// Start loading the image
		const settings = settingsManager.settings;
		const resourceUri = settings.resourceUri;
		
		if (resourceUri.toLowerCase().endsWith('.tif') || resourceUri.toLowerCase().endsWith('.tiff')) {
			handleTiff(settings.src);
		} else {
			image.src = settings.src;
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
	}

	/**
	 * Setup VS Code message handling
	 */
	function setupMessageHandling() {
		window.addEventListener('message', (e) => {
			if (e.origin !== window.origin) {
				console.error('Dropping message from unknown origin in image preview');
				return;
			}

			handleVSCodeMessage(e.data);
		});

		// Send ready message to VS Code
		vscode.postMessage({ type: 'get-initial-data' });
	}

	/**
	 * Handle messages from VS Code
	 */
	function handleVSCodeMessage(message) {
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
				settingsManager.updateSettings(message.settings);
				updateImageWithNewSettings();
				break;
			
			case 'mask-filter-settings':
				// Handle mask filter settings updates
				settingsManager.updateSettings(message.settings);
				updateImageWithNewSettings();
				break;
		}
	}

	/**
	 * Update image rendering with new settings
	 */
	async function updateImageWithNewSettings() {
		if (!canvas || !hasLoadedImage) return;

		// For TIFF images, re-render with new settings
		if (primaryImageData && tiffProcessor.rawTiffData) {
			try {
				console.log('Updating image with new settings:', settingsManager.settings);
				
				// Re-render the TIFF with current settings
				const newImageData = await tiffProcessor.renderTiffWithSettings(
					tiffProcessor.rawTiffData.image,
					tiffProcessor.rawTiffData.rasters
				);
				
				// Update the canvas with new image data
				const ctx = canvas.getContext('2d');
				if (ctx && newImageData) {
					ctx.putImageData(newImageData, 0, 0);
					primaryImageData = newImageData;
					console.log('Image updated with new settings');
				}
			} catch (error) {
				console.error('Error updating image with new settings:', error);
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
			}
		});

		// Error link handling
		document.querySelector('.open-file-link')?.addEventListener('click', (e) => {
			e.preventDefault();
			vscode.postMessage({ type: 'reopen-as-text' });
		});

		// Window beforeunload
		window.addEventListener('beforeunload', () => {
			zoomController.saveState();
		});
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
			const result = await tiffProcessor.processTiff(peerUri);
			peerImageData = result.imageData;
			vscode.postMessage({ type: 'comparison-ready' });
		} catch (error) {
			console.error('Failed to load peer image for comparison:', error);
			vscode.postMessage({ type: 'show-error', message: 'Failed to load comparison image.' });
		}
	}

	// Start the application
	initialize();
}()); 
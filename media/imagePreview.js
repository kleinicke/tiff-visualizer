// @ts-check
"use strict";

import { SettingsManager } from './modules/settings-manager.js';
import { TiffProcessor } from './modules/tiff-processor.js';
import { NpyProcessor } from './modules/npy-processor.js';
import { PfmProcessor } from './modules/pfm-processor.js';
import { PpmProcessor } from './modules/ppm-processor.js';
import { PngProcessor } from './modules/png-processor.js';
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
	const npyProcessor = new NpyProcessor(settingsManager, vscode);
	const pfmProcessor = new PfmProcessor(settingsManager, vscode);
	const ppmProcessor = new PpmProcessor(settingsManager, vscode);
	const pngProcessor = new PngProcessor(settingsManager, vscode);
	mouseHandler.setNpyProcessor(npyProcessor);
	mouseHandler.setPfmProcessor(pfmProcessor);
	mouseHandler.setPpmProcessor(ppmProcessor);
	mouseHandler.setPngProcessor(pngProcessor);

	// Application state
	let hasLoadedImage = false;
	let canvas = null;
	let imageElement = null;
	let primaryImageData = null;
	let peerImageData = null;
	let isShowingPeer = false;
	
	// Image collection state
	let imageCollection = {
		totalImages: 1,
		currentIndex: 0,
		show: false
	};
	let overlayElement = null;
	
	// Global image cache for instant switching (shared across all instances)
	window.tiffVisualizerImageCache = window.tiffVisualizerImageCache || new Map();
	let imageCache = window.tiffVisualizerImageCache; // cacheKey -> { canvas, imageData, metadata }

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
		
		// Start loading the image
		const settings = settingsManager.settings;
		const resourceUri = settings.resourceUri;
		
		// Check if this image is already cached
		if (imageCache.has(resourceUri)) {
			console.log('Loading from cache:', resourceUri);
			loadFromCache(resourceUri);
		} else {
			console.log('Loading fresh:', resourceUri);
			// Load fresh and cache the result
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
				image.src = settings.src;
			}
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

		// Cache the current image if it's not already cached
		cacheCurrentImage();

		// Apply initial zoom and setup mouse handling
		zoomController.applyInitialZoom();
		mouseHandler.addMouseListeners(imageElement);
	}

	/**
	 * Load image from cache for instant display
	 */
	function loadFromCache(resourceUri) {
		const cachedData = imageCache.get(resourceUri);
		if (!cachedData) {
			console.error('Cache miss for:', resourceUri);
			return;
		}
		
		console.log('Loading from cache:', resourceUri);
		
		// Use cached data directly
		canvas = cachedData.canvas.cloneNode(true);
		canvas.classList.add('scale-to-fit');
		primaryImageData = cachedData.imageData;
		imageElement = canvas;
		
		// Apply cached image data to canvas
		const ctx = canvas.getContext('2d');
		if (ctx && primaryImageData) {
			ctx.putImageData(primaryImageData, 0, 0);
		}
		
		hasLoadedImage = true;
		finalizeImageSetup();
	}

	/**
	 * Cache the currently loaded image
	 */
	function cacheCurrentImage() {
		const settings = settingsManager.settings;
		const cacheKey = settings.resourceUri;
		
		if (!imageCache.has(cacheKey) && canvas && primaryImageData) {
			console.log('Caching current image:', settings.resourceUri);
			
			// Manage cache size (limit to 10 images to prevent memory issues)
			if (imageCache.size >= 10) {
				// Remove oldest cached image
				const oldestKey = Array.from(imageCache.keys())[0];
				imageCache.delete(oldestKey);
				console.log('Cache limit reached, removed oldest:', oldestKey);
			}
			
			imageCache.set(cacheKey, {
				canvas: canvas.cloneNode(true),
				imageData: primaryImageData,
				metadata: {
					uri: settings.src,
					resourceUri: settings.resourceUri,
					timestamp: Date.now()
				}
			});
			
			console.log('Cache size:', imageCache.size);
		}
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
				// Update cached images with new settings
				updateCachedImagesWithNewSettings();
				break;
			
			case 'mask-filter-settings':
				// Handle mask filter settings updates
				settingsManager.updateSettings(message.settings);
				updateImageWithNewSettings();
				// Update cached images with new settings
				updateCachedImagesWithNewSettings();
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
				
			case 'restoreZoomState':
				// Restore zoom state after image change
				if (message.state) {
					zoomController.restoreState(message.state);
				}
				break;
				
			case 'switchToImage':
				// Switch to a new image in the collection (legacy)
				switchToNewImage(message.uri, message.resourceUri);
				break;
				
			case 'switchToImageFromCache':
				// Switch using cached data if available
				switchToImageFromCache(message.cacheKey, message.uri, message.resourceUri, message.isPreloaded);
				break;
				
			case 'preloadImage':
				// Preload image in background
				preloadImageInBackground(message.cacheKey, message.uri, message.resourceUri);
				break;
				
			case 'cacheCurrentImage':
				// Cache the currently displayed image
				cacheCurrentImage();
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
				console.log('Updating TIFF image with new settings:', settingsManager.settings);
				
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
					console.log('TIFF image updated with new settings');
				}
			} catch (error) {
				console.error('Error updating TIFF image with new settings:', error);
			}
		}
		
		// For PGM images, re-render with new settings
		if (primaryImageData && ppmProcessor) {
			try {
				console.log('Updating PGM image with new settings:', settingsManager.settings);
				
				// Re-render the PGM with current settings
				const newImageData = ppmProcessor.renderPgmWithSettings();
				
				if (newImageData) {
					// Update the canvas with new image data
					const ctx = canvas.getContext('2d');
					if (ctx) {
						ctx.putImageData(newImageData, 0, 0);
						primaryImageData = newImageData;
						console.log('PGM image updated with new settings');
					}
				}
			} catch (error) {
				console.error('Error updating PGM image with new settings:', error);
			}
		}
		
		// For PNG/JPEG images, re-render with new settings
		if (primaryImageData && pngProcessor) {
			try {
				console.log('Updating PNG/JPEG image with new settings:', settingsManager.settings);
				
				// Re-render the PNG with current settings
				const newImageData = pngProcessor.renderPngWithSettings();
				
				if (newImageData) {
					// Update the canvas with new image data
					const ctx = canvas.getContext('2d');
					if (ctx) {
						ctx.putImageData(newImageData, 0, 0);
						primaryImageData = newImageData;
						console.log('PNG/JPEG image updated with new settings');
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
	 * Switch to image using cached data for instant switching
	 */
	function switchToImageFromCache(cacheKey, uri, resourceUri, isPreloaded) {
		// Update settings
		settingsManager.settings.resourceUri = resourceUri;
		settingsManager.settings.src = uri;
		
		if (isPreloaded && imageCache.has(cacheKey)) {
			// Use cached data for instant switch
			const cachedData = imageCache.get(cacheKey);
			
			// Reset state
			hasLoadedImage = false;
			
			// Clear container
			const container = document.body;
			container.className = 'container';
			const existingImages = container.querySelectorAll('img, canvas');
			existingImages.forEach(el => el.remove());
			
			// Use cached canvas and data
			canvas = cachedData.canvas.cloneNode(true);
			canvas.classList.add('scale-to-fit');
			primaryImageData = cachedData.imageData;
			imageElement = canvas;
			
			// Apply cached image data to canvas
			const ctx = canvas.getContext('2d');
			if (ctx && primaryImageData) {
				ctx.putImageData(primaryImageData, 0, 0);
			}
			
			hasLoadedImage = true;
			finalizeImageSetup();
		} else {
			// Not preloaded yet, load normally and cache the result
			switchToNewImage(uri, resourceUri);
		}
	}

	/**
	 * Preload image in background for instant switching
	 */
	async function preloadImageInBackground(cacheKey, uri, resourceUri) {
		if (imageCache.has(cacheKey)) {
			return; // Already cached
		}
		
		try {
			console.log('Preloading image:', resourceUri);
			
			// Load and process the image based on type
			const result = await loadAndProcessImage(uri, resourceUri);
			
			if (result) {
				// Cache the processed result
				imageCache.set(cacheKey, {
					canvas: result.canvas.cloneNode(true),
					imageData: result.imageData,
					metadata: {
						uri: uri,
						resourceUri: resourceUri,
						timestamp: Date.now()
					}
				});
				
				console.log('Image preloaded and cached:', resourceUri);
				
				// Notify extension that preloading is complete
				vscode.postMessage({
					type: 'imagePreloaded',
					cacheKey: cacheKey
				});
			}
		} catch (error) {
			console.error('Failed to preload image:', resourceUri, error);
		}
	}

	/**
	 * Load and process image by type (helper function)
	 */
	async function loadAndProcessImage(uri, resourceUri) {
		const lower = resourceUri.toLowerCase();
		
		if (lower.endsWith('.tif') || lower.endsWith('.tiff')) {
			return await tiffProcessor.processTiff(uri);
		} else if (lower.endsWith('.pfm')) {
			return await pfmProcessor.processPfm(uri);
		} else if (lower.endsWith('.ppm') || lower.endsWith('.pgm') || lower.endsWith('.pbm')) {
			return await ppmProcessor.processPpm(uri);
		} else if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
			return await pngProcessor.processPng(uri);
		} else if (lower.endsWith('.npy') || lower.endsWith('.npz')) {
			return await npyProcessor.processNpy(uri);
		} else {
			// Fallback to regular image loading
			return await loadRegularImage(uri);
		}
	}

	/**
	 * Load regular image and convert to canvas/imageData
	 */
	function loadRegularImage(uri) {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				const canvas = document.createElement('canvas');
				canvas.width = img.naturalWidth;
				canvas.height = img.naturalHeight;
				
				const ctx = canvas.getContext('2d');
				if (ctx) {
					ctx.drawImage(img, 0, 0);
					const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
					resolve({ canvas, imageData });
				} else {
					reject(new Error('Could not get canvas context'));
				}
			};
			img.onerror = () => reject(new Error('Failed to load image'));
			img.src = uri;
		});
	}

	/**
	 * Update all cached images with new settings
	 */
	async function updateCachedImagesWithNewSettings() {
		console.log('Updating cached images with new settings...');
		
		// Get all cached images
		const cacheEntries = Array.from(imageCache.entries());
		
		for (const [cacheKey, cachedData] of cacheEntries) {
			try {
				console.log('Re-processing cached image:', cachedData.metadata.resourceUri);
				
				// Re-process the image with new settings
				const result = await loadAndProcessImage(cachedData.metadata.uri, cachedData.metadata.resourceUri);
				
				if (result) {
					// Update the cache with new processed data
					imageCache.set(cacheKey, {
						canvas: result.canvas.cloneNode(true),
						imageData: result.imageData,
						metadata: {
							...cachedData.metadata,
							timestamp: Date.now() // Update timestamp
						}
					});
					
					console.log('Updated cached image:', cachedData.metadata.resourceUri);
				}
			} catch (error) {
				console.error('Failed to update cached image:', cachedData.metadata.resourceUri, error);
			}
		}
		
		// Update the currently displayed image cache as well
		cacheCurrentImage();
		
		console.log('Finished updating cached images');
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
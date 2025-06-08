/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
"use strict";

(function () {
	/**
	 * @param {number} value
	 * @param {number} min
	 * @param {number} max
	 * @return {number}
	 */
	function clamp(value, min, max) {
		return Math.min(Math.max(value, min), max);
	}

	function getSettings() {
		const element = document.getElementById('image-preview-settings');
		if (element) {
			const data = element.getAttribute('data-settings');
			if (data) {
				return JSON.parse(data);
			}
		}

		throw new Error(`Could not load settings`);
	}

	/**
	 * Enable image-rendering: pixelated for images scaled by more than this.
	 */
	const PIXELATION_THRESHOLD = 3;

	const SCALE_PINCH_FACTOR = 0.075;
	const MAX_SCALE = 100;
	const MIN_SCALE = 0.1;

	const zoomLevels = [
		0.1,
		0.2,
		0.3,
		0.4,
		0.5,
		0.6,
		0.7,
		0.8,
		0.9,
		1,
		1.5,
		2,
		3,
		5,
		7,
		10,
		15,
		20,
		30,
		50,
		70,
		100
	];

	const settings = getSettings();
	const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

	// @ts-ignore
	const vscode = acquireVsCodeApi();

	const initialState = vscode.getState() || { scale: 'fit', offsetX: 0, offsetY: 0 };

	// State
	let scale = initialState.scale;
	let ctrlPressed = false;
	let altPressed = false;
	let hasLoadedImage = false;
	let consumeClick = true;
	let isActive = false;
	let rawTiffData;
	let offscreenCanvas;
	let offscreenCtx;

	// Elements
	const container = document.body;
	const image = document.createElement('img');
	let canvas;
	let imageElement; // This will always be the canvas

	function addMouseListeners(element) {
		element.addEventListener('mouseenter', (/** @type {MouseEvent} */ e) => {
			if (!imageElement) {
				return;
			}
			const rect = imageElement.getBoundingClientRect();
			const naturalWidth = imageElement.width;
			const naturalHeight = imageElement.height;
			const x = Math.round((e.clientX - rect.left) / rect.width * naturalWidth);
			const y = Math.round((e.clientY - rect.top) / rect.height * naturalHeight);
			const color = getColorAtPixel(x, y, naturalWidth, naturalHeight);

			vscode.postMessage({
				type: 'size',
				value: `${x}x${y} ${color}`
			});
		});

		element.addEventListener('mousemove', (/** @type {MouseEvent} */ e) => {
			if (!imageElement) {
				return;
			}
			const rect = imageElement.getBoundingClientRect();
			const naturalWidth = imageElement.width;
			const naturalHeight = imageElement.height;
			const x = Math.round((e.clientX - rect.left) / rect.width * naturalWidth);
			const y = Math.round((e.clientY - rect.top) / rect.height * naturalHeight);
			const color = getColorAtPixel(x, y, naturalWidth, naturalHeight);

			vscode.postMessage({
				type: 'size',
				value: `${x}x${y} ${color}`
			});
		});

		element.addEventListener('mouseleave', (/** @type {MouseEvent} */ e) => {
			vscode.postMessage({
				type: 'size',
				value: `${imageElement.width}x${imageElement.height}`
			});
		});
	}

	function getColorAtPixel(x, y, naturalWidth, naturalHeight) {
		let color = '';
		if (rawTiffData) { // This is a TIFF
			const ifd = rawTiffData.ifd;
			const data = rawTiffData.data;
			const pixelIndex = y * naturalWidth + x;
			const format = ifd.t339; // SampleFormat
			const samples = ifd.t277;
			const planarConfig = ifd.t284;

			if (samples === 1) { // Grayscale
				const value = data[pixelIndex];
				color = format === 3 ? value.toPrecision(3) : value.toString();
			} else if (samples >= 3) {
				const values = [];
				if (planarConfig === 2) { // Planar data
					const planeSize = naturalWidth * naturalHeight;
					for (let i = 0; i < samples; i++) {
						const value = data[pixelIndex + i * planeSize];
						values.push(format === 3 ? value.toPrecision(3) : value.toString().padStart(3, '0'));
					}
				} else { // Interleaved data
					for (let i = 0; i < samples; i++) {
						const value = data[pixelIndex * samples + i];
						values.push(format === 3 ? value.toPrecision(3) : value.toString().padStart(3, '0'));
					}
				}
				color = values.slice(0, 3).join(' ');
			}
		} else if (imageElement) { // Standard image on a canvas
			const ctx = imageElement.getContext('2d');
			if (ctx) {
				const pixel = ctx.getImageData(x, y, 1, 1).data;
				color = `${pixel[0].toString().padStart(3, '0')} ${pixel[1].toString().padStart(3, '0')} ${pixel[2].toString().padStart(3, '0')}`;
			}
		}
		return color;
	}

	function updateScale(newScale) {
		if (!imageElement || !hasLoadedImage || !imageElement.parentElement) {
			return;
		}

		const isTiff = !!canvas;

		if (newScale === 'fit') {
			scale = 'fit';
			imageElement.classList.add('scale-to-fit');
			imageElement.classList.remove('pixelated');
			if (isTiff) {
				imageElement.style.transform = '';
				imageElement.style.transformOrigin = '';
			} else {
				// @ts-ignore Non-standard CSS property
				image.style.zoom = 'normal';
			}
			vscode.setState(undefined);
		} else {
			scale = clamp(newScale, MIN_SCALE, MAX_SCALE);
			if (scale >= PIXELATION_THRESHOLD) {
				imageElement.classList.add('pixelated');
			} else {
				imageElement.classList.remove('pixelated');
			}

			const dx = (window.scrollX + container.clientWidth / 2) / container.scrollWidth;
			const dy = (window.scrollY + container.clientHeight / 2) / container.scrollHeight;

			imageElement.classList.remove('scale-to-fit');
			
			if (isTiff) {
				// Set transform origin to top-left to make scaling behavior consistent
				imageElement.style.transformOrigin = '0 0';
				imageElement.style.transform = `scale(${scale})`;
			} else {
				// @ts-ignore Non-standard CSS property
				image.style.zoom = scale;
			}

			const newScrollX = container.scrollWidth * dx - container.clientWidth / 2;
			const newScrollY = container.scrollHeight * dy - container.clientHeight / 2;

			window.scrollTo(newScrollX, newScrollY);

			vscode.setState({ scale: scale, offsetX: newScrollX, offsetY: newScrollY });
		}

		vscode.postMessage({
			type: 'zoom',
			value: scale
		});
	}

	function setActive(value) {
		isActive = value;
		if (value) {
			if (isMac ? altPressed : ctrlPressed) {
				container.classList.remove('zoom-in');
				container.classList.add('zoom-out');
			} else {
				container.classList.remove('zoom-out');
				container.classList.add('zoom-in');
			}
		} else {
			ctrlPressed = false;
			altPressed = false;
			container.classList.remove('zoom-out');
			container.classList.remove('zoom-in');
		}
	}

	function firstZoom() {
		if (!imageElement || !hasLoadedImage) {
			return;
		}

		const isTiff = !!canvas;
		if (isTiff) {
			const containerWidth = container.clientWidth - 20; // 20 for padding
			const containerHeight = container.clientHeight - 20;
			scale = Math.min(containerWidth / canvas.width, containerHeight / canvas.height);
		} else {
			scale = image.clientWidth / image.naturalWidth;
		}
		updateScale(scale);
	}

	function zoomIn() {
		if (scale === 'fit') {
			firstZoom();
		}

		let i = 0;
		for (; i < zoomLevels.length; ++i) {
			if (zoomLevels[i] > scale) {
				break;
			}
		}
		updateScale(zoomLevels[i] || MAX_SCALE);
	}

	function zoomOut() {
		if (scale === 'fit') {
			firstZoom();
		}

		let i = zoomLevels.length - 1;
		for (; i >= 0; --i) {
			if (zoomLevels[i] < scale) {
				break;
			}
		}
		updateScale(zoomLevels[i] || MIN_SCALE);
	}

	window.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
		if (!imageElement || !hasLoadedImage) {
			return;
		}
		ctrlPressed = e.ctrlKey;
		altPressed = e.altKey;

		if (isMac ? altPressed : ctrlPressed) {
			container.classList.remove('zoom-in');
			container.classList.add('zoom-out');
		}
	});

	window.addEventListener('keyup', (/** @type {KeyboardEvent} */ e) => {
		if (!imageElement || !hasLoadedImage) {
			return;
		}

		ctrlPressed = e.ctrlKey;
		altPressed = e.altKey;

		if (!(isMac ? altPressed : ctrlPressed)) {
			container.classList.remove('zoom-out');
			container.classList.add('zoom-in');
		}
	});

	container.addEventListener('mousedown', (/** @type {MouseEvent} */ e) => {
		if (!imageElement || !hasLoadedImage) {
			return;
		}

		if (e.button !== 0) {
			return;
		}

		ctrlPressed = e.ctrlKey;
		altPressed = e.altKey;

		consumeClick = !isActive;
	});

	container.addEventListener('click', (/** @type {MouseEvent} */ e) => {
		if (!imageElement || !hasLoadedImage) {
			return;
		}

		if (e.button !== 0) {
			return;
		}

		if (consumeClick) {
			consumeClick = false;
			return;
		}
		// left click
		if (scale === 'fit') {
			firstZoom();
		}

		if (!(isMac ? altPressed : ctrlPressed)) { // zoom in
			zoomIn();
		} else {
			zoomOut();
		}
	});

	container.addEventListener('wheel', (/** @type {WheelEvent} */ e) => {
		// Prevent pinch to zoom
		if (e.ctrlKey) {
			e.preventDefault();
		}

		if (!imageElement || !hasLoadedImage) {
			return;
		}

		const isScrollWheelKeyPressed = isMac ? altPressed : ctrlPressed;
		if (!isScrollWheelKeyPressed && !e.ctrlKey) { // pinching is reported as scroll wheel + ctrl
			return;
		}

		if (scale === 'fit') {
			firstZoom();
		}

		const delta = e.deltaY > 0 ? 1 : -1;
		updateScale(scale * (1 - delta * SCALE_PINCH_FACTOR));
	}, { passive: false });

	window.addEventListener('scroll', e => {
		if (!imageElement || !hasLoadedImage || !imageElement.parentElement || scale === 'fit') {
			return;
		}

		const entry = vscode.getState();
		if (entry) {
			vscode.setState({ scale: entry.scale, offsetX: window.scrollX, offsetY: window.scrollY });
		}
	}, { passive: true });

	function handleTiff(src) {
		if (settings.decoder === 'geotiff') {
			handleTiffWithGeoTiff(src);
		} else {
			handleTiffWithUtif(src);
		}
	}

	async function handleTiffWithGeoTiff(src) {
		try {
			const response = await fetch(src);
			const buffer = await response.arrayBuffer();
			// @ts-ignore
			const tiff = await GeoTIFF.fromArrayBuffer(buffer);
			const image = await tiff.getImage();
			const width = image.getWidth();
			const height = image.getHeight();

			canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			canvas.classList.add('scale-to-fit');

			const ctx = canvas.getContext('2d');
			if (!ctx) {
				throw new Error('Could not get canvas context');
			}
			
			const rasters = await image.readRasters();
			const samplesPerPixel = image.getSamplesPerPixel();
			const sampleFormat = image.getSampleFormat();

			const data = new (sampleFormat === 3 ? Float32Array : Uint8Array)(width * height * samplesPerPixel);
			if (samplesPerPixel === 1) {
				data.set(rasters[0]);
			} else {
				for (let i = 0; i < rasters[0].length; i++) {
					for (let j = 0; j < samplesPerPixel; j++) {
						data[i * samplesPerPixel + j] = rasters[j][i];
					}
				}
			}

			rawTiffData = {
				data: data,
				ifd: { t277: samplesPerPixel, t339: sampleFormat }
			};

			// Handle floating point data by normalizing it
			if (sampleFormat === 3) {
				const displayRasters = [];
				for (const raster of rasters) {
					displayRasters.push(new Float32Array(raster));
				}

				if (settings.normalization === 'minmax') {
					let min = Infinity;
					let max = -Infinity;

					for (let i = 0; i < displayRasters.length; i++) {
						for (let j = 0; j < displayRasters[i].length; j++) {
							if (!isNaN(displayRasters[i][j])) {
								min = Math.min(min, displayRasters[i][j]);
								max = Math.max(max, displayRasters[i][j]);
							}
						}
					}

					const range = max - min;
					for (let i = 0; i < displayRasters.length; i++) {
						for (let j = 0; j < displayRasters[i].length; j++) {
							if (range > 0) {
								displayRasters[i][j] = (displayRasters[i][j] - min) / range * 255;
							} else {
								displayRasters[i][j] = 0; // Flat color, show as black
							}
						}
					}
				} else { // 'clamp' is the default
					for (let i = 0; i < displayRasters.length; i++) {
						for (let j = 0; j < displayRasters[i].length; j++) {
							// clamp to [0, 1] then scale to [0, 255]
							const clampedValue = Math.max(0, Math.min(1, displayRasters[i][j]));
							displayRasters[i][j] = clampedValue * 255;
						}
					}
				}
				
				let imageDataArray;
				if (samplesPerPixel === 1) {
					const gray = displayRasters[0];
					imageDataArray = new Uint8ClampedArray(width * height * 4);
					for (let i = 0; i < gray.length; i++) {
						imageDataArray[i * 4] = gray[i];
						imageDataArray[i * 4 + 1] = gray[i];
						imageDataArray[i * 4 + 2] = gray[i];
						imageDataArray[i * 4 + 3] = 255;
					}
				} else if (samplesPerPixel >= 3) {
					const [r, g, b] = displayRasters;
					const a = (samplesPerPixel === 4) ? displayRasters[3] : null;
					imageDataArray = new Uint8ClampedArray(width * height * 4);
					for (let i = 0; i < r.length; i++) {
						imageDataArray[i * 4] = r[i];
						imageDataArray[i * 4 + 1] = g[i];
						imageDataArray[i * 4 + 2] = b[i];
						imageDataArray[i * 4 + 3] = a ? a[i] : 255;
					}
				} else {
					throw new Error(`Unsupported number of samples per pixel: ${samplesPerPixel}`);
				}
				const imageData = new ImageData(imageDataArray, width, height);
				ctx.putImageData(imageData, 0, 0);

			} else {
				let imageDataArray;
				if (samplesPerPixel === 1) {
					const gray = rasters[0];
					imageDataArray = new Uint8ClampedArray(width * height * 4);
					for (let i = 0; i < gray.length; i++) {
						imageDataArray[i * 4] = gray[i];
						imageDataArray[i * 4 + 1] = gray[i];
						imageDataArray[i * 4 + 2] = gray[i];
						imageDataArray[i * 4 + 3] = 255;
					}
				} else if (samplesPerPixel >= 3) {
					const [r, g, b] = rasters;
					const a = (samplesPerPixel === 4) ? rasters[3] : null;
					imageDataArray = new Uint8ClampedArray(width * height * 4);
					for (let i = 0; i < r.length; i++) {
						imageDataArray[i * 4] = r[i];
						imageDataArray[i * 4 + 1] = g[i];
						imageDataArray[i * 4 + 2] = b[i];
						imageDataArray[i * 4 + 3] = a ? a[i] : 255;
					}
				} else {
					throw new Error(`Unsupported number of samples per pixel: ${samplesPerPixel}`);
				}
				const imageData = new ImageData(imageDataArray, width, height);
				ctx.putImageData(imageData, 0, 0);
			}

			hasLoadedImage = true;
			imageElement = canvas;

			vscode.postMessage({
				type: 'size',
				value: `${width}x${height}`
			});

			document.body.classList.remove('loading');
			document.body.classList.add('ready');
			document.body.append(canvas);

			updateScale(scale);
			if (initialState.scale !== 'fit') {
				window.scrollTo(initialState.offsetX, initialState.offsetY);
			}
			addMouseListeners(imageElement);
		} catch (err) {
			if (hasLoadedImage) {
				return;
			}
			console.error(err);
			hasLoadedImage = true;
			container.classList.remove('loading');
			container.classList.add('error');
			const errorDetails = document.querySelector('.error-details');
			if (errorDetails) {
				errorDetails.textContent = err ? err.toString() : 'Unknown error';
			}
		}
	}

	function handleTiffWithUtif(src) {
		fetch(src)
			.then(response => response.arrayBuffer())
			.then(buffer => {
				// @ts-ignore
				const ifds = UTIF.decode(buffer);
				// @ts-ignore
				UTIF.decodeImage(buffer, ifds[0]);
				rawTiffData = { data: ifds[0].data, ifd: ifds[0] };
				// @ts-ignore
				const rgba = UTIF.toRGBA8(ifds[0]);

				canvas = document.createElement('canvas');
				canvas.width = ifds[0].width;
				canvas.height = ifds[0].height;
				canvas.classList.add('scale-to-fit');
				
				const ctx = canvas.getContext('2d');
				if (!ctx) {
					throw new Error('Could not get canvas context');
				}
				const imageData = new ImageData(new Uint8ClampedArray(rgba), canvas.width, canvas.height);
				ctx.putImageData(imageData, 0, 0);

				hasLoadedImage = true;
				imageElement = canvas;

				vscode.postMessage({
					type: 'size',
					value: `${canvas.width}x${canvas.height}`
				});

				document.body.classList.remove('loading');
				document.body.classList.add('ready');
				document.body.append(canvas);

				updateScale(scale);
				if (initialState.scale !== 'fit') {
					window.scrollTo(initialState.offsetX, initialState.offsetY);
				}
				addMouseListeners(imageElement);

				offscreenCanvas = document.createElement('canvas');
				offscreenCanvas.width = image.naturalWidth;
				offscreenCanvas.height = image.naturalHeight;
				offscreenCtx = offscreenCanvas.getContext('2d');
				if (offscreenCtx) {
					offscreenCtx.drawImage(image, 0, 0);
				}
			})
			.catch((err) => {
				if (hasLoadedImage) {
					return;
				}
				console.error(err);
				hasLoadedImage = true;
				container.classList.remove('loading');
				container.classList.add('error');
				const errorDetails = document.querySelector('.error-details');
				if (errorDetails) {
					errorDetails.textContent = err ? err.toString() : 'Unknown error';
				}
			});
	}

	container.classList.add('image');

	image.classList.add('scale-to-fit');

	image.addEventListener('load', () => {
		if (hasLoadedImage) {
			return;
		}
		hasLoadedImage = true;

		// Create a canvas and draw the image to it.
		// This unifies the rendering path for all images.
		canvas = document.createElement('canvas');
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		canvas.classList.add('scale-to-fit');

		const ctx = canvas.getContext('2d');
		if (!ctx) {
			hasLoadedImage = false;
			return;
		}
		ctx.drawImage(image, 0, 0);

		imageElement = canvas;

		vscode.postMessage({
			type: 'size',
			value: `${image.naturalWidth}x${image.naturalHeight}`,
		});

		document.body.classList.remove('loading');
		document.body.classList.add('ready');
		document.body.append(imageElement);

		updateScale(scale);

		if (initialState.scale !== 'fit') {
			window.scrollTo(initialState.offsetX, initialState.offsetY);
		}
		addMouseListeners(imageElement);
	});

	image.addEventListener('error', e => {
		if (hasLoadedImage) {
			return;
		}

		hasLoadedImage = true;
		document.body.classList.add('error');
		document.body.classList.remove('loading');
	});

	// Check if this is a TIFF file and handle accordingly
	const src = settings.src;
	const resourceUri = settings.resourceUri;

	if (resourceUri.toLowerCase().endsWith('.tif') || resourceUri.toLowerCase().endsWith('.tiff')) {
		handleTiff(src);
	} else {
		image.src = src;
	}

	document.querySelector('.open-file-link')?.addEventListener('click', (e) => {
		e.preventDefault();
		vscode.postMessage({
			type: 'reopen-as-text',
		});
	});

	window.addEventListener('message', e => {
		if (e.origin !== window.origin) {
			console.error('Dropping message from unknown origin in image preview');
			return;
		}

		switch (e.data.type) {
			case 'setScale': {
				updateScale(e.data.scale);
				break;
			}
			case 'setActive': {
				setActive(e.data.value);
				break;
			}
			case 'zoomIn': {
				zoomIn();
				break;
			}
			case 'zoomOut': {
				zoomOut();
				break;
			}
			case 'copyImage': {
				copyImage();
				break;
			}
		}
	});

	document.addEventListener('copy', () => {
		copyImage();
	});

	async function copyImage(retries = 5) {
		if (!document.hasFocus() && retries > 0) {
			// copyImage is called at the same time as webview.reveal, which means this function is running whilst the webview is gaining focus.
			// Since navigator.clipboard.write requires the document to be focused, we need to wait for focus.
			// We cannot use a listener, as there is a high chance the focus is gained during the setup of the listener resulting in us missing it.
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
						// For TIFF images, copy from the existing canvas
						copyCanvas.width = canvas.width;
						copyCanvas.height = canvas.height;
						ctx.drawImage(canvas, 0, 0);
					} else {
						// For regular images, create canvas and draw image
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
			console.error(e);
		}
	}
}());
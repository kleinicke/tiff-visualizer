"use strict";

import { SettingsManager } from './modules/settings-manager.js';
import type { ImageSettings, SettingsUpdateResult } from './modules/settings-manager.js';
import type { DeferredRenderOptions } from './modules/types.js';
import { TiffProcessor, tiffFormatTypeFor, tiffTypeMax, tiffNeedsFloatCarrier } from './modules/tiff-processor.js';
import { ExrProcessor } from './modules/exr-processor.js';
import { NpyProcessor } from './modules/npy-processor.js';
import { PfmProcessor } from './modules/pfm-processor.js';
import { PpmProcessor } from './modules/ppm-processor.js';
import { PngProcessor } from './modules/png-processor.js';
import { HdrProcessor } from './modules/hdr-processor.js';
import { TgaProcessor } from './modules/tga-processor.js';
import { WebImageProcessor } from './modules/web-image-processor.js';
import { JxlProcessor } from './modules/jxl-processor.js';
import { ZoomController } from './modules/zoom-controller.js';
import { MouseHandler } from './modules/mouse-handler.js';
import { HistogramOverlay } from './modules/histogram-overlay.js';
import { MetadataPanel } from './modules/metadata-panel.js';
import type { MetadataInfo } from './modules/metadata-panel.js';
import type { TagEntry } from './modules/tiff-tag-utils.js';
import { ColormapConverter } from './modules/colormap-converter.js';
import { ImageRenderer, ImageStatsCalculator } from './modules/normalization-helper.js';
import { DecodeWorkerClient } from './modules/decode-worker-client.js';
import { PerfTrace } from './modules/perf-trace.js';
import { LayerManager, BLEND_MODES } from './modules/layer-manager.js';
import type { LayerInput } from './modules/layer-manager.js';
import { LayersPanel } from './modules/layers-panel.js';
import { OmeAxis, omeCoordinatesToIfd, omeIfdToCoordinates } from './modules/ome-tiff.js';
import { installRangeDoubleClickReset } from './modules/range-controls.js';
import { writeLayerStackAsXcf } from './modules/xcf-writer.js';
import { ScientificArrayProcessor } from './modules/scientific-array-processor.js';
import { LayeredPreviewProcessor } from './modules/layered-preview-processor.js';
import type { LayeredDocumentFormat } from './modules/layered-document.js';
import { extractDicomJpegFrame, parseDicom, parseFits, parseNetCdf } from './modules/scientific-format-parsers.js';
import type { ScientificDecodedImage } from './modules/scientific-format-parsers.js';

/**
 * Main Image Preview Application
 * Orchestrates all modules to provide image viewing functionality
 */
(function () {
	type SettingsChanges = SettingsUpdateResult;
	type CopiedPosition = { relativeX: number, relativeY: number, sourceWidth: number, sourceHeight: number, scale: number | string };
	type ColormapConversionState = { colormapName: string, minValue: number, maxValue: number, inverted: boolean, logarithmic: boolean };
	type FormatInfo = { width?: number, height?: number, samplesPerPixel?: number, bitsPerSample?: number, sampleFormat?: number, formatType?: string, [key: string]: any };
	type DatasetPlane = { coordinates: Record<string, number>, resourceUri: string, src: string, format: 'dicom' | 'tiff', pageIndex?: number, frameIndex?: number };
	type DatasetAxis = { key: string, label: string, size: number, valueLabels?: string[] };
	type DatasetSeries = { id: string, label: string, axes: DatasetAxis[], planes: DatasetPlane[] };
	type DatasetManifest = { id: string, kind: 'dicom' | 'ome-tiff', label: string, series: DatasetSeries[] };

	// The worker normally decodes encapsulated DICOM JPEG frames with Rust/WASM.
	// Keep a browser-native fallback so a failed/blocked worker never makes the
	// file unusable; ordinary browser JPEG decoding is sufficient for Baseline.
	async function parseDicomForBrowser(buffer: ArrayBuffer, frameIndex = 0): Promise<ScientificDecodedImage> {
		try { return parseDicom(buffer, frameIndex); }
		catch (error) {
			if (!(error instanceof Error) || !error.message.includes('requires codec: jpeg-baseline')) { throw error; }
		}
		const started = performance.now();
		const frame = extractDicomJpegFrame(buffer, frameIndex);
		const jpegBytes = new Uint8Array(frame.encoded.byteLength);
		jpegBytes.set(frame.encoded);
		const bitmap = await createImageBitmap(new Blob([jpegBytes.buffer], { type: 'image/jpeg' }));
		try {
			if (bitmap.width !== frame.width || bitmap.height !== frame.height) {
				throw new Error(`DICOM/JPEG dimensions disagree: ${frame.width}x${frame.height} vs ${bitmap.width}x${bitmap.height}`);
			}
			const canvas = document.createElement('canvas');
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			const context = canvas.getContext('2d', { willReadFrequently: true });
			if (!context) { throw new Error('Could not create a JPEG decode canvas'); }
			context.drawImage(bitmap, 0, 0);
			const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
			const channels = frame.channels === 1 ? 1 : 3;
			const data = new Float32Array(bitmap.width * bitmap.height * channels);
			const slope = Number(frame.metadata.rescaleSlope ?? 1);
			const intercept = Number(frame.metadata.rescaleIntercept ?? 0);
			for (let pixel = 0; pixel < bitmap.width * bitmap.height; pixel++) {
				for (let channel = 0; channel < channels; channel++) {
					data[pixel * channels + channel] = rgba[pixel * 4 + channel] * slope + intercept;
				}
			}
			if (frame.metadata.photometric === 'MONOCHROME1') {
				let min = Infinity, max = -Infinity;
				for (const value of data) { if (value < min) { min = value; } if (value > max) { max = value; } }
				for (let i = 0; i < data.length; i++) { data[i] = max + min - data[i]; }
			}
			return {
				width: bitmap.width, height: bitmap.height, channels, data,
				metadata: { ...frame.metadata, decoder: 'Browser JPEG fallback' },
				decodeTimings: [{ name: 'decode-dicom-browser-jpeg', durationMs: performance.now() - started }],
			};
		} finally {
			bitmap.close();
		}
	}

	// @ts-ignore - acquireVsCodeApi is injected by VS Code at runtime, not declared globally
	const originalVscode = acquireVsCodeApi() as { postMessage: (message: any) => any, setState: (state: any) => void, getState: () => any };

	// Format info tracking for context menu
	let currentFormatInfo: FormatInfo | null = null;
	let lastFormatInfoPost: { time: number, generation: number, formatType: string } | null = null;

	// Wrap vscode.postMessage to track formatInfo
	const vscode = {
		postMessage: (message: { type: string, [key: string]: any }) => {
			// Track formatInfo when it's sent
			if (message.type === 'formatInfo' && message.value) {
				currentFormatInfo = message.value;
				lastFormatInfoPost = {
					time: performance.now(),
					generation: _loadGeneration,
					formatType: String(message.value.formatType || '')
				};
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
	pngProcessor.onMetadataTagsReady = () => updateMetadataData();
	const hdrProcessor = new HdrProcessor(settingsManager, vscode);
	const tgaProcessor = new TgaProcessor(settingsManager, vscode);
	const webImageProcessor = new WebImageProcessor(settingsManager, vscode);
	const jxlProcessor = new JxlProcessor(settingsManager, vscode);
	const fitsProcessor = new ScientificArrayProcessor(settingsManager, vscode, { workerFormat: 'fits', formatLabel: 'FITS', formatType: 'fits', parse: parseFits });
	const dicomProcessor = new ScientificArrayProcessor(settingsManager, vscode, { workerFormat: 'dicom', formatLabel: 'DICOM', formatType: 'dicom', parse: (buffer, options) => parseDicomForBrowser(buffer, Number(options?.frameIndex || 0)) });
	const netcdfProcessor = new ScientificArrayProcessor(settingsManager, vscode, { workerFormat: 'netcdf', formatLabel: 'NetCDF', formatType: 'netcdf', parse: (buffer, options) => parseNetCdf(buffer, options) });
	const scientificProcessors = [fitsProcessor, dicomProcessor, netcdfProcessor];
	const layeredPreviewProcessor = new LayeredPreviewProcessor(settingsManager, vscode);
	// All format processors, for bulk per-switch state resets and load cancellation.
	const allProcessors = [tiffProcessor, exrProcessor, npyProcessor, pfmProcessor, ppmProcessor, pngProcessor, hdrProcessor, tgaProcessor, webImageProcessor, jxlProcessor, layeredPreviewProcessor, ...scientificProcessors];
	// Off-thread decode worker, pre-warmed in the background. Processors fall
	// back to their local (main-thread) decoders until it is ready or if it
	// is unavailable, so worker failures never break image loading.
	const decodeWorkerClient = new DecodeWorkerClient();
	decodeWorkerClient.start();
	const workerProcessors = [tiffProcessor, exrProcessor, npyProcessor, pfmProcessor, ppmProcessor, pngProcessor, hdrProcessor, layeredPreviewProcessor, ...scientificProcessors];
	for (const p of workerProcessors) { p.decodeWorker = decodeWorkerClient; }
	const histogramOverlay = new HistogramOverlay(settingsManager, vscode);
	const metadataPanel = new MetadataPanel(settingsManager, vscode);
	const colormapConverter = new ColormapConverter();
	mouseHandler.setNpyProcessor(npyProcessor);
	mouseHandler.setPfmProcessor(pfmProcessor);
	mouseHandler.setPpmProcessor(ppmProcessor);
	mouseHandler.setPngProcessor(pngProcessor);
	mouseHandler.setHdrProcessor(hdrProcessor);
	mouseHandler.setTgaProcessor(tgaProcessor);
	mouseHandler.setWebImageProcessor(webImageProcessor);
	mouseHandler.setJxlProcessor(jxlProcessor);
	mouseHandler.setExrProcessor(exrProcessor);
	mouseHandler.setScientificProcessors(scientificProcessors);
	mouseHandler.setLayeredPreviewProcessor(layeredPreviewProcessor);

	function disposeWebglRenderers() {
		for (const p of allProcessors) {
			// Not every processor class exposes a _webglRenderer field; cast is a
			// pre-existing (documented) type-only workaround, no behavior change.
			const webglRenderer = (p as any)?._webglRenderer;
			if (webglRenderer && typeof webglRenderer.dispose === 'function') {
				webglRenderer.dispose();
			}
		}
	}

	// Layer compositing (GIMP-style) — manager holds the stack, panel is the UI.
	// Canvas uploads are async for ordinary-sized images; this generation keeps
	// an older visibility state from painting over a newer one.
	let _layerCanvasRenderGeneration = 0;
	const layerManager = new LayerManager();
	const layersPanel = new LayersPanel(layerManager, {
		onChange: (options: { interactive?: boolean } = {}) => { scheduleRecomposite(options.interactive ? 180 : 0); scheduleSaveState(); },
		onBackgroundChange: (brightness: number | null) => { applyLayerBackground(brightness); scheduleSaveState(); },
		onPersist: () => { scheduleSaveState(); },
		onAddLayer: () => { vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.addLayer' }); },
		onExportPng: () => { vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.exportAsPng' }); },
		onExportXcf: () => { vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.exportAsXcf' }); },
		onVisibilityChange: (visible: boolean) => {
			layerManager.active = visible;
			if (!visible) { _layerCanvasRenderGeneration++; }
			// Tell the extension so it can track layer mode (and block collection ops).
			vscode.postMessage({ type: 'layerModeChanged', active: visible });
			if (visible) {
				if (!installLayeredDocumentLayers()) { syncBaseLayer(); }
				recompositeLayers();
			} else {
				// Restore the normal single-image render.
				updateImageWithNewSettings(null);
			}
			updateLayeredPreviewOverlay();
			scheduleSaveState();
		},
	}, { closable: settingsManager.settings.surfaceMode !== 'layers' });
	// Pixel inspector reads the composite value when compositing is active.
	mouseHandler.compositeValueProvider = (x: number, y: number) =>
		(layerManager.active && layerManager.hasCompositeStack()) ? layerManager.getCompositeValueAt(x, y) : null;
	// Pixel inspector reads the decoded scalar when a colormap has been decoded.
	mouseHandler.decodedValueProvider = (x: number, y: number) => {
		if (!decodedColormapSource) { return null; }
		const { floatData, width, height } = decodedColormapSource;
		if (x < 0 || y < 0 || x >= width || y >= height) { return null; }
		return floatData[y * width + x];
	};
	/** URI of the image currently used as the base layer. */
	let _layerBaseUri: string | undefined;
	let _expandedLayerDocumentUri: string | undefined;

	const isTiffExtension = (lower: string): boolean => /\.(?:tif|tiff|tf2|tf8|btf)$/.test(lower);
	const layeredFormatForPath = (lower: string): LayeredDocumentFormat | null => {
		if (lower.endsWith('.ora')) { return 'ora'; }
		if (lower.endsWith('.kra')) { return 'kra'; }
		if (lower.endsWith('.psd')) { return 'psd'; }
		if (lower.endsWith('.psb')) { return 'psb'; }
		if (lower.endsWith('.xcf')) { return 'xcf'; }
		if (lower.endsWith('.afphoto') || lower.endsWith('.af')) { return 'affinity'; }
		return null;
	};

	// Application state
	let hasLoadedImage = false;
	let canvas: HTMLCanvasElement | null = null;
	let imageElement: HTMLElement | null = null;
	let primaryImageData: ImageData | null = null;
	let peerImageData: ImageData | null = null;
	let peerRawTiffData: any = null;      // Raw TIFF data for peer image (kept separate from primary)
	let peerLastStatistics: any = null;   // Statistics for peer TIFF image
	let peerRawExrData: any = null;       // Raw EXR data for peer image
	let peerExrStats: any = null;         // Cached stats for peer EXR image
	let peerImageUris: string[] = []; // Track peer URIs for comparison state
	let _pendingZoomState: { scale: number | string, [key: string]: any } | null = null; // Zoom state to restore after next image load
	let _loadGeneration = 0;     // Incremented on every switchToNewImage; stale loads bail out
	let _loadAbortController: AbortController | null = null; // Aborts the in-flight load's fetch when a newer switch supersedes it
	let _tiffCanvasReadyPromise: Promise<void>;
	let _tiffCanvasReadyResolve: (() => void) | null = null;
	let isShowingPeer = false;
	let initialLoadStartTime = 0;
	let extensionLoadStartTime = 0; // Time when extension started loading (from settings)
	let currentLoadFormat = '';
	let currentLoadDecodeInfo: { engine: string, durationMs: number } | null = null;
	let _deferredHistogramTimer: number | null = null;
	let _previousDecodedImageCache: { resourceUri: string, cacheKey: string, format: string, raw: any } | null = null;
	let _restoreDecodedImageCandidate: { resourceUri: string, cacheKey: string, format: string, raw: any } | null = null;
	let _outgoingImageElement: HTMLElement | null = null;
	let _imageTransitionActive = false;
	let _collectionSwitchLoading = false;

	function formatDecodeInfo() {
		return currentLoadDecodeInfo
			? `, decode: ${currentLoadDecodeInfo.engine} ${currentLoadDecodeInfo.durationMs.toFixed(2)}ms`
			: '';
	}

	function resetTiffCanvasReady() {
		// Release a stale waiter before replacing it; its generation check will
		// prevent it from rendering into the next image.
		_tiffCanvasReadyResolve?.();
		_tiffCanvasReadyPromise = new Promise(resolve => {
			_tiffCanvasReadyResolve = resolve;
		});
	}

	function signalTiffCanvasReady() {
		_tiffCanvasReadyResolve?.();
		_tiffCanvasReadyResolve = null;
	}

	resetTiffCanvasReady();

	// Colormap conversion state
	let colormapConversionState: ColormapConversionState | null = null;

	// Original image state (for reverting from conversions)
	let originalImageData: ImageData | null = null;
	let hasAppliedConversion = false;

	// Decoded single-channel float data produced by "Decode Colormap to Float".
	// When set, it becomes the active single-image source: it renders through the
	// central ImageRenderer pipeline (so normalization/gamma/display-colormap all
	// apply) and feeds the pixel inspector.
	let decodedColormapSource: { floatData: Float32Array, width: number, height: number } | null = null;

	// Copied position state (for paste position feature)
	// Stores position as relative coordinates (0-1) for cross-resolution compatibility
	let copiedPositionState: CopiedPosition | null = null;

	// Restore persisted state if available
	const persistedState = vscode.getState();
	/** Layer stack to restore after the base image loads. */
	let _pendingLayerRestore: { layers: any[], active: boolean, collapsed: boolean } | null = null;
	if (persistedState) {
		peerImageUris = persistedState.peerImageUris || [];
		isShowingPeer = persistedState.isShowingPeer || false;
		colormapConversionState = persistedState.colormapConversionState || null;
		tiffProcessor.pageIndex = Math.max(0, Number(persistedState.tiffPageIndex || 0));
		if (persistedState.displayColormap) {
			settingsManager.settings.displayColormap = persistedState.displayColormap;
		}
		if (Array.isArray(persistedState.layerGroupCollapsed)) {
			layersPanel.collapsedGroups = new Set(persistedState.layerGroupCollapsed.map(String));
		}
		if (Number.isFinite(persistedState.layerBackgroundBrightness)) {
			layersPanel.backgroundBrightness = Math.max(0, Math.min(100, Number(persistedState.layerBackgroundBrightness)));
		}
		// Note: Histogram visibility is now managed globally by the extension
		// and restored via restoreHistogramState message when webview becomes active
		const savedLayers = persistedState.layers;
		if (Array.isArray(savedLayers) && (savedLayers.length > 1 || persistedState.layerActive)) {
			_pendingLayerRestore = {
				layers: savedLayers,
				active: !!persistedState.layerActive,
				collapsed: !!persistedState.layerCollapsed,
			};
		}
	}

	// Image collection state
	let imageCollection: { totalImages: number, currentIndex: number, show: boolean } = {
		totalImages: 1,
		currentIndex: 0,
		show: false
	};
	let overlayElement: HTMLElement | null = null;
	let tiffPageOverlay: HTMLElement | null = null;
	let datasetOverlay: HTMLElement | null = null;
	let netcdfOverlay: HTMLElement | null = null;
	let layeredPreviewOverlay: HTMLElement | null = null;
	let netcdfSelection: { variableName?: string; indices: Record<string, number> } = persistedState?.netcdfSelection && typeof persistedState.netcdfSelection === 'object'
		? { variableName: persistedState.netcdfSelection.variableName, indices: { ...(persistedState.netcdfSelection.indices || {}) } }
		: { indices: {} };
	let datasetManifest: DatasetManifest | null = null;
	let datasetSeriesIndex = 0;
	let datasetCoordinates: Record<string, number> = {};
	let datasetLoading = false;
	let omeDatasetRequestKey = '';
	let filenameBadge: HTMLElement | null = null;
	let activeCounterInput: HTMLInputElement | null = null;

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
			displayColormap: settingsManager.settings.displayColormap,
			isHistogramVisible: histogramOverlay.getVisibility(),
			netcdfSelection,
			// Include zoom so it isn't erased when the app-level state is written
			scale: zoomState.scale,
			offsetX: zoomState.x,
			offsetY: zoomState.y,
			// Layer compositing state — metadata only (images are re-decoded from
			// their URIs on reload). Lets a layer view restore itself after the
			// webview is unloaded and reloaded on a tab switch.
			layers: layerManager.layers.map((l, i) => ({
				resourceUri: l.uri,
				name: l.name,
				offsetX: l.offsetX,
				offsetY: l.offsetY,
				opacity: l.opacity,
				blendMode: l.blendMode,
				visible: l.visible,
				maskCondition: l.maskCondition,
				kind: l.kind,
				parentId: l.parentId,
				clipped: l.clipped,
				groupPath: l.groupPath,
				groupIds: l.groupIds,
				sourceNodeId: l.sourceNodeId,
				sourceSupport: l.sourceSupport,
				sourceBlendMode: l.sourceBlendMode,
				isBase: i === 0,
			})),
			layerActive: layerManager.active,
			layerCollapsed: layersPanel.collapsed,
			layerGroupCollapsed: [...layersPanel.collapsedGroups],
			layerBackgroundBrightness: layersPanel.backgroundBrightness,
			tiffPageIndex: tiffProcessor.pageIndex,
			timestamp: Date.now()
		};
		vscode.setState(state);
	}

	// Debounced state save for frequent layer edits (slider drags, moves).
	let _saveStateTimer: ReturnType<typeof setTimeout> | null = null;
	function scheduleSaveState() {
		if (_saveStateTimer) { return; }
		_saveStateTimer = setTimeout(() => { _saveStateTimer = null; saveState(); }, 150);
	}

	// DOM elements
	const container = document.body;
	const image = document.createElement('img');

	function applyLayerBackground(brightness: number | null): void {
		if (brightness === null) {
			delete container.dataset.layerBackgroundOverride;
			container.style.removeProperty('--layer-preview-background');
			return;
		}
		const channel = Math.round(Math.max(0, Math.min(100, brightness)) * 2.55);
		container.dataset.layerBackgroundOverride = 'true';
		container.style.setProperty('--layer-preview-background', `rgb(${channel}, ${channel}, ${channel})`);
	}

	function syncThemeBackgroundBrightness(): void {
		const probe = document.createElement('span');
		probe.style.color = 'var(--vscode-editor-background, #1e1e1e)';
		probe.style.display = 'none';
		document.body.appendChild(probe);
		const match = getComputedStyle(probe).color.match(/[\d.]+/g);
		probe.remove();
		if (!match || match.length < 3) { return; }
		const [red, green, blue] = match.slice(0, 3).map(Number);
		// Perceived sRGB brightness gives the most useful position on a grayscale slider.
		layersPanel.setThemeBackgroundBrightness((0.299 * red + 0.587 * green + 0.114 * blue) / 2.55);
	}

	applyLayerBackground(layersPanel.backgroundBrightness);
	syncThemeBackgroundBrightness();
	const themeObserver = new MutationObserver(syncThemeBackgroundBrightness);
	themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
	themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

	/**
	 * Initialize the application
	 */
	function initialize() {
		initialLoadStartTime = performance.now();
		// Get the extension start time from settings (for total elapsed measurement)
		extensionLoadStartTime = settingsManager.settings.loadStartTime || 0;
		// The initial image must be cancellable too. Without a signal, switching
		// while it decodes lets the stale load continue after its worker is
		// terminated and interfere with the newest image.
		_loadAbortController = new AbortController();
		for (const p of allProcessors) { p.loadSignal = _loadAbortController.signal; }
		setupImageLoading();
		setupMessageHandling();
		setupEventListeners();
		createImageCollectionOverlay();
		createTiffPageOverlay();
		createDatasetOverlay();
		createNetCdfOverlay();
		createLayeredPreviewOverlay();
		createFilenameBadge();

		// Save state when webview might be disposed
		window.addEventListener('beforeunload', saveState);
		window.addEventListener('pagehide', saveState);

		// Start loading the image
		const settings = settingsManager.settings;
		const resourceUri = settings.resourceUri ?? '';

		// Load image based on file extension
		const src = settings.src ?? '';
		beginDirectLoadTrace('open', resourceUri);
		loadImageByType(src, resourceUri, _loadGeneration);

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
		mouseHandler.setPhysicalPixelSize(null);
		disposeWebglRenderers();

		// Reset each processor's initial-load flag so the reload re-sends
		// formatInfo (refreshing currentFormatInfo and per-format settings).
		// Without this, reverting a colormap decode would leave the menu/status
		// bars showing the decoded single-channel-float format instead of the
		// original image's format.
		for (const p of allProcessors) { p._isInitialLoad = true; }

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
		beginDirectLoadTrace('reload', resourceUri);
		loadImageByType(reloadSrc, resourceUri, _loadGeneration);
	}

	/**
	 * Helper function to send formatInfo (tracking happens automatically in vscode wrapper)
	 */
	function sendFormatInfo(formatInfo: object) {
		vscode.postMessage({
			type: 'formatInfo',
			value: formatInfo
		});
	}

	/**
	 * Helper to log to VS Code Output
	 */
	function logToOutput(message: string) {
		vscode.postMessage({
			type: 'log',
			value: message
		});
	}

	// PerfTrace summaries go to both the webview console and the extension's
	// Output channel, so timing is visible without opening Developer Tools.
	PerfTrace.setLogger((message) => {
		console.log(message);
		logToOutput(message);
	});

	/**
	 * Start a detailed trace for a direct image load. Collection switches and
	 * layer adds have their own labels; this covers initial open and reload.
	 */
	function beginDirectLoadTrace(action: string, resourceUri: string) {
		let name = resourceUri || 'image';
		try { name = decodeURIComponent(name.split('/').pop() || name); }
		catch { name = name.split('/').pop() || name; }
		PerfTrace.begin(`${action} ${name}`);
	}

	/**
	 * Helper to render ImageData to canvas using createImageBitmap for performance
	 */
	async function renderImageDataToCanvas(imageData: ImageData, ctx: CanvasRenderingContext2D | null, shouldDraw: () => boolean = () => true) {
		if (!ctx) return;
		if (!shouldDraw()) return;
		// Ensure the canvas matches the image size. Without this, drawing a smaller
		// image onto a canvas still sized for a previous (larger) image leaves the
		// old pixels visible around the new one — both images appear overlaid.
		if (ctx.canvas.width !== imageData.width || ctx.canvas.height !== imageData.height) {
			ctx.canvas.width = imageData.width;
			ctx.canvas.height = imageData.height;
		}
		const start = performance.now();
		const pixelCount = imageData.width * imageData.height;
		if (pixelCount > 25_000_000) {
			if (shouldDraw()) { ctx.putImageData(imageData, 0, 0); }
			console.log(`[Canvas] putImageData upload took ${(performance.now() - start).toFixed(2)}ms`);
			PerfTrace.mark('canvas-upload');
			return;
		}
		try {
			const bitmap = await createImageBitmap(imageData);
			if (shouldDraw()) { ctx.drawImage(bitmap, 0, 0); }
			bitmap.close(); // Release memory
			console.log(`[Canvas] ImageBitmap upload took ${(performance.now() - start).toFixed(2)}ms`);
		} catch (e) {
			console.error("Error creating ImageBitmap, falling back to putImageData", e);
			const fallbackStart = performance.now();
			if (shouldDraw()) { ctx.putImageData(imageData, 0, 0); }
			console.log(`[Canvas] putImageData fallback took ${(performance.now() - fallbackStart).toFixed(2)}ms`);
		}
		PerfTrace.mark('canvas-upload');
	}

	/**
	 * A canvas that has a WebGL context can never acquire a 2D context. When a
	 * later operation needs CPU ImageData rendering, replace it with a fresh
	 * canvas of the same size and styling.
	 */
	function ensure2dCanvasContext(): CanvasRenderingContext2D | null {
		if (!canvas) { return null; }
		let ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (ctx) { return ctx; }

		const replacement = document.createElement('canvas');
		replacement.width = canvas.width;
		replacement.height = canvas.height;
		replacement.className = canvas.className;
		replacement.style.cssText = canvas.style.cssText;
		if (imageElement === canvas && canvas.parentElement) {
			canvas.replaceWith(replacement);
		}
		canvas = replacement;
		imageElement = replacement;
		zoomController.setCanvas(canvas);
		zoomController.setImageElement(imageElement);
		mouseHandler.setImageElement(imageElement);
		mouseHandler.addMouseListeners(imageElement);
		ctx = canvas.getContext('2d', { willReadFrequently: true });
		return ctx;
	}

	/**
	 * Read the displayed canvas pixels from either a 2D or WebGL2-backed canvas.
	 * WebGL readPixels is bottom-left origin, so rows are flipped into ImageData.
	 */
	function readDisplayedCanvasImageData(sourceCanvas: HTMLCanvasElement): ImageData | null {
		const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
		if (ctx) {
			return ctx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
		}
		const gl = sourceCanvas.getContext('webgl2');
		if (!gl) { return null; }
		const width = sourceCanvas.width;
		const height = sourceCanvas.height;
		const bottomUp = new Uint8Array(width * height * 4);
		gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bottomUp);
		const topDown = new Uint8ClampedArray(bottomUp.length);
		const rowBytes = width * 4;
		for (let y = 0; y < height; y++) {
			const src = (height - 1 - y) * rowBytes;
			const dst = y * rowBytes;
			topDown.set(bottomUp.subarray(src, src + rowBytes), dst);
		}
		return new ImageData(topDown, width, height);
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
	function onImageError(message: string = '') {
		PerfTrace.cancel();
		hasLoadedImage = true;
		signalTiffCanvasReady();
		finishSeamlessImageTransition();
		clearCollectionLoadingState();
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
	 */
	async function handleTiff(src: string, gen: number = _loadGeneration, pageIndex: number = tiffProcessor.pageIndex) {
		currentLoadFormat = 'TIFF';
		currentLoadDecodeInfo = null;
		try {
			const result = await tiffProcessor.processTiff(src, pageIndex);
			if (gen !== _loadGeneration) { return; }
			const ome = tiffProcessor.omeMetadata;
			if (ome && !datasetManifest) {
				const images = ome.images?.length ? ome.images : [ome];
				const externalPlaneCount = images.flatMap(image => Object.values(image.coordinateToPlane || {})).filter(plane => !!plane.fileName).length;
				const requestKey = `${ome.uuid || ome.imageId || ''}:${images.length}:${externalPlaneCount}`;
				if (externalPlaneCount > 0 && requestKey !== omeDatasetRequestKey) {
					omeDatasetRequestKey = requestKey;
					vscode.postMessage({
						type: 'registerOmeDataset',
						dataset: {
							uuid: ome.uuid,
							series: images.map(image => ({
								imageId: image.imageId,
								imageName: image.imageName,
								sizeC: image.planeSizeC,
								sizeZ: image.sizeZ,
								sizeT: image.sizeT,
								channelNames: image.channels.map(channel => channel.name),
								planes: Object.values(image.coordinateToPlane || {}),
							})),
							currentResourceUri: settingsManager.settings.resourceUri,
							currentPageIndex: tiffProcessor.pageIndex,
						},
					});
				}
			} else if (tiffProcessor.omeBinaryOnly && !datasetManifest) {
				const reference = tiffProcessor.omeBinaryOnly;
				const requestKey = `binary-only:${reference.metadataFile}:${settingsManager.settings.resourceUri}`;
				if (requestKey !== omeDatasetRequestKey) {
					omeDatasetRequestKey = requestKey;
					vscode.postMessage({
						type: 'registerOmeDataset',
						dataset: {
							metadataFile: reference.metadataFile,
							metadataUuid: reference.uuid,
							currentResourceUri: settingsManager.settings.resourceUri,
							currentPageIndex: tiffProcessor.pageIndex,
						},
					});
				}
			}
			mouseHandler.setPhysicalPixelSize(ome ? {
				x: ome.physicalSizeX,
				y: ome.physicalSizeY,
				xUnit: ome.physicalSizeXUnit,
				yUnit: ome.physicalSizeYUnit,
			} : null);
			updateTiffPageOverlay();
			currentLoadDecodeInfo = result.decodeInfo;

			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;

			// Deferred TIFF renders must not create a 2D context here; doing so
			// would prevent the later WebGL2 render path from using this canvas.
			const ctx = tiffProcessor._pendingRenderData ? null : canvas.getContext('2d');
			if (ctx && primaryImageData) {
				await renderImageDataToCanvas(primaryImageData, ctx);
			}

			hasLoadedImage = true;
			signalTiffCanvasReady();
			if (!tiffProcessor._pendingRenderData) {
				finalizeImageSetup();
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logToOutput(`[Perf] TIFF Image loaded in ${webviewTime}ms (total: ${totalTime}ms${formatDecodeInfo()})`);
			}
			// else: finalizeImageSetup called after deferred render in updateSettings handler

		} catch (error) {
			if (gen !== _loadGeneration) { return; }
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
	 */
	async function handleExr(src: string, gen: number = _loadGeneration) {
		currentLoadFormat = 'EXR';
		currentLoadDecodeInfo = null;
		try {
			const result = await exrProcessor.processExr(src);
			if (gen !== _loadGeneration) { return; }

			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;

			// Deferred float renders may use WebGL2, so don't create a 2D
			// context for their placeholder canvases.
			const ctx = exrProcessor._pendingRenderData ? null : canvas.getContext('2d');
			if (ctx && primaryImageData) {
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
			if (gen !== _loadGeneration) { return; }
			console.error('Error handling EXR:', error);
			onImageError();
		}
	}

	/**
	 * Handle PFM file loading
	 */
	async function handlePfm(src: string, gen: number = _loadGeneration) {
		currentLoadFormat = 'PFM';
		currentLoadDecodeInfo = null;
		try {
			const result = await pfmProcessor.processPfm(src);
			if (gen !== _loadGeneration) { return; }
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = pfmProcessor._pendingRenderData ? null : canvas.getContext('2d');
			if (ctx && primaryImageData) {
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
			if (gen !== _loadGeneration) { return; }
			console.error('Error handling PFM:', error);
			onImageError();
		}
	}

	async function handleScientificArray(processor: ScientificArrayProcessor, src: string, gen: number = _loadGeneration, decodeOptions: Record<string, any> = {}) {
		currentLoadFormat = processor.config.formatLabel;
		currentLoadDecodeInfo = null;
		try {
			const result = await processor.process(src, decodeOptions);
			if (gen !== _loadGeneration) { return; }
			if (processor === dicomProcessor && !datasetManifest && Number(processor.metadata.frames || 1) > 1) {
				vscode.postMessage({ type: 'registerDicomFrames', frames: Number(processor.metadata.frames) });
			}
			if (processor === netcdfProcessor) {
				netcdfSelection = {
					variableName: String(processor.metadata.variable || ''),
					indices: { ...(processor.metadata.selectedIndices || {}) },
				};
				updateNetCdfOverlay(processor.metadata, false);
			}
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = processor._pendingRenderData ? null : canvas.getContext('2d');
			if (ctx && primaryImageData) { await renderImageDataToCanvas(primaryImageData, ctx); }
			hasLoadedImage = true;
			if (!processor._pendingRenderData) { finalizeImageSetup(); }
		} catch (error) {
			if (gen !== _loadGeneration) { return; }
			if (processor === netcdfProcessor) { netcdfOverlay?.classList.remove('dataset-overlay--loading'); }
			console.error(`Error handling ${processor.config.formatLabel}:`, error);
			onImageError(`Failed to load ${processor.config.formatLabel}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async function handleLayeredPreview(format: LayeredDocumentFormat, src: string, gen: number = _loadGeneration) {
		currentLoadFormat = 'Layered Document';
		currentLoadDecodeInfo = null;
		try {
			const result = await layeredPreviewProcessor.process(src, format);
			if (gen !== _loadGeneration) { return; }
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = layeredPreviewProcessor._pendingRenderData ? null : canvas.getContext('2d');
			if (ctx && primaryImageData) { await renderImageDataToCanvas(primaryImageData, ctx); }
			hasLoadedImage = true;
			updateLayeredPreviewOverlay();
			if (!layeredPreviewProcessor._pendingRenderData) { finalizeImageSetup(); }
		} catch (error) {
			if (gen !== _loadGeneration) { return; }
			console.error(`Error handling layered ${format} document:`, error);
			onImageError(`Failed to load ${format.toUpperCase()}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Handle PPM/PGM file loading
	 */
	async function handlePpm(src: string, gen: number = _loadGeneration) {
		currentLoadFormat = 'PPM/PGM';
		currentLoadDecodeInfo = null;
		try {
			const result = await ppmProcessor.processPpm(src);
			if (gen !== _loadGeneration) { return; }
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = ppmProcessor._pendingRenderData ? null : canvas.getContext('2d');
			if (ctx && primaryImageData) {
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
			if (gen !== _loadGeneration) { return; }
			console.error('Error handling PPM/PGM:', error);
			onImageError();
		}
	}

	/**
	 * Handle PNG/JPEG file loading
	 */
	async function handlePng(src: string, gen: number = _loadGeneration) {
		currentLoadFormat = 'PNG/JPEG';
		currentLoadDecodeInfo = null;
		try {
			const result = await pngProcessor.processPng(src);
			if (gen !== _loadGeneration) { return; }
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = result.displayElement || canvas;
			const ctx = pngProcessor._pendingRenderData ? null : canvas.getContext('2d');
			if (ctx && primaryImageData && !result.canvasAlreadyRendered) {
				await renderImageDataToCanvas(primaryImageData, ctx);
			}
			hasLoadedImage = true;
			if (!pngProcessor._pendingRenderData && !result.lazyPixelData) {
				finalizeImageSetup();
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logToOutput(`[Perf] PNG/JPEG Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
			}
			// else: finalizeImageSetup called after deferred render in updateSettings handler
		} catch (error) {
			if (gen !== _loadGeneration) { return; }
			console.error('Error handling PNG/JPEG:', error);
			onImageError();
		}
	}

	/**
	 * Handle NPY/NPZ file loading
	 */
	async function handleNpy(src: string, gen: number = _loadGeneration) {
		currentLoadFormat = 'NPY/NPZ';
		currentLoadDecodeInfo = null;
		try {
			const result = await npyProcessor.processNpy(src);
			if (gen !== _loadGeneration) { return; }
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = npyProcessor._pendingRenderData ? null : canvas.getContext('2d');
			if (ctx && primaryImageData) {
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
			if (gen !== _loadGeneration) { return; }
			console.error('Error handling NPY/NPZ:', error);
			onImageError();
		}
	}

	async function handleHdr(src: string, gen: number = _loadGeneration) {
		currentLoadFormat = 'HDR';
		currentLoadDecodeInfo = null;
		try {
			const result = await hdrProcessor.processHdr(src);
			if (gen !== _loadGeneration) { return; }
			canvas = result.canvas;
			primaryImageData = result.imageData;
			imageElement = canvas;
			const ctx = hdrProcessor._pendingRenderData ? null : canvas.getContext('2d');
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

	async function handleTga(src: string, gen: number = _loadGeneration) {
		currentLoadFormat = 'TGA';
		currentLoadDecodeInfo = null;
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

	async function handleWebImage(src: string, gen: number = _loadGeneration) {
		currentLoadFormat = 'Web Image';
		currentLoadDecodeInfo = null;
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

	async function handleJxl(src: string, gen: number = _loadGeneration) {
		currentLoadFormat = 'JXL';
		currentLoadDecodeInfo = null;
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

	/**
	 * Finalize image setup after loading
	 */
	function finalizeImageSetup() {
		if (!imageElement || !canvas) return;
		const nextImageElement = imageElement;
		if (_imageTransitionActive) {
			// The outgoing frame remains interactive while decoding; carry any pan or
			// zoom made during that interval into the replacement frame as well.
			_pendingZoomState = zoomController.getCurrentState();
		}
		// Update all controllers with references
		zoomController.setImageElement(nextImageElement);
		zoomController.setCanvas(canvas);
		zoomController.setImageLoaded();
		mouseHandler.setImageElement(nextImageElement);

		// Send size information to VS Code
		const sizeElement = nextImageElement as any;
		const sizeWidth = canvas?.width || sizeElement.naturalWidth || sizeElement.width;
		const sizeHeight = canvas?.height || sizeElement.naturalHeight || sizeElement.height;
		vscode.postMessage({
			type: 'size',
			value: `${sizeWidth}x${sizeHeight}`,
		});

		// Put the completed frame into the DOM before removing any stale elements.
		// replaceWith() makes collection/page changes atomic from the browser's
		// perspective: the outgoing frame remains visible until this exact point.
		if (_outgoingImageElement &&
			_outgoingImageElement !== nextImageElement &&
			_outgoingImageElement.parentElement === container) {
			_outgoingImageElement.replaceWith(nextImageElement);
		} else if (!nextImageElement.isConnected) {
			container.append(nextImageElement);
		}

		// Remove any other stale image/canvas elements, but preserve the histogram.
		const existingImages = container.querySelectorAll('img, canvas');
		existingImages.forEach(el => {
			if (el !== nextImageElement && !el.closest('.histogram-overlay')) {
				el.remove();
			}
		});

		// Update UI
		container.classList.remove('loading');
		container.classList.remove('error');
		container.classList.add('ready');

		// Apply zoom: restore saved state from before the switch, or fit if none
		if (_pendingZoomState && _pendingZoomState.scale !== 'fit') {
			zoomController.restoreState(_pendingZoomState);
		} else {
			zoomController.applyInitialZoom();
		}
		_pendingZoomState = null;
		finishSeamlessImageTransition();

		// Restore overlay counter from loading state — but only if no deferred render is still pending.
		// Deferred renders (EXR, NPY, TIFF with per-format settings, etc.) call finalizeImageSetup
		// with a placeholder canvas; the real render happens later in the updateSettings handler.
		// Clearing the loading indicator here would make it disappear before the actual image shows.
		const hasPendingDeferred = tiffProcessor._pendingRenderData ||
			layeredPreviewProcessor._pendingRenderData ||
			npyProcessor._pendingRenderData ||
			pngProcessor._pendingRenderData ||
			ppmProcessor._pendingRenderData ||
			pfmProcessor._pendingRenderData ||
			exrProcessor._pendingRenderData ||
			hdrProcessor._pendingRenderData ||
			tgaProcessor._pendingRenderData ||
			webImageProcessor._pendingRenderData ||
			jxlProcessor._pendingRenderData ||
			scientificProcessors.some(processor => !!processor._pendingRenderData);
		if (!hasPendingDeferred) {
			clearCollectionLoadingState();
		}

		mouseHandler.addMouseListeners(imageElement);
		PerfTrace.mark('finalize-dom');

		// Note: Histogram visibility is restored via restoreHistogramState message
		// when webview becomes active (sent from ImagePreview.sendHistogramState)

		// Update histogram if visible
		updateHistogramData();

		// Keep the layer stack's base in sync only when the layer system needs it.
		// Browser-native images without raw buffers otherwise force a full-canvas readback.
		if (shouldSyncBaseLayer()) {
			syncBaseLayer();
			PerfTrace.mark('layers-sync');
		} else {
			PerfTrace.detail('layers-sync-skipped', 0);
		}
		// Restore a saved layer stack after a webview reload (once the base exists).
		maybeRestoreLayers();
		PerfTrace.mark('layers-restore');
		// In a dedicated Layers window, open the panel automatically on first load
		// and ask the extension for any images to stack on top (e.g. a collection).
		if (settingsManager.settings.surfaceMode === 'layers' && !_layerSurfaceShown) {
			_layerSurfaceShown = true;
			layersPanel.show();
			if (!_pendingLayerRestore) {
				vscode.postMessage({ type: 'requestInitialLayers' });
			}
		}
		if (layerManager.active && layerManager.hasCompositeStack()) {
			recompositeLayers();
			PerfTrace.mark('layers-recomposite');
		}

		// Close the switch trace once the final pixels are shown. With a deferred
		// render pending this call is the placeholder finalize — keep the trace
		// open; the post-deferred finalize (pending cleared by then) ends it.
		PerfTrace.mark('finalize');
		if (!hasPendingDeferred) {
			PerfTrace.end();
		}
	}

	// ===================== Layer compositing helpers =====================

	function layerBaseName(uri: string): string {
		try { return decodeURIComponent((uri || '').split('/').pop() || uri || 'layer'); }
		catch { return (uri || '').split('/').pop() || 'layer'; }
	}

	/** NaN display color from current settings. */
	function getNanColorObj() {
		return settingsManager.settings && settingsManager.settings.nanColor === 'fuchsia'
			? { r: 255, g: 0, b: 255 }
			: { r: 0, g: 0, b: 0 };
	}

	function npyTypeInfo(dtype?: string): { isFloat: boolean, typeMax: number } {
		const d = String(dtype || '').toLowerCase();
		if (d.includes('f')) { return { isFloat: true, typeMax: 1.0 }; }
		const bits = parseInt(d.replace(/\D/g, ''), 10) || 8;
		return { isFloat: false, typeMax: bits >= 16 ? 65535 : 255 };
	}

	/**
	 * Map a processor's raw struct to a compositor layer.
	 */
	function lastRawToLayer(raw: any, ti: { isFloat: boolean, typeMax: number }, name: string, uri: string): LayerInput | null {
		if (!raw || !raw.data) { return null; }
		return { data: raw.data, width: raw.width, height: raw.height, channels: raw.channels, isFloat: ti.isFloat, typeMax: ti.typeMax, name, uri };
	}

	function tiffRawToLayer(raw: any, name: string, uri: string): LayerInput | null {
		if (!raw || !raw.data || !raw.ifd) { return null; }
		const ifd = raw.ifd;
		// Signed integer samples and wide (>16-bit) unsigned integer samples
		// (t339 === 2, or bitsPerSample > 16) are carried in a Float32Array too
		// (see tiff-processor.js tiffNeedsFloatCarrier/pickTiffArrayCtor), so
		// they route through the same float compositing path as true IEEE
		// float data.
		const isFloat = tiffNeedsFloatCarrier(ifd.t339, ifd.t258);
		const typeMax = tiffTypeMax(ifd.t339, ifd.t258);
		return { data: raw.data, width: ifd.width, height: ifd.height, channels: ifd.t277, isFloat, typeMax, name, uri };
	}

	function exrRawToLayer(raw: any, name: string, uri: string): LayerInput | null {
		if (!raw || !raw.data) { return null; }
		return { data: raw.data, width: raw.width, height: raw.height, channels: raw.channels, isFloat: true, typeMax: 1.0, name, uri };
	}

	/**
	 * Capture the currently displayed canvas pixels as a fallback layer (used for
	 * formats whose raw float buffer isn't readily available).
	 */
	function baseFromCanvas(name: string, uri: string): LayerInput | null {
		if (!canvas) { return null; }
		const w = canvas.width, h = canvas.height;
		const img = readDisplayedCanvasImageData(canvas);
		if (!img) { return null; }
		const data = new Float32Array(img.data.length);
		for (let i = 0; i < img.data.length; i++) { data[i] = img.data[i]; }
		return { data, width: w, height: h, channels: 4, isFloat: false, typeMax: 255, name, uri };
	}

	/**
	 * Derive the base (background) layer from whichever processor loaded the
	 * current primary image.
	 */
	function deriveBaseLayer(): LayerInput | null {
		const uri = settingsManager.settings.resourceUri || '';
		const name = layerBaseName(uri);
		switch (currentLoadFormat) {
			case 'TIFF': return tiffRawToLayer(tiffProcessor.rawTiffData, name, uri) || baseFromCanvas(name, uri);
			case 'EXR': return exrRawToLayer(exrProcessor.rawExrData, name, uri) || baseFromCanvas(name, uri);
			case 'PFM': return lastRawToLayer(pfmProcessor._lastRaw, { isFloat: true, typeMax: 1.0 }, name, uri) || baseFromCanvas(name, uri);
			case 'PPM/PGM': return lastRawToLayer(ppmProcessor._lastRaw, { isFloat: false, typeMax: (ppmProcessor._lastRaw && ppmProcessor._lastRaw.maxval) || 255 }, name, uri) || baseFromCanvas(name, uri);
			case 'PNG/JPEG': return lastRawToLayer(pngProcessor._lastRaw, { isFloat: false, typeMax: (pngProcessor._lastRaw && pngProcessor._lastRaw.maxValue) || 255 }, name, uri) || baseFromCanvas(name, uri);
			case 'NPY/NPZ': return lastRawToLayer(npyProcessor._lastRaw, npyTypeInfo(npyProcessor._lastRaw && npyProcessor._lastRaw.dtype), name, uri) || baseFromCanvas(name, uri);
			case 'HDR': return lastRawToLayer(hdrProcessor._lastRaw, { isFloat: true, typeMax: 1.0 }, name, uri) || baseFromCanvas(name, uri);
			case 'FITS': return lastRawToLayer(fitsProcessor._lastRaw, { isFloat: true, typeMax: 1.0 }, name, uri) || baseFromCanvas(name, uri);
			case 'DICOM': return lastRawToLayer(dicomProcessor._lastRaw, { isFloat: true, typeMax: 1.0 }, name, uri) || baseFromCanvas(name, uri);
			case 'NetCDF': return lastRawToLayer(netcdfProcessor._lastRaw, { isFloat: true, typeMax: 1.0 }, name, uri) || baseFromCanvas(name, uri);
			case 'Layered Document': {
				const raw = layeredPreviewProcessor._lastRaw;
				const activeRaw = raw ? { ...raw, data: layeredPreviewProcessor.activeData() } : null;
				return lastRawToLayer(activeRaw, { isFloat: raw?.sampleFormat === 3, typeMax: raw?.sampleFormat === 3 ? 1 : raw?.bitDepth === 16 ? 65535 : 255 }, name, uri) || baseFromCanvas(name, uri);
			}
			default: return baseFromCanvas(name, uri);
		}
	}

	/**
	 * Decode an image URI into a layer using a fresh processor instance (so the
	 * primary image's processor state is never disturbed). Falls back to a plain
	 * <img> decode for formats without an exposed raw buffer.
	 * @param src Webview-safe URI to fetch.
	 * @param resourceUri Original resource URI (for extension + name).
	 */
	async function decodeLayer(src: string, resourceUri: string): Promise<LayerInput | null> {
		const lower = (resourceUri || src || '').toLowerCase();
		const name = layerBaseName(resourceUri || src);
		const noop = {
			postMessage() { },
			setState() { },
			getState: (): any => undefined,
		};
		try {
			const layeredFormat = layeredFormatForPath(lower);
			if (layeredFormat) {
				const p = new LayeredPreviewProcessor(settingsManager, noop); p._isInitialLoad = false; p.decodeWorker = decodeWorkerClient;
				await p.process(src, layeredFormat);
				const raw = p._lastRaw;
				return lastRawToLayer(raw, { isFloat: raw?.sampleFormat === 3, typeMax: raw?.sampleFormat === 3 ? 1 : raw?.bitDepth === 16 ? 65535 : 255 }, name, resourceUri);
			}
			if (isTiffExtension(lower)) {
				const p = new TiffProcessor(settingsManager, noop); p._isInitialLoad = false; p.decodeWorker = decodeWorkerClient;
				await p.processTiff(src); return tiffRawToLayer(p.rawTiffData, name, resourceUri);
			}
			if (lower.endsWith('.exr')) {
				const p = new ExrProcessor(settingsManager, noop); p._isInitialLoad = false; p.decodeWorker = decodeWorkerClient;
				await p.processExr(src); return exrRawToLayer(p.rawExrData, name, resourceUri);
			}
			if (lower.endsWith('.pfm')) {
				const p = new PfmProcessor(settingsManager, noop); p._isInitialLoad = false; p.decodeWorker = decodeWorkerClient;
				await p.processPfm(src); return lastRawToLayer(p._lastRaw, { isFloat: true, typeMax: 1.0 }, name, resourceUri);
			}
			if (lower.match(/\.(ppm|pgm|pbm)$/)) {
				const p = new PpmProcessor(settingsManager, noop); p._isInitialLoad = false; p.decodeWorker = decodeWorkerClient;
				await p.processPpm(src); return lastRawToLayer(p._lastRaw, { isFloat: false, typeMax: (p._lastRaw && p._lastRaw.maxval) || 255 }, name, resourceUri);
			}
			if (lower.match(/\.(png|jpg|jpeg)$/)) {
				const p = new PngProcessor(settingsManager, noop); p._isInitialLoad = false; p.decodeWorker = decodeWorkerClient;
				await p.processPng(src);
				const layer = lastRawToLayer(p._lastRaw, { isFloat: false, typeMax: (p._lastRaw && p._lastRaw.maxValue) || 255 }, name, resourceUri);
				return layer || decodeViaImage(src, name, resourceUri);
			}
			if (lower.match(/\.(npy|npz)$/)) {
				const p = new NpyProcessor(settingsManager, noop); p._isInitialLoad = false; p.decodeWorker = decodeWorkerClient;
				await p.processNpy(src); return lastRawToLayer(p._lastRaw, npyTypeInfo(p._lastRaw && p._lastRaw.dtype), name, resourceUri);
			}
			const scientificConfig = lower.match(/\.(fits|fit|fts)$/) ? fitsProcessor.config :
				lower.match(/\.(dcm|dicom)$/) ? dicomProcessor.config :
				lower.match(/\.(nc|cdf)$/) ? netcdfProcessor.config : null;
			if (scientificConfig) {
				const p = new ScientificArrayProcessor(settingsManager, noop, scientificConfig); p._isInitialLoad = false; p.decodeWorker = decodeWorkerClient;
				await p.process(src); return lastRawToLayer(p._lastRaw, { isFloat: true, typeMax: 1.0 }, name, resourceUri);
			}
			return decodeViaImage(src, name, resourceUri);
		} catch (err) {
			console.error('Failed to decode layer', resourceUri, err);
			return null;
		}
	}

	/**
	 * Decode any browser-loadable image into an RGBA float layer.
	 */
	function decodeViaImage(src: string, name: string, uri: string): Promise<LayerInput | null> {
		return new Promise((resolve) => {
			const img = new Image();
			img.onload = () => {
				const c = document.createElement('canvas');
				c.width = img.naturalWidth; c.height = img.naturalHeight;
				const ctx = c.getContext('2d');
				if (!ctx) { resolve(null); return; }
				ctx.drawImage(img, 0, 0);
				const id = ctx.getImageData(0, 0, c.width, c.height);
				const data = new Float32Array(id.data.length);
				for (let i = 0; i < id.data.length; i++) { data[i] = id.data[i]; }
				resolve({ data, width: c.width, height: c.height, channels: 4, isFloat: false, typeMax: 255, name, uri });
			};
			img.onerror = () => resolve(null);
			img.src = src;
		});
	}

	/** (Re)synchronize the base layer with the current primary image. */
	function shouldSyncBaseLayer() {
		return layerManager.active ||
			layersPanel.isVisible() ||
			!!_pendingLayerRestore ||
			settingsManager.settings.surfaceMode === 'layers' ||
			layerManager.hasExtraLayers();
	}

	/** Expand compatible document raster nodes into the editable layer stack. */
	function installLayeredDocumentLayers(): boolean {
		const raw = layeredPreviewProcessor._lastRaw;
		const uri = settingsManager.settings.resourceUri || '';
		if (!raw?.layerAssets?.length) { return false; }
		if (_expandedLayerDocumentUri === uri && layerManager.layers.length === raw.layerAssets.length) { return true; }
		const supportedModes = new Set(BLEND_MODES.map(mode => mode.id));
		const layers = [...raw.layerAssets].reverse().map(asset => layerManager.createLayer({
			data: asset.data, width: asset.width, height: asset.height, channels: 4,
			isFloat: false, typeMax: 255,
			name: asset.name,
			kind: asset.kind || 'raster',
			parentId: asset.parentId,
			clipped: asset.clipped,
			rasterMask: asset.rasterMask ? {
				data: asset.rasterMask.data, width: asset.rasterMask.width, height: asset.rasterMask.height,
				channels: asset.rasterMask.channels, typeMax: asset.rasterMask.typeMax,
				offsetX: asset.rasterMask.x, offsetY: asset.rasterMask.y,
			} : undefined,
			groupPath: asset.groupPath,
			groupIds: asset.groupIds,
			sourceNodeId: asset.nodeId,
			sourceSupport: asset.support,
			sourceBlendMode: asset.blendMode,
		}, {
			offsetX: asset.x, offsetY: asset.y, opacity: asset.opacity,
			visible: asset.visible,
			blendMode: supportedModes.has(asset.blendMode) ? asset.blendMode : 'normal',
		}));
		if (!layers.length) { return false; }
		layerManager.setLayers(layers, raw.document.width, raw.document.height);
		layerManager.documentExpanded = true;
		_expandedLayerDocumentUri = uri;
		_layerBaseUri = uri;
		layersPanel.refresh();
		return true;
	}

	function syncBaseLayer() {
		const base = deriveBaseLayer();
		if (!base) { return; }
		if (_layerBaseUri !== base.uri || layerManager.isEmpty()) {
			_layerBaseUri = base.uri;
			layerManager.setBaseLayer(base);
			if (layersPanel.isVisible()) { layersPanel.refresh(); }
		} else {
			// Same image re-rendered: refresh the matching layer's data in place
			// (it may have been reordered). If the user removed that layer, leave
			// the stack untouched — don't re-inject it.
			const existing = layerManager.layers.find(l => l.uri === base.uri);
			if (existing) {
				Object.assign(existing, {
					data: base.data, width: base.width, height: base.height,
					channels: base.channels, isFloat: base.isFloat, typeMax: base.typeMax,
				});
				layerManager.canvasWidth = base.width;
				layerManager.canvasHeight = base.height;
			}
		}
	}

	/**
	 * Composite the layer stack and draw the result to the main canvas.
	 * @returns True if a composite was rendered.
	 */
	function recompositeLayers(): boolean {
		if (!layerManager.active || !canvas) { return false; }
		const renderGeneration = ++_layerCanvasRenderGeneration;
		const imageData = layerManager.renderToImageData(settingsManager.settings, { nanColor: getNanColorObj() });
		if (!imageData) { return false; }
		if (canvas.width !== imageData.width || canvas.height !== imageData.height) {
			canvas.width = imageData.width;
			canvas.height = imageData.height;
		}
		const ctx = ensure2dCanvasContext();
		if (ctx) {
			void renderImageDataToCanvas(imageData, ctx, () =>
				renderGeneration === _layerCanvasRenderGeneration && layerManager.active);
			primaryImageData = imageData;
			updateHistogramData();
		}
		return true;
	}

	// Coalesce rapid recomposite requests. Interactive drags get a short trailing
	// debounce because a full large-layer composite can take hundreds of ms or
	// seconds, and running one for every slider event makes the slider itself lag.
	let _recompositeScheduled = false;
	let _interactiveRecompositeTimer: ReturnType<typeof setTimeout> | null = null;
	function scheduleRecomposite(delayMs: number = 0) {
		if (delayMs > 0) {
			if (_interactiveRecompositeTimer) { clearTimeout(_interactiveRecompositeTimer); }
			_interactiveRecompositeTimer = setTimeout(() => {
				_interactiveRecompositeTimer = null;
				scheduleRecomposite(0);
			}, delayMs);
			return;
		}
		if (_interactiveRecompositeTimer) {
			clearTimeout(_interactiveRecompositeTimer);
			_interactiveRecompositeTimer = null;
		}
		if (_recompositeScheduled) { return; }
		_recompositeScheduled = true;
		requestAnimationFrame(() => {
			_recompositeScheduled = false;
			recompositeLayers();
		});
	}

	// ---- Layer restore after a webview reload (tab switch) ----
	let _layersRestoreDone = false;
	// True once the dedicated Layers window has auto-opened its panel.
	let _layerSurfaceShown = false;

	/** Kick off layer-stack restore once the base image has loaded. */
	function maybeRestoreLayers() {
		if (_layersRestoreDone || !_pendingLayerRestore) { return; }
		_layersRestoreDone = true;

		const metas = _pendingLayerRestore.layers || [];
		const baseMeta = metas.find(m => m.isBase);
		const currentUri = settingsManager.settings.resourceUri;
		// Only restore if the saved stack belongs to the image now showing.
		if (baseMeta && baseMeta.resourceUri && currentUri && baseMeta.resourceUri !== currentUri) {
			_pendingLayerRestore = null;
			return;
		}

		const nonBase = metas.filter(m => !m.isBase && m.resourceUri);
		if (nonBase.length === 0) {
			finishLayerRestore({});
		} else {
			// Ask the extension for webview-safe URIs to fetch the layer images.
			vscode.postMessage({ type: 'resolveLayerUris', resourceUris: nonBase.map(m => m.resourceUri) });
		}
	}

	/**
	 * Rebuild the layer stack from the pending metadata using resolved URIs.
	 */
	async function finishLayerRestore(uriMap: { [resourceUri: string]: string }) {
		const pending = _pendingLayerRestore;
		_pendingLayerRestore = null;
		if (!pending) { return; }

		syncBaseLayer();
		const baseLayer = layerManager.layers.find(l => l.uri === settingsManager.settings.resourceUri) || layerManager.layers[0];
		const rebuilt = [];
		for (const meta of pending.layers) {
			if (meta.isBase) {
				if (baseLayer) {
					Object.assign(baseLayer, {
						offsetX: meta.offsetX ?? 0, offsetY: meta.offsetY ?? 0,
						opacity: meta.opacity ?? 1, blendMode: meta.blendMode ?? 'normal',
						visible: meta.visible !== false, maskCondition: meta.maskCondition,
					});
					rebuilt.push(baseLayer);
				}
			} else {
				const src = uriMap[meta.resourceUri];
				if (!src) { continue; }
				const input = await decodeLayer(src, meta.resourceUri);
				if (input) { rebuilt.push(layerManager.createLayer(input, meta)); }
			}
		}
		if (rebuilt.length === 0) {
			if (baseLayer) { rebuilt.push(baseLayer); } else { return; }
		}
		layerManager.setLayers(rebuilt, layerManager.canvasWidth, layerManager.canvasHeight);
		layersPanel.collapsed = !!pending.collapsed;
		if (pending.active) {
			layersPanel.show(); // sets active, notifies the extension and recomposites
		} else {
			layersPanel.refresh();
		}
	}

	/** Drag-on-image move tool for the layer armed in the panel. */
	let _layerDrag: { id: string, lastX: number, lastY: number } | null = null;
	function setupLayerMoveDrag() {
		container.addEventListener('mousedown', (e) => {
			if (!layerManager.active || !layersPanel.movingLayerId || !imageElement) { return; }
			const target = e.target as Node | null;
			// Never hijack clicks on the panel — its controls must keep working.
			if (layersPanel.root && target && layersPanel.root.contains(target)) { return; }
			// Only begin a move when the drag starts on the image/canvas itself.
			const onImage = target === imageElement || target === canvas ||
				(!!target && !!imageElement.contains && imageElement.contains(target));
			if (!onImage) { return; }
			_layerDrag = { id: layersPanel.movingLayerId, lastX: e.clientX, lastY: e.clientY };
			// Capture-phase stop so the zoom/pan controller doesn't also react.
			e.preventDefault();
			e.stopPropagation();
		}, true);
		window.addEventListener('mousemove', (e) => {
			if (!_layerDrag || !canvas || !imageElement) { return; }
			const rect = imageElement.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) { return; }
			const dx = Math.round(((e.clientX - _layerDrag.lastX) / rect.width) * canvas.width);
			const dy = Math.round(((e.clientY - _layerDrag.lastY) / rect.height) * canvas.height);
			if (dx !== 0 || dy !== 0) {
				layerManager.moveLayer(_layerDrag.id, dx, dy);
				_layerDrag.lastX = e.clientX;
				_layerDrag.lastY = e.clientY;
				scheduleRecomposite();
			}
		});
		window.addEventListener('mouseup', () => {
			if (_layerDrag) {
				_layerDrag = null;
				layersPanel.refresh(); // sync the numeric offset inputs after the drag
				scheduleSaveState();
			}
		});
	}

	function swapImageElementToCanvas() {
		if (!canvas || imageElement === canvas) return;
		const previousElement = imageElement;
		if (previousElement) {
			canvas.className = previousElement.className;
			canvas.style.cssText = previousElement.style.cssText;
			if (previousElement.parentElement) {
				previousElement.replaceWith(canvas);
			}
		}
		imageElement = canvas;
		zoomController.setCanvas(canvas);
		zoomController.setImageElement(imageElement);
		mouseHandler.setImageElement(imageElement);
		mouseHandler.addMouseListeners(imageElement);
	}

	/**
	 * Clear the collection loading indicators (overlay dot + badge highlight).
	 * Called once the final image pixels are rendered — either directly in
	 * finalizeImageSetup (no deferred render) or after performDeferredRender completes.
	 */
	function clearCollectionLoadingState() {
		if (overlayElement) {
			if (imageCollection.show) {
				const counter = overlayElement.querySelector('.image-counter');
				if (counter) {
					counter.textContent = `${imageCollection.currentIndex + 1} of ${imageCollection.totalImages}`;
					counter.removeAttribute('aria-label');
				}
			}
			overlayElement.classList.remove('image-collection-overlay--loading');
		}
		if (filenameBadge) filenameBadge.classList.remove('filename-badge--loading');
		_collectionSwitchLoading = false;
		datasetLoading = false;
		updateDatasetOverlay(false);
		updateTiffPageOverlay(false);
	}

	function getDisplayedImageElement(): HTMLElement | null {
		for (const child of Array.from(container.children)) {
			if (child instanceof HTMLElement && (child.tagName === 'IMG' || child.tagName === 'CANVAS')) {
				return child;
			}
		}
		return null;
	}

	/** Keep the current frame on screen while its replacement is decoded. */
	function beginSeamlessImageTransition(isCollectionSwitch: boolean = false) {
		_outgoingImageElement = getDisplayedImageElement();
		_imageTransitionActive = _outgoingImageElement !== null;
		_collectionSwitchLoading = isCollectionSwitch;

		if (_imageTransitionActive) {
			container.classList.remove('loading', 'error');
			container.classList.add('ready', 'image-transition-pending');
			container.setAttribute('aria-busy', 'true');
		} else {
			container.classList.add('loading');
		}
	}

	function finishSeamlessImageTransition() {
		_outgoingImageElement = null;
		_imageTransitionActive = false;
		container.classList.remove('image-transition-pending');
		container.removeAttribute('aria-busy');
	}

	function renderCollectionLoadingState() {
		if (!overlayElement || !imageCollection.show || !_collectionSwitchLoading) { return; }
		const counter = overlayElement.querySelector('.image-counter');
		if (counter && !activeCounterInput) {
			const position = `${imageCollection.currentIndex + 1} of ${imageCollection.totalImages}`;
			counter.innerHTML = `<span class="collection-loading-dot" aria-hidden="true"></span><span class="collection-loading-label">Loading</span> ${position}`;
			counter.setAttribute('aria-label', `Loading image ${position}`);
		}
		overlayElement.classList.add('image-collection-overlay--loading');
	}

	function requestCollectionNavigation(direction: 'next' | 'previous') {
		if (imageCollection.totalImages <= 1) { return; }
		_collectionSwitchLoading = true;
		renderCollectionLoadingState();
		if (filenameBadge) filenameBadge.classList.add('filename-badge--loading');
		vscode.postMessage({
			type: direction === 'next' ? 'toggleImage' : 'toggleImageReverse'
		});
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

		// Enable the layer move tool (drag-on-image) once.
		setupLayerMoveDrag();

		// Send ready message to VS Code
		vscode.postMessage({ type: 'get-initial-data' });
	}

	/**
	 * Handle messages from VS Code
	 */
	async function handleVSCodeMessage(message: { type: string, [key: string]: any }) {
		switch (message.type) {
			case 'setScale':
				zoomController.updateScale(message.scale);
				break;

			case 'addLayerImages': {
				const images = message.images || [];
				const imageLabel = `${images.length} image${images.length === 1 ? '' : 's'}`;
				PerfTrace.begin(`add-layer ${imageLabel}`, { conciseLabel: `Layer add (${imageLabel}) completed` });
				syncBaseLayer();
				PerfTrace.mark('layers-base-sync');
				const wasLayerActive = layerManager.active;
				layersPanel.show({ notify: false });
				if (!wasLayerActive) {
					layerManager.active = true;
					vscode.postMessage({ type: 'layerModeChanged', active: true });
				}
				PerfTrace.mark('layers-panel-show');
				let addedLayers = 0;
				for (const im of images) {
					const layer = await decodeLayer(im.src, im.resourceUri);
					PerfTrace.mark('layer-decode');
					if (layer) { layerManager.addLayer(layer); addedLayers++; }
				}
				if (addedLayers > 0) {
					layersPanel.refresh();
					PerfTrace.mark('layers-panel-refresh');
					recompositeLayers();
					PerfTrace.mark('layers-recomposite-submit');
					scheduleSaveState();
					PerfTrace.mark('layers-state-save-scheduled');
				} else {
					vscode.postMessage({ type: 'show-error', message: 'Could not load the selected image(s) as layers.' });
					PerfTrace.mark('layers-add-failed');
				}
				PerfTrace.end();
				break;
			}

			case 'layerUrisResolved':
				finishLayerRestore(message.map || {});
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

			case 'exportAsXcf':
				exportAsXcf();
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
				const updateMessageStart = performance.now();
				// Handle real-time settings updates
				const oldResourceUri = settingsManager.settings.resourceUri;
				const updateApplyStart = performance.now();
				const changes = settingsManager.updateSettings(message.settings);
				const updateApplyDuration = performance.now() - updateApplyStart;
				const newResourceUri = settingsManager.settings.resourceUri;
				const updateReason = message.reason || (message.isInitialRender ? 'initial-render' : 'unspecified');

				// formatInfo is posted from inside processTiff(), before handleTiff()
				// receives and installs its canvas. Do not drop the immediate
				// initial-settings response while that canvas is still in flight.
				if (message.isInitialRender && currentLoadFormat === 'TIFF' && !canvas) {
					const waitingGeneration = _loadGeneration;
					const canvasWaitStart = performance.now();
					await _tiffCanvasReadyPromise;
					PerfTrace.detail('await-settings-tiff-canvas-wait', performance.now() - canvasWaitStart);
					if (waitingGeneration !== _loadGeneration) {
						break;
					}
				}

				// Check if this is a deferred render trigger (initial load)
				if (message.isInitialRender && canvas) {
					// Time between formatInfo going out and per-format settings
					// coming back — extension-host latency, not main-thread work.
					if (lastFormatInfoPost && lastFormatInfoPost.generation === _loadGeneration) {
						PerfTrace.detail('await-settings-roundtrip', updateMessageStart - lastFormatInfoPost.time);
					}
					PerfTrace.detail('settings-apply', updateApplyDuration);
					PerfTrace.mark('await-settings');
					// Trigger deferred rendering for the appropriate processor
					let deferredImageData = null;
					let deferredCanvasAlreadyRendered = false;
					const pendingScientific = scientificProcessors.find(processor => !!processor._pendingRenderData);

					if (tiffProcessor._pendingRenderData) {
						deferredImageData = await tiffProcessor.performDeferredRender({
							collectHistogram: histogramOverlay.getVisibility(),
							targetCanvas: canvas,
							placeholderImageData: primaryImageData
						});
						deferredCanvasAlreadyRendered = tiffProcessor._lastRenderUsedWebGL === true;
					} else if (layeredPreviewProcessor._pendingRenderData) {
						deferredImageData = layeredPreviewProcessor.performDeferredRender({
							collectHistogram: histogramOverlay.getVisibility(),
							targetCanvas: canvas,
							placeholderImageData: primaryImageData
						});
					} else if (npyProcessor._pendingRenderData) {
						deferredImageData = npyProcessor.performDeferredRender({
							collectHistogram: histogramOverlay.getVisibility(),
							targetCanvas: canvas,
							placeholderImageData: primaryImageData
						});
						deferredCanvasAlreadyRendered = npyProcessor._lastRenderUsedWebGL === true;
					} else if (pngProcessor._pendingRenderData) {
						deferredImageData = pngProcessor.performDeferredRender({
							collectHistogram: histogramOverlay.getVisibility(),
							targetCanvas: canvas,
							placeholderImageData: primaryImageData
						});
						deferredCanvasAlreadyRendered = pngProcessor._lastRenderReusedOriginalImageData === true || pngProcessor._lastRenderUsedWebGL === true;
					} else if (ppmProcessor._pendingRenderData) {
						deferredImageData = ppmProcessor.performDeferredRender({
							collectHistogram: histogramOverlay.getVisibility(),
							targetCanvas: canvas,
							placeholderImageData: primaryImageData
						});
						deferredCanvasAlreadyRendered = ppmProcessor._lastRenderUsedWebGL === true;
					} else if (pfmProcessor._pendingRenderData) {
						deferredImageData = pfmProcessor.performDeferredRender({
							collectHistogram: histogramOverlay.getVisibility(),
							targetCanvas: canvas,
							placeholderImageData: primaryImageData
						});
						deferredCanvasAlreadyRendered = pfmProcessor._lastRenderUsedWebGL === true;
					} else if (pendingScientific) {
						deferredImageData = pendingScientific.performDeferredRender({
							collectHistogram: histogramOverlay.getVisibility(),
							targetCanvas: canvas,
							placeholderImageData: primaryImageData
						});
						deferredCanvasAlreadyRendered = pendingScientific._lastRenderUsedWebGL === true;
					} else if (exrProcessor._pendingRenderData) {
						deferredImageData = exrProcessor.updateSettings(settingsManager.settings, {
							collectHistogram: histogramOverlay.getVisibility(),
							targetCanvas: canvas,
							placeholderImageData: primaryImageData
						});
						deferredCanvasAlreadyRendered = exrProcessor._lastRenderUsedWebGL === true;
					} else if (hdrProcessor._pendingRenderData) {
						deferredImageData = hdrProcessor.performDeferredRender({
							collectHistogram: histogramOverlay.getVisibility(),
							targetCanvas: canvas,
							placeholderImageData: primaryImageData
						});
						deferredCanvasAlreadyRendered = hdrProcessor._lastRenderUsedWebGL === true;
					} else if (tgaProcessor._pendingRenderData) {
						deferredImageData = tgaProcessor.performDeferredRender();
					} else if (webImageProcessor._pendingRenderData) {
						deferredImageData = webImageProcessor.performDeferredRender();
					} else if (jxlProcessor._pendingRenderData) {
						deferredImageData = jxlProcessor.performDeferredRender();
					}

					if (deferredImageData) {
						if (deferredCanvasAlreadyRendered) {
							PerfTrace.mark('canvas-upload-skipped');
							primaryImageData = deferredImageData;
						} else {
							// Use ensure2dCanvasContext(), not a raw canvas.getContext('2d', ...):
							// the WebGL attempt just above (canRender()==true but render()
							// failing after _ensureContext() already called
							// canvas.getContext('webgl2', ...)) can leave this exact canvas
							// permanently locked to the webgl2 context type — getContext('2d')
							// on it then returns null forever, silently skipping the paint
							// below and leaving the placeholder canvas visibly black until an
							// unrelated settings change routes through updateImageWithNewSettings
							// (which already calls ensure2dCanvasContext()) and swaps in a fresh
							// canvas. Doing the same swap here on the very first deferred render
							// avoids ever showing that black canvas.
							const ctx = ensure2dCanvasContext();
							if (ctx) {
								await renderImageDataToCanvas(deferredImageData, ctx);
								primaryImageData = deferredImageData;
							}
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
							logToOutput(`[Perf] ${currentLoadFormat} Image loaded in ${webviewTime}ms (total: ${totalTime}ms${formatDecodeInfo()})`);
							initialLoadStartTime = 0; // Reset
						}
					} else if (pngProcessor.hasLazyNativeReadback()) {
						if (!pngProcessor.canUseLazyNativeCanvasForSettings(settingsManager.settings)) {
							await updateImageWithNewSettings(changes);
						}
						finalizeImageSetup();
						clearCollectionLoadingState();
						if (initialLoadStartTime > 0) {
							const endTime = performance.now();
							const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
							const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
							logToOutput(`[Perf] ${currentLoadFormat} Image loaded in ${webviewTime}ms (total: ${totalTime}ms${formatDecodeInfo()})`);
							initialLoadStartTime = 0;
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
						layeredPreviewProcessor._pendingRenderData ||
						(npyProcessor && npyProcessor._pendingRenderData) ||
						(pngProcessor && pngProcessor._pendingRenderData) ||
						(ppmProcessor && ppmProcessor._pendingRenderData) ||
						(pfmProcessor && pfmProcessor._pendingRenderData) ||
						(exrProcessor && exrProcessor._pendingRenderData) ||
						(hdrProcessor && hdrProcessor._pendingRenderData) ||
						(tgaProcessor && tgaProcessor._pendingRenderData) ||
						(webImageProcessor && webImageProcessor._pendingRenderData) ||
						(jxlProcessor && jxlProcessor._pendingRenderData) ||
						scientificProcessors.some(processor => !!processor._pendingRenderData);

					if (hasLoadedImage && !hasPendingRender && changes.changed) {
						const startTime = performance.now();
						await updateImageWithNewSettings(changes);
						const endTime = performance.now();
						logToOutput(`[Perf] Settings re-render (${updateReason}; ${changes.changedKeys.join(', ')}) took ${(endTime - startTime).toFixed(2)}ms`);
					} else if (hasLoadedImage && !hasPendingRender && !changes.changed) {
						logToOutput(`[Perf] Skipped no-op settings update (${updateReason})`);
					}
				}
				break;

			case 'updateLoadStartTime':
				extensionLoadStartTime = message.timestamp;
				break;

			case 'updateImageCollectionOverlay':
				updateImageCollectionOverlay(message.data);
				break;

			case 'setDataset':
				datasetManifest = message.manifest || null;
				datasetSeriesIndex = Number(message.seriesIndex || 0);
				datasetCoordinates = { ...(message.coordinates || {}) };
				imageCollection = { totalImages: 1, currentIndex: 0, show: false };
				updateImageCollectionOverlay(imageCollection);
				updateDatasetOverlay(false);
				{
					const series = datasetManifest?.series[datasetSeriesIndex];
					const plane = series?.planes.find(candidate =>
						series.axes.every(axis => (candidate.coordinates[axis.key] || 0) === (datasetCoordinates[axis.key] || 0)));
					const currentResource = settingsManager.settings.resourceUri;
					const alreadyDisplayed = !!plane && plane.resourceUri === currentResource && (
						plane.format === 'dicom'
							? Number(plane.frameIndex || 0) === Number(dicomProcessor.metadata.frameIndex || 0) && !!dicomProcessor._lastRaw
							: Number(plane.pageIndex || 0) === tiffProcessor.pageIndex && !!tiffProcessor.rawTiffData
					);
					if (!alreadyDisplayed) { requestDatasetNavigation(datasetSeriesIndex, datasetCoordinates); }
				}
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
				// The target position travels with the switch so the loading badge never
				// flashes the outgoing image number before the separate overlay update.
				if (message.collection) {
					imageCollection = message.collection;
				}
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

			case 'switchToDatasetPlane':
				datasetSeriesIndex = Number(message.seriesIndex || 0);
				datasetCoordinates = { ...(message.coordinates || {}) };
				datasetLoading = true;
				updateDatasetOverlay(true);
				switchToNewImage(message.uri, message.resourceUri, {
					formatHint: message.formatHint,
					pageIndex: message.pageIndex,
					frameIndex: message.frameIndex,
				});
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

			case 'toggleMetadata':
				metadataPanel.toggle();
				updateMetadataData();
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

			case 'setDisplayColormap':
				// Apply (or clear) a render-time pseudocolor colormap.
				await handleSetDisplayColormap(message.colormap || 'none');
				break;
		}
	}

	/**
	 * Set the render-time display colormap (pseudocolor) and re-render. Pass
	 * 'none' to clear it. Applies to single-channel images and to layers, since
	 * everything renders through ImageRenderer which reads this setting.
	 */
	async function handleSetDisplayColormap(colormapName: string) {
		settingsManager.settings.displayColormap = colormapName;
		saveState();
		await updateImageWithNewSettings({
			changed: true,
			changedKeys: ['displayColormap'],
			parametersOnly: true,
			changedStructure: false
		});
	}

	/**
	 * Gather the currently active image's metadata/tags/statistics for the
	 * Metadata panel, checking each processor's stored raw data in the same
	 * priority order as updateHistogramData below.
	 */
	function gatherActiveMetadataInfo(): MetadataInfo | null {
		let formatLabel: string;
		let fileFields: Record<string, string>;
		let tags: TagEntry[] = [];
		let data: ArrayLike<number> | null = null;
		let width = 0, height = 0, channels = 1;

		if (tiffProcessor.rawTiffData) {
			const ifd = tiffProcessor.rawTiffData.ifd;
			width = ifd.width; height = ifd.height; channels = ifd.t277 || 1;
			const bitsPerSample = ifd.t258 || 8;
			const sampleFormat = ifd.t339;
			const sampleFormatLabel = sampleFormat === 3 ? 'IEEE float' : (sampleFormat === 2 ? 'signed int' : 'unsigned int');
			formatLabel = 'TIFF';
			fileFields = {
				'Dimensions': `${width} x ${height}`,
				'Channels': String(channels),
				'Bits/Sample': String(bitsPerSample),
				'Sample Format': sampleFormatLabel
			};
			const ome = tiffProcessor.omeMetadata;
			if (ome) {
				const coordinates = omeIfdToCoordinates(ome, tiffProcessor.pageIndex);
				fileFields['OME Dimensions'] = `C ${ome.planeSizeC} × Z ${ome.sizeZ} × T ${ome.sizeT}`;
				fileFields['Current Plane'] = `C ${coordinates.c + 1}, Z ${coordinates.z + 1}, T ${coordinates.t + 1} (IFD ${tiffProcessor.pageIndex})`;
				fileFields['Dimension Order'] = ome.dimensionOrder;
				if (ome.imageName) { fileFields['Image Name'] = ome.imageName; }
				if (ome.pixelType) { fileFields['OME Pixel Type'] = ome.pixelType; }
				if (ome.channels.length) { fileFields['OME Channels'] = ome.channels.map(channel => channel.name).join(', '); }
				if (ome.physicalSizeX !== undefined) { fileFields['Physical Size X'] = `${ome.physicalSizeX} ${ome.physicalSizeXUnit || ''}`.trim(); }
				if (ome.physicalSizeY !== undefined) { fileFields['Physical Size Y'] = `${ome.physicalSizeY} ${ome.physicalSizeYUnit || ''}`.trim(); }
				if (ome.physicalSizeZ !== undefined) { fileFields['Physical Size Z'] = `${ome.physicalSizeZ} ${ome.physicalSizeZUnit || ''}`.trim(); }
				if (ome.timeIncrement !== undefined) { fileFields['Time Increment'] = `${ome.timeIncrement} ${ome.timeIncrementUnit || ''}`.trim(); }
				if (ome.objective) {
					const objective = ome.objective;
					fileFields['Objective'] = [objective.manufacturer, objective.model].filter(Boolean).join(' ') || objective.id || 'n/a';
					if (objective.nominalMagnification !== undefined) { fileFields['Magnification'] = `${objective.nominalMagnification}×`; }
					if (objective.lensNA !== undefined) { fileFields['Objective NA'] = String(objective.lensNA); }
					if (objective.immersion) { fileFields['Immersion'] = objective.immersion; }
				}
			}
			tags = tiffProcessor._lastAllTags || [];
			data = tiffProcessor.rawTiffData.data;
		} else if (exrProcessor.rawExrData) {
			const r = exrProcessor.rawExrData;
			width = r.width; height = r.height; channels = r.channels || 1;
			formatLabel = 'EXR';
			fileFields = {
				'Dimensions': `${width} x ${height}`,
				'Channels': String(channels),
				'Channel Names': (r.channelNames || []).join(', ') || 'n/a',
				'Precision': r.type === 1016 ? 'half (float16)' : 'float32'
			};
			tags = exrProcessor._lastAllTags || [];
			data = r.data;
		} else if (layeredPreviewProcessor._lastRaw) {
			const r = layeredPreviewProcessor._lastRaw;
			const doc = r.document;
			width = r.width; height = r.height; channels = r.channels;
			formatLabel = r.formatLabel;
			fileFields = {
				'Dimensions': `${width} x ${height}`,
				'Channels': String(channels),
				'Bit Depth': String(r.bitDepth),
				'Layers': String(doc.layerCount),
				'Preview': `${doc.previewKind} (${layeredPreviewProcessor.previewMode})`,
				'Preview Fidelity': doc.previewIsAuthoritative ? 'authoritative embedded preview' : 'reconstructed or heuristic',
			};
			if (doc.warnings.length) { fileFields['Compatibility Notes'] = doc.warnings.join(' · '); }
			for (const [key, value] of Object.entries(layeredPreviewProcessor.metadata)) {
				fileFields[key.replace(/([a-z])([A-Z])/g, '$1 $2')] = String(value);
			}
			if (doc.reconstruction?.available) {
				fileFields['Reconstruction Difference'] = doc.reconstruction.differentPixelRatio === undefined
					? 'available; integrated preview dimensions differ'
					: `${(doc.reconstruction.differentPixelRatio * 100).toFixed(3)}% pixels`;
			}
			data = layeredPreviewProcessor.activeData();
		} else if (npyProcessor._lastRaw) {
			const r = npyProcessor._lastRaw;
			width = r.width; height = r.height; channels = r.channels || 1;
			formatLabel = 'NPY/NPZ';
			fileFields = { 'Dimensions': `${width} x ${height}`, 'Channels': String(channels), 'Dtype': r.dtype || 'n/a' };
			data = r.data;
		} else if (pfmProcessor._lastRaw) {
			const r = pfmProcessor._lastRaw;
			width = r.width; height = r.height; channels = r.channels || 1;
			formatLabel = 'PFM';
			fileFields = { 'Dimensions': `${width} x ${height}`, 'Channels': String(channels) };
			data = r.data;
		} else if (scientificProcessors.some(processor => !!processor._lastRaw)) {
			const processor = scientificProcessors.find(candidate => !!candidate._lastRaw)!;
			const r = processor._lastRaw!;
			width = r.width; height = r.height; channels = r.channels || 1;
			formatLabel = processor.config.formatLabel;
			fileFields = { 'Dimensions': `${width} x ${height}`, 'Channels': String(channels) };
			for (const [key, value] of Object.entries(processor.metadata)) {
				if (value === undefined || value === null || typeof value === 'object') { continue; }
				fileFields[key.replace(/([a-z])([A-Z])/g, '$1 $2')] = String(value);
			}
			data = r.data;
		} else if (hdrProcessor._lastRaw) {
			const r = hdrProcessor._lastRaw;
			width = r.width; height = r.height; channels = r.channels || 3;
			formatLabel = 'HDR (Radiance)';
			fileFields = { 'Dimensions': `${width} x ${height}`, 'Channels': String(channels) };
			tags = hdrProcessor._lastAllTags || [];
			data = r.data;
		} else if (ppmProcessor._lastRaw) {
			const r = ppmProcessor._lastRaw;
			width = r.width; height = r.height; channels = r.channels || 1;
			formatLabel = r.format || 'PPM/PGM/PBM';
			fileFields = { 'Dimensions': `${width} x ${height}`, 'Channels': String(channels), 'Max Value': String(r.maxval) };
			data = r.data;
		} else if (pngProcessor._lastRaw || pngProcessor._lazyNativeReadback) {
			const r = pngProcessor._lastRaw;
			const lazy = pngProcessor._lazyNativeReadback;
			const isJpeg = currentFormatInfo?.formatType === 'jpg';
			formatLabel = isJpeg ? 'JPEG' : 'PNG';
			if (r) {
				width = r.width; height = r.height; channels = r.channels || 4;
				fileFields = { 'Dimensions': `${width} x ${height}`, 'Channels': String(channels), 'Bit Depth': String(r.bitDepth || 8) };
				data = r.data;
			} else {
				// Large JPEGs skip pixel-array storage (lazy native-Image
				// readback) — still show file info and any embedded Exif tags.
				fileFields = { 'Dimensions': `${lazy.width} x ${lazy.height}` };
			}
			tags = pngProcessor._lastAllTags || [];
		} else {
			return null;
		}

		let stats: MetadataInfo['stats'] = null;
		if (data && width && height) {
			try {
				stats = ImageStatsCalculator.calculateExtendedStats(data, width, height, channels || 1);
			} catch {
				stats = null;
			}
		}

		return { formatLabel, fileFields, tags, stats };
	}

	/**
	 * Refresh the Metadata panel, if visible, from the currently active image.
	 * Cheap no-op when the panel is closed.
	 */
	function updateMetadataData() {
		if (!canvas || !hasLoadedImage || !metadataPanel.getVisibility()) {
			return;
		}
		try {
			metadataPanel.render(gatherActiveMetadataInfo());
		} catch (error) {
			console.warn('[MetadataPanel] Failed to gather metadata:', error);
		}
	}

	/**
	 * Update histogram with current image data.
	 * Uses raw image data when available for accurate value representation.
	 */
	function updateHistogramData() {
		updateMetadataData();
		if (!canvas || !hasLoadedImage) {
			return;
		}

		// Only update histogram if it's visible - this is expensive
		if (!histogramOverlay.getVisibility()) {
			return;
		}
		try {
			if (_deferredHistogramTimer !== null) {
				clearTimeout(_deferredHistogramTimer);
				_deferredHistogramTimer = null;
			}
			if (pngProcessor && pngProcessor.hasLazyNativeReadback()) {
				const sampledImageData = pngProcessor.getLazyNativeHistogramImageData(1_000_000);
				if (sampledImageData) {
					PerfTrace.mark('histogram-prepare');
					histogramOverlay.update(sampledImageData, { settings: settingsManager.settings, sampleStep: 1 });
					return;
				}
				const imageData = pngProcessor.renderPngWithSettings();
				if (imageData) { primaryImageData = imageData; }
			}

			if (tiffProcessor.rawTiffData && tiffProcessor._lastRenderHistogram) {
				PerfTrace.mark('histogram-prepare');
				histogramOverlay.updateFromPrecomputed(tiffProcessor._lastRenderHistogram);
				PerfTrace.mark('histogram-from-render');
				return;
			}
			if (exrProcessor.rawExrData && exrProcessor._lastRenderHistogram) {
				PerfTrace.mark('histogram-prepare');
				histogramOverlay.updateFromPrecomputed(exrProcessor._lastRenderHistogram);
				PerfTrace.mark('histogram-from-render');
				return;
			}
			if (npyProcessor._lastRaw && npyProcessor._lastRenderHistogram) {
				PerfTrace.mark('histogram-prepare');
				histogramOverlay.updateFromPrecomputed(npyProcessor._lastRenderHistogram);
				PerfTrace.mark('histogram-from-render');
				return;
			}
			if (pfmProcessor._lastRaw && pfmProcessor._lastRenderHistogram) {
				PerfTrace.mark('histogram-prepare');
				histogramOverlay.updateFromPrecomputed(pfmProcessor._lastRenderHistogram);
				PerfTrace.mark('histogram-from-render');
				return;
			}
			const scientificWithHistogram = scientificProcessors.find(processor => processor._lastRaw && processor._lastRenderHistogram);
			if (scientificWithHistogram) {
				PerfTrace.mark('histogram-prepare');
				histogramOverlay.updateFromPrecomputed(scientificWithHistogram._lastRenderHistogram);
				PerfTrace.mark('histogram-from-render');
				return;
			}
			if (hdrProcessor._lastRaw && hdrProcessor._lastRenderHistogram) {
				PerfTrace.mark('histogram-prepare');
				histogramOverlay.updateFromPrecomputed(hdrProcessor._lastRenderHistogram);
				PerfTrace.mark('histogram-from-render');
				return;
			}

			const settings = settingsManager.settings;
			let histogramOptions: any = {
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
				// Signed ints and wide (>16-bit) unsigned ints are carried as
				// Float32Array too (see tiff-processor.js
				// tiffNeedsFloatCarrier/pickTiffArrayCtor), so they're binned
				// through the float path.
				const isFloat = tiffNeedsFloatCarrier(format, bitsPerSample);
				const typeMax = tiffTypeMax(format, bitsPerSample);

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
			} else if (layeredPreviewProcessor._lastRaw) {
				const raw = layeredPreviewProcessor._lastRaw;
				histogramOptions = {
					...histogramOptions,
					rawData: layeredPreviewProcessor.activeData(),
					channels: raw.channels,
					isFloat: raw.sampleFormat === 3,
					typeMax: raw.sampleFormat === 3 ? 1.0 : raw.bitDepth === 16 ? 65535 : 255,
					stats: layeredPreviewProcessor._cachedStats || null
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

				let typeMax: number;
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
			} else if (scientificProcessors.some(processor => !!processor._lastRaw)) {
				const processor = scientificProcessors.find(candidate => !!candidate._lastRaw)!;
				const { data, channels } = processor._lastRaw!;
				histogramOptions = {
					...histogramOptions,
					rawData: data,
					channels,
					isFloat: true,
					typeMax: 1.0,
					stats: processor._cachedStats || null
				};
			} else if (hdrProcessor && hdrProcessor._lastRaw) {
				// HDR raw data (float RGBA from parse-hdr; alpha is ignored by histogram stats)
				const { width, height, data, channels } = hdrProcessor._lastRaw;
				const stats = hdrProcessor._cachedStats || null;

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

			PerfTrace.mark('histogram-prepare');

			// Get canvas image data as fallback
			let imageData: ImageData | null = null;
			if (!histogramOptions.rawData && !histogramOptions.planarData) {
				imageData = readDisplayedCanvasImageData(canvas);
				if (!imageData) return;
				PerfTrace.mark('histogram-canvas-readback');
			}

			const rawPixelCount = histogramOptions.planarData
				? (histogramOptions.planarData[0]?.length || 0)
				: (histogramOptions.rawData ? Math.floor(histogramOptions.rawData.length / (histogramOptions.channels || 1)) : 0);
			const largeRawHistogram = rawPixelCount > 4_000_000 && (histogramOptions.rawData || histogramOptions.planarData);
			if (largeRawHistogram) {
				const sampleStep = Math.max(2, Math.ceil(rawPixelCount / 1_000_000));
				histogramOverlay.update(imageData, { ...histogramOptions, sampleStep });
				const generation = _loadGeneration;
				const runExact = () => {
					_deferredHistogramTimer = null;
					if (generation !== _loadGeneration || !histogramOverlay.getVisibility()) { return; }
					try {
						const exactStart = performance.now();
						histogramOverlay.update(imageData, histogramOptions);
						console.log(`[Histogram] Deferred exact update took ${(performance.now() - exactStart).toFixed(1)}ms`);
					} catch (error) {
						console.error('Error updating exact histogram:', error);
					}
				};
				_deferredHistogramTimer = window.setTimeout(runExact, 250);
				return;
			}

			// Update histogram overlay
			histogramOverlay.update(imageData, histogramOptions);
		} catch (error) {
			console.error('Error updating histogram:', error);
		}
	}

	/**
	 * Clear the cached raw data of every format processor. Used when the decoded
	 * colormap scalar takes over as the active single-image source.
	 */
	function clearAllProcessorRawData() {
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
		layeredPreviewProcessor.reset();
		updateLayeredPreviewOverlay();
		for (const processor of scientificProcessors) { processor._lastRaw = null; }
		disposeWebglRenderers();
	}

	/**
	 * Render the decoded colormap scalar source through the central pipeline,
	 * honoring the current normalization / gamma / display-colormap settings.
	 */
	async function renderDecodedColormapSource() {
		if (!decodedColormapSource || !canvas) { return; }
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) { return; }
		const { floatData, width, height } = decodedColormapSource;
		const stats = ImageStatsCalculator.calculateFloatStats(floatData, width, height, 1);
		const imageData = ImageRenderer.render(
			floatData, width, height, 1, true, stats,
			settingsManager.settings, { nanColor: getNanColorObj() }
		);
		await renderImageDataToCanvas(imageData, ctx);
		primaryImageData = imageData;
		updateHistogramData();
	}

	/**
	 * Decode a colormapped image to scalar float values (inverse colormap).
	 * @param colormapName - Name of the colormap used in the image
	 * @param minValue - Value mapped to the start of the colormap
	 * @param maxValue - Value mapped to the end of the colormap
	 * @param inverted - Whether the colormap was applied inverted
	 * @param logarithmic - Whether to use logarithmic mapping
	 */
	async function handleColormapConversion(colormapName: string, minValue: number, maxValue: number, inverted: boolean, logarithmic: boolean) {
		if (!canvas || !hasLoadedImage) {
			console.error('No image loaded for colormap conversion');
			return;
		}

		try {
			const imageData = readDisplayedCanvasImageData(canvas);
			if (!imageData) {
				console.error('Could not get canvas context');
				return;
			}

			// Read the displayed RGB pixels (the true colormap colors at the
			// current display) and invert the colormap to recover scalar values.
			const width = imageData.width;
			const height = imageData.height;

			const floatData = colormapConverter.convertToFloat(
				imageData,
				colormapName,
				minValue,
				maxValue,
				inverted,
				logarithmic
			);

			// The decoded scalar becomes the active single-image source. Clearing
			// the per-processor raw data ensures settings re-renders go through the
			// decoded-source path below instead of re-rendering the original image.
			decodedColormapSource = { floatData, width, height };
			clearAllProcessorRawData();

			// Switch to a float view of the decoded range.
			if (settingsManager.settings.normalization) {
				settingsManager.settings.normalization.autoNormalize = true;
				settingsManager.settings.normalization.min = minValue;
				settingsManager.settings.normalization.max = maxValue;
			}

			// Render the decoded scalar through the central pipeline so
			// normalization / gamma / display-colormap all apply.
			await renderDecodedColormapSource();

			// Update zoom controller to refresh the display
			zoomController.updateScale(zoomController.scale || 'fit');

			// Update settings display
			vscode.postMessage({
				type: 'stats',
				value: { min: minValue, max: maxValue }
			});

			// Tell the extension this is now a single-channel float image so the
			// float status-bar controls (normalization) appear.
			sendFormatInfo({
				width: width,
				height: height,
				bitsPerSample: 32,
				sampleFormat: 3, // Float
				samplesPerPixel: 1,
				formatType: 'colormap-converted',
				isInitialLoad: false
			});

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

			console.log(`Colormap decode complete: ${colormapName} [${minValue}, ${maxValue}]`);
		} catch (error) {
			console.error('Error during colormap conversion:', error);
			vscode.postMessage({
				type: 'error',
				message: `Colormap conversion failed: ${(error as any).message}`
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
			decodedColormapSource = null;

			// Clear converted data from processors
			clearAllProcessorRawData();

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
				message: `Failed to revert to original image: ${(error as any).message}`
			});
		}
	}

	/**
	 * Update image rendering with new settings
	 * @param changes - Changed settings
	 */
	async function updateImageWithNewSettings(changes?: SettingsChanges | null) {
		const canRenderLazyPng = pngProcessor && pngProcessor.hasLazyNativeReadback();
		if (!canvas || (!primaryImageData && !canRenderLazyPng)) {
			return;
		}
		if (canRenderLazyPng && pngProcessor.canUseLazyNativeCanvasForSettings(settingsManager.settings)) {
			return;
		}

		// When compositing is active with extra layers, the composite owns the
		// canvas — re-render it through the central pipeline and skip the
		// per-processor paths below.
		if (layerManager.active && layerManager.hasCompositeStack()) {
			if (recompositeLayers()) { return; }
		}

		// When a colormap has been decoded to float, that scalar is the active
		// source — re-render it (so normalization / gamma / display-colormap apply).
		if (decodedColormapSource) {
			await renderDecodedColormapSource();
			return;
		}

		if (primaryImageData && layeredPreviewProcessor._lastRaw) {
			const newImageData = layeredPreviewProcessor.renderWithSettings({ collectHistogram: histogramOverlay.getVisibility() });
			const ctx = ensure2dCanvasContext();
			if (newImageData && ctx) {
				await renderImageDataToCanvas(newImageData, ctx);
				primaryImageData = newImageData;
				updateHistogramData();
			}
			return;
		}

		// Default to full update if no change info provided
		if (!changes) {
			changes = { changed: true, changedKeys: ['unspecified'], parametersOnly: false, changedStructure: false };
		}

		// For TIFF images, optimize based on what changed
		if (primaryImageData && tiffProcessor.rawTiffData) {
			try {
				// If only parameters changed (gamma/brightness/normalization), use optimized path
				if (changes.parametersOnly) {
					// Skip mask loading and statistics recalculation
					// Just re-render with new parameters from raw data
					// Pre-existing arg-count mismatch predating the TS migration:
					// renderTiffWithSettingsFast only takes 3 params, so this 4th "skipMasks"
					// arg was already silently dropped by JS at runtime. Cast to `any` rather
					// than fix the call, to avoid a behavior change outside migration scope.
					const newImageData = await (tiffProcessor.renderTiffWithSettingsFast as any)(
						tiffProcessor.rawTiffData.image,
						tiffProcessor.rawTiffData.rasters,
						true, // skipMasks flag
						{
							collectHistogram: histogramOverlay.getVisibility(),
							targetCanvas: canvas,
							placeholderImageData: primaryImageData
						}
					);

					// Update the canvas with new image data
					if (tiffProcessor._lastRenderUsedWebGL && newImageData) {
						PerfTrace.mark('canvas-upload-skipped');
						primaryImageData = newImageData;
						updateHistogramData();
					} else {
						const ctx = ensure2dCanvasContext();
						if (ctx && newImageData) {
							await renderImageDataToCanvas(newImageData, ctx);
							primaryImageData = newImageData;
							updateHistogramData();
						}
					}
					return;
				}

				// Fallback to full re-render for structural changes or mask changes
				const newImageData = await tiffProcessor.renderTiffWithSettings(
					tiffProcessor.rawTiffData.image,
					tiffProcessor.rawTiffData.rasters,
					{
						collectHistogram: histogramOverlay.getVisibility(),
						targetCanvas: canvas,
						placeholderImageData: primaryImageData
					}
				);

				// Update the canvas with new image data
				if (tiffProcessor._lastRenderUsedWebGL && newImageData) {
					PerfTrace.mark('canvas-upload-skipped');
					primaryImageData = newImageData;
					updateHistogramData();
				} else {
					const ctx = ensure2dCanvasContext();
					if (ctx && newImageData) {
						console.log('✅ CANVAS UPDATE (TIFF slow path): Applying new ImageData to canvas');
						await renderImageDataToCanvas(newImageData, ctx);
						primaryImageData = newImageData;
						updateHistogramData();
					}
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
				const newImageData = exrProcessor.updateSettings(settingsManager.settings, {
					collectHistogram: histogramOverlay.getVisibility(),
					targetCanvas: canvas,
					placeholderImageData: primaryImageData
				});

				if (newImageData) {
					// Update the canvas with new image data
					if (exrProcessor._lastRenderUsedWebGL) {
						PerfTrace.mark('canvas-upload-skipped');
						primaryImageData = newImageData;
						updateHistogramData();
					} else {
						const ctx = ensure2dCanvasContext();
						if (ctx) {
							console.log('✅ CANVAS UPDATE (EXR): Applying new ImageData to canvas');
							await renderImageDataToCanvas(newImageData, ctx);
							primaryImageData = newImageData;
							updateHistogramData();
						}
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
				const newImageData = ppmProcessor.renderPgmWithSettings({
					collectHistogram: histogramOverlay.getVisibility(),
					targetCanvas: canvas,
					placeholderImageData: primaryImageData
				});

				if (newImageData) {
					// Update the canvas with new image data
					if (ppmProcessor._lastRenderUsedWebGL) {
						PerfTrace.mark('canvas-upload-skipped');
						primaryImageData = newImageData;
						updateHistogramData();
					} else {
						const ctx = ensure2dCanvasContext();
						if (ctx) {
							await renderImageDataToCanvas(newImageData, ctx);
							primaryImageData = newImageData;
							swapImageElementToCanvas();
							updateHistogramData();
						}
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
				const newImageData = pfmProcessor.renderPfmWithSettings({
					collectHistogram: histogramOverlay.getVisibility(),
					targetCanvas: canvas,
					placeholderImageData: primaryImageData
				});

				if (newImageData) {
					// Update the canvas with new image data
					if (pfmProcessor._lastRenderUsedWebGL) {
						PerfTrace.mark('canvas-upload-skipped');
						primaryImageData = newImageData;
						updateHistogramData();
					} else {
						const ctx = ensure2dCanvasContext();
						if (ctx) {
							await renderImageDataToCanvas(newImageData, ctx);
							primaryImageData = newImageData;
							updateHistogramData();
						}
					}
				}
			} catch (error) {
				console.error('Error updating PFM image with new settings:', error);
			}
			return;
		}

		const activeScientific = scientificProcessors.find(processor => !!processor._lastRaw);
		if (primaryImageData && activeScientific) {
			try {
				const newImageData = activeScientific.renderWithSettings({
					collectHistogram: histogramOverlay.getVisibility(),
					targetCanvas: canvas,
					placeholderImageData: primaryImageData
				});
				if (newImageData) {
					if (activeScientific._lastRenderUsedWebGL) {
						primaryImageData = newImageData;
					} else {
						const ctx = ensure2dCanvasContext();
						if (ctx) { await renderImageDataToCanvas(newImageData, ctx); primaryImageData = newImageData; }
					}
					updateHistogramData();
				}
			} catch (error) {
				console.error(`Error updating ${activeScientific.config.formatLabel} with new settings:`, error);
			}
			return;
		}

		// For NPY images, re-render with new settings
		if (primaryImageData && npyProcessor && npyProcessor._lastRaw) {
			try {
				// Re-render the NPY with current settings
				const newImageData = npyProcessor.renderNpyWithSettings({
					collectHistogram: histogramOverlay.getVisibility(),
					targetCanvas: canvas,
					placeholderImageData: primaryImageData
				});

				if (newImageData) {
					// Update the canvas with new image data
					if (npyProcessor._lastRenderUsedWebGL) {
						PerfTrace.mark('canvas-upload-skipped');
						primaryImageData = newImageData;
						updateHistogramData();
					} else {
						const ctx = ensure2dCanvasContext();
						if (ctx) {
							await renderImageDataToCanvas(newImageData, ctx);
							primaryImageData = newImageData;
							updateHistogramData();
						}
					}
				}
			} catch (error) {
				console.error('Error updating NPY image with new settings:', error);
			}
			return;
		}

		// For PNG/JPEG images, re-render with new settings
		if (pngProcessor && (pngProcessor._lastRaw || pngProcessor.hasLazyNativeReadback())) {
			try {
				// Re-render the PNG with current settings
				const newImageData = pngProcessor.renderPngWithSettings({
					collectHistogram: histogramOverlay.getVisibility(),
					targetCanvas: canvas,
					placeholderImageData: primaryImageData
				});

				if (newImageData) {
					// Update the canvas with new image data
					if (pngProcessor._lastRenderUsedWebGL) {
						PerfTrace.mark('canvas-upload-skipped');
						primaryImageData = newImageData;
						updateHistogramData();
					} else {
						const ctx = ensure2dCanvasContext();
						if (ctx) {
							await renderImageDataToCanvas(newImageData, ctx);
							primaryImageData = newImageData;
							swapImageElementToCanvas();
							updateHistogramData();
						}
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
				const newImageData = hdrProcessor.renderHdrWithSettings({
					collectHistogram: histogramOverlay.getVisibility(),
					targetCanvas: canvas,
					placeholderImageData: primaryImageData
				});
				if (newImageData) {
					if (hdrProcessor._lastRenderUsedWebGL) {
						PerfTrace.mark('canvas-upload-skipped');
						primaryImageData = newImageData;
						updateHistogramData();
					} else {
						const ctx = ensure2dCanvasContext();
						if (ctx) {
							await renderImageDataToCanvas(newImageData, ctx);
							primaryImageData = newImageData;
							updateHistogramData();
						}
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
	}

	/**
	 * Setup additional event listeners
	 */
	function setupEventListeners() {
		installRangeDoubleClickReset(document);
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

			// In layer move mode, a click on the image moves the layer — don't zoom.
			if (layerManager.active && layersPanel.movingLayerId) {
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
			const createMenuItem = (text: string, action: () => void) => {
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
			// Single-channel scalar image (or a decoded colormap): can be pseudocolored.
			const isSingleChannel = !!currentFormatInfo && (currentFormatInfo.samplesPerPixel ?? 1) <= 1;

			if (isRgb8BitUint) {
				menu.appendChild(createSeparator());

				const rgb24Active = settingsManager.settings.rgbAs24BitGrayscale || false;
				menu.appendChild(createMenuItem(rgb24Active ? '✓ Interpret as 24-bit Grayscale' : 'Interpret as 24-bit Grayscale', () => {
					vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.toggleRgb24Mode' });
				}));
			}

			// "Apply Colormap" (pseudocolor): map a single-channel scalar to colors.
			if (isSingleChannel) {
				menu.appendChild(createSeparator());

				const activeColormap = settingsManager.settings.displayColormap;
				const hasColormap = activeColormap && activeColormap !== 'none';
				menu.appendChild(createMenuItem(hasColormap ? `Apply Colormap… (${activeColormap})` : 'Apply Colormap…', () => {
					vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.applyColormap' });
				}));
				if (hasColormap) {
					menu.appendChild(createMenuItem('Remove Colormap', () => {
						handleSetDisplayColormap('none');
					}));
				}
			}

			// "Decode Colormap to Float": recover a scalar from a colormapped RGB image.
			if (isRgbImage) {
				if (!isRgb8BitUint) {
					menu.appendChild(createSeparator());
				}

				menu.appendChild(createMenuItem('Decode Colormap to Float', () => {
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

			// Layers compositing view
			menu.appendChild(createMenuItem('Open Layers View', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.toggleLayers' });
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

			// Add Toggle Metadata Panel option
			menu.appendChild(createMenuItem('Toggle Metadata Panel', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.toggleMetadata' });
			}));

			// Open as Point Cloud — only when ply-visualizer is installed and format is supported
			const plyFormats = ['tiff-float', 'tiff-int', 'tiff-int-signed', 'tiff-int-wide', 'pfm', 'npy', 'npy-float', 'npy-uint', 'png'];
			if (settingsManager.settings.plyVisualizerInstalled && currentFormatInfo && plyFormats.includes(currentFormatInfo.formatType ?? '')) {
				menu.appendChild(createSeparator());
				menu.appendChild(createMenuItem('Open as Point Cloud', () => {
					vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.openAsPointCloud' });
				}));
			}

			document.body.appendChild(menu);

			// Keep the menu inside the viewport: if it would overflow the right or
			// bottom edge, shift it back so it isn't clipped by the webview bounds.
			// (An over-tall menu is capped and made scrollable via CSS max-height.)
			const edgeMargin = 8;
			const menuRect = menu.getBoundingClientRect();
			let menuLeft = e.clientX;
			let menuTop = e.clientY;
			if (menuLeft + menuRect.width > window.innerWidth - edgeMargin) {
				menuLeft = Math.max(edgeMargin, window.innerWidth - menuRect.width - edgeMargin);
			}
			if (menuTop + menuRect.height > window.innerHeight - edgeMargin) {
				menuTop = Math.max(edgeMargin, window.innerHeight - menuRect.height - edgeMargin);
			}
			menu.style.left = `${menuLeft}px`;
			menu.style.top = `${menuTop}px`;

			// Remove menu when clicking outside
			const removeMenu = (event: MouseEvent) => {
				if (!menu.contains(event.target as Node)) {
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

		// Capture collection and multi-page TIFF navigation before image panning or
		// VS Code's webview focus handling can consume the physical arrow key.
		window.addEventListener('keydown', (e) => {
			const target = e.target as HTMLElement | null;
			const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
			const isPlainKey = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
			const isRightArrow = e.key === 'ArrowRight' || e.code === 'ArrowRight';
			const isLeftArrow = e.key === 'ArrowLeft' || e.code === 'ArrowLeft';
			if (!isTyping && isPlainKey && (isRightArrow || isLeftArrow) &&
				(datasetManifest || imageCollection.totalImages > 1 || tiffProcessor.pageCount > 1)) {
				e.preventDefault();
				e.stopPropagation();
				if (datasetManifest) {
					navigateDatasetPrimary(isRightArrow ? 1 : -1);
				} else if (imageCollection.totalImages > 1) {
					requestCollectionNavigation(isRightArrow ? 'next' : 'previous');
				} else {
					void navigateTiffPage(isRightArrow ? 1 : -1);
				}
				return;
			}
			if (!isTyping && tiffProcessor.pageCount > 1) {
				if (e.key === ']' || e.code === 'PageDown') {
					e.preventDefault();
					void navigateTiffPage(1);
					return;
				} else if (e.key === '[' || e.code === 'PageUp') {
					e.preventDefault();
					void navigateTiffPage(-1);
					return;
				}
			}
		}, true);

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
					<button class="collection-nav-btn collection-prev-btn" type="button" tabindex="-1" title="Previous image (Left Arrow)" aria-label="Previous image">&#x2039;</button>
					<span class="image-counter" title="Click to jump to image">1 of 1</span>
					<button class="collection-nav-btn collection-next-btn" type="button" tabindex="-1" title="Next image (Right Arrow)" aria-label="Next image">&#x203a;</button>
					<button class="collection-remove-btn" title="Remove from collection">&#x2715;</button>
				</div>
				<span class="toggle-hint">Left / Right Arrow keys to navigate</span>
			</div>
		`;

		const bindNavigationButton = (selector: string, direction: 'next' | 'previous') => {
			const button = overlayElement?.querySelector(selector) as HTMLButtonElement | null;
			button?.addEventListener('pointerdown', (e) => {
				// The overlay lives inside the body container, which also owns image
				// zoom/click handling. Keep navigation clicks out of that pipeline.
				e.preventDefault();
				e.stopPropagation();
			});
			button?.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				button.blur();
				requestCollectionNavigation(direction);
			});
			button?.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					e.stopPropagation();
				}
			});
		};
		bindNavigationButton('.collection-prev-btn', 'previous');
		bindNavigationButton('.collection-next-btn', 'next');

		// Click on counter → inline number input to jump to any image
		const counterEl = overlayElement.querySelector('.image-counter') as HTMLElement;

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

		let removeConfirmTimer: ReturnType<typeof setTimeout> | null = null;

		overlayElement.addEventListener('mousedown', (e) => {
			if ((e.target as HTMLElement).classList.contains('collection-remove-btn')) {
				e.preventDefault(); // prevent text selection on repeated clicks
			}
		});

		overlayElement.addEventListener('click', (e) => {
			const target = e.target as HTMLButtonElement;
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

	function createTiffPageOverlay() {
		tiffPageOverlay = document.createElement('div');
		tiffPageOverlay.className = 'tiff-page-overlay';
		tiffPageOverlay.style.display = 'none';
		tiffPageOverlay.innerHTML = `
			<div class="tiff-page-basic">
				<button class="tiff-page-prev" type="button" tabindex="-1" title="Previous TIFF page (Left Arrow, [ or Page Up)" aria-label="Previous TIFF page">&#x2039;</button>
				<span class="tiff-page-counter">Page 1 / 1</span>
				<button class="tiff-page-next" type="button" tabindex="-1" title="Next TIFF page (Right Arrow, ] or Page Down)" aria-label="Next TIFF page">&#x203a;</button>
			</div>
			<div class="ome-axis-controls" aria-label="OME-TIFF dimensions">
				<label class="ome-axis ome-axis-c"><span class="ome-axis-label">C</span><input type="range" data-default-value="0" title="Channel · Double-click to reset"><span class="ome-axis-value"></span></label>
				<label class="ome-axis ome-axis-z"><span class="ome-axis-label">Z</span><input type="range" data-default-value="0" title="Z slice · Double-click to reset"><span class="ome-axis-value"></span></label>
				<label class="ome-axis ome-axis-t"><span class="ome-axis-label">T</span><input type="range" data-default-value="0" title="Timepoint · Double-click to reset"><span class="ome-axis-value"></span></label>
			</div>
		`;
		const bindTiffPageButton = (selector: string, delta: number) => {
			const button = tiffPageOverlay?.querySelector(selector) as HTMLButtonElement | null;
			button?.addEventListener('pointerdown', (e) => {
				e.preventDefault();
				e.stopPropagation();
			});
			button?.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				button.blur();
				void navigateTiffPage(delta);
			});
			button?.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					e.stopPropagation();
				}
			});
		};
		bindTiffPageButton('.tiff-page-prev', -1);
		bindTiffPageButton('.tiff-page-next', 1);
		for (const axis of ['C', 'Z', 'T'] as OmeAxis[]) {
			const input = tiffPageOverlay.querySelector(`.ome-axis-${axis.toLowerCase()} input`) as HTMLInputElement | null;
			input?.addEventListener('input', () => void navigateOmeAxis(axis, Number(input.value)));
		}
		document.body.appendChild(tiffPageOverlay);
	}

	function createDatasetOverlay() {
		datasetOverlay = document.createElement('div');
		datasetOverlay.className = 'dataset-overlay';
		datasetOverlay.style.display = 'none';
		datasetOverlay.innerHTML = `
			<div class="dataset-heading">
				<button class="dataset-prev" type="button" tabindex="-1" title="Previous dataset plane (Left Arrow)" aria-label="Previous dataset plane">&#x2039;</button>
				<span class="dataset-title"></span>
				<button class="dataset-next" type="button" tabindex="-1" title="Next dataset plane (Right Arrow)" aria-label="Next dataset plane">&#x203a;</button>
			</div>
			<label class="dataset-series-row"><span>Series</span><select class="dataset-series"></select></label>
			<div class="dataset-axis-controls"></div>
		`;
		const bindButton = (selector: string, delta: number) => {
			const button = datasetOverlay?.querySelector(selector) as HTMLButtonElement | null;
			button?.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
			button?.addEventListener('click', e => {
				e.preventDefault(); e.stopPropagation(); button.blur(); navigateDatasetPrimary(delta);
			});
			button?.addEventListener('keydown', e => {
				if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); }
			});
		};
		bindButton('.dataset-prev', -1);
		bindButton('.dataset-next', 1);
		const select = datasetOverlay.querySelector('.dataset-series') as HTMLSelectElement;
		select.addEventListener('change', () => {
			datasetSeriesIndex = Number(select.value);
			const series = datasetManifest?.series[datasetSeriesIndex];
			datasetCoordinates = Object.fromEntries((series?.axes || []).map(axis => [axis.key, 0]));
			requestDatasetNavigation(datasetSeriesIndex, datasetCoordinates);
		});
		document.body.appendChild(datasetOverlay);
	}

	function requestDatasetNavigation(seriesIndex: number, coordinates: Record<string, number>) {
		if (!datasetManifest) { return; }
		datasetLoading = true;
		updateDatasetOverlay(true);
		vscode.postMessage({ type: 'navigateDataset', seriesIndex, coordinates });
	}

	function navigateDatasetPrimary(delta: number) {
		const series = datasetManifest?.series[datasetSeriesIndex];
		if (!series || series.planes.length === 0) { return; }
		const currentIndex = series.planes.findIndex(plane =>
			series.axes.every(axis => (plane.coordinates[axis.key] || 0) === (datasetCoordinates[axis.key] || 0)));
		const startIndex = currentIndex >= 0 ? currentIndex : 0;
		const targetIndex = (startIndex + delta + series.planes.length) % series.planes.length;
		datasetCoordinates = { ...series.planes[targetIndex].coordinates };
		requestDatasetNavigation(datasetSeriesIndex, datasetCoordinates);
	}

	function updateDatasetOverlay(loading = datasetLoading) {
		if (!datasetOverlay) { return; }
		const manifest = datasetManifest;
		if (!manifest || manifest.series.length === 0) {
			datasetOverlay.style.display = 'none';
			return;
		}
		const series = manifest.series[Math.max(0, Math.min(manifest.series.length - 1, datasetSeriesIndex))];
		const title = datasetOverlay.querySelector('.dataset-title') as HTMLElement;
		title.textContent = manifest.label;
		const seriesRow = datasetOverlay.querySelector('.dataset-series-row') as HTMLElement;
		const select = datasetOverlay.querySelector('.dataset-series') as HTMLSelectElement;
		if (select.options.length !== manifest.series.length || Array.from(select.options).some((option, index) => option.text !== manifest.series[index].label)) {
			select.replaceChildren(...manifest.series.map((item, index) => {
				const option = document.createElement('option'); option.value = String(index); option.text = item.label; return option;
			}));
		}
		select.value = String(datasetSeriesIndex);
		seriesRow.style.display = manifest.series.length > 1 ? 'grid' : 'none';
		const controls = datasetOverlay.querySelector('.dataset-axis-controls') as HTMLElement;
		controls.replaceChildren(...series.axes.map(axis => {
			const row = document.createElement('label'); row.className = 'dataset-axis';
			const axisLabel = document.createElement('span'); axisLabel.className = 'dataset-axis-label'; axisLabel.textContent = axis.label;
			const input = document.createElement('input'); input.type = 'range'; input.min = '0'; input.max = String(Math.max(0, axis.size - 1)); input.step = '1'; input.dataset.defaultValue = '0'; input.value = String(datasetCoordinates[axis.key] || 0); input.title = `${axis.label} · Double-click to reset`;
			const axisValue = datasetCoordinates[axis.key] || 0;
			const value = document.createElement('span'); value.className = 'dataset-axis-value'; value.textContent = `${axisValue + 1} / ${axis.size}${axis.valueLabels?.[axisValue] ? ` · ${axis.valueLabels[axisValue]}` : ''}`;
			input.addEventListener('input', () => {
				datasetCoordinates = { ...datasetCoordinates, [axis.key]: Number(input.value) };
				requestDatasetNavigation(datasetSeriesIndex, datasetCoordinates);
			});
			row.append(axisLabel, input, value); return row;
		}));
		datasetOverlay.classList.toggle('dataset-overlay--loading', loading);
		datasetOverlay.style.display = 'flex';
		if (tiffPageOverlay) tiffPageOverlay.style.display = 'none';
		if (filenameBadge) filenameBadge.style.display = 'block';
	}

	function createNetCdfOverlay() {
		netcdfOverlay = document.createElement('div');
		netcdfOverlay.className = 'dataset-overlay netcdf-overlay';
		netcdfOverlay.style.display = 'none';
		netcdfOverlay.innerHTML = `
			<div class="dataset-title">NetCDF</div>
			<label class="dataset-series-row"><span>Variable</span><select class="dataset-series netcdf-variable"></select></label>
			<div class="dataset-axis-controls netcdf-dimension-controls"></div>
			<div class="netcdf-view-info"></div>
		`;
		const select = netcdfOverlay.querySelector('.netcdf-variable') as HTMLSelectElement;
		select.addEventListener('change', () => {
			netcdfSelection = { variableName: select.value, indices: {} };
			reloadNetCdfSelection();
		});
		document.body.appendChild(netcdfOverlay);
	}

	function createLayeredPreviewOverlay() {
		if (layeredPreviewOverlay) { return; }
		const overlay = document.createElement('div');
		overlay.className = 'layered-preview-overlay';
		overlay.setAttribute('hidden', '');
		overlay.innerHTML = `
			<span class="layered-preview-label">Document preview</span>
			<button type="button" data-preview-mode="integrated">Integrated</button>
			<button type="button" data-preview-mode="reconstructed">Reconstructed</button>
			<button type="button" data-layer-action hidden>Open Layers</button>
			<span class="layered-preview-fidelity"></span>`;
		overlay.querySelectorAll<HTMLButtonElement>('button[data-preview-mode]').forEach(button => {
			button.addEventListener('click', async event => {
				event.preventDefault(); event.stopPropagation(); button.blur();
				const mode = button.dataset.previewMode as 'integrated' | 'reconstructed';
				if (!layeredPreviewProcessor.setPreviewMode(mode)) { return; }
				updateLayeredPreviewOverlay();
				await updateImageWithNewSettings(null);
				if (!layerManager.active) { syncBaseLayer(); }
				updateMetadataData();
			});
		});
		const layersButton = overlay.querySelector<HTMLButtonElement>('button[data-layer-action]');
		layersButton?.addEventListener('click', event => {
			event.preventDefault(); event.stopPropagation(); layersButton.blur();
			layersPanel.show();
		});
		document.body.appendChild(overlay);
		layeredPreviewOverlay = overlay;
	}

	function updateLayeredPreviewOverlay() {
		if (!layeredPreviewOverlay) { return; }
		const raw = layeredPreviewProcessor._lastRaw;
		if (!raw || layerManager.active) {
			layeredPreviewOverlay.setAttribute('hidden', '');
			return;
		}
		layeredPreviewOverlay.removeAttribute('hidden');
		const hasComparison = !!raw.reconstructedData;
		layeredPreviewOverlay.querySelectorAll<HTMLButtonElement>('button[data-preview-mode]').forEach(button => {
			button.hidden = !hasComparison;
			const selected = button.dataset.previewMode === layeredPreviewProcessor.previewMode;
			button.classList.toggle('active', selected);
			button.setAttribute('aria-pressed', String(selected));
		});
		const formatNames: Record<LayeredDocumentFormat, string> = { ora: 'ORA', kra: 'KRA', psd: 'PSD', psb: 'PSB', xcf: 'XCF', affinity: 'Affinity' };
		const kindNames: Record<string, string> = { integrated: 'integrated', merged: 'merged', embedded: 'embedded', reconstructed: 'reconstructed' };
		const label = layeredPreviewOverlay.querySelector<HTMLElement>('.layered-preview-label');
		if (label) { label.textContent = `${formatNames[raw.formatType]} · ${kindNames[raw.document.previewKind] || raw.document.previewKind} preview`; }
		const layersButton = layeredPreviewOverlay.querySelector<HTMLButtonElement>('button[data-layer-action]');
		const editableRasterCount = raw.layerAssets?.filter(asset => asset.kind !== 'group' && !!asset.data).length || 0;
		if (layersButton) { layersButton.hidden = editableRasterCount === 0; }
		const fidelity = layeredPreviewOverlay.querySelector<HTMLElement>('.layered-preview-fidelity');
		const difference = raw.document.reconstruction?.differentPixelRatio;
		if (fidelity) {
			if (hasComparison && difference !== undefined) {
				fidelity.textContent = `${(difference * 100).toFixed(2)}% differ`;
				fidelity.title = 'Pixels differing by more than one channel value from the integrated preview';
			} else if (raw.document.previewKind === 'embedded') {
				fidelity.textContent = 'non-authoritative · layers unavailable';
				fidelity.title = 'This embedded preview may not match the full document';
			} else if (editableRasterCount) {
				fidelity.textContent = `${editableRasterCount} raster layer${editableRasterCount === 1 ? '' : 's'}`;
				fidelity.title = 'Compatible raster layers can be opened in the Layers View';
			} else {
				fidelity.textContent = `${raw.document.layerCount} node${raw.document.layerCount === 1 ? '' : 's'} · preview only`;
				fidelity.title = 'Layer structure may be inspected, but layer pixels are not available in the Layers View';
			}
		}
	}

	function reloadNetCdfSelection() {
		const src = settingsManager.settings.src || '';
		const resourceUri = settingsManager.settings.resourceUri || '';
		if (!src || !resourceUri) { return; }
		netcdfOverlay?.classList.add('dataset-overlay--loading');
		switchToNewImage(src, resourceUri, { netcdfOptions: { ...netcdfSelection, indices: { ...netcdfSelection.indices } } });
	}

	function updateNetCdfOverlay(metadata: Record<string, any>, loading = false) {
		if (!netcdfOverlay || !Array.isArray(metadata.variables)) { return; }
		const select = netcdfOverlay.querySelector('.netcdf-variable') as HTMLSelectElement;
		if (select.options.length !== metadata.variables.length || Array.from(select.options).some((option, index) => option.value !== metadata.variables[index].name)) {
			select.replaceChildren(...metadata.variables.map((variable: any) => {
				const option = document.createElement('option');
				option.value = variable.name;
				option.text = `${variable.label}${variable.unit ? ` · ${variable.unit}` : ''}`;
				return option;
			}));
		}
		select.value = String(metadata.variable || '');
		const controls = netcdfOverlay.querySelector('.netcdf-dimension-controls') as HTMLElement;
		const selectors = Array.isArray(metadata.selectors) ? metadata.selectors : [];
		controls.replaceChildren(...selectors.map((selector: any) => {
			const row = document.createElement('label'); row.className = 'dataset-axis';
			const label = document.createElement('span'); label.className = 'dataset-axis-label'; label.textContent = selector.name;
			const input = document.createElement('input'); input.type = 'range'; input.min = '0'; input.max = String(Math.max(0, Number(selector.size) - 1)); input.step = '1'; input.dataset.defaultValue = '0'; input.value = String(selector.value || 0); input.title = `${selector.name} · Double-click to reset`;
			const value = document.createElement('span'); value.className = 'dataset-axis-value'; value.textContent = `${Number(selector.value || 0) + 1} / ${selector.size}`;
			input.addEventListener('input', () => { value.textContent = `${Number(input.value) + 1} / ${selector.size}`; });
			input.addEventListener('change', () => {
				netcdfSelection.indices = { ...netcdfSelection.indices, [selector.name]: Number(input.value) };
				reloadNetCdfSelection();
			});
			row.append(label, input, value); return row;
		}));
		controls.style.display = selectors.some((selector: any) => Number(selector.size) > 1) ? 'flex' : 'none';
		const info = netcdfOverlay.querySelector('.netcdf-view-info') as HTMLElement;
		info.textContent = metadata.viewMode === 'mpas-mesh'
			? `MPAS ${metadata.meshLocation || 'mesh'} · ${metadata.projection || 'projected'}`
			: 'Regular raster';
		netcdfOverlay.classList.toggle('dataset-overlay--loading', loading);
		netcdfOverlay.style.display = 'flex';
		if (datasetOverlay) { datasetOverlay.style.display = 'none'; }
		if (tiffPageOverlay) { tiffPageOverlay.style.display = 'none'; }
	}

	function updateTiffPageOverlay(loading = false) {
		if (!tiffPageOverlay) { return; }
		if (datasetManifest) {
			tiffPageOverlay.style.display = 'none';
			return;
		}
		if (tiffProcessor.pageCount <= 1) {
			tiffPageOverlay.style.display = 'none';
			return;
		}
		const counter = tiffPageOverlay.querySelector('.tiff-page-counter');
		const ome = tiffProcessor.omeMetadata;
		const basic = tiffPageOverlay.querySelector('.tiff-page-basic') as HTMLElement | null;
		const axes = tiffPageOverlay.querySelector('.ome-axis-controls') as HTMLElement | null;
		if (counter) { counter.textContent = `${ome ? 'IFD' : 'Page'} ${tiffProcessor.pageIndex + 1} / ${tiffProcessor.pageCount}`; }
		if (basic) { basic.classList.toggle('tiff-page-basic--ome', !!ome); }
		if (axes) { axes.style.display = ome ? 'flex' : 'none'; }
		if (ome) {
			const coordinates = omeIfdToCoordinates(ome, tiffProcessor.pageIndex);
			const values: Record<OmeAxis, number> = { C: coordinates.c, Z: coordinates.z, T: coordinates.t };
			const sizes: Record<OmeAxis, number> = { C: ome.planeSizeC, Z: ome.sizeZ, T: ome.sizeT };
			for (const axis of ['C', 'Z', 'T'] as OmeAxis[]) {
				const row = tiffPageOverlay.querySelector(`.ome-axis-${axis.toLowerCase()}`) as HTMLElement | null;
				const input = row?.querySelector('input') as HTMLInputElement | null;
				const label = row?.querySelector('.ome-axis-value') as HTMLElement | null;
				if (!row || !input || !label) { continue; }
				const size = sizes[axis];
				row.style.display = size > 1 || axis === 'C' && ome.channels.length > 0 ? 'grid' : 'none';
				input.min = '0'; input.max = String(Math.max(0, size - 1)); input.step = '1'; input.value = String(values[axis]);
				const channel = axis === 'C' ? ome.channels[values.C] : undefined;
				label.textContent = `${values[axis] + 1} / ${size}${channel ? ` · ${channel.name}` : ''}`;
				if (channel?.colorCss) { row.style.setProperty('--ome-channel-color', channel.colorCss.slice(0, 7)); }
				else { row.style.removeProperty('--ome-channel-color'); }
			}
		}
		tiffPageOverlay.classList.toggle('tiff-page-overlay--loading', loading);
		tiffPageOverlay.style.display = 'flex';
	}

	async function navigateTiffPage(delta: number): Promise<void> {
		const total = tiffProcessor.pageCount;
		if (total <= 1) { return; }
		const target = (tiffProcessor.pageIndex + delta + total) % total;
		await navigateTiffToPage(target);
	}

	async function navigateOmeAxis(axis: OmeAxis, value: number): Promise<void> {
		const ome = tiffProcessor.omeMetadata;
		if (!ome) { return; }
		const coordinates = omeIfdToCoordinates(ome, tiffProcessor.pageIndex);
		if (axis === 'C') { coordinates.c = value; }
		else if (axis === 'Z') { coordinates.z = value; }
		else { coordinates.t = value; }
		await navigateTiffToPage(omeCoordinatesToIfd(ome, coordinates));
	}

	async function navigateTiffToPage(target: number): Promise<void> {
		const total = tiffProcessor.pageCount;
		if (target < 0 || target >= total) { return; }
		if (target === tiffProcessor.pageIndex) { return; }

		const src = settingsManager.settings.src || '';
		if (!src) { return; }
		const gen = ++_loadGeneration;
		initialLoadStartTime = performance.now();
		_pendingZoomState = zoomController.getCurrentState();
		_loadAbortController?.abort();
		decodeWorkerClient.cancelActiveDecodes();
		_loadAbortController = new AbortController();
		for (const p of allProcessors) { p.loadSignal = _loadAbortController.signal; }
		resetTiffCanvasReady();
		beginSeamlessImageTransition(false);

		tiffProcessor.pageIndex = target;
		tiffProcessor._isInitialLoad = true;
		tiffProcessor._pendingRenderData = null;
		tiffProcessor.rawTiffData = null;
		tiffProcessor._lastStatistics = null;
		tiffProcessor._convertedFloatData = null;
		hasLoadedImage = false;
		canvas = null;
		imageElement = null;
		primaryImageData = null;
		updateTiffPageOverlay(true);
		saveState();
		await handleTiff(src, gen, target);
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
		let tooltipEl: HTMLElement | null = null;

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

	function updateFilenameBadge(resourceUri: string) {
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
	 */
	function updateImageCollectionOverlay(data: { show: boolean, currentIndex: number, totalImages: number }) {
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
			renderCollectionLoadingState();
		} else {
			overlayElement.style.display = 'none';
			if (filenameBadge) filenameBadge.style.display = datasetManifest ? 'block' : 'none';
		}
	}

	function cacheCurrentDecodedImage() {
		const resourceUri = settingsManager.settings.resourceUri;
		if (!resourceUri || !hasLoadedImage) { return; }
		const lower = resourceUri.toLowerCase();
		let entry: { resourceUri: string, cacheKey: string, format: string, raw: any } | null = null;
		if (isTiffExtension(lower) && tiffProcessor.rawTiffData) {
			entry = {
				resourceUri,
				cacheKey: `${resourceUri}#tiff-page=${tiffProcessor.pageIndex}`,
				format: 'tiff',
				raw: {
					tiffData: tiffProcessor.rawTiffData,
					lastStatistics: tiffProcessor._lastStatistics,
					lastStatisticsRgb24Mode: tiffProcessor._lastStatisticsRgb24Mode,
					convertedFloatData: tiffProcessor._convertedFloatData,
					pageIndex: tiffProcessor.pageIndex,
					pageCount: tiffProcessor.pageCount,
					formatInfo: currentFormatInfo ? { ...currentFormatInfo } : null
				}
			};
		} else if (lower.endsWith('.exr') && exrProcessor.rawExrData) {
			entry = { resourceUri, cacheKey: resourceUri, format: 'exr', raw: exrProcessor.rawExrData };
		} else if ((lower.endsWith('.npy') || lower.endsWith('.npz')) && npyProcessor._lastRaw) {
			entry = { resourceUri, cacheKey: resourceUri, format: 'npy', raw: npyProcessor._lastRaw };
		} else if (lower.endsWith('.pfm') && pfmProcessor._lastRaw) {
			entry = { resourceUri, cacheKey: resourceUri, format: 'pfm', raw: pfmProcessor._lastRaw };
		} else if ((lower.endsWith('.ppm') || lower.endsWith('.pgm') || lower.endsWith('.pbm')) && ppmProcessor._lastRaw) {
			entry = { resourceUri, cacheKey: resourceUri, format: 'ppm', raw: ppmProcessor._lastRaw };
		} else if (lower.endsWith('.png') && pngProcessor._lastRaw && pngProcessor._lastRaw.bitDepth > 8) {
			entry = { resourceUri, cacheKey: resourceUri, format: 'png', raw: pngProcessor._lastRaw };
		} else if (lower.endsWith('.hdr') && hdrProcessor._lastRaw) {
			entry = { resourceUri, cacheKey: resourceUri, format: 'hdr', raw: hdrProcessor._lastRaw };
		} else if (dicomProcessor._lastRaw && (datasetManifest?.kind === 'dicom' || lower.endsWith('.dcm') || lower.endsWith('.dicom'))) {
			entry = {
				resourceUri,
				cacheKey: `${resourceUri}#dicom-frame=${Number(dicomProcessor.metadata.frameIndex || 0)}`,
				format: 'dicom',
				raw: { image: dicomProcessor._lastRaw, metadata: { ...dicomProcessor.metadata } },
			};
		}
		_previousDecodedImageCache = entry;
	}

	function installCachedPlaceholder(width: number, height: number) {
		canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		canvas.classList.add('scale-to-fit');
		primaryImageData = new ImageData(width, height);
		imageElement = canvas;
		hasLoadedImage = true;
		PerfTrace.mark('decoded-cache-hit');
	}

	function postCachedExrFormatInfo(raw: any) {
		vscode.postMessage({
			type: 'formatInfo',
			value: {
				width: raw.width,
				height: raw.height,
				channels: raw.channels,
				samplesPerPixel: raw.channels,
				dataType: raw.type === 1016 ? 'float16' : 'float32',
				isHdr: true,
				formatLabel: 'EXR',
				formatType: 'exr-float',
				isInitialLoad: true,
				channelNames: raw.channelNames || [],
				displayedChannels: raw.displayedChannels || raw.channelNames || []
			}
		});
	}

	function tryRestoreDecodedImageFromCache(resourceUri: string, formatHint?: 'dicom' | 'tiff', pageIndex = 0, frameIndex = 0): boolean {
		const cache = _restoreDecodedImageCandidate;
		const requestedKey = formatHint === 'tiff' || isTiffExtension(resourceUri.toLowerCase())
			? `${resourceUri}#tiff-page=${pageIndex}`
			: formatHint === 'dicom' || datasetManifest?.kind === 'dicom' || /\.(dcm|dicom)$/i.test(resourceUri)
				? `${resourceUri}#dicom-frame=${frameIndex}`
				: resourceUri;
		if (!cache || cache.cacheKey !== requestedKey) { return false; }
		const raw = cache.raw;
		currentLoadDecodeInfo = null;
		switch (cache.format) {
			case 'tiff': {
				const tiffData = raw.tiffData;
				const image = tiffData?.image;
				const rasters = tiffData?.rasters;
				if (!image || !rasters) { return false; }
				currentLoadFormat = 'TIFF';
				currentLoadDecodeInfo = { engine: 'decoded-cache', durationMs: 0 };
				tiffProcessor.rawTiffData = tiffData;
				tiffProcessor._lastStatistics = raw.lastStatistics || null;
				tiffProcessor._lastStatisticsRgb24Mode = raw.lastStatisticsRgb24Mode === true;
				tiffProcessor._convertedFloatData = raw.convertedFloatData || null;
				tiffProcessor.pageIndex = Number(raw.pageIndex || 0);
				tiffProcessor.pageCount = Math.max(1, Number(raw.pageCount || 1));
				tiffProcessor.omeMetadata = tiffData.ome || null;
				const cachedOme = tiffProcessor.omeMetadata;
				mouseHandler.setPhysicalPixelSize(cachedOme ? {
					x: cachedOme.physicalSizeX, y: cachedOme.physicalSizeY,
					xUnit: cachedOme.physicalSizeXUnit, yUnit: cachedOme.physicalSizeYUnit,
				} : null);
				updateTiffPageOverlay();
				tiffProcessor._lastRenderHistogram = null;
				tiffProcessor._lastRenderUsedWebGL = false;
				tiffProcessor._isInitialLoad = true;
				tiffProcessor._pendingRenderData = { image, rasters };
				installCachedPlaceholder(image.getWidth(), image.getHeight());
				const sampleFormat = image.getSampleFormat?.();
				const bitsPerSample = image.getBitsPerSample?.();
				const samplesPerPixel = image.getSamplesPerPixel?.();
				const sampleFormatValue = Array.isArray(sampleFormat) ? sampleFormat[0] : sampleFormat;
				vscode.postMessage({
					type: 'formatInfo',
					value: {
						width: image.getWidth(),
						height: image.getHeight(),
						sampleFormat,
						samplesPerPixel,
						bitsPerSample,
						planarConfig: tiffData.ifd?.t284 ?? 1,
						formatType: tiffFormatTypeFor(sampleFormatValue, bitsPerSample),
						...(raw.formatInfo || {}),
						isInitialLoad: true,
						decodedWith: 'decoded-cache',
						...tiffProcessor._omeFormatInfo()
					}
				});
				return true;
			}
			case 'exr':
				currentLoadFormat = 'EXR';
				exrProcessor.rawExrData = raw;
				exrProcessor._cachedStats = undefined;
				exrProcessor._isInitialLoad = true;
				exrProcessor._pendingRenderData = {
					width: raw.width,
					height: raw.height,
					data: raw.data,
					channels: raw.channels,
					type: raw.type,
					format: raw.format
				};
				installCachedPlaceholder(raw.width, raw.height);
				postCachedExrFormatInfo(raw);
				return true;
			case 'npy':
				currentLoadFormat = 'NPY/NPZ';
				npyProcessor._lastRaw = raw;
				npyProcessor._cachedStats = undefined;
				npyProcessor._cachedStatsRgb24Mode = false;
				npyProcessor._isInitialLoad = true;
				npyProcessor._pendingRenderData = { data: raw.data, width: raw.width, height: raw.height };
				installCachedPlaceholder(raw.width, raw.height);
				npyProcessor._postFormatInfo(raw.width, raw.height, 'NPY');
				return true;
			case 'pfm':
				currentLoadFormat = 'PFM';
				pfmProcessor._lastRaw = raw;
				pfmProcessor._cachedStats = undefined;
				pfmProcessor._isInitialLoad = true;
				pfmProcessor._pendingRenderData = { displayData: raw.data, width: raw.width, height: raw.height, channels: raw.channels };
				installCachedPlaceholder(raw.width, raw.height);
				pfmProcessor._postFormatInfo(raw.width, raw.height, raw.channels, 'PFM');
				return true;
			case 'ppm':
				currentLoadFormat = 'PPM/PGM';
				ppmProcessor._lastRaw = raw;
				ppmProcessor._cachedStats = undefined;
				ppmProcessor._cachedStatsRgb24Mode = false;
				ppmProcessor._isInitialLoad = true;
				ppmProcessor._pendingRenderData = {
					displayData: raw.data,
					width: raw.width,
					height: raw.height,
					maxval: raw.maxval,
					channels: raw.channels
				};
				installCachedPlaceholder(raw.width, raw.height);
				ppmProcessor._postFormatInfo(raw.width, raw.height, raw.channels, raw.format || 'PPM/PGM', raw.maxval);
				return true;
			case 'png':
				currentLoadFormat = 'PNG/JPEG';
				pngProcessor._lastRaw = raw;
				pngProcessor._cachedStats = undefined;
				pngProcessor._cachedStatsRgb24Mode = false;
				pngProcessor._isInitialLoad = true;
				pngProcessor._pendingRenderData = true;
				installCachedPlaceholder(raw.width, raw.height);
				pngProcessor._postFormatInfo(raw.width, raw.height, raw.channels, raw.bitDepth, 'PNG');
				return true;
			case 'hdr':
				currentLoadFormat = 'HDR';
				hdrProcessor._lastRaw = raw;
				hdrProcessor._cachedStats = undefined;
				hdrProcessor._cachedWebglRgb = null;
				hdrProcessor._isInitialLoad = true;
				hdrProcessor._pendingRenderData = { data: raw.data, width: raw.width, height: raw.height, renderChannels: raw.channels };
				installCachedPlaceholder(raw.width, raw.height);
				hdrProcessor._postFormatInfo(raw.width, raw.height, 3, 'HDR');
				return true;
			case 'dicom': {
				const image = raw.image;
				if (!image?.data) { return false; }
				currentLoadFormat = 'DICOM';
				dicomProcessor._lastRaw = image;
				dicomProcessor.metadata = raw.metadata || {};
				dicomProcessor._cachedStats = undefined;
				dicomProcessor._isInitialLoad = true;
				dicomProcessor._pendingRenderData = { displayData: image.data, width: image.width, height: image.height, channels: image.channels };
				installCachedPlaceholder(image.width, image.height);
				dicomProcessor._postScientificFormatInfo({ ...image, metadata: dicomProcessor.metadata });
				return true;
			}
			default:
				return false;
		}
	}

	/**
	 * Switch to a new image in the collection (legacy - for fallback)
	 */
	function switchToNewImage(uri: string, resourceUri: string, options: { formatHint?: 'dicom' | 'tiff', pageIndex?: number, frameIndex?: number, netcdfOptions?: Record<string, any> } = {}) {
		// Every switch gets a new generation so any in-flight load from a
		// previous rapid press can detect it is stale and bail out.
		const gen = ++_loadGeneration;

		// Trace where this switch spends its time; the summary is logged from
		// finalizeImageSetup once the final pixels are on screen.
		let switchName = resourceUri.split('/').pop() || 'image';
		try { switchName = decodeURIComponent(switchName); } catch { /* keep encoded name */ }
		PerfTrace.begin(`switch ${switchName}`, { conciseLabel: `Collection switch ${switchName} completed` });
		_restoreDecodedImageCandidate = _previousDecodedImageCache;
		cacheCurrentDecodedImage();
		beginSeamlessImageTransition(true);

		// Abort the previous in-flight load: cancels its network fetch and lets
		// the processors stop before decoding, instead of the superseded load
		// running to completion and blocking the next image.
		if (_loadAbortController) { _loadAbortController.abort(); }
		decodeWorkerClient.cancelActiveDecodes();
		resetTiffCanvasReady();
		_loadAbortController = new AbortController();
		for (const p of allProcessors) { p.loadSignal = _loadAbortController.signal; }

		// Update the settings with the new resource URI
		settingsManager.settings.resourceUri = resourceUri;
		settingsManager.settings.src = uri;
		tiffProcessor.pageIndex = Math.max(0, Number(options.pageIndex || 0));
		tiffProcessor.pageCount = 1;
		updateTiffPageOverlay();
		updateFilenameBadge(resourceUri);

		// Keep the live zoom untouched while the old frame remains visible. The
		// captured state is applied to the completed replacement in finalizeImageSetup.
		renderCollectionLoadingState();
		if (filenameBadge) filenameBadge.classList.add('filename-badge--loading');

		// Reset the state
		hasLoadedImage = false;
		canvas = null;
		imageElement = null;
		primaryImageData = null;
		mouseHandler.setPhysicalPixelSize(null);
		disposeWebglRenderers();

		// Reset each processor's initial-load flag so they re-send formatInfo and
		// trigger the extension to apply the correct per-format settings for the
		// new image (e.g. switching from TIFF-int to EXR-float needs different
		// normalization defaults). The AppStateManager caches settings per-format
		// so any user adjustments are preserved when switching back.
		for (const p of allProcessors) { p._isInitialLoad = true; }

		// Clear each processor's stale raw data so the mouse handler and histogram
		// don't read pixels from the previous image. Without this, the TIFF-first
		// checks in mouse-handler.js and updateHistogramData() would return values
		// from the old image while the new one is loading/rendering.
		tiffProcessor.rawTiffData = null;
		tiffProcessor._lastStatistics = null;
		tiffProcessor._convertedFloatData = null;
		exrProcessor.rawExrData = undefined;
		exrProcessor._cachedStats = undefined;
		const rawDataProcessors = [exrProcessor, npyProcessor, pfmProcessor, ppmProcessor, pngProcessor, hdrProcessor, tgaProcessor, webImageProcessor, jxlProcessor, ...scientificProcessors];
		for (const p of rawDataProcessors) { p._lastRaw = null; }
		layeredPreviewProcessor.reset();
		_expandedLayerDocumentUri = undefined;
		updateLayeredPreviewOverlay();

		// Drop any pending deferred-render data from the previous image. Otherwise a
		// late updateSettings(isInitialRender) for the old image could draw it onto
		// the new image's canvas, overlaying two images of different sizes.
		for (const p of allProcessors) { p._pendingRenderData = null; }
		pngProcessor._lazyNativeReadback = null;

		// Keep existing image/canvas visible while the new image loads to avoid
		// a black flash. They will be removed in finalizeImageSetup once the new
		// image is ready to be shown.

		// Load the new image based on file type
		loadImageByType(uri, resourceUri, gen, options.formatHint, options.pageIndex, options.frameIndex, options.netcdfOptions);
	}

	/**
	 * Load image by type (wrapper function)
	 */
	async function loadImageByType(uri: string, resourceUri: string, gen: number, formatHint?: 'dicom' | 'tiff', pageIndex?: number, frameIndex?: number, netcdfOptions?: Record<string, any>) {
		// Wait until the browser has painted the loading UI (counter, filename
		// badge, loading dot) before starting synchronous decode work, so every
		// switch gives immediate visual feedback. This also lets a burst of
		// queued switch messages (rapid key presses) be processed first — all
		// but the newest switch bail out here instead of running a full load.
		// The plain timeout races as a fallback because requestAnimationFrame
		// does not fire while the webview is hidden.
		await new Promise(resolve => {
			requestAnimationFrame(() => setTimeout(resolve, 0));
			setTimeout(resolve, 100);
		});
		if (gen !== _loadGeneration) { return; }
		PerfTrace.mark('paint-yield');
		const lower = resourceUri.toLowerCase();
		const layeredFormat = layeredFormatForPath(lower);
		if (!lower.endsWith('.nc') && !lower.endsWith('.cdf') && netcdfOverlay) { netcdfOverlay.style.display = 'none'; }
		if (tryRestoreDecodedImageFromCache(resourceUri, formatHint, Number(pageIndex || 0), Number(frameIndex || 0))) {
			return;
		}
		if (layeredFormat) {
			handleLayeredPreview(layeredFormat, uri, gen);
		} else if (formatHint === 'tiff' || isTiffExtension(lower)) {
			handleTiff(uri, gen, pageIndex);
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
		} else if (lower.endsWith('.fits') || lower.endsWith('.fit') || lower.endsWith('.fts')) {
			handleScientificArray(fitsProcessor, uri, gen);
		} else if (formatHint === 'dicom' || lower.endsWith('.dcm') || lower.endsWith('.dicom') || !resourceUri.split('/').pop()?.includes('.')) {
			handleScientificArray(dicomProcessor, uri, gen, { frameIndex: Number(frameIndex || 0) });
		} else if (lower.endsWith('.nc') || lower.endsWith('.cdf')) {
			handleScientificArray(netcdfProcessor, uri, gen, netcdfOptions || netcdfSelection);
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
		if (layerManager.active && layerManager.hasCompositeStack()) {
			// Render directly for export instead of reading the visible canvas: its
			// ImageBitmap upload is asynchronous and may still contain the previous
			// layer state immediately after a visibility/opacity change.
			const rendered = layerManager.renderToImageData(settingsManager.settings, { nanColor: getNanColorObj() });
			if (rendered) {
				const exportCanvas = document.createElement('canvas');
				exportCanvas.width = rendered.width; exportCanvas.height = rendered.height;
				const exportContext = exportCanvas.getContext('2d');
				if (exportContext) {
					exportContext.putImageData(rendered, 0, 0);
					vscode.postMessage({ type: 'didExportAsPng', payload: exportCanvas.toDataURL('image/png') });
					exportCanvas.remove();
					return;
				}
			}
		}
		const lazyImageElement = imageElement?.tagName === 'IMG' ? (imageElement as unknown as HTMLImageElement) : null;
		if (lazyImageElement) {
			const tempCanvas = document.createElement('canvas');
			tempCanvas.width = lazyImageElement.naturalWidth;
			tempCanvas.height = lazyImageElement.naturalHeight;
			const ctx = tempCanvas.getContext('2d');
			if (ctx) {
				ctx.drawImage(lazyImageElement, 0, 0);
				vscode.postMessage({
					type: 'didExportAsPng',
					payload: tempCanvas.toDataURL('image/png')
				});
			}
			tempCanvas.remove();
		} else if (canvas) {
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

	function exportAsXcf() {
		try {
			if (!layerManager.hasCompositeStack()) { throw new Error('Open Layers View before exporting an XCF'); }
			const result = writeLayerStackAsXcf(layerManager.layers, layerManager.canvasWidth, layerManager.canvasHeight);
			let binary = '';
			for (let offset = 0; offset < result.data.length; offset += 0x8000) {
				binary += String.fromCharCode(...result.data.subarray(offset, Math.min(result.data.length, offset + 0x8000)));
			}
			vscode.postMessage({ type: 'didExportAsXcf', payload: btoa(binary), warnings: result.warnings });
		} catch (error) {
			vscode.postMessage({ type: 'didExportAsXcf', error: error instanceof Error ? error.message : String(error), warnings: [] });
		}
	}

	/**
	 * Show a notification message
	 * @param message - The message to display
	 * @param type - The type of notification ('success' or 'error')
	 */
	function showNotification(message: string, type: string = 'success') {
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
			let centerXImage: number, centerYImage: number;
			
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

					const sourceElement = imageElement?.tagName === 'IMG'
						? (imageElement as unknown as HTMLImageElement)
						: canvas || image;
					const sourceWidth = (sourceElement as any).naturalWidth || sourceElement.width;
					const sourceHeight = (sourceElement as any).naturalHeight || sourceElement.height;
					copyCanvas.width = sourceWidth;
					copyCanvas.height = sourceHeight;
					ctx.drawImage(sourceElement, 0, 0);

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
			showNotification(`Failed to copy image: ${(e as any).message}`, 'error');
		}
	}

	/**
	 * Paste position from previously copied state
	 * Scales the position for images of different sizes
	 * @param positionState - Position state (from extension for cross-webview, or local)
	 */
	function pastePosition(positionState: CopiedPosition | null) {
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
			
			targetScale = (state.scale as number) * scaleRatio;
			
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
				const targetDocX = elemLeftDoc + targetCenterX * (targetScale as number);
				const targetDocY = elemTopDoc + targetCenterY * (targetScale as number);
				
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
	async function handleStartComparison(peerUri: string) {
		try {
			vscode.postMessage({ type: 'show-loading' });

			// Track peer URI for state persistence
			if (!peerImageUris.includes(peerUri)) {
				peerImageUris.push(peerUri);
			}

			const lower = peerUri.toLowerCase();
			let result: any;

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

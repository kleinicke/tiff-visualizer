import { encodeDepthPlane } from './modules/depth-plane.js';
import { NavigationKeys } from './modules/navigation-shortcuts.js';
import type { ActiveImageProcessor } from './modules/active-image.js';
import { parseAutomationRequest, type HostToViewerMessage, type ViewerToHostMessage, type FormatInfo, type DatasetManifest, type DatasetSeries, type DatasetAxis, type DatasetPlane } from '../shared/viewer-protocol';
import { ImageNavigation, type CachedImage } from './modules/image-navigation';
import { installImageLoad, type ImageLoadResult, type LoadProcessor } from './modules/image-load';
import { imageMeasurement, imageHistogram, imageLayer, type ActiveImage, type DecodedSnapshot } from './modules/active-image';
import { sampleAt } from './modules/measure/types';
import { openContextMenu, type MenuItem } from '../ui/context-menu';
import Navigation from '../ui/components/Navigation.svelte';
import { mountView } from '../ui/mount.js';
import type { NavigationModel } from '../ui/navigation-model.js';
import { on as onSvelteEvent } from 'svelte/events';
import { remoteTileConcurrency } from './modules/remote-tiff-source.js';
"use strict";

import { SettingsManager, webviewStateMatchesVersions, withWebviewStateVersions } from './modules/settings-manager.js';
import type { ImageSettings } from './modules/settings-manager.js';
import type { DeferredRenderOptions } from './modules/types.js';
import { tiffFormatTypeFor, tiffTypeMax, tiffNeedsFloatCarrier } from './modules/tiff-format-utils.js';
import { scenePageDirectory, imagePages, isPyramidal, levelForDisplayWidth, levelForZoom, levelLabel, levelsForPage, pageOwningIfd } from './modules/tiff-pages.js';
import { planRegionForView, snapToBlocks, visibleImageRect } from './modules/viewport-tiles.js';
import { FULL_RESOLUTION_PIXEL_BUDGET, LARGE_PYRAMID_SCENE_THRESHOLD } from './modules/tiff-pages.js';
import type { Rect } from './modules/viewport-tiles.js';
import { bandDescription } from './modules/gdal-metadata.js';
import { nanIsTransparent, nextNanColor as nextNanColor_, resolveNanColor } from './modules/nan-color.js';
import type { TiffPageEntry } from './modules/tiff-pages.js';
import { PngProcessor } from './modules/png-processor.js';
import { TgaProcessor } from './modules/tga-processor.js';
import { WebImageProcessor } from './modules/web-image-processor.js';
import { ZoomController } from './modules/zoom-controller.js';
import { MouseHandler } from './modules/mouse-handler.js';
import { HistogramOverlay } from './modules/histogram-overlay.js';
import { DebayerPanel } from './modules/debayer-panel.js';
import { DEFAULT_DEBAYER, invalidateDebayerCache, shouldDebayer, CFA_DETECTED_EVENT, getLastDebayerGains, getDebayeredPixel, type DebayerSettings } from './modules/debayer.js';
import { MetadataPanel } from './modules/metadata-panel.js';
import type { MetadataInfo } from './modules/metadata-panel.js';
import { MeasurePanel } from './modules/measure-panel.js';
import { ChannelsPanel } from './modules/channels-panel.js';
import { WebGPUChannelCompositor } from './modules/webgpu-channel-compositor.js';
import {
	compositeChannels,
	defaultChannelSettings,
	planesFromInterleaved,
	parseChannelGroups,
	resolveChannelGroups,
	suggestedChannelColors,
	type ChannelPlane,
	type ChannelSettings,
} from './modules/channel-composite.js';
import { RoiManager } from './modules/measure/roi-manager.js';
import { RoiOverlay } from './modules/measure/roi-overlay.js';
import { autoCalibration, calibrationFromCzi, calibrationFromDicom, calibrationFromTagList } from './modules/measure/calibration.js';
import { deserializeRoi, parseSidecar, serializeRoi } from './modules/measure/roi-io.js';
import { toScalarPlane, UNCALIBRATED, type Calibration, type MeasurementSource } from './modules/measure/types.js';
import type { TagEntry } from './modules/tiff-tag-utils.js';
import { ColormapConverter } from './modules/colormap-converter.js';
import { ImageRenderer, ImageStatsCalculator } from './modules/normalization-helper.js';
import { DecodeWorkerClient } from './modules/decode-worker-client.js';
import { FastRawWorkerClient } from './modules/fast-raw-worker-client.js';
import {
	LayerCompositorWorkerClient,
	layerDisplayScale,
	shouldUseLayerInteractionPreview,
} from './modules/layer-compositor-worker-client.js';
import type {
	LayerCompositorBackend,
	LayerCompositorBackendSelection,
} from './modules/layer-compositor-worker-client.js';
import { WebGL2LayerCompositor } from './modules/webgl2-layer-compositor.js';
import { WebGPULayerCompositor } from './modules/webgpu-layer-compositor.js';
import { PerfTrace } from './modules/perf-trace.js';
import { setWebGLLateFailureHandler } from './modules/webgl2-float-renderer.js';
import { LayerManager, BLEND_MODES } from './modules/layer-manager.js';
import type { LayerInput } from './modules/layer-manager.js';
import { LayersPanel } from './modules/layers-panel.js';
import { OmeAxis, omeCoordinatesToIfd, omeIfdToCoordinates } from './modules/ome-tiff.js';
import { installRangeDoubleClickReset, datasetAxisSignature } from './modules/range-controls.js';
import type { LayerExportFormat } from './modules/layer-document-writers.js';
import { LayeredPreviewProcessor } from './modules/layered-preview-processor.js';
import { offerPrefetch, offerPushedSource, setPushedSourceChannel, startPrefetch } from './modules/pushed-source.js';
import type { LayeredDocumentFormat } from './modules/layered-document.js';
import { isTiffPath, layeredFormatOf, resolveFormat } from './modules/format-registry.js';
import { PyramidScene } from './modules/pyramid-scene.js';

/**
 * Main Image Preview Application
 * Orchestrates all modules to provide image viewing functionality
 */
(function () {
	type CopiedPosition = { relativeX: number, relativeY: number, sourceWidth: number, sourceHeight: number, scale: number | string };
	type ColormapConversionState = { colormapName: string, minValue: number, maxValue: number, inverted: boolean, logarithmic: boolean };

	const nativeBootstrap = (window as any).__tiffVisualizerBootstrap as {
		vscode?: { postMessage: (message: any) => any, setState: (state: any) => void, getState: () => any };
		nativeImage?: HTMLImageElement | null;
		visibleTotalMs?: number | null;
	} | undefined;
	let layerWriterPromise: Promise<typeof import('./modules/layer-document-writers.js')> | null = null;
	let imagejRoiPromise: Promise<typeof import('./modules/measure/imagej-roi.js')> | null = null;
	function loadLayerWriter() {
		if (!layerWriterPromise) {
			const url = (window as any).__tiffVisualizerVendorAssets?.layerDocumentWriter;
			if (!url) { return Promise.reject(new Error('Layer document writer asset is unavailable')); }
			layerWriterPromise = import(url) as Promise<typeof import('./modules/layer-document-writers.js')>;
		}
		return layerWriterPromise;
	}
	function loadImagejRoi() {
		if (!imagejRoiPromise) {
			const url = (window as any).__tiffVisualizerVendorAssets?.imagejRoi;
			if (!url) { return Promise.reject(new Error('ImageJ ROI asset is unavailable')); }
			imagejRoiPromise = import(url) as Promise<typeof import('./modules/measure/imagej-roi.js')>;
		}
		return imagejRoiPromise;
	}
	// The tiny native-image bootstrap, or the source-push bootstrap, acquires
	// the API before this application loads. Reuse it: acquireVsCodeApi() may
	// only be called once.
	// @ts-ignore - acquireVsCodeApi is injected by VS Code at runtime, not declared globally
	const originalVscode = nativeBootstrap?.vscode || (window as any).__tiffVisualizerVsCodeApi || acquireVsCodeApi() as { postMessage: (message: any) => any, setState: (state: any) => void, getState: () => any };
	setPushedSourceChannel(originalVscode);
	const settingsManager = new SettingsManager();
	const navigationKeys = new NavigationKeys(() => settingsManager.settings.navigationShortcuts, () => {
		if (navigationView) {
			navigationModel = { ...navigationModel, hints: navKeyHints(navControls) };
			navigationView.update(navigationModel);
		}
	});
	const navigation = new ImageNavigation<FormatInfo>({
		cancelWorkers: () => {
			for (const worker of [decodeWorkerClient, pngDecodeWorkerClient, layeredDecodeWorkerClient, fastRawWorkerClient]) worker.cancelActiveDecodes();
			resetTiffCanvasReady();
		},
		setSignal: signal => { for (const processor of allProcessors) processor.loadSignal = signal; },
		resetFile: () => {
			disposeWebglRenderers();
			for (const processor of allProcessors) processor.resetForNewFile();
			_expandedLayerDocumentUri = undefined;
			updateLayeredPreviewOverlay();
		},
	});
	const stateExtensionVersion = settingsManager.settings.extensionVersion;
	const stateVsCodeVersion = settingsManager.settings.vscodeVersion;
	const initialPersistedState = originalVscode.getState();
	if (initialPersistedState && !webviewStateMatchesVersions(
		initialPersistedState,
		stateExtensionVersion,
		stateVsCodeVersion,
	)) {
		console.info(
			`[State] Discarding persisted preview state from extension ${initialPersistedState.extensionVersion || 'unknown'} ` +
			`/ VS Code ${initialPersistedState.vscodeVersion || 'unknown'}`,
		);
		originalVscode.setState(withWebviewStateVersions({}, stateExtensionVersion, stateVsCodeVersion));
	}

	// Format info tracking for context menu
	let currentFormatInfo: FormatInfo | null = null;
	let lastFormatInfoPost: { time: number, generation: number, formatType: string } | null = null;

	// Wrap vscode.postMessage to track formatInfo
	const vscode = {
		postMessage: (message: ViewerToHostMessage) => {
			// Track formatInfo when it's sent
			if (message.type === 'formatInfo' && message.value) {
				// The extension host uses this URI to report the correct on-disk size,
				// including when a collection switch is showing a different resource
				// from the custom document that owns the webview.
				message = {
					...message,
					value: { ...message.value, resourceUri: settingsManager.settings.resourceUri },
				};
				currentFormatInfo = message.value;
				lastFormatInfoPost = {
					time: performance.now(),
					generation: navigation.generation,
					formatType: String(message.value.formatType || '')
				};
			}
			return originalVscode.postMessage(message);
		},
		setState: (state: any) => originalVscode.setState(
			withWebviewStateVersions(state || {}, stateExtensionVersion, stateVsCodeVersion),
		),
		getState: () => {
			const state = originalVscode.getState();
			return webviewStateMatchesVersions(state, stateExtensionVersion, stateVsCodeVersion)
				? state
				: undefined;
		},
	};

	// Initialize all modules
	const dormantProcessor = (): any => ({
		_isInitialLoad: true, _pendingRenderData: null, _lastRaw: null,
		_lastAllTags: [], metadata: {}, rawTiffData: null, rawExrData: null,
		pageIndex: 0, pageCount: 1, pageDirectory: [], omeMetadata: null, omeBinaryOnly: null,
		selectableBandCount: 0,
		// MouseHandler probes processors in a fixed order. A lazy family that has
		// not been installed yet must behave like an empty processor, not merely
		// be truthy and then throw when its pixel accessor is called.
		getColorAtPixel: () => '',
	});
	let tiffProcessor: any = dormantProcessor();
	let exrProcessor: any = dormantProcessor();
	const zoomController = new ZoomController(settingsManager, vscode);
	const mouseHandler = new MouseHandler(settingsManager, vscode, () => getActiveImage());
	let npyProcessor: any = dormantProcessor();
	let pfmProcessor: any = dormantProcessor();
	let ppmProcessor: any = dormantProcessor();
	const pngProcessor = new PngProcessor(settingsManager, vscode);
	pngProcessor.onMetadataTagsReady = () => updateMetadataData();
	let hdrProcessor: any = dormantProcessor();
	const tgaProcessor = new TgaProcessor(settingsManager, vscode);
	const webImageProcessor = new WebImageProcessor(settingsManager, vscode);
	let fitsProcessor: any = dormantProcessor();
	let jxlProcessor: any = dormantProcessor();
	let jxrProcessor: any = dormantProcessor();
	let jp2Processor: any = dormantProcessor();
	let dicomProcessor: any = dormantProcessor();
	let netcdfProcessor: any = dormantProcessor();
	let cziProcessor: any = dormantProcessor();
	let nd2Processor: any = dormantProcessor();
	let lifProcessor: any = dormantProcessor();
	let sdtProcessor: any = dormantProcessor();
	let sgiProcessor: any = dormantProcessor();
	let scientificProcessors: any[] = [];
	const layeredPreviewProcessor = new LayeredPreviewProcessor(settingsManager, vscode);
	// All format processors, for bulk per-switch state resets and load cancellation.
	const allProcessors: any[] = [pngProcessor, tgaProcessor, webImageProcessor, layeredPreviewProcessor];
	// Off-thread decoder. It is started by loadImageByType only for formats that
	// need it; eagerly compiling the full WASM module made native JPEG/PNG/WebP
	// loads compete with a decoder they never use.
	const decodeWorkerClient = new DecodeWorkerClient();
	const pngDecodeWorkerClient = new DecodeWorkerClient('pngDecodeWorker.bundle.js');
	const layeredDecodeWorkerClient = new DecodeWorkerClient('layeredDecodeWorker.bundle.js', false);
	const fastRawWorkerClient = new FastRawWorkerClient(decodeWorkerClient);
	const processorFamilyLoads = new Map<string, Promise<void>>();
	const installProcessor = (processor: any, worker: DecodeWorkerClient | FastRawWorkerClient = decodeWorkerClient) => {
		processor.decodeWorker = worker;
		processor._isInitialLoad = true;
		processor.loadSignal = navigation.signal;
		allProcessors.push(processor);
		return processor;
	};
	function ensureProcessorFamily(kind: string): Promise<void> {
		const family = ['sgi', 'fits', 'dicom', 'netcdf', 'czi', 'nd2', 'lif', 'sdt', 'jxr', 'jp2', 'jxl'].includes(kind) ? 'scientific' : kind;
		const existing = processorFamilyLoads.get(family);
		if (existing) { return existing; }
		const load = (async () => {
			if (family === 'tiff') {
				const pendingPageIndex = Number(tiffProcessor.pageIndex || 0);
				const [{ TiffProcessor }, wasm, strips] = await Promise.all([
					import('./modules/tiff-processor.js'),
					import('./modules/tiff-wasm-wrapper.js'),
					import('./modules/strip-parallel-decode.js'),
				]);
				tiffProcessor = installProcessor(new TiffProcessor(settingsManager, vscode));
				tiffProcessor.pageIndex = pendingPageIndex;

				void wasm.getWasmModule();
				strips.prewarmStripPool();
			} else if (family === 'exr') {
				const [{ ExrProcessor }, strips] = await Promise.all([
					import('./modules/exr-processor.js'),
					import('./modules/strip-parallel-decode.js'),
				]);
				exrProcessor = installProcessor(new ExrProcessor(settingsManager, vscode));

				strips.prewarmStripPool();
			} else if (family === 'npy') {
				const { NpyProcessor } = await import('./modules/npy-processor.js');
				npyProcessor = installProcessor(new NpyProcessor(settingsManager, vscode), fastRawWorkerClient);
				planeNavProcessors.push(npyProcessor);

			} else if (family === 'pfm') {
				const { PfmProcessor } = await import('./modules/pfm-processor.js');
				pfmProcessor = installProcessor(new PfmProcessor(settingsManager, vscode), fastRawWorkerClient);

			} else if (family === 'netpbm') {
				const { PpmProcessor } = await import('./modules/ppm-processor.js');
				ppmProcessor = installProcessor(new PpmProcessor(settingsManager, vscode), fastRawWorkerClient);

			} else if (family === 'hdr') {
				const { HdrProcessor } = await import('./modules/hdr-processor.js');
				hdrProcessor = installProcessor(new HdrProcessor(settingsManager, vscode));

			} else if (family === 'scientific') {
				const [{ ScientificArrayProcessor }, { CziProcessor }, decoders] = await Promise.all([
					import('./modules/scientific-array-processor.js'),
					import('./modules/czi-processor.js'),
					import('./modules/main-thread-decode.js'),
				]);
				fitsProcessor = installProcessor(new ScientificArrayProcessor(settingsManager, vscode, { workerFormat: 'fits', formatLabel: 'FITS', formatType: 'fits', parse: decoders.decodeFitsLocal }));
				jxrProcessor = installProcessor(new ScientificArrayProcessor(settingsManager, vscode, { workerFormat: 'jxr', formatLabel: 'JPEG XR', formatType: 'jxr', parse: decoders.decodeJxrLocal }));
				jp2Processor = installProcessor(new ScientificArrayProcessor(settingsManager, vscode, { workerFormat: 'jp2', formatLabel: 'JPEG 2000', formatType: 'jp2', parse: decoders.decodeJp2Local }));
				jxlProcessor = installProcessor(new ScientificArrayProcessor(settingsManager, vscode, { workerFormat: 'jxl', formatLabel: 'JPEG XL', formatType: 'jxl', formatTypeFor: domain => (domain.sampleFormat === 3 ? 'jxl-float' : 'jxl'), parse: decoders.decodeJxlLocal }));
				dicomProcessor = installProcessor(new ScientificArrayProcessor(settingsManager, vscode, { workerFormat: 'dicom', formatLabel: 'DICOM', formatType: 'dicom', cacheSourceInWorker: true, parse: (buffer: ArrayBuffer, options: any) => decoders.decodeDicomLocal(buffer, { frameIndex: Number(options?.frameIndex || 0) }) }));
				netcdfProcessor = installProcessor(new ScientificArrayProcessor(settingsManager, vscode, { workerFormat: 'netcdf', formatLabel: 'NetCDF', formatType: 'netcdf', parse: (buffer: ArrayBuffer, options: any) => decoders.decodeNetcdfLocal(buffer, options || {}) }));
				cziProcessor = installProcessor(new CziProcessor(settingsManager, vscode, { workerFormat: 'czi', formatLabel: 'CZI', formatType: 'czi', cacheSourceInWorker: true, parse: (buffer: ArrayBuffer, options: any) => decoders.decodeCziLocal(buffer, options || {}) }));
				nd2Processor = installProcessor(new ScientificArrayProcessor(settingsManager, vscode, { workerFormat: 'nd2', formatLabel: 'ND2', formatType: 'nd2', cacheSourceInWorker: true, ranged: 'nd2', parse: (buffer: ArrayBuffer, options: any) => decoders.decodeNd2Local(buffer, options || {}) }));
				lifProcessor = installProcessor(new ScientificArrayProcessor(settingsManager, vscode, { workerFormat: 'lif', formatLabel: 'LIF', formatType: 'lif', cacheSourceInWorker: true, ranged: 'lif', parse: (buffer: ArrayBuffer, options: any) => decoders.decodeLifLocal(buffer, options || {}) }));
				sdtProcessor = installProcessor(new ScientificArrayProcessor(settingsManager, vscode, { workerFormat: 'sdt', formatLabel: 'SDT', formatType: 'sdt', cacheSourceInWorker: true, parse: (buffer: ArrayBuffer, options: any) => decoders.decodeSdtLocal(buffer, options || {}) }));
				sgiProcessor = installProcessor(new ScientificArrayProcessor(settingsManager, vscode, { workerFormat: 'sgi', formatLabel: 'SGI RGB', formatType: 'sgi', parse: (buffer: ArrayBuffer) => decoders.decodeSgiLocal(buffer) }));
				scientificProcessors = [sgiProcessor, fitsProcessor, jxrProcessor, jp2Processor, jxlProcessor, dicomProcessor, netcdfProcessor, cziProcessor, nd2Processor, lifProcessor, sdtProcessor];

				planeNavProcessors = [npyProcessor, cziProcessor, nd2Processor, lifProcessor, sdtProcessor];
			}
		})();
		processorFamilyLoads.set(family, load);
		return load;
	}
	// Started after the first image is shown (logLoadPerformance), or by the
	// first composite that needs it: booting it at page start fetched its
	// bundle, a worker and WebAssembly while the first image was decoding.
	const layerCompositorWorker = new LayerCompositorWorkerClient();
	const layerGpuCompositor = new WebGL2LayerCompositor();
	const layerWebGpuCompositor = new WebGPULayerCompositor();
	pngProcessor.decodeWorker = pngDecodeWorkerClient;
	layeredPreviewProcessor.decodeWorker = layeredDecodeWorkerClient;
	const histogramOverlay = new HistogramOverlay(settingsManager, vscode);
	const metadataPanel = new MetadataPanel(settingsManager, vscode);
	const debayerPanel = new DebayerPanel(settings => { void handleDebayerSettingsChanged(settings); });
	// Do not initialize the multi-megabyte WASM module merely because the
	// optional debayer UI exists. The decoder worker owns normal image startup;
	// debayer's synchronous path already has a JS fallback and initializes WASM
	// lazily when the feature is actually used.
	// A file that declares itself a CFA mosaic gets the panel opened for it;
	// the mode still has to be switched on deliberately, so nothing about the
	// image changes without the user asking.
	window.addEventListener(CFA_DETECTED_EVENT, (event: Event) => {
		if (!(event as CustomEvent).detail?.detected) { return; }
		debayerPanel.show();
		// Showing the panel is not enough: its checkbox reads from its own state,
		// so without pushing that state into the settings the panel would claim
		// the mode is on while the image stayed a raw mosaic -- and toggling off
		// and on again would be the only way to fix it.
		void handleDebayerSettingsChanged(debayerPanel.getSettings());
	});


	// --- multi-channel compositing ------------------------------------------
	// Off unless switched on, and only offered for images that actually have
	// several channels. Single-channel viewing is untouched.

	let channelPlanes: ChannelPlane[] = [];
	let channelSettings: ChannelSettings[] = [];
	let channelSolo: number | null = null;
	// A configured group isolated as a whole. Exclusive with `channelSolo`.
	let channelGroupSolo: string | null = null;
	// Channels a Solo switched on because they were off. Clearing the solo
	// switches them off again, so pressing Solo twice leaves things as they were.
	let soloShownPositions: number[] = [];
	// The channel the selector overlay shows while the composite is on. It
	// follows Solo and survives clearing it, so the slider does not jump back.
	let compositeSelectorChannel: number | null = null;
	let channelSoloResource: string | null = null;
	let compositeEnabled = false;
	// `tiffVisualizer.channels.autoComposite` turns compositing on for images
	// whose channels come from metadata. Once the user switches it either way,
	// that choice wins for the rest of this preview. `compositeAuto` marks a
	// composite the setting switched on, so an image it does not apply to (an
	// RGB photo later in the folder) goes back to the decoded view.
	let compositeChosenByUser = false;
	// The file `tiffVisualizer.channels.autoOpenPanel` last opened the panel for,
	// so closing the panel, or stepping through Z/T, is not undone.
	let autoPanelResource: string | null = null;
	let compositeAuto = false;
	let channelGeneration = -1;
	// Sibling pages of an OME/ImageJ stack decode in the background. The panel
	// reports this rather than "single channel", which is what it would
	// otherwise say for the whole time the pages are still arriving.
	let channelStatus: string | null = null;
	// Which file/Z/T the loaded OME planes belong to. They contain every
	// channel, so moving the C selector must not throw them away.
	let channelPlanesKey: string | null = null;
	// `tiffVisualizer.channels.groups`: named sets of channels for the panel.
	let channelGroups = parseChannelGroups(settingsManager.settings.channelDefaults?.groups);
	let channelGroupsKey = JSON.stringify(settingsManager.settings.channelDefaults?.groups ?? null);
	let compositeRenderHandle = 0;
	// WebGPU is tried first and the CPU compositor is the fallback and the
	// correctness reference. There is deliberately no WebGL2 variant: both paths
	// build their colour tables with the same `prepareChannels()`, and a third
	// implementation would only add surface for a backend on its way out.
	const channelGpuCompositor = new WebGPUChannelCompositor();
	let channelBackend: 'webgpu' | 'cpu' = 'cpu';
	let channelGpuRequested = false;

	/**
	 * Separate the current image into channel planes.
	 *
	 * Two layouts have to be handled, and they are genuinely different: an
	 * ordinary multi-sample image (RGB TIFF, EXR, NPY) keeps its channels
	 * interleaved within one page, whereas an OME-TIFF with a C axis stores each
	 * channel as its own IFD. The second is the microscopy case this feature
	 * exists for, and it needs the sibling pages decoded — see
	 * `loadOmeChannelPlanes`.
	 */
	function rebuildChannelPlanes(): void {
		if (channelGeneration === navigation.generation) { return; }
		channelGeneration = navigation.generation;
		// Same file, Z and T: the planes already hold every channel.
		if (channelPlanes.length >= 2 && channelPlanesKey !== null && channelPlanesKey === omePlaneKey()) { return; }
		// Tints and opacities the user chose should survive stepping to the next
		// image of a series; the display ranges belong to the data and are
		// recomputed. Carrying either across a change in channel count would be
		// meaningless, so that case starts fresh.
		const previousSettings = channelSettings;
		channelPlanes = [];
		channelSettings = [];
		soloShownPositions = [];
		channelStatus = null;

		const source = getMeasurementSource();
		// Nothing decoded yet: leave the generation unconsumed so the next
		// caller retries instead of seeing "no channels" for the whole load.
		if (!source) { channelGeneration = -1; return; }

		const ome = tiffProcessor.rawTiffData?.ome || null;
		const omeChannelCount = ome?.sizeC || 0;

		if (omeChannelCount > 1 && (source.channels || 1) === 1) {
			// Channels live on separate pages; fetch them in the background so the
			// first page still appears immediately.
			void loadOmeChannelPlanes(omeChannelCount, navigation.generation);
			return;
		}

		if ((source.channels || 1) < 2 || !source.data) { return; }

		// OME names its channels; a GeoTIFF names its bands in GDALMetadata
		// ("yearly rate of change" beats "Channel 1"). Either beats nothing.
		const gdalNames = Array.from({ length: source.channels }, (_unused, index) =>
			bandDescription(tiffProcessor.gdalMetadata, index)).filter(Boolean);
		const omeNames = ome?.channels?.map((channel: { name?: string }) => channel?.name).filter(Boolean) as string[] | undefined;
		const names = omeNames?.length ? omeNames
			: (gdalNames.length === source.channels ? gdalNames : undefined);
		channelPlanes = planesFromInterleaved(
			source.data, source.width, source.height, source.channels, names,
		);
		channelSettings = adoptChannelSettings(channelPlanes, previousSettings, {
			colors: ome?.channels?.map((channel: { colorCss?: string }) => channel?.colorCss),
		});
		channelsPanel.render();
	}

	/**
	 * Decode the sibling C planes of an OME-TIFF.
	 *
	 * The page currently on screen is only one channel; the rest are decoded
	 * through the same worker path the main load uses, at the current Z/T. The
	 * generation check makes a superseded load drop its results instead of
	 * compositing planes from an image the user has already navigated away from.
	 */
	async function loadOmeChannelPlanes(channelCount: number, generation: number): Promise<void> {
		const ome = tiffProcessor.omeMetadata;
		const src = settingsManager.settings.src || '';
		if (!ome || !src) { return; }

		const current = omeIfdToCoordinates(ome, tiffProcessor.pageIndex);
		const planesKey = omePlaneKey();
		const planes: ChannelPlane[] = [];
		const failed: number[] = [];
		const setStatus = (text: string | null) => {
			if (generation !== navigation.generation) { return; }
			channelStatus = text;
			channelsPanel.render();
		};
		// One read of the file serves every channel. The worker hands the bytes
		// back untouched (`returnSource`), so a 41-channel stack costs one fetch
		// rather than 41 full downloads of the whole file.
		let fileBytes: ArrayBuffer | null = null;

		for (let c = 0; c < channelCount; c++) {
			if (generation !== navigation.generation) { return; }
			const ifd = omeCoordinatesToIfd(ome, { ...current, c });
			setStatus(`Loading channel ${c + 1} of ${channelCount}…`);

			let decoded: { data?: ArrayLike<number>; width?: number; height?: number; channels?: number } | null = null;
			if (ifd === tiffProcessor.pageIndex && tiffProcessor.rawTiffData?.data) {
				// The visible page is already decoded; re-decoding it would be
				// pure waste on every navigation.
				decoded = {
					data: tiffProcessor.rawTiffData.data,
					width: tiffProcessor.rawTiffData.ifd.width,
					height: tiffProcessor.rawTiffData.ifd.height,
					channels: tiffProcessor.rawTiffData.ifd.t277 || 1,
				};
			} else {
				try {
					if (!fileBytes) { fileBytes = await (await fetch(src)).arrayBuffer(); }
					const pending = decodeWorkerClient.decode('tiff', fileBytes, { pageIndex: ifd, returnSource: true });
					fileBytes = null;
					const result = pending ? await pending : null;
					if (result?.sourceBuffer?.byteLength) { fileBytes = result.sourceBuffer; }
					if (result?.ok && result.result?.data) { decoded = result.result; }
					else { console.warn('[Channels] Decode of channel page failed', ifd, result?.error); }
				} catch (error) {
					console.warn('[Channels] Could not decode channel page', ifd, error);
				}
			}

			if (!decoded?.data || !decoded.width || !decoded.height) { failed.push(c); continue; }
			const pixels = decoded.width * decoded.height;
			const stride = decoded.channels || 1;
			const plane = new Float32Array(pixels);
			for (let p = 0; p < pixels; p++) { plane[p] = Number(decoded.data[p * stride]); }
			planes.push({
				index: c,
				name: ome.channels?.[c]?.name || `Channel ${c + 1}`,
				data: plane,
				width: decoded.width,
				height: decoded.height,
			});
		}

		if (generation !== navigation.generation) { return; }
		if (planes.length < 2) {
			setStatus(`Could not load the channels of this image (${failed.length} of ${channelCount} pages failed to decode).`);
			return;
		}
		channelStatus = failed.length ? `${failed.length} of ${channelCount} channels could not be decoded and are omitted.` : null;
		channelPlanes = planes;
		channelPlanesKey = planesKey;
		channelSettings = adoptChannelSettings(planes, channelSettings, {
			colors: ome.channels?.map((channel: any) => channel?.colorCss),
		});
		channelsPanel.render();
		if (compositeEnabled) { scheduleCompositeRender(); }
	}

	/** Draw the composite into the visible canvas. */
	function renderComposite(): void {
		if (!compositeEnabled || channelPlanes.length < 2) { return; }
		const width = channelPlanes[0].width;
		const height = channelPlanes[0].height;
		// The channel compositor writes opaque pixels, so a transparent choice
		// falls back to black here rather than silently becoming invisible.
		const resolved = resolveNanColor(settingsManager.settings);
		const nanColor: [number, number, number] = [resolved.r, resolved.g, resolved.b];
		const options = { soloIndex: activeSolo(), nanColor };

		// Kick off device creation once, in the background. The first composite
		// therefore lands on the CPU rather than waiting on an adapter, and every
		// later one uses the GPU.
		if (!channelGpuRequested && WebGPUChannelCompositor.isSupported()) {
			channelGpuRequested = true;
			void channelGpuCompositor.initialize().then(ready => {
				if (ready && compositeEnabled) { scheduleCompositeRender(); }
			});
		}

		if (channelGpuCompositor.isReady()) {
			const gpuCanvas = channelGpuCompositor.render(
				channelPlanes, channelSettings, width, height, options,
			);
			if (gpuCanvas) {
				const context = ensure2dCanvasContext();
				if (context) {
					if (canvas && (canvas.width !== width || canvas.height !== height)) {
						canvas.width = width;
						canvas.height = height;
					}
					context.clearRect(0, 0, width, height);
					context.drawImage(gpuCanvas, 0, 0);
					// Pixel inspection and the histogram read `primaryImageData`,
					// so it has to reflect what is on screen. Reading it back
					// costs one copy and only happens after a settled render.
					primaryImageData = context.getImageData(0, 0, width, height);
					channelBackend = 'webgpu';
					return;
				}
			}
		}

		const imageData = compositeChannels(channelPlanes, channelSettings, width, height, options);
		const context = ensure2dCanvasContext();
		if (!context) { return; }
		void renderImageDataToCanvas(imageData, context);
		primaryImageData = imageData;
		channelBackend = 'cpu';
	}

	function scheduleCompositeRender(): void {
		if (compositeRenderHandle) { return; }
		compositeRenderHandle = requestAnimationFrame(() => {
			compositeRenderHandle = 0;
			renderComposite();
			if (histogramOverlay.getVisibility()) { updateHistogramData(); }
		});
	}

	const channelsPanel = new ChannelsPanel({
		getPlanes: () => { rebuildChannelPlanes(); return channelPlanes; },
		getSettings: () => channelSettings,
		setSettings: settings => {
			channelSettings = settings;
			// A channel the user switches off by hand is theirs to decide about.
			soloShownPositions = soloShownPositions.filter(position => settings[position]?.visible);
		},
		isComposite: () => compositeEnabled,
		setComposite: enabled => {
			compositeEnabled = enabled;
			compositeChosenByUser = true;
			compositeAuto = false;
			if (enabled) {
				// The selector shows the soloed channel, or the loaded page's if none.
				compositeSelectorChannel = channelSolo;
				rebuildChannelPlanes();
				renderComposite();
			} else if (compositeSelectorChannel !== null && currentChannelIndex() !== null
				&& currentChannelIndex() !== compositeSelectorChannel) {
				// The selector was left on a channel other than the loaded page;
				// show that channel, so the two agree.
				selectChannelThroughSelector(compositeSelectorChannel);
			} else {
				// Leaving composite mode re-renders the image exactly as it was
				// decoded, so the mode is genuinely a view and not a conversion.
				void updateImageWithNewSettings();
			}
			updateTiffPageOverlay();
			scheduleSaveState();
		},
		getGroups: () => resolveChannelGroups(channelGroups, channelPlanes),
		getGroupSolo: () => channelGroupSolo,
		setGroupSolo: name => {
			channelGroupSolo = name;
			// One solo at a time. The selector keeps its position: a group is
			// several channels, which a single slider cannot show.
			if (name !== null) {
				channelSolo = null;
				// Soloing a group switches all its channels on.
				soloShowChannels(resolveChannelGroups(channelGroups, channelPlanes).find(group => group.name === name)?.positions ?? []);
			} else {
				soloRestoreChannels();
			}
		},
		getSolo: () => channelSolo,
		setSolo: index => {
			channelSolo = index;
			if (index !== null) {
				compositeSelectorChannel = index;
				channelGroupSolo = null;
				// Soloing a channel that is switched off turns it on.
				soloShowChannels(channelPlanes.flatMap((plane, position) => plane.index === index ? [position] : []));
			} else {
				soloRestoreChannels();
			}
			// The selector follows Solo.
			updateTiffPageOverlay();
		},
		onChange: () => { scheduleCompositeRender(); scheduleSaveState(); },
		getBackend: () => (channelGpuCompositor.isReady() ? channelBackend : 'cpu'),
		getStatus: () => channelStatus,
		getCurrentChannel: () => currentChannelIndex(),
		selectChannel: index => selectChannelThroughSelector(index),
	});

	/**
	 * Merge previously chosen appearance with freshly measured ranges.
	 *
	 * Ranges come from the new data — a different exposure needs a different
	 * black point — while tint, visibility and opacity are decisions about how
	 * the user wants to look at the series and should persist across it. Fresh
	 * tints come from `tiffVisualizer.channels.*`, then the file, then the palette.
	 */
	function adoptChannelSettings(
		planes: ChannelPlane[],
		previous: ChannelSettings[],
		options: { colors?: (string | undefined)[] },
	): ChannelSettings[] {
		const fresh = defaultChannelSettings(planes, {
			colors: suggestedChannelColors(planes, options.colors, settingsManager.settings.channelDefaults),
		});
		if (previous.length !== planes.length) { return fresh; }
		return fresh.map((setting, index) => ({
			...setting,
			visible: previous[index].visible,
			color: previous[index].color,
			opacity: previous[index].opacity,
			colormap: previous[index].colormap,
		}));
	}

	/** Identifies the plane set an OME stack's channel planes were built from. */
	function omePlaneKey(): string | null {
		const ome = tiffProcessor.omeMetadata;
		if (!ome || !(ome.sizeC > 1)) { return null; }
		const at = omeIfdToCoordinates(ome, tiffProcessor.pageIndex);
		return `${settingsManager.settings.resourceUri || settingsManager.settings.src || ''}|z${at.z}|t${at.t}`;
	}

	/** True when each channel is its own page, chosen with the selector's C control. */
	function channelsAreSeparatePages(): boolean {
		const ome = tiffProcessor.omeMetadata;
		return currentLoadFormat === 'TIFF' && !!ome && ome.sizeC > 1 && (getMeasurementSource()?.channels || 1) === 1;
	}

	/**
	 * A solo is starting: first undo what the previous solo switched on, then
	 * switch on whichever of these channels are off, remembering them.
	 */
	function soloShowChannels(positions: readonly number[]): void {
		soloRestoreChannels();
		const off = positions.filter(position => channelSettings[position] && !channelSettings[position].visible);
		if (!off.length) { return; }
		channelSettings = channelSettings.map((setting, position) => off.includes(position) ? { ...setting, visible: true } : setting);
		soloShownPositions = off;
	}

	/** The solo ended: switch off the channels it had switched on. */
	function soloRestoreChannels(): void {
		if (!soloShownPositions.length) { return; }
		const shown = soloShownPositions;
		soloShownPositions = [];
		channelSettings = channelSettings.map((setting, position) => shown.includes(position) ? { ...setting, visible: false } : setting);
	}

	/**
	 * What the composite is restricted to: the soloed group's channels, the
	 * single soloed channel, or null for no restriction. A group that matches no
	 * channel is ignored rather than blanking the image.
	 */
	function activeSolo(): number | number[] | null {
		if (channelGroupSolo !== null) {
			const group = resolveChannelGroups(channelGroups, channelPlanes).find(entry => entry.name === channelGroupSolo);
			if (group && group.positions.length) { return group.positions.map(position => channelPlanes[position].index); }
		}
		return channelSolo;
	}

	function soloAllows(planeIndex: number): boolean {
		const solo = activeSolo();
		return solo === null || (typeof solo === 'number' ? solo === planeIndex : solo.includes(planeIndex));
	}

	/**
	 * The channel the selector overlay is showing, for the panel to highlight.
	 * Null when the image has no selector for channels (the panel then behaves
	 * as it always did).
	 */
	function currentChannelIndex(): number | null {
		if (currentLoadFormat !== 'TIFF') { return null; }
		const ome = tiffProcessor.omeMetadata;
		if (ome && channelsAreSeparatePages()) { return omeIfdToCoordinates(ome, tiffProcessor.pageIndex).c; }
		if (tiffProcessor.selectableBandCount > 1 && !tiffProcessor.displayRgbBands) { return tiffProcessor.displayBand; }
		return null;
	}

	/** Show one channel by driving the selector, so the two controls cannot disagree. */
	function selectChannelThroughSelector(index: number): boolean {
		if (currentChannelIndex() === null) { return false; }
		if (channelsAreSeparatePages()) { void navigateOmeAxis('C', index); } else { void selectTiffBand(index); }
		return true;
	}

	/**
	 * The selector's channel control while the composite is on: solo that
	 * channel instead of loading its page. The composite stays on.
	 */
	function soloFromSelector(index: number): void {
		channelSolo = index;
		channelGroupSolo = null;
		soloShowChannels(channelPlanes.flatMap((plane, position) => plane.index === index ? [position] : []));
		compositeSelectorChannel = index;
		scheduleCompositeRender();
		scheduleSaveState();
		updateTiffPageOverlay();
	}

	/** True when the selector's channel control should solo rather than load a page. */
	function selectorSolosChannels(): boolean {
		return compositeEnabled && channelPlanes.length >= 2;
	}

	/** Keep the Channels panel in step with the selector overlay. */
	function syncChannelPanel(): void {
		if (channelsPanel.isVisible()) { channelsPanel.render(); }
	}

	/** React to an edit of `tiffVisualizer.channels.groups` without reopening the image. */
	function applyChannelGroups(raw: unknown): void {
		const key = JSON.stringify(raw ?? null);
		if (key === channelGroupsKey) { return; }
		channelGroupsKey = key;
		channelGroups = parseChannelGroups(raw);
		if (channelGroupSolo !== null && !channelGroups.some(group => group.name === channelGroupSolo)) { channelGroupSolo = null; }
		soloShownPositions = [];
		if (compositeEnabled) { scheduleCompositeRender(); }
		channelsPanel.render();
	}

	/**
	 * True when the current image has several channels, judged from metadata.
	 *
	 * Deliberately does not need the planes: OME and ImageJ stacks store each
	 * channel as its own page, and those planes are fetched and decoded in the
	 * background only once someone asks for them. Gating the menu entry on the
	 * planes meant the first right-click started the load and showed no entry,
	 * and the entry only appeared on a later click once decoding had finished.
	 */
	function hasCompositableChannels(): boolean {
		if (channelPlanes.length >= 2) { return true; }
		const ome = tiffProcessor.rawTiffData?.ome || null;
		const source = getMeasurementSource();
		if (!source) { return false; }
		const sourceChannels = source.channels || 1;
		if ((ome?.sizeC || 0) > 1 && sourceChannels === 1) { return true; }
		return sourceChannels >= 2 && !!source.data;
	}

	// --- measurement subsystem ----------------------------------------------
	// Everything below is inert until the Measure panel is opened: the overlay
	// canvas is hidden and takes no pointer events, and no scalar plane is
	// built. Someone who only wants to look at a TIFF pays nothing for it.

	const roiManager = new RoiManager();
	let measureCalibration: Calibration = { ...UNCALIBRATED };
	let measurementSourceCache: { generation: number; source: MeasurementSource | null } | null = null;
	let scalarPlaneCache: { generation: number; plane: Float32Array | null } | null = null;

	/**
	 * The raw image a measurement runs against.
	 *
	 * Deliberately reads the same per-processor raw buffers the histogram uses,
	 * rather than the displayed canvas: measurements must not change when the
	 * user drags gamma or brightness. Interleaved `data` is preferred over
	 * planar rasters where a processor offers both, since every consumer here
	 * indexes by pixel.
	 */
	function buildMeasurementSource(): MeasurementSource | null {
		return imageMeasurement(getActiveImage(), settingsManager.settings.resourceUri || settingsManager.settings.src || undefined);
	}

	function getMeasurementSource(): MeasurementSource | null {
		if (measurementSourceCache?.generation === navigation.generation) { return measurementSourceCache.source; }
		const source = buildMeasurementSource();
		measurementSourceCache = { generation: navigation.generation, source };
		return source;
	}

	/**
	 * Single-channel view of the image, built lazily and cached per load.
	 *
	 * The wand, livewire, and every threshold method need one scalar per pixel.
	 * Materialising it once is far cheaper than the alternative of recomputing a
	 * luma per probe, and it is only ever built after the panel is opened.
	 */
	function getScalarPlane(): Float32Array | null {
		if (scalarPlaneCache?.generation === navigation.generation) { return scalarPlaneCache.plane; }
		const source = getMeasurementSource();
		const plane = source ? toScalarPlane(source) : null;
		scalarPlaneCache = { generation: navigation.generation, plane };
		return plane;
	}

	const roiOverlay = new RoiOverlay(roiManager, {
		getImageElement: () => imageElement,
		getSource: () => getMeasurementSource(),
		getScalarPlane: () => getScalarPlane(),
		getCalibration: () => measureCalibration,
		onCalibrationLine: distance => measurePanel.onCalibrationLine(distance),
		onRoiEdited: () => {
			measurePanel.scheduleMeasure();
			// Debounced, so dragging a vertex does not write state per mouse move.
			scheduleSaveState();
		},
		onHint: text => measurePanel.setHint(text),
		onScaleBarPositionChanged: () => scheduleSaveState(),
	});

	// Adopt the session's scale-bar preference immediately.
	//
	// A NEW webview receives its settings embedded in the bootstrap HTML, not
	// as an `updateSettings` message, so handling only the message left every
	// freshly opened image drawing the bar again even though the session flag
	// said otherwise. The overlay defaults to visible, so this only ever has to
	// turn it off — but it is written as a plain assignment so the two paths
	// (bootstrap here, message later) cannot drift apart.
	if (typeof settingsManager.settings.showScaleBar === 'boolean') {
		roiOverlay.setShowScaleBar(settingsManager.settings.showScaleBar);
	}

	function invalidatePyramidViewport(): void {
		_pyramidViewGeneration++;
		_pyramidViewportAbortController?.abort();
		_pyramidViewportAbortController = null;
		// The next viewport may start without waiting for obsolete decode jobs.
		_pyramidTileLoadPending = false;
		_pyramidTileLoadQueued = false;
	}

	// A scroll moves the image under the patch; the patch is placed in document
	// coordinates so it travels with it, but a pan can also expose ground the
	// patch does not cover, which needs a new rectangle.
	window.addEventListener('resize', () => {
		if (container.classList.contains('web-app') && zoomController.scale === 'fit') { zoomController.updateScale('fit'); }
		invalidatePyramidViewport(); scheduleLevelRefinement();
	});
	window.addEventListener('scroll', () => {
		invalidatePyramidViewport();
		mouseHandler.refreshAtPointer();
		scheduleLevelRefinement();
	}, { passive: true });

	zoomController.onScaleChanged = () => {
		invalidatePyramidViewport();
		roiOverlay.scheduleRedraw();
		mouseHandler.refreshAtPointer();
		// Zooming past a pyramid level's resolution is exactly when the finer
		// level becomes worth its decode; nothing else in the session changes
		// the answer, so this is the only trigger.
		scheduleLevelRefinement();
	};

	const measurePanel = new MeasurePanel({
		manager: roiManager,
		overlay: roiOverlay,
		getSource: () => getMeasurementSource(),
		getScalarPlane: () => getScalarPlane(),
		getCalibration: () => measureCalibration,
		setCalibration: calibration => {
			measureCalibration = calibration;
			roiOverlay.scheduleRedraw();
			scheduleSaveState();
		},
		saveTextFile: (fileName, content, options) => vscode.postMessage({
			type: 'measureSaveText', fileName, content, open: options?.open !== false,
		}),
		saveBinaryFile: (fileName, bytes) => vscode.postMessage({
			type: 'measureSaveBinary', fileName, bytes: Array.from(bytes),
		}),
		requestImport: kind => vscode.postMessage({ type: 'measureRequestImport', kind }),
		saveSidecar: json => vscode.postMessage({ type: 'measureSaveSidecar', content: json }),
	});

	/**
	 * Adopt whatever spatial calibration the file already declares.
	 *
	 * Auto-populating is the main advantage over asking, as ImageJ does: a
	 * forgotten or mistyped scale is the most common way a measurement ends up
	 * silently wrong. A calibration the user set by hand is never overwritten.
	 */
	function refreshMeasureCalibration(): void {
		if (measureCalibration.origin === 'manual') { return; }
		// `_lastRaw` is the gate rather than the metadata itself: a processor keeps
		// the metadata of the file it decoded last, so without it a DICOM viewed
		// earlier in the collection would go on calibrating a later TIFF in mm.
		const dicom = dicomProcessor._lastRaw ? calibrationFromDicom(dicomProcessor.metadata) : null;
		const czi = cziProcessor._lastRaw ? calibrationFromCzi(cziProcessor.metadata) : null;
		const ome = tiffProcessor.rawTiffData?.ome || null;
		const fromTags = calibrationFromTagList(tiffProcessor._lastAllTags as TagEntry[] | null);
		measureCalibration = dicom || czi
			|| (ome ? autoCalibration(ome, null) : (fromTags || { ...UNCALIBRATED }));
		roiOverlay.scheduleRedraw();
	}

	/**
	 * ROIs for `vscode.setState`, which only accepts structured-cloneable data.
	 * Mask ROIs carry a Uint8Array, so they go through the same run-length
	 * encoding the sidecar uses rather than being dropped.
	 */
	function serializeRoisForState(rois: ReturnType<RoiManager['list']>): unknown[] {
		return rois.map(roi => serializeRoi(roi));
	}

	function deserializeRoisFromState(stored: unknown[]): ReturnType<RoiManager['list']> {
		const out: ReturnType<RoiManager['list']> = [];
		for (const entry of stored) {
			const roi = deserializeRoi(entry as never);
			if (roi) { out.push(roi); }
		}
		return out;
	}

	/**
	 * Apply `tiffVisualizer.channels.autoComposite` to the image just shown.
	 *
	 * Only channels described by OME or ImageJ metadata count: a fluorescence
	 * stack is meant to be viewed as a composite, an RGB photo is not. Runs after
	 * the frame is committed, so the first channel still appears immediately and
	 * the composite fills in once the sibling planes have loaded.
	 */
	function applyAutoComposite(): void {
		if (compositeChosenByUser) { return; }
		const metadataChannels = hasMetadataChannels();
		const wanted = settingsManager.settings.channelDefaults?.autoComposite === true && metadataChannels;
		if (wanted && !compositeEnabled) {
			compositeEnabled = true;
			compositeAuto = true;
		} else if (!wanted && compositeAuto) {
			compositeEnabled = false;
			compositeAuto = false;
		} else {
			return;
		}
		channelsPanel.render();
		scheduleSaveState();
	}

	/** True when OME or ImageJ metadata describes several channels, as opposed to an ordinary RGB image. */
	function hasMetadataChannels(): boolean {
		return (tiffProcessor.rawTiffData?.ome?.sizeC || 0) > 1 && hasCompositableChannels();
	}

	/**
	 * Apply `tiffVisualizer.channels.autoOpenPanel`: open the Channels panel once
	 * per file for images whose channels come from metadata. Runs right after the
	 * first frame is committed, which for OME and ImageJ stacks is before the
	 * other channels' pages have decoded, so the panel shows the loading progress
	 * instead of appearing at the end.
	 */
	function applyAutoOpenPanel(): void {
		if (settingsManager.settings.channelDefaults?.autoOpenPanel !== true || !hasMetadataChannels()) { return; }
		const resource = settingsManager.settings.resourceUri || settingsManager.settings.src || '';
		if (autoPanelResource === resource) { return; }
		autoPanelResource = resource;
		channelsPanel.show();
		scheduleSaveState();
	}

	/** Drop measurement caches when the displayed image changes. */
	function invalidateMeasurementForNewImage(): void {
		measurementSourceCache = null;
		scalarPlaneCache = null;
		refreshMeasureCalibration();
		measurePanel.onImageChanged();
		// Channel planes belong to the image, but deinterleaving a 5120² RGB
		// raster creates three additional full-size Float32Arrays (~300 MiB).
		// Build them only for a feature that consumes them; opening the Channels
		// panel also calls rebuildChannelPlanes through its getPlanes callback.
		channelGeneration = -1;
		if (!(channelPlanes.length >= 2 && channelPlanesKey !== null && channelPlanesKey === omePlaneKey())) {
			channelPlanes = [];
			channelPlanesKey = null;
			channelStatus = null;
		}
		// Solo and the selector position belong to the file; stepping Z or T
		// within it keeps them.
		const soloResource = settingsManager.settings.resourceUri || settingsManager.settings.src || '';
		if (soloResource !== channelSoloResource) {
			channelSoloResource = soloResource;
			channelSolo = null;
			channelGroupSolo = null;
			soloShownPositions = [];
			compositeSelectorChannel = null;
		}
		applyAutoComposite();
		applyAutoOpenPanel();
		if (compositeEnabled || channelsPanel.isVisible()) { rebuildChannelPlanes(); }
		if (compositeEnabled) { scheduleCompositeRender(); }
		// Ask whether this image has ROIs saved beside it. Cheap, silent when
		// there are none, and it is what makes the sidecar feel like part of the
		// image rather than a file you have to remember to open.
		vscode.postMessage({ type: 'measureCheckSidecar' });
	}

	const colormapConverter = new ColormapConverter();

	function disposeWebglRenderers() {
		layerGpuCompositor.dispose();
		layerWebGpuCompositor.dispose();
		_normalRenderBackend = 'cpu';
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
	// Multiple render qualities may represent the same layer state. Keep that
	// state revision separate from request ordering so a completed 768 px
	// interaction preview is not discarded merely because its native settled
	// render has already been queued.
	let _layerStateRevision = 0;
	const _layerRevisionStartedAt = new Map<number, number>();
	const _layerPreviewDisplayedAt = new Map<number, number>();
	const _layerPreviewRequested = new Set<number>();
	const _layerNativeRequested = new Set<number>();
	const _layerNativeDisplayed = new Set<number>();
	let _nativeAfterPreviewRevision: number | null = null;
	type LayerPerformanceChange = {
		id: number;
		latestRevision: number;
		backend: string;
		settled: boolean;
		emitted: boolean;
		previewCount: number;
		previewWidth: number;
		previewHeight: number;
		previewLastMs: number;
		previewMaxMs: number;
		previewSkipped?: string;
		nativeWidth: number;
		nativeHeight: number;
		nativeMs: number;
		nativeRevision: number;
		nativeNote?: string;
	};
	let _nextLayerPerformanceChangeId = 1;
	let _activeLayerGestureChangeId: number | null = null;
	const _layerPerformanceChanges = new Map<number, LayerPerformanceChange>();
	const _layerRevisionPerformanceChange = new Map<number, number>();
	let _layerCompositorBackend: LayerCompositorBackend = 'javascript';
	let _layerCompositorSelection: LayerCompositorBackendSelection = 'auto';
	let _automaticBackendGeneration = 0;
	type PreviewBackgroundRgb = { red: number; green: number; blue: number };
	let _themeBackgroundRgb: PreviewBackgroundRgb = { red: 30, green: 30, blue: 30 };
	// A manual adjustment keeps the tint of the theme in which it was made. The
	// live theme is followed again after a double-click reset.
	let _layerBackgroundTint: PreviewBackgroundRgb | null = null;
	const layerManager = new LayerManager();
	const layersPanel = new LayersPanel(layerManager, {
		onChange: (options: { interactive?: boolean; settled?: boolean } = {}) => {
			// Settling a continuous control does not change its value again. Keep
			// the interactive revision so its queued/in-flight preview remains
			// eligible to be displayed before the native render.
			const stateRevision = options.settled ? _layerStateRevision : ++_layerStateRevision;
			if (options.settled) {
				settleLayerPerformanceChange(stateRevision);
			} else {
				registerLayerPerformanceRevision(stateRevision, options.interactive === true);
			}
			const usePreview = shouldUseLayerInteractionPreview(
				layerManager.canvasWidth,
				layerManager.canvasHeight,
			);
			if (options.settled) {
				if (usePreview) {
					scheduleNativeAfterPreview(stateRevision);
				}
				// Small documents already rendered the final input event at native
				// resolution, so settling must not issue a duplicate render.
			} else if (options.interactive) {
				if (usePreview) {
					scheduleRecomposite(0, true, stateRevision);
					scheduleRecomposite(180, false, stateRevision);
				} else {
					scheduleRecomposite(0, false, stateRevision);
				}
			} else {
				// Structural/visibility edits need immediate feedback too. Large
				// documents show a bounded interaction preview first, then settle
				// to the native-resolution document render.
				schedulePreviewThenNative(stateRevision, 60);
			}
			scheduleSaveState();
		},
		onBackgroundChange: (brightness: number | null) => { setLayerBackgroundBrightness(brightness); scheduleSaveState(); },
		onPersist: () => { scheduleSaveState(); },
		onAddLayer: () => { vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.addLayer' }); },
		onExport: () => { vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.exportLayers' }); },
		onCompositorBackendChange: (selection: LayerCompositorBackendSelection) => {
			_layerCompositorSelection = selection;
			// Backend selection is also an explicit benchmark boundary. Release
			// every accelerator first so source pixels and composition surfaces
			// cannot remain uploaded in both WebGPU and WebGL (or retained by the
			// CPU worker) after a switch.
			coldResetLayerCompositorBackends();
			if (selection === 'auto') {
				void selectAutomaticLayerBackend(true, true);
			} else {
				applyLayerCompositorBackend(selection, true, true);
			}
		},
		onVisibilityChange: (visible: boolean) => {
			layerManager.active = visible;
			if (!visible) { _layerStateRevision++; }
			// Tell the extension so it can track layer mode (and block collection ops).
			vscode.postMessage({ type: 'layerModeChanged', active: visible });
			if (visible) {
				// Backend probing can initialize WebGPU or a second copy of the
				// multi-megabyte WASM module. Keep that work out of ordinary image
				// startup and perform it only when Layers is actually opened.
				if (_layerCompositorSelection === 'auto') {
					void selectAutomaticLayerBackend(true);
				}
				if (!installLayeredDocumentLayers()) { syncBaseLayer(); }
				const stateRevision = ++_layerStateRevision;
				schedulePreviewThenNative(stateRevision, 60);
			} else {
				// Restore the normal single-image render.
				updateImageWithNewSettings();
			}
			updateLayeredPreviewOverlay();
			scheduleSaveState();
		},
	}, { closable: settingsManager.settings.surfaceMode !== 'layers' });
	layeredPreviewProcessor.onLayersReady = () => {
		if (currentLoadFormat !== 'Layered Document') { return; }
		updateLayeredPreviewOverlay();
		// A restored source-document stack must be rebuilt only after its real
		// raster/group/filter assets exist. Restoring against the earlier
		// integrated-preview placeholder would briefly create one fake layer and
		// would also lose the saved per-node edits.
		if (_pendingLayerRestore) {
			_layersRestoreDone = false;
			maybeRestoreLayers();
			return;
		}
		// Dedicated Layers windows remain on the integrated preview until the
		// deferred graph is ready. Showing the panel now lets its visibility
		// callback install the complete graph directly, without a placeholder.
		if (settingsManager.settings.surfaceMode === 'layers' && !_layerSurfaceShown) {
			_layerSurfaceShown = true;
			layersPanel.show();
			vscode.postMessage({ type: 'requestInitialLayers' });
			return;
		}
		if (!layerManager.active && !layersPanel.isVisible() && settingsManager.settings.surfaceMode !== 'layers') {
			return;
		}
		// Replace the temporary integrated-preview base with the editable PSD
		// graph as soon as the background layer-only decode has completed.
		_expandedLayerDocumentUri = undefined;
		if (installLayeredDocumentLayers()) {
			const stateRevision = ++_layerStateRevision;
			schedulePreviewThenNative(stateRevision, 60);
			scheduleSaveState();
		}
	};
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
	// Pixel inspector reports demosaiced samples while debayering is active.
	mouseHandler.debayerValueProvider = (x: number, y: number) => {
		const debayer = settingsManager.settings.debayer;
		if (!debayer?.enabled || debayer.view === 'mosaic') { return null; }
		// The canvas is sized to the image, so its width is the row stride the
		// cached demosaic buffer was built with.
		const width = canvas?.width;
		if (!width || x < 0 || y < 0) { return null; }
		return getDebayeredPixel(x, y, width);
	};
	/** URI of the image currently used as the base layer. */
	let _layerBaseUri: string | undefined;
	/** Stable identity of that base layer even when the user reorders the stack. */
	let _layerBaseId: string | undefined;
	let _expandedLayerDocumentUri: string | undefined;

	// Both delegate to modules/format-registry.ts, the single place that maps a
	// file extension to a decoder.
	const isTiffExtension = (lower: string): boolean => isTiffPath(lower);
	const remoteTiffUrlFor = (resourceUri: string, formatHint?: string): string | undefined => {
		try {
			const parsed = new URL(resourceUri);
			const hintedTiff = resolveFormat('', formatHint)?.kind === 'tiff';
			return /^(?:http|https):$/.test(parsed.protocol)
				&& (hintedTiff || isTiffExtension(parsed.pathname.toLowerCase()))
				? resourceUri : undefined;
		} catch { return undefined; }
	};
	const layeredFormatForPath = (lower: string): LayeredDocumentFormat | null =>
		(layeredFormatOf(lower) as LayeredDocumentFormat | null);

	// Application state
	let hasLoadedImage = false;
	let canvas: HTMLCanvasElement | null = null;
	/**
	 * Overlay chrome that must survive an image swap.
	 *
	 * The load paths below clear the container of every `img`/`canvas` so a new
	 * image starts on a clean background. Floating panels are `div`s and are
	 * unaffected, but overlays that *are* canvases — the histogram, and the
	 * measurement overlay — live on the same container and would be deleted with
	 * the old image, silently and only on the second image opened.
	 */
	/**
	 * The display limits, named because they are sent to the decode worker as
	 * well: it decides which pyramid level to decode, and has no canvas of its
	 * own to ask. `canvasCanHold` still probes for the cases past these, which
	 * differ between platforms and hosts.
	 */
	const CANVAS_SAFE_AXIS = 16384;
	const CANVAS_SAFE_AREA = 16384 * 16384;
	/** An ImageData's backing store is one typed array: 2^31-1 bytes at most. */
	const IMAGE_DATA_MAX_BYTES = 2 ** 31 - 1;
	/**
	 * The hard ceiling on what can be DRAWN, shared by the size check and the
	 * renderer so the two cannot disagree. Chromium refuses to back a 2D canvas
	 * larger than 2^28 pixels, and beyond that the canvas silently becomes
	 * unusable while the surrounding allocation takes the webview process with
	 * it.
	 */
	const MAX_CANVAS_AREA = 268_435_456;
	function isOverlayChrome(element: Element): boolean {
		return !!element.closest('.histogram-overlay')
			|| element.classList.contains('measure-overlay')
			|| element.classList.contains('detail-patch');
	}

	let imageElement: HTMLElement | null = null;
	/** Stable full-resolution scene used only for oversized pyramidal TIFFs. */
	let _pyramidScene: PyramidScene | null = null;
	/** Invalidates convergence decisions when a zoom/pan changes the viewport. */
	let _pyramidViewGeneration = 0;
	/** Cancels remote block requests as soon as a different viewport supersedes them. */
	let _pyramidViewportAbortController: AbortController | null = null;
	/** Detail work in flight, separate from whole-image/page loading. */
	let _tiffViewportLoadCount = 0;
	/** Level-space bounds of the detail currently being requested/displayed. */
	let _pyramidPatchRegion: { level: number, rect: Rect } | null = null;
	let primaryImageData: ImageData | null = null;
	let peerImageData: ImageData | null = null;
	let peerRawTiffData: any = null;      // Raw TIFF data for peer image (kept separate from primary)
	let peerLastStatistics: any = null;   // Statistics for peer TIFF image
	let peerRawExrData: any = null;       // Raw EXR data for peer image
	let peerExrStats: any = null;         // Cached stats for peer EXR image
	let peerImageUris: string[] = []; // Track peer URIs for comparison state
	let _pendingZoomState: { scale: number | string, [key: string]: any } | null = null; // Zoom state to restore after next image load
	let _pendingZoomStateExplicit = false;
	/** Pyramid level switches rescale the pending zoom; see navigateTiffToPage. */
	let _pendingLevelScaleMultiplier: number | null = null;
	let _tiffCanvasReadyPromise: Promise<void>;
	let _tiffCanvasReadyResolve: (() => void) | null = null;
	let isShowingPeer = false;
	let initialLoadStartTime = 0;
	let extensionLoadStartTime = 0; // Time when extension started loading (from settings)
	let visibleTotalMs: number | null = nativeBootstrap?.visibleTotalMs ?? null;
	let visiblePaintPromise: Promise<number> | null = visibleTotalMs === null ? null : Promise.resolve(visibleTotalMs);
	let currentLoadFormat = '';
	let currentLoadDecodeInfo: { engine: string, durationMs: number } | null = null;
	let _deferredHistogramTimer: number | null = null;
	let _layerHistogramTimer: number | null = null;
	let _layerHistogramCanvas: HTMLCanvasElement | null = null;
	let _normalRenderBackend: 'webgl2' | 'cpu' = 'cpu';
	let _outgoingImageElement: HTMLElement | null = null;
	let _imageTransitionActive = false;
	let _collectionSwitchLoading = false;

	function formatDecodeInfo() {
		return currentLoadDecodeInfo
			? `, decode: ${currentLoadDecodeInfo.engine} ${currentLoadDecodeInfo.durationMs.toFixed(2)}ms`
			: '';
	}

	// Top-level PerfTrace marks only. The sub-phase details share the same
	// `fetch-`/`decode-` prefixes, so these patterns anchor on the exact mark
	// names to avoid double counting.
	const FETCH_MARK = /^fetch(\(.*\))?$/;
	const DECODE_MARK = /^decode-(worker|local)\(.*\)$|^decode-(wasm|geotiff)(-worker|-local|-strip-pool)?$/;
	// Statistics and the non-finite sweep, both full passes over the samples.
	const STATS_MARK = /^(stats|finite-scan|histogram-stats)$/;
	// Rebuilding the interleaved buffer, or splitting it into planes.
	const SHUFFLE_MARK = /^(interleave|deinterleave|raster-copy)$/;
	// Getting the pixels onto the canvas, GPU or CPU.
	const RENDER_MARK = /^(render|render-webgl|canvas-upload|webgl-context-setup|webgl-texture-upload)$/;

	/**
	 * Compose the per-load [Perf] summary: read time, decode time, which decoder
	 * ran, and the end-to-end total. Reads PerfTrace totals, which are recorded
	 * for every load regardless of DETAILED_PERF_TRACING.
	 */
	function formatLoadPerf(label: string, webviewMs: string, totalMs: string | number) {
		const fetchMs = PerfTrace.totalMatching(FETCH_MARK);
		const decodeMs = PerfTrace.totalMatching(DECODE_MARK);
		const mark = PerfTrace.firstMatching(DECODE_MARK);
		// Prefer the decoder's own self-reported engine string; fall back to the
		// mark name, which encodes worker-vs-main-thread and the decoder family.
		let engine = currentLoadDecodeInfo?.engine || '';
		if (!engine && mark) {
			const inner = mark.match(/^decode-(?:worker|local)\((.*)\)$/);
			if (inner) { engine = `${inner[1]} (${mark.startsWith('decode-worker') ? 'worker' : 'main'})`; }
			else if (mark === 'decode-wasm-strip-pool') { engine = 'wasm (strip pool)'; }
			else if (mark.startsWith('decode-wasm')) { engine = `wasm (${mark.endsWith('-local') ? 'main' : 'worker'})`; }
			else if (mark.startsWith('decode-geotiff')) { engine = `geotiff.js (${mark.endsWith('-worker') ? 'worker' : 'main'})`; }
		}
		const statsMs = PerfTrace.totalMatching(STATS_MARK);
		const shuffleMs = PerfTrace.totalMatching(SHUFFLE_MARK);
		const renderMs = PerfTrace.totalMatching(RENDER_MARK);
		// Whatever the named phases did not account for: settings round-trip,
		// layer sync, DOM finalize, and any un-instrumented work in between.
		const otherMs = Math.max(0, Number(webviewMs) - fetchMs - decodeMs - statsMs - shuffleMs - renderMs);

		const parts = [];
		if (fetchMs > 0) { parts.push(`read ${fetchMs.toFixed(0)}ms`); }
		if (decodeMs > 0) { parts.push(`decode ${decodeMs.toFixed(0)}ms${engine ? ` [${engine}]` : ''}`); }
		if (statsMs > 0) { parts.push(`stats ${statsMs.toFixed(0)}ms`); }
		if (shuffleMs > 0) { parts.push(`reshape ${shuffleMs.toFixed(0)}ms`); }
		if (renderMs > 0) { parts.push(`render ${renderMs.toFixed(0)}ms`); }
		if (otherMs >= 1) { parts.push(`other ${otherMs.toFixed(0)}ms`); }
		parts.push(`webview ${webviewMs}ms`);
		parts.push(`total ${totalMs}ms`);
		return `[Perf] ${label}: ${parts.join(' | ')}`;
	}

	/** Record when a newly committed image has had one browser paint opportunity. */
	function scheduleVisiblePaintMeasurement(): void {
		if (visibleTotalMs !== null || visiblePaintPromise) { return; }
		visiblePaintPromise = new Promise(resolve => {
			let finished = false;
			const markVisible = () => {
				if (finished) { return; }
				finished = true;
				visibleTotalMs = extensionLoadStartTime
					? Math.max(0, Date.now() - extensionLoadStartTime)
					: Math.max(0, performance.now() - initialLoadStartTime);
				resolve(visibleTotalMs);
			};
			requestAnimationFrame(() => requestAnimationFrame(markVisible));
			// Hidden webviews may not receive animation frames. Preserve logging
			// without claiming a value earlier than the DOM commit.
			setTimeout(markVisible, 100);
		});
	}

	/**
	 * Run bookkeeping only after the committed frame had a paint opportunity.
	 * Promise continuations run as microtasks inside the animation-frame callback
	 * and can still delay that frame, so cross a task boundary as well.
	 */
	function scheduleAfterVisiblePaint(callback: () => void): void {
		const generation = navigation.generation;
		const run = () => window.setTimeout(() => {
			if (generation === navigation.generation) { callback(); }
		}, 0);
		if (visiblePaintPromise) {
			void visiblePaintPromise.then(run);
		} else {
			requestAnimationFrame(() => requestAnimationFrame(run));
		}
	}

	/**
	 * Describe WHAT ended up on screen, as a companion to the [Perf] timing
	 * line. A multi-page or pyramidal file (a COG carries its overviews as
	 * extra IFDs) shows only one of its images, and until this line existed
	 * nothing in the log said which one, or at what size — a blank-looking
	 * result and a correct one logged identically.
	 *
	 * Returns null for the ordinary case where it would only restate the
	 * `📂 Opened` line: one image, drawn at the size that line already
	 * reported. Only a page/level selection, or a canvas whose size differs
	 * from the file's declared size, says anything new.
	 */
	function formatVisibleSummary(label: string): string | null {
		const parts: string[] = [];
		const width = canvas?.width || (imageElement as any)?.naturalWidth || (imageElement as any)?.width;
		const height = canvas?.height || (imageElement as any)?.naturalHeight || (imageElement as any)?.height;
		if (width && height) { parts.push(`${width}x${height}`); }

		// Only trust format info this load actually posted; on a collection or
		// page switch the previous image's info is still in the variable until
		// the new one is sent.
		const info = lastFormatInfoPost?.generation === navigation.generation ? currentFormatInfo : null;
		const samples = Number(info?.samplesPerPixel ?? 0);
		if (samples > 0) { parts.push(`${samples} sample${samples === 1 ? '' : 's'}`); }
		const bits = Number(info?.bitsPerSample ?? 0);
		if (bits > 0) {
			// SampleFormat: 1 uint, 2 int, 3 float. Anything else is left to the
			// bit depth alone rather than guessed at.
			const kind = info?.sampleFormat === 3 ? 'float' : info?.sampleFormat === 2 ? 'int' : 'uint';
			parts.push(`${kind}${bits}`);
		}

		// TIFF is the only format here whose extra images are addressed as
		// pages; the selector shows the same numbering. A pyramid's extra
		// images are levels of one page, so say which level instead — "page 2
		// of 4" on a COG describes something the file does not contain.
		const directory = tiffProcessor.pageDirectory;
		const before = parts.length;
		if (isPyramidal(directory)) {
			const page = pageOwningIfd(directory, tiffProcessor.pageIndex);
			const levels = levelsForPage(directory, page);
			const position = levels.findIndex(level => level.index === tiffProcessor.pageIndex);
			const pages = imagePages(directory);
			if (pages.length > 1) {
				parts.push(`page ${pages.findIndex(entry => entry.index === page) + 1}/${pages.length}`);
			}
			parts.push(`level ${position + 1}/${levels.length} (${levelLabel(levels[position] ?? levels[0])})`);
		} else if (tiffProcessor.pageCount > 1) {
			parts.push(`page ${tiffProcessor.pageIndex + 1}/${tiffProcessor.pageCount}`);
		}
		const selectedOneOfMany = parts.length > before;

		// The declared size and the drawn size differ only when a level other
		// than the full-resolution one was chosen, which is worth saying; when
		// they agree, every remaining part is already in the `📂 Opened` line.
		const declaredSize = Number(info?.width) === width && Number(info?.height) === height;
		if (!selectedOneOfMany && declaredSize) { return null; }

		const source = String(settingsManager.settings.resourceUri || settingsManager.settings.src || '');
		const name = source ? decodeURIComponent(source.split(/[\\/]/).pop() || '') : '';
		const suffix = name ? ` — ${name}` : '';
		return `[Visible] ${label}: ${parts.join(', ')}${suffix}`;
	}

	function logLoadPerformance(label: string, webviewMs: string, totalMs: string | number): void {
		setTimeout(() => { void layerCompositorWorker.start(); }, 0);
		// The image has loaded: a prefetch of the collection's next one may start.
		startPrefetch();
		// Capture phase totals immediately; PerfTrace may be reused by another
		// navigation before the paint callback runs.
		const summary = formatLoadPerf(label, webviewMs, totalMs);
		const pendingVisible = visiblePaintPromise;
		// The visible summary is captured now for the same reason as the phase
		// totals: by the time a pending paint resolves, a page or collection
		// change may already have moved the state it reads.
		const visibleSummary = formatVisibleSummary(label);
		const logVisible = () => { if (visibleSummary) { logToOutput(visibleSummary); } };
		if (visibleTotalMs !== null) {
			logToOutput(`${summary} | visible ${visibleTotalMs.toFixed(0)}ms`);
			logVisible();
		} else if (pendingVisible) {
			void pendingVisible.then(ms => {
				logToOutput(`${summary} | visible ${ms.toFixed(0)}ms`);
				logVisible();
			});
		} else {
			logToOutput(summary);
			logVisible();
		}
	}

	function resetVisibleTiming(): void {
		visibleTotalMs = null;
		visiblePaintPromise = null;
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
	let decodedColormapSource: { floatData: Float32Array, width: number, height: number, stats?: { min: number; max: number } } | null = null;

	// Copied position state (for paste position feature)
	// Stores position as relative coordinates (0-1) for cross-resolution compatibility
	let copiedPositionState: CopiedPosition | null = null;

	// Restore persisted state if available
	const persistedState = vscode.getState();
	/** Layer stack to restore after the base image loads. */
	let _pendingLayerRestore: { layers: any[], active: boolean, collapsed: boolean, documentUri?: string } | null = null;
	if (persistedState) {
		peerImageUris = persistedState.peerImageUris || [];
		isShowingPeer = persistedState.isShowingPeer || false;
		colormapConversionState = persistedState.colormapConversionState || null;
		tiffProcessor.pageIndex = Math.max(0, Number(persistedState.tiffPageIndex || 0));
		if (persistedState.displayColormap) {
			settingsManager.settings.displayColormap = persistedState.displayColormap;
		}
		if (persistedState.debayer) {
			settingsManager.settings.debayer = persistedState.debayer;
			debayerPanel.setSettings(persistedState.debayer);
			if (persistedState.isDebayerPanelVisible) { debayerPanel.show(); }
		}
		// Restore measurement work before showing the panel, so it opens onto the
		// ROIs it had rather than an empty list.
		if (persistedState.measureCalibration) {
			measureCalibration = persistedState.measureCalibration;
		}
		if (persistedState.scaleBarPosition) {
			roiOverlay.setScaleBarPosition(persistedState.scaleBarPosition);
		}
		if (Array.isArray(persistedState.measureRois) && persistedState.measureRois.length > 0) {
			const restored = deserializeRoisFromState(persistedState.measureRois);
			// No history entry: restoring is not an edit the user should be able
			// to undo into an empty document.
			roiManager.withoutHistory(() => roiManager.replaceAll(restored, { recordHistory: false }));
		}
		if (persistedState.isMeasurePanelVisible) { measurePanel.show(); }
		if (Array.isArray(persistedState.channelSettings)) {
			channelSettings = persistedState.channelSettings;
		}
		if (typeof persistedState.channelSolo === 'number') { channelSolo = persistedState.channelSolo; compositeSelectorChannel = channelSolo; }
		if (typeof persistedState.channelGroupSolo === 'string') { channelGroupSolo = persistedState.channelGroupSolo; }
		compositeEnabled = persistedState.compositeEnabled === true;
		compositeChosenByUser = persistedState.compositeChosenByUser === true;
		autoPanelResource = typeof persistedState.autoPanelResource === 'string' ? persistedState.autoPanelResource : null;
		compositeAuto = persistedState.compositeAuto === true;
		if (persistedState.isChannelsPanelVisible) { channelsPanel.show(); }
		if (Array.isArray(persistedState.layerGroupCollapsed)) {
			layersPanel.collapsedGroups = new Set(persistedState.layerGroupCollapsed.map(String));
		}
		if (Number.isFinite(persistedState.layerBackgroundBrightness)) {
			layersPanel.backgroundBrightness = Math.max(0, Math.min(100, Number(persistedState.layerBackgroundBrightness)));
		}
		const savedBackendSelection = persistedState.layerCompositorBackendSelection;
		if (savedBackendSelection === 'auto' || savedBackendSelection === 'webgpu' || savedBackendSelection === 'gpu' ||
			savedBackendSelection === 'wasm' || savedBackendSelection === 'javascript') {
			_layerCompositorSelection = savedBackendSelection;
			layersPanel.setCompositorBackend(_layerCompositorSelection);
		}
		const savedBackgroundTint = persistedState.layerBackgroundTint;
		if (savedBackgroundTint && [savedBackgroundTint.red, savedBackgroundTint.green, savedBackgroundTint.blue].every(Number.isFinite)) {
			_layerBackgroundTint = {
				red: Math.max(0, Math.min(255, Number(savedBackgroundTint.red))),
				green: Math.max(0, Math.min(255, Number(savedBackgroundTint.green))),
				blue: Math.max(0, Math.min(255, Number(savedBackgroundTint.blue))),
			};
		}
		// Note: Histogram visibility is now managed globally by the extension
		// and restored via restoreHistogramState message when webview becomes active
		const savedLayers = persistedState.layers;
		if (Array.isArray(savedLayers) && (savedLayers.length > 1 || persistedState.layerActive)) {
			_pendingLayerRestore = {
				layers: savedLayers,
				active: !!persistedState.layerActive,
				collapsed: !!persistedState.layerCollapsed,
				documentUri: persistedState.layerDocumentUri,
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
	let layeredPreviewOverlay: HTMLElement | null = null;
	let netcdfSelection: { variableName?: string; indices: Record<string, number> } = persistedState?.netcdfSelection && typeof persistedState.netcdfSelection === 'object'
		? { variableName: persistedState.netcdfSelection.variableName, indices: { ...(persistedState.netcdfSelection.indices || {}) } }
		: { indices: {} };
	/**
	 * Processors whose formats expose a multi-dimensional plane selector.
	 *
	 * CZI, ND2, LIF and SDT all emit the same `selectors` / `selectedIndices`
	 * metadata contract from Rust, so one overlay, one keyboard binding and one
	 * coalescing reload serve all three; only the title differs. Adding a
	 * fourth such format means adding it to this list and nothing else here.
	 */
	let planeNavProcessors: any[] = [];
	/** Whichever of the above produced the image on screen, if any. */
	let planeNavProcessor: any = null;
	const isPlaneNavProcessor = (p: unknown) => planeNavProcessors.includes(p);

	let planeSelection: { indices: Record<string, number> } = persistedState?.planeSelection && typeof persistedState.planeSelection === 'object'
		? { indices: { ...(persistedState.planeSelection.indices || {}) } }
		: { indices: {} };
	/** Plane axes of the loaded image, kept for keyboard navigation. */
	/** Axis signature currently rendered as slider rows, to avoid rebuilding them. */
	let planeRenderedAxes = '';
	let planeLoadInFlight = false;
	let planeLoadPending = false;
	let datasetManifest: DatasetManifest | null = null;
	let datasetSeriesIndex = 0;
	let datasetCoordinates: Record<string, number> = {};
	let datasetLoading = false;
	// One dataset plane request in flight; see requestDatasetNavigation.
	let datasetRequestInFlight = false;
	let pendingDatasetRequest: { seriesIndex: number; coordinates: Record<string, number> } | null = null;
	let datasetRequestTimer: ReturnType<typeof setTimeout> | undefined;
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
			debayer: settingsManager.settings.debayer,
			isDebayerPanelVisible: debayerPanel.isVisible(),
			isMeasurePanelVisible: measurePanel.isVisible(),
			isChannelsPanelVisible: channelsPanel.isVisible(),
			// Channel planes are re-derived from the image; only the user's
			// choices are worth persisting.
			compositeEnabled,
			compositeChosenByUser,
			autoPanelResource,
			compositeAuto,
			channelSettings,
			channelSolo,
			channelGroupSolo,
			// ROIs and their calibration ride along with the webview state.
			// The JSON sidecar is the durable store, but a webview can be
			// reloaded for reasons the user never asked for — moving the tab,
			// splitting the editor, an extension host restart — and losing an
			// afternoon of segmentation to that is not acceptable. Masks are
			// run-length encoded, so even a few hundred objects stay small.
			measureRois: serializeRoisForState(roiManager.list()),
			measureCalibration,
			scaleBarPosition: roiOverlay.getScaleBarPosition(),
			isHistogramVisible: histogramOverlay.getVisibility(),
			netcdfSelection,
			planeSelection,
			// Include zoom so it isn't erased when the app-level state is written
			scale: zoomState.scale,
			offsetX: zoomState.x,
			offsetY: zoomState.y,
			panX: zoomState.panX,
			panY: zoomState.panY,
			// Layer compositing state — metadata only (images are re-decoded from
			// their URIs on reload). Lets a layer view restore itself after the
			// webview is unloaded and reloaded on a tab switch.
			layerDocumentUri: settingsManager.settings.resourceUri,
			layers: layerManager.layers.map(l => ({
				id: l.id,
				resourceUri: l.uri,
				name: l.name,
				offsetX: l.offsetX,
				offsetY: l.offsetY,
				opacity: l.opacity,
				blendMode: l.blendMode,
				visible: l.visible,
				maskCondition: l.maskCondition,
				kind: l.kind,
				adjustment: l.adjustment,
				parentId: l.parentId,
				clipped: l.clipped,
				groupPath: l.groupPath,
				groupIds: l.groupIds,
				sourceNodeId: l.sourceNodeId,
				sourceSupport: l.sourceSupport,
				sourceBlendMode: l.sourceBlendMode,
				sourceNumericType: l.sourceNumericType,
				isBase: l.id === _layerBaseId,
			})),
			layerActive: layerManager.active,
			layerCollapsed: layersPanel.collapsed,
			layerGroupCollapsed: [...layersPanel.collapsedGroups],
			layerCompositorBackend: _layerCompositorBackend,
			layerCompositorBackendSelection: _layerCompositorSelection,
			layerBackgroundBrightness: layersPanel.backgroundBrightness,
			layerBackgroundTint: layersPanel.backgroundBrightness === null ? null : _layerBackgroundTint,
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

	function rgbToHsl({ red, green, blue }: PreviewBackgroundRgb): { hue: number; saturation: number; lightness: number } {
		const r = red / 255, g = green / 255, b = blue / 255;
		const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
		const lightness = (max + min) / 2;
		if (delta === 0) { return { hue: 0, saturation: 0, lightness: lightness * 100 }; }
		const saturation = delta / (1 - Math.abs(2 * lightness - 1));
		let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
		hue = (hue * 60 + 360) % 360;
		return { hue, saturation: saturation * 100, lightness: lightness * 100 };
	}

	function applyLayerBackground(brightness: number | null): void {
		if (brightness === null) {
			delete container.dataset.layerBackgroundOverride;
			container.style.removeProperty('--layer-preview-background');
			return;
		}
		const tint = rgbToHsl(_layerBackgroundTint || _themeBackgroundRgb);
		const lightness = Math.max(0, Math.min(100, brightness));
		container.dataset.layerBackgroundOverride = 'true';
		container.style.setProperty('--layer-preview-background', `hsl(${tint.hue}, ${tint.saturation}%, ${lightness}%)`);
	}

	function setLayerBackgroundBrightness(brightness: number | null): void {
		if (brightness === null) { _layerBackgroundTint = null; }
		else if (!_layerBackgroundTint) { _layerBackgroundTint = { ..._themeBackgroundRgb }; }
		applyLayerBackground(brightness);
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
		_themeBackgroundRgb = { red, green, blue };
		// HSL lightness makes the default thumb position exactly reproduce the
		// theme colour while retaining its hue and saturation along the slider.
		layersPanel.setThemeBackgroundBrightness(rgbToHsl(_themeBackgroundRgb).lightness);
	}

	syncThemeBackgroundBrightness();
	if (layersPanel.backgroundBrightness !== null && !_layerBackgroundTint) { _layerBackgroundTint = { ..._themeBackgroundRgb }; }
	applyLayerBackground(layersPanel.backgroundBrightness);
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
		for (const p of allProcessors) { p.loadSignal = navigation.signal; }
		setupImageLoading();
		setupMessageHandling();
		setupEventListeners();
		createImageCollectionOverlay();
		createNavOverlay();
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
		loadImageByType(src, resourceUri, navigation.generation, settings.formatHint);

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
		resetVisibleTiming();
		// Reset the state
		hasLoadedImage = false;
		canvas = null;
		imageElement = null;
		_pyramidScene = null;
		_pyramidPatchRegion = null;
		invalidatePyramidViewport();
		primaryImageData = null;
		peerImageData = null;
		mouseHandler.setPhysicalPixelSize(null);
		mouseHandler.setGeoReference(null);

		mouseHandler.setCoordinateScale(1);
		mouseHandler.setStoredValueResolver(null);
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
		_pyramidScene = null;
		_pyramidPatchRegion = null;
		const existingImages = container.querySelectorAll('img, canvas, .pyramid-scene');
		existingImages.forEach(el => {
			if (!isOverlayChrome(el)) {
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
		loadImageByType(reloadSrc, resourceUri, navigation.generation, settings.formatHint);
	}

	/**
	 * Helper function to send formatInfo (tracking happens automatically in vscode wrapper)
	 */
	function sendFormatInfo(formatInfo: FormatInfo) {
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

	const DETAILED_LAYER_COMPOSITOR_LOGGING = false;
	function logLayerPerformance(message: string) {
		console.log(message);
		if (DETAILED_LAYER_COMPOSITOR_LOGGING ||
			/\b(failed|device lost|validation error|unavailable)\b/i.test(message)) {
			logToOutput(message);
		}
	}

	layerCompositorWorker.setLogger(logLayerPerformance);
	layerGpuCompositor.setLogger(logLayerPerformance);
	layerWebGpuCompositor.setLogger(logLayerPerformance);

	const failedAutomaticBackends = new Set<LayerCompositorBackend>();

	function coldResetLayerCompositorBackends(): void {
		failedAutomaticBackends.clear();
		_automaticBackendGeneration++;
		layerCompositorWorker.dispose();
		layerGpuCompositor.dispose();
		layerWebGpuCompositor.dispose();
		layerManager.invalidateComposite();
	}

	function applyLayerCompositorBackend(
		backend: LayerCompositorBackend,
		rerender: boolean,
		forceColdRender = false,
	): void {
		const changed = _layerCompositorBackend !== backend;
		_layerCompositorBackend = backend;
		layersPanel.setResolvedCompositorBackend(backend);
		if (!changed && !forceColdRender) {
			if (rerender) { scheduleSaveState(); }
			return;
		}
		layerCompositorWorker.invalidateCompositeCache();
		if (backend === 'gpu') { layerGpuCompositor.retry(); }
		if (backend === 'webgpu') { layerWebGpuCompositor.retry(); }
		if (rerender && layerManager.active && !layerManager.isEmpty()) {
			const stateRevision = ++_layerStateRevision;
			schedulePreviewThenNative(stateRevision, 60);
		}
		scheduleSaveState();
	}

	async function selectAutomaticLayerBackend(rerender: boolean, forceColdRender = false): Promise<void> {
		const generation = ++_automaticBackendGeneration;
		let backend: LayerCompositorBackend = 'javascript';
		if (!failedAutomaticBackends.has('webgpu') && settingsManager.settings.gpuAcceleration !== false && await layerWebGpuCompositor.isAvailable()) {
			backend = 'webgpu';
		} else if (!failedAutomaticBackends.has('gpu') && settingsManager.settings.gpuAcceleration !== false && layerGpuCompositor.isAvailable()) {
			backend = 'gpu';
		} else if (await layerCompositorWorker.isWasmAvailable()) {
			backend = 'wasm';
		}
		if (generation !== _automaticBackendGeneration || _layerCompositorSelection !== 'auto') { return; }
		applyLayerCompositorBackend(backend, rerender, forceColdRender);
	}

	if (_layerCompositorSelection !== 'auto') {
		applyLayerCompositorBackend(_layerCompositorSelection, false);
	}

	// PerfTrace summaries go to both the webview console and the extension's
	// Output channel, so timing is visible without opening Developer Tools.
	PerfTrace.setLogger((message) => {
		console.log(message);
		logToOutput(message);
	});

	// A GPU upload rejected after the image was reported as drawn: the renderer
	// has disabled that path, so draw the current image again on the CPU.
	setWebGLLateFailureHandler(() => { void updateImageWithNewSettings(); });

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
		// See MAX_CANVAS_AREA. Reaching this is now a bug rather than a
		// possibility — `canvasCanHold` applies the same ceiling, so nothing
		// should ever ask for a larger image — but it stays as the backstop
		// that keeps a mistake from killing the webview process.
		const area = imageData.width * imageData.height;
		if (area > MAX_CANVAS_AREA) {
			const message = `Image is ${imageData.width}x${imageData.height} (${(area / 1e6).toFixed(0)} megapixels), `
				+ `above the ${(MAX_CANVAS_AREA / 1e6).toFixed(0)} megapixel limit a browser canvas can display. `
				+ `The pixel data decoded correctly and values can still be inspected; tiled rendering for images `
				+ `this large is not implemented yet.`;
			console.warn(`[Canvas] ${message}`);
			logToOutput(`[Canvas] ${message}`);
			vscode.postMessage({ type: 'show-error', message });
			return;
		}
		// Ensure the canvas matches the image size. Without this, drawing a smaller
		// image onto a canvas still sized for a previous (larger) image leaves the
		// old pixels visible around the new one — both images appear overlaid.
		if (ctx.canvas.width !== imageData.width || ctx.canvas.height !== imageData.height) {
			ctx.canvas.width = imageData.width;
			ctx.canvas.height = imageData.height;
		}
		const start = performance.now();
		// putImageData replaces the pixels outright (as the 'copy' operation
		// would) and leaves the same canvas bytes as createImageBitmap +
		// drawImage, also for translucent pixels, at a third of the cost in the
		// VS Code webview (25 MP: ~20 instead of ~60 ms).
		if (shouldDraw()) { ctx.putImageData(imageData, 0, 0); }
		console.log(`[Canvas] putImageData upload took ${(performance.now() - start).toFixed(2)}ms`);
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
		if (_pyramidScene && canvas.parentElement === _pyramidScene.element) {
			canvas.replaceWith(replacement);
			_pyramidScene.clearTiles();
		} else if (imageElement === canvas && canvas.parentElement) {
			canvas.replaceWith(replacement);
		}
		canvas = replacement;
		imageElement = _pyramidScene?.element || replacement;
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

	/**
	 * Reject an image the browser cannot actually put on a canvas.
	 *
	 * Chromium caps a canvas at a maximum area (and a maximum per-axis size),
	 * and silently gives back a canvas that is not the size asked for rather
	 * than throwing. A 20480x20480 float TIFF decodes perfectly well and then
	 * renders as a blank grey panel with nothing logged, which looks like a
	 * hang rather than a limit.
	 *
	 * Below the shared ceiling the limit is probed rather than hardcoded,
	 * because it differs between platforms and VS Code hosts: allocate the
	 * requested size and see whether the canvas kept it. The probe canvas is
	 * discarded immediately.
	 *
	 * The ceiling itself is NOT probed, and that is the point. Chromium happily
	 * allocates a 20000x20000 canvas, so the probe said yes — while
	 * `renderImageDataToCanvas` refuses anything past 2^28 pixels outright,
	 * because at that size the ImageData and the backing store together take the
	 * webview process down. Two limits that disagree meant the level machinery
	 * confidently chose a 400-megapixel level, the renderer declined to draw it,
	 * and the view went transparent with the decode already paid for. Whatever
	 * else is true, this must never claim more than the renderer will accept.
	 */
	function canvasCanHold(width: number, height: number): boolean {
		if (!(width > 0 && height > 0)) { return false; }
		if (width * height > MAX_CANVAS_AREA) { return false; }
		// A canvas is only half the question: the pixels reach it through an
		// ImageData, whose backing store is a single typed array and so cannot
		// exceed 2^31-1 bytes. Chromium will happily allocate a 40000x40000
		// canvas and then throw IndexSizeError on `new ImageData(...)`, which
		// is how a 1.6-gigapixel COG used to fail after a 27-second decode.
		if (width * height * 4 > IMAGE_DATA_MAX_BYTES) { return false; }
		// Fast path: anything inside the smallest limit any mainstream engine
		// enforces is fine, and must NOT be probed — allocating a second
		// full-size canvas to ask the question would double peak memory for
		// every ordinary image.
		const SAFE_AXIS = CANVAS_SAFE_AXIS;
		const SAFE_AREA = CANVAS_SAFE_AREA;
		if (width <= SAFE_AXIS && height <= SAFE_AXIS && width * height <= SAFE_AREA) {
			return true;
		}
		try {
			const probe = document.createElement('canvas');
			probe.width = width;
			probe.height = height;
			if (probe.width !== width || probe.height !== height) { return false; }
			// Chromium only fails the ALLOCATION when a context is requested.
			const context = probe.getContext('2d');
			if (!context) { return false; }
			probe.width = 1;
			probe.height = 1;
			return true;
		} catch {
			return false;
		}
	}

	/** Human-readable "this image is too big to display" message. */
	function tooLargeMessage(width: number, height: number): string {
		const megapixels = (width * height / 1e6).toFixed(1);
		return `This image is ${width} x ${height} (${megapixels} megapixels), which exceeds the maximum canvas size this browser can allocate. `
			+ `The file decoded correctly; it cannot be displayed at full resolution.`;
	}

	function onImageError(message: string = '') {
		navigation.markFailed(navigation.generation);
		if (datasetRequestInFlight) { datasetRequestSettled(); }
		PerfTrace.cancel();
		hasLoadedImage = true;
		signalTiffCanvasReady();
		finishSeamlessImageTransition();
		clearCollectionLoadingState();
		// Remove previous image/canvas so the error message shows on a clean background
		container.querySelectorAll('img, canvas, .pyramid-scene').forEach(el => {
			if (!isOverlayChrome(el)) {
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
	/**
	 * `chooseLevel` is what separates OPENING a file from navigating within one.
	 * On an open, a pyramidal file's level is picked from the window; once the
	 * reader (or the zoom-driven refinement) has asked for a specific level,
	 * re-applying that policy would immediately undo the request — a refinement
	 * to full resolution would be answered with the window-sized level again.
	 */
	async function handleTiff(
		src: string,
		gen: number = navigation.generation,
		pageIndex: number = tiffProcessor.pageIndex,
		{ chooseLevel = true }: { chooseLevel?: boolean } = {},
	) {
		currentLoadFormat = 'TIFF';
		currentLoadDecodeInfo = null;
		try {
			const result = await tiffProcessor.load(src, pageIndex, chooseLevel ? {
				// Fit-to-window is the opening view, so the container width is
				// what a level has to cover.
				displayWidth: (container.clientWidth || window.innerWidth || 1024) * (window.devicePixelRatio || 1),
				// The limits, measured here because only this side has a canvas
				// to measure with, and sent as numbers so the DECISION can be
				// made in the decode worker — where the file is already being
				// read, and where a file with no pyramid pays nothing for it.
				maxAxis: CANVAS_SAFE_AXIS,
				maxArea: CANVAS_SAFE_AREA,
				maxBytes: IMAGE_DATA_MAX_BYTES,
				pixelBudget: FULL_RESOLUTION_PIXEL_BUDGET,
			} : undefined);
			if (gen !== navigation.generation) { return; }
			if (!canvasCanHold(result.canvas.width, result.canvas.height)) {
				// A pyramidal file carries smaller copies of this very scene.
				// Showing the largest one that fits beats refusing the file —
				// but say so, because the reader is no longer looking at full
				// resolution.
				const fallback = largestDisplayableLevel(pageIndex);
				if (fallback && fallback.index !== pageIndex) {
					logToOutput(`[Level] ${result.canvas.width}x${result.canvas.height} exceeds this browser's canvas limit; `
						+ `showing overview ${levelLabel(fallback)}`);
					await navigateTiffToPage(fallback.index);
					return;
				}
				onImageError(tooLargeMessage(result.canvas.width, result.canvas.height));
				return;
			}
			const ome = tiffProcessor.omeMetadata;
			registerTiffDataset();
			mouseHandler.setPhysicalPixelSize(ome ? {
				x: ome.physicalSizeX,
				y: ome.physicalSizeY,
				xUnit: ome.physicalSizeXUnit,
				yUnit: ome.physicalSizeYUnit,
			} : null);
			// A GeoTIFF's cursor readout is its map position, which takes
			// precedence over the OME spacing above; the mouse handler decides.
			mouseHandler.setGeoReference(tiffProcessor.geoReference || null);
			currentLoadDecodeInfo = result.decodeInfo;

			_pyramidScene = null;
			_pyramidPatchRegion = null;
			invalidatePyramidViewport();
			if (!await installLoadedImage(tiffProcessor, result, gen)) return;
			signalTiffCanvasReady();
			// The TIFF directory has already given us the scene/page geometry and
			// block layout. Publish that UI now, before the per-format settings
			// handshake and first pixel decode complete. On a remote image this can
			// be several network round trips earlier than first paint.
			if (tiffProcessor._pendingRenderData) { updateTiffPageOverlay(true); }
			if (!tiffProcessor._pendingRenderData) {
				installPyramidSceneIfNeeded();
				configureTiffMouseReadout();
				finalizeImageSetup();
				updateTiffPageOverlay();
				void updateDetailPatch();
				const endTime = performance.now();
				const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
				const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
				logLoadPerformance('TIFF', webviewTime, totalTime);
			}
			// else: finalizeImageSetup called after deferred render in updateSettings handler

		} catch (error) {
			if (gen !== navigation.generation) { return; }
			console.error('Error handling TIFF:', error);
			const msg = String(error instanceof Error ? error.message : error);
			// ZSTD itself is decoded (strips, tiles and planar layouts alike),
			// so a failure here is about the specific file, not the codec:
			// report what the decoder actually said instead of claiming the
			// compression is unsupported.
			if (msg.toLowerCase().includes('compression')) {
				onImageError(`Unsupported TIFF compression: ${msg}`);
			} else {
				onImageError(`Failed to load TIFF: ${msg}`);
			}
		}
	}

	async function installLoadedImage(processor: LoadProcessor, result: ImageLoadResult, gen: number): Promise<boolean> {
		return installImageLoad({
			isCurrent: generation => generation === navigation.generation,
			install: loaded => { canvas = loaded.canvas; primaryImageData = loaded.imageData; imageElement = loaded.displayElement || canvas; },
			draw: renderImageDataToCanvas,
			complete: () => { hasLoadedImage = true; },
		}, processor, result, gen);
	}

	async function handleImageLoad(processor: LoadProcessor & { load(src: string): Promise<ImageLoadResult>; _lastDecodeInfo?: typeof currentLoadDecodeInfo }, label: string, src: string, gen = navigation.generation) {
		currentLoadFormat = label;
		currentLoadDecodeInfo = null;
		try {
			const result = await processor.load(src);
			if (!await installLoadedImage(processor, result, gen)) return;
			currentLoadDecodeInfo = processor._lastDecodeInfo ?? null;
			if (!processor._pendingRenderData && !result.lazyPixelData) {
				finalizeImageSetup();
				const webviewTime = (performance.now() - initialLoadStartTime).toFixed(2);
				logLoadPerformance(label, webviewTime, extensionLoadStartTime ? Date.now() - extensionLoadStartTime : webviewTime);
			}
		} catch (error) {
			if (gen !== navigation.generation) return;
			console.error(`Error handling ${label}:`, error);
			onImageError();
		}
	}

	async function handleScientificArray(processor: any, src: string, gen: number = navigation.generation, decodeOptions: Record<string, any> = {}) {
		currentLoadFormat = processor.config.formatLabel;
		currentLoadDecodeInfo = null;
		try {
			const result = await processor.load(src, decodeOptions);
			if (gen !== navigation.generation) { return; }
			if (!canvasCanHold(result.canvas.width, result.canvas.height)) {
				onImageError(tooLargeMessage(result.canvas.width, result.canvas.height));
				return;
			}
			if (processor === dicomProcessor) { registerDicomDataset(); }
			if (isPlaneNavProcessor(processor)) {
				// Show completed planes during scrubbing, but keep the controls at
				// the newest requested position rather than the older decoded one.
				planeNavProcessor = processor;
				if (!planeLoadPending) {
					planeSelection = { indices: { ...(processor.metadata.selectedIndices || {}) } };
				}
				updatePlaneOverlay(processor.metadata, planeLoadPending);
			}
			if (processor === netcdfProcessor) {
				netcdfSelection = {
					variableName: String(processor.metadata.variable || ''),
					indices: { ...(processor.metadata.selectedIndices || {}) },
				};
				updateNetCdfOverlay(processor.metadata, false);
			}
			if (!await installLoadedImage(processor, result, gen)) return;
			// A CZI mosaic too large to hold whole shows a stored level inside the
			// pyramid scene large TIFFs use; finer levels stream in on zoom.
			const cziScene = processor === cziProcessor && cziProcessor.isScene;
			if (cziScene && !processor._pendingRenderData) {
				installPyramidSceneIfNeeded();
				configureTiffMouseReadout();
			}
			if (!processor._pendingRenderData) { finalizeImageSetup(); }
			if (cziScene && !processor._pendingRenderData) { void updateDetailPatch(); }
			// Start the trailing decode only after this canvas has been installed.
			// The next load yields to paint and keeps this frame visible while busy.
			if (isPlaneNavProcessor(processor)) { onPlaneLoadSettled(); }
		} catch (error) {
			if (gen !== navigation.generation) { return; }
			if (processor === netcdfProcessor) { navOverlay?.classList.remove('dataset-overlay--loading'); }
			if (isPlaneNavProcessor(processor)) {
				navOverlay?.classList.remove('dataset-overlay--loading');
				onPlaneLoadSettled();
			}
			console.error(`Error handling ${processor.config.formatLabel}:`, error);
			onImageError(`Failed to load ${processor.config.formatLabel}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async function handleLayeredPreview(format: LayeredDocumentFormat, src: string, gen: number = navigation.generation) {
		currentLoadFormat = 'Layered Document';
		currentLoadDecodeInfo = null;
		try {
			const result = await layeredPreviewProcessor.load(src, format);
			if (gen !== navigation.generation) { return; }
			if (!await installLoadedImage(layeredPreviewProcessor, result, gen)) return;
			updateLayeredPreviewOverlay();
			if (!layeredPreviewProcessor._pendingRenderData) { finalizeImageSetup(); }
		} catch (error) {
			if (gen !== navigation.generation) { return; }
			console.error(`Error handling layered ${format} document:`, error);
			onImageError(`Failed to load ${format.toUpperCase()}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Finalize image setup after loading
	 */
	function finalizeImageSetup() {
		if (!imageElement || !canvas) return;
		const nextImageElement = imageElement;
		if (_imageTransitionActive && !_pendingZoomStateExplicit) {
			// The outgoing frame remains interactive while decoding; carry any pan or
			// zoom made during that interval into the replacement frame as well.
			_pendingZoomState = zoomController.getCurrentState();
		}
		// Update all controllers with references
		zoomController.setImageElement(nextImageElement);
		zoomController.setCanvas(canvas);
		zoomController.setImageLoaded();
		mouseHandler.setImageElement(nextImageElement);
		// A persisted channel composite or an already-open analysis panel can
		// affect the visible result immediately. Ordinary measurement/cache
		// invalidation does not, so keep it out of the first-paint task.
		const analysisNeededForCommittedFrame = compositeEnabled ||
			channelsPanel.isVisible() || measurePanel.isVisible();
		if (analysisNeededForCommittedFrame) {
			invalidateMeasurementForNewImage();
		}

		// Send size information to VS Code
		const sizeElement = nextImageElement as any;
		const sizeWidth = Number(nextImageElement.dataset?.sceneWidth)
			|| canvas?.width || sizeElement.naturalWidth || sizeElement.width;
		const sizeHeight = Number(nextImageElement.dataset?.sceneHeight)
			|| canvas?.height || sizeElement.naturalHeight || sizeElement.height;

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

		// Remove any other stale image/canvas elements, but preserve overlay chrome.
		for (const el of Array.from(container.children)) {
			if (!(el instanceof HTMLElement)) { continue; }
			const isVisual = el.tagName === 'IMG' || el.tagName === 'CANVAS'
				|| el.classList.contains('pyramid-scene');
			if (isVisual && el !== nextImageElement && !isOverlayChrome(el)) { el.remove(); }
		}

		// Update UI
		container.classList.remove('loading');
		container.classList.remove('error');
		container.classList.add('ready');

		// Apply zoom: restore saved state from before the switch, or use the
		// controller's initial state if this was the first load. An explicit fit
		// state must go through restoreState(); applyInitialZoom() intentionally
		// reapplies persisted state and could otherwise resurrect an old numeric
		// zoom on a newly opened image.
		if (_pendingLevelScaleMultiplier && _pendingZoomState && typeof _pendingZoomState.scale === 'number') {
			_pendingZoomState = {
				..._pendingZoomState,
				scale: _pendingZoomState.scale * _pendingLevelScaleMultiplier,
			};
		}
		_pendingLevelScaleMultiplier = null;
		if (_pendingZoomState) {
			zoomController.restoreState(_pendingZoomState);
		} else {
			zoomController.applyInitialZoom();
		}
		_pendingZoomState = null;
		_pendingZoomStateExplicit = false;
		finishSeamlessImageTransition();
		// Dimensions belong to the committed image, independently of deferred
		// analysis/paint bookkeeping. Keep an idle readout even on that first load.
		vscode.postMessage({ type: 'size', value: `${sizeWidth}x${sizeHeight}` });

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
			scientificProcessors.some(processor => !!processor._pendingRenderData);
		if (!hasPendingDeferred) {
			scheduleVisiblePaintMeasurement();
			clearCollectionLoadingState();
		}

		mouseHandler.addMouseListeners(imageElement);
		PerfTrace.mark('finalize-dom');

		// Note: Histogram visibility is restored via restoreHistogramState message
		// when webview becomes active (sent from ImagePreview.sendHistogramState)

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
		if (layerManager.active && layerManager.hasCompositeStack()) {
			recompositeLayers();
			PerfTrace.mark('layers-recomposite');
		}

		// Close the switch trace once the final pixels are shown. With a deferred
		// render pending this call is the placeholder finalize — keep the trace
		// open; the post-deferred finalize (pending cleared by then) ends it.
		PerfTrace.mark('finalize');
		if (!hasPendingDeferred) {
			navigation.markReady(navigation.generation);
			PerfTrace.end();
			scheduleAfterVisiblePaint(() => {
				if (!analysisNeededForCommittedFrame) {
					invalidateMeasurementForNewImage();
				}
				// Metadata/histogram refresh and opening the
				// dedicated layer controls do not affect the committed base frame.
				updateHistogramData();
				if (settingsManager.settings.surfaceMode === 'layers' && !_layerSurfaceShown &&
					!layeredPreviewProcessor.hasDeferredLayersPending()) {
					_layerSurfaceShown = true;
					layersPanel.show();
					if (!_pendingLayerRestore) {
						vscode.postMessage({ type: 'requestInitialLayers' });
					}
				}
			});
		}
	}

	// ===================== Layer compositing helpers =====================

	function layerBaseName(uri: string): string {
		try { return decodeURIComponent((uri || '').split('/').pop() || uri || 'layer'); }
		catch { return (uri || '').split('/').pop() || 'layer'; }
	}

	/** NaN display color from current settings. */
	function getNanColorObj() {
		return resolveNanColor(settingsManager.settings);
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

	/** Lazy processors are selected here; image consumers do not probe formats. */
	const processorSources = {
		get tiff() { return tiffProcessor; }, get exr() { return exrProcessor; },
		get npy() { return npyProcessor; }, get pfm() { return pfmProcessor; },
		get netpbm() { return ppmProcessor; }, get png() { return pngProcessor; },
		get hdr() { return hdrProcessor; }, get tga() { return tgaProcessor; },
		get 'web-image'() { return webImageProcessor; }, get layered() { return layeredPreviewProcessor; },
	};
	function activeProcessor(kind = resolveFormat(settingsManager.settings.resourceUri || '', settingsManager.settings.formatHint)?.kind): ActiveImageProcessor | undefined {
		return processorSources[kind as keyof typeof processorSources]
			?? scientificProcessors.find(processor => processor.config.workerFormat === kind);
	}

	function getActiveImage(): ActiveImage | null {
		const decoded = decodedColormapSource;
		if (!decoded) return activeProcessor()?.activeImage ?? null;
		return {
			raster: { data: decoded.floatData, width: decoded.width, height: decoded.height, channels: 1, isFloat: true, typeMax: 1, sourceNumericType: 'float32' },
			stats: decoded.stats, pixelDisplay: 'float',
			readPixel: (x, y) => x >= 0 && y >= 0 && x < decoded.width && y < decoded.height ? String(decoded.floatData[y * decoded.width + x]) : '',
		};
	}

	/** Derive the base layer from the current image, preserving source samples. */
	function deriveBaseLayer(): LayerInput | null {
		const uri = settingsManager.settings.resourceUri || '';
		const name = layerBaseName(uri);
		return imageLayer(getActiveImage(), name, uri) || baseFromCanvas(name, uri);
	}

	/**
	 * Decode an image URI into a layer using a fresh processor instance (so the
	 * primary image's processor state is never disturbed). Falls back to a plain
	 * <img> decode for formats without an exposed raw buffer.
	 * @param src Webview-safe URI to fetch.
	 * @param resourceUri Original resource URI (for extension + name).
	 */
	async function decodeLayer(src: string, resourceUri: string): Promise<LayerInput | null> {
		const name = layerBaseName(resourceUri || src);
		const format = resolveFormat(resourceUri || src);
		const noop = { postMessage() {}, setState() {}, getState: (): undefined => undefined };
		try {
			if (!format) return decodeViaImage(src, name, resourceUri);
			await ensureProcessorFamily(format.kind);
			const source = activeProcessor(format.kind);
			if (!source?.activeImage) return decodeViaImage(src, name, resourceUri);
			// A fresh instance isolates layer decoding from the currently displayed image.
			const Processor = source.constructor as new (...args: any[]) => {
				activeImage: ActiveImage; load: (src: string, format?: string) => Promise<unknown>;
				_isInitialLoad: boolean; decodeEditableLayers?: boolean; decodeWorker: unknown;
			};
			const processor = new Processor(settingsManager, noop, source.config);
			processor._isInitialLoad = false;
			processor.decodeEditableLayers = false;
			processor.decodeWorker = format.kind === 'png' ? pngDecodeWorkerClient
				: format.kind === 'layered' ? layeredDecodeWorkerClient
				: format.kind === 'pfm' || format.kind === 'netpbm' || (format.kind === 'npy' && resourceUri.toLowerCase().endsWith('.npy')) ? fastRawWorkerClient : decodeWorkerClient;
			await processor.load(src, format.layeredFormat);
			return imageLayer(processor.activeImage, name, resourceUri) || decodeViaImage(src, name, resourceUri);
		} catch (error) {
			console.error('Failed to decode layer', resourceUri, error);
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
		const orderedAssets = raw.layerOrder === 'bottom-to-top' ? raw.layerAssets : [...raw.layerAssets].reverse();
		const layers = orderedAssets.map(asset => layerManager.createLayer({
			data: asset.data, width: asset.width, height: asset.height, channels: asset.channels ?? 4,
			isFloat: asset.isFloat ?? false, typeMax: asset.typeMax ?? 255,
			sourceNumericType: asset.sourceNumericType,
			name: asset.name,
			kind: asset.kind || 'raster',
			adjustment: asset.adjustment,
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
			adjustment: asset.adjustment,
		}));
		if (!layers.length) { return false; }
		// Decoder relationships use stable source-node IDs, while the compositor
		// uses its own runtime layer IDs. Resolve the former before compositing so
		// imported groups and adjustment ownership are first-class relationships.
		const runtimeIds = new Map<string, string>();
		for (let i = 0; i < orderedAssets.length; i++) {
			const sourceId = orderedAssets[i].nodeId;
			const runtimeId = layers[i].id;
			if (sourceId && runtimeId) { runtimeIds.set(sourceId, runtimeId); }
		}
		for (const layer of layers) {
			if (layer.parentId && runtimeIds.has(layer.parentId)) {
				layer.parentId = runtimeIds.get(layer.parentId);
			}
		}
		layerManager.setLayers(layers, raw.document.width, raw.document.height);
		layerManager.documentExpanded = true;
		_expandedLayerDocumentUri = uri;
		_layerBaseUri = uri;
		_layerBaseId = undefined;
		layersPanel.refresh();
		return true;
	}

	function syncBaseLayer() {
		const base = deriveBaseLayer();
		if (!base) { return; }
		if (_layerBaseUri !== base.uri || layerManager.isEmpty()) {
			_layerBaseUri = base.uri;
			layerManager.setBaseLayer(base);
			_layerBaseId = layerManager.layers[0]?.id;
			if (layersPanel.isVisible()) { layersPanel.refresh(); }
		} else {
			// Same image re-rendered: refresh the matching layer's data in place
			// (it may have been reordered). If the user removed that layer, leave
			// the stack untouched — don't re-inject it.
			const existing = layerManager.layers.find(l => l.id === _layerBaseId) ||
				layerManager.layers.find(l => l.uri === base.uri);
			if (existing) {
				_layerBaseId = existing.id;
				Object.assign(existing, {
					data: base.data, width: base.width, height: base.height,
					channels: base.channels, isFloat: base.isFloat, typeMax: base.typeMax,
				});
				layerManager.canvasWidth = base.width;
				layerManager.canvasHeight = base.height;
				layerManager.invalidateComposite();
			}
		}
	}

	/**
	 * Composite the layer stack and draw the result to the main canvas.
	 * @returns True if a composite was rendered.
	 */
	function recompositeLayers(interactive = false, requestedStateRevision?: number): boolean {
		if (!layerManager.active || !canvas) { return false; }
		const stateRevision = requestedStateRevision ?? ++_layerStateRevision;
		const interactionStartedAt = _layerRevisionStartedAt.get(stateRevision) ?? performance.now();
		const fullWidth = layerManager.canvasWidth, fullHeight = layerManager.canvasHeight;
		const scale = layerDisplayScale(fullWidth, fullHeight, interactive);
		const phase = interactive ? 'preview' : 'native';
		const formatTiming = (value: number) => `${value.toFixed(1)}ms`;
		const formatBytes = (value: number) => value >= 1024 * 1024
			? `${(value / (1024 * 1024)).toFixed(1)}MiB`
			: `${(value / 1024).toFixed(1)}KiB`;
		if (_layerCompositorBackend === 'webgpu') {
			if (interactive) {
				const pendingUpload = layerWebGpuCompositor.pendingUpload(layerManager.layers);
				if (pendingUpload.count > 0) {
					_layerPreviewRequested.delete(stateRevision);
					if (_nativeAfterPreviewRevision === stateRevision) {
						_nativeAfterPreviewRevision = null;
					}
					logLayerPerformance(
						`[LayerCompositor] webgpu preview skipped | ` +
						`pending-uploads=${pendingUpload.count}/${formatBytes(pendingUpload.bytes)} ` +
						`delay=${formatTiming(performance.now() - interactionStartedAt)}; starting native immediately`,
					);
					recordLayerPreviewSkipped(stateRevision, 'cold upload');
					scheduleRecomposite(0, false, stateRevision);
					return true;
				}
			}
			void layerWebGpuCompositor.renderWithMetrics(
				layerManager.layers, fullWidth, fullHeight, scale,
				settingsManager.settings, getNanColorObj(), true,
			).then(({ canvas: gpuSurface, timing }) => {
				if (!gpuSurface || stateRevision !== _layerStateRevision || !layerManager.active || !canvas) { return; }
				const ctx = ensure2dCanvasContext();
				if (!ctx) { return; }
				const copyStarted = performance.now();
				if (ctx.canvas.width !== fullWidth || ctx.canvas.height !== fullHeight) {
					ctx.canvas.width = fullWidth; ctx.canvas.height = fullHeight;
				}
				ctx.save();
				ctx.globalCompositeOperation = 'copy';
				ctx.imageSmoothingEnabled = true;
				ctx.drawImage(gpuSurface, 0, 0, fullWidth, fullHeight);
				ctx.restore();
				scheduleLayerHistogramRefresh(stateRevision, interactive);
				const displayedAt = performance.now();
				if (interactive) {
					recordLayerPreview(stateRevision, 'webgpu', gpuSurface.width, gpuSurface.height, timing.renderMs);
					markLayerPreviewDisplayed(stateRevision, displayedAt);
				} else {
					recordLayerNative(
						stateRevision, 'webgpu', gpuSurface.width, gpuSurface.height, timing.renderMs,
						`uploads=${timing.uploadCount}, composition=${timing.compositionCacheHit ? 'cached' : 'rendered'}`,
					);
				}
				const previewVisibleMs = !interactive && _layerPreviewDisplayedAt.has(stateRevision)
					? displayedAt - (_layerPreviewDisplayedAt.get(stateRevision) as number)
					: null;
				logLayerPerformance(
					`[LayerCompositor] webgpu ${phase} ${gpuSurface.width}×${gpuSurface.height} at ${Math.round(scale * 100)}% | ` +
					`delay=${formatTiming(timing.requestedAt - interactionStartedAt)} ` +
					`queue=${formatTiming(timing.queueMs)} init=${formatTiming(timing.initializationMs)} ` +
					`prepare=${formatTiming(timing.prepareMs)} encode=${formatTiming(timing.encodeMs)} ` +
					`gpu=${formatTiming(timing.gpuMs)} validate=${formatTiming(timing.validationMs)} ` +
					`copy=${formatTiming(displayedAt - copyStarted)} render=${formatTiming(timing.renderMs)} ` +
					`total=${formatTiming(displayedAt - interactionStartedAt)} ` +
					`uploads=${timing.uploadCount}/${formatBytes(timing.uploadBytes)}/${formatTiming(timing.uploadCpuMs)} ` +
					`composition=${timing.compositionCacheHit ? 'cached' : 'rendered'} ` +
					`surfaces=${timing.surfaceCacheHit ? 'cached' : `new/${formatBytes(timing.surfaceAllocationBytes)}`} ` +
					`${previewVisibleMs === null ? '' : `preview-visible=${formatTiming(previewVisibleMs)}`}`.trimEnd(),
				);
				if (!interactive) {
					markLayerNativeDisplayed(stateRevision);
					_layerRevisionStartedAt.delete(stateRevision);
					_layerPreviewDisplayedAt.delete(stateRevision);
				}
			}).catch(error => {
				if (stateRevision !== _layerStateRevision) { return; }
				if (recoverAutomaticBackend('webgpu', error)) { return; }
				reportStrictCompositorFailure('WebGPU', error, stateRevision);
				setTimeout(() => { throw error; }, 0);
			});
			return true;
		}
		if (_layerCompositorBackend === 'gpu') {
			const gpuStarted = performance.now();
			let gpuSurface: HTMLCanvasElement;
			try {
				gpuSurface = layerGpuCompositor.render(
					layerManager.layers,
					fullWidth,
					fullHeight,
					scale,
					settingsManager.settings,
					getNanColorObj(),
					true,
				) as HTMLCanvasElement;
			} catch (error) {
				if (recoverAutomaticBackend('gpu', error)) { return true; }
				reportStrictCompositorFailure('GPU', error, stateRevision);
				throw error;
			}
			const ctx = ensure2dCanvasContext();
			if (!ctx) { return false; }
			const renderFinished = performance.now();
			const copyStarted = performance.now();
			if (ctx.canvas.width !== fullWidth || ctx.canvas.height !== fullHeight) {
				ctx.canvas.width = fullWidth; ctx.canvas.height = fullHeight;
			}
			ctx.save();
			ctx.globalCompositeOperation = 'copy';
			ctx.imageSmoothingEnabled = true;
			ctx.drawImage(gpuSurface, 0, 0, fullWidth, fullHeight);
			ctx.restore();
			scheduleLayerHistogramRefresh(stateRevision, interactive);
			const displayedAt = performance.now();
			const gpuRenderMs = renderFinished - gpuStarted;
			if (interactive) {
				recordLayerPreview(stateRevision, 'webgl2', gpuSurface.width, gpuSurface.height, gpuRenderMs);
				markLayerPreviewDisplayed(stateRevision, displayedAt);
			} else {
				recordLayerNative(stateRevision, 'webgl2', gpuSurface.width, gpuSurface.height, gpuRenderMs);
			}
			const previewVisibleMs = !interactive && _layerPreviewDisplayedAt.has(stateRevision)
				? displayedAt - (_layerPreviewDisplayedAt.get(stateRevision) as number)
				: null;
			logLayerPerformance(
				`[LayerCompositor] webgl2 ${phase} ${gpuSurface.width}×${gpuSurface.height} at ${Math.round(scale * 100)}% | ` +
				`delay=${formatTiming(gpuStarted - interactionStartedAt)} queue=0.0ms ` +
				`render=${formatTiming(renderFinished - gpuStarted)} ` +
				`copy=${formatTiming(displayedAt - copyStarted)} ` +
				`total=${formatTiming(displayedAt - interactionStartedAt)} ` +
				`${previewVisibleMs === null ? '' : `preview-visible=${formatTiming(previewVisibleMs)}`}`.trimEnd(),
			);
			if (!interactive) {
				markLayerNativeDisplayed(stateRevision);
				_layerRevisionStartedAt.delete(stateRevision);
				_layerPreviewDisplayedAt.delete(stateRevision);
			}
			return true;
		}
		const workerBackend = _layerCompositorBackend === 'wasm' ? 'wasm' : 'javascript';
		const workerRequest = layerCompositorWorker.compose(layerManager.layers, fullWidth, fullHeight, scale, workerBackend);
		if (workerRequest) {
			void workerRequest.then(async result => {
				if (!result || stateRevision !== _layerStateRevision || !layerManager.active || !canvas) { return; }
				const imageData = layerManager.renderCompositeToImageData(result, settingsManager.settings, {
					nanColor: getNanColorObj(),
					cache: scale === 1,
				});
				const ctx = ensure2dCanvasContext();
				if (!ctx) { return; }
				if (scale < 1) {
					if (ctx.canvas.width !== fullWidth || ctx.canvas.height !== fullHeight) {
						ctx.canvas.width = fullWidth; ctx.canvas.height = fullHeight;
					}
					try {
						const bitmap = await createImageBitmap(imageData);
						if (stateRevision === _layerStateRevision && layerManager.active) {
							ctx.save();
							ctx.globalCompositeOperation = 'copy';
							ctx.imageSmoothingEnabled = true;
							ctx.drawImage(bitmap, 0, 0, fullWidth, fullHeight);
							ctx.restore();
						}
						bitmap.close();
					} catch {
						const previewCanvas = document.createElement('canvas');
						previewCanvas.width = imageData.width; previewCanvas.height = imageData.height;
						previewCanvas.getContext('2d')?.putImageData(imageData, 0, 0);
						if (stateRevision === _layerStateRevision && layerManager.active) {
							ctx.save(); ctx.globalCompositeOperation = 'copy';
							ctx.drawImage(previewCanvas, 0, 0, fullWidth, fullHeight); ctx.restore();
						}
					}
				} else {
					await renderImageDataToCanvas(imageData, ctx, () =>
						stateRevision === _layerStateRevision && layerManager.active);
					if (stateRevision === _layerStateRevision && layerManager.active) {
						primaryImageData = imageData;
					}
				}
				scheduleLayerHistogramRefresh(stateRevision, interactive);
				if (interactive && stateRevision === _layerStateRevision && layerManager.active) {
					const timing = (result as typeof result & { compositorTiming?: { backend: string; durationMs: number } }).compositorTiming;
					recordLayerPreview(
						stateRevision,
						timing?.backend || workerBackend,
						result.width,
						result.height,
						timing?.durationMs || 0,
					);
					markLayerPreviewDisplayed(stateRevision, performance.now());
				} else if (!interactive && stateRevision === _layerStateRevision && layerManager.active) {
					const timing = (result as typeof result & { compositorTiming?: { backend: string; durationMs: number } }).compositorTiming;
					recordLayerNative(
						stateRevision,
						timing?.backend || workerBackend,
						result.width,
						result.height,
						timing?.durationMs || 0,
					);
					markLayerNativeDisplayed(stateRevision);
				}
			}).catch(error => {
				if (stateRevision !== _layerStateRevision) { return; }
				reportStrictCompositorFailure(_layerCompositorBackend === 'wasm' ? 'Rust/Wasm' : 'JavaScript', error, stateRevision);
				setTimeout(() => { throw error; }, 0);
			});
			return true;
		}
		const error = new Error(`${workerBackend} compositor worker is unavailable`);
		reportStrictCompositorFailure(workerBackend === 'wasm' ? 'Rust/Wasm' : 'JavaScript', error, stateRevision);
		throw error;
	}

	function recoverAutomaticBackend(backend: LayerCompositorBackend, error: unknown): boolean {
		if (_layerCompositorSelection !== 'auto') { return false; }
		failedAutomaticBackends.add(backend);
		logLayerPerformance(`[LayerCompositor] ${backend} failed; selecting a fallback: ${String(error)}`);
		if (backend === 'webgpu') { layerWebGpuCompositor.dispose(); }
		if (backend === 'gpu') { layerGpuCompositor.dispose(); }
		void selectAutomaticLayerBackend(true);
		return true;
	}

	function reportStrictCompositorFailure(backend: string, error: unknown, stateRevision: number): void {
		if (stateRevision !== _layerStateRevision) { return; }
		if (_interactiveRecompositeTimer) {
			clearTimeout(_interactiveRecompositeTimer);
			_interactiveRecompositeTimer = null;
		}
		const detail = error instanceof Error ? error.message : String(error);
		const message = `[LayerCompositor] Strict ${backend} render failed: ${detail}`;
		logLayerPerformance(message);
		vscode.postMessage({ type: 'show-error', message });
	}

	// Coalesce rapid recomposite requests. Interactive drags get a short trailing
	// debounce because a full large-layer composite can take hundreds of ms or
	// seconds, and running one for every slider event makes the slider itself lag.
	let _recompositeScheduled = false;
	let _scheduledInteractive = false;
	let _scheduledStateRevision = 0;
	let _interactiveRecompositeTimer: ReturnType<typeof setTimeout> | null = null;

	function registerLayerPerformanceRevision(stateRevision: number, interactive: boolean): LayerPerformanceChange {
		let change: LayerPerformanceChange | undefined;
		if (interactive && _activeLayerGestureChangeId !== null) {
			change = _layerPerformanceChanges.get(_activeLayerGestureChangeId);
		}
		if (!change) {
			const id = _nextLayerPerformanceChangeId++;
			change = {
				id,
				latestRevision: stateRevision,
				backend: _layerCompositorBackend,
				settled: !interactive,
				emitted: false,
				previewCount: 0,
				previewWidth: 0,
				previewHeight: 0,
				previewLastMs: 0,
				previewMaxMs: 0,
				nativeWidth: 0,
				nativeHeight: 0,
				nativeMs: 0,
				nativeRevision: -1,
			};
			_layerPerformanceChanges.set(id, change);
			if (interactive) { _activeLayerGestureChangeId = id; }
		}
		change.latestRevision = stateRevision;
		change.backend = _layerCompositorBackend;
		_layerRevisionPerformanceChange.set(stateRevision, change.id);
		return change;
	}

	function layerPerformanceChange(stateRevision: number, interactive: boolean): LayerPerformanceChange {
		const id = _layerRevisionPerformanceChange.get(stateRevision);
		return (id !== undefined ? _layerPerformanceChanges.get(id) : undefined) ||
			registerLayerPerformanceRevision(stateRevision, interactive);
	}

	function settleLayerPerformanceChange(stateRevision: number): void {
		const change = layerPerformanceChange(stateRevision, true);
		change.settled = true;
		if (_activeLayerGestureChangeId === change.id) { _activeLayerGestureChangeId = null; }
		emitLayerPerformanceChange(change);
	}

	function recordLayerPreview(
		stateRevision: number,
		backend: string,
		width: number,
		height: number,
		renderMs: number,
	): void {
		const change = layerPerformanceChange(stateRevision, true);
		change.backend = backend;
		change.previewCount++;
		change.previewWidth = width;
		change.previewHeight = height;
		change.previewLastMs = renderMs;
		change.previewMaxMs = Math.max(change.previewMaxMs, renderMs);
	}

	function recordLayerPreviewSkipped(stateRevision: number, reason: string): void {
		layerPerformanceChange(stateRevision, true).previewSkipped = reason;
	}

	function recordLayerNative(
		stateRevision: number,
		backend: string,
		width: number,
		height: number,
		renderMs: number,
		note?: string,
	): void {
		const change = layerPerformanceChange(stateRevision, false);
		if (stateRevision !== change.latestRevision) { return; }
		change.backend = backend;
		change.nativeWidth = width;
		change.nativeHeight = height;
		change.nativeMs = renderMs;
		change.nativeRevision = stateRevision;
		change.nativeNote = note;
		emitLayerPerformanceChange(change);
	}

	function emitLayerPerformanceChange(change: LayerPerformanceChange): void {
		if (change.emitted || !change.settled || change.nativeWidth <= 0 ||
			change.nativeRevision !== change.latestRevision) { return; }
		change.emitted = true;
		const preview = change.previewCount > 0
			? `${change.previewCount}× ${change.previewWidth}×${change.previewHeight}, last ${change.previewLastMs.toFixed(1)}ms` +
				(change.previewCount > 1 ? `, max ${change.previewMaxMs.toFixed(1)}ms` : '')
			: `skipped${change.previewSkipped ? ` (${change.previewSkipped})` : ''}`;
		logToOutput(
			`[LayerCompositor] ${change.backend} change | preview=${preview} | ` +
			`native=${change.nativeWidth}×${change.nativeHeight} ${change.nativeMs.toFixed(1)}ms` +
			`${change.nativeNote ? ` | ${change.nativeNote}` : ''}`,
		);
		for (const [revision, id] of _layerRevisionPerformanceChange) {
			if (id === change.id) { _layerRevisionPerformanceChange.delete(revision); }
		}
		_layerPerformanceChanges.delete(change.id);
	}

	function markLayerPreviewDisplayed(stateRevision: number, displayedAt: number): void {
		_layerPreviewRequested.delete(stateRevision);
		_layerPreviewDisplayedAt.set(stateRevision, displayedAt);
		if (_nativeAfterPreviewRevision !== stateRevision) { return; }
		_nativeAfterPreviewRevision = null;
		// Queue native work for the following animation frame so the browser can
		// actually present the reduced result first, including for direct clicks
		// that produce input and pointerup in the same frame.
		scheduleRecomposite(0, false, stateRevision);
	}

	function scheduleNativeAfterPreview(stateRevision: number): void {
		if (_interactiveRecompositeTimer) {
			clearTimeout(_interactiveRecompositeTimer);
			_interactiveRecompositeTimer = null;
		}
		if (_layerNativeRequested.has(stateRevision) || _layerNativeDisplayed.has(stateRevision)) {
			_nativeAfterPreviewRevision = null;
			return;
		}
		if (_layerPreviewRequested.has(stateRevision) && !_layerPreviewDisplayedAt.has(stateRevision)) {
			_nativeAfterPreviewRevision = stateRevision;
			return;
		}
		_nativeAfterPreviewRevision = null;
		scheduleRecomposite(0, false, stateRevision);
	}

	function schedulePreviewThenNative(stateRevision: number, nativeDelayMs: number): void {
		if (!_layerRevisionPerformanceChange.has(stateRevision)) {
			registerLayerPerformanceRevision(stateRevision, false);
		}
		if (!shouldUseLayerInteractionPreview(layerManager.canvasWidth, layerManager.canvasHeight)) {
			layerPerformanceChange(stateRevision, false).previewSkipped = 'document ≤1500px';
			scheduleRecomposite(0, false, stateRevision);
			return;
		}
		scheduleRecomposite(0, true, stateRevision);
		scheduleRecomposite(nativeDelayMs, false, stateRevision);
	}

	function markLayerNativeDisplayed(stateRevision: number): void {
		_layerNativeRequested.delete(stateRevision);
		_layerNativeDisplayed.add(stateRevision);
	}

	function scheduleRecomposite(delayMs: number = 0, interactive = false, stateRevision = _layerStateRevision) {
		if (!_layerRevisionStartedAt.has(stateRevision)) {
			_layerRevisionStartedAt.set(stateRevision, performance.now());
			for (const revision of _layerRevisionStartedAt.keys()) {
				if (revision < stateRevision - 2) {
					_layerRevisionStartedAt.delete(revision);
					_layerPreviewDisplayedAt.delete(revision);
					_layerPreviewRequested.delete(revision);
					_layerNativeRequested.delete(revision);
					_layerNativeDisplayed.delete(revision);
				}
			}
		}
		if (delayMs > 0) {
			if (_interactiveRecompositeTimer) { clearTimeout(_interactiveRecompositeTimer); }
			_interactiveRecompositeTimer = setTimeout(() => {
				_interactiveRecompositeTimer = null;
				scheduleRecomposite(0, interactive, stateRevision);
			}, delayMs);
			return;
		}
		if (interactive) { _layerPreviewRequested.add(stateRevision); }
		else { _layerNativeRequested.add(stateRevision); }
		if (_interactiveRecompositeTimer && !interactive) {
			clearTimeout(_interactiveRecompositeTimer);
			_interactiveRecompositeTimer = null;
		}
		if (_recompositeScheduled) {
			// A full render subsumes an interactive preview in the same frame.
			if (!interactive) { _scheduledInteractive = false; }
			_scheduledStateRevision = stateRevision;
			return;
		}
		_recompositeScheduled = true;
		_scheduledInteractive = interactive;
		_scheduledStateRevision = stateRevision;
		requestAnimationFrame(() => {
			_recompositeScheduled = false;
			const renderInteractive = _scheduledInteractive;
			const renderStateRevision = _scheduledStateRevision;
			_scheduledInteractive = false;
			recompositeLayers(renderInteractive, renderStateRevision);
		});
	}

	// ---- Layer restore after a webview reload (tab switch) ----
	let _layersRestoreDone = false;
	// True once the dedicated Layers window has auto-opened its panel.
	let _layerSurfaceShown = false;

	/** Kick off layer-stack restore once the base image has loaded. */
	function maybeRestoreLayers() {
		if (_layersRestoreDone || !_pendingLayerRestore) { return; }

		const metas = _pendingLayerRestore.layers || [];
		const restoresSourceDocument = metas.some(meta => !!meta.sourceNodeId);
		if (restoresSourceDocument && layeredPreviewProcessor.hasDeferredLayersPending() &&
			!layeredPreviewProcessor._lastRaw?.layerAssets?.length) {
			return;
		}
		_layersRestoreDone = true;
		const baseMeta = metas.find(m => m.isBase);
		const currentUri = settingsManager.settings.resourceUri;
		// Only restore if the saved stack belongs to the image now showing.
		const savedDocumentUri = _pendingLayerRestore.documentUri || baseMeta?.resourceUri;
		if (savedDocumentUri && currentUri && savedDocumentUri !== currentUri) {
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

		const restoresSourceDocument = pending.layers.some(meta => !!meta.sourceNodeId) &&
			!!layeredPreviewProcessor._lastRaw?.layerAssets?.length;
		if (restoresSourceDocument) {
			installLayeredDocumentLayers();
		} else {
			syncBaseLayer();
		}
		const baseLayer = layerManager.layers.find(l => l.id === _layerBaseId) ||
			layerManager.layers.find(l => l.uri === settingsManager.settings.resourceUri) ||
			layerManager.layers[0];
		const sourceLayers = new Map<string, typeof layerManager.layers>();
		for (const layer of layerManager.layers) {
			if (!layer.sourceNodeId) { continue; }
			const matches = sourceLayers.get(layer.sourceNodeId) || [];
			matches.push(layer);
			sourceLayers.set(layer.sourceNodeId, matches);
		}
		const rebuilt: typeof layerManager.layers = [];
		const restoredIds = new Map<string, string>();
		const applyMeta = (layer: typeof layerManager.layers[number], meta: any) => {
			Object.assign(layer, {
				name: meta.name ?? layer.name,
				offsetX: meta.offsetX ?? layer.offsetX ?? 0,
				offsetY: meta.offsetY ?? layer.offsetY ?? 0,
				opacity: meta.opacity ?? layer.opacity ?? 1,
				blendMode: meta.blendMode ?? layer.blendMode ?? 'normal',
				visible: meta.visible !== false,
				maskCondition: meta.maskCondition,
				kind: meta.kind ?? layer.kind,
				adjustment: meta.adjustment ?? layer.adjustment,
				parentId: meta.parentId,
				clipped: meta.clipped,
				groupPath: meta.groupPath ?? layer.groupPath,
				groupIds: meta.groupIds ?? layer.groupIds,
				sourceNodeId: meta.sourceNodeId ?? layer.sourceNodeId,
				sourceSupport: meta.sourceSupport ?? layer.sourceSupport,
				sourceBlendMode: meta.sourceBlendMode ?? layer.sourceBlendMode,
				sourceNumericType: meta.sourceNumericType ?? layer.sourceNumericType,
			});
			if (meta.id && layer.id) { restoredIds.set(meta.id, layer.id); }
			return layer;
		};
		for (const meta of pending.layers) {
			if (meta.sourceNodeId) {
				const matches = sourceLayers.get(meta.sourceNodeId);
				const source = matches?.shift();
				if (source) {
					rebuilt.push(applyMeta(source, meta));
				} else {
					// A duplicated imported node shares its decoded pixels with the
					// original and can be recreated without embedding them in state.
					const template = layerManager.layers.find(l => l.sourceNodeId === meta.sourceNodeId);
					if (template) {
						rebuilt.push(applyMeta(layerManager.createLayer({
							...template,
							isFloat: template.isFloat ?? false,
							typeMax: template.typeMax ?? 255,
							channels: template.channels ?? 4,
						}, meta), meta));
					}
				}
			} else if (meta.isBase) {
				if (baseLayer) {
					rebuilt.push(applyMeta(baseLayer, meta));
					_layerBaseId = baseLayer.id;
				}
			} else {
				if (meta.kind === 'adjustment' && meta.adjustment) {
					const adjustment = layerManager.createLayer({
						width: 1, height: 1, channels: 4, isFloat: false, typeMax: baseLayer?.typeMax || 255,
						name: meta.name || 'Adjustment', kind: 'adjustment', adjustment: meta.adjustment,
						parentId: meta.parentId, clipped: meta.clipped, groupPath: meta.groupPath, groupIds: meta.groupIds,
					}, meta);
					rebuilt.push(applyMeta(adjustment, meta));
					continue;
				}
				const src = uriMap[meta.resourceUri];
				if (!src) { continue; }
				const input = await decodeLayer(src, meta.resourceUri);
				if (input) { rebuilt.push(applyMeta(layerManager.createLayer(input, meta), meta)); }
			}
		}
		// createLayer assigns fresh IDs. Reconnect filters and groups to those new
		// IDs after every node has been rebuilt.
		for (const layer of rebuilt) {
			if (layer.parentId && restoredIds.has(layer.parentId)) {
				layer.parentId = restoredIds.get(layer.parentId);
			}
		}
		if (rebuilt.length === 0) {
			if (baseLayer) { rebuilt.push(baseLayer); } else { return; }
		}
		layerManager.setLayers(rebuilt, layerManager.canvasWidth, layerManager.canvasHeight);
		layersPanel.collapsed = !!pending.collapsed;
		if (pending.active || settingsManager.settings.surfaceMode === 'layers') {
			if (settingsManager.settings.surfaceMode === 'layers') { _layerSurfaceShown = true; }
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
			layerManager.beginHistoryGroup();
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
				layerManager.endHistoryGroup();
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
		if (datasetRequestInFlight) { datasetRequestSettled(); }
	}

	function getDisplayedImageElement(): HTMLElement | null {
		for (const child of Array.from(container.children)) {
			if (child instanceof HTMLElement && !isOverlayChrome(child) && (child.tagName === 'IMG' || child.tagName === 'CANVAS'
				|| child.classList.contains('pyramid-scene'))) {
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
			// The loading signal is a pulsing dot drawn ahead of the ‹ button by
			// CSS, laid out so it takes no width and nothing shifts. Putting a
			// "Loading" word or an inline dot in the counter itself re-centred the
			// position mid-switch, so it visibly jumped sideways and back.
			// The state stays announced through aria-label for screen readers.
			counter.textContent = position;
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
	async function handleVSCodeMessage(message: HostToViewerMessage) {
		switch (message.type) {
			case 'requestDepthPlane': {
				try {
					if (!document.body.classList.contains('ready') || planeLoadInFlight || datasetLoading) throw new Error('Wait for the selected image to finish loading before opening it as a point cloud.');
					if (layerManager.active || settingsManager.settings.surfaceMode === 'layers' || isShowingPeer) throw new Error('Open the depth image in its own image view before converting it to a point cloud.');
					vscode.postMessage({ type: 'depthPlaneResult', id: message.id, bytes: encodeDepthPlane(getActiveImage()) });
				} catch (error) {
					vscode.postMessage({ type: 'depthPlaneResult', id: message.id, error: error instanceof Error ? error.message : String(error) });
				}
				break;
			}
			case 'automationRequest': {
				try {
					const deadline=performance.now()+14000;
					while (_imageTransitionActive || !document.body.classList.contains('ready')) {
						if (performance.now()>deadline) throw new Error('Image is still loading; retry inspection after decoding completes');
						await new Promise(resolve=>setTimeout(resolve,25));
					}
					const { args } = parseAutomationRequest(message);
					let result: unknown;
					if (message.operation === 'display') {
						await handleVSCodeMessage({type:'updateSettings',settings:args.settings,reason:'python-api'});
						if (args.zoom !== undefined) await handleVSCodeMessage({type:'setScale',scale:args.zoom});
						result = {applied:true};
					} else if (message.operation === 'capture') {
						const target = document.createElement('canvas');
						const source = imageElement as HTMLCanvasElement | HTMLImageElement | null;
						if (!source) throw new Error('No rendered image is available');
						target.width = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
						target.height = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
						if (target.width * target.height > 16000000) throw new Error('Capture exceeds 16 megapixels; select a smaller image or preview');
						if (layerManager.active && layerManager.hasCompositeStack()) {
							const rendered = await renderedExportImage();
							if (!rendered) throw new Error('No rendered layer image is available');
							target.width=rendered.width;target.height=rendered.height;
							if (target.width * target.height > 16000000) throw new Error('Layer capture exceeds 16 megapixels');
							target.getContext('2d')!.putImageData(rendered,0,0);
						} else target.getContext('2d')!.drawImage(source,0,0);
						const png = target.toDataURL('image/png').split(',')[1];
						if (png.length > 24*1024*1024) throw new Error('Compressed capture exceeds 24 MiB');
						result={png,width:target.width,height:target.height};
					} else if (message.operation === 'region') {
						const source=getMeasurementSource();
						if (!source || ![args.x,args.y,args.width,args.height].every(Number.isInteger) || args.x<0 || args.y<0 || args.width<1 || args.height<1 || args.x+args.width>source.width || args.y+args.height>source.height) throw new Error('Rectangle is outside the decoded image');
						const id=crypto.randomUUID();
						roiManager.add({kind:'rect',id,name:args.name||'API region',source:'manual',x:args.x,y:args.y,width:args.width,height:args.height});
						measurePanel.refresh();
						result={roiId:id,rows:measurePanel.results.getRows().filter(row=>row.roiId===id),calibration:measureCalibration};
					} else if (message.operation === 'measurements') {
						measurePanel.refresh();
						result={rois:serializeRoisForState(roiManager.list()),rows:measurePanel.results.getRows(),calibration:measureCalibration};
					} else {
						const source=getMeasurementSource();
						if (!source) throw new Error('Original pixel data is not available for this image or preview');
						if (message.operation === 'pixel') {
							if (!Number.isInteger(args.x)||!Number.isInteger(args.y)||args.x<0||args.y<0||args.x>=source.width||args.y>=source.height) throw new Error('Pixel coordinates are outside the decoded image');
							result={x:args.x,y:args.y,values:Array.from({length:source.channels},(_,channel)=>sampleAt(source,args.x,args.y,channel)),coordinateSpace:'decoded-image'};
						} else if (message.operation === 'inspect') result={width:source.width,height:source.height,channels:source.channels,isFloat:source.isFloat,typeMax:source.typeMax,settings:settingsManager.settings};
						else throw new Error('Unknown image operation');
					}
					vscode.postMessage({type:'automationResult',id:message.id,result});
				} catch (error) { vscode.postMessage({type:'automationResult',id:message.id,error:error instanceof Error?error.message:String(error)}); }
				break;
			}
			case 'clearImage': {
				navigation.clear();
				signalTiffCanvasReady();
				invalidatePyramidViewport();
				if (_levelRefineTimer !== null) { clearTimeout(_levelRefineTimer); _levelRefineTimer = null; }
				for (const processor of allProcessors) { processor._pendingRenderData = null; }
				_pyramidScene?.dispose();
				_pyramidScene = null;
				removeDetailPatch();
				_pyramidPatchRegion = null;
				hasLoadedImage = false;
				zoomController.hasLoadedImage = false;
				zoomController.imageElement = null;
				zoomController.canvas = null;
				zoomController.scale = 'fit';
				mouseHandler.imageElement = null;
				mouseHandler.setStoredValueResolver(null);
				canvas = null;
				imageElement = null;
				primaryImageData = null;
				_pendingZoomState = null;
				_pendingZoomStateExplicit = false;
				for (const element of Array.from(container.children)) {
					if (element instanceof HTMLElement && !isOverlayChrome(element)
						&& (element.tagName === 'IMG' || element.tagName === 'CANVAS' || element.classList.contains('pyramid-scene'))) { element.remove(); }
				}
				finishSeamlessImageTransition();
				disposeWebglRenderers();
				hideNavOverlay();
				container.classList.remove('ready', 'loading', 'error', 'web-image-zoomed');
				window.scrollTo(0, 0);
				break;
			}
			case 'setScale':
				zoomController.updateScale(message.scale);
				break;

			case 'addLayerImages': {
				const layerGeneration = navigation.generation;
				// A visible outgoing frame does not mean the new source is ready.
				if (!await navigation.waitUntilReady(layerGeneration)) break;
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
					if (_layerCompositorSelection === 'auto') {
						void selectAutomaticLayerBackend(true);
					}
				}
				PerfTrace.mark('layers-panel-show');
				let addedLayers = 0;
				for (const im of images) {
					const layer = await decodeLayer(im.src, im.resourceUri);
					if (layerGeneration !== navigation.generation) break;
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

			case 'getLayerExportCompatibility':
				const layerWriter = layerManager.hasCompositeStack() ? await loadLayerWriter() : null;
				vscode.postMessage({
					type: 'didGetLayerExportCompatibility',
					options: layerManager.hasCompositeStack()
						? layerWriter!.analyzeLayerExports(layerManager.layers)
						: [{ format: 'png', label: 'PNG', description: '✓ Rendered image', detail: 'Exports exactly the current rendered image.', compatible: true }],
				});
				break;

			case 'exportLayerDocument':
				exportLayerDocument(message.format as LayerExportFormat);
				break;

			case 'start-comparison':
				handleStartComparison(message.peerUri);
				break;

			case 'copyImage':
				copyImage();
				break;

			case 'showContextMenu':
				document.dispatchEvent(new MouseEvent('contextmenu', {
					bubbles: true,
					cancelable: true,
					clientX: Number(message.x || 8),
					clientY: Number(message.y || 8),
				}));
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
				zoomController.applyInteractionSettings();
				if (message.settings && 'channelDefaults' in message.settings) {
					applyChannelGroups(message.settings.channelDefaults?.groups);
				}
				if (navigationView) {
					navigationModel = { ...navigationModel, hints: navKeyHints(navControls) };
					navigationView.update(navigationModel);
				}
				const updateApplyDuration = performance.now() - updateApplyStart;
				const newResourceUri = settingsManager.settings.resourceUri;
				// The scale bar is a SESSION preference held by the host, so it
				// is applied on every settings message — including the first one
				// a freshly created webview receives. Without that, turning it
				// off only lasted until the next preview was built.
				if (typeof message.settings?.showScaleBar === 'boolean') {
					roiOverlay.setShowScaleBar(message.settings.showScaleBar);
				}
				// A hole over the editor background is nearly indistinguishable
				// from a black pixel in a dark theme, which would make the
				// transparent choice look like it did nothing. The checkerboard
				// is the conventional way to say "there is nothing here"; it is
				// applied only in that mode, so no other image changes
				// appearance, and the Layers background override still wins.
				container.toggleAttribute('data-no-value-transparent', nanIsTransparent(settingsManager.settings));
				const updateReason = message.reason || (message.isInitialRender ? 'initial-render' : 'unspecified');
				if (changes.changedKeys.includes('gpuAcceleration')) {
					if (_layerCompositorSelection === 'auto') {
						// Select before the settings rerender below so an automatic
						// Layers view cannot keep using a now-disabled GPU backend.
						coldResetLayerCompositorBackends();
						await selectAutomaticLayerBackend(false, true);
					}
				}

				// formatInfo is posted from inside load(), before handleTiff()
				// receives and installs its canvas. Do not drop the immediate
				// initial-settings response while that canvas is still in flight.
				if (message.isInitialRender && currentLoadFormat === 'TIFF' && !canvas) {
					const waitingGeneration = navigation.generation;
					const canvasWaitStart = performance.now();
					await _tiffCanvasReadyPromise;
					PerfTrace.detail('await-settings-tiff-canvas-wait', performance.now() - canvasWaitStart);
					if (waitingGeneration !== navigation.generation) {
						break;
					}
				}

				// Check if this is a deferred render trigger (initial load)
				if (message.isInitialRender && canvas) {
					const renderGeneration = navigation.generation;
					// Time between formatInfo going out and per-format settings
					// coming back — extension-host latency, not main-thread work.
					if (lastFormatInfoPost && lastFormatInfoPost.generation === navigation.generation) {
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
						deferredCanvasAlreadyRendered = tiffProcessor._lastRenderUsedWebGL === true
							|| tiffProcessor.isProgressiveRemoteBase;
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
					}

					if (renderGeneration !== navigation.generation) { break; }
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
						const cziScene = currentLoadFormat === 'CZI' && cziProcessor?.isScene;
						if (currentLoadFormat === 'TIFF' || cziScene) {
							installPyramidSceneIfNeeded();
							configureTiffMouseReadout();
						}
						finalizeImageSetup();
						if (currentLoadFormat === 'TIFF') {
							updateTiffPageOverlay();
							void updateDetailPatch();
						} else if (cziScene) {
							void updateDetailPatch();
						}
						// Deferred render is done — clear loading indicators now
						clearCollectionLoadingState();

						// Log deferred render completion (only if we actually rendered deferred data)
						if (initialLoadStartTime > 0) {
							const endTime = performance.now();
							const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
							const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
							logLoadPerformance(`${currentLoadFormat}`, webviewTime, totalTime);
							initialLoadStartTime = 0; // Reset
						}
					} else if (pngProcessor.hasLazyNativeReadback()) {
						if (!pngProcessor.canUseLazyNativeCanvasForSettings(settingsManager.settings)) {
							await updateImageWithNewSettings();
						}
						finalizeImageSetup();
						clearCollectionLoadingState();
						if (initialLoadStartTime > 0) {
							const endTime = performance.now();
							const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
							const totalTime = extensionLoadStartTime ? (Date.now() - extensionLoadStartTime) : webviewTime;
							logLoadPerformance(`${currentLoadFormat}`, webviewTime, totalTime);
							initialLoadStartTime = 0;
						}
					}
				}
				// If resource URI changed, reload the entire image.
				// Guard with hasLoadedImage: if a collection switch is already in flight
				// (hasLoadedImage=false), a stale sendSettingsUpdate from the extension
				// can carry a different resourceUri — don't let it hijack the in-progress load.
				else if (oldResourceUri !== newResourceUri && hasLoadedImage) {
					// The cached demosaic belongs to the outgoing image; drop it so
					// a full-resolution buffer is not held alive across the switch.
					invalidateDebayerCache();
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
						scientificProcessors.some(processor => !!processor._pendingRenderData);

					if (hasLoadedImage && !hasPendingRender && changes.changed) {
						const startTime = performance.now();
						await updateImageWithNewSettings();
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
				resetDatasetNavigation();
				_pendingZoomStateExplicit = !!message.zoomState;
				if (Number.isFinite(Number(message.loadStartTime))) {
					extensionLoadStartTime = Number(message.loadStartTime);
				}
				// The target position travels with the switch so the loading badge never
				// flashes the outgoing image number before the separate overlay update.
				if (message.collection) {
					imageCollection = message.collection;
				}
				// Prefer zoom state injected by the extension (set before the webview
				// reloaded, so it's always accurate). Fall back to live state on the
				// first switch in a rapid in-session burst.
				if (message.zoomState?.scale === 'fit') {
					// Opening a newly supplied image is a fresh view. This explicit reset
					// wins even if another switch had already captured an outgoing zoom.
					_pendingZoomState = { scale: 'fit', x: 0, y: 0 };
				} else if (_pendingZoomState === null) {
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
				if (message.source) { offerPushedSource(message.uri, message.source.token, message.source.size, message.source.mtime); }
				switchToNewImage(message.uri, message.resourceUri, {
					formatHint: message.formatHint,
				});
				break;

			case 'switchToDatasetPlane':
				// A newer slider position is waiting: keep showing it on the controls.
				if (!pendingDatasetRequest) {
					datasetSeriesIndex = Number(message.seriesIndex || 0);
					datasetCoordinates = { ...(message.coordinates || {}) };
				}
				datasetLoading = true;
				updateDatasetOverlay(true);
				// The step started here, not at the host's original open: time it from
				// switchToNewImage instead of reporting the time since the file opened.
				extensionLoadStartTime = 0;
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

			case 'toggleScaleBar': {
				// The host owns the flag for the session; honour what it sends
				// and only fall back to a local flip for older messages.
				const shown = typeof message.shown === 'boolean'
					? (roiOverlay.setShowScaleBar(message.shown), message.shown)
					: roiOverlay.toggleScaleBar();
				// An uncalibrated image draws nothing either way, so without this the
				// command looks broken on the files where it is least obvious why.
				if (shown && measureCalibration.origin === 'none') {
					vscode.postMessage({
						type: 'showMessage',
						level: 'info',
						message: 'This image carries no physical pixel size, so no scale bar can be drawn. Set the scale in the Measure panel.',
					});
				}
				break;
			}

			case 'toggleChannels':
				if (!hasCompositableChannels()) {
					// Say so rather than opening a panel with one row in it.
					console.log('[Channels] This image has a single channel.');
				}
				channelsPanel.toggle();
				break;

			case 'toggleMeasure':
				measurePanel.toggle();
				vscode.postMessage({
					type: 'measureVisibilityChanged',
					isVisible: measurePanel.isVisible(),
				});
				break;

			case 'measureHint':
				measurePanel.setHint(String(message.text || ''));
				break;

			case 'measureImportResult': {
				// Bytes cross the message boundary as a plain array; postMessage
				// cannot transfer a typed array to a webview.
				const bytes = new Uint8Array(message.bytes || []);
				if (message.kind === 'imagej') {
					const imported = (await loadImagejRoi()).importImageJRois(bytes, message.fileName || 'RoiSet');
					if (imported.length === 0) {
						measurePanel.setHint('No ROIs could be read from that file.');
					} else {
						roiManager.addMany(imported.map(entry => entry.roi), { select: false });
						const notes = imported.flatMap(entry => entry.notes);
						measurePanel.setHint(notes.length > 0
							? `Imported ${imported.length} ROIs. ${notes[0]}`
							: `Imported ${imported.length} ROIs from ImageJ.`);
					}
				} else {
					// An automatic load must never discard work. If anything is
					// already drawn, the sidecar is ignored and only mentioned —
					// the user can still load it deliberately from the ROIs tab.
					if (message.automatic && roiManager.count() > 0) {
						measurePanel.setHint('This image has a saved ROI file. Load it from the ROIs tab to replace what is on screen.');
						break;
					}
					const parsed = parseSidecar(new TextDecoder().decode(bytes));
					if (parsed.rois.length > 0) { roiManager.replaceAll(parsed.rois); }
					// A stored calibration is authoritative for those ROIs; adopting
					// it keeps reloaded measurements identical to the saved ones.
					if (parsed.calibration) {
						measureCalibration = { ...parsed.calibration, origin: 'imported' };
					}
					measurePanel.applyLoadedDerivedColumns(parsed.derivedColumns, parsed.columns);
					measurePanel.setHint(parsed.warnings.length > 0
						? parsed.warnings[0]
						: `Loaded ${parsed.rois.length} ROIs${message.automatic ? ' saved next to this image' : ''}.`);
				}
				measurePanel.refresh();
				break;
			}

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

			case 'sourceChunk':
				// Read by the bootstrap script in the webview HTML, or pushed-source.ts.
				break;

			case 'prefetchSource':
				offerPrefetch(message.uri, message.token, message.size, message.mtime);
				// Already idle: the current image finished before the offer arrived.
				if (!_imageTransitionActive && document.body.classList.contains('ready')) { startPrefetch(); }
				break;

			case 'toggleDebayer':
				// Open/close the debayer control panel. Opening it on a
				// single-channel image turns the mode on straight away, so the
				// command produces a visible result instead of an inert panel.
				debayerPanel.toggle();
				if (debayerPanel.isVisible() && !settingsManager.settings.debayer?.enabled) {
					// Safe to enable unconditionally: shouldDebayer() ignores the
					// setting for anything that is not single-channel, so this
					// cannot disturb an already-demosaiced image.
					const current = settingsManager.settings.debayer ?? DEFAULT_DEBAYER;
					debayerPanel.setSettings({ enabled: true });
					await handleDebayerSettingsChanged({ ...current, enabled: true });
				}
				break;
		}
	}

	/**
	 * Apply a debayer settings change and re-render.
	 *
	 * Mirrors handleSetDisplayColormap: the raw plane is untouched, the render
	 * path picks the new settings up, and the demosaic cache means only the
	 * parameters that actually affect interpolation cause recomputation.
	 */
	async function handleDebayerSettingsChanged(settings: DebayerSettings) {
		settingsManager.settings.debayer = settings;
		saveState();
		await updateImageWithNewSettings();
		// Auto WB resolves gains during the render; show the user what it picked.
		if (settings.autoWb) {
			const resolved = getLastDebayerGains();
			if (resolved) { debayerPanel.reportGains(resolved); }
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
		await updateImageWithNewSettings();
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
				fileFields['Metadata Convention'] = ome.metadataFormat === 'ImageJ' ? 'ImageJ' : 'OME';
				fileFields['Stack Dimensions'] = `C ${ome.planeSizeC} × Z ${ome.sizeZ} × T ${ome.sizeT}`;
				fileFields['Current Plane'] = `C ${coordinates.c + 1}, Z ${coordinates.z + 1}, T ${coordinates.t + 1} (IFD ${tiffProcessor.pageIndex})`;
				fileFields['Dimension Order'] = ome.dimensionOrder;
				if (ome.imageName) { fileFields['Image Name'] = ome.imageName; }
				if (ome.pixelType) { fileFields['Pixel Type'] = ome.pixelType; }
				if (ome.channels.length) { fileFields['Channel Names'] = ome.channels.map((channel: any) => channel.name).join(', '); }
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
		if (layerManager.active) {
			fileFields['Renderer'] = _layerCompositorBackend === 'gpu' ? 'WebGL2' :
				_layerCompositorBackend === 'webgpu' ? 'WebGPU' :
					_layerCompositorBackend === 'wasm' ? 'Rust/Wasm' : 'JavaScript';
		} else {
			const activeProcessor = currentLoadFormat === 'TIFF' ? tiffProcessor :
				currentLoadFormat === 'EXR' ? exrProcessor :
					currentLoadFormat === 'PFM' ? pfmProcessor :
						currentLoadFormat === 'PPM/PGM' ? ppmProcessor :
							currentLoadFormat === 'PNG/JPEG' ? pngProcessor :
								currentLoadFormat === 'NPY/NPZ' ? npyProcessor :
									currentLoadFormat === 'HDR' ? hdrProcessor :
										currentLoadFormat === 'TGA' ? tgaProcessor :
											currentLoadFormat === 'JPEG XL' ? jxlProcessor :
												currentLoadFormat === 'FITS' ? fitsProcessor :
													currentLoadFormat === 'DICOM' ? dicomProcessor :
														currentLoadFormat === 'NetCDF' ? netcdfProcessor :
							currentLoadFormat === 'CZI' ? cziProcessor :
							currentLoadFormat === 'ND2' ? nd2Processor :
							currentLoadFormat === 'LIF' ? lifProcessor :
							currentLoadFormat === 'SGI RGB' ? sgiProcessor :
							currentLoadFormat === 'SDT' ? sdtProcessor :
															currentLoadFormat === 'Layered Document' ? layeredPreviewProcessor :
																webImageProcessor;
			const processorUsedWebGl = (activeProcessor as any)?._lastRenderUsedWebGL === true;
			_normalRenderBackend = processorUsedWebGl ? 'webgl2' : 'cpu';
			fileFields['Renderer'] = _normalRenderBackend === 'webgl2' ? 'WebGL2' : 'CPU';
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
	 * Refresh the Layers histogram from the rendered composite. This deliberately
	 * starts with the visibility check: when the histogram is closed, layer edits
	 * allocate nothing, read back nothing, and schedule no work. When visible, a
	 * capped downsample keeps the readback bounded while still tracking every
	 * compositor backend and every layer edit.
	 */
	function scheduleLayerHistogramRefresh(stateRevision = _layerStateRevision, interactive = false) {
		if (!histogramOverlay.getVisibility() || !layerManager.active || !canvas) {
			return;
		}
		if (_layerHistogramTimer !== null) {
			clearTimeout(_layerHistogramTimer);
		}
		_layerHistogramTimer = window.setTimeout(() => {
			_layerHistogramTimer = null;
			if (!histogramOverlay.getVisibility() || !layerManager.active ||
				stateRevision !== _layerStateRevision || !canvas) {
				return;
			}
			const sourceWidth = canvas.width;
			const sourceHeight = canvas.height;
			if (sourceWidth < 1 || sourceHeight < 1) { return; }
			const maxPixels = 262_144;
			const scale = Math.min(1, Math.sqrt(maxPixels / (sourceWidth * sourceHeight)));
			const width = Math.max(1, Math.round(sourceWidth * scale));
			const height = Math.max(1, Math.round(sourceHeight * scale));
			_layerHistogramCanvas ||= document.createElement('canvas');
			if (_layerHistogramCanvas.width !== width) { _layerHistogramCanvas.width = width; }
			if (_layerHistogramCanvas.height !== height) { _layerHistogramCanvas.height = height; }
			const ctx = _layerHistogramCanvas.getContext('2d', { willReadFrequently: true });
			if (!ctx) { return; }
			ctx.clearRect(0, 0, width, height);
			ctx.drawImage(canvas, 0, 0, width, height);
			const displayedComposite = ctx.getImageData(0, 0, width, height);
			PerfTrace.mark('histogram-layer-composite');
			histogramOverlay.update(displayedComposite, {
				settings: settingsManager.settings,
				sampleStep: 1,
			});
		}, interactive ? 80 : 0);
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
		if (layerManager.active && layerManager.hasCompositeStack()) {
			scheduleLayerHistogramRefresh();
			return;
		}
		try {
			if (_deferredHistogramTimer !== null) {
				clearTimeout(_deferredHistogramTimer);
				_deferredHistogramTimer = null;
			}
			const image = getActiveImage();
			const sampled = image?.sampleHistogram?.();
			if (sampled) {
				PerfTrace.mark('histogram-prepare');
				histogramOverlay.update(sampled, { settings: settingsManager.settings, sampleStep: 1 });
				return;
			}
			if (image?.histogram) {
				PerfTrace.mark('histogram-prepare');
				histogramOverlay.updateFromPrecomputed(image.histogram);
				PerfTrace.mark('histogram-from-render');
				return;
			}

			// In composite mode the histogram describes the channels, not the
			// rendered RGB: each has its own display range, and binning them on
			// one axis would flatten a dim channel into the leftmost few pixels.
			if (compositeEnabled && channelPlanes.length >= 2) {
				histogramOverlay.updateFromChannels(channelPlanes.map((plane, index) => ({
					name: plane.name,
					color: channelSettings[index]?.color || '#ffffff',
					min: channelSettings[index]?.min ?? 0,
					max: channelSettings[index]?.max ?? 1,
					visible: (channelSettings[index]?.visible ?? true)
						&& soloAllows(plane.index),
					data: plane.data,
				})));
				return;
			}
			histogramOverlay.clearChannelHistograms();

			const histogramOptions = { ...imageHistogram(image), settings: settingsManager.settings };

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
				const generation = navigation.generation;
				const runExact = () => {
					_deferredHistogramTimer = null;
					if (generation !== navigation.generation || !histogramOverlay.getVisibility()) { return; }
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
		decodedColormapSource.stats = stats;
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
			measurementSourceCache = null;
			scalarPlaneCache = null;
			measurePanel.onImageChanged();
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
	 */
	async function updateImageWithNewSettings() {
		const canRenderLazyPng = pngProcessor && pngProcessor.hasLazyNativeReadback();
		if (!canvas || (!primaryImageData && !canRenderLazyPng)) {
			return;
		}
		if (canRenderLazyPng && pngProcessor.canUseLazyNativeCanvasForSettings(settingsManager.settings)) {
			return;
		}

		// Channel compositing owns the canvas the same way the layer stack does:
		// the per-processor paths below would draw a single channel over it.
		// Checked first because a channel composite is the more specific mode.
		if (compositeEnabled && channelPlanes.length >= 2) {
			renderComposite();
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

		const processor = activeProcessor();
		if (!processor) return;
		const renderGeneration = navigation.generation;
		const renderCanvas = canvas;
		try {
			if (processor === tiffProcessor) {
				if (tiffProcessor.isProgressiveRemoteBase && _pyramidScene) {
					_pyramidScene.clearTiles();
					_pyramidScene.clearBase();
					_pyramidPatchRegion = null;
					invalidatePyramidViewport();
					void updatePyramidSceneTiles();
					return;
				}
				_pyramidScene?.clearTiles();
			}
			const newImageData = await processor.renderWithSettings({
				collectHistogram: histogramOverlay.getVisibility(),
				targetCanvas: renderCanvas,
				placeholderImageData: primaryImageData,
			});
			if (!newImageData || renderGeneration !== navigation.generation || canvas !== renderCanvas) return;
			if (processor._lastRenderUsedWebGL) {
				PerfTrace.mark('canvas-upload-skipped');
			} else {
				const ctx = ensure2dCanvasContext();
				if (!ctx) return;
				await renderImageDataToCanvas(newImageData, ctx);
				if (renderGeneration !== navigation.generation) return;
				if (processor === ppmProcessor || processor === pngProcessor) swapImageElementToCanvas();
			}
			primaryImageData = newImageData;
			updateHistogramData();
			if (processor === tiffProcessor) void updateDetailPatch();
		} catch (error) {
			console.error('Error updating image with new settings:', error);
		}
	}

	/**
	 * Setup additional event listeners
	 */
	function setupEventListeners() {
		installRangeDoubleClickReset(document);
		if (container.classList.contains('web-app')) {
			for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
				container.addEventListener(type, event => zoomController.handleGesture(event), { passive: false });
			}
		}
		for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
			container.addEventListener(type, event => zoomController.handleTouch(event as TouchEvent), { passive: false });
		}
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

			if (e.target === imageElement || e.target === container) {
				if (zoomController.beginPan(e, moved => { if (moved) { mouseHandler.consumeClick = true; } })) { return; }
			}

			if (e.button !== 0 || e.target !== imageElement) {
				return;
			}

			mouseHandler.consumeClick = !mouseHandler.isActive;
		});

		container.addEventListener('click', (e) => {
			if (!imageElement || !hasLoadedImage) {
				return;
			}

			// The website toolbar, status bar, and popovers live inside this body,
			// too. Only a click on the displayed pixels is an image zoom gesture.
			if (e.button !== 0 || e.target !== imageElement) {
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
			if (zoomController.scrollToZoom && e.detail > 1) { return; }

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

		container.addEventListener('dblclick', e => {
			if (layerManager.active && layersPanel.movingLayerId) { return; }
			zoomController.handleDoubleClick(e);
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

		const isEditableEventTarget = (target: EventTarget | null): boolean => {
			if (!(target instanceof HTMLElement)) { return false; }
			if (target.isContentEditable || target.closest('[contenteditable="true"]')) { return true; }
			// A control in the navigation overlay is never "typing", whatever
			// element it happens to be built from. A dropdown there is a plane
			// selector exactly like the sliders beside it, and treating it as a
			// text field meant that merely CLICKING it — even without choosing
			// anything — killed every navigation shortcut until focus moved
			// away. Range inputs were already excluded for the same reason.
			if (target.closest('.nav-overlay')) { return false; }
			if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) { return true; }
			if (!(target instanceof HTMLInputElement)) { return false; }
			return !['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit'].includes(target.type);
		};

		/**
		 * Keep keyboard focus off controls that do not need it.
		 *
		 * A focused range input or button consumes the arrow keys that drive
		 * plane, page and collection navigation, so a single click on a slider
		 * silently disabled every shortcut until the user clicked the image
		 * again. Blurring on release costs nothing: dragging is pointer-driven
		 * and has already finished by the time this runs.
		 *
		 * Text fields, dropdowns and contenteditable regions are left alone —
		 * they are useless without focus.
		 */
		document.addEventListener('pointerup', (e) => {
			const target = e.target;
			if (!(target instanceof HTMLElement)) { return; }
			if (isEditableEventTarget(target)) { return; }
			// Deliberately NOT selects. A native dropdown opens its popup on
			// pointerDOWN and keeps it open only while it holds focus, so
			// blurring on pointerUP shut the list again before it could be
			// used. A select gives up focus on `change` instead (below), and
			// its focus ring is suppressed in CSS.
			if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLButtonElement)) { return; }
			target.blur();
		}, true);

		// A dropdown needs focus while it is open, but not after a choice is
		// made, or its own arrow-key handling would keep swallowing navigation.
		document.addEventListener('change', (e) => {
			if (e.target instanceof HTMLSelectElement) { e.target.blur(); }
		}, true);

		// Copy handling
		document.addEventListener('copy', (e) => {
			if (isEditableEventTarget(e.target)) { return; }
			copyImage();
		});

		// Custom context menu with various commands
		document.addEventListener('contextmenu', (e) => {
			if (isEditableEventTarget(e.target)) { return; }
			e.preventDefault();

			const fileItems: MenuItem[] = [], displayItems: MenuItem[] = [], inspectItems: MenuItem[] = [], measureItems: MenuItem[] = [];
			const createMenuItem = (label: string, action: () => void): MenuItem => ({ label, action: () => { setTimeout(action, 0); } });

			// Add Copy option (triggers command via extension for logging)
			fileItems.push(createMenuItem('Copy Image and Position', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.copyImage' });
			}));

			// Add Paste Position option (uses extension command for cross-webview support)
			fileItems.push(createMenuItem('Paste Position', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.pastePosition' });
			}));

			// The unified exporter evaluates compatibility before choosing a format.
			fileItems.push(createMenuItem('Export…', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.exportLayers' });
			}));


			// Add Images to Collection option
			fileItems.push(createMenuItem('Add Images to Collection', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.browseAndAddToCollection' });
			}));


			// Add Toggle Histogram option (triggers command via extension for logging)
			inspectItems.push(createMenuItem('Toggle Histogram', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.toggleHistogram' });
			}));

			if (hasCompositableChannels()) {
				displayItems.push(createMenuItem(
					channelsPanel.isVisible() ? 'Close Channels Panel' : 'Channels…',
					() => { vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.toggleChannels' }); },
				));
			}

			// Measurement is one entry, not a submenu of eleven: the tools live
			// inside the panel, so the menu stays as short as it is today.
			measureItems.push(createMenuItem(
				measurePanel.isVisible() ? 'Close Measure Panel' : 'Measure…',
				() => { vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.toggleMeasure' }); },
			));

			// A scale-bar command is meaningful only after the current image has
			// supplied physical calibration (embedded metadata or Set Scale).
			if (measureCalibration.origin !== 'none') {
				measureItems.push(createMenuItem(
					roiOverlay.getShowScaleBar() ? 'Hide Scale Bar' : 'Show Scale Bar',
					() => { vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.toggleScaleBar' }); },
				));
				if (roiOverlay.hasCustomScaleBarPosition()) {
					measureItems.push(createMenuItem('Reset Scale Bar Position', () => roiOverlay.resetScaleBarPosition()));
				}
			}

			// Check if image is 8-bit uint RGB for interpretation options
			const isRgb8BitUint = currentFormatInfo &&
				(currentFormatInfo.samplesPerPixel ?? 0) >= 3 &&
				currentFormatInfo.bitsPerSample === 8 &&
				currentFormatInfo.sampleFormat !== 3; // Not float
			const isRgbImage = currentFormatInfo && (currentFormatInfo.samplesPerPixel ?? 0) >= 3;
			// Single-channel scalar image (or a decoded colormap): can be pseudocolored.
			const isSingleChannel = !!currentFormatInfo && (currentFormatInfo.samplesPerPixel ?? 1) <= 1;

			if (isRgb8BitUint) {

				const rgb24Active = settingsManager.settings.rgbAs24BitGrayscale || false;
				displayItems.push(createMenuItem(rgb24Active ? '✓ Interpret as 24-bit Grayscale' : 'Interpret as 24-bit Grayscale', () => {
					vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.toggleRgb24Mode' });
				}));
			}

			// "Apply Colormap" (pseudocolor): map a single-channel scalar to colors.
			if (isSingleChannel) {

				const activeColormap = settingsManager.settings.displayColormap;
				const hasColormap = activeColormap && activeColormap !== 'none';
				displayItems.push(createMenuItem(hasColormap ? `Apply Colormap… (${activeColormap})` : 'Apply Colormap…', () => {
					vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.applyColormap' });
				}));
				if (hasColormap) {
					displayItems.push(createMenuItem('Remove Colormap', () => {
						handleSetDisplayColormap('none');
					}));
				}
			}

			// "Decode Colormap to Float": recover a scalar from a colormapped RGB image.
			if (isRgbImage) {

				displayItems.push(createMenuItem('Decode Colormap to Float', () => {
					vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.convertColormapToFloat' });
				}));
			}

			// Show revert option if a colormap conversion has been applied
			if (hasAppliedConversion) {

				displayItems.push(createMenuItem('Revert to Original', () => {
					vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.revertToOriginal' });
				}));
			}


			// Layers compositing view
			fileItems.push(createMenuItem('Open Layers View', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.toggleLayers' });
			}));

			// Cycle how pixels with no value are drawn (black/fuchsia/transparent)
			const nextNanColor = nextNanColor_(settingsManager.settings.nanColor);
			displayItems.push(createMenuItem(`Show No-Value Pixels as ${nextNanColor}`, () => {
				vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.toggleNanColor' });
			}));

			// Add Toggle Color Picker Mode option - ONLY in Gamma Mode
			// In other modes, we always show original values
			const isGammaMode = settingsManager.settings.normalization && settingsManager.settings.normalization.gammaMode;
			if (isGammaMode && !layerManager.active) {
				const isShowingModified = settingsManager.settings.colorPickerShowModified || false;
				const nextColorMode = isShowingModified ? 'Original Values' : 'Modified Values';
				inspectItems.push(createMenuItem(`Color Picker: Show ${nextColorMode}`, () => {
					vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.toggleColorPickerMode' });
				}));
			}

			// Add Toggle Metadata Panel option
			inspectItems.push(createMenuItem('Toggle Metadata Panel', () => {
				vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.toggleMetadata' });
			}));

			// Open as Point Cloud — only when ply-visualizer is installed and format is supported
			const plyFormats = ['tiff-float', 'tiff-int', 'tiff-int-signed', 'tiff-int-wide', 'tiff-uint16', 'pfm', 'npy', 'npy-float', 'npy-uint', 'png'];
			if (settingsManager.settings.plyVisualizerInstalled && currentFormatInfo && plyFormats.includes(currentFormatInfo.formatType ?? '')) {
				fileItems.push(createMenuItem('Open as Point Cloud', () => {
					vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.openAsPointCloud' });
				}));
			}
			const items: MenuItem[] = [
				{ heading: true, label: 'Display' }, ...displayItems,
				{ heading: true, label: 'Inspect' }, ...inspectItems, ...measureItems,
				{ heading: true, label: 'File' }, ...fileItems,
			];

			openContextMenu(items, e.clientX, e.clientY);
		});

		// Prevent cut operation (only copy makes sense for image viewer)
		document.addEventListener('cut', (e) => {
			if (isEditableEventTarget(e.target)) { return; }
			e.preventDefault();
		});

		// Handle paste for position pasting (Ctrl+V / Cmd+V)
		// Uses extension command for cross-webview support
		document.addEventListener('paste', (e) => {
			if (isEditableEventTarget(e.target)) { return; }
			e.preventDefault();
			// Use extension command for cross-webview paste support
			vscode.postMessage({ type: 'executeCommand', command: 'tiffVisualizer.pastePosition' });
		});

		// Measurement shortcuts run before every other key handler, but only
		// while the panel is open — otherwise single letters like R and L would
		// shadow the existing collection and comparison shortcuts for users who
		// never opened it.
		document.addEventListener('keydown', (e) => {
			if (isEditableEventTarget(e.target)) { return; }
			if (measurePanel.handleKey(e)) {
				e.preventDefault();
				e.stopPropagation();
			}
		}, true);
		// The peek shortcut is held rather than toggled, so it needs the release.
		document.addEventListener('keyup', (e) => {
			if (measurePanel.handleKeyUp(e)) {
				e.preventDefault();
				e.stopPropagation();
			}
		}, true);

		// Comparison toggle
		document.addEventListener('keydown', async (e) => {
			if (e.key.toLowerCase() === 'c' && !e.metaKey && !e.ctrlKey && !e.altKey &&
				!isEditableEventTarget(e.target) && peerImageData) {
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
			// Ranges and buttons are inputs, but they are not text entry: treating
			// them as such let a focused slider suppress every navigation key.
			const isTyping = isEditableEventTarget(e.target);
			const isPlainKey = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
			const isRightArrow = e.key === 'ArrowRight' || e.code === 'ArrowRight';
			const isLeftArrow = e.key === 'ArrowLeft' || e.code === 'ArrowLeft';
			// Arrow keys: the shared control model owns them whenever the file
			// has navigable controls AND it is the only image open. A multi-image
			// collection keeps the arrows for switching files, which is the one
			// case where stepping between FILES outranks stepping within one.
			const collectionArrow = imageCollection.totalImages > 1 && isPlainKey && (isRightArrow || isLeftArrow);
			if (!isTyping && !collectionArrow) {
				navigationKeys.observe(e);
				// Physical bindings win over legacy symbols if a layout maps a
				// physical key to another row's old punctuation shortcut.
				for (const legacy of [false, true]) {
					for (let position = 0; position < Math.min(navControls.length, 4); position++) {
						const binding = navigationKeys.bindings(navControls, imageCollection.totalImages > 1)[position];
						if (binding < 0) continue;
						const delta = legacy ? navigationKeys.legacyStep(e, binding) : navigationKeys.step(e, binding);
						if (!delta) continue;
						e.preventDefault(); e.stopPropagation();
						stepNavControl(navControlAt(position), delta);
						return;
					}
				}
			}
			const logicalTiffPages = isPyramidal(tiffProcessor.pageDirectory)
				? imagePages(tiffProcessor.pageDirectory).length
				: tiffProcessor.pageCount;
			if (!isTyping && isPlainKey && (isRightArrow || isLeftArrow) &&
				(imageCollection.totalImages > 1 || (logicalTiffPages > 1 && navControls.length === 0))) {
				e.preventDefault();
				e.stopPropagation();
				if (imageCollection.totalImages > 1) {
					requestCollectionNavigation(isRightArrow ? 'next' : 'previous');
				} else {
					void navigateTiffPage(isRightArrow ? 1 : -1);
				}
				return;
			}
			if (!isTyping && tiffProcessor.pageCount > 1) {
				const delta = navigationKeys.step(e, 0) || navigationKeys.legacyStep(e, 0);
				if (delta) { e.preventDefault(); void navigateTiffPage(delta); }
			}
		}, true);

		// Window beforeunload
		window.addEventListener('beforeunload', () => {
			zoomController.saveState();
			coldResetLayerCompositorBackends();
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

	/**
	 * One shared model of "things the keyboard can step" for every format.
	 *
	 * DICOM, NetCDF, CZI, ND2, LIF and SDT all present the same two kinds of
	 * control: a DROPDOWN choosing among named datasets of differing shape
	 * (DICOM series, NetCDF variable, LIF series) and SLIDERS scrubbing
	 * homogeneous axes (Z, T, C, stage position). They used to bind keys three
	 * separate ways — DICOM gave the arrows to its primary axis and nothing to
	 * the rest, NetCDF bound nothing at all, microscopy used a positional
	 * scheme — so the same key did different things per format, or nothing.
	 *
	 * Now every overlay publishes its controls here in display order (dropdown
	 * first, then sliders) and the key assignment is derived from that order
	 * alone. Adding a format means publishing its controls; it does not mean
	 * touching the keyboard handler.
	 */
	interface NavControl {
		/** Shown in the row's hint cell. */
		readonly label: string;
		readonly size: number;
		readonly value: number;
		/** True when this control renders as a dropdown rather than a slider. */
		readonly isChoice?: boolean;
		/** Move to an absolute index; the overlay owns what that means. */
		readonly go: (index: number) => void;
	}
	let navControls: NavControl[] = [];

	/** Hints and key dispatch share the same available-binding order. */
	function navKeyHints(controls: readonly { isChoice?: boolean }[]): string[] {
		return navigationKeys.bindings(controls, imageCollection.totalImages > 1)
			.map(binding => binding < 0 ? '' : navigationKeys.hint(binding));
	}

	/** The control a given shortcut pair drives, if there is one. */
	function navControlAt(position: number): NavControl | undefined {
		const control = navControls[position];
		return control && control.size > 1 ? control : undefined;
	}

	/** Step a control by `delta`, wrapping, like every overlay already did. */
	function stepNavControl(control: NavControl | undefined, delta: number) {
		if (!control || control.size <= 1) { return; }
		const next = (control.value + delta + control.size) % control.size;
		control.go(next);
	}

	/**
	 * Make a floating overlay draggable by its body.
	 *
	 * The plane overlays sit over the image, so on a small window they cover
	 * the part being inspected. Dragging is bound on the overlay itself rather
	 * than a dedicated title bar — there is very little chrome to grab — but
	 * interactive children are excluded, otherwise starting a drag on a slider
	 * would fight the slider.
	 *
	 * The position is remembered per overlay class for the session, so stepping
	 * to another image does not send it back to the corner. It is also clamped
	 * back into view on resize, since a remembered position can end up off
	 * screen when the window shrinks.
	 */
	const overlayPositions = new Map<string, { x: number, y: number }>();
	function makeOverlayDraggable(overlay: HTMLElement, key: string, onTitleClick?: () => void) {
		let titleClickTimer: number | null = null;
		const clamp = (x: number, y: number) => {
			const rect = overlay.getBoundingClientRect();
			const maxX = Math.max(0, window.innerWidth - rect.width);
			const maxY = Math.max(0, window.innerHeight - rect.height);
			return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
		};
		const place = (x: number, y: number) => {
			// The overlay is centred with `transform: translateX(-50%)`. A
			// transform shifts what `getBoundingClientRect()` reports but NOT
			// what `style.left` means, so leaving it in place made the overlay
			// jump half its width on grab and then drift away from the pointer.
			// Once dragged, position is expressed purely as left/top.
			overlay.style.transform = 'none';
			const at = clamp(x, y);
			overlayPositions.set(key, at);
			overlay.style.left = `${at.x}px`;
			overlay.style.top = `${at.y}px`;
			overlay.style.right = 'auto';
			overlay.style.bottom = 'auto';
		};
		const remembered = overlayPositions.get(key);
		if (remembered) { place(remembered.x, remembered.y); }
		const restoreDefaultPosition = () => {
			overlayPositions.delete(key);
			// Let the stylesheet own the home position again. This deliberately
			// removes rather than hard-codes coordinates because the web app and
			// extension place the overlay at different default vertical offsets.
			for (const property of ['left', 'top', 'right', 'bottom', 'transform']) {
				overlay.style.removeProperty(property);
			}
		};

		// The container's zoom/pan handlers listen on `mousedown` and `click`,
		// which are SEPARATE from the pointer events used for dragging — so
		// stopping `pointerdown` alone still let every press reach the zoom
		// handler, and moving the overlay zoomed the image underneath it.
		for (const type of ['mousedown', 'click', 'dblclick', 'wheel'] as const) {
			onSvelteEvent(overlay, type, event => { event.stopPropagation(); });
		}
		overlay.addEventListener('dblclick', event => {
			const target = event.target as HTMLElement;
			// A double-click on the overlay chrome means “put this back”. Controls
			// keep their native double-click behaviour and never move the panel.
			if (target.closest('input, select, button, a, textarea')) { return; }
			event.preventDefault();
			if (titleClickTimer !== null) {
				window.clearTimeout(titleClickTimer);
				titleClickTimer = null;
			}
			restoreDefaultPosition();
		});
		onSvelteEvent(overlay, 'pointerdown', event => {
			const target = event.target as HTMLElement;
			event.stopPropagation();
			// Never hijack a control the user meant to operate.
			if (target.closest('input, select, button, a, textarea')) { return; }
			if (event.button !== 0) { return; }
			const titleClick = !!target.closest('.dataset-title');
			// Measure BEFORE neutralizing the transform so the grab point is
			// taken from the box the user actually sees, then re-anchor to that
			// same box so the first move does not teleport the overlay.
			const rect = overlay.getBoundingClientRect();
			const grabX = event.clientX - rect.left;
			const grabY = event.clientY - rect.top;
			const startX = event.clientX;
			const startY = event.clientY;
			let moved = false;
			let anchored = false;
			overlay.setPointerCapture(event.pointerId);
			const move = (e: PointerEvent) => {
				if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) { return; }
				moved = true;
				if (!anchored) {
					place(rect.left, rect.top);
					overlay.classList.add('dataset-overlay--dragging');
					anchored = true;
				}
				place(e.clientX - grabX, e.clientY - grabY);
			};
			const up = (endEvent: PointerEvent) => {
				overlay.classList.remove('dataset-overlay--dragging');
				overlay.removeEventListener('pointermove', move);
				overlay.removeEventListener('pointerup', up);
				overlay.removeEventListener('pointercancel', up);
				if (endEvent.type === 'pointerup' && !moved && titleClick && onTitleClick) {
					// Wait briefly so a double-click can retain its established meaning:
					// reset the panel position without also changing its compact state.
					if (titleClickTimer !== null) { window.clearTimeout(titleClickTimer); }
					titleClickTimer = window.setTimeout(() => {
						titleClickTimer = null;
						onTitleClick();
					}, 250);
				}
			};
			overlay.addEventListener('pointermove', move);
			overlay.addEventListener('pointerup', up);
			overlay.addEventListener('pointercancel', up);
			event.preventDefault();
		});
		window.addEventListener('resize', () => {
			const at = overlayPositions.get(key);
			if (at) { place(at.x, at.y); }
		});
		// The gesture can end anywhere, including outside the overlay.
		for (const end of ['pointerup', 'pointercancel'] as const) {
			window.addEventListener(end, () => { navControlHeld = false; });
		}
	}

	/**
	 * Resolve a desired coordinate to a plane that actually exists.
	 *
	 * A DICOM series is frequently SPARSE — not every (C, Z, T) combination has
	 * an image — so stepping one axis on its own can name a plane that is not
	 * in the series. Snapping keeps the invariant "navigation always lands on a
	 * real plane" while letting every axis be an ordinary navigable control:
	 * the requested axis value is honoured exactly, and the remaining axes fall
	 * to the nearest available plane.
	 */
	function snapToDatasetPlane(
		series: { axes: { key: string }[], planes: { coordinates: Record<string, number> }[] },
		desired: Record<string, number>,
		pinnedAxis: string,
	): Record<string, number> {
		if (!series.planes.length) { return desired; }
		let best: Record<string, number> | null = null;
		let bestCost = Number.POSITIVE_INFINITY;
		for (const plane of series.planes) {
			if ((plane.coordinates[pinnedAxis] || 0) !== (desired[pinnedAxis] || 0)) { continue; }
			let cost = 0;
			for (const axis of series.axes) {
				if (axis.key === pinnedAxis) { continue; }
				cost += Math.abs((plane.coordinates[axis.key] || 0) - (desired[axis.key] || 0));
			}
			if (cost < bestCost) { bestCost = cost; best = plane.coordinates; }
		}
		// No plane carries that coordinate on the pinned axis at all: leave the
		// request untouched rather than silently jumping somewhere unrelated.
		return best ? { ...best } : desired;
	}

	/** Clear file-owned navigation before opening another collection entry. */
	function resetDatasetNavigation() {
		datasetManifest = null;
		datasetSeriesIndex = 0;
		datasetCoordinates = {};
		datasetLoading = false;
		datasetRequestInFlight = false;
		pendingDatasetRequest = null;
		clearTimeout(datasetRequestTimer);
		omeDatasetRequestKey = '';
		updateDatasetOverlay(false);
	}


	/**
	 * Dataset navigation keeps at most one plane request in flight. A slider
	 * dragged across a study asks for a plane on every step; sent straight
	 * through, each one cancelled the decode before it (restarting the worker)
	 * or queued behind it, so the plane it was dropped on appeared only after
	 * every plane passed on the way. Now the newest position waits while one
	 * plane loads and is sent the moment it is shown: the view keeps updating
	 * during the drag and lands on the final plane one load later.
	 */

	function requestDatasetNavigation(seriesIndex: number, coordinates: Record<string, number>) {
		if (!datasetManifest) { return; }
		datasetLoading = true;
		updateDatasetOverlay(true);
		if (datasetRequestInFlight) {
			pendingDatasetRequest = { seriesIndex, coordinates: { ...coordinates } };
			return;
		}
		datasetRequestInFlight = true;
		// A position without a plane gets no answer; do not wait forever.
		clearTimeout(datasetRequestTimer);
		datasetRequestTimer = setTimeout(datasetRequestSettled, 3000);
		vscode.postMessage({ type: 'navigateDataset', seriesIndex, coordinates });
	}

	/** The plane in flight was shown (or failed): send the newest waiting position. */
	function datasetRequestSettled() {
		clearTimeout(datasetRequestTimer);
		datasetRequestInFlight = false;
		const next = pendingDatasetRequest;
		pendingDatasetRequest = null;
		if (next) { requestDatasetNavigation(next.seriesIndex, next.coordinates); }
	}

	function updateDatasetOverlay(loading = datasetLoading) {
		const manifest = datasetManifest;
		if (!manifest || manifest.series.length === 0) {
			// Only tear the overlay down if this format still OWNS it. During a
			// switch ownership is released and the manifest is briefly absent
			// before the next one arrives; hiding on that transient state is
			// what made the controls blink in and out while stepping through a
			// study. An unclaimed overlay is left for the incoming image.
			if (navOwner === 'dataset') { hideNavOverlay('dataset'); }
			return;
		}
		renderNavOverlay({ owner: 'dataset', title: manifest.label, controls: datasetControls(), loading });
		if (filenameBadge) { filenameBadge.style.display = 'block'; }
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
				await updateImageWithNewSettings();
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

	// --- Control sources ------------------------------------------------
	//
	// Every source produces the SAME shape — `{ name, size, value, labels? }` —
	// and `controlsFromSelectors` turns it into controls. There is exactly one
	// rule and it lives in one place:
	//
	//     labels present => a choice among named things  => dropdown
	//     labels absent  => a homogeneous axis           => slider
	//
	// No source decides a widget, a key, or a layout, and none of them names a
	// format. Changing navigation behaviour is a single edit here, not five
	// edits and five retests.

	interface Selector {
		readonly name: string;
		readonly size: number;
		readonly value: number;
		readonly labels?: readonly string[];
	}

	/** The one and only selector -> control conversion. */
	function controlsFromSelectors(
		namespace: string,
		selectors: readonly Selector[],
		go: (selector: Selector, index: number) => void,
	): NavControlSpec[] {
		return selectors.map(selector => ({
			key: `${namespace}:${selector.name}`,
			label: selector.name,
			size: Math.max(1, selector.size),
			value: selector.value,
			labels: selector.labels && selector.labels.length === selector.size
				? selector.labels
				: undefined,
			go: (index: number) => go(selector, index),
		}));
	}

	/** Normalize a decoder's raw `selectors` metadata into the common shape. */
	function readSelectors(metadata: Record<string, any>): Selector[] {
		const raw: any[] = Array.isArray(metadata.selectors) ? metadata.selectors : [];
		return raw.map((selector: any) => ({
			name: String(selector.name),
			size: Math.max(1, Number(selector.size)),
			value: Number(selector.value ?? 0) || 0,
			labels: Array.isArray(selector.labels) && selector.labels.length
				? selector.labels.map((entry: any) => String(entry))
				: undefined,
		}));
	}

	/** CZI / ND2 / LIF. */
	function planeControlsFromSelectors(metadata: Record<string, any>): NavControlSpec[] {
		const selectors = readSelectors(metadata).map(selector => ({
			...selector,
			value: Number(planeSelection.indices[selector.name] ?? selector.value) || 0,
		}));
		return controlsFromSelectors('sel', selectors, (selector, index) => {
			const resets = (metadata.selectorResets || {})[selector.name];
			const retained = { ...planeSelection.indices };
			if (Array.isArray(resets)) { for (const name of resets) { delete retained[String(name)]; } }
			planeSelection.indices = { ...retained, [selector.name]: index };
			requestPlaneReload();
		});
	}

	/** DICOM: the series choice, then the series' own axes. */
	function datasetControls(): NavControlSpec[] {
		const manifest = datasetManifest;
		if (!manifest || !manifest.series.length) { return []; }
		const seriesIndex = Math.max(0, Math.min(manifest.series.length - 1, datasetSeriesIndex));
		const series = manifest.series[seriesIndex];
		const selectors: Selector[] = [];
		if (manifest.series.length > 1) {
			selectors.push({
				name: 'Series',
				size: manifest.series.length,
				value: seriesIndex,
				labels: manifest.series.map((item: any) => String(item.label)),
			});
		}
		for (const axis of series.axes) {
			const size = Math.max(1, axis.size);
			const complete = Array.isArray(axis.valueLabels)
				&& axis.valueLabels.length === size
				&& axis.valueLabels.every((entry: any) => !!entry);
			selectors.push({
				name: axis.label,
				size,
				value: datasetCoordinates[axis.key] || 0,
				labels: complete ? axis.valueLabels.map((entry: any) => String(entry)) : undefined,
			});
		}
		return controlsFromSelectors('dicom', selectors, (selector, index) => {
			if (selector.name === 'Series') {
				datasetSeriesIndex = index;
				const target = manifest.series[index];
				datasetCoordinates = Object.fromEntries((target?.axes || []).map((axis: any) => [axis.key, 0]));
				requestDatasetNavigation(datasetSeriesIndex, datasetCoordinates);
				return;
			}
			const axis = series.axes.find((candidate: any) => candidate.label === selector.name);
			if (!axis) { return; }
			datasetCoordinates = snapToDatasetPlane(series, { ...datasetCoordinates, [axis.key]: index }, axis.key);
			requestDatasetNavigation(datasetSeriesIndex, datasetCoordinates);
		});
	}

	/** NetCDF: the variable choice, then the variable's dimensions. */
	function netcdfControls(metadata: Record<string, any>): NavControlSpec[] {
		const variables: any[] = Array.isArray(metadata.variables) ? metadata.variables : [];
		const names = variables.map((variable: any) => String(variable.name ?? variable));
		const selectors: Selector[] = [];
		if (names.length > 1) {
			selectors.push({
				name: 'Variable',
				size: names.length,
				value: Math.max(0, names.indexOf(String(netcdfSelection.variableName ?? ''))),
				labels: names,
			});
		}
		for (const selector of readSelectors(metadata)) {
			selectors.push({
				...selector,
				value: Number(netcdfSelection.indices[selector.name] ?? selector.value) || 0,
			});
		}
		return controlsFromSelectors('nc', selectors, (selector, index) => {
			if (selector.name === 'Variable') {
				netcdfSelection = { variableName: names[index], indices: {} };
			} else {
				netcdfSelection.indices = { ...netcdfSelection.indices, [selector.name]: index };
			}
			reloadNetCdfSelection();
		});
	}

	/** TIFF: OME C/Z/T, pyramid levels, or the page index for a multi-page file. */
	function tiffBandControls(): NavControlSpec[] {
		const count = tiffProcessor.selectableBandCount;
		if (currentLoadFormat !== 'TIFF' || !Number.isInteger(count) || count < 2) { return []; }
		const labels = Array.from({ length: count }, (_unused, index) =>
			bandDescription(tiffProcessor.gdalMetadata, index) || `Band ${index + 1}`);
		const rgb = tiffProcessor.displayRgbBands;
		const mode = controlsFromSelectors('tiff-mode', [{ name: 'View', size: 2, value: rgb ? 1 : 0, labels: ['Single band', 'RGB bands'] }],
			(_selector, index) => {
				if (index === 0) void selectTiffBand(tiffProcessor.displayBand);
				else if (tiffProcessor.setDisplayRgbBands([0, 1, Math.min(2, count - 1)])) void refreshTiffBandView();
			});
		const selectors = rgb
			? ['Red', 'Green', 'Blue'].map((name, i) => ({ name, size: count, value: rgb[i], labels }))
			: [{ name: 'Band', size: count, labels,
				value: Math.min(count - 1, Math.max(0, selectorSolosChannels() && compositeSelectorChannel !== null
					? compositeSelectorChannel : tiffProcessor.displayBand)) }];
		return [...mode, ...controlsFromSelectors('tiff', selectors, (selector, index) => {
			if (!rgb) {
				if (selectorSolosChannels()) { soloFromSelector(index); } else { void selectTiffBand(index); }
				return;
			}
			const next: [number, number, number] = [rgb[0], rgb[1], rgb[2]];
			next[['Red', 'Green', 'Blue'].indexOf(selector.name)] = index;
			if (tiffProcessor.setDisplayRgbBands(next)) void refreshTiffBandView();
		})];
	}

	async function selectTiffBand(index: number): Promise<void> {
		if (!tiffProcessor.setDisplayBand(index)) { return; }
		await refreshTiffBandView();
	}

	async function refreshTiffBandView(): Promise<void> {
		invalidatePyramidViewport();
		_detailPatchGeneration++;
		removeDetailPatch();
		// An explicit band choice is a scalar view. If the optional channel
		// compositor was active, leaving it in charge of the canvas would make the
		// dropdown appear to do nothing.
		compositeEnabled = false;
		compositeChosenByUser = true;
		compositeAuto = false;
		channelSolo = null;
		channelGroupSolo = null;
		soloShownPositions = [];
		await updateImageWithNewSettings();
		channelsPanel.render();
		updateTiffPageOverlay();
	}

	function tiffControls(): NavControlSpec[] {
		const bandControls = tiffBandControls();
		if (tiffProcessor.pageCount <= 1 || tiffProcessor.hasGeneratedPreview) { return bandControls; }
		const ome = tiffProcessor.omeMetadata;
		if (!ome) {
			const directory = tiffProcessor.pageDirectory;
			// A pyramid's extra IFDs are the same scene downsampled, so they are
			// levels of ONE image, not pages. Offering them as "page 2 of 4"
			// invites the reader to treat a blurry duplicate as separate data.
			if (isPyramidal(directory)) {
				const pages = imagePages(directory);
				const currentPage = pageOwningIfd(directory, tiffProcessor.pageIndex);
				const controls: NavControlSpec[] = [];
				if (pages.length > 1) {
					controls.push(...controlsFromSelectors('tiff', [{
						name: 'Page',
						size: pages.length,
						value: Math.max(0, pages.findIndex(page => page.index === currentPage)),
					}], (_selector, index) => {
						void navigateTiffToPage(pages[index]?.index ?? 0);
					}));
				}
				return [...controls, ...bandControls];
			}
			return [...controlsFromSelectors('tiff', [{
				name: 'Page',
				size: tiffProcessor.pageCount,
				value: tiffProcessor.pageIndex,
			}], (_selector, index) => { void navigateTiffToPage(index); }), ...bandControls];
		}
		const coordinates = omeIfdToCoordinates(ome, tiffProcessor.pageIndex);
		const current: Record<OmeAxis, number> = { C: coordinates.c, Z: coordinates.z, T: coordinates.t };
		const sizes: Record<OmeAxis, number> = { C: ome.planeSizeC, Z: ome.sizeZ, T: ome.sizeT };
		const channelNames = ome.channels.map((channel: any) => String(channel?.name || ''));
		const named = channelNames.length === sizes.C && channelNames.every((name: string) => !!name);
		const selectors: Selector[] = (['C', 'Z', 'T'] as OmeAxis[]).map(axis => ({
			name: axis,
			size: sizes[axis],
			// While the composite is on, the C control shows the soloed channel.
			value: axis === 'C' && selectorSolosChannels() && compositeSelectorChannel !== null
				? compositeSelectorChannel : current[axis],
			labels: axis === 'C' && named ? channelNames : undefined,
		}));
		return [...controlsFromSelectors('ome', selectors, (selector, index) => {
			if (selector.name === 'C' && selectorSolosChannels()) { soloFromSelector(index); return; }
			void navigateOmeAxis(selector.name as OmeAxis, index);
		}), ...bandControls];
	}

	// ------------------------------------------------------------------
	// One navigation overlay for every dimensioned format
	// ------------------------------------------------------------------
	//
	// DICOM, NetCDF, OME-TIFF, CZI, ND2, LIF and SDT all present the same thing: an
	// ordered list of controls that pick which plane of a multi-dimensional
	// file is on screen. They used to have four overlays, four render
	// functions and three key bindings between them, so the same concept
	// behaved differently depending on which decoder produced it.
	//
	// There is now ONE overlay element and ONE renderer. A format contributes a
	// list of `NavControlSpec` and nothing else; it does not own a widget, a
	// key, or a row. Whether a control appears as a dropdown or a slider is
	// decided by the DATA — a control that arrives with per-option names is a
	// choice among named things, one without is a homogeneous axis.

	interface NavControlSpec {
		/** Stable identity, used for row reuse and focus restoration. */
		readonly key: string;
		readonly label: string;
		readonly size: number;
		readonly value: number;
		/** Present => render a dropdown; absent => render a slider. */
		readonly labels?: readonly string[];
		readonly go: (index: number) => void;
	}

	let navOverlay: HTMLElement | null = null;
	let navOverlayCollapsed = false;
  let navigationView: ReturnType<typeof mountView<NavigationModel>>;
  let navigationModel: NavigationModel;

	function applyNavOverlayCollapsedState() {
		if (!navOverlay) { return; }
		navOverlay.classList.toggle('dataset-overlay--collapsed', navOverlayCollapsed);
		const title = navOverlay.querySelector('.dataset-title') as HTMLElement | null;
		if (title) {
			const readonly = navOverlay.classList.contains('dataset-overlay--readonly');
			title.tabIndex = readonly ? -1 : 0;
			if (readonly) {
				title.removeAttribute('role');
				title.removeAttribute('aria-expanded');
				title.title = 'Drag to move';
				return;
			}
			title.setAttribute('role', 'button');
			title.setAttribute('aria-expanded', String(!navOverlayCollapsed));
			title.title = navOverlayCollapsed ? 'Click to expand' : 'Click to collapse';
		}
	}

	/**
	 * Which format currently owns the shared overlay.
	 *
	 * Every format's update function targets the same element now, and each of
	 * them hides it when IT has nothing to show. Without an owner the last
	 * updater to run wins: opening a DICOM study ran the TIFF updater too,
	 * which saw `pageCount <= 1`, hid the overlay, and made it flicker in and
	 * out on every navigation; NetCDF lost its overlay outright the same way.
	 * A non-owner's request to hide is ignored.
	 */
	type NavOwner = 'plane' | 'dataset' | 'netcdf' | 'tiff';
	let navOwner: NavOwner | null = null;

	/** True while a pointer is held on a control, so re-renders leave it alone. */
	let navControlHeld = false;

  function createNavOverlay() {
    const toggle = () => {
      if (navOverlay?.classList.contains('dataset-overlay--readonly')) return;
      navOverlayCollapsed = !navOverlayCollapsed;
      applyNavOverlayCollapsedState();
    };
    navigationModel = { title: '', controls: [], hints: [], note: '', loading: false,
      ready: node => { navOverlay = node; }, toggle,
      held: () => navControlHeld, hold: () => { navControlHeld = true; },
    };
    navigationView = mountView(Navigation, navigationModel);
    navigationKeys.watchLayout();
    makeOverlayDraggable(navOverlay!, 'plane', toggle);
    applyNavOverlayCollapsedState();
  }

	/**
	 * Render the overlay for `controls`.
	 *
	 * Rows are reused across renders wherever the shape is unchanged: rebuilding
	 * them destroys the element the user is dragging or has focused, which is
	 * what made the sliders feel broken. When a rebuild IS required (the axis
	 * set genuinely changed, e.g. a new series), focus is captured and restored
	 * onto the equivalent new row.
	 */
	function renderNavOverlay(options: {
		owner: NavOwner,
		title: string,
		controls: readonly NavControlSpec[],
		loading?: boolean,
		/** A line of read-only status under the controls; '' hides it. */
		note?: string,
		resolution?: { preview: string, detail: string, description: string },
	}) {
		if (!navOverlay) { return; }
		const { owner, title, loading = false } = options;
		// A control with a single option is not navigable: it cannot be stepped,
		// has no shortcut, and only takes a row over the image. Dropping it here
		// also makes "is this the lone control?" — which decides whether the
		// arrows or the brackets apply — count only real ones.
		const controls = options.controls.filter(control => control.size > 1);
		const note = options.note || '';
		if (!controls.length && !note && !options.resolution) {
			// Hide when this format owns the overlay, and also when NOBODY does:
			// a switch releases ownership without hiding (so the controls stay up
			// through the decode), and the incoming format is then the one that
			// decides whether they are still needed. Without the unclaimed case,
			// moving from a DICOM study to a plain image left the study's
			// controls stranded on screen.
			if (navOwner === owner || navOwner === null) { hideNavOverlay(owner); }
			return;
		}
		navOwner = owner;
		navOverlay.classList.toggle('dataset-overlay--loading', loading);
		navOverlay.classList.toggle('dataset-overlay--readonly', controls.length === 0 && !note);
		navControls = controls.map(spec => ({
			label: spec.label,
			size: spec.size,
			value: spec.value,
			isChoice: !!spec.labels && spec.size > 1,
			go: spec.go,
		}));
    const focusedKey = (document.activeElement instanceof HTMLElement)
      ? document.activeElement.closest('[data-nav-key]')?.getAttribute('data-nav-key') : null;
    navigationModel = { ...navigationModel, title, controls, hints: navKeyHints(navControls), note, loading, resolution: options.resolution };
    navigationView.update(navigationModel);
    if (focusedKey && !navOverlay.contains(document.activeElement)) {
      navOverlay.querySelector<HTMLElement>(`[data-nav-key="${CSS.escape(focusedKey)}"] input, [data-nav-key="${CSS.escape(focusedKey)}"] select`)?.focus();
    }

		applyNavOverlayCollapsedState();
		navOverlay.style.display = options.resolution ? 'grid' : 'flex';
	}

	/** Release the overlay without hiding it, so it survives the next decode. */
	function releaseNavOverlay() {
		navOwner = null;
	}

	function hideNavOverlay(owner?: NavOwner) {
		// A format that is not showing must not blank another format's overlay.
		if (owner && navOwner && navOwner !== owner) { return; }
		navOwner = null;
		navControls = [];
		if (navOverlay) { navOverlay.style.display = 'none'; }
	}

	function updatePlaneOverlay(metadata: Record<string, any>, loading = false) {
		// The title is just the format. The channel name used to be appended
		// here because there was nowhere better to put it; now a named channel
		// IS a dropdown showing that name, so repeating it in the title would
		// say the same thing twice.
		renderNavOverlay({
			owner: 'plane',
			title: planeNavProcessor?.config.formatLabel || 'Image',
			controls: planeControlsFromSelectors(metadata),
			loading,
		});
	}
	/**
	 * Keyboard shortcuts are assigned by SLIDER POSITION, not by axis name.
	 *
	 * They used to be chosen by content — arrows drove Z if a Z axis existed,
	 * brackets drove C — which meant the same key moved a different axis from
	 * one series to the next, and an axis with no rule (a LIF series selector,
	 * for instance) got no shortcut at all. Binding to position instead makes
	 * the mapping stable and visible: the hint sits at the end of its own row,
	 * so what a key does is always readable off the slider it belongs to.
	 *
	 * Sliders past the fourth are mouse-only; there are no obvious further key
	 * pairs, and inventing obscure ones would be worse than leaving them out.
	 */


	/** Step a CZI plane axis, wrapping like DICOM dataset navigation does. */
	function navigatePlaneAxis(axis: { name: string, size: number, value: number } | undefined, delta: number) {
		if (!axis || axis.size <= 1) { return; }
		const current = Number(planeSelection.indices[axis.name] ?? axis.value) || 0;
		const next = (current + delta + axis.size) % axis.size;
		planeSelection.indices = { ...planeSelection.indices, [axis.name]: next };
		axis.value = next;
		requestPlaneReload();
	}

	/**
	 * Request the plane in `planeSelection`, coalescing while one is in flight.
	 *
	 * Dragging a slider emits far more events than a decode-and-render cycle can
	 * absorb. Rather than debouncing on a timer — which makes the image lag the
	 * handle by a fixed delay — only one load runs at a time and the newest
	 * position is kept as the trailing request, so the image tracks the slider as
	 * fast as the machine allows and always lands on the released value.
	 */
	function requestPlaneReload() {
		// Publish the requested position immediately so repeated keys advance
		// from it, even while the decoder is busy with an older plane.
		if (planeNavProcessor) { updatePlaneOverlay(planeNavProcessor.metadata, true); }
		if (planeLoadInFlight) { planeLoadPending = true; return; }
		planeLoadInFlight = true;
		reloadPlaneSelection();
	}

	/** Called when a CZI load settles, to run whatever the user asked for since. */
	function onPlaneLoadSettled() {
		planeLoadInFlight = false;
		if (!planeLoadPending) { return; }
		planeLoadPending = false;
		requestPlaneReload();
	}

	function reloadPlaneSelection() {
		const src = settingsManager.settings.src || '';
		const resourceUri = settingsManager.settings.resourceUri || '';
		if (!src || !resourceUri) { planeLoadInFlight = false; return; }
		navOverlay?.classList.add('dataset-overlay--loading');
		switchToNewImage(src, resourceUri, { planeOptions: { indices: { ...planeSelection.indices } }, planeChange: true });
	}


	function reloadNetCdfSelection() {
		const src = settingsManager.settings.src || '';
		const resourceUri = settingsManager.settings.resourceUri || '';
		if (!src || !resourceUri) { return; }
		navOverlay?.classList.add('dataset-overlay--loading');
		switchToNewImage(src, resourceUri, { netcdfOptions: { ...netcdfSelection, indices: { ...netcdfSelection.indices } } });
	}

	function updateNetCdfOverlay(metadata: Record<string, any>, loading = false) {
		renderNavOverlay({ owner: 'netcdf', title: 'NetCDF', controls: netcdfControls(metadata), loading });
	}
	function updateTiffPageOverlay(loading = false) {
		// Shared load completion runs for every format. Only TIFF may populate
		// this overlay; a retained or dormant TIFF processor is not the active image.
		if (datasetManifest) { return; }
		if (currentLoadFormat !== 'TIFF') { hideNavOverlay('tiff'); return; }
		renderNavOverlay({
			owner: 'tiff',
			title: 'TIFF',
			controls: tiffControls(),
			loading: loading || _levelSwitchPending || _tiffViewportLoadCount > 0,
			resolution: tiffResolutionStatus(),
		});
		syncChannelPanel();
	}

	function beginTiffViewportLoad(): void {
		_tiffViewportLoadCount++;
		if (currentLoadFormat === 'TIFF') { updateTiffPageOverlay(); }
	}

	function endTiffViewportLoad(): void {
		_tiffViewportLoadCount = Math.max(0, _tiffViewportLoadCount - 1);
		if (currentLoadFormat === 'TIFF') { updateTiffPageOverlay(); }
	}

	/** A stable read-only scale strip; details describe pixels already painted. */
	function tiffResolutionStatus(): { preview: string, detail: string, description: string } | undefined {
		const description = pyramidStatusNote();
		if (!description) { return undefined; }
		const directory: TiffPageEntry[] = scenePageDirectory(tiffProcessor.pageDirectory);
		const current = directory.find(entry => entry.index === tiffProcessor.pageIndex);
		if (!current || current.reduction <= 1) { return undefined; }
		const patch = _pyramidScene ? _pyramidPatchRegion : _detailPatchRegion;
		const level = patch && directory.find(entry => entry.index === patch.level);
		const hasDetail = level && level.reduction < current.reduction
			&& (!_pyramidScene || _pyramidScene.loadedSummary(level, patch!.rect).blocks > 0);
		const scale = (reduction: number) => reduction <= 1 ? '1:1' : `1/${reduction}`;
		const full = directory.find(entry => entry.index === pageOwningIfd(directory, current.index));
		return {
			preview: scale(current.reduction),
			detail: hasDetail ? scale(level.reduction) : '',
			description: `${description}. Original: ${full?.width ?? current.width} × ${full?.height ?? current.height}px. Resolution adjusts automatically as you zoom.`,
		};
	}

	/** One-line whole-scene and visible-detail information for a pyramid. */
	function pyramidStatusNote(): string {
		const directory = scenePageDirectory(tiffProcessor.pageDirectory);
		const pyramid = isPyramidal(directory);
		if (!pyramid && !_pyramidScene && !tiffProcessor.isProgressiveRemoteBase) { return ''; }
		const page = pageOwningIfd(directory, tiffProcessor.pageIndex);
		const levels = levelsForPage(directory, page);
		const full = levels[0];
		const current = directory.find((entry: TiffPageEntry) => entry.index === tiffProcessor.pageIndex);
		if (!full || !current) { return ''; }

		// Keep the overview first, followed by only the detail facts needed to
		// understand what has actually arrived under the viewport.
		const overviewResolution = current.reduction <= 1 ? 'Full' : `1/${current.reduction}`;
		const parts = [current.generated ? `Generated preview: ${overviewResolution}` : pyramid
			? `Scene overview: ${overviewResolution}`
			: `Resolution: ${overviewResolution}`];
		if (!_pyramidScene && tiffProcessor.isProgressiveRemoteBase) {
			const columns = Math.ceil(current.width / Math.max(1, current.blockWidth));
			const rows = Math.ceil(current.height / Math.max(1, current.blockHeight));
			parts[0] += ` · 0/${columns * rows} tiles loaded`;
		}

		if (_pyramidScene) {
			if (tiffProcessor.isProgressiveRemoteBase) {
				const baseProgress = _pyramidScene.baseLoadedSummary(current, {
					x: 0, y: 0, width: current.width, height: current.height,
				});
				if (baseProgress.totalBlocks > 0
					&& (!pyramid || baseProgress.blocks < baseProgress.totalBlocks)) {
					parts[0] += ` · ${baseProgress.blocks}/${baseProgress.totalBlocks} tiles loaded`;
				}
			}
			const patch = _pyramidPatchRegion;
			const patchLevel = patch
				? levels.find(level => level.index === patch.level)
				: undefined;
			if (patch && patchLevel) {
				const loaded = _pyramidScene.loadedSummary(patchLevel, patch.rect);
				const resolution = patchLevel.reduction <= 1 ? 'Full' : `1/${patchLevel.reduction}`;
				parts[0] += ` · Resolution: ${resolution}, ${loaded.blocks} tile${loaded.blocks === 1 ? '' : 's'},`
					+ ` each ${Math.max(1, patchLevel.blockWidth)}x${Math.max(1, patchLevel.blockHeight)}px`;
			}
			return parts[0];
		}

		// A patch is the finest thing on screen, and saying only what the BASE
		// holds reads as "this is all you are seeing" — which is how a view
		// showing full-resolution pixels over its middle gets reported as
		// stuck at 1/8.
		const patchLevel = _detailPatchRegion
			? directory.find((entry: TiffPageEntry) => entry.index === _detailPatchRegion!.level)
			: undefined;
		if (patchLevel && patchLevel.width > current.width) {
			const resolution = patchLevel.reduction <= 1 ? 'Full' : `1/${patchLevel.reduction}`;
			const rect = _detailPatchRegion!.rect;
			parts[0] += ` · Resolution: ${resolution}, 1 tile, each ${rect.width}x${rect.height}px`;
		}
		return parts[0];
	}
	async function navigateTiffPage(delta: number): Promise<void> {
		if (isPyramidal(tiffProcessor.pageDirectory)) {
			const pages = imagePages(tiffProcessor.pageDirectory);
			if (pages.length <= 1) { return; }
			const current = pages.findIndex(page => page.index === pageOwningIfd(tiffProcessor.pageDirectory, tiffProcessor.pageIndex));
			await navigateTiffToPage(pages[(current + delta + pages.length) % pages.length].index);
			return;
		}
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

	// --- Pyramid level selection ------------------------------------------
	//
	// A pyramidal TIFF (a COG, a whole-slide image) stores the same scene at
	// halving resolutions. Which one to decode is a display decision, and it is
	// made here rather than in the decoder, which has no idea how large the
	// window is.
	//
	// The policy is deliberately conservative: full resolution is the default
	// whenever it can be shown at all, because this is an inspector and a
	// silently downsampled image is worse than a slow one. A coarser level is
	// used only when the full page exceeds what the browser can put on a canvas
	// or when a full decode exceeds the opening pixel budget. Zooming in
	// then refines back towards full resolution,
	// since that is the point at which the missing detail becomes visible.

	/** Set while a level switch is in flight, so zoom events do not stack up. */
	let _levelSwitchPending = false;
	/** Pending settle timer; see scheduleLevelRefinement. */
	let _levelRefineTimer: number | null = null;
	let _levelRefineRequestedAt = 0;


	/**
	 * The processor a pyramid scene reads its levels and regions from: the
	 * CZI processor while it shows a mosaic too large to hold whole, the TIFF
	 * processor otherwise. Both answer the same members (see czi-processor.ts).
	 */
	function sceneSource(): any {
		return currentLoadFormat === 'CZI' && cziProcessor?.isScene ? cziProcessor : tiffProcessor;
	}

	/** How many stored pixels each displayed pixel stands for. 1 at full size. */
	function currentLevelReduction(): number {
		const source = sceneSource();
		const directory = source.pageDirectory;
		if (!isPyramidal(directory)) { return 1; }
		const current = directory.find((entry: TiffPageEntry) => entry.index === source.pageIndex);
		return current ? Math.max(1, current.reduction) : 1;
	}

	function streamedSceneLevels(): TiffPageEntry[] {
		const source = sceneSource();
		const directory = source.pageDirectory;
		const page = pageOwningIfd(directory, source.pageIndex);
		const levels = levelsForPage(directory, page);
		const full = levels[0];
		if (!full) { return []; }
		if (source !== tiffProcessor) { return levels; }
		// A metadata-only remote base must always acquire a scene that can ask
		// for its blocks—even if the TIFF has no reduced overview IFDs. Without
		// this path a large, single-level tiled TIFF remains a blank canvas.
		if (tiffProcessor.isProgressiveRemoteBase) { return levels; }
		if (tiffProcessor.hasGeneratedPreview) { return levels; }
		return isPyramidal(directory) && full.width * full.height > LARGE_PYRAMID_SCENE_THRESHOLD
			? levels
			: [];
	}

	/** Wrap oversized pyramids and metadata-only remote bases in a tiled scene. */
	function installPyramidSceneIfNeeded(): void {
		if (!canvas || _pyramidScene) { return; }
		const levels = streamedSceneLevels();
		if (!levels.length) { return; }
		removeDetailPatch();
		const parent = canvas.parentNode;
		const nextSibling = canvas.nextSibling;
		_pyramidScene = new PyramidScene(canvas, levels[0].width, levels[0].height);
		imageElement = _pyramidScene.element;
		if (parent) { parent.insertBefore(_pyramidScene.element, nextSibling); }
	}

	function configureTiffMouseReadout(): void {
		const source = sceneSource();
		if (_pyramidScene) {

			mouseHandler.setCoordinateScale(1);
			mouseHandler.setStoredValueResolver(
				(x: number, y: number) => source.readFullResolutionPixel(x, y),
				{
					exactOnly: true,
					// Stored pyramids report resident samples. Generated previews also
					// request an original block on hover so decimation never replaces
					// the exact scalar readout; later positions reuse that block.
					upgradeApproximate: source.hasGeneratedPreview,
					immediateResolver: (x: number, y: number) =>
						source.readCachedScenePixel(x, y),
				},
			);
			return;
		}

		mouseHandler.setCoordinateScale(currentLevelReduction());
		mouseHandler.setStoredValueResolver((x: number, y: number) => source.readStoredPixel(x, y));
	}

	// --- Detail patch -----------------------------------------------------
	//
	// Small pyramids retain the legacy single-patch path below. Oversized
	// pyramids use PyramidScene instead: the overview and retained block tiles
	// share one full-resolution transform and stay visible throughout zoom/pan.
	// Both paths decode only the finer rectangle that intersects the viewport.

	let _detailPatch: HTMLCanvasElement | null = null;
	/** The rectangle currently drawn, in the patch level's own pixels. */
	let _detailPatchRegion: { level: number, rect: Rect } | null = null;
	let _detailPatchGeneration = -1;
	/** The load the patch belongs to; a new image invalidates it. */
	let _detailPatchLoad = -1;
	let _pyramidTileLoadPending = false;
	let _pyramidTileLoadQueued = false;

	function removeDetailPatch(): void {
		const had = !!_detailPatchRegion;
		_detailPatch?.remove();
		_detailPatch = null;
		_detailPatchRegion = null;
		// The status line names the patch, so it has to be told when there is
		// no longer one.
		if (had) { updateTiffPageOverlay(); }
	}

	/**
	 * Decode and place the sharp patch for the current view, or take it away
	 * when the displayed level is already the best one available.
	 */
	async function updateDetailPatch(): Promise<void> {
		if (_pyramidScene) {
			await updatePyramidSceneTiles();
			return;
		}
		const element = imageElement as HTMLElement | null;
		const directory = tiffProcessor.pageDirectory;
		// Mid-switch there is nothing to measure against — but the patch is
		// still valid content for the same image, and taking it away here is
		// what made zooming out lose the sharp centre a moment before the new
		// base arrived. Leave it; the load that follows re-places it.
		if (!element || !hasLoadedImage || _imageTransitionActive) { return; }
		if (!isPyramidal(directory)) { removeDetailPatch(); return; }
		const page = pageOwningIfd(directory, tiffProcessor.pageIndex);
		const levels = levelsForPage(directory, page);
		const base = directory.find((entry: TiffPageEntry) => entry.index === tiffProcessor.pageIndex);
		if (!base || !levels.length) { removeDetailPatch(); return; }

		// The level this zoom deserves. When it is the one already displayed,
		// the coarse image IS the detail and a patch would only be a second
		// copy of it.
		const wanted = levelForDisplayWidth(directory, page, displayedImageWidthPx());
		const held = _detailPatchRegion
			? directory.find((entry: TiffPageEntry) => entry.index === _detailPatchRegion!.level)
			: undefined;

		if (!wanted || wanted.width <= base.width) {
			// Zoomed back out. A patch already decoded is finer than the base
			// still under it, and throwing it away means the middle of the view
			// visibly LOSES detail it had a moment ago — the opposite of what
			// zooming out should do. Keep it: a sharp centre with a coarser
			// surround is what every map viewer shows, and it costs nothing
			// beyond the memory already spent. It goes when the base catches up
			// with it, or when the image does.
			if (held && held.width > base.width) {
				positionDetailPatch(element, base, held, element.clientWidth / base.width);
			} else {
				removeDetailPatch();
			}
			return;
		}

		// CSS pixels per pixel of the displayed level, and of the patch level.
		const baseScale = element.clientWidth / base.width;
		const ratio = wanted.width / base.width;
		const rect = element.getBoundingClientRect();
		const visibleInBase = visibleImageRect(
			{ imageWidth: base.width, imageHeight: base.height },
			Math.min(window.innerWidth, rect.width),
			Math.min(window.innerHeight, rect.height),
			baseScale,
			Math.max(0, -rect.left),
			Math.max(0, -rect.top),
		);
		// The level's OWN block size — a tile, or a band of strip rows. Snapping
		// to it makes two nearby views ask for the same rectangle, which is what
		// lets a small pan reuse the patch already drawn.
		const geometry = {
			imageWidth: wanted.width,
			imageHeight: wanted.height,
			blockWidth: wanted.blockWidth,
			blockHeight: wanted.blockHeight,
		};
		const visibleInWanted = {
			x: visibleInBase.x * ratio,
			y: visibleInBase.y * ratio,
			width: visibleInBase.width * ratio,
			height: visibleInBase.height * ratio,
		};
		const plan = planRegionForView(geometry, visibleInWanted,
			_detailPatchRegion?.level === wanted.index ? _detailPatchRegion.rect : null);
		if (plan.kind === 'keep') { positionDetailPatch(element, base, wanted, baseScale); return; }
		if (plan.kind === 'whole-page') {
			// The view covers most of the level, so a region read would decode
			// nearly all of it — the base is the better answer. An existing
			// patch is still valid data over part of the view, so it stays put
			// rather than being thrown away for a rule about what to fetch next.
			if (held && held.width > base.width) {
				positionDetailPatch(element, base, held, baseScale);
			} else {
				removeDetailPatch();
			}
			return;
		}

		const generation = ++_detailPatchGeneration;
		_detailPatchLoad = navigation.generation;
		beginTiffViewportLoad();
		try {
			const rendered = await tiffProcessor.renderRegion(wanted.index, plan.rect);
			// A zoom or a page change while the blocks were decoding makes this
			// answer describe a view that no longer exists.
			if (!rendered || generation !== _detailPatchGeneration || navigation.generation !== _detailPatchLoad) { return; }

			if (!_detailPatch) {
				_detailPatch = document.createElement('canvas');
				_detailPatch.className = 'detail-patch';
				container.appendChild(_detailPatch);
			}
			_detailPatch.width = rendered.width;
			_detailPatch.height = rendered.height;
			const context = _detailPatch.getContext('2d');
			if (!context) { removeDetailPatch(); return; }
			context.putImageData(rendered, 0, 0);
			const levelChanged = _detailPatchRegion?.level !== wanted.index;
			_detailPatchRegion = { level: wanted.index, rect: plan.rect };
			positionDetailPatch(element, base, wanted, baseScale);
			updateTiffPageOverlay();
			const line = `[Detail] ${levelLabel(wanted)} over ${plan.rect.width}x${plan.rect.height} `
				+ `at ${plan.rect.x},${plan.rect.y}`;
			// Panning redraws the patch constantly; only a change of LEVEL is news.
			// The rest goes to the console, where it is available when wanted and
			// not filling the log someone is reading.
			if (levelChanged) { logToOutput(line); } else { console.log(line); }
		} finally {
			endTiffViewportLoad();
		}
	}

	/** Fill an oversized pyramid scene with retained, block-aligned detail. */
	async function updatePyramidSceneTiles(): Promise<void> {
		const scene = _pyramidScene;
		if (!scene || !hasLoadedImage || _imageTransitionActive) { return; }
		if (_pyramidTileLoadPending) { _pyramidTileLoadQueued = true; return; }
		const provider = sceneSource();
		const directory = scenePageDirectory(provider.pageDirectory);
		const page = pageOwningIfd(directory, provider.pageIndex);
		const levels = levelsForPage(directory, page);
		const base = directory.find((entry: TiffPageEntry) => entry.index === provider.pageIndex);
		const wanted = levelForDisplayWidth(directory, page, displayedImageWidthPx());
		if (!base || !wanted) { return; }
		const streamingBase = provider.isProgressiveRemoteBase && wanted.index === base.index;
		if (wanted.width <= base.width && !streamingBase) {
			// Retained detail is the bridge across a gesture, not a permanent
			// patchwork. Once the overview is the chosen level, converge to it.
			_pyramidPatchRegion = null;
			if (scene.tileCount) {
				scene.clearTiles();
				updateTiffPageOverlay();
			}
			return;
		}

		const elementRect = scene.element.getBoundingClientRect();
		const sceneScale = scene.sceneScale();
		if (!(sceneScale > 0)) { return; }
		const visibleInFull = visibleImageRect(
			{ imageWidth: scene.fullWidth, imageHeight: scene.fullHeight },
			Math.min(window.innerWidth, elementRect.width),
			Math.min(window.innerHeight, elementRect.height),
			sceneScale,
			Math.max(0, -elementRect.left),
			Math.max(0, -elementRect.top),
		);
		const reduction = Math.max(1, wanted.reduction);
		const visibleInLevel = {
			x: visibleInFull.x / reduction,
			y: visibleInFull.y / reduction,
			width: visibleInFull.width / reduction,
			height: visibleInFull.height / reduction,
		};
		const patchRect = snapToBlocks(visibleInLevel, {
			imageWidth: wanted.width,
			imageHeight: wanted.height,
			blockWidth: wanted.blockWidth,
			blockHeight: wanted.blockHeight,
		});
		// At fit/low zoom this would be a near-whole-level decode merely to
		// replace an already-good overview. Region work begins only when the
		// viewport makes it substantially cheaper than the page.
		if (!streamingBase && wanted.sourceIndex === undefined && (visibleInLevel.width * visibleInLevel.height) / (wanted.width * wanted.height) >= 0.6) {
			// Loading most of a finer page would defeat the bounded-view design.
			// Settle uniformly on the base rather than leaving old fine islands.
			_pyramidPatchRegion = null;
			if (scene.tileCount) {
				scene.clearTiles();
				updateTiffPageOverlay();
			}
			return;
		}
		// If a very large/HiDPI viewport cannot fit at this level, stay on the
		// complete overview. Starting work that must evict itself creates holes.
		if (!streamingBase && !scene.canRetain(wanted, visibleInLevel)) {
			_pyramidPatchRegion = null;
			if (scene.tileCount) { scene.clearTiles(); }
			updateTiffPageOverlay();
			return;
		}

		// Decode precisely the settled viewport. Blocks are independent in a COG;
		// centre-first streaming makes the useful part appear as soon as each
		// range arrives and never rerenders the complete scene.
		const missing = streamingBase
			? scene.missingBaseRects(wanted, visibleInLevel)
			: scene.missingRects(wanted, visibleInLevel);
		if (!missing.length) {
			if (!streamingBase) {
				_pyramidPatchRegion = { level: wanted.index, rect: patchRect };
				scene.retainOnlyLevel(wanted.index);
			}
			updateTiffPageOverlay();
			return;
		}
		if (!streamingBase) {
			const alreadyLoaded = scene.loadedBounds(wanted, visibleInLevel);
			if (alreadyLoaded) { _pyramidPatchRegion = { level: wanted.index, rect: alreadyLoaded }; }
		}
		// Generated previews stream independent strips center-first, like remote
		// COG blocks. Each result can paint while the next strips decode.
		const streamBlocks = provider.isRemoteSource || (provider.hasGeneratedPreview
			&& wanted.blockWidth === wanted.width && wanted.blockWidth * wanted.blockHeight <= 8_000_000);
		const requests = streamBlocks ? missing : [{
			x: Math.min(...missing.map(rect => rect.x)),
			y: Math.min(...missing.map(rect => rect.y)),
			width: Math.max(...missing.map(rect => rect.x + rect.width)) - Math.min(...missing.map(rect => rect.x)),
			height: Math.max(...missing.map(rect => rect.y + rect.height)) - Math.min(...missing.map(rect => rect.y)),
		}];

		_pyramidTileLoadPending = true;
		const load = navigation.generation;
		const view = _pyramidViewGeneration;
		const requestController = new AbortController();
		_pyramidViewportAbortController = requestController;
		beginTiffViewportLoad();
		try {
			const refinementStarted = _levelRefineRequestedAt || performance.now();
			let firstPaintMs = 0;
			let nextRequest = 0;
			const paintRect = async (rect: Rect): Promise<void> => {
				let rendered: ImageData | HTMLCanvasElement | null;
				if (wanted.sourceIndex !== undefined) {
					const source = directory.find(level => level.index === wanted.sourceIndex)!;
					const factor = wanted.reduction;
					const sourceRect = { x: rect.x * factor, y: rect.y * factor,
						width: Math.min(rect.width * factor, source.width - rect.x * factor),
						height: Math.min(rect.height * factor, source.height - rect.y * factor) };
					const original = await provider.renderRegion(source.index, sourceRect, requestController.signal);
					rendered = original && !requestController.signal.aborted
						? resizeDetailForDisplay(original, rect.width, rect.height) : null;
				} else {
					rendered = provider.isRemoteSource
						? await provider.renderRegionCanvas(wanted.index, rect, requestController.signal)
						: await provider.renderRegion(wanted.index, rect, requestController.signal);
				}
				// A block remains useful after a pan because its scene position is
				// absolute. A different image, however, must never receive it.
				if (scene !== _pyramidScene || load !== navigation.generation || requestController.signal.aborted) { return; }
				if (rendered) {
					if (streamingBase) {
						scene.commitBaseRegion(wanted, rect, rendered);
					} else {
						scene.commitRegion(wanted, rect, rendered);
						const loaded = scene.loadedBounds(wanted, visibleInLevel);
						if (loaded) { _pyramidPatchRegion = { level: wanted.index, rect: loaded }; }
					}
					if (!firstPaintMs) { firstPaintMs = performance.now() - refinementStarted; }
					mouseHandler.refreshAtPointer();
					updateTiffPageOverlay();
					console.log(`[Tiles] painted ${levelLabel(wanted)} ${rect.width}x${rect.height} at ${rect.x},${rect.y}`);
				}
			};
			// Establish one normalization range before parallel tiles begin. This
			// keeps auto-normalized blocks visually identical at their boundaries.
			if (streamingBase && !provider._lastStatistics && requests.length) {
				await paintRect(requests[nextRequest++]);
			}
			const paintNext = async (): Promise<void> => {
				while (nextRequest < requests.length && view === _pyramidViewGeneration
					&& !requestController.signal.aborted) {
					await paintRect(requests[nextRequest++]);
				}
			};
			// Match the remote decoder pool: enough parallel ranges to fill the
			// connection without waiting for every block before the first paint.
			const streams = Math.min(requests.length, provider.isRemoteSource
				? remoteTileConcurrency(wanted.blockWidth, wanted.blockHeight, wanted.samplesPerPixel)
				: streamBlocks ? 4 : 1);
			await Promise.all(Array.from({ length: streams }, () => paintNext()));
			if (firstPaintMs && !requestController.signal.aborted) {
				requestAnimationFrame(() => setTimeout(() => {
					if (scene === _pyramidScene && view === _pyramidViewGeneration) {
						logToOutput(`[Refine] first commit ${firstPaintMs.toFixed(0)}ms | visible ${(performance.now() - refinementStarted).toFixed(0)}ms | ${requests.length} regions`);
					}
				}, 0));
			}

			// Convergence is valid only for the SAME viewport that initiated this
			// stream. An old request completing during a zoom must not remove the
			// detail that currently prevents the image from appearing blank.
			if (!streamingBase && view === _pyramidViewGeneration && !scene.missingRect(wanted, visibleInLevel)) {
				_pyramidPatchRegion = { level: wanted.index, rect: patchRect };
				scene.retainOnlyLevel(wanted.index);
			}
			updateTiffPageOverlay();
		} finally {
			if (_pyramidViewportAbortController === requestController) {
				_pyramidViewportAbortController = null;
				_pyramidTileLoadPending = false;
				if (_pyramidTileLoadQueued) {
					_pyramidTileLoadQueued = false;
					void updatePyramidSceneTiles();
				}
			}
			endTiffViewportLoad();
		}
	}

	/** Bound retained display pixels while keeping original samples in the picker cache. */
	function resizeDetailForDisplay(original: ImageData, width: number, height: number): ImageData | null {
		const source = document.createElement('canvas');
		source.width = original.width;
		source.height = original.height;
		const target = document.createElement('canvas');
		target.width = width;
		target.height = height;
		const from = source.getContext('2d');
		const to = target.getContext('2d');
		if (!from || !to) { return null; }
		from.putImageData(original, 0, 0);
		to.imageSmoothingEnabled = true;
		to.imageSmoothingQuality = 'high';
		to.drawImage(source, 0, 0, width, height);
		const result = to.getImageData(0, 0, width, height);
		source.width = source.height = target.width = target.height = 0;
		return result;
	}

	/** Lay the patch exactly over the image pixels it stands for. */
	function positionDetailPatch(
		element: HTMLElement,
		base: TiffPageEntry,
		wanted: TiffPageEntry,
		baseScale: number,
	): void {
		if (!_detailPatch || !_detailPatchRegion) { return; }
		const rect = _detailPatchRegion.rect;
		const ratio = wanted.width / base.width;
		const elementRect = element.getBoundingClientRect();
		// Document coordinates, so the patch scrolls with the image instead of
		// being re-placed on every scroll event.
		const left = elementRect.left + window.scrollX + (rect.x / ratio) * baseScale;
		const top = elementRect.top + window.scrollY + (rect.y / ratio) * baseScale;
		_detailPatch.style.left = `${left}px`;
		_detailPatch.style.top = `${top}px`;
		_detailPatch.style.width = `${(rect.width / ratio) * baseScale}px`;
		_detailPatch.style.height = `${(rect.height / ratio) * baseScale}px`;
	}

	/** How many screen pixels the image currently spans, in device pixels. */
	function displayedImageWidthPx(): number {
		const element = imageElement as HTMLElement | null;
		const cssWidth = element?.clientWidth || canvas?.width || 0;
		return cssWidth * (window.devicePixelRatio || 1);
	}

	/**
	 * Switch to another level of the page being viewed, keeping the image the
	 * same size on screen: the levels differ in pixel count, so the zoom scale
	 * has to move the other way by the same factor.
	 */
	async function switchToPyramidLevel(target: TiffPageEntry, reason: string): Promise<void> {
		if (_levelSwitchPending || target.index === tiffProcessor.pageIndex) { return; }
		const current = tiffProcessor.pageDirectory.find((entry: TiffPageEntry) => entry.index === tiffProcessor.pageIndex);
		const multiplier = current && target.width > 0 ? current.width / target.width : 1;
		_levelSwitchPending = true;
		logToOutput(`[Level] ${reason}: ${levelLabel(target)}`);
		try {
			await navigateTiffToPage(target.index, { scaleMultiplier: multiplier });
		} finally {
			_levelSwitchPending = false;
		}
	}

	/**
	 * Move to a finer level when the reader has zoomed past what the current
	 * one holds. Only ever refines: zooming back out keeps the sharper data
	 * already decoded, since dropping to a coarser level would cost a decode
	 * to show less.
	 */
	function maybeRefineTiffLevel(): void {
		// Mid-switch the visible element is still the OUTGOING frame at the
		// outgoing scale, so measuring it picks a level for a view that is
		// already gone — which, evaluated on every scale event, walks the
		// pyramid in a loop instead of settling.
		if (_pyramidScene || _levelSwitchPending || !hasLoadedImage) { return; }
		if (_imageTransitionActive || _collectionSwitchLoading) { return; }
		const directory = tiffProcessor.pageDirectory;
		if (!isPyramidal(directory)) { return; }
		const page = pageOwningIfd(directory, tiffProcessor.pageIndex);
		const levels = levelsForPage(directory, page);
		const current = directory.find((entry: TiffPageEntry) => entry.index === tiffProcessor.pageIndex);
		if (!current) { return; }
		// Reaching here means the level is being chosen automatically, so a
		// patch of the true resolution will cover what is on screen. The base
		// therefore only has to be good enough for the moment before the next
		// patch lands — and for the histogram, measurement and export, which
		// keep reading it — so it stops at the same budget that governs
		// opening rather than at whatever a canvas could hold. See
		// levelForZoom.
		const target = levelForZoom(
			directory, page, tiffProcessor.pageIndex, displayedImageWidthPx(), canvasCanHold,
			FULL_RESOLUTION_PIXEL_BUDGET);
		if (!target) { return; }
		void switchToPyramidLevel(target, target.width > current.width
			? 'zoomed in, refining to'
			: 'zoomed out, dropping to');
	}

	/**
	 * Decide after the view settles rather than on every scale event.
	 *
	 * A zoom gesture is a burst — a pinch or a wheel produces dozens of scale
	 * changes — and a level decode is expensive enough that acting on each one
	 * would decode levels nobody ever sees. Waiting for the burst to end costs
	 * a moment of softness and saves every intermediate decode.
	 */
	function scheduleLevelRefinement(): void {
		_levelRefineRequestedAt = performance.now();
		if (_levelRefineTimer !== null) { window.clearTimeout(_levelRefineTimer); }
		_levelRefineTimer = window.setTimeout(() => {
			_levelRefineTimer = null;
			// Patch size and display scale follow the settled zoom/pan even when no
			// new block is needed.
			if (isPyramidal(tiffProcessor.pageDirectory)) { updateTiffPageOverlay(); }
			maybeRefineTiffLevel();
			void updateDetailPatch();
		}, _pyramidScene ? 80 : 250);
	}

	/**
	 * The largest level that this browser can put on a canvas, or null when
	 * even the smallest cannot be shown. Lets a 40000x40000 COG open at its
	 * 2500x2500 level instead of failing outright — the pyramid is there
	 * precisely so an image too large to draw can still be looked at.
	 */
	function largestDisplayableLevel(pageIndex: number): TiffPageEntry | null {
		const levels = levelsForPage(tiffProcessor.pageDirectory, pageOwningIfd(tiffProcessor.pageDirectory, pageIndex));
		for (const level of levels) {
			if (canvasCanHold(level.width, level.height)) { return level; }
		}
		return null;
	}

	async function navigateTiffToPage(target: number, options: { scaleMultiplier?: number } = {}): Promise<void> {
		if (tiffProcessor.hasGeneratedPreview) { return; }
		const total = tiffProcessor.pageCount;
		if (target < 0 || target >= total) { return; }
		if (target === tiffProcessor.pageIndex) { return; }

		const src = settingsManager.settings.src || '';
		if (!src) { return; }
		const gen = navigation.changeLevel();
		resetVisibleTiming();
		initialLoadStartTime = performance.now();
		// This load starts NOW. Without this, `total` kept measuring from when
		// the file was first opened, so a level switch minutes into a session
		// reported two minutes.
		extensionLoadStartTime = Date.now();
		_pendingZoomState = zoomController.getCurrentState();
		// Zoom is expressed against the decoded image's own width, and two levels
		// of one pyramid have different widths — so carrying the scale across a
		// level switch unchanged would resize the image on screen. This is
		// applied at restore time rather than here because the pending state is
		// re-captured from the live view just before it is restored.
		_pendingLevelScaleMultiplier = options.scaleMultiplier ?? null;

		beginSeamlessImageTransition(false);

		// A patch belongs to the IMAGE, not to the level currently under it, so a
		// level switch keeps it: coarsening the base while zooming out would
		// otherwise take the detail out of the middle of the view. Moving to a
		// different page is a different image, and takes the patch with it.
		if (pageOwningIfd(tiffProcessor.pageDirectory, target)
			!== pageOwningIfd(tiffProcessor.pageDirectory, tiffProcessor.pageIndex)) {
			removeDetailPatch();
		}
		tiffProcessor.pageIndex = target;
		tiffProcessor._isInitialLoad = true;
		tiffProcessor._pendingRenderData = null;
		tiffProcessor.rawTiffData = null;
		tiffProcessor._lastStatistics = null;
		tiffProcessor._convertedFloatData = null;
		hasLoadedImage = false;
		canvas = null;
		imageElement = null;
		_pyramidScene = null;
		_pyramidPatchRegion = null;
		invalidatePyramidViewport();
		primaryImageData = null;
		updateTiffPageOverlay(true);
		saveState();
		// A navigation is a request for THIS level; see handleTiff's chooseLevel.
		await handleTiff(src, gen, target, { chooseLevel: false });
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
		if (navigationView) {
			navigationModel = { ...navigationModel, hints: navKeyHints(navControls) };
			navigationView.update(navigationModel);
		}

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

	function registerTiffDataset() {
		const ome = tiffProcessor.omeMetadata;
		if (ome && !datasetManifest) {
			const images = ome.images?.length ? ome.images : [ome];
			const externalPlaneCount = images.flatMap((image: any) => Object.values(image.coordinateToPlane || {})).filter((plane: any) => !!plane.fileName).length;
			const requestKey = `${ome.uuid || ome.imageId || ''}:${images.length}:${externalPlaneCount}`;
			if (externalPlaneCount > 0 && requestKey !== omeDatasetRequestKey) {
				omeDatasetRequestKey = requestKey;
				vscode.postMessage({
					type: 'registerOmeDataset',
					dataset: {
						uuid: ome.uuid,
						series: images.map((image: any) => ({
							imageId: image.imageId,
							imageName: image.imageName,
							sizeC: image.planeSizeC,
							sizeZ: image.sizeZ,
							sizeT: image.sizeT,
							channelNames: image.channels.map((channel: any) => channel.name),
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
	}

	function registerDicomDataset() {
		if (!datasetManifest && Number(dicomProcessor.metadata.frames || 1) > 1) {
			vscode.postMessage({
				type: 'registerDicomFrames',
				frames: Number(dicomProcessor.metadata.frames),
				frameLabels: Array.isArray(dicomProcessor.metadata.frameLabels) ? dicomProcessor.metadata.frameLabels : undefined,
			});
		}
	}

	function decodedCacheKey(resourceUri: string, formatHint?: string, pageIndex = 0, frameIndex = 0): string {
		const kind = resolveFormat(resourceUri, formatHint)?.kind;
		return kind === 'tiff' ? `${resourceUri}#tiff-page=${pageIndex}`
			: kind === 'dicom' ? `${resourceUri}#dicom-frame=${frameIndex}` : resourceUri;
	}

	function captureCurrentDecodedImage(): CachedImage<FormatInfo> | null {
		const { resourceUri, formatHint } = settingsManager.settings;
		if (!resourceUri || !hasLoadedImage) return null;
		const snapshot = activeProcessor()?.captureDecoded?.();
		return snapshot ? {
			cacheKey: decodedCacheKey(resourceUri, formatHint, tiffProcessor.pageIndex, Number(dicomProcessor.metadata.frameIndex || 0)),
			label: currentLoadFormat, snapshot, formatInfo: currentFormatInfo ? { ...currentFormatInfo } : null,
		} : null;
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

	function tryRestoreDecodedImageFromCache(resourceUri: string, formatHint?: string, pageIndex = 0, frameIndex = 0): boolean {
		const cache = navigation.restore(decodedCacheKey(resourceUri, formatHint, pageIndex, frameIndex));
		if (!cache) return false;
		currentLoadFormat = cache.label;
		currentLoadDecodeInfo = { engine: 'decoded-cache', durationMs: 0 };
		if (resolveFormat(resourceUri, formatHint)?.kind === 'tiff') {
			const ome = tiffProcessor.omeMetadata;
			mouseHandler.setPhysicalPixelSize(ome ? { x: ome.physicalSizeX, y: ome.physicalSizeY, xUnit: ome.physicalSizeXUnit, yUnit: ome.physicalSizeYUnit } : null);
			mouseHandler.setGeoReference(tiffProcessor.geoReference);
			updateTiffPageOverlay();
		}
		if (resolveFormat(resourceUri, formatHint)?.kind === 'tiff') { registerTiffDataset(); }
		if (resolveFormat(resourceUri, formatHint)?.kind === 'dicom') { registerDicomDataset(); }
		installCachedPlaceholder(cache.snapshot.width, cache.snapshot.height);
		vscode.postMessage({ type: 'formatInfo', value: { ...cache.formatInfo, isInitialLoad: true, decodedWith: 'decoded-cache' } });
		return true;
	}

	/**
	 * Switch to a new image in the collection (legacy - for fallback)
	 */
	function switchToNewImage(uri: string, resourceUri: string, options: { formatHint?: string, pageIndex?: number, frameIndex?: number, netcdfOptions?: Record<string, any>, planeOptions?: Record<string, any>, planeChange?: boolean } = {}) {
		const planeChange = !!options.planeChange;
		if (!planeChange && resourceUri !== settingsManager.settings.resourceUri) {
			planeSelection = { indices: {} };
			planeLoadPending = false;
			planeLoadInFlight = false;
			planeNavProcessor = null;
		}
		resetVisibleTiming();
		initialLoadStartTime = performance.now();
		let switchName = resourceUri.split('/').pop() || 'image';
		try { switchName = decodeURIComponent(switchName); } catch { /* keep encoded name */ }
		PerfTrace.begin(planeChange ? `plane ${switchName}` : `switch ${switchName}`);
		const gen = planeChange ? navigation.changePlane() : navigation.openFile(captureCurrentDecodedImage());
		if (!planeChange) beginSeamlessImageTransition(true);

		// Update the settings with the new resource URI
		settingsManager.settings.resourceUri = resourceUri;
		settingsManager.settings.src = uri;
		settingsManager.settings.formatHint = options.formatHint;
		settingsManager.settings.remoteTiffUrl = remoteTiffUrlFor(resourceUri, options.formatHint);
		if (!planeChange) {
			// Let the incoming image claim (or clear) the navigation controls,
			// while they stay on screen until it does.
			releaseNavOverlay();
			tiffProcessor.pageIndex = Math.max(0, Number(options.pageIndex || 0));
			tiffProcessor.pageCount = 1;
			updateTiffPageOverlay();
			updateFilenameBadge(resourceUri);

			// Keep the live zoom untouched while the old frame remains visible. The
			// captured state is applied to the completed replacement in finalizeImageSetup.
			renderCollectionLoadingState();
			if (filenameBadge) filenameBadge.classList.add('filename-badge--loading');
		}

		// Reset the state
		hasLoadedImage = false;
		canvas = null;
		imageElement = null;
		_pyramidScene = null;
		_pyramidPatchRegion = null;
		invalidatePyramidViewport();
		primaryImageData = null;
		mouseHandler.setPhysicalPixelSize(null);
		mouseHandler.setGeoReference(null);

		mouseHandler.setCoordinateScale(1);
		mouseHandler.setStoredValueResolver(null);
		// Same format and (almost always) same dimensions across a plane step, so
		// the renderers stay valid. Tearing them down here cost a full GPU
		// re-validation per slider step.

		// Keep existing image/canvas visible while the new image loads to avoid
		// a black flash. They will be removed in finalizeImageSetup once the new
		// image is ready to be shown.

		// Load the new image based on file type
		loadImageByType(uri, resourceUri, gen, options.formatHint, options.pageIndex, options.frameIndex, options.netcdfOptions, options.planeOptions, planeChange);
	}

	/**
	 * Load image by type (wrapper function)
	 */
	async function loadImageByType(uri: string, resourceUri: string, gen: number, formatHint?: string, pageIndex?: number, frameIndex?: number, netcdfOptions?: Record<string, any>, planeOptions?: Record<string, any>, planeChange = false) {
		// Yield only while replacing an existing frame (or changing a plane).
		// That lets the loading badge paint and coalesces rapid navigation, but a
		// direct first open has neither an outgoing frame nor queued navigation.
		// Making first open wait for requestAnimationFrame was particularly costly
		// in a newly-created VS Code webview, where Chromium may not schedule the
		// first frame for hundreds of milliseconds.
		const shouldYieldForLoadingUi = _imageTransitionActive || planeChange;
		if (shouldYieldForLoadingUi) {
			// The plain timeout races as a fallback because requestAnimationFrame
			// does not fire while the webview is hidden.
			await new Promise(resolve => {
				requestAnimationFrame(() => setTimeout(resolve, 0));
				setTimeout(resolve, 100);
			});
		}
		if (gen !== navigation.generation) { return; }
		PerfTrace.mark(shouldYieldForLoadingUi ? 'paint-yield' : 'load-start');
		const lower = resourceUri.toLowerCase();
		const format = resolveFormat(resourceUri, formatHint);
		const layeredFormat = (format?.kind === 'layered' ? format.layeredFormat : null)
			|| layeredFormatForPath(lower);
		if (format && ['tiff', 'exr', 'npy', 'pfm', 'netpbm', 'hdr', 'jxr', 'jp2', 'jxl', 'fits', 'dicom', 'netcdf', 'czi', 'nd2', 'lif', 'sdt', 'sgi'].includes(format.kind)) {
			await ensureProcessorFamily(format.kind);
			if (gen !== navigation.generation) { return; }
		}

		// The cache is keyed by URI/page/frame and knows nothing about plane
		// coordinates, so on a plane step it would hand back the plane we are
		// trying to move away from.
		if (!planeChange && tryRestoreDecodedImageFromCache(resourceUri, formatHint, Number(pageIndex || 0), Number(frameIndex || 0))) {
			return;
		}
		// One lookup instead of an ordered if/else chain, so no branch can
		// silently shadow another and the routing is inspectable in one table.
		// Keep the current overlay on screen while the next image decodes, the
		// same way the outgoing FRAME is kept until its replacement is ready.
		// Hiding it up front blanked the controls for the whole decode — which
		// is what made them "disappear when switching" — and for a format whose
		// overlay is driven by a host message (a DICOM manifest) they could stay
		// gone entirely. Only a format that can never navigate clears it, and it
		// is cleared as soon as the format is known rather than on every load.
		const NAVIGABLE_KINDS = ['npy', 'tiff', 'dicom', 'netcdf', 'czi', 'nd2', 'lif', 'sdt'];
		if (!format || !NAVIGABLE_KINDS.includes(format.kind)) {
			hideNavOverlay();
		}
		const localBinaryPgm = format?.kind === 'netpbm' && lower.endsWith('.pgm');
		const fastRawFormat = format?.kind === 'pfm' ||
			(format?.kind === 'netpbm' && lower.endsWith('.ppm')) ||
			(format?.kind === 'npy' && lower.endsWith('.npy'));
		if (fastRawFormat) {
			void fastRawWorkerClient.start();
		} else if (format?.kind === 'layered') {
			// Layered documents decode on their own worker (adopting the one the
			// page bootstrap already started). Unstarted, every layered decode
			// fell back to the main thread, including the deferred decode of
			// all editable layers, which froze the view for seconds after the
			// preview appeared and delayed the next editor until it finished.
			void layeredDecodeWorkerClient.start();
		} else if (format && !localBinaryPgm && !['png', 'tga', 'web-image'].includes(format.kind)) {
			// Boot alongside the format's file fetch. PNG starts this itself only
			// after its IHDR confirms that the 16-bit worker path is necessary.
			void decodeWorkerClient.start();
		}
		if (format?.kind === 'layered' && layeredFormat) {
			handleLayeredPreview(layeredFormat, uri, gen);
		} else if (format?.kind === 'tiff') {
			handleTiff(uri, gen, pageIndex);
		} else if (format?.kind === 'exr') {
			handleImageLoad(exrProcessor, 'EXR', uri, gen);
		} else if (format?.kind === 'pfm') {
			handleImageLoad(pfmProcessor, 'PFM', uri, gen);
		} else if (format?.kind === 'netpbm') {
			handleImageLoad(ppmProcessor, 'PPM/PGM', uri, gen);
		} else if (format?.kind === 'png') {
			handleImageLoad(pngProcessor, 'PNG/JPEG', uri, gen);
		} else if (format?.kind === 'npy') {
			handleScientificArray(npyProcessor, uri, gen, planeOptions || planeSelection);
		} else if (format?.kind === 'hdr') {
			handleImageLoad(hdrProcessor, 'HDR', uri, gen);
		} else if (format?.kind === 'tga') {
			handleImageLoad(tgaProcessor, 'TGA', uri, gen);
		} else if (format?.kind === 'web-image') {
			handleImageLoad(webImageProcessor, 'Web Image', uri, gen);
		} else if (format?.kind === 'jxl') {
			handleScientificArray(jxlProcessor, uri, gen);
		} else if (format?.kind === 'jxr') {
			handleScientificArray(jxrProcessor, uri, gen);
		} else if (format?.kind === 'jp2') {
			handleScientificArray(jp2Processor, uri, gen);
		} else if (format?.kind === 'fits') {
			handleScientificArray(fitsProcessor, uri, gen);
		} else if (format?.kind === 'dicom') {
			handleScientificArray(dicomProcessor, uri, gen, { frameIndex: Number(frameIndex || 0) });
		} else if (format?.kind === 'netcdf') {
			handleScientificArray(netcdfProcessor, uri, gen, netcdfOptions || netcdfSelection);
		} else if (format?.kind === 'czi') {
			handleScientificArray(cziProcessor, uri, gen, planeOptions || planeSelection);
		} else if (format?.kind === 'nd2') {
			handleScientificArray(nd2Processor, uri, gen, planeOptions || planeSelection);
		} else if (format?.kind === 'lif') {
			handleScientificArray(lifProcessor, uri, gen, planeOptions || planeSelection);
		} else if (format?.kind === 'sgi') {
			handleScientificArray(sgiProcessor, uri, gen);
		} else if (format?.kind === 'sdt') {
			handleScientificArray(sdtProcessor, uri, gen, planeOptions || planeSelection);
		} else {
			// Fallback to regular image loading
			const newImage = document.createElement('img');
			newImage.classList.add('scale-to-fit');
			newImage.src = uri;

			newImage.addEventListener('load', () => {
				if (gen !== navigation.generation) return;

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
				if (gen !== navigation.generation) return;
				onImageError();
			});
		}
	}

	/** Capture the exact currently rendered pixels used by every export format. */
	async function renderedExportImage(): Promise<ImageData | null> {
		if (layerManager.active && layerManager.hasCompositeStack()) {
			// Render directly for export instead of reading the visible canvas: its
			// ImageBitmap upload is asynchronous and may still contain the previous
			// layer state immediately after a visibility/opacity change.
			const workerComposite = await layerCompositorWorker.compose(
				layerManager.layers,
				layerManager.canvasWidth,
				layerManager.canvasHeight,
				1,
			);
			const rendered = workerComposite
				? layerManager.renderCompositeToImageData(workerComposite, settingsManager.settings, { nanColor: getNanColorObj() })
				: layerManager.renderToImageData(settingsManager.settings, { nanColor: getNanColorObj() });
			if (rendered) {
				const exportCanvas = document.createElement('canvas');
				exportCanvas.width = rendered.width; exportCanvas.height = rendered.height;
				const exportContext = exportCanvas.getContext('2d');
				if (exportContext) {
					exportContext.putImageData(rendered, 0, 0);
					const result = exportContext.getImageData(0, 0, exportCanvas.width, exportCanvas.height);
					exportCanvas.remove();
					return result;
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
				const result = ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
				tempCanvas.remove();
				return result;
			}
		} else if (canvas) {
			return readDisplayedCanvasImageData(canvas);
		} else if (image && image.src) {
			// If no canvas, create a temporary canvas from the image element
			const tempCanvas = document.createElement('canvas');
			tempCanvas.width = image.naturalWidth;
			tempCanvas.height = image.naturalHeight;
			const ctx = tempCanvas.getContext('2d');
			if (ctx) {
				ctx.drawImage(image, 0, 0);
				const result = ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
				tempCanvas.remove();
				return result;
			}
		}
		return null;
	}

	async function exportLayerDocument(format: LayerExportFormat) {
		try {
			const rendered = await renderedExportImage();
			if (!rendered) { throw new Error('The current image has no rendered pixels to export'); }
			if (format !== 'png' && !layerManager.hasCompositeStack()) { throw new Error(`${format.toUpperCase()} layered export requires an active Layers composition`); }
			const result = (await loadLayerWriter()).writeLayerDocument(format, layerManager.layers, rendered.width, rendered.height, rendered);
			let binary = '';
			for (let offset = 0; offset < result.data.length; offset += 0x8000) {
				binary += String.fromCharCode(...result.data.subarray(offset, Math.min(result.data.length, offset + 0x8000)));
			}
			vscode.postMessage({ type: 'didExportLayerDocument', format, payload: btoa(binary), warnings: result.warnings });
		} catch (error) {
			vscode.postMessage({ type: 'didExportLayerDocument', format, error: error instanceof Error ? error.message : String(error), warnings: [] });
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

				result = await exrProcessor.load(peerUri);
				peerImageData = result.imageData;

				peerRawExrData = exrProcessor.rawExrData;
				peerExrStats = exrProcessor._cachedStats;
				exrProcessor.rawExrData = savedExrData;
				exrProcessor._cachedStats = savedExrStats;
			} else {
				// TIFF / other — use tiffProcessor, preserve primary's raw data
				const savedRawTiffData = tiffProcessor.rawTiffData;
				const savedLastStatistics = tiffProcessor._lastStatistics;

				result = await tiffProcessor.load(peerUri);
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

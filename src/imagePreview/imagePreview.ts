import { getCellIdColumns } from '../cells/cellIdColumns';
import type { HostToViewerMessage } from '../../shared/viewer-protocol';
import type { ChannelDefaults } from '../../shared/viewer-settings';
import * as vscode from 'vscode';
import type { NanColorName } from './imageSettings';
import { Utils } from 'vscode-uri';
import { BinarySizeStatusBarEntry } from '../binarySizeStatusBarEntry';
import { MediaPreview, PreviewState } from '../mediaPreview';
import { escapeAttribute, getNonce } from '../util/dom';
import { SizeStatusBarEntry } from './sizeStatusBarEntry';
import { Scale, ZoomStatusBarEntry } from './zoomStatusBarEntry';
import { NormalizationStatusBarEntry } from './normalizationStatusBarEntry';
import { GammaStatusBarEntry } from './gammaStatusBarEntry';
import { BrightnessStatusBarEntry } from './brightnessStatusBarEntry';
import { LayersStatusBarEntry } from './layersStatusBarEntry';
import { HistogramStatusBarEntry } from './histogramStatusBarEntry';
import { ColorPickerModeStatusBarEntry } from './colorPickerModeStatusBarEntry';
import { MessageRouter } from './messageHandlers';
import type { IImagePreviewManager, LayerExportFormat, LayerExportOption, LayerExportResult } from './types';
import type { ImageFormatType, ImageSettings } from './appStateManager';
import type { DatasetManifest, DatasetPlane, DatasetSeries, WebviewDatasetManifest } from './datasetTypes';
import { parseOmeDatasetXml, tiffImageDescription } from './omeMetadataFile';
import { canPushSource, PREFETCH_MAX_BYTES, PUSHED_SOURCE_MIN_BYTES, pushSource } from './source-push';

// Extended settings for webview (includes preview-local display settings).
interface WebviewImageSettings extends ImageSettings {
	nanColor: NanColorName;
	colorPickerShowModified: boolean;
	gpuAcceleration: boolean;
	scrollToZoom: boolean;
	navigationShortcuts: Record<string, string[]>;
	channelDefaults: ChannelDefaults;
	cellsAutoOpenPanel: 'auto' | 'always' | 'never';
	cellIdCols: string[];
	/** Experimental rectangle reads; see the setting's description. */
	experimentalRegionDecode: boolean;
}

function nativeFormatForPath(path: string): ImageFormatType | undefined {
	if (/\.png$/i.test(path)) { return 'png'; }
	if (/\.jpe?g$/i.test(path)) { return 'jpg'; }
	if (/\.webp$/i.test(path)) { return 'webp'; }
	if (/\.avif$/i.test(path)) { return 'avif'; }
	if (/\.bmp$/i.test(path)) { return 'bmp'; }
	if (/\.ico$/i.test(path)) { return 'ico'; }
	return undefined;
}

function canUseNativeFirstPaint(settings: ImageSettings, surfaceMode: 'editor' | 'layers'): boolean {
	return surfaceMode === 'editor' &&
		settings.normalization.gammaMode === true &&
		settings.normalization.autoNormalize === false &&
		Math.abs(settings.gamma.in - settings.gamma.out) < 0.001 &&
		Math.abs(settings.brightness.offset) < 0.001 &&
		settings.rgbAs24BitGrayscale !== true;
}

/** TIFFs at least this large are streamed so decoding can start before the read ends. */
const STREAMED_TIFF_MIN_BYTES = 8 * 1024 * 1024;

export class ImagePreview extends MediaPreview {
	private readonly depthRequests = new Map<string, { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

	public requestDepthPlane(): Promise<Uint8Array> {
		if (this.previewState !== PreviewState.Active) return Promise.reject(new Error('Focus the depth image before opening it as a point cloud.'));
		const id = getNonce();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.depthRequests.delete(id); reject(new Error('The image viewer did not respond to the depth export request.')); }, 30000);
			this.depthRequests.set(id, { resolve, reject, timer });
			this.postViewerMessage({ type: 'requestDepthPlane', id });
		});
	}

	private postViewerMessage(message: HostToViewerMessage): Thenable<boolean> {
		return this._webviewEditor.webview.postMessage(message);
	}

	private _imageSize: string | undefined;
	private _imageZoom: Scale | undefined;
	private _isTiff: boolean = false;
	private _currentFormat: import('./appStateManager').ImageFormatType | undefined;

	// Image collection management
	private _imageCollection: vscode.Uri[] = [];
	private _currentImageIndex: number = 0;
	// True while the Layers compositing panel is active for this view. A view is
	// either a layer view or a collection, never both.
	private _isLayerView: boolean = false;
	// 'layers' when this preview is the dedicated, retained Layers window.
	private _surfaceMode: 'editor' | 'layers' = 'editor';
	private _preloadedImageData: Map<string, { uri: vscode.Uri; webviewUri: string; loaded: boolean }> = new Map();
	private _currentComparisonState: { peerUris: string[]; isShowingPeer: boolean } | undefined;
	private _datasetManifest: DatasetManifest | undefined;
	// Folder datasets cannot be reconstructed from one of their single-frame files.
	private readonly _collectionDatasets = new Map<string, DatasetManifest>();
	private _datasetSeriesIndex = 0;
	private _datasetCoordinates: Record<string, number> = {};
	private _datasetCurrentResource: vscode.Uri | undefined;

	private readonly emptyPngDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR42gEFAPr/AP///wAI/AL+Sr4t6gAAAABJRU5ErkJggg==';

	private readonly _sizeStatusBarEntry: SizeStatusBarEntry;
	private readonly _zoomStatusBarEntry: ZoomStatusBarEntry;
	private readonly _normalizationStatusBarEntry: NormalizationStatusBarEntry;
	private readonly _gammaStatusBarEntry: GammaStatusBarEntry;
	private readonly _brightnessStatusBarEntry: BrightnessStatusBarEntry;
	private readonly _layersStatusBarEntry: LayersStatusBarEntry;
	private readonly _histogramStatusBarEntry: HistogramStatusBarEntry;
	private readonly _colorPickerModeStatusBarEntry: ColorPickerModeStatusBarEntry;
	private readonly _messageRouter: MessageRouter;

	private readonly _onDidGetLayerExportCompatibility = this._register(new vscode.EventEmitter<LayerExportOption[]>());
	public readonly onDidGetLayerExportCompatibility = this._onDidGetLayerExportCompatibility.event;
	private readonly _onDidExportLayerDocument = this._register(new vscode.EventEmitter<LayerExportResult>());
	public readonly onDidExportLayerDocument = this._onDidExportLayerDocument.event;

	private _openTimestamp: number = 0;
	/** The sources the page may still request (its first image, recent switches), by token. */
	private readonly _pushableSources = new Map<string, { resource: vscode.Uri; size: number }>();
	private _sourcePushGeneration = 0;
	private _switchGeneration = 0;
	/** +1 or -1: the next image in this direction is prefetched. */
	private _switchDirection = 1;
	private _lastPrefetchKey = '';

	public setOpenTimestamp(timestamp: number) {
		this._openTimestamp = timestamp;
		this.postViewerMessage({
			type: 'updateLoadStartTime',
			timestamp: timestamp
		});
	}

	constructor(
		private readonly extensionRoot: vscode.Uri,
		resource: vscode.Uri,
		webviewEditor: vscode.WebviewPanel,
		sizeStatusBarEntry: SizeStatusBarEntry,
		binarySizeStatusBarEntry: BinarySizeStatusBarEntry,
		zoomStatusBarEntry: ZoomStatusBarEntry,
		normalizationStatusBarEntry: NormalizationStatusBarEntry,
		gammaStatusBarEntry: GammaStatusBarEntry,
		brightnessStatusBarEntry: BrightnessStatusBarEntry,
		layersStatusBarEntry: LayersStatusBarEntry,
		histogramStatusBarEntry: HistogramStatusBarEntry,
		colorPickerModeStatusBarEntry: ColorPickerModeStatusBarEntry,
		private readonly _manager: IImagePreviewManager,
		openTimestamp?: number,
		surfaceMode: 'editor' | 'layers' = 'editor',
		private readonly _extensionVersion = 'unknown',
	) {
		super(extensionRoot, resource, webviewEditor, binarySizeStatusBarEntry);
		this._openTimestamp = openTimestamp || Date.now();
		this._surfaceMode = surfaceMode;
		// A dedicated Layers window is always a layer view (collections disabled).
		if (surfaceMode === 'layers') {
			this._isLayerView = true;
		}

		this._sizeStatusBarEntry = sizeStatusBarEntry;
		this._zoomStatusBarEntry = zoomStatusBarEntry;
		this._normalizationStatusBarEntry = normalizationStatusBarEntry;
		this._gammaStatusBarEntry = gammaStatusBarEntry;
		this._brightnessStatusBarEntry = brightnessStatusBarEntry;
		this._layersStatusBarEntry = layersStatusBarEntry;
		this._histogramStatusBarEntry = histogramStatusBarEntry;
		this._colorPickerModeStatusBarEntry = colorPickerModeStatusBarEntry;
		this._messageRouter = new MessageRouter(this._sizeStatusBarEntry, this);

		this._register(webviewEditor.webview.onDidReceiveMessage(message => {
			if (message?.type === 'depthPlaneResult') {
				const request = this.depthRequests.get(message.id);
				if (!request) return;
				this.depthRequests.delete(message.id); clearTimeout(request.timer);
				if (message.error) request.reject(new Error(String(message.error)));
				else if (!(message.bytes instanceof Uint8Array) || message.bytes.length < 10) request.reject(new Error('The viewer returned invalid depth data.'));
				else request.resolve(message.bytes);
				return;
			}
			if (message?.type === 'sourceRequest') {
				this.onSourceRequest(message);
				return;
			}
			this._messageRouter.handle(message);
		}));

		this._register(this._zoomStatusBarEntry.onDidChangeScale(e => {
			if (this.previewState === PreviewState.Active) {
				this.postViewerMessage({ type: 'setScale', scale: e.scale });
			}
		}));

		this._register(webviewEditor.onDidChangeViewState(() => {
			this.updateStatusBar();

			// Also update the global state
			this.updateState();

			// Restore histogram state and image collection when webview becomes active
			if (webviewEditor.active && webviewEditor.visible) {
				this.sendHistogramState();
				// If the collection has multiple images and we weren't on the first one,
				// the webview reloaded image 1 — re-navigate to the correct image.
				if (this._currentImageIndex > 0 && this._imageCollection.length > 1) {
					this.switchToImageAtIndex(this._currentImageIndex);
				} else {
					this.updateImageCollectionOverlay();
				}
			}
		}));

		// Single unified settings update handler
		const updateSettings = (reason: string) => {
			// Get current settings from both managers
			// Update status bar entries
			this._gammaStatusBarEntry.updateGamma(this._manager.appStateManager.imageSettings.gamma.in, this._manager.appStateManager.imageSettings.gamma.out);
			this._brightnessStatusBarEntry.updateBrightness(this._manager.appStateManager.imageSettings.brightness.offset);
			this._sizeStatusBarEntry.updateColorPickerMode(this._manager.settingsManager.getColorPickerShowModified());
			this._layersStatusBarEntry.show();

			// Create full settings object
			const webviewSettings = {
				normalization: this._manager.appStateManager.imageSettings.normalization,
				gamma: this._manager.appStateManager.imageSettings.gamma,
				brightness: this._manager.appStateManager.imageSettings.brightness,
				rgbAs24BitGrayscale: this._manager.appStateManager.imageSettings.rgbAs24BitGrayscale,
				scale24BitFactor: this._manager.appStateManager.imageSettings.scale24BitFactor,
				normalizedFloatMode: this._manager.appStateManager.imageSettings.normalizedFloatMode,
				colorPickerShowModified: this._manager.settingsManager.getColorPickerShowModified(),
				nanColor: this._manager.settingsManager.getNanColor(),
				showScaleBar: this._manager.settingsManager.getShowScaleBar(),
				navigationShortcuts: vscode.workspace.getConfiguration('tiffVisualizer').get<Record<string, string[]>>('navigationShortcuts', {}),
				gpuAcceleration: this.getGpuAccelerationEnabled(),
				scrollToZoom: this.getScrollToZoom(),
				channelDefaults: this.getChannelDefaults(),
				cellsAutoOpenPanel: this.getCellsAutoOpenPanel(),
				cellIdCols: getCellIdColumns(),
				experimentalRegionDecode: this.getRegionDecodeEnabled()
			};

			// Send to webview once
			this.sendSettingsUpdate(webviewSettings, reason);
			this.updateStatusBar();
		};

		// Subscribe to both managers but use single update function.
		this._register(this._manager.settingsManager.onDidChangeSettings(() => updateSettings('preview-settings-changed')));
		// Per-format settings (normalization, gamma, brightness) only apply if format matches
		this._register(this._manager.appStateManager.onDidChangeSettings(() => {
			// Only update if settings are for our format (prevents cross-format contamination)
			if (this._currentFormat === this._manager.appStateManager.currentFormat) {
				updateSettings('format-settings-changed');
			}
		}));
		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('tiffVisualizer.navigationShortcuts')
				|| e.affectsConfiguration('tiffVisualizer.gpuAcceleration')
				|| e.affectsConfiguration('tiffVisualizer.experimentalRegionDecode')
				|| e.affectsConfiguration('tiffVisualizer.scrollToZoom')
				|| e.affectsConfiguration('tiffVisualizer.channels')
				|| e.affectsConfiguration('tiffVisualizer.cells.autoOpenPanel')
				|| e.affectsConfiguration('tiffVisualizer.cells.cellIdCol')) {
				updateSettings('configuration-changed');
			}
		}));

		this._register(webviewEditor.onDidDispose(() => {
			for (const request of this.depthRequests.values()) {
				clearTimeout(request.timer); request.reject(new Error('The image preview was closed during depth export.'));
			}
			this.depthRequests.clear();
			if (this.previewState === PreviewState.Active) {
				this._sizeStatusBarEntry.hide(this);
				this._zoomStatusBarEntry.hide(this);
				this._normalizationStatusBarEntry.forceHide();
				this._gammaStatusBarEntry.hide();
				this._brightnessStatusBarEntry.hide();
				this._layersStatusBarEntry.hide();
				this._histogramStatusBarEntry.hide();
				this._colorPickerModeStatusBarEntry.hide();
			}
		}));

		// Initialize the image collection with the current image
		this._imageCollection = [this.resource];

		// Add the first image to preloaded data tracking
		const webviewUri = this._webviewEditor.webview.asWebviewUri(this.resource);
		this._preloadedImageData.set(this.resource.toString(), {
			uri: this.resource,
			webviewUri: webviewUri.toString(),
			loaded: false
		});

		// Initialize the preview
		this.render();

		// Update binary size and ensure proper state initialization
		this.updateBinarySize().then(() => {
			this.updateState();
			this.updateStatusBar();
		});
	}

	public override dispose(): void {
		if (this.previewState === PreviewState.Active) {
			this._sizeStatusBarEntry.hide(this);
			this._zoomStatusBarEntry.hide(this);
			this._normalizationStatusBarEntry.forceHide();
			this._gammaStatusBarEntry.hide();
			this._brightnessStatusBarEntry.hide();
			this._layersStatusBarEntry.hide();
			this._histogramStatusBarEntry.hide();
		}
		super.dispose();
	}

	public get viewColumn() {
		return this._webviewEditor.viewColumn;
	}

	public zoomIn() {
		if (this.previewState === PreviewState.Active) {
			this.postViewerMessage({ type: 'zoomIn' });
		}
	}

	public zoomOut() {
		if (this.previewState === PreviewState.Active) {
			this.postViewerMessage({ type: 'zoomOut' });
		}
	}

	public copyImage() {
		if (this.previewState === PreviewState.Active) {
			this.postViewerMessage({ type: 'copyImage' });
		}
	}

	public pastePosition() {
		if (this.previewState === PreviewState.Active) {
			// Get the stored position from the manager (shared across all webviews)
			const manager = this._manager as any;
			if (manager.getCopiedPosition) {
				const positionState = manager.getCopiedPosition();
				if (positionState) {
					this.postViewerMessage({
						type: 'pastePosition',
						state: positionState
					});
				} else {
					// No position copied - let webview show error
					this.postViewerMessage({ type: 'pastePosition' });
				}
			} else {
				this.postViewerMessage({ type: 'pastePosition' });
			}
		}
	}

	public resetZoom() {
		if (this.previewState === PreviewState.Active) {
			this.postViewerMessage({ type: 'resetZoom' });
		}
	}

	public async getLayerExportCompatibility(): Promise<LayerExportOption[] | undefined> {
		if (this.previewState !== PreviewState.Active) { return undefined; }
		return new Promise(resolve => {
			const subscription = this.onDidGetLayerExportCompatibility(options => { subscription.dispose(); resolve(options); });
			this.postViewerMessage({ type: 'getLayerExportCompatibility' });
		});
	}

	public async exportLayerDocument(format: LayerExportFormat): Promise<LayerExportResult | undefined> {
		if (this.previewState !== PreviewState.Active) { return undefined; }
		return new Promise(resolve => {
			const subscription = this.onDidExportLayerDocument(result => {
				if (result.format !== format) { return; }
				subscription.dispose(); resolve(result);
			});
			this.postViewerMessage({ type: 'exportLayerDocument', format });
		});
	}

	public startComparison(peerUri: vscode.Uri) {
		if (this.previewState === PreviewState.Active) {
			// Update comparison state
			if (!this._currentComparisonState) {
				this._currentComparisonState = { peerUris: [], isShowingPeer: false };
			}
			if (!this._currentComparisonState.peerUris.includes(peerUri.toString())) {
				this._currentComparisonState.peerUris.push(peerUri.toString());
			}

			this.postViewerMessage({ type: 'start-comparison', peerUri: peerUri.toString() });
		}
	}

	public updatePreview() {
		// Instead of full render (which reloads HTML), just send updated settings
		// This allows fast parameter updates without HTML reload
		this.sendCurrentSettings();
	}

	private sendCurrentSettings() {
		// Create full settings object
		const webviewSettings = {
			normalization: this._manager.appStateManager.imageSettings.normalization,
			gamma: this._manager.appStateManager.imageSettings.gamma,
			brightness: this._manager.appStateManager.imageSettings.brightness,
			rgbAs24BitGrayscale: this._manager.appStateManager.imageSettings.rgbAs24BitGrayscale,
			scale24BitFactor: this._manager.appStateManager.imageSettings.scale24BitFactor,
			normalizedFloatMode: this._manager.appStateManager.imageSettings.normalizedFloatMode,
			nanColor: this._manager.settingsManager.getNanColor(),
			colorPickerShowModified: this._manager.settingsManager.getColorPickerShowModified(),
			showScaleBar: this._manager.settingsManager.getShowScaleBar(),
			navigationShortcuts: vscode.workspace.getConfiguration('tiffVisualizer').get<Record<string, string[]>>('navigationShortcuts', {}),
			gpuAcceleration: this.getGpuAccelerationEnabled(),
			scrollToZoom: this.getScrollToZoom(),
			channelDefaults: this.getChannelDefaults(),
			cellsAutoOpenPanel: this.getCellsAutoOpenPanel(),
			cellIdCols: getCellIdColumns(),
			experimentalRegionDecode: this.getRegionDecodeEnabled()
		};

		// Send to webview
		this.sendSettingsUpdate(webviewSettings, 'preview-refresh');
	}

	private getGpuAccelerationEnabled(): boolean {
		return vscode.workspace
			.getConfiguration('tiffVisualizer')
			.get<boolean>('gpuAcceleration', true);
	}

	private getScrollToZoom(): boolean {
		return vscode.workspace.getConfiguration('tiffVisualizer').get<boolean>('scrollToZoom', false);
	}

	private getChannelDefaults(): ChannelDefaults {
		const config = vscode.workspace.getConfiguration('tiffVisualizer.channels');
		return {
			autoComposite: config.get<boolean>('autoComposite', false),
			autoOpenPanel: config.get<boolean>('autoOpenPanel', false),
			colorsByName: config.get<Record<string, string>>('colorsByName', {}),
			colorsByNumber: config.get<Record<string, string>>('colorsByNumber', {}),
			groups: config.get<Record<string, unknown>>('groups', {}),
		};
	}

	private getCellsAutoOpenPanel(): 'auto' | 'always' | 'never' {
		const value = vscode.workspace.getConfiguration('tiffVisualizer.cells').get<string>('autoOpenPanel', 'auto');
		return value === 'always' || value === 'never' ? value : 'auto';
	}

	private getRegionDecodeEnabled(): boolean {
		return vscode.workspace
			.getConfiguration('tiffVisualizer')
			.get<boolean>('experimentalRegionDecode', false);
	}

	public setImageSize(size: string): void {
		this._imageSize = size;
	}

	public getImageSize(): string | undefined {
		return this._imageSize;
	}

	public setImageZoom(zoom: Scale): void {
		this._imageZoom = zoom;
	}

	public setCurrentFormat(format: import('./appStateManager').ImageFormatType): void {
		this._currentFormat = format;
	}

	public getCurrentFormat(): import('./appStateManager').ImageFormatType | undefined {
		return this._currentFormat;
	}

	public get isTiff(): boolean {
		return this._isTiff;
	}

	public getNormalizationStatusBarEntry(): NormalizationStatusBarEntry {
		return this._normalizationStatusBarEntry;
	}

	public getSizeStatusBarEntry(): SizeStatusBarEntry {
		return this._sizeStatusBarEntry;
	}

	public getWebview(): vscode.Webview {
		return this._webviewEditor.webview;
	}

	public fireLayerExportCompatibilityEvent(options: LayerExportOption[]): void {
		this._onDidGetLayerExportCompatibility.fire(options);
	}

	public fireLayerExportEvent(result: LayerExportResult): void {
		this._onDidExportLayerDocument.fire(result);
	}

	public getManager(): IImagePreviewManager {
		return this._manager;
	}

	public isPreviewActive(): boolean {
		return this.previewState === PreviewState.Active;
	}

	public updateHistogramVisibility(isVisible: boolean): void {
		this._histogramStatusBarEntry.updateVisibility(isVisible);
		// Update global histogram state
		this._manager.appStateManager.setHistogramVisible(isVisible);
	}

	/**
	 * Sync the histogram status bar entry with the current visibility state.
	 * Unlike updateHistogramVisibility, this doesn't update the global state.
	 */
	public syncHistogramStatusBar(isVisible: boolean): void {
		this._histogramStatusBarEntry.updateVisibility(isVisible);
	}

	public toggleHistogram(): void {
		if (this.previewState === PreviewState.Active) {
			this.postViewerMessage({ type: 'toggleHistogram' });
		}
	}

	public toggleMetadata(): void {
		if (this.previewState === PreviewState.Active) {
			this.postViewerMessage({ type: 'toggleMetadata' });
		}
	}

	public toggleMeasure(): void {
		if (this.previewState === PreviewState.Active) {
			this.postViewerMessage({ type: 'toggleMeasure' });
		}
	}

	public toggleChannels(): void {
		if (this.previewState === PreviewState.Active) {
			this.postViewerMessage({ type: 'toggleChannels' });
		}
	}

	public toggleCells(): void {
		if (this.previewState === PreviewState.Active) {
			this.postViewerMessage({ type: 'toggleCells' });
		}
	}

	public toggleScaleBar(): void {
		// Flip the SESSION flag rather than telling one webview to flip its own
		// copy. The settings-changed event then pushes the new value to every
		// open preview, and any preview created later starts from it — which is
		// what makes the choice stick for the session instead of resetting the
		// next time a webview is built.
		const shown = this._manager.settingsManager.toggleScaleBar();
		if (this.previewState === PreviewState.Active) {
			this.postViewerMessage({ type: 'toggleScaleBar', shown });
		}
	}

	/**
	 * Send the global histogram state to the webview.
	 * Called when the webview becomes active to restore histogram visibility.
	 */
	private sendHistogramState(): void {
		const histogramState = this._manager.appStateManager.histogramState;
		this.postViewerMessage({
			type: 'restoreHistogramState',
			isVisible: histogramState.isVisible,
			position: histogramState.position,
			scaleMode: histogramState.scaleMode
		});
		// Also update the status bar to reflect the current state
		this._histogramStatusBarEntry.updateVisibility(histogramState.isVisible);
	}

	// Image collection management methods
	public get imageCollection(): readonly vscode.Uri[] {
		return this._imageCollection;
	}

	/** The image currently displayed (the active collection entry, or the resource). */
	public getCurrentImage(): vscode.Uri {
		if (this._datasetCurrentResource) { return this._datasetCurrentResource; }
		return this._imageCollection[this._currentImageIndex] ?? this.resource;
	}

	/**
	 * The dataset currently open, if this preview is showing one.
	 *
	 * Exposed so commands can act on what the user is already looking at — the
	 * 3D volume export in particular, which would otherwise make them pick the
	 * same folder a second time and re-scan it.
	 */
	public get datasetManifest(): DatasetManifest | undefined {
		return this._datasetManifest;
	}

	/** Which series of `datasetManifest` is on screen. */
	public get datasetSeriesIndex(): number {
		return this._datasetSeriesIndex;
	}

	public setDatasetManifest(manifest: DatasetManifest): void {
		this._datasetManifest = manifest;
		const entry = this._imageCollection[this._currentImageIndex] || this.resource;
		this._collectionDatasets.set(entry.toString(), manifest);
		this._datasetSeriesIndex = Math.max(0, Math.min(manifest.series.length - 1, manifest.initialSeriesIndex || 0));
		this._datasetCoordinates = { ...(manifest.initialCoordinates || {}) };
		const resources = manifest.series.flatMap(series => series.planes.map(plane => vscode.Uri.parse(plane.resourceUri)));
		this.ensureLocalResourceRoots(resources);
		this.sendDatasetManifest();
	}

	public sendDatasetManifest(): void {
		if (!this._datasetManifest) { return; }
		const manifest: WebviewDatasetManifest = {
			...this._datasetManifest,
			series: this._datasetManifest.series.map(series => ({
				...series,
				planes: series.planes.map(plane => {
					const resource = vscode.Uri.parse(plane.resourceUri);
					return { ...plane, src: this._webviewEditor.webview.asWebviewUri(resource).toString() };
				}),
			})),
		};
		this.postViewerMessage({
			type: 'setDataset',
			manifest,
			seriesIndex: this._datasetSeriesIndex,
			coordinates: this._datasetCoordinates,
		});
	}

	/** Promote a directly opened multi-frame DICOM object to the shared dataset UI. */
	public registerDicomFrames(frameCount: number, frameLabelsValue?: unknown): void {
		const frames = Math.max(1, Math.trunc(frameCount));
		if (this._datasetManifest || frames <= 1) { return; }
		const resource = this.getCurrentImage();
		const frameLabels = Array.isArray(frameLabelsValue) && frameLabelsValue.length === frames
			? frameLabelsValue.map(value => String(value || '').trim())
			: [];
		const groupedFrames = new Map<string, number[]>();
		for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
			const label = frameLabels[frameIndex] || '';
			if (!label) { continue; }
			const group = groupedFrames.get(label) || [];
			group.push(frameIndex);
			groupedFrames.set(label, group);
		}
		const hasFrameGroups = groupedFrames.size > 1
			&& [...groupedFrames.values()].reduce((sum, group) => sum + group.length, 0) === frames;
		const series: DatasetSeries[] = hasFrameGroups
			? [...groupedFrames.entries()].map(([label, indices], seriesIndex) => ({
				id: `dicom-frame-group-${seriesIndex}`,
				label,
				axes: [{ key: 'frame', label: 'Frame', size: indices.length }],
				planes: indices.map((frameIndex, localFrameIndex) => ({
					coordinates: { frame: localFrameIndex },
					resourceUri: resource.toString(),
					format: 'dicom' as const,
					frameIndex,
				})),
			}))
			: [{
				id: 'dicom-multiframe',
				label: 'Multi-frame image',
				axes: [{ key: 'frame', label: 'Frame', size: frames }],
				planes: Array.from({ length: frames }, (_, frameIndex) => ({
					coordinates: { frame: frameIndex },
					resourceUri: resource.toString(),
					format: 'dicom' as const,
					frameIndex,
				})),
			}];
		this.setDatasetManifest({
			id: `dicom-frames-${resource.toString()}`,
			kind: 'dicom',
			label: Utils.basename(resource),
			series,
			initialSeriesIndex: 0,
			initialCoordinates: { frame: 0 },
		});
	}

	public navigateDataset(seriesIndex: number, coordinates: Record<string, number>): void {
		const manifest = this._datasetManifest;
		if (!manifest) { return; }
		const safeSeriesIndex = Math.max(0, Math.min(manifest.series.length - 1, Math.trunc(seriesIndex)));
		const series = manifest.series[safeSeriesIndex];
		const safeCoordinates: Record<string, number> = {};
		for (const axis of series.axes) {
			safeCoordinates[axis.key] = Math.max(0, Math.min(axis.size - 1, Math.trunc(coordinates[axis.key] || 0)));
		}
		const plane = series.planes.find(candidate =>
			series.axes.every(axis => (candidate.coordinates[axis.key] || 0) === safeCoordinates[axis.key]));
		if (!plane) {
			vscode.window.showWarningMessage('No image plane is available at that dataset position.');
			return;
		}
		const previous = safeSeriesIndex === this._datasetSeriesIndex ? this._datasetCoordinates : undefined;
		this._datasetSeriesIndex = safeSeriesIndex;
		this._datasetCoordinates = safeCoordinates;
		this._datasetCurrentResource = vscode.Uri.parse(plane.resourceUri);
		this.sendDatasetPlane(plane);
		// A series of one file per slice: offer the next slice along the axis
		// just stepped, so stepping on reads nothing (as collections do).
		const axis = previous && series.axes.find(candidate => (previous[candidate.key] ?? 0) !== safeCoordinates[candidate.key]);
		if (axis && previous) {
			const step = Math.sign(safeCoordinates[axis.key] - (previous[axis.key] ?? 0));
			const wanted = { ...safeCoordinates, [axis.key]: safeCoordinates[axis.key] + step };
			const next = series.planes.find(candidate =>
				series.axes.every(a => (candidate.coordinates[a.key] || 0) === wanted[a.key]));
			if (next && next.resourceUri !== plane.resourceUri) {
				const resource = vscode.Uri.parse(next.resourceUri);
				this.offerPrefetchOf(resource, this._webviewEditor.webview.asWebviewUri(resource).toString(), this._switchGeneration);
			}
		}
	}

	public async registerOmeDataset(description: any): Promise<void> {
		if (this._datasetManifest || !description) { return; }
		const generation = this._switchGeneration;
		const currentResource = description.currentResourceUri ? vscode.Uri.parse(description.currentResourceUri) : this.getCurrentImage();
		const baseDirectory = Utils.dirname(currentResource);
		const resolveFile = (fileName: string | undefined): vscode.Uri | undefined => {
			if (!fileName) { return currentResource; }
			const normalized = String(fileName).replace(/\\/g, '/');
			if (normalized.startsWith('/') || normalized.split('/').includes('..')) { return undefined; }
			const resolved = Utils.joinPath(baseDirectory, ...normalized.split('/').filter(Boolean));
			const basePath = baseDirectory.path.endsWith('/') ? baseDirectory.path : `${baseDirectory.path}/`;
			return resolved.path.startsWith(basePath) ? resolved : undefined;
		};

		if (description.metadataFile) {
			const metadataResource = resolveFile(String(description.metadataFile));
			if (!metadataResource) {
				vscode.window.showWarningMessage('OME BinaryOnly metadata reference is outside the image folder and was not opened.');
				return;
			}
			try {
				const bytes = await vscode.workspace.fs.readFile(metadataResource);
				const lower = metadataResource.path.toLowerCase();
				const xml = lower.endsWith('.ome') || lower.endsWith('.xml')
					? new TextDecoder('utf-8').decode(bytes)
					: tiffImageDescription(bytes);
				const parsed = parseOmeDatasetXml(xml);
				if (!parsed) { throw new Error('referenced file contains no OME Image metadata'); }
				if (description.metadataUuid && parsed.uuid && description.metadataUuid !== parsed.uuid) {
					throw new Error(`metadata UUID mismatch (expected ${description.metadataUuid}, found ${parsed.uuid})`);
				}
				description = {
					...description,
					uuid: parsed.uuid || description.metadataUuid,
					series: parsed.series,
				};
			} catch (error) {
				vscode.window.showWarningMessage(`Could not load referenced OME metadata '${description.metadataFile}': ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
		}

		const seriesDescriptions: any[] = Array.isArray(description.series)
			? description.series
			: Array.isArray(description.planes) ? [description] : [];
		if (seriesDescriptions.length === 0) { return; }
		const candidates: Array<{ series: any; seriesIndex: number; plane: any; resource: vscode.Uri | undefined }> = seriesDescriptions.flatMap((series: any, seriesIndex: number) =>
			(series.planes || []).map((plane: any) => ({ series, seriesIndex, plane, resource: resolveFile(plane.fileName) })));
		const availability = new Map<string, boolean>();
		const uniqueResources = new Map<string, vscode.Uri>();
		for (const candidate of candidates) {
			if (candidate.resource) { uniqueResources.set(candidate.resource.toString(), candidate.resource); }
		}
		await Promise.all([...uniqueResources.values()].map(async resource => {
			try { await vscode.workspace.fs.stat(resource); availability.set(resource.toString(), true); }
			catch { availability.set(resource.toString(), false); }
		}));
		const datasetSeries: DatasetSeries[] = seriesDescriptions.map((series: any, seriesIndex: number): DatasetSeries => {
			const planes: DatasetPlane[] = candidates
				.filter(candidate => candidate.seriesIndex === seriesIndex)
				.flatMap(({ plane, resource }: any) => {
					if (!resource || !availability.get(resource.toString())) { return []; }
					return [{
						coordinates: { c: Number(plane.c || 0), z: Number(plane.z || 0), t: Number(plane.t || 0) },
						resourceUri: resource.toString(),
						format: 'tiff' as const,
						pageIndex: Number(plane.ifd || 0),
					}];
				});
			return {
				id: String(series.imageId || `Image:${seriesIndex}`),
				label: String(series.imageName || `OME Image ${seriesIndex + 1}`),
				axes: [
					{ key: 'c', label: 'C', size: Math.max(1, Number(series.sizeC || 1)), valueLabels: Array.isArray(series.channelNames) ? series.channelNames : undefined },
					{ key: 'z', label: 'Z', size: Math.max(1, Number(series.sizeZ || 1)) },
					{ key: 't', label: 'T', size: Math.max(1, Number(series.sizeT || 1)) },
				],
				planes,
			};
		}).filter(series => series.planes.length > 0);
		if (datasetSeries.length === 0) { return; }
		const availablePlaneCount = datasetSeries.reduce((sum, series) => sum + series.planes.length, 0);
		const missing = candidates.length - availablePlaneCount;
		const currentPage = Number(description.currentPageIndex || 0);
		let initialSeriesIndex = datasetSeries.findIndex(series => series.planes.some(plane =>
			plane.resourceUri === currentResource.toString() && plane.pageIndex === currentPage));
		if (initialSeriesIndex < 0) { initialSeriesIndex = 0; }
		const currentPlane = datasetSeries[initialSeriesIndex].planes.find(plane =>
			plane.resourceUri === currentResource.toString() && plane.pageIndex === currentPage) || datasetSeries[initialSeriesIndex].planes[0];
		const manifest: DatasetManifest = {
			id: `ome-${description.uuid || seriesDescriptions[0]?.imageId || currentResource.toString()}`,
			kind: 'ome-tiff',
			label: description.imageName || seriesDescriptions[0]?.imageName || Utils.basename(baseDirectory),
			series: datasetSeries,
			initialSeriesIndex,
			initialCoordinates: { ...currentPlane.coordinates },
		};
		if (generation !== this._switchGeneration) { return; }
		this.setDatasetManifest(manifest);
		if (missing > 0) {
			vscode.window.showWarningMessage(`OME dataset opened with ${missing} unavailable plane mapping${missing === 1 ? '' : 's'}.`);
		}
	}

	private sendDatasetPlane(plane: DatasetPlane): void {
		const resource = vscode.Uri.parse(plane.resourceUri);
		this.postViewerMessage({
			type: 'switchToDatasetPlane',
			uri: this._webviewEditor.webview.asWebviewUri(resource).toString(),
			resourceUri: resource.toString(),
			formatHint: plane.format,
			pageIndex: plane.pageIndex,
			frameIndex: plane.frameIndex,
			seriesIndex: this._datasetSeriesIndex,
			coordinates: this._datasetCoordinates,
		});
	}

	/**
	 * Images to add as layers once the webview is ready (used when a Layers
	 * window is opened with extra images, e.g. a whole collection).
	 */
	private _initialLayers: vscode.Uri[] = [];
	public setInitialLayers(uris: vscode.Uri[]): void {
		this._initialLayers = uris;
	}

	/** Send the queued initial layers to the webview (once it has loaded). */
	public sendInitialLayers(): void {
		if (this._initialLayers.length > 0) {
			const uris = this._initialLayers;
			this._initialLayers = [];
			this.addLayerImages(uris);
		}
	}

	/**
	 * Ensure the webview's localResourceRoots cover the directories of the given
	 * URIs, reassigning webview.options at most once. Reassigning options reloads
	 * the webview, so callers should pass a whole batch to avoid repeated reloads,
	 * and this is a no-op when every folder is already covered.
	 */
	public ensureLocalResourceRoots(uris: vscode.Uri[]): void {
		const currentRoots = this._webviewEditor.webview.options.localResourceRoots ?? [];
		const toAdd: vscode.Uri[] = [];
		const isCovered = (dir: vscode.Uri): boolean => {
			return [...currentRoots, ...toAdd].some(root => {
				if (root.scheme !== dir.scheme || root.authority !== dir.authority) {
					return false;
				}
				const rootPath = root.path.endsWith('/') ? root.path : `${root.path}/`;
				return dir.path === root.path || dir.path.startsWith(rootPath);
			});
		};
		for (const uri of uris) {
			const dir = Utils.dirname(uri).with({ query: '', fragment: '' });
			if (!isCovered(dir)) {
				toAdd.push(dir);
			}
		}
		if (toAdd.length > 0) {
			this._webviewEditor.webview.options = {
				...this._webviewEditor.webview.options,
				localResourceRoots: [...currentRoots, ...toAdd],
			};
		}
	}

	/**
	 * The exclusive mode of this view. A preview is either a layer-compositing
	 * view or an image collection, never both.
	 */
	public getViewMode(): 'layers' | 'collection' | 'normal' {
		if (this._isLayerView) { return 'layers'; }
		if (this._imageCollection.length > 1) { return 'collection'; }
		return 'normal';
	}

	/** Called when the webview reports the Layers panel opened/closed. */
	public setLayerMode(active: boolean): void {
		this._isLayerView = active;
		this._manager.refreshActiveMode();
	}

	/**
	 * Convert layer resource URIs to webview-safe URIs so the webview can re-fetch
	 * them when restoring a layer stack after a reload. Ensures the folders are in
	 * localResourceRoots first.
	 */
	public resolveLayerUris(resourceUris: string[]): void {
		const uris = resourceUris.map(s => vscode.Uri.parse(s));

		const currentRoots = this._webviewEditor.webview.options.localResourceRoots ?? [];
		const rootsToAdd = uris
			.map(u => Utils.dirname(u).with({ query: '', fragment: '' }))
			.filter(dir => !currentRoots.some(r => r.toString() === dir.toString()));
		if (rootsToAdd.length > 0) {
			this._webviewEditor.webview.options = {
				...this._webviewEditor.webview.options,
				localResourceRoots: [...currentRoots, ...rootsToAdd],
			};
		}

		const map: { [key: string]: string } = {};
		for (const u of uris) {
			map[u.toString()] = this._webviewEditor.webview.asWebviewUri(u).toString();
		}
		this.postViewerMessage({ type: 'layerUrisResolved', map });
	}

	public getSurfaceMode(): 'editor' | 'layers' {
		return this._surfaceMode;
	}

	/** Bring this preview's tab to the foreground. */
	public reveal(): void {
		this._webviewEditor.reveal();
	}

	/**
	 * Send images to the webview to be decoded and added as layers. Reuses
	 * ensureLocalResourceRoots so the webview can fetch files outside the initial folder.
	 * @param uris Image resources to add as layers.
	 */
	public addLayerImages(uris: vscode.Uri[]): void {
		if (uris.length === 0) { return; }
		if (this._imageCollection.length > 1) {
			vscode.window.showWarningMessage('Layers are not available for a multi-image collection.');
			return;
		}
		this.ensureLocalResourceRoots(uris);
		const images = uris.map(u => ({
			src: this._webviewEditor.webview.asWebviewUri(u).toString(),
			resourceUri: u.toString(),
		}));
		this.postViewerMessage({ type: 'addLayerImages', images });
	}

	/** Returns true if the image was added, false if it was already in the collection. */
	public async addToImageCollection(uri: vscode.Uri): Promise<boolean> {
		if (this._isLayerView) {
			// This view is a layer composition — collections are disabled here.
			return false;
		}
		if (this._imageCollection.some(img => img.toString() === uri.toString())) {
			return false;
		}

		this._imageCollection.push(uri);
		// Adding a second image makes this a collection — keep the menu state in sync.
		this._manager.refreshActiveMode();

		// Make sure the webview can fetch this image's folder. Reassigning
		// webview.options reloads the webview, so this is a no-op when the folder
		// is already covered (e.g. it's inside the workspace).
		this.ensureLocalResourceRoots([uri]);

		// Start preloading the image data (async, don't wait)
		this.preloadImageData(uri);
		this.offerPrefetch(this._switchGeneration);
		// Update overlay immediately
		this.updateImageCollectionOverlay();
		return true;
	}

	public jumpToCollectionIndex(index: number): void {
		if (index < 0 || index >= this._imageCollection.length || index === this._currentImageIndex) {
			return;
		}
		this.saveCurrentZoomState();
		this.switchToImageAtIndex(index);
	}

	public removeCurrentFromCollection(): void {
		if (this._imageCollection.length <= 1) {
			return; // Can't remove the only image
		}

		const removedKey = this._imageCollection[this._currentImageIndex].toString();
		this._imageCollection.splice(this._currentImageIndex, 1);
		this._preloadedImageData.delete(removedKey);
		this._collectionDatasets.delete(removedKey);

		// If we removed the last item, step back one index
		if (this._currentImageIndex >= this._imageCollection.length) {
			this._currentImageIndex = this._imageCollection.length - 1;
		}

		this.switchToImageAtIndex(this._currentImageIndex);
	}


	public toggleToNextImage(): void {
		if (this._imageCollection.length <= 1) {
			return; // No other images to toggle to
		}

		// Save current zoom/position state
		this.saveCurrentZoomState();

		// Move to next image (cycle back to 0 if at end)
		this._switchDirection = 1;
		this._currentImageIndex = (this._currentImageIndex + 1) % this._imageCollection.length;

		// Update current resource and reload
		this.switchToImageAtIndex(this._currentImageIndex);
	}

	public toggleToPreviousImage(): void {
		if (this._imageCollection.length <= 1) {
			return; // No other images to toggle to
		}

		// Save current zoom/position state
		this.saveCurrentZoomState();

		// Move to previous image (cycle to end if at beginning)
		this._switchDirection = -1;
		this._currentImageIndex = (this._currentImageIndex - 1 + this._imageCollection.length) % this._imageCollection.length;

		// Update current resource and reload
		this.switchToImageAtIndex(this._currentImageIndex);
	}

	private async preloadImageData(uri: vscode.Uri): Promise<void> {
		const key = uri.toString();
		const webviewUri = this._webviewEditor.webview.asWebviewUri(uri);

		// Store the webview URI for later use
		this._preloadedImageData.set(key, {
			uri: uri,
			webviewUri: webviewUri.toString(),
			loaded: false
		});
	}

	private saveCurrentZoomState(): void {
		if (this.previewState === PreviewState.Active) {
			this.postViewerMessage({ type: 'getComparisonState' });
		}
	}

	private switchToImageAtIndex(index: number): void {
		if (index < 0 || index >= this._imageCollection.length) {
			return;
		}

		this._currentImageIndex = index;
		const newResource = this._imageCollection[index];
		const cacheKey = newResource.toString();
		const cachedData = this._preloadedImageData.get(cacheKey);
		const loadStartTime = Date.now();
		const generation = ++this._switchGeneration;
		void this.sourceOffer(newResource).then(source => {
			// A later switch has already been sent.
			if (generation !== this._switchGeneration) { return; }
			this.postSwitchToImage(newResource, cachedData?.webviewUri, loadStartTime, source);
			this.offerPrefetch(generation);
		});
	}

	/**
	 * Offers the next collection image in the direction of travel; the viewer
	 * requests it once the current one has loaded, so the next switch reads
	 * nothing.
	 */
	private offerPrefetch(generation: number): void {
		const count = this._imageCollection.length;
		if (count < 2) { return; }
		const resource = this._imageCollection[(this._currentImageIndex + this._switchDirection + count) % count];
		this.offerPrefetchOf(resource, this.collectionWebviewUri(resource), generation);
	}

	/** Offer `resource` (shown at `uri`) for the viewer to read while it is idle. */
	private offerPrefetchOf(resource: vscode.Uri, uri: string, generation: number): void {
		void this.pushableStat(resource, PREFETCH_MAX_BYTES).then(stat => {
			if (!stat || generation !== this._switchGeneration) { return; }
			// The viewer already holds (or is fetching) this exact file.
			const key = `${resource.toString()}|${stat.size}|${stat.mtime}`;
			if (key === this._lastPrefetchKey) { return; }
			this._lastPrefetchKey = key;
			const token = getNonce();
			this.registerPushableSource(token, resource, stat.size);
			this.postViewerMessage({ type: 'prefetchSource', uri, token, ...stat });
		});
	}

	private collectionWebviewUri(resource: vscode.Uri): string {
		return this._preloadedImageData.get(resource.toString())?.webviewUri
			|| this._webviewEditor.webview.asWebviewUri(resource).toString();
	}

	private postSwitchToImage(newResource: vscode.Uri, webviewUri: string | undefined, loadStartTime: number, source: { token: string; size: number; mtime: number } | undefined): void {
		// Dataset navigation belongs to the outgoing entry, not the collection.
		this._datasetManifest = undefined;
		this._datasetCurrentResource = undefined;
		this._datasetSeriesIndex = 0;
		this._datasetCoordinates = {};
		// Send switch request to webview
		this.postViewerMessage({
			type: 'switchToImage',
			uri: webviewUri || this._webviewEditor.webview.asWebviewUri(newResource).toString(),
			resourceUri: newResource.toString(),
			loadStartTime,
			collection: {
				currentIndex: this._currentImageIndex,
				totalImages: this._imageCollection.length,
				show: this._imageCollection.length > 1
			},
			source,
		});

		const dataset = this._collectionDatasets.get(newResource.toString());
		if (dataset) { this.setDatasetManifest(dataset); }

		// Update overlay
		this.updateImageCollectionOverlay();

		// Restore comparison state after the image loads (zoom is handled webview-side)
		setTimeout(() => {
			if (this._currentComparisonState && this._currentComparisonState.peerUris.length > 0) {
				this.postViewerMessage({
					type: 'restoreComparisonState',
					state: this._currentComparisonState
				});
			}
		}, 300);
	}

	private updateImageCollectionOverlay(): void {
		if (this.previewState === PreviewState.Active) {
			const overlayData = {
				totalImages: this._imageCollection.length,
				currentIndex: this._currentImageIndex,
				show: this._imageCollection.length > 1
			};

			this.postViewerMessage({
				type: 'updateImageCollectionOverlay',
				data: overlayData
			});
		}
	}

	private sendSettingsUpdate(settings: WebviewImageSettings, reason: string): void {
		// Send to both Active and Visible previews (for multi-preview support)
		if (this.previewState === PreviewState.Active || this.previewState === PreviewState.Visible) {
			// Use the currently displayed image URI (not always the original resource when
			// using the image collection). This prevents settings updates from triggering
			// a full reload when the webview is showing a different image in the collection.
			const currentResource = this.getCurrentImage();
			const uri = this._webviewEditor.webview.asWebviewUri(currentResource);
			const webviewSafeSettings = {
				...settings,
				resourceUri: currentResource.toString(),
				src: uri.toString()
			};

			this.postViewerMessage({
				type: 'updateSettings',
				settings: webviewSafeSettings,
				reason
			});
		}
	}

	public updateStatusBar() {
		if (this.previewState !== PreviewState.Active) {
			this._sizeStatusBarEntry.hide(this);
			this._zoomStatusBarEntry.hide(this);
			this._normalizationStatusBarEntry.forceHide();
			this._gammaStatusBarEntry.hide();
			this._brightnessStatusBarEntry.hide();
			this._layersStatusBarEntry.hide();
			this._histogramStatusBarEntry.hide();
			return;
		}

		if (this._webviewEditor.active && this._webviewEditor.visible) {
			this._sizeStatusBarEntry.show(this, this._imageSize || '');
			this._zoomStatusBarEntry.show(this, this._imageZoom || 'fit');

			// Show the Layers button while a preview is active.
			this._layersStatusBarEntry.show();

			// Always show normalization controls for all image formats
			const normSettings = this._manager.appStateManager.imageSettings.normalization;
			this._normalizationStatusBarEntry.setRgbAs24BitMode(
				this._manager.appStateManager.imageSettings.rgbAs24BitGrayscale
			);
			this._normalizationStatusBarEntry.setNormalizedFloatMode(
				this._manager.appStateManager.imageSettings.normalizedFloatMode
			);
			this._normalizationStatusBarEntry.updateNormalization(
				normSettings.min,
				normSettings.max
			);
			this._normalizationStatusBarEntry.show(
				normSettings.autoNormalize,
				normSettings.gammaMode
			);

			// Show gamma/brightness controls when in gamma mode
			if (normSettings.gammaMode) {
				this._gammaStatusBarEntry.updateGamma(this._manager.appStateManager.imageSettings.gamma.in, this._manager.appStateManager.imageSettings.gamma.out);
				this._brightnessStatusBarEntry.updateBrightness(this._manager.appStateManager.imageSettings.brightness.offset);
				this._gammaStatusBarEntry.show();
				this._brightnessStatusBarEntry.show();
			} else {
				this._gammaStatusBarEntry.hide();
				this._brightnessStatusBarEntry.hide();
			}
		}

		// Always show histogram button
		this._histogramStatusBarEntry.show();
	}

	protected override async getWebviewContents(): Promise<string> {
		const version = Date.now().toString();

		// Detect format from file extension for HTML generation
		// Note: We do NOT call setImageFormat() here to avoid premature format switching
		// The webview will report the actual format via formatInfo message
		const lower = this.resource.path.toLowerCase();
		const formatHint = this._manager.getResourceFormatHint(this.resource);
		const isTiff = formatHint
			? /^(?:tiff|tif|tf2|tf8|btf)$/i.test(formatHint)
			: /\.(?:tif|tiff|tf2|tf8|btf)$/.test(lower);
		const remoteTiffUrl = isTiff && /^(?:https?)$/.test(this.resource.scheme)
			? this.resource.toString()
			: undefined;
		const isPpm = lower.endsWith('.ppm') || lower.endsWith('.pgm') || lower.endsWith('.pbm');
		const isPng = lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg');
		const isPfm = lower.endsWith('.pfm');
		const isNpy = lower.endsWith('.npy') || lower.endsWith('.npz');
		const isExr = lower.endsWith('.exr');
		const isHdr = lower.endsWith('.hdr');
		const isTga = lower.endsWith('.tga');
		const isWebImage = lower.endsWith('.webp') || lower.endsWith('.avif') || lower.endsWith('.bmp') || lower.endsWith('.ico');
		const isJxl = lower.endsWith('.jxl');
		const isScientificArray = /\.(?:rgb|rgba|sgi|bw|fits|fit|fts|dcm|dicom|nc|cdf|czi)$/.test(lower);
		const isLayeredDocument = /\.(?:ora|kra|psd|psb|xcf|afphoto|af)$/.test(lower);
		this._isTiff = isTiff || isPpm || isPng || isPfm || isNpy || isExr || isHdr || isTga || isWebImage || isJxl || isScientificArray || isLayeredDocument;
		// A content-identified TIFF whose URL happens to end in .jpg must never
		// take the browser's native-JPEG bootstrap. The TIFF hint has higher
		// authority than the path throughout the complete startup pipeline.
		const nativeFormat = isTiff ? undefined : nativeFormatForPath(lower);
		const targetImageSettings = nativeFormat
			? this._manager.appStateManager.getSettingsForFormat(nativeFormat)
			: this._manager.appStateManager.imageSettings;
		const nativeFirstPaint = !!nativeFormat && canUseNativeFirstPaint(targetImageSettings, this._surfaceMode);

		// Merge settings from both managers:
		// - normalization, gamma, brightness, rgbAs24BitGrayscale, scale24BitFactor, normalizedFloatMode from appStateManager (per-format)
		// - nan color / color-picker mode from preview settings
		const settings = {
			normalization: targetImageSettings.normalization,
			gamma: targetImageSettings.gamma,
			brightness: targetImageSettings.brightness,
			rgbAs24BitGrayscale: targetImageSettings.rgbAs24BitGrayscale,
			scale24BitFactor: targetImageSettings.scale24BitFactor,
			normalizedFloatMode: targetImageSettings.normalizedFloatMode,
			nanColor: this._manager.settingsManager.getNanColor(),
			colorPickerShowModified: this._manager.settingsManager.getColorPickerShowModified(),
			showScaleBar: this._manager.settingsManager.getShowScaleBar(),
			plyVisualizerInstalled: !!vscode.extensions.getExtension('kleinicke.ply-visualizer'),
			navigationShortcuts: vscode.workspace.getConfiguration('tiffVisualizer').get<Record<string, string[]>>('navigationShortcuts', {}),
			gpuAcceleration: this.getGpuAccelerationEnabled(),
			scrollToZoom: this.getScrollToZoom(),
			channelDefaults: this.getChannelDefaults(),
			cellsAutoOpenPanel: this.getCellsAutoOpenPanel(),
			cellIdCols: getCellIdColumns()
		};

		const nonce = getNonce();
		const cspSource = this._webviewEditor.webview.cspSource;

		const uri = this._webviewEditor.webview.asWebviewUri(this.resource);
		const workspaceUri = vscode.workspace.getWorkspaceFolder(this.resource)?.uri ?? this.resource;
		const folderUri = this._webviewEditor.webview.asWebviewUri(workspaceUri);

		// Extend settings with required properties for JavaScript
		const extendedSettings = {
			...settings,
			resourceUri: this.resource.toString(),
			src: uri.toString(),
			remoteTiffUrl,
			formatHint,
			folder: folderUri.toString(),
			version: version,
			surfaceMode: this._surfaceMode, // 'layers' = dedicated Layers window
			extensionVersion: this._extensionVersion,
			vscodeVersion: vscode.version,
			loadStartTime: this._openTimestamp // For total elapsed time measurement (captured when file was opened)
		};

		const componentCssUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'imagePreview.bundle.css'));
		const cssUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'imagePreview.css'));
		const jsUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'imagePreview.bundle.js'));
		const decodeWorkerUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'decodeWorker.bundle.js'));
		const fastRawWorkerUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'fastRawWorker.bundle.js'));
		const layeredDecodeWorkerUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'layeredDecodeWorker.bundle.js'));
		const pngDecodeWorkerUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'pngDecodeWorker.bundle.js'));
		const wasmUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'wasm', 'tiff-wasm.wasm'));
		// The JPEG XL decoder is a separate module; naming it here costs nothing,
		// and nothing fetches it until a .jxl is opened.
		const jxlWasmUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'wasm', 'jxl-wasm.wasm'));
		const codecWasmUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'wasm', 'codec-wasm.wasm'));
		const geotiffUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'geotiff.min.js'));
		const pakoUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'pako.min.js'));
		const upngUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'upng.min.js'));
		const parseExrUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'parse-exr.js'));
		const layeredPreviewFallbackUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'layeredPreviewFallback.bundle.js'));
		const layerDocumentWriterUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'layerDocumentWriter.bundle.js'));
		const imagejRoiUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'imagejRoi.bundle.js'));
		// Named here so the Cells section can read a segmentation, table or mask; nothing fetches either until a file is added.
		const cellsWorkerUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'xeniumCellsWorker.bundle.js'));
		const tileWorkerUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'xeniumTileWorker.bundle.js'));
		const transcriptsWasmUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'wasm', 'transcripts-wasm.wasm'));
		const vendorAssets = {
			wasm: wasmUri.toString(),
			workers: {
				'decodeWorker.bundle.js': decodeWorkerUri.toString(),
				'fastRawWorker.bundle.js': fastRawWorkerUri.toString(),
				'layeredDecodeWorker.bundle.js': layeredDecodeWorkerUri.toString(),
				'pngDecodeWorker.bundle.js': pngDecodeWorkerUri.toString(),
				'xeniumCellsWorker.bundle.js': cellsWorkerUri.toString(),
				'xeniumTileWorker.bundle.js': tileWorkerUri.toString(),
			},
			transcriptsWasm: transcriptsWasmUri.toString(),
			jxlWasm: jxlWasmUri.toString(),
			codecWasm: codecWasmUri.toString(),
			geotiff: geotiffUri.toString(),
			pako: pakoUri.toString(),
			upng: upngUri.toString(),
			parseExr: parseExrUri.toString(),
			layeredPreviewFallback: layeredPreviewFallbackUri.toString(),
			layerDocumentWriter: layerDocumentWriterUri.toString(),
			imagejRoi: imagejRoiUri.toString(),
			nonce,
		};
		const warmFastRawDecoder = lower.endsWith('.ppm') || isPfm || lower.endsWith('.npy');
		const warmGeneralDecoder = isTiff || lower.endsWith('.npz') || isExr || isHdr || isScientificArray;
		const warmDecoderUri = isLayeredDocument ? layeredDecodeWorkerUri : warmFastRawDecoder ? fastRawWorkerUri : warmGeneralDecoder ? decodeWorkerUri : null;
		const warmDecoderBundleName = !warmDecoderUri ? null : isLayeredDocument ? 'layeredDecodeWorker.bundle.js'
			: warmFastRawDecoder ? 'fastRawWorker.bundle.js' : 'decodeWorker.bundle.js';
		const speculativeDecodeFormat = isTiff ? 'tiff'
			: lower.endsWith('.ppm') ? 'ppm'
			: isPfm ? 'pfm'
				: lower.endsWith('.npy') ? 'npy'
					: isHdr ? 'hdr'
							: null;
		const warmSourceRead = this.sourceIsReadWhole(this.resource);
		// Large TIFFs are read as a stream into a buffer of the file's size, so the
		// strip pool can start decoding ranges whose bytes have arrived while the
		// rest is still being read. The size comes from the host because webview
		// resource responses carry no Content-Length.
		// Local sources are pushed by the host (see source-push.ts) instead.
		let streamSourceBytes = 0;
		let pushedSourceBytes = 0;
		const pushable = warmSourceRead && canPushSource(this.resource);
		if (warmSourceRead && (isTiff || pushable)) {
			try {
				const { size } = await vscode.workspace.fs.stat(this.resource);
				streamSourceBytes = isTiff && size >= STREAMED_TIFF_MIN_BYTES ? size : 0;
				pushedSourceBytes = pushable && size >= PUSHED_SOURCE_MIN_BYTES ? size : 0;
			} catch { /* stream nothing; the ordinary read still works */ }
		}
		if (pushedSourceBytes > 0) {
			this.registerPushableSource(nonce, this.resource, pushedSourceBytes);
		}
		const decoderWarmupScript = warmSourceRead ? /* html */`
	<script nonce="${nonce}">
		(function () {
			const imageSourceUri = ${JSON.stringify(uri.toString())};
			const sourceReadMetrics = {};
			// A progressive view of the source while it is read, for large TIFFs:
			// the strip pool dispatches each range once its bytes have arrived.
			// The bootstrap decode below must not take (transfer) the buffer while
			// the viewer may still be copying ranges out of it, so it waits for
			// releaseImageStream(), which the viewer calls when it is done or
			// when it claims that decode.
			const streamBytes = ${streamSourceBytes};
			let releaseImageStream = () => {};
			const imageStreamReleased = streamBytes > 0 ? new Promise(resolve => { releaseImageStream = resolve; }) : null;
			// Local sources arrive as sourceChunk messages from the host, in file
			// order, tagged with this page's token.
			const pushedBytes = ${pushedSourceBytes};
			const pushToken = ${JSON.stringify(pushedSourceBytes > 0 ? nonce : null)};
			// acquireVsCodeApi() works once per page; the viewer reuses this one.
			const vscodeApi = pushedBytes > 0 ? acquireVsCodeApi() : null;
			if (vscodeApi) window.__tiffVisualizerVsCodeApi = vscodeApi;
			const createStream = total => ({
				total,
				received: 0,
				bytes: null,
				error: null,
				waiters: [],
				whenAvailable(end) {
					if (this.error) return Promise.reject(this.error);
					if (this.received >= Math.min(end, this.total)) return Promise.resolve();
					return new Promise((resolve, reject) => this.waiters.push({ end, resolve, reject }));
				},
				settle() {
					const pending = this.waiters;
					this.waiters = [];
					for (const waiter of pending) {
						if (this.error) waiter.reject(this.error);
						else if (this.received >= Math.min(waiter.end, this.total)) waiter.resolve();
						else this.waiters.push(waiter);
					}
				}
			});
			const imageStream = streamBytes > 0 ? createStream(streamBytes) : null;
			const readPushed = stream => new Promise((resolve, reject) => {
				const bytes = new Uint8Array(stream.total);
				stream.bytes = bytes;
				let idle = 0;
				let retries = 0;
				const finish = error => {
					clearTimeout(idle);
					window.removeEventListener('message', onChunk);
					if (error) reject(error); else resolve(bytes.buffer);
				};
				// Ask from the first missing byte; a request replaces the host's
				// previous push. Chunks that stop arriving are asked for again.
				const request = () => {
					clearTimeout(idle);
					idle = setTimeout(() => {
						if (++retries > 3) finish(new Error('pushed image source stalled'));
						else request();
					}, 5000);
					vscodeApi.postMessage({ type: 'sourceRequest', token: pushToken, offset: stream.received });
				};
				function onChunk(event) {
					const chunk = event.data;
					if (chunk?.type !== 'sourceChunk' || chunk.token !== pushToken) return;
					if (chunk.error) return finish(new Error(chunk.error));
					// A chunk of a push this page has since replaced.
					if (chunk.offset !== stream.received) return;
					if (stream.received + chunk.bytes.byteLength > bytes.byteLength) {
						return finish(new Error('pushed image source is larger than announced'));
					}
					bytes.set(chunk.bytes, chunk.offset);
					stream.received += chunk.bytes.byteLength;
					stream.settle();
					if (stream.received === bytes.byteLength) finish(null);
					else { retries = 0; clearTimeout(idle); idle = setTimeout(request, 5000); }
				}
				window.addEventListener('message', onChunk);
				request();
			});
			const imageBufferPromise = (async () => {
				if (pushedBytes > 0) {
					const readStart = performance.now();
					try {
						const buffer = await readPushed(imageStream || createStream(pushedBytes));
						sourceReadMetrics.responseMs = 0;
						sourceReadMetrics.arrayBufferMs = performance.now() - readStart;
						if (imageStream) setTimeout(releaseImageStream, 5000);
						return buffer;
					} catch (error) {
						if (imageStream) {
							// As for a failed fetch below: the viewer falls back to an ordinary read.
							imageStream.error = error instanceof Error ? error : new Error(String(error));
							imageStream.settle();
							releaseImageStream();
							throw imageStream.error;
						}
						// Otherwise read the resource the ordinary way.
					}
				}
				const responseStart = performance.now();
				const response = await fetch(imageSourceUri);
				sourceReadMetrics.responseMs = performance.now() - responseStart;
				if (!response.ok) throw new Error('image source warmup failed');
				const readStart = performance.now();
				if (imageStream && response.body) {
					try {
						const bytes = new Uint8Array(imageStream.total);
						imageStream.bytes = bytes;
						const reader = response.body.getReader();
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							if (imageStream.received + value.byteLength > bytes.byteLength) throw new Error('image grew while it was read');
							bytes.set(value, imageStream.received);
							imageStream.received += value.byteLength;
							imageStream.settle();
						}
						if (imageStream.received !== bytes.byteLength) throw new Error('image shrank while it was read');
						// Safety net: every range has been copied long before this,
						// even if the viewer never released the stream itself.
						setTimeout(releaseImageStream, 5000);
						sourceReadMetrics.arrayBufferMs = performance.now() - readStart;
						return bytes.buffer;
					} catch (error) {
						// Fail every pending range; the viewer falls back to an ordinary read.
						imageStream.error = error instanceof Error ? error : new Error(String(error));
						imageStream.settle();
						releaseImageStream();
						throw imageStream.error;
					}
				}
				const buffer = await response.arrayBuffer();
				sourceReadMetrics.arrayBufferMs = performance.now() - readStart;
				return buffer;
			})();
			const sourcePromise = ${warmDecoderUri ? `fetch(${JSON.stringify(warmDecoderUri.toString())}).then(response => {
				if (!response.ok) throw new Error('decode worker warmup failed');
				return response.text();
			})` : 'null'};
			// Layered documents use it too: embedded PNGs decode in Rust on their
			// worker, and a PSD composite on the strip pool.
			const wasmResourcePromise = ${warmGeneralDecoder || isLayeredDocument ? `fetch(${JSON.stringify(wasmUri.toString())}).then(response => {
				if (!response.ok) throw new Error('decoder WASM warmup failed');
				return { compileResponse: response.clone(), bytesResponse: response };
			})` : 'null'};
			let wasmBytesPromise = null;
			const getWasmBytes = wasmResourcePromise ? () => {
				wasmBytesPromise ||= wasmResourcePromise.then(resource => resource.bytesResponse.arrayBuffer());
				return wasmBytesPromise;
			} : null;
			const wasmModulePromise = wasmResourcePromise ? wasmResourcePromise.then(async resource => {
				const fallbackResponse = resource.compileResponse.clone();
				if (typeof WebAssembly.compileStreaming === 'function') {
					try {
						return await WebAssembly.compileStreaming(Promise.resolve(resource.compileResponse));
					} catch { /* incorrect MIME or unsupported response: use bytes below */ }
				}
				return WebAssembly.compile(await fallbackResponse.arrayBuffer());
			}) : null;
			const readyWorkerPromise = sourcePromise ? Promise.all([
				sourcePromise,
				wasmModulePromise ? wasmModulePromise.catch(() => null) : Promise.resolve(null)
			]).then(async ([source, wasmModule]) => {
				// A transferable compiled module is sufficient. Read and copy the
				// 3 MB payload only on the compile fallback path.
				const wasmBytes = !wasmModule && getWasmBytes ? await getWasmBytes() : null;
				return new Promise((resolve, reject) => {
				const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
				const worker = ${warmFastRawDecoder ? 'new Worker(blobUrl)' : `new Worker(blobUrl, { type: 'module' })`};
				const timeout = setTimeout(() => {
					worker.terminate();
					URL.revokeObjectURL(blobUrl);
					reject(new Error('decode worker warmup timed out'));
				}, 20000);
				worker.onerror = event => {
					clearTimeout(timeout);
					worker.terminate();
					URL.revokeObjectURL(blobUrl);
					reject(new Error(event.message || 'decode worker warmup failed'));
				};
				worker.onmessage = event => {
					if (event.data?.type !== 'ready') return;
					clearTimeout(timeout);
					worker.onmessage = null;
					worker.onerror = null;
					resolve({ worker, blobUrl, caps: event.data.caps || {}, wasmModule });
				};
				const wasmBuffer = wasmModule || !wasmBytes ? null : wasmBytes.slice(0);
				// An XCF preview composites in bands on the layered worker's own
				// workers; they boot while the file arrives.
				const initMessage = { type: 'init', tiffWasmModule: wasmModule, tiffWasmBuffer: wasmBuffer, prewarmBands: ${lower.endsWith('.xcf')} };
				worker.postMessage(initMessage, wasmBuffer ? [wasmBuffer] : []);
				});
			}) : null;
			const speculativeFormat = ${JSON.stringify(speculativeDecodeFormat)};
			const speculativeDecodeMetrics = {};
			const speculativeDecodePromise = speculativeFormat && readyWorkerPromise
				? Promise.all([readyWorkerPromise, imageBufferPromise, imageStreamReleased]).then(([adopted, buffer]) => new Promise(resolve => {
					const id = 0;
					// TIFF page navigation and decoder fallback need the source bytes
					// after the decode. Rather than copying them before the transfer
					// (a full-file copy on the critical path), the worker transfers its
					// untouched input back as \`sourceBuffer\` (\`returnSource\`).
					const timeout = setTimeout(() => resolve({
						ok: false,
						error: 'speculative decode timed out'
					}), 30000);
					speculativeDecodeMetrics.start = performance.now();
					speculativeDecodeMetrics.fileBytes = buffer.byteLength;
					adopted.worker.onmessage = event => {
						if (event.data?.id !== id) return;
						clearTimeout(timeout);
						speculativeDecodeMetrics.end = performance.now();
						speculativeDecodeMetrics.durationMs = speculativeDecodeMetrics.end - speculativeDecodeMetrics.start;
						adopted.worker.onmessage = null;
						resolve(event.data);
					};
					try {
						adopted.worker.postMessage({
							id,
							format: speculativeFormat,
							buffer,
							options: {
								numpyDataset: speculativeFormat === 'npy',
								computeStats: ${!settings.normalization?.gammaMode && settings.normalization?.autoNormalize !== false},
								preferParallelTiff: speculativeFormat === 'tiff',
								preferParallelHdr: speculativeFormat === 'hdr',
								returnSource: speculativeFormat === 'tiff' || speculativeFormat === 'hdr'
							}
						}, [buffer]);
					} catch (error) {
						clearTimeout(timeout);
						resolve({
							ok: false,
							error: String(error),
							buffer
						});
					}
				}))
				: null;
			// Adopting the worker replaces its message handler, so ownership passes
			// to the viewer only after the bootstrap decode response has arrived.
			const workerPromise = readyWorkerPromise && speculativeDecodePromise
				? Promise.all([readyWorkerPromise, speculativeDecodePromise]).then(([adopted]) => adopted)
				: readyWorkerPromise;
			// Consume failures here as well as in DecodeWorkerClient so an optional
			// warmup never becomes an unhandled rejection.
			sourcePromise?.catch(() => {});
			imageBufferPromise.catch(() => {});
			wasmModulePromise?.catch(() => {});
			speculativeDecodePromise?.catch(() => {});
			workerPromise?.catch(() => {});
			window.__tiffVisualizerDecoderWarmup = {
				bundleName: ${JSON.stringify(warmDecoderBundleName)},
				imageSourceUri,
				imageBufferPromise,
				imageStream,
				releaseImageStream: () => releaseImageStream(),
				sourceReadMetrics,
				imageBufferClaimed: false,
				speculativeFormat,
				speculativeDecodePromise,
				speculativeDecodeMetrics,
				speculativeDecodeClaimed: false,
				sourcePromise,
				wasmBytesPromise,
				getWasmBytes,
				wasmModulePromise,
				workerPromise
			};
		}());
	</script>` : '';
		const appScripts = [jsUri.toString()];
		const staticScripts = appScripts.map((scriptUri, index) =>
			`<script${index === appScripts.length - 1 ? ' type="module"' : ''} src="${escapeAttribute(scriptUri)}" nonce="${nonce}"></script>`
		).join('\n\t');
		const bootstrapScript = nativeFirstPaint ? /* html */`
	<script nonce="${nonce}">
		(function () {
			const vscode = window.__tiffVisualizerVsCodeApi || acquireVsCodeApi();
			const image = document.getElementById('native-fast-preview');
			const persisted = vscode.getState() || {};
			const stateAllowsNative = !persisted.colormapConversionState &&
				(!persisted.displayColormap || persisted.displayColormap === 'none') &&
				!persisted.debayer && !persisted.compositeEnabled &&
				!(Array.isArray(persisted.layers) && (persisted.layers.length > 1 || persisted.layerActive));
			window.__tiffVisualizerBootstrap = {
				vscode,
				nativeImage: stateAllowsNative ? image : null,
				visibleTotalMs: null
			};

			let appStarted = false;
			const scripts = ${JSON.stringify(appScripts)};
			function startApp() {
				if (appStarted) return;
				appStarted = true;
				let index = 0;
				const loadNext = () => {
					if (index >= scripts.length) return;
					const script = document.createElement('script');
					const isApp = index === scripts.length - 1;
					script.src = scripts[index++];
					script.nonce = ${JSON.stringify(nonce)};
					if (isApp) script.type = 'module';
					script.addEventListener('load', loadNext, { once: true });
					script.addEventListener('error', loadNext, { once: true });
					document.body.append(script);
				};
				loadNext();
			}

			if (!stateAllowsNative || !image) {
				image?.remove();
				startApp();
				return;
			}
			const showThenStart = () => {
				document.body.classList.remove('loading');
				document.body.classList.add('ready');
				requestAnimationFrame(() => requestAnimationFrame(() => {
					// The first frame had an opportunity to reach the screen. Keep
					// the same click/open origin as the existing total measurement.
					window.__tiffVisualizerBootstrap.visibleTotalMs = Math.max(0, Date.now() - ${this._openTimestamp});
					startApp();
				}));
				setTimeout(startApp, 100);
			};
			image.addEventListener('load', showThenStart, { once: true });
			image.addEventListener('error', startApp, { once: true });
			if (image.complete) {
				if (image.naturalWidth > 0) showThenStart();
				else startApp();
			}
		}());
	</script>` : '';

		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">

	<!-- Disable pinch zooming -->
	<meta name="viewport"
		content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">

	<title>Image Preview</title>

	<link rel="stylesheet" href="${escapeAttribute(cssUri.toString())}" type="text/css" media="screen" nonce="${nonce}">

	<link rel="stylesheet" href="${escapeAttribute(componentCssUri.toString())}" nonce="${nonce}">

	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: ${cspSource}; script-src 'nonce-${nonce}' ${cspSource} 'wasm-unsafe-eval' 'unsafe-eval'; worker-src blob:;style-src ${cspSource} 'nonce-${nonce}'; connect-src ${cspSource} https: http:;">
	<meta id="image-preview-settings" data-settings="${escapeAttribute(JSON.stringify(extendedSettings))}" data-resource="${escapeAttribute(uri.toString())}" data-folder="${escapeAttribute(folderUri.toString())}" data-version="${escapeAttribute(version)}">
</head>
<body class="container image${nativeFirstPaint ? ' loading' : ''}">
	<div class="loading-indicator" aria-label="Loading image"></div>
	<div class="image-load-error">
		<p>${vscode.l10n.t("An error occurred while loading the image.")}</p>
	</div>
	${nativeFirstPaint ? `<img id="native-fast-preview" class="scale-to-fit" src="${escapeAttribute(uri.toString())}" alt="">` : ''}

	<script nonce="${nonce}">
		// Add error handler for module loading
		window.addEventListener('error', function(e) {
			console.error('TIFF Visualizer: Script error:', e.error, e.filename, e.lineno, e.colno);
		});

		window.addEventListener('unhandledrejection', function(e) {
			console.error('TIFF Visualizer: Unhandled promise rejection:', e.reason);
		});
	</script>

	<script nonce="${nonce}">window.__tiffVisualizerVendorAssets = ${JSON.stringify(vendorAssets)};</script>
	${decoderWarmupScript}
	${bootstrapScript || staticScripts}
</body>
</html>`;
	}

	protected override async render(): Promise<void> {
		try {
			const content = await this.getWebviewContents();
			this._webviewEditor.webview.html = content;
			// The replaced page's push, if any, stops; the new page holds no prefetch.
			this._sourcePushGeneration++;
			this._lastPrefetchKey = '';
			this.updateStatusBar();
		} catch (error) {
			console.error('TIFF Visualizer render error:', error);
		}
	}

	/**
	 * The page's bootstrap asks for its source once it listens, and again from
	 * where it stopped if chunks stop arriving (a reloaded page asks afresh).
	 * Each request replaces the push before it.
	 */
	private onSourceRequest(message: { token?: unknown; offset?: unknown }): void {
		const token = typeof message.token === 'string' ? message.token : '';
		const source = this._pushableSources.get(token);
		const offset = Number(message.offset);
		if (!source || !Number.isSafeInteger(offset) || offset < 0 || offset > source.size) { return; }
		const generation = ++this._sourcePushGeneration;
		void pushSource(this._webviewEditor.webview, source.resource, token, source.size, offset,
			() => generation === this._sourcePushGeneration && this.previewState !== PreviewState.Disposed);
	}

	private registerPushableSource(token: string, resource: vscode.Uri, size: number): void {
		this._pushableSources.set(token, { resource, size });
		// The page's first image, the latest switch and prefetch are all it can still ask for.
		for (const oldest of this._pushableSources.keys()) {
			if (this._pushableSources.size <= 4) { break; }
			this._pushableSources.delete(oldest);
		}
	}

	/**
	 * Whether the viewer reads this file whole (rather than through an image
	 * element or in ranges): the formats the page bootstrap warms a decoder and
	 * the source read for, plus PGM, PBM and TGA, whose cheaper decoders run on
	 * the page itself, and the codestream and microscopy formats the decode
	 * worker reads on demand (JPEG XL/XR/2000, ND2, LIF, SDT).
	 */
	private sourceIsReadWhole(resource: vscode.Uri): boolean {
		const lower = resource.path.toLowerCase();
		const formatHint = this._manager.getResourceFormatHint(resource);
		const isTiff = formatHint
			? /^(?:tiff|tif|tf2|tf8|btf)$/i.test(formatHint)
			: /\.(?:tif|tiff|tf2|tf8|btf)$/.test(lower);
		if (isTiff) {
			// Remote TIFFs are read in ranges.
			return !/^(?:https?)$/.test(resource.scheme);
		}
		// CZI, ND2 and LIF are absent: the page reads only the parts of them a
		// plane needs (czi-source.ts, ranged-source.ts), never the whole file.
		return /\.(?:ppm|pgm|pbm|pfm|npy|npz|exr|hdr|tga)$/.test(lower)
			|| /\.(?:rgb|rgba|sgi|bw|fits|fit|fts|dcm|dicom|nc|cdf|sdt)$/.test(lower)
			|| /\.(?:jxl|jxr|wdp|hdp|jp2|jpf|jpx|j2k|j2c|jpc)$/.test(lower)
			|| /\.(?:ora|kra|psd|psb|xcf|afphoto|af)$/.test(lower);
	}

	/** Offers a collection image for pushing, when it is local and read whole. */
	private async sourceOffer(resource: vscode.Uri): Promise<{ token: string; size: number; mtime: number } | undefined> {
		const stat = await this.pushableStat(resource);
		if (!stat) { return undefined; }
		const token = getNonce();
		this.registerPushableSource(token, resource, stat.size);
		return { token, ...stat };
	}

	/** Size and mtime of a local, whole-read file worth pushing (1 MB to `maxBytes`). */
	private async pushableStat(resource: vscode.Uri, maxBytes = Infinity): Promise<{ size: number; mtime: number } | undefined> {
		if (!canPushSource(resource) || !this.sourceIsReadWhole(resource)) { return undefined; }
		try {
			const { size, mtime } = await vscode.workspace.fs.stat(resource);
			return size >= PUSHED_SOURCE_MIN_BYTES && size <= maxBytes ? { size, mtime } : undefined;
		} catch {
			return undefined;
		}
	}

	private async getResourcePath(webviewEditor: vscode.WebviewPanel, resource: vscode.Uri): Promise<string> {
		if (resource.scheme === 'git') {
			const stat = await vscode.workspace.fs.stat(resource);
			if (stat.size === 0) {
				return webviewEditor.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionRoot, 'media', 'loading.svg')).toString();
			}
		}

		// Avoid adding cache busting if there is already a query string
		if (resource.query) {
			return webviewEditor.webview.asWebviewUri(resource).toString();
		}
		return webviewEditor.webview.asWebviewUri(resource).toString(true);
	}

	private extensionResource(...parts: string[]) {
		return vscode.Uri.joinPath(this.extensionRoot, ...parts);
	}
}

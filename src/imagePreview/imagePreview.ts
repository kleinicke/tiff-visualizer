import * as vscode from 'vscode';
import { BinarySizeStatusBarEntry } from '../binarySizeStatusBarEntry';
import { MediaPreview, PreviewState } from '../mediaPreview';
import { escapeAttribute, getNonce } from '../util/dom';
import { SizeStatusBarEntry } from './sizeStatusBarEntry';
import { Scale, ZoomStatusBarEntry } from './zoomStatusBarEntry';
import { NormalizationStatusBarEntry } from './normalizationStatusBarEntry';
import { GammaStatusBarEntry } from './gammaStatusBarEntry';
import { BrightnessStatusBarEntry } from './brightnessStatusBarEntry';
import { MaskFilterStatusBarEntry } from './maskFilterStatusBarEntry';
import { HistogramStatusBarEntry } from './histogramStatusBarEntry';
import { ColorPickerModeStatusBarEntry } from './colorPickerModeStatusBarEntry';
import { MessageRouter } from './messageHandlers';
import type { IImagePreviewManager } from './types';
import type { ImageSettings } from './appStateManager';
import type { MaskFilterSettings } from './imageSettings';

// Extended settings for webview (includes per-image mask filters and nanColor)
interface WebviewImageSettings extends ImageSettings {
	maskFilters: MaskFilterSettings[];
	nanColor: 'black' | 'fuchsia';
	colorPickerShowModified: boolean;
}

export class ImagePreview extends MediaPreview {

	private _imageSize: string | undefined;
	private _imageZoom: Scale | undefined;
	private _isTiff: boolean = false;
	private _currentFormat: import('./appStateManager').ImageFormatType | undefined;

	// Image collection management
	private _imageCollection: vscode.Uri[] = [];
	private _currentImageIndex: number = 0;
	private _preloadedImageData: Map<string, { uri: vscode.Uri; webviewUri: string; loaded: boolean }> = new Map();
	private _currentZoomState: { scale: Scale; x: number; y: number } | undefined;
	private _currentComparisonState: { peerUris: string[]; isShowingPeer: boolean } | undefined;

	private readonly emptyPngDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR42gEFAPr/AP///wAI/AL+Sr4t6gAAAABJRU5ErkJggg==';

	private readonly _sizeStatusBarEntry: SizeStatusBarEntry;
	private readonly _zoomStatusBarEntry: ZoomStatusBarEntry;
	private readonly _normalizationStatusBarEntry: NormalizationStatusBarEntry;
	private readonly _gammaStatusBarEntry: GammaStatusBarEntry;
	private readonly _brightnessStatusBarEntry: BrightnessStatusBarEntry;
	private readonly _maskFilterStatusBarEntry: MaskFilterStatusBarEntry;
	private readonly _histogramStatusBarEntry: HistogramStatusBarEntry;
	private readonly _colorPickerModeStatusBarEntry: ColorPickerModeStatusBarEntry;
	private readonly _messageRouter: MessageRouter;

	private readonly _onDidExport = this._register(new vscode.EventEmitter<string>());
	public readonly onDidExport = this._onDidExport.event;

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
		maskFilterStatusBarEntry: MaskFilterStatusBarEntry,
		histogramStatusBarEntry: HistogramStatusBarEntry,
		colorPickerModeStatusBarEntry: ColorPickerModeStatusBarEntry,
		private readonly _manager: IImagePreviewManager
	) {
		super(extensionRoot, resource, webviewEditor, binarySizeStatusBarEntry);

		this._sizeStatusBarEntry = sizeStatusBarEntry;
		this._zoomStatusBarEntry = zoomStatusBarEntry;
		this._normalizationStatusBarEntry = normalizationStatusBarEntry;
		this._gammaStatusBarEntry = gammaStatusBarEntry;
		this._brightnessStatusBarEntry = brightnessStatusBarEntry;
		this._maskFilterStatusBarEntry = maskFilterStatusBarEntry;
		this._histogramStatusBarEntry = histogramStatusBarEntry;
		this._colorPickerModeStatusBarEntry = colorPickerModeStatusBarEntry;
		this._messageRouter = new MessageRouter(this._sizeStatusBarEntry, this);

		this._register(webviewEditor.webview.onDidReceiveMessage(message => {
			this._messageRouter.handle(message);
		}));

		this._register(this._zoomStatusBarEntry.onDidChangeScale(e => {
			if (this.previewState === PreviewState.Active) {
				this._webviewEditor.webview.postMessage({ type: 'setScale', scale: e.scale });
			}
		}));

		this._register(webviewEditor.onDidChangeViewState(() => {
			this.updateStatusBar();

			// Also update the global state
			this.updateState();
		}));

		// Single unified settings update handler
		const updateSettings = () => {
			// Get current settings from both managers
			const maskFilters = this._manager.settingsManager.getMaskFilterSettings(this.resource.toString());
			const enabledMasks = maskFilters.filter(mask => mask.enabled);
			const totalMasks = maskFilters.length;

			// Update status bar entries
			this._gammaStatusBarEntry.updateGamma(this._manager.appStateManager.imageSettings.gamma.in, this._manager.appStateManager.imageSettings.gamma.out);
			this._brightnessStatusBarEntry.updateBrightness(this._manager.appStateManager.imageSettings.brightness.offset);
			this._sizeStatusBarEntry.updateColorPickerMode(this._manager.settingsManager.getColorPickerShowModified());
			this._maskFilterStatusBarEntry.updateMaskFilter(
				totalMasks > 0,
				enabledMasks.length > 0 ? `${enabledMasks.length}/${totalMasks} masks` : undefined,
				enabledMasks.length > 0 ? enabledMasks[0].threshold : 0,
				enabledMasks.length > 0 ? enabledMasks[0].filterHigher : true
			);

			// Create full settings object
			const webviewSettings = {
				normalization: this._manager.appStateManager.imageSettings.normalization,
				gamma: this._manager.appStateManager.imageSettings.gamma,
				brightness: this._manager.appStateManager.imageSettings.brightness,
				rgbAs24BitGrayscale: this._manager.appStateManager.imageSettings.rgbAs24BitGrayscale,
				scale24BitFactor: this._manager.appStateManager.imageSettings.scale24BitFactor,
				normalizedFloatMode: this._manager.appStateManager.imageSettings.normalizedFloatMode,
				colorPickerShowModified: this._manager.settingsManager.getColorPickerShowModified(),
				maskFilters: maskFilters,
				nanColor: this._manager.settingsManager.getNanColor()
			};

			// Send to webview once
			this.sendSettingsUpdate(webviewSettings);
			this.updateStatusBar();
		};

		// Subscribe to both managers but use single update function
		// Per-image settings (maskFilters) always apply to this preview
		this._register(this._manager.settingsManager.onDidChangeSettings(updateSettings));
		// Per-format settings (normalization, gamma, brightness) only apply if format matches
		this._register(this._manager.appStateManager.onDidChangeSettings(() => {
			// Only update if settings are for our format (prevents cross-format contamination)
			if (this._currentFormat === this._manager.appStateManager.currentFormat) {
				updateSettings();
			}
		}));

		this._register(webviewEditor.onDidDispose(() => {
			if (this.previewState === PreviewState.Active) {
				this._sizeStatusBarEntry.hide(this);
				this._zoomStatusBarEntry.hide(this);
				this._normalizationStatusBarEntry.forceHide();
				this._gammaStatusBarEntry.hide();
				this._brightnessStatusBarEntry.hide();
				this._maskFilterStatusBarEntry.hide();
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
			this._maskFilterStatusBarEntry.hide();
			this._histogramStatusBarEntry.hide();
		}
		super.dispose();
	}

	public get viewColumn() {
		return this._webviewEditor.viewColumn;
	}

	public zoomIn() {
		if (this.previewState === PreviewState.Active) {
			this._webviewEditor.webview.postMessage({ type: 'zoomIn' });
		}
	}

	public zoomOut() {
		if (this.previewState === PreviewState.Active) {
			this._webviewEditor.webview.postMessage({ type: 'zoomOut' });
		}
	}

	public copyImage() {
		if (this.previewState === PreviewState.Active) {
			this._webviewEditor.webview.postMessage({ type: 'copyImage' });
		}
	}

	public resetZoom() {
		if (this.previewState === PreviewState.Active) {
			this._webviewEditor.webview.postMessage({ type: 'resetZoom' });
		}
	}

	public async exportAsPng(): Promise<string | undefined> {
		if (this.previewState === PreviewState.Active) {
			return new Promise<string | undefined>((resolve) => {
				const subscription = this.onDidExport(payload => {
					subscription.dispose();
					resolve(payload);
				});
				this._webviewEditor.webview.postMessage({ type: 'exportAsPng' });
			});
		}
		return undefined;
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

			this._webviewEditor.webview.postMessage({ type: 'start-comparison', peerUri: peerUri.toString() });
		}
	}

	public updatePreview() {
		// Instead of full render (which reloads HTML), just send updated settings
		// This allows fast parameter updates without HTML reload
		this.sendCurrentSettings();
	}

	private sendCurrentSettings() {
		// Get current settings from both managers
		const maskFilters = this._manager.settingsManager.getMaskFilterSettings(this.resource.toString());

		// Create full settings object
		const webviewSettings = {
			normalization: this._manager.appStateManager.imageSettings.normalization,
			gamma: this._manager.appStateManager.imageSettings.gamma,
			brightness: this._manager.appStateManager.imageSettings.brightness,
			rgbAs24BitGrayscale: this._manager.appStateManager.imageSettings.rgbAs24BitGrayscale,
			scale24BitFactor: this._manager.appStateManager.imageSettings.scale24BitFactor,
			normalizedFloatMode: this._manager.appStateManager.imageSettings.normalizedFloatMode,
			maskFilters: maskFilters,
			nanColor: this._manager.settingsManager.getNanColor(),
			colorPickerShowModified: this._manager.settingsManager.getColorPickerShowModified()
		};

		// Send to webview
		this.sendSettingsUpdate(webviewSettings);
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

	public fireExportEvent(payload: string): void {
		this._onDidExport.fire(payload);
	}

	public getManager(): IImagePreviewManager {
		return this._manager;
	}

	public isPreviewActive(): boolean {
		return this.previewState === PreviewState.Active;
	}

	public updateHistogramVisibility(isVisible: boolean): void {
		this._histogramStatusBarEntry.updateVisibility(isVisible);
	}

	public toggleHistogram(): void {
		if (this.previewState === PreviewState.Active) {
			this._webviewEditor.webview.postMessage({ type: 'toggleHistogram' });
		}
	}

	// Image collection management methods
	public async addToImageCollection(uri: vscode.Uri): Promise<void> {
		if (!this._imageCollection.some(img => img.toString() === uri.toString())) {
			this._imageCollection.push(uri);
			// Start preloading the image data (async, don't wait)
			this.preloadImageData(uri);
			// Update overlay immediately
			this.updateImageCollectionOverlay();
		}
	}

	public toggleToNextImage(): void {
		if (this._imageCollection.length <= 1) {
			return; // No other images to toggle to
		}

		// Save current zoom/position state
		this.saveCurrentZoomState();

		// Move to next image (cycle back to 0 if at end)
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
			this._webviewEditor.webview.postMessage({ type: 'getZoomState' });
			this._webviewEditor.webview.postMessage({ type: 'getComparisonState' });
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

		// Send switch request to webview
		this._webviewEditor.webview.postMessage({
			type: 'switchToImage',
			uri: cachedData?.webviewUri || this._webviewEditor.webview.asWebviewUri(newResource).toString(),
			resourceUri: newResource.toString()
		});

		// Update overlay
		this.updateImageCollectionOverlay();

		// Restore zoom and comparison state after a brief delay
		setTimeout(() => {
			if (this._currentZoomState) {
				this._webviewEditor.webview.postMessage({
					type: 'restoreZoomState',
					state: this._currentZoomState
				});
			}
			if (this._currentComparisonState && this._currentComparisonState.peerUris.length > 0) {
				this._webviewEditor.webview.postMessage({
					type: 'restoreComparisonState',
					state: this._currentComparisonState
				});
			}
		}, 150);
	}

	private updateImageCollectionOverlay(): void {
		if (this.previewState === PreviewState.Active) {
			const overlayData = {
				totalImages: this._imageCollection.length,
				currentIndex: this._currentImageIndex,
				show: this._imageCollection.length > 1
			};

			this._webviewEditor.webview.postMessage({
				type: 'updateImageCollectionOverlay',
				data: overlayData
			});
		}
	}

	private sendSettingsUpdate(settings: WebviewImageSettings): void {
		// Send to both Active and Visible previews (for multi-preview support)
		if (this.previewState === PreviewState.Active || this.previewState === PreviewState.Visible) {
			// Convert mask URIs to webview-safe URIs if they exist
			const webviewSafeMasks = settings.maskFilters.map(mask => ({
				...mask,
				maskUri: this._webviewEditor.webview.asWebviewUri(vscode.Uri.parse(mask.maskUri)).toString()
			}));

			// Include resourceUri so webview can detect file changes
			const uri = this._webviewEditor.webview.asWebviewUri(this.resource);
			const webviewSafeSettings = {
				...settings,
				maskFilters: webviewSafeMasks,
				resourceUri: this.resource.toString(),
				src: uri.toString()
			};

			this._webviewEditor.webview.postMessage({
				type: 'updateSettings',
				settings: webviewSafeSettings
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
			this._maskFilterStatusBarEntry.hide();
			this._histogramStatusBarEntry.hide();
			return;
		}

		if (this._webviewEditor.active && this._webviewEditor.visible) {
			this._sizeStatusBarEntry.show(this, this._imageSize || '');
			this._zoomStatusBarEntry.show(this, this._imageZoom || 'fit');

			// Show mask filter status bar entry if enabled
			const maskFilters = this._manager.settingsManager.getMaskFilterSettings(this.resource.toString());
			// Update mask filter status bar with summary
			const enabledMasks = maskFilters.filter(mask => mask.enabled);
			const totalMasks = maskFilters.length;
			this._maskFilterStatusBarEntry.updateMaskFilter(
				totalMasks > 0,
				enabledMasks.length > 0 ? `${enabledMasks.length}/${totalMasks} masks` : undefined,
				enabledMasks.length > 0 ? enabledMasks[0].threshold : 0,
				enabledMasks.length > 0 ? enabledMasks[0].filterHigher : true
			);

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
		const isTiff = lower.endsWith('.tif') || lower.endsWith('.tiff');
		const isPpm = lower.endsWith('.ppm') || lower.endsWith('.pgm') || lower.endsWith('.pbm');
		const isPng = lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg');
		const isPfm = lower.endsWith('.pfm');
		const isNpy = lower.endsWith('.npy') || lower.endsWith('.npz');
		const isExr = lower.endsWith('.exr');
		this._isTiff = isTiff || isPpm || isPng;

		// Merge settings from both managers:
		// - normalization, gamma, brightness, rgbAs24BitGrayscale, scale24BitFactor, normalizedFloatMode from appStateManager (per-format)
		// - maskFilters from settingsManager (per-image)
		const maskFilters = this._manager.settingsManager.getMaskFilterSettings(this.resource.toString());
		const settings = {
			normalization: this._manager.appStateManager.imageSettings.normalization,
			gamma: this._manager.appStateManager.imageSettings.gamma,
			brightness: this._manager.appStateManager.imageSettings.brightness,
			rgbAs24BitGrayscale: this._manager.appStateManager.imageSettings.rgbAs24BitGrayscale,
			scale24BitFactor: this._manager.appStateManager.imageSettings.scale24BitFactor,
			normalizedFloatMode: this._manager.appStateManager.imageSettings.normalizedFloatMode,
			maskFilters: maskFilters,
			nanColor: this._manager.settingsManager.getNanColor(),
			colorPickerShowModified: this._manager.settingsManager.getColorPickerShowModified()
		};

		const nonce = getNonce();
		const cspSource = this._webviewEditor.webview.cspSource;

		const uri = this._webviewEditor.webview.asWebviewUri(this.resource);
		const workspaceUri = vscode.workspace.getWorkspaceFolder(this.resource)?.uri ?? this.resource;
		const folderUri = this._webviewEditor.webview.asWebviewUri(workspaceUri);

		// Convert mask URIs to webview-safe URIs if they exist
		const webviewSafeMasks = settings.maskFilters.map(mask => ({
			...mask,
			maskUri: this._webviewEditor.webview.asWebviewUri(vscode.Uri.parse(mask.maskUri)).toString()
		}));

		// Extend settings with required properties for JavaScript
		const extendedSettings = {
			...settings,
			maskFilters: webviewSafeMasks,
			resourceUri: this.resource.toString(),
			src: uri.toString(),
			folder: folderUri.toString(),
			version: version
		};

		const cssUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'imagePreview.css'));
		const jsUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'imagePreview.js'));
		const geotiffUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'geotiff.min.js'));
		const pakoUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'pako.min.js'));
		const upngUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'upng.min.js'));
		const parseExrUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'parse-exr.js'));

		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">

	<!-- Disable pinch zooming -->
	<meta name="viewport"
		content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">

	<title>Image Preview</title>

	<link rel="stylesheet" href="${escapeAttribute(cssUri.toString())}" type="text/css" media="screen" nonce="${nonce}">

	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${cspSource}; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; style-src ${cspSource} 'nonce-${nonce}'; connect-src ${cspSource};">
	<meta id="image-preview-settings" data-settings="${escapeAttribute(JSON.stringify(extendedSettings))}" data-resource="${escapeAttribute(uri.toString())}" data-folder="${escapeAttribute(folderUri.toString())}" data-version="${escapeAttribute(version)}">
</head>
<body class="container image">
	<div class="loading-indicator" aria-label="Loading image"></div>
	<div class="image-load-error">
		<p>${vscode.l10n.t("An error occurred while loading the image.")}</p>
	</div>
	
	<script nonce="${nonce}">
		// Add error handler for module loading
		window.addEventListener('error', function(e) {
			console.error('TIFF Visualizer: Script error:', e.error, e.filename, e.lineno, e.colno);
		});

		window.addEventListener('unhandledrejection', function(e) {
			console.error('TIFF Visualizer: Unhandled promise rejection:', e.reason);
		});
	</script>
	
	${isTiff ?
				`<script src="${escapeAttribute(geotiffUri.toString())}" nonce="${nonce}"></script>` :
				''
			}
	${isPng ?
				`<script src="${escapeAttribute(pakoUri.toString())}" nonce="${nonce}"></script>
	<script src="${escapeAttribute(upngUri.toString())}" nonce="${nonce}"></script>` :
				''
			}
	${isExr ?
				`<script src="${escapeAttribute(parseExrUri.toString())}" nonce="${nonce}"></script>` :
				''
			}
	<script type="module" src="${escapeAttribute(jsUri.toString())}" nonce="${nonce}"></script>
</body>
</html>`;
	}

	protected override async render(): Promise<void> {
		try {
			const content = await this.getWebviewContents();
			this._webviewEditor.webview.html = content;
			this.updateStatusBar();
		} catch (error) {
			console.error('TIFF Visualizer render error:', error);
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
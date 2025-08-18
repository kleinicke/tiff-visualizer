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
import { MessageRouter } from './messageHandlers';
import type { IImagePreviewManager } from './types';
import type { ImageSettings } from './imageSettings';

export class ImagePreview extends MediaPreview {

	private _imageSize: string | undefined;
	private _imageZoom: Scale | undefined;
	private _isTiff: boolean = false;
	private _isFloat: boolean = false;

	private readonly emptyPngDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR42gEFAPr/AP///wAI/AL+Sr4t6gAAAABJRU5ErkJggg==';

	private readonly _sizeStatusBarEntry: SizeStatusBarEntry;
	private readonly _zoomStatusBarEntry: ZoomStatusBarEntry;
	private readonly _normalizationStatusBarEntry: NormalizationStatusBarEntry;
	private readonly _gammaStatusBarEntry: GammaStatusBarEntry;
	private readonly _brightnessStatusBarEntry: BrightnessStatusBarEntry;
	private readonly _maskFilterStatusBarEntry: MaskFilterStatusBarEntry;
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
		private readonly _manager: IImagePreviewManager
	) {
		super(extensionRoot, resource, webviewEditor, binarySizeStatusBarEntry);

		this._sizeStatusBarEntry = sizeStatusBarEntry;
		this._zoomStatusBarEntry = zoomStatusBarEntry;
		this._normalizationStatusBarEntry = normalizationStatusBarEntry;
		this._gammaStatusBarEntry = gammaStatusBarEntry;
		this._brightnessStatusBarEntry = brightnessStatusBarEntry;
		this._maskFilterStatusBarEntry = maskFilterStatusBarEntry;
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

		// Subscribe to settings changes for automatic updates
		this._register(this._manager.settingsManager.onDidChangeSettings((settings) => {
			// Get image-specific settings
			const imageSettings = this._manager.settingsManager.getSettingsForImage(this.resource.toString());
			
			// Update status bar entries with new values
			this._gammaStatusBarEntry.updateGamma(imageSettings.gamma.in, imageSettings.gamma.out);
			this._brightnessStatusBarEntry.updateBrightness(imageSettings.brightness.offset);
			// Update mask filter status bar with summary
			const enabledMasks = imageSettings.maskFilters.filter(mask => mask.enabled);
			const totalMasks = imageSettings.maskFilters.length;
			this._maskFilterStatusBarEntry.updateMaskFilter(
				totalMasks > 0,
				enabledMasks.length > 0 ? `${enabledMasks.length}/${totalMasks} masks` : undefined,
				enabledMasks.length > 0 ? enabledMasks[0].threshold : 0,
				enabledMasks.length > 0 ? enabledMasks[0].filterHigher : true
			);
			
			// Send targeted updates to webview instead of full reload
			this.sendSettingsUpdate(imageSettings);
			this.updateStatusBar();
		}));

		this._register(webviewEditor.onDidDispose(() => {
			if (this.previewState === PreviewState.Active) {
				this._sizeStatusBarEntry.hide(this);
				this._zoomStatusBarEntry.hide(this);
				this._normalizationStatusBarEntry.forceHide();
				this._gammaStatusBarEntry.hide();
				this._brightnessStatusBarEntry.hide();
				this._maskFilterStatusBarEntry.hide();
			}
		}));

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
			this._webviewEditor.webview.postMessage({ type: 'start-comparison', peerUri: peerUri.toString() });
		}
	}

	public updatePreview() {
		this.render();
	}

	public get isFloatTiff(): boolean {
		return this._isTiff && this._isFloat;
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

	public setIsFloat(isFloat: boolean): void {
		this._isFloat = isFloat;
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

	private sendSettingsUpdate(settings: ImageSettings): void {
		if (this.previewState === PreviewState.Active) {
			// Convert mask URIs to webview-safe URIs if they exist
			const webviewSafeMasks = settings.maskFilters.map(mask => ({
				...mask,
				maskUri: this._webviewEditor.webview.asWebviewUri(vscode.Uri.parse(mask.maskUri)).toString()
			}));

			const webviewSafeSettings = {
				...settings,
				maskFilters: webviewSafeMasks
			};

			this._webviewEditor.webview.postMessage({ 
				type: 'updateSettings', 
				settings: webviewSafeSettings 
			});
		}
	}

	public updateStatusBar() {
		const outputChannel = vscode.window.createOutputChannel('TIFF Visualizer Debug');
		
		if (this.previewState !== PreviewState.Active) {
			this._sizeStatusBarEntry.hide(this);
			this._zoomStatusBarEntry.hide(this);
			this._normalizationStatusBarEntry.forceHide();
			this._gammaStatusBarEntry.hide();
			this._brightnessStatusBarEntry.hide();
			this._maskFilterStatusBarEntry.hide();
			return;
		}

		outputChannel.appendLine(`TIFF Visualizer: updateStatusBar - isTiff: ${this._isTiff}, isFloat: ${this._isFloat}, active: ${this._webviewEditor.active}, visible: ${this._webviewEditor.visible}`);

		if (this._webviewEditor.active && this._webviewEditor.visible) {
			this._sizeStatusBarEntry.show(this, this._imageSize || '');
			this._zoomStatusBarEntry.show(this, this._imageZoom || 'fit');
			
					// Show mask filter status bar entry if enabled
		const settings = this._manager.settingsManager.getSettingsForImage(this.resource.toString());
			// Update mask filter status bar with summary
			const enabledMasks = settings.maskFilters.filter(mask => mask.enabled);
			const totalMasks = settings.maskFilters.length;
			this._maskFilterStatusBarEntry.updateMaskFilter(
				totalMasks > 0,
				enabledMasks.length > 0 ? `${enabledMasks.length}/${totalMasks} masks` : undefined,
				enabledMasks.length > 0 ? enabledMasks[0].threshold : 0,
				enabledMasks.length > 0 ? enabledMasks[0].filterHigher : true
			);
			
			// Show float controls not only for TIFF but for any float source
			if (this._isFloat) {
				outputChannel.appendLine('TIFF Visualizer: Showing FLOAT TIFF controls (normalization)');
				this._normalizationStatusBarEntry.updateNormalization(
					settings.normalization.min, 
					settings.normalization.max
				);
				this._normalizationStatusBarEntry.show(
					settings.normalization.autoNormalize, 
					settings.normalization.gammaMode
				);
				
				if (settings.normalization.gammaMode) {
					this._gammaStatusBarEntry.show();
					this._brightnessStatusBarEntry.show();
				} else {
					this._gammaStatusBarEntry.hide();
					this._brightnessStatusBarEntry.hide();
				}
			} else if (this._isTiff && !this._isFloat) {
				outputChannel.appendLine('TIFF Visualizer: Showing INTEGER TIFF controls (gamma/brightness only)');
				this._normalizationStatusBarEntry.forceHide();
				this._gammaStatusBarEntry.show();
				this._brightnessStatusBarEntry.show();
			} else {
				outputChannel.appendLine('TIFF Visualizer: Hiding all TIFF-specific controls (not a TIFF)');
				this._normalizationStatusBarEntry.forceHide();
				this._gammaStatusBarEntry.hide();
				this._brightnessStatusBarEntry.hide();
			}
		} else {
			this._sizeStatusBarEntry.hide(this);
			this._zoomStatusBarEntry.hide(this);
			this._normalizationStatusBarEntry.forceHide();
			this._gammaStatusBarEntry.hide();
			this._brightnessStatusBarEntry.hide();
			this._maskFilterStatusBarEntry.hide();
		}
	}

	protected override async getWebviewContents(): Promise<string> {
		const outputChannel = vscode.window.createOutputChannel('TIFF Visualizer Debug');
		
		const version = Date.now().toString();
		const settings = this._manager.settingsManager.getSettingsForImage(this.resource.toString());

		const nonce = getNonce();
		const cspSource = this._webviewEditor.webview.cspSource;

		const uri = this._webviewEditor.webview.asWebviewUri(this.resource);
		const workspaceUri = vscode.workspace.getWorkspaceFolder(this.resource)?.uri ?? this.resource;
		const folderUri = this._webviewEditor.webview.asWebviewUri(workspaceUri);

		const lower = this.resource.path.toLowerCase();
		const isTiff = lower.endsWith('.tif') || lower.endsWith('.tiff');
		this._isTiff = isTiff;

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

		outputChannel.appendLine(`TIFF Visualizer: Creating webview for: ${this.resource.toString()}`);
		outputChannel.appendLine(`TIFF Visualizer: Is TIFF file: ${isTiff}`);
		outputChannel.appendLine(`TIFF Visualizer: Webview URI: ${uri.toString()}`);
		outputChannel.appendLine(`TIFF Visualizer: Extension root: ${this.extensionRoot.toString()}`);
		outputChannel.appendLine(`TIFF Visualizer: Extended settings: ${JSON.stringify(extendedSettings)}`);

		const cssUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'imagePreview.css'));
		const jsUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'imagePreview.js'));
		const geotiffUri = this._webviewEditor.webview.asWebviewUri(this.extensionResource('media', 'geotiff.min.js'));

		outputChannel.appendLine(`TIFF Visualizer: CSS URI: ${cssUri.toString()}`);
		outputChannel.appendLine(`TIFF Visualizer: JS URI: ${jsUri.toString()}`);
		outputChannel.appendLine(`TIFF Visualizer: GeoTIFF URI: ${geotiffUri.toString()}`);

		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">

	<!-- Disable pinch zooming -->
	<meta name="viewport"
		content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">

	<title>Image Preview</title>

	<link rel="stylesheet" href="${escapeAttribute(cssUri.toString())}" type="text/css" media="screen" nonce="${nonce}">

	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${cspSource}; script-src 'nonce-${nonce}'; style-src ${cspSource} 'nonce-${nonce}'; connect-src ${cspSource};">
	<meta id="image-preview-settings" data-settings="${escapeAttribute(JSON.stringify(extendedSettings))}" data-resource="${escapeAttribute(uri.toString())}" data-folder="${escapeAttribute(folderUri.toString())}" data-version="${escapeAttribute(version)}">
</head>
<body class="container image">
	<div class="loading-indicator" aria-label="Loading image"></div>
	<div class="image-load-error">
		<p>${vscode.l10n.t("An error occurred while loading the image.")}</p>
		<a href="#" class="open-file-link">${vscode.l10n.t("Open file using VS Code's standard text editor?")}</a>
	</div>
	
	<script nonce="${nonce}">
		console.log('TIFF Visualizer: Webview HTML loaded');
		console.log('TIFF Visualizer: Settings:', ${JSON.stringify(extendedSettings)});
		console.log('TIFF Visualizer: Resource URI:', '${escapeAttribute(uri.toString())}');
		
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
	<script type="module" src="${escapeAttribute(jsUri.toString())}" nonce="${nonce}"></script>
	
	<script nonce="${nonce}">
		console.log('TIFF Visualizer: All scripts loaded');
	</script>
</body>
</html>`;
	}

	protected override async render(): Promise<void> {
		const outputChannel = vscode.window.createOutputChannel('TIFF Visualizer Debug');
		outputChannel.appendLine('TIFF Visualizer: Starting render process...');
		
		try {
			const content = await this.getWebviewContents();
			outputChannel.appendLine(`TIFF Visualizer: Generated webview content (${content.length} characters)`);
			outputChannel.appendLine('TIFF Visualizer: Setting webview HTML...');
			
			this._webviewEditor.webview.html = content;
			
			outputChannel.appendLine('TIFF Visualizer: Webview HTML set successfully');
			this.updateStatusBar();
			outputChannel.appendLine('TIFF Visualizer: Render complete');
		} catch (error) {
			outputChannel.appendLine(`TIFF Visualizer: Render error: ${error}`);
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
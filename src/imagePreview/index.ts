import * as vscode from 'vscode';
import { BinarySizeStatusBarEntry } from '../binarySizeStatusBarEntry';
import { MediaPreview, PreviewState } from '../mediaPreview';
import { escapeAttribute, getNonce } from '../util/dom';
import { SizeStatusBarEntry } from './sizeStatusBarEntry';
import { Scale, ZoomStatusBarEntry } from './zoomStatusBarEntry';
import { NormalizationStatusBarEntry } from './normalizationStatusBarEntry';
import { GammaStatusBarEntry } from './gammaStatusBarEntry';
import { BrightnessStatusBarEntry } from './brightnessStatusBarEntry';
import { fromArrayBuffer } from 'geotiff';

export class ImagePreviewManager implements vscode.CustomReadonlyEditorProvider {

	public static readonly viewType = 'tiffVisualizer.previewEditor';

	private readonly _previews = new Set<ImagePreview>();
	private _activePreview: ImagePreview | undefined;

	private _tempNormalisationMin: number | undefined;
	private _tempNormalisationMax: number | undefined;
	private _autoNormalize: boolean = false;
	private _gammaMode: boolean = false; // New mode for float images with gamma/brightness


	private _tempGammaIn: number | undefined;
	private _tempGammaOut: number | undefined;

	private _tempBrightness: number | undefined;

	private _comparisonBaseUri: vscode.Uri | undefined;

	constructor(
		private readonly extensionRoot: vscode.Uri,
		private readonly sizeStatusBarEntry: SizeStatusBarEntry,
		private readonly binarySizeStatusBarEntry: BinarySizeStatusBarEntry,
		private readonly zoomStatusBarEntry: ZoomStatusBarEntry,
		private readonly normalizationStatusBarEntry: NormalizationStatusBarEntry,
		private readonly gammaStatusBarEntry: GammaStatusBarEntry,
		private readonly brightnessStatusBarEntry: BrightnessStatusBarEntry,
	) { }

	public getNormalizationConfig() {
		return {
			min: this._tempNormalisationMin ?? 0.0,
			max: this._tempNormalisationMax ?? 1.0,
			autoNormalize: this._autoNormalize,
			gammaMode: this._gammaMode,
		};
	}

	public getGammaConfig() {
		return {
			in: this._tempGammaIn ?? 2.2,
			out: this._tempGammaOut ?? 2.2,
		};
	}

	public getBrightnessConfig() {
		return {
			offset: this._tempBrightness ?? 0,
		};
	}

	public setTempNormalization(min: number, max: number) {
		this._tempNormalisationMin = min;
		this._tempNormalisationMax = max;
	}

	public setAutoNormalize(enabled: boolean) {
		this._autoNormalize = enabled;
		if (enabled) {
			this._gammaMode = false; // Disable gamma mode when auto-normalize is enabled
		}
	}

	public setGammaMode(enabled: boolean) {
		this._gammaMode = enabled;
		if (enabled) {
			// When enabling gamma mode, preserve current normalization range
			if (this._autoNormalize) {
				// Coming from auto-normalize: disable auto mode but keep existing manual values
				this._autoNormalize = false;
			}
			// If coming from manual mode, keep the current manual values
		}
	}



	public setTempGamma(gammaIn: number, gammaOut: number) {
		this._tempGammaIn = gammaIn;
		this._tempGammaOut = gammaOut;
	}

	public setTempBrightness(offset: number) {
		this._tempBrightness = offset;
	}

	public setComparisonBase(uri: vscode.Uri | undefined) {
		this._comparisonBaseUri = uri;
		vscode.commands.executeCommand('setContext', 'tiffVisualizer.hasComparisonImage', !!uri);
	}

	public getComparisonBase(): vscode.Uri | undefined {
		return this._comparisonBaseUri;
	}

	public updateAllPreviews() {
		for (const preview of this._previews) {
			preview.updatePreview();
		}
	}

	public async openCustomDocument(uri: vscode.Uri) {
		return { uri, dispose: () => { } };
	}

	public async resolveCustomEditor(
		document: vscode.CustomDocument,
		webviewEditor: vscode.WebviewPanel,
	): Promise<void> {
		const preview = new ImagePreview(this.extensionRoot, document.uri, webviewEditor, this.sizeStatusBarEntry, this.binarySizeStatusBarEntry, this.zoomStatusBarEntry, this.normalizationStatusBarEntry, this.gammaStatusBarEntry, this.brightnessStatusBarEntry, this);
		this._previews.add(preview);
		this.setActivePreview(preview);

		webviewEditor.onDidDispose(() => { this._previews.delete(preview); });

		webviewEditor.onDidChangeViewState(() => {
			if (webviewEditor.active) {
				this.setActivePreview(preview);
			} else if (this._activePreview === preview && !webviewEditor.active) {
				this.setActivePreview(undefined);
			}
		});
	}

	public get activePreview() {
		return this._activePreview;
	}

	public getPreviewFor(resource: vscode.Uri, viewColumn?: vscode.ViewColumn): ImagePreview | undefined {
		for (const preview of this._previews) {
			if (preview.resource.toString() === resource.toString()) {
				if (!viewColumn || preview.viewColumn === viewColumn) {
					return preview;
				}
			}
		}
		return undefined;
	}

	private setActivePreview(value: ImagePreview | undefined): void {
		this._activePreview = value;
	}
}


class ImagePreview extends MediaPreview {

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
		private readonly _manager: ImagePreviewManager
	) {
		super(extensionRoot, resource, webviewEditor, binarySizeStatusBarEntry);

		this._sizeStatusBarEntry = sizeStatusBarEntry;
		this._zoomStatusBarEntry = zoomStatusBarEntry;
		this._normalizationStatusBarEntry = normalizationStatusBarEntry;
		this._gammaStatusBarEntry = gammaStatusBarEntry;
		this._brightnessStatusBarEntry = brightnessStatusBarEntry;

		this._register(webviewEditor.webview.onDidReceiveMessage(message => {
			switch (message.type) {
				case 'size':
					{
						this._imageSize = message.value;
						this.updateStatusBar();
						return;
					}
				case 'zoom':
					{
						this._imageZoom = message.value;
						this.updateStatusBar();
						return;
					}
				case 'pixelFocus':
					{
						if (this.previewState === PreviewState.Active) {
							this._sizeStatusBarEntry.showPixelPosition(this, message.value);
						}
						return;
					}
				case 'pixelBlur':
					{
						if (this.previewState === PreviewState.Active) {
							this._sizeStatusBarEntry.hidePixelPosition(this);
							this._sizeStatusBarEntry.show(this, this._imageSize || '');
						}
						return;
					}
				case 'isFloat':
					{
						this._isFloat = message.value;
						this.updateStatusBar();
						return;
					}
				case 'stats':
					{
						if (this._isTiff) {
							this._normalizationStatusBarEntry.updateImageStats(message.value.min, message.value.max);
							this.updateStatusBar();
						}
						return;
					}
				case 'formatInfo':
					{
						if (this._isTiff) {
							this._sizeStatusBarEntry.updateFormatInfo(message.value);
						}
						return;
					}
				case 'ready':
					{
						if (this.previewState === PreviewState.Disposed) {
							return;
						}
						this._webviewEditor.webview.postMessage({
							type: 'update',
							body: {
								isTiff: this._isTiff
							}
						});
						return;
					}
				case 'didExportAsPng': {
					this._onDidExport.fire(message.payload);
					break;
				}
				case 'get-initial-data': {
					this._webviewEditor.webview.postMessage({
						type: 'update',
						body: {
							isTiff: this._isTiff
						}
					});
					break;
				}
			}
		}));

		this._register(this._zoomStatusBarEntry.onDidChangeScale(e => {
			if (this.previewState === PreviewState.Active) {
				this._webviewEditor.webview.postMessage({ type: 'setScale', scale: e.scale });
			}
		}));

		this._register(webviewEditor.onDidChangeViewState(() => {
			this.updateStatusBar();
		}));

		this._register(webviewEditor.onDidDispose(() => {
			if (this.previewState === PreviewState.Active) {
				this._sizeStatusBarEntry.hide(this);
				this._zoomStatusBarEntry.hide(this);
				this._normalizationStatusBarEntry.hide();
				this._gammaStatusBarEntry.hide();
				this._brightnessStatusBarEntry.hide();
			}
			this.previewState = PreviewState.Disposed;
		}));

		this.updateBinarySize();
		this.render();
		this.updateStatusBar();
	}

	public override dispose(): void {
		super.dispose();
		this._sizeStatusBarEntry.hide(this);
		this._zoomStatusBarEntry.hide(this);
		this._normalizationStatusBarEntry.hide();
		this._gammaStatusBarEntry.hide();
		this._brightnessStatusBarEntry.hide();
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
			this._webviewEditor.reveal();
			this._webviewEditor.webview.postMessage({ type: 'copyImage' });
		}
	}

	public resetZoom() {
		if (this.previewState === PreviewState.Active) {
			this._webviewEditor.webview.postMessage({ type: 'resetZoom' });
		}
	}

	public async exportAsPng() {
		if (this.previewState === PreviewState.Active) {
			this._webviewEditor.reveal();
			this._webviewEditor.webview.postMessage({ type: 'exportAsPng' });
		}
	}

	public startComparison(peerUri: vscode.Uri) {
		if (this.previewState === PreviewState.Active) {
			this._webviewEditor.webview.postMessage({ type: 'start-comparison', peerUri: this._webviewEditor.webview.asWebviewUri(peerUri).toString() });
		}
	}

	public updatePreview() {
		this.render();
	}

	public get isFloatTiff(): boolean {
		return this._isTiff && this._isFloat;
	}

	public updateStatusBar() {
		if (this.previewState !== PreviewState.Active) {
			return;
		}

		if (this._webviewEditor.active) {
			this._sizeStatusBarEntry.show(this, this._imageSize || '');
			this._zoomStatusBarEntry.show(this, this._imageZoom || 'fit');
			if (this._isTiff && this._isFloat) {
				const { min, max, autoNormalize, gammaMode } = this._manager.getNormalizationConfig();
				this._normalizationStatusBarEntry.updateNormalization(min, max);
				this._normalizationStatusBarEntry.show(autoNormalize, gammaMode);
				
				if (gammaMode) {
					// Show gamma and brightness controls in gamma mode
					this._gammaStatusBarEntry.show();
					this._brightnessStatusBarEntry.show();
				} else {
					// Hide gamma and brightness controls in other modes
					this._gammaStatusBarEntry.hide();
					this._brightnessStatusBarEntry.hide();
				}
			} else if (this._isTiff && !this._isFloat) {
				this._normalizationStatusBarEntry.hide();
				this._gammaStatusBarEntry.show();
				this._brightnessStatusBarEntry.show();
			} else {
				this._normalizationStatusBarEntry.hide();
				this._gammaStatusBarEntry.hide();
				this._brightnessStatusBarEntry.hide();
			}
		} else {
			this._sizeStatusBarEntry.hide(this);
			this._zoomStatusBarEntry.hide(this);
			this._normalizationStatusBarEntry.hide();
			this._gammaStatusBarEntry.hide();
			this._brightnessStatusBarEntry.hide();
		}
	}

	protected override async getWebviewContents(): Promise<string> {
		const version = Date.now().toString();
		const settings = {
			src: await this.getResourcePath(this._webviewEditor, this.resource, version),
			resourceUri: this.resource.toString(),
			normalization: this._manager.getNormalizationConfig(),
			gamma: this._manager.getGammaConfig(),
			brightness: this._manager.getBrightnessConfig(),
		};

		const isTiff = this.resource.path.toLowerCase().endsWith('.tiff') || this.resource.path.toLowerCase().endsWith('.tif');
		this._isTiff = isTiff;

		const nonce = getNonce();

		const cspSource = this._webviewEditor.webview.cspSource;
		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">

	<!-- Disable pinch zooming -->
	<meta name="viewport"
		content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">

	<title>Image Preview</title>

	<link rel="stylesheet" href="${escapeAttribute(this.extensionResource('media', 'imagePreview.css'))}" type="text/css" media="screen" nonce="${nonce}">

	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${cspSource}; connect-src ${cspSource}; script-src 'nonce-${nonce}'; style-src ${cspSource} 'nonce-${nonce}';">
	<meta id="image-preview-settings" data-settings="${escapeAttribute(JSON.stringify(settings))}">
</head>
<body class="container image scale-to-fit loading" data-vscode-context='{ "preventDefaultContextMenuItems": true }'>
	<div class="loading-indicator"></div>
	<div class="image-load-error">
		<p>${vscode.l10n.t("An error occurred while loading the image.")}</p>
		<p class="error-details"></p>
		<a href="#" class="open-file-link">${vscode.l10n.t("Open file using VS Code's standard text/binary editor?")}</a>
	</div>
	<script src="${escapeAttribute(this.extensionResource('media', 'geotiff.min.js'))}" nonce="${nonce}"></script>
	<script src="${escapeAttribute(this.extensionResource('media', 'imagePreview.js'))}" nonce="${nonce}"></script>
</body>
</html>`;
	}

	protected override async render(): Promise<void> {
		await super.render();
		this._webviewEditor.webview.postMessage({ type: 'setActive', value: this._webviewEditor.active });
	}

	private async getResourcePath(webviewEditor: vscode.WebviewPanel, resource: vscode.Uri, version: string): Promise<string> {
		if (resource.scheme === 'git') {
			const stat = await vscode.workspace.fs.stat(resource);
			if (stat.size === 0) {
				return this.emptyPngDataUri;
			}
		}

		// Avoid adding cache busting if there is already a query string
		if (resource.query) {
			return webviewEditor.webview.asWebviewUri(resource).toString();
		}
		return webviewEditor.webview.asWebviewUri(resource).with({ query: `version=${version}` }).toString();
	}

	private extensionResource(...parts: string[]) {
		return this._webviewEditor.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionRoot, ...parts));
	}

}


export function registerImagePreviewSupport(context: vscode.ExtensionContext, binarySizeStatusBarEntry: BinarySizeStatusBarEntry): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];

	const sizeStatusBarEntry = new SizeStatusBarEntry();
	disposables.push(sizeStatusBarEntry);

	const zoomStatusBarEntry = new ZoomStatusBarEntry();
	disposables.push(zoomStatusBarEntry);

	const normalizationStatusBarEntry = new NormalizationStatusBarEntry();
	disposables.push(normalizationStatusBarEntry);

	const gammaStatusBarEntry = new GammaStatusBarEntry();
	disposables.push(gammaStatusBarEntry);

	const brightnessStatusBarEntry = new BrightnessStatusBarEntry();
	disposables.push(brightnessStatusBarEntry);

	const previewManager = new ImagePreviewManager(context.extensionUri, sizeStatusBarEntry, binarySizeStatusBarEntry, zoomStatusBarEntry, normalizationStatusBarEntry, gammaStatusBarEntry, brightnessStatusBarEntry);

	disposables.push(vscode.window.registerCustomEditorProvider(ImagePreviewManager.viewType, previewManager, {
		supportsMultipleEditorsPerDocument: true,
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.zoomIn', () => {
		previewManager.activePreview?.zoomIn();
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.zoomOut', () => {
		previewManager.activePreview?.zoomOut();
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.copyImage', () => {
		previewManager.activePreview?.copyImage();
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.resetZoom', () => {
		previewManager.activePreview?.resetZoom();
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.exportAsPng', async () => {
		const activePreview = previewManager.activePreview;
		if (activePreview) {
			const data = await new Promise<string>(resolve => {
				const sub = activePreview.onDidExport(e => {
					sub.dispose();
					resolve(e);
				});
				activePreview.exportAsPng();
			});

			const resource = activePreview.resource;
			const defaultUri = resource.with({
				path: resource.path.replace(/\.[^.]+$/, '.png')
			});

			const uri = await vscode.window.showSaveDialog({
				defaultUri,
				saveLabel: 'Export as PNG'
			});

			if (!uri) {
				return;
			}

			const Dt = data.replace(/^data:image\/png;base64,/, '');
			const buffer = Buffer.from(Dt, 'base64');
			await vscode.workspace.fs.writeFile(uri, buffer);
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.setNormalizationRange', async () => {
		const currentConfig = previewManager.getNormalizationConfig();
		const activePreview = previewManager.activePreview;
		
		// First show a QuickPick with options
		const options = [
			{
				label: (!currentConfig.autoNormalize && !currentConfig.gammaMode) ? '$(check) Manual Range' : '$(square) Manual Range',
				description: 'Set custom min/max values',
				detail: `Current: [${currentConfig.min.toFixed(2)}, ${currentConfig.max.toFixed(2)}]`,
				action: 'manual'
			},
			{
				label: currentConfig.autoNormalize ? '$(check) Auto-Normalize' : '$(square) Auto-Normalize',
				description: 'Automatically use image min/max values',
				detail: 'Normalize each float image from its actual min to max pixel values',
				action: 'auto'
			},
			{
				label: currentConfig.gammaMode ? '$(check) Gamma/Brightness Mode' : '$(square) Gamma/Brightness Mode',
				description: 'Normalize to fixed 0-1 range and enable gamma/brightness controls',
				detail: 'Always normalize to 0-1 range, then apply gamma and brightness adjustments',
				action: 'gamma'
			}
		];

		const selected = await vscode.window.showQuickPick(options, {
			placeHolder: 'Choose normalization method',
			title: 'Image Normalization Settings'
		});

		if (!selected) {
			return;
		}

		if (selected.action === 'auto') {
			// Enable auto-normalize (don't toggle off if already enabled)
			if (!currentConfig.autoNormalize) {
				previewManager.setAutoNormalize(true);
				const gammaText = currentConfig.gammaMode ? ' Gamma/brightness corrections will be applied on top.' : '';
				vscode.window.showInformationMessage('Auto-normalize enabled. Float images will be normalized to their actual min/max values.' + gammaText);
			}
		} else if (selected.action === 'gamma') {
			// Enable gamma mode (don't toggle off if already enabled)
			if (!currentConfig.gammaMode) {
				previewManager.setGammaMode(true);
				vscode.window.showInformationMessage('Gamma/Brightness mode enabled. Normalization between 0 and 1 will be used with gamma/brightness controls.');
			}
		} else {
			// Manual range setting
			const min = await vscode.window.showInputBox({
				prompt: 'Enter the minimum normalization value.',
				value: currentConfig.min.toString(),
				validateInput: text => {
					return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
				}
			});

			if (min === undefined) {
				return;
			}

			const max = await vscode.window.showInputBox({
				prompt: 'Enter the maximum normalization value.',
				value: currentConfig.max.toString(),
				validateInput: text => {
					return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
				}
			});

			if (max === undefined) {
				return;
			}

			if (parseFloat(min) >= parseFloat(max)) {
				vscode.window.showErrorMessage('Min value must be smaller than max value.');
				return;
			}
			
			const newMin = parseFloat(min);
			const newMax = parseFloat(max);

			previewManager.setTempNormalization(newMin, newMax);
			// Disable both auto-normalize and gamma mode when manually setting values
			previewManager.setAutoNormalize(false);
			previewManager.setGammaMode(false);
		}

		previewManager.updateAllPreviews();

		if (activePreview) {
			activePreview.updateStatusBar();
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.setGamma', async () => {
		const currentPreview = previewManager.activePreview;
		const normConfig = previewManager.getNormalizationConfig();
		
		// Check if this is a float TIFF and not in gamma mode
		if (currentPreview && currentPreview.isFloatTiff && !normConfig.gammaMode) {
			const choice = await vscode.window.showQuickPick([
				{
					label: '$(arrow-right) Switch to Gamma/Brightness Mode',
					description: 'Enable gamma correction for this float image',
					detail: 'Use current normalization range with gamma/brightness controls',
					action: 'switch'
				},
				{
					label: '$(edit) Set Gamma (Manual Mode)',
					description: 'Set gamma values for manual normalization',
					detail: 'Keep current normalization mode and set gamma values',
					action: 'manual'
				},
				{
					label: '$(x) Cancel',
					description: 'Go back without changes',
					action: 'cancel'
				}
			], {
				placeHolder: 'Float image detected - Choose how to apply gamma correction',
				title: 'Gamma Correction for Float Image'
			});

			if (!choice || choice.action === 'cancel') {
				return;
			}

			if (choice.action === 'switch') {
				previewManager.setGammaMode(true);
				previewManager.updateAllPreviews();
				if (currentPreview) {
					currentPreview.updateStatusBar();
				}
				vscode.window.showInformationMessage('Switched to Gamma/Brightness mode. Current normalization range will be used with gamma/brightness controls.');
				return;
			}
		}

		const currentConfig = previewManager.getGammaConfig();

		const gammaIn = await vscode.window.showInputBox({
			prompt: 'Enter the source gamma value. (Default: 2.2, Linear: 1.0)',
			value: currentConfig.in.toString(),
			validateInput: text => {
				return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
			}
		});

		if (gammaIn === undefined) {
			return;
		}

		const gammaOut = await vscode.window.showInputBox({
			prompt: 'Enter the display gamma value. (Default: 2.2, Linear: 1.0)',
			value: currentConfig.out.toString(),
			validateInput: text => {
				return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
			}
		});

		if (gammaOut === undefined) {
			return;
		}

		const newGammaIn = parseFloat(gammaIn);
		const newGammaOut = parseFloat(gammaOut);

		previewManager.setTempGamma(newGammaIn, newGammaOut);
		previewManager.updateAllPreviews();

		const activePreview = previewManager.activePreview;
		if (activePreview) {
			gammaStatusBarEntry.updateGamma(newGammaIn, newGammaOut);
			activePreview.updateStatusBar();
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.setBrightness', async () => {
		const currentPreview = previewManager.activePreview;
		const normConfig = previewManager.getNormalizationConfig();
		
		// Check if this is a float TIFF and not in gamma mode
		if (currentPreview && currentPreview.isFloatTiff && !normConfig.gammaMode) {
			const choice = await vscode.window.showQuickPick([
				{
					label: '$(arrow-right) Switch to Gamma/Brightness Mode',
					description: 'Enable brightness adjustment for this float image',
					detail: 'Use current normalization range with gamma/brightness controls',
					action: 'switch'
				},
				{
					label: '$(edit) Set Brightness (Manual Mode)',
					description: 'Set brightness values for manual normalization',
					detail: 'Keep current normalization mode and set brightness values',
					action: 'manual'
				},
				{
					label: '$(x) Cancel',
					description: 'Go back without changes',
					action: 'cancel'
				}
			], {
				placeHolder: 'Float image detected - Choose how to apply brightness adjustment',
				title: 'Brightness Adjustment for Float Image'
			});

			if (!choice || choice.action === 'cancel') {
				return;
			}

			if (choice.action === 'switch') {
				previewManager.setGammaMode(true);
				previewManager.updateAllPreviews();
				if (currentPreview) {
					currentPreview.updateStatusBar();
				}
				vscode.window.showInformationMessage('Switched to Gamma/Brightness mode. Current normalization range will be used with gamma/brightness controls.');
				return;
			}
		}

		const currentConfig = previewManager.getBrightnessConfig();

		const brightness = await vscode.window.showInputBox({
			prompt: 'Enter exposure compensation in stops (e.g., -1.0 for one stop darker, +1.0 for one stop brighter in linear space).',
			value: currentConfig.offset.toString(),
			validateInput: text => {
				const value = parseFloat(text);
				if (isNaN(value)) {
					return 'Please enter a valid number.';
				}
				return null;
			}
		});

		if (brightness === undefined) {
			return;
		}

		const newBrightness = parseFloat(brightness);

		previewManager.setTempBrightness(newBrightness);
		previewManager.updateAllPreviews();

		const activePreview = previewManager.activePreview;
		if (activePreview) {
			brightnessStatusBarEntry.updateBrightness(newBrightness);
			activePreview.updateStatusBar();
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.selectForCompare', () => {
		const activePreview = previewManager.activePreview;
		if (activePreview) {
			previewManager.setComparisonBase(activePreview.resource);
			vscode.window.showInformationMessage(`Selected ${activePreview.resource.fsPath.split('/').pop()} for comparison.`);
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.compareWithSelected', async () => {
		const activePreview = previewManager.activePreview;
		const baseUri = previewManager.getComparisonBase();

		if (!activePreview || !baseUri) {
			vscode.window.showErrorMessage('No image selected for comparison.');
			return;
		}

		try {
			const baseFile = await vscode.workspace.fs.readFile(baseUri);
			const baseTiff = await fromArrayBuffer(baseFile.buffer);
			const baseImage = await baseTiff.getImage();
			const baseWidth = baseImage.getWidth();
			const baseHeight = baseImage.getHeight();

			const peerFile = await vscode.workspace.fs.readFile(activePreview.resource);
			const peerTiff = await fromArrayBuffer(peerFile.buffer);
			const peerImage = await peerTiff.getImage();
			const peerWidth = peerImage.getWidth();
			const peerHeight = peerImage.getHeight();

			if (baseWidth !== peerWidth || baseHeight !== peerHeight) {
				vscode.window.showErrorMessage('Images must have the same dimensions to be compared.');
				previewManager.setComparisonBase(undefined);
				return;
			}

			const basePreview = previewManager.getPreviewFor(baseUri);
			if (basePreview) {
				basePreview.startComparison(activePreview.resource);

				// Close the peer editor and reset state
				activePreview.dispose();
				previewManager.setComparisonBase(undefined);
			}

		} catch (error) {
			vscode.window.showErrorMessage('Failed to compare images. Ensure both are valid TIFF files.');
			previewManager.setComparisonBase(undefined);
		}
	}));

	return vscode.Disposable.from(...disposables);
}

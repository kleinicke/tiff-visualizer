/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BinarySizeStatusBarEntry } from '../binarySizeStatusBarEntry';
import { MediaPreview, PreviewState, reopenAsText } from '../mediaPreview';
import { escapeAttribute, getNonce } from '../util/dom';
import { SizeStatusBarEntry } from './sizeStatusBarEntry';
import { PixelPositionStatusBarEntry } from './pixelPositionStatusBarEntry';
import { Scale, ZoomStatusBarEntry } from './zoomStatusBarEntry';
import { NormalizationStatusBarEntry } from './normalizationStatusBarEntry';

export class ImagePreviewManager implements vscode.CustomReadonlyEditorProvider {

	public static readonly viewType = 'tiffVisualizer.previewEditor';

	private readonly _previews = new Set<ImagePreview>();
	private _activePreview: ImagePreview | undefined;

	private _tempNormalisationMin: number | undefined;
	private _tempNormalisationMax: number | undefined;

	constructor(
		private readonly extensionRoot: vscode.Uri,
		private readonly sizeStatusBarEntry: SizeStatusBarEntry,
		private readonly binarySizeStatusBarEntry: BinarySizeStatusBarEntry,
		private readonly zoomStatusBarEntry: ZoomStatusBarEntry,
		private readonly pixelPositionStatusBarEntry: PixelPositionStatusBarEntry,
		private readonly normalizationStatusBarEntry: NormalizationStatusBarEntry,
	) { }

	public getNormalizationConfig() {
		return {
			min: this._tempNormalisationMin ?? 0.0,
			max: this._tempNormalisationMax ?? 1.0,
		};
	}

	public setTempNormalization(min: number, max: number) {
		this._tempNormalisationMin = min;
		this._tempNormalisationMax = max;
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
		const preview = new ImagePreview(this.extensionRoot, document.uri, webviewEditor, this.sizeStatusBarEntry, this.binarySizeStatusBarEntry, this.zoomStatusBarEntry, this.pixelPositionStatusBarEntry, this.normalizationStatusBarEntry, this);
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
	private readonly _pixelPositionStatusBarEntry: PixelPositionStatusBarEntry;
	private readonly _normalizationStatusBarEntry: NormalizationStatusBarEntry;

	constructor(
		private readonly extensionRoot: vscode.Uri,
		resource: vscode.Uri,
		webviewEditor: vscode.WebviewPanel,
		sizeStatusBarEntry: SizeStatusBarEntry,
		binarySizeStatusBarEntry: BinarySizeStatusBarEntry,
		zoomStatusBarEntry: ZoomStatusBarEntry,
		pixelPositionStatusBarEntry: PixelPositionStatusBarEntry,
		normalizationStatusBarEntry: NormalizationStatusBarEntry,
		private readonly _manager: ImagePreviewManager
	) {
		super(extensionRoot, resource, webviewEditor, binarySizeStatusBarEntry);

		this._sizeStatusBarEntry = sizeStatusBarEntry;
		this._zoomStatusBarEntry = zoomStatusBarEntry;
		this._pixelPositionStatusBarEntry = pixelPositionStatusBarEntry;
		this._normalizationStatusBarEntry = normalizationStatusBarEntry;

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
							this._sizeStatusBarEntry.hide(this);
							this._pixelPositionStatusBarEntry.show(this, message.value);
						}
						return;
					}
				case 'pixelBlur':
					{
						if (this.previewState === PreviewState.Active) {
							this._pixelPositionStatusBarEntry.hide(this);
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
				case 'reopen-as-text': {
					reopenAsText(resource, this._webviewEditor.viewColumn);
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
				this._pixelPositionStatusBarEntry.hide(this);
				this._normalizationStatusBarEntry.hide();
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
		this._pixelPositionStatusBarEntry.hide(this);
		this._normalizationStatusBarEntry.hide();
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

	public updatePreview() {
		this.render();
	}

	public updateStatusBar() {
		if (this.previewState !== PreviewState.Active) {
			return;
		}

		if (this._webviewEditor.active) {
			this._sizeStatusBarEntry.show(this, this._imageSize || '');
			this._zoomStatusBarEntry.show(this, this._imageZoom || 'fit');
			this._pixelPositionStatusBarEntry.hide(this);
			if (this._isTiff && this._isFloat) {
				const { min, max } = this._manager.getNormalizationConfig();
				this._normalizationStatusBarEntry.updateNormalization(min, max);
				this._normalizationStatusBarEntry.show();
			} else {
				this._normalizationStatusBarEntry.hide();
			}
		} else {
			this._sizeStatusBarEntry.hide(this);
			this._zoomStatusBarEntry.hide(this);
			this._pixelPositionStatusBarEntry.hide(this);
			this._normalizationStatusBarEntry.hide();
		}
	}

	protected override async getWebviewContents(): Promise<string> {
		const version = Date.now().toString();
		const settings = {
			src: await this.getResourcePath(this._webviewEditor, this.resource, version),
			resourceUri: this.resource.toString(),
			normalization: this._manager.getNormalizationConfig()
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

	public async reopenAsText() {
		await vscode.commands.executeCommand('reopenActiveEditorWith', 'default');
		this._webviewEditor.dispose();
	}
}


export function registerImagePreviewSupport(context: vscode.ExtensionContext, binarySizeStatusBarEntry: BinarySizeStatusBarEntry): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];

	const sizeStatusBarEntry = new SizeStatusBarEntry();
	disposables.push(sizeStatusBarEntry);

	const zoomStatusBarEntry = new ZoomStatusBarEntry();
	disposables.push(zoomStatusBarEntry);

	const pixelPositionStatusBarEntry = new PixelPositionStatusBarEntry();
	disposables.push(pixelPositionStatusBarEntry);

	const normalizationStatusBarEntry = new NormalizationStatusBarEntry();
	disposables.push(normalizationStatusBarEntry);

	const previewManager = new ImagePreviewManager(context.extensionUri, sizeStatusBarEntry, binarySizeStatusBarEntry, zoomStatusBarEntry, pixelPositionStatusBarEntry, normalizationStatusBarEntry);

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

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.reopenAsText', async () => {
		return previewManager.activePreview?.reopenAsText();
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.reopenAsPreview', async () => {

		await vscode.commands.executeCommand('reopenActiveEditorWith', ImagePreviewManager.viewType);
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.setNormalizationRange', async () => {
		const currentConfig = previewManager.getNormalizationConfig();

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
		previewManager.updateAllPreviews();

		const activePreview = previewManager.activePreview;
		if (activePreview) {
			activePreview.updateStatusBar();
		}
	}));

	return vscode.Disposable.from(...disposables);
}

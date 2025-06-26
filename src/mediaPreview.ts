import * as vscode from 'vscode';
import { Utils } from 'vscode-uri';
import { BinarySizeStatusBarEntry } from './binarySizeStatusBarEntry';
import { Disposable } from './util/dispose';


export const enum PreviewState {
	Disposed,
	Visible,
	Active,
}

export abstract class MediaPreview extends Disposable {

	protected previewState = PreviewState.Visible;
	private _binarySize: number | undefined;

	constructor(
		extensionRoot: vscode.Uri,
		protected readonly _resource: vscode.Uri,
		protected readonly _webviewEditor: vscode.WebviewPanel,
		private readonly _binarySizeStatusBarEntry: BinarySizeStatusBarEntry,
	) {
		super();

		_webviewEditor.webview.options = {
			enableScripts: true,
			enableForms: false,
			localResourceRoots: [
				Utils.dirname(_resource),
				extensionRoot,
			]
		};

		this._register(_webviewEditor.onDidChangeViewState(() => {
			this.updateState();
		}));

		this._register(_webviewEditor.onDidDispose(() => {
			this.previewState = PreviewState.Disposed;
			this.dispose();
		}));

		const watcher = this._register(vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(_resource, '*')));
		this._register(watcher.onDidChange(e => {
			if (e.toString() === this._resource.toString()) {
				this.updateBinarySize();
				this.render();
			}
		}));

		this._register(watcher.onDidDelete(e => {
			if (e.toString() === this._resource.toString()) {
				this._webviewEditor.dispose();
			}
		}));
	}

	public override dispose() {
		super.dispose();
		this._binarySizeStatusBarEntry.hide(this);
	}

	public get resource() {
		return this._resource;
	}

	protected updateBinarySize() {
		vscode.workspace.fs.stat(this._resource).then(({ size }) => {
			this._binarySize = size;
			this.updateState();
		});
	}

	protected async render() {
		if (this.previewState === PreviewState.Disposed) {
			return;
		}

		const content = await this.getWebviewContents();
		if (this.previewState as PreviewState === PreviewState.Disposed) {
			return;
		}

		this._webviewEditor.webview.html = content;
	}

	protected abstract getWebviewContents(): Promise<string>;

	protected updateState() {
		const outputChannel = vscode.window.createOutputChannel('TIFF Visualizer Debug');
		
		if (this.previewState === PreviewState.Disposed) {
			outputChannel.appendLine('TIFF Visualizer: updateState - preview disposed, skipping');
			return;
		}

		outputChannel.appendLine(`TIFF Visualizer: updateState - webviewEditor.active: ${this._webviewEditor.active}`);
		outputChannel.appendLine(`TIFF Visualizer: updateState - webviewEditor.visible: ${this._webviewEditor.visible}`);
		outputChannel.appendLine(`TIFF Visualizer: updateState - current previewState: ${this.previewState}`);

		if (this._webviewEditor.active) {
			outputChannel.appendLine('TIFF Visualizer: Setting preview state to Active');
			this.previewState = PreviewState.Active;
			this._binarySizeStatusBarEntry.show(this, this._binarySize);
		} else {
			outputChannel.appendLine('TIFF Visualizer: Setting preview state to Visible (not active)');
			this._binarySizeStatusBarEntry.hide(this);
			this.previewState = PreviewState.Visible;
		}
		
		outputChannel.appendLine(`TIFF Visualizer: updateState - final previewState: ${this.previewState}`);
	}
}

import * as vscode from 'vscode';
import { Utils } from 'vscode-uri';
import { Disposable } from '../util/dispose';

export class ComparisonPanel extends Disposable {
	public static readonly viewType = 'tiffVisualizer.comparisonPanel';
	private static currentPanel: ComparisonPanel | undefined;

	private readonly _panel: vscode.WebviewPanel;
	private _extensionRoot: vscode.Uri;
	private _images: vscode.Uri[] = [];
	private _isDisposed = false;

	public static create(extensionRoot: vscode.Uri): ComparisonPanel {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;

		// If we already have a panel, show it.
		if (ComparisonPanel.currentPanel) {
			ComparisonPanel.currentPanel._panel.reveal(column);
			return ComparisonPanel.currentPanel;
		}

		// Otherwise, create a new panel.
		const panel = vscode.window.createWebviewPanel(
			ComparisonPanel.viewType,
			'Image Comparison',
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					extensionRoot,
				],
			},
		);

		ComparisonPanel.currentPanel = new ComparisonPanel(panel, extensionRoot);
		return ComparisonPanel.currentPanel;
	}

	public static revive(panel: vscode.WebviewPanel, extensionRoot: vscode.Uri): ComparisonPanel {
		ComparisonPanel.currentPanel = new ComparisonPanel(panel, extensionRoot);
		return ComparisonPanel.currentPanel;
	}

	private constructor(panel: vscode.WebviewPanel, extensionRoot: vscode.Uri) {
		super();
		this._panel = panel;
		this._extensionRoot = extensionRoot;

		// Set the webview's initial html content
		this._update();

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programmatically
		this._register(this._panel.onDidDispose(() => this.dispose()));

		// Update the content based on view changes
		this._register(this._panel.onDidChangeViewState(e => {
			if (this._panel.visible) {
				this._update();
			}
		}));

		// Handle messages from the webview
		this._register(this._panel.webview.onDidReceiveMessage(message => {
			switch (message.type) {
				case 'openImageInMainEditor':
					this._openImageInMainEditor(message.uri);
					break;
				case 'removeImage':
					this._removeImage(message.uri);
					break;
			}
		}));
	}

	public addImage(uri: vscode.Uri): void {
		// Add image if not already present
		const uriString = uri.toString();
		if (!this._images.some(img => img.toString() === uriString)) {
			this._images.push(uri);
			this._update();
		}
		
		// Show the panel
		this._panel.reveal();
	}

	public removeImage(uri: vscode.Uri): void {
		this._removeImage(uri.toString());
	}

	private _removeImage(uriString: string): void {
		this._images = this._images.filter(img => img.toString() !== uriString);
		this._update();
	}

	private async _openImageInMainEditor(uriString: string): Promise<void> {
		try {
			const uri = vscode.Uri.parse(uriString);
			await vscode.commands.executeCommand('vscode.openWith', uri, 'tiffVisualizer.previewEditor');
		} catch (error) {
			console.error('Error opening image in main editor:', error);
		}
	}

	public override dispose(): void {
		ComparisonPanel.currentPanel = undefined;
		this._isDisposed = true;
		this._panel.dispose();
		super.dispose();
	}

	private _update(): void {
		if (this._isDisposed) {
			return;
		}

		const webview = this._panel.webview;
		this._panel.title = `Image Comparison (${this._images.length} images)`;
		this._panel.webview.html = this._getHtmlForWebview(webview);
	}

	private _getHtmlForWebview(webview: vscode.Webview): string {
		// Local path to main script run in the webview
		const scriptPathOnDisk = vscode.Uri.joinPath(this._extensionRoot, 'media', 'comparisonPanel.js');
		const scriptUri = webview.asWebviewUri(scriptPathOnDisk);

		// Local path to css styles
		const styleResetPath = vscode.Uri.joinPath(this._extensionRoot, 'media', 'reset.css');
		const stylesPathMainPath = vscode.Uri.joinPath(this._extensionRoot, 'media', 'comparisonPanel.css');
		const stylesResetUri = webview.asWebviewUri(styleResetPath);
		const stylesMainUri = webview.asWebviewUri(stylesPathMainPath);

		// Use a nonce to only allow specific scripts to be run
		const nonce = getNonce();

		// Generate image data for the webview
		const imageData = this._images.map(uri => {
			const webviewUri = webview.asWebviewUri(uri);
			return {
				uri: uri.toString(),
				webviewUri: webviewUri.toString(),
				filename: Utils.basename(uri)
			};
		});

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link href="${stylesResetUri}" rel="stylesheet">
				<link href="${stylesMainUri}" rel="stylesheet">
				<title>Image Comparison</title>
			</head>
			<body>
				<div class="header">
					<h2>Image Comparison Panel</h2>
					<div class="image-count">${this._images.length} images</div>
				</div>
				<div class="container">
					<div id="image-grid" class="image-grid">
						${imageData.length === 0 ? '<div class="empty-state">No images to compare. Use "Select for Compare" from the context menu in an image editor.</div>' : ''}
					</div>
				</div>
				<script nonce="${nonce}">
					window.imageData = ${JSON.stringify(imageData)};
				</script>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
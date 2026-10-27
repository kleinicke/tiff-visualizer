import * as vscode from 'vscode';
import { Utils } from 'vscode-uri';
import type { ChannelDefaults } from '../../shared/viewer-settings';
import { buildSceneManifest, discoverChannelFiles, folderOf, parseExperiment } from '../../media/modules/scene/xenium-manifest';
import { escapeAttribute, getNonce } from '../util/dom';

/**
 * Opens a Xenium output bundle from its `experiment.xenium` manifest.
 *
 * A separate custom editor from the image preview: the bundle is a set of
 * files, not one image, and its webview app (`media/xenium-viewer.ts`) shares
 * nothing with the single-image load pipeline. The host does only what the
 * webview cannot: read the manifest and list the folder, then hand over the
 * channel files as webview URIs.
 */
export class XeniumEditorProvider implements vscode.CustomReadonlyEditorProvider {
	public static readonly viewType = 'tiffVisualizer.xeniumViewer';

	constructor(private readonly extensionRoot: vscode.Uri) { }

	public async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
		return { uri, dispose: () => { } };
	}

	public async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
		const bundleFolder = Utils.dirname(document.uri).with({ query: '', fragment: '' });
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [bundleFolder, this.extensionRoot],
		};
		panel.webview.html = this.html(panel.webview);
		panel.webview.onDidReceiveMessage(async message => {
			switch (message?.type) {
				case 'ready':
					await this.sendScene(document.uri, bundleFolder, panel.webview);
					break;
				case 'openAsText':
					await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
					break;
				case 'error':
					console.error('[Xenium] viewer error:', message.message);
					break;
			}
		});
	}

	private async sendScene(manifestUri: vscode.Uri, bundleFolder: vscode.Uri, webview: vscode.Webview): Promise<void> {
		try {
			const experiment = parseExperiment(new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(manifestUri)));
			const imageFolder = experiment.morphologyFocusPath ? folderOf(experiment.morphologyFocusPath) : '';
			const entries = experiment.morphologyFocusPath
				? await vscode.workspace.fs.readDirectory(imageFolder ? Utils.joinPath(bundleFolder, ...imageFolder.split('/')) : bundleFolder)
				: [];
			const listing = entries.filter(([, type]) => (type & vscode.FileType.File) !== 0).map(([name]) => name);
			const files = discoverChannelFiles(experiment, listing);
			const manifest = buildSceneManifest(
				experiment,
				files,
				relativePath => webview.asWebviewUri(Utils.joinPath(bundleFolder, ...relativePath.split('/'))).toString(),
				Utils.basename(bundleFolder),
			);
			await webview.postMessage({ type: 'scene', manifest });
		} catch (error) {
			await webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
		}
	}

	private getChannelDefaults(): ChannelDefaults {
		const config = vscode.workspace.getConfiguration('tiffVisualizer.channels');
		return {
			colorsByName: config.get<Record<string, string>>('colorsByName', {}),
			colorsByNumber: config.get<Record<string, string>>('colorsByNumber', {}),
			groups: config.get<Record<string, unknown>>('groups', {}),
		};
	}

	private html(webview: vscode.Webview): string {
		const nonce = getNonce();
		const asset = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionRoot, 'media', ...parts)).toString();
		const vendorAssets = {
			workers: { 'xeniumTileWorker.bundle.js': asset('xeniumTileWorker.bundle.js') },
			codecWasm: asset('wasm', 'codec-wasm.wasm'),
			nonce,
		};
		const settings = { channelDefaults: this.getChannelDefaults() };
		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Xenium Viewer</title>
	<link rel="stylesheet" href="${escapeAttribute(asset('imagePreview.css'))}" nonce="${nonce}">
	<link rel="stylesheet" href="${escapeAttribute(asset('xeniumViewer.bundle.css'))}" nonce="${nonce}">
	<link rel="stylesheet" href="${escapeAttribute(asset('xenium-viewer.css'))}" nonce="${nonce}">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval'; worker-src blob:; style-src ${webview.cspSource} 'nonce-${nonce}'; connect-src ${webview.cspSource};">
	<meta id="xenium-settings" data-settings="${escapeAttribute(JSON.stringify(settings))}">
</head>
<body>
	<div id="scene-root"></div>
	<script nonce="${nonce}">window.__tiffVisualizerVendorAssets = ${JSON.stringify(vendorAssets)};</script>
	<script type="module" nonce="${nonce}" src="${escapeAttribute(asset('xeniumViewer.bundle.js'))}"></script>
</body>
</html>`;
	}
}

export function registerXeniumSupport(context: vscode.ExtensionContext): vscode.Disposable {
	return vscode.window.registerCustomEditorProvider(
		XeniumEditorProvider.viewType,
		new XeniumEditorProvider(context.extensionUri),
		{ supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } },
	);
}

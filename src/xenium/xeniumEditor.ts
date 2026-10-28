import * as vscode from 'vscode';
import { Utils } from 'vscode-uri';
import type { ChannelDefaults } from '../../shared/viewer-settings';
import {
	buildSceneManifest, discoverCellFiles, discoverChannelFiles, expandSampleName, folderOf, isAbsolutePath, parseExperiment, sourceNameFromPath,
	type CellSourceSpec,
} from '../../media/modules/scene/xenium-manifest';
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
interface ConfiguredSource { name: string; kind: 'table' | 'boundaries'; path: string; parent?: string; uri?: vscode.Uri }

export class XeniumEditorProvider implements vscode.CustomReadonlyEditorProvider {
	public static readonly viewType = 'tiffVisualizer.xeniumViewer';

	constructor(private readonly extensionRoot: vscode.Uri) { }

	public async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
		return { uri, dispose: () => { } };
	}

	public async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
		const bundleFolder = Utils.dirname(document.uri).with({ query: '', fragment: '' });
		// Files named in the settings are served to the webview directly, so their
		// folders must be among its resource roots; roots cannot change later.
		const configured = await this.configuredSources(bundleFolder);
		const roots = [
			bundleFolder, this.extensionRoot,
			...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri),
			...configured.filter(entry => entry.uri).map(entry => Utils.dirname(entry.uri!)),
		];
		panel.webview.options = { enableScripts: true, localResourceRoots: roots };
		panel.webview.html = this.html(panel.webview);
		panel.webview.onDidReceiveMessage(async message => {
			switch (message?.type) {
				case 'ready':
					await this.sendScene(document.uri, bundleFolder, panel.webview, configured, roots);
					break;
				case 'resolveCell':
					await this.answerCell(panel.webview, message.requestId, bundleFolder, roots, typeof message.text === 'string' ? message.text : '');
					break;
				case 'browseCell':
					await this.answerCell(panel.webview, message.requestId, bundleFolder, roots, null);
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

	private async sendScene(
		manifestUri: vscode.Uri, bundleFolder: vscode.Uri, webview: vscode.Webview,
		configured: ConfiguredSource[], roots: vscode.Uri[],
	): Promise<void> {
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
			const toSrc = (relativePath: string) => webview.asWebviewUri(Utils.joinPath(bundleFolder, ...relativePath.split('/'))).toString();
			const rootEntries = await vscode.workspace.fs.readDirectory(bundleFolder);
			manifest.cells = discoverCellFiles(rootEntries.filter(([, type]) => (type & vscode.FileType.File) !== 0).map(([name]) => name), toSrc);
			if (rootEntries.some(([name, type]) => name === 'transcripts.parquet' && (type & vscode.FileType.File) !== 0)) { manifest.transcripts = toSrc('transcripts.parquet'); }
			manifest.cellSources = await Promise.all(configured.map(async entry => ({ ...await this.specFor(entry.name, entry.kind, entry.path, entry.uri, webview, roots, false), parent: entry.parent })));
			await webview.postMessage({ type: 'scene', manifest });
		} catch (error) {
			await webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
		}
	}

	/** Where relative cell paths start: the workspace folder holding the bundle. */
	private baseFolder(bundleFolder: vscode.Uri): vscode.Uri {
		return vscode.workspace.getWorkspaceFolder(bundleFolder)?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri ?? Utils.dirname(bundleFolder);
	}

	/** Turn a typed or configured path (with `{sample_name}`) into a location. */
	private locate(text: string, bundleFolder: vscode.Uri): vscode.Uri {
		const expanded = expandSampleName(text.trim(), Utils.basename(bundleFolder));
		if (isAbsolutePath(expanded)) { return bundleFolder.scheme === 'file' ? vscode.Uri.file(expanded) : bundleFolder.with({ path: expanded }); }
		return Utils.joinPath(this.baseFolder(bundleFolder), ...expanded.split(/[\\/]/).filter(Boolean));
	}

	private async configuredSources(bundleFolder: vscode.Uri): Promise<ConfiguredSource[]> {
		const config = vscode.workspace.getConfiguration('tiffVisualizer.cells');
		const out: ConfiguredSource[] = [];
		for (const [setting, kind, parented] of [['cellsParquet', 'table', true], ['cellBoundariesParquet', 'boundaries', false], ['nucleusBoundariesParquet', 'boundaries', true]] as const) {
			const entries = config.get<Record<string, unknown>>(setting, {});
			for (const [name, value] of Object.entries(entries)) {
				// Tables and nucleus files name the one cell set they belong to; cell boundaries are just a path.
				const template = parented ? (value as { path?: unknown } | null)?.path : value;
				const parent = parented ? (value as { parent?: unknown } | null)?.parent : undefined;
				if (typeof template !== 'string' || !template.trim()) { continue; }
				if (parented && (typeof parent !== 'string' || !parent.trim())) { continue; }
				const uri = this.locate(template, bundleFolder);
				const exists = await vscode.workspace.fs.stat(uri).then(() => true, () => false);
				out.push({ name, kind, path: expandSampleName(template.trim(), Utils.basename(bundleFolder)), parent: typeof parent === 'string' ? parent.trim() : undefined, uri: exists ? uri : undefined });
			}
		}
		return out;
	}

	private isReachable(uri: vscode.Uri, roots: readonly vscode.Uri[]): boolean {
		return roots.some(root => root.scheme === uri.scheme && root.authority === uri.authority && (uri.path === root.path || uri.path.startsWith(root.path.replace(/\/$/, '') + '/')));
	}

	/** A resolved cell file: a webview URI when the webview can read it, else (when allowed) its bytes. */
	private async specFor(
		name: string, kind: CellSourceSpec['kind'], path: string, uri: vscode.Uri | undefined,
		webview: vscode.Webview, roots: readonly vscode.Uri[], allowBytes: boolean,
	): Promise<CellSourceSpec> {
		if (!uri) { return { name, kind, path, found: false }; }
		if (this.isReachable(uri, roots)) { return { name, kind, path, found: true, src: webview.asWebviewUri(uri).toString() }; }
		if (!allowBytes) { return { name, kind, path, found: false }; }
		const data = await vscode.workspace.fs.readFile(uri);
		return { name, kind, path, found: true, bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer };
	}

	/** Reply to the webview's request to add a cell file: `text` is a typed path, null opens the file dialog. */
	private async answerCell(webview: vscode.Webview, requestId: unknown, bundleFolder: vscode.Uri, roots: readonly vscode.Uri[], text: string | null): Promise<void> {
		try {
			let uri: vscode.Uri | undefined;
			if (text === null) {
				const picked = await vscode.window.showOpenDialog({
					canSelectMany: false, defaultUri: this.baseFolder(bundleFolder), openLabel: 'Add cells',
					filters: { Parquet: ['parquet'], 'All files': ['*'] },
				});
				if (!picked?.length) { await webview.postMessage({ type: 'cellSource', requestId, cancelled: true }); return; }
				uri = picked[0];
			} else {
				if (!text.trim()) { throw new Error('Enter a path first.'); }
				uri = this.locate(text, bundleFolder);
				if (!await vscode.workspace.fs.stat(uri).then(() => true, () => false)) { throw new Error(`Not found: ${uri.fsPath || uri.path}`); }
			}
			const shown = uri.scheme === 'file' ? uri.fsPath : uri.path;
			const spec = await this.specFor(sourceNameFromPath(shown), 'unknown', shown, uri, webview, roots, true);
			await webview.postMessage({ type: 'cellSource', requestId, spec });
		} catch (error) {
			await webview.postMessage({ type: 'cellSource', requestId, error: error instanceof Error ? error.message : String(error) });
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
			workers: {
				'xeniumTileWorker.bundle.js': asset('xeniumTileWorker.bundle.js'),
				'xeniumCellsWorker.bundle.js': asset('xeniumCellsWorker.bundle.js'),
			},
			codecWasm: asset('wasm', 'codec-wasm.wasm'),
			transcriptsWasm: asset('wasm', 'transcripts-wasm.wasm'),
			nonce,
		};
		const settings = {
			channelDefaults: this.getChannelDefaults(),
			transcriptGroups: vscode.workspace.getConfiguration('tiffVisualizer.transcripts').get<Record<string, unknown>>('groups', {}),
		};
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

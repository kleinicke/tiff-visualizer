import * as vscode from 'vscode';
import { Utils } from 'vscode-uri';
import { expandSampleName, isAbsolutePath, sourceNameFromPath, type CellSourceSpec } from '../../media/modules/scene/xenium-manifest';

/**
 * Locating cell files for the Cells panel, shared by the Xenium viewer and the
 * image viewer. `sampleFolder` is the folder that holds the bundle or image: its
 * name is `{sample_name}` in paths, and relative paths start at its workspace folder.
 */

/** `{sample_name}` for an image: its file name without the extension (and without `.ome`). */
export function imageSampleName(image: vscode.Uri): string {
	return Utils.basename(image).replace(/\.[^.]+$/, '').replace(/\.ome$/i, '');
}

/** A cell file named in settings, with where it was found (if it exists). */
export interface ConfiguredSource { name: string; kind: 'table' | 'boundaries'; path: string; parent?: string; uri?: vscode.Uri }

/**
 * The files named by `tiffVisualizer.cells.cellData`, `cellBoundaries` and
 * `nucleusBoundaries`. Each path may use `{sample_name}`. The earlier names
 * (`cellsParquet`, `cellBoundariesParquet`, `nucleusBoundariesParquet`) are
 * still read, so existing settings.json files keep working.
 */
export async function configuredSources(sampleFolder: vscode.Uri, sampleName: string): Promise<ConfiguredSource[]> {
	const config = vscode.workspace.getConfiguration('tiffVisualizer.cells');
	const out: ConfiguredSource[] = [];
	for (const [settings, kind, parented] of [[['cellData', 'cellsParquet'], 'table', true], [['cellBoundaries', 'cellBoundariesParquet'], 'boundaries', false], [['nucleusBoundaries', 'nucleusBoundariesParquet'], 'boundaries', true]] as const) {
		const entries: Record<string, unknown> = {};
		for (const setting of [...settings].reverse()) { Object.assign(entries, config.get<Record<string, unknown>>(setting, {})); }
		for (const [name, value] of Object.entries(entries)) {
			// Tables and nucleus files name the one cell set they belong to; cell boundaries are just a path.
			const template = parented ? (value as { path?: unknown } | null)?.path : value;
			const parent = parented ? (value as { parent?: unknown } | null)?.parent : undefined;
			if (typeof template !== 'string' || !template.trim()) { continue; }
			if (parented && (typeof parent !== 'string' || !parent.trim())) { continue; }
			const uri = locate(template, sampleFolder, sampleName);
			const exists = await vscode.workspace.fs.stat(uri).then(() => true, () => false);
			out.push({ name, kind, path: expandSampleName(template.trim(), sampleName), parent: typeof parent === 'string' ? parent.trim() : undefined, uri: exists ? uri : undefined });
		}
	}
	return out;
}

/** Where relative cell paths start: the workspace folder holding the sample. */
export function baseFolder(sampleFolder: vscode.Uri): vscode.Uri {
	return vscode.workspace.getWorkspaceFolder(sampleFolder)?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri ?? Utils.dirname(sampleFolder);
}

/** Turn a typed or configured path (with `{sample_name}`) into a location. */
export function locate(text: string, sampleFolder: vscode.Uri, sampleName: string = Utils.basename(sampleFolder)): vscode.Uri {
	const expanded = expandSampleName(text.trim(), sampleName);
	if (isAbsolutePath(expanded)) { return sampleFolder.scheme === 'file' ? vscode.Uri.file(expanded) : sampleFolder.with({ path: expanded }); }
	return Utils.joinPath(baseFolder(sampleFolder), ...expanded.split(/[\\/]/).filter(Boolean));
}

export function isReachable(uri: vscode.Uri, roots: readonly vscode.Uri[]): boolean {
	return roots.some(root => root.scheme === uri.scheme && root.authority === uri.authority && (uri.path === root.path || uri.path.startsWith(root.path.replace(/\/$/, '') + '/')));
}

/** A resolved cell file: a webview URI when the webview can read it, else (when allowed) its bytes. */
export async function specFor(
	name: string, kind: CellSourceSpec['kind'], path: string, uri: vscode.Uri | undefined,
	webview: vscode.Webview, roots: readonly vscode.Uri[], allowBytes: boolean,
): Promise<CellSourceSpec> {
	if (!uri) { return { name, kind, path, found: false }; }
	if (isReachable(uri, roots)) { return { name, kind, path, found: true, src: webview.asWebviewUri(uri).toString() }; }
	if (!allowBytes) { return { name, kind, path, found: false }; }
	const data = await vscode.workspace.fs.readFile(uri);
	return { name, kind, path, found: true, bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer };
}

/** Reply to the webview's request to add a cell file: `text` is a typed path, null opens the file dialog. */
export async function answerCellRequest(webview: vscode.Webview, requestId: unknown, sampleFolder: vscode.Uri, roots: readonly vscode.Uri[], text: string | null, sampleName: string = Utils.basename(sampleFolder)): Promise<void> {
	try {
		let uri: vscode.Uri | undefined;
		if (text === null) {
			const picked = await vscode.window.showOpenDialog({
				canSelectMany: false, defaultUri: baseFolder(sampleFolder), openLabel: 'Add cells',
				filters: { 'Cell files': ['parquet', 'tif', 'tiff', 'csv', 'tsv'], 'All files': ['*'] },
			});
			if (!picked?.length) { await webview.postMessage({ type: 'cellSource', requestId, cancelled: true }); return; }
			uri = picked[0];
		} else {
			if (!text.trim()) { throw new Error('Enter a path first.'); }
			uri = locate(text, sampleFolder, sampleName);
			if (!await vscode.workspace.fs.stat(uri).then(() => true, () => false)) { throw new Error(`Not found: ${uri.fsPath || uri.path}`); }
		}
		const shown = uri.scheme === 'file' ? uri.fsPath : uri.path;
		const spec = await specFor(sourceNameFromPath(shown), 'unknown', shown, uri, webview, roots, true);
		await webview.postMessage({ type: 'cellSource', requestId, spec });
	} catch (error) {
		await webview.postMessage({ type: 'cellSource', requestId, error: error instanceof Error ? error.message : String(error) });
	}
}

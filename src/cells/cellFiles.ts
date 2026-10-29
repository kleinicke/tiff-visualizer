import * as vscode from 'vscode';
import { Utils } from 'vscode-uri';
import { expandSampleName, isAbsolutePath, sourceNameFromPath, type CellSourceSpec } from '../../media/modules/scene/xenium-manifest';

/**
 * Locating cell files for the Cells panel, shared by the Xenium viewer and the
 * image viewer. `sampleFolder` is the folder that holds the bundle or image: its
 * name is `{sample_name}` in paths, and relative paths start at its workspace folder.
 */

/** Where relative cell paths start: the workspace folder holding the sample. */
export function baseFolder(sampleFolder: vscode.Uri): vscode.Uri {
	return vscode.workspace.getWorkspaceFolder(sampleFolder)?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri ?? Utils.dirname(sampleFolder);
}

/** Turn a typed or configured path (with `{sample_name}`) into a location. */
export function locate(text: string, sampleFolder: vscode.Uri): vscode.Uri {
	const expanded = expandSampleName(text.trim(), Utils.basename(sampleFolder));
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
export async function answerCellRequest(webview: vscode.Webview, requestId: unknown, sampleFolder: vscode.Uri, roots: readonly vscode.Uri[], text: string | null): Promise<void> {
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
			uri = locate(text, sampleFolder);
			if (!await vscode.workspace.fs.stat(uri).then(() => true, () => false)) { throw new Error(`Not found: ${uri.fsPath || uri.path}`); }
		}
		const shown = uri.scheme === 'file' ? uri.fsPath : uri.path;
		const spec = await specFor(sourceNameFromPath(shown), 'unknown', shown, uri, webview, roots, true);
		await webview.postMessage({ type: 'cellSource', requestId, spec });
	} catch (error) {
		await webview.postMessage({ type: 'cellSource', requestId, error: error instanceof Error ? error.message : String(error) });
	}
}

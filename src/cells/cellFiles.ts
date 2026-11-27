import * as vscode from 'vscode';
import { Utils } from 'vscode-uri';
import type { CellSourceSpec } from '../../media/modules/scene/xenium-manifest';
import { expandSampleName, extractSampleName, isAbsolutePath, sourceNameFromPath } from '../../shared/cell-paths';
import { escapeGlobLiteral, expandGlobPatternAsync, hasGlob } from '../util/globPaths';

/**
 * Locating cell files for the Cells panel, shared by the Xenium viewer and the
 * image viewer. `sampleFolder` is the folder that holds the bundle or image: its
 * name is `{sample_name}` in paths, and relative paths start at its workspace folder.
 */

const warned = new Set<string>();

/**
 * `{sample_name}` for a folder or file name: the name itself, or the part of it
 * picked out by `tiffVisualizer.cells.sampleNamePattern`. A pattern that does
 * not work is reported once and the whole name is used.
 */
export function sampleNameFor(rawName: string): string {
	const pattern = vscode.workspace.getConfiguration('tiffVisualizer.cells').get<string>('sampleNamePattern', '');
	const { name, warning, problem } = extractSampleName(pattern, rawName);
	if (warning) {
		// Once per pattern and problem, not per file: a pattern meant for other names would otherwise warn on every file.
		const key = `${pattern}\0${problem}`;
		if (warned.has(key)) { console.warn(`[Cells] ${warning}`); }
		else { warned.add(key); void vscode.window.showWarningMessage(warning); }
	}
	return name;
}

/**
 * `{sample_name}` resolved on first use, so the pattern is only applied (and can
 * only warn) when a path actually uses `{sample_name}`.
 */
export type SampleName = () => string;

export function lazySampleName(rawName: string): SampleName {
	let name: string | undefined;
	return () => (name ??= sampleNameFor(rawName));
}

/** `{sample_name}` for an image: its file name without the extension (and without `.ome`), through the pattern. */
export function imageSampleName(image: vscode.Uri): SampleName {
	return lazySampleName(Utils.basename(image).replace(/\.[^.]+$/, '').replace(/\.ome$/i, ''));
}

/** A cell file named in settings, with where it was found (if it exists). */
export interface ConfiguredSource { name: string; kind: 'table' | 'boundaries'; path: string; parent?: string; uri?: vscode.Uri }

/**
 * The files named by `tiffVisualizer.cells.cellData`, `cellBoundaries` and
 * `nucleusBoundaries`. Each path may use `{sample_name}`. The earlier names
 * (`cellsParquet`, `cellBoundariesParquet`, `nucleusBoundariesParquet`) are
 * still read, so existing settings.json files keep working.
 */
export async function configuredSources(sampleFolder: vscode.Uri, sampleName: SampleName): Promise<ConfiguredSource[]> {
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
			const uri = await locate(template, sampleFolder, sampleName);
			out.push({ name, kind, path: uri ? shownPath(uri) : expandSampleName(template.trim(), sampleName), parent: typeof parent === 'string' ? parent.trim() : undefined, uri });
		}
	}
	return out;
}

/** Where relative cell paths start: the workspace folder holding the sample. */
export function baseFolder(sampleFolder: vscode.Uri): vscode.Uri {
	return vscode.workspace.getWorkspaceFolder(sampleFolder)?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri ?? Utils.dirname(sampleFolder);
}

/** Build a path URI, keeping the sample host and workspace-relative base. */
function pathUri(text: string, sampleFolder: vscode.Uri, sampleName: SampleName, quoteBase = false): vscode.Uri {
	const expanded = expandSampleName(text.trim(), sampleName);
	if (isAbsolutePath(expanded)) { return sampleFolder.scheme === 'file' ? vscode.Uri.file(expanded) : sampleFolder.with({ path: expanded }); }
	const base = baseFolder(sampleFolder);
	return Utils.joinPath(quoteBase ? base.with({ path: escapeGlobLiteral(base.path) }) : base, ...expanded.split(/[\\/]/).filter(Boolean));
}

/** Resolve a cell template to the newest file; equal mtimes use ascending URI order. */
export async function locate(text: string, sampleFolder: vscode.Uri, sampleName: SampleName = lazySampleName(Utils.basename(sampleFolder))): Promise<vscode.Uri | undefined> {
	// Existing literal paths win, including names containing glob metacharacters.
	const exact = pathUri(text, sampleFolder, sampleName);
	const stat = await vscode.workspace.fs.stat(exact).then(value => value, () => undefined);
	if (stat?.type && (stat.type & vscode.FileType.File)) return exact;
	if (!hasGlob(text.replace(/\{sample_name\}/g, ''))) return undefined;
	const pattern = pathUri(text, sampleFolder, () => escapeGlobLiteral(sampleName()), true);
	const matches = await expandGlobPatternAsync(shownPath(pattern), pattern, () => false, { expandDirectory: false, maxResults: Infinity });
	let newest: { uri: vscode.Uri; mtime: number } | undefined;
	for (const uri of matches) {
		const stat = await vscode.workspace.fs.stat(uri).then(value => value, () => undefined);
		if (!stat || !(stat.type & vscode.FileType.File)) continue;
		if (!newest || stat.mtime > newest.mtime || (stat.mtime === newest.mtime && uri.toString() < newest.uri.toString())) {
			newest = { uri, mtime: stat.mtime };
		}
	}
	return newest?.uri;
}

function shownPath(uri: vscode.Uri): string {
	return uri.scheme === 'file' ? uri.fsPath : uri.path;
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
export async function answerCellRequest(webview: vscode.Webview, requestId: unknown, sampleFolder: vscode.Uri, roots: readonly vscode.Uri[], text: string | null, sampleName: SampleName = lazySampleName(Utils.basename(sampleFolder))): Promise<void> {
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
			uri = await locate(text, sampleFolder, sampleName);
			if (!uri) { throw new Error(`Not found: ${expandSampleName(text.trim(), sampleName)}`); }
		}
		const shown = shownPath(uri);
		const spec = await specFor(sourceNameFromPath(shown), 'unknown', shown, uri, webview, roots, true);
		await webview.postMessage({ type: 'cellSource', requestId, spec });
	} catch (error) {
		await webview.postMessage({ type: 'cellSource', requestId, error: error instanceof Error ? error.message : String(error) });
	}
}

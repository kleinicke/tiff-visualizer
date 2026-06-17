import * as vscode from 'vscode';
import * as path from 'path';
import { Utils } from 'vscode-uri';
import { BinarySizeStatusBarEntry } from '../binarySizeStatusBarEntry';
import { SizeStatusBarEntry } from './sizeStatusBarEntry';
import { ImagePreviewManager } from './imagePreviewManager';
import { ComparisonPanel } from '../comparisonPanel/comparisonPanel';
import { getOutputChannel } from '../extension';

const IMAGE_EXTENSIONS = ['tif', 'tiff', 'exr', 'pfm', 'npy', 'npz', 'ppm', 'pgm', 'pbm', 'png', 'jpg', 'jpeg', 'hdr', 'tga', 'webp', 'avif', 'bmp', 'ico', 'jxl'];

/**
 * Expand a file path that may contain * and ? wildcards into a list of URIs.
 * Only the basename portion may contain wildcards; the directory must be literal.
 */
/**
 * Convert a single glob segment (no path separators) to a RegExp.
 * Supports: * ? [abc] [a-z] [!abc] {a,b,c}
 */
function segmentToRegex(segment: string): RegExp {
	let result = '';
	let i = 0;

	while (i < segment.length) {
		const ch = segment[i];

		if (ch === '*') {
			result += '.*';
			i++;
		} else if (ch === '?') {
			result += '.';
			i++;
		} else if (ch === '[') {
			// Character class: [abc] [a-z] [!abc] [^abc]
			let cls = '[';
			i++;
			// [! or [^ both mean negation in glob
			if (i < segment.length && (segment[i] === '!' || segment[i] === '^')) {
				cls += '^';
				i++;
			}
			// A ] immediately after [ (or [^) is treated as a literal ]
			if (i < segment.length && segment[i] === ']') {
				cls += '\\]';
				i++;
			}
			// Consume until closing ]
			while (i < segment.length && segment[i] !== ']') {
				// Escape regex metacharacters inside class except - and ^
				const c = segment[i];
				if (c === '\\' && i + 1 < segment.length) {
					cls += '\\' + segment[i + 1];
					i += 2;
				} else {
					cls += c;
					i++;
				}
			}
			cls += ']';
			i++; // consume ']'
			result += cls;
		} else if (ch === '{') {
			// Brace expansion: {a,b,c} → (?:a|b|c)
			// Each alternative is treated as a mini-pattern (supports * ? inside)
			const alternatives: string[] = [];
			let current = '';
			let depth = 0;
			i++; // skip '{'
			while (i < segment.length) {
				const c = segment[i];
				if (c === '{') { depth++; current += c; i++; }
				else if (c === '}') {
					if (depth === 0) { alternatives.push(current); current = ''; i++; break; }
					depth--; current += c; i++;
				} else if (c === ',' && depth === 0) {
					alternatives.push(current); current = ''; i++;
				} else { current += c; i++; }
			}
			if (current) alternatives.push(current); // unterminated brace fallback
			// Recursively convert each alternative (supports * and ? inside braces)
			const altRegexes = alternatives.map(alt => segmentToRegex(alt).source.slice(1, -1));
			result += '(?:' + altRegexes.join('|') + ')';
		} else {
			// Literal character — escape regex metacharacters
			result += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
			i++;
		}
	}

	return new RegExp('^' + result + '$', 'i');
}


const MAX_GLOB_RESULTS = 2000;

/**
 * Path helpers that resolve typed path strings against an "anchor" URI — the
 * currently open image. All filesystem access goes through `vscode.workspace.fs`
 * rather than Node's `fs`, and child URIs inherit the anchor's scheme and
 * authority. This is what makes wildcard scanning work over Remote-SSH, dev
 * containers, and VS Code Web, instead of accidentally hitting the local disk.
 */
function pathModuleFor(anchor: vscode.Uri): path.PlatformPath {
	// Local files follow the host OS path rules; everything else (remote, virtual) is POSIX.
	return anchor.scheme === 'file' ? path : path.posix;
}

/** Builds a URI for an absolute path string, inheriting scheme/authority from the anchor. */
function pathToUri(p: string, anchor: vscode.Uri): vscode.Uri {
	if (anchor.scheme === 'file') {
		return vscode.Uri.file(p);
	}
	return anchor.with({ path: p.replace(/\\/g, '/'), query: '', fragment: '' });
}

/** stat() a path string via the VS Code filesystem API; undefined if it does not exist. */
async function statPath(p: string, anchor: vscode.Uri): Promise<vscode.FileStat | undefined> {
	try { return await vscode.workspace.fs.stat(pathToUri(p, anchor)); } catch { return undefined; }
}

/** readDirectory() a path string via the VS Code filesystem API; empty if unreadable. */
async function readDirPath(p: string, anchor: vscode.Uri): Promise<[string, vscode.FileType][]> {
	try { return await vscode.workspace.fs.readDirectory(pathToUri(p, anchor)); } catch { return []; }
}

/**
 * Expand the directory portion of a path (which may itself contain wildcards)
 * into the list of concrete directories it matches.
 * Accepts an isCancelled callback so in-flight scans abort as soon as the QuickPick closes.
 */
async function resolveWildcardDirsAsync(dirPath: string, anchor: vscode.Uri, isCancelled: () => boolean): Promise<string[]> {
	const pp = pathModuleFor(anchor);
	if (!dirPath.includes('*') && !dirPath.includes('?')) {
		return (await statPath(dirPath, anchor)) ? [dirPath] : [];
	}
	const segments = dirPath.split(/[/\\]/);
	const baseSegs: string[] = [];
	for (const seg of segments) {
		if (/[*?]/.test(seg)) break;
		baseSegs.push(seg);
	}
	const wildcardSegs = segments.slice(baseSegs.length);
	const baseDir = baseSegs.join(pp.sep) || pp.sep;

	async function walkDirs(dir: string, segs: string[]): Promise<string[]> {
		if (isCancelled()) return [];
		if (segs.length === 0) return [dir];
		const [head, ...rest] = segs;
		if (!head) return walkDirs(dir, rest);
		if (!/[*?]/.test(head)) {
			const next = pp.join(dir, head);
			return (await statPath(next, anchor)) ? walkDirs(next, rest) : [];
		}
		const regex = segmentToRegex(head);
		const entries = await readDirPath(dir, anchor);
		const out: string[] = [];
		for (const [name, fileType] of entries) {
			if (isCancelled()) return out;
			if (!regex.test(name)) continue;
			if (fileType & vscode.FileType.Directory) {
				out.push(...await walkDirs(pp.join(dir, name), rest));
			}
		}
		return out;
	}

	return walkDirs(baseDir, wildcardSegs);
}

/**
 * Async glob expansion via the VS Code filesystem API, with cancellation and a
 * hard result cap. Mutates the shared `results` array so the cap is enforced
 * across recursive calls.
 */
async function expandGlobSegmentsAsync(
	baseDir: string,
	segments: string[],
	anchor: vscode.Uri,
	results: vscode.Uri[],
	isCancelled: () => boolean,
): Promise<void> {
	if (isCancelled() || results.length >= MAX_GLOB_RESULTS || segments.length === 0) return;

	const pp = pathModuleFor(anchor);
	const [head, ...tail] = segments;
	const isLast = tail.length === 0;

	if (!head.includes('*') && !head.includes('?')) {
		const fullPath = pp.join(baseDir, head);
		if (isLast) {
			const st = await statPath(fullPath, anchor);
			if (st && (st.type & vscode.FileType.File)) {
				const uri = pathToUri(fullPath, anchor);
				if (isImageUri(uri)) results.push(uri);
			}
		} else {
			await expandGlobSegmentsAsync(fullPath, tail, anchor, results, isCancelled);
		}
		return;
	}

	const regex = segmentToRegex(head);
	const entries = await readDirPath(baseDir, anchor);
	for (const [entry, fileType] of entries) {
		if (isCancelled() || results.length >= MAX_GLOB_RESULTS) return;
		if (!regex.test(entry)) continue;
		const fullPath = pp.join(baseDir, entry);
		if (isLast) {
			if (fileType & vscode.FileType.File) {
				const uri = pathToUri(fullPath, anchor);
				if (isImageUri(uri)) results.push(uri);
			}
		} else {
			if (fileType & vscode.FileType.Directory) {
				await expandGlobSegmentsAsync(fullPath, tail, anchor, results, isCancelled);
			}
		}
	}
}

async function expandGlobPatternAsync(pattern: string, anchor: vscode.Uri, isCancelled: () => boolean): Promise<vscode.Uri[]> {
	const pp = pathModuleFor(anchor);
	if (!pattern.includes('*') && !pattern.includes('?')) {
		const plain = pattern.replace(/[/\\]+$/, '') || pp.sep;
		const st = await statPath(plain, anchor);
		if (!st) return [];
		if (st.type & vscode.FileType.Directory) {
			// A plain folder path expands to every supported image directly
			// inside it (non-recursive, mirroring the Explorer context menu).
			const results: vscode.Uri[] = [];
			for (const [name, fileType] of await readDirPath(plain, anchor)) {
				if (isCancelled() || results.length >= MAX_GLOB_RESULTS) break;
				if ((fileType & vscode.FileType.File) === 0) continue;
				const uri = pathToUri(pp.join(plain, name), anchor);
				if (isImageUri(uri)) results.push(uri);
			}
			return results.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
		}
		return (st.type & vscode.FileType.File) ? [pathToUri(plain, anchor)] : [];
	}

	const firstWild = pattern.search(/[*?]/);
	const beforeWild = pattern.substring(0, firstWild);
	const endsWithSep = beforeWild.endsWith('/') || beforeWild.endsWith('\\');
	const baseDir = pp.dirname(endsWithSep ? beforeWild + '_' : beforeWild);
	// dirname of a root-level path returns the root itself ('/' or 'C:\'),
	// which already ends with a separator — don't skip an extra character.
	const remainder = pattern.substring(baseDir.endsWith(pp.sep) ? baseDir.length : baseDir.length + 1);
	const segments = remainder.split(/[/\\]/);

	const results: vscode.Uri[] = [];
	await expandGlobSegmentsAsync(baseDir, segments, anchor, results, isCancelled);
	return results.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

/** Returns the final path segment of a URI (scheme-agnostic). */
function uriBasename(uri: vscode.Uri): string {
	return uri.path.split('/').pop() || uri.path;
}

/** True if the URI's extension is one of the supported image formats. */
function isImageUri(uri: vscode.Uri): boolean {
	const ext = uriBasename(uri).split('.').pop()?.toLowerCase() ?? '';
	return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Expands a selection of URIs into a flat, sorted list of image-file URIs.
 * Directories are scanned (non-recursively) for supported image files via the
 * VS Code filesystem API, so it works for local, remote (SSH) and virtual
 * workspaces alike. Plain image files pass through unchanged; anything else is
 * dropped. Duplicates are removed.
 */
async function collectImageFiles(uris: vscode.Uri[]): Promise<vscode.Uri[]> {
	const out = new Map<string, vscode.Uri>();
	for (const uri of uris) {
		let type: vscode.FileType;
		try {
			type = (await vscode.workspace.fs.stat(uri)).type;
		} catch {
			continue;
		}
		if (type & vscode.FileType.Directory) {
			let entries: [string, vscode.FileType][];
			try {
				entries = await vscode.workspace.fs.readDirectory(uri);
			} catch {
				continue;
			}
			for (const [name, entryType] of entries) {
				if ((entryType & vscode.FileType.File) === 0) { continue; }
				const child = Utils.joinPath(uri, name);
				if (isImageUri(child)) { out.set(child.toString(), child); }
			}
		} else if ((type & vscode.FileType.File) && isImageUri(uri)) {
			out.set(uri.toString(), uri);
		}
	}
	return [...out.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

/**
 * Adds a list of image URIs to the given preview's collection, showing progress
 * for multi-file operations and a summary message at the end.
 * Shared by the Explorer context-menu path and the wildcard pattern picker.
 */
async function addUrisToCollection(
	activePreview: {
		addToImageCollection(uri: vscode.Uri): Promise<boolean>;
		ensureLocalResourceRoots(uris: vscode.Uri[]): void;
	},
	uris: vscode.Uri[],
): Promise<{ added: number; skipped: number }> {
	const result = { added: 0, skipped: 0 };
	if (uris.length === 0) {
		return result;
	}

	// Register all folders in one shot so the webview reloads at most once
	// (ideally zero times for in-workspace images) instead of per file.
	activePreview.ensureLocalResourceRoots(uris);

	let firstAdded: vscode.Uri | undefined;
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Adding to collection…', cancellable: true },
		async (progress, token) => {
			for (const uri of uris) {
				if (token.isCancellationRequested) { break; }
				if (uris.length > 1) {
					progress.report({ message: `Adding ${result.added + result.skipped + 1} / ${uris.length}…`, increment: 100 / uris.length });
				}
				try {
					const wasAdded = await activePreview.addToImageCollection(uri);
					if (wasAdded) { if (!firstAdded) { firstAdded = uri; } result.added++; } else { result.skipped++; }
				} catch (error) {
					logCommand('browseAndAddToCollection', 'error', `Failed to add ${uri.fsPath}: ${error}`);
				}
			}
		}
	);

	const { added, skipped } = result;
	if (added === 0 && skipped > 0) {
		const msg = skipped === 1
			? `${uriBasename(uris[0])} is already in the collection.`
			: `All ${skipped} images are already in the collection.`;
		vscode.window.showWarningMessage(msg);
	} else if (added > 0) {
		vscode.commands.executeCommand('workbench.action.keepEditor');
		const base = added === 1
			? `Added ${uriBasename(firstAdded!)} to image collection.`
			: `Added ${added} images to collection.`;
		const msg = skipped > 0
			? `${base} (${skipped} already in collection, skipped) Press ← → to navigate.`
			: `${base} Press ← → to navigate.`;
		vscode.window.showInformationMessage(msg);
	}
	return result;
}

/**
 * Logs command execution to the output channel
 */
function logCommand(commandName: string, status: 'start' | 'success' | 'error', details?: string) {
	const output = getOutputChannel();
	const timestamp = new Date().toLocaleTimeString();
	const statusIcon = status === 'start' ? '▶️' : status === 'success' ? '✅' : '❌';

	if (status === 'start') {
		output.appendLine(`[${timestamp}] ${statusIcon} Command: ${commandName}`);
	} else if (status === 'success') {
		output.appendLine(`[${timestamp}] ${statusIcon} Command: ${commandName} - SUCCESS${details ? ` (${details})` : ''}`);
	} else {
		output.appendLine(`[${timestamp}] ${statusIcon} Command: ${commandName} - FAILED${details ? ` - ${details}` : ''}`);
	}
}

export function registerImagePreviewCommands(
	context: vscode.ExtensionContext,
	previewManager: ImagePreviewManager,
	sizeStatusBarEntry: SizeStatusBarEntry,
	binarySizeStatusBarEntry: BinarySizeStatusBarEntry
): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];

	// Copy image information to clipboard (triggered by keyboard shortcut)
	disposables.push(vscode.commands.registerCommand('tiffVisualizer.copyImageInfo', async () => {
		logCommand('copyImageInfo', 'start');
		try {
			const info = sizeStatusBarEntry.getFormattedInfo();
			// Remove markdown formatting for clean clipboard text
			const plainText = info.replace(/\*\*/g, '');
			await vscode.env.clipboard.writeText(plainText);

			// Show brief notification
			await vscode.window.showInformationMessage('Image information copied to clipboard');

			logCommand('copyImageInfo', 'success');
		} catch (error) {
			logCommand('copyImageInfo', 'error', String(error));
			await vscode.window.showErrorMessage('Failed to copy image information');
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.zoomIn', () => {
		logCommand('zoomIn', 'start');
		try {
			previewManager.activePreview?.zoomIn();
			logCommand('zoomIn', 'success');
		} catch (error) {
			logCommand('zoomIn', 'error', String(error));
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.zoomOut', () => {
		logCommand('zoomOut', 'start');
		try {
			previewManager.activePreview?.zoomOut();
			logCommand('zoomOut', 'success');
		} catch (error) {
			logCommand('zoomOut', 'error', String(error));
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.resetZoom', () => {
		logCommand('resetZoom', 'start');
		try {
			previewManager.activePreview?.resetZoom();
			logCommand('resetZoom', 'success');
		} catch (error) {
			logCommand('resetZoom', 'error', String(error));
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.copyImage', async () => {
		logCommand('copyImage', 'start');
		try {
			const activePreview = previewManager.activePreview;
			if (activePreview) {
				activePreview.copyImage();
				logCommand('copyImage', 'success');
			} else {
				logCommand('copyImage', 'error', 'No active preview');
			}
		} catch (error) {
			logCommand('copyImage', 'error', String(error));
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.pastePosition', async () => {
		logCommand('pastePosition', 'start');
		try {
			const activePreview = previewManager.activePreview;
			if (activePreview) {
				activePreview.pastePosition();
				logCommand('pastePosition', 'success');
			} else {
				logCommand('pastePosition', 'error', 'No active preview');
			}
		} catch (error) {
			logCommand('pastePosition', 'error', String(error));
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.exportAsPng', async () => {
		logCommand('exportAsPng', 'start');
		const activePreview = previewManager.activePreview;
		if (activePreview) {
			try {
				const result = await activePreview.exportAsPng();
				if (result) {
					const saveUri = await vscode.window.showSaveDialog({
						filters: { 'PNG Images': ['png'] },
						defaultUri: vscode.Uri.file(activePreview.resource.path.replace(/\.[^/.]+$/, '.png'))
					});

					if (saveUri) {
						const buffer = Buffer.from(result.split(',')[1], 'base64');
						await vscode.workspace.fs.writeFile(saveUri, buffer);
						vscode.window.showInformationMessage(`Image exported to ${saveUri.fsPath}`);
						logCommand('exportAsPng', 'success', saveUri.fsPath);
					} else {
						logCommand('exportAsPng', 'error', 'User cancelled save dialog');
					}
				} else {
					logCommand('exportAsPng', 'error', 'No result from exportAsPng');
				}
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to export image: ${error}`);
				logCommand('exportAsPng', 'error', String(error));
			}
		} else {
			logCommand('exportAsPng', 'error', 'No active preview');
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.setNormalizationRange', async () => {
		logCommand('setNormalizationRange', 'start');
		const currentConfig = previewManager.getNormalizationConfig();
		const activePreview = previewManager.activePreview;

		// Check if we have an RGB image (3 or more channels)
		const formatInfo = activePreview?.getManager().appStateManager.uiState.formatInfo;
		const isSingleChannelUint = formatInfo && formatInfo.samplesPerPixel === 1 && formatInfo.sampleFormat !== 3; // Not float
		const normalizedFloatModeEnabled = previewManager.appStateManager.imageSettings.normalizedFloatMode;

		// Gamma mode normalizes to the full type range: 0-1 for float images, but
		// 0-typeMax for integer images (e.g. 0-255 for uint8, 0-65535 for uint16).
		// Reflect the actual range in the labels so it isn't misleading.
		const isFloatImage = !formatInfo || formatInfo.sampleFormat === 3;
		const gammaMax = (isFloatImage || normalizedFloatModeEnabled)
			? 1
			: (Math.pow(2, formatInfo.bitsPerSample || 8) - 1);
		const gammaRangeLabel = formatInfo
			? `0-${gammaMax}`
			: '0-1 (float) or 0-255/0-65535 (integer)';

		// First show a QuickPick with options
		const options: Array<vscode.QuickPickItem & { action?: string }> = [
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
				description: `Normalize to fixed ${gammaRangeLabel} range and enable gamma/brightness controls`,
				detail: `Always normalize to ${gammaRangeLabel} range, then apply gamma and brightness adjustments`,
				action: 'gamma'
			}
		];

		// Add normalized float mode option for single-channel uint images
		if (isSingleChannelUint) {
			options.push(
				{
					label: '',
					kind: vscode.QuickPickItemKind.Separator
				},
				{
					label: normalizedFloatModeEnabled ? '$(check) Normalized Float Mode' : '$(square) Normalized Float Mode',
					description: 'Display uint values as normalized floats (0-1)',
					detail: 'Color picker shows float values, normalization borders use float range',
					action: 'normalizedFloat'
				}
			);
		}

		// Create a custom QuickPick to disable input
		const quickPick = vscode.window.createQuickPick<typeof options[0]>();
		quickPick.items = options;
		quickPick.placeholder = 'Choose normalization method';
		quickPick.title = 'Image Normalization Settings';
		quickPick.canSelectMany = false;
		quickPick.ignoreFocusOut = false;

		// Disable the input box by making it non-interactive
		quickPick.value = '';

		const selected = await new Promise<typeof options[0] | undefined>((resolve) => {
			quickPick.onDidChangeSelection(selection => {
				if (selection.length > 0) {
					resolve(selection[0]);
					quickPick.hide();
				}
			});

			quickPick.onDidHide(() => {
				resolve(undefined);
				quickPick.dispose();
			});

			// Prevent typing by immediately clearing any input
			quickPick.onDidChangeValue(() => {
				quickPick.value = '';
			});

			quickPick.show();
		});

		if (!selected) {
			logCommand('setNormalizationRange', 'error', 'User cancelled');
			return;
		}

		if (selected.action === 'auto') {
			previewManager.setAutoNormalize(true);
			if (activePreview) {
				activePreview.updateStatusBar();
			}
			logCommand('setNormalizationRange', 'success', 'Auto-normalize enabled');
		} else if (selected.action === 'gamma') {
			previewManager.setGammaMode(true);
			if (activePreview) {
				activePreview.updateStatusBar();
			}
			logCommand('setNormalizationRange', 'success', 'Gamma/brightness mode enabled');
		} else if (selected.action === 'normalizedFloat') {
			// Toggle normalized float mode
			const newState = !previewManager.appStateManager.imageSettings.normalizedFloatMode;
			previewManager.appStateManager.setNormalizedFloatMode(newState);
			if (activePreview) {
				activePreview.updateStatusBar();
			}
			logCommand('setNormalizationRange', 'success', `Normalized float mode ${newState ? 'enabled' : 'disabled'}`);
		} else {
			// Manual range setting
			const minValue = await vscode.window.showInputBox({
				prompt: '↓ Enter the minimum value for normalization',
				value: currentConfig.min.toString(),
				validateInput: text => {
					return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
				}
			});

			if (minValue === undefined) {
				logCommand('setNormalizationRange', 'error', 'User cancelled min value input');
				return;
			}

			const maxValue = await vscode.window.showInputBox({
				prompt: '↑ Enter the maximum value for normalization',
				value: currentConfig.max.toString(),
				validateInput: text => {
					const num = parseFloat(text);
					return isNaN(num) ? 'Please enter a valid number.' :
						num <= parseFloat(minValue) ? 'Maximum must be greater than minimum.' : null;
				}
			});

			if (maxValue === undefined) {
				logCommand('setNormalizationRange', 'error', 'User cancelled max value input');
				return;
			}

			// Only switch mode AFTER successful input
			previewManager.setAutoNormalize(false);
			previewManager.setGammaMode(false);

			const min = parseFloat(minValue);
			const max = parseFloat(maxValue);

			previewManager.setTempNormalization(min, max);
			if (activePreview) {
				activePreview.updateStatusBar();
			}
			logCommand('setNormalizationRange', 'success', `Manual range: [${min}, ${max}]`);
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.setGamma', async () => {
		logCommand('setGamma', 'start');
		const currentPreview = previewManager.activePreview;
		const normConfig = previewManager.getNormalizationConfig();

		// Check if not in gamma mode (offer to switch to gamma mode)
		if (currentPreview && !normConfig.gammaMode) {
			const gammaOptions = [
				{
					label: '$(arrow-right) Switch to Gamma/Brightness Mode',
					description: 'Enable gamma correction for this image',
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
			];

			// Create a custom QuickPick to disable input
			const gammaQuickPick = vscode.window.createQuickPick<typeof gammaOptions[0]>();
			gammaQuickPick.items = gammaOptions;
			gammaQuickPick.placeholder = 'Not in gamma mode - Choose how to apply gamma correction';
			gammaQuickPick.title = 'Gamma Correction';
			gammaQuickPick.canSelectMany = false;
			gammaQuickPick.ignoreFocusOut = false;
			gammaQuickPick.value = '';

			const choice = await new Promise<typeof gammaOptions[0] | undefined>((resolve) => {
				gammaQuickPick.onDidChangeSelection(selection => {
					if (selection.length > 0) {
						resolve(selection[0]);
						gammaQuickPick.hide();
					}
				});

				gammaQuickPick.onDidHide(() => {
					resolve(undefined);
					gammaQuickPick.dispose();
				});

				// Prevent typing by immediately clearing any input
				gammaQuickPick.onDidChangeValue(() => {
					gammaQuickPick.value = '';
				});

				gammaQuickPick.show();
			});

			if (!choice || choice.action === 'cancel') {
				logCommand('setGamma', 'error', 'User cancelled');
				return;
			}

			if (choice.action === 'switch') {
				previewManager.setGammaMode(true);
				if (currentPreview) {
					currentPreview.updateStatusBar();
				}
				logCommand('setGamma', 'success', 'Switched to gamma/brightness mode');
				return;
			}
		}

		const currentConfig = previewManager.getGammaConfig();

		const gammaIn = await vscode.window.showInputBox({
			prompt: '← Enter the source gamma value. (Default: 2.2, Linear: 1.0)',
			value: currentConfig.in.toString(),
			validateInput: text => {
				return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
			}
		});

		if (gammaIn === undefined) {
			logCommand('setGamma', 'error', 'User cancelled gamma in input');
			return;
		}

		const gammaOut = await vscode.window.showInputBox({
			prompt: '→ Enter the target gamma value. (Default: 2.2, Linear: 1.0)',
			value: currentConfig.out.toString(),
			validateInput: text => {
				return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
			}
		});

		if (gammaOut === undefined) {
			logCommand('setGamma', 'error', 'User cancelled gamma out input');
			return;
		}

		const gammaInValue = parseFloat(gammaIn);
		const gammaOutValue = parseFloat(gammaOut);

		previewManager.setTempGamma(gammaInValue, gammaOutValue);
		if (currentPreview) {
			currentPreview.updateStatusBar();
		}
		logCommand('setGamma', 'success', `Gamma set: in=${gammaInValue}, out=${gammaOutValue}`);
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.setBrightness', async () => {
		logCommand('setBrightness', 'start');
		const currentConfig = previewManager.getBrightnessConfig();
		const currentPreview = previewManager.activePreview;

		const brightness = await vscode.window.showInputBox({
			prompt: 'Enter brightness offset in exposure stops (applied in linear space (2^Exposure) after removing gamma, afterwards gamma is reapplied)',
			placeHolder: '0 = no change, +1 = 2× brighter, -1 = 2× darker in linear space',
			value: currentConfig.offset.toString(),
			validateInput: text => {
				return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
			}
		});

		if (brightness === undefined) {
			logCommand('setBrightness', 'error', 'User cancelled');
			return;
		}

		const brightnessValue = parseFloat(brightness);
		previewManager.setTempBrightness(brightnessValue);
		if (currentPreview) {
			currentPreview.updateStatusBar();
		}
		logCommand('setBrightness', 'success', `Brightness set: ${brightnessValue}`);
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.setComparisonBase', async () => {
		logCommand('setComparisonBase', 'start');
		const activePreview = previewManager.activePreview;
		if (!activePreview) {
			logCommand('setComparisonBase', 'error', 'No active preview');
			return;
		}

		const currentBase = previewManager.getComparisonBase();

		if (currentBase) {
			// Already has a comparison base, offer to clear it
			const comparisonOptions = [
				{
					label: '$(file-media) Choose New Comparison Image',
					description: 'Select a different image to compare with',
					action: 'choose'
				},
				{
					label: '$(x) Clear Comparison',
					description: 'Remove the current comparison image',
					action: 'clear'
				}
			];

			// Create a custom QuickPick to disable input
			const comparisonQuickPick = vscode.window.createQuickPick<typeof comparisonOptions[0]>();
			comparisonQuickPick.items = comparisonOptions;
			comparisonQuickPick.placeholder = `Current comparison: ${currentBase.fsPath}`;
			comparisonQuickPick.title = 'Image Comparison';
			comparisonQuickPick.canSelectMany = false;
			comparisonQuickPick.ignoreFocusOut = false;
			comparisonQuickPick.value = '';

			const choice = await new Promise<typeof comparisonOptions[0] | undefined>((resolve) => {
				comparisonQuickPick.onDidChangeSelection(selection => {
					if (selection.length > 0) {
						resolve(selection[0]);
						comparisonQuickPick.hide();
					}
				});

				comparisonQuickPick.onDidHide(() => {
					resolve(undefined);
					comparisonQuickPick.dispose();
				});

				// Prevent typing by immediately clearing any input
				comparisonQuickPick.onDidChangeValue(() => {
					comparisonQuickPick.value = '';
				});

				comparisonQuickPick.show();
			});

			if (!choice) {
				logCommand('setComparisonBase', 'error', 'User cancelled');
				return;
			}

			if (choice.action === 'clear') {
				previewManager.setComparisonBase(undefined);
				vscode.window.showInformationMessage('Comparison cleared.');
				logCommand('setComparisonBase', 'success', 'Comparison cleared');
				return;
			}
		}

		// Choose a new comparison image
		const uris = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: {
				'Images': ['tif', 'tiff', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp']
			},
			title: 'Select Comparison Image'
		});

		if (uris && uris.length > 0) {
			const comparisonUri = uris[0];
			previewManager.setComparisonBase(comparisonUri);
			activePreview.startComparison(comparisonUri);
			vscode.window.showInformationMessage(`Comparison set to: ${comparisonUri.fsPath}`);
			logCommand('setComparisonBase', 'success', comparisonUri.fsPath);
		} else {
			logCommand('setComparisonBase', 'error', 'No file selected');
		}
	}));


	// Open a new dedicated Layers window for the active image.
	disposables.push(vscode.commands.registerCommand('tiffVisualizer.toggleLayers', async () => {
		logCommand('toggleLayers', 'start');
		const activePreview = previewManager.activePreview;
		if (!activePreview) {
			vscode.window.showErrorMessage('No active TIFF Visualizer preview found. Please open an image first.');
			logCommand('toggleLayers', 'error', 'No active preview');
			return;
		}

		// The currently displayed image becomes the base layer and names the tab.
		const current = activePreview.getCurrentImage();

		if (activePreview.getViewMode() === 'collection') {
			// In a collection, offer to bring just this image or the whole set.
			const collection = activePreview.imageCollection;
			const choice = await vscode.window.showQuickPick(
				[
					{ label: 'Current image only', detail: current.path.split('/').pop(), action: 'current' as const },
					{ label: `All ${collection.length} images from the collection`, detail: 'Stacked as layers, current image as the base', action: 'all' as const },
				],
				{ placeHolder: 'Open the Layers view with…' }
			);
			if (!choice) {
				logCommand('toggleLayers', 'error', 'User cancelled');
				return;
			}
			const extras = choice.action === 'all'
				? collection.filter(u => u.toString() !== current.toString())
				: [];
			previewManager.openLayerView(current, extras);
			logCommand('toggleLayers', 'success', `collection: ${choice.action}`);
			return;
		}

		previewManager.openLayerView(current);
		logCommand('toggleLayers', 'success');
	}));

	// Pick one or more images and add them as layers to the active preview.
	disposables.push(vscode.commands.registerCommand('tiffVisualizer.addLayer', async (resource?: vscode.Uri, resources?: vscode.Uri[]) => {
		logCommand('addLayer', 'start');
		const activePreview = previewManager.activePreview;
		if (!activePreview) {
			vscode.window.showErrorMessage('No active TIFF Visualizer preview found. Please open an image first.');
			logCommand('addLayer', 'error', 'No active preview');
			return;
		}

		// From the Explorer context menu we get the selected resource(s) directly;
		// from the command palette, prompt with an open dialog.
		const selected = (resources && resources.length > 0)
			? resources
			: (resource ? [resource] : []);
		let uris: vscode.Uri[];
		if (selected.length > 0) {
			uris = selected;
		} else {
			const picked = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: true,
				openLabel: 'Add as layer(s)',
				filters: { 'Images': IMAGE_EXTENSIONS },
			});
			if (!picked || picked.length === 0) {
				logCommand('addLayer', 'error', 'User cancelled');
				return;
			}
			uris = picked;
		}
		activePreview.addLayerImages(uris);
		logCommand('addLayer', 'success', `${uris.length} image(s)`);
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.toggleNanColor', () => {
		logCommand('toggleNanColor', 'start');
		try {
			const currentColor = previewManager.settingsManager.getNanColor();
			previewManager.settingsManager.toggleNanColor();
			previewManager.updateAllPreviews();

			const newColor = previewManager.settingsManager.getNanColor();
			vscode.window.showInformationMessage(`NaN color changed to: ${newColor}`);
			logCommand('toggleNanColor', 'success', `Changed to: ${newColor}`);
		} catch (error) {
			logCommand('toggleNanColor', 'error', String(error));
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.toggleRgb24Mode', () => {
		logCommand('toggleRgb24Mode', 'start');
		const newState = !previewManager.appStateManager.imageSettings.rgbAs24BitGrayscale;
		previewManager.appStateManager.setRgbAs24BitGrayscale(newState);
		const activePreview = previewManager.activePreview;
		if (activePreview) {
			activePreview.updateStatusBar();
		}
		logCommand('toggleRgb24Mode', 'success', `RGB 24-bit mode ${newState ? 'enabled' : 'disabled'}`);
	}));

	/**
	 * Show a QuickPick-based path picker with filesystem autocomplete.
	 * Returns the final typed/selected pattern, or undefined if cancelled.
	 */
	async function pickPathWithAutocomplete(anchor: vscode.Uri, existingCollection: readonly vscode.Uri[] = []): Promise<string | undefined> {
		const pp = pathModuleFor(anchor);
		const sep = pp.sep;
		const initialDir = pp.dirname(anchor.scheme === 'file' ? anchor.fsPath : anchor.path);
		return new Promise<string | undefined>((resolve) => {
			const qp = vscode.window.createQuickPick();
			qp.placeholder = 'Type a file path, folder, or wildcard pattern (e.g. *.tiff)';
			qp.value = initialDir + sep;
			qp.matchOnDescription = false;
			qp.matchOnDetail = false;

			// Version counter — incremented on each keystroke to cancel stale searches
			let searchVersion = 0;

			const LOADING_ITEM: vscode.QuickPickItem = {
				label: '$(loading~spin) Searching...',
				description: 'Please wait',
				alwaysShow: true,
			};
			(LOADING_ITEM as any)._useRaw = true;

			async function updateSuggestions(typed: string): Promise<void> {
				const version = ++searchVersion;
				const isCancelled = () => searchVersion !== version;

				// Show loading state immediately
				const useItem: vscode.QuickPickItem = { label: '$(check) Use this pattern', description: 'Press Enter to confirm', alwaysShow: true };
				(useItem as any)._useRaw = true;
				qp.items = [useItem, LOADING_ITEM];

				// Debounce: wait before starting the actual search
				await new Promise(r => setTimeout(r, 200));
				if (searchVersion !== version) return;

				const contentItems: vscode.QuickPickItem[] = [];

				if (typed) {
					try {
						const trailingSlash = typed.endsWith('/') || typed.endsWith('\\');
						let dirToList: string;
						let prefix: string;
						if (trailingSlash) {
							dirToList = typed.replace(/[/\\]+$/, '') || sep;
							prefix = '';
						} else {
							dirToList = pp.dirname(typed);
							prefix = pp.basename(typed).toLowerCase();
						}

						const prefixHasWild = /[*?]/.test(prefix);
						const prefixRegex = prefixHasWild ? segmentToRegex(prefix) : null;
						const matchesPrefix = (name: string) =>
							prefixHasWild ? prefixRegex!.test(name) : name.startsWith(prefix);

						const dirsToList = await resolveWildcardDirsAsync(dirToList, anchor, isCancelled);

						if (searchVersion !== version) return;

						for (const dir of dirsToList) {
							if (searchVersion !== version) return;

							const entries = await readDirPath(dir, anchor);

							if (searchVersion !== version) return;

							for (const [name, fileType] of entries) {
								if (!matchesPrefix(name.toLowerCase())) continue;

								const fullPath = pp.join(dir, name);
								let isDir = (fileType & vscode.FileType.Directory) !== 0;
								if (!isDir && (fileType & vscode.FileType.SymbolicLink)) {
									const st = await statPath(fullPath, anchor);
									isDir = !!st && (st.type & vscode.FileType.Directory) !== 0;
								}

								if (isDir) {
									contentItems.push({
										label: '$(folder) ' + name,
										description: fullPath,
										detail: 'Folder — select to navigate into it, or confirm the typed path to add all images inside',
										alwaysShow: true,
									} as vscode.QuickPickItem & { _dirPath?: string });
									(contentItems[contentItems.length - 1] as any)._dirPath = fullPath;
								} else if (isImageUri(pathToUri(fullPath, anchor))) {
									contentItems.push({
										label: '$(file-media) ' + name,
										description: fullPath,
										alwaysShow: true,
									} as vscode.QuickPickItem & { _filePath?: string });
									(contentItems[contentItems.length - 1] as any)._filePath = fullPath;
								}
							}
						}
					} catch { /* ignore fs errors */ }
				}

				if (searchVersion !== version) return;

				// Detect if the typed path is a plain directory (no wildcards) —
				// folders are accepted and expand to all images directly inside.
				let isDirectoryPath = false;
				if (typed && !typed.includes('*') && !typed.includes('?')) {
					const st = await statPath(typed.replace(/[/\\]+$/, '') || sep, anchor);
					isDirectoryPath = !!st && (st.type & vscode.FileType.Directory) !== 0;
					if (searchVersion !== version) return;
				}

				const files = await expandGlobPatternAsync(typed, anchor, isCancelled);
				if (searchVersion !== version) return;
				const existingSet = new Set(existingCollection.map(u => u.toString()));
				const newCount = files.filter(u => !existingSet.has(u.toString())).length;
				const alreadyCount = files.length - newCount;
				const fromFolder = isDirectoryPath ? ' from this folder' : '';
				let useLabel: string;
				if (files.length === 0) {
					useLabel = isDirectoryPath
						? '$(warning) No supported images in this folder'
						: '$(check) Use this pattern';
				} else if (alreadyCount === 0) {
					useLabel = `$(check) Add ${newCount} image${newCount === 1 ? '' : 's'}${fromFolder}`;
				} else if (newCount === 0) {
					useLabel = `$(warning) All ${alreadyCount} image${alreadyCount === 1 ? '' : 's'} already in collection`;
				} else {
					useLabel = `$(check) Add ${newCount} new image${newCount === 1 ? '' : 's'}${fromFolder} (${alreadyCount} already in collection)`;
				}
				const canConfirm = newCount > 0;
				const finalUseItem: vscode.QuickPickItem = { label: useLabel, description: canConfirm ? 'Press Enter to confirm' : undefined, alwaysShow: true };
				(finalUseItem as any)._useRaw = canConfirm;
				qp.items = [finalUseItem, ...contentItems];
			}

			// Initial populate
			updateSuggestions(qp.value);

			qp.onDidChangeValue(value => {
				updateSuggestions(value);
			});

			qp.onDidAccept(() => {
				const selected = qp.selectedItems[0] as any;
				if (!selected) {
					resolve(qp.value || undefined);
					qp.dispose();
					return;
				}
				if (selected._useRaw === true) {
					resolve(qp.value || undefined);
					qp.dispose();
				} else if (selected._useRaw === false) {
					// Warning item (folder path) — ignore, let user keep typing
				} else if (selected._dirPath) {
					// Navigate into directory
					qp.value = selected._dirPath + sep;
					updateSuggestions(qp.value);
				} else if (selected._filePath) {
					resolve(selected._filePath);
					qp.dispose();
				} else {
					resolve(qp.value || undefined);
					qp.dispose();
				}
			});

			qp.onDidHide(() => {
				++searchVersion; // cancel any in-flight search
				resolve(undefined);
				qp.dispose();
			});

			qp.show();
		});
	}

	/**
	 * Opens an image in the TIFF Visualizer custom editor and returns its preview
	 * once registered. Used to bootstrap a collection when no preview is open yet.
	 */
	async function openPreviewForResource(uri: vscode.Uri) {
		await vscode.commands.executeCommand('vscode.openWith', uri, ImagePreviewManager.viewType);
		// resolveCustomEditor runs asynchronously — wait briefly for the preview to register.
		for (let i = 0; i < 60; i++) {
			const preview = previewManager.getPreviewFor(uri) ?? previewManager.activePreview;
			if (preview) { return preview; }
			await new Promise(r => setTimeout(r, 50));
		}
		return previewManager.getPreviewFor(uri) ?? previewManager.activePreview;
	}

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.browseAndAddToCollection', async (resource?: vscode.Uri, resources?: vscode.Uri[]) => {
		logCommand('browseAndAddToCollection', 'start');

		// When invoked from the Explorer context menu, VS Code passes the clicked
		// resource as the first argument and, when several entries are selected,
		// the full selection as the second argument. Honor the whole selection so
		// users can Ctrl/Shift-select multiple files (and folders) and add them all.
		const selectedResources = (resources && resources.length > 0)
			? resources
			: (resource ? [resource] : []);

		if (selectedResources.length > 0) {
			try {
				// Selection may include folders (right-clicked or multi-selected) —
				// expand them into the image files they contain.
				const files = await collectImageFiles(selectedResources);
				if (files.length === 0) {
					vscode.window.showWarningMessage('No supported image files found in the selection.');
					logCommand('browseAndAddToCollection', 'error', 'No image files in selection');
					return;
				}

				// No preview open yet: open the first image as the preview, then add
				// the rest to its collection. This removes the chicken-and-egg of
				// having to open an image manually before the menu does anything.
				let activePreview = previewManager.activePreview;
				let filesToAdd = files;
				if (!activePreview) {
					const [first, ...rest] = files;
					activePreview = await openPreviewForResource(first);
					if (!activePreview) {
						vscode.window.showErrorMessage('Failed to open the image in TIFF Visualizer.');
						logCommand('browseAndAddToCollection', 'error', 'Failed to open initial preview');
						return;
					}
					filesToAdd = rest;
				}

				const { added, skipped } = await addUrisToCollection(activePreview, filesToAdd);
				logCommand('browseAndAddToCollection', 'success', `explorer: added ${added}, skipped ${skipped}`);
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to add images to collection: ${error}`);
				logCommand('browseAndAddToCollection', 'error', String(error));
			}
			return;
		}

		// Command-palette invocation needs an already-open image to anchor the picker.
		const activePreview = previewManager.activePreview;
		if (!activePreview) {
			vscode.window.showErrorMessage('No active TIFF Visualizer preview found. Please open an image first.');
			logCommand('browseAndAddToCollection', 'error', 'No active preview');
			return;
		}

		const pattern = await pickPathWithAutocomplete(activePreview.resource, activePreview.imageCollection);
		if (!pattern) { return; }

		const filesToAdd = await expandGlobPatternAsync(pattern, activePreview.resource, () => false);
		if (filesToAdd.length === 0) {
			vscode.window.showWarningMessage(`No image files found matching: ${pattern}`);
			logCommand('browseAndAddToCollection', 'error', `No files matching: ${pattern}`);
			return;
		}

		const { added, skipped } = await addUrisToCollection(activePreview, filesToAdd);
		logCommand('browseAndAddToCollection', 'success', `Added ${added}, skipped ${skipped}`);
	}));

	// Comparison Panel Commands
	disposables.push(vscode.commands.registerCommand('tiffVisualizer.selectForCompare', async () => {
		logCommand('selectForCompare', 'start');
		const activePreview = previewManager.activePreview;
		if (!activePreview) {
			vscode.window.showErrorMessage('No active TIFF Visualizer preview found.');
			logCommand('selectForCompare', 'error', 'No active preview');
			return;
		}

		try {
			// Add current image to the comparison panel
			const panel = ComparisonPanel.create(context.extensionUri);
			panel.addImage(activePreview.resource);

			vscode.window.showInformationMessage(`Added ${activePreview.resource.fsPath.split('/').pop()} to comparison panel.`);

			// Set context to show that we have a comparison image
			vscode.commands.executeCommand('setContext', 'tiffVisualizer.hasComparisonImage', true);
			logCommand('selectForCompare', 'success', activePreview.resource.fsPath);
		} catch (error) {
			logCommand('selectForCompare', 'error', String(error));
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.compareWithSelected', async () => {
		logCommand('compareWithSelected', 'start');
		const activePreview = previewManager.activePreview;
		if (!activePreview) {
			vscode.window.showErrorMessage('No active TIFF Visualizer preview found.');
			logCommand('compareWithSelected', 'error', 'No active preview');
			return;
		}

		try {
			// Get or create comparison panel and add current image
			const panel = ComparisonPanel.create(context.extensionUri);
			panel.addImage(activePreview.resource);

			vscode.window.showInformationMessage(`Added ${activePreview.resource.fsPath.split('/').pop()} to comparison panel.`);
			logCommand('compareWithSelected', 'success', activePreview.resource.fsPath);
		} catch (error) {
			logCommand('compareWithSelected', 'error', String(error));
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.resetAllSettings', async () => {
		logCommand('resetAllSettings', 'start');
		const choice = await vscode.window.showWarningMessage(
			'Reset all TIFF Visualizer settings to defaults? This will clear all cached normalization, gamma, and brightness settings for all image formats.',
			{ modal: true },
			'Reset All',
			'Cancel'
		);

		if (choice === 'Reset All') {
			try {
				previewManager.appStateManager.clearAllCaches();
				previewManager.appStateManager.resetToDefaults();

				// Refresh all open previews to apply default settings
				previewManager.updateAllPreviews();

				vscode.window.showInformationMessage('All TIFF Visualizer settings have been reset to defaults.');
				logCommand('resetAllSettings', 'success');
			} catch (error) {
				logCommand('resetAllSettings', 'error', String(error));
			}
		} else {
			logCommand('resetAllSettings', 'error', 'User cancelled');
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.toggleHistogram', () => {
		logCommand('toggleHistogram', 'start');
		try {
			previewManager.activePreview?.toggleHistogram();
			logCommand('toggleHistogram', 'success');
		} catch (error) {
			logCommand('toggleHistogram', 'error', String(error));
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.convertColormapToFloat', async () => {
		logCommand('convertColormapToFloat', 'start');
		const activePreview = previewManager.activePreview;
		if (!activePreview) {
			vscode.window.showErrorMessage('No active image preview found.');
			logCommand('convertColormapToFloat', 'error', 'No active preview');
			return;
		}

		// Step 1: Select colormap
		const colormapOptions = [
			{ label: 'Viridis', description: 'Purple-blue-green-yellow perceptually uniform colormap', value: 'viridis' },
			{ label: 'Plasma', description: 'Purple-pink-orange perceptually uniform colormap', value: 'plasma' },
			{ label: 'Inferno', description: 'Black-purple-orange-yellow perceptually uniform colormap', value: 'inferno' },
			{ label: 'Magma', description: 'Black-purple-pink-yellow perceptually uniform colormap', value: 'magma' },
			{ label: 'Jet', description: 'Rainbow colormap (blue-cyan-green-yellow-red)', value: 'jet' },
			{ label: 'Hot', description: 'Black-red-orange-yellow-white colormap', value: 'hot' },
			{ label: 'Cool', description: 'Cyan-magenta colormap', value: 'cool' },
			{ label: 'Turbo', description: 'Improved rainbow colormap', value: 'turbo' },
			{ label: 'Gray', description: 'Grayscale colormap', value: 'gray' }
		];

		const colormapPick = vscode.window.createQuickPick();
		colormapPick.items = colormapOptions;
		colormapPick.placeholder = 'Select the colormap used in your image';
		colormapPick.title = 'Colormap Selection';
		colormapPick.canSelectMany = false;
		colormapPick.ignoreFocusOut = false;
		colormapPick.value = '';

		const selectedColormap = await new Promise<typeof colormapOptions[0] | undefined>((resolve) => {
			colormapPick.onDidChangeSelection(selection => {
				if (selection.length > 0) {
					resolve(selection[0] as typeof colormapOptions[0]);
					colormapPick.hide();
				}
			});

			colormapPick.onDidHide(() => {
				resolve(undefined);
				colormapPick.dispose();
			});

			colormapPick.onDidChangeValue(() => {
				colormapPick.value = '';
			});

			colormapPick.show();
		});

		if (!selectedColormap) {
			logCommand('convertColormapToFloat', 'error', 'User cancelled colormap selection');
			return;
		}

		// Step 2: Select mapping mode
		const mappingOptions = [
			{
				label: 'Linear - Normal',
				description: 'Linear mapping from dark to bright',
				detail: 'Colormap start → minimum value, Colormap end → maximum value',
				value: { inverted: false, logarithmic: false }
			},
			{
				label: 'Linear - Inverted',
				description: 'Linear mapping from bright to dark',
				detail: 'Colormap start → maximum value, Colormap end → minimum value',
				value: { inverted: true, logarithmic: false }
			},
			{
				label: 'Logarithmic - Normal',
				description: 'Logarithmic mapping from dark to bright',
				detail: 'Better for data with large dynamic range (e.g., 0.001 to 1000)',
				value: { inverted: false, logarithmic: true }
			},
			{
				label: 'Logarithmic - Inverted',
				description: 'Logarithmic mapping from bright to dark',
				detail: 'Inverted logarithmic scale for high dynamic range data',
				value: { inverted: true, logarithmic: true }
			}
		];

		const mappingPick = vscode.window.createQuickPick();
		mappingPick.items = mappingOptions;
		mappingPick.placeholder = 'Select mapping mode';
		mappingPick.title = 'Colormap Mapping Mode';
		mappingPick.canSelectMany = false;
		mappingPick.ignoreFocusOut = false;
		mappingPick.value = '';

		const selectedMapping = await new Promise<typeof mappingOptions[0] | undefined>((resolve) => {
			mappingPick.onDidChangeSelection(selection => {
				if (selection.length > 0) {
					resolve(selection[0] as typeof mappingOptions[0]);
					mappingPick.hide();
				}
			});

			mappingPick.onDidHide(() => {
				resolve(undefined);
				mappingPick.dispose();
			});

			mappingPick.onDidChangeValue(() => {
				mappingPick.value = '';
			});

			mappingPick.show();
		});

		if (!selectedMapping) {
			logCommand('convertColormapToFloat', 'error', 'User cancelled mapping selection');
			return;
		}

		// Step 3: Get minimum value
		const minPrompt = selectedMapping.value.inverted
			? 'Enter the minimum value (corresponds to the end of the colormap - brightest)'
			: 'Enter the minimum value (corresponds to the start of the colormap - darkest)';

		const minValue = await vscode.window.showInputBox({
			prompt: minPrompt,
			value: '0',
			placeHolder: '0',
			validateInput: text => {
				return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
			}
		});

		if (minValue === undefined) {
			logCommand('convertColormapToFloat', 'error', 'User cancelled min value input');
			return;
		}

		// Step 4: Get maximum value
		const maxPrompt = selectedMapping.value.inverted
			? 'Enter the maximum value (corresponds to the start of the colormap - darkest)'
			: 'Enter the maximum value (corresponds to the end of the colormap - brightest)';

		const maxValue = await vscode.window.showInputBox({
			prompt: maxPrompt,
			value: '1',
			placeHolder: '1',
			validateInput: text => {
				const num = parseFloat(text);
				return isNaN(num) ? 'Please enter a valid number.' :
					num <= parseFloat(minValue) ? 'Maximum must be greater than minimum.' : null;
			}
		});

		if (maxValue === undefined) {
			logCommand('convertColormapToFloat', 'error', 'User cancelled max value input');
			return;
		}

		const min = parseFloat(minValue);
		const max = parseFloat(maxValue);

		// Send conversion request to webview
		// Cast to ImagePreview to access getWebview method
		const preview = activePreview as any;
		if (preview.getWebview) {
			preview.getWebview().postMessage({
				type: 'convertColormapToFloat',
				colormap: selectedColormap.value,
				min: min,
				max: max,
				inverted: selectedMapping.value.inverted,
				logarithmic: selectedMapping.value.logarithmic
			});

			const mappingDesc = selectedMapping.value.logarithmic
				? (selectedMapping.value.inverted ? 'logarithmic inverted' : 'logarithmic')
				: (selectedMapping.value.inverted ? 'inverted' : 'normal');

			vscode.window.showInformationMessage(
				`Converting ${selectedColormap.label} colormap to float values [${min}, ${max}] (${mappingDesc})...`
			);
			logCommand('convertColormapToFloat', 'success', `${selectedColormap.value} [${min}, ${max}] ${mappingDesc}`);
		} else {
			logCommand('convertColormapToFloat', 'error', 'No webview available');
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.applyColormap', async () => {
		logCommand('applyColormap', 'start');
		const activePreview = previewManager.activePreview;
		if (!activePreview) {
			vscode.window.showErrorMessage('No active image preview found.');
			logCommand('applyColormap', 'error', 'No active preview');
			return;
		}

		// Pseudocolor a single-channel image: pick a colormap (or None to clear).
		const colormapOptions = [
			{ label: 'None', description: 'Show as grayscale (remove colormap)', value: 'none' },
			{ label: 'Viridis', description: 'Purple-blue-green-yellow perceptually uniform colormap', value: 'viridis' },
			{ label: 'Plasma', description: 'Purple-pink-orange perceptually uniform colormap', value: 'plasma' },
			{ label: 'Inferno', description: 'Black-purple-orange-yellow perceptually uniform colormap', value: 'inferno' },
			{ label: 'Magma', description: 'Black-purple-pink-yellow perceptually uniform colormap', value: 'magma' },
			{ label: 'Jet', description: 'Rainbow colormap (blue-cyan-green-yellow-red)', value: 'jet' },
			{ label: 'Hot', description: 'Black-red-orange-yellow-white colormap', value: 'hot' },
			{ label: 'Cool', description: 'Cyan-magenta colormap', value: 'cool' },
			{ label: 'Turbo', description: 'Improved rainbow colormap', value: 'turbo' },
			{ label: 'Gray', description: 'Grayscale colormap', value: 'gray' }
		];

		const selected = await vscode.window.showQuickPick(colormapOptions, {
			placeHolder: 'Select a colormap to apply (pseudocolor)',
			title: 'Apply Colormap'
		});

		if (!selected) {
			logCommand('applyColormap', 'error', 'User cancelled colormap selection');
			return;
		}

		const preview = activePreview as any;
		if (preview.getWebview) {
			preview.getWebview().postMessage({
				type: 'setDisplayColormap',
				colormap: selected.value
			});
			logCommand('applyColormap', 'success', selected.value);
		} else {
			logCommand('applyColormap', 'error', 'No webview available');
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.revertToOriginal', async () => {
		logCommand('revertToOriginal', 'start');
		const activePreview = previewManager.activePreview;
		if (!activePreview) {
			vscode.window.showErrorMessage('No active image preview found.');
			logCommand('revertToOriginal', 'error', 'No active preview');
			return;
		}

		// Reset the RGB 24-bit mode
		previewManager.appStateManager.setRgbAs24BitGrayscale(false);

		// Send revert message to webview to reload original image
		const preview = activePreview as any;
		if (preview.getWebview) {
			preview.getWebview().postMessage({
				type: 'revertToOriginal'
			});
		}

		previewManager.updateAllPreviews();
		if (activePreview) {
			activePreview.updateStatusBar();
		}

		logCommand('revertToOriginal', 'success', 'Reverted to original image');
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.toggleColorPickerMode', () => {
		logCommand('toggleColorPickerMode', 'start');
		try {
			previewManager.settingsManager.toggleColorPickerShowModified();
			const isEnabled = previewManager.settingsManager.getColorPickerShowModified();
			const mode = isEnabled ? 'modified values' : 'original values';
			vscode.window.showInformationMessage(`Color picker now shows ${mode}`);
			logCommand('toggleColorPickerMode', 'success', `${mode}`);
		} catch (error) {
			logCommand('toggleColorPickerMode', 'error', String(error));
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.openAsPointCloud', async (resource?: vscode.Uri) => {
		logCommand('openAsPointCloud', 'start');
		const uri = resource ?? previewManager.activePreview?.resource;
		if (!uri) {
			vscode.window.showErrorMessage('No image file to open as point cloud.');
			return;
		}

		const ext = path.extname(uri.fsPath).toLowerCase();
		const extToCommand: Record<string, string> = {
			'.tif':  'plyViewer.convertTifToPointCloud',
			'.tiff': 'plyViewer.convertTifToPointCloud',
			'.pfm':  'plyViewer.convertDepthToPointCloud',
			'.npy':  'plyViewer.convertNpyToPointCloud',
			'.npz':  'plyViewer.convertNpyToPointCloud',
			'.png':  'plyViewer.convertPngToPointCloud',
		};

		const plyCommand = extToCommand[ext];
		if (!plyCommand) {
			vscode.window.showErrorMessage(`"${ext}" files are not supported for point cloud conversion.`);
			return;
		}

		try {
			await vscode.commands.executeCommand(plyCommand, uri);
			logCommand('openAsPointCloud', 'success', `Executed ${plyCommand} for ${uri.fsPath}`);
		} catch {
			vscode.window.showErrorMessage(
				'Could not open as point cloud. Make sure the "3D Point Cloud and Mesh Visualizer" extension (kleinicke.ply-visualizer) is installed.'
			);
			logCommand('openAsPointCloud', 'error', 'ply-visualizer command failed');
		}
	}));

	return vscode.Disposable.from(...disposables);
}

import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Convert a single glob segment (no path separators) to a RegExp.
 * Supports: * ? [abc] [a-z] [!abc] {a,b,c}
 */
export function segmentToRegex(segment: string): RegExp {
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
			// Incomplete classes are literal while a user is still typing a path.
			const classStart = i + 1 + (/[!^]/.test(segment[i + 1] ?? '') ? 1 : 0);
			const closing = segment.indexOf(']', classStart + (segment[classStart] === ']' ? 1 : 0));
			if (closing < 0) { result += '\\['; i++; continue; }
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
			if (!segment.includes('}', i + 1)) { result += '\\{'; i++; continue; }
			// Brace expansion: {a,b,c} → (?:a|b|c)
			// Each alternative is treated as a mini-pattern (supports * ? inside)
			const alternatives: string[] = [];
			let current = '';
			let depth = 0;
			i++; // skip '{'
			while (i < segment.length) {
				const c = segment[i];
				if (c === '[') {
					// Braces and commas in a character class are literal, including quoted sample names.
					const start = i + 1 + (/[!^]/.test(segment[i + 1] ?? '') ? 1 : 0);
					const end = segment.indexOf(']', start + (segment[start] === ']' ? 1 : 0));
					if (end >= 0) { current += segment.slice(i, end + 1); i = end + 1; }
					else { current += c; i++; }
				} else if (c === '{') { depth++; current += c; i++; }
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


/** Glob syntax is shared by collections and cell-file templates. No recursive ** semantics. */
export function hasGlob(pattern: string): boolean {
	return /[*?\[{]/.test(pattern);
}

/** Quote user-provided names as glob character classes, not pattern syntax. */
export function escapeGlobLiteral(value: string): string {
	return value.replace(/[*?\[\]{},]/g, ch => '[' + ch + ']');
}

interface GlobOptions {
	acceptFile?: (uri: vscode.Uri) => boolean;
	expandDirectory?: boolean;
	maxResults?: number;
}

/**
 * Path helpers that resolve typed path strings against an "anchor" URI — the
 * currently open image. All filesystem access goes through `vscode.workspace.fs`
 * rather than Node's `fs`, and child URIs inherit the anchor's scheme and
 * authority. This is what makes wildcard scanning work over Remote-SSH, dev
 * containers, and VS Code Web, instead of accidentally hitting the local disk.
 */
export function pathModuleFor(anchor: vscode.Uri): path.PlatformPath {
	// Local files follow the host OS path rules; everything else (remote, virtual) is POSIX.
	return anchor.scheme === 'file' ? path : path.posix;
}

/** Builds a URI for an absolute path string, inheriting scheme/authority from the anchor. */
export function pathToUri(p: string, anchor: vscode.Uri): vscode.Uri {
	if (anchor.scheme === 'file') {
		return vscode.Uri.file(p);
	}
	return anchor.with({ path: p.replace(/\\/g, '/'), query: '', fragment: '' });
}

/** stat() a path string via the VS Code filesystem API; undefined if it does not exist. */
export async function statPath(p: string, anchor: vscode.Uri): Promise<vscode.FileStat | undefined> {
	try { return await vscode.workspace.fs.stat(pathToUri(p, anchor)); } catch { return undefined; }
}

/** readDirectory() a path string via the VS Code filesystem API; empty if unreadable. */
export async function readDirPath(p: string, anchor: vscode.Uri): Promise<[string, vscode.FileType][]> {
	try { return await vscode.workspace.fs.readDirectory(pathToUri(p, anchor)); } catch { return []; }
}

/**
 * Expand the directory portion of a path (which may itself contain wildcards)
 * into the list of concrete directories it matches.
 * Accepts an isCancelled callback so in-flight scans abort as soon as the QuickPick closes.
 */
export async function resolveWildcardDirsAsync(dirPath: string, anchor: vscode.Uri, isCancelled: () => boolean): Promise<string[]> {
	const pp = pathModuleFor(anchor);
	if (!hasGlob(dirPath)) {
		return (await statPath(dirPath, anchor)) ? [dirPath] : [];
	}
	const segments = dirPath.split(/[/\\]/);
	const baseSegs: string[] = [];
	for (const seg of segments) {
		if (hasGlob(seg)) break;
		baseSegs.push(seg);
	}
	const wildcardSegs = segments.slice(baseSegs.length);
	const baseDir = baseSegs.join(pp.sep) || pp.sep;

	async function walkDirs(dir: string, segs: string[]): Promise<string[]> {
		if (isCancelled()) return [];
		if (segs.length === 0) return [dir];
		const [head, ...rest] = segs;
		if (!head) return walkDirs(dir, rest);
		if (!hasGlob(head)) {
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
	acceptFile: (uri: vscode.Uri) => boolean,
	maxResults: number,
): Promise<void> {
	if (isCancelled() || results.length >= maxResults || segments.length === 0) return;

	const pp = pathModuleFor(anchor);
	const [head, ...tail] = segments;
	const isLast = tail.length === 0;

	if (!hasGlob(head)) {
		const fullPath = pp.join(baseDir, head);
		if (isLast) {
			const st = await statPath(fullPath, anchor);
			if (st && (st.type & vscode.FileType.File)) {
				const uri = pathToUri(fullPath, anchor);
				if (acceptFile(uri)) results.push(uri);
			}
		} else {
			await expandGlobSegmentsAsync(fullPath, tail, anchor, results, isCancelled, acceptFile, maxResults);
		}
		return;
	}

	const regex = segmentToRegex(head);
	const entries = (await readDirPath(baseDir, anchor)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
	for (const [entry, fileType] of entries) {
		if (isCancelled() || results.length >= maxResults) return;
		if (!regex.test(entry)) continue;
		const fullPath = pp.join(baseDir, entry);
		if (isLast) {
			if (fileType & vscode.FileType.File) {
				const uri = pathToUri(fullPath, anchor);
				if (acceptFile(uri)) results.push(uri);
			}
		} else {
			if (fileType & vscode.FileType.Directory) {
				await expandGlobSegmentsAsync(fullPath, tail, anchor, results, isCancelled, acceptFile, maxResults);
			}
		}
	}
}

export async function expandGlobPatternAsync(pattern: string, anchor: vscode.Uri, isCancelled: () => boolean, options: GlobOptions = {}): Promise<vscode.Uri[]> {
	const { acceptFile = () => true, expandDirectory = true, maxResults = 2000 } = options;
	if (isCancelled() || maxResults <= 0) return [];
	const pp = pathModuleFor(anchor);
	const plain = pattern.replace(/[/\\]+$/, '') || pp.sep;
	const exact = await statPath(plain, anchor);
	if (exact || !hasGlob(pattern)) {
		const st = exact;
		if (!st) return [];
		if (st.type & vscode.FileType.Directory) {
			if (!expandDirectory) return [];
			// A plain folder path expands to every accepted file directly
			// inside it (non-recursive, mirroring the Explorer context menu).
			const results: vscode.Uri[] = [];
			for (const [name, fileType] of await readDirPath(plain, anchor)) {
				if (isCancelled() || results.length >= maxResults) break;
				if ((fileType & vscode.FileType.File) === 0) continue;
				const uri = pathToUri(pp.join(plain, name), anchor);
				if (acceptFile(uri)) results.push(uri);
			}
			return results.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
		}
		const uri = pathToUri(plain, anchor);
		return (st.type & vscode.FileType.File) && acceptFile(uri) ? [uri] : [];
	}

	const firstWild = pattern.search(/[*?\[{]/);
	const beforeWild = pattern.substring(0, firstWild);
	const endsWithSep = beforeWild.endsWith('/') || beforeWild.endsWith('\\');
	const baseDir = pp.dirname(endsWithSep ? beforeWild + '_' : beforeWild);
	// dirname of a root-level path returns the root itself ('/' or 'C:\'),
	// which already ends with a separator — don't skip an extra character.
	const remainder = pattern.substring(baseDir.endsWith(pp.sep) ? baseDir.length : baseDir.length + 1);
	const segments = remainder.split(/[/\\]/);

	const results: vscode.Uri[] = [];
	await expandGlobSegmentsAsync(baseDir, segments, anchor, results, isCancelled, acceptFile, maxResults);
	return results.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}


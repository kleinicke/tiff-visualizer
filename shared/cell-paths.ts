/** Path helpers for cell files, shared by the extension host and the viewers. Pure: no VS Code or DOM API. */

/**
 * Fill `{sample_name}` in a path template. A function is only called when the
 * template uses `{sample_name}`. The name is inserted literally: `$&` and similar
 * replacement patterns in it are not expanded.
 */
export function expandSampleName(template: string, sampleName: string | (() => string)): string {
	return template.replace(/\{sample_name\}/g, typeof sampleName === 'function' ? sampleName : () => sampleName);
}

export function isAbsolutePath(path: string): boolean {
	return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

/** Short display name for a path typed or picked by the user: the file name without its extension. */
export function sourceNameFromPath(path: string): string {
	const file = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
	return file.replace(/\.(parquet|tiff?|csv|tsv)$/i, '') || path;
}

/** Why a pattern could not supply the name; stable across file names, so a warning can be shown once per problem. */
export type SampleNameProblem = 'invalid' | 'no-group' | 'no-match' | 'empty';

export interface SampleNameResult { name: string; warning?: string; problem?: SampleNameProblem }

/**
 * `{sample_name}` for a folder or file name. With no pattern it is the name
 * itself. Otherwise `pattern` is a regular expression with a named group
 * `sample_name`, and the first match in `rawName` supplies the name. Anything
 * that stops the pattern working gives `rawName` back with a warning.
 */
export function extractSampleName(pattern: string | undefined, rawName: string): SampleNameResult {
	const source = pattern?.trim();
	if (!source) { return { name: rawName }; }
	const fallback = (problem: SampleNameProblem, detail: string): SampleNameResult => ({ name: rawName, problem, warning: `tiffVisualizer.cells.sampleNamePattern ${detail}; using "${rawName}" as {sample_name}.` });
	let regex: RegExp;
	try { regex = new RegExp(source); } catch (error) { return fallback('invalid', `is not a valid regular expression (${error instanceof Error ? error.message : String(error)})`); }
	if (!/(?<!\\)\(\?<sample_name>/.test(source)) { return fallback('no-group', 'needs a named group (?<sample_name>...)'); }
	const matched = regex.exec(rawName);
	if (!matched) { return fallback('no-match', `does not match "${rawName}"`); }
	const name = matched.groups?.sample_name;
	if (!name) { return fallback('empty', `matched "${rawName}" but its sample_name group captured nothing`); }
	return { name };
}

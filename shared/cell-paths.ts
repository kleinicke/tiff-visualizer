/** Path helpers for cell files, shared by the extension host and the viewers. Pure: no VS Code or DOM API. */

/** Fill `{sample_name}` in a path template. */
export function expandSampleName(template: string, sampleName: string): string {
	return template.replace(/\{sample_name\}/g, sampleName);
}

export function isAbsolutePath(path: string): boolean {
	return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

/** Short display name for a path typed or picked by the user: the file name without its extension. */
export function sourceNameFromPath(path: string): string {
	const file = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
	return file.replace(/\.(parquet|tiff?|csv|tsv)$/i, '') || path;
}

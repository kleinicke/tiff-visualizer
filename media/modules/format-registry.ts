"use strict";
/**
 * Single source of truth for "what kind of file is this, and who decodes it".
 *
 * This used to be spread across a fifteen-branch `if/else` chain in
 * `imagePreview.ts`, a `switch` in `decode-worker.ts`, the `customEditors`
 * selectors in package.json, and several ad-hoc regexes. Adding a format meant
 * editing all of them with no compiler help if you missed one, and the answer
 * to "which decoder handles this file?" was not written down anywhere — it had
 * to be reconstructed by reading the chain in order, where earlier branches
 * silently shadow later ones.
 *
 * WHAT THIS IS NOT: `ImageFormatType` in `appStateManager.ts` (`tiff-float`,
 * `npy-uint`, ...) is deliberately absent here. Those are per-format RENDERING
 * SETTINGS keys chosen from the DECODED DATA — the same `.tif` is `tiff-float`
 * or `tiff-int-signed` depending on its sample format. Extension routing and
 * settings keys are different questions and folding them together would be
 * wrong.
 */

/** How a file's bytes get turned into pixels. */
export type DecoderKind =
	| 'tiff'
	| 'exr'
	| 'pfm'
	| 'netpbm'
	| 'png'
	| 'npy'
	| 'hdr'
	| 'tga'
	| 'web-image'
	| 'jxl'
	| 'fits'
	| 'dicom'
	| 'netcdf'
	| 'czi'
	| 'nd2'
	| 'lif'
	| 'layered';

export interface FormatEntry {
	/** Stable identifier, also the decode-worker `format` string where one exists. */
	readonly kind: DecoderKind;
	/** Lower-case extensions WITHOUT the leading dot. */
	readonly extensions: readonly string[];
	/** Human-readable name used in logs and diagnostics. */
	readonly label: string;
	/**
	 * Layered creative documents share one processor and pass this discriminator
	 * to it; `undefined` for every other kind.
	 */
	readonly layeredFormat?: 'ora' | 'kra' | 'psd' | 'psb' | 'xcf' | 'affinity';
}

/**
 * Order matters only for documentation: lookup is by exact extension, so
 * entries cannot shadow one another the way the old `if/else` chain could.
 */
export const FORMATS: readonly FormatEntry[] = [
	{ kind: 'tiff', label: 'TIFF', extensions: ['tif', 'tiff', 'tf2', 'tf8', 'btf'] },
	{ kind: 'exr', label: 'OpenEXR', extensions: ['exr'] },
	{ kind: 'pfm', label: 'PFM', extensions: ['pfm'] },
	{ kind: 'netpbm', label: 'NetPBM', extensions: ['ppm', 'pgm', 'pbm'] },
	{ kind: 'png', label: 'PNG/JPEG', extensions: ['png', 'jpg', 'jpeg'] },
	{ kind: 'npy', label: 'NumPy', extensions: ['npy', 'npz'] },
	{ kind: 'hdr', label: 'Radiance HDR', extensions: ['hdr'] },
	{ kind: 'tga', label: 'TGA', extensions: ['tga'] },
	{ kind: 'web-image', label: 'Browser image', extensions: ['webp', 'avif', 'bmp', 'ico'] },
	{ kind: 'jxl', label: 'JPEG XL', extensions: ['jxl'] },
	{ kind: 'fits', label: 'FITS', extensions: ['fits', 'fit', 'fts'] },
	{ kind: 'dicom', label: 'DICOM', extensions: ['dcm', 'dicom'] },
	{ kind: 'netcdf', label: 'NetCDF', extensions: ['nc', 'cdf'] },
	{ kind: 'czi', label: 'Zeiss CZI', extensions: ['czi'] },
	{ kind: 'nd2', label: 'Nikon ND2', extensions: ['nd2'] },
	{ kind: 'lif', label: 'Leica LIF', extensions: ['lif'] },
	{ kind: 'layered', label: 'OpenRaster', extensions: ['ora'], layeredFormat: 'ora' },
	{ kind: 'layered', label: 'Krita', extensions: ['kra'], layeredFormat: 'kra' },
	{ kind: 'layered', label: 'Photoshop', extensions: ['psd'], layeredFormat: 'psd' },
	{ kind: 'layered', label: 'Photoshop Large', extensions: ['psb'], layeredFormat: 'psb' },
	{ kind: 'layered', label: 'GIMP XCF', extensions: ['xcf'], layeredFormat: 'xcf' },
	{ kind: 'layered', label: 'Affinity Photo', extensions: ['afphoto', 'af'], layeredFormat: 'affinity' },
];

const BY_EXTENSION: ReadonlyMap<string, FormatEntry> = (() => {
	const map = new Map<string, FormatEntry>();
	for (const entry of FORMATS) {
		for (const extension of entry.extensions) {
			if (map.has(extension)) {
				// Two entries claiming one extension is a registry bug, not a
				// runtime condition — surface it rather than picking silently.
				throw new Error(`format-registry: '.${extension}' is claimed by both `
					+ `'${map.get(extension)!.label}' and '${entry.label}'`);
			}
			map.set(extension, entry);
		}
	}
	return map;
})();

/** Every extension the viewer claims, sorted — used to check package.json. */
export function allExtensions(): string[] {
	return [...BY_EXTENSION.keys()].sort();
}

/** Extension of `path` without the dot, lower-cased; '' when there is none. */
export function extensionOf(path: string): string {
	const name = path.split('/').pop() || '';
	const dot = name.lastIndexOf('.');
	return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * Resolves the decoder for a resource.
 *
 * `formatHint` wins when present: the extension host uses it to open a file
 * whose name does not describe its contents (a DICOM instance exported without
 * an extension, or a page of an already-identified TIFF).
 *
 * An extensionless file is treated as DICOM, matching the long-standing
 * behaviour that lets extensionless DICOM studies open. That heuristic used to
 * live as the trailing condition of a long `else if` chain, where it was easy
 * to read as a general catch-all; it is deliberate and narrow.
 */
export function resolveFormat(path: string, formatHint?: string): FormatEntry | null {
	if (formatHint) {
		const hinted = FORMATS.find(entry => entry.kind === formatHint);
		if (hinted) { return hinted; }
	}
	const extension = extensionOf(path);
	if (!extension) {
		return FORMATS.find(entry => entry.kind === 'dicom') || null;
	}
	return BY_EXTENSION.get(extension) || null;
}

/** True for the TIFF family, including the BigTIFF spellings. */
export function isTiffPath(path: string): boolean {
	return resolveFormat(path)?.kind === 'tiff';
}

/** The layered-document discriminator for `path`, or null if it is not one. */
export function layeredFormatOf(path: string): FormatEntry['layeredFormat'] | null {
	const entry = resolveFormat(path);
	return entry?.kind === 'layered' ? entry.layeredFormat! : null;
}

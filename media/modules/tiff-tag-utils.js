// @ts-check
"use strict";

/**
 * Shared helpers for the TIFF tag/metadata dump surfaced in the Metadata panel.
 *
 * The Rust/WASM decoder (default path) walks the raw IFD generically and
 * returns every tag it finds — including Exif/GPS sub-IFD tags — as a JSON
 * string via `TiffResult.all_tags_json`. `parseAllTagsJson` just parses that.
 *
 * The geotiff.js fallback path (used when the Rust decoder rejects a TIFF
 * variant) doesn't expose an equivalent raw-tag walk, so `buildTagsFromGeotiffImage`
 * enumerates whatever geotiff.js already parsed into `image.fileDirectory` /
 * `image.geoKeys` generically — no curated tag list on this path either.
 */

/** @typedef {{tag: number|null, name: string, group: string, value: string}} TagEntry */

/**
 * @param {string|undefined|null} json
 * @returns {TagEntry[]}
 */
export function parseAllTagsJson(json) {
	if (!json) { return []; }
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

const MAX_SHOWN_ARRAY_VALUES = 16;

/**
 * @param {any} value
 * @returns {string}
 */
function stringifyTagValue(value) {
	if (value === null || value === undefined) { return ''; }
	if (Array.isArray(value) || ArrayBuffer.isView(value)) {
		const arr = Array.from(/** @type {ArrayLike<any>} */ (value));
		const shown = arr.slice(0, MAX_SHOWN_ARRAY_VALUES).join(', ');
		return arr.length > MAX_SHOWN_ARRAY_VALUES
			? `${shown}, … (${arr.length - MAX_SHOWN_ARRAY_VALUES} more)`
			: shown;
	}
	if (typeof value === 'object') {
		try { return JSON.stringify(value); } catch { return String(value); }
	}
	return String(value);
}

/**
 * Enumerate every tag geotiff.js has already parsed for an image, generically
 * (no curated subset) — used only on the geotiff.js compatibility fallback
 * path, since the Rust/WASM decoder path has its own raw-IFD walk.
 * @param {any} image - geotiff.js GeoTIFFImage instance
 * @returns {TagEntry[]}
 */
export function buildTagsFromGeotiffImage(image) {
	/** @type {TagEntry[]} */
	const out = [];
	const fileDirectory = image?.fileDirectory || {};
	for (const [name, rawValue] of Object.entries(fileDirectory)) {
		out.push({ tag: null, name, group: 'TIFF', value: stringifyTagValue(rawValue) });
	}
	// geotiff.js resolves the GeoKeyDirectory into a plain object when present.
	let geoKeys = null;
	try { geoKeys = typeof image?.getGeoKeys === 'function' ? image.getGeoKeys() : image?.geoKeys; } catch { /* not a GeoTIFF */ }
	if (geoKeys && typeof geoKeys === 'object') {
		for (const [name, rawValue] of Object.entries(geoKeys)) {
			out.push({ tag: null, name, group: 'GeoKeys', value: stringifyTagValue(rawValue) });
		}
	}
	return out;
}

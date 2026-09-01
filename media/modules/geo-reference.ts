"use strict";

/**
 * GeoTIFF georeferencing on the webview side.
 *
 * The parsing is Rust's (`crates/image-decoders/src/formats/tiff/geokeys.rs`),
 * per the repository rule that complete byte parsers live there. What is left
 * here is applying the affine transform to a cursor position and formatting
 * the result for a human — arithmetic over an already-typed model, and the
 * formatting decisions are display concerns that belong next to the UI.
 */

/** The decoded georeferencing, as `GeoReference::to_json` emits it. */
export interface GeoReference {
	/** e.g. "EPSG:32631 (WGS 84 / UTM zone 31N)". Absent if the file names none. */
	crs?: string;
	/** True when the coordinates are degrees, so they read as lon/lat. */
	isGeographic: boolean;
	/**
	 * GTRasterTypeGeoKey. PixelIsArea (false) anchors a pixel's coordinate at
	 * its top-left CORNER; PixelIsPoint (true) at its CENTRE.
	 */
	pixelIsPoint: boolean;
	/** "metre", "degree", ... — for labelling a projected readout. */
	unit?: string;
	/** Affine [a, b, c, d, e, f]: x = a·px + b·py + c, y = d·px + e·py + f. */
	transform?: number[];
}

/** Parse the decoder's `geoJson`, tolerating absence and malformed text. */
export function parseGeoReference(json: string | undefined | null): GeoReference | null {
	if (!json) { return null; }
	try {
		const parsed = JSON.parse(json);
		if (!parsed || typeof parsed !== 'object') { return null; }
		return parsed as GeoReference;
	} catch {
		return null;
	}
}

/**
 * The model coordinate of pixel (x, y), or null when the file georeferences
 * a CRS but never says where the raster sits — which is a real combination,
 * not a parse failure.
 */
export function mapCoordinate(
	geo: GeoReference | null,
	x: number,
	y: number,
): { x: number; y: number } | null {
	const t = geo?.transform;
	if (!t || t.length < 6) { return null; }
	// PixelIsArea puts the tagged coordinate at the pixel's corner, so the
	// CENTRE of the pixel under the cursor — which is what the reader means by
	// "where is this pixel" — is half a pixel further along both axes.
	// PixelIsPoint already refers to the centre, so it gets no shift.
	const offset = geo!.pixelIsPoint ? 0 : 0.5;
	const px = x + offset;
	const py = y + offset;
	return {
		x: t[0] * px + t[1] * py + t[2],
		y: t[3] * px + t[4] * py + t[5],
	};
}

/** Degrees as `50.1234°N`, the form a reader can check against a map. */
function formatDegrees(value: number, positive: string, negative: string): string {
	const hemisphere = value >= 0 ? positive : negative;
	return `${Math.abs(value).toFixed(6)}°${hemisphere}`;
}

/**
 * The cursor's position in the raster's own CRS, or '' when there is none.
 *
 * Geographic rasters read as lon/lat because they already are; projected ones
 * read as easting/northing in their own units, NOT converted to lat/lon —
 * that conversion needs the projection maths this deliberately does not carry,
 * and a wrong latitude looks entirely plausible.
 */
export function formatMapPosition(
	geo: GeoReference | null,
	x: number,
	y: number,
): string {
	const point = mapCoordinate(geo, x, y);
	if (!point) { return ''; }
	if (geo!.isGeographic) {
		// x is longitude, y is latitude — the GeoTIFF model axis order.
		return `${formatDegrees(point.y, 'N', 'S')} ${formatDegrees(point.x, 'E', 'W')}`;
	}
	// Projected coordinates are large numbers (a UTM easting is six digits),
	// so a fixed 2 decimals reads better than a precision-based format that
	// would show 300000.00 as 3.0000e5.
	const unit = geo!.unit === 'metre' ? ' m' : geo!.unit ? ` ${geo!.unit}` : '';
	return `E ${point.x.toFixed(2)}${unit}, N ${point.y.toFixed(2)}${unit}`;
}

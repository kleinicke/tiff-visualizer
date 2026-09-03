"use strict";

/**
 * How a pixel with no value is drawn.
 *
 * "No value" covers two things the viewer treats alike: a non-finite sample
 * (NaN or infinity, which is the producing pipeline saying it had no answer)
 * and a declared nodata sentinel (GDAL_NODATA, which is the file saying the
 * same thing). Neither is a measurement, so neither should be shown as one.
 *
 * The three choices answer different questions:
 *
 *   black        — stay out of the way. The default, and right when the holes
 *                  are incidental and you are reading the data around them.
 *   fuchsia      — where ARE they? Nothing in real data is this colour, so the
 *                  holes are unmistakable at a glance.
 *   transparent  — treat them as absent. The pixels get alpha 0, so a layer
 *                  underneath shows through and an exported PNG carries a real
 *                  hole rather than a coloured patch. This is what GDAL and
 *                  QGIS do with nodata by default, which is why a geospatial
 *                  reader expects it.
 *
 * One resolver rather than a `=== 'fuchsia'` check in every processor: adding
 * the third option to seven copies is how a setting ends up meaning different
 * things in different formats.
 */

export type NanColorName = 'black' | 'fuchsia' | 'transparent';

export interface NanColor {
	r: number;
	g: number;
	b: number;
	/** 0-255. Only 'transparent' is anything but opaque. */
	a: number;
}

export const NAN_COLOR_NAMES: readonly NanColorName[] = ['black', 'fuchsia', 'transparent'];

/** The next choice in the cycle the toggle command walks. */
export function nextNanColor(current: string | undefined): NanColorName {
	const index = NAN_COLOR_NAMES.indexOf(String(current) as NanColorName);
	return NAN_COLOR_NAMES[(index + 1) % NAN_COLOR_NAMES.length];
}

/**
 * The colour for a settings object. Accepts a `#rrggbb` string too, which the
 * NPY path has always allowed; anything unrecognized falls back to black,
 * since a mis-typed setting should not make an image invisible.
 */
export function resolveNanColor(settings: { nanColor?: unknown } | null | undefined): NanColor {
	const value = settings?.nanColor;
	if (typeof value === 'object' && value !== null) {
		const candidate = value as { r?: number, g?: number, b?: number, a?: number };
		return {
			r: Number(candidate.r) || 0,
			g: Number(candidate.g) || 0,
			b: Number(candidate.b) || 0,
			a: candidate.a === undefined ? 255 : Number(candidate.a),
		};
	}
	const name = String(value ?? 'black');
	if (name === 'fuchsia') { return { r: 255, g: 0, b: 255, a: 255 }; }
	if (name === 'transparent') {
		// The RGB still matters: a viewer that ignores alpha (an old capture
		// path, a copy into an opaque surface) then shows black rather than an
		// arbitrary colour.
		return { r: 0, g: 0, b: 0, a: 0 };
	}
	const hex = /^#?([0-9a-f]{6})$/i.exec(name);
	if (hex) {
		const packed = parseInt(hex[1], 16);
		return { r: (packed >> 16) & 255, g: (packed >> 8) & 255, b: packed & 255, a: 255 };
	}
	return { r: 0, g: 0, b: 0, a: 255 };
}

/** Whether pixels with no value are drawn as holes rather than as a colour. */
export function nanIsTransparent(settings: { nanColor?: unknown } | null | undefined): boolean {
	return resolveNanColor(settings).a === 0;
}

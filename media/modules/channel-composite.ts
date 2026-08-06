"use strict";

import { getColormapLut } from './colormaps.js';

/**
 * Multi-channel compositing — the scientific "Composite" / "Display Adjustment"
 * mode: several channels shown at once, each with its own tint, opacity and
 * display range, summed additively.
 *
 * **This is not the layer compositor.** `layer-compositor.ts` implements
 * authoring semantics — Photoshop/GIMP blend modes, clipping, groups, alpha
 * over. What happens here is raw arithmetic over scientific channels: scale each
 * channel by its own range, multiply by its tint, add. Emission from separate
 * fluorophores physically adds at the detector, so addition is the operation
 * that corresponds to the data, and alpha-over would misrepresent it.
 *
 * Everything is computed from the **raw** sample values, so the composite is
 * consistent with the measurement subsystem: a pixel's contribution comes from
 * the same number `measureRoi` would report.
 */

/** One channel's pixel data, already separated from any interleaving. */
export interface ChannelPlane {
	index: number;
	name: string;
	/** width * height samples, raw values. */
	data: ArrayLike<number>;
	width: number;
	height: number;
}

export interface ChannelStats {
	min: number;
	max: number;
	/** Sample count that was finite; the rest were excluded. */
	count: number;
	nonFiniteCount: number;
}

export interface ChannelSettings {
	visible: boolean;
	/** CSS hex tint, e.g. "#00ff00". */
	color: string;
	/** 0..1 */
	opacity: number;
	/** Display range in raw units. */
	min: number;
	max: number;
	/**
	 * Optional colormap applied instead of a flat tint. A flat tint is the
	 * microscopy convention; a colormap is occasionally wanted for a single
	 * ratiometric channel.
	 */
	colormap?: string;
}

/** Fallback tints, in the order fluorescence channels usually arrive. */
export const CHANNEL_PALETTE = [
	'#00ff00', // green — GFP and friends dominate channel 0 in practice
	'#ff0040', // magenta-red
	'#3399ff', // blue — DAPI is usually the last acquired, first shown
	'#ffcc00',
	'#ff8000',
	'#00ffcc',
	'#cc66ff',
	'#ffffff',
];

export function defaultChannelColor(index: number, suggested?: string): string {
	// OME `Channel/@Color` is authoritative when the file provides it: the
	// acquisition software knows which fluorophore this is and we do not.
	if (suggested && /^#[0-9a-f]{6}$/i.test(suggested)) { return suggested; }
	return CHANNEL_PALETTE[index % CHANNEL_PALETTE.length];
}

/** Parse "#rrggbb" into 0..255 components. */
export function parseColor(color: string): [number, number, number] {
	const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
	if (!match) { return [255, 255, 255]; }
	return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

/**
 * Min/max of one channel, excluding non-finite samples.
 *
 * Per-channel rather than per-image: a DAPI channel and a dim GFP channel share
 * no useful scale, and normalising them together is exactly what makes one of
 * them invisible. `ImageStatsCalculator` reasons about the image as a whole, so
 * this is deliberately its own pass.
 */
export function channelStats(plane: ChannelPlane, step = 1): ChannelStats {
	let min = Infinity;
	let max = -Infinity;
	let count = 0;
	let nonFinite = 0;
	const data = plane.data;
	for (let i = 0; i < data.length; i += step) {
		const value = Number(data[i]);
		if (!Number.isFinite(value)) { nonFinite++; continue; }
		if (value < min) { min = value; }
		if (value > max) { max = value; }
		count++;
	}
	if (count === 0) { return { min: 0, max: 1, count: 0, nonFiniteCount: nonFinite }; }
	return { min, max, count, nonFiniteCount: nonFinite };
}

/**
 * Percentile-based auto range.
 *
 * Plain min/max is a poor default for fluorescence: one hot pixel sets the
 * maximum and the actual signal collapses into the bottom few percent of the
 * range. Clipping a small fraction at each end is what every acquisition
 * package does by default, and it is why "auto" looks right there and wrong
 * with a naive implementation.
 */
export function autoRange(plane: ChannelPlane, lowFraction = 0.001, highFraction = 0.999): { min: number; max: number } {
	const stats = channelStats(plane);
	if (stats.count === 0 || stats.max === stats.min) { return { min: stats.min, max: stats.max || stats.min + 1 }; }

	const bins = 4096;
	const counts = new Int32Array(bins);
	const scale = bins / (stats.max - stats.min);
	const data = plane.data;
	for (let i = 0; i < data.length; i++) {
		const value = Number(data[i]);
		if (!Number.isFinite(value)) { continue; }
		let bin = Math.floor((value - stats.min) * scale);
		if (bin >= bins) { bin = bins - 1; }
		if (bin < 0) { bin = 0; }
		counts[bin]++;
	}

	const lowTarget = stats.count * lowFraction;
	const highTarget = stats.count * highFraction;
	let cumulative = 0;
	let low = stats.min;
	let high = stats.max;
	let haveLow = false;
	for (let bin = 0; bin < bins; bin++) {
		cumulative += counts[bin];
		if (!haveLow && cumulative >= lowTarget) {
			low = stats.min + (bin / bins) * (stats.max - stats.min);
			haveLow = true;
		}
		if (cumulative >= highTarget) {
			high = stats.min + ((bin + 1) / bins) * (stats.max - stats.min);
			break;
		}
	}
	if (!(high > low)) { high = low + (stats.max - stats.min) / bins || 1; }
	return { min: low, max: high };
}

export interface CompositeOptions {
	/** Applied to the normalised value before tinting. 1 disables it. */
	gamma?: number;
	/** Colour for pixels that are not finite in any visible channel. */
	nanColor?: [number, number, number];
	/**
	 * Grey out everything but one channel. Solo is a view, not a settings
	 * change, so it is passed per render rather than stored per channel.
	 */
	soloIndex?: number | null;
}

/** Number of steps in the per-channel colour lookup table. */
export const LUT_STEPS = 1024;

/**
 * A channel prepared for compositing: its plane plus the colour it contributes
 * at every normalised level.
 *
 * Split out so the CPU path and the GPU path build the table with exactly the
 * same code. A GPU compositor that reimplemented tint, gamma, opacity and
 * colormap in a shader would drift from the CPU reference silently, and the CPU
 * path is the correctness reference for the whole render stack.
 */
export interface PreparedChannel {
	plane: ChannelPlane;
	/** LUT_STEPS entries of premultiplied colour, 0..255 per component. */
	lut: Float32Array;
	min: number;
	/** 1 / (max - min), or 0 for a degenerate range. */
	scale: number;
}

export function prepareChannels(
	planes: ChannelPlane[],
	settings: ChannelSettings[],
	width: number,
	height: number,
	options: { gamma?: number; solo?: number | null; identityGamma?: boolean } = {},
): PreparedChannel[] {
	const gamma = options.gamma && options.gamma > 0 ? options.gamma : 1;
	const identityGamma = options.identityGamma ?? Math.abs(gamma - 1) < 1e-6;
	const solo = options.solo ?? null;
	const prepared: PreparedChannel[] = [];

	for (let i = 0; i < planes.length; i++) {
		const plane = planes[i];
		const setting = settings[i];
		if (!setting || !setting.visible) { continue; }
		if (solo !== null && plane.index !== solo) { continue; }
		if (plane.width !== width || plane.height !== height) { continue; }

		const range = setting.max - setting.min;
		const scale = range !== 0 ? 1 / range : 0;
		const opacity = Math.max(0, Math.min(1, setting.opacity));

		// A colormap replaces the flat tint entirely: its own colour already
		// encodes the value, so multiplying it by a tint as well would just
		// darken it.
		const colormapLut = setting.colormap && setting.colormap !== 'none'
			? getColormapLut(setting.colormap)
			: null;
		const [tintR, tintG, tintB] = parseColor(setting.color);

		const lut = new Float32Array(LUT_STEPS * 3);
		for (let s = 0; s < LUT_STEPS; s++) {
			let t = s / (LUT_STEPS - 1);
			if (!identityGamma) { t = Math.pow(t, gamma); }
			if (colormapLut) {
				const entry = Math.min(255, Math.max(0, Math.round(t * 255)));
				lut[s * 3] = colormapLut[entry * 3] * opacity;
				lut[s * 3 + 1] = colormapLut[entry * 3 + 1] * opacity;
				lut[s * 3 + 2] = colormapLut[entry * 3 + 2] * opacity;
			} else {
				lut[s * 3] = tintR * t * opacity;
				lut[s * 3 + 1] = tintG * t * opacity;
				lut[s * 3 + 2] = tintB * t * opacity;
			}
		}

		prepared.push({ plane, lut, min: setting.min, scale });
	}

	return prepared;
}

/**
 * Composite the visible channels into RGBA.
 *
 * Additive, saturating at 255. Each channel contributes
 * `tint × clamp((v − min) / (max − min))^γ × opacity`, so a channel's own range
 * decides its brightness and a shared bright channel never rescales the others.
 */
export function compositeChannels(
	planes: ChannelPlane[],
	settings: ChannelSettings[],
	width: number,
	height: number,
	options: CompositeOptions = {},
): ImageData {
	const pixels = width * height;
	const output = new Uint8ClampedArray(pixels * 4);
	const gamma = options.gamma && options.gamma > 0 ? options.gamma : 1;
	const identityGamma = Math.abs(gamma - 1) < 1e-6;
	const solo = options.soloIndex ?? null;

	const prepared = prepareChannels(planes, settings, width, height, { gamma, solo, identityGamma });
	const [nanR, nanG, nanB] = options.nanColor || [0, 0, 0];

	for (let p = 0; p < pixels; p++) {
		let r = 0;
		let g = 0;
		let b = 0;
		let sawFinite = false;

		for (let c = 0; c < prepared.length; c++) {
			const entry = prepared[c];
			const value = Number(entry.plane.data[p]);
			// Non-finite samples contribute nothing rather than being clamped to
			// the bottom of the range, which is the same rule the measurement
			// path uses.
			if (!Number.isFinite(value)) { continue; }
			sawFinite = true;
			let t = (value - entry.min) * entry.scale;
			if (t <= 0) { continue; }
			if (t > 1) { t = 1; }
			const step = ((t * (LUT_STEPS - 1)) | 0) * 3;
			r += entry.lut[step];
			g += entry.lut[step + 1];
			b += entry.lut[step + 2];
		}

		const offset = p * 4;
		if (!sawFinite && prepared.length > 0) {
			output[offset] = nanR;
			output[offset + 1] = nanG;
			output[offset + 2] = nanB;
		} else {
			output[offset] = r;
			output[offset + 1] = g;
			output[offset + 2] = b;
		}
		output[offset + 3] = 255;
	}

	return new ImageData(output, width, height);
}

/**
 * Split an interleaved buffer into per-channel planes.
 *
 * No copy is made of the source; each plane is a strided view materialised into
 * its own array, because every consumer below indexes planes densely and a
 * strided read in the inner loop costs more than the one-off copy.
 */
export function planesFromInterleaved(
	data: ArrayLike<number>,
	width: number,
	height: number,
	channels: number,
	names?: string[],
): ChannelPlane[] {
	const pixels = width * height;
	const planes: ChannelPlane[] = [];
	for (let c = 0; c < channels; c++) {
		const plane = new Float32Array(pixels);
		for (let p = 0; p < pixels; p++) { plane[p] = Number(data[p * channels + c]); }
		planes.push({
			index: c,
			name: names?.[c] || defaultChannelName(c, channels),
			data: plane,
			width,
			height,
		});
	}
	return planes;
}

/**
 * A channel's default name.
 *
 * Three or four channels of an ordinary image are almost always RGB(A), and
 * calling them "Channel 1..3" there would be needlessly obscure. Anything else
 * gets a number, because guessing fluorophores would be worse than saying
 * nothing.
 */
export function defaultChannelName(index: number, channelCount: number): string {
	if (channelCount === 3 || channelCount === 4) {
		return ['Red', 'Green', 'Blue', 'Alpha'][index] || `Channel ${index + 1}`;
	}
	return `Channel ${index + 1}`;
}

/** Build default settings for a set of planes. */
export function defaultChannelSettings(
	planes: ChannelPlane[],
	options: { colors?: (string | undefined)[]; useAutoRange?: boolean } = {},
): ChannelSettings[] {
	return planes.map((plane, index) => {
		const range = options.useAutoRange === false
			? channelStats(plane)
			: autoRange(plane);
		return {
			// Alpha is data, not a colour to add: showing it as a fourth emission
			// channel would wash out the composite.
			visible: !(planes.length === 4 && index === 3),
			color: defaultChannelColor(index, options.colors?.[index]),
			opacity: 1,
			min: range.min,
			max: range.max,
		};
	});
}

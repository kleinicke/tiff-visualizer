// @ts-check
"use strict";

/**
 * Shared colormap definitions and lookup tables.
 *
 * This module is the single source of truth for colormaps used in two directions:
 *  - "Apply" (pseudocolor): map a single-channel scalar to RGB at render time.
 *    Used by ImageRenderer in normalization-helper.js.
 *  - "Decode" (remove color): recover a scalar from a colormapped RGB image.
 *    Used by ColormapConverter in colormap-converter.js.
 *
 * Each colormap is generated as 256 [r, g, b] entries (0-255). Forward LUTs and
 * the inverse-lookup cube are cached so they are only built once per colormap.
 */

/** @type {string[]} */
export const COLORMAP_NAMES = [
	'viridis', 'plasma', 'inferno', 'magma', 'jet', 'hot', 'cool', 'turbo', 'gray'
];

/** Perceptually-uniform colormap control points (matplotlib), interpolated to 256. */
const CONTROL_POINTS = {
	viridis: [
		[0.267004, 0.004874, 0.329415], [0.282623, 0.140926, 0.457517],
		[0.253935, 0.265254, 0.529983], [0.206756, 0.371758, 0.553117],
		[0.163625, 0.471133, 0.558148], [0.127568, 0.566949, 0.550556],
		[0.134692, 0.658636, 0.517649], [0.266941, 0.748751, 0.440573],
		[0.477504, 0.821444, 0.318195], [0.741388, 0.873449, 0.149561],
		[0.993248, 0.906157, 0.143936]
	],
	plasma: [
		[0.050383, 0.029803, 0.527975], [0.287076, 0.010384, 0.627010],
		[0.476230, 0.011158, 0.657865], [0.647257, 0.125289, 0.593542],
		[0.785914, 0.274290, 0.472908], [0.877850, 0.439704, 0.345067],
		[0.936213, 0.605205, 0.231465], [0.972355, 0.771125, 0.155626],
		[0.994617, 0.938336, 0.165141], [0.987053, 0.991438, 0.749504]
	],
	inferno: [
		[0.001462, 0.000466, 0.013866], [0.094329, 0.042852, 0.225802],
		[0.239903, 0.067979, 0.343397], [0.412470, 0.102815, 0.380271],
		[0.591217, 0.155410, 0.347824], [0.758643, 0.237267, 0.275196],
		[0.889650, 0.360829, 0.210001], [0.969788, 0.514135, 0.186861],
		[0.994738, 0.683489, 0.240902], [0.988362, 0.998364, 0.644924]
	],
	magma: [
		[0.001462, 0.000466, 0.013866], [0.091904, 0.051667, 0.200303],
		[0.234547, 0.090739, 0.348341], [0.408198, 0.131574, 0.416555],
		[0.595732, 0.180653, 0.421399], [0.776405, 0.266630, 0.373397],
		[0.924010, 0.406370, 0.330720], [0.987622, 0.583041, 0.382914],
		[0.996212, 0.771453, 0.543135], [0.987053, 0.991438, 0.749504]
	],
	turbo: [
		[0.18995, 0.07176, 0.23217], [0.25107, 0.25237, 0.63374],
		[0.19659, 0.47276, 0.82300], [0.12756, 0.66813, 0.82565],
		[0.13094, 0.82030, 0.65899], [0.37408, 0.92478, 0.41642],
		[0.66987, 0.95987, 0.19659], [0.90842, 0.87640, 0.10899],
		[0.98999, 0.64450, 0.03932], [0.93702, 0.25023, 0.01583]
	]
};

/**
 * Interpolate a control-point colormap to 256 [r,g,b] entries (0-255).
 * @param {number[][]} points
 * @returns {number[][]}
 */
function interpolateControlPoints(points) {
	const out = [];
	for (let i = 0; i < 256; i++) {
		const pos = (i / 255.0) * (points.length - 1);
		const idx = Math.floor(pos);
		const frac = pos - idx;
		const c1 = points[Math.min(idx, points.length - 1)];
		const c2 = points[Math.min(idx + 1, points.length - 1)];
		out.push([
			Math.round((c1[0] * (1 - frac) + c2[0] * frac) * 255),
			Math.round((c1[1] * (1 - frac) + c2[1] * frac) * 255),
			Math.round((c1[2] * (1 - frac) + c2[2] * frac) * 255)
		]);
	}
	return out;
}

/** @returns {number[][]} */
function generateGray() {
	const out = [];
	for (let i = 0; i < 256; i++) { out.push([i, i, i]); }
	return out;
}

/** @returns {number[][]} */
function generateJet() {
	const out = [];
	for (let i = 0; i < 256; i++) {
		const v = i / 255.0;
		let r, g, b;
		if (v < 0.125) { r = 0; g = 0; b = 0.5 + v * 4; }
		else if (v < 0.375) { r = 0; g = (v - 0.125) * 4; b = 1; }
		else if (v < 0.625) { r = (v - 0.375) * 4; g = 1; b = 1 - (v - 0.375) * 4; }
		else if (v < 0.875) { r = 1; g = 1 - (v - 0.625) * 4; b = 0; }
		else { r = 1 - (v - 0.875) * 4; g = 0; b = 0; }
		out.push([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]);
	}
	return out;
}

/** @returns {number[][]} */
function generateHot() {
	const out = [];
	for (let i = 0; i < 256; i++) {
		const v = i / 255.0;
		let r, g, b;
		if (v < 0.33) { r = v / 0.33; g = 0; b = 0; }
		else if (v < 0.66) { r = 1; g = (v - 0.33) / 0.33; b = 0; }
		else { r = 1; g = 1; b = (v - 0.66) / 0.34; }
		out.push([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]);
	}
	return out;
}

/** @returns {number[][]} */
function generateCool() {
	const out = [];
	for (let i = 0; i < 256; i++) {
		const v = i / 255.0;
		out.push([Math.round(v * 255), Math.round((1 - v) * 255), 255]);
	}
	return out;
}

/**
 * Build the 256-entry [r,g,b] table for a colormap.
 * @param {string} name
 * @returns {number[][] | null}
 */
function buildColormap(name) {
	if (CONTROL_POINTS[name]) { return interpolateControlPoints(CONTROL_POINTS[name]); }
	switch (name) {
		case 'gray': return generateGray();
		case 'jet': return generateJet();
		case 'hot': return generateHot();
		case 'cool': return generateCool();
		default: return null;
	}
}

/** @type {Map<string, Uint8Array>} */
const _lutCache = new Map();

/**
 * Get a colormap as a flat Uint8Array of length 256*3 (r,g,b interleaved).
 * Cached per colormap. Returns null for unknown names.
 * @param {string} name
 * @returns {Uint8Array | null}
 */
export function getColormapLut(name) {
	if (!name || name === 'none') { return null; }
	const cached = _lutCache.get(name);
	if (cached) { return cached; }
	const table = buildColormap(name);
	if (!table) { return null; }
	const lut = new Uint8Array(256 * 3);
	for (let i = 0; i < 256; i++) {
		lut[i * 3] = table[i][0];
		lut[i * 3 + 1] = table[i][1];
		lut[i * 3 + 2] = table[i][2];
	}
	_lutCache.set(name, lut);
	return lut;
}

/** @type {Map<string, Uint8Array>} */
const _inverseCubeCache = new Map();
const CUBE_BITS = 5;                 // 32 levels per channel
const CUBE_SIZE = 1 << CUBE_BITS;    // 32
const CUBE_SHIFT = 8 - CUBE_BITS;    // 3

/**
 * Build (and cache) a 32x32x32 RGB->index cube for fast inverse colormap lookup.
 * Each cube cell holds the colormap index (0-255) whose color is nearest to the
 * cell center. This turns decode into an O(N) operation.
 * @param {string} name
 * @returns {Uint8Array | null}
 */
function getInverseCube(name) {
	const lut = getColormapLut(name);
	if (!lut) { return null; }
	const cached = _inverseCubeCache.get(name);
	if (cached) { return cached; }

	const cube = new Uint8Array(CUBE_SIZE * CUBE_SIZE * CUBE_SIZE);
	const step = 255 / (CUBE_SIZE - 1);
	let ci = 0;
	for (let ri = 0; ri < CUBE_SIZE; ri++) {
		const r = ri * step;
		for (let gi = 0; gi < CUBE_SIZE; gi++) {
			const g = gi * step;
			for (let bi = 0; bi < CUBE_SIZE; bi++) {
				const b = bi * step;
				let best = 0, bestDist = Infinity;
				for (let k = 0; k < 256; k++) {
					const dr = r - lut[k * 3];
					const dg = g - lut[k * 3 + 1];
					const db = b - lut[k * 3 + 2];
					const d = dr * dr + dg * dg + db * db;
					if (d < bestDist) { bestDist = d; best = k; }
				}
				cube[ci++] = best;
			}
		}
	}
	_inverseCubeCache.set(name, cube);
	return cube;
}

/**
 * Map an RGB color (0-255) to the nearest colormap index (0-255) via the cube.
 * @param {string} name
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {number} index 0-255, or -1 if colormap unknown
 */
export function rgbToColormapIndex(name, r, g, b) {
	const cube = getInverseCube(name);
	if (!cube) { return -1; }
	const ri = (r >> CUBE_SHIFT);
	const gi = (g >> CUBE_SHIFT);
	const bi = (b >> CUBE_SHIFT);
	return cube[(ri * CUBE_SIZE + gi) * CUBE_SIZE + bi];
}

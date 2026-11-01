/** Colours for genes: one tint per group, or a palette within the group. */

function hexToHsl(hex: string): [number, number, number] {
	const value = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1] ?? 'ffffff';
	const r = parseInt(value.slice(0, 2), 16) / 255, g = parseInt(value.slice(2, 4), 16) / 255, b = parseInt(value.slice(4, 6), 16) / 255;
	const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
	if (max === min) { return [0, 0, l]; }
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return [h * 60, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
	const a = s * Math.min(l, 1 - l);
	const channel = (n: number) => {
		const k = (n + h / 30) % 12;
		return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0');
	};
	return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** Group colours for new groups, spread around the wheel. */
export const GROUP_COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#22b8cf', '#ff922b', '#94d82d'];

/** Colours for genes that belong to no group. */
export const GENE_COLORS = ['#ffffff', '#ffd43b', '#69db7c', '#74c0fc', '#f783ac', '#ffa94d', '#b197fc', '#63e6be'];

/**
 * The colour of gene number `index` (of `total`) in a palette built around
 * `base`: hues walk the wheel by the golden angle from the base hue, with
 * lightness alternating so neighbours differ even when hues are close.
 */
export function paletteColor(base: string, index: number): string {
	const [hue, , lightness] = hexToHsl(base);
	const shade = [0.62, 0.5, 0.72][index % 3];
	return hslToHex((hue + index * 137.508) % 360, 0.85, Math.abs(lightness - shade) < 0.04 ? shade + 0.06 : shade);
}

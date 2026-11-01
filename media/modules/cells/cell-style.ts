/** Fill colours for cells: each row falls in a bucket, and a bucket is one colour. */

import type { CellColumn, ContinuousColumn, DiscreteColumn } from './cell-table.js';

export type CellShow = 'cells' | 'nucleus' | 'both' | 'none';

/** Bucket 0 means hidden; otherwise `colors[bucket - 1]` is the fill. */
export interface BucketPlan {
	bucket: Uint16Array;
	colors: string[];
	/** False when the metric is "none": cells are outlined only. */
	fill: boolean;
}

const BASE_PALETTE = [
	'#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
	'#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#8c564b', '#17becf', '#bcbd22', '#e377c2', '#7f7f7f', '#aec7e8',
];

/** A distinct colour per category: the base palette first, then evenly spaced hues. */
export function categoryColor(index: number): string {
	if (index < BASE_PALETTE.length) { return BASE_PALETTE[index]; }
	const hue = ((index - BASE_PALETTE.length) * 137.508) % 360;
	return hslToHex(hue, 0.6, 0.55);
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
	const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
	const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
	const m = lightness - chroma / 2;
	const [r, g, b] = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
	const hex = (value: number) => Math.round((value + m) * 255).toString(16).padStart(2, '0');
	return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function planNone(count: number): BucketPlan {
	return { bucket: new Uint16Array(count).fill(1), colors: ['#ffffff'], fill: false };
}

export function planDiscrete(column: DiscreteColumn, enabled: boolean[], colors: string[]): BucketPlan {
	const bucket = new Uint16Array(column.codes.length);
	for (let row = 0; row < bucket.length; row++) {
		const code = column.codes[row];
		bucket[row] = code >= 0 && enabled[code] !== false ? code + 1 : 0;
	}
	return { bucket, colors: column.labels.map((_label, index) => colors[index] ?? categoryColor(index)), fill: true };
}

const MISSING_COLOR = '#808080';

export function planContinuous(column: ContinuousColumn, low: number, high: number, lut: Uint8Array | null): BucketPlan {
	const span = high - low > 0 ? high - low : 1;
	const colors: string[] = [];
	for (let step = 0; step < 256; step++) {
		if (lut) { colors.push(`rgb(${lut[step * 3]},${lut[step * 3 + 1]},${lut[step * 3 + 2]})`); }
		else { const grey = step; colors.push(`rgb(${grey},${grey},${grey})`); }
	}
	colors.push(MISSING_COLOR);
	const bucket = new Uint16Array(column.values.length);
	for (let row = 0; row < bucket.length; row++) {
		const value = column.values[row];
		bucket[row] = Number.isFinite(value) ? 1 + Math.round(Math.max(0, Math.min(1, (value - low) / span)) * 255) : 257;
	}
	return { bucket, colors, fill: true };
}

export function isDiscrete(column: CellColumn | null): column is DiscreteColumn { return column?.kind === 'discrete'; }

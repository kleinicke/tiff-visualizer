import type { ImageSettings } from '../../shared/viewer-settings';

export interface BinStats {
	minBin: number;
	maxBin: number;
	meanBin: number;
	total: number;
}

export interface HistogramData {
	r: Uint32Array;
	g: Uint32Array;
	b: Uint32Array;
	luminance: Uint32Array;
	nanCount: number;
	stats: { r: BinStats, g: BinStats, b: BinStats, luminance: BinStats };
}

export interface HistogramOptions {
	rawData?: ArrayLike<number> | null;
	planarData?: ArrayLike<number>[] | null;
	channels?: number;
	settings?: ImageSettings;
	isFloat?: boolean;
	typeMin?: number;
	typeMax?: number;
	stats?: { min: number, max: number } | null;
	lut?: Uint8Array | null;
	sampleStep?: number;
}

export interface OriginalStats {
	r: { min: number, max: number, mean: number, total: number };
	g: { min: number, max: number, mean: number, total: number };
	b: { min: number, max: number, mean: number, total: number };
}

export interface HistogramSnapshot {
  histogramData: HistogramData;
  originalStats?: OriginalStats;
  valueRange?: { min: number; max: number; isFloat: boolean };
}

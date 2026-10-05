import type { MeasurementSource } from './measure/types';
import type { HistogramOptions, HistogramSnapshot } from './histogram-types';
import type { LayerInput } from './layer-manager';

/** The decoded image exposed to consumers, independent of its file container. */
export interface ActiveImage {
  raster: Pick<LayerInput, 'data' | 'width' | 'height' | 'channels' | 'isFloat' | 'typeMax' | 'sourceNumericType'> | null;
  stats?: { min: number; max: number } | null;
  typeMin?: number;
  planar?: ArrayLike<number>[];
  page?: number;
  pageCount?: number;
  histogram?: HistogramSnapshot | null;
  sampleHistogram?: () => ImageData | null;
  readPixel: (x: number, y: number, width: number, height: number) => string;
  pixelDisplay: 'float' | 'byte' | 'tiff' | 'native';
}

export function imageRaster(
  raw: { data: ArrayLike<number>; width: number; height: number; channels: number } | null | undefined,
  domain: Pick<LayerInput, 'isFloat' | 'typeMax' | 'sourceNumericType'>,
): ActiveImage['raster'] {
  if (!raw?.data) return null;
  const sourceNumericType = domain.sourceNumericType ?? (
    raw.data instanceof Uint16Array ? 'uint16' :
    raw.data instanceof Uint8Array || raw.data instanceof Uint8ClampedArray ? 'uint8' :
    raw.data instanceof Float64Array ? 'float64' : 'float32'
  );
  return { data: raw.data, width: raw.width, height: raw.height, channels: raw.channels, ...domain, sourceNumericType };
}

export function imageLayer(image: ActiveImage | null | undefined, name: string, uri: string): LayerInput | null {
  return image?.raster ? { ...image.raster, name, uri } : null;
}

/** Holds immutable decoded buffers and a processor-owned restore operation. */
export interface DecodedSnapshot {
  width: number;
  height: number;
  restore(): void;
}

/** Adapt source samples without allocating a second pixel buffer. */
export function imageMeasurement(image: ActiveImage | null | undefined, fileName?: string): MeasurementSource | null {
  const raster = image?.raster;
  if (!raster?.width || !raster.height) return null;
  return { ...raster, data: raster.data, typeMin: image.typeMin,
    fileName, page: image.page, pageCount: image.pageCount };
}

export function imageHistogram(image: ActiveImage | null | undefined): HistogramOptions {
  const raster = image?.raster;
  if (!raster) return {};
  return { rawData: image.planar ? undefined : raster.data, planarData: image.planar,
    channels: raster.channels, isFloat: raster.isFloat, typeMax: raster.typeMax,
    typeMin: image.typeMin, stats: image.stats };
}

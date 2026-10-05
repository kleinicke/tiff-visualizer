// Display policy shared by every host. No DOM or IDE dependencies.
export interface NormalizationSettings {
	min: number;
	max: number;
	autoNormalize: boolean;
	gammaMode: boolean;
}

export interface GammaSettings {
	in: number;
	out: number;
}

export interface BrightnessSettings {
	offset: number;
}

export interface DisplaySettings {
	normalization: NormalizationSettings;
	gamma: GammaSettings;
	brightness: BrightnessSettings;
	rgbAs24BitGrayscale: boolean;
	scale24BitFactor: number; // Divide 24-bit values by this for display (default 1000)
	normalizedFloatMode: boolean; // Convert uint images to normalized float (0-1 range)
}

// Image format types for per-format settings
export type ImageFormatType = 'png' | 'jpg' | 'ppm' | 'tiff-float' | 'tiff-int' | 'tiff-int-signed' | 'tiff-int-wide' | 'tiff-uint16' | 'exr-float' | 'pfm' | 'hdr' | 'npy-float' | 'npy-uint' | 'sgi' | 'tga' | 'webp' | 'avif' | 'bmp' | 'ico' | 'jxl' | 'jxl-float' | 'jxr' | 'jp2' | 'fits' | 'dicom' | 'netcdf' | 'czi' | 'nd2' | 'lif' | 'sdt' | 'ora' | 'kra' | 'psd' | 'psb' | 'xcf' | 'affinity';

/** Authored images retain their display range; scientific arrays use their data range. */
const GAMMA_FORMATS: ReadonlySet<string> = new Set([
  'tiff-int', 'ppm', 'png', 'jpg', 'sgi', 'tga', 'webp', 'avif', 'bmp', 'ico', 'jxl',
  'ora', 'kra', 'psd', 'psb', 'xcf', 'affinity', 'tiff-float', 'pfm', 'hdr',
]);

export function defaultDisplaySettings(format?: string): DisplaySettings {
  const gammaMode = format !== undefined && GAMMA_FORMATS.has(format);
  return {
    normalization: { min: 0, max: 1, autoNormalize: format !== undefined && !gammaMode, gammaMode },
    gamma: { in: 2.2, out: 2.2 },
    brightness: { offset: 0 },
    rgbAs24BitGrayscale: false,
    scale24BitFactor: 1000,
    normalizedFloatMode: false,
  };
}

export function copyDisplaySettings(settings: DisplaySettings): DisplaySettings {
  return { ...settings, normalization: { ...settings.normalization }, gamma: { ...settings.gamma }, brightness: { ...settings.brightness } };
}

/** Changing modes preserves the manual range, including when disabling a mode. */
export function setDisplayMode(settings: DisplaySettings, mode: 'manual' | 'auto' | 'gamma'): void {
  settings.normalization.autoNormalize = mode === 'auto';
  settings.normalization.gammaMode = mode === 'gamma';
}

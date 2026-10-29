import type { Calibration } from '../measure/types.js';

export type CellsAutoOpen = 'auto' | 'always' | 'never';

export interface CellsHints {
	channels: number;
	/** The file carries OME-XML, as microscopy exports do. */
	omeMetadata: boolean;
	/** Pixel size in microns, or null when the image has no micron scale. */
	micronsPerPixel: number | null;
}

export function parseCellsAutoOpen(value: unknown): CellsAutoOpen {
	return value === 'always' || value === 'never' ? value : 'auto';
}

/** Microns per pixel from a calibration, or null when its unit is not a length we can convert. */
export function micronsPerPixel(calibration: Calibration): number | null {
	const factor = ({ 'µm': 1, 'μm': 1, um: 1, micron: 1, microns: 1, nm: 0.001, mm: 1000 } as Record<string, number>)[calibration.unit.trim().toLowerCase()];
	const size = calibration.pixelWidth * (factor ?? NaN);
	return Number.isFinite(size) && size > 0 ? size : null;
}

/**
 * Whether the Cells panel should open by itself. `auto` is deliberately narrow:
 * several channels, OME metadata and a micron scale together are what a
 * fluorescence microscopy image looks like, and photos, HDR and scientific
 * rasters never match.
 */
export function shouldAutoOpenCells(mode: CellsAutoOpen, hints: CellsHints): boolean {
	if (mode === 'never') { return false; }
	if (mode === 'always') { return true; }
	return hints.channels >= 2 && hints.omeMetadata && hints.micronsPerPixel !== null;
}

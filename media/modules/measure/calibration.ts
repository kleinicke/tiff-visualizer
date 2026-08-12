"use strict";

import { UNCALIBRATED, type Calibration } from './types.js';

/**
 * Spatial calibration.
 *
 * ImageJ generally asks the user to set the scale by hand. We should not have
 * to: TIFF has carried resolution tags since 1986 and OME-TIFF states physical
 * pixel size explicitly, so in most cases the answer is already in the file.
 * Auto-populating it — and saying where the number came from — removes the most
 * common source of silently wrong measurements, which is a forgotten or
 * mistyped scale.
 *
 * No unit conversion is attempted between different source units. Source
 * metadata disagrees about spelling ("um", "µm", "micron", "MICROMETER") often
 * enough that normalising by guesswork would eventually corrupt a number
 * without anyone noticing.
 */

/** TIFF ResolutionUnit values. */
const RESOLUTION_UNIT_NONE = 1;
const RESOLUTION_UNIT_INCH = 2;
const RESOLUTION_UNIT_CENTIMETER = 3;

/** Coerce a TIFF rational, array, or scalar tag into a number. */
function tagNumber(value: unknown): number | undefined {
	if (typeof value === 'number') { return Number.isFinite(value) ? value : undefined; }
	if (Array.isArray(value)) {
		if (value.length === 1) { return tagNumber(value[0]); }
		// Rationals arrive as [numerator, denominator] from some decoders.
		if (value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
			return value[1] !== 0 ? value[0] / value[1] : undefined;
		}
		return tagNumber(value[0]);
	}
	return undefined;
}

/**
 * Derive calibration from baseline TIFF resolution tags.
 *
 * XResolution/YResolution are *pixels per unit*, so pixel size is their
 * reciprocal. ResolutionUnit 1 ("no absolute unit") is explicitly meaningless
 * as a physical scale and is rejected rather than being reported as inches.
 */
export function calibrationFromTiffTags(ifd: Record<string, unknown> | null | undefined): Calibration | null {
	if (!ifd) { return null; }
	const xResolution = tagNumber(ifd.t282);
	const yResolution = tagNumber(ifd.t283);
	const unitTag = tagNumber(ifd.t296) ?? RESOLUTION_UNIT_INCH;

	if (!xResolution || !yResolution || xResolution <= 0 || yResolution <= 0) { return null; }
	if (unitTag === RESOLUTION_UNIT_NONE) { return null; }

	const unit = unitTag === RESOLUTION_UNIT_CENTIMETER ? 'cm'
		: unitTag === RESOLUTION_UNIT_INCH ? 'inch'
			: null;
	if (!unit) { return null; }

	// A 1×1 resolution is the default a writer emits when it has nothing to say;
	// treating it as "one pixel is one inch" would be actively misleading.
	if (xResolution === 1 && yResolution === 1) { return null; }

	return {
		pixelWidth: 1 / xResolution,
		pixelHeight: 1 / yResolution,
		unit,
		origin: 'tiff-resolution',
	};
}

/**
 * Derive calibration from the flat tag list the metadata panel already builds.
 *
 * The WASM decoder and the geotiff.js fallback expose resolution tags under
 * different shapes but the same names, and both stringify their values, so
 * matching on the name and re-parsing is the one approach that works on both
 * paths without duplicating either decoder's tag walk.
 */
export function calibrationFromTagList(
	tags: { name?: string; value?: unknown }[] | null | undefined,
): Calibration | null {
	if (!Array.isArray(tags)) { return null; }
	const find = (pattern: RegExp): number | undefined => {
		for (const tag of tags) {
			if (!tag?.name || !pattern.test(String(tag.name))) { continue; }
			const text = String(tag.value ?? '').trim();
			// Rationals stringify as "300, 1" via the shared tag formatter.
			const parts = text.split(',').map(part => parseFloat(part.trim()));
			if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1]) && parts[1] !== 0) {
				return parts[0] / parts[1];
			}
			if (Number.isFinite(parts[0])) { return parts[0]; }
		}
		return undefined;
	};

	return calibrationFromTiffTags({
		t282: find(/^xresolution$/i),
		t283: find(/^yresolution$/i),
		t296: find(/^resolutionunit$/i),
	});
}

/** Derive calibration from parsed OME-TIFF metadata. */
export function calibrationFromOme(ome: {
	physicalSizeX?: number;
	physicalSizeY?: number;
	physicalSizeZ?: number;
	physicalSizeXUnit?: string;
	physicalSizeYUnit?: string;
} | null | undefined): Calibration | null {
	if (!ome) { return null; }
	const x = ome.physicalSizeX;
	const y = ome.physicalSizeY;
	if (!x || !y || !Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) { return null; }

	const xUnit = ome.physicalSizeXUnit || 'µm';
	const yUnit = ome.physicalSizeYUnit || xUnit;
	// Anisotropic pixels are supported, but only when both axes agree on the
	// unit; mixed units would make area meaningless.
	if (yUnit !== xUnit) { return null; }

	return {
		pixelWidth: x,
		pixelHeight: y,
		pixelDepth: ome.physicalSizeZ,
		unit: xUnit,
		origin: 'ome',
	};
}

/**
 * Derive calibration from DICOM spacing tags.
 *
 * Pixel Spacing (0028,0030) is `row spacing\column spacing`: the first value is
 * the distance between the centres of adjacent *rows*, i.e. the vertical pixel
 * size, and the second the horizontal one. Getting that pair the wrong way round
 * is invisible on the square pixels of most CT/MR and wrong on everything else,
 * so the mapping is spelled out here rather than assumed.
 *
 * All DICOM spacing tags are millimetres by definition, which is why this is the
 * one source where a fixed unit string is safe.
 */
export function calibrationFromDicom(metadata: {
	pixelSpacing?: unknown;
	imagerPixelSpacing?: unknown;
	sliceThickness?: unknown;
	spacingBetweenSlices?: unknown;
} | null | undefined): Calibration | null {
	if (!metadata) { return null; }

	// DICOM decimal strings are backslash-separated; the panel and worker paths
	// both hand them over as raw text.
	const values = (raw: unknown): number[] => String(raw ?? '')
		.split('\\')
		.map(part => parseFloat(part.trim()))
		.filter(value => Number.isFinite(value) && value > 0);
	const single = (raw: unknown): number | undefined => values(raw)[0];

	// Patient-plane spacing first; the detector-plane fallback is only right for
	// projection images, and then only approximately.
	const patient = values(metadata.pixelSpacing);
	const detector = values(metadata.imagerPixelSpacing);
	const spacing = patient.length >= 2 ? patient : detector;
	if (spacing.length < 2) { return null; }

	// Spacing Between Slices is the reconstructed centre-to-centre distance and
	// is what a depth measurement needs; Slice Thickness only matches it when the
	// slices neither overlap nor leave gaps.
	const depth = single(metadata.spacingBetweenSlices) ?? single(metadata.sliceThickness);

	return {
		pixelWidth: spacing[1],
		pixelHeight: spacing[0],
		pixelDepth: depth,
		unit: 'mm',
		origin: spacing === patient ? 'dicom' : 'dicom-detector',
	};
}

/**
 * Derive calibration from CZI scaling metadata.
 *
 * CZI stores scaling in metres per pixel; the parser has already converted to
 * micrometres, which is the unit microscopy works in and avoids reporting a
 * sub-nanometre float for every measurement. ScalingZ becomes the depth so a
 * z-stack measures through-plane distances correctly.
 */
export function calibrationFromCzi(metadata: {
	scalingXUm?: unknown;
	scalingYUm?: unknown;
	scalingZUm?: unknown;
} | null | undefined): Calibration | null {
	if (!metadata) { return null; }
	const positive = (raw: unknown): number | undefined => {
		const value = typeof raw === 'number' ? raw : Number(raw);
		return Number.isFinite(value) && value > 0 ? value : undefined;
	};
	const width = positive(metadata.scalingXUm);
	// A CZI that declares only one lateral scaling is square by definition.
	const height = positive(metadata.scalingYUm) ?? width;
	if (!width || !height) { return null; }
	return {
		pixelWidth: width,
		pixelHeight: height,
		pixelDepth: positive(metadata.scalingZUm),
		unit: 'µm',
		origin: 'czi',
	};
}

/**
 * Pick the best available automatic calibration.
 *
 * OME wins over baseline tags: when a file carries both, the OME block is the
 * one the acquisition software wrote deliberately, while the resolution tags
 * are often a print-DPI default left over from an export step.
 */
export function autoCalibration(
	ome: Parameters<typeof calibrationFromOme>[0],
	ifd: Parameters<typeof calibrationFromTiffTags>[0],
): Calibration {
	return calibrationFromOme(ome) || calibrationFromTiffTags(ifd) || { ...UNCALIBRATED };
}

/**
 * Calibration from a drawn line of known physical length — the "set scale"
 * workflow, used when the file carries no metadata but the image contains a
 * scale bar.
 *
 * Pixels are assumed square here, because a single line cannot separate the two
 * axes. A user with anisotropic pixels has to enter them directly.
 */
export function calibrationFromKnownDistance(
	pixelDistance: number,
	knownLength: number,
	unit: string,
): Calibration | null {
	if (!(pixelDistance > 0) || !(knownLength > 0)) { return null; }
	const size = knownLength / pixelDistance;
	return {
		pixelWidth: size,
		pixelHeight: size,
		unit: unit || 'px',
		origin: 'manual',
	};
}

/** Human-readable one-line description, for the panel and for exports. */
export function describeCalibration(calibration: Calibration): string {
	if (calibration.origin === 'none') { return 'Uncalibrated — measurements are in pixels.'; }
	const square = Math.abs(calibration.pixelWidth - calibration.pixelHeight) < 1e-9;
	const size = square
		? `${formatNumber(calibration.pixelWidth)} ${calibration.unit}/px`
		: `${formatNumber(calibration.pixelWidth)} × ${formatNumber(calibration.pixelHeight)} ${calibration.unit}/px`;
	const sourceLabel = calibration.origin === 'ome' ? 'from OME metadata'
		: calibration.origin === 'tiff-resolution' ? 'from TIFF resolution tags'
			: calibration.origin === 'dicom' ? 'from DICOM Pixel Spacing'
				: calibration.origin === 'dicom-detector' ? 'from DICOM Imager Pixel Spacing (detector plane)'
					: calibration.origin === 'czi' ? 'from CZI scaling metadata'
						: calibration.origin === 'imported' ? 'from the ROI file'
						: 'set manually';
	return `${size} (${sourceLabel})`;
}

/** Unit for an area measurement, e.g. "µm²". */
export function areaUnit(calibration: Calibration): string {
	if (calibration.origin === 'none') { return 'px²'; }
	return `${calibration.unit}²`;
}

export function formatNumber(value: number, digits = 4): string {
	if (!Number.isFinite(value)) { return Number.isNaN(value) ? 'NaN' : (value > 0 ? '∞' : '−∞'); }
	if (value === 0) { return '0'; }
	const magnitude = Math.abs(value);
	if (magnitude < 1e-4 || magnitude >= 1e7) { return value.toExponential(Math.max(1, digits - 1)); }
	// Show enough digits to distinguish neighbouring pixels at any scale, but
	// never so many that the table becomes unreadable.
	const decimals = Math.max(0, digits - Math.max(1, Math.floor(Math.log10(magnitude)) + 1));
	return value.toFixed(decimals).replace(/\.?0+$/, '') || '0';
}

/**
 * Pick a scale-bar length that is a round number in the calibrated unit and
 * covers roughly the requested fraction of the visible width.
 */
export function chooseScaleBarLength(
	visibleWidthPixels: number,
	calibration: Calibration,
	targetFraction = 0.2,
): { lengthPixels: number; label: string } | null {
	if (calibration.origin === 'none' || !(visibleWidthPixels > 0)) { return null; }
	const targetPhysical = visibleWidthPixels * calibration.pixelWidth * targetFraction;
	if (!(targetPhysical > 0)) { return null; }

	const exponent = Math.floor(Math.log10(targetPhysical));
	const base = Math.pow(10, exponent);
	// 1, 2, 5, 10 — the standard set, so the bar always reads as a round number.
	const candidates = [base, base * 2, base * 5, base * 10];
	let best = candidates[0];
	for (const candidate of candidates) {
		if (Math.abs(candidate - targetPhysical) < Math.abs(best - targetPhysical)) { best = candidate; }
	}

	return {
		lengthPixels: best / calibration.pixelWidth,
		label: `${formatNumber(best)} ${calibration.unit}`,
	};
}

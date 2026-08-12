"use strict";

/**
 * Shared types for the measurement subsystem.
 *
 * Design rules that the rest of the subsystem depends on:
 *
 * - ROI geometry is stored in **image pixel coordinates**, never in screen or
 *   canvas coordinates. Zoom, pan, and window size therefore never invalidate a
 *   stored ROI, and the JSON sidecar stays meaningful across sessions.
 * - Pixel coordinate (x, y) refers to the *centre* of pixel column x, row y.
 *   Rasterisation, hit testing, and the ImageJ interop layer all use this
 *   convention, which is also what ImageJ itself uses.
 * - Calibration is applied only at the point where a number is reported. All
 *   geometry and all statistics are computed in pixels/raw values first, so a
 *   later calibration change never requires re-measuring.
 */

/** Area ROIs enclose a region; line ROIs do not; point ROIs are markers. */
export type RoiKind =
	| 'rect'
	| 'ellipse'
	| 'polygon'
	| 'freehand'
	| 'mask'
	| 'line'
	| 'polyline'
	| 'point';

export const AREA_KINDS: readonly RoiKind[] = ['rect', 'ellipse', 'polygon', 'freehand', 'mask'];
export const LINE_KINDS: readonly RoiKind[] = ['line', 'polyline'];

export function isAreaKind(kind: RoiKind): boolean {
	return AREA_KINDS.indexOf(kind) >= 0;
}

export function isLineKind(kind: RoiKind): boolean {
	return LINE_KINDS.indexOf(kind) >= 0;
}

/** Where an ROI came from. Carried into exports as provenance. */
export type RoiSource = 'manual' | 'wand' | 'threshold' | 'imagej' | 'imported';

export interface RoiCommon {
	id: string;
	name: string;
	/** Optional user grouping, exported as its own column. */
	group?: string;
	/** CSS colour for the overlay; falls back to the palette when absent. */
	color?: string;
	source?: RoiSource;
	/** Page/slice index this ROI belongs to, for multi-page images. */
	page?: number;
	/** Channel this ROI was drawn on, when the user restricted it to one. */
	channel?: number;
}

export interface RectRoi extends RoiCommon {
	kind: 'rect';
	x: number;
	y: number;
	width: number;
	height: number;
	/** Rotation in radians about the rectangle centre. */
	angle?: number;
}

export interface EllipseRoi extends RoiCommon {
	kind: 'ellipse';
	/** Bounding box of the unrotated ellipse. */
	x: number;
	y: number;
	width: number;
	height: number;
	angle?: number;
}

export interface PolygonRoi extends RoiCommon {
	kind: 'polygon' | 'freehand';
	/** Flat [x0, y0, x1, y1, ...] in image pixels. Implicitly closed. */
	points: number[];
}

export interface LineRoi extends RoiCommon {
	kind: 'line' | 'polyline';
	/** Flat [x0, y0, x1, y1, ...]. Open. */
	points: number[];
	/**
	 * Width in pixels of the band averaged perpendicular to the line when
	 * sampling a profile. 1 means a single-pixel trace.
	 */
	lineWidth?: number;
}

export interface PointRoi extends RoiCommon {
	kind: 'point';
	/** Flat [x0, y0, ...]. A counter ROI holds many points. */
	points: number[];
	/** Optional per-point category index, parallel to points/2. */
	categories?: number[];
}

/**
 * A raster ROI produced by segmentation. Stored as a bounding box plus a
 * one-byte-per-pixel mask, because arbitrary segmentation output has no compact
 * polygon form and round-tripping it through a contour would lose holes.
 */
export interface MaskRoi extends RoiCommon {
	kind: 'mask';
	x: number;
	y: number;
	width: number;
	height: number;
	/** length === width * height; non-zero means inside. */
	mask: Uint8Array;
}

export type Roi = RectRoi | EllipseRoi | PolygonRoi | LineRoi | PointRoi | MaskRoi;

/** A rasterised ROI: bounding box plus inclusion mask, in image pixels. */
export interface RoiMask {
	x: number;
	y: number;
	width: number;
	height: number;
	mask: Uint8Array;
	/** Number of non-zero entries; cached because every measurement needs it. */
	count: number;
}

/**
 * Physical pixel size. `unit` is a display string ("µm", "mm", "px"); no unit
 * conversion is attempted, because the source metadata rarely agrees on
 * spelling and guessing would silently corrupt numbers.
 */
export interface Calibration {
	/** Width of one pixel in `unit`. 1 with unit "px" means uncalibrated. */
	pixelWidth: number;
	pixelHeight: number;
	/** Spacing between pages/slices, for multi-page stacks. */
	pixelDepth?: number;
	unit: string;
	/** Where these numbers came from, shown in the panel and exported. */
	origin: 'none' | 'tiff-resolution' | 'ome' | 'dicom' | 'dicom-detector' | 'czi' | 'manual' | 'imported';
}

export const UNCALIBRATED: Calibration = {
	pixelWidth: 1,
	pixelHeight: 1,
	unit: 'px',
	origin: 'none',
};

export function isCalibrated(calibration: Calibration): boolean {
	return calibration.origin !== 'none' && calibration.unit !== 'px';
}

/**
 * The image a measurement runs against.
 *
 * Either `data` (interleaved, channels per pixel) or `planar` (one array per
 * channel) is present — TIFF hands out planar rasters and copying them into an
 * interleaved buffer purely to measure would double peak memory on large
 * images.
 *
 * Values are always **raw**: pre-normalisation, pre-gamma, pre-colormap. This
 * is the single most important property of the whole subsystem.
 */
export interface MeasurementSource {
	width: number;
	height: number;
	channels: number;
	data?: Float32Array | Uint8Array | Uint16Array | Int16Array | Int32Array | Float64Array;
	planar?: ArrayLike<number>[];
	isFloat: boolean;
	/** Nominal maximum of the sample type (255, 65535, 1.0, …). */
	typeMax: number;
	typeMin?: number;
	/** Identifies the image for provenance columns. */
	fileName?: string;
	page?: number;
	pageCount?: number;
}

/** Read one channel of one pixel from either storage layout. */
export function sampleAt(source: MeasurementSource, x: number, y: number, channel: number): number {
	const index = y * source.width + x;
	if (source.planar) {
		const plane = source.planar[Math.min(channel, source.planar.length - 1)];
		return plane ? Number(plane[index]) : NaN;
	}
	const data = source.data;
	if (!data) { return NaN; }
	const channels = source.channels || 1;
	return Number(data[index * channels + Math.min(channel, channels - 1)]);
}

/**
 * Luminance-ish scalar used wherever a single value per pixel is needed
 * (thresholding, region growing, wand). Single-channel images pass through
 * untouched; RGB uses Rec. 709 luma; anything else averages the first three
 * channels. Alpha is never mixed in.
 */
export function scalarAt(source: MeasurementSource, x: number, y: number): number {
	const channels = source.channels || 1;
	if (channels === 1) { return sampleAt(source, x, y, 0); }
	const r = sampleAt(source, x, y, 0);
	const g = sampleAt(source, x, y, 1);
	const b = channels >= 3 ? sampleAt(source, x, y, 2) : g;
	if (channels === 2) { return (r + g) / 2; }
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Materialise the scalar view of an image once, for algorithms that sweep it. */
export function toScalarPlane(source: MeasurementSource): Float32Array {
	const { width, height } = source;
	const out = new Float32Array(width * height);
	const channels = source.channels || 1;
	if (channels === 1) {
		if (source.planar) {
			const plane = source.planar[0];
			for (let i = 0; i < out.length; i++) { out[i] = Number(plane[i]); }
		} else if (source.data) {
			const data = source.data;
			for (let i = 0; i < out.length; i++) { out[i] = Number(data[i]); }
		}
		return out;
	}
	let i = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			out[i++] = scalarAt(source, x, y);
		}
	}
	return out;
}

/** One measured row. Values are calibrated; `*Px` variants stay in pixels. */
export interface MeasurementRow {
	roiId: string;
	roiName: string;
	roiKind: RoiKind;
	group?: string;
	channel: number;
	page?: number;
	fileName?: string;

	// Geometry (calibrated)
	area?: number;
	perimeter?: number;
	length?: number;
	width?: number;
	height?: number;
	bx?: number;
	by?: number;
	major?: number;
	minor?: number;
	angle?: number;
	feret?: number;
	minFeret?: number;
	feretAngle?: number;
	feretX?: number;
	feretY?: number;
	circularity?: number;
	aspectRatio?: number;
	roundness?: number;
	solidity?: number;

	// Position (calibrated)
	centroidX?: number;
	centroidY?: number;
	centerOfMassX?: number;
	centerOfMassY?: number;

	// Intensity (raw units — never calibrated)
	pixelCount?: number;
	mean?: number;
	stdDev?: number;
	min?: number;
	max?: number;
	median?: number;
	mode?: number;
	skewness?: number;
	kurtosis?: number;
	integratedDensity?: number;
	rawIntegratedDensity?: number;
	/** Pixels excluded from intensity statistics because they were not finite. */
	nonFiniteCount?: number;

	[extra: string]: unknown;
}

/** Column identifiers the user can switch on and off. */
export type MeasurementColumn =
	| 'area'
	| 'perimeter'
	| 'length'
	| 'bounds'
	| 'fitEllipse'
	| 'feret'
	| 'shape'
	| 'centroid'
	| 'centerOfMass'
	| 'intensity'
	| 'minMax'
	| 'median'
	| 'mode'
	| 'moments'
	| 'integratedDensity';

export const DEFAULT_COLUMNS: MeasurementColumn[] = [
	'area',
	'perimeter',
	'length',
	'intensity',
	'minMax',
	'shape',
	'feret',
];

/**
 * What each selectable group puts in the table.
 *
 * The grouping mirrors ImageJ's "Set Measurements" because that is the mental
 * model people arrive with — "area and mean gray value" is one decision there,
 * not five. Exports are unaffected and always contain every populated column:
 * a results file that silently omits a measurement because of a display setting
 * is a trap, and disk is cheap.
 */
export const COLUMN_GROUPS: {
	id: MeasurementColumn;
	label: string;
	keys: (keyof MeasurementRow)[];
}[] = [
	{ id: 'area', label: 'Area', keys: ['area'] },
	{ id: 'perimeter', label: 'Perimeter', keys: ['perimeter'] },
	{ id: 'length', label: 'Length (lines)', keys: ['length'] },
	{ id: 'intensity', label: 'Mean and StdDev', keys: ['mean', 'stdDev'] },
	{ id: 'minMax', label: 'Min and max', keys: ['min', 'max'] },
	{ id: 'median', label: 'Median', keys: ['median'] },
	{ id: 'mode', label: 'Mode', keys: ['mode'] },
	{ id: 'moments', label: 'Skewness and kurtosis', keys: ['skewness', 'kurtosis'] },
	{ id: 'integratedDensity', label: 'Integrated density', keys: ['integratedDensity', 'rawIntegratedDensity'] },
	{ id: 'centroid', label: 'Centroid', keys: ['centroidX', 'centroidY'] },
	{ id: 'centerOfMass', label: 'Centre of mass', keys: ['centerOfMassX', 'centerOfMassY'] },
	{ id: 'bounds', label: 'Bounding box', keys: ['bx', 'by', 'width', 'height'] },
	{ id: 'fitEllipse', label: 'Fitted ellipse', keys: ['major', 'minor', 'angle'] },
	{ id: 'feret', label: 'Feret diameter', keys: ['feret', 'minFeret', 'feretAngle'] },
	{ id: 'shape', label: 'Shape descriptors', keys: ['circularity', 'aspectRatio', 'roundness', 'solidity'] },
];

/** Short header labels, so the table stays narrow. */
export const COLUMN_LABELS: Partial<Record<keyof MeasurementRow, string>> = {
	area: 'Area', perimeter: 'Perim.', length: 'Length',
	mean: 'Mean', stdDev: 'StdDev', min: 'Min', max: 'Max',
	median: 'Median', mode: 'Mode', skewness: 'Skew', kurtosis: 'Kurt',
	integratedDensity: 'IntDen', rawIntegratedDensity: 'RawIntDen',
	centroidX: 'X', centroidY: 'Y', centerOfMassX: 'XM', centerOfMassY: 'YM',
	bx: 'BX', by: 'BY', width: 'W', height: 'H',
	major: 'Major', minor: 'Minor', angle: 'Angle',
	feret: 'Feret', minFeret: 'MinFeret', feretAngle: 'FeretAng',
	circularity: 'Circ.', aspectRatio: 'AR', roundness: 'Round', solidity: 'Solidity',
};

/** Columns carrying a calibrated length, for unit-suffixed headers. */
export const LENGTH_COLUMNS: (keyof MeasurementRow)[] = [
	'perimeter', 'length', 'major', 'minor', 'feret', 'minFeret',
	'centroidX', 'centroidY', 'centerOfMassX', 'centerOfMassY',
	'bx', 'by', 'width', 'height',
];

/** Provenance recorded alongside every export, so a row is self-explanatory. */
export interface MeasurementProvenance {
	fileName?: string;
	unit: string;
	pixelWidth: number;
	pixelHeight: number;
	calibrationOrigin: Calibration['origin'];
	thresholdMethod?: string;
	thresholdLow?: number;
	thresholdHigh?: number;
	preprocessing?: string;
	extensionVersion?: string;
	settingsHash?: string;
}

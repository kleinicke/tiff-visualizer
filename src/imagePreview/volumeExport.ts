import * as vscode from 'vscode';
import { Utils } from 'vscode-uri';
import { parseDicomImageHeader, type DicomImageHeader } from './dicomDataset';
import { parseDicom } from '../../media/modules/scientific-format-parsers';
import type { DatasetSeries } from './datasetTypes';

/**
 * Hands a decoded DICOM series to the 3D viewer as NRRD.
 *
 * This extension decodes stacks but renders them one slice at a time; the
 * neighbouring `ply-visualizer` has Three.js, camera controls and transforms
 * but no notion of an intensity stack. Rather than either extension growing
 * the other's half, the volume travels between them.
 *
 * NRRD carries the payload because it is a documented standard (3D Slicer,
 * ITK) that already expresses everything the handover needs — a full affine,
 * world units, dtype, endianness — so there is no private descriptor for two
 * repositories to keep in sync, and the file is independently useful.
 */

/** What the 3D side needs that the 2D viewer never had to care about. */
export interface VolumeGeometry {
	/** Column direction (i axis) in LPS, scaled to metres. */
	iVector: [number, number, number];
	/** Row direction (j axis) in LPS, scaled to metres. */
	jVector: [number, number, number];
	/** Slice-to-slice step in LPS metres, derived from consecutive slice positions. */
	kVector: [number, number, number];
	/** ImagePositionPatient of the first slice, converted to metres. */
	origin: [number, number, number];
	/** How the k vector was determined, for reporting to the user. */
	kSource: 'positions' | 'sliceThickness' | 'assumed';
}

function cross(a: number[], b: number[]): [number, number, number] {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function scale(v: number[], factor: number): [number, number, number] {
	return [v[0] * factor, v[1] * factor, v[2] * factor];
}

/**
 * Derives the voxel-to-world mapping from the slice headers.
 *
 * The subtle part is the k vector. `SliceThickness` is the obvious tag and the
 * wrong one: it describes how thick a slice is, not how far apart consecutive
 * slices sit, so it silently ignores both gaps and overlap. Differencing
 * consecutive `ImagePositionPatient` values measures the actual step, and is
 * what every serious converter uses. Thickness is kept only as a fallback for
 * single-slice or position-less series.
 */
export function deriveGeometry(first: DicomImageHeader, last: DicomImageHeader, sliceCount: number): VolumeGeometry {
	const metresPerMillimetre = 0.001;
	const orientation = first.orientation && first.orientation.length >= 6
		? first.orientation
		: [1, 0, 0, 0, 1, 0];
	const rowDirection = orientation.slice(0, 3);
	const columnDirection = orientation.slice(3, 6);

	// PixelSpacing is [between rows, between columns]. "Between rows" is a step
	// along the column direction, so the two are cross-assigned; swapping them
	// is the classic way to get a subtly stretched volume out of anisotropic
	// pixels.
	const spacing = first.pixelSpacing && first.pixelSpacing.length >= 2 ? first.pixelSpacing : [1, 1];
	const iVector = scale(rowDirection, spacing[1] * metresPerMillimetre);
	const jVector = scale(columnDirection, spacing[0] * metresPerMillimetre);

	const origin = (first.position && first.position.length >= 3 ? first.position : [0, 0, 0]) as number[];

	let kVector: [number, number, number];
	let kSource: VolumeGeometry['kSource'];
	if (sliceCount > 1 && first.position?.length === 3 && last.position?.length === 3) {
		const span = [
			last.position[0] - first.position[0],
			last.position[1] - first.position[1],
			last.position[2] - first.position[2],
		];
		const length = Math.hypot(span[0], span[1], span[2]);
		if (length > 1e-6) {
			kVector = scale(span, metresPerMillimetre / (sliceCount - 1));
			kSource = 'positions';
		} else {
			kVector = scale(cross(rowDirection, columnDirection), (first.sliceThickness || 1) * metresPerMillimetre);
			kSource = first.sliceThickness ? 'sliceThickness' : 'assumed';
		}
	} else {
		kVector = scale(cross(rowDirection, columnDirection), (first.sliceThickness || 1) * metresPerMillimetre);
		kSource = first.sliceThickness ? 'sliceThickness' : 'assumed';
	}

	return {
		iVector,
		jVector,
		kVector,
		origin: [origin[0] * metresPerMillimetre, origin[1] * metresPerMillimetre, origin[2] * metresPerMillimetre],
		kSource,
	};
}

export interface VolumeExportResult {
	bytes: Uint8Array;
	sizes: [number, number, number];
	geometry: VolumeGeometry;
	modality?: string;
	intensityUnits?: string;
}

function formatVector(v: readonly number[]): string {
	return `(${v.map(value => Number(value.toPrecision(12))).join(',')})`;
}

/**
 * Gzip through the platform's CompressionStream.
 *
 * Deliberately not `node:zlib`: this extension also builds for the browser host
 * (`out/extension.web.js`, `platform: 'browser'`), where a Node builtin fails
 * to resolve at bundle time. CompressionStream exists in both, and mirrors the
 * DecompressionStream the reader on the other side of the bridge uses.
 */
async function gzip(payload: Uint8Array): Promise<Uint8Array> {
	const compressionStream = (globalThis as { CompressionStream?: unknown }).CompressionStream;
	if (typeof compressionStream !== 'function') {
		throw new Error('Writing a compressed volume needs CompressionStream, which this runtime lacks');
	}
	const stream = new Blob([payload as unknown as BlobPart])
		.stream()
		.pipeThrough(new (compressionStream as new (format: string) => ReadableWritablePair)('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Serialises a float32 volume as gzip-encoded NRRD. */
export async function writeNrrd(
	samples: Float32Array,
	sizes: [number, number, number],
	geometry: VolumeGeometry,
	extras: Record<string, string> = {},
): Promise<Uint8Array> {
	const lines = [
		'NRRD0004',
		'# Written by tiff-visualizer for the 3D viewer bridge',
		'type: float',
		'dimension: 3',
		`sizes: ${sizes.join(' ')}`,
		// DICOM is LPS. Declaring it rather than pre-converting keeps this file
		// correct for any NRRD reader, not just the one across the bridge.
		'space: left-posterior-superior',
		`space directions: ${formatVector(geometry.iVector)} ${formatVector(geometry.jVector)} ${formatVector(geometry.kVector)}`,
		`space origin: ${formatVector(geometry.origin)}`,
		'space units: "m" "m" "m"',
		'kinds: domain domain domain',
		'encoding: gzip',
		'endian: little',
	];
	for (const [key, value] of Object.entries(extras)) {
		lines.push(`${key}:=${value}`);
	}

	// The header is ASCII by construction, so a byte-per-character encode is
	// exact and avoids `Buffer`, which the browser build does not have either.
	const header = `${lines.join('\n')}\n\n`;
	const headerBytes = new Uint8Array(header.length);
	for (let i = 0; i < header.length; i++) {
		headerBytes[i] = header.charCodeAt(i) & 0xff;
	}

	const payload = await gzip(
		new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
	);

	const out = new Uint8Array(headerBytes.length + payload.length);
	out.set(headerBytes);
	out.set(payload, headerBytes.length);
	return out;
}

/**
 * Reads every slice of a series and stacks it into one volume.
 *
 * Samples come out of `parseDicom` with RescaleSlope/RescaleIntercept already
 * applied, which is what makes a CT volume carry true Hounsfield units — and
 * therefore what lets the 3D side default its isosurface to a physically
 * meaningful threshold instead of an arbitrary one.
 */
export async function buildVolumeFromSeries(
	series: DatasetSeries,
	progress?: (done: number, total: number) => void,
	isCancelled?: () => boolean,
): Promise<VolumeExportResult> {
	// One plane per z; other axes (time, echo) are not part of a static volume,
	// so the first index of each is taken.
	const byZ = new Map<number, string>();
	for (const plane of series.planes) {
		const z = plane.coordinates.z ?? 0;
		const extraAxes = Object.entries(plane.coordinates).filter(([key]) => key !== 'z');
		if (extraAxes.some(([, value]) => value !== 0)) {
			continue;
		}
		if (!byZ.has(z)) {
			byZ.set(z, plane.resourceUri);
		}
	}

	const zValues = [...byZ.keys()].sort((a, b) => a - b);
	if (zValues.length === 0) {
		throw new Error('This series has no slices to export.');
	}

	// Only DICOM planes are decodable here. An OME-TIFF dataset produces planes
	// with `format: 'tiff'`, which would otherwise be handed to the DICOM parser
	// and fail with a misleading "not a DICOM file". Microscopy stacks also need
	// their voxel geometry read from OME-XML rather than from DICOM tags, so
	// supporting them is real work, not a decoder swap — say so plainly.
	const foreign = series.planes.find(plane => plane.format !== 'dicom');
	if (foreign) {
		throw new Error(
			`This series contains ${foreign.format.toUpperCase()} planes; the 3D volume export currently ` +
			'handles DICOM only. OME-TIFF support needs its voxel spacing read from OME-XML.',
		);
	}

	let samples: Float32Array | undefined;
	let width = 0;
	let height = 0;
	let firstHeader: DicomImageHeader | undefined;
	let lastHeader: DicomImageHeader | undefined;
	let modality: string | undefined;
	let windowCenter: number | undefined;
	let windowWidth: number | undefined;
	let photometricInterpretation: string | undefined;

	for (let index = 0; index < zValues.length; index++) {
		if (isCancelled?.()) {
			throw new Error('Volume export cancelled');
		}
		const uri = vscode.Uri.parse(byZ.get(zValues[index])!);
		const bytes = await vscode.workspace.fs.readFile(uri);
		const header = parseDicomImageHeader(bytes);

		let decoded;
		try {
			decoded = parseDicom(
				bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
			);
		} catch (error) {
			// Compressed transfer syntaxes decode in the webview's WASM codec
			// path, which is not reachable from here. Say so plainly rather
			// than producing a volume with a hole in it.
			throw new Error(
				`Slice ${index + 1} of ${zValues.length} could not be decoded here ` +
				`(${error instanceof Error ? error.message : String(error)}). ` +
				'Compressed DICOM is not yet supported by the 3D export.',
			);
		}

		if (decoded.channels !== 1) {
			throw new Error(`This series has ${decoded.channels} channels per pixel; only grayscale volumes can be exported.`);
		}

		if (!samples) {
			width = decoded.width;
			height = decoded.height;
			samples = new Float32Array(width * height * zValues.length);
			firstHeader = header ?? undefined;
			modality = (decoded.metadata as { modality?: string }).modality;
			windowCenter = firstHeader?.windowCenter ?? Number((decoded.metadata as { windowCenter?: number }).windowCenter);
			windowWidth = firstHeader?.windowWidth ?? Number((decoded.metadata as { windowWidth?: number }).windowWidth);
			photometricInterpretation = firstHeader?.photometricInterpretation ?? (decoded.metadata as { photometric?: string }).photometric;
		} else if (decoded.width !== width || decoded.height !== height) {
			throw new Error(
				`Slice ${index + 1} is ${decoded.width}x${decoded.height} but the first slice is ${width}x${height}; ` +
				'a volume needs uniform slice dimensions.',
			);
		}

		samples.set(decoded.data as Float32Array, index * width * height);
		lastHeader = header ?? lastHeader;
		progress?.(index + 1, zValues.length);
	}

	const geometry = deriveGeometry(
		firstHeader ?? {} as DicomImageHeader,
		lastHeader ?? firstHeader ?? {} as DicomImageHeader,
		zValues.length,
	);

	// Hounsfield units only mean anything for CT; labelling an MR volume "HU"
	// would make the 3D side offer a bone-density default that is nonsense.
	const intensityUnits = (modality || '').toUpperCase() === 'CT' ? 'HU' : undefined;

	const sizes: [number, number, number] = [width, height, zValues.length];
	const extras: Record<string, string> = {};
	if (modality) {
		extras['modality'] = modality;
	}
	if (intensityUnits) {
		extras['units'] = intensityUnits;
	}
	if (Number.isFinite(windowCenter)) {
		extras['window center'] = String(windowCenter);
	}
	if (Number.isFinite(windowWidth) && windowWidth! > 0) {
		extras['window width'] = String(windowWidth);
	}
	if (photometricInterpretation) {
		// parseDicom normalises MONOCHROME1 samples to black-low/white-high for
		// presentation. Describe the exported samples honestly while retaining
		// the source tag for inspection.
		extras['photometric interpretation'] = 'MONOCHROME2';
		extras['source photometric interpretation'] = photometricInterpretation;
	}

	return {
		bytes: await writeNrrd(samples!, sizes, geometry, extras),
		sizes,
		geometry,
		modality,
		intensityUnits,
	};
}

/** Where the handed-over volume is written before the 3D viewer opens it. */
export function volumeExportUri(storage: vscode.Uri, label: string): vscode.Uri {
	const safe = label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'volume';
	return Utils.joinPath(storage, `${safe}.nrrd`);
}

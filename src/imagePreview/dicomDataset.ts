import * as vscode from 'vscode';
import { Utils } from 'vscode-uri';
import type { DatasetManifest, DatasetPlane, DatasetSeries } from './datasetTypes';

interface ElementLocation { offset: number; length: number; vr: string; }

interface DicomImageHeader {
	studyUid: string;
	seriesUid: string;
	sopUid: string;
	seriesNumber?: number;
	instanceNumber?: number;
	acquisitionNumber?: number;
	temporalPosition?: number;
	echoNumber?: number;
	modality?: string;
	frameOfReferenceUid?: string;
	position?: number[];
	orientation?: number[];
	rows?: number;
	columns?: number;
	frames: number;
	transferSyntax: string;
	hasPixelData: boolean;
}

const LONG_VR = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'UC', 'UR', 'UT', 'UN']);

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	let out = '';
	const end = Math.min(bytes.length, offset + length);
	for (let i = offset; i < end; i++) { out += String.fromCharCode(bytes[i]); }
	return out;
}

function readElement(view: DataView, bytes: Uint8Array, offset: number, explicit: boolean, little: boolean) {
	if (offset + 8 > view.byteLength) { return null; }
	const group = view.getUint16(offset, little);
	const element = view.getUint16(offset + 2, little);
	let vr = '';
	let length: number;
	let valueOffset: number;
	if (explicit) {
		vr = ascii(bytes, offset + 4, 2);
		if (!/^[A-Z]{2}$/.test(vr)) { return null; }
		if (LONG_VR.has(vr)) {
			if (offset + 12 > view.byteLength) { return null; }
			length = view.getUint32(offset + 8, little);
			valueOffset = offset + 12;
		} else {
			length = view.getUint16(offset + 6, little);
			valueOffset = offset + 8;
		}
	} else {
		length = view.getUint32(offset + 4, little);
		valueOffset = offset + 8;
	}
	return { group, element, tag: group * 0x10000 + element, vr, length, valueOffset };
}

function skipUndefinedValue(view: DataView, bytes: Uint8Array, start: number, explicit: boolean, little: boolean, endElement = 0xe0dd): number {
	let offset = start;
	while (offset + 8 <= view.byteLength) {
		const group = view.getUint16(offset, little);
		const element = view.getUint16(offset + 2, little);
		if (group === 0xfffe) {
			const length = view.getUint32(offset + 4, little);
			if (element === endElement) { return offset + 8; }
			if (element === 0xe000) {
				offset = length === 0xffffffff
					? skipUndefinedValue(view, bytes, offset + 8, explicit, little, 0xe00d)
					: offset + 8 + length;
				continue;
			}
			offset += 8;
			continue;
		}
		const nested = readElement(view, bytes, offset, explicit, little);
		if (!nested) { return view.byteLength; }
		offset = nested.length === 0xffffffff
			? skipUndefinedValue(view, bytes, nested.valueOffset, explicit, little)
			: nested.valueOffset + nested.length;
	}
	return view.byteLength;
}

function parseNumbers(value: string): number[] | undefined {
	const values = value.split('\\').map(Number);
	return values.length > 0 && values.every(Number.isFinite) ? values : undefined;
}

/** Parse only technical tags needed to assemble an image series. */
export function parseDicomImageHeader(data: Uint8Array): DicomImageHeader | null {
	if (data.byteLength < 8) { return null; }
	const bytes = data;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const hasPreamble = bytes.byteLength >= 132 && ascii(bytes, 128, 4) === 'DICM';
	let offset = hasPreamble ? 132 : 0;
	let transferSyntax = '1.2.840.10008.1.2';

	if (hasPreamble) {
		while (offset + 8 <= bytes.byteLength) {
			const el = readElement(view, bytes, offset, true, true);
			if (!el || el.group !== 0x0002) { break; }
			if (el.tag === 0x00020010) {
				transferSyntax = ascii(bytes, el.valueOffset, el.length).replace(/[\0 ]+$/g, '');
			}
			offset = el.valueOffset + el.length;
		}
	}

	const syntaxes: Record<string, { explicit: boolean; little: boolean }> = {
		'1.2.840.10008.1.2': { explicit: false, little: true },
		'1.2.840.10008.1.2.1': { explicit: true, little: true },
		'1.2.840.10008.1.2.2': { explicit: true, little: false },
		'1.2.840.10008.1.2.4.50': { explicit: true, little: true },
	};
	let encoding = syntaxes[transferSyntax];
	if (!hasPreamble) {
		encoding = { explicit: /^[A-Z]{2}$/.test(ascii(bytes, 4, 2)), little: true };
	}
	if (!encoding) { return null; }

	const tags = new Map<number, ElementLocation>();
	let hasPixelData = false;
	while (offset + 8 <= bytes.byteLength) {
		const el = readElement(view, bytes, offset, encoding.explicit, encoding.little);
		if (!el) { break; }
		if (el.tag === 0x7fe00010 || el.tag === 0x7fe00008 || el.tag === 0x7fe00009) {
			hasPixelData = true;
			break;
		}
		if (el.length === 0xffffffff) {
			offset = skipUndefinedValue(view, bytes, el.valueOffset, encoding.explicit, encoding.little);
			continue;
		}
		if (el.valueOffset + el.length > bytes.byteLength) { return null; }
		tags.set(el.tag, { offset: el.valueOffset, length: el.length, vr: el.vr });
		offset = el.valueOffset + el.length;
	}

	const text = (tag: number): string => {
		const el = tags.get(tag);
		return el ? ascii(bytes, el.offset, el.length).replace(/[\0 ]+$/g, '') : '';
	};
	const number = (tag: number): number | undefined => {
		const parsed = Number(text(tag).split('\\')[0]);
		return Number.isFinite(parsed) ? parsed : undefined;
	};
	const ushort = (tag: number): number | undefined => {
		const el = tags.get(tag);
		return el && el.length >= 2 ? view.getUint16(el.offset, encoding.little) : undefined;
	};

	const studyUid = text(0x0020000d);
	const seriesUid = text(0x0020000e);
	if (!hasPreamble && !studyUid && !seriesUid && !hasPixelData) { return null; }
	return {
		studyUid,
		seriesUid,
		sopUid: text(0x00080018),
		seriesNumber: number(0x00200011),
		instanceNumber: number(0x00200013),
		acquisitionNumber: number(0x00200012),
		temporalPosition: number(0x00200100),
		echoNumber: number(0x00180086),
		modality: text(0x00080060) || undefined,
		frameOfReferenceUid: text(0x00200052) || undefined,
		position: parseNumbers(text(0x00200032)),
		orientation: parseNumbers(text(0x00200037)),
		rows: ushort(0x00280010),
		columns: ushort(0x00280011),
		frames: Math.max(1, Math.trunc(number(0x00280008) || 1)),
		transferSyntax,
		hasPixelData,
	};
}

function dot(a: number[], b: number[]): number {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function slicePosition(header: DicomImageHeader): number | undefined {
	if (!header.position || header.position.length < 3 || !header.orientation || header.orientation.length < 6) { return undefined; }
	const [rx, ry, rz, cx, cy, cz] = header.orientation;
	const normal = [ry * cz - rz * cy, rz * cx - rx * cz, rx * cy - ry * cx];
	return dot(header.position, normal);
}

function safeId(value: string): string {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) { hash = Math.imul(hash ^ value.charCodeAt(i), 16777619); }
	return (hash >>> 0).toString(16);
}

export async function scanDicomFolder(
	folder: vscode.Uri,
	progress?: (done: number, total: number, name: string) => void,
	isCancelled?: () => boolean,
): Promise<DatasetManifest> {
	const entries = await vscode.workspace.fs.readDirectory(folder);
	const files = entries.filter(([, type]) => (type & vscode.FileType.File) !== 0);
	const images: { uri: vscode.Uri; header: DicomImageHeader }[] = [];
	let next = 0;
	const workerCount = Math.min(8, files.length);
	await Promise.all(Array.from({ length: workerCount }, async () => {
		while (true) {
			const index = next++;
			if (index >= files.length || isCancelled?.()) { return; }
			const [name] = files[index];
			try {
				const uri = Utils.joinPath(folder, name);
				const data = await vscode.workspace.fs.readFile(uri);
				const header = parseDicomImageHeader(data);
				if (header?.hasPixelData) { images.push({ uri, header }); }
			} catch {
				// Mixed-content folders are expected; non-DICOM files are ignored.
			}
			progress?.(index + 1, files.length, name);
		}
	}));
	if (isCancelled?.()) { throw new Error('DICOM folder scan cancelled'); }
	if (images.length === 0) { throw new Error('No DICOM images with pixel data were found in this folder.'); }

	// Copies with a different filename are common when users add a .dcm suffix.
	// SOP Instance UID identifies the image object and prevents duplicate slices.
	const uniqueImages = new Map<string, (typeof images)[number]>();
	for (const image of images.sort((a, b) => a.uri.path.localeCompare(b.uri.path, undefined, { numeric: true }))) {
		const key = image.header.sopUid || image.uri.toString();
		if (!uniqueImages.has(key)) { uniqueImages.set(key, image); }
	}
	const groups = new Map<string, typeof images>();
	for (const image of uniqueImages.values()) {
		const h = image.header;
		const geometry = `${h.rows || 0}x${h.columns || 0}`;
		const orientation = h.orientation?.slice(0, 6).map(value => value.toFixed(4)).join('\\') || 'unknown-orientation';
		const identity = h.seriesUid || `${h.studyUid}|series-${h.seriesNumber ?? '?'}`;
		const key = `${identity}|${h.frameOfReferenceUid || ''}|${geometry}|${orientation}`;
		const group = groups.get(key) || [];
		group.push(image);
		groups.set(key, group);
	}

	const orderedGroups = [...groups.entries()].sort(([, a], [, b]) =>
		(a[0].header.seriesNumber ?? Number.MAX_SAFE_INTEGER) - (b[0].header.seriesNumber ?? Number.MAX_SAFE_INTEGER));
	const series: DatasetSeries[] = orderedGroups.map(([groupId, group], groupIndex) => {
		group.sort((a, b) => {
			const aPosition = slicePosition(a.header);
			const bPosition = slicePosition(b.header);
			if (aPosition !== undefined && bPosition !== undefined && Math.abs(aPosition - bPosition) > 1e-6) {
				return aPosition - bPosition;
			}
			return (a.header.instanceNumber ?? Number.MAX_SAFE_INTEGER) - (b.header.instanceNumber ?? Number.MAX_SAFE_INTEGER)
				|| Utils.basename(a.uri).localeCompare(Utils.basename(b.uri), undefined, { numeric: true });
		});
		const first = group[0].header;
		const temporalValues = [...new Set(group.map(image => image.header.temporalPosition).filter((value): value is number => value !== undefined))].sort((a, b) => a - b);
		const echoValues = [...new Set(group.map(image => image.header.echoNumber).filter((value): value is number => value !== undefined))].sort((a, b) => a - b);
		const hasTemporalAxis = temporalValues.length > 1;
		const hasEchoAxis = echoValues.length > 1;
		const positions = group.map(image => slicePosition(image.header));
		const allHavePositions = positions.every((value): value is number => value !== undefined);
		const positionValues = allHavePositions
			? [...new Set((positions as number[]).map(value => Number(value.toFixed(5))))].sort((a, b) => a - b)
			: [];
		const rankWithinDimension = new Map<string, number>();
		const nextRank = new Map<string, number>();
		const hasFrameAxis = group.some(image => image.header.frames > 1);
		const maxFrames = Math.max(...group.map(image => image.header.frames));
		const planes: DatasetPlane[] = group.flatMap((image, index) => {
			const t = hasTemporalAxis ? temporalValues.indexOf(image.header.temporalPosition!) : 0;
			const echo = hasEchoAxis ? echoValues.indexOf(image.header.echoNumber!) : 0;
			let z: number;
			if (allHavePositions) {
				z = positionValues.indexOf(Number((positions[index] as number).toFixed(5)));
			} else if (hasTemporalAxis || hasEchoAxis) {
				const dimensionKey = `${t},${echo}`;
				const instanceKey = `${dimensionKey}:${image.header.instanceNumber ?? index}`;
				if (!rankWithinDimension.has(instanceKey)) {
					rankWithinDimension.set(instanceKey, nextRank.get(dimensionKey) || 0);
					nextRank.set(dimensionKey, (nextRank.get(dimensionKey) || 0) + 1);
				}
				z = rankWithinDimension.get(instanceKey)!;
			} else {
				z = index;
			}
			const baseCoordinates: Record<string, number> = { z };
			if (hasTemporalAxis) { baseCoordinates.t = t; }
			if (hasEchoAxis) { baseCoordinates.echo = echo; }
			return Array.from({ length: image.header.frames }, (_, frameIndex) => ({
				coordinates: { ...baseCoordinates, ...(hasFrameAxis ? { frame: frameIndex } : {}) },
				resourceUri: image.uri.toString(),
				format: 'dicom' as const,
				frameIndex,
			}));
		});
		const zSize = Math.max(1, ...planes.map(plane => plane.coordinates.z + 1));
		const seriesNumber = first.seriesNumber ?? groupIndex + 1;
		return {
			id: `dicom-series-${safeId(groupId)}`,
			label: `Series ${seriesNumber}${first.modality ? ` · ${first.modality}` : ''}`,
			axes: [
				...(zSize > 1 || !hasFrameAxis ? [{ key: 'z', label: 'Slice', size: zSize }] : []),
				...(hasFrameAxis ? [{ key: 'frame', label: 'Frame', size: maxFrames }] : []),
				...(hasTemporalAxis ? [{ key: 't', label: 'Time', size: temporalValues.length, valueLabels: temporalValues.map(String) }] : []),
				...(hasEchoAxis ? [{ key: 'echo', label: 'Echo', size: echoValues.length, valueLabels: echoValues.map(String) }] : []),
			],
			planes,
		};
	});

	return {
		id: `dicom-${safeId(folder.toString())}`,
		kind: 'dicom',
		label: Utils.basename(folder),
		series,
		initialSeriesIndex: 0,
		initialCoordinates: { z: 0 },
	};
}

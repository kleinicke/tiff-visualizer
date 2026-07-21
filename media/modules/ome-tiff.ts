"use strict";

import type { TagEntry } from './tiff-tag-utils.js';

export type OmeAxis = 'C' | 'Z' | 'T';

export interface OmeChannel {
	id?: string;
	name: string;
	color?: number;
	colorCss?: string;
	samplesPerPixel: number;
}

export interface OmeObjective {
	id?: string;
	manufacturer?: string;
	model?: string;
	serialNumber?: string;
	nominalMagnification?: number;
	lensNA?: number;
	immersion?: string;
	correction?: string;
}

export interface OmeCoordinates {
	c: number;
	z: number;
	t: number;
}

export interface OmeTiffData {
	ifd: number;
	firstC: number;
	firstZ: number;
	firstT: number;
	planeCount: number;
	fileName?: string;
	uuid?: string;
}

export interface OmePlaneSource extends OmeCoordinates {
	ifd: number;
	fileName?: string;
	uuid?: string;
}

export interface OmeMetadata {
	xml: string;
	creator?: string;
	uuid?: string;
	imageId?: string;
	imageName?: string;
	pixelsId?: string;
	dimensionOrder: string;
	sizeX: number;
	sizeY: number;
	sizeC: number;
	sizeZ: number;
	sizeT: number;
	/** Number of independently stored channel planes (RGB samples may share one plane). */
	planeSizeC: number;
	pixelType?: string;
	physicalSizeX?: number;
	physicalSizeXUnit?: string;
	physicalSizeY?: number;
	physicalSizeYUnit?: string;
	physicalSizeZ?: number;
	physicalSizeZUnit?: string;
	timeIncrement?: number;
	timeIncrementUnit?: string;
	channels: OmeChannel[];
	objective?: OmeObjective;
	objectiveSettingsId?: string;
	tiffData: OmeTiffData[];
	expectedPlaneCount: number;
	coordinateToIfd: Record<string, number>;
	ifdToCoordinate: Record<string, OmeCoordinates>;
	coordinateToPlane: Record<string, OmePlaneSource>;
	/** Every logical Image represented by the same OME-XML document. */
	images?: OmeMetadata[];
}

export interface OmeBinaryOnly {
	metadataFile: string;
	uuid?: string;
}

type Attributes = Record<string, string>;

function decodeXml(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_whole, entity: string) => {
		const lower = entity.toLowerCase();
		if (lower === 'amp') { return '&'; }
		if (lower === 'lt') { return '<'; }
		if (lower === 'quot') { return '"'; }
		if (lower === 'apos') { return "'"; }
		const radix = lower.startsWith('#x') ? 16 : 10;
		const digits = lower.slice(radix === 16 ? 2 : 1);
		const codePoint = parseInt(digits, radix);
		return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _whole;
	});
}

function parseAttributes(source: string): Attributes {
	const out: Attributes = {};
	const pattern = /([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(source))) {
		const rawName = match[1];
		const localName = rawName.includes(':') ? rawName.slice(rawName.lastIndexOf(':') + 1) : rawName;
		out[localName] = decodeXml(match[3]);
	}
	return out;
}

function startTags(xml: string, localName: string): Attributes[] {
	const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const pattern = new RegExp(`<(?:[\\w.-]+:)?${escaped}\\b([^>]*)>`, 'gi');
	const out: Attributes[] = [];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(xml))) { out.push(parseAttributes(match[1])); }
	return out;
}

function firstStartTag(xml: string, localName: string): Attributes | null {
	return startTags(xml, localName)[0] || null;
}

function firstElementBody(xml: string, localName: string): string {
	const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const pattern = new RegExp(
		`<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}\\s*>`,
		'i',
	);
	return pattern.exec(xml)?.[1] || '';
}

function elements(xml: string, localName: string): { attributes: Attributes, body: string }[] {
	const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const pattern = new RegExp(`<(?:[\\w.-]+:)?${escaped}\\b([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}\\s*>)`, 'gi');
	const out: { attributes: Attributes, body: string }[] = [];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(xml))) { out.push({ attributes: parseAttributes(match[1]), body: match[2] || '' }); }
	return out;
}

function positiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function finiteNumber(value: string | undefined): number | undefined {
	if (value === undefined || value === '') { return undefined; }
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function coordinateKey(coordinates: OmeCoordinates): string {
	return `${coordinates.c},${coordinates.z},${coordinates.t}`;
}

function axisSize(metadata: Pick<OmeMetadata, 'planeSizeC' | 'sizeZ' | 'sizeT'>, axis: string): number {
	if (axis === 'C') { return metadata.planeSizeC; }
	if (axis === 'Z') { return metadata.sizeZ; }
	return metadata.sizeT;
}

function normalizedPlaneAxes(dimensionOrder: string): OmeAxis[] {
	const axes = dimensionOrder.toUpperCase().replace(/X|Y/g, '').split('')
		.filter((axis): axis is OmeAxis => axis === 'C' || axis === 'Z' || axis === 'T');
	for (const axis of ['Z', 'C', 'T'] as OmeAxis[]) {
		if (!axes.includes(axis)) { axes.push(axis); }
	}
	return axes;
}

function linearIndex(metadata: Pick<OmeMetadata, 'dimensionOrder' | 'planeSizeC' | 'sizeZ' | 'sizeT'>, coordinates: OmeCoordinates): number {
	let index = 0;
	let stride = 1;
	for (const axis of normalizedPlaneAxes(metadata.dimensionOrder)) {
		const value = axis === 'C' ? coordinates.c : axis === 'Z' ? coordinates.z : coordinates.t;
		index += value * stride;
		stride *= axisSize(metadata, axis);
	}
	return index;
}

function coordinatesForLinearIndex(metadata: Pick<OmeMetadata, 'dimensionOrder' | 'planeSizeC' | 'sizeZ' | 'sizeT'>, rawIndex: number): OmeCoordinates {
	let index = Math.max(0, rawIndex);
	const coordinates: OmeCoordinates = { c: 0, z: 0, t: 0 };
	for (const axis of normalizedPlaneAxes(metadata.dimensionOrder)) {
		const size = Math.max(1, axisSize(metadata, axis));
		const value = index % size;
		index = Math.floor(index / size);
		if (axis === 'C') { coordinates.c = value; }
		else if (axis === 'Z') { coordinates.z = value; }
		else { coordinates.t = value; }
	}
	return coordinates;
}

function channelIndexForFirstC(channels: OmeChannel[], firstC: number): number {
	let sampleOffset = 0;
	for (let index = 0; index < channels.length; index++) {
		if (firstC === sampleOffset || firstC === index) { return index; }
		sampleOffset += Math.max(1, channels[index].samplesPerPixel);
	}
	return Math.max(0, Math.min(channels.length - 1, firstC));
}

/** Convert the OME signed 32-bit RGBA integer to a CSS #RRGGBBAA color. */
export function omeColorToCss(color: number | undefined): string | undefined {
	if (!Number.isFinite(color)) { return undefined; }
	const rgba = Number(color) >>> 0;
	return `#${rgba.toString(16).padStart(8, '0')}`;
}

export function findOmeXmlInTags(tags: TagEntry[]): string | undefined {
	for (const tag of tags || []) {
		const isDescription = tag.tag === 270 || /(^|\b)ImageDescription\b/i.test(String(tag.name || ''));
		if (!isDescription) { continue; }
		const value = String(tag.value || '').replace(/^\uFEFF/, '').trim();
		if (/(?:<\?xml[\s\S]*?\?>\s*)?<(?:(?:[\w.-]+):)?OME\b/i.test(value)) { return value; }
	}
	return undefined;
}

function parseOmeImage(source: string, ome: Attributes, image: Attributes, imageBody: string): OmeMetadata | null {
	const pixelsBody = firstElementBody(imageBody, 'Pixels') || imageBody;
	const pixels = firstStartTag(imageBody, 'Pixels');
	if (!pixels) { return null; }

	const dimensionOrder = /^[XYZCT]{5}$/i.test(pixels.DimensionOrder || '')
		? pixels.DimensionOrder.toUpperCase()
		: 'XYZCT';
	const sizeC = positiveInt(pixels.SizeC, 1);
	const sizeZ = positiveInt(pixels.SizeZ, 1);
	const sizeT = positiveInt(pixels.SizeT, 1);

	const channelAttrs = startTags(pixelsBody, 'Channel');
	const channels: OmeChannel[] = channelAttrs.map((attrs, index) => {
		const color = finiteNumber(attrs.Color);
		return {
			id: attrs.ID,
			name: attrs.Name || attrs.Fluor || `Channel ${index + 1}`,
			color,
			colorCss: omeColorToCss(color),
			samplesPerPixel: positiveInt(attrs.SamplesPerPixel, 1),
		};
	});
	const storedChannelCount = channels.length || sizeC;
	const summedSamples = channels.reduce((sum, channel) => sum + channel.samplesPerPixel, 0);
	const planeSizeC = summedSamples === sizeC ? storedChannelCount : sizeC;

	const objectiveSettings = firstStartTag(imageBody, 'ObjectiveSettings');
	const objectiveSettingsId = objectiveSettings?.ID;
	const objectives = startTags(source, 'Objective');
	const objectiveAttrs = objectives.find(candidate => objectiveSettingsId && candidate.ID === objectiveSettingsId)
		|| objectives[0];
	const objective: OmeObjective | undefined = objectiveAttrs ? {
		id: objectiveAttrs.ID,
		manufacturer: objectiveAttrs.Manufacturer,
		model: objectiveAttrs.Model,
		serialNumber: objectiveAttrs.SerialNumber,
		nominalMagnification: finiteNumber(objectiveAttrs.NominalMagnification),
		lensNA: finiteNumber(objectiveAttrs.LensNA),
		immersion: objectiveAttrs.Immersion,
		correction: objectiveAttrs.Correction,
	} : undefined;

	const metadata: OmeMetadata = {
		xml: source,
		creator: ome.Creator,
		uuid: ome.UUID,
		imageId: image.ID,
		imageName: image.Name,
		pixelsId: pixels.ID,
		dimensionOrder,
		sizeX: positiveInt(pixels.SizeX, 1),
		sizeY: positiveInt(pixels.SizeY, 1),
		sizeC,
		sizeZ,
		sizeT,
		planeSizeC,
		pixelType: pixels.Type,
		physicalSizeX: finiteNumber(pixels.PhysicalSizeX),
		physicalSizeXUnit: pixels.PhysicalSizeXUnit,
		physicalSizeY: finiteNumber(pixels.PhysicalSizeY),
		physicalSizeYUnit: pixels.PhysicalSizeYUnit,
		physicalSizeZ: finiteNumber(pixels.PhysicalSizeZ),
		physicalSizeZUnit: pixels.PhysicalSizeZUnit,
		timeIncrement: finiteNumber(pixels.TimeIncrement),
		timeIncrementUnit: pixels.TimeIncrementUnit,
		channels,
		objective,
		objectiveSettingsId,
		tiffData: [],
		expectedPlaneCount: planeSizeC * sizeZ * sizeT,
		coordinateToIfd: {},
		ifdToCoordinate: {},
		coordinateToPlane: {},
	};

	metadata.tiffData = elements(pixelsBody, 'TiffData').map(element => {
		const attrs = element.attributes;
		const uuidElement = elements(element.body, 'UUID')[0];
		const uuid = uuidElement?.attributes || {};
		return {
			ifd: nonNegativeInt(attrs.IFD, 0),
			firstC: channelIndexForFirstC(channels, nonNegativeInt(attrs.FirstC, 0)),
			firstZ: nonNegativeInt(attrs.FirstZ, 0),
			firstT: nonNegativeInt(attrs.FirstT, 0),
			// Per the OME-TIFF specification, an attribute-free TiffData covers all
			// planes; once IFD is explicitly supplied, the default becomes one.
			planeCount: positiveInt(attrs.PlaneCount, attrs.IFD === undefined ? metadata.expectedPlaneCount : 1),
			fileName: uuid.FileName,
			uuid: uuidElement?.body.trim() || undefined,
		};
	});

	if (metadata.tiffData.length > 0) {
		for (const mapping of metadata.tiffData) {
			const firstCoordinates = { c: mapping.firstC, z: mapping.firstZ, t: mapping.firstT };
			const firstLinear = linearIndex(metadata, firstCoordinates);
			for (let offset = 0; offset < mapping.planeCount; offset++) {
				const coordinates = coordinatesForLinearIndex(metadata, firstLinear + offset);
				const ifd = mapping.ifd + offset;
				metadata.coordinateToIfd[coordinateKey(coordinates)] = ifd;
				metadata.ifdToCoordinate[String(ifd)] = coordinates;
				metadata.coordinateToPlane[coordinateKey(coordinates)] = { ...coordinates, ifd, fileName: mapping.fileName, uuid: mapping.uuid };
			}
		}
	}

	return metadata;
}

export function parseOmeXmlImages(xml: string | undefined | null): OmeMetadata[] {
	const source = String(xml || '').replace(/^\uFEFF/, '').trim();
	if (!/<(?:(?:[\w.-]+):)?OME\b/i.test(source)) { return []; }
	const ome = firstStartTag(source, 'OME') || {};
	return elements(source, 'Image')
		.map(image => parseOmeImage(source, ome, image.attributes, image.body))
		.filter((image): image is OmeMetadata => !!image);
}

export function parseOmeXml(xml: string | undefined | null): OmeMetadata | null {
	const images = parseOmeXmlImages(xml);
	if (images.length === 0) { return null; }
	images[0].images = images.map(image => {
		const copy: OmeMetadata = { ...image };
		delete copy.images;
		return copy;
	});
	return images[0];
}

/** Locate the external metadata document referenced by a BinaryOnly OME block. */
export function parseOmeBinaryOnly(xml: string | undefined | null): OmeBinaryOnly | null {
	const source = String(xml || '').replace(/^\uFEFF/, '').trim();
	if (!/<(?:(?:[\w.-]+):)?OME\b/i.test(source)) { return null; }
	const binaryOnly = elements(source, 'BinaryOnly')[0]?.attributes;
	if (!binaryOnly?.MetadataFile) { return null; }
	return { metadataFile: binaryOnly.MetadataFile, uuid: binaryOnly.UUID };
}

export function omeCoordinatesToIfd(metadata: OmeMetadata, coordinates: OmeCoordinates): number {
	const safe: OmeCoordinates = {
		c: Math.max(0, Math.min(metadata.planeSizeC - 1, Math.trunc(coordinates.c))),
		z: Math.max(0, Math.min(metadata.sizeZ - 1, Math.trunc(coordinates.z))),
		t: Math.max(0, Math.min(metadata.sizeT - 1, Math.trunc(coordinates.t))),
	};
	return metadata.coordinateToIfd[coordinateKey(safe)] ?? linearIndex(metadata, safe);
}

export function omeIfdToCoordinates(metadata: OmeMetadata, ifd: number): OmeCoordinates {
	return metadata.ifdToCoordinate[String(ifd)] || coordinatesForLinearIndex(metadata, ifd);
}

/** Read the first IFD's ImageDescription without decoding TIFF pixels. */
export function tiffImageDescription(bytes: Uint8Array): string | undefined {
	if (bytes.byteLength < 16) { return undefined; }
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const byteOrder = String.fromCharCode(bytes[0], bytes[1]);
	const little = byteOrder === 'II';
	if (!little && byteOrder !== 'MM') { return undefined; }
	const magic = view.getUint16(2, little);
	const safeOffset = (value: bigint | number): number | undefined => {
		const number = typeof value === 'bigint' ? Number(value) : value;
		return Number.isSafeInteger(number) && number >= 0 && number < bytes.byteLength ? number : undefined;
	};
	let ifdOffset: number | undefined;
	let entryCount = 0;
	let entryStart = 0;
	let entrySize = 0;
	let inlineSize = 0;
	if (magic === 42) {
		ifdOffset = safeOffset(view.getUint32(4, little));
		if (ifdOffset === undefined || ifdOffset + 2 > bytes.byteLength) { return undefined; }
		entryCount = view.getUint16(ifdOffset, little);
		entryStart = ifdOffset + 2;
		entrySize = 12;
		inlineSize = 4;
	} else if (magic === 43 && view.getUint16(4, little) === 8) {
		ifdOffset = safeOffset(view.getBigUint64(8, little));
		if (ifdOffset === undefined || ifdOffset + 8 > bytes.byteLength) { return undefined; }
		entryCount = Number(view.getBigUint64(ifdOffset, little));
		entryStart = ifdOffset + 8;
		entrySize = 20;
		inlineSize = 8;
	} else {
		return undefined;
	}
	for (let index = 0; index < entryCount; index++) {
		const entry = entryStart + index * entrySize;
		if (entry + entrySize > bytes.byteLength || view.getUint16(entry, little) !== 270) { continue; }
		if (view.getUint16(entry + 2, little) !== 2) { return undefined; }
		const count = magic === 42 ? view.getUint32(entry + 4, little) : Number(view.getBigUint64(entry + 4, little));
		const valueOffsetField = magic === 42 ? entry + 8 : entry + 12;
		const valueOffset = count <= inlineSize
			? valueOffsetField
			: safeOffset(magic === 42 ? view.getUint32(valueOffsetField, little) : view.getBigUint64(valueOffsetField, little));
		if (valueOffset === undefined || count < 1 || valueOffset + count > bytes.byteLength) { return undefined; }
		return new TextDecoder('utf-8').decode(bytes.subarray(valueOffset, valueOffset + count)).replace(/\0+$/g, '');
	}
	return undefined;
}

type Attributes = Record<string, string>;
type OmeAxis = 'C' | 'Z' | 'T';

export interface OmeDatasetDescription {
	uuid?: string;
	series: Array<{
		imageId?: string;
		imageName?: string;
		sizeC: number;
		sizeZ: number;
		sizeT: number;
		channelNames: string[];
		planes: Array<{ c: number; z: number; t: number; ifd: number; fileName?: string; uuid?: string }>;
	}>;
}

function xmlAttributes(source: string): Attributes {
	const attributes: Attributes = {};
	const pattern = /([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(source))) {
		const name = match[1].split(':').pop()!;
		attributes[name] = match[3]
			.replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
			.replace(/&quot;/gi, '"').replace(/&apos;/gi, "'");
	}
	return attributes;
}

function xmlElements(source: string, name: string): Array<{ attributes: Attributes; body: string }> {
	const pattern = new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>)`, 'gi');
	const found: Array<{ attributes: Attributes; body: string }> = [];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(source))) { found.push({ attributes: xmlAttributes(match[1]), body: match[2] || '' }); }
	return found;
}

function positiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Parse only the OME fields required to assemble externally referenced TIFF planes. */
export function parseOmeDatasetXml(xml: string | undefined): OmeDatasetDescription | null {
	const source = String(xml || '').replace(/^\uFEFF/, '').trim();
	const omeMatch = /<(?:[\w.-]+:)?OME\b([^>]*)>/i.exec(source);
	if (!omeMatch) { return null; }
	const ome = xmlAttributes(omeMatch[1]);
	const series = xmlElements(source, 'Image').flatMap(imageElement => {
		const pixelsElement = xmlElements(imageElement.body, 'Pixels')[0];
		if (!pixelsElement) { return []; }
		const pixels = pixelsElement.attributes;
		const dimensionOrder = /^[XYZCT]{5}$/i.test(pixels.DimensionOrder || '') ? pixels.DimensionOrder.toUpperCase() : 'XYZCT';
		const sizeC = positiveInt(pixels.SizeC, 1);
		const sizeZ = positiveInt(pixels.SizeZ, 1);
		const sizeT = positiveInt(pixels.SizeT, 1);
		const channels = xmlElements(pixelsElement.body, 'Channel').map((channel, index) => ({
			name: channel.attributes.Name || channel.attributes.Fluor || `Channel ${index + 1}`,
			samples: positiveInt(channel.attributes.SamplesPerPixel, 1),
		}));
		const summedSamples = channels.reduce((sum, channel) => sum + channel.samples, 0);
		const planeSizeC = channels.length > 0 && summedSamples === sizeC ? channels.length : sizeC;
		const channelIndex = (raw: number) => {
			let sampleOffset = 0;
			for (let index = 0; index < channels.length; index++) {
				if (raw === sampleOffset || raw === index) { return index; }
				sampleOffset += channels[index].samples;
			}
			return Math.max(0, Math.min(planeSizeC - 1, raw));
		};
		const axes = dimensionOrder.replace(/X|Y/g, '').split('')
			.filter((axis): axis is OmeAxis => axis === 'C' || axis === 'Z' || axis === 'T');
		for (const axis of ['Z', 'C', 'T'] as const) { if (!axes.includes(axis)) { axes.push(axis); } }
		const axisSize = (axis: OmeAxis) => axis === 'C' ? planeSizeC : axis === 'Z' ? sizeZ : sizeT;
		const coordinatesForIndex = (rawIndex: number) => {
			let index = rawIndex;
			const coordinates = { c: 0, z: 0, t: 0 };
			for (const axis of axes) {
				const value = index % axisSize(axis);
				index = Math.floor(index / axisSize(axis));
				if (axis === 'C') { coordinates.c = value; }
				else if (axis === 'Z') { coordinates.z = value; }
				else { coordinates.t = value; }
			}
			return coordinates;
		};
		const linearIndex = (coordinates: { c: number; z: number; t: number }) => {
			let index = 0, stride = 1;
			for (const axis of axes) {
				index += (axis === 'C' ? coordinates.c : axis === 'Z' ? coordinates.z : coordinates.t) * stride;
				stride *= axisSize(axis);
			}
			return index;
		};
		const planes = xmlElements(pixelsElement.body, 'TiffData').flatMap(mapping => {
			const attrs = mapping.attributes;
			const uuidElement = xmlElements(mapping.body, 'UUID')[0];
			const first = {
				c: channelIndex(Math.max(0, Number(attrs.FirstC || 0))),
				z: Math.max(0, Number(attrs.FirstZ || 0)),
				t: Math.max(0, Number(attrs.FirstT || 0)),
			};
			const planeCount = positiveInt(attrs.PlaneCount, attrs.IFD === undefined ? planeSizeC * sizeZ * sizeT : 1);
			return Array.from({ length: planeCount }, (_, offset) => ({
				...coordinatesForIndex(linearIndex(first) + offset),
				ifd: Math.max(0, Number(attrs.IFD || 0)) + offset,
				fileName: uuidElement?.attributes.FileName,
				uuid: uuidElement?.body.trim() || undefined,
			}));
		});
		return [{
			imageId: imageElement.attributes.ID,
			imageName: imageElement.attributes.Name,
			sizeC: planeSizeC, sizeZ, sizeT,
			channelNames: channels.map(channel => channel.name),
			planes,
		}];
	});
	return series.length > 0 ? { uuid: ome.UUID, series } : null;
}

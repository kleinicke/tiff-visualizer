"use strict";

export interface ScientificDecodedImage {
	width: number;
	height: number;
	channels: number;
	data: Float32Array;
	metadata: Record<string, any>;
	numericDomain: {
		bitsPerSample: number;
		sampleFormat: 1 | 2 | 3;
		typeMin: number;
		typeMax: number;
		sourceNumericType: 'uint8' | 'int8' | 'uint16' | 'int16' | 'uint32' | 'int32' | 'float32' | 'float64';
	};
	decodeTimings?: { name: string, durationMs: number }[];
}

function finiteNumber(value: unknown, fallback: number): number {
	const parsed = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function scaledDomain(storedMin: number, storedMax: number, scale: number, offset: number): { typeMin: number, typeMax: number } {
	const first = offset + scale * storedMin;
	const last = offset + scale * storedMax;
	return { typeMin: Math.min(first, last), typeMax: Math.max(first, last) };
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
	let out = '';
	const end = Math.min(bytes.length, start + length);
	for (let i = start; i < end; i++) { out += String.fromCharCode(bytes[i]); }
	return out;
}

function fitsValue(card: string): string | number | boolean | null {
	if (card[8] !== '=') { return null; }
	let raw = card.slice(10);
	let quoted = false;
	let value = '';
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (ch === "'") {
			if (quoted && raw[i + 1] === "'") { value += "'"; i++; continue; }
			quoted = !quoted;
			continue;
		}
		if (ch === '/' && !quoted) { break; }
		value += ch;
	}
	value = value.trim();
	if (value === 'T') { return true; }
	if (value === 'F') { return false; }
	const numeric = Number(value.replace(/[dD]/, 'E'));
	return value !== '' && Number.isFinite(numeric) ? numeric : value.trim();
}

/** Decode the first primary/IMAGE FITS HDU with at least two axes. */
export function parseFits(buffer: ArrayBuffer): ScientificDecodedImage {
	const started = performance.now();
	const bytes = new Uint8Array(buffer);
	const view = new DataView(buffer);
	let hduOffset = 0;
	let hduIndex = 0;

	while (hduOffset + 80 <= bytes.length) {
		const header: Record<string, any> = {};
		let cardOffset = hduOffset;
		let foundEnd = false;
		while (cardOffset + 80 <= bytes.length) {
			const card = ascii(bytes, cardOffset, 80);
			cardOffset += 80;
			const key = card.slice(0, 8).trim();
			if (key === 'END') { foundEnd = true; break; }
			if (key) { header[key] = fitsValue(card); }
		}
		if (!foundEnd) { throw new Error('Invalid FITS header: missing END card'); }
		const dataOffset = Math.ceil(cardOffset / 2880) * 2880;
		const bitpix = finiteNumber(header.BITPIX, 0);
		const naxis = Math.max(0, finiteNumber(header.NAXIS, 0));
		const axes: number[] = [];
		let elementCount = naxis > 0 ? 1 : 0;
		for (let i = 1; i <= naxis; i++) {
			const size = Math.max(0, finiteNumber(header[`NAXIS${i}`], 0));
			axes.push(size);
			elementCount *= size;
		}
		const bytesPerValue = Math.abs(bitpix) / 8;
		const dataBytes = elementCount * bytesPerValue;
		const isImage = hduIndex === 0 || String(header.XTENSION || '').trim().toUpperCase() === 'IMAGE';

		if (isImage && naxis >= 2 && axes[0] > 0 && axes[1] > 0 && [8, 16, 32, 64, -32, -64].includes(bitpix)) {
			const width = axes[0];
			const height = axes[1];
			const planeValues = width * height;
			if (dataOffset + planeValues * bytesPerValue > buffer.byteLength) {
				throw new Error('Truncated FITS image data');
			}
			const scale = finiteNumber(header.BSCALE, 1);
			const zero = finiteNumber(header.BZERO, 0);
			const blank = typeof header.BLANK === 'number' ? header.BLANK : null;
			const bitsPerSample = Math.abs(bitpix);
			const sampleFormat: 1 | 2 | 3 = bitpix < 0 ? 3 : bitpix === 8 ? 1 : 2;
			const storedMin = sampleFormat === 3 ? 0 : sampleFormat === 1 ? 0 : -(2 ** (bitsPerSample - 1));
			const storedMax = sampleFormat === 3 ? 1 : sampleFormat === 1 ? (2 ** bitsPerSample) - 1 : (2 ** (bitsPerSample - 1)) - 1;
			const domain = scaledDomain(storedMin, storedMax, scale, zero);
			const sourceNumericType = (sampleFormat === 3
				? (bitsPerSample <= 32 ? 'float32' : 'float64')
				: sampleFormat === 1 ? 'uint8'
					: bitsPerSample <= 16 ? 'int16' : 'int32') as ScientificDecodedImage['numericDomain']['sourceNumericType'];
			const data = new Float32Array(planeValues);
			const readStored = (offset: number): number => {
				switch (bitpix) {
					case 8: return view.getUint8(offset);
					case 16: return view.getInt16(offset, false);
					case 32: return view.getInt32(offset, false);
					case 64: return Number(view.getBigInt64(offset, false));
					case -32: return view.getFloat32(offset, false);
					case -64: return view.getFloat64(offset, false);
					default: return NaN;
				}
			};
			// FITS axis 2 increases bottom-to-top; flip rows for a conventional canvas.
			for (let y = 0; y < height; y++) {
				const srcY = height - 1 - y;
				for (let x = 0; x < width; x++) {
					const stored = readStored(dataOffset + (srcY * width + x) * bytesPerValue);
					data[y * width + x] = blank !== null && stored === blank ? NaN : zero + scale * stored;
				}
			}
			return {
				width, height, channels: 1, data,
				numericDomain: { bitsPerSample, sampleFormat, ...domain, sourceNumericType },
				metadata: {
					format: 'FITS', hduIndex, bitpix, axes,
					bscale: scale, bzero: zero,
					object: header.OBJECT || undefined,
					unit: header.BUNIT || undefined,
					firstPlaneOnly: axes.slice(2).some(size => size > 1),
				},
				decodeTimings: [{ name: 'decode-fits-parse', durationMs: performance.now() - started }]
			};
		}

		const paddedDataBytes = Math.ceil(dataBytes / 2880) * 2880;
		hduOffset = dataOffset + paddedDataBytes;
		hduIndex++;
	}
	throw new Error('FITS file contains no supported 2D image HDU');
}

const LONG_VR = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'UC', 'UR', 'UT', 'UN']);

interface DicomElement { offset: number; length: number; vr: string; }
interface DicomEncoding { explicit: boolean; little: boolean; compressed?: 'jpeg-baseline'; }
interface DicomContext {
	bytes: Uint8Array;
	view: DataView;
	encoding: DicomEncoding;
	transferSyntax: string;
	tags: Map<number, DicomElement>;
	pixelTag: number;
	pixelOffset: number;
	pixelLength: number;
}

export interface DicomCompressedFrame {
	encoded: Uint8Array;
	width: number;
	height: number;
	channels: number;
	metadata: Record<string, any>;
	numericDomain: ScientificDecodedImage['numericDomain'];
}

function dicomElement(view: DataView, bytes: Uint8Array, offset: number, explicit: boolean, little: boolean) {
	if (offset + 8 > view.byteLength) { return null; }
	const group = view.getUint16(offset, little);
	const element = view.getUint16(offset + 2, little);
	let vr = '';
	let length: number;
	let valueOffset: number;
	if (explicit) {
		vr = ascii(bytes, offset + 4, 2);
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
	return { group, element, tag: (group << 16) | element, vr, length, valueOffset };
}

function findSequenceEnd(bytes: Uint8Array, start: number, little: boolean): number {
	const marker = little ? [0xfe, 0xff, 0xdd, 0xe0] : [0xff, 0xfe, 0xe0, 0xdd];
	for (let i = start; i + 8 <= bytes.length; i++) {
		if (bytes[i] === marker[0] && bytes[i + 1] === marker[1] && bytes[i + 2] === marker[2] && bytes[i + 3] === marker[3]) {
			return i + 8;
		}
	}
	throw new Error('Unsupported unterminated DICOM sequence');
}

function parseDicomContext(buffer: ArrayBuffer): DicomContext {
	const bytes = new Uint8Array(buffer);
	const view = new DataView(buffer);
	const hasPreamble = buffer.byteLength >= 132 && ascii(bytes, 128, 4) === 'DICM';
	let offset = hasPreamble ? 132 : 0;
	let transferSyntax = '1.2.840.10008.1.2';

	if (hasPreamble) {
		while (offset + 8 <= buffer.byteLength) {
			const el = dicomElement(view, bytes, offset, true, true);
			if (!el || el.group !== 0x0002) { break; }
			if (el.tag === 0x00020010) {
				transferSyntax = ascii(bytes, el.valueOffset, el.length).replace(/[\0 ]+$/g, '');
			}
			offset = el.valueOffset + el.length;
		}
	}

	const syntax: Record<string, DicomEncoding> = {
		'1.2.840.10008.1.2': { explicit: false, little: true },
		'1.2.840.10008.1.2.1': { explicit: true, little: true },
		'1.2.840.10008.1.2.2': { explicit: true, little: false },
		'1.2.840.10008.1.2.4.50': { explicit: true, little: true, compressed: 'jpeg-baseline' },
	};
	let encoding = syntax[transferSyntax];
	if (!hasPreamble) {
		const possibleVr = ascii(bytes, 4, 2);
		const explicit = /^[A-Z]{2}$/.test(possibleVr);
		encoding = { explicit, little: true };
	}
	if (!encoding) {
		throw new Error(`Compressed or unsupported DICOM Transfer Syntax: ${transferSyntax}`);
	}

	const tags = new Map<number, DicomElement>();
	let pixelTag = 0;
	let pixelOffset = 0;
	let pixelLength = 0;
	while (offset + 8 <= buffer.byteLength) {
		const el = dicomElement(view, bytes, offset, encoding.explicit, encoding.little);
		if (!el) { break; }
		if (el.tag === 0x7fe00010 || el.tag === 0x7fe00008 || el.tag === 0x7fe00009) {
			pixelTag = el.tag;
			pixelOffset = el.valueOffset;
			pixelLength = el.length;
			if (el.length !== 0xffffffff) { tags.set(el.tag, { offset: el.valueOffset, length: el.length, vr: el.vr }); }
			break;
		}
		if (el.length === 0xffffffff) {
			offset = findSequenceEnd(bytes, el.valueOffset, encoding.little);
			continue;
		}
		if (el.valueOffset + el.length > buffer.byteLength) { throw new Error('Truncated DICOM element'); }
		tags.set(el.tag, { offset: el.valueOffset, length: el.length, vr: el.vr });
		offset = el.valueOffset + el.length;
	}
	if (!pixelTag) { throw new Error('DICOM file has no Pixel Data'); }
	return { bytes, view, encoding, transferSyntax, tags, pixelTag, pixelOffset, pixelLength };
}

function dicomImageInfo(context: DicomContext) {
	const { bytes, view, encoding, tags, pixelTag, transferSyntax } = context;
	const get = (tag: number) => tags.get(tag);
	const uint16 = (tag: number, fallback: number) => {
		const el = get(tag); return el && el.length >= 2 ? view.getUint16(el.offset, encoding.little) : fallback;
	};
	const text = (tag: number, fallback = '') => {
		const el = get(tag); return el ? ascii(bytes, el.offset, el.length).replace(/[\0 ]+$/g, '') : fallback;
	};
	const decimal = (tag: number, fallback: number) => {
		const raw = text(tag).split('\\')[0].trim();
		return raw === '' ? fallback : finiteNumber(raw, fallback);
	};
	const rows = uint16(0x00280010, 0);
	const columns = uint16(0x00280011, 0);
	const samples = uint16(0x00280002, 1);
	const planar = uint16(0x00280006, 0);
	const bitsAllocated = uint16(0x00280100, pixelTag === 0x7fe00008 ? 32 : pixelTag === 0x7fe00009 ? 64 : 0);
	const bitsStored = uint16(0x00280101, bitsAllocated);
	const signed = uint16(0x00280103, 0) === 1;
	const frames = Math.max(1, Math.floor(decimal(0x00280008, 1)));
	const photometric = text(0x00280004, samples === 3 ? 'RGB' : 'MONOCHROME2');
	if (!rows || !columns || ![1, 3, 4].includes(samples)) { throw new Error('Unsupported DICOM image dimensions or samples per pixel'); }
	if (![8, 16, 32, 64].includes(bitsAllocated)) { throw new Error(`Unsupported DICOM Bits Allocated: ${bitsAllocated}`); }
	const slope = decimal(0x00281053, 1);
	const intercept = decimal(0x00281052, 0);
	const sampleFormat: 1 | 2 | 3 = pixelTag === 0x7fe00008 || pixelTag === 0x7fe00009 ? 3 : signed ? 2 : 1;
	const storedMin = sampleFormat === 3 ? 0 : signed ? -(2 ** (bitsStored - 1)) : 0;
	const storedMax = sampleFormat === 3 ? 1 : signed ? (2 ** (bitsStored - 1)) - 1 : (2 ** bitsStored) - 1;
	const domain = scaledDomain(storedMin, storedMax, slope, intercept);
	const sourceNumericType = (sampleFormat === 3
		? (bitsAllocated <= 32 ? 'float32' : 'float64')
		: `${signed ? 'int' : 'uint'}${bitsStored <= 8 ? 8 : bitsStored <= 16 ? 16 : 32}`) as ScientificDecodedImage['numericDomain']['sourceNumericType'];
	return {
		rows, columns, samples, planar, bitsAllocated, bitsStored, signed, frames, photometric,
		slope, intercept, numericDomain: {
			bitsPerSample: bitsStored,
			sampleFormat,
			...domain,
			sourceNumericType,
		},
		metadata: {
			format: 'DICOM', transferSyntax, photometric, bitsAllocated, bitsStored,
			signed, frames, rescaleSlope: slope, rescaleIntercept: intercept,
			windowCenter: decimal(0x00281050, NaN), windowWidth: decimal(0x00281051, NaN),
			modality: text(0x00080060) || undefined,
			pixelSpacing: text(0x00280030) || undefined,
			// Projection radiography (CR/DX/MG) has no Pixel Spacing at the patient,
			// only at the detector, so Imager Pixel Spacing is the only scale those
			// images carry. Kept separate rather than merged: the two are measured
			// in different planes and conflating them would misreport magnified
			// acquisitions.
			imagerPixelSpacing: text(0x00181164) || undefined,
			sliceThickness: text(0x00180050) || undefined,
			spacingBetweenSlices: text(0x00180088) || undefined,
		},
	};
}

/** Decode one native (uncompressed) DICOM frame. Patient-identifying tags are not retained. */
export function parseDicom(buffer: ArrayBuffer, frameIndex = 0): ScientificDecodedImage {
	const started = performance.now();
	const context = parseDicomContext(buffer);
	if (context.encoding.compressed) {
		throw new Error(`Compressed DICOM frame requires codec: ${context.encoding.compressed}`);
	}
	const { view, encoding, pixelTag, pixelOffset, pixelLength } = context;
	const info = dicomImageInfo(context);
	const { rows, columns, samples, planar, bitsAllocated, bitsStored, signed, frames, photometric, slope, intercept } = info;
	const safeFrame = Math.max(0, Math.min(frames - 1, Math.trunc(frameIndex)));
	const bytesPerSample = bitsAllocated / 8;
	const sampleCount = rows * columns * samples;
	const frameBytes = sampleCount * bytesPerSample;
	if (pixelLength < (safeFrame + 1) * frameBytes) { throw new Error('Truncated DICOM Pixel Data'); }
	const frameSampleOffset = safeFrame * sampleCount;
	const output = new Float32Array(sampleCount);
	const readSample = (sampleIndex: number): number => {
		const p = pixelOffset + (frameSampleOffset + sampleIndex) * bytesPerSample;
		if (pixelTag === 0x7fe00008) { return view.getFloat32(p, encoding.little); }
		if (pixelTag === 0x7fe00009) { return view.getFloat64(p, encoding.little); }
		if (bitsAllocated === 8) {
			let value = view.getUint8(p);
			if (signed && bitsStored < 8 && value >= 2 ** (bitsStored - 1)) { value -= 2 ** bitsStored; }
			else if (signed && bitsStored === 8) { value = view.getInt8(p); }
			return value;
		}
		if (bitsAllocated === 16) {
			let value = view.getUint16(p, encoding.little);
			if (bitsStored < 16) { value &= (2 ** bitsStored) - 1; }
			if (signed && value >= 2 ** (bitsStored - 1)) { value -= 2 ** bitsStored; }
			return value;
		}
		return signed ? view.getInt32(p, encoding.little) : view.getUint32(p, encoding.little);
	};
	for (let pixelIndex = 0; pixelIndex < rows * columns; pixelIndex++) {
		for (let channel = 0; channel < samples; channel++) {
			const sourceIndex = planar === 1 && samples > 1 ? channel * rows * columns + pixelIndex : pixelIndex * samples + channel;
			output[pixelIndex * samples + channel] = readSample(sourceIndex) * slope + intercept;
		}
	}
	if (photometric === 'MONOCHROME1') {
		let min = Infinity, max = -Infinity;
		for (const value of output) { if (value < min) min = value; if (value > max) max = value; }
		for (let i = 0; i < output.length; i++) { output[i] = max + min - output[i]; }
	}

	return {
		width: columns, height: rows, channels: samples === 4 ? 4 : samples, data: output,
		numericDomain: info.numericDomain,
		metadata: {
			...info.metadata,
			frameIndex: safeFrame,
		},
		decodeTimings: [{ name: 'decode-dicom-parse', durationMs: performance.now() - started }]
	};
}

function concatFragments(fragments: Uint8Array[]): Uint8Array {
	const length = fragments.reduce((sum, fragment) => sum + fragment.length, 0);
	const output = new Uint8Array(length);
	let offset = 0;
	for (const fragment of fragments) { output.set(fragment, offset); offset += fragment.length; }
	return output;
}

/** Extract one JPEG Baseline codestream from encapsulated DICOM Pixel Data. */
export function extractDicomJpegFrame(buffer: ArrayBuffer, frameIndex = 0): DicomCompressedFrame {
	const context = parseDicomContext(buffer);
	if (context.encoding.compressed !== 'jpeg-baseline') {
		throw new Error(`Unsupported compressed DICOM Transfer Syntax: ${context.transferSyntax}`);
	}
	const info = dicomImageInfo(context);
	const safeFrame = Math.max(0, Math.min(info.frames - 1, Math.trunc(frameIndex)));
	const { view, bytes } = context;
	let offset = context.pixelOffset;
	const readItem = () => {
		if (offset + 8 > view.byteLength || view.getUint16(offset, true) !== 0xfffe) { throw new Error('Invalid encapsulated DICOM Pixel Data item'); }
		const element = view.getUint16(offset + 2, true);
		const length = view.getUint32(offset + 4, true);
		const itemOffset = offset;
		offset += 8;
		if (length !== 0xffffffff && offset + length > view.byteLength) { throw new Error('Truncated encapsulated DICOM Pixel Data item'); }
		const data = length === 0xffffffff ? new Uint8Array() : bytes.subarray(offset, offset + length);
		if (length !== 0xffffffff) { offset += length; }
		return { element, length, itemOffset, data };
	};
	const bot = readItem();
	if (bot.element !== 0xe000) { throw new Error('DICOM Basic Offset Table is missing'); }
	const basicOffsets: number[] = [];
	for (let i = 0; i + 4 <= bot.data.length; i += 4) {
		basicOffsets.push(new DataView(bot.data.buffer, bot.data.byteOffset + i, 4).getUint32(0, true));
	}
	const firstFragmentOffset = offset;
	const fragments: { relativeOffset: number, data: Uint8Array }[] = [];
	while (offset + 8 <= view.byteLength) {
		const item = readItem();
		if (item.element === 0xe0dd) { break; }
		if (item.element !== 0xe000) { throw new Error('Unexpected DICOM encapsulated Pixel Data item'); }
		fragments.push({ relativeOffset: item.itemOffset - firstFragmentOffset, data: item.data });
	}
	if (fragments.length === 0) { throw new Error('DICOM JPEG Pixel Data contains no fragments'); }

	let selected: Uint8Array[];
	if (basicOffsets.length >= info.frames && basicOffsets.some(value => value !== 0)) {
		const start = basicOffsets[safeFrame];
		const end = safeFrame + 1 < basicOffsets.length ? basicOffsets[safeFrame + 1] : Number.MAX_SAFE_INTEGER;
		selected = fragments.filter(fragment => fragment.relativeOffset >= start && fragment.relativeOffset < end).map(fragment => fragment.data);
	} else if (fragments.length === info.frames) {
		selected = [fragments[safeFrame].data];
	} else {
		const joined = concatFragments(fragments.map(fragment => fragment.data));
		const frames: Uint8Array[] = [];
		let start = -1;
		for (let i = 0; i + 1 < joined.length; i++) {
			if (joined[i] === 0xff && joined[i + 1] === 0xd8) { start = i; }
			if (start >= 0 && joined[i] === 0xff && joined[i + 1] === 0xd9) { frames.push(joined.subarray(start, i + 2)); start = -1; i++; }
		}
		if (!frames[safeFrame]) { throw new Error(`Could not locate compressed DICOM frame ${safeFrame + 1}`); }
		selected = [frames[safeFrame]];
	}
	if (selected.length === 0) { throw new Error(`DICOM frame ${safeFrame + 1} has no JPEG fragments`); }
	return {
		encoded: concatFragments(selected),
		width: info.columns,
		height: info.rows,
		channels: info.samples,
		metadata: { ...info.metadata, frameIndex: safeFrame, compression: 'JPEG Baseline' },
		numericDomain: info.numericDomain,
	};
}

const NC_DIMENSION = 10;
const NC_VARIABLE = 11;
const NC_ATTRIBUTE = 12;
const NC_TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 };

class NetCdfReader {
	offset = 0;
	constructor(public view: DataView, public bytes: Uint8Array, public version: number) {}
	u32() { const value = this.view.getUint32(this.offset, false); this.offset += 4; return value; }
	u64() {
		const value = Number(this.view.getBigUint64(this.offset, false)); this.offset += 8;
		if (!Number.isSafeInteger(value)) { throw new Error('NetCDF offset exceeds JavaScript safe integer range'); }
		return value;
	}
	name() {
		const length = this.u32();
		const value = ascii(this.bytes, this.offset, length);
		this.offset += Math.ceil(length / 4) * 4;
		return value;
	}
	values(type: number, count: number): any[] {
		const size = NC_TYPE_SIZE[type];
		if (!size) { throw new Error(`Unsupported NetCDF type: ${type}`); }
		const values: any[] = [];
		for (let i = 0; i < count; i++) {
			const p = this.offset + i * size;
			switch (type) {
				case 1: values.push(this.view.getInt8(p)); break;
				case 2: values.push(String.fromCharCode(this.view.getUint8(p))); break;
				case 3: values.push(this.view.getInt16(p, false)); break;
				case 4: values.push(this.view.getInt32(p, false)); break;
				case 5: values.push(this.view.getFloat32(p, false)); break;
				case 6: values.push(this.view.getFloat64(p, false)); break;
			}
		}
		this.offset += Math.ceil((count * size) / 4) * 4;
		return values;
	}
	attributes(): Record<string, any> {
		const tag = this.u32();
		if (tag === 0) { this.u32(); return {}; }
		if (tag !== NC_ATTRIBUTE) { throw new Error('Invalid NetCDF attribute list'); }
		const count = this.u32();
		const attrs: Record<string, any> = {};
		for (let i = 0; i < count; i++) {
			const name = this.name();
			const type = this.u32();
			const length = this.u32();
			const values = this.values(type, length);
			attrs[name] = type === 2 ? values.join('').replace(/\0+$/g, '') : values.length === 1 ? values[0] : values;
		}
		return attrs;
	}
}

export interface NetCdfDecodeOptions {
	variableName?: string;
	indices?: Record<string, number>;
}

/** Decode classic NetCDF CDF-1/CDF-2 as either a regular raster or an MPAS cell mesh. */
export function parseNetCdf(buffer: ArrayBuffer, options: NetCdfDecodeOptions = {}): ScientificDecodedImage {
	const started = performance.now();
	const bytes = new Uint8Array(buffer);
	if (buffer.byteLength < 8 || ascii(bytes, 0, 3) !== 'CDF') {
		if (buffer.byteLength >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'HDF') {
			throw new Error('NetCDF-4/HDF5 is not supported yet; use classic NetCDF (CDF-1 or CDF-2)');
		}
		throw new Error('Invalid NetCDF signature');
	}
	const version = bytes[3];
	if (version !== 1 && version !== 2) { throw new Error(`Unsupported NetCDF format version: CDF-${version}`); }
	const reader = new NetCdfReader(new DataView(buffer), bytes, version);
	reader.offset = 4;
	const numRecords = reader.u32();
	const dimTag = reader.u32();
	const dimensions: { name: string, size: number, unlimited: boolean }[] = [];
	if (dimTag === 0) { reader.u32(); }
	else {
		if (dimTag !== NC_DIMENSION) { throw new Error('Invalid NetCDF dimension list'); }
		const count = reader.u32();
		for (let i = 0; i < count; i++) {
			const name = reader.name();
			const declaredSize = reader.u32();
			dimensions.push({ name, size: declaredSize || numRecords, unlimited: declaredSize === 0 });
		}
	}
	reader.attributes();
	const varTag = reader.u32();
	if (varTag === 0) { reader.u32(); throw new Error('NetCDF file contains no variables'); }
	if (varTag !== NC_VARIABLE) { throw new Error('Invalid NetCDF variable list'); }
	const variableCount = reader.u32();
	const variables: { name: string, dimIds: number[], attrs: Record<string, any>, type: number, vsize: number, begin: number }[] = [];
	for (let i = 0; i < variableCount; i++) {
		const name = reader.name();
		const dimCount = reader.u32();
		const dimIds: number[] = [];
		for (let d = 0; d < dimCount; d++) { dimIds.push(reader.u32()); }
		const attrs = reader.attributes();
		const type = reader.u32();
		const vsize = reader.u32();
		const begin = version === 1 ? reader.u32() : reader.u64();
		variables.push({ name, dimIds, attrs, type, vsize, begin });
	}
	const view = new DataView(buffer);
	const recordSize = variables
		.filter(variable => dimensions[variable.dimIds[0]]?.unlimited)
		.reduce((sum, variable) => sum + Math.ceil(variable.vsize / 4) * 4, 0);
	const variableByName = new Map(variables.map(variable => [variable.name, variable]));
	const variableDimensions = (variable: (typeof variables)[number]) => variable.dimIds.map(id => dimensions[id]);
	const storedValue = (variable: (typeof variables)[number], indices: number[]): number => {
		const dims = variableDimensions(variable);
		const typeSize = NC_TYPE_SIZE[variable.type];
		const isRecord = dims[0]?.unlimited;
		let linear = 0;
		for (let i = isRecord ? 1 : 0; i < dims.length; i++) {
			linear = linear * dims[i].size + Math.max(0, Math.min(dims[i].size - 1, Math.trunc(indices[i] || 0)));
		}
		const recordIndex = isRecord ? Math.max(0, Math.min(dims[0].size - 1, Math.trunc(indices[0] || 0))) : 0;
		const p = variable.begin + recordIndex * recordSize + linear * typeSize;
		if (p < 0 || p + typeSize > buffer.byteLength) { throw new Error(`Truncated NetCDF variable data: ${variable.name}`); }
		let stored: number;
		switch (variable.type) {
			case 1: stored = view.getInt8(p); break;
			case 3: stored = view.getInt16(p, false); break;
			case 4: stored = view.getInt32(p, false); break;
			case 5: stored = view.getFloat32(p, false); break;
			case 6: stored = view.getFloat64(p, false); break;
			default: throw new Error(`Unsupported NetCDF variable type: ${variable.type}`);
		}
		const fillValues = [variable.attrs._FillValue, variable.attrs.missing_value]
			.flat().filter((value: any) => typeof value === 'number');
		if (fillValues.some((value: number) => stored === value)) { return NaN; }
		return stored * finiteNumber(variable.attrs.scale_factor, 1) + finiteNumber(variable.attrs.add_offset, 0);
	};

	const isNumeric = (variable: (typeof variables)[number]) => variable.type !== 2 && !!NC_TYPE_SIZE[variable.type];
	const cellDimension = dimensions.findIndex(dimension => dimension.name === 'nCells');
	const hasMpasGeometry = cellDimension >= 0 && ['latVertex', 'lonVertex', 'verticesOnCell', 'nEdgesOnCell']
		.every(name => variableByName.has(name));
	const topologyName = /^(?:lat|lon|x|y|z)Cell$|^indexToCellID$|^(?:cells|edges|vertices)OnCell$|^nEdgesOnCell$/i;
	const meshVariables = hasMpasGeometry ? variables.filter(variable =>
		isNumeric(variable) && variable.dimIds.includes(cellDimension) && !topologyName.test(variable.name)
	) : [];
	const rasterVariables = variables.filter(variable => {
		if (!isNumeric(variable) || variable.dimIds.length < 2 || topologyName.test(variable.name)) { return false; }
		const dims = variableDimensions(variable);
		return dims[dims.length - 1]?.size > 1 && dims[dims.length - 2]?.size > 1;
	});
	const candidates = meshVariables.length > 0 ? meshVariables : rasterVariables;
	if (candidates.length === 0) {
		throw new Error('NetCDF file contains no supported raster or MPAS cell variable');
	}
	const preferredMeshNames = ['areaCell', 'h_s', 'h', 'ke', 'tracers'];
	const selected = candidates.find(variable => variable.name === options.variableName)
		|| (meshVariables.length > 0 ? preferredMeshNames.map(name => variableByName.get(name)).find(variable => variable && meshVariables.includes(variable)) : undefined)
		|| candidates[0];
	const selectedBits = NC_TYPE_SIZE[selected.type] * 8;
	const selectedSampleFormat: 1 | 2 | 3 = selected.type >= 5 ? 3 : 2;
	const selectedScale = finiteNumber(selected.attrs.scale_factor, 1);
	const selectedOffset = finiteNumber(selected.attrs.add_offset, 0);
	const selectedStoredMin = selectedSampleFormat === 3 ? 0 : -(2 ** (selectedBits - 1));
	const selectedStoredMax = selectedSampleFormat === 3 ? 1 : (2 ** (selectedBits - 1)) - 1;
	const selectedDomain = scaledDomain(selectedStoredMin, selectedStoredMax, selectedScale, selectedOffset);
	const selectedSourceNumericType = (selectedSampleFormat === 3
		? (selectedBits <= 32 ? 'float32' : 'float64')
		: selectedBits <= 8 ? 'int8' : selectedBits <= 16 ? 'int16' : 'int32') as ScientificDecodedImage['numericDomain']['sourceNumericType'];
	const numericDomain: ScientificDecodedImage['numericDomain'] = {
		bitsPerSample: selectedBits,
		sampleFormat: selectedSampleFormat,
		...selectedDomain,
		sourceNumericType: selectedSourceNumericType,
	};
	const selectedDimensions = variableDimensions(selected);
	const selectedIndices = Object.fromEntries(selectedDimensions.map(dimension => [
		dimension.name,
		Math.max(0, Math.min(dimension.size - 1, Math.trunc(options.indices?.[dimension.name] || 0))),
	]));
	const variableChoices = candidates.map(variable => ({
		name: variable.name,
		label: String(variable.attrs.long_name || variable.name),
		dimensions: variableDimensions(variable).map(dimension => ({ name: dimension.name, size: dimension.size })),
		unit: variable.attrs.units,
	}));

	if (meshVariables.includes(selected)) {
		const cellAxis = selected.dimIds.indexOf(cellDimension);
		const selectors = selectedDimensions.filter((_, index) => index !== cellAxis).map(dimension => ({
			name: dimension.name, size: dimension.size, value: selectedIndices[dimension.name],
		}));
		const cellValues = new Float32Array(dimensions[cellDimension].size);
		for (let cell = 0; cell < cellValues.length; cell++) {
			const indices = selectedDimensions.map((dimension, index) => index === cellAxis ? cell : selectedIndices[dimension.name]);
			cellValues[cell] = storedValue(selected, indices);
		}
		const latVertexVariable = variableByName.get('latVertex')!;
		const lonVertexVariable = variableByName.get('lonVertex')!;
		const verticesOnCellVariable = variableByName.get('verticesOnCell')!;
		const nEdgesOnCellVariable = variableByName.get('nEdgesOnCell')!;
		const vertexCount = variableDimensions(latVertexVariable)[0].size;
		const maxEdges = variableDimensions(verticesOnCellVariable)[1].size;
		const latitudes = new Float64Array(vertexCount);
		const longitudes = new Float64Array(vertexCount);
		for (let vertex = 0; vertex < vertexCount; vertex++) {
			latitudes[vertex] = storedValue(latVertexVariable, [vertex]);
			longitudes[vertex] = storedValue(lonVertexVariable, [vertex]);
		}
		const angularScale = Math.max(...Array.from(latitudes, Math.abs)) > Math.PI ? Math.PI / 180 : 1;
		const width = 720, height = 360;
		const data = new Float32Array(width * height); data.fill(NaN);
		const fillPolygon = (points: Array<{ x: number, y: number }>, value: number) => {
			if (points.length < 3 || !Number.isFinite(value)) { return; }
			for (const shift of [-width, 0, width]) {
				const shifted = points.map(point => ({ x: point.x + shift, y: point.y }));
				const minY = Math.max(0, Math.floor(Math.min(...shifted.map(point => point.y))));
				const maxY = Math.min(height - 1, Math.ceil(Math.max(...shifted.map(point => point.y))));
				for (let y = minY; y <= maxY; y++) {
					const scanY = y + 0.5;
					const intersections: number[] = [];
					for (let i = 0, previous = shifted.length - 1; i < shifted.length; previous = i++) {
						const a = shifted[previous], b = shifted[i];
						if ((a.y > scanY) !== (b.y > scanY)) { intersections.push(a.x + (scanY - a.y) * (b.x - a.x) / (b.y - a.y)); }
					}
					intersections.sort((a, b) => a - b);
					for (let pair = 0; pair + 1 < intersections.length; pair += 2) {
						const from = Math.max(0, Math.ceil(intersections[pair]));
						const to = Math.min(width - 1, Math.floor(intersections[pair + 1]));
						for (let x = from; x <= to; x++) { data[y * width + x] = value; }
					}
				}
			}
		};
		for (let cell = 0; cell < cellValues.length; cell++) {
			const edgeCount = Math.max(0, Math.min(maxEdges, Math.trunc(storedValue(nEdgesOnCellVariable, [cell]))));
			const points: Array<{ x: number, y: number }> = [];
			for (let edge = 0; edge < edgeCount; edge++) {
				const vertex = Math.trunc(storedValue(verticesOnCellVariable, [cell, edge])) - 1;
				if (vertex < 0 || vertex >= vertexCount) { continue; }
				const lon = longitudes[vertex] * angularScale;
				const lat = latitudes[vertex] * angularScale;
				let x = ((lon + Math.PI) / (2 * Math.PI)) * width;
				const y = ((Math.PI / 2 - lat) / Math.PI) * height;
				if (points.length > 0) {
					while (x - points[0].x > width / 2) { x -= width; }
					while (x - points[0].x < -width / 2) { x += width; }
				}
				points.push({ x, y });
			}
			fillPolygon(points, cellValues[cell]);
		}
		return {
			width, height, channels: 1, data,
			numericDomain,
			metadata: {
				format: `NetCDF CDF-${version}`, variable: selected.name,
				unit: selected.attrs.units, longName: selected.attrs.long_name,
				viewMode: 'mpas-mesh', projection: 'Equirectangular', meshLocation: 'nCells',
				variables: variableChoices, selectors, selectedIndices,
			},
			decodeTimings: [{ name: 'decode-netcdf-parse', durationMs: performance.now() - started }]
		};
	}

	const width = selectedDimensions[selectedDimensions.length - 1].size;
	const height = selectedDimensions[selectedDimensions.length - 2].size;
	const selectors = selectedDimensions.slice(0, -2).map(dimension => ({
		name: dimension.name, size: dimension.size, value: selectedIndices[dimension.name],
	}));
	const data = new Float32Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const indices = selectedDimensions.map((dimension, index) => index === selectedDimensions.length - 2 ? y
				: index === selectedDimensions.length - 1 ? x : selectedIndices[dimension.name]);
			data[y * width + x] = storedValue(selected, indices);
		}
	}
	return {
		width, height, channels: 1, data,
		numericDomain,
		metadata: {
			format: `NetCDF CDF-${version}`,
			variable: selected.name,
			dimensions: selectedDimensions.map(dimension => ({ name: dimension.name, size: dimension.size })),
			unit: selected.attrs.units,
			longName: selected.attrs.long_name,
			viewMode: 'raster', variables: variableChoices, selectors, selectedIndices,
		},
		decodeTimings: [{ name: 'decode-netcdf-parse', durationMs: performance.now() - started }]
	};
}

// ---------------------------------------------------------------------------
// Zeiss CZI (ZISRAW)
// ---------------------------------------------------------------------------

export interface CziDecodeOptions {
	/** Plane coordinate per non-spatial axis, e.g. `{ Z: 4, C: 1 }`. */
	indices?: Record<string, number>;
}

interface CziDimension { start: number, size: number, storedSize: number }

interface CziDirectoryEntry {
	pixelType: number;
	filePosition: number;
	compression: number;
	dimensions: Record<string, CziDimension>;
	/** Byte length of the entry itself, so callers can walk the directory. */
	byteLength: number;
}

/** Pixel layout per CZI PixelType id. `bgr` marks the channel-reversed types. */
const CZI_PIXEL_TYPES: Record<number, {
	name: string,
	channels: number,
	bgr: boolean,
	bytesPerChannel: number,
	read: (view: DataView, offset: number) => number,
	domain: ScientificDecodedImage['numericDomain'],
}> = {
	0: { name: 'Gray8', channels: 1, bgr: false, bytesPerChannel: 1, read: (v, o) => v.getUint8(o), domain: { bitsPerSample: 8, sampleFormat: 1, typeMin: 0, typeMax: 255, sourceNumericType: 'uint8' } },
	1: { name: 'Gray16', channels: 1, bgr: false, bytesPerChannel: 2, read: (v, o) => v.getUint16(o, true), domain: { bitsPerSample: 16, sampleFormat: 1, typeMin: 0, typeMax: 65535, sourceNumericType: 'uint16' } },
	2: { name: 'Gray32Float', channels: 1, bgr: false, bytesPerChannel: 4, read: (v, o) => v.getFloat32(o, true), domain: { bitsPerSample: 32, sampleFormat: 3, typeMin: 0, typeMax: 1, sourceNumericType: 'float32' } },
	3: { name: 'Bgr24', channels: 3, bgr: true, bytesPerChannel: 1, read: (v, o) => v.getUint8(o), domain: { bitsPerSample: 8, sampleFormat: 1, typeMin: 0, typeMax: 255, sourceNumericType: 'uint8' } },
	4: { name: 'Bgr48', channels: 3, bgr: true, bytesPerChannel: 2, read: (v, o) => v.getUint16(o, true), domain: { bitsPerSample: 16, sampleFormat: 1, typeMin: 0, typeMax: 65535, sourceNumericType: 'uint16' } },
	8: { name: 'Bgr96Float', channels: 3, bgr: true, bytesPerChannel: 4, read: (v, o) => v.getFloat32(o, true), domain: { bitsPerSample: 32, sampleFormat: 3, typeMin: 0, typeMax: 1, sourceNumericType: 'float32' } },
	9: { name: 'Bgra32', channels: 4, bgr: true, bytesPerChannel: 1, read: (v, o) => v.getUint8(o), domain: { bitsPerSample: 8, sampleFormat: 1, typeMin: 0, typeMax: 255, sourceNumericType: 'uint8' } },
	12: { name: 'Gray32', channels: 1, bgr: false, bytesPerChannel: 4, read: (v, o) => v.getInt32(o, true), domain: { bitsPerSample: 32, sampleFormat: 2, typeMin: -2147483648, typeMax: 2147483647, sourceNumericType: 'int32' } },
	13: { name: 'Gray64', channels: 1, bgr: false, bytesPerChannel: 8, read: (v, o) => v.getFloat64(o, true), domain: { bitsPerSample: 32, sampleFormat: 3, typeMin: 0, typeMax: 1, sourceNumericType: 'float64' } },
};

const CZI_COMPRESSION_NAMES: Record<number, string> = {
	1: 'JPEG', 2: 'LZW', 4: 'JPEG XR', 5: 'Zstd-0', 6: 'Zstd-1',
};

/** Axis order used for the plane selector UI; unknown axes are appended. */
const CZI_AXIS_ORDER = ['S', 'I', 'V', 'H', 'R', 'T', 'C', 'Z', 'B', 'M'];

function cziSegment(bytes: Uint8Array, view: DataView, position: number): { id: string, dataStart: number, usedSize: number } {
	if (position < 0 || position + 32 > bytes.length) { throw new Error(`CZI segment out of range at ${position}`); }
	return {
		id: ascii(bytes, position, 16).replace(/\0+$/, ''),
		dataStart: position + 32,
		usedSize: Number(view.getBigInt64(position + 24, true)),
	};
}

/** Parse a DirectoryEntryDV: 32 fixed bytes plus 20 bytes per dimension entry. */
function cziDirectoryEntry(bytes: Uint8Array, view: DataView, offset: number): CziDirectoryEntry {
	const dimensionCount = view.getInt32(offset + 28, true);
	if (dimensionCount < 0 || dimensionCount > 64) { throw new Error(`Invalid CZI dimension count: ${dimensionCount}`); }
	const dimensions: Record<string, CziDimension> = {};
	for (let i = 0; i < dimensionCount; i++) {
		const entry = offset + 32 + i * 20;
		const name = ascii(bytes, entry, 4).replace(/\0/g, '').trim();
		if (!name) { continue; }
		dimensions[name] = {
			start: view.getInt32(entry + 4, true),
			size: view.getInt32(entry + 8, true),
			storedSize: view.getInt32(entry + 16, true) || view.getInt32(entry + 8, true),
		};
	}
	return {
		pixelType: view.getInt32(offset + 2, true),
		filePosition: Number(view.getBigInt64(offset + 6, true)),
		compression: view.getInt32(offset + 18, true),
		dimensions,
		byteLength: 32 + dimensionCount * 20,
	};
}

/** Read the subblock directory, falling back to a sequential segment scan. */
function cziSubBlockEntries(bytes: Uint8Array, view: DataView, directoryPosition: number): CziDirectoryEntry[] {
	const entries: CziDirectoryEntry[] = [];
	if (directoryPosition > 0 && directoryPosition + 32 < bytes.length) {
		const segment = cziSegment(bytes, view, directoryPosition);
		if (segment.id === 'ZISRAWDIRECTORY') {
			const count = view.getInt32(segment.dataStart, true);
			// EntryCount (4 bytes) is followed by 124 reserved bytes.
			let offset = segment.dataStart + 128;
			for (let i = 0; i < count; i++) {
				const entry = cziDirectoryEntry(bytes, view, offset);
				entries.push(entry);
				offset += entry.byteLength;
			}
			if (entries.length) { return entries; }
		}
	}
	// Fallback: walk every segment and pick up the subblocks directly.
	let position = 0;
	while (position + 32 <= bytes.length) {
		const segment = cziSegment(bytes, view, position);
		if (!segment.id) { break; }
		const allocated = Number(view.getBigInt64(position + 16, true));
		if (segment.id === 'ZISRAWSUBBLOCK') {
			const entry = cziDirectoryEntry(bytes, view, segment.dataStart + 16);
			entry.filePosition = position;
			entries.push(entry);
		}
		if (allocated <= 0) { break; }
		position = segment.dataStart + allocated;
	}
	return entries;
}

/** Pull the handful of display-relevant fields out of the ZISRAWMETADATA XML. */
function cziXmlMetadata(xml: string): Record<string, any> {
	const text = (tag: string): string | undefined => {
		const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
		return match ? match[1].trim() : undefined;
	};
	const metadata: Record<string, any> = {};
	const name = text('Name');
	if (name) { metadata.documentName = name; }
	// Scaling is metres per pixel; report micrometres, which is the working unit here.
	for (const axis of ['X', 'Y', 'Z']) {
		const value = Number(text(`Scaling${axis}`));
		if (Number.isFinite(value) && value > 0) { metadata[`scaling${axis}Um`] = value * 1e6; }
	}
	const channelNames: string[] = [];
	for (const block of xml.split(/<Channel[\s>]/i).slice(1)) {
		const dye = block.match(/<(?:DyeName|Fluor|Name)[^>]*>([^<]*)</i);
		channelNames.push(dye ? dye[1].trim() : `Channel ${channelNames.length + 1}`);
	}
	// Channels are listed once per XML section (acquisition and display setting),
	// so keep only the first SizeC entries rather than every repetition.
	const sizeC = Number(text('SizeC'));
	if (channelNames.length) {
		metadata.channelNames = Number.isFinite(sizeC) && sizeC > 0 ? channelNames.slice(0, sizeC) : channelNames;
	}
	return metadata;
}

/**
 * Decode a Zeiss CZI plane.
 *
 * CZI stores each plane (and each mosaic tile) as an independent subblock keyed
 * by dimension coordinates, so decoding means picking the subblocks matching the
 * requested Z/C/T/... coordinate and blitting them into one raster. Only
 * uncompressed subblocks are handled; compressed variants report which codec the
 * file needs. Pyramid (subsampled) subblocks are skipped so the full-resolution
 * plane is always what gets assembled.
 */
export function parseCzi(buffer: ArrayBuffer, options: CziDecodeOptions = {}): ScientificDecodedImage {
	const started = performance.now();
	const bytes = new Uint8Array(buffer);
	const view = new DataView(buffer);
	if (buffer.byteLength < 32 || ascii(bytes, 0, 10) !== 'ZISRAWFILE') {
		throw new Error('Invalid CZI signature');
	}
	const header = cziSegment(bytes, view, 0).dataStart;
	const filePart = view.getInt32(header + 0x30, true);
	if (filePart !== 0) { throw new Error('Multi-file CZI sets are not supported; open the master file (part 0)'); }
	const directoryPosition = Number(view.getBigInt64(header + 0x34, true));
	const metadataPosition = Number(view.getBigInt64(header + 0x3c, true));

	let xmlMetadata: Record<string, any> = {};
	if (metadataPosition > 0 && metadataPosition + 32 < bytes.length) {
		const segment = cziSegment(bytes, view, metadataPosition);
		if (segment.id === 'ZISRAWMETADATA') {
			const xmlSize = view.getInt32(segment.dataStart, true);
			if (xmlSize > 0) {
				// Fixed part of the metadata segment is 256 bytes; the XML follows.
				const start = segment.dataStart + 256;
				const xml = new TextDecoder('utf-8').decode(bytes.subarray(start, Math.min(bytes.length, start + xmlSize)));
				try { xmlMetadata = cziXmlMetadata(xml); } catch { xmlMetadata = {}; }
			}
		}
	}

	const allEntries = cziSubBlockEntries(bytes, view, directoryPosition);
	if (!allEntries.length) { throw new Error('CZI file contains no image subblocks'); }
	// Pyramid levels store a downscaled copy of the same coordinate; keep full res.
	const entries = allEntries.filter(entry => {
		const x = entry.dimensions.X, y = entry.dimensions.Y;
		return x && y && x.size === x.storedSize && y.size === y.storedSize;
	});
	if (!entries.length) { throw new Error('CZI file contains no full-resolution subblocks'); }

	const pixelType = CZI_PIXEL_TYPES[entries[0].pixelType];
	if (!pixelType) { throw new Error(`Unsupported CZI pixel type: ${entries[0].pixelType}`); }

	// Axis extents across every subblock, spatial axes excluded.
	const axes: Record<string, { min: number, max: number }> = {};
	for (const entry of entries) {
		for (const [name, dimension] of Object.entries(entry.dimensions)) {
			if (name === 'X' || name === 'Y') { continue; }
			const axis = axes[name] || (axes[name] = { min: Infinity, max: -Infinity });
			axis.min = Math.min(axis.min, dimension.start);
			axis.max = Math.max(axis.max, dimension.start + Math.max(1, dimension.size) - 1);
		}
	}
	// Mosaic tiles share a coordinate, so M selects nothing the user cares about.
	delete axes.M;

	const requested: Record<string, number> = {};
	for (const [name, axis] of Object.entries(axes)) {
		const wanted = Number(options.indices?.[name]);
		const offset = Number.isFinite(wanted) ? Math.round(wanted) : 0;
		requested[name] = Math.min(axis.max, Math.max(axis.min, axis.min + offset));
	}

	const selected = entries.filter(entry => Object.entries(requested).every(([name, value]) => {
		const dimension = entry.dimensions[name];
		if (!dimension) { return true; }
		return value >= dimension.start && value < dimension.start + Math.max(1, dimension.size);
	}));
	if (!selected.length) { throw new Error('No CZI subblock matches the requested plane'); }

	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const entry of selected) {
		minX = Math.min(minX, entry.dimensions.X.start);
		minY = Math.min(minY, entry.dimensions.Y.start);
		maxX = Math.max(maxX, entry.dimensions.X.start + entry.dimensions.X.size);
		maxY = Math.max(maxY, entry.dimensions.Y.start + entry.dimensions.Y.size);
	}
	const width = maxX - minX;
	const height = maxY - minY;
	if (!(width > 0 && height > 0)) { throw new Error('CZI plane has an empty extent'); }
	const channels = pixelType.channels;
	const data = new Float32Array(width * height * channels);

	for (const entry of selected) {
		if (entry.compression !== 0) {
			const codec = CZI_COMPRESSION_NAMES[entry.compression] || `id ${entry.compression}`;
			throw new Error(`Compressed CZI is not supported yet (${codec}); only uncompressed subblocks decode`);
		}
		if (entry.pixelType !== entries[0].pixelType) { throw new Error('Mixed pixel types in one CZI plane'); }
		const segment = cziSegment(bytes, view, entry.filePosition);
		if (segment.id !== 'ZISRAWSUBBLOCK') { throw new Error(`Expected ZISRAWSUBBLOCK at ${entry.filePosition}, found "${segment.id}"`); }
		const metadataSize = view.getInt32(segment.dataStart, true);
		const inlineEntry = cziDirectoryEntry(bytes, view, segment.dataStart + 16);
		// The fixed part of a subblock header is padded to at least 256 bytes.
		const fixedSize = Math.max(256, 16 + inlineEntry.byteLength);
		let pixels = segment.dataStart + fixedSize + Math.max(0, metadataSize);
		const tileWidth = entry.dimensions.X.size;
		const tileHeight = entry.dimensions.Y.size;
		const stride = tileWidth * channels * pixelType.bytesPerChannel;
		if (pixels + stride * tileHeight > bytes.length) { throw new Error('CZI subblock data is truncated'); }
		const originX = entry.dimensions.X.start - minX;
		const originY = entry.dimensions.Y.start - minY;
		for (let row = 0; row < tileHeight; row++) {
			let source = pixels + row * stride;
			let target = ((originY + row) * width + originX) * channels;
			for (let column = 0; column < tileWidth; column++) {
				for (let channel = 0; channel < channels; channel++) {
					const value = pixelType.read(view, source + channel * pixelType.bytesPerChannel);
					// BGR(A) types are stored channel-reversed for the colour triple.
					const index = pixelType.bgr && channel < 3 ? 2 - channel : channel;
					data[target + index] = value;
				}
				source += channels * pixelType.bytesPerChannel;
				target += channels;
			}
		}
	}

	const selectors = CZI_AXIS_ORDER
		.concat(Object.keys(axes).filter(name => !CZI_AXIS_ORDER.includes(name)))
		.filter(name => axes[name])
		.map(name => ({
			name,
			size: axes[name].max - axes[name].min + 1,
			value: requested[name] - axes[name].min,
		}))
		.filter(selector => selector.size > 1);

	const channelIndex = axes.C ? requested.C - axes.C.min : 0;
	const channelNames: string[] | undefined = xmlMetadata.channelNames;

	return {
		width,
		height,
		channels,
		data,
		metadata: {
			...xmlMetadata,
			format: 'CZI',
			pixelTypeName: pixelType.name,
			subBlockCount: entries.length,
			tileCount: selected.length,
			selectors,
			selectedIndices: Object.fromEntries(selectors.map(selector => [selector.name, selector.value])),
			channelName: channelNames?.[channelIndex],
		},
		numericDomain: pixelType.domain,
		decodeTimings: [{ name: 'decode-czi-parse', durationMs: performance.now() - started }],
	};
}

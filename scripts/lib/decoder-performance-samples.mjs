import fs from 'node:fs';
import path from 'node:path';
import UPNG from 'upng-js';

function patternedValue(index) {
	return ((index * 251 + (index >>> 7) * 17) & 0xffff) / 65535;
}

export function makePpm16(width, height, channels = 3) {
	const magic = channels === 3 ? 'P6' : 'P5';
	const header = Buffer.from(`${magic}\n${width} ${height}\n65535\n`, 'ascii');
	const samples = width * height * channels;
	const bytes = Buffer.allocUnsafe(header.length + samples * 2);
	header.copy(bytes);
	for (let i = 0, offset = header.length; i < samples; i++, offset += 2) {
		bytes.writeUInt16BE(Math.round(patternedValue(i) * 65535), offset);
	}
	return bytes;
}

export function makeNpyF32(width, height) {
	const dict = `{'descr': '<f4', 'fortran_order': False, 'shape': (${height}, ${width}), }`;
	const prefixLength = 10;
	const padding = (16 - ((prefixLength + dict.length + 1) % 16)) % 16;
	const headerText = `${dict}${' '.repeat(padding)}\n`;
	const header = Buffer.from(headerText, 'ascii');
	const bytes = Buffer.allocUnsafe(prefixLength + header.length + width * height * 4);
	bytes.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0], 0);
	bytes.writeUInt16LE(header.length, 8);
	header.copy(bytes, prefixLength);
	for (let i = 0, offset = prefixLength + header.length; i < width * height; i++, offset += 4) {
		bytes.writeFloatLE(patternedValue(i) * 4 - 2, offset);
	}
	return bytes;
}

export function makePfm(width, height) {
	const header = Buffer.from(`Pf\n${width} ${height}\n-1.0\n`, 'ascii');
	const bytes = Buffer.allocUnsafe(header.length + width * height * 4);
	for (let i = 0, offset = header.length; i < width * height; i++, offset += 4) {
		bytes.writeFloatLE(patternedValue(i), offset);
	}
	header.copy(bytes);
	return bytes;
}

export function makePng8(width, height) {
	const rgba = new Uint8Array(width * height * 4);
	for (let pixel = 0; pixel < width * height; pixel++) {
		const value = Math.round(patternedValue(pixel) * 255);
		const offset = pixel * 4;
		rgba[offset] = value;
		rgba[offset + 1] = (value * 3 + 17) & 0xff;
		rgba[offset + 2] = (value * 7 + 41) & 0xff;
		rgba[offset + 3] = 255;
	}
	return Buffer.from(UPNG.encode([rgba.buffer], width, height, 0));
}

export function syntheticPerformanceSamples(width, height = width) {
	return [
		{ id: 'ppm-rgb16', extension: 'ppm', format: 'ppm', bytes: makePpm16(width, height, 3) },
		{ id: 'pgm-u16', extension: 'pgm', format: 'ppm', bytes: makePpm16(width, height, 1) },
		{ id: 'npy-f32', extension: 'npy', format: 'npy', bytes: makeNpyF32(width, height) },
		{ id: 'pfm-f32', extension: 'pfm', format: 'pfm', bytes: makePfm(width, height) },
	];
}

export function syntheticVsCodePerformanceSamples(width, height = width) {
	return [
		...syntheticPerformanceSamples(width, height),
		{ id: 'png-rgb8', extension: 'png', bytes: makePng8(width, height) },
	];
}

export function writeSyntheticPerformanceSamples(directory, width, height = width) {
	fs.mkdirSync(directory, { recursive: true });
	return syntheticPerformanceSamples(width, height).map(sample => {
		const file = path.join(directory, `${sample.id}-${width}x${height}.${sample.extension}`);
		fs.writeFileSync(file, sample.bytes);
		return { ...sample, file };
	});
}

export function writeSyntheticVsCodePerformanceSamples(directory, width, height = width) {
	fs.mkdirSync(directory, { recursive: true });
	return syntheticVsCodePerformanceSamples(width, height).map(sample => {
		const file = path.join(directory, `${sample.id}-${width}x${height}.${sample.extension}`);
		fs.writeFileSync(file, sample.bytes);
		return { ...sample, file };
	});
}

"use strict";

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Zero-copy hot paths for formats whose native representation already matches
 * a JavaScript TypedArray. These deliberately cover only the common binary
 * cases; callers retain the full Rust decoder as the compatibility fallback.
 */

function isWhitespace(byte: number): boolean {
	return byte === 9 || byte === 10 || byte === 13 || byte === 32;
}

function netpbmTokens(bytes: Uint8Array): { tokens: string[], rasterOffset: number } | null {
	const tokens: string[] = [];
	let offset = 0;
	while (tokens.length < 4) {
		while (offset < bytes.length) {
			if (bytes[offset] === 35) {
				while (offset < bytes.length && bytes[offset] !== 10 && bytes[offset] !== 13) offset++;
			} else if (isWhitespace(bytes[offset])) offset++;
			else break;
		}
		const start = offset;
		while (offset < bytes.length && !isWhitespace(bytes[offset]) && bytes[offset] !== 35) offset++;
		if (start === offset) throw new Error('Invalid NetPBM header');
		tokens.push(String.fromCharCode(...bytes.subarray(start, offset)));
	}
	// Binary NetPBM has exactly one whitespace separator after maxval. CRLF is
	// one logical separator and is common in files produced on Windows.
	if (bytes[offset] === 13 && bytes[offset + 1] === 10) offset += 2;
	else if (isWhitespace(bytes[offset])) offset++;
	else return null;
	return { tokens, rasterOffset: offset };
}

export function decodeBinaryNetpbmFast(buffer: ArrayBuffer) {
	if (!IS_LITTLE_ENDIAN) return null;
	const started = performance.now();
	const bytes = new Uint8Array(buffer);
	if (bytes.length < 2 || bytes[0] !== 80 || (bytes[1] !== 53 && bytes[1] !== 54)) return null;
	const header = netpbmTokens(bytes);
	if (!header) return null;
	const { tokens, rasterOffset } = header;
	const [magic, widthText, heightText, maxText] = tokens;
	if (magic !== 'P5' && magic !== 'P6') return null;
	const width = Number(widthText), height = Number(heightText), maxval = Number(maxText);
	const channels = magic === 'P6' ? 3 : 1;
	if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0 ||
		!Number.isInteger(maxval) || maxval < 1 || maxval > 65535) throw new Error('Invalid NetPBM dimensions or maxval');
	const samples = width * height * channels;
	const bytesPerSample = maxval > 255 ? 2 : 1;
	const rasterBytes = samples * bytesPerSample;
	if (!Number.isSafeInteger(rasterBytes) || rasterOffset + rasterBytes > buffer.byteLength) {
		throw new Error('Insufficient data for binary PPM/PGM');
	}
	let data: Uint8Array | Uint16Array;
	if (bytesPerSample === 1) {
		data = bytes.subarray(rasterOffset, rasterOffset + rasterBytes);
	} else {
		// A Uint16Array requires alignment. Compact within the transferred source
		// buffer, then swap two samples per u32. This avoids both a second raster
		// allocation and the WASM linear-memory round trip.
		bytes.copyWithin(0, rasterOffset, rasterOffset + rasterBytes);
		const pairs = new Uint32Array(buffer, 0, Math.floor(rasterBytes / 4));
		for (let i = 0; i < pairs.length; i++) {
			const value = pairs[i];
			pairs[i] = ((value & 0x00ff00ff) << 8) | ((value & 0xff00ff00) >>> 8);
		}
		data = new Uint16Array(buffer, 0, samples);
		if ((samples & 1) !== 0) {
			const i = samples - 1;
			const value = data[i];
			data[i] = ((value & 0xff) << 8) | (value >>> 8);
		}
	}
	return {
		width, height, channels, data,
		numericDomain: {
			bitsPerSample: maxval > 255 ? 16 : 8,
			sampleFormat: 1,
			typeMin: 0,
			typeMax: maxval,
			sourceNumericType: maxval > 255 ? 'uint16' : 'uint8',
		},
		stats: undefined as { min: number, max: number } | undefined,
		formatLabel: magic === 'P6' ? 'PPM (Binary)' : 'PGM (Binary)',
		decodedWith: 'javascript-zero-copy (worker)',
		decodeTimings: [{ name: 'decode-ppm-js-zero-copy', durationMs: performance.now() - started }],
	};
}

function parseNpyHeader(buffer: ArrayBuffer) {
	const view = new DataView(buffer);
	if (buffer.byteLength < 10 || view.getUint32(0, false) !== 0x934e554d || view.getUint16(4, false) !== 0x5059) {
		throw new Error('Invalid NPY file');
	}
	const major = view.getUint8(6);
	if (major !== 1 && major !== 2) return null;
	const headerStart = major === 1 ? 10 : 12;
	const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
	if (headerStart + headerLength > buffer.byteLength) throw new Error('Invalid NPY file');
	const header = new TextDecoder('latin1').decode(new Uint8Array(buffer, headerStart, headerLength));
	const dtype = /'descr':\s*'([^']+)'/.exec(header)?.[1];
	const shape = /'shape':\s*\(([^)]+)\)/.exec(header)?.[1]
		.split(',').map(value => value.trim()).filter(Boolean).map(Number);
	if (!dtype || !shape || !shape.every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid NPY header');
	return { dtype, shape, dataOffset: headerStart + headerLength };
}

export function decodeNativeF32NpyFast(buffer: ArrayBuffer, computeStats = true) {
	if (!IS_LITTLE_ENDIAN) return null;
	const started = performance.now();
	if (buffer.byteLength < 6 || new Uint8Array(buffer, 0, 6)[0] !== 0x93) return null;
	const parsed = parseNpyHeader(buffer);
	if (!parsed || (parsed.dtype !== '<f4' && parsed.dtype !== '=f4') || (parsed.shape.length !== 2 && parsed.shape.length !== 3)) return null;
	const [height, width, shapeChannels = 1] = parsed.shape;
	if (shapeChannels !== 1 && shapeChannels !== 3 && shapeChannels !== 4) return null;
	const samples = width * height * shapeChannels;
	if (parsed.dataOffset % 4 !== 0 || parsed.dataOffset + samples * 4 > buffer.byteLength) return null;
	const data = new Float32Array(buffer, parsed.dataOffset, samples);
	let stats: { min: number, max: number } | undefined;
	let validCount: number | undefined, nonFiniteCount: number | undefined;
	if (computeStats) {
		let min = Infinity, max = -Infinity;
		validCount = 0;
		nonFiniteCount = 0;
		const scanChannels = shapeChannels >= 3 ? 3 : 1;
		for (let pixel = 0; pixel < width * height; pixel++) {
			const base = pixel * shapeChannels;
			for (let channel = 0; channel < scanChannels; channel++) {
				const value = data[base + channel];
				if (Number.isFinite(value)) {
					if (value < min) min = value;
					if (value > max) max = value;
					validCount++;
				} else nonFiniteCount++;
			}
		}
		stats = { min, max };
	}
	return {
		width, height, channels: shapeChannels, data,
		metadata: { dtype: parsed.dtype },
		numericDomain: { bitsPerSample: 32, sampleFormat: 3, typeMin: 0, typeMax: 1, sourceNumericType: 'float32' },
		stats,
		validCount,
		nonFiniteCount,
		decodedWith: 'javascript-zero-copy (worker)',
		decodeTimings: [{ name: 'decode-npy-js-zero-copy', durationMs: performance.now() - started }],
	};
}

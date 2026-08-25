"use strict";

function primarySampleFormat(sampleFormat: number | number[]): number {
	return Array.isArray(sampleFormat) ? sampleFormat[0] : sampleFormat;
}

export function tiffNeedsFloatCarrier(sampleFormat: number | number[], bitsPerSample: number): boolean {
	const format = primarySampleFormat(sampleFormat);
	return format === 3 || format === 2 || bitsPerSample > 16;
}

export function tiffTypeMax(sampleFormat: number | number[], bitsPerSample: number): number {
	const format = primarySampleFormat(sampleFormat);
	if (format === 3) { return 1.0; }
	if (format === 2) { return Math.pow(2, bitsPerSample - 1) - 1; }
	return Math.pow(2, bitsPerSample) - 1;
}

export function tiffFormatTypeFor(sampleFormat: number | number[], bitsPerSample?: number): 'tiff-float' | 'tiff-int-signed' | 'tiff-int-wide' | 'tiff-int' {
	const format = primarySampleFormat(sampleFormat);
	if (format === 3) { return 'tiff-float'; }
	if (format === 2) { return 'tiff-int-signed'; }
	if ((bitsPerSample || 0) > 16) { return 'tiff-int-wide'; }
	return 'tiff-int';
}

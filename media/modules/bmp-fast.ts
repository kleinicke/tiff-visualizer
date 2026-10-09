/**
 * Direct RGBA expansion of uncompressed 24-bit BMPs, the layout of nearly
 * every large BMP. Through the browser such a file is decoded by an <img>,
 * drawn to a canvas and read back with getImageData: ~310 ms for 5120².
 * Reading the rows here takes a fraction of that.
 *
 * Only layouts the browser displays without any transform are handled:
 * BI_RGB, 24 bits, a BITMAPINFOHEADER or a V4/V5 header declaring sRGB or
 * the Windows default colour space (Chromium colour-manages calibrated and
 * embedded profiles). Anything else returns null and stays with the browser.
 * The result equals the browser's getImageData byte for byte (see
 * test/web/bmp-fast.spec.ts).
 */

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
/** 'sRGB' and 'Win ' as V4/V5 bV4CSType values. */
const LCS_SRGB = 0x73524742;
const LCS_WINDOWS_COLOR_SPACE = 0x57696e20;

export function decodeBmp24(buffer: ArrayBuffer): { width: number; height: number; data: Uint8ClampedArray } | null {
	if (!LITTLE_ENDIAN || buffer.byteLength < 54) { return null; }
	const view = new DataView(buffer);
	if (view.getUint16(0, true) !== 0x4d42) { return null; }
	const pixelOffset = view.getUint32(10, true);
	const headerSize = view.getUint32(14, true);
	if (headerSize !== 40 && headerSize !== 108 && headerSize !== 124) { return null; }
	if (headerSize > 40) {
		if (buffer.byteLength < 14 + headerSize) { return null; }
		const colorSpace = view.getUint32(14 + 56, true);
		if (colorSpace !== LCS_SRGB && colorSpace !== LCS_WINDOWS_COLOR_SPACE) { return null; }
	}
	const width = view.getInt32(18, true);
	const signedHeight = view.getInt32(22, true);
	const planes = view.getUint16(26, true);
	const bitCount = view.getUint16(28, true);
	const compression = view.getUint32(30, true);
	const height = Math.abs(signedHeight);
	if (planes !== 1 || bitCount !== 24 || compression !== 0 || width <= 0 || height === 0) { return null; }
	const rowBytes = Math.ceil(width * 3 / 4) * 4;
	if (pixelOffset < 14 + headerSize || pixelOffset + rowBytes * height > buffer.byteLength) { return null; }

	const data = new Uint8ClampedArray(width * height * 4);
	const words = new Uint32Array(data.buffer);
	const topDown = signedHeight < 0;
	for (let row = 0; row < height; row++) {
		const y = topDown ? row : height - 1 - row;
		let source = pixelOffset + row * rowBytes;
		let target = y * width;
		const end = target + width;
		// Three unaligned little-endian words hold four BGR pixels.
		const end4 = target + (width & ~3);
		for (; target < end4; target += 4, source += 12) {
			const w0 = view.getUint32(source, true), w1 = view.getUint32(source + 4, true), w2 = view.getUint32(source + 8, true);
			words[target] = 0xff000000 | ((w0 & 0xff) << 16) | (w0 & 0xff00) | ((w0 >>> 16) & 0xff);
			words[target + 1] = 0xff000000 | ((w0 >>> 24) << 16) | ((w1 & 0xff) << 8) | ((w1 >>> 8) & 0xff);
			words[target + 2] = 0xff000000 | (((w1 >>> 16) & 0xff) << 16) | ((w1 >>> 24) << 8) | (w2 & 0xff);
			words[target + 3] = 0xff000000 | ((w2 & 0xff00) << 8) | ((w2 >>> 8) & 0xff00) | (w2 >>> 24);
		}
		for (; target < end; target++, source += 3) {
			words[target] = 0xff000000 | (view.getUint8(source + 2)) | (view.getUint8(source + 1) << 8) | (view.getUint8(source) << 16);
		}
	}
	return { width, height, data };
}

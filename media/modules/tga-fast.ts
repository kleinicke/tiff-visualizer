/**
 * RGBA expansion of decoded TGA pixels, for the layouts nearly every TGA
 * uses: 24/32-bit colour and 8-bit grey, rows stored left to right. tga-js
 * computes a destination index and writes four bytes per pixel; this writes
 * one 32-bit word per pixel along each row from whole-word reads: a
 * 5120² 24-bit image expands in ~30 instead of ~80 ms.
 * The output equals tga-js `getImageData` byte for byte (BGR(A) to RGBA,
 * alpha 255 without an alpha channel, the 32-bit alpha byte kept as is,
 * bottom-up rows flipped). Other layouts return false and stay with tga-js.
 */

/** The parts of a tga-js `header` this reads. */
export interface TgaLayout {
	width: number;
	height: number;
	pixelDepth: number;
	flags: number;
	isGreyColor: boolean;
	hasColorMap: boolean;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * Write `pixels` (tga-js `imageData`: RLE already expanded) into `out`, a
 * width × height RGBA buffer. Returns false, writing nothing, when the layout
 * is not one handled here.
 */
export function expandTgaPixels(header: TgaLayout, pixels: Uint8Array, out: Uint8ClampedArray): boolean {
	const { width, height, pixelDepth, isGreyColor, hasColorMap } = header;
	const origin = (header.flags & 0x30) >> 4;
	// Origins 1 and 3 store each row right to left.
	if (!LITTLE_ENDIAN || hasColorMap || origin === 1 || origin === 3) { return false; }
	const bytes = pixelDepth >> 3;
	const supported = isGreyColor ? pixelDepth === 8 : pixelDepth === 24 || pixelDepth === 32;
	if (!supported || out.length !== width * height * 4 || out.byteOffset % 4 !== 0) { return false; }
	const rowBytes = width * bytes;
	if (pixels.length < rowBytes * height) { return false; }
	const words = new Uint32Array(out.buffer, out.byteOffset, width * height);
	// Unaligned little-endian words: three hold four BGR pixels.
	const view = new DataView(pixels.buffer, pixels.byteOffset, pixels.byteLength);
	const topDown = origin === 2;
	for (let row = 0; row < height; row++) {
		const y = topDown ? row : height - 1 - row;
		let source = row * rowBytes;
		let target = y * width;
		const end = target + width;
		if (pixelDepth === 24) {
			const end4 = target + (width & ~3);
			for (; target < end4; target += 4, source += 12) {
				const w0 = view.getUint32(source, true), w1 = view.getUint32(source + 4, true), w2 = view.getUint32(source + 8, true);
				words[target] = 0xff000000 | ((w0 & 0xff) << 16) | (w0 & 0xff00) | ((w0 >>> 16) & 0xff);
				words[target + 1] = 0xff000000 | ((w0 >>> 24) << 16) | ((w1 & 0xff) << 8) | ((w1 >>> 8) & 0xff);
				words[target + 2] = 0xff000000 | (((w1 >>> 16) & 0xff) << 16) | ((w1 >>> 24) << 8) | (w2 & 0xff);
				words[target + 3] = 0xff000000 | ((w2 & 0xff00) << 8) | ((w2 >>> 8) & 0xff00) | (w2 >>> 24);
			}
			for (; target < end; target++, source += 3) {
				words[target] = 0xff000000 | (pixels[source] << 16) | (pixels[source + 1] << 8) | pixels[source + 2];
			}
		} else if (pixelDepth === 32) {
			for (; target < end; target++, source += 4) {
				const bgra = view.getUint32(source, true);
				words[target] = (bgra & 0xff00ff00) | ((bgra & 0xff) << 16) | ((bgra >>> 16) & 0xff);
			}
		} else {
			for (; target < end; target++, source++) {
				words[target] = 0xff000000 | (pixels[source] * 0x010101);
			}
		}
	}
	return true;
}

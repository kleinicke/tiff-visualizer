import { codecWasmModule } from '../codec-wasm-wrapper.js';
import { TiffChannelSource } from '../scene/channel-source.js';
import type { MaskSamples } from './mask-trace.js';

/** Masks bigger than this are refused: they are held whole, at up to four bytes a pixel. */
export const MAX_MASK_PIXELS = 150_000_000;
/** Pixels read per request, so decoding never holds more than this as floats. */
const BAND_PIXELS = 8_000_000;

export interface MaskImage { data: MaskSamples; width: number; height: number }

/** Read the first image of a TIFF as unsigned integer labels (8, 16 or 32 bits a pixel). */
export async function readMaskImage(bytes: ArrayBuffer): Promise<MaskImage> {
	const source = await TiffChannelSource.fromBytes(bytes, await codecWasmModule());
	try {
		const { width, height } = source.levels[0];
		if (width * height > MAX_MASK_PIXELS) {
			throw new Error(`The mask is ${width} × ${height} pixels; masks over ${(MAX_MASK_PIXELS / 1e6).toFixed(0)} megapixels are not supported.`);
		}
		const rows = Math.max(1, Math.floor(BAND_PIXELS / width));
		let data: MaskSamples | null = null;
		for (let y = 0; y < height; y += rows) {
			const band = await source.readRegion(0, { x: 0, y, width, height: Math.min(rows, height - y) });
			if (band.data.length !== band.width * band.height) {
				throw new Error('The image has more than one value per pixel, so it is not a label mask.');
			}
			data ??= band.data instanceof Uint8Array ? new Uint8Array(width * height) : band.data instanceof Uint16Array ? new Uint16Array(width * height) : new Uint32Array(width * height);
			if (band.data instanceof Float32Array) {
				const target = data;
				for (let index = 0; index < band.data.length; index++) {
					const value = band.data[index];
					if (!Number.isFinite(value)) { throw new Error('The mask contains non-finite values. Labels must be whole numbers, with 0 for background.'); }
					// The region decoder uses f32, so adjacent uint32 IDs can become indistinguishable here.
					if (value >= 2 ** 24) { throw new Error('Mask labels must be below 16,777,216 with this decoder. Relabel the mask and its matching table with smaller IDs before importing.'); }
					if (!(value > 0)) {
						if (value < 0) { throw new Error('The image has negative values, so it is not a label mask (whole numbers, 0 for background).'); }
						continue;
					}
					if (value !== Math.floor(value) || value > 0xFFFFFFFF) { throw new Error('The image has fractional values, so it is not a label mask (whole numbers, 0 for background).'); }
					target[y * width + index] = value;
				}
			} else {
				data.set(band.data as never, y * width);
			}
		}
		if (!data) { throw new Error('The image has no pixels.'); }
		return { data, width, height };
	} finally { source.dispose(); }
}

/**
 * TGA pixels are expanded to RGBA by `media/modules/tga-fast.ts` for the
 * common layouts and by tga-js otherwise. The result must equal tga-js
 * `getImageData` byte for byte: random images of every image type (raw and
 * RLE, colour, grey, palette), depth and origin, plus a real file when the
 * local benchmark corpus has one.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TgaLoader = require('tga-js').default || require('tga-js');

function random(seed) {
	let state = seed >>> 0 || 1;
	return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}

/** A TGA file; `rle` packets mix runs and literals. */
function makeTga(rand, { imageType, pixelDepth, origin, width, height }) {
	const colorMapped = imageType === 1 || imageType === 9;
	const rle = imageType >= 9;
	const bytes = colorMapped ? 1 : pixelDepth >> 3;
	const palette = colorMapped ? Array.from({ length: 256 * 3 }, () => Math.floor(rand() * 256)) : [];
	const pixels = [];
	for (let p = 0; p < width * height; p++) {
		const pixel = Array.from({ length: bytes }, () => Math.floor(rand() * 256));
		// Repeat pixels often, so RLE has runs.
		pixels.push(p && rand() < 0.4 ? pixels[p - 1] : pixel);
	}
	const body = [];
	if (rle) {
		for (let p = 0; p < pixels.length;) {
			const count = Math.min(128, pixels.length - p, 1 + Math.floor(rand() * 6));
			if (rand() < 0.5) { body.push(0x80 | (count - 1), ...pixels[p]); } else { body.push(count - 1); for (let k = 0; k < count; k++) body.push(...pixels[p + k]); }
			p += count;
		}
	} else {
		for (const pixel of pixels) body.push(...pixel);
	}
	const idLength = Math.floor(rand() * 3);
	const header = [
		idLength, colorMapped ? 1 : 0, imageType,
		0, 0, colorMapped ? 0 : 0, colorMapped ? 1 : 0, colorMapped ? 24 : 0,
		0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8,
		colorMapped ? 8 : pixelDepth, origin << 4,
	];
	return new Uint8Array([...header, ...Array(idLength).fill(7), ...palette, ...body]);
}

async function main() {
	const { expandTgaPixels } = await import('../out/media/modules/tga-fast.js');
	const decode = (file, fast) => {
		const tga = new TgaLoader();
		tga.load(file);
		const { width, height } = tga.header;
		const out = { width, height, data: new Uint8ClampedArray(width * height * 4) };
		const handled = fast && expandTgaPixels(tga.header, tga.imageData, out.data);
		if (!handled) tga.getImageData(out);
		return { data: out.data, handled };
	};

	const rand = random(4242);
	let fast = 0, fallback = 0;
	const layouts = [
		[2, 24], [2, 32], [2, 16], [10, 24], [10, 32], [10, 16],
		[3, 8], [3, 16], [11, 8], [11, 16], [1, 8], [9, 8],
	];
	for (const [imageType, pixelDepth] of layouts) {
		for (let origin = 0; origin < 4; origin++) {
			for (let trial = 0; trial < 3; trial++) {
				const width = 1 + Math.floor(rand() * 37), height = 1 + Math.floor(rand() * 29);
				const file = makeTga(rand, { imageType, pixelDepth, origin, width, height });
				const expected = decode(file, false).data;
				const actual = decode(file, true);
				assert.ok(Buffer.from(actual.data.buffer).equals(Buffer.from(expected.buffer)), `type ${imageType}, ${pixelDepth}-bit, origin ${origin}, ${width}x${height}`);
				if (actual.handled) fast++; else fallback++;
			}
		}
	}
	assert.ok(fast > 0 && fallback > 0, 'both paths exercised');

	let real = '';
	const corpusFile = path.resolve(__dirname, '../../test_data/nl_01_depth_norm.tga');
	if (fs.existsSync(corpusFile)) {
		const file = new Uint8Array(fs.readFileSync(corpusFile));
		const startSlow = performance.now();
		const expected = decode(file, false).data;
		const slow = performance.now() - startSlow;
		const startFast = performance.now();
		const actual = decode(file, true);
		const quick = performance.now() - startFast;
		assert.ok(actual.handled && Buffer.from(actual.data.buffer).equals(Buffer.from(expected.buffer)), 'nl_01_depth_norm.tga');
		real = `; nl_01_depth_norm.tga identical (${slow.toFixed(0)} -> ${quick.toFixed(0)} ms)`;
	}
	console.log(`TGA fast expansion: ${fast} images identical to tga-js, ${fallback} left to tga-js${real}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });

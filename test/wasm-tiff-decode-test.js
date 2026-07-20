/**
 * Regression tests for the Rust/WASM TIFF decoder (wasm/tiff-decoder).
 *
 * Exercises the compression types the geotiff.js fallback cannot handle and
 * which the WASM decoder is responsible for:
 *   - CCITT Group 3 / T.4   (compression 3)
 *   - CCITT Group 4 / T.6   (compression 4)
 *   - JPEG-in-TIFF          (compression 7, decoded to RGB)
 *   - Uncompressed bilevel  (1-bit, expanded to 8-bit grayscale)
 *   - Palette / RGBPalette  (indices expanded to RGB via the ColorMap)
 *   - ZSTD                  (compression 50000)
 *
 * The CCITT-compressed images are byte-for-byte copies of an uncompressed
 * reference, so a correct decode must match the reference exactly.
 *
 * Run with: node test/wasm-tiff-decode-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const samplesDir = path.join(__dirname, '..', 'test-samples');
const wasmJs = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.js');
const wasmBin = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.wasm');

function decode(mod, file) {
	const buffer = fs.readFileSync(path.join(samplesDir, file));
	const result = mod.decode_tiff(new Uint8Array(buffer));
	return {
		width: result.width,
		height: result.height,
		channels: result.channels,
		bitsPerSample: result.bits_per_sample,
		compression: result.compression,
		data: Array.from(result.get_data_as_f32()),
	};
}

async function main() {
	if (!fs.existsSync(wasmBin)) {
		console.log('⚠️  media/wasm/tiff-wasm.wasm not found — run `npm run build:wasm` first. Skipping.');
		return;
	}

	const mod = await import(wasmJs.replace(/\\/g, '/'));
	await mod.default({ module_or_path: fs.readFileSync(wasmBin) });

	console.log('🧪 Running WASM TIFF decoder tests...\n');

	const reference = decode(mod, 'ccitt_none.tif');

	// 1. Uncompressed bilevel expands to one byte per pixel (regression for the
	//    1-bit path that previously returned an empty buffer).
	{
		assert.strictEqual(reference.width, 128);
		assert.strictEqual(reference.height, 96);
		assert.strictEqual(reference.channels, 1);
		assert.strictEqual(reference.bitsPerSample, 8, 'bilevel should be expanded to 8-bit');
		assert.strictEqual(reference.data.length, 128 * 96, 'expanded data must cover every pixel');
		assert.ok(reference.data.some(v => v === 0) && reference.data.some(v => v === 255),
			'bilevel image should contain both black and white pixels');
		console.log('✅ Uncompressed 1-bit bilevel expands to 8-bit grayscale');
	}

	// 2. CCITT Group 3 and Group 4 decode to the exact same pixels as the
	//    uncompressed reference image.
	for (const [label, file, comp] of [['Group 3', 'ccitt_g3.tif', 3], ['Group 4', 'ccitt_g4.tif', 4]]) {
		const img = decode(mod, file);
		assert.strictEqual(img.compression, comp, `${label} compression tag`);
		assert.strictEqual(img.width, reference.width);
		assert.strictEqual(img.height, reference.height);
		assert.strictEqual(img.channels, 1);
		assert.deepStrictEqual(img.data, reference.data,
			`CCITT ${label} must decode identically to the uncompressed reference`);
		console.log(`✅ CCITT ${label} (compression ${comp}) matches the uncompressed reference exactly`);
	}

	// 2b. Multi-strip CCITT Modified Huffman (compression 2, WhiteIsZero) masks.
	//     Each strip is an independent byte-aligned stream; these must decode
	//     identically to a deflate-compressed grayscale reference (regression for
	//     a real dataset that previously rendered garbled or failed to load).
	for (const n of [1, 2, 3]) {
		const img = decode(mod, `ccitt_mh_strip_${n}.tif`);
		const ref = decode(mod, `ccitt_mh_strip_${n}_ref.tif`);
		assert.strictEqual(img.compression, 2, `mask ${n} compression tag`);
		assert.strictEqual(img.width, 1024);
		assert.strictEqual(img.height, 1024);
		assert.strictEqual(img.data.length, ref.data.length, `mask ${n} length`);
		assert.deepStrictEqual(img.data, ref.data,
			`multi-strip CCITT MH mask ${n} must match the reference exactly`);
		console.log(`✅ Multi-strip CCITT Modified Huffman mask ${n} matches the reference exactly`);
	}

	// 3. JPEG-in-TIFF decodes to a 3-channel (RGB) 8-bit image.
	{
		const jpeg = decode(mod, 'jpeg_ycbcr.tif');
		assert.strictEqual(jpeg.compression, 7, 'JPEG compression tag');
		assert.strictEqual(jpeg.width, 160);
		assert.strictEqual(jpeg.height, 120);
		assert.strictEqual(jpeg.channels, 3, 'JPEG should decode to 3 interleaved channels');
		assert.strictEqual(jpeg.bitsPerSample, 8);
		assert.strictEqual(jpeg.data.length, 160 * 120 * 3);
		const max = jpeg.data.reduce((m, v) => Math.max(m, v), 0);
		assert.ok(max > 0, 'JPEG image should contain non-zero pixels');
		console.log('✅ JPEG-in-TIFF (compression 7) decodes to 3-channel RGB');
	}

	// 3b. JPEG with PhotometricInterpretation YCbCr (6) is decoded directly with
	//     zune-jpeg to avoid the tiff crate's double YCbCr->RGB conversion. The
	//     result must match a libjpeg reference within JPEG rounding tolerance
	//     (the buggy double-converted path was off by ~100+).
	{
		const ycc = decode(mod, 'jpeg_ycbcr_color.tif');
		const ref = decode(mod, 'jpeg_ycbcr_color_ref.tif');
		assert.strictEqual(ycc.compression, 7, 'YCbCr JPEG compression tag');
		assert.strictEqual(ycc.channels, 3, 'YCbCr JPEG decodes to 3 channels');
		assert.strictEqual(ycc.data.length, ref.data.length, 'YCbCr JPEG length');
		let maxDelta = 0;
		for (let i = 0; i < ref.data.length; i++) {
			maxDelta = Math.max(maxDelta, Math.abs(ycc.data[i] - ref.data[i]));
		}
		assert.ok(maxDelta <= 6, `YCbCr JPEG must match libjpeg within tolerance (got ${maxDelta})`);
		console.log(`✅ YCbCr JPEG (photometric 6) decodes correctly (max delta ${maxDelta} vs libjpeg)`);
	}

	// 4. Palette images expand to RGB through the ColorMap. The first pixel of
	//    this fixture is palette index -> (20, 12, 27), matching Pillow's own
	//    palette->RGB conversion.
	{
		const pal = decode(mod, 'palette.tif');
		assert.strictEqual(pal.width, 160);
		assert.strictEqual(pal.height, 120);
		assert.strictEqual(pal.channels, 3, 'palette should expand to 3 channels');
		assert.strictEqual(pal.bitsPerSample, 8);
		assert.strictEqual(pal.data.length, 160 * 120 * 3);
		assert.deepStrictEqual(pal.data.slice(0, 3), [20, 12, 27],
			'first pixel must match the ColorMap expansion');
		console.log('✅ Palette (RGBPalette) expands to RGB via the ColorMap');
	}

	// 5. ZSTD-compressed (compression 50000) decodes correctly.
	{
		const zstd = decode(mod, 'zstd_u16.tif');
		assert.strictEqual(zstd.compression, 50000, 'ZSTD compression tag');
		assert.strictEqual(zstd.width, 160);
		assert.strictEqual(zstd.height, 120);
		assert.strictEqual(zstd.bitsPerSample, 16);
		assert.strictEqual(zstd.data.length, 160 * 120);
		const max = zstd.data.reduce((m, v) => Math.max(m, v), 0);
		assert.ok(max > 60000, 'ZSTD 16-bit image should span the full range');
		console.log('✅ ZSTD (compression 50000) decodes correctly');
	}

	// 5b. ZSTD with predictors must decode identically to an uncompressed twin.
	//     This exercises the pure-Rust (ruzstd) path's predictor handling:
	//     horizontal (2) on 16-bit and RGB, and floating-point (3) on float32.
	for (const [zstdFile, refFile, label] of [
		['zstd_pred2_u16.tif', 'pred_ref_u16.tif', 'horizontal predictor, uint16'],
		['zstd_pred2_rgb8.tif', 'pred_ref_rgb8.tif', 'horizontal predictor, RGB8'],
		['zstd_pred3_f32.tif', 'pred_ref_f32.tif', 'float predictor, float32'],
	]) {
		const z = decode(mod, zstdFile);
		const r = decode(mod, refFile);
		assert.strictEqual(z.compression, 50000, `${zstdFile} compression tag`);
		assert.strictEqual(z.data.length, r.data.length, `${label}: length`);
		assert.deepStrictEqual(z.data, r.data,
			`ZSTD ${label} must match the uncompressed reference exactly`);
		console.log(`✅ ZSTD ${label} matches the uncompressed reference exactly`);
	}

	// 5c. Sub-16-bit unsigned chunky samples (10/12/14-bit RGB), the non-byte-
	//     aligned bit depths that tiff crate's read_image() rejects with
	//     "color type RGB(n) is unsupported" before decompression is even
	//     attempted (see try_decode_subbit_strips in wasm/tiff-decoder). These
	//     shapes_lzw_*bps.tif files are LZW-compressed, chunky, single-strip,
	//     Predictor absent (=1), unsigned. Ground truth values were extracted
	//     independently by parsing an uncompressed twin (`tiffcp -c none`) and
	//     manually bit-unpacking the raw strip bytes.
	for (const [file, bits, expected] of [
		['shapes_lzw_12bps.tif', 12, {
			'0,0': [4095, 4095, 4095],
			'1,0': [4095, 4095, 4095],
			'0,1': [4095, 4095, 4095],
			'64,36': [4014, 79, 0],
			'127,71': [4095, 4095, 4095],
			'50,20': [4095, 4095, 4095],
			'10,60': [4095, 4095, 4095],
		}],
		['shapes_lzw_14bps.tif', 14, {
			'0,0': [16383, 16383, 16383],
			'1,0': [16383, 16383, 16383],
			'0,1': [16383, 16383, 16383],
			'64,36': [16061, 320, 0],
			'127,71': [16383, 16383, 16383],
			'50,20': [16383, 16383, 16383],
			'10,60': [16383, 16383, 16383],
		}],
	]) {
		const img = decode(mod, file);
		assert.strictEqual(img.width, 128, `${file}: width`);
		assert.strictEqual(img.height, 72, `${file}: height`);
		assert.strictEqual(img.channels, 3, `${file}: channels`);
		assert.strictEqual(img.bitsPerSample, bits, `${file}: bits_per_sample must report the true bit depth (not 16)`);
		assert.strictEqual(img.data.length, 128 * 72 * 3, `${file}: data length`);
		for (const [coord, rgb] of Object.entries(expected)) {
			const [x, y] = coord.split(',').map(Number);
			const idx = (y * 128 + x) * 3;
			const got = img.data.slice(idx, idx + 3);
			assert.deepStrictEqual(got, rgb, `${file}: pixel (${x},${y}) must match ground truth`);
		}
		console.log(`✅ ${bits}-bit sub-16-bit LZW RGB (${file}) decodes to exact ground-truth pixel values`);
	}

	// 5d. Planar (PlanarConfiguration 2) and tiled-LZW images. These previously
	//     either decoded WRONG with no error (planar: the `tiff` crate's own
	//     read_image() doc comment admits its planar handling is "not
	//     correct" -- it reads only the first plane, or concatenates planes
	//     sequentially into one buffer instead of interleaving per sample) or
	//     failed outright ("no lzw end code found" for tiled LZW whose final
	//     tile omits the EOI code, which libtiff tolerates but the `tiff`
	//     crate's LZW reader does not). See try_decode_general_strips_tiles in
	//     wasm/tiff-decoder for the fix: a direct strip/tile reader that
	//     always produces chunky interleaved output regardless of on-disk
	//     planar configuration.
	//
	//     Ground truth for every sample of every file below was produced
	//     independently of this decoder: via `tiffcp -p contig -c none`
	//     (planar/tiled -> chunky, uncompressed) followed by tifffile
	//     (imagecodecs) decoding, cross-checked file-for-file against a
	//     direct tifffile read of the original planar/tiled/compressed file.
	//     The two 10-bit/planar files that `tiffcp` itself cannot convert
	//     (libtiff: "Compression algorithm does not support random access"
	//     and "Cannot handle different planar configuration w/ bits/sample !=
	//     8") were verified purely via the direct tifffile read; that read
	//     path was itself validated by the tiffcp cross-check on the other
	//     four files. Ground truth is stored as raw little-endian binary
	//     fixtures (`*.gt.u8.bin` / `*.gt.u16.bin`), one sample per pixel per
	//     channel, row-major, chunky (H, W, C).
	for (const [file, gtFile, gtDtype, expectPlanar] of [
		['shapes_lzw_planar.tif', 'shapes_lzw_planar.gt.u8.bin', 'u8', 2],
		['shapes_uncompressed_tiled_planar.tif', 'shapes_uncompressed_tiled_planar.gt.u8.bin', 'u8', 2],
		['shapes_lzw_planar_10bps.tif', 'shapes_lzw_planar_10bps.gt.u16.bin', 'u16', 2],
		['shapes_lzw_tiled.tif', 'shapes_lzw_tiled.gt.u8.bin', 'u8', 1],
		['shapes_lzw_tiled_planar.tif', 'shapes_lzw_tiled_planar.gt.u8.bin', 'u8', 2],
		['shapes_tiled_multi.tif', 'shapes_tiled_multi.gt.u8.bin', 'u8', 1],
	]) {
		const buffer = fs.readFileSync(path.join(samplesDir, file));
		const result = mod.decode_tiff(new Uint8Array(buffer));
		const data = result.get_data_as_f32();

		const gtBuffer = fs.readFileSync(path.join(samplesDir, gtFile));
		const gt = gtDtype === 'u16'
			? new Uint16Array(gtBuffer.buffer, gtBuffer.byteOffset, gtBuffer.length / 2)
			: new Uint8Array(gtBuffer.buffer, gtBuffer.byteOffset, gtBuffer.length);

		assert.strictEqual(result.width, 128, `${file}: width`);
		assert.strictEqual(result.height, 72, `${file}: height`);
		assert.strictEqual(result.channels, 3, `${file}: channels`);
		assert.strictEqual(result.planar_configuration, expectPlanar,
			`${file}: must still report the true on-disk PlanarConfiguration tag in metadata`);
		assert.strictEqual(data.length, gt.length, `${file}: sample count`);

		let mismatches = 0;
		let firstMismatchIndex = -1;
		for (let i = 0; i < data.length; i++) {
			if (data[i] !== gt[i]) {
				mismatches++;
				if (firstMismatchIndex === -1) firstMismatchIndex = i;
			}
		}
		assert.strictEqual(mismatches, 0,
			`${file}: ${mismatches}/${data.length} samples differ from ground truth ` +
			`(first at index ${firstMismatchIndex}: got ${data[firstMismatchIndex]}, expected ${gt[firstMismatchIndex]})`);
		console.log(`✅ ${file} (planar=${result.planar_configuration}, tiled=${result.tile_width > 0}) matches ground truth exactly, every sample`);
	}

	// 6. WebP-compressed (compression 50001) decodes to RGB.
	{
		const webp = decode(mod, 'webp_rgb.tif');
		assert.strictEqual(webp.compression, 50001, 'WebP compression tag');
		assert.strictEqual(webp.width, 160);
		assert.strictEqual(webp.height, 120);
		assert.strictEqual(webp.channels, 3, 'WebP should decode to 3 channels');
		assert.strictEqual(webp.bitsPerSample, 8);
		assert.strictEqual(webp.data.length, 160 * 120 * 3);
		const max = webp.data.reduce((m, v) => Math.max(m, v), 0);
		assert.ok(max > 0, 'WebP image should contain non-zero pixels');
		console.log('✅ WebP (compression 50001) decodes to 3-channel RGB');
	}

	// 7. Gray+alpha (SamplesPerPixel=2). house.tif is an 8-bit grayscale image
	//    with an unassociated-alpha extra sample whose ExtraSamples tag value
	//    (999) is not a valid TIFF ExtraSamples enum entry, so the tiff crate's
	//    colortype() falls back to `ColorType::Multiband { num_samples: 2, .. }`
	//    instead of `ColorType::GrayA` - a `channels` value the old hand-rolled
	//    match in decode_tiff_impl didn't handle and silently reported as 1,
	//    corrupting the stride of every decoded row ("subpixel artifacts").
	//    Ground truth extracted independently via tifffile.
	{
		const img = decode(mod, 'house.tif');
		assert.strictEqual(img.width, 512, 'house.tif: width');
		assert.strictEqual(img.height, 512, 'house.tif: height');
		assert.strictEqual(img.channels, 2, 'house.tif: channels must be truthful (gray + alpha)');
		assert.strictEqual(img.bitsPerSample, 8, 'house.tif: bits_per_sample');
		assert.strictEqual(img.data.length, 512 * 512 * 2, 'house.tif: data length must equal width*height*channels');
		for (const [coord, grayAlpha] of Object.entries({
			'0,0': [203, 255],
			'10,10': [205, 255],
			'100,200': [147, 255],
			'511,511': [163, 255],
			'50,300': [204, 255],
			'1,1': [203, 255],
			'400,400': [188, 255],
		})) {
			const [x, y] = coord.split(',').map(Number);
			const idx = (y * 512 + x) * 2;
			const got = img.data.slice(idx, idx + 2);
			assert.deepStrictEqual(got, grayAlpha, `house.tif: pixel (${x},${y}) must match ground truth`);
		}
		console.log('✅ house.tif (gray+alpha, SamplesPerPixel=2) decodes to exact ground-truth pixel values with the correct stride');
	}

	// 8. RGB with 4 extra unspecified samples (SamplesPerPixel=7). shapes_hyper.tif
	//    is a float32 image with PhotometricInterpretation RGB (photometric_samples
	//    = 3) but SamplesPerPixel = 7; `tiff::ColorType::RGB(_).num_samples()` is
	//    3, so the old channels match silently reported 3 while every raw pixel
	//    is actually 7 samples wide, scrambling every channel/row after the first
	//    ("scrambled/red-shifted"). Ground truth extracted independently via
	//    tifffile; channels 3-6 are constant (0.1, 0.2, 0.3, 0.5) across the
	//    whole image, channels 0-2 vary with the RGB shape pattern.
	{
		const img = decode(mod, 'shapes_hyper.tif');
		assert.strictEqual(img.width, 128, 'shapes_hyper.tif: width');
		assert.strictEqual(img.height, 72, 'shapes_hyper.tif: height');
		assert.strictEqual(img.channels, 7, 'shapes_hyper.tif: channels must be truthful (RGB + 4 extra samples)');
		assert.strictEqual(img.bitsPerSample, 32, 'shapes_hyper.tif: bits_per_sample');
		assert.strictEqual(img.data.length, 128 * 72 * 7, 'shapes_hyper.tif: data length must equal width*height*channels');
		const closeEnough = (a, b) => Math.abs(a - b) < 1e-5;
		for (const [coord, samples] of Object.entries({
			'0,0': [1, 1, 1, 0.1, 0.2, 0.3, 0.5],
			'64,36': [0.9803921580314636, 0.019607843831181526, 0, 0.1, 0.2, 0.3, 0.5],
			'127,71': [1, 1, 1, 0.1, 0.2, 0.3, 0.5],
			'10,10': [1, 1, 1, 0.1, 0.2, 0.3, 0.5],
			'20,50': [0.72156864, 0.87058824, 0.25882354, 0.1, 0.2, 0.3, 0.5],
			'90,15': [0.03137255, 0.96862745, 0.011764706, 0.1, 0.2, 0.3, 0.5],
		})) {
			const [x, y] = coord.split(',').map(Number);
			const idx = (y * 128 + x) * 7;
			const got = img.data.slice(idx, idx + 7);
			for (let c = 0; c < 7; c++) {
				assert.ok(closeEnough(got[c], samples[c]),
					`shapes_hyper.tif: pixel (${x},${y}) channel ${c} must match ground truth (got ${got[c]}, expected ${samples[c]})`);
			}
		}
		console.log('✅ shapes_hyper.tif (RGB + 4 extra samples, SamplesPerPixel=7) decodes to exact ground-truth pixel values with the correct stride');
	}

	// 9. Wide unsigned integer (uint32) samples must survive the Rust decoder
	//    exactly, including values above 65535 (which a Uint16Array carrier
	//    would wrap mod 65536). gray_u32.tif is a 64x48 grayscale uint32 image
	//    generated with tifffile; ground truth extracted independently via
	//    tifffile.imread.
	{
		const img = decode(mod, 'gray_u32.tif');
		assert.strictEqual(img.width, 64, 'gray_u32.tif: width');
		assert.strictEqual(img.height, 48, 'gray_u32.tif: height');
		assert.strictEqual(img.channels, 1, 'gray_u32.tif: channels');
		assert.strictEqual(img.bitsPerSample, 32, 'gray_u32.tif: bits_per_sample');
		assert.strictEqual(img.data.length, 64 * 48, 'gray_u32.tif: data length');
		assert.strictEqual(img.data[0], 0, 'gray_u32.tif: pixel (0,0)');
		assert.strictEqual(img.data[1], 70000, 'gray_u32.tif: pixel (1,0) must survive intact (>65535, would wrap in a Uint16Array carrier)');
		const max = img.data.reduce((m, v) => Math.max(m, v), 0);
		assert.strictEqual(max, 214970000, 'gray_u32.tif: max value must survive exactly (well within Float32 exact-integer range of 2^24)');
		console.log('✅ gray_u32.tif (uint32 grayscale): values above 65535 survive the Rust decoder exactly');
	}

	// 10. CMYK (PhotometricInterpretation 5) is converted to RGB by the Rust
	//     decoder (naive uncalibrated formula: R=(max-C)*(max-K)/max, etc,
	//     max=255 for 8-bit). channels must report 3 (not the raw 4 CMYK
	//     samples), while photometric_interpretation still reports the true
	//     tag value (5) for the Metadata panel. cmyk.tif is a 64x48 8-bit
	//     CMYK image generated with tifffile; expected RGB values computed
	//     independently in Python from the raw CMYK samples via the same
	//     formula (see the test file's comment for the derivation).
	{
		const img = decode(mod, 'cmyk.tif');
		assert.strictEqual(img.width, 64, 'cmyk.tif: width');
		assert.strictEqual(img.height, 48, 'cmyk.tif: height');
		assert.strictEqual(img.channels, 3, 'cmyk.tif: channels must be converted to RGB (3), not left as raw CMYK (4)');
		assert.strictEqual(img.bitsPerSample, 8, 'cmyk.tif: bits_per_sample');
		assert.strictEqual(img.data.length, 64 * 48 * 3, 'cmyk.tif: data length must equal width*height*3 (post-conversion)');

		const buffer = fs.readFileSync(path.join(samplesDir, 'cmyk.tif'));
		const raw = mod.decode_tiff(new Uint8Array(buffer));
		assert.strictEqual(raw.photometric_interpretation, 5,
			'cmyk.tif: photometric_interpretation metadata must still report the true CMYK tag value (5)');

		for (const [coord, rgb] of Object.entries({
			'0,0': [162, 142, 123],   // raw CMYK (0, 31, 62, 93)
			'1,1': [72, 60, 49],      // raw CMYK (65, 96, 127, 158)
			'30,20': [116, 100, 84],  // raw CMYK (30, 61, 92, 123)
		})) {
			const [x, y] = coord.split(',').map(Number);
			const idx = (y * 64 + x) * 3;
			const got = img.data.slice(idx, idx + 3);
			assert.deepStrictEqual(got, rgb, `cmyk.tif: pixel (${x},${y}) must match the CMYK->RGB conversion formula`);
		}
		console.log('✅ cmyk.tif (PhotometricInterpretation 5): converted to RGB (channels=3) with correct values, metadata keeps photometric=5');
	}

	// 11. Orientation tag (274) values 2-8 must be applied as a pixel-buffer
	//     transform (flip/rotate/transpose), normalizing every one of the 8
	//     orientations to the exact same visual layout - width/height are
	//     swapped for the transpose variants (5-8). Each orientation_tagN.tif
	//     fixture stores the SAME visual image pre-transformed on disk (the
	//     mathematical inverse of the decoder's correction) with Orientation=N,
	//     generated by scratchpad/make_orientation_fixtures.py; a correct
	//     decode of every fixture must produce this identical expected array.
	{
		const W = 5, H = 4;
		const expected = [];
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				expected.push(x * 10 + 5, y * 20 + 5, 200);
			}
		}
		for (let orientation = 1; orientation <= 8; orientation++) {
			const img = decode(mod, `orientation_tag${orientation}.tif`);
			assert.strictEqual(img.width, W, `orientation_tag${orientation}.tif: width must be normalized (not swapped)`);
			assert.strictEqual(img.height, H, `orientation_tag${orientation}.tif: height must be normalized (not swapped)`);
			assert.strictEqual(img.channels, 3, `orientation_tag${orientation}.tif: channels`);
			assert.deepStrictEqual(img.data, expected,
				`orientation_tag${orientation}.tif: pixels must be normalized to the same visual layout as orientation=1`);
		}
		console.log('✅ Orientation tag (274) values 1-8: every orientation normalizes to the identical visual pixel layout');
	}

	// 11b. The Orientation tag must also be honored by the CCITT and
	//      JPEG-YCbCr early-return decode paths (decode_ccitt /
	//      decode_jpeg_ycbcr in wasm/tiff-decoder), which used to bypass the
	//      main pipeline's Orientation handling entirely - an oriented fax or
	//      JPEG-in-TIFF would decode un-rotated. `ccitt_g4_orientation4.tif`
	//      and `jpeg_ycbcr_color_orientation4.tif` are byte-for-byte copies of
	//      their untagged originals with an Orientation=4 (bottom-left) tag
	//      spliced in via `tiffset -s 274 4`, so no on-disk pixel data
	//      changed - only the decoder's interpretation should. Orientation 4
	//      is a pure vertical flip (row 0 <-> row H-1, no transpose), so the
	//      expected result is computed by flipping the untagged decode here,
	//      making the assertion self-verifying without external ground truth.
	function flipVertical(data, width, height, channels) {
		const out = new Array(data.length);
		for (let y = 0; y < height; y++) {
			const srcRow = (height - 1 - y) * width * channels;
			const dstRow = y * width * channels;
			for (let i = 0; i < width * channels; i++) {
				out[dstRow + i] = data[srcRow + i];
			}
		}
		return out;
	}
	{
		const untagged = decode(mod, 'ccitt_g4.tif');
		const tagged = decode(mod, 'ccitt_g4_orientation4.tif');
		assert.strictEqual(tagged.compression, 4, 'ccitt_g4_orientation4.tif: compression tag');
		assert.strictEqual(tagged.width, untagged.width, 'ccitt_g4_orientation4.tif: width must not be swapped (orientation 4 does not transpose)');
		assert.strictEqual(tagged.height, untagged.height, 'ccitt_g4_orientation4.tif: height must not be swapped');
		assert.strictEqual(tagged.channels, untagged.channels, 'ccitt_g4_orientation4.tif: channels');
		const expected = flipVertical(untagged.data, untagged.width, untagged.height, untagged.channels);
		assert.deepStrictEqual(tagged.data, expected,
			'ccitt_g4_orientation4.tif: Orientation=4 must vertically flip the CCITT-decoded pixels');
		console.log('✅ CCITT (compression 4) honors the Orientation tag: orientation 4 vertically flips the decoded fax image');
	}
	{
		const untagged = decode(mod, 'jpeg_ycbcr_color.tif');
		const tagged = decode(mod, 'jpeg_ycbcr_color_orientation4.tif');
		assert.strictEqual(tagged.compression, 7, 'jpeg_ycbcr_color_orientation4.tif: compression tag');
		assert.strictEqual(tagged.width, untagged.width, 'jpeg_ycbcr_color_orientation4.tif: width must not be swapped (orientation 4 does not transpose)');
		assert.strictEqual(tagged.height, untagged.height, 'jpeg_ycbcr_color_orientation4.tif: height must not be swapped');
		assert.strictEqual(tagged.channels, untagged.channels, 'jpeg_ycbcr_color_orientation4.tif: channels');
		const expected = flipVertical(untagged.data, untagged.width, untagged.height, untagged.channels);
		assert.deepStrictEqual(tagged.data, expected,
			'jpeg_ycbcr_color_orientation4.tif: Orientation=4 must vertically flip the decoded JPEG-YCbCr pixels');
		console.log('✅ JPEG-YCbCr (photometric 6) honors the Orientation tag: orientation 4 vertically flips the decoded image');
	}

	// 12. BigTIFF (8-byte offsets) regression guards: an uncompressed BigTIFF
	//     and a Deflate-compressed tiled BigTIFF must decode with the correct
	//     dimensions and exact pixel values. Ground truth extracted
	//     independently via tifffile.imread.
	{
		const img = decode(mod, 'bigtiff_u16.tif');
		assert.strictEqual(img.width, 64, 'bigtiff_u16.tif: width');
		assert.strictEqual(img.height, 48, 'bigtiff_u16.tif: height');
		assert.strictEqual(img.channels, 1, 'bigtiff_u16.tif: channels');
		assert.strictEqual(img.bitsPerSample, 16, 'bigtiff_u16.tif: bits_per_sample');
		assert.strictEqual(img.data[0], 0, 'bigtiff_u16.tif: pixel (0,0)');
		assert.strictEqual(img.data[1 * 64 + 2], 66, 'bigtiff_u16.tif: pixel (2,1)');
		const max = img.data.reduce((m, v) => Math.max(m, v), 0);
		assert.strictEqual(max, 3071, 'bigtiff_u16.tif: max value');
		console.log('✅ bigtiff_u16.tif (uncompressed BigTIFF): decodes with correct dimensions and exact pixel values');
	}
	{
		const img = decode(mod, 'bigtiff_deflate_tiled.tif');
		assert.strictEqual(img.width, 64, 'bigtiff_deflate_tiled.tif: width');
		assert.strictEqual(img.height, 48, 'bigtiff_deflate_tiled.tif: height');
		assert.strictEqual(img.channels, 3, 'bigtiff_deflate_tiled.tif: channels');
		assert.strictEqual(img.compression, 8, 'bigtiff_deflate_tiled.tif: Deflate compression tag');
		assert.deepStrictEqual(img.data.slice(0, 3), [0, 17, 34], 'bigtiff_deflate_tiled.tif: pixel (0,0)');
		assert.deepStrictEqual(img.data.slice((10 * 64 + 20) * 3, (10 * 64 + 20) * 3 + 3), [148, 165, 182],
			'bigtiff_deflate_tiled.tif: pixel (20,10)');
		console.log('✅ bigtiff_deflate_tiled.tif (Deflate-compressed tiled BigTIFF): decodes with correct dimensions and exact pixel values');
	}

	// 13. Multi-page TIFFs expose their page count and decode the selected IFD,
	//     including page-local sample types and metadata.
	{
		const bytes = new Uint8Array(fs.readFileSync(path.join(samplesDir, 'multipage_rgb_depth_mask.tif')));
		assert.strictEqual(mod.tiff_page_count(bytes), 3, 'multipage fixture page count');

		const color = mod.decode_tiff_page_fast(bytes, 0);
		const depth = mod.decode_tiff_page_fast(bytes, 1);
		const mask = mod.decode_tiff_page_fast(bytes, 2);
		assert.deepStrictEqual([color.width, color.height, color.channels, color.sample_format], [48, 32, 3, 1]);
		assert.deepStrictEqual([depth.width, depth.height, depth.channels, depth.sample_format], [48, 32, 1, 3]);
		assert.deepStrictEqual([mask.width, mask.height, mask.channels, mask.sample_format], [48, 32, 1, 1]);
		assert.ok(depth.get_data_as_f32().some(v => v > 0 && v < 10), 'depth page should expose float values');
		assert.ok(mask.get_data_as_f32().every(v => v === 0 || v === 255), 'mask page should contain only its binary samples');
		assert.ok(depth.all_tags_json.includes('depth'), 'page 2 metadata should come from page 2 IFD');
		assert.throws(() => mod.decode_tiff_page_fast(bytes, 3), /out of range/i);
		console.log('✅ Multi-page TIFF: page count, arbitrary IFD decoding, sample types, and page-local metadata');
	}

	console.log('\n🎉 All WASM TIFF decoder tests passed.\n');
}

main().catch(err => {
	console.error('❌ WASM TIFF decoder test failed:');
	console.error(err);
	process.exit(1);
});

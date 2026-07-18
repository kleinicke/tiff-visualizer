/**
 * Regression test for TiffProcessor.decodeAllPages() — the multi-page decode
 * path behind "Open TIFF Pages as Layers" (src/imagePreview/commands.ts) —
 * and the page-layer naming precedence mirrored from media/imagePreview.js.
 *
 * tiff-processor.js is a webview module (references `window.GeoTIFF` and the
 * browser `fetch`), so it's loaded here with the minimal globals it needs
 * stubbed: `window.GeoTIFF` is the real `geotiff` npm package, and `fetch` is
 * a tiny file-reading shim. Everything else (WASM init, WebGL) already
 * degrades gracefully without a browser and is exercised by other tests.
 *
 * Fixtures (both 3 pages: uint8 RGB, float32 1-ch depth, uint8 1-ch mask):
 *   - multipage_rgb_depth_mask.tif    — PageName tag on every page (tifffile
 *     also writes its shaped-metadata JSON into ImageDescription).
 *   - multipage_description_only.tif  — no PageName; a short single-line
 *     ImageDescription per page instead.
 * Regenerate with tifffile:
 *   python3 -c "
 *   import numpy as np, tifffile
 *   h, w = 32, 48
 *   rng = np.random.default_rng(42)
 *   rgb = rng.integers(0, 256, size=(h, w, 3), dtype=np.uint8)
 *   depth = (rng.random((h, w), dtype=np.float32) * 10.0).astype(np.float32)
 *   mask = (rng.integers(0, 2, size=(h, w)) * 255).astype(np.uint8)
 *   with tifffile.TiffWriter('test-samples/multipage_rgb_depth_mask.tif') as tw:
 *       tw.write(rgb, photometric='rgb', extratags=[(285, 's', 0, 'color', True)])
 *       tw.write(depth, photometric='minisblack', extratags=[(285, 's', 0, 'depth', True)])
 *       tw.write(mask, photometric='minisblack', extratags=[(285, 's', 0, 'mask', True)])
 *   h, w = 24, 36
 *   rng = np.random.default_rng(7)
 *   rgb = rng.integers(0, 256, size=(h, w, 3), dtype=np.uint8)
 *   depth = (rng.random((h, w), dtype=np.float32) * 5.0).astype(np.float32)
 *   mask = (rng.integers(0, 2, size=(h, w)) * 255).astype(np.uint8)
 *   with tifffile.TiffWriter('test-samples/multipage_description_only.tif') as tw:
 *       tw.write(rgb, photometric='rgb', description='left camera RGB', metadata=None)
 *       tw.write(depth, photometric='minisblack', description='disparity (px)', metadata=None)
 *       tw.write(mask, photometric='minisblack', description='valid-pixel mask', metadata=None)
 *   "
 *
 * Run with: node test/tiff-multipage-decode-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const samplesDir = path.join(__dirname, '..', 'test-samples');
const namedFixture = path.join(samplesDir, 'multipage_rgb_depth_mask.tif');
const descFixture = path.join(samplesDir, 'multipage_description_only.tif');

// Minimal browser shims tiff-processor.js needs at import/construct time.
global.window = { GeoTIFF: require('geotiff') };
global.fetch = async (filePath) => {
	const buf = fs.readFileSync(filePath);
	const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	return { arrayBuffer: async () => arrayBuffer };
};

// Mirror of tiffPageLayerName in media/imagePreview.js: PageName, else a short
// single-line ImageDescription, else "<basename> — page N" (1-based).
function pageLayerName(page, baseName, index) {
	if (page.pageName) { return page.pageName; }
	const desc = (page.imageDescription || '').trim();
	if (desc && desc.length <= 48 && !desc.includes('\n')) { return desc; }
	return `${baseName} — page ${index + 1}`;
}

async function main() {
	if (!fs.existsSync(namedFixture) || !fs.existsSync(descFixture)) {
		console.log('⚠️  Multi-page TIFF fixtures not found in test-samples/ — skipping.');
		return;
	}

	console.log('🧪 Running TIFF multi-page decode tests...\n');

	const { TiffProcessor } = await import(
		path.join('..', 'out', 'media', 'modules', 'tiff-processor.js').replace(/\\/g, '/')
	);
	const p = new TiffProcessor(/** @type {any} */ (null), null);

	// --- Fixture with PageName tags ---
	const pages = await p.decodeAllPages(namedFixture);

	assert.strictEqual(pages.length, 3, 'expected 3 pages');
	console.log(`✅ Decoded ${pages.length} pages (PageName fixture)`);

	const [color, depth, mask] = pages;

	assert.strictEqual(color.ifd.width, 48);
	assert.strictEqual(color.ifd.height, 32);
	assert.strictEqual(color.ifd.t277, 3, 'page 0 (color) should have 3 channels');
	assert.strictEqual(color.ifd.t258, 8, 'page 0 (color) should be 8-bit');
	assert.strictEqual(color.ifd.t262, 2, 'page 0 (color) photometric should be RGB (2)');
	assert.strictEqual(color.pageName, 'color');
	assert.strictEqual(color.data.length, 48 * 32 * 3);
	assert.ok(color.data instanceof Uint8Array, 'page 0 should decode to Uint8Array');
	console.log('✅ Page 0 (color): 48x32, 3 channels, 8-bit, RGB, PageName="color"');

	assert.strictEqual(depth.ifd.width, 48);
	assert.strictEqual(depth.ifd.height, 32);
	assert.strictEqual(depth.ifd.t277, 1, 'page 1 (depth) should have 1 channel');
	assert.strictEqual(depth.ifd.t339, 3, 'page 1 (depth) should be IEEE float (SampleFormat=3)');
	assert.strictEqual(depth.ifd.t262, 1, 'page 1 (depth) photometric should be MinIsBlack (1)');
	assert.strictEqual(depth.pageName, 'depth');
	assert.strictEqual(depth.data.length, 48 * 32);
	assert.ok(depth.data instanceof Float32Array, 'page 1 should decode to Float32Array');
	console.log('✅ Page 1 (depth): 48x32, 1 channel, float32, PageName="depth"');

	assert.strictEqual(mask.ifd.width, 48);
	assert.strictEqual(mask.ifd.height, 32);
	assert.strictEqual(mask.ifd.t277, 1, 'page 2 (mask) should have 1 channel');
	assert.strictEqual(mask.ifd.t258, 8, 'page 2 (mask) should be 8-bit');
	assert.strictEqual(mask.pageName, 'mask');
	assert.strictEqual(mask.data.length, 48 * 32);
	assert.ok(mask.data instanceof Uint8Array, 'page 2 should decode to Uint8Array');
	console.log('✅ Page 2 (mask): 48x32, 1 channel, 8-bit, PageName="mask"');

	// tifffile wrote its shaped-metadata JSON into ImageDescription; PageName
	// must still win the naming precedence.
	assert.ok(color.imageDescription && color.imageDescription.includes('"shape"'),
		'page 0 should expose the ImageDescription tag');
	assert.deepStrictEqual(
		pages.map((pg, i) => pageLayerName(pg, 'f.tif', i)),
		['color', 'depth', 'mask'],
		'PageName should take precedence over ImageDescription');
	console.log('✅ Naming: PageName wins over ImageDescription');

	// Visibility default logic (mirrored from media/imagePreview.js
	// addTiffPagesAsLayers): channels >= 3 => visible, else hidden.
	const wouldBeVisible = pages.map(pg => pg.ifd.t277 >= 3);
	assert.deepStrictEqual(wouldBeVisible, [true, false, false],
		'only the color page should default to visible');
	console.log('✅ Visibility defaults: color visible, depth/mask hidden');

	// --- Fixture with only ImageDescription (no PageName) ---
	const descPages = await p.decodeAllPages(descFixture);

	assert.strictEqual(descPages.length, 3, 'expected 3 pages');
	assert.deepStrictEqual(descPages.map(pg => pg.pageName),
		[undefined, undefined, undefined], 'fixture must have no PageName tags');
	assert.deepStrictEqual(descPages.map(pg => pg.imageDescription),
		['left camera RGB', 'disparity (px)', 'valid-pixel mask'],
		'ImageDescription should be extracted NUL-stripped');
	assert.deepStrictEqual(
		descPages.map((pg, i) => pageLayerName(pg, 'f.tif', i)),
		['left camera RGB', 'disparity (px)', 'valid-pixel mask'],
		'short single-line ImageDescription should be used as the layer name');
	console.log('✅ Naming: short single-line ImageDescription used when PageName is absent');

	// Long or multi-line descriptions (ImageJ/tifffile metadata blobs) must
	// fall back to "<basename> — page N".
	const blob = { pageName: undefined, imageDescription: 'ImageJ=1.53\nimages=3\nslices=3' };
	const long = { pageName: undefined, imageDescription: 'x'.repeat(60) };
	assert.strictEqual(pageLayerName(blob, 'f.tif', 1), 'f.tif — page 2');
	assert.strictEqual(pageLayerName(long, 'f.tif', 2), 'f.tif — page 3');
	console.log('✅ Naming: multi-line / long ImageDescription falls back to "— page N"');

	console.log('\n🎉 All TIFF multi-page decode tests passed.\n');
}

main().catch(err => {
	console.error('❌ TIFF multi-page decode test failed:');
	console.error(err);
	process.exit(1);
});

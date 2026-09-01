/**
 * GeoTIFF georeferencing, end to end: Rust unpacks the key directory and the
 * model transform, and `media/modules/geo-reference.ts` turns that into the
 * string under the cursor.
 *
 * The Rust unit tests in `formats/tiff/geokeys.rs` cover the parsing rules
 * against synthesized directories. This covers the other half — real files
 * through the real WebAssembly module, and the pixel-to-coordinate arithmetic
 * the parser does not do — because the two halves fail differently: a correct
 * parser still shows the wrong place if the half-pixel convention or the
 * northing sign is applied wrongly here.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const samplesDir = path.join(__dirname, '..', 'test-samples');

async function main() {
	const wasmJs = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.js');
	const wasmBin = path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.wasm');
	const geoJsPath = path.join(__dirname, '..', 'out', 'media', 'modules', 'geo-reference.js');
	if (!fs.existsSync(wasmBin) || !fs.existsSync(geoJsPath)) {
		console.log('⚠️  build outputs not found — run `npm run compile` first. Skipping.');
		return;
	}
	if (!fs.existsSync(path.join(samplesDir, 'geotiff_utm31n.tif'))) {
		console.log('⚠️  GeoTIFF fixtures not found — run scripts/make-geotiff-testdata.py. Skipping.');
		return;
	}

	const wasm = await import(wasmJs.replace(/\\/g, '/'));
	await wasm.default({ module_or_path: fs.readFileSync(wasmBin) });
	const { parseGeoReference, formatMapPosition, mapCoordinate } =
		await import(geoJsPath.replace(/\\/g, '/'));

	console.log('🧪 Running GeoTIFF tests...\n');
	let count = 0;

	const geoOf = (file) => {
		const bytes = new Uint8Array(fs.readFileSync(path.join(samplesDir, file)));
		return parseGeoReference(wasm.decode_tiff_fast(bytes).geo_json);
	};

	// --- A projected raster: CRS naming and the northing sign ----------------
	{
		const geo = geoOf('geotiff_utm31n.tif');
		assert.ok(geo, 'the UTM fixture is georeferenced');
		assert.strictEqual(geo.crs, 'EPSG:32631 (WGS 84 / UTM zone 31N)');
		assert.strictEqual(geo.isGeographic, false);
		assert.strictEqual(geo.unit, 'metre');

		// PixelIsArea: the tiepoint is the raster's top-left CORNER, so the
		// centre of pixel (0,0) is half a pixel — 5 m — into the raster.
		const first = mapCoordinate(geo, 0, 0);
		assert.strictEqual(first.x, 300005, 'easting is the corner plus half a pixel');
		assert.strictEqual(first.y, 5699995, 'northing is the corner MINUS half a pixel');

		// The sign trap: rows run down the image, northing runs up the map.
		const lower = mapCoordinate(geo, 0, 10);
		assert.ok(lower.y < first.y, 'moving DOWN the raster must DECREASE northing');
		assert.strictEqual(lower.y, 5699895);

		assert.strictEqual(formatMapPosition(geo, 0, 0), 'E 300005.00 m, N 5699995.00 m');
		console.log('✅ EPSG:32631 names its UTM zone, and northing decreases down the raster');
		count++;
	}

	// --- A geographic raster reads as lon/lat --------------------------------
	{
		const geo = geoOf('geotiff_wgs84.tif');
		assert.strictEqual(geo.crs, 'EPSG:4326 (WGS 84)');
		assert.strictEqual(geo.isGeographic, true);
		assert.strictEqual(formatMapPosition(geo, 0, 0), '49.995000°N 10.005000°E');
		console.log('✅ a geographic CRS reads as degrees with hemispheres');
		count++;
	}

	// --- ModelTransformation carries rotation --------------------------------
	{
		const geo = geoOf('geotiff_rotated.tif');
		assert.ok(geo.transform, 'the rotated fixture georeferences through 34264');
		// A rotated raster's row direction has an EAST component, which an
		// axis-aligned reading of scale+tiepoint would lose entirely.
		const origin = mapCoordinate(geo, 0, 0);
		const oneRowDown = mapCoordinate(geo, 0, 1);
		assert.ok(Math.abs(oneRowDown.x - origin.x) > 1,
			'moving down a rotated raster must also move east/west');
		console.log('✅ a rotated raster is placed through ModelTransformation');
		count++;
	}

	// --- PixelIsPoint gets no half-pixel shift -------------------------------
	{
		const geo = geoOf('geotiff_pixelispoint.tif');
		assert.strictEqual(geo.pixelIsPoint, true);
		const first = mapCoordinate(geo, 0, 0);
		// PixelIsPoint means the tiepoint already refers to the pixel's centre.
		// Shifting it again would move every sample by half a pixel — the
		// classic silent DEM-versus-imagery error.
		assert.strictEqual(first.x, -20, 'PixelIsPoint takes the tiepoint as-is');
		assert.strictEqual(first.y, 65);
		assert.strictEqual(formatMapPosition(geo, 0, 0), '65.000000°N 20.000000°W');
		console.log('✅ PixelIsPoint is sampled at the tiepoint, not half a pixel off');
		count++;
	}

	// --- A plain TIFF carries none of this -----------------------------------
	{
		const bytes = new Uint8Array(fs.readFileSync(path.join(samplesDir, 'shapes_lzw_tiled.tif')));
		const raw = wasm.decode_tiff_fast(bytes).geo_json;
		assert.strictEqual(raw, '', 'a non-geo TIFF reports no georeferencing');
		assert.strictEqual(parseGeoReference(raw), null);
		assert.strictEqual(formatMapPosition(null, 0, 0), '',
			'no georeferencing produces no readout rather than a wrong one');
		console.log('✅ an ordinary TIFF reports no georeferencing');
		count++;
	}

	console.log(`\n🎉 All ${count} GeoTIFF checks passed.`);
}

main().catch(error => {
	console.error('❌ GeoTIFF test failed:');
	console.error(error);
	process.exit(1);
});

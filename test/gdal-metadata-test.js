/**
 * Tests for GDAL's per-band metadata (media/modules/gdal-metadata.ts).
 *
 * The point of this parser is agreement with other tools: a band declaring
 * SCALE=0.001 stores 1234 and MEANS 1.234, and a reader that ignores the tag
 * reports values a thousand times too large with nothing on screen to explain
 * it. The tag is also a free-form store, so unknown items must be ignored
 * rather than treated as failure.
 *
 * Run with: node test/gdal-metadata-test.js
 */

const assert = require('assert');
const path = require('path');

const REPORTED_FILE_XML = `<GDALMetadata>
  <Item name="OVERVIEW_RESAMPLING">NEAREST</Item>
  <Item name="OFFSET" sample="0" role="offset">0</Item>
  <Item name="SCALE" sample="0" role="scale">0.001</Item>
  <Item name="DESCRIPTION" sample="0" role="description">yearly rate of change</Item>
  <Item name="OFFSET" sample="1" role="offset">10</Item>
  <Item name="SCALE" sample="1" role="scale">0.001</Item>
  <Item name="DESCRIPTION" sample="1" role="description">level @ period end date</Item>
</GDALMetadata>`;

async function main() {
	console.log('🧪 Running GDAL band-metadata tests...\n');

	const {
		parseGdalMetadataXml, parseGdalMetadata, applyBandScaling, hasBandScaling, bandDescription,
	} = await import(
		path.join('..', 'out', 'media', 'modules', 'gdal-metadata.js').replace(/\\/g, '/')
	);

	// 1. The shape GDAL actually writes, from the file in issue #12.
	{
		const metadata = parseGdalMetadataXml(REPORTED_FILE_XML);
		assert.strictEqual(metadata.bands.length, 2);
		assert.strictEqual(metadata.bands[0].scale, 0.001);
		assert.strictEqual(metadata.bands[0].offset, 0);
		assert.strictEqual(metadata.bands[0].description, 'yearly rate of change');
		assert.strictEqual(metadata.bands[1].offset, 10);
		assert.strictEqual(metadata.dataset.OVERVIEW_RESAMPLING, 'NEAREST',
			'items without a sample attribute belong to the dataset, not a band');
		console.log('✅ Parses the per-band scale, offset and description GDAL writes');
	}

	// 2. Physical value = raw * scale + offset, per band.
	{
		const metadata = parseGdalMetadataXml(REPORTED_FILE_XML);
		assert.strictEqual(applyBandScaling(metadata, 0, 1234), 1.234);
		assert.ok(Math.abs(applyBandScaling(metadata, 1, 1234) - 11.234) < 1e-9,
			'the offset applies after the scale, and is per band');
		assert.strictEqual(applyBandScaling(metadata, 7, 1234), 1234,
			'a band the file says nothing about keeps its raw value');
		assert.strictEqual(applyBandScaling(null, 0, 1234), 1234);
		assert.ok(hasBandScaling(metadata));
		assert.strictEqual(bandDescription(metadata, 1), 'level @ period end date');
		console.log('✅ Applies scale and offset per band, and leaves undeclared bands alone');
	}

	// 3. An identity declaration is not scaling — the readout must not switch
	//    to a "physical units" presentation for a file that has none.
	{
		const identity = parseGdalMetadataXml(
			'<GDALMetadata><Item name="SCALE" sample="0" role="scale">1</Item>' +
			'<Item name="OFFSET" sample="0" role="offset">0</Item></GDALMetadata>');
		assert.ok(!hasBandScaling(identity), 'scale 1 / offset 0 changes nothing');
		console.log('✅ An identity scale is not treated as scaling');
	}

	// 4. Absence and rubbish are answered, not thrown on.
	{
		for (const input of [undefined, null, '', 'not xml', '<GDALMetadata></GDALMetadata>']) {
			const metadata = parseGdalMetadataXml(input);
			assert.deepStrictEqual(metadata.bands, []);
			assert.ok(!hasBandScaling(metadata));
		}
		// A free-form store contains items no version of GDAL wrote.
		const odd = parseGdalMetadataXml(
			'<GDALMetadata><Item name="SOMETHING_NEW" sample="0">x</Item>' +
			'<Item name="SCALE" sample="0" role="scale">2</Item></GDALMetadata>');
		assert.strictEqual(odd.bands.length, 1);
		assert.strictEqual(odd.bands[0].scale, 2, 'an unknown item does not stop the known ones');
		console.log('✅ Missing, malformed and unrecognized metadata are handled without throwing');
	}

	// 5. Found by tag id on the Rust path and by name on the geotiff.js one,
	//    matching how the nodata tag is located.
	{
		const byId = parseGdalMetadata([{ tag: 42112, name: 'Unknown(42112)', group: 'TIFF', value: REPORTED_FILE_XML }]);
		assert.strictEqual(byId.bands.length, 2);
		const byName = parseGdalMetadata([{ tag: null, name: 'GDAL_METADATA', group: 'TIFF', value: REPORTED_FILE_XML }]);
		assert.strictEqual(byName.bands.length, 2);
		assert.deepStrictEqual(parseGdalMetadata([]).bands, []);
		assert.deepStrictEqual(parseGdalMetadata(undefined).bands, []);
		console.log('✅ Located by tag id or by name, whichever the decode path provides');
	}

	console.log('\n🎉 All GDAL band-metadata tests passed.\n');
}

main().catch(error => {
	console.error('❌ GDAL band-metadata test failed:');
	console.error(error);
	process.exit(1);
});

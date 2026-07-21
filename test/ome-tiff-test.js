/**
 * OME-XML parsing and C/Z/T -> TIFF IFD mapping tests.
 * Run with: node test/ome-tiff-test.js (after npm run compile:quick)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

function loadOmeMetadataFileModule() {
	const file = path.join(__dirname, '..', 'src', 'imagePreview', 'omeMetadataFile.ts');
	const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	}).outputText;
	const loaded = { exports: {} };
	new Function('exports', 'require', 'module', '__filename', '__dirname', output)(loaded.exports, require, loaded, file, path.dirname(file));
	return loaded.exports;
}

async function main() {
	const {
		findOmeXmlInTags,
		omeCoordinatesToIfd,
		omeIfdToCoordinates,
		parseOmeBinaryOnly,
		parseOmeXml,
		parseOmeXmlImages,
	} = await import(path.join('..', 'out', 'media', 'modules', 'ome-tiff.js').replace(/\\/g, '/'));

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
	<ome:OME xmlns:ome="http://www.openmicroscopy.org/Schemas/OME/2016-06" Creator="Unit &amp; Integration">
	  <ome:Instrument ID="Instrument:0">
	    <ome:Objective ID="Objective:0" Manufacturer="Nikon" Model="Plan Apo" NominalMagnification="60" LensNA="1.4" Immersion="Oil"/>
	  </ome:Instrument>
	  <ome:Image ID="Image:0" Name="DAPI &amp; GFP stack">
	    <ome:ObjectiveSettings ID="Objective:0"/>
	    <ome:Pixels ID="Pixels:0" DimensionOrder="XYTCZ" Type="uint16" SizeX="64" SizeY="32" SizeC="2" SizeZ="3" SizeT="2"
	      PhysicalSizeX="0.108" PhysicalSizeXUnit="µm" PhysicalSizeY="0.108" PhysicalSizeYUnit="µm" PhysicalSizeZ="0.5" PhysicalSizeZUnit="µm">
	      <ome:Channel ID="Channel:0:0" Name="DAPI" Color="65535" SamplesPerPixel="1"/>
	      <ome:Channel ID="Channel:0:1" Name="GFP" Color="16711935" SamplesPerPixel="1"/>
	      <ome:TiffData IFD="9" FirstC="1" FirstZ="2" FirstT="1" PlaneCount="1"/>
	      <ome:TiffData IFD="0" FirstC="0" FirstZ="0" FirstT="0" PlaneCount="9"/>
	    </ome:Pixels>
	  </ome:Image>
	</ome:OME>`;

	const metadata = parseOmeXml(xml);
	assert.ok(metadata, 'namespace-prefixed OME XML should parse');
	assert.strictEqual(metadata.creator, 'Unit & Integration');
	assert.strictEqual(metadata.imageName, 'DAPI & GFP stack');
	assert.strictEqual(metadata.dimensionOrder, 'XYTCZ');
	assert.deepStrictEqual([metadata.planeSizeC, metadata.sizeZ, metadata.sizeT], [2, 3, 2]);
	assert.deepStrictEqual(metadata.channels.map(channel => channel.name), ['DAPI', 'GFP']);
	assert.strictEqual(metadata.channels[0].colorCss, '#0000ffff');
	assert.strictEqual(metadata.physicalSizeX, 0.108);
	assert.strictEqual(metadata.objective.model, 'Plan Apo');
	assert.strictEqual(metadata.objective.nominalMagnification, 60);
	assert.strictEqual(metadata.objective.lensNA, 1.4);

	// XYTCZ means T is fastest, then C, then Z. Explicit TiffData wins for
	// the final coordinate, while PlaneCount expands the other mapping.
	assert.strictEqual(omeCoordinatesToIfd(metadata, { c: 0, z: 0, t: 0 }), 0);
	assert.strictEqual(omeCoordinatesToIfd(metadata, { c: 0, z: 0, t: 1 }), 1);
	assert.strictEqual(omeCoordinatesToIfd(metadata, { c: 1, z: 0, t: 0 }), 2);
	assert.strictEqual(omeCoordinatesToIfd(metadata, { c: 1, z: 2, t: 1 }), 9);
	assert.deepStrictEqual(omeIfdToCoordinates(metadata, 9), { c: 1, z: 2, t: 1 });

	const extracted = findOmeXmlInTags([{ tag: 270, name: 'ImageDescription', group: 'TIFF', value: xml }]);
	assert.strictEqual(extracted, xml);
	assert.strictEqual(parseOmeXml('<not-ome/>'), null);
	const defaultMapping = parseOmeXml(
		'<OME><Image><Pixels DimensionOrder="XYZTC" SizeX="1" SizeY="1" SizeZ="2" SizeT="2" SizeC="1"><TiffData/></Pixels></Image></OME>'
	);
	assert.strictEqual(defaultMapping.tiffData[0].planeCount, 4, 'attribute-free TiffData maps every plane');
	assert.strictEqual(omeCoordinatesToIfd(defaultMapping, { c: 0, z: 1, t: 1 }), 3);

	const multiFile = parseOmeXml(
		'<OME UUID="urn:uuid:dataset"><Image ID="Image:0" Name="Fileset"><Pixels DimensionOrder="XYZTC" SizeX="1" SizeY="1" SizeZ="2" SizeT="1" SizeC="2">' +
		'<Channel Name="DAPI"/><Channel Name="GFP"/>' +
		'<TiffData IFD="0" FirstC="0" FirstZ="0" FirstT="0" PlaneCount="2"><UUID FileName="c0.ome.tif">urn:uuid:c0</UUID></TiffData>' +
		'<TiffData IFD="0" FirstC="1" FirstZ="0" FirstT="0" PlaneCount="2"><UUID FileName="c1.ome.tif">urn:uuid:c1</UUID></TiffData>' +
		'</Pixels></Image></OME>'
	);
	assert.strictEqual(multiFile.coordinateToPlane['0,1,0'].fileName, 'c0.ome.tif');
	assert.strictEqual(multiFile.coordinateToPlane['0,1,0'].ifd, 1);
	assert.strictEqual(multiFile.coordinateToPlane['1,0,0'].fileName, 'c1.ome.tif');
	assert.strictEqual(multiFile.coordinateToPlane['1,0,0'].uuid, 'urn:uuid:c1');

	// Exercise a real OME-TIFF when the shared scientific fixture repository is
	// present. The test remains portable for clean checkouts.
	const realFixture = '/Users/florian/Projects/cursor/test_data/testfiles/exampletiffs/4D-series.ome.tif';
	if (fs.existsSync(realFixture)) {
		const GeoTIFF = require('geotiff');
		const bytes = fs.readFileSync(realFixture);
		const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
		const firstImage = await tiff.getImage(0);
		const real = parseOmeXml(firstImage.fileDirectory.ImageDescription);
		assert.ok(real);
		assert.deepStrictEqual([real.sizeC, real.sizeZ, real.sizeT], [1, 5, 7]);
		assert.strictEqual(await tiff.getImageCount(), 35);
		assert.strictEqual(omeCoordinatesToIfd(real, { c: 0, z: 4, t: 6 }), 34);

		const wasm = await import(path.join('..', 'media', 'wasm', 'tiff-wasm.js').replace(/\\/g, '/'));
		await wasm.default({ module_or_path: fs.readFileSync(path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.wasm')) });
		const page34 = wasm.decode_tiff_page_fast(new Uint8Array(bytes), 34);
		assert.ok(page34.ome_xml.includes('<OME'), 'later-page WASM results must retain first-IFD OME-XML');
		assert.strictEqual(wasm.tiff_page_count(new Uint8Array(bytes)), 35);
		console.log('✅ Real 4D-series.ome.tif: C1 × Z5 × T7 maps to 35 IFDs');
	}

	const multiFileFixture = '/Users/florian/Projects/cursor/test_data/testfiles/exampletiffs/ometiff_testdata/tubhiswt-4D/tubhiswt_C0_TP0.ome.tif';
	if (fs.existsSync(multiFileFixture)) {
		const GeoTIFF = require('geotiff');
		const bytes = fs.readFileSync(multiFileFixture);
		const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
		const firstImage = await tiff.getImage(0);
		const real = parseOmeXml(firstImage.fileDirectory.ImageDescription);
		assert.ok(real);
		assert.deepStrictEqual([real.planeSizeC, real.sizeZ, real.sizeT], [2, 10, 43]);
		assert.strictEqual(Object.keys(real.coordinateToPlane).length, 860);
		assert.strictEqual(new Set(Object.values(real.coordinateToPlane).map(plane => plane.fileName)).size, 86);
		assert.strictEqual(real.coordinateToPlane['1,9,42'].fileName, 'tubhiswt_C1_TP42.ome.tif');
		assert.strictEqual(real.coordinateToPlane['1,9,42'].ifd, 9);
		console.log('✅ Real tubhiswt-4D fileset: C2 × Z10 × T43 maps to 86 TIFF files');
	}

	const multipleRoot = '/Users/florian/Projects/cursor/test_data/testfiles/exampletiffs/ometiff_testdata/multiples';
	const multiImageFixture = path.join(multipleRoot, 'multi_image_node', 'TSeries-camp-005_Cycle00001_Ch1_000001.ome.tif');
	if (fs.existsSync(multiImageFixture)) {
		const GeoTIFF = require('geotiff');
		const bytes = fs.readFileSync(multiImageFixture);
		const tiff = await GeoTIFF.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
		const description = (await tiff.getImage(0)).fileDirectory.ImageDescription;
		const images = parseOmeXmlImages(description);
		assert.strictEqual(images.length, 3);
		assert.deepStrictEqual(images.map(image => image.imageName), ['Sequence:1', 'Sequence:2', 'Sequence:3']);
		assert.ok(images.every(image => Object.keys(image.coordinateToPlane).length === 8));
		assert.strictEqual(new Set(images.flatMap(image => Object.values(image.coordinateToPlane).map(plane => plane.fileName))).size, 24);
		assert.strictEqual(parseOmeXml(description).images.length, 3);
		const hostParsed = loadOmeMetadataFileModule().parseOmeDatasetXml(description);
		assert.strictEqual(hostParsed.series.length, 3);
		assert.ok(hostParsed.series.every(series => series.planes.length === 8));
		console.log('✅ Real multi-Image OME fileset: three series map all 24 TIFF files');
	}

	const masterBinaryFixture = path.join(multipleRoot, 'master', 'multifile-Z2.ome.tiff');
	const companionBinaryFixture = path.join(multipleRoot, 'companion', 'multifile-Z1.ome.tiff');
	if (fs.existsSync(masterBinaryFixture) && fs.existsSync(companionBinaryFixture)) {
		const GeoTIFF = require('geotiff');
		const readDescription = async file => {
			const bytes = fs.readFileSync(file);
			const tiff = await GeoTIFF.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
			return (await tiff.getImage(0)).fileDirectory.ImageDescription;
		};
		assert.deepStrictEqual(parseOmeBinaryOnly(await readDescription(masterBinaryFixture)), {
			metadataFile: 'multifile-Z1.ome.tiff',
			uuid: 'urn:uuid:d25bfea2-2708-4a4f-bcd9-8ab1ac478041',
		});
		assert.strictEqual(parseOmeBinaryOnly(await readDescription(companionBinaryFixture)).metadataFile, 'multifile.companion.ome');
		const companionImages = parseOmeXmlImages(fs.readFileSync(path.join(multipleRoot, 'companion', 'multifile.companion.ome'), 'utf8'));
		assert.strictEqual(companionImages.length, 1);
		assert.strictEqual(Object.keys(companionImages[0].coordinateToPlane).length, 5);
		const { parseOmeDatasetXml, tiffImageDescription } = loadOmeMetadataFileModule();
		const masterXml = tiffImageDescription(fs.readFileSync(path.join(multipleRoot, 'master', 'multifile-Z1.ome.tiff')));
		assert.strictEqual(parseOmeXmlImages(masterXml)[0].sizeZ, 5);
		assert.strictEqual(parseOmeDatasetXml(masterXml).series[0].planes.length, 5);
		console.log('✅ Real master-TIFF and companion-OME BinaryOnly references resolve metadata targets');
	}

	console.log('✅ OME metadata, namespace handling, entities, objective, channel colors, voxel sizes, and TiffData mappings');
}

main().catch(error => {
	console.error('❌ OME-TIFF test failed:');
	console.error(error);
	process.exit(1);
});

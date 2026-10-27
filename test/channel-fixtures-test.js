/**
 * Metadata checks on the real multi-channel fixtures in test-samples/.
 *
 *   - ome_3ch_z.ome.tif: OME-TIFF, 3 named channels (two with file colours), 2 Z planes
 *   - imagej_3ch_labels.tif: ImageJ stack, 3 channels named by slice labels
 *   - shapes_hyper.tif / pred_ref_rgb8.tif: images that must NOT count as
 *     channel stacks (extra samples without metadata, plain RGB)
 *
 * The parsers are tested against hand-built tags in ome-tiff-test.js; this
 * reads the same data out of files written by tifffile, so a change to how
 * either is parsed, or to the fixtures, is caught.
 *
 * Run with: node test/channel-fixtures-test.js (after npm run compile:quick)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const samples = name => path.join(__dirname, '..', 'test-samples', name);

/** Walk every IFD and return { pages, tags } for the first one; tag values as the viewer reports them. */
function readTiff(file) {
	const bytes = fs.readFileSync(file);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const little = bytes[0] === 0x49;
	const u16 = at => view.getUint16(at, little);
	const u32 = at => view.getUint32(at, little);
	const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };
	let offset = u32(4);
	let pages = 0;
	let first = null;
	while (offset && pages < 1000) {
		const count = u16(offset);
		if (pages === 0) {
			first = {};
			for (let i = 0; i < count; i++) {
				const entry = offset + 2 + i * 12;
				const tag = u16(entry);
				const type = u16(entry + 2);
				const n = u32(entry + 4);
				const length = n * (sizes[type] || 1);
				const at = length > 4 ? u32(entry + 8) : entry + 8;
				first[tag] = { type, n, bytes: bytes.subarray(at, at + length) };
			}
		}
		pages++;
		offset = u32(offset + 2 + count * 12);
	}
	return { pages, first };
}

const text = entry => entry ? Buffer.from(entry.bytes).toString('latin1').replace(/\0+$/, '') : '';
/** The tag entries parseImageJLabels reads: private tags 50838/50839 as comma-separated numbers. */
function imageJTags(first) {
	const numbers = (entry, size) => {
		const out = [];
		for (let i = 0; i + size <= entry.bytes.length; i += size) { out.push(Buffer.from(entry.bytes).readUIntLE(i, size)); }
		return out.join(', ');
	};
	return [
		{ tag: 50838, name: 'Unknown(50838)', group: 'TIFF', value: numbers(first[50838], 4) },
		{ tag: 50839, name: 'Unknown(50839)', group: 'TIFF', value: numbers(first[50839], 1) },
	].filter(entry => entry.value !== '');
}

async function main() {
	const ome = await import(path.join('..', 'out', 'media', 'modules', 'ome-tiff.js').replace(/\\/g, '/'));
	let passed = 0;
	const test = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`); };
	console.log('🧪 Running channel fixture metadata tests...\n');

	test('OME-TIFF: 3 named channels, file colours on two, 2 Z planes', () => {
		const { pages, first } = readTiff(samples('ome_3ch_z.ome.tif'));
		assert.strictEqual(pages, 6);
		const metadata = ome.parseOmeXml(text(first[270]));
		assert.ok(metadata);
		assert.deepStrictEqual([metadata.sizeC, metadata.sizeZ, metadata.sizeT], [3, 2, 1]);
		assert.deepStrictEqual(metadata.channels.map(channel => channel.name), ['DAPI', 'GFP', 'CD3e']);
		assert.deepStrictEqual(metadata.channels.map(channel => channel.colorCss), ['#0000ffff', '#00ff00ff', undefined],
			'file colours are #rrggbbaa; a channel without a Color attribute has none, so configured or palette colours apply');
	});

	test('OME-TIFF: channels vary fastest, so IFD = c + 3 * z', () => {
		const metadata = ome.parseOmeXml(text(readTiff(samples('ome_3ch_z.ome.tif')).first[270]));
		assert.strictEqual(ome.omeCoordinatesToIfd(metadata, { c: 2, z: 1, t: 0 }), 5);
		assert.deepStrictEqual(ome.omeIfdToCoordinates(metadata, 4), { c: 1, z: 1, t: 0 });
	});

	test('ImageJ stack: channels named by slice labels', () => {
		const { pages, first } = readTiff(samples('imagej_3ch_labels.tif'));
		assert.strictEqual(pages, 3);
		const labels = ome.parseImageJLabels(imageJTags(first));
		assert.deepStrictEqual(labels, ['DAPI', 'GFP', 'CD3e']);
		const metadata = ome.parseImageJMetadata(text(first[270]), 64, 48, pages, labels);
		assert.ok(metadata);
		assert.strictEqual(metadata.sizeC, 3);
		assert.deepStrictEqual(metadata.channels.map(channel => channel.name), ['DAPI', 'GFP', 'CD3e']);
		assert.strictEqual(ome.omeCoordinatesToIfd(metadata, { c: 2, z: 0, t: 0 }), 2);
	});

	test('extra samples without metadata are not a channel stack', () => {
		const { first } = readTiff(samples('shapes_hyper.tif'));
		assert.strictEqual(first[277].bytes.readUInt16LE(0), 7, 'fixture still has 7 samples per pixel');
		assert.strictEqual(ome.parseOmeXml(text(first[270])), null);
		assert.strictEqual(ome.parseImageJMetadata(text(first[270]), 128, 72, 1), null);
	});

	test('a plain RGB TIFF is not a channel stack', () => {
		const { pages, first } = readTiff(samples('pred_ref_rgb8.tif'));
		assert.strictEqual(ome.parseOmeXml(text(first[270])), null);
		assert.strictEqual(ome.parseImageJMetadata(text(first[270]), 1, 1, pages), null);
	});

	console.log(`\n🎉 All ${passed} channel fixture tests passed.`);
}

main().catch(error => { console.error(error); process.exit(1); });

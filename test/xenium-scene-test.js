const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const sample = path.join(__dirname, '..', 'test-samples', 'scientific', 'xenium', 'Xenium_V1_MultiCellSeg_Human_Ovary_tiny_outs');
const esbuild = require('esbuild');
const os = require('os');

/** Bundle a media module for the test, so other tests that emit CommonJS into out/ cannot interfere. */
async function load(relative) {
	const outfile = path.join(os.tmpdir(), `${relative.replace(/[\\/]/g, '-')}-${process.pid}.mjs`);
	await esbuild.build({
		entryPoints: [path.join(__dirname, '..', 'media', 'modules', `${relative}.ts`)],
		bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
	});
	return import(pathToFileURL(outfile).href);
}

function classicTiff(subOffsets) {
	const b = Buffer.alloc(512);
	b.write('II');
	b.writeUInt16LE(42, 2);
	b.writeUInt32LE(8, 4);
	b.writeUInt16LE(1, 8);
	b.writeUInt16LE(330, 10);
	b.writeUInt16LE(4, 12);
	b.writeUInt32LE(subOffsets.length, 14);
	b.writeUInt32LE(100, 18);
	b.writeUInt32LE(0, 22);
	subOffsets.forEach((o, i) => b.writeUInt32LE(o, 100 + i * 4));
	subOffsets.forEach(o => { b.writeUInt16LE(0, o); b.writeUInt32LE(0, o + 2); });
	return new Uint8Array(b);
}

(async () => {
	const subifd = await load('scene/tiff-subifd');
	const manifest = await load('scene/xenium-manifest');
	const pyramid = await load('scene/pyramid');

	const bytes = classicTiff([200, 300, 400]);
	const info = subifd.inspectTiffRoot(bytes);
	assert.deepStrictEqual(Array.from(info.subIfdOffsets), [200, 300, 400]);
	subifd.chainSubIfds(bytes);
	const view = new DataView(bytes.buffer);
	assert.strictEqual(view.getUint32(8 + 2 + 12, true), 200);
	assert.strictEqual(view.getUint32(200 + 2, true), 300);
	assert.strictEqual(view.getUint32(300 + 2, true), 400);
	assert.strictEqual(view.getUint32(400 + 2, true), 0);

	assert.throws(() => manifest.parseExperiment('{"images":{}}'));
	assert.throws(() => manifest.parseExperiment('not json'));
	assert.deepStrictEqual(manifest.parseGenePanel('{"payload":{"targets":[{"type":{"descriptor":"gene","data":{"name":"EPCAM"}}},{"type":{"descriptor":"genomic_control","data":{"name":"Intergenic"}}},{"type":{"descriptor":"gene","data":{"name":"EPCAM"}}}]}}'), ['EPCAM']);
	assert.deepStrictEqual(manifest.parseGenePanel('not json'), []);

	const cam = pyramid.fitCamera({ width: 1000, height: 500 }, { width: 500, height: 500 });
	assert.ok(cam.scale > 0);

	if (fs.existsSync(path.join(sample, 'experiment.xenium'))) {
		if (fs.existsSync(path.join(sample, 'gene_panel.json'))) {
			const panel = manifest.parseGenePanel(fs.readFileSync(path.join(sample, 'gene_panel.json'), 'utf8'));
			assert.ok(panel.includes('ACTA2') && !panel.includes('Intergenic_Region_29000'), 'the sample panel lists genes, not controls');
		}
		const exp = manifest.parseExperiment(fs.readFileSync(path.join(sample, 'experiment.xenium'), 'utf8'));
		assert.ok(exp.pixelSizeUm > 0);
		const listing = fs.readdirSync(path.join(sample, 'morphology_focus'));
		const files = manifest.discoverChannelFiles(exp, listing);
		assert.strictEqual(files.length, 4);
		const first = fs.readFileSync(path.join(sample, 'morphology_focus', listing.sort()[0]));
		const real = new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
		const root = subifd.inspectTiffRoot(real);
		assert.ok(root.subIfdOffsets.length >= 3);
		const xml = root.description;
		const hints = manifest.omeChannelHints(xml);
		assert.strictEqual(hints.length, 4);
		assert.ok(hints.every(h => h.name));
		assert.ok(manifest.purposeTint(hints[0].purpose));
		subifd.chainSubIfds(real);
	}
	console.log('xenium scene tests passed');
})().catch(error => { console.error(error); process.exit(1); });

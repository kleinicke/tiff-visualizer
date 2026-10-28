const assert = require('node:assert');
const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { patchHyparquetEncoding } = require('../esbuild-hyparquet-patch.js');

async function load(file) {
	const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tx-')), 'm.cjs');
	await esbuild.build({ entryPoints: [path.join(__dirname, '..', file)], bundle: true, platform: 'node', format: 'cjs', outfile: out, plugins: [patchHyparquetEncoding()], logLevel: 'silent' });
	return require(out);
}

(async () => {
	const { buildGenePoints, lowerBoundX } = await load('media/modules/transcripts/transcript-data.ts');
	const points = buildGenePoints([5, 4, 1, 2], [50, 40, 10, 20], [40, 10.4, 300, -2], 0.5);
	assert.deepStrictEqual([...points.x], [0.5, 1, 2, 2.5]);
	assert.deepStrictEqual([...points.y], [5, 10, 20, 25]);
	assert.deepStrictEqual([...points.qv], [255, 0, 10, 40]);
	assert.strictEqual(lowerBoundX(points.x, 0, 4, 1), 1);
	assert.strictEqual(lowerBoundX(points.x, 0, 4, 1.5), 2);
	assert.strictEqual(lowerBoundX(points.x, 0, 4, 99), 4);

	const { paletteColor } = await load('media/modules/transcripts/transcript-colors.ts');
	const colours = new Set(Array.from({ length: 30 }, (_v, index) => paletteColor('#ff6b6b', index)));
	assert.strictEqual(colours.size, 30);
	assert.ok([...colours].every(colour => /^#[0-9a-f]{6}$/.test(colour)));

	const { TranscriptsWorkspace } = await load('media/modules/transcripts/transcripts-workspace.ts');
	const index = { genes: ['A', 'B', 'C'], counts: [2, 3, 1], total: 6 };
	const fetched = [];
	const host = {
		addOverlay: () => undefined, removeOverlay: () => undefined, requestRender: () => undefined, notify: () => undefined, available: true,
		open: async progress => { progress(1, 1); return index; },
		genes: async names => { fetched.push([...names]); return new Map(names.map(name => [name, buildGenePoints([1, 2], [3, 4], [30, 30], 1)])); },
	};
	const workspace = new TranscriptsWorkspace(host, 1, [{ name: 'Epi', genes: ['A', 'B', 'Z'], color: '#ff0000' }, { name: 'Imm', genes: ['C'], color: '#00ff00' }]);
	await workspace.load();
	let model = workspace.snapshot();
	assert.strictEqual(model.points, 6);
	assert.deepStrictEqual(fetched, [], 'no positions are read until a gene is shown');
	assert.strictEqual(model.genes.length, 0, 'nothing is added by default');
	assert.strictEqual(model.groups.length, 0);
	assert.deepStrictEqual(model.groupChoices.map(group => group.name), ['Epi', 'Imm']);
	model.addGroup('Epi');
	model = workspace.snapshot();
	assert.strictEqual(model.groups[0].state, 'none');
	assert.strictEqual(model.groups[0].found, 2);
	assert.deepStrictEqual(model.groups[0].missing, ['Z']);
	model.groups[0].toggle();
	await workspace.settled();
	model = workspace.snapshot();
	assert.deepStrictEqual(fetched, [['A', 'B']], 'one request for the group');
	assert.deepStrictEqual(model.genes.map(gene => gene.name), ['A', 'B']);
	assert.strictEqual(model.genes[0].count, 2);
	assert.strictEqual(model.genes[0].loading, false);
	assert.strictEqual(model.groups[0].state, 'all');
	assert.strictEqual(model.genes[0].color, '#ff0000');
	assert.strictEqual(model.genes[1].color, '#ff0000');
	model.groups[0].setPalette(true);
	model = workspace.snapshot();
	assert.notStrictEqual(model.genes[0].color, model.genes[1].color);
	model.genes[0].setVisible(false);
	model = workspace.snapshot();
	assert.strictEqual(model.groups[0].state, 'some');
	model.groups[0].toggle();
	model = workspace.snapshot();
	assert.strictEqual(model.groups[0].state, 'all');
	model.groups[0].toggle();
	model = workspace.snapshot();
	assert.strictEqual(model.groups[0].state, 'none');
	assert.strictEqual(model.genes.length, 2, 'unticking keeps the genes listed');
	model.addGene('C');
	await workspace.settled();
	model = workspace.snapshot();
	assert.strictEqual(model.genes.length, 3);
	assert.deepStrictEqual(fetched[fetched.length - 1], ['C']);
	const requests = fetched.length;
	model.genes[0].setVisible(false);
	model.genes[0].setVisible(true);
	await workspace.settled();
	assert.strictEqual(fetched.length, requests, 'a gene already read is not read again');
	model.groups[0].toggleFilter();
	model = workspace.snapshot();
	assert.deepStrictEqual(model.listed.map(gene => gene.name), ['A', 'B']);
	model.groups[0].removeAll();
	model = workspace.snapshot();
	assert.deepStrictEqual(model.genes.map(gene => gene.name), ['C']);
	model.createGroup("Mine", "a, C\nQ");
	model = workspace.snapshot();
	assert.ok(model.groups.some(group => group.name === 'Mine' && group.found === 2 && group.missing.length === 1));
	const state = workspace.getState();
	const again = new TranscriptsWorkspace(host, 1, []);
	await again.load();
	again.restore(JSON.parse(JSON.stringify(state)));
	await again.settled();
	assert.deepStrictEqual(again.snapshot().genes.map(gene => gene.name), ['C']);

	const sample = path.join(__dirname, '..', 'test-samples/scientific/xenium/Xenium_V1_MultiCellSeg_Human_Ovary_tiny_outs/transcripts.parquet');
	if (fs.existsSync(sample)) {
		const { openTranscripts, readGenes } = await load('media/modules/transcripts/transcript-reader.ts');
		const bytes = fs.readFileSync(sample);
		let reads = 0;
		const file = { byteLength: bytes.length, slice: async (start, end) => { reads++; const part = bytes.subarray(start, end ?? bytes.length); return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength); } };
		const handle = await openTranscripts(file, 1);
		assert.strictEqual(handle.index.genes.length, 403);
		assert.strictEqual(handle.index.total, 227243);
		assert.strictEqual(handle.index.counts[handle.index.genes.indexOf('EPCAM')], 8289);
		const opened = reads;
		const read = await readGenes(handle, ['EPCAM', 'NOT_A_GENE']);
		assert.deepStrictEqual([...read.keys()], ['EPCAM']);
		assert.strictEqual(read.get('EPCAM').x.length, 8289);
		assert.ok(read.get('EPCAM').x.every((value, at, all) => at === 0 || all[at - 1] <= value), 'sorted by x');
		assert.ok(reads > opened, 'positions are read on demand');
	}
	console.log('xenium transcripts tests passed');
})();

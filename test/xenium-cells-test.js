const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { patchHyparquetEncoding } = require('../esbuild-hyparquet-patch.js');

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

async function bundledReader() {
	const outfile = path.join(require('os').tmpdir(), `parquet-reader-${process.pid}.mjs`);
	await esbuild.build({
		entryPoints: [path.join(__dirname, '..', 'media', 'modules', 'cells', 'parquet-reader.ts')],
		bundle: true, format: 'esm', platform: 'node', outfile, plugins: [patchHyparquetEncoding()], logLevel: 'silent',
	});
	return import(pathToFileURL(outfile).href);
}

const square = (id, x, y, size = 2) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size]].map(([vx, vy]) => ({ id, vx, vy }));

(async () => {
	const { buildPolygonSet, polygonContains, polygonArea, polygonPerimeter } = await load('cells/polygon-set');
	const { SpatialIndex } = await load('cells/spatial-index');
	const { planDiscrete, planContinuous, planNone, categoryColor } = await load('cells/cell-style');
	const { discreteColumn, continuousColumn, histogram, buildCellTable } = await load('cells/cell-table');

	// Polygons are grouped by consecutive ids and scaled to scene pixels.
	const vertices = [...square('a', 0, 0), ...square('b', 10, 10), ...square('c', 20, 0)];
	const rowOf = { a: 0, b: 1, c: -1 };
	const set = buildPolygonSet(vertices.map(v => v.id), vertices.map(v => v.vx), vertices.map(v => v.vy), id => rowOf[id], 2);
	assert.strictEqual(set.count, 3);
	assert.deepStrictEqual(Array.from(set.rows), [0, 1, -1]);
	assert.strictEqual(polygonArea(set, 0), 16);
	assert.strictEqual(polygonPerimeter(set, 0), 16);
	assert.ok(polygonContains(set, 0, 2, 2));
	assert.ok(!polygonContains(set, 0, 5, 2));
	assert.ok(!polygonContains(set, 1, 2, 2));

	// The grid finds what overlaps a window, and nothing else of note.
	const index = new SpatialIndex(set);
	assert.ok(index.visible(0, 0, 4, 4).includes(0));
	assert.strictEqual(index.visible(-100, -100, 100, 100).length, 3);
	const far = new SpatialIndex(buildPolygonSet(
		Array.from({ length: 400 }, (_v, i) => `c${Math.floor(i / 4)}`),
		Array.from({ length: 400 }, (_v, i) => (Math.floor(i / 4) % 10) * 10 + [0, 2, 2, 0][i % 4]),
		Array.from({ length: 400 }, (_v, i) => Math.floor(Math.floor(i / 4) / 10) * 10 + [0, 0, 2, 2][i % 4]),
		() => 0, 1));
	const near = far.visible(0, 0, 3, 3);
	assert.ok(near.includes(0) && near.length < 10, `a small window finds few polygons, found ${near.length}`);

	// Categories: most common first, hidden ones get bucket 0.
	const column = discreteColumn('kind', ['x', 'y', 'y', null, 'y']);
	assert.deepStrictEqual(column.labels, ['y', 'x']);
	assert.deepStrictEqual(column.counts, [3, 1]);
	assert.deepStrictEqual(Array.from(column.codes), [1, 0, 0, -1, 0]);
	const discrete = planDiscrete(column, [true, false], ['#111111', '#222222']);
	assert.deepStrictEqual(Array.from(discrete.bucket), [0, 1, 1, 0, 1]);
	assert.strictEqual(discrete.fill, true);
	assert.ok(categoryColor(0) !== categoryColor(1) && categoryColor(30) !== categoryColor(31));

	// Numbers: range ends map to the first and last colour, gaps to the missing colour.
	const numbers = continuousColumn('n', Float64Array.from([0, 5, 10, NaN]));
	assert.strictEqual(numbers.min, 0);
	assert.strictEqual(numbers.max, 10);
	const lut = new Uint8Array(768).map((_v, i) => i % 256);
	const continuous = planContinuous(numbers, 0, 10, lut);
	assert.deepStrictEqual(Array.from(continuous.bucket), [1, 129, 257 - 1, 257]);
	assert.strictEqual(planNone(3).fill, false);
	assert.deepStrictEqual(histogram(Float64Array.from([0, 1, 9, 10]), 0, 10, 2), [2, 2]);

	if (fs.existsSync(path.join(sample, 'cells.parquet'))) {
		const { readParquetColumns } = await bundledReader();
		const read = file => { const b = fs.readFileSync(path.join(sample, file)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
		const table = buildCellTable(await readParquetColumns(read('cells.parquet')));
		assert.strictEqual(table.count, 623);
		const method = table.columns.find(c => c.name === 'segmentation_method');
		assert.strictEqual(method.kind, 'discrete');
		assert.strictEqual(table.columns.find(c => c.name === 'cell_area').kind, 'continuous');
		assert.strictEqual(table.columns.find(c => c.name === 'transcript_counts').kind, 'continuous');
		const boundary = await readParquetColumns(read('cell_boundaries.parquet'), ['cell_id', 'vertex_x', 'vertex_y']);
		const ids = Array.from(boundary.get('cell_id'));
		const cells = buildPolygonSet(ids, Array.from(boundary.get('vertex_x')), Array.from(boundary.get('vertex_y')), id => table.rowOfId.get(id) ?? -1, 1 / 0.2125);
		assert.strictEqual(cells.count, 623);
		assert.ok(Array.from(cells.rows).every(row => row >= 0));
		// Outline area agrees with the table's own cell_area (square microns).
		const area = table.columns.find(c => c.name === 'cell_area').values;
		for (const polygon of [0, 100, 400]) {
			const measured = polygonArea(cells, polygon) * 0.2125 * 0.2125;
			assert.ok(Math.abs(measured - area[cells.rows[polygon]]) / area[cells.rows[polygon]] < 0.05, `polygon ${polygon} area`);
		}
	}
	{
		const { buildPolygonSetFromLabels } = await load('cells/polygon-set');
		const set = buildPolygonSetFromLabels(Int32Array.from([1, 1, 1, 2, 2, 2]), [0, 2, 2, 5, 7, 7], [0, 0, 2, 5, 5, 7], label => label - 1, 2);
		assert.strictEqual(set.count, 2);
		assert.deepStrictEqual(Array.from(set.offsets), [0, 3, 6]);
		assert.deepStrictEqual(Array.from(set.rows), [0, 1]);
		assert.deepStrictEqual(Array.from(set.bounds), [0, 0, 4, 4, 10, 10, 14, 14]);
	}
	{
		const { channelHistogram } = await load('channel-composite');
		const plane = { index: 0, name: 'a', data: Float32Array.from([0, 1, 1, 2, 9, 10, NaN]) };
		assert.deepStrictEqual(channelHistogram(plane, 0, 10, 2), [4, 2]);
		assert.deepStrictEqual(channelHistogram(plane, 5, 5, 3), [0, 0, 0]);
	}
	{
		const { buildCellTable } = await load('cells/cell-table');
		const { mergeTable, dropColumns } = await load('cells/cells-merge');
		const target = buildCellTable(new Map([['cell_id', ['a', 'b', 'c']], ['area', [1, 2, 3]]]));
		const extra = buildCellTable(new Map([['cell_id', ['c', 'a', 'z']], ['score', [0.5, 0.25, 9]], ['type', ['T', 'B', 'T']]]));
		const merged = mergeTable(target, extra, 'segtraq');
		assert.deepStrictEqual(merged.added, ['segtraq · score', 'segtraq · type']);
		assert.strictEqual(merged.matched, 2);
		assert.strictEqual(merged.total, 3);
		const score = target.columns.find(c => c.name === 'segtraq · score');
		assert.deepStrictEqual([score.values[0], Number.isNaN(score.values[1]), score.values[2]], [0.25, true, 0.5]);
		const type = target.columns.find(c => c.name === 'segtraq · type');
		assert.deepStrictEqual(Array.from(type.codes).map(code => code < 0 ? null : type.labels[code]), ['B', null, 'T']);
		dropColumns(target, merged.added);
		assert.strictEqual(target.columns.length, 1);
		const none = mergeTable(target, buildCellTable(new Map([['cell_id', ['q']], ['x', [1]]])), 'other');
		assert.deepStrictEqual([none.added.length, none.matched], [0, 0]);
	}
	{
		const { expandSampleName, isAbsolutePath, sourceNameFromPath } = await load('scene/xenium-manifest');
		assert.strictEqual(expandSampleName('segtraq/{sample_name}/{sample_name}.segtraq_cells.parquet', 'S1'), 'segtraq/S1/S1.segtraq_cells.parquet');
		assert.ok(isAbsolutePath('/data/x.parquet') && isAbsolutePath('C:\\data\\x.parquet') && !isAbsolutePath('sam2/x.parquet'));
		assert.strictEqual(sourceNameFromPath('/a/b/S1.segtraq_cells.parquet'), 'S1.segtraq_cells');
	}
	{
		const { CellsWorkspace } = await load('cells/cells-workspace');
		const { buildCellTable } = await load('cells/cell-table');
		const { buildPolygonSet } = await load('cells/polygon-set');
		const tick = () => new Promise(resolve => setTimeout(resolve, 5));
		const made = (ids) => {
			const table = buildCellTable(new Map([['cell_id', ids], ['area', ids.map((_id, index) => index + 1)]]));
			const vertices = ids.flatMap((id, index) => square(id, index * 10, 0));
			return { table, cells: buildPolygonSet(vertices.map(v => v.id), vertices.map(v => v.vx), vertices.map(v => v.vy), id => table.rowOfId.get(id) ?? -1, 1) };
		};
		const overlays = new Set();
		const host = {
			load: async file => {
				if (file.path === 'tab') { return { kind: 'table', table: buildCellTable(new Map([['cell_id', ['a', 'b', 'zz']], ['score', [1, 2, 3]]])) }; }
				if (file.path === 'nuc') { return { kind: 'boundaries', ...made(['a', 'b', 'zz']) }; }
				if (file.path === 'other') { return { kind: 'table', table: buildCellTable(new Map([['cell_id', ['nope']], ['x', [1]]])) }; }
				return { kind: 'boundaries', ...made(['p', 'q', 'r']) };
			},
			resolve: async text => ({ name: text, kind: 'unknown', path: text, found: true, src: text }),
			browse: async () => null,
			addOverlay: layer => overlays.add(layer), removeOverlay: layer => overlays.delete(layer),
			requestRender: () => undefined, notify: () => undefined,
		};
		const workspace = new CellsWorkspace(host, 0.2125);
		workspace.addConfigured([
			{ name: 'segtraq', kind: 'table', path: 'tab', found: true, src: 'tab', parent: 'Xenium cells' },
			{ name: 'sam2_default', kind: 'table', path: 'tab', found: true, src: 'tab', parent: 'sam2' },
			{ name: 'orphan', kind: 'table', path: 'tab', found: true, src: 'tab', parent: 'nobody' },
			{ name: 'nuc', kind: 'boundaries', path: 'nuc', found: true, src: 'nuc', parent: 'Xenium cells' },
			{ name: 'sam2', kind: 'boundaries', path: 'seg', found: true, src: 'seg' },
			{ name: 'gone', kind: 'boundaries', path: 'nowhere', found: false },
		]);
		const native = made(['a', 'b', 'c']);
		workspace.addNative('Xenium cells', { ...native, nuclei: made(['a', 'b', 'c']).cells });
		let panel = workspace.snapshot(null);
		assert.deepStrictEqual(panel.sets.map(set => set.name), ['Xenium cells']);
		assert.deepStrictEqual(panel.pending.map(row => [row.name, row.state]), [['sam2', 'available'], ['gone', 'missing']]);
		assert.deepStrictEqual(panel.sets[0].tables.map(table => [table.name, table.state]), [['cells', 'loaded'], ['nucleus_boundaries', 'loaded'], ['segtraq', 'available'], ['nuc', 'available']]);
		const segtraq = () => workspace.snapshot(null).sets[0].tables.find(table => table.name === 'segtraq');
		panel.sets[0].loadTable(segtraq().id);
		await tick(); await tick();
		panel = workspace.snapshot(null);
		assert.strictEqual(segtraq().state, 'loaded');
		assert.ok(panel.sets[0].view.metrics.some(metric => metric.name === 'segtraq · score'));
		assert.ok(segtraq().detail.includes('2 of 3'));
		panel.sets[0].removeTable(panel.sets[0].tables[0].id);
		assert.strictEqual(workspace.snapshot(null).sets[0].tables[0].name, 'cells');
		assert.strictEqual(panel.sets[0].view.hasNuclei, true);
		const nuc = () => workspace.snapshot(null).sets[0].tables.find(table => table.name === 'nuc');
		panel.sets[0].loadTable(nuc().id);
		await tick(); await tick();
		assert.strictEqual(nuc().state, 'loaded');
		assert.strictEqual(nuc().kind, 'nuclei');
		assert.ok(nuc().detail.includes('2 matched'));
		assert.strictEqual(workspace.snapshot(null).sets[0].tables.find(table => table.name === 'nucleus_boundaries').state, 'available');
		panel.sets[0].removeTable(nuc().id);
		assert.strictEqual(workspace.snapshot(null).sets[0].view.hasNuclei, false);
		assert.strictEqual(nuc().state, 'available');
		panel.sets[0].addTable('other');
		await tick(); await tick();
		panel = workspace.snapshot(null);
		assert.strictEqual(panel.sets[0].tables.find(table => table.name === 'other').state, 'error');
		panel.sets[0].view.setMetric('segtraq · score');
		panel.sets[0].removeTable(segtraq().id);
		panel = workspace.snapshot(null);
		assert.strictEqual(panel.sets[0].view.metric, null);
		assert.ok(!panel.sets[0].view.metrics.some(metric => metric.name.startsWith('segtraq')));
		panel.loadSource(panel.pending[0].id);
		await tick(); await tick();
		panel = workspace.snapshot(null);
		assert.deepStrictEqual(panel.sets.map(set => set.name), ['Xenium cells', 'sam2']);
		assert.strictEqual(overlays.size, 2);
		assert.deepStrictEqual(panel.sets[1].tables.map(table => table.name), ['sam2_default']);
		assert.deepStrictEqual(panel.pending.map(row => row.name), ['gone']);
		panel.sets[1].remove();
		panel = workspace.snapshot(null);
		assert.strictEqual(overlays.size, 1);
		assert.deepStrictEqual(panel.pending.map(row => row.name), ['sam2', 'gone']);
		assert.strictEqual(workspace.getState().tables.some(entry => entry.set === 'Xenium cells' && entry.path === 'other'), true);
	}
	{
		const { TileCache } = await load('cells/cells-tiles');
		assert.ok(TileCache.levelFor(1) === 0);
		assert.strictEqual(TileCache.levelFor(0.5), -2);
		assert.strictEqual(TileCache.levelFor(0.6), -1);
		assert.strictEqual(TileCache.levelFor(3), 4);
		for (const scale of [0.013, 0.07, 0.3, 0.71, 1, 2.5]) {
			const ratio = scale / TileCache.scaleOf(TileCache.levelFor(scale));
			assert.ok(ratio <= 1 + 1e-9 && ratio > Math.SQRT1_2 - 1e-9, `scale ${scale} ratio ${ratio}`);
		}
		assert.ok(TileCache.levelFor(0.26) < TileCache.levelFor(0.6));
	}
	if (fs.existsSync(path.join(sample, 'cells.parquet'))) {
		const read = file => { const b = fs.readFileSync(path.join(sample, file)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
		const outfile = path.join(os.tmpdir(), `parquet-fast-${process.pid}.mjs`);
		await esbuild.build({
			entryPoints: [path.join(__dirname, '..', 'media', 'modules', 'cells', 'parquet-fast.ts')],
			bundle: true, format: 'esm', platform: 'node', outfile, plugins: [patchHyparquetEncoding()], logLevel: 'silent',
		});
		const { readPlainColumns } = await import(pathToFileURL(outfile).href);
		const { readParquetColumns } = await bundledReader();
		const file = read('cell_boundaries.parquet');
		const fast = readPlainColumns(file, ['vertex_x', 'vertex_y', 'label_id']);
		const slow = await readParquetColumns(file, ['vertex_x', 'vertex_y', 'label_id']);
		for (const name of ['vertex_x', 'vertex_y', 'label_id']) {
			assert.strictEqual(fast.get(name).length, slow.get(name).length);
			assert.ok(Array.from(fast.get(name)).every((value, index) => value === Number(slow.get(name)[index])), name);
		}
	}
	console.log('xenium cells tests passed');
})().catch(error => { console.error(error); process.exit(1); });

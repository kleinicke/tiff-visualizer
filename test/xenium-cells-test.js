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
	console.log('xenium cells tests passed');
})().catch(error => { console.error(error); process.exit(1); });

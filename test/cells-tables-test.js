const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const esbuild = require('esbuild');

async function load(relative) {
	const outfile = path.join(os.tmpdir(), `${relative.replace(/[\\/]/g, '-')}-${process.pid}.mjs`);
	await esbuild.build({ entryPoints: [path.join(__dirname, '..', 'media', 'modules', `${relative}.ts`)], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
	return import(pathToFileURL(outfile).href);
}

/** A mask from rows of text: '.' is background, a digit is that label. */
function maskOf(rows) {
	const width = rows[0].length;
	return { width, height: rows.length, data: Uint8Array.from(rows.join('').split('').map(char => char === '.' ? 0 : Number(char))) };
}

const polygons = traced => Array.from(traced.labels, (label, index) => ({ label, ring: Array.from({ length: traced.offsets[index + 1] - traced.offsets[index] }, (_v, vertex) => [traced.xy[(traced.offsets[index] + vertex) * 2], traced.xy[(traced.offsets[index] + vertex) * 2 + 1]]) }));
const area = ring => ring.reduce((sum, [x0, y0], index) => { const [x1, y1] = ring[(index + 1) % ring.length]; return sum + x0 * y1 - x1 * y0; }, 0) / 2;

(async () => {
	const { pickIdColumn, normalizeId, missingIdColumnMessage } = await load('cells/id-column');
	assert.strictEqual(pickIdColumn(['Object', 'Area'], ['Object']), 'Object');
	assert.strictEqual(pickIdColumn(['object', 'Area'], ['Object']), 'object', 'case-insensitive, spelled as the table has it');
	assert.strictEqual(pickIdColumn(['cell_id', 'Object'], ['Object']), 'cell_id', 'cell_id comes first');
	assert.strictEqual(pickIdColumn(['Label', 'Object'], ['Missing', 'Object']), 'Object');
	assert.strictEqual(pickIdColumn(['Area'], ['Object']), null);
	assert.strictEqual(pickIdColumn(['Area'], []), null);
	assert.strictEqual(normalizeId(' 12.0 '), '12');
	assert.strictEqual(normalizeId('12'), '12');
	assert.strictEqual(normalizeId('12.5'), '12.5');
	assert.strictEqual(normalizeId('A1'), 'A1');
	assert.ok(missingIdColumnMessage(['Area', 'Mean']).includes('tiffVisualizer.cells.cellIdCol'));

	const { parseDelimited, typedColumn, detectDelimiter } = await load('cells/delimited');
	assert.strictEqual(detectDelimiter('Object\tArea\tMean'), '\t');
	assert.strictEqual(detectDelimiter('"a,b",c,d'), ',');
	assert.strictEqual(detectDelimiter('a;b;c'), ';');
	const csv = parseDelimited('﻿Object,Area,Marker,Note\r\n1,10.5,CD3,"a, ""quoted"" note"\r\n2,,CD8,\r\n3,7,,x\r\n\r\n');
	assert.deepStrictEqual(csv.header, ['Object', 'Area', 'Marker', 'Note']);
	assert.deepStrictEqual(csv.raw[0], ['1', '2', '3']);
	assert.strictEqual(csv.raw[3][0], 'a, "quoted" note');
	assert.deepStrictEqual(Array.from(typedColumn(csv.raw[1])).map(String), ['10.5', 'NaN', '7']);
	assert.deepStrictEqual(typedColumn(csv.raw[2]), ['CD3', 'CD8', null]);
	assert.deepStrictEqual(typedColumn(['1', '2', 'NA']), [1n, 2n, null], 'whole numbers stay integers');
	assert.ok(typedColumn(['1', '2.5']) instanceof Float64Array);
	assert.deepStrictEqual(parseDelimited('Object\tArea\n1\t5\n').raw, [['1'], ['5']]);
	assert.deepStrictEqual(parseDelimited('').header, []);

	const { traceMaskJs, traceMask } = await load('cells/mask-trace');
	const square = maskOf(['....', '.11.', '.11.', '....']);
	const traced = traceMaskJs(square.data, square.width, square.height, 0);
	assert.deepStrictEqual(polygons(traced), [{ label: 1, ring: [[1, 1], [3, 1], [3, 3], [1, 3]] }]);
	const ell = maskOf(['11.', '11.', '111']);
	assert.strictEqual(area(polygons(traceMaskJs(ell.data, 3, 3, 0))[0].ring), 7);
	const touching = maskOf(['1122', '1122']);
	assert.deepStrictEqual(Array.from(traceMaskJs(touching.data, 4, 2, 0).labels), [1, 2]);
	const hole = maskOf(['111', '1.1', '111']);
	assert.strictEqual(area(polygons(traceMaskJs(hole.data, 3, 3, 0))[0].ring), 9, 'a hole does not cut the outline');
	const pieces = maskOf(['11.', '11.', '..1']);
	const kept = polygons(traceMaskJs(pieces.data, 3, 3, 0));
	assert.strictEqual(kept.length, 1);
	assert.strictEqual(area(kept[0].ring), 4, 'only the largest piece of a label is kept');
	const order = maskOf(['3.1', '3.2']);
	assert.deepStrictEqual(Array.from(traceMaskJs(order.data, 3, 2, 0).labels), [1, 2, 3]);
	const wide = new Uint16Array([0, 300, 300, 0]);
	assert.deepStrictEqual(Array.from(traceMaskJs(wide, 2, 2, 0).labels), [300]);
	assert.throws(() => traceMaskJs(new Uint8Array(0), 0, 0, 0));

	// A disc thinned at 0.8 px keeps its area and loses most vertices.
	const size = 41, disc = new Uint8Array(size * size);
	for (let y = 0; y < size; y++) { for (let x = 0; x < size; x++) { if ((x - 20) ** 2 + (y - 20) ** 2 <= 225) { disc[y * size + x] = 1; } } }
	const exact = polygons(traceMaskJs(disc, size, size, 0))[0].ring, thin = polygons(traceMaskJs(disc, size, size, 0.8))[0].ring;
	assert.ok(thin.length < exact.length * 0.6, `${thin.length} vs ${exact.length}`);
	assert.ok(Math.abs(area(thin) - area(exact)) / area(exact) < 0.03);

	// The Rust tracer must agree with the TypeScript one, when the built module has it.
	const wasmPath = path.join(__dirname, '..', 'media', 'wasm', 'transcripts-wasm.wasm');
	const module = new WebAssembly.Module(fs.readFileSync(wasmPath));
	if (WebAssembly.Module.exports(module).some(entry => entry.name === 'mask_trace')) {
		let seed = 12345;
		const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
		for (const [width, height, labels] of [[40, 30, 6], [64, 64, 20], [17, 90, 3]]) {
			const data = new Uint16Array(width * height);
			for (let blob = 1; blob <= labels; blob++) {
				const cx = random() * width, cy = random() * height, r = 2 + random() * 8;
				for (let y = 0; y < height; y++) { for (let x = 0; x < width; x++) { if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) { data[y * width + x] = blob; } } }
			}
			for (const epsilon of [0, 0.8]) {
				const js = traceMaskJs(data, width, height, epsilon);
				const rust = traceMask(data, width, height, epsilon, module);
				assert.deepStrictEqual(Array.from(rust.labels), Array.from(js.labels), 'same labels');
				assert.deepStrictEqual(Array.from(rust.offsets), Array.from(js.offsets), 'same vertex counts');
				assert.deepStrictEqual(Array.from(rust.xy), Array.from(js.xy), 'same vertices');
			}
		}
		console.log('mask tracer: Rust and TypeScript agree');
	} else {
		console.log('mask tracer: media/wasm/transcripts-wasm.wasm predates the tracer, so only TypeScript was checked (run npm run build:wasm:transcripts)');
	}

	const { cellsFromTrace, maskScaleFor } = await load('cells/mask-cells');
	const set = cellsFromTrace(traceMaskJs(touching.data, 4, 2, 0), 2);
	assert.deepStrictEqual(set.table.ids, ['1', '2']);
	assert.strictEqual(set.table.rowOfId.get('2'), 1);
	assert.deepStrictEqual(Array.from(set.cells.bounds.slice(0, 4)), [0, 0, 4, 4], 'scaled to scene pixels');
	assert.deepStrictEqual(Array.from(set.cells.rows), [0, 1]);
	assert.strictEqual(maskScaleFor({ width: 100, height: 50 }, { width: 100, height: 50 }), 1);
	assert.strictEqual(maskScaleFor({ width: 100, height: 50 }, { width: 400, height: 200 }), 4);
	assert.strictEqual(maskScaleFor({ width: 100, height: 50 }, null), 1);
	assert.throws(() => maskScaleFor({ width: 100, height: 50 }, { width: 100, height: 80 }), /do not line up/);
	console.log('cells tables: ok');
})().catch(error => { console.error(error); process.exit(1); });

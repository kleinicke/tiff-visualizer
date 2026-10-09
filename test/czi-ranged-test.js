/**
 * Ranged CZI access (formats/czi.rs, media/modules/czi-source.ts): the page
 * reads the header, the directory and only the subblocks a view needs.
 *
 * - For every repository CZI and every plane, the ranged decode of the whole
 *   plane equals `decode_czi_fast` on the whole file, and a region equals the
 *   same rectangle of it.
 * - A synthetic Gray16 mosaic with overlapping tiles and stored pyramid
 *   levels (factors 2 and 4) whose stored pixels hold the full-resolution
 *   value at their sample point: a region read at factor 2 or 4 must then
 *   equal the full-resolution plane sampled every 2nd/4th pixel exactly, and
 *   must read only that level's subblocks.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function segment(id, data) {
	const header = Buffer.alloc(32);
	header.write(id, 0, 'ascii');
	header.writeBigInt64LE(BigInt(data.length), 16);
	header.writeBigInt64LE(BigInt(data.length), 24);
	return Buffer.concat([header, data]);
}

function directoryEntry(filePosition, pixelType, dims) {
	const entry = Buffer.alloc(32 + dims.length * 20);
	entry.write('DV', 0, 'ascii');
	entry.writeInt32LE(pixelType, 2);
	entry.writeBigInt64LE(BigInt(filePosition), 6);
	entry.writeInt32LE(0, 18); // uncompressed
	entry.writeUInt8(dims.some(([, , size, stored]) => stored !== size) ? 2 : 0, 22); // PyramidType
	entry.writeInt32LE(dims.length, 28);
	dims.forEach(([name, start, size, stored], index) => {
		const at = 32 + index * 20;
		entry.write(name, at, 'ascii');
		entry.writeInt32LE(start, at + 4);
		entry.writeInt32LE(size, at + 8);
		entry.writeInt32LE(stored, at + 16);
	});
	return entry;
}

/** A plane value that differs per pixel and per C. */
const value = (x, y, c) => (x * 7 + y * 131 + c * 9001) & 0xffff;

/**
 * 3x2 mosaic of 40x30 tiles overlapping by 4 pixels, two channels, Gray16,
 * plus stored levels: factor 2 as 2 tiles, factor 4 as 1 tile.
 */
function syntheticPyramid() {
	const tiles = [];
	const step = 36;
	for (let c = 0; c < 2; c++) {
		for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 3; tx++) {
			tiles.push({ c, x: 5 + tx * step, y: 3 + ty * 26, width: 40, height: 30, factor: 1 });
		}
	}
	const extent = { x: 5, y: 3, width: 2 * step + 40, height: 26 + 30 };
	for (let c = 0; c < 2; c++) {
		const half = Math.ceil(extent.width / 2 / 2) * 2;
		tiles.push({ c, x: extent.x, y: extent.y, width: half, height: extent.height, factor: 2 });
		tiles.push({ c, x: extent.x + half, y: extent.y, width: extent.width - half, height: extent.height, factor: 2 });
		tiles.push({ c, x: extent.x, y: extent.y, width: extent.width, height: extent.height, factor: 4 });
	}
	const head = 32 + 512;
	let position = head;
	const blocks = [];
	const entries = [];
	for (const tile of tiles) {
		const storedW = Math.ceil(tile.width / tile.factor);
		const storedH = Math.ceil(tile.height / tile.factor);
		const dims = [['X', tile.x, tile.width, storedW], ['Y', tile.y, tile.height, storedH], ['C', tile.c, 1, 1]];
		const pixels = Buffer.alloc(storedW * storedH * 2);
		for (let y = 0; y < storedH; y++) for (let x = 0; x < storedW; x++) {
			// The stored sample of a pyramid pixel is the plane value where the
			// decoder samples it: (X - start) * stored / size, inverted.
			const planeX = tile.x + Math.ceil(x * tile.width / storedW);
			const planeY = tile.y + Math.ceil(y * tile.height / storedH);
			pixels.writeUInt16LE(value(planeX, planeY, tile.c), (y * storedW + x) * 2);
		}
		const inline = directoryEntry(position, 1, dims);
		const fixed = Buffer.alloc(Math.max(256, 16 + inline.length));
		fixed.writeBigInt64LE(BigInt(pixels.length), 8);
		inline.copy(fixed, 16);
		const block = segment('ZISRAWSUBBLOCK', Buffer.concat([fixed, pixels]));
		entries.push(directoryEntry(position, 1, dims));
		blocks.push(block);
		position += block.length;
	}
	const directoryPosition = position;
	const directory = segment('ZISRAWDIRECTORY', Buffer.concat([
		(() => { const fixed = Buffer.alloc(128); fixed.writeInt32LE(entries.length, 0); return fixed; })(),
		...entries,
	]));
	const fileHeader = Buffer.alloc(512);
	fileHeader.writeInt32LE(1, 0);
	fileHeader.writeBigInt64LE(BigInt(directoryPosition), 0x34);
	return { bytes: Buffer.concat([segment('ZISRAWFILE', fileHeader), ...blocks, directory]), extent };
}

/** The page's ranged path against an in-memory file (czi-source.ts without fetch). */
function rangedReader(wasm, bytes) {
	const read = (position, length) => new Uint8Array(bytes.subarray(position, position + length));
	const segmentAt = position => read(position, 32 + Number(Buffer.from(bytes.subarray(position + 24, position + 32)).readBigInt64LE(0)));
	const header = JSON.parse(wasm.czi_header(read(0, 512)));
	const directory = segmentAt(header.directoryPosition);
	const metadata = header.metadataPosition > 0 ? segmentAt(header.metadataPosition) : new Uint8Array(0);
	const boundaries = [header.directoryPosition, header.metadataPosition, header.attachmentDirectoryPosition].filter(n => n > 0);
	return {
		read,
		layout: indices => JSON.parse(wasm.czi_layout(directory, metadata, JSON.stringify({ indices }))),
		/** The pool path: one decode per tile, merged (czi-tile-merge.ts). */
		regionByTiles(merge, indices, factor, rect) {
			const options = { indices, factor, ...(rect ? { rect } : {}), fileSize: bytes.length, boundaries };
			const plan = JSON.parse(wasm.czi_region_plan(directory, JSON.stringify(options)));
			const clamp = (value, max) => Math.min(Math.max(0, Math.floor(value)), max);
			const layout = JSON.parse(wasm.czi_layout(directory, metadata, JSON.stringify({ indices })));
			const region = { x: clamp(rect?.x ?? 0, layout.width), y: clamp(rect?.y ?? 0, layout.height) };
			const jobs = merge.cziTileJobs(region, factor, plan.width, plan.height, plan.rects);
			const output = new Float32Array(plan.width * plan.height * layout.channels);
			jobs.forEach((job, i) => {
				if (!job) return;
				const [position, length] = plan.ranges[i];
				const tileOptions = JSON.stringify({ ...options, rect: job.rect, positions: [position] });
				const result = wasm.decode_czi_region(directory, tileOptions, read(position, length), Uint32Array.of(0));
				assert.ok(merge.mergeCziTile(output, plan.width, layout.channels, job,
					{ width: result.width, height: result.height, samples: result.take_data_as_f32() }), 'tile size');
			});
			return output;
		},
		region(indices, factor, rect) {
			const options = JSON.stringify({ indices, factor, ...(rect ? { rect } : {}), fileSize: bytes.length, boundaries });
			const plan = JSON.parse(wasm.czi_region_plan(directory, options));
			const parts = plan.ranges.map(([position, length]) => read(position, length));
			const blob = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
			const offsets = new Uint32Array(parts.length);
			let at = 0;
			parts.forEach((part, i) => { offsets[i] = at; blob.set(part, at); at += part.length; });
			const result = wasm.decode_czi_region(directory, options, blob, offsets);
			return { width: result.width, height: result.height, channels: result.channels, data: result.take_data_as_f32(), plan };
		},
	};
}

function sameSamples(actual, expected, label) {
	assert.equal(actual.length, expected.length, `${label}: sample count`);
	for (let i = 0; i < expected.length; i++) {
		if (!Object.is(actual[i], expected[i])) assert.fail(`${label}: sample ${i} is ${actual[i]}, expected ${expected[i]}`);
	}
}

async function main() {
	const wasm = await import(path.join(root, 'media', 'wasm', 'tiff-wasm.js'));
	const merge = await import(path.join(root, 'out', 'media', 'modules', 'czi-tile-merge.js'));
	await wasm.default({ module_or_path: fs.readFileSync(path.join(root, 'media', 'wasm', 'tiff-wasm.wasm')) });

	// Repository files: ranged equals whole, for every plane, plus a region.
	const samples = fs.readdirSync(path.join(root, 'test-samples', 'scientific')).filter(name => name.endsWith('.czi'));
	let planes = 0;
	for (const name of samples) {
		const bytes = fs.readFileSync(path.join(root, 'test-samples', 'scientific', name));
		const reader = rangedReader(wasm, bytes);
		const selectors = JSON.parse(reader.layout({}).metadataJson).selectors || [];
		const combos = [{}];
		for (const selector of selectors) {
			const next = [];
			for (const combo of combos) for (let i = 0; i < selector.size; i++) next.push({ ...combo, [selector.name]: i });
			combos.splice(0, combos.length, ...next);
		}
		for (const indices of combos) {
			const whole = wasm.decode_czi_fast(new Uint8Array(bytes), JSON.stringify({ indices }));
			const expected = whole.take_data_as_f32();
			const ranged = reader.region(indices, 1);
			assert.equal(ranged.width, whole.width, `${name} width`);
			sameSamples(ranged.data, expected, `${name} ${JSON.stringify(indices)}`);
			const rect = { x: 3, y: 2, width: Math.max(1, whole.width - 7), height: Math.max(1, whole.height - 5) };
			const part = reader.region(indices, 1, rect);
			const cut = new Float32Array(rect.width * rect.height * whole.channels);
			for (let y = 0; y < rect.height; y++) {
				cut.set(expected.subarray(((rect.y + y) * whole.width + rect.x) * whole.channels, ((rect.y + y) * whole.width + rect.x + rect.width) * whole.channels), y * rect.width * whole.channels);
			}
			sameSamples(part.data, cut, `${name} ${JSON.stringify(indices)} region`);
			planes++;
		}
	}

	// Synthetic pyramid: stored levels equal the full plane sampled at their factor.
	const { bytes, extent } = syntheticPyramid();
	const reader = rangedReader(wasm, bytes);
	for (const c of [0, 1]) {
		const layout = reader.layout({ C: c });
		assert.deepEqual(layout.factors, [1, 2, 4]);
		assert.equal(layout.width, extent.width);
		const full = reader.region({ C: c }, 1);
		for (let y = 0; y < extent.height; y++) for (let x = 0; x < extent.width; x++) {
			assert.equal(full.data[y * extent.width + x], value(extent.x + x, extent.y + y, c), `full plane at ${x},${y}`);
		}
		for (const factor of [2, 4]) {
			for (const rect of [undefined, { x: 8, y: 4, width: 60, height: 40 }]) {
				const r = rect || { x: 0, y: 0, width: extent.width, height: extent.height };
				const region = reader.region({ C: c }, factor, rect);
				assert.equal(region.plan.sourceFactor, factor, `factor ${factor} reads its stored level`);
				assert.equal(region.width, Math.ceil(r.width / factor));
				assert.equal(region.height, Math.ceil(r.height / factor));
				const expected = new Float32Array(region.width * region.height);
				for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) {
					expected[y * region.width + x] = full.data[(r.y + y * factor) * extent.width + r.x + x * factor];
				}
				sameSamples(region.data, expected, `C${c} factor ${factor} ${rect ? 'region' : 'plane'}`);
			}
		}
		// Between stored levels the coarser-or-equal one is read.
		assert.equal(reader.region({ C: c }, 3).plan.sourceFactor, 2);
		assert.equal(reader.region({ C: c }, 64).plan.sourceFactor, 4);
		// One decode per tile, merged in plan order, equals the single decode.
		for (const [factor, rect] of [[1, undefined], [1, { x: 30, y: 7, width: 70, height: 40 }], [2, undefined], [3, { x: 9, y: 5, width: 61, height: 33 }]]) {
			sameSamples(reader.regionByTiles(merge, { C: c }, factor, rect), reader.region({ C: c }, factor, rect).data, `C${c} factor ${factor} tiles merged`);
		}
		// A region reads only the subblocks it touches.
		assert.equal(reader.region({ C: c }, 1, { x: 0, y: 0, width: 10, height: 10 }).plan.ranges.length, 1);
	}
	console.log(`CZI ranged access: ${planes} planes of ${samples.length} files equal the whole-file decode; synthetic pyramid levels exact at factors 2 and 4`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });

/**
 * XCF previews composite their layers in row bands on several workers
 * (`media/modules/layer-compositor-bands.ts`). Each band must equal the same
 * rows of the full composite bit for bit, whatever the stack holds: offsets
 * partly outside the canvas, every blend mode and opacity, raster masks,
 * clipping, adjustment layers and nested groups with their own offsets. This
 * composites random stacks whole and in several band splits and compares.
 */
const assert = require('node:assert/strict');

function random(seed) {
	let state = seed >>> 0 || 1;
	return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}

async function main() {
	const compositor = await import('../out/media/modules/layer-compositor.js');
	const { sliceLayersForBand, mergeBands, canComposeInBands, finiteRangeOf } = await import('../out/media/modules/layer-compositor-bands.js');
	const { composite, BLEND_MODES } = compositor;
	const modes = BLEND_MODES.map(mode => mode.id);
	const adjustments = [
		{ type: 'levels', rgb: { inputLow: 10, inputHigh: 240, gamma: 1.3, outputLow: 0, outputHigh: 255 } },
		{ type: 'curves', rgb: [{ input: 0, output: 0 }, { input: 128, output: 160 }, { input: 255, output: 255 }] },
		{ type: 'hue/saturation', master: { hue: 25, saturation: 20, lightness: -10 } },
		{ type: 'brightness/contrast', brightness: 20, contrast: 15 },
		{ type: 'invert' },
	];

	let stacks = 0, compared = 0;
	for (let seed = 1; seed <= 60; seed++) {
		const rand = random(seed * 7919);
		const pick = list => list[Math.floor(rand() * list.length)];
		const width = 17 + Math.floor(rand() * 40), height = 23 + Math.floor(rand() * 60);
		const layers = [];
		const groupIds = [];
		const count = 2 + Math.floor(rand() * 7);
		for (let i = 0; i < count; i++) {
			const parentId = groupIds.length && rand() < 0.4 ? pick(groupIds) : undefined;
			const kind = i > 0 && rand() < 0.15 ? 'adjustment' : i > 0 && rand() < 0.12 ? 'group' : 'raster';
			const base = {
				id: `l${i}`, kind, parentId, visible: rand() > 0.1, opacity: rand() < 0.3 ? rand() : 1,
				blendMode: rand() < 0.5 ? 'normal' : pick(modes), clipped: i > 0 && rand() < 0.2,
				offsetX: Math.floor(rand() * width) - Math.floor(width / 3), offsetY: Math.floor(rand() * height) - Math.floor(height / 3),
				isFloat: false, typeMax: 255,
			};
			if (kind === 'group') {
				layers.push({ ...base, width, height, channels: 4 });
				groupIds.push(base.id);
				continue;
			}
			if (kind === 'adjustment') {
				layers.push({ ...base, width: 1, height: 1, channels: 4, adjustment: pick(adjustments) });
				continue;
			}
			const full = rand() < 0.3;
			const w = full ? width : 1 + Math.floor(rand() * width), h = full ? height : 1 + Math.floor(rand() * height);
			const channels = pick([1, 2, 3, 4, 4]);
			const data = new Uint8Array(w * h * channels);
			for (let p = 0; p < data.length; p++) data[p] = Math.floor(rand() * 256);
			const layer = { ...base, width: w, height: h, channels, data };
			if (full) { layer.offsetX = 0; layer.offsetY = 0; }
			if (rand() < 0.3) {
				const mw = 1 + Math.floor(rand() * width), mh = 1 + Math.floor(rand() * height);
				const maskData = new Uint8Array(mw * mh);
				for (let p = 0; p < maskData.length; p++) maskData[p] = Math.floor(rand() * 256);
				layer.rasterMask = { data: maskData, width: mw, height: mh, channels: 1, typeMax: 255,
					offsetX: Math.floor(rand() * width) - 3, offsetY: Math.floor(rand() * height) - 3, invert: rand() < 0.3 };
			}
			layers.push(layer);
		}
		// Offset groups are composited whole; check the predicate, then band the
		// same stack with its groups at the origin (as XCF writes them).
		if (layers.some(layer => layer.kind === 'group' && (layer.offsetX || layer.offsetY))) {
			assert.equal(canComposeInBands(layers), false, `seed ${seed}: an offset group must not be banded`);
			for (const layer of layers) if (layer.kind === 'group') { layer.offsetX = 0; layer.offsetY = 0; }
		}
		assert.ok(canComposeInBands(layers));
		const expected = composite(layers, width, height);
		stacks++;
		for (const bandCount of [2, 3, 5, 8]) {
			const cuts = [0];
			for (let b = 1; b < bandCount; b++) cuts.push(Math.round(b * height / bandCount));
			cuts.push(height);
			const bands = [];
			for (let b = 0; b < bandCount; b++) {
				if (cuts[b + 1] <= cuts[b]) continue;
				bands.push(composite(sliceLayersForBand(layers, cuts[b], cuts[b + 1]), width, cuts[b + 1] - cuts[b]));
			}
			// Ranges computed per band (as the workers do) and over the merged data agree.
			const merged = mergeBands(bands, width, height, bands.map(finiteRangeOf));
			const recomputed = mergeBands(bands, width, height);
			assert.deepEqual(recomputed.stats, merged.stats, `seed ${seed}: band ranges and merged range`);
			assert.equal(merged.channels, expected.channels, `seed ${seed}: channels`);
			assert.equal(merged.coveredCount, expected.coveredCount, `seed ${seed}, ${bandCount} bands: covered count`);
			const a = Buffer.from(merged.data.buffer), b = Buffer.from(expected.data.buffer);
			if (!a.equals(b)) {
				let first = 0; while (merged.data[first] === expected.data[first] || (Number.isNaN(merged.data[first]) && Number.isNaN(expected.data[first]))) first++;
				assert.fail(`seed ${seed}, ${bandCount} bands: sample ${first} (row ${Math.floor(first / expected.channels / width)}) is ${merged.data[first]}, full composite ${expected.data[first]}`);
			}
			assert.ok(Object.is(merged.stats.min, expected.stats.min) && Object.is(merged.stats.max, expected.stats.max), `seed ${seed}, ${bandCount} bands: band stats ${JSON.stringify(bands.map(x => [x.stats.min, x.stats.max, x.coveredCount]))} stats ${merged.stats.min}..${merged.stats.max} vs ${expected.stats.min}..${expected.stats.max}, channels ${expected.channels}, covered ${expected.coveredCount}`);
			compared++;
		}
	}
	console.log(`Composite bands: ${stacks} random stacks identical to the full composite in ${compared} band splits`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });

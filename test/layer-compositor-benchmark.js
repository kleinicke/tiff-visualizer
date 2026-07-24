/**
 * Repeatable CPU compositor benchmark.
 *
 * Default: 1024×1024, six raster layers and three adjustments. Override with
 * LAYER_BENCH_WIDTH, LAYER_BENCH_HEIGHT, LAYER_BENCH_LAYERS,
 * LAYER_BENCH_CHANNELS and LAYER_BENCH_RUNS when profiling custom documents.
 * LAYER_BENCH_PRESET=4k and =8k provide bounded representative workloads.
 */
const path = require('path');
const { performance } = require('perf_hooks');

function positiveInteger(name, fallback) {
	const value = Number(process.env[name]);
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function main() {
	const { composite, compositeRegion } = await import(path.join('..', 'out', 'media', 'modules', 'layer-compositor.js').replace(/\\/g, '/'));
	const preset = process.env.LAYER_BENCH_PRESET;
	const defaults = preset === '4k'
		? { width: 3840, height: 2160, layers: 4, channels: 4, runs: 3 }
		: preset === '8k'
			// Scalar 8K still exercises 33 million pixels per layer without
			// requiring more than a gigabyte solely for RGBA source fixtures.
			? { width: 7680, height: 4320, layers: 3, channels: 1, runs: 1 }
			: { width: 1024, height: 1024, layers: 6, channels: 4, runs: 5 };
	const width = positiveInteger('LAYER_BENCH_WIDTH', defaults.width);
	const height = positiveInteger('LAYER_BENCH_HEIGHT', defaults.height);
	const rasterCount = positiveInteger('LAYER_BENCH_LAYERS', defaults.layers);
	const channels = positiveInteger('LAYER_BENCH_CHANNELS', defaults.channels);
	const runs = positiveInteger('LAYER_BENCH_RUNS', defaults.runs);
	const pixels = width * height;
	const layers = [];

	for (let layerIndex = 0; layerIndex < rasterCount; layerIndex++) {
		const data = new Uint8Array(pixels * channels);
		for (let pixel = 0; pixel < pixels; pixel++) {
			const offset = pixel * channels;
			data[offset] = (pixel + layerIndex * 17) & 255;
			if (channels >= 3) {
				data[offset + 1] = (pixel * 3 + layerIndex * 29) & 255;
				data[offset + 2] = (pixel * 7 + layerIndex * 11) & 255;
			}
			if (channels === 4) { data[offset + 3] = layerIndex === 0 ? 255 : 176; }
		}
		layers.push({
			id: `raster-${layerIndex}`, kind: 'raster', data, width, height,
			channels, typeMax: 255, opacity: 1, visible: true,
			blendMode: ['normal', 'multiply', 'screen'][layerIndex % 3],
		});
	}
	const adjustments = [
		{ id: 'levels', kind: 'adjustment', clipped: false, width: 1, height: 1, channels, typeMax: 255, opacity: 1, visible: true, blendMode: 'normal', adjustment: { type: 'levels', rgb: { shadowInput: 8, highlightInput: 242, midtoneInput: 1.15, shadowOutput: 0, highlightOutput: 255 } } },
		{ id: 'curves', kind: 'adjustment', clipped: false, width: 1, height: 1, channels, typeMax: 255, opacity: 1, visible: true, blendMode: 'normal', adjustment: { type: 'curves', rgb: [{ input: 0, output: 0 }, { input: 96, output: 120 }, { input: 255, output: 255 }] } },
	];
	if (channels >= 3) {
		adjustments.push({ id: 'hue', kind: 'adjustment', clipped: false, width: 1, height: 1, channels, typeMax: 255, opacity: 1, visible: true, blendMode: 'normal', adjustment: { type: 'hue/saturation', master: { hue: 18, saturation: 12, lightness: -3 }, colorizeEnabled: false } });
	}
	layers.push(...adjustments);

	// One warm-up lets the runtime optimize hot loops and populate LUT caches.
	composite(layers, width, height);
	const durations = [];
	for (let run = 0; run < runs; run++) {
		const start = performance.now();
		const result = composite(layers, width, height);
		durations.push(performance.now() - start);
		if (result.width !== width || result.height !== height) { throw new Error('Unexpected benchmark result dimensions'); }
	}
	const megapixels = pixels / 1_000_000;
	const middle = median(durations);
	console.log(`Layer compositor: ${width}×${height}, ${rasterCount} raster (${channels}ch) + ${adjustments.length} filter layers`);
	console.log(`median ${middle.toFixed(1)} ms (${(megapixels * rasterCount / (middle / 1000)).toFixed(1)} raster MP/s), runs ${durations.map(value => value.toFixed(1)).join(', ')} ms`);
	const regionWidth = Math.min(512, width), regionHeight = Math.min(512, height);
	const regionStart = performance.now();
	compositeRegion(layers, width, height, {
		x: Math.floor((width - regionWidth) / 2), y: Math.floor((height - regionHeight) / 2),
		width: regionWidth, height: regionHeight,
	});
	console.log(`localized ${regionWidth}×${regionHeight} dirty region ${(performance.now() - regionStart).toFixed(1)} ms`);
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});

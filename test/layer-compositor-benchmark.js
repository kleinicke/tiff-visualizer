/**
 * Repeatable CPU compositor benchmark.
 *
 * Default: 1024×1024, six raster layers and three adjustments. Override with
 * LAYER_BENCH_WIDTH, LAYER_BENCH_HEIGHT, LAYER_BENCH_LAYERS and
 * LAYER_BENCH_RUNS when profiling larger documents.
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
	const { composite } = await import(path.join('..', 'out', 'media', 'modules', 'layer-compositor.js').replace(/\\/g, '/'));
	const width = positiveInteger('LAYER_BENCH_WIDTH', 1024);
	const height = positiveInteger('LAYER_BENCH_HEIGHT', 1024);
	const rasterCount = positiveInteger('LAYER_BENCH_LAYERS', 6);
	const runs = positiveInteger('LAYER_BENCH_RUNS', 5);
	const pixels = width * height;
	const layers = [];

	for (let layerIndex = 0; layerIndex < rasterCount; layerIndex++) {
		const data = new Uint8Array(pixels * 4);
		for (let pixel = 0; pixel < pixels; pixel++) {
			const offset = pixel * 4;
			data[offset] = (pixel + layerIndex * 17) & 255;
			data[offset + 1] = (pixel * 3 + layerIndex * 29) & 255;
			data[offset + 2] = (pixel * 7 + layerIndex * 11) & 255;
			data[offset + 3] = layerIndex === 0 ? 255 : 176;
		}
		layers.push({
			id: `raster-${layerIndex}`, kind: 'raster', data, width, height,
			channels: 4, typeMax: 255, opacity: 1, visible: true,
			blendMode: ['normal', 'multiply', 'screen'][layerIndex % 3],
		});
	}
	layers.push(
		{ id: 'levels', kind: 'adjustment', clipped: false, width: 1, height: 1, channels: 4, typeMax: 255, opacity: 1, visible: true, blendMode: 'normal', adjustment: { type: 'levels', rgb: { shadowInput: 8, highlightInput: 242, midtoneInput: 1.15, shadowOutput: 0, highlightOutput: 255 } } },
		{ id: 'curves', kind: 'adjustment', clipped: false, width: 1, height: 1, channels: 4, typeMax: 255, opacity: 1, visible: true, blendMode: 'normal', adjustment: { type: 'curves', rgb: [{ input: 0, output: 0 }, { input: 96, output: 120 }, { input: 255, output: 255 }] } },
		{ id: 'hue', kind: 'adjustment', clipped: false, width: 1, height: 1, channels: 4, typeMax: 255, opacity: 1, visible: true, blendMode: 'normal', adjustment: { type: 'hue/saturation', master: { hue: 18, saturation: 12, lightness: -3 }, colorizeEnabled: false } },
	);

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
	console.log(`Layer compositor: ${width}×${height}, ${rasterCount} raster + 3 filter layers`);
	console.log(`median ${middle.toFixed(1)} ms (${(megapixels * rasterCount / (middle / 1000)).toFixed(1)} raster MP/s), runs ${durations.map(value => value.toFixed(1)).join(', ')} ms`);
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});

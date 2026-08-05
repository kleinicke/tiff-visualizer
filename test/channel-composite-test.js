/**
 * Multi-channel compositing tests.
 *
 * Runs against the unbundled ESM output in out/media/modules, so it exercises
 * the code the webview loads. Assertions check arithmetic against hand-computed
 * answers rather than recorded output — the whole claim of this feature is that
 * a channel's brightness follows its own range and nothing else.
 *
 * Run with: node test/channel-composite-test.js  (after npm run compile)
 */

const assert = require('assert');
const path = require('path');

const OUT = path.join(__dirname, '..', 'out', 'media', 'modules');
const moduleUrl = name => require('url').pathToFileURL(path.join(OUT, name)).href;

let passed = 0;
let failed = 0;

function test(name, fn) {
	try {
		fn();
		passed++;
		console.log(`  ✅ ${name}`);
	} catch (error) {
		failed++;
		console.log(`  ❌ ${name}`);
		console.log(`     ${error.message}`);
	}
}

function close(actual, expected, tolerance, label) {
	assert.ok(
		Math.abs(actual - expected) <= tolerance,
		`${label}: expected ~${expected}, got ${actual} (tolerance ${tolerance})`,
	);
}

/** ImageData is a DOM type; the composite only needs its shape. */
function installImageDataShim() {
	if (typeof globalThis.ImageData === 'function') { return; }
	globalThis.ImageData = class {
		constructor(data, width, height) {
			this.data = data;
			this.width = width;
			this.height = height;
		}
	};
}

function plane(index, name, values, width, height) {
	return { index, name, data: Float32Array.from(values), width, height };
}

async function main() {
	installImageDataShim();
	const composite = await import(moduleUrl('channel-composite.js'));

	console.log('\n🎨 Channel compositing');

	test('a single channel is tinted by its colour and range', () => {
		const planes = [plane(0, 'A', [0, 50, 100], 3, 1)];
		const settings = [{ visible: true, color: '#00ff00', opacity: 1, min: 0, max: 100 }];
		const image = composite.compositeChannels(planes, settings, 3, 1);

		// Pure green tint: red and blue stay at zero, green tracks the value.
		close(image.data[1], 0, 1, 'green at the black point');
		close(image.data[5], 127, 2, 'green at mid range');
		close(image.data[9], 255, 1, 'green at the white point');
		assert.strictEqual(image.data[0], 0, 'a green tint must not produce red');
		assert.strictEqual(image.data[2], 0, 'a green tint must not produce blue');
		assert.strictEqual(image.data[3], 255, 'alpha must be opaque');
	});

	test('channels add rather than replace', () => {
		const planes = [
			plane(0, 'G', [100], 1, 1),
			plane(1, 'R', [100], 1, 1),
		];
		const settings = [
			{ visible: true, color: '#00ff00', opacity: 1, min: 0, max: 100 },
			{ visible: true, color: '#ff0000', opacity: 1, min: 0, max: 100 },
		];
		const image = composite.compositeChannels(planes, settings, 1, 1);
		// Two saturated channels of different hue give yellow, not one or the
		// other — this is the property that distinguishes additive compositing
		// from alpha-over.
		close(image.data[0], 255, 1, 'red from channel 2');
		close(image.data[1], 255, 1, 'green from channel 1');
		close(image.data[2], 0, 1, 'blue untouched');
	});

	test('each channel is scaled by its own range', () => {
		// A dim channel and a bright one. With a shared range the dim channel
		// would be nearly invisible; with its own it reaches full brightness.
		const planes = [
			plane(0, 'dim', [10], 1, 1),
			plane(1, 'bright', [1000], 1, 1),
		];
		const settings = [
			{ visible: true, color: '#00ff00', opacity: 1, min: 0, max: 10 },
			{ visible: true, color: '#ff0000', opacity: 1, min: 0, max: 1000 },
		];
		const image = composite.compositeChannels(planes, settings, 1, 1);
		close(image.data[1], 255, 1, 'the dim channel reaches full brightness on its own range');
		close(image.data[0], 255, 1, 'the bright channel is unaffected by the dim one');
	});

	test('opacity scales a channel\'s contribution', () => {
		const planes = [plane(0, 'A', [100], 1, 1)];
		const settings = [{ visible: true, color: '#ffffff', opacity: 0.5, min: 0, max: 100 }];
		const image = composite.compositeChannels(planes, settings, 1, 1);
		close(image.data[0], 127, 2, 'half opacity halves the contribution');
	});

	test('hidden channels and solo', () => {
		const planes = [
			plane(0, 'A', [100], 1, 1),
			plane(1, 'B', [100], 1, 1),
		];
		const settings = [
			{ visible: true, color: '#00ff00', opacity: 1, min: 0, max: 100 },
			{ visible: true, color: '#ff0000', opacity: 1, min: 0, max: 100 },
		];

		const hidden = composite.compositeChannels(
			planes, [settings[0], { ...settings[1], visible: false }], 1, 1);
		assert.strictEqual(hidden.data[0], 0, 'a hidden channel must contribute nothing');
		assert.strictEqual(hidden.data[1], 255);

		const soloed = composite.compositeChannels(planes, settings, 1, 1, { soloIndex: 1 });
		assert.strictEqual(soloed.data[1], 0, 'solo must exclude the other channel');
		assert.strictEqual(soloed.data[0], 255);
	});

	test('values outside the range clamp instead of wrapping', () => {
		const planes = [plane(0, 'A', [-50, 0, 50, 100, 500], 5, 1)];
		const settings = [{ visible: true, color: '#ffffff', opacity: 1, min: 0, max: 100 }];
		const image = composite.compositeChannels(planes, settings, 5, 1);
		assert.strictEqual(image.data[0], 0, 'below the black point is black');
		assert.strictEqual(image.data[4], 0, 'at the black point is black');
		close(image.data[8], 127, 2, 'mid range');
		assert.strictEqual(image.data[12], 255, 'at the white point is full');
		assert.strictEqual(image.data[16], 255, 'above the white point stays full, not wrapped');
	});

	test('non-finite samples contribute nothing and never poison a pixel', () => {
		const planes = [
			plane(0, 'A', [NaN, 100], 2, 1),
			plane(1, 'B', [100, 100], 2, 1),
		];
		const settings = [
			{ visible: true, color: '#00ff00', opacity: 1, min: 0, max: 100 },
			{ visible: true, color: '#ff0000', opacity: 1, min: 0, max: 100 },
		];
		const image = composite.compositeChannels(planes, settings, 2, 1);
		// Pixel 0: channel A is NaN, channel B is valid — B must still show.
		assert.strictEqual(image.data[1], 0, 'the NaN channel contributed');
		assert.strictEqual(image.data[0], 255, 'the finite channel was lost because of the other one');
	});

	test('a pixel that is non-finite in every channel uses the NaN colour', () => {
		const planes = [plane(0, 'A', [NaN], 1, 1)];
		const settings = [{ visible: true, color: '#ffffff', opacity: 1, min: 0, max: 100 }];
		const image = composite.compositeChannels(planes, settings, 1, 1, { nanColor: [255, 0, 255] });
		assert.deepStrictEqual(
			[image.data[0], image.data[1], image.data[2]], [255, 0, 255],
			'a fully non-finite pixel should be painted with the NaN colour');
	});

	test('interleaved data splits into planes without reordering', () => {
		// Two pixels, three channels, interleaved.
		const data = [1, 2, 3, 4, 5, 6];
		const planes = composite.planesFromInterleaved(data, 2, 1, 3);
		assert.strictEqual(planes.length, 3);
		assert.deepStrictEqual(Array.from(planes[0].data), [1, 4]);
		assert.deepStrictEqual(Array.from(planes[1].data), [2, 5]);
		assert.deepStrictEqual(Array.from(planes[2].data), [3, 6]);
		assert.deepStrictEqual(planes.map(p => p.name), ['Red', 'Green', 'Blue']);
	});

	test('channel statistics exclude non-finite samples', () => {
		const stats = composite.channelStats(plane(0, 'A', [5, NaN, 10, Infinity, 1], 5, 1));
		assert.strictEqual(stats.min, 1);
		assert.strictEqual(stats.max, 10);
		assert.strictEqual(stats.count, 3);
		assert.strictEqual(stats.nonFiniteCount, 2);
	});

	test('auto range clips outliers instead of following one hot pixel', () => {
		// 10000 samples of signal in 0..100, plus one hot pixel at 60000. Plain
		// min/max would put the signal in the bottom 0.2% of the range.
		const values = new Array(10000);
		for (let i = 0; i < values.length; i++) { values[i] = (i % 101); }
		values[0] = 60000;
		const target = plane(0, 'A', values, 100, 100);

		const full = composite.channelStats(target);
		assert.strictEqual(full.max, 60000, 'the hot pixel is genuinely there');

		const auto = composite.autoRange(target);
		assert.ok(auto.max < 200, `auto range should ignore the outlier, got ${auto.max}`);
		assert.ok(auto.max > 90, `auto range should still cover the signal, got ${auto.max}`);
	});

	test('OME channel colours win over the fallback palette', () => {
		assert.strictEqual(composite.defaultChannelColor(0, '#123456'), '#123456');
		// Junk from a malformed file must not become the tint.
		assert.strictEqual(
			composite.defaultChannelColor(0, 'not-a-colour'),
			composite.CHANNEL_PALETTE[0]);
		assert.strictEqual(composite.defaultChannelColor(1), composite.CHANNEL_PALETTE[1]);
	});

	test('alpha is not shown as a fourth emission channel by default', () => {
		const planes = composite.planesFromInterleaved([1, 2, 3, 4], 1, 1, 4);
		const settings = composite.defaultChannelSettings(planes);
		assert.strictEqual(settings[3].visible, false, 'alpha should start hidden');
		assert.ok(settings.slice(0, 3).every(s => s.visible), 'colour channels should start visible');
	});

	test('a colormap replaces the tint rather than multiplying it', () => {
		const planes = [plane(0, 'A', [100], 1, 1)];
		const tinted = composite.compositeChannels(
			planes, [{ visible: true, color: '#ff0000', opacity: 1, min: 0, max: 100 }], 1, 1);
		const mapped = composite.compositeChannels(
			planes, [{ visible: true, color: '#ff0000', opacity: 1, min: 0, max: 100, colormap: 'viridis' }], 1, 1);
		// Viridis at its top end is yellow-green, nothing like the red tint that
		// would survive a multiply.
		assert.notDeepStrictEqual(
			[tinted.data[0], tinted.data[1], tinted.data[2]],
			[mapped.data[0], mapped.data[1], mapped.data[2]]);
		assert.ok(mapped.data[1] > 100, `viridis top should be bright green-ish, got ${mapped.data[1]}`);
	});

	test('mismatched plane sizes are skipped rather than corrupting the output', () => {
		const planes = [
			plane(0, 'A', [100, 100], 2, 1),
			plane(1, 'B', [100], 1, 1),
		];
		const settings = [
			{ visible: true, color: '#00ff00', opacity: 1, min: 0, max: 100 },
			{ visible: true, color: '#ff0000', opacity: 1, min: 0, max: 100 },
		];
		const image = composite.compositeChannels(planes, settings, 2, 1);
		assert.strictEqual(image.width, 2);
		assert.strictEqual(image.data[0], 0, 'the wrong-sized plane must not be read');
		assert.strictEqual(image.data[1], 255);
	});

	console.log('\n' + '─'.repeat(60));
	if (failed === 0) {
		console.log(`🎉 All ${passed} channel compositing tests passed.`);
	} else {
		console.log(`❌ ${failed} of ${passed + failed} channel compositing tests failed.`);
		process.exitCode = 1;
	}
}

main().catch(error => {
	console.error('Test harness failed:', error);
	process.exitCode = 1;
});

/**
 * Tests for how a pixel with no value is coloured (media/modules/nan-color.ts).
 *
 * This used to be a `settings.nanColor === 'fuchsia'` check copied into seven
 * processors, which is how a setting ends up meaning slightly different things
 * in different formats — the NPY path accepted a hex string and an object that
 * no other format did. One resolver, tested here, is the point.
 *
 * Run with: node test/nan-color-test.js
 */

const assert = require('assert');
const path = require('path');

async function main() {
	console.log('🧪 Running no-value colour tests...\n');

	const { resolveNanColor, nanIsTransparent, nextNanColor, NAN_COLOR_NAMES } = await import(
		path.join('..', 'out', 'media', 'modules', 'nan-color.js').replace(/\\/g, '/')
	);

	// 1. The three named choices.
	{
		assert.deepStrictEqual(resolveNanColor({ nanColor: 'black' }), { r: 0, g: 0, b: 0, a: 255 });
		assert.deepStrictEqual(resolveNanColor({ nanColor: 'fuchsia' }), { r: 255, g: 0, b: 255, a: 255 });
		// Transparent still carries an RGB: a path that ignores alpha then shows
		// black rather than whatever happened to be in the buffer.
		assert.deepStrictEqual(resolveNanColor({ nanColor: 'transparent' }), { r: 0, g: 0, b: 0, a: 0 });
		assert.ok(nanIsTransparent({ nanColor: 'transparent' }));
		assert.ok(!nanIsTransparent({ nanColor: 'black' }));
		console.log('✅ black, fuchsia and transparent resolve to the expected pixels');
	}

	// 2. A mis-typed or missing setting must not make an image invisible.
	{
		for (const value of [undefined, null, '', 'chartreuse', 42, true]) {
			assert.deepStrictEqual(resolveNanColor({ nanColor: value }), { r: 0, g: 0, b: 0, a: 255 },
				`unrecognized setting ${String(value)} falls back to opaque black`);
		}
		assert.deepStrictEqual(resolveNanColor(undefined), { r: 0, g: 0, b: 0, a: 255 });
		assert.deepStrictEqual(resolveNanColor(null), { r: 0, g: 0, b: 0, a: 255 });
		console.log('✅ Absent and unrecognized settings fall back to opaque black');
	}

	// 3. The hex string and object forms the NPY path has always accepted.
	{
		assert.deepStrictEqual(resolveNanColor({ nanColor: '#ff8000' }), { r: 255, g: 128, b: 0, a: 255 });
		assert.deepStrictEqual(resolveNanColor({ nanColor: 'FF8000' }), { r: 255, g: 128, b: 0, a: 255 });
		assert.deepStrictEqual(resolveNanColor({ nanColor: { r: 1, g: 2, b: 3 } }), { r: 1, g: 2, b: 3, a: 255 });
		assert.deepStrictEqual(resolveNanColor({ nanColor: { r: 1, g: 2, b: 3, a: 0 } }), { r: 1, g: 2, b: 3, a: 0 });
		console.log('✅ Hex-string and object forms are accepted for every format, not just NPY');
	}

	// 4. The toggle command walks all three and returns to where it started.
	{
		assert.deepStrictEqual([...NAN_COLOR_NAMES], ['black', 'fuchsia', 'transparent']);
		assert.strictEqual(nextNanColor('black'), 'fuchsia');
		assert.strictEqual(nextNanColor('fuchsia'), 'transparent');
		assert.strictEqual(nextNanColor('transparent'), 'black');
		// An unknown current value starts the cycle rather than sticking.
		assert.strictEqual(nextNanColor(undefined), 'black');
		assert.strictEqual(nextNanColor('nonsense'), 'black');
		console.log('✅ The cycle covers all three choices and recovers from an unknown value');
	}

	console.log('\n🎉 All no-value colour tests passed.\n');
}

main().catch(error => {
	console.error('❌ No-value colour test failed:');
	console.error(error);
	process.exit(1);
});

/**
 * Unit tests for the layer compositor (media/modules/layer-compositor.js).
 * Pure-logic tests — no VS Code or DOM required.
 *
 * Run with: node test/layer-compositor-test.js
 */

const assert = require('assert');
const path = require('path');

function approx(a, b, eps = 1e-6) {
	return Math.abs(a - b) <= eps;
}

async function main() {
	const mod = await import(path.join('..', 'media', 'modules', 'layer-compositor.js').replace(/\\/g, '/'));
	const { composite, blendValue, isArithmeticMode, centeredOffset, BLEND_MODES } = mod;

	console.log('🧪 Running Layer Compositor tests...\n');

	// Helper to build a layer.
	const layer = (props) => Object.assign({ channels: 1, opacity: 1, blendMode: 'normal', visible: true }, props);

	// 1. Subtract gives the exact per-pixel difference on raw float values.
	{
		const a = layer({ data: new Float32Array([10, 20, 30, 40]), width: 2, height: 2, isFloat: true });
		const b = layer({ data: new Float32Array([1, 2, 3, 4]), width: 2, height: 2, isFloat: true, blendMode: 'subtract' });
		const r = composite([a, b], 2, 2);
		assert.deepStrictEqual(Array.from(r.data), [9, 18, 27, 36], 'subtract should be exact');
		assert.ok(r.isFloat, 'arithmetic result is float');
		console.log('✅ Exact float subtraction (error = a - b)');
	}

	// 2. Arithmetic propagates NaN.
	{
		const a = layer({ data: new Float32Array([5, NaN]), width: 2, height: 1 });
		const b = layer({ data: new Float32Array([1, 1]), width: 2, height: 1, blendMode: 'add' });
		const r = composite([a, b], 2, 1);
		assert.strictEqual(r.data[0], 6);
		assert.ok(Number.isNaN(r.data[1]), 'NaN propagates through arithmetic');
		console.log('✅ NaN propagates through arithmetic');
	}

	// 3. Normal mode: NaN in the top layer is transparent (background shows through).
	{
		const bg = layer({ data: new Float32Array([10, 20]), width: 2, height: 1 });
		const top = layer({ data: new Float32Array([NaN, 99]), width: 2, height: 1, blendMode: 'normal' });
		const r = composite([bg, top], 2, 1);
		assert.strictEqual(r.data[0], 10, 'NaN in top is transparent -> background value');
		assert.strictEqual(r.data[1], 99, 'finite top value replaces background');
		console.log('✅ Normal mode treats NaN as transparent');
	}

	// 4. Opacity lerps in normal mode.
	{
		const bg = layer({ data: new Float32Array([0]), width: 1, height: 1 });
		const top = layer({ data: new Float32Array([100]), width: 1, height: 1, opacity: 0.25, blendMode: 'normal' });
		const r = composite([bg, top], 1, 1);
		assert.ok(approx(r.data[0], 25), `expected 25, got ${r.data[0]}`);
		console.log('✅ Opacity blends (normal)');
	}

	// 5. Different sizes: a smaller top layer centered only affects the overlap; the
	//    rest keeps the background, and uncovered pixels stay NaN.
	{
		// 3x3 background of value 1; 1x1 top layer of value 9 centered at (1,1) subtract.
		const bg = layer({ data: new Float32Array(9).fill(1), width: 3, height: 3 });
		const off = centeredOffset(1, 1, 3, 3);
		assert.deepStrictEqual(off, { offsetX: 1, offsetY: 1 }, 'centered offset for 1x1 on 3x3');
		const top = layer({ data: new Float32Array([9]), width: 1, height: 1, blendMode: 'subtract', offsetX: off.offsetX, offsetY: off.offsetY });
		const r = composite([bg, top], 3, 3);
		const expected = [1, 1, 1, 1, 1 - 9, 1, 1, 1, 1];
		assert.deepStrictEqual(Array.from(r.data), expected, 'only the centered overlap is modified');
		console.log('✅ Centered placement of a smaller layer affects only the overlap');
	}

	// 6. Negative offset (overhang) is allowed and clipped.
	{
		const bg = layer({ data: new Float32Array([1, 1, 1, 1]), width: 2, height: 2 });
		// 2x2 top placed at (-1,-1): only its bottom-right pixel lands on canvas (0,0).
		const top = layer({ data: new Float32Array([5, 6, 7, 8]), width: 2, height: 2, blendMode: 'add', offsetX: -1, offsetY: -1 });
		const r = composite([bg, top], 2, 2);
		// top local (1,1)=8 maps to canvas (0,0): 1 + 8 = 9; rest unchanged.
		assert.deepStrictEqual(Array.from(r.data), [9, 1, 1, 1], 'negative offset overhang clipped correctly');
		console.log('✅ Negative offsets / overhang handled');
	}

	// 7. Uncovered pixels remain NaN (no-data), not 0.
	{
		const only = layer({ data: new Float32Array([7]), width: 1, height: 1, offsetX: 0, offsetY: 0 });
		const r = composite([only], 2, 1);
		assert.strictEqual(r.data[0], 7);
		assert.ok(Number.isNaN(r.data[1]), 'uncovered pixel stays NaN');
		assert.strictEqual(r.coveredCount, 1, 'coverage count tracks overlapped pixels');
		console.log('✅ Uncovered canvas stays no-data (NaN)');
	}

	// 8. Divide by zero yields NaN.
	{
		const a = layer({ data: new Float32Array([10]), width: 1, height: 1 });
		const b = layer({ data: new Float32Array([0]), width: 1, height: 1, blendMode: 'divide' });
		const r = composite([a, b], 1, 1);
		assert.ok(Number.isNaN(r.data[0]), 'divide by zero -> NaN');
		console.log('✅ Divide-by-zero yields NaN');
	}

	// 9. Grayscale layer composited over an RGB background broadcasts to 3 channels.
	{
		const bg = layer({ data: new Float32Array([10, 20, 30]), width: 1, height: 1, channels: 3 });
		const top = layer({ data: new Float32Array([5]), width: 1, height: 1, channels: 1, blendMode: 'add' });
		const r = composite([bg, top], 1, 1);
		assert.strictEqual(r.channels, 3, 'composite is RGB when any layer is colour');
		assert.deepStrictEqual(Array.from(r.data), [15, 25, 35], 'grayscale broadcast to RGB');
		console.log('✅ Channel broadcasting (gray over RGB)');
	}

	// 10. blendValue and isArithmeticMode behave as documented.
	{
		assert.strictEqual(blendValue(3, 4, 'difference'), 1);
		assert.strictEqual(blendValue(3, 4, 'normal'), 4);
		assert.strictEqual(isArithmeticMode('subtract'), true);
		assert.strictEqual(isArithmeticMode('normal'), false);
		assert.ok(BLEND_MODES.length >= 8, 'blend modes are exported');
		console.log('✅ blendValue / isArithmeticMode / BLEND_MODES');
	}

	// 11. Invisible / zero-opacity layers are ignored.
	{
		const bg = layer({ data: new Float32Array([1]), width: 1, height: 1 });
		const hidden = layer({ data: new Float32Array([99]), width: 1, height: 1, blendMode: 'add', visible: false });
		const transparent = layer({ data: new Float32Array([99]), width: 1, height: 1, blendMode: 'add', opacity: 0 });
		const r = composite([bg, hidden, transparent], 1, 1);
		assert.strictEqual(r.data[0], 1, 'hidden and zero-opacity layers contribute nothing');
		console.log('✅ Hidden / zero-opacity layers ignored');
	}

	console.log('\n🎉 All layer compositor tests passed.\n');
}

main().catch(err => {
	console.error('❌ Layer compositor test failed:');
	console.error(err);
	process.exit(1);
});

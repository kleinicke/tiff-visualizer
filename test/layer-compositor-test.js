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
	const mod = await import(path.join('..', 'out', 'media', 'modules', 'layer-compositor.js').replace(/\\/g, '/'));
	const { composite, blendValue, blendDocumentValue, isArithmeticMode, centeredOffset, BLEND_MODES } = mod;

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

	// 12. Mask mode hides the content below where the condition is false.
	{
		const { evalMaskCondition } = mod;
		// base values 0,1,2,3 ; mask values 0,1,0,1 ; condition "> 0.5" keeps where mask>0.5.
		const base = layer({ data: new Float32Array([0, 1, 2, 3]), width: 2, height: 2 });
		const mask = layer({ data: new Float32Array([0, 1, 0, 1]), width: 2, height: 2, blendMode: 'mask', maskCondition: { op: 'gt', threshold: 0.5 } });
		const r = composite([base, mask], 2, 2);
		assert.ok(Number.isNaN(r.data[0]), 'mask 0 (<=0.5) hides -> NaN');
		assert.strictEqual(r.data[1], 1, 'mask 1 (>0.5) keeps base');
		assert.ok(Number.isNaN(r.data[2]), 'mask 0 hides');
		assert.strictEqual(r.data[3], 3, 'mask 1 keeps');
		// Condition helper sanity.
		assert.strictEqual(evalMaskCondition(0.6, { op: 'gt', threshold: 0.5 }), true);
		assert.strictEqual(evalMaskCondition(NaN, { op: 'isnan' }), true);
		assert.strictEqual(evalMaskCondition(0.2, { op: 'isfinite' }), true);
		console.log('✅ Mask mode hides below where condition is false');
	}

	// 13. RGBA layers use per-pixel alpha in addition to layer opacity.
	{
		const bg = layer({ data: new Uint8Array([10, 20, 30, 255]), width: 1, height: 1, channels: 4, typeMax: 255 });
		const top = layer({ data: new Uint8Array([110, 120, 130, 128]), width: 1, height: 1, channels: 4, typeMax: 255 });
		const r = composite([bg, top], 1, 1);
		assert.strictEqual(r.channels, 4);
		assert.ok(approx(r.data[0], 10 + 100 * (128 / 255), 1e-5), `red alpha blend: ${r.data[0]}`);
		assert.ok(approx(r.data[1], 20 + 100 * (128 / 255), 1e-5), `green alpha blend: ${r.data[1]}`);
		assert.ok(approx(r.data[2], 30 + 100 * (128 / 255), 1e-5), `blue alpha blend: ${r.data[2]}`);
		assert.strictEqual(r.data[3], 255, 'opaque background keeps the result opaque');
		console.log('✅ RGBA layers honor per-pixel alpha');
	}

	// 14. Arithmetic comparisons keep their historical RGB value-space behavior.
	{
		const a = layer({ data: new Uint8Array([10, 20, 30, 128]), width: 1, height: 1, channels: 4, typeMax: 255 });
		const b = layer({ data: new Uint8Array([1, 2, 3, 64]), width: 1, height: 1, channels: 4, typeMax: 255, blendMode: 'subtract' });
		const r = composite([a, b], 1, 1);
		assert.strictEqual(r.channels, 3);
		assert.deepStrictEqual(Array.from(r.data), [9, 18, 27]);
		console.log('✅ RGBA arithmetic remains RGB value-space math');
	}

	// 15. Visibility changes never consume or mutate source layer pixels.
	{
		const bg = layer({ data: new Uint8Array([10, 20, 30, 255]), width: 1, height: 1, channels: 4, typeMax: 255 });
		const topPixels = new Uint8Array([200, 100, 50, 255]);
		const top = layer({ data: topPixels, width: 1, height: 1, channels: 4, typeMax: 255 });
		const visible = composite([bg, top], 1, 1);
		top.visible = false;
		const hidden = composite([bg, top], 1, 1);
		top.visible = true;
		const restored = composite([bg, top], 1, 1);
		assert.deepStrictEqual(Array.from(hidden.data), [10, 20, 30, 255]);
		assert.deepStrictEqual(Array.from(restored.data), Array.from(visible.data));
		assert.deepStrictEqual(Array.from(top.data), Array.from(topPixels));
		console.log('✅ RGBA layer visibility toggles restore the original pixels');
	}

	// 16. Groups composite on an isolated surface before group opacity is applied.
	{
		const bg = layer({ id: 'bg', data: new Uint8Array([0, 0, 0, 255]), width: 1, height: 1, channels: 4, typeMax: 255 });
		const group = layer({ id: 'group', kind: 'group', data: undefined, width: 1, height: 1, channels: 4, typeMax: 255, opacity: 0.5 });
		const red = layer({ id: 'red', parentId: 'group', data: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1, channels: 4, typeMax: 255 });
		const green = layer({ id: 'green', parentId: 'group', data: new Uint8Array([0, 255, 0, 128]), width: 1, height: 1, channels: 4, typeMax: 255 });
		const r = composite([bg, group, red, green], 1, 1);
		assert.ok(approx(r.data[0], 63.5, 1), `isolated group red: ${r.data[0]}`);
		assert.ok(approx(r.data[1], 64, 1), `isolated group green: ${r.data[1]}`);
		console.log('✅ First-class groups use isolated compositor surfaces');
	}

	// 17. Common document blend functions use the source value range.
	{
		assert.ok(approx(blendDocumentValue(128, 64, 'multiply', 255), 32.125, 1e-3));
		assert.ok(approx(blendDocumentValue(128, 64, 'screen', 255), 159.875, 1e-3));
		assert.strictEqual(blendDocumentValue(128, 64, 'darken', 255), 64);
		assert.strictEqual(blendDocumentValue(128, 64, 'lighten', 255), 128);
		assert.strictEqual(blendDocumentValue(128, 64, 'difference', 255), 64);
		assert.ok(approx(blendDocumentValue(128, 64, 'exclusion', 255), 127.749, 1e-3));
		assert.ok(BLEND_MODES.some(mode => mode.id === 'overlay'));
		console.log('✅ Common document blend modes');
	}

	// 18. Attached raster masks modulate layer alpha without becoming color layers.
	{
		const bg = layer({ data: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255]), width: 2, height: 1, channels: 4, typeMax: 255 });
		const top = layer({ data: new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255]), width: 2, height: 1, channels: 4, typeMax: 255,
			rasterMask: { data: new Uint8Array([255, 0]), width: 2, height: 1, channels: 1, typeMax: 255, offsetX: 0, offsetY: 0 } });
		const r = composite([bg, top], 2, 1);
		assert.deepStrictEqual(Array.from(r.data), [255, 0, 0, 255, 0, 0, 0, 255]);
		console.log('✅ Attached raster masks modulate alpha');
	}

	// 19. Clipped layers use the nearest unclipped sibling's alpha.
	{
		const bg = layer({ data: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255]), width: 2, height: 1, channels: 4, typeMax: 255 });
		const base = layer({ data: new Uint8Array([255, 0, 0, 255, 255, 0, 0, 0]), width: 2, height: 1, channels: 4, typeMax: 255 });
		const clipped = layer({ data: new Uint8Array([0, 0, 255, 255, 0, 0, 255, 255]), width: 2, height: 1, channels: 4, typeMax: 255, clipped: true });
		const r = composite([bg, base, clipped], 2, 1);
		assert.deepStrictEqual(Array.from(r.data), [0, 0, 255, 255, 0, 0, 0, 255]);
		console.log('✅ Clipping relationships follow base alpha');
	}

	// 20. Transparent authored pixels stay RGBA-transparent instead of becoming
	//     scientific no-data (NaN).
	{
		const authored = layer({
			data: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 128]),
			width: 2,
			height: 1,
			channels: 4,
			typeMax: 255,
		});
		const r = composite([authored], 2, 1);
		assert.deepStrictEqual(Array.from(r.data), [0, 0, 0, 0, 0, 0, 0, 128]);
		assert.ok(Array.from(r.data).every(Number.isFinite), 'transparent RGBA pixels must not become NaN');
		assert.strictEqual(r.coveredCount, 1, 'only the partially opaque pixel is covered');
		assert.deepStrictEqual(r.stats, { min: 0, max: 0 }, 'transparent pixels do not affect statistics');
		console.log('✅ Transparent RGBA remains transparent, not NaN');
	}

	console.log('\n🎉 All layer compositor tests passed.\n');
}

main().catch(err => {
	console.error('❌ Layer compositor test failed:');
	console.error(err);
	process.exit(1);
});

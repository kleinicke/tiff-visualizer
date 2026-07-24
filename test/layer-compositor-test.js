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
	const {
		composite, compositeRegion, blendValue, blendDocumentValue, evaluateCurvePoints,
		isArithmeticMode, centeredOffset, BLEND_MODES, getLayerCompositorCacheStats,
		resetLayerCompositorCacheStats,
	} = mod;
	const { LayerManager } = await import(path.join('..', 'out', 'media', 'modules', 'layer-manager.js').replace(/\\/g, '/'));
	const { blendModePatch } = await import(path.join('..', 'out', 'media', 'modules', 'layers-panel.js').replace(/\\/g, '/'));

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
		const rgbBase = layer({ data: new Float32Array([10, 20, 30, 255]), width: 1, height: 1, channels: 4, typeMax: 255 });
		const greenMask = layer({
			data: new Float32Array([0, 255, 0, 255]), width: 1, height: 1, channels: 4, typeMax: 255,
			blendMode: 'mask', maskCondition: { op: 'gt', threshold: 100 },
		});
		assert.strictEqual(composite([rgbBase, greenMask], 1, 1).data[3], 255, 'RGB masks use luminance rather than only the red channel');
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

	// 21. PSD-style adjustment nodes transform the composite below them.
	{
		const base = layer({ data: new Uint8Array([64, 0, 0, 255]), width: 1, height: 1, channels: 4, typeMax: 255 });
		const levels = layer({ kind: 'adjustment', adjustment: { type: 'levels', rgb: { shadowInput: 0, highlightInput: 128, shadowOutput: 0, highlightOutput: 255, midtoneInput: 1 } }, width: 1, height: 1, channels: 4, typeMax: 255 });
		const levelResult = composite([base, levels], 1, 1);
		assert.ok(approx(levelResult.data[0], 127.5, 0.01), `levels result: ${levelResult.data[0]}`);

		const curves = layer({ kind: 'adjustment', adjustment: { type: 'curves', rgb: [{ input: 0, output: 255 }, { input: 255, output: 0 }] }, width: 1, height: 1, channels: 4, typeMax: 255 });
		const curveResult = composite([base, curves], 1, 1);
		assert.ok(approx(curveResult.data[0], 191, 0.01), `curves result: ${curveResult.data[0]}`);
		const previewPoints = [{ input: 0, output: 0 }, { input: 128, output: 200 }, { input: 255, output: 255 }];
		assert.strictEqual(evaluateCurvePoints(previewPoints, 128), 200);
		assert.ok(evaluateCurvePoints(previewPoints, 64) > 64 && evaluateCurvePoints(previewPoints, 64) < 200, 'curve preview uses smooth monotone interpolation');

		const red = layer({ data: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1, channels: 4, typeMax: 255 });
		const hue = layer({ kind: 'adjustment', adjustment: { type: 'hue/saturation', master: { hue: 120, saturation: 0, lightness: 0 } }, width: 1, height: 1, channels: 4, typeMax: 255 });
		const hueResult = composite([red, hue], 1, 1);
		assert.ok(hueResult.data[1] > 254 && hueResult.data[0] < 1, `hue result: ${Array.from(hueResult.data)}`);

		const gray = layer({ data: new Uint8Array([128, 128, 128, 255]), width: 1, height: 1, channels: 4, typeMax: 255 });
		const colorize = layer({ kind: 'adjustment', adjustment: { type: 'hue/saturation', colorize: { hue: 0, saturation: 100, lightness: -50 } }, width: 1, height: 1, channels: 4, typeMax: 255 });
		const colorized = composite([gray, colorize], 1, 1);
		assert.ok(approx(colorized.data[0], 128, 0.01) && colorized.data[1] < 0.01 && colorized.data[2] < 0.01,
			`legacy colorize result: ${Array.from(colorized.data)}`);
		colorize.adjustment = { ...colorize.adjustment, colorizeEnabled: false };
		assert.deepStrictEqual(Array.from(composite([gray, colorize], 1, 1).data), [128, 128, 128, 255]);
		colorize.adjustment = { ...colorize.adjustment, colorizeEnabled: true };
		assert.ok(composite([gray, colorize], 1, 1).data[0] > 127, 're-enabling colorize reuses its previous parameters');
		console.log('✅ Levels, smooth curves, hue/saturation, and legacy colorize adjustments');
	}

	// 22. A clipped adjustment changes its base surface before the base blend
	//     mode is applied to the parent stack.
	{
		const background = layer({ data: new Uint8Array([100, 100, 100, 255]), width: 1, height: 1, channels: 4, typeMax: 255 });
		const screenedBase = layer({ data: new Uint8Array([50, 50, 50, 255]), width: 1, height: 1, channels: 4, typeMax: 255, blendMode: 'screen' });
		const clippedLevels = layer({ kind: 'adjustment', clipped: true, adjustment: { type: 'levels', rgb: { shadowInput: 0, highlightInput: 100, shadowOutput: 0, highlightOutput: 255, midtoneInput: 1 } }, width: 1, height: 1, channels: 4, typeMax: 255 });
		const result = composite([background, screenedBase, clippedLevels], 1, 1);
		const expected = blendDocumentValue(100, 127.5, 'screen', 255);
		assert.ok(approx(result.data[0], expected, 0.01), `clipped adjustment scope: ${result.data[0]} vs ${expected}`);
		screenedBase.visible = false;
		assert.ok(approx(composite([background, screenedBase, clippedLevels], 1, 1).data[0], 100, 0.01));
		screenedBase.visible = true;
		assert.ok(approx(composite([background, screenedBase, clippedLevels], 1, 1).data[0], expected, 0.01));
		console.log('✅ Clipped adjustment stacks render before their base blend mode and remain cache-safe');
	}

	// 23. Additional professional adjustment families share the same scoped,
	//     non-destructive compositor path.
	{
		const apply = (pixel, adjustment) => composite([
			layer({ data: new Uint8Array([...pixel, 255]), width: 1, height: 1, channels: 4, typeMax: 255 }),
			layer({ kind: 'adjustment', adjustment, width: 1, height: 1, channels: 4, typeMax: 255 }),
		], 1, 1).data;
		assert.ok(apply([64, 64, 64], { type: 'brightness/contrast', brightness: 10, contrast: 0 })[0] > 88);
		assert.ok(approx(apply([64, 64, 64], { type: 'exposure', exposure: 1, offset: 0, gamma: 1 })[0], 128, 0.01));
		assert.deepStrictEqual(Array.from(apply([10, 20, 30], { type: 'invert' })), [245, 235, 225, 255]);
		const mixed = apply([10, 20, 30], { type: 'channel mixer', red: { blue: 100 }, green: { green: 100 }, blue: { red: 100 } });
		assert.deepStrictEqual(Array.from(mixed), [30, 20, 10, 255]);
		const balanced = apply([128, 128, 128], { type: 'color balance', midtones: { cyanRed: 50 }, preserveLuminosity: false });
		assert.ok(balanced[0] > balanced[1], 'color balance moves midtone red independently');
		const monochrome = apply([200, 80, 20], { type: 'black & white' });
		assert.ok(approx(monochrome[0], monochrome[1]) && approx(monochrome[1], monochrome[2]));
		assert.deepStrictEqual(Array.from(apply([127, 200, 20], { type: 'threshold', level: 128 })), [255, 255, 255, 255]);
		const posterized = apply([100, 150, 240], { type: 'posterize', levels: 2 });
		assert.deepStrictEqual(Array.from(posterized), [0, 255, 255, 255]);
		const mapped = apply([128, 128, 128], { type: 'gradient map', stops: [{ position: 0, color: { r: 0, g: 0, b: 0 } }, { position: 1, color: { r: 255, g: 0, b: 0 } }] });
		assert.ok(mapped[0] > 127 && mapped[1] === 0 && mapped[2] === 0);
		console.log('✅ Exposure, brightness/contrast, invert, channel mixer, color balance, black & white, threshold/posterize, and gradient map');
	}

	// 24. Display-only setting changes may rerender the cached composite, while
	//     all mutations invalidate it before the next compositor pass.
	{
		const manager = new LayerManager();
		manager.setBaseLayer({ data: new Uint8Array([10, 20]), width: 2, height: 1, channels: 1, isFloat: false, typeMax: 255 });
		const first = manager.getComposite();
		assert.strictEqual(manager.getComposite(), first, 'unchanged layer stacks reuse the same composite');
		manager.updateLayer(manager.layers[0].id, { opacity: 0.5 });
		const updated = manager.getComposite();
		assert.notStrictEqual(updated, first, 'layer edits invalidate the composite cache');
		manager.moveLayer(manager.layers[0].id, 1, 0);
		assert.notStrictEqual(manager.getComposite(), updated, 'layer movement invalidates the composite cache');
		console.log('✅ Composite cache is reused for display-only rerenders and invalidated by layer edits');
	}

	// 25. Isolated group surfaces are retained when unrelated branches change.
	{
		resetLayerCompositorCacheStats();
		const group = layer({ id: 'group-cache', kind: 'group', width: 2, height: 1, channels: 4, typeMax: 255 });
		const child = layer({ id: 'group-child', parentId: 'group-cache', data: new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]), width: 2, height: 1, channels: 4, typeMax: 255 });
		const outside = layer({ id: 'outside', data: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]), width: 2, height: 1, channels: 4, typeMax: 255 });
		composite([group, child, outside], 2, 1);
		outside.opacity = 0.5;
		composite([group, child, outside], 2, 1);
		const stats = getLayerCompositorCacheStats();
		assert.ok(stats.groupMisses >= 1 && stats.groupHits >= 1, `expected a group cache hit after an unrelated edit: ${JSON.stringify(stats)}`);
		console.log('✅ Unchanged isolated groups reuse their cached compositor surfaces');
	}

	// 26. Dirty-region composition exactly matches the corresponding rectangle
	//     from a complete render, including canvas-coordinate translation.
	{
		const background = layer({ id: 'region-bg', data: new Uint8Array(4 * 4 * 4).fill(32), width: 4, height: 4, channels: 4, typeMax: 255 });
		for (let pixel = 0; pixel < 16; pixel++) { background.data[pixel * 4 + 3] = 255; }
		const patchLayer = layer({ id: 'region-patch', data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]), width: 2, height: 1, channels: 4, typeMax: 255, offsetX: 1, offsetY: 2 });
		const complete = composite([background, patchLayer], 4, 4);
		const region = compositeRegion([background, patchLayer], 4, 4, { x: 1, y: 2, width: 2, height: 1 });
		assert.deepStrictEqual(Array.from(region.data), Array.from(complete.data.slice((2 * 4 + 1) * 4, (2 * 4 + 3) * 4)));
		console.log('✅ Dirty-region composition matches the full compositor');
	}

	// 27. Creative 8-bit RGBA and scientific/high-bit-depth layers share one
	//     normalized display domain without collapsing the composite alpha.
	{
		const psdBase = layer({ data: new Uint8Array([10, 20, 30, 255]), width: 1, height: 1, channels: 4, typeMax: 255 });
		const floatTiff = layer({ data: new Float32Array([0.5]), width: 1, height: 1, channels: 1, typeMax: 1, isFloat: true });
		const floatResult = composite([psdBase, floatTiff], 1, 1);
		assert.strictEqual(floatResult.channels, 4);
		assert.strictEqual(floatResult.typeMax, 255);
		assert.ok(approx(floatResult.data[0], 127.5) && approx(floatResult.data[1], 127.5) && approx(floatResult.data[2], 127.5));
		assert.strictEqual(floatResult.data[3], 255, 'mixed float/RGBA alpha remains in the output type range');

		const uint16Tiff = layer({ data: new Uint16Array([32768]), width: 1, height: 1, channels: 1, typeMax: 65535 });
		const uint16Result = composite([psdBase, uint16Tiff], 1, 1);
		assert.ok(approx(uint16Result.data[0], 32768 * 255 / 65535, 1e-4), '16-bit samples are normalized into the PSD working range');
		assert.strictEqual(uint16Result.data[3], 255);
		console.log('✅ Mixed PSD + float/16-bit TIFF layers retain visible, correctly ranged alpha');
	}

	// 28. Two-channel TIFF is gray+alpha throughout composition.
	{
		const base = layer({ data: new Uint8Array([10, 20, 30, 255]), width: 1, height: 1, channels: 4, typeMax: 255 });
		const grayAlpha = layer({ data: new Float32Array([1, 0.5]), width: 1, height: 1, channels: 2, typeMax: 1, isFloat: true });
		const result = composite([base, grayAlpha], 1, 1);
		assert.ok(approx(result.data[0], 132.5) && approx(result.data[1], 137.5) && approx(result.data[2], 142.5));
		assert.strictEqual(result.data[3], 255);
		console.log('✅ Gray+alpha TIFF layers composite as grayscale with independent alpha');
	}

	// 29. Every document blend mode accepts mixed numeric ranges and produces a
	//     finite opaque result in the base document's working range.
	{
		const documentModes = BLEND_MODES.filter(mode => !mode.arithmetic && !mode.mask).map(mode => mode.id);
		for (const mode of documentModes) {
			const base = layer({ data: new Uint8Array([40, 100, 200, 255]), width: 1, height: 1, channels: 4, typeMax: 255 });
			const top = layer({ data: new Float32Array([0.8, 0.4, 0.2, 1]), width: 1, height: 1, channels: 4, typeMax: 1, isFloat: true, blendMode: mode });
			const result = composite([base, top], 1, 1);
			assert.ok(Array.from(result.data).every(Number.isFinite), `${mode} produced only finite samples`);
			assert.strictEqual(result.data[3], 255, `${mode} preserved opaque alpha`);
		}
		console.log('✅ All creative blend modes compose across uint8 and float layers');
	}

	// 30. Brightness Mask is a reversible view mode: it neither mutates pixels
	//     nor leaves an ordinary image clipped when returning to Normal.
	{
		const manager = new LayerManager();
		manager.setBaseLayer({ data: new Uint8Array([20, 20, 20, 255, 40, 40, 40, 255]), width: 2, height: 1, channels: 4, isFloat: false, typeMax: 255 });
		const pixels = new Float32Array([0, 1]);
		const id = manager.addLayer({ data: pixels, width: 2, height: 1, channels: 1, isFloat: true, typeMax: 1, sourceNumericType: 'float32' });
		const added = manager.layers.find(item => item.id === id);
		const before = Array.from(manager.getComposite().data);
		manager.updateLayer(id, blendModePatch(added, 'mask'));
		assert.strictEqual(added.clipped, false, 'brightness masks apply to the composite below instead of becoming clipping layers');
		assert.strictEqual(manager.getComposite().coveredCount, 1, 'mask mode changes coverage');
		manager.updateLayer(id, blendModePatch(added, 'normal'));
		assert.strictEqual(added.clipped, false);
		assert.deepStrictEqual(Array.from(manager.getComposite().data), before, 'returning to normal fully restores the prior composite');
		assert.deepStrictEqual(Array.from(pixels), [0, 1], 'mode changes never mutate TIFF source samples');
		console.log('✅ Brightness Mask → Normal restores the layer and its unmodified samples');
	}

	// 31. Channel-layout × numeric-type × blend-mode compatibility matrix.
	{
		const variants = [
			() => layer({ data: new Uint8Array([96]), width: 1, height: 1, channels: 1, typeMax: 255 }),
			() => layer({ data: new Uint16Array([32768, 49152]), width: 1, height: 1, channels: 2, typeMax: 65535 }),
			() => layer({ data: new Float32Array([0.2, 0.5, 0.8]), width: 1, height: 1, channels: 3, typeMax: 1, isFloat: true }),
			() => layer({ data: new Uint8Array([40, 100, 180, 224]), width: 1, height: 1, channels: 4, typeMax: 255 }),
		];
		for (const mode of BLEND_MODES.filter(item => !item.mask)) {
			for (const makeBase of variants) for (const makeTop of variants) {
				const base = makeBase(), top = makeTop(); top.blendMode = mode.id;
				const result = composite([base, top], 1, 1);
				assert.ok(result.data.length === result.channels, `${mode.id}: output shape matches channel count`);
				assert.ok(Array.from(result.data).every(Number.isFinite), `${mode.id}: 1/2/3/4-channel mixed result is finite`);
			}
		}
		console.log('✅ Numeric/channel/blend compatibility matrix passed for 1/2/3/4-channel layers');
	}

	// 32. Group/clipping caches invalidate when mask conditions or float
	//     interpretation changes, rather than returning a stale surface.
	{
		const group = layer({ id: 'mixed-cache-group', kind: 'group', width: 2, height: 1, channels: 4, typeMax: 255 });
		const base = layer({ id: 'mixed-cache-base', parentId: group.id, data: new Uint8Array([20, 20, 20, 255, 40, 40, 40, 255]), width: 2, height: 1, channels: 4, typeMax: 255 });
		const mask = layer({ id: 'mixed-cache-mask', parentId: group.id, data: new Float32Array([0.25, 0.75]), width: 2, height: 1, channels: 1, typeMax: 1, isFloat: true, blendMode: 'mask', maskCondition: { op: 'gt', threshold: 0.5 } });
		const first = composite([group, base, mask], 2, 1);
		assert.strictEqual(first.coveredCount, 1);
		mask.maskCondition = { op: 'gt', threshold: 0.1 };
		const second = composite([group, base, mask], 2, 1);
		assert.strictEqual(second.coveredCount, 2, 'mask threshold invalidates the isolated group cache');
		console.log('✅ Mixed group/mask caches invalidate on semantic changes');
	}

	console.log('\n🎉 All layer compositor tests passed.\n');
}

main().catch(err => {
	console.error('❌ Layer compositor test failed:');
	console.error(err);
	process.exit(1);
});

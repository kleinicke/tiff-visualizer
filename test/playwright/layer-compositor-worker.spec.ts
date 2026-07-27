import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

test('dedicated layer compositor worker returns full and scaled surfaces', async ({ page }) => {
	const workerSource = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'layerCompositorWorker.bundle.js'), 'utf8');
	const wasmBase64 = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'wasm', 'tiff-wasm.wasm')).toString('base64');
	const results = await page.evaluate(async ({ source, wasmBase64 }) => {
		const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
		const worker = new Worker(url);
		const messages: any[] = [];
		worker.onmessage = event => messages.push(event.data);
		for (let wait = 0; wait < 100 && !messages.some(message => message.type === 'ready'); wait++) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		const binary = atob(wasmBase64);
		const wasm = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) { wasm[index] = binary.charCodeAt(index); }
		worker.postMessage({ type: 'init-wasm', buffer: wasm.buffer }, [wasm.buffer]);
		for (let wait = 0; wait < 200 && !messages.some(message => message.type === 'caps' && message.rustCompositor); wait++) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		const baseLayer = {
			key: 'base', signature: 'base-v1', id: 'base', kind: 'raster',
			dataAssetId: 1, width: 2, height: 2, channels: 4, typeMax: 255,
			offsetX: 0, offsetY: 0, opacity: 1, visible: true, blendMode: 'normal',
		};
		const compose = (id: number, scale: number, assets: any[], layers: any[] = [baseLayer], requestedBackend?: 'wasm' | 'javascript') => new Promise<any>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('worker composition timeout')), 5000);
			const listener = (event: MessageEvent) => {
				if (event.data?.id !== id) { return; }
				worker.removeEventListener('message', listener);
				clearTimeout(timeout);
				resolve(event.data);
			};
			worker.addEventListener('message', listener);
			worker.postMessage({
				type: 'compose', id, width: 2, height: 2, scale, assets,
				layers, requestedBackend,
			});
		});
		const pixels = new Uint8Array([
			255, 0, 0, 255, 0, 255, 0, 255,
			0, 0, 255, 255, 255, 255, 255, 255,
		]);
		const full = await compose(1, 1, [{ id: 1, data: pixels }]);
		const scaled = await compose(2, 0.5, []);
		const mixed = await compose(3, 1, [{ id: 2, data: new Float32Array([0.5, 1, 0.25, 0.5, 1, 1, 0, 0]) }], [
			baseLayer,
			{
				key: 'gray-alpha', signature: 'gray-alpha-v1', id: 'gray-alpha', kind: 'raster',
				dataAssetId: 2, width: 2, height: 2, channels: 2, typeMax: 1, isFloat: true,
				offsetX: 0, offsetY: 0, opacity: 1, visible: true, blendMode: 'normal',
			},
		]);
		const strictJavascript = await compose(4, 1, [], [baseLayer], 'javascript');
		const strictWasmAdjustment = await compose(5, 1, [], [
			baseLayer,
			{
				key: 'levels', signature: 'levels-v1', id: 'levels', name: 'Levels', kind: 'adjustment',
				width: 2, height: 2, channels: 4, typeMax: 255,
				offsetX: 0, offsetY: 0, opacity: 1, visible: true, blendMode: 'normal', clipped: true,
				adjustment: { type: 'levels' },
			},
		], 'wasm');
		const strictWasmEmpty = await compose(7, 1, [], [{ ...baseLayer, signature: 'base-hidden-v1', visible: false }], 'wasm');
		const common = {
			width: 1, height: 1, channels: 4, typeMax: 255,
			offsetX: 0, offsetY: 0, opacity: 1, visible: true, blendMode: 'normal',
		};
		const raster = (key: string, assetId: number, blendMode = 'normal') => ({
			...common, key, signature: `${key}-v1`, id: key, name: key, kind: 'raster',
			dataAssetId: assetId, blendMode,
		});
		const filter = (key: string, adjustment: any) => ({
			...common, key, signature: `${key}-v1`, id: key, name: key,
			kind: 'adjustment', clipped: true, adjustment,
		});
		const levels = (highlightInput: number, shadowInput = 0) => ({
			type: 'levels',
			rgb: { shadowInput, highlightInput, shadowOutput: 0, highlightOutput: 255, midtoneInput: 1 },
		});
		const curves = (points: number[][]) => ({
			type: 'curves', rgb: points.map(([input, output]) => ({ input, output })),
		});
		const colorize = (hue: number) => ({
			type: 'hue/saturation', colorizeEnabled: true,
			colorize: { hue, saturation: 100, lightness: -50 },
		});
		const psdLayers = [
			raster('502nmos', 3),
			filter('Levels 1', levels(62)),
			filter('Curves 1', curves([[0, 0], [59, 63], [179, 196], [255, 255]])),
			filter('Hue 1', colorize(-131)),
			raster('656nmos', 4, 'screen'),
			filter('Levels 2', levels(240)),
			filter('Curves 2', curves([[0, 0], [46, 52], [186, 208], [255, 255]])),
			filter('Hue 2', colorize(103)),
			raster('673nmos', 5, 'screen'),
			filter('Levels 3', levels(148, 7)),
			filter('Curves 3', curves([[0, 0], [41, 73], [158, 217], [255, 255]])),
			filter('Hue 3', colorize(0)),
		];
		const psdStack = await compose(6, 1, [
			{ id: 3, data: new Uint8Array([7, 7, 7, 111]) },
			{ id: 4, data: new Uint8Array([0, 0, 0, 111]) },
			{ id: 5, data: new Uint8Array([17, 17, 17, 111]) },
		], psdLayers, 'wasm');
		// Image visibility does not disable its filter controls in the UI. Hidden
		// image stacks must still own/consume those filters instead of allowing
		// them to attach to the preceding visible blue stack.
		const blueOnlyLayers = psdLayers.map((layer, index) => index === 4 || index === 8
			? { ...layer, signature: `${layer.signature}-hidden`, visible: false }
			: layer);
		const blueOnlyJavascript = await compose(8, 1, [], blueOnlyLayers, 'javascript');
		const blueOnlyWasm = await compose(9, 1, [], blueOnlyLayers, 'wasm');
		const directPixels = new Uint8Array([
			64, 128, 192, 255, 192, 64, 128, 192,
			24, 220, 96, 128, 240, 96, 16, 64,
		]);
		const directAdjustments = [
			{
				type: 'hue/saturation',
				master: { hue: 7, saturation: -4, lightness: 3 },
				reds: { a: -30, b: -10, c: 20, d: 45, hue: 18, saturation: 12, lightness: -5 },
				blues: { hue: -22, saturation: 8, lightness: 6 },
			},
			{ type: 'brightness/contrast', brightness: 12, contrast: -18 },
			{ type: 'exposure', exposure: 0.75, offset: -0.05, gamma: 1.3 },
			{ type: 'invert' },
			{ type: 'channel mixer', red: { red: 80, green: 20 }, green: { green: 70, blue: 30 }, blue: { red: 10, blue: 90 } },
			{ type: 'channel mixer', monochrome: true, gray: { red: 25, green: 60, blue: 15, constant: 3 } },
			{ type: 'color balance', shadows: { cyanRed: -15 }, midtones: { magentaGreen: 20 }, highlights: { yellowBlue: -10 }, preserveLuminosity: true },
			{ type: 'black & white', reds: 35, yellows: 70, greens: 30, cyans: 55, blues: 15, magentas: 90 },
			{ type: 'threshold', level: 100 },
			{ type: 'posterize', levels: 5 },
			{ type: 'gradient map', reverse: true, stops: [
				{ position: 0, color: { r: 10, g: 20, b: 30 } },
				{ position: 0.4, color: { r: 90, g: 160, b: 40 } },
				{ position: 1, color: { r: 250, g: 220, b: 180 } },
			] },
		];
		const directResults: any[] = [];
		for (let index = 0; index < directAdjustments.length; index++) {
			const directBase = { ...baseLayer, key: `direct-base-${index}`, signature: `direct-base-${index}`, dataAssetId: 6 };
			const directFilter = {
				...filter(`direct-filter-${index}`, directAdjustments[index]),
				width: 2, height: 2,
			};
			const assets = index === 0 ? [{ id: 6, data: directPixels }] : [];
			const javascript = await compose(20 + index * 2, 1, assets, [directBase, directFilter], 'javascript');
			const wasmResult = await compose(21 + index * 2, 1, [], [directBase, directFilter], 'wasm');
			directResults.push({
				typescript: Array.from(javascript.result?.data || []),
				wasm: Array.from(wasmResult.result?.data || []),
				backend: wasmResult.backend,
				type: wasmResult.type,
			});
		}
		const groupedPixels = new Uint8Array([
			210, 30, 50, 255, 170, 60, 90, 192,
			80, 20, 40, 128, 130, 40, 60, 255,
		]);
		const groupLayers = [
			{ ...baseLayer, key: 'group-bg', signature: 'group-bg-v1', dataAssetId: 7 },
			{
				key: 'group', signature: 'group-v1', id: 'group', name: 'group', kind: 'group',
				width: 2, height: 2, channels: 4, typeMax: 255, offsetX: 0, offsetY: 0,
				opacity: 0.7, visible: true, blendMode: 'screen',
				rasterMask: { dataAssetId: 9, width: 2, height: 2, channels: 1, typeMax: 255 },
			},
			{
				...baseLayer, key: 'group-child', signature: 'group-child-v1', id: 'group-child',
				parentId: 'group', dataAssetId: 8, offsetX: 0, offsetY: 0,
			},
			{
				...filter('group-exposure', { type: 'exposure', exposure: 0.5, gamma: 1.2 }),
				parentId: 'group',
			},
			{
				...baseLayer, key: 'group-clipped', signature: 'group-clipped-v1', id: 'group-clipped',
				parentId: 'group', dataAssetId: 11, clipped: true, opacity: 0.6, blendMode: 'screen',
				rasterMask: { dataAssetId: 12, width: 2, height: 2, channels: 1, typeMax: 255 },
			},
			{
				...filter('global-invert', { type: 'invert' }),
				clipped: false, opacity: 0.2,
				rasterMask: { dataAssetId: 10, width: 2, height: 2, channels: 1, typeMax: 255, invert: true },
			},
		];
		const groupedJavascript = await compose(100, 1, [
			{ id: 7, data: pixels }, { id: 8, data: groupedPixels },
			{ id: 9, data: new Uint8Array([255, 128, 64, 192]) },
			{ id: 10, data: new Uint8Array([0, 64, 192, 255]) },
			{ id: 11, data: new Uint8Array([
				20, 80, 230, 180, 40, 120, 200, 255,
				90, 30, 180, 128, 10, 160, 220, 192,
			]) },
			{ id: 12, data: new Uint8Array([255, 96, 192, 32]) },
		], groupLayers, 'javascript');
		const groupedWasm = await compose(101, 1, [], groupLayers, 'wasm');
		const numericCases = [
			{ name: 'u8-gray', data: new Uint8Array([0, 40, 120, 255]), channels: 1, typeMax: 255 },
			{ name: 'u16-gray-alpha', data: new Uint16Array([1000, 65535, 30000, 32768, 50000, 16384, 65535, 0]), channels: 2, typeMax: 65535 },
			{ name: 'u32-rgb', data: new Uint32Array([1, 20, 90, 25, 50, 75, 100, 80, 60, 10, 30, 70]), channels: 3, typeMax: 100 },
			{ name: 'i8-gray', data: new Int8Array([-20, 0, 40, 100]), channels: 1, typeMax: 100 },
			{ name: 'i16-rgb', data: new Int16Array([-100, 0, 100, 50, 25, -25, 100, 80, 60, 0, 20, 40]), channels: 3, typeMax: 100 },
			{ name: 'i32-gray', data: new Int32Array([-1000, 0, 500, 1000]), channels: 1, typeMax: 1000 },
			{ name: 'f32-rgb', data: new Float32Array([0.1, 0.2, 0.3, 0.8, 0.4, 0.2, 0.5, 0.7, 0.9, 0.25, 0.5, 0.75]), channels: 3, typeMax: 1 },
			{ name: 'f64-gray', data: new Float64Array([-0.5, 0, 0.25, 1]), channels: 1, typeMax: 1 },
		];
		const numericResults: any[] = [];
		for (let index = 0; index < numericCases.length; index++) {
			const value = numericCases[index], assetId = 20 + index;
			const layer = {
				key: value.name, signature: `${value.name}-v1`, id: value.name, name: value.name, kind: 'raster',
				dataAssetId: assetId, width: 2, height: 2, channels: value.channels, typeMax: value.typeMax,
				isFloat: value.data instanceof Float32Array || value.data instanceof Float64Array,
				offsetX: 0, offsetY: 0, opacity: 1, visible: true, blendMode: 'normal',
			};
			const javascript = await compose(110 + index * 2, 1, [{ id: assetId, data: value.data }], [layer], 'javascript');
			const wasmResult = await compose(111 + index * 2, 1, [], [layer], 'wasm');
			numericResults.push({
				name: value.name, backend: wasmResult.backend, type: wasmResult.type,
				channels: wasmResult.result?.channels,
				typescript: Array.from(javascript.result?.data || []),
				wasm: Array.from(wasmResult.result?.data || []),
			});
		}
		const scientificBase = {
			key: 'scientific-base', signature: 'scientific-base-v1', id: 'scientific-base', kind: 'raster',
			dataAssetId: 40, width: 2, height: 2, channels: 1, typeMax: 100, isFloat: true,
			offsetX: 0, offsetY: 0, opacity: 1, visible: true, blendMode: 'normal',
		};
		const scientificResults: any[] = [];
		const scientificAssets = [
			{ id: 40, data: new Float32Array([10, 20, 30, 40]) },
			{ id: 41, data: new Float32Array([2, 0, 12, 50]) },
			{ id: 42, data: new Float32Array([10, 20, 30, Number.NaN]) },
			{ id: 43, data: new Uint8Array([255, 128, 0, 192]) },
		];
		let scientificRequest = 150;
		for (const mode of ['add', 'subtract', 'raw-difference', 'raw-multiply', 'divide', 'min', 'max', 'average']) {
			const layers = [
				scientificBase,
				{
					...scientificBase, key: `science-${mode}`, signature: `science-${mode}-v1`, id: `science-${mode}`,
					dataAssetId: 41, opacity: 0.65, blendMode: mode,
					rasterMask: { dataAssetId: 43, width: 2, height: 2, channels: 1, typeMax: 255 },
				},
			];
			const javascript = await compose(scientificRequest++, 1, scientificRequest === 151 ? scientificAssets : [], layers, 'javascript');
			const wasmResult = await compose(scientificRequest++, 1, [], layers, 'wasm');
			scientificResults.push({ mode, backend: wasmResult.backend, type: wasmResult.type, typescript: Array.from(javascript.result?.data || []), wasm: Array.from(wasmResult.result?.data || []) });
		}
		for (const [condition, threshold] of [['gt', 15], ['le', 20], ['eq', 30], ['isfinite', 0], ['isnan', 0]] as const) {
			const layers = [
				scientificBase,
				{
					...scientificBase, key: `science-mask-${condition}`, signature: `science-mask-${condition}-v1`,
					id: `science-mask-${condition}`, dataAssetId: 42, blendMode: 'mask',
					maskCondition: { op: condition, threshold },
				},
			];
			const javascript = await compose(scientificRequest++, 1, [], layers, 'javascript');
			const wasmResult = await compose(scientificRequest++, 1, [], layers, 'wasm');
			scientificResults.push({ mode: `mask-${condition}`, backend: wasmResult.backend, type: wasmResult.type, typescript: Array.from(javascript.result?.data || []), wasm: Array.from(wasmResult.result?.data || []) });
		}
		worker.terminate();
		URL.revokeObjectURL(url);
		return {
			full: { type: full.type, backend: full.backend, width: full.result.width, height: full.result.height, data: Array.from(full.result.data) },
			scaled: { type: scaled.type, width: scaled.result.width, height: scaled.result.height, data: Array.from(scaled.result.data) },
			mixed: { type: mixed.type, backend: mixed.backend, typeMax: mixed.result.typeMax, channels: mixed.result.channels, data: Array.from(mixed.result.data) },
			strictJavascript: { type: strictJavascript.type, backend: strictJavascript.backend },
			strictWasmAdjustment: {
				type: strictWasmAdjustment.type,
				backend: strictWasmAdjustment.backend,
				data: strictWasmAdjustment.result ? Array.from(strictWasmAdjustment.result.data) : [],
			},
			strictWasmEmpty: {
				type: strictWasmEmpty.type,
				backend: strictWasmEmpty.backend,
				coveredCount: strictWasmEmpty.result?.coveredCount,
				data: strictWasmEmpty.result ? Array.from(strictWasmEmpty.result.data) : [],
			},
			psdStack: {
				type: psdStack.type,
				backend: psdStack.backend,
				data: psdStack.result ? Array.from(psdStack.result.data) : [],
			},
			blueOnly: {
				typescript: Array.from(blueOnlyJavascript.result?.data || []),
				wasm: Array.from(blueOnlyWasm.result?.data || []),
				backend: blueOnlyWasm.backend,
			},
			directResults,
			grouped: {
				typescript: Array.from(groupedJavascript.result?.data || []),
				wasm: Array.from(groupedWasm.result?.data || []),
				backend: groupedWasm.backend, type: groupedWasm.type,
			},
			numericResults,
			scientificResults,
		};
	}, { source: workerSource, wasmBase64 });

	expect(results.full.type).toBe('composite-result');
	expect(results.full.backend).toBe('rust-wasm');
	expect([results.full.width, results.full.height]).toEqual([2, 2]);
	expect(results.full.data.slice(0, 4)).toEqual([255, 0, 0, 255]);
	expect(results.scaled.type).toBe('composite-result');
	expect([results.scaled.width, results.scaled.height]).toEqual([1, 1]);
	expect(results.scaled.data).toHaveLength(4);
	expect([results.mixed.channels, results.mixed.typeMax]).toEqual([4, 255]);
	expect(results.mixed.backend).toBe('rust-wasm');
	expect(results.mixed.data[3]).toBe(255);
	expect(results.mixed.data[7]).toBe(255);
	expect(results.strictJavascript).toEqual({ type: 'composite-result', backend: 'typescript' });
	expect(results.strictWasmAdjustment.type).toBe('composite-result');
	expect(results.strictWasmAdjustment.backend).toBe('rust-wasm');
	expect(results.strictWasmAdjustment.data.slice(0, 4)).toEqual([255, 0, 0, 255]);
	expect(results.strictWasmEmpty.type).toBe('composite-result');
	expect(results.strictWasmEmpty.backend).toBe('rust-wasm');
	expect(results.strictWasmEmpty.coveredCount).toBe(0);
	expect(results.strictWasmEmpty.data.every((value: number) => Number.isNaN(value))).toBe(true);
	expect(results.psdStack.type).toBe('composite-result');
	expect(results.psdStack.backend).toBe('rust-wasm');
	const psdExpected = [17.745607, 2.977995, 16.243607, 209.079453];
	for (let channel = 0; channel < 4; channel++) {
		expect(Math.abs(results.psdStack.data[channel] - psdExpected[channel])).toBeLessThan(0.02);
	}
	expect(results.blueOnly.backend).toBe('rust-wasm');
	expect(results.blueOnly.wasm).toHaveLength(results.blueOnly.typescript.length);
	for (let channel = 0; channel < results.blueOnly.wasm.length; channel++) {
		expect(Math.abs(results.blueOnly.wasm[channel] - results.blueOnly.typescript[channel])).toBeLessThan(0.02);
	}
	expect(results.blueOnly.wasm[2]).toBeGreaterThan(results.blueOnly.wasm[0]);
	for (const result of results.directResults) {
		expect(result.type).toBe('composite-result');
		expect(result.backend).toBe('rust-wasm');
		expect(result.wasm).toHaveLength(result.typescript.length);
		for (let value = 0; value < result.wasm.length; value++) {
			expect(Math.abs(result.wasm[value] - result.typescript[value])).toBeLessThan(0.025);
		}
	}
	expect(results.grouped.type).toBe('composite-result');
	expect(results.grouped.backend).toBe('rust-wasm');
	expect(results.grouped.wasm).toHaveLength(results.grouped.typescript.length);
	for (let value = 0; value < results.grouped.wasm.length; value++) {
		expect(Math.abs(results.grouped.wasm[value] - results.grouped.typescript[value])).toBeLessThan(0.03);
	}
	for (const result of results.numericResults) {
		expect(result.type, result.name).toBe('composite-result');
		expect(result.backend, result.name).toBe('rust-wasm');
		expect(result.wasm, result.name).toHaveLength(result.typescript.length);
		for (let value = 0; value < result.wasm.length; value++) {
			const left = result.wasm[value], right = result.typescript[value];
			expect((Number.isNaN(left) && Number.isNaN(right)) || Math.abs(left - right) < 0.03, `${result.name} value ${value}: ${left} != ${right}`).toBe(true);
		}
	}
	for (const result of results.scientificResults) {
		expect(result.type, result.mode).toBe('composite-result');
		expect(result.backend, result.mode).toBe('rust-wasm');
		expect(result.wasm, result.mode).toHaveLength(result.typescript.length);
		for (let value = 0; value < result.wasm.length; value++) {
			const left = result.wasm[value], right = result.typescript[value];
			expect((Number.isNaN(left) && Number.isNaN(right)) || Math.abs(left - right) < 0.03, `${result.mode} value ${value}: ${left} != ${right}`).toBe(true);
		}
	}
});

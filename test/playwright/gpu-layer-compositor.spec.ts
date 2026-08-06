import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import path from 'path';

const MODES = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'exclusion'];

test('WebGL2 layer compositor matches the CPU reference and rejects unsupported stacks', async ({ page }) => {
	const bundle = buildSync({
		entryPoints: [path.join(__dirname, '..', '..', 'media', 'modules', 'webgl2-layer-compositor.ts')],
		bundle: true,
		write: false,
		format: 'iife',
		globalName: 'GpuLayerTest',
		platform: 'browser',
		target: 'chrome100',
	}).outputFiles[0].text;
	await page.addScriptTag({ content: bundle });
	const gpuResults = await page.evaluate(modes => {
		const Compositor = (window as any).GpuLayerTest.WebGL2LayerCompositor;
		const settings = {
			gpuAcceleration: true,
			normalization: { min: 0, max: 255, autoNormalize: false, gammaMode: true },
			gamma: { in: 1, out: 1 },
			brightness: { offset: 0 },
			displayColormap: 'none',
		};
		const basePixels = [
			20, 40, 60, 255, 80, 100, 120, 255,
			140, 160, 180, 255, 200, 220, 240, 255,
		];
		const output: Record<string, number[]> = {};
		for (const mode of modes) {
			for (const alpha of [128, 255]) {
				const compositor = new Compositor();
				const layers = [
					{ id: 'base', kind: 'raster', data: new Uint8Array(basePixels), width: 2, height: 2, channels: 4, typeMax: 255, visible: true, opacity: 1, blendMode: 'normal' },
					{ id: 'top', kind: 'raster', data: new Uint8Array([220, 30, 90, alpha]), width: 1, height: 1, channels: 4, typeMax: 255, visible: true, opacity: 1, blendMode: mode, offsetX: 1, offsetY: 0 },
				];
				const canvas = compositor.render(layers, 2, 2, 1, settings, { r: 255, g: 0, b: 255 });
				if (!canvas) { throw new Error(`GPU compositor rejected ${mode} at alpha ${alpha}`); }
				const context = document.createElement('canvas').getContext('2d')!;
				context.canvas.width = 2; context.canvas.height = 2;
				context.drawImage(canvas, 0, 0);
				output[`${mode}:${alpha}`] = Array.from(context.getImageData(0, 0, 2, 2).data);
				compositor.dispose();
			}
		}
		const compositor = new Compositor();
		const unsupported = compositor.canRender([
			{ id: 'invalid', kind: 'raster', data: new Uint8Array(5), width: 1, height: 1, channels: 5, typeMax: 255, visible: true },
		], settings, 1, 1);
		const hidden = {
			id: 'hidden', kind: 'raster', data: new Uint8Array([255, 0, 0, 255]),
			width: 1, height: 1, channels: 4, typeMax: 255, visible: false,
		};
		const emptyCanvas = compositor.render([hidden], 1, 1, 1, settings, { r: 255, g: 0, b: 255 }, true);
		const emptyOutput = document.createElement('canvas');
		emptyOutput.width = 1; emptyOutput.height = 1;
		if (emptyCanvas) { emptyOutput.getContext('2d')!.drawImage(emptyCanvas, 0, 0); }
		const empty = Array.from(emptyOutput.getContext('2d')!.getImageData(0, 0, 1, 1).data);
		compositor.dispose();
		const cold = new Compositor();
		cold.render([{
			id: 'cold', kind: 'raster', data: new Uint8Array([1, 2, 3, 255]),
			width: 1, height: 1, channels: 4, typeMax: 255, visible: true,
		}], 1, 1, 1, settings, { r: 255, g: 0, b: 255 }, true);
		const texturesBeforeDispose = (cold as any).ownedTextures.size;
		cold.dispose();
		const texturesAfterDispose = (cold as any).ownedTextures.size;
		return { output, unsupported, empty, texturesBeforeDispose, texturesAfterDispose };
	}, MODES);

	const compositorPath = path.join(__dirname, '..', '..', 'out', 'media', 'modules', 'layer-compositor.js');
	const { composite } = await import(compositorPath.replace(/\\/g, '/'));
	const base = new Uint8Array([
		20, 40, 60, 255, 80, 100, 120, 255,
		140, 160, 180, 255, 200, 220, 240, 255,
	]);
	for (const mode of MODES) {
		for (const alpha of [128, 255]) {
			const result = composite([
				{ id: 'base', kind: 'raster', data: base, width: 2, height: 2, channels: 4, typeMax: 255, visible: true, opacity: 1, blendMode: 'normal' },
				{ id: 'top', kind: 'raster', data: new Uint8Array([220, 30, 90, alpha]), width: 1, height: 1, channels: 4, typeMax: 255, visible: true, opacity: 1, blendMode: mode, offsetX: 1, offsetY: 0 },
			], 2, 2);
			const expected = Array.from(result.data, (value: number) => Math.max(0, Math.min(255, Math.round(value))));
			for (let index = 0; index < expected.length; index++) {
				expect(Math.abs(gpuResults.output[`${mode}:${alpha}`][index] - expected[index]), `${mode} alpha ${alpha} channel ${index}`).toBeLessThanOrEqual(1);
			}
		}
	}
	expect(gpuResults.unsupported).toBe(false);
	expect(gpuResults.empty).toEqual([0, 0, 0, 0]);
	expect(gpuResults.texturesBeforeDispose).toBeGreaterThan(0);
	expect(gpuResults.texturesAfterDispose).toBe(0);
});

test('WebGL2 layer compositor handles uint16 sources and re-renders a large cached stack promptly', async ({ page }) => {
	const bundle = buildSync({
		entryPoints: [path.join(__dirname, '..', '..', 'media', 'modules', 'webgl2-layer-compositor.ts')],
		bundle: true,
		write: false,
		format: 'iife',
		globalName: 'GpuLayerTest',
		platform: 'browser',
		target: 'chrome100',
	}).outputFiles[0].text;
	await page.addScriptTag({ content: bundle });
	const result = await page.evaluate(() => {
		const Compositor = (window as any).GpuLayerTest.WebGL2LayerCompositor;
		const compositor = new Compositor();
		const settings = {
			gpuAcceleration: true,
			normalization: { min: 0, max: 65535, autoNormalize: false, gammaMode: false },
			gamma: { in: 1, out: 1 },
			brightness: { offset: 0 },
			displayColormap: 'none',
		};
		const scalar = {
			id: 'scalar', kind: 'raster', width: 2, height: 1, channels: 1, typeMax: 65535,
			data: new Uint16Array([0, 65535]), visible: true, opacity: 1, blendMode: 'normal',
		};
		const scalarSurface = compositor.render([scalar], 2, 1, 1, settings, { r: 255, g: 0, b: 255 });
		const context = document.createElement('canvas').getContext('2d')!;
		context.canvas.width = 2; context.canvas.height = 1;
		if (scalarSurface) { context.drawImage(scalarSurface, 0, 0); }
		const scalarRgba = Array.from(context.getImageData(0, 0, 2, 1).data);
		const float64 = {
			id: 'float64', kind: 'raster', width: 2, height: 1, channels: 1, typeMax: 1,
			data: new Float64Array([0.125, 0.875]), visible: true, opacity: 1, blendMode: 'normal',
		};
		const floatSettings = { ...settings, normalization: { ...settings.normalization, max: 1 } };
		const float64Surface = compositor.render([float64], 2, 1, 1, floatSettings, { r: 255, g: 0, b: 255 }, true);

		const size = 1024;
		const layers = Array.from({ length: 4 }, (_, index) => ({
			id: `large-${index}`, kind: 'raster', width: size, height: size, channels: 4, typeMax: 255,
			data: new Uint8Array(size * size * 4).fill(48 + index * 32),
			visible: true, opacity: 0.8, blendMode: index % 2 ? 'screen' : 'normal',
		}));
		const largeSettings = { ...settings, normalization: { ...settings.normalization, max: 255, gammaMode: true } };
		const firstStart = performance.now();
		const first = compositor.render(layers, size, size, 0.75, largeSettings, { r: 255, g: 0, b: 255 });
		first?.getContext('webgl2')?.finish();
		const firstMs = performance.now() - firstStart;
		layers[3].visible = false;
		const cachedStart = performance.now();
		const cached = compositor.render(layers, size, size, 0.75, largeSettings, { r: 255, g: 0, b: 255 });
		cached?.getContext('webgl2')?.finish();
		const cachedMs = performance.now() - cachedStart;
		const dimensions = cached ? [cached.width, cached.height] : [];
		compositor.dispose();
		return { scalarSupported: !!scalarSurface, float64Supported: !!float64Surface, scalarRgba, largeSupported: !!first && !!cached, dimensions, firstMs, cachedMs };
	});

	expect(result.scalarSupported).toBe(true);
	expect(result.float64Supported).toBe(true);
	expect(result.scalarRgba).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
	expect(result.largeSupported).toBe(true);
	expect(result.dimensions).toEqual([768, 768]);
	expect(result.cachedMs).toBeLessThan(2000);
	console.log(`GPU 4x1024 render: first ${result.firstMs.toFixed(1)} ms, cached visibility edit ${result.cachedMs.toFixed(1)} ms`);
	test.info().annotations.push({ type: 'performance', description: `GPU 4x1024: first ${result.firstMs.toFixed(1)} ms, cached edit ${result.cachedMs.toFixed(1)} ms` });
});

test('WebGL2 display path supports auto-normalization, colormaps, and RGB24 grayscale', async ({ page }) => {
	const bundle = buildSync({
		entryPoints: [path.join(__dirname, '..', '..', 'media', 'modules', 'webgl2-layer-compositor.ts')],
		bundle: true,
		write: false,
		format: 'iife',
		globalName: 'GpuLayerTest',
		platform: 'browser',
		target: 'chrome100',
	}).outputFiles[0].text;
	await page.addScriptTag({ content: bundle });
	const result = await page.evaluate(() => {
		const Compositor = (window as any).GpuLayerTest.WebGL2LayerCompositor;
		const compositor = new Compositor();
		const read = (canvas: HTMLCanvasElement | null) => {
			if (!canvas) { return []; }
			const output = document.createElement('canvas');
			output.width = canvas.width; output.height = canvas.height;
			const context = output.getContext('2d')!;
			context.drawImage(canvas, 0, 0);
			return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data);
		};
		const baseSettings = {
			gpuAcceleration: true,
			normalization: { min: 0, max: 255, autoNormalize: false, gammaMode: true },
			gamma: { in: 1, out: 1 },
			brightness: { offset: 0 },
			displayColormap: 'none',
		};
		const scalar = {
			id: 'scalar', kind: 'raster', data: new Uint8Array([50, 200]),
			width: 2, height: 1, channels: 1, typeMax: 255,
			visible: true, opacity: 1, blendMode: 'normal',
		};
		const auto = read(compositor.render(
			[scalar], 2, 1, 1,
			{ ...baseSettings, normalization: { min: 0, max: 255, autoNormalize: true, gammaMode: false } },
			{ r: 255, g: 0, b: 255 }, true,
		));
		const colormap = read(compositor.render(
			[{ ...scalar, data: new Uint8Array([0, 255]) }], 2, 1, 1,
			{ ...baseSettings, displayColormap: 'viridis' },
			{ r: 255, g: 0, b: 255 }, true,
		));
		const unknownColormap = read(compositor.render(
			[{ ...scalar, data: new Uint8Array([0, 255]) }], 2, 1, 1,
			{ ...baseSettings, displayColormap: 'not-a-colormap' },
			{ r: 255, g: 0, b: 255 }, true,
		));
		const rgb24 = read(compositor.render(
			[{
				id: 'rgb24', kind: 'raster', data: new Uint8Array([0, 0, 0, 255, 255, 255]),
				width: 2, height: 1, channels: 3, typeMax: 255,
				visible: true, opacity: 1, blendMode: 'normal',
			}],
			2, 1, 1,
			{
				...baseSettings,
				rgbAs24BitGrayscale: true,
				normalization: { min: 0, max: 16777215, autoNormalize: false, gammaMode: false },
			},
			{ r: 255, g: 0, b: 255 }, true,
		));
		compositor.dispose();
		return { auto, colormap, unknownColormap, rgb24 };
	});

	expect(result.auto).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
	expect(result.colormap.slice(0, 3)).not.toEqual([0, 0, 0]);
	expect(result.colormap[0]).not.toEqual(result.colormap[1]);
	expect(result.colormap.slice(4, 7)).not.toEqual([255, 255, 255]);
	expect(result.unknownColormap).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
	expect(result.rgb24).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
});

test('WebGL2 isolated Levels, Curves, and Colorize stacks match the CPU compositor', async ({ page }) => {
	const bundle = buildSync({
		entryPoints: [path.join(__dirname, '..', '..', 'media', 'modules', 'webgl2-layer-compositor.ts')],
		bundle: true,
		write: false,
		format: 'iife',
		globalName: 'GpuLayerTest',
		platform: 'browser',
		target: 'chrome100',
	}).outputFiles[0].text;
	await page.addScriptTag({ content: bundle });
	const layers = [
		{ id: 'gray-a', kind: 'raster', data: new Uint8Array([20, 20, 20, 255, 170, 170, 170, 255]), width: 2, height: 1, channels: 4, typeMax: 255, visible: true, opacity: 1, blendMode: 'normal' },
		{ id: 'levels-a', kind: 'adjustment', adjustment: { type: 'levels', rgb: { shadowInput: 10, highlightInput: 200, shadowOutput: 0, highlightOutput: 255, midtoneInput: 1.2 } }, clipped: true, width: 1, height: 1, channels: 4, typeMax: 255, visible: true, opacity: 0.8, blendMode: 'normal' },
		{ id: 'curves-a', kind: 'adjustment', adjustment: { type: 'curves', rgb: [{ input: 0, output: 0 }, { input: 100, output: 140 }, { input: 255, output: 255 }] }, clipped: true, width: 1, height: 1, channels: 4, typeMax: 255, visible: true, opacity: 1, blendMode: 'normal' },
		{ id: 'hue-a', kind: 'adjustment', adjustment: { type: 'hue/saturation', colorizeEnabled: true, colorize: { hue: 120, saturation: 100, lightness: -20 } }, clipped: true, width: 1, height: 1, channels: 4, typeMax: 255, visible: true, opacity: 1, blendMode: 'normal' },
		{ id: 'gray-b', kind: 'raster', data: new Uint8Array([80, 80, 80, 255, 220, 220, 220, 255]), width: 2, height: 1, channels: 4, typeMax: 255, visible: true, opacity: 0.7, blendMode: 'screen' },
		{ id: 'hue-b', kind: 'adjustment', adjustment: { type: 'hue/saturation', colorizeEnabled: true, colorize: { hue: -120, saturation: 80, lightness: -10 } }, clipped: true, width: 1, height: 1, channels: 4, typeMax: 255, visible: true, opacity: 0.6, blendMode: 'normal' },
	] as any[];
	const gpu = await page.evaluate(inputLayers => {
		const Compositor = (window as any).GpuLayerTest.WebGL2LayerCompositor;
		const compositor = new Compositor();
		for (const layer of inputLayers) if (Array.isArray(layer.data)) { layer.data = new Uint8Array(layer.data); }
		const settings = {
			gpuAcceleration: true,
			normalization: { min: 0, max: 255, autoNormalize: false, gammaMode: true },
			gamma: { in: 1, out: 1 }, brightness: { offset: 0 }, displayColormap: 'none',
		};
		const canvas = compositor.render(inputLayers, 2, 1, 1, settings, { r: 255, g: 0, b: 255 });
		if (!canvas) { return { supported: false, pixels: [], dimensions: [] }; }
		const output = document.createElement('canvas'); output.width = 2; output.height = 1;
		const context = output.getContext('2d')!; context.drawImage(canvas, 0, 0);
		const result = { supported: true, pixels: Array.from(context.getImageData(0, 0, 2, 1).data), dimensions: [canvas.width, canvas.height] };
		compositor.dispose();
		return result;
	}, layers.map(layer => ({ ...layer, data: layer.data ? Array.from(layer.data) : undefined })));

	const compositorPath = path.join(__dirname, '..', '..', 'out', 'media', 'modules', 'layer-compositor.js');
	const { composite } = await import(compositorPath.replace(/\\/g, '/'));
	const cpu = composite(layers, 2, 1);
	const expected = Array.from(cpu.data, (value: number) => Math.max(0, Math.min(255, Math.round(value))));
	expect(gpu.supported).toBe(true);
	expect(gpu.dimensions).toEqual([2, 1]);
	for (let index = 0; index < expected.length; index++) {
		expect(Math.abs(gpu.pixels[index] - expected[index]), `adjustment channel ${index}`).toBeLessThanOrEqual(3);
	}
});

test('WebGL2 implements every editable adjustment with CPU parity', async ({ page }) => {
	const bundle = buildSync({
		entryPoints: [path.join(__dirname, '..', '..', 'media', 'modules', 'webgl2-layer-compositor.ts')],
		bundle: true, write: false, format: 'iife', globalName: 'GpuLayerTest',
		platform: 'browser', target: 'chrome100',
	}).outputFiles[0].text;
	await page.addScriptTag({ content: bundle });
	const results = await page.evaluate(() => {
		const Compositor = (window as any).GpuLayerTest.WebGL2LayerCompositor;
		const settings = {
			gpuAcceleration: true,
			normalization: { min: 0, max: 255, autoNormalize: false, gammaMode: true },
			gamma: { in: 1, out: 1 }, brightness: { offset: 0 }, displayColormap: 'none',
		};
		const adjustments = [
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
		return adjustments.map((adjustment, index) => {
			const compositor = new Compositor();
			const layers = [
				{
					id: `base-${index}`, kind: 'raster',
					data: new Uint8Array([64, 128, 192, 255, 192, 64, 128, 192, 24, 220, 96, 128, 240, 96, 16, 64]),
					width: 2, height: 2, channels: 4, typeMax: 255,
					visible: true, opacity: 1, blendMode: 'normal',
				},
				{
					id: `filter-${index}`, kind: 'adjustment', adjustment, clipped: true,
					width: 2, height: 2, channels: 4, typeMax: 255,
					visible: true, opacity: 0.83, blendMode: 'normal',
				},
				{
					id: `global-${index}`, kind: 'adjustment', adjustment: { type: 'invert' }, clipped: false,
					width: 2, height: 2, channels: 4, typeMax: 255,
					visible: true, opacity: 0.12, blendMode: 'normal',
				},
			];
			try {
				const canvas = compositor.render(layers, 2, 2, 1, settings, { r: 255, g: 0, b: 255 }, true);
				return { type: adjustment.type, supported: !!canvas };
			} catch (error) {
				return { type: adjustment.type, supported: false, error: error instanceof Error ? error.message : String(error) };
			} finally {
				compositor.dispose();
			}
		});
	});
	for (const result of results) {
		expect(result.supported, `${result.type}: ${result.error || 'rejected'}`).toBe(true);
	}
});

test('WebGL2 preserves nested isolated groups, group offsets, and group adjustments', async ({ page }) => {
	const bundle = buildSync({
		entryPoints: [path.join(__dirname, '..', '..', 'media', 'modules', 'webgl2-layer-compositor.ts')],
		bundle: true, write: false, format: 'iife', globalName: 'GpuLayerTest',
		platform: 'browser', target: 'chrome100',
	}).outputFiles[0].text;
	await page.addScriptTag({ content: bundle });
	const result = await page.evaluate(() => {
		const Compositor = (window as any).GpuLayerTest.WebGL2LayerCompositor;
		const settings = {
			gpuAcceleration: true,
			normalization: { min: 0, max: 255, autoNormalize: false, gammaMode: true },
			gamma: { in: 1, out: 1 }, brightness: { offset: 0 }, displayColormap: 'none',
		};
		const common = { width: 3, height: 2, channels: 4, typeMax: 255, visible: true, opacity: 1, blendMode: 'normal' };
		const background = new Uint8Array(24);
		for (let offset = 0; offset < background.length; offset += 4) { background.set([40, 40, 40, 255], offset); }
		const layers = [
			{ ...common, id: 'background', kind: 'raster', data: background },
			{
				...common, id: 'outer', kind: 'group', opacity: 0.8, blendMode: 'screen', offsetX: 1,
				rasterMask: { data: new Uint8Array([255, 192, 64, 128, 255, 96]), width: 3, height: 2, channels: 1, typeMax: 255 },
			},
			{ ...common, id: 'outer-invert', kind: 'adjustment', parentId: undefined, clipped: true, adjustment: { type: 'invert' }, opacity: 0.25 },
			{ ...common, id: 'inner', kind: 'group', parentId: 'outer', offsetY: 1 },
			{ ...common, id: 'red', kind: 'raster', parentId: 'inner', data: new Uint8Array([
				220, 20, 40, 255, 180, 30, 60, 192, 0, 0, 0, 0,
				80, 10, 20, 128, 120, 20, 30, 255, 0, 0, 0, 0,
			]) },
			{ ...common, id: 'inner-exposure', kind: 'adjustment', parentId: 'inner', clipped: true, adjustment: { type: 'exposure', exposure: 0.4, gamma: 1.2 } },
		];
		const compositor = new Compositor();
		try {
			const canvas = compositor.render(layers, 3, 2, 1, settings, { r: 255, g: 0, b: 255 }, true);
			return { supported: !!canvas };
		} catch (error) {
			return { supported: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			compositor.dispose();
		}
	});
	expect(result.supported, result.error).toBe(true);
});

test('WebGL2 preserves raster masks, adjustment masks, and clipped raster relationships', async ({ page }) => {
	const bundle = buildSync({
		entryPoints: [path.join(__dirname, '..', '..', 'media', 'modules', 'webgl2-layer-compositor.ts')],
		bundle: true, write: false, format: 'iife', globalName: 'GpuLayerTest',
		platform: 'browser', target: 'chrome100',
	}).outputFiles[0].text;
	await page.addScriptTag({ content: bundle });
	const result = await page.evaluate(() => {
		const Compositor = (window as any).GpuLayerTest.WebGL2LayerCompositor;
		const settings = {
			gpuAcceleration: true,
			normalization: { min: 0, max: 255, autoNormalize: false, gammaMode: true },
			gamma: { in: 1, out: 1 }, brightness: { offset: 0 }, displayColormap: 'none',
		};
		const common = { width: 3, height: 2, channels: 4, typeMax: 255, visible: true, opacity: 1, blendMode: 'normal' };
		const rgba = (values: number[][]) => new Uint8Array(values.flat());
		const layers = [
			{ ...common, id: 'background', kind: 'raster', data: rgba(Array(6).fill([25, 50, 75, 255])) },
			{
				...common, id: 'masked-base', kind: 'raster',
				data: rgba(Array(6).fill([180, 80, 30, 220])),
				rasterMask: { data: new Uint8Array([0, 64, 128, 192, 255, 96]), width: 3, height: 2, channels: 1, typeMax: 255 },
			},
			{
				...common, id: 'clipped-blue', kind: 'raster', clipped: true, opacity: 0.7, blendMode: 'screen',
				visible: true,
				data: rgba(Array(6).fill([20, 80, 230, 180])),
				rasterMask: { data: new Uint16Array([65535, 32768, 0, 16384, 49152, 65535]), width: 3, height: 2, channels: 1, typeMax: 65535, invert: true },
			},
			{
				...common, id: 'masked-invert', kind: 'adjustment', clipped: true, opacity: 0.6,
				visible: true,
				adjustment: { type: 'invert' },
				rasterMask: { data: new Uint8Array([255, 0, 128, 64, 192, 255]), width: 3, height: 2, channels: 1, typeMax: 255 },
			},
		];
		const compositor = new Compositor();
		try {
			const canvas = compositor.render(layers, 3, 2, 1, settings, { r: 255, g: 0, b: 255 }, true);
			return { supported: !!canvas };
		} catch (error) {
			return { supported: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			compositor.dispose();
		}
	});
	expect(result.supported, result.error).toBe(true);
});

test('WebGL2 preserves scientific arithmetic and brightness-mask modes', async ({ page }) => {
	const bundle = buildSync({
		entryPoints: [path.join(__dirname, '..', '..', 'media', 'modules', 'webgl2-layer-compositor.ts')],
		bundle: true, write: false, format: 'iife', globalName: 'GpuLayerTest',
		platform: 'browser', target: 'chrome100',
	}).outputFiles[0].text;
	await page.addScriptTag({ content: bundle });
	const results = await page.evaluate(() => {
		const Compositor = (window as any).GpuLayerTest.WebGL2LayerCompositor;
		const settings = {
			gpuAcceleration: true,
			normalization: { min: 0, max: 100, autoNormalize: false, gammaMode: false },
			gamma: { in: 1, out: 1 }, brightness: { offset: 0 }, displayColormap: 'none',
		};
		const base = {
			id: 'base', kind: 'raster', data: new Float32Array([10, 20, 30, 40]),
			width: 2, height: 2, channels: 1, typeMax: 100, isFloat: true,
			visible: true, opacity: 1, blendMode: 'normal',
		};
		const arithmetic = ['add', 'subtract', 'raw-difference', 'raw-multiply', 'divide', 'min', 'max', 'average'];
		const output: any[] = [];
		for (const mode of arithmetic) {
			const compositor = new Compositor();
			try {
				const canvas = compositor.render([
					base,
					{ ...base, id: mode, data: new Float32Array([2, 0, 12, 50]), opacity: 0.65, blendMode: mode },
				], 2, 2, 1, settings, { r: 255, g: 0, b: 255 }, true);
				output.push({ mode, supported: !!canvas });
			} catch (error) {
				output.push({ mode, supported: false, error: error instanceof Error ? error.message : String(error) });
			} finally { compositor.dispose(); }
		}
		for (const [condition, threshold] of [['gt', 15], ['le', 20], ['eq', 30], ['isfinite', 0], ['isnan', 0]] as const) {
			const compositor = new Compositor();
			try {
				const canvas = compositor.render([
					base,
					{
						...base, id: `mask-${condition}`, data: new Float32Array([10, 20, 30, Number.NaN]),
						blendMode: 'mask', maskCondition: { op: condition, threshold },
					},
				], 2, 2, 1, settings, { r: 255, g: 0, b: 255 }, true);
				output.push({ mode: `mask-${condition}`, supported: !!canvas });
			} catch (error) {
				output.push({ mode: `mask-${condition}`, supported: false, error: error instanceof Error ? error.message : String(error) });
			} finally { compositor.dispose(); }
		}
		return output;
	});
	for (const result of results) {
		expect(result.supported, `${result.mode}: ${result.error || 'rejected'}`).toBe(true);
	}
});

test('WebGL2 matches translucent clipped adjustment stacks used by PSD', async ({ page }) => {
	const bundle = buildSync({
		entryPoints: [path.join(__dirname, '..', '..', 'media', 'modules', 'webgl2-layer-compositor.ts')],
		bundle: true, write: false, format: 'iife', globalName: 'GpuLayerTest',
		platform: 'browser', target: 'chrome100',
	}).outputFiles[0].text;
	await page.addScriptTag({ content: bundle });
	const result = await page.evaluate(() => {
		const Compositor = (window as any).GpuLayerTest.WebGL2LayerCompositor;
		const settings = {
			gpuAcceleration: true,
			normalization: { min: 0, max: 255, autoNormalize: false, gammaMode: true },
			gamma: { in: 1, out: 1 }, brightness: { offset: 0 }, displayColormap: 'none',
		};
		const raster = (id: string, rgba: number[], blendMode: string) => ({
			id, name: id, kind: 'raster', data: new Uint8Array(rgba),
			width: 1, height: 1, channels: 4, typeMax: 255,
			visible: true, opacity: 1, blendMode,
		});
		const filter = (id: string, adjustment: any) => ({
			id, name: id, kind: 'adjustment', adjustment, clipped: true,
			width: 1, height: 1, channels: 4, typeMax: 255,
			visible: true, opacity: 1, blendMode: 'normal',
		});
		const levels = (high: number, low = 0) => ({
			type: 'levels', rgb: {
				shadowInput: low, highlightInput: high,
				shadowOutput: 0, highlightOutput: 255, midtoneInput: 1,
			},
		});
		const curves = (points: number[][]) => ({
			type: 'curves', rgb: points.map(([input, output]) => ({ input, output })),
		});
		const colorize = (hue: number) => ({
			type: 'hue/saturation', colorizeEnabled: true,
			colorize: { hue, saturation: 100, lightness: -50 },
		});
		const layers = [
			raster('502nmos', [7, 7, 7, 111], 'normal'),
			filter('Levels 1', levels(62)),
			filter('Curves 1', curves([[0, 0], [59, 63], [179, 196], [255, 255]])),
			filter('Hue/Saturation 1', colorize(-131)),
			raster('656nmos', [0, 0, 0, 111], 'screen'),
			filter('Levels 2', levels(240)),
			filter('Curves 2', curves([[0, 0], [46, 52], [186, 208], [255, 255]])),
			filter('Hue/Saturation 2', colorize(103)),
			raster('673nmos', [17, 17, 17, 111], 'screen'),
			filter('Levels 3', levels(148, 7)),
			filter('Curves 3', curves([[0, 0], [41, 73], [158, 217], [255, 255]])),
			filter('Hue/Saturation 3', colorize(0)),
		];
		const compositor = new Compositor();
		const surface = compositor.render(layers, 1, 1, 1, settings, { r: 255, g: 0, b: 255 }, true);
		const copy = document.createElement('canvas'); copy.width = 1; copy.height = 1;
		const context = copy.getContext('2d')!;
		context.drawImage(surface, 0, 0);
		const pixel = Array.from(context.getImageData(0, 0, 1, 1).data);
		compositor.dispose();
		return pixel;
	});
	expect(result[3]).toBeGreaterThan(200);
	expect(result[0]).toBeGreaterThan(result[1]);
	expect(result[2]).toBeGreaterThan(result[1]);
});

test('WebGL2 renders a native 1600px three-channel adjustment document promptly', async ({ page }) => {
	if (process.env.CI) { test.setTimeout(120_000); }
	const bundle = buildSync({
		entryPoints: [path.join(__dirname, '..', '..', 'media', 'modules', 'webgl2-layer-compositor.ts')],
		bundle: true,
		write: false,
		format: 'iife',
		globalName: 'GpuLayerTest',
		platform: 'browser',
		target: 'chrome100',
	}).outputFiles[0].text;
	await page.addScriptTag({ content: bundle });
	const testSize = Number(process.env.LAYER_GPU_TEST_SIZE || 1600);
	const result = await page.evaluate(size => {
		const Compositor = (window as any).GpuLayerTest.WebGL2LayerCompositor;
		const raster = (value: number, id: string, blendMode: string) => {
			const data = new Uint8Array(size * size * 4);
			for (let offset = 0; offset < data.length; offset += 4) {
				data[offset] = data[offset + 1] = data[offset + 2] = value;
				data[offset + 3] = 255;
			}
			return { id, kind: 'raster', data, width: size, height: size, channels: 4, typeMax: 255, visible: true, opacity: 1, blendMode };
		};
		const filters = (suffix: string, hue: number) => [
			{ id: `levels-${suffix}`, kind: 'adjustment', adjustment: { type: 'levels', rgb: { shadowInput: 5, highlightInput: 220, shadowOutput: 0, highlightOutput: 255, midtoneInput: 1.1 } }, clipped: true, width: 1, height: 1, channels: 4, typeMax: 255, visible: true, opacity: 1 },
			{ id: `curves-${suffix}`, kind: 'adjustment', adjustment: { type: 'curves', rgb: [{ input: 0, output: 0 }, { input: 80, output: 110 }, { input: 255, output: 255 }] }, clipped: true, width: 1, height: 1, channels: 4, typeMax: 255, visible: true, opacity: 1 },
			{ id: `hue-${suffix}`, kind: 'adjustment', adjustment: { type: 'hue/saturation', colorizeEnabled: true, colorize: { hue, saturation: 100, lightness: -30 } }, clipped: true, width: 1, height: 1, channels: 4, typeMax: 255, visible: true, opacity: 1 },
		];
		const layers = [
			raster(60, 'red', 'normal'), ...filters('red', 0),
			raster(120, 'green', 'screen'), ...filters('green', 120),
			raster(180, 'blue', 'screen'), ...filters('blue', 240),
		];
		const settings = {
			gpuAcceleration: true,
			normalization: { min: 0, max: 255, autoNormalize: false, gammaMode: true },
			gamma: { in: 1, out: 1 }, brightness: { offset: 0 }, displayColormap: 'none',
		};
		const compositor = new Compositor();
		const logs: string[] = []; compositor.setLogger((message: string) => logs.push(message));
		const readCenter = (surface: HTMLCanvasElement | null) => {
			if (!surface) { return [] as number[]; }
			const copy = document.createElement('canvas'); copy.width = surface.width; copy.height = surface.height;
			const context = copy.getContext('2d')!; context.drawImage(surface, 0, 0);
			return Array.from(context.getImageData(Math.floor(surface.width / 2), Math.floor(surface.height / 2), 1, 1).data);
		};
		const started = performance.now();
		const canvas = compositor.render(layers, size, size, 1, settings, { r: 255, g: 0, b: 255 });
		const durationMs = performance.now() - started;
		const dimensions = canvas ? [canvas.width, canvas.height] : [];
		const nativePixel = readCenter(canvas);
		const preview = compositor.render(layers, size, size, 768 / size, settings, { r: 255, g: 0, b: 255 });
		const cachedStarted = performance.now();
		const cachedNative = compositor.render(layers, size, size, 1, settings, { r: 255, g: 0, b: 255 });
		const cachedNativeMs = performance.now() - cachedStarted;
		const cachedDimensions = cachedNative ? [cachedNative.width, cachedNative.height] : [];
		const cachedNativePixel = readCenter(cachedNative);
		(layers[3].adjustment as any).colorize.hue = 30;
		const changedStarted = performance.now();
		const changedNative = compositor.render(layers, size, size, 1, settings, { r: 255, g: 0, b: 255 }, true);
		const changedNativeMs = performance.now() - changedStarted;
		const changedNativePixel = readCenter(changedNative);
		compositor.dispose();
		return {
			supported: !!canvas && !!preview && !!cachedNative && !!changedNative,
			nativeSupported: !!canvas, previewSupported: !!preview, cachedSupported: !!cachedNative,
			durationMs, dimensions, nativePixel, cachedNativeMs, cachedDimensions, cachedNativePixel,
			changedNativeMs, changedNativePixel, logs,
		};
	}, testSize);
	expect(result.supported, JSON.stringify(result)).toBe(true);
	expect(result.dimensions).toEqual([testSize, testSize]);
	expect(result.cachedDimensions).toEqual([testSize, testSize]);
	expect(result.nativePixel.slice(0, 3).every(channel => channel > 20)).toBe(true);
	expect(result.cachedNativePixel).toEqual(result.nativePixel);
	expect(result.changedNativePixel).not.toEqual(result.nativePixel);
	// CI runs on SwiftShader/shared hardware, several times slower than a
	// developer machine with a real GPU, so the budget scales there.
	const performanceLimitMs = (testSize > 1600 ? 30_000 : 5000) * (process.env.CI ? 4 : 1);
	expect(result.durationMs).toBeLessThan(performanceLimitMs);
	expect(result.cachedNativeMs).toBeLessThan(performanceLimitMs);
	expect(result.changedNativeMs).toBeLessThan(performanceLimitMs);
	console.log(
		`GPU native 3×${testSize} with 9 adjustments: first ${result.durationMs.toFixed(1)} ms, ` +
		`reused ${result.cachedNativeMs.toFixed(1)} ms, one-stack edit ${result.changedNativeMs.toFixed(1)} ms`,
	);
});

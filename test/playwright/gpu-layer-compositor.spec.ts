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
		const topPixels = [220, 30, 90, 128];
		const output: Record<string, number[]> = {};
		for (const mode of modes) {
			const compositor = new Compositor();
			const layers = [
				{ id: 'base', kind: 'raster', data: new Uint8Array(basePixels), width: 2, height: 2, channels: 4, typeMax: 255, visible: true, opacity: 1, blendMode: 'normal' },
				{ id: 'top', kind: 'raster', data: new Uint8Array(topPixels), width: 1, height: 1, channels: 4, typeMax: 255, visible: true, opacity: 1, blendMode: mode, offsetX: 1, offsetY: 0 },
			];
			const canvas = compositor.render(layers, 2, 2, 1, settings, { r: 255, g: 0, b: 255 });
			if (!canvas) { throw new Error(`GPU compositor rejected ${mode}`); }
			const context = document.createElement('canvas').getContext('2d')!;
			context.canvas.width = 2; context.canvas.height = 2;
			context.drawImage(canvas, 0, 0);
			output[mode] = Array.from(context.getImageData(0, 0, 2, 2).data);
			compositor.dispose();
		}
		const compositor = new Compositor();
		const unsupported = compositor.canRender([
			{ id: 'adjustment', kind: 'adjustment', adjustment: { type: 'invert' }, width: 1, height: 1, channels: 4, typeMax: 255, visible: true },
		], settings, 1, 1);
		return { output, unsupported };
	}, MODES);

	const compositorPath = path.join(__dirname, '..', '..', 'out', 'media', 'modules', 'layer-compositor.js');
	const { composite } = await import(compositorPath.replace(/\\/g, '/'));
	const base = new Uint8Array([
		20, 40, 60, 255, 80, 100, 120, 255,
		140, 160, 180, 255, 200, 220, 240, 255,
	]);
	const top = new Uint8Array([220, 30, 90, 128]);
	for (const mode of MODES) {
		const result = composite([
			{ id: 'base', kind: 'raster', data: base, width: 2, height: 2, channels: 4, typeMax: 255, visible: true, opacity: 1, blendMode: 'normal' },
			{ id: 'top', kind: 'raster', data: top, width: 1, height: 1, channels: 4, typeMax: 255, visible: true, opacity: 1, blendMode: mode, offsetX: 1, offsetY: 0 },
		], 2, 2);
		const expected = Array.from(result.data, (value: number) => Math.max(0, Math.min(255, Math.round(value))));
		for (let index = 0; index < expected.length; index++) {
			expect(Math.abs(gpuResults.output[mode][index] - expected[index]), `${mode} channel ${index}`).toBeLessThanOrEqual(1);
		}
	}
	expect(gpuResults.unsupported).toBe(false);
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
		return { scalarSupported: !!scalarSurface, scalarRgba, largeSupported: !!first && !!cached, dimensions, firstMs, cachedMs };
	});

	expect(result.scalarSupported).toBe(true);
	expect(result.scalarRgba).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
	expect(result.largeSupported).toBe(true);
	expect(result.dimensions).toEqual([768, 768]);
	expect(result.cachedMs).toBeLessThan(2000);
	console.log(`GPU 4x1024 render: first ${result.firstMs.toFixed(1)} ms, cached visibility edit ${result.cachedMs.toFixed(1)} ms`);
	test.info().annotations.push({ type: 'performance', description: `GPU 4x1024: first ${result.firstMs.toFixed(1)} ms, cached edit ${result.cachedMs.toFixed(1)} ms` });
});

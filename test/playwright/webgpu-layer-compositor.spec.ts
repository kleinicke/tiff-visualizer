import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import http from 'http';
import path from 'path';

test('WebGPU composites PSD-style colorize and screen stacks with strict parity', async ({ page }) => {
	const server = http.createServer((_request, response) => {
		response.setHeader('Content-Type', 'text/html');
		response.end('<!doctype html><meta charset="utf-8">');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		if (!address || typeof address === 'string') { throw new Error('Could not start WebGPU test origin'); }
		await page.goto(`http://127.0.0.1:${address.port}`);
		const bundle = buildSync({
			entryPoints: [path.join(__dirname, '..', '..', 'media', 'modules', 'webgpu-layer-compositor.ts')],
			bundle: true, write: false, format: 'iife', globalName: 'WebGpuLayerTest',
			platform: 'browser', target: 'chrome120',
		}).outputFiles[0].text;
		await page.addScriptTag({ content: bundle });
		const result = await page.evaluate(async () => {
			const Compositor = (window as any).WebGpuLayerTest.WebGPULayerCompositor;
			const compositor = new Compositor();
			const logs: string[] = [];
			compositor.setLogger((message: string) => logs.push(message));
			const common = {
				width: 2, height: 1, channels: 4, typeMax: 255,
				visible: true, opacity: 1, blendMode: 'normal',
			};
			const layers = [
				{ ...common, id: 'blue-gray', kind: 'raster', data: new Uint8Array([30, 30, 30, 255, 180, 180, 180, 128]) },
				{
					...common, id: 'blue-colorize', kind: 'adjustment', clipped: true,
					adjustment: { type: 'hue/saturation', colorizeEnabled: true, colorize: { hue: -131, saturation: 100, lightness: -20 } },
				},
				{ ...common, id: 'red-gray', kind: 'raster', data: new Uint8Array([80, 80, 80, 192, 220, 220, 220, 255]), blendMode: 'screen' },
				{
					...common, id: 'red-colorize', kind: 'adjustment', clipped: true,
					adjustment: { type: 'hue/saturation', colorizeEnabled: true, colorize: { hue: 0, saturation: 100, lightness: -30 } },
				},
			];
			const settings = {
				gpuAcceleration: true,
				normalization: { min: 0, max: 255, autoNormalize: false, gammaMode: true },
				gamma: { in: 1, out: 1 }, brightness: { offset: 0 }, displayColormap: 'none',
			};
			try {
				const canvas = await compositor.render(layers, 2, 1, 1, settings, { r: 255, g: 0, b: 255 }, true);
				if (!canvas) { return { supported: false, error: 'No canvas' }; }
				// A slider can mutate adjustment objects while an asynchronous GPU
				// request is between command submission and strict CPU validation.
				// The request must retain its submission-time parameters.
				(layers[1] as any).adjustment.colorize.hue = -90;
				const queued = compositor.render(layers, 2, 1, 1, settings, { r: 255, g: 0, b: 255 }, true);
				await new Promise(resolve => setTimeout(resolve, 0));
				(layers[1] as any).adjustment.colorize.hue = -131;
				await queued;
				// A hidden raster still owns its clipped filters. Hiding the red
				// base must not attach its colorize filter to the blue base.
				layers[2].visible = false;
				await compositor.render(layers, 2, 1, 1, settings, { r: 255, g: 0, b: 255 }, true);
				layers[2].visible = true;
				await compositor.render([{
					id: 'auto', kind: 'raster', data: new Uint8Array([50, 200]),
					width: 2, height: 1, channels: 1, typeMax: 255, visible: true, opacity: 1, blendMode: 'normal',
				}], 2, 1, 1, {
					...settings, normalization: { min: 0, max: 255, autoNormalize: true, gammaMode: false },
				}, { r: 255, g: 0, b: 255 }, true);
				await compositor.render(layers, 2, 1, 1, settings, { r: 255, g: 0, b: 255 }, true);
				const cachedUploads = compositor.pendingUpload(layers).count;
				compositor.dispose();
				const releasedUploads = compositor.pendingUpload(layers).count;
				await compositor.render(layers, 2, 1, 1, settings, { r: 255, g: 0, b: 255 }, true);
				return { supported: true, logs, cachedUploads, releasedUploads };
			} catch (error) {
				return { supported: false, error: error instanceof Error ? error.message : String(error) };
			} finally {
				compositor.dispose();
			}
		});
		expect(result.supported, result.error).toBe(true);
		expect(result.logs, result.logs?.join('\n')).toEqual([]);
		expect(result.cachedUploads).toBe(0);
		expect(result.releasedUploads).toBeGreaterThan(0);
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

test('WebGPU preserves every filter, groups, masks, clipping, numeric types, and scientific modes', async ({ page }) => {
	const server = http.createServer((_request, response) => response.end('<!doctype html>'));
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		if (!address || typeof address === 'string') { throw new Error('Could not start WebGPU test origin'); }
		await page.goto(`http://127.0.0.1:${address.port}`);
		const bundle = buildSync({
			entryPoints: [path.join(__dirname, '..', '..', 'media', 'modules', 'webgpu-layer-compositor.ts')],
			bundle: true, write: false, format: 'iife', globalName: 'WebGpuLayerTest',
			platform: 'browser', target: 'chrome120',
		}).outputFiles[0].text;
		await page.addScriptTag({ content: bundle });
		const results = await page.evaluate(async () => {
			const Compositor = (window as any).WebGpuLayerTest.WebGPULayerCompositor;
			const settings = {
				gpuAcceleration: true,
				normalization: { min: 0, max: 255, autoNormalize: false, gammaMode: true },
				gamma: { in: 1, out: 1 }, brightness: { offset: 0 }, displayColormap: 'none',
			};
			const adjustments = [
				{ type: 'levels', rgb: { shadowInput: 10, highlightInput: 220, midtoneInput: 1.2 } },
				{ type: 'curves', rgb: [{ input: 0, output: 0 }, { input: 100, output: 150 }, { input: 255, output: 255 }] },
				{ type: 'hue/saturation', master: { hue: 7, saturation: -4, lightness: 3 }, reds: { a: -30, b: -10, c: 20, d: 45, hue: 18, saturation: 12, lightness: -5 } },
				{ type: 'brightness/contrast', brightness: 12, contrast: -18 },
				{ type: 'exposure', exposure: 0.75, offset: -0.05, gamma: 1.3 },
				{ type: 'invert' },
				{ type: 'channel mixer', red: { red: 80, green: 20 }, green: { green: 70, blue: 30 }, blue: { red: 10, blue: 90 } },
				{ type: 'color balance', shadows: { cyanRed: -15 }, midtones: { magentaGreen: 20 }, highlights: { yellowBlue: -10 }, preserveLuminosity: true },
				{ type: 'black & white', reds: 35, yellows: 70, greens: 30, cyans: 55, blues: 15, magentas: 90 },
				{ type: 'threshold', level: 100 },
				{ type: 'posterize', levels: 5 },
				{ type: 'gradient map', reverse: true, stops: [
					{ position: 0, color: { r: 10, g: 20, b: 30 } },
					{ position: 1, color: { r: 250, g: 220, b: 180 } },
				] },
			];
			const output: any[] = [];
			for (let index = 0; index < adjustments.length; index++) {
				const compositor = new Compositor();
				const layers = [
					{
						id: `base-${index}`, kind: 'raster',
						data: new Uint8Array([64, 128, 192, 255, 192, 64, 128, 192, 24, 220, 96, 128, 240, 96, 16, 64]),
						width: 2, height: 2, channels: 4, typeMax: 255, visible: true, opacity: 1, blendMode: 'normal',
					},
					{
						id: `filter-${index}`, kind: 'adjustment', adjustment: adjustments[index], clipped: true,
						width: 2, height: 2, channels: 4, typeMax: 255, visible: true, opacity: 0.83, blendMode: 'normal',
						rasterMask: { data: new Uint8Array([255, 128, 64, 192]), width: 2, height: 2, channels: 1, typeMax: 255 },
					},
				];
				try {
					await compositor.render(layers, 2, 2, 1, settings, { r: 255, g: 0, b: 255 }, true);
					output.push({ name: adjustments[index].type, ok: true });
				} catch (error) {
					output.push({ name: adjustments[index].type, ok: false, error: error instanceof Error ? error.message : String(error) });
				} finally { compositor.dispose(); }
			}
			const complex = new Compositor();
			const complexLayers = [
				{
					id: 'background', kind: 'raster', data: new Uint16Array([1000, 2000, 3000, 65535, 4000, 5000, 6000, 65535]),
					width: 2, height: 1, channels: 4, typeMax: 65535, visible: true, opacity: 1, blendMode: 'normal',
				},
				{
					id: 'group', kind: 'group', width: 2, height: 1, channels: 4, typeMax: 65535,
					visible: true, opacity: 0.7, blendMode: 'screen', offsetX: 0, offsetY: 0,
					rasterMask: { data: new Uint8Array([255, 128]), width: 2, height: 1, channels: 1, typeMax: 255 },
				},
				{
					id: 'child', parentId: 'group', kind: 'raster', data: new Float32Array([0.2, 0.4, 0.7, 1, 0.8, 0.1, 0.3, 0.5]),
					width: 2, height: 1, channels: 4, typeMax: 1, isFloat: true, visible: true, opacity: 1, blendMode: 'normal',
				},
				{
					id: 'child-invert', parentId: 'group', kind: 'adjustment', adjustment: { type: 'invert' }, clipped: true,
					width: 2, height: 1, channels: 4, typeMax: 1, visible: true, opacity: 0.2, blendMode: 'normal',
				},
			];
			try {
				await complex.render(complexLayers, 2, 1, 1, { ...settings, normalization: { ...settings.normalization, max: 65535 } }, { r: 255, g: 0, b: 255 }, true);
				output.push({ name: 'nested-group-numeric-mask', ok: true });
			} catch (error) {
				output.push({ name: 'nested-group-numeric-mask', ok: false, error: error instanceof Error ? error.message : String(error) });
			} finally { complex.dispose(); }
			for (const mode of ['add', 'subtract', 'raw-difference', 'raw-multiply', 'divide', 'min', 'max', 'average', 'mask']) {
				const compositor = new Compositor();
				const layers = [
					{ id: 'science-base', kind: 'raster', data: new Float32Array([10, 20]), width: 2, height: 1, channels: 1, typeMax: 100, isFloat: true, visible: true, opacity: 1, blendMode: 'normal' },
					{ id: `science-${mode}`, kind: 'raster', data: new Float32Array([2, 5]), width: 2, height: 1, channels: 1, typeMax: 100, isFloat: true, visible: true, opacity: 0.6, blendMode: mode, maskCondition: { op: 'gt', threshold: 3 } },
				];
				try {
					await compositor.render(layers, 2, 1, 1, { ...settings, normalization: { ...settings.normalization, max: 100 } }, { r: 255, g: 0, b: 255 }, true);
					output.push({ name: mode, ok: true });
				} catch (error) {
					output.push({ name: mode, ok: false, error: error instanceof Error ? error.message : String(error) });
				} finally { compositor.dispose(); }
			}
			for (const mode of ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'exclusion']) {
				const compositor = new Compositor();
				const layers = [
					{ id: 'common-base', kind: 'raster', data: new Uint8Array([30, 120, 220, 192, 220, 80, 20, 255]), width: 2, height: 1, channels: 4, typeMax: 255, visible: true, opacity: 1, blendMode: 'normal' },
					{ id: `common-${mode}`, kind: 'raster', data: new Uint8Array([200, 40, 100, 128, 40, 180, 230, 96]), width: 2, height: 1, channels: 4, typeMax: 255, visible: true, opacity: 0.7, blendMode: mode },
				];
				try {
					await compositor.render(layers, 2, 1, 1, settings, { r: 255, g: 0, b: 255 }, true);
					output.push({ name: `common-${mode}`, ok: true });
				} catch (error) {
					output.push({ name: `common-${mode}`, ok: false, error: error instanceof Error ? error.message : String(error) });
				} finally { compositor.dispose(); }
			}
			const nan = new Compositor();
			try {
				await nan.render([
					{ id: 'nan-background', kind: 'raster', data: new Float32Array([0.2, 0.4]), width: 2, height: 1, channels: 1, typeMax: 1, isFloat: true, visible: true, opacity: 1, blendMode: 'normal' },
					{ id: 'nan-top', kind: 'raster', data: new Float32Array([Number.NaN, 0.8]), width: 2, height: 1, channels: 1, typeMax: 1, isFloat: true, visible: true, opacity: 1, blendMode: 'normal' },
				], 2, 1, 1, { ...settings, normalization: { ...settings.normalization, max: 1 } }, { r: 255, g: 0, b: 255 }, true);
				output.push({ name: 'nan-propagation-and-display', ok: true });
			} catch (error) {
				output.push({ name: 'nan-propagation-and-display', ok: false, error: error instanceof Error ? error.message : String(error) });
			} finally { nan.dispose(); }
			return output;
		});
		for (const result of results) { expect(result.ok, `${result.name}: ${result.error || 'failed'}`).toBe(true); }
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

test('WebGPU renders a native 5000×5000 byte document within the interactive backend budget', async ({ page }) => {
	test.setTimeout(30_000);
	const server = http.createServer((_request, response) => response.end('<!doctype html>'));
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		if (!address || typeof address === 'string') { throw new Error('Could not start WebGPU test origin'); }
		await page.goto(`http://127.0.0.1:${address.port}`);
		const bundle = buildSync({
			entryPoints: [path.join(__dirname, '..', '..', 'media', 'modules', 'webgpu-layer-compositor.ts')],
			bundle: true, write: false, format: 'iife', globalName: 'WebGpuLayerTest',
			platform: 'browser', target: 'chrome120',
		}).outputFiles[0].text;
		await page.addScriptTag({ content: bundle });
		const result = await page.evaluate(async () => {
			const Compositor = (window as any).WebGpuLayerTest.WebGPULayerCompositor;
			const compositor = new Compositor();
			const size = 5000;
			const data = new Uint8Array(size * size * 4);
			data.fill(96);
			for (let alpha = 3; alpha < data.length; alpha += 4) { data[alpha] = 255; }
			const started = performance.now();
			try {
				const layers = [{
					id: '5k', kind: 'raster', data,
					width: size, height: size, channels: 4, typeMax: 255,
					visible: true, opacity: 1, blendMode: 'normal',
				}];
				const settings = {
					gpuAcceleration: true,
					normalization: { min: 0, max: 255, autoNormalize: false, gammaMode: true },
					gamma: { in: 1, out: 1 }, brightness: { offset: 0 }, displayColormap: 'none',
				};
				const pendingBefore = compositor.pendingUpload(layers);
				const cold = await compositor.renderWithMetrics(
					layers, size, size, 1, settings, { r: 255, g: 0, b: 255 }, true,
				);
				await compositor.renderWithMetrics(
					layers, size, size, 768 / size, settings, { r: 255, g: 0, b: 255 }, true,
				);
				const reused = await compositor.renderWithMetrics(
					layers, size, size, 1, settings, { r: 255, g: 0, b: 255 }, true,
				);
				return {
					ok: true, duration: performance.now() - started,
					cold: cold.timing, reused: reused.timing,
					pendingBefore, pendingAfter: compositor.pendingUpload(layers),
				};
			} catch (error) {
				return { ok: false, duration: performance.now() - started, error: error instanceof Error ? error.message : String(error) };
			} finally { compositor.dispose(); }
		});
		expect(result.ok, result.error).toBe(true);
		expect(result.duration).toBeLessThan(10_000);
		expect(result.reused?.surfaceCacheHit).toBe(true);
		expect(result.reused?.compositionCacheHit).toBe(true);
		expect(result.reused?.surfaceAllocationBytes).toBe(0);
		expect(result.reused?.uploadCount).toBe(0);
		expect(result.pendingBefore?.count).toBe(1);
		expect(result.pendingAfter?.count).toBe(0);
		test.info().annotations.push({
			type: 'performance',
			description: `5000×5000 cold: ${result.cold?.renderMs.toFixed(1)}ms, reused after preview: ${result.reused?.renderMs.toFixed(1)}ms`,
		});
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

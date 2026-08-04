import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import http from 'http';
import path from 'path';

function bundle(entryPoint: string, globalName: string): string {
	return buildSync({
		entryPoints: [entryPoint],
		bundle: true,
		write: false,
		format: 'iife',
		globalName,
		platform: 'browser',
		target: 'chrome120',
	}).outputFiles[0].text;
}

for (const workload of [
	{ name: 'normal-image', size: 2048, layerCount: 1 },
	{ name: 'four-layer', size: 1024, layerCount: 4 },
]) {
test(`compares CPU, WebGL2, and WebGPU for ${workload.name}`, async ({ page }) => {
	test.setTimeout(60_000);
	const server = http.createServer((_request, response) => response.end('<!doctype html><meta charset="utf-8">'));
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		if (!address || typeof address === 'string') { throw new Error('Could not start benchmark origin'); }
		await page.goto(`http://127.0.0.1:${address.port}`);
		const modules = path.join(__dirname, '..', '..', 'media', 'modules');
		await page.addScriptTag({ content: bundle(path.join(modules, 'layer-manager.ts'), 'CpuLayerBenchmark') });
		await page.addScriptTag({ content: bundle(path.join(modules, 'webgl2-layer-compositor.ts'), 'WebGlLayerBenchmark') });
		await page.addScriptTag({ content: bundle(path.join(modules, 'webgpu-layer-compositor.ts'), 'WebGpuLayerBenchmark') });

		const result = await page.evaluate(async ({ size, layerCount }) => {
			const layers = Array.from({ length: layerCount }, (_, index) => {
				const data = new Uint8Array(size * size * 4);
				for (let offset = 0; offset < data.length; offset += 4) {
					data[offset] = 32 + index * 41;
					data[offset + 1] = 180 - index * 27;
					data[offset + 2] = 64 + index * 31;
					data[offset + 3] = index === 0 ? 255 : 192;
				}
				return {
					id: `raster-${index}`, kind: 'raster', data,
					width: size, height: size, channels: 4, typeMax: 255,
					visible: true, opacity: 1,
					blendMode: ['normal', 'multiply', 'screen', 'overlay'][index],
				};
			});
			const settings = {
				gpuAcceleration: true,
				normalization: { min: 0, max: 255, autoNormalize: false, gammaMode: true },
				gamma: { in: 1, out: 1 },
				brightness: { offset: 0 },
				displayColormap: 'none',
			};
			const changedSettings = { ...settings, brightness: { offset: 0.125 } };
			const nanColor = { r: 255, g: 0, b: 255 };
			const measureSync = (operation: () => unknown) => {
				const started = performance.now();
				const value = operation();
				return { value, ms: performance.now() - started };
			};

			const CpuManager = (window as any).CpuLayerBenchmark.LayerManager;
			const cpu = new CpuManager();
			cpu.setLayers(layers, size, size);
			const cpuCold = measureSync(() => cpu.renderToImageData(settings, { nanColor }));
			const cpuWarm = measureSync(() => cpu.renderToImageData(changedSettings, { nanColor }));

			const WebGlCompositor = (window as any).WebGlLayerBenchmark.WebGL2LayerCompositor;
			const webgl = new WebGlCompositor();
			const webglCold = measureSync(() => webgl.render(layers, size, size, 1, settings, nanColor, true));
			const webglWarm = measureSync(() => webgl.render(layers, size, size, 1, changedSettings, nanColor, true));
			const gl = (webgl as any).gl as WebGL2RenderingContext | null;
			const rendererInfo = gl?.getExtension('WEBGL_debug_renderer_info');
			const webglRenderer = gl && rendererInfo
				? String(gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL))
				: 'unreported';
			webgl.dispose();

			const WebGpuCompositor = (window as any).WebGpuLayerBenchmark.WebGPULayerCompositor;
			const webgpu = new WebGpuCompositor();
			let webgpuCold: any;
			let webgpuWarm: any;
			let webgpuError: string | undefined;
			try {
				webgpuCold = (await webgpu.renderWithMetrics(
					layers, size, size, 1, settings, nanColor, true,
				)).timing;
				webgpuWarm = (await webgpu.renderWithMetrics(
					layers, size, size, 1, changedSettings, nanColor, true,
				)).timing;
			} catch (error) {
				webgpuError = error instanceof Error ? error.message : String(error);
			} finally {
				var webgpuAdapter = (webgpu as any).adapter?.info
					? JSON.parse(JSON.stringify((webgpu as any).adapter.info))
					: null;
				webgpu.dispose();
			}

			return {
				size,
				layers: layers.length,
				cpu: { coldMs: cpuCold.ms, warmMs: cpuWarm.ms, supported: !!cpuCold.value && !!cpuWarm.value },
				webgl: { coldMs: webglCold.ms, warmMs: webglWarm.ms, supported: !!webglCold.value && !!webglWarm.value, renderer: webglRenderer },
				webgpu: webgpuError ? { supported: false, error: webgpuError } : {
					supported: true,
					coldMs: webgpuCold.renderMs,
					warmMs: webgpuWarm.renderMs,
					coldGpuMs: webgpuCold.gpuMs,
					warmGpuMs: webgpuWarm.gpuMs,
					coldUploads: webgpuCold.uploadCount,
					warmUploads: webgpuWarm.uploadCount,
					compositionCacheHit: webgpuWarm.compositionCacheHit,
					adapter: webgpuAdapter,
				},
			};
		}, workload);

		expect(result.cpu.supported).toBe(true);
		expect(result.webgl.supported).toBe(true);
		expect(result.webgpu.supported, result.webgpu.error).toBe(true);
		console.log(`Accelerator benchmark ${result.layers}×${result.size}² RGBA layers`);
		console.log(JSON.stringify(result, null, 2));
		test.info().annotations.push({
			type: 'performance',
			description: JSON.stringify(result),
		});
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});
}

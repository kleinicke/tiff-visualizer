import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

test('dedicated layer compositor worker returns full and scaled surfaces', async ({ page }) => {
	const workerSource = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'layerCompositorWorker.bundle.js'), 'utf8');
	const results = await page.evaluate(async source => {
		const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
		// The bundle is self-contained; classic mode also works on Playwright's
		// opaque about:blank origin, where module Blob workers are blocked.
		const worker = new Worker(url);
		const messages: any[] = [];
		worker.onmessage = event => messages.push(event.data);
		for (let wait = 0; wait < 100 && !messages.some(message => message.type === 'ready'); wait++) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		const baseLayer = {
			key: 'base', signature: 'base-v1', id: 'base', kind: 'raster',
			dataAssetId: 1, width: 2, height: 2, channels: 4, typeMax: 255,
			offsetX: 0, offsetY: 0, opacity: 1, visible: true, blendMode: 'normal',
		};
		const compose = (id: number, scale: number, assets: any[], layers: any[] = [baseLayer]) => new Promise<any>((resolve, reject) => {
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
				layers,
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
		worker.terminate();
		URL.revokeObjectURL(url);
		return {
			full: { type: full.type, width: full.result.width, height: full.result.height, data: Array.from(full.result.data) },
			scaled: { type: scaled.type, width: scaled.result.width, height: scaled.result.height, data: Array.from(scaled.result.data) },
			mixed: { type: mixed.type, typeMax: mixed.result.typeMax, channels: mixed.result.channels, data: Array.from(mixed.result.data) },
		};
	}, workerSource);

	expect(results.full.type).toBe('composite-result');
	expect([results.full.width, results.full.height]).toEqual([2, 2]);
	expect(results.full.data.slice(0, 4)).toEqual([255, 0, 0, 255]);
	expect(results.scaled.type).toBe('composite-result');
	expect([results.scaled.width, results.scaled.height]).toEqual([1, 1]);
	expect(results.scaled.data).toHaveLength(4);
	expect([results.mixed.channels, results.mixed.typeMax]).toEqual([4, 255]);
	expect(results.mixed.data[3]).toBe(255);
	expect(results.mixed.data[7]).toBe(255);
});

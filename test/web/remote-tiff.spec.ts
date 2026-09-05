import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import path from 'path';

test('remote scalar GPU tiles preserve display pixels and original picker values', async ({ page }) => {
  const bundle = buildSync({ entryPoints: [path.resolve('media/modules/tiff-processor.ts')], bundle: true,
    write: false, format: 'iife', globalName: 'RemoteTileTest', platform: 'browser', target: 'chrome100', logLevel: 'silent' }).outputFiles[0].text;
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(async () => {
    const settings = { gpuAcceleration: true, normalization: { autoNormalize: true, gammaMode: false },
      gamma: { in: 1, out: 1 }, brightness: { offset: 0 }, displayColormap: 'none', nanColor: 'black' };
    const processor = new (window as any).RemoteTileTest.TiffProcessor({ settings }, null);
    processor._sourceBuffer = new ArrayBuffer(1);
    const width = 17, height = 19;
    const data = Float32Array.from({ length: width * height }, (_, i) => i * 199 % 65536);
    processor.rawTiffData = { ifd: { t258: 16, t339: 1, t277: 1 }, data };
    processor._lastStatistics = { min: 0, max: 65535 };
    processor._gdalNodata = 0;
    processor._decodeRegionRaw = async () => ({ width, height, channels: 1, sampleFormat: 1, bitsPerSample: 16, data });
    const rect = { x: 0, y: 0, width, height };
    const cpu = await processor.renderRegion(0, rect);
    const gpu = await processor.renderRegionCanvas(0, rect);
    const pixels = gpu.getContext('2d').getImageData(0, 0, width, height).data;
    const differences = Array.from(cpu.data as Uint8ClampedArray).filter((value, i) => value !== pixels[i]).length;
    const original = processor._readCachedPagePixel(0, 10, 10);
    settings.gpuAcceleration = false;
    const fallback = await processor.renderRegionCanvas(0, rect);
    return { differences, backend: gpu.dataset.renderBackend, original,
      expected: String(data[10 * width + 10]), fallback: fallback instanceof ImageData };
  });
  expect(result.backend).toBe('webgl');
  expect(result.differences).toBe(0);
  expect(result.original).toBe(result.expected);
  expect(result.fallback).toBe(true);
});

test('streams the massive remote COG through lazy indices and bounded requests', async ({ page }) => {
  const sample = process.env.TIFF_REMOTE_SAMPLE;
  test.skip(!sample, 'Set TIFF_REMOTE_SAMPLE to test a live massive COG');
  test.setTimeout(120_000);
  const messages: string[] = [];
  page.on('console', message => messages.push(message.text()));
  await page.goto('/?url=' + encodeURIComponent(sample!));
  await expect(page.locator('.pyramid-scene')).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => messages.some(text => text.startsWith('[Refine]')), { timeout: 60_000 }).toBe(true);
  expect(messages.some(text => text.includes('[RemoteTIFF] Lazy directory'))).toBe(true);
  expect(messages.filter(text => /pool unavailable|using existing directory reader|render failure/.test(text))).toEqual([]);
  await expect(page.locator('.nav-overlay')).not.toHaveClass(/dataset-overlay--loading/);
  await expect(page.locator('#web-status-size')).not.toContainText('overview');
});

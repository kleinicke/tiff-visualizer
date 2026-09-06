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
  await page.addInitScript(() => localStorage.setItem('scientific-image-visualizer.webview-state', JSON.stringify({ scale: 4, offsetX: 200, offsetY: 300 })));
  await page.goto('/?source=' + encodeURIComponent(sample!), { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.pyramid-scene')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#web-status-zoom')).toHaveText('Whole Image');
  const fit = await page.locator('.pyramid-scene').boundingBox();
  expect(fit!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(fit!.height).toBeLessThanOrEqual(page.viewportSize()!.height - 92);
  // Read a screenshot: the overview may own a WebGL context, so asking that
  // canvas for a 2D context would return null even when its pixels are visible.
  const screenshot = await page.locator('.pyramid-base').screenshot();
  expect(await page.evaluate(async bytes => {
    const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    image.close();
    return pixels.some((value, index) => index % 4 !== 3 && value !== pixels[0]);
  }, Array.from(screenshot))).toBe(true);
  expect(messages.some(text => text.includes('[RemoteTIFF] Lazy directory'))).toBe(true);
  await expect(page.locator('.pyramid-base')).toBeVisible();
  await expect(page.locator('.pyramid-gpu')).toHaveCount(0);
  expect(messages.filter(text => /pool unavailable|using existing directory reader|render failure/.test(text))).toEqual([]);
  await expect(page.locator('.nav-overlay')).not.toHaveClass(/dataset-overlay--loading/);
  await expect(page.locator('#web-status-size')).not.toContainText('overview');
  await page.getByRole('button', { name: /^Close / }).click();
  await expect(page.locator('#web-empty-state')).toBeVisible();
  await expect(page.locator('.pyramid-scene')).toHaveCount(0);
});

test('RGB band mapping preserves original samples', async ({ page }) => {
  const bundle = buildSync({ stdin: { contents: `export { TiffProcessor } from './media/modules/tiff-processor';`, resolveDir: process.cwd() }, bundle: true,
    write: false, format: 'iife', globalName: 'TileTest', platform: 'browser', target: 'chrome100', logLevel: 'silent' }).outputFiles[0].text;
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(async () => {
    const { TiffProcessor } = (window as any).TileTest;
    const settings = { gpuAcceleration: true, normalization: { autoNormalize: false, gammaMode: false, min: 0, max: 255 }, gamma: { in: 1, out: 1 }, brightness: { offset: 0 }, displayColormap: 'none', nanColor: 'black' };
    const processor = new TiffProcessor({ settings }, null);
    processor._sourceBuffer = new ArrayBuffer(1);
    const width = 8, height = 8, data = Float32Array.from({length: width*height*5}, (_,i) => i%5*40 + Math.floor(i/5)%31);
    processor.rawTiffData = { ifd: { t258: 8, t339: 1, t277: 5, t262: 1 }, data };
    processor._extraSamplesAreAlpha = false;
    processor._decodeRegionRaw = async () => ({ width,height,channels:5,sampleFormat:1,bitsPerSample:8,data });
    const selected = processor.setDisplayRgbBands([4,1,3]);
    const rect = { x:0,y:0,width,height }, cpu = await processor.renderRegion(0,rect);
    const first=Array.from(cpu.data.slice(0,4));
    processor.setDisplayBand(2);
    return {selected,first,scalarAgain:processor.displayRgbBands===null,source:Array.from(data.slice(0,5))};
  });
  expect(result).toEqual({selected:true,first:[160,40,120,255],scalarAgain:true,source:[0,40,80,120,160]});
});

import { expect, test, type Page } from '@playwright/test';
import * as path from 'node:path';

async function request(page: Page, operation: string, args: Record<string, unknown> = {}) {
  return page.evaluate(({ operation, args }) => new Promise<Record<string, any>>((resolve, reject) => {
    const id = crypto.randomUUID();
    const receive = (event: Event) => {
      const message = (event as CustomEvent).detail;
      if (message.type === 'automationResult' && message.id === id) {
        clearTimeout(timer); window.removeEventListener('__testViewerMessage', receive); resolve(message);
      }
    };
    const timer = setTimeout(() => { window.removeEventListener('__testViewerMessage', receive); reject(new Error('No automation response')); }, 5000);
    window.addEventListener('__testViewerMessage', receive);
    window.postMessage({type:'automationRequest',id,operation,args}, location.origin);
  }), {operation,args});
}

test('viewer protocol validates automation and measures the active decoded source', async ({page}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'acquireVsCodeApi', { configurable: true, set(factory) {
      Object.defineProperty(window, 'acquireVsCodeApi', { configurable: true, value: () => {
        const api = factory();
        const post = api.postMessage;
        api.postMessage = (message: unknown) => {
          window.dispatchEvent(new CustomEvent('__testViewerMessage', { detail: message }));
          return post(message);
        };
        return api;
      } });
    } });
  });
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles(path.resolve('test-samples/pred_ref_rgb8.tif'));
  await expect(page.locator('body')).toHaveClass(/ready/);
  const original = await request(page,'inspect');
  expect(original.error).toBeUndefined();
  expect(original.result.channels).toBe(3);
  const invalid = await request(page,'region',{x:0,y:0,width:-1,height:2});
  expect(invalid.error).toMatch(/Invalid width/);
  expect((await request(page,'measurements')).result.rois).toHaveLength(0);
  const region = await request(page,'region',{x:0,y:0,width:2,height:2});
  expect(region.result.rows[0].area).toBe(4);

  await page.evaluate(() => window.postMessage({type:'convertColormapToFloat',colormap:'viridis',min:-10,max:10,inverted:false,logarithmic:false},location.origin));
  await expect.poll(async () => (await request(page,'inspect')).result?.channels).toBe(1);
  const pixel = await request(page,'pixel',{x:0,y:0});
  expect(pixel.result.values).toHaveLength(1);
  expect(pixel.result.values[0]).toBeGreaterThanOrEqual(-10);
  expect(pixel.result.values[0]).toBeLessThanOrEqual(10);
  await page.evaluate(() => window.postMessage({type:'toggleHistogram'},location.origin));
  await expect(page.locator('.histogram-overlay')).toBeVisible();
  await expect(page.locator('.histogram-stat-line').first()).not.toBeEmpty();
});

import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
const script = buildSync({ entryPoints: [path.join(root, 'media/modules/zoom-controller.ts')], bundle: true, format: 'iife', globalName: 'ZoomModule', write: false }).outputFiles[0].text;
const css = readFileSync(path.join(root, 'media/imagePreview.css'), 'utf8');

// Exercise the real controller and desktop stylesheet with browser layout.
// This does not replace extension-host tests for configuration delivery.
for (const pyramid of [false, true]) for (const scrollToZoom of [false, true]) {
  test(`fit resize and zoom limits: pyramid=${pyramid}, scrollToZoom=${scrollToZoom}`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.setContent('<!doctype html><body class="container image ready"></body>');
    await page.addStyleTag({ content: css + '\nbody { margin: 0; }' });
    await page.addScriptTag({ content: script });
    await page.evaluate(({ pyramid, scrollToZoom }) => {
      const w = window as any;
      const image = document.createElement(pyramid ? 'div' : 'canvas');
      if (pyramid) { image.classList.add('pyramid-scene'); }
      document.body.append(image);
      const settings = { settings: { scrollToZoom, fitUpscale: true }, constants: { PIXELATION_THRESHOLD: 3, MAX_SCALE: 200, MIN_SCALE: 0.1, ZOOM_LEVELS: [1, 2, 3, 5, 10, 20, 50, 100, 200] } };
      const controller = new w.ZoomModule.ZoomController(settings, { getState: () => ({}), setState() {}, postMessage() {} });
      controller.setImageElement(image);
      controller.setImageLoaded();
      w.fitTest = {
        controller, settings,
        size(width: number, height: number) {
          if (pyramid) { image.dataset.sceneWidth = String(width); image.dataset.sceneHeight = String(height); }
          else { (image as HTMLCanvasElement).width = width; (image as HTMLCanvasElement).height = height; }
          controller.resetZoom();
        },
      };
      window.addEventListener('resize', () => controller.refit());
      w.fitTest.size(100, 60);
    }, { pyramid, scrollToZoom });
    const width = () => page.evaluate(() => (window as any).fitTest.controller.imageElement.getBoundingClientRect().width);
    await expect.poll(width).toBeGreaterThan(960);
    await page.setViewportSize({ width: 80, height: 60 });
    await expect.poll(width).toBeLessThanOrEqual(60);
    await page.setViewportSize({ width: 1000, height: 600 });
    await expect.poll(width).toBeGreaterThan(960);

    await page.evaluate(() => {
      const { settings, controller } = (window as any).fitTest;
      settings.settings.fitUpscale = false;
      controller.updateScale('fit');
    });
    await expect.poll(width).toBe(100);
    await page.evaluate(() => {
      const { settings, controller } = (window as any).fitTest;
      settings.settings.fitUpscale = true;
      controller.updateScale('fit');
    });
    await expect.poll(width).toBeGreaterThan(960);

    await page.evaluate(() => (window as any).fitTest.size(2, 2));
    await expect.poll(width).toBe(400);
    await page.evaluate(() => (window as any).fitTest.controller.zoomIn());
    await expect.poll(width).toBe(400);
    await page.evaluate(() => (window as any).fitTest.controller.zoomOut());
    await expect.poll(width).toBe(200);
    await page.setViewportSize({ width: 900, height: 500 });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(900);
    expect(await width()).toBe(200);
    await page.evaluate(() => (window as any).fitTest.controller.resetZoom());
    await expect.poll(width).toBe(400);
  });
}

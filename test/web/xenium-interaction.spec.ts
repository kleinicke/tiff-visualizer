import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
const script = buildSync({ entryPoints: [path.join(root, 'media/modules/scene/scene-viewer.ts')], bundle: true, format: 'iife', globalName: 'SceneModule', write: false }).outputFiles[0].text;
async function open(page: Page, enabled: boolean) {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.setContent('<!doctype html><body><div id="scene-root"></div></body>');
  await page.addStyleTag({ content: readFileSync(path.join(root, 'media/xenium-viewer.css'), 'utf8') });
  await page.addScriptTag({ content: script });
  await page.evaluate(async scrollToZoom => {
    const w = window as any;
    // Synthetic pixels isolate camera/input behavior from TIFF and worker loading.
    const source = { levels: [{ index: 0, width: 1000, height: 800, reduction: 1, blockWidth: 256, blockHeight: 256 }], async readRegion(_level: number, rect: { width: number; height: number }) { return { ...rect, data: new Uint8Array(rect.width * rect.height) }; } };
    w.scene = await w.SceneModule.SceneViewer.create({ container: document.getElementById('scene-root'), sources: [source], names: ['Test'], pixelSizeUm: 1, scrollToZoom, getSettings: () => [{ visible: true, min: 0, max: 255, color: '#ffffff' }], getSolo: () => null });
    w.clicks = 0;
    w.scene.addOverlay({ draw() {}, onClick() { w.clicks++; return true; } });
  }, enabled);
}
const camera = (page: Page) => page.evaluate(() => (window as any).scene.currentCamera);
async function settle(page: Page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }

test('Xenium scale bar follows the zoom, hides, moves and stays clear of the readout', async ({ page }) => {
  await open(page, false);
  await page.addStyleTag({ content: readFileSync(path.join(root, 'media/imagePreview.css'), 'utf8') });
  await settle(page);
  const handle = page.locator('.measure-scale-bar-handle');
  const white = async (x: number, y: number) => page.evaluate(([px, py]) => Array.from((document.querySelector('.scene-canvas') as HTMLCanvasElement).getContext('2d')!.getImageData(px, py, 1, 1).data).slice(0, 3).join(), [x, y]);
  await expect(handle).toBeVisible();
  const box = (await handle.boundingBox())!;
  expect(await white(Math.round(box.x + box.width / 2), Math.round(box.y + 16))).toBe('255,255,255');
  const hud = (await page.locator('.scene-hud').boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(hud.y);

  await page.evaluate(() => (window as any).scene.setCamera({ scale: 2, x: -300, y: -300 }));
  await settle(page);
  const zoomed = (await handle.boundingBox())!;
  expect(zoomed.width).toBeLessThan(box.width * 4);
  expect(zoomed.width).not.toBe(box.width);
  expect([zoomed.x, zoomed.y]).toEqual([box.x, box.y]);
  await page.evaluate(() => (window as any).scene.setCamera({ scale: 2, x: -50, y: -700 }));
  await settle(page);
  expect(await handle.boundingBox()).toMatchObject({ x: zoomed.x, y: zoomed.y });

  await page.mouse.move(zoomed.x + zoomed.width / 2, zoomed.y + 16); await page.mouse.down();
  await page.mouse.move(zoomed.x + zoomed.width / 2 + 40, zoomed.y - 120, { steps: 6 }); await page.mouse.up();
  await settle(page);
  expect(await page.evaluate(() => (window as any).scene.hasCustomScaleBarPosition())).toBe(true);
  expect((await handle.boundingBox())!.y).toBeLessThan(zoomed.y - 80);
  await page.evaluate(() => (window as any).scene.resetScaleBarPosition());
  await settle(page);
  expect((await handle.boundingBox())!.y).toBeCloseTo(zoomed.y, 0);

  await page.evaluate(() => (window as any).scene.setShowScaleBar(false));
  await settle(page);
  await expect(handle).toBeHidden();
  await page.evaluate(() => (window as any).scene.setShowScaleBar(true));
  await settle(page);
  await expect(handle).toBeVisible();
});

for (const enabled of [false, true]) {
  test(`Xenium clicks and dragging respect scrollToZoom=${enabled}`, async ({ page }) => {
    await open(page, enabled);
    const initial = await camera(page);
    await page.mouse.click(400, 300);
    expect((await camera(page)).scale).toBe(initial.scale);
    expect(await page.evaluate(() => (window as any).clicks)).toBe(1);
    await page.mouse.move(400, 300); await page.mouse.down();
    await page.mouse.move(460, 330, { steps: 8 }); await page.mouse.up();
    const moved = await camera(page);
    expect(moved.scale).toBe(initial.scale);
    expect(moved.x - initial.x).toBeCloseTo(enabled ? 60 : 0, 5);
    expect(moved.y - initial.y).toBeCloseTo(enabled ? 30 : 0, 5);
    expect(await page.evaluate(() => (window as any).clicks)).toBe(1);
  });
}

test('Xenium wheel uses pointer anchoring and preserves it across fit boundaries', async ({ page }) => {
  await open(page, true);
  await page.evaluate(() => (window as any).scene.setCamera({ scale: 1, x: -100, y: -100 }));
  await page.mouse.move(300, 220);
  for (const deltaY of [100, 100, 100, -100, -100, -100]) {
    const before = await camera(page);
    const point = { x: (300 - before.x) / before.scale, y: (220 - before.y) / before.scale };
    await page.mouse.wheel(0, deltaY);
    await expect.poll(async () => (await camera(page)).scale).not.toBe(before.scale);
    const after = await camera(page);
    expect(Math.abs(after.x + point.x * after.scale - 300)).toBeLessThan(0.01);
    expect(Math.abs(after.y + point.y * after.scale - 220)).toBeLessThan(0.01);
  }
});

test('Xenium normal mode scrolls and modifier zoom anchors at the centre', async ({ page }) => {
  await open(page, false);
  await page.evaluate(() => (window as any).scene.setCamera({ scale: 2, x: -600, y: -500 }));
  await page.mouse.move(250, 180); await page.mouse.wheel(30, 100);
  await expect.poll(async () => (await camera(page)).y).toBe(-600);
  expect((await camera(page)).x).toBe(-630);
  expect((await camera(page)).scale).toBe(2);
  const before = await camera(page);
  const modifier = await page.evaluate(() => navigator.platform.toUpperCase().includes('MAC') ? 'Alt' : 'Control');
  await page.keyboard.down(modifier); await page.mouse.wheel(0, -100); await page.keyboard.up(modifier);
  await expect.poll(async () => (await camera(page)).scale).toBeGreaterThan(2);
  const after = await camera(page);
  expect(after.scale).toBeCloseTo(2 * 1.075, 6);
  expect(after.x + (400 - before.x) / before.scale * after.scale).toBeCloseTo(400, 6);
  expect(after.y + (300 - before.y) / before.scale * after.scale).toBeCloseTo(300, 6);
});

test('live Xenium mode change cancels dragging and gates double-click fit', async ({ page }) => {
  await open(page, true);
  await page.evaluate(() => (window as any).scene.setCamera({ scale: 2, x: -600, y: -500 }));
  await page.mouse.move(400, 300); await page.mouse.down(); await page.mouse.move(440, 320);
  await page.evaluate(() => (window as any).scene.setScrollToZoom(false));
  const stopped = await camera(page);
  await page.mouse.move(490, 370); await page.mouse.up();
  expect(await camera(page)).toEqual(stopped);
  expect(await page.evaluate(() => (window as any).clicks)).toBe(0);
  await page.mouse.dblclick(400, 300);
  expect((await camera(page)).scale).toBe(2);
  await page.evaluate(() => (window as any).scene.setScrollToZoom(true));
  await page.mouse.dblclick(400, 300);
  await expect.poll(async () => (await camera(page)).scale).toBeLessThan(1);
  await settle(page);
});

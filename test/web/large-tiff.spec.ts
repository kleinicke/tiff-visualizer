import { test, expect } from '@playwright/test';
import { fromFile } from 'geotiff';

// Opt-in real-file regression: TIFF_LARGE_SAMPLE=/path/to/large.tif
// npx playwright test --config web/playwright.config.ts large-tiff
const sample = process.env.TIFF_LARGE_SAMPLE;
test('opens a large scalar TIFF, picks original values, and streams zoomed detail', async ({ page }) => {
  test.skip(!sample, 'Set TIFF_LARGE_SAMPLE to a large single-page float32 TIFF');
  test.setTimeout(120_000);
  const source = await fromFile(sample!);
  try {
    const image = await source.getImage();
    await page.goto('/');
    await page.locator('#web-file-input').setInputFiles(sample!);
    const scene = page.locator('.pyramid-scene');
    await expect(scene).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('body')).toHaveClass(/ready/);
    await expect(scene).toHaveAttribute('data-scene-width', String(image.getWidth()));
    await expect(page.locator('.dataset-note')).toContainText('Generated preview');
    const size = await scene.locator('.pyramid-base').evaluate((el: HTMLCanvasElement) => ({ width: el.width, height: el.height }));
    expect(size.width).toBeLessThanOrEqual(4096);
    expect(size.height).toBeLessThanOrEqual(4096);

    const checkPicker = async () => {
      const box = (await scene.boundingBox())!;
      const viewport = page.viewportSize()!;
      const x = Math.min(viewport.width - 80, Math.max(80, box.x + box.width * 0.51));
      const y = Math.min(viewport.height - 100, Math.max(100, box.y + box.height * 0.53));
      await page.mouse.move(x - 2, y - 2);
      await page.mouse.move(x, y);
      const status = page.locator('#web-status-size');
      await expect(status).toContainText(/\d+x\d+/, { timeout: 15_000 });
      await expect(status).not.toContainText('overview', { timeout: 15_000 });
      const text = await status.innerText();
      const match = text.match(/(\d+)x(\d+)\s+([^\s]+)/)!;
      expect(match).toBeTruthy();
      const px = Number(match[1]), py = Number(match[2]);
      const rasters = await image.readRasters({ window: [px, py, px + 1, py + 1] });
      expect(match[3]).toBe(Number(rasters[0][0]).toPrecision(4));
    };
    await checkPicker();
    await page.locator('#web-status-zoom').click();
    await page.locator('#web-control-popover select[name="scale"]').selectOption('1');
    await page.locator('#web-control-popover button[type="submit"]').click();
    await expect(scene.locator('.pyramid-tile').first()).toBeVisible({ timeout: 30_000 });
    await checkPicker();
  } finally { await source.close(); }
});

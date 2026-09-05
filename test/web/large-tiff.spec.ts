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
    await expect(page.locator('.dataset-resolution')).toHaveAttribute('title', /Generated preview/);
    await expect(page.locator('.nav-overlay')).not.toContainText('Auto');
    const titleBox = (await page.locator('.dataset-title').boundingBox())!;
    const scaleBox = (await page.locator('.dataset-resolution').boundingBox())!;
    expect(Math.abs((titleBox.y + titleBox.height / 2) - (scaleBox.y + scaleBox.height / 2))).toBeLessThan(2);
    const before = await page.locator('.dataset-title-label').boundingBox();
    await page.locator('.nav-overlay').evaluate(el => el.classList.add('dataset-overlay--loading'));
    expect(await page.locator('.dataset-title-label').boundingBox()).toEqual(before);
    await page.locator('.nav-overlay').evaluate(el => el.classList.remove('dataset-overlay--loading'));
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
      // Resolution text is gone; wait for the actual original-value upgrade.
      await expect.poll(async () => {
        const current = (await status.innerText()).match(/(\d+)x(\d+)\s+([^\s]+)/);
        return current?.[3];
      }).toBe(Number(rasters[0][0]).toPrecision(4));
    };
    await checkPicker();
    for (const [scale, detail] of [['0.2', '1/4'], ['0.5', '1/2']]) {
      await page.locator('#web-status-zoom').click();
      await page.locator('#web-control-popover select[name="scale"]').selectOption(scale);
      await page.locator('#web-control-popover button[type="submit"]').click();
      await expect(page.locator('[data-resolution="detail"]')).toHaveText(detail, { timeout: 30_000 });
      await expect(page.locator('.nav-overlay')).not.toHaveClass(/dataset-overlay--loading/, { timeout: 30_000 });
      await expect(scene.locator('.pyramid-tile').first()).toBeVisible();
      const tiles = await scene.locator('.pyramid-tile').evaluateAll(elements =>
        elements.map(el => ({ width: (el as HTMLCanvasElement).width, height: (el as HTMLCanvasElement).height })));
      expect(tiles.every(tile => tile.width === image.getWidth() / Number(detail.slice(2)))).toBe(true);
      expect(tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0)).toBeLessThanOrEqual(32_000_000);
      await checkPicker();
    }
    await page.locator('#web-status-zoom').click();
    await page.locator('#web-control-popover select[name="scale"]').selectOption('1');
    await page.locator('#web-control-popover button[type="submit"]').click();
    await expect(scene.locator('.pyramid-tile').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-resolution="detail"]')).toHaveText('1:1');
    await checkPicker();
    // A new gesture while strips are in flight must converge on the latest zoom.
    for (const scale of ['2', '0.5', '1']) {
      await page.locator('#web-status-zoom').click();
      await page.locator('#web-control-popover select[name="scale"]').selectOption(scale);
      await page.locator('#web-control-popover button[type="submit"]').click();
    }
    await expect(page.locator('[data-resolution="detail"]')).toHaveText('1:1');
    await expect(page.locator('.nav-overlay')).not.toHaveClass(/dataset-overlay--loading/);
    await checkPicker();
  } finally { await source.close(); }
});

// A previously supported ~100 MP file must retain the ordinary full-raster path.
test('keeps a 100 MP TIFF at full resolution without a preview readout', async ({ page }) => {
  const medium = process.env.TIFF_MEDIUM_SAMPLE;
  test.skip(!medium, 'Set TIFF_MEDIUM_SAMPLE to the 100 MP example');
  test.setTimeout(120_000);
  const source = await fromFile(medium!);
  try {
    const image = await source.getImage();
    await page.goto('/');
    await page.locator('#web-file-input').setInputFiles(medium!);
    await expect(page.locator('body')).toHaveClass(/ready/, { timeout: 90_000 });
    const canvas = page.locator('body > canvas:not(.measure-overlay)');
    await expect(canvas).toBeVisible();
    await expect(canvas).toHaveJSProperty('width', image.getWidth(), { timeout: 90_000 });
    await expect(canvas).toHaveJSProperty('height', image.getHeight());
    await expect(page.locator('.pyramid-scene')).toHaveCount(0);
    await expect(page.locator('.nav-overlay')).toBeHidden();
  } finally { await source.close(); }
});

import { expect, test } from '@playwright/test';
import path from 'node:path';

test('serves the standalone scientific image viewer', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('Scientific Image Visualizer');
  await expect(
    page.getByRole('button', { name: /Drop images here/ })
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'About' })).toHaveAttribute(
    'href',
    'https://f-kleinicke.de/'
  );
  await expect(page.getByRole('link', { name: 'Impressum' })).toHaveAttribute(
    'href',
    'https://f-kleinicke.de/impressum.html'
  );
});

test('keeps the mobile file picker rendered for document providers', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const input = page.locator('#web-file-input');
  await expect(input).toHaveAttribute('multiple', '');
  expect(await input.getAttribute('accept')).toBeNull();
  expect(await input.evaluate(element => getComputedStyle(element).display)).not.toBe('none');
});

test('loads an image through the public browser host', async ({ page }) => {
  await page.goto('/');

  await page
    .locator('#web-file-input')
    .setInputFiles(path.resolve('test-samples/orientation_tag1.tif'));

  await expect(page.locator('body')).toHaveClass(/web-has-image/);
  await expect(page.locator('.web-brand small')).toHaveText('Local browser viewer');
  await expect(page.locator('body')).toHaveClass(/ready/, { timeout: 30_000 });
  await expect(page.locator('body > canvas:not(.measure-overlay)')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: 'Loading log' }).click();
  await expect(page.locator('#web-log-panel')).toBeVisible();
  await expect(page.locator('#web-log-output')).toContainText('📂 Opened 1: orientation_tag1.tif');
  await expect(page.locator('#web-log-output')).toContainText('[Perf] TIFF:');
  await expect(page.locator('#web-log-output')).toContainText(/total [\d.]+ms \| visible [\d.]+ms/);
  // The companion line says WHAT became visible, not just how long it took.
  await expect(page.locator('#web-log-output')).toContainText(
    /\[Visible\] TIFF: \d+x\d+,.*orientation_tag1\.tif/
  );
});

test('keeps separately opened images available as toolbar tabs', async ({ page }) => {
  await page.goto('/');
  const input = page.locator('#web-file-input');
  await input.setInputFiles(path.resolve('test-samples/orientation_tag1.tif'));
  await expect(page.locator('body > canvas:not(.measure-overlay)')).toBeVisible({ timeout: 30_000 });

  await input.setInputFiles(path.resolve('test-samples/orientation_tag2.tif'));
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab', { name: 'orientation_tag2.tif' })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('tab', { name: 'orientation_tag1.tif' }).click();
  await expect(page.getByRole('tab', { name: 'orientation_tag1.tif' })).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'orientation_tag1.tif' })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: 'Close orientation_tag2.tif' }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Close orientation_tag1.tif' })).toBeVisible();
  await page.getByRole('button', { name: 'Close orientation_tag1.tif' }).click();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Drop images here/ })).toBeVisible();
});

test('keeps display menus transient and lets explicit zoom sizing win', async ({ page }) => {
  await page.goto('/');
  await page
    .locator('#web-file-input')
    .setInputFiles(path.resolve('test-samples/orientation_tag1.tif'));

  const canvas = page.locator('body > canvas:not(.measure-overlay)');
  await expect(canvas).toBeVisible({ timeout: 30_000 });

  await page.locator('#web-status-normalization').click();
  await expect(page.locator('#web-control-popover')).toBeVisible();
  await page.locator('#web-status-normalization').click();
  await expect(page.locator('#web-control-popover')).toBeHidden();
  await page.locator('#web-status-normalization').click();
  await expect(page.locator('#web-control-popover')).toBeVisible();
  await page.locator('#web-status-size').click();
  await expect(page.locator('#web-control-popover')).toBeHidden();

  await page.locator('#web-status-zoom').click();
  await page.locator('#web-control-popover select[name="scale"]').selectOption('2');
  await page.locator('#web-control-popover button[type="submit"]').click();

  await expect(canvas).not.toHaveClass(/scale-to-fit/);
  const sizing = await canvas.evaluate(element => ({
    intrinsicWidth: (element as HTMLCanvasElement).width,
    inlineWidth: (element as HTMLElement).style.width,
    maxHeight: getComputedStyle(element).maxHeight,
  }));
  expect(sizing.inlineWidth).toBe(`${sizing.intrinsicWidth * 2}px`);
  expect(sizing.maxHeight).toBe('none');
});

test('honours explicit zoom width for a CZI canvas', async ({ page }) => {
  await page.goto('/');
  await page
    .locator('#web-file-input')
    .setInputFiles(path.resolve('test-samples/scientific/synthetic-stack.czi'));

  const canvas = page.locator('body > canvas:not(.measure-overlay)');
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await page.locator('#web-status-zoom').click();
  await page.locator('#web-control-popover select[name="scale"]').selectOption('5');
  await page.locator('#web-control-popover button[type="submit"]').click();

  const sizing = await canvas.evaluate(element => ({
    intrinsicWidth: (element as HTMLCanvasElement).width,
    inlineWidth: (element as HTMLElement).style.width,
    renderedWidth: element.getBoundingClientRect().width,
    flex: getComputedStyle(element).flex,
  }));
  expect(sizing.inlineWidth).toBe(`${sizing.intrinsicWidth * 5}px`);
  expect(sizing.renderedWidth).toBe(sizing.intrinsicWidth * 5);
  expect(sizing.flex).toMatch(/^0 0/);
});

/**
 * JPEG XL is decoded by a SECOND WebAssembly module, downloaded on demand.
 * Both halves of that are worth asserting through a real browser: that nothing
 * fetches the ~1.3 MB payload until a `.jxl` is actually opened (otherwise the
 * separate module buys nothing), and that once it is opened the file decodes
 * and renders — which exercises the decode worker, the module hand-off from
 * the main thread, and the shared scientific-array renderer together.
 */
test('fetches the JPEG XL decoder only when a .jxl is opened', async ({ page }) => {
  const jxlWasmRequests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('jxl-wasm.wasm')) { jxlWasmRequests.push(request.url()); }
  });

  await page.goto('/');
  await page
    .locator('#web-file-input')
    .setInputFiles(path.resolve('test-samples/orientation_tag1.tif'));
  await expect(page.locator('body > canvas:not(.measure-overlay)')).toBeVisible({ timeout: 30_000 });
  expect(jxlWasmRequests, 'opening a TIFF must not download the JPEG XL module').toEqual([]);

  await page
    .locator('#web-file-input')
    .setInputFiles(path.resolve('test-samples/standalone_gray16.jxl'));
  // The loading log names each opened file once it has decoded, so it is both
  // the "did it load" signal and the "which file" one.
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: 'Loading log' }).click();
  await expect(page.locator('#web-log-output')).toContainText('standalone_gray16.jxl', { timeout: 30_000 });
  await expect(page.locator('#web-status-size')).toContainText('64x48');
  expect(jxlWasmRequests.length, 'opening a .jxl must download the JPEG XL module').toBeGreaterThan(0);
});

/**
 * The heavy codecs — JPEG 2000, JPEG XR, LERC, LZMA, WebP — live in a second
 * WebAssembly module fetched only when a file's own header declares one. Both
 * halves are worth asserting through a real browser, because the whole point
 * of the split is what does NOT happen on the common path: an ordinary LZW
 * TIFF must not download it, and a LERC one must.
 */
test('fetches the codec module only for a file that needs a heavy codec', async ({ page }) => {
  const codecRequests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('codec-wasm.wasm')) { codecRequests.push(request.url()); }
  });

  await page.goto('/');
  await page
    .locator('#web-file-input')
    .setInputFiles(path.resolve('test-samples/shapes_lzw_tiled.tif'));
  await expect(page.locator('body > canvas:not(.measure-overlay)')).toBeVisible({ timeout: 30_000 });
  expect(codecRequests, 'an LZW TIFF must not download the codec module').toEqual([]);

  await page
    .locator('#web-file-input')
    .setInputFiles(path.resolve('test-samples/lerc_f32.tif'));
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: 'Loading log' }).click();
  await expect(page.locator('#web-log-output')).toContainText('lerc_f32.tif', { timeout: 30_000 });
  await expect(page.locator('#web-status-size')).toContainText('64x48');
  expect(codecRequests.length, 'a LERC TIFF must download the codec module').toBeGreaterThan(0);
});

/**
 * A standalone JPEG 2000 exercises the full routing chain in one file: the
 * registry claims `.jp2`, the decode worker answers with the
 * `[external-codec:JPEG 2000]` marker WITHOUT attempting a decode, the main
 * thread recognizes the marker and fetches the codec module, and the retry
 * decodes there. Every one of those steps is a place the wiring can be wrong
 * while each piece passes its own unit test.
 *
 * `standalone_gray12.jp2` is deliberately the 12-bit-in-16 fixture — the
 * Sentinel-2 shape this support exists for.
 */
test('opens a standalone JPEG 2000 through the codec module', async ({ page }) => {
  const codecRequests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('codec-wasm.wasm')) { codecRequests.push(request.url()); }
  });

  await page.goto('/');
  await page
    .locator('#web-file-input')
    .setInputFiles(path.resolve('test-samples/standalone_gray12.jp2'));
  await expect(page.locator('body > canvas:not(.measure-overlay)')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#web-status-size')).toContainText('64x48');
  expect(codecRequests.length, 'a .jp2 must download the codec module').toBeGreaterThan(0);
});

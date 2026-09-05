import { expect, test } from '@playwright/test';
import fs from 'node:fs';
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
  // No `[Visible]` line here on purpose: for a plain single-level image drawn
  // at its declared size it would only repeat the "📂 Opened" line above. It
  // appears when it has something to add — see the pyramid test below.
});

test('routes a misleading filename from its image header', async ({ page }) => {
  await page.goto('/');
  const source = fs.readFileSync(path.resolve('test-samples/house.tif'));

  await page.locator('#web-file-input').setInputFiles({
    name: 'actually-a-tiff.jpg',
    mimeType: 'image/jpeg',
    buffer: source,
  });

  const decoded = page.locator('body > canvas.scale-to-fit');
  await expect(decoded).toBeVisible({ timeout: 30_000 });
  await expect(decoded).toHaveJSProperty('width', 512);
  await expect(decoded).toHaveJSProperty('height', 512);
});

test('opens a DICOM image with no filename extension', async ({ page }) => {
  await page.goto('/');
  const source = fs.readFileSync(path.resolve('test-samples/scientific/synthetic-ct.dcm'));

  await page.locator('#web-file-input').setInputFiles({
    name: 'IM00001',
    mimeType: 'application/octet-stream',
    buffer: source,
  });

  const decoded = page.locator('body > canvas.scale-to-fit');
  await expect(decoded).toBeVisible({ timeout: 30_000 });
  await expect(decoded).toHaveJSProperty('width', 32);
  await expect(decoded).toHaveJSProperty('height', 24);
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
 * fetches the ~2.2 MB payload until JPEG XL is actually encountered (otherwise the
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

test('shows a pyramidal COG as levels of one image, not as pages', async ({ page }) => {
  await page.goto('/');

  await page
    .locator('#web-file-input')
    .setInputFiles(path.resolve('test-samples/cog_2band_pyramid.tif'));

  await expect(page.locator('body')).toHaveClass(/ready/, { timeout: 30_000 });

  // The three IFDs are one image at three resolutions. Offering them as
  // "Page 1 / 3" would describe something the file does not contain.
  const overlay = page.locator('.dataset-overlay');
  await expect(overlay.locator('.dataset-resolution')).toBeHidden();
  await expect(overlay.locator('.dataset-axis-label')).not.toContainText(['Level']);
  await expect(overlay).not.toContainText('Page');
  await expect(overlay.locator('select')).toHaveValue('0');

  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: 'Loading log' }).click();
  await expect(page.locator('#web-log-output')).toContainText('level 1/3 (Full · 256x256)');
});

test('opens an image from a link, and from ?url=', async ({ page }) => {
  // Served by the same host as the page, so this exercises the whole path —
  // fetch, name, decode, display — without depending on a remote service.
  await page.goto('/?url=' + encodeURIComponent('/icon.png'));

  await expect(page.locator('body')).toHaveClass(/web-has-image/, { timeout: 30_000 });
  await expect(page.locator('.web-image-tabs')).toContainText('icon.png');

  // And through the form on the empty state.
  await page.goto('/');
  await page.locator('#web-url-input').fill('/og.png');
  await page.locator('.web-url-submit').click();
  await expect(page.locator('.web-image-tabs')).toContainText('og.png', { timeout: 30_000 });
});

test('says plainly when a link cannot be read', async ({ page }) => {
  await page.goto('/');
  await page.locator('#web-url-input').fill('/does-not-exist.tif');
  await page.locator('.web-url-submit').click();
  // A 404 is reported as what it is; a cross-origin refusal reaches script
  // without a reason, so that case gets the generic advice instead.
  await expect(page.locator('.web-toast-region')).toContainText('404');
  await expect(page.getByRole('tab', { name: 'does-not-exist.tif', exact: true })).toHaveCount(0);
});

test('reports an HTTP refusal before opening a TIFF tab', async ({ page }) => {
  await page.route('**/forbidden.tif', route => route.fulfill({ status: 403, body: 'Forbidden' }));
  await page.goto('/');
  await page.locator('#web-url-input').fill('/forbidden.tif');
  await page.locator('.web-url-submit').click();
  await expect(page.locator('.web-toast-region')).toContainText('403');
  await expect(page.getByRole('tab', { name: 'forbidden.tif', exact: true })).toHaveCount(0);
});

test('cycles how pixels with no value are drawn', async ({ page }) => {
  await page.goto('/');
  await page
    .locator('#web-file-input')
    .setInputFiles(path.resolve('test-samples/cog_2band_pyramid.tif'));
  await expect(page.locator('body')).toHaveClass(/ready/, { timeout: 30_000 });

  // A pixel inside the fixture's nodata block.
  const noValuePixel = () => page.evaluate(() => {
    const canvas = document.querySelector('body > canvas:not(.measure-overlay)') as HTMLCanvasElement;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const data = context.getImageData(20, 20, 1, 1).data;
    return [data[0], data[1], data[2], data[3]];
  });
  // A pixel with real data, used to tell "not painted yet" from "painted".
  const dataPixel = () => page.evaluate(() => {
    const canvas = document.querySelector('body > canvas:not(.measure-overlay)') as HTMLCanvasElement;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const data = context.getImageData(128, 128, 1, 1).data;
    return [data[0], data[1], data[2], data[3]];
  });
  const cycle = async () => {
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: 'Cycle no-value colour' }).click();
    await page.waitForTimeout(600);
  };

  // `ready` lands before the first paint, so wait for real content rather than
  // sampling an empty canvas.
  await expect.poll(async () => (await dataPixel())[3], { timeout: 30_000 }).toBe(255);

  expect(await noValuePixel()).toEqual([0, 0, 0, 255]);
  await cycle();
  expect(await noValuePixel()).toEqual([255, 0, 255, 255]);
  await cycle();
  // Transparent: a hole, plus a checkerboard behind the canvas so the hole
  // does not read as a black pixel in a dark theme.
  expect(await noValuePixel()).toEqual([0, 0, 0, 0]);
  await expect(page.locator('.container.image')).toHaveAttribute('data-no-value-transparent', '');
  await cycle();
  expect(await noValuePixel()).toEqual([0, 0, 0, 255]);
});

test('chooses COG resolution automatically and keeps band selection', async ({ page }) => {
  await page.goto('/');
  await page
    .locator('#web-file-input')
    .setInputFiles(path.resolve('test-samples/cog_2band_pyramid.tif'));
  await expect(page.locator('body')).toHaveClass(/ready/, { timeout: 30_000 });

  // This fixture is far below the size where a reduced level would be worth
  // the approximate readout, so it opens at full resolution and the readout
  // carries no overview note.
  await expect(page.locator('.dataset-resolution')).toBeHidden();
  const canvas = page.locator('body > canvas:not(.measure-overlay)');
  const box = await canvas.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.move(box.x + box.width * 0.5 + 3, box.y + box.height * 0.5 + 3);
  }
  await expect(page.locator('#web-status-size')).not.toContainText('overview');

  await expect(page.locator('.dataset-resolution')).toBeHidden();
  await expect(page.locator('.dataset-axis-label')).not.toContainText(['Level']);
  await expect(page.locator('.dataset-overlay select')).toHaveCount(1);
  await page.locator('.dataset-overlay select').selectOption('1');
  await expect(page.locator('.dataset-overlay select')).toHaveValue('1');

});

test('reads original COG pixels with automatic resolution', async ({ page }) => {
  await page.goto('/');
  await page
    .locator('#web-file-input')
    .setInputFiles(path.resolve('test-samples/cog_2band_pyramid.tif'));
  await expect(page.locator('body')).toHaveClass(/ready/, { timeout: 30_000 });

  const canvas = page.locator('body > canvas:not(.measure-overlay):not(.detail-patch)');
  await expect.poll(async () => {
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + (159.5 / 256) * box.width, box.y + (97.5 / 256) * box.height);
    await page.mouse.move(box.x + (160.5 / 256) * box.width, box.y + (98.5 / 256) * box.height);
    return page.locator('#web-status-size').innerText();
  }).toContain('160x98');
  await expect(page.locator('#web-status-size')).toContainText('0.758');
  await expect(page.locator('#web-status-size')).not.toContainText('overview');
});

test('draws a sharp patch of a finer level over the visible area', async ({ page }) => {
  // Needs a pyramid whose full resolution is past the size worth decoding
  // whole, which is the only situation where a patch is the right answer — so
  // it needs a genuinely large file rather than a fixture.
  const corpusFile = '/Users/florian/Projects/cursor/test_data/cog/big_40000px_cog.tif';
  test.skip(!fs.existsSync(corpusFile), 'corpus file not present');

	await page.goto('/');
	await page.locator('#web-file-input').setInputFiles(corpusFile);
	await expect(page.locator('body')).toHaveClass(/ready/, { timeout: 120_000 });
	await page.waitForTimeout(2500);

	// Zoom in on Auto. The base settles at the budget; retained FULL-resolution
	// tiles cover the visible area without allocating a scene-sized canvas.
	await page.evaluate(() => window.postMessage({ type: 'setScale', scale: 16 }, '*'));
	const tiles = page.locator('.pyramid-scene > canvas.pyramid-tile');
	await expect.poll(() => tiles.count(), { timeout: 60_000 }).toBeGreaterThan(0);

	const resolution = page.locator('.dataset-resolution');
	await expect(resolution.locator('[data-resolution="detail"]')).toHaveText('1:1');
	await expect(resolution).toHaveAttribute('title', /\d+ tiles?, each \d+x\d+px/);
	await expect(page.locator('.dataset-axis-label')).not.toContainText(['Level']);

});

test('keeps band controls collapsible and stable while loading at full resolution', async ({ page }) => {
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles(path.resolve('test-samples/cog_2band_pyramid.tif'));
  await expect(page.locator('body')).toHaveClass(/ready/, { timeout: 30_000 });
  const overlay = page.locator('.nav-overlay');
  await overlay.locator('.dataset-title').click();
  await expect(overlay).toHaveClass(/dataset-overlay--collapsed/);
  await expect(overlay.locator('.dataset-resolution')).toBeHidden();
  await expect(overlay.locator('.dataset-axis-controls')).toBeHidden();
  const before = await overlay.locator('.dataset-title-label').boundingBox();
  await overlay.evaluate(el => el.classList.add('dataset-overlay--loading'));
  expect(await overlay.locator('.dataset-title-label').boundingBox()).toEqual(before);
  await overlay.evaluate(el => el.classList.remove('dataset-overlay--loading'));
  expect(await overlay.locator('.dataset-title-label').boundingBox()).toEqual(before);
  await overlay.locator('.dataset-title').click();
  await expect(overlay).not.toHaveClass(/dataset-overlay--collapsed/);
  await expect(overlay.locator('.dataset-axis-controls')).toBeVisible();
});

test('leaves an ordinary TIFF completely alone', async ({ page }) => {
  // The dynamic behaviour belongs to multi-resolution files. A plain image must
  // get no level control, no status line and no patch — the same viewer it was.
  await page.goto('/?regionDecode=1');
  await page
    .locator('#web-file-input')
    .setInputFiles(path.resolve('test-samples/house.tif'));
  await expect(page.locator('body')).toHaveClass(/ready/, { timeout: 30_000 });
  await expect(page.locator('body > canvas:not(.measure-overlay)')).toBeVisible();

  await expect(page.locator('.dataset-overlay')).toBeHidden();
  await expect(page.locator('canvas.detail-patch')).toHaveCount(0);
});

/**
 * The bug this pins: zooming into a very large pyramid chose a level the size
 * check accepted and the renderer then refused, so the decode was paid for and
 * the view went transparent — followed by a fallback decode that took half a
 * minute. Both limits now come from one constant; this asserts the outcome.
 */
test('zooming a gigapixel pyramid never asks for more than can be drawn', async ({ page }) => {
  const corpusFile = '/Users/florian/Projects/cursor/test_data/cog/big_40000px_cog.tif';
  test.skip(!fs.existsSync(corpusFile), 'corpus file not present');

  const problems: string[] = [];
  page.on('console', message => {
    const text = message.text();
    if (/\[Canvas\].*limit|geotiff\.js \(main thread\)/.test(text)) { problems.push(text); }
  });

  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles(corpusFile);
  await expect(page.locator('body')).toHaveClass(/ready/, { timeout: 120_000 });
  await page.waitForTimeout(2500);

  await page.evaluate(() => window.postMessage({ type: 'setScale', scale: 16 }, '*'));
  await page.waitForTimeout(9000);

  const canvas = await page.evaluate(() => {
    const element = document.querySelector('body > canvas:not(.measure-overlay):not(.detail-patch)') as HTMLCanvasElement;
    if (!element) { return null; }
    const context = element.getContext('2d', { willReadFrequently: true });
    // A WebGL-rendered canvas has no 2D context; that it exists at the chosen
    // size is what matters here.
    const middle = context?.getImageData(Math.floor(element.width / 2), Math.floor(element.height / 2), 1, 1).data;
    return { width: element.width, height: element.height, alpha: middle ? middle[3] : 255 };
  });

  expect(canvas, 'an image must be on screen').not.toBeNull();
  expect(canvas!.width * canvas!.height).toBeLessThanOrEqual(268_435_456);
  expect(canvas!.alpha, 'the view must not be transparent').toBe(255);
  expect(problems, 'no refused render and no main-thread geotiff.js fallback').toEqual([]);
});

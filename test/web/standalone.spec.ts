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
  await expect(overlay).toContainText('Level');
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

test('picks a pyramid level for the window, and pins the one you choose', async ({ page }) => {
  await page.goto('/');
  await page
    .locator('#web-file-input')
    .setInputFiles(path.resolve('test-samples/cog_2band_pyramid.tif'));
  await expect(page.locator('body')).toHaveClass(/ready/, { timeout: 30_000 });

  // This fixture is far below the size where a reduced level would be worth
  // the approximate readout, so it opens at full resolution and the readout
  // carries no overview note.
  await expect(page.locator('.dataset-overlay')).toContainText('Full · 256x256');
  const canvas = page.locator('body > canvas:not(.measure-overlay)');
  const box = await canvas.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.move(box.x + box.width * 0.5 + 3, box.y + box.height * 0.5 + 3);
  }
  await expect(page.locator('#web-status-size')).not.toContainText('overview');

  // Choosing a level by hand pins it: index 0 is Auto, so index 2 is the first
  // reduced level. The status line follows the choice, and stays there.
  await page.locator('.dataset-overlay select').selectOption({ index: 2 });
  await expect(page.locator('.dataset-overlay')).toContainText('1/2 · 128x128', { timeout: 30_000 });
  await page.waitForTimeout(600);
  await expect(page.locator('.dataset-overlay')).toContainText('1/2 · 128x128');
  await expect(page.locator('.dataset-overlay select')).toHaveValue('2');
});

test('reads the value stored under the cursor while an overview is displayed', async ({ page }) => {
  await page.goto('/');
  await page
    .locator('#web-file-input')
    .setInputFiles(path.resolve('test-samples/cog_2band_pyramid.tif'));
  await expect(page.locator('body')).toHaveClass(/ready/, { timeout: 30_000 });

  // Pin the 1/2 level, so what is DISPLAYED is a decimation of the stored
  // pixels (index 0 is Auto, index 1 is full resolution).
  await page.locator('.dataset-overlay select').selectOption({ index: 2 });
  await expect(page.locator('.dataset-note')).toContainText('1/2', { timeout: 30_000 });

  // Aim at a known pixel of that level. The fixture's overviews are [::2, ::2],
  // so level pixel (80, 49) is the average-free copy of stored pixel (160, 98)
  // — and the two hold different values, which is what makes this test able to
  // tell an exact read from a displayed one.
  const canvas = page.locator('body > canvas:not(.measure-overlay):not(.detail-patch)');
  const box = (await canvas.boundingBox())!;
  const at = (x: number, y: number) => ({
    x: box.x + ((x + 0.5) / 128) * box.width,
    y: box.y + ((y + 0.5) / 128) * box.height,
  });
  await page.mouse.move(at(79, 48).x, at(79, 48).y);
  await page.mouse.move(at(80, 49).x, at(80, 49).y);

  // Positions are the IMAGE's, not the level's: 128 pixels of a 1/2 level are
  // 256 pixels of the image, and a readout that counted to 128 would be
  // describing the machinery rather than the picture.
  await expect(page.locator('#web-status-size')).toContainText('160x98');

  // And the value settles onto the one actually stored there (804), not the
  // level's own sample (758).
  await expect(page.locator('#web-status-size')).toContainText('804', { timeout: 10_000 });
  await expect(page.locator('#web-status-size')).not.toContainText('overview');
});

test('draws a sharp patch of a finer level over the visible area', async ({ page }) => {
  // Needs a pyramid whose full resolution is past the size worth decoding
  // whole, which is the only situation where a patch is the right answer — so
  // it needs a genuinely large file rather than a fixture.
  const corpusFile = '/Users/florian/Projects/cursor/test_data/cog/big_40000px_cog.tif';
  test.skip(!fs.existsSync(corpusFile), 'corpus file not present');

  const detail: string[] = [];
  page.on('console', message => {
    if (message.text().startsWith('[Detail]')) { detail.push(message.text()); }
  });

  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles(corpusFile);
  await expect(page.locator('body')).toHaveClass(/ready/, { timeout: 120_000 });
  await page.waitForTimeout(2500);

  // Zoom in on Auto. The base settles at the budget; the patch covers what is
  // on screen from the FULL level, which no canvas could hold whole.
  await page.evaluate(() => window.postMessage({ type: 'setScale', scale: 16 }, '*'));
  const patch = page.locator('canvas.detail-patch');
  await expect(patch).toHaveCount(1, { timeout: 60_000 });
  expect(detail.join(' ')).toContain('Full · 40000x40000');

  // The rectangle the log says was decoded, and where the patch was put.
  const match = /over (\d+)x(\d+) at (\d+),(\d+)/.exec(detail[detail.length - 1] || '');
  expect(match, `no decoded rectangle in ${JSON.stringify(detail)}`).not.toBeNull();
  const [, rectWidth, rectHeight, rectX, rectY] = match!.map(Number);

  const placement = await page.evaluate(() => {
    const base = document.querySelector('body > canvas:not(.measure-overlay):not(.detail-patch)') as HTMLCanvasElement;
    const patchEl = document.querySelector('canvas.detail-patch') as HTMLCanvasElement;
    const baseRect = base.getBoundingClientRect();
    const patchRect = patchEl.getBoundingClientRect();
    return {
      baseWidth: base.width,
      baseCssWidth: baseRect.width,
      offsetX: patchRect.left - baseRect.left,
      offsetY: patchRect.top - baseRect.top,
      cssWidth: patchRect.width,
      patchPixels: [patchEl.width, patchEl.height],
    };
  });

  // The patch holds exactly the pixels that were decoded.
  expect(placement.patchPixels).toEqual([rectWidth, rectHeight]);

  // And the status line names it. Reporting only the base level reads as
  // "this is all you are seeing" while full-resolution pixels are on screen.
  await expect(page.locator('.dataset-note')).toContainText('Visible detail: Full ·');
  await expect(page.locator('.dataset-note')).toContainText(`${rectWidth}x${rectHeight} px`);

  // And it sits exactly over them: converting its position back into
  // full-resolution pixels must return the rectangle's own origin. A patch
  // placed a tile out would show the right pixels in the wrong place, which is
  // the failure this pins.
  const fullPerBaseCss = (40000 / placement.baseCssWidth);
  expect(Math.round(placement.offsetX * fullPerBaseCss)).toBe(rectX);
  expect(Math.round(placement.offsetY * fullPerBaseCss)).toBe(rectY);
  expect(Math.round(placement.cssWidth * fullPerBaseCss)).toBe(rectWidth);
});

test('a level chosen by hand turns the patch off', async ({ page }) => {
  const corpusFile = '/Users/florian/Projects/cursor/test_data/cog/big_40000px_cog.tif';
  test.skip(!fs.existsSync(corpusFile), 'corpus file not present');

  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles(corpusFile);
  await expect(page.locator('body')).toHaveClass(/ready/, { timeout: 120_000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.postMessage({ type: 'setScale', scale: 16 }, '*'));
  await expect(page.locator('canvas.detail-patch')).toHaveCount(1, { timeout: 60_000 });

  // Pinning a level says which resolution to look at; a finer one laid over it
  // would contradict that.
  await page.locator('.dataset-overlay select').selectOption({ index: 5 });
  await expect(page.locator('canvas.detail-patch')).toHaveCount(0, { timeout: 60_000 });

  // Auto takes the decision back, and the patch with it.
  await page.locator('.dataset-overlay select').selectOption({ index: 0 });
  await expect(page.locator('canvas.detail-patch')).toHaveCount(1, { timeout: 60_000 });
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

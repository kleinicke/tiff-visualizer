import { expect, test } from '@playwright/test';
import * as path from 'node:path';

async function open(page: import('@playwright/test').Page, name = 'pred_ref_rgb8.tif') {
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles(path.resolve('test-samples', name));
  await expect(page.locator('body')).toHaveClass(/ready/, { timeout: 30_000 });
}
async function command(page: import('@playwright/test').Page, type: string) {
  await page.evaluate(type => window.postMessage({ type }, '*'), type);
}

test('Svelte metadata and histogram retain their complete data and interactions', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await open(page);
  await command(page, 'toggleMetadata');
  const metadata = page.locator('.metadata-panel');
  await expect(metadata).toBeVisible();
  await expect(metadata).toContainText('Statistics');
  await expect(metadata).toContainText('TIFF Tags');
  await page.screenshot({ path: testInfo.outputPath('metadata.png') });
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text: string) => { (window as any).copiedMetadata = JSON.parse(text); } }));
  await metadata.getByRole('button', { name: 'Copy as JSON' }).click();
  await expect(metadata.getByRole('button', { name: 'Copied!' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).copiedMetadata.tags.length)).toBeGreaterThan(0);
  await metadata.getByTitle('Close metadata panel').click();
  await expect(metadata).toBeHidden();
  await command(page, 'toggleHistogram');
  const histogram = page.locator('.histogram-overlay');
  await expect(histogram).toBeVisible();
  await expect(histogram.locator('.histogram-stat-line').first()).not.toBeEmpty();
  await histogram.getByTitle('Toggle Linear/Sqrt scale').click();
  await expect(histogram.getByTitle('Toggle Linear/Sqrt scale')).toHaveText('Linear Mode');
  await histogram.locator('canvas').hover();
  await expect(histogram.locator('.histogram-tooltip')).toBeVisible();
  await expect(histogram.locator('.histogram-tooltip')).toContainText('Value:');
  await histogram.getByTitle('Close histogram').click();
  await expect(histogram).toBeHidden();
  expect(errors).toEqual([]);
});

test('Svelte channels retain slider identity, solo and composite state', async ({ page }, testInfo) => {
  await open(page);
  await command(page, 'toggleChannels');
  const panel = page.locator('.channels-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.channel-row')).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath('channels.png') });
  await panel.getByRole('button', { name: 'Composite', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Composite', exact: true })).toHaveClass(/active/);
  const first = panel.locator('.channel-row').first();
  await first.getByRole('button', { name: 'Solo' }).click();
  await expect(first.getByRole('button', { name: 'Solo' })).toHaveClass(/active/);
  await expect(panel.locator('.channel-row.dimmed')).toHaveCount(2);
  // Channels start folded to their first row; the sliders are in the unfolded part.
  await first.locator('.channel-fold').click();
  const slider = first.getByTitle('Channel opacity');
  await slider.evaluate((element: HTMLInputElement) => {
    (window as any).channelSlider = element;
    element.value = '40'; element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(slider).toHaveValue('40');
  expect(await slider.evaluate(element => element === (window as any).channelSlider)).toBe(true);
  // The image viewer's panel starts with All channels folded.
  await panel.locator('summary', { hasText: 'All channels' }).click();
  await panel.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(panel.locator('.channel-row.dimmed')).toHaveCount(0);
});

test('Svelte debayer restores pattern controls, gains, phase and fourth-channel availability', async ({ page }, testInfo) => {
  await open(page, 'png_u16_gray.png');
  await command(page, 'toggleDebayer');
  const panel = page.locator('.debayer-panel');
  await expect(panel).toBeVisible();
  await panel.getByLabel('Pattern', { exact: true }).selectOption('quad_rggb');
  await expect(panel.locator('.debayer-label')).toContainText(['Phase (0-3)']);
  await panel.locator('[data-axis="X"]').click();
  await expect(panel.locator('[data-axis="X"]')).toHaveText('X: 1');
  await panel.getByTitle('R gain', { exact: true }).fill('1.75');
  await panel.getByTitle('R gain', { exact: true }).press('Tab');
  await expect(panel.getByTitle('R gain', { exact: true })).toHaveValue('1.75');
  await expect(panel.locator('[data-view="i"]')).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('debayer.png') });
  await panel.getByTitle('Close debayer panel').click();
  await command(page, 'toggleDebayer');
  await expect(panel.getByLabel('Pattern', { exact: true })).toHaveValue('quad_rggb');
  await expect(panel.locator('[data-axis="X"]')).toHaveText('X: 1');
});

test('embedded JetBrains controls use the Svelte forms and narrow panels stay reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await page.goto('/?host=jetbrains');
  await page.locator('#web-file-input').setInputFiles(path.resolve('test-samples/pred_ref_rgb8.tif'));
  // The bootstrap frame is already ready; wait for the selected image to replace it.
  await expect.poll(() => page.locator('body > canvas:not(.measure-overlay)').evaluate((element: HTMLCanvasElement) => element.width)).toBeGreaterThan(1);
  await expect(page.locator('.web-toolbar')).toBeHidden();
  await page.evaluate(() => {
    (window as any).scientificImageHost.theme('light');
    (window as any).scientificImageHost.statusAction('gamma');
  });
  await page.getByLabel('Source gamma').fill('1');
  await page.getByLabel('Target gamma').fill('2.2');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('#web-status-gamma')).toContainText('1.0→2.2');
  await command(page, 'toggleMetadata');
  const panel = page.locator('.metadata-panel');
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await panel.getByTitle('Close metadata panel').click();
  await expect(panel).toBeHidden();
});


test('Svelte layers edit, rename, and apply every adjustment type', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await open(page);
  await page.locator('#web-file-input').evaluate((input: HTMLInputElement) => { input.dataset.mode = 'layers'; });
  await page.locator('#web-file-input').setInputFiles(path.resolve('test-samples/pred_ref_rgb8.tif'));
  const panel = page.locator('.layers-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.layer-row')).toHaveCount(2);
  const row = panel.locator('.layer-row').first();
  await row.locator('.layer-name').dblclick();
  await row.locator('.layer-name-input').fill('Renamed layer');
  await row.locator('.layer-name-input').press('Enter');
  await expect(row.locator('.layer-name')).toHaveText('Renamed layer');
  await row.locator('.layer-name').dblclick();
  await row.locator('.layer-name-input').fill('Cancelled rename');
  await row.locator('.layer-name-input').press('Escape');
  await expect(row.locator('.layer-name')).toHaveText('Renamed layer');
  await expect(panel.locator('.layers-compositor-select')).toBeHidden();
  await panel.getByText('Rendering diagnostics', { exact: true }).click();
  await expect(panel.locator('.layers-compositor-select')).toBeVisible();
  await panel.getByText('Rendering diagnostics', { exact: true }).click();
  await row.locator('.layer-opacity').evaluate(element => { (window as any).retainedLayerSlider = element; });
  await row.locator('.layer-opacity').fill('60');
  await expect(row.locator('.layer-opacity-value')).toHaveText('60%');
  expect(await row.locator('.layer-opacity').evaluate(element => element === (window as any).retainedLayerSlider)).toBe(true);
  await row.locator('.layer-filter-toggle-inline').click();
  const types = ['levels', 'levels', 'curves', 'hue/saturation', 'brightness/contrast', 'exposure', 'invert', 'channel mixer', 'color balance', 'black & white', 'threshold', 'posterize', 'gradient map'];
  for (const type of types) {
    await panel.locator('.layer-add-filter').first().selectOption(type);
    await expect(panel.locator('.layer-add-filter').first()).toHaveValue('');
    const editor = panel.locator('.layer-adjustment-editor').first();
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('open', '');
    const range = editor.locator('input[type=range]').first();
    if (await range.count()) { await range.press('ArrowRight'); await range.press('Tab'); }
    await editor.getByRole('button', { name: 'Remove filter', exact: true }).click();
    await expect(panel.locator('.layer-row-adjustment')).toHaveCount(0);
  }
  await page.screenshot({ path: testInfo.outputPath('layers.png') });
  expect(errors).toEqual([]);
});

test('Svelte measurement tabs preserve ROI measurements, derived columns, scale and segmentation', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await open(page);
  await command(page, 'toggleMeasure');
  const panel = page.locator('.measure-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Brush', exact: true }).click();
  await panel.getByLabel('Radius (px)', { exact: true }).fill('5');
  await panel.getByLabel('Radius (px)', { exact: true }).press('Tab');
  await page.evaluate(() => window.postMessage({ type: 'measureImportResult', kind: 'sidecar', bytes: Array.from(new TextEncoder().encode(JSON.stringify({version:1,rois:[{kind:'rect',id:'known',name:'Known rectangle',x:1,y:1,width:4,height:3}]}))) }, '*'));
  await panel.locator('.measure-tab').getByText('ROIs', { exact: true }).click();
  await expect(panel.locator('.measure-roi-name')).toHaveValue('Known rectangle');
  await panel.locator('.measure-roi-name').fill('Renamed ROI');
  await panel.locator('.measure-roi-name').press('Tab');
  await panel.locator('.measure-tab').getByText('Results', { exact: true }).click();
  await expect(panel.locator('.measure-results-wrapper tbody tr')).toHaveCount(1);
  await expect(panel.locator('.measure-results-wrapper tbody tr')).toContainText('Renamed ROI');
  await expect(panel.locator('.measure-results-wrapper tbody tr td').nth(2)).toHaveText('12');
  await panel.getByRole('button', { name: 'Add column', exact: true }).click();
  await panel.getByLabel('Column expression', { exact: true }).fill('area * 2');
  await panel.getByLabel('Column expression', { exact: true }).press('Tab');
  await expect(panel.locator('.measure-results-wrapper tbody tr td').last()).toHaveText('24');
  await panel.locator('.measure-tab').getByText('Scale', { exact: true }).click();
  await panel.getByLabel('Pixel width', { exact: true }).evaluate(element => { (window as any).retainedScaleInput = element; });
  await panel.getByLabel('Pixel width', { exact: true }).fill('2');
  await panel.getByLabel('Pixel width', { exact: true }).press('Tab');
  expect(await panel.getByLabel('Pixel width', { exact: true }).evaluate(element => element === (window as any).retainedScaleInput)).toBe(true);
  await panel.locator('.measure-tab').getByText('Results', { exact: true }).click();
  await expect(panel.locator('.measure-results-wrapper tbody tr td').nth(2)).toHaveText('24');
  await panel.locator('.measure-tab').getByText('Segment', { exact: true }).click();
  await expect(panel.locator('.measure-method').filter({ hasText: 'Otsu' })).toBeEnabled({timeout:30_000});
  await panel.locator('.measure-method').filter({ hasText: 'Otsu' }).click();
  await expect(panel.locator('.measure-method.active')).toContainText('Otsu');
  await panel.getByLabel('Min area (px)', { exact: true }).evaluate(element => { (window as any).retainedSegmentInput = element; });
  await panel.getByLabel('Min area (px)', { exact: true }).fill('2');
  await panel.getByLabel('Min area (px)', { exact: true }).press('Tab');
  expect(await panel.getByLabel('Min area (px)', { exact: true }).evaluate(element => element === (window as any).retainedSegmentInput)).toBe(true);
  await expect(panel.locator('.measure-histogram')).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('measurement.png')});
  expect(errors).toEqual([]);
});

test('image actions are grouped by task and stay reachable in a narrow view', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await open(page);
  await page.locator('#web-status-options').click();
  const menu = page.locator('.custom-context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.context-menu-heading')).toHaveText(['Display', 'Inspect', 'File']);
  await expect(menu.getByRole('menuitem', { name: 'Toggle Histogram', exact: true })).toBeVisible();
  const bounds = await menu.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(740);
  await page.screenshot({ path: testInfo.outputPath('actions.png') });
  await menu.getByRole('menuitem', { name: 'Toggle Histogram', exact: true }).click();
  await expect(page.locator('.histogram-overlay')).toBeVisible();
});

for (const backend of ['auto', 'gpu']) {
  test(`a failed layer GPU render ${backend === 'auto' ? 'falls back automatically' : 'reports a forced-backend error'}`, async ({ page }) => {
    const errors: string[] = [], logs: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => logs.push(message.text()));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
      const original = HTMLCanvasElement.prototype.getContext;
      const wrapped = new WeakSet<object>();
      HTMLCanvasElement.prototype.getContext = function (type: string, ...args: any[]) {
        const context = original.call(this, type as any, ...args) as any;
        if (type === 'webgl2' && context && !wrapped.has(context)) {
          wrapped.add(context);
          const finish = context.finish.bind(context);
          context.finish = () => {
            if ((window as any).failNextLayerRender) {
              (window as any).failNextLayerRender = false;
              throw new Error('Injected GPU submission failure');
            }
            finish();
          };
        }
        return context;
      } as typeof original;
    });
    await open(page);
    test.skip(!await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2')), 'Requires a usable WebGL context to inject a runtime failure');
    await page.locator('#web-file-input').evaluate((input: HTMLInputElement) => { input.dataset.mode = 'layers'; });
    await page.locator('#web-file-input').setInputFiles({ name: 'failure-probe.ppm', mimeType: 'application/octet-stream',
      buffer: Buffer.concat([Buffer.from('P6\n4 4\n255\n'), Buffer.alloc(4 * 4 * 3, 255)]) });
    const panel = page.locator('.layers-panel');
    await expect(panel.locator('.layer-row')).toHaveCount(2);
    await panel.getByText('Rendering diagnostics', { exact: true }).click();
    await panel.locator('.layers-compositor-select').selectOption(backend);
    await expect(panel.locator('.layers-diagnostics small')).toContainText('Active: gpu');
    await expect.poll(() => logs.some(line => line.includes('webgl2 native'))).toBe(true);
    const readPixel = () => page.locator('body > canvas:not(.measure-overlay)').first().evaluate((canvas: HTMLCanvasElement) =>
      Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data).join(','));
    const before = await readPixel();
    await page.evaluate(() => { (window as any).failNextLayerRender = true; });
    await panel.locator('.layer-opacity').first().fill('60');
    if (backend === 'auto') {
      await expect(panel.locator('.layers-diagnostics small')).toContainText(/Active: (wasm|javascript)/);
      await expect.poll(readPixel).not.toBe(before);
      expect(errors).toEqual([]);
    } else {
      await expect.poll(() => errors.some(message => message.includes('Injected GPU submission failure'))).toBe(true);
      await expect(panel.locator('.layers-diagnostics small')).toContainText('Active: gpu');
      expect(logs.some(line => line.includes('selecting a fallback'))).toBe(false);
    }
  });
}

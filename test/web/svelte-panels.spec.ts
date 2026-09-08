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
  const slider = first.getByTitle('Channel opacity');
  await slider.evaluate((element: HTMLInputElement) => {
    (window as any).channelSlider = element;
    element.value = '40'; element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(slider).toHaveValue('40');
  expect(await slider.evaluate(element => element === (window as any).channelSlider)).toBe(true);
  await panel.getByRole('button', { name: 'Show all', exact: true }).click();
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
  await expect(page.locator('body')).toHaveClass(/ready/);
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
  await row.locator('.layer-opacity').fill('60');
  await expect(row.locator('.layer-opacity-value')).toHaveText('60%');
  await row.locator('.layer-filter-toggle-inline').click();
  const types = ['levels', 'curves', 'hue/saturation', 'brightness/contrast', 'exposure', 'invert', 'channel mixer', 'color balance', 'black & white', 'threshold', 'posterize', 'gradient map'];
  for (const type of types) {
    await panel.locator('.layer-add-filter').first().selectOption(type);
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
  await panel.getByLabel('Pixel width', { exact: true }).fill('2');
  await panel.getByLabel('Pixel width', { exact: true }).press('Tab');
  await panel.locator('.measure-tab').getByText('Results', { exact: true }).click();
  await expect(panel.locator('.measure-results-wrapper tbody tr td').nth(2)).toHaveText('24');
  await panel.locator('.measure-tab').getByText('Segment', { exact: true }).click();
  await expect(panel.locator('.measure-method').filter({ hasText: 'Otsu' })).toBeEnabled({timeout:30_000});
  await panel.locator('.measure-method').filter({ hasText: 'Otsu' }).click();
  await expect(panel.locator('.measure-method.active')).toContainText('Otsu');
  await panel.getByLabel('Min area (px)', { exact: true }).fill('2');
  await panel.getByLabel('Min area (px)', { exact: true }).press('Tab');
  await expect(panel.locator('.measure-histogram')).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('measurement.png')});
  expect(errors).toEqual([]);
});

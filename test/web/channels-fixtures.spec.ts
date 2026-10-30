import { expect, test, type Page } from '@playwright/test';
import * as path from 'node:path';

/**
 * The channel settings against real files: an OME-TIFF and an ImageJ stack
 * (both written by tifffile, see test/channel-fixtures-test.js), and images that
 * must not be treated as channel stacks.
 */

const CHANNELS = {
  autoComposite: true,
  autoOpenPanel: true,
  colorsByName: { dapi: '#ff00ff' },
  colorsByNumber: { 3: '#ffaa00' },
  groups: { 'T cells': ['CD3e', 'gfp', 'nope'] },
};

async function open(page: Page, file: string, channelDefaults: object = CHANNELS) {
  await page.goto('/');
  await page.evaluate(settings => window.postMessage({ type: 'updateSettings', settings }, '*'), { channelDefaults });
  await page.locator('#web-file-input').setInputFiles(path.resolve('test-samples', file));
  await expect(page.locator('body')).toHaveClass(/ready/, { timeout: 30_000 });
  return page.locator('.channels-panel');
}

const composite = (panel: ReturnType<Page['locator']>) => panel.getByRole('button', { name: 'Composite' });

test('OME-TIFF opens in composite with the panel, named channels and configured tints', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const panel = await open(page, 'ome_3ch_z.ome.tif');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel.locator('.channel-row')).toHaveCount(3, { timeout: 15_000 });
  await expect(panel.locator('.channel-row .channel-name')).toHaveText(['DAPI', 'GFP', 'CD3e']);
  await expect(composite(panel)).toHaveClass(/active/);
  const swatch = panel.locator('.channel-swatch');
  await expect(swatch.nth(0)).toHaveValue('#ff00ff');
  await expect(swatch.nth(1)).toHaveValue('#00ff00');
  await expect(swatch.nth(2)).toHaveValue('#ffaa00');
  expect(errors).toEqual([]);
});

test('without the settings the same file opens plain, and the file colours still apply', async ({ page }) => {
  const panel = await open(page, 'ome_3ch_z.ome.tif', {});
  await expect(panel).toBeHidden();
  await page.evaluate(() => window.postMessage({ type: 'toggleChannels' }, '*'));
  await expect(panel.locator('.channel-row')).toHaveCount(3, { timeout: 15_000 });
  await expect(composite(panel)).not.toHaveClass(/active/);
  await expect(panel.locator('.channel-swatch').nth(0)).toHaveValue('#0000ff');
  await expect(panel.locator('.channel-swatch').nth(1)).toHaveValue('#00ff00');
});

test('turning composite off by hand sticks while stepping Z', async ({ page }) => {
  const panel = await open(page, 'ome_3ch_z.ome.tif');
  await expect(composite(panel)).toHaveClass(/active/, { timeout: 15_000 });
  await composite(panel).click();
  await expect(composite(panel)).not.toHaveClass(/active/);
  await page.locator('.dataset-overlay [data-axis="Z"] input[type=range]').fill('1');
  await expect(page.locator('.dataset-overlay [data-axis="Z"] .dataset-axis-value')).toHaveText('2 / 2');
  await expect(composite(panel)).not.toHaveClass(/active/);
  await expect(panel).toBeVisible();
});

test('the channel selector solos in composite and the panel follows', async ({ page }) => {
  const panel = await open(page, 'ome_3ch_z.ome.tif');
  await expect(composite(panel)).toHaveClass(/active/, { timeout: 15_000 });
  await page.locator('.dataset-overlay [data-axis="C"] select').selectOption('1');
  await expect(panel.locator('.channel-row').nth(1).locator('.channel-solo')).toHaveClass(/active/);
  await expect(composite(panel)).toHaveClass(/active/);
  await panel.locator('.channel-row').nth(2).locator('.channel-solo').click();
  await expect(page.locator('.dataset-overlay [data-axis="C"] select')).toHaveValue('2');
});

test('a configured group is listed with its missing member', async ({ page }) => {
  const panel = await open(page, 'ome_3ch_z.ome.tif');
  await expect(panel.locator('.channel-group-row')).toHaveCount(1, { timeout: 15_000 });
  await expect(panel.locator('.channel-group-row .channel-name')).toHaveText('T cells');
  // The image viewer's panel starts with Groups folded.
  await panel.locator('summary', { hasText: 'Groups' }).click();
  await expect(panel.getByText('T cells: not found — nope')).toBeVisible();
});

test('an ImageJ stack takes its channel names from the slice labels', async ({ page }) => {
  const panel = await open(page, 'imagej_3ch_labels.tif');
  await expect(panel.locator('.channel-row')).toHaveCount(3, { timeout: 15_000 });
  await expect(panel.locator('.channel-row .channel-name')).toHaveText(['DAPI', 'GFP', 'CD3e']);
  await expect(composite(panel)).toHaveClass(/active/);
  await expect(panel.locator('.channel-swatch').nth(0)).toHaveValue('#ff00ff');
  await expect(page.locator('.dataset-overlay [data-axis="C"] option')).toHaveText(['DAPI', 'GFP', 'CD3e']);
});

test('extra samples without channel metadata are left alone', async ({ page }) => {
  const panel = await open(page, 'shapes_hyper.tif');
  await expect(panel).toBeHidden();
  await page.evaluate(() => window.postMessage({ type: 'toggleChannels' }, '*'));
  await expect(panel.locator('.channel-row')).toHaveCount(7, { timeout: 15_000 });
  await expect(composite(panel)).not.toHaveClass(/active/);
});

test('the channels of an RGB image are tinted red, green and blue', async ({ page }) => {
  const panel = await open(page, 'pred_ref_rgb8.tif', {});
  await page.evaluate(() => window.postMessage({ type: 'toggleChannels' }, '*'));
  await expect(panel.locator('.channel-row .channel-name')).toHaveText(['Red', 'Green', 'Blue']);
  const swatch = panel.locator('.channel-swatch');
  await expect(swatch.nth(0)).toHaveValue('#ff0000');
  await expect(swatch.nth(1)).toHaveValue('#00ff00');
  await expect(swatch.nth(2)).toHaveValue('#0000ff');
});

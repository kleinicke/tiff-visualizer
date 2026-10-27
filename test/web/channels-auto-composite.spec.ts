import { expect, test } from '@playwright/test';
import * as path from 'node:path';

/**
 * A minimal ImageJ hyperstack: one uncompressed 8-bit page per channel, with
 * the `channels=` description ImageJ writes. Built here so the test does not
 * depend on a binary fixture.
 */
function imagejHyperstack(channels: number, width = 4, height = 4): Buffer {
  const description = `ImageJ=1.54f\nimages=${channels}\nchannels=${channels}\nhyperstack=true\n\0`;
  const entries = 10;
  const ifdSize = 2 + entries * 12 + 4;
  const pixels = width * height;
  const descOffset = 8;
  const firstIfd = descOffset + description.length + (description.length % 2);
  const dataStart = firstIfd + channels * ifdSize;
  const buffer = Buffer.alloc(dataStart + channels * pixels);
  buffer.write('II', 0, 'latin1');
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(firstIfd, 4);
  buffer.write(description, descOffset, 'latin1');
  for (let c = 0; c < channels; c++) {
    const ifd = firstIfd + c * ifdSize;
    const data = dataStart + c * pixels;
    const tags: [number, number, number, number][] = [
      [256, 3, 1, width], [257, 3, 1, height], [258, 3, 1, 8], [259, 3, 1, 1], [262, 3, 1, 1],
      [270, 2, description.length, descOffset], [273, 4, 1, data], [277, 3, 1, 1],
      [278, 3, 1, height], [279, 4, 1, pixels],
    ];
    buffer.writeUInt16LE(entries, ifd);
    tags.forEach(([tag, type, count, value], index) => {
      const at = ifd + 2 + index * 12;
      buffer.writeUInt16LE(tag, at);
      buffer.writeUInt16LE(type, at + 2);
      buffer.writeUInt32LE(count, at + 4);
      if (type === 3) { buffer.writeUInt16LE(value, at + 8); } else { buffer.writeUInt32LE(value, at + 8); }
    });
    buffer.writeUInt32LE(c + 1 < channels ? ifd + ifdSize : 0, ifd + 2 + entries * 12);
    for (let p = 0; p < pixels; p++) { buffer[data + p] = (p * 16 + c * 40) & 0xff; }
  }
  return buffer;
}

async function openWithChannelDefaults(page: import('@playwright/test').Page, files: Parameters<import('@playwright/test').Locator['setInputFiles']>[0]) {
  await page.goto('/');
  // The VS Code host sends `tiffVisualizer.channels.*` this way; the
  // standalone host has no such settings, so inject them as a host would.
  await page.evaluate(() => window.postMessage({
    type: 'updateSettings',
    settings: { channelDefaults: { autoComposite: true, colorsByNumber: { 2: '#ff00ff' } } },
  }, '*'));
  await page.locator('#web-file-input').setInputFiles(files);
  await expect(page.locator('body')).toHaveClass(/ready/, { timeout: 30_000 });
}

test('autoComposite opens an ImageJ hyperstack in composite mode with configured tints', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openWithChannelDefaults(page, {
    name: 'hyperstack.tif', mimeType: 'image/tiff', buffer: imagejHyperstack(3),
  });
  await page.evaluate(() => window.postMessage({ type: 'toggleChannels' }, '*'));
  const panel = page.locator('.channels-panel');
  await expect(panel.locator('.channel-row')).toHaveCount(3, { timeout: 15_000 });
  await expect(panel.getByRole('button', { name: 'Composite' })).toHaveClass(/active/);
  await expect(panel.locator('.channel-swatch').nth(1)).toHaveValue('#ff00ff');

  // A manual choice wins over the setting.
  await panel.getByRole('button', { name: 'Composite' }).click();
  await expect(panel.getByRole('button', { name: 'Composite' })).not.toHaveClass(/active/);
  expect(errors).toEqual([]);
});

test('autoComposite leaves an ordinary RGB image in the decoded view', async ({ page }) => {
  await openWithChannelDefaults(page, path.resolve('test-samples', 'pred_ref_rgb8.tif'));
  await page.evaluate(() => window.postMessage({ type: 'toggleChannels' }, '*'));
  const panel = page.locator('.channels-panel');
  await expect(panel.locator('.channel-row')).toHaveCount(3);
  await expect(panel.getByRole('button', { name: 'Composite' })).not.toHaveClass(/active/);
});

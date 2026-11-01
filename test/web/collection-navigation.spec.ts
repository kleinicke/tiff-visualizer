import { expect, test } from '@playwright/test';
import path from 'node:path';

// Small explicit-VR DICOM with three distinct 2x2 frames.
function dicom() {
  const tag = (group: number, element: number, vr: string, value: Buffer) => {
    const long = vr === 'OB';
    const header = Buffer.alloc(long ? 12 : 8);
    header.writeUInt16LE(group); header.writeUInt16LE(element, 2); header.write(vr, 4);
    if (long) header.writeUInt32LE(value.length, 8); else header.writeUInt16LE(value.length, 6);
    return Buffer.concat([header, value]);
  };
  const us = (element: number, value: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return tag(0x28, element, 'US', b); };
  return Buffer.concat([
    Buffer.alloc(128), Buffer.from('DICM'), tag(2, 0x10, 'UI', Buffer.from('1.2.840.10008.1.2.1\0')),
    us(2, 1), tag(0x28, 4, 'CS', Buffer.from('MONOCHROME2 ')), tag(0x28, 8, 'IS', Buffer.from('3 ')),
    us(0x10, 2), us(0x11, 2), us(0x100, 8), us(0x101, 8), us(0x102, 7), us(0x103, 0),
    tag(0x7fe0, 0x10, 'OB', Buffer.from([0, 20, 40, 60, 60, 80, 100, 120, 120, 140, 160, 180])),
  ]);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Exercise the shared viewer with the extension's collection contract.
    // Website tabs deliberately do not expose collection arrow navigation.
    window.addEventListener('message', event => {
      const data = event.data;
      if (data?.type === 'switchToImage') data.collection = { totalImages: 2, currentIndex: 0, show: true };
      if (data?.type === 'updateImageCollectionOverlay') data.data = { totalImages: 2, currentIndex: 0, show: true };
    });
    (window as any).__collectionMessages = [];
    Object.defineProperty(window, 'acquireVsCodeApi', { configurable: true, set(factory) {
      Object.defineProperty(window, 'acquireVsCodeApi', { configurable: true, value: () => {
        const api = factory(); const post = api.postMessage;
        api.postMessage = (message: any) => {
          (window as any).__collectionMessages.push(message);
          return post(message);
        };
        return api;
      } });
    } });
  });
});

for (const format of ['dicom', 'ome'] as const) {
  test(`${format}: collection survives container load, plane steps and cached return`, async ({ page }) => {
    await page.goto('/');
    await page.locator('#web-file-input').setInputFiles(format === 'dicom'
      ? { name: 'frames.dcm', mimeType: 'application/octet-stream', buffer: dicom() }
      : path.resolve('test-samples/ome_3ch_z.ome.tif'));
    await expect(page.locator('body')).toHaveClass(/ready/);
    const overlay = page.locator('.image-collection-overlay');
    const navigation = page.locator('.dataset-overlay');
    await expect(overlay).toBeVisible();
    await expect(navigation).toBeVisible();
    await expect(navigation.locator('.dataset-axis-hint').first()).toHaveText('[ ]');
    await expect(navigation).not.toContainText('←');
    const first = navigation.locator('input[type=range], select').first();
    await page.keyboard.press('BracketRight');
    await expect(first).toHaveValue('1');
    await expect(navigation).not.toHaveClass(/dataset-overlay--loading/);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => page.evaluate(() => (window as any).__collectionMessages.filter((m: any) => m.type === 'toggleImage').length)).toBe(1);
    await expect(first).toHaveValue('1');
    // Reset to the opening plane so returning exercises the decoded cache.
    await page.keyboard.press('BracketLeft');
    await expect(first).toHaveValue('0');
    await expect(navigation).not.toHaveClass(/dataset-overlay--loading/);
    await page.locator('#web-file-input').setInputFiles(path.resolve('test-samples/png_u8_rgb.png'));
    await expect(navigation).toBeHidden();
    await expect(overlay).toBeVisible();
    await page.locator('.web-image-tab-select').filter({ hasText: format === 'dicom' ? 'frames.dcm' : 'ome_3ch_z.ome.tif' }).click();
    await expect(navigation).toBeVisible();
    await expect(overlay).toBeVisible();
    await expect(navigation.locator('.dataset-axis-hint').first()).toHaveText('[ ]');
    await expect.poll(() => page.evaluate(() => (window as any).__collectionMessages.some((m: any) => m.type === 'formatInfo' && m.value?.decodedWith === 'decoded-cache'))).toBe(true);
    await page.keyboard.press('BracketRight');
    await expect(first).toHaveValue('1');
  });
}

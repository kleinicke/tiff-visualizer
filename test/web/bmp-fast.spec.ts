import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * `media/modules/bmp-fast.ts` reads 24-bit BMP rows itself instead of letting
 * the browser decode, draw and read the image back. Its RGBA must equal what
 * Chromium's getImageData returns for the same file, for every row padding,
 * both row orders and the header variants it accepts; files it declines must
 * be left to the browser.
 */

type Variant = { width: number; height: number; topDown: boolean; header: 40 | 108 | 124; colorSpace?: number; bitCount?: number };

function makeBmp(seed: number, v: Variant): Buffer {
  let state = seed;
  const next = () => { state = (state * 1103515245 + 12345) >>> 0; return state >>> 24; };
  const bitCount = v.bitCount ?? 24;
  const rowBytes = Math.ceil(v.width * bitCount / 8 / 4) * 4;
  const pixelOffset = 14 + v.header;
  const file = Buffer.alloc(pixelOffset + rowBytes * v.height);
  file.write('BM', 0, 'latin1');
  file.writeUInt32LE(file.length, 2);
  file.writeUInt32LE(pixelOffset, 10);
  file.writeUInt32LE(v.header, 14);
  file.writeInt32LE(v.width, 18);
  file.writeInt32LE(v.topDown ? -v.height : v.height, 22);
  file.writeUInt16LE(1, 26);
  file.writeUInt16LE(bitCount, 28);
  file.writeUInt32LE(0, 30);
  file.writeUInt32LE(rowBytes * v.height, 34);
  if (v.header > 40) file.writeUInt32LE(v.colorSpace ?? 0x73524742, 14 + 56);
  for (let row = 0; row < v.height; row++) {
    for (let x = 0; x < rowBytes; x++) file[pixelOffset + row * rowBytes + x] = x < v.width * bitCount / 8 ? next() : 0;
  }
  return file;
}

test('direct 24-bit BMP decoding matches the browser byte for byte', async ({ page }) => {
  const moduleSource = fs.readFileSync(path.resolve('out/media/modules/bmp-fast.js'), 'utf8');
  const variants: Variant[] = [];
  for (const width of [1, 2, 3, 4, 5, 6, 7, 8, 9, 37]) {
    for (const topDown of [false, true]) variants.push({ width, height: 1 + (width * 7) % 11, topDown, header: 40 });
  }
  variants.push({ width: 13, height: 9, topDown: false, header: 108 });
  variants.push({ width: 13, height: 9, topDown: true, header: 124, colorSpace: 0x57696e20 });
  // Declined: a 32-bit image and a calibrated colour space.
  variants.push({ width: 12, height: 5, topDown: false, header: 40, bitCount: 32 });
  variants.push({ width: 12, height: 5, topDown: false, header: 124, colorSpace: 0 });
  const files = variants.map((variant, index) => [...makeBmp(index + 1, variant)]);

  await page.setContent('<!doctype html><title>bmp</title>');
  const results = await page.evaluate(async ({ moduleSource, files }) => {
    const url = URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' }));
    const { decodeBmp24 } = await import(url);
    const out: { handled: boolean; equal: boolean; first: number }[] = [];
    for (const bytes of files) {
      const buffer = new Uint8Array(bytes).buffer;
      const direct = decodeBmp24(buffer);
      const image = new Image();
      image.src = URL.createObjectURL(new Blob([buffer], { type: 'image/bmp' }));
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(image, 0, 0);
      const browser = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      if (!direct) { out.push({ handled: false, equal: true, first: -1 }); continue; }
      let first = -1;
      if (direct.data.length !== browser.length) first = 0;
      else for (let i = 0; i < browser.length; i++) if (direct.data[i] !== browser[i]) { first = i; break; }
      out.push({ handled: true, equal: first < 0, first });
    }
    return out;
  }, { moduleSource, files });

  results.forEach((result, index) => {
    const variant = variants[index];
    const declined = (variant.bitCount ?? 24) !== 24 || variant.colorSpace === 0;
    expect(result.handled, JSON.stringify(variant)).toBe(!declined);
    expect(result.equal, `${JSON.stringify(variant)}: first differing byte ${result.first}`).toBe(true);
  });
});

test('the viewer opens a 24-bit BMP', async ({ page }, testInfo) => {
  const file = testInfo.outputPath('direct.bmp');
  fs.writeFileSync(file, makeBmp(7, { width: 37, height: 21, topDown: false, header: 40 }));
  const formats: string[] = [];
  page.on('console', message => { if (message.text().includes('[Perf] Web Image')) formats.push(message.text()); });
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles(file);
  await expect.poll(() => formats.length, { timeout: 15000 }).toBeGreaterThan(0);
  await expect(page.locator('body')).toHaveClass(/ready/);
});

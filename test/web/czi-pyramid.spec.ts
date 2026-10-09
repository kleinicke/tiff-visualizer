import { test, expect } from '@playwright/test';
import fs from 'node:fs';

/**
 * A CZI mosaic too large to hold whole opens as a pyramid scene from ranged
 * reads (media/modules/czi-processor.ts): the stored overview level first,
 * finer regions on zoom. The file here is sparse — two 64x64 tiles 8000
 * pixels apart make a 57 MP plane in a few KB — with one stored 1/16 tile.
 */

function segment(id: string, data: Buffer): Buffer {
  const header = Buffer.alloc(32);
  header.write(id, 0, 'ascii');
  header.writeBigInt64LE(BigInt(data.length), 16);
  header.writeBigInt64LE(BigInt(data.length), 24);
  return Buffer.concat([header, data]);
}

function sparseMosaic(): Buffer {
  const tiles = [
    { x: 0, y: 0, width: 64, height: 64, factor: 1 },
    { x: 8000, y: 7000, width: 64, height: 64, factor: 1 },
    { x: 0, y: 0, width: 8064, height: 7064, factor: 16 },
  ];
  const entry = (position: number, tile: typeof tiles[number]) => {
    const storedW = Math.ceil(tile.width / tile.factor), storedH = Math.ceil(tile.height / tile.factor);
    const dims: [string, number, number, number][] = [['X', tile.x, tile.width, storedW], ['Y', tile.y, tile.height, storedH]];
    const out = Buffer.alloc(32 + dims.length * 20);
    out.write('DV', 0, 'ascii');
    out.writeInt32LE(0, 2); // Gray8
    out.writeBigInt64LE(BigInt(position), 6);
    out.writeInt32LE(dims.length, 28);
    dims.forEach(([name, start, size, stored], i) => {
      out.write(name, 32 + i * 20, 'ascii');
      out.writeInt32LE(start, 36 + i * 20);
      out.writeInt32LE(size, 40 + i * 20);
      out.writeInt32LE(stored, 48 + i * 20);
    });
    return { out, storedW, storedH };
  };
  let position = 32 + 512;
  const blocks: Buffer[] = [];
  const entries: Buffer[] = [];
  for (const tile of tiles) {
    const { out, storedW, storedH } = entry(position, tile);
    const pixels = Buffer.alloc(storedW * storedH);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37 + tile.factor * 50) & 255;
    const fixed = Buffer.alloc(256);
    fixed.writeBigInt64LE(BigInt(pixels.length), 8);
    out.copy(fixed, 16);
    const block = segment('ZISRAWSUBBLOCK', Buffer.concat([fixed, pixels]));
    blocks.push(block);
    entries.push(out);
    position += block.length;
  }
  const directoryHead = Buffer.alloc(128);
  directoryHead.writeInt32LE(entries.length, 0);
  const fileHeader = Buffer.alloc(512);
  fileHeader.writeInt32LE(1, 0);
  fileHeader.writeBigInt64LE(BigInt(position), 0x34);
  return Buffer.concat([segment('ZISRAWFILE', fileHeader), ...blocks, segment('ZISRAWDIRECTORY', Buffer.concat([directoryHead, ...entries]))]);
}

test('a huge CZI mosaic opens as a pyramid scene and refines on zoom', async ({ page }, testInfo) => {
  const file = testInfo.outputPath('sparse-mosaic.czi');
  fs.writeFileSync(file, sparseMosaic());
  const logs: string[] = [];
  const errors: string[] = [];
  page.on('console', message => logs.push(message.text()));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles(file);
  const scene = page.locator('.pyramid-scene');
  await expect(scene).toBeVisible({ timeout: 15000 });
  await expect(scene).toHaveAttribute('data-scene-width', '8064');
  await expect(scene).toHaveAttribute('data-scene-height', '7064');
  expect(logs.some(line => line.includes('ranged read failed'))).toBe(false);
  await page.evaluate(() => window.postMessage({ type: 'setScale', scale: 1 }, '*'));
  await expect.poll(() => logs.some(line => line.includes('[Tiles] painted Full')), { timeout: 15000 }).toBe(true);
  expect(errors).toEqual([]);
});

import { test, expect } from '@playwright/test';
import { deflateSync } from 'node:zlib';

/** A tiny compressed file with a 50 MP lowest overview and repeated valid tiles. */
function pyramidFixture(): Buffer {
  const pixels = Buffer.alloc(512 * 512);
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) pixels[y * 512 + x] = 64 + ((x >> 2) + (y >> 2)) % 128;
  const compressed = deflateSync(pixels);
  const levels = [{ width: 32768, height: 24576, ifd: 8 }, { width: 8192, height: 6144, ifd: 256 }];
  let end = 1024;
  const tables = levels.map(level => {
    const count = level.width / 512 * level.height / 512;
    const offsets = end; end += count * 4;
    const counts = end; end += count * 4;
    return { count, offsets, counts };
  });
  const data = Buffer.alloc(end + compressed.length);
  data.write('II'); data.writeUInt16LE(42, 2); data.writeUInt32LE(8, 4);
  levels.forEach((level, index) => {
    const table = tables[index];
    const entries = [[254,4,1,index], [256,4,1,level.width], [257,4,1,level.height], [258,3,1,8],
      [259,3,1,8], [262,3,1,1], [277,3,1,1], [322,4,1,512], [323,4,1,512],
      [324,4,table.count,table.offsets], [325,4,table.count,table.counts]];
    data.writeUInt16LE(entries.length, level.ifd);
    entries.forEach(([tag,type,count,value], i) => {
      const at = level.ifd + 2 + i * 12;
      data.writeUInt16LE(tag,at); data.writeUInt16LE(type,at+2); data.writeUInt32LE(count,at+4); data.writeUInt32LE(value,at+8);
    });
    data.writeUInt32LE(index === 0 ? 256 : 0, level.ifd + 2 + entries.length * 12);
    for (let i = 0; i < table.count; i++) { data.writeUInt32LE(end,table.offsets+i*4); data.writeUInt32LE(compressed.length,table.counts+i*4); }
  });
  compressed.copy(data,end);
  return data;
}

test('keeps the coarse remote image visible while panning with detail requests blocked', async ({ page }) => {
  test.setTimeout(90_000);
  const file = pyramidFixture();
  let blocked = false, blockedRequests = 0;
  await page.route('**/pan-continuity.tif', async route => {
    if (blocked) { blockedRequests++; await route.abort(); return; }
    const range = /bytes=(\d+)-(\d+)/.exec(route.request().headers().range || '');
    const start = range ? +range[1] : 0, end = Math.min(range ? +range[2] : file.length - 1, file.length - 1);
    await route.fulfill({ status: 206, headers: { 'content-type': 'image/tiff', 'content-range': `bytes ${start}-${end}/${file.length}` }, body: file.subarray(start,end+1) });
  });
  const messages: string[] = [];
  page.on('console', message => messages.push(message.text()));
  await page.goto('/?url=' + encodeURIComponent('http://127.0.0.1:4173/pan-continuity.tif'));
  await expect.poll(() => messages.some(line => line.startsWith('[Refine]')), { timeout: 60_000 }).toBe(true);
  const base = page.locator('.pyramid-base');
  const sample = () => base.evaluate((canvas: HTMLCanvasElement) => {
    const bytes = canvas.getContext('2d')!.getImageData(300,300,32,32).data;
    return { opaque: bytes.filter((_v,i) => i % 4 === 3).every(v => v === 255), bright: bytes.some((v,i) => i % 4 !== 3 && v > 40) };
  });
  expect(await sample()).toEqual({ opaque: true, bright: true });
  blocked = true;
  await page.evaluate(() => window.postMessage({ type: 'setScale', scale: 16 }, '*'));
  await expect.poll(() => blockedRequests).toBeGreaterThan(0);
  for (const fraction of [0.2, 0.8, 0.4]) {
    await page.evaluate(f => window.scrollTo((document.documentElement.scrollWidth-innerWidth)*f, (document.documentElement.scrollHeight-innerHeight)*f), fraction);
    const screenshot = await page.screenshot();
    const visible = await page.evaluate(async encoded => {
      const blob = new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], {type:'image/png'});
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas'); canvas.width=bitmap.width;canvas.height=bitmap.height;
      const context=canvas.getContext('2d')!;context.drawImage(bitmap,0,0);bitmap.close();
      const data=context.getImageData(Math.floor(canvas.width/2)-16,Math.floor(canvas.height/2)-16,32,32).data;
      return data.filter((_v,i)=>i%4!==3).reduce((sum,v)=>sum+v,0)/(32*32*3);
    }, screenshot.toString('base64'));
    expect(visible, 'the viewport must show the loaded coarse image while new detail is unavailable').toBeGreaterThan(35);
    expect(await sample()).toEqual({ opaque: true, bright: true });
  }
  await expect(page.locator('.pyramid-gpu')).toHaveCount(0);
});

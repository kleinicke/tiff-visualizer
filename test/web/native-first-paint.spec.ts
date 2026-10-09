import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * In VS Code the page bootstrap paints PNG/JPEG/WebP/AVIF/BMP/ICO with a
 * native <img> before the viewer starts, and the processors adopt that
 * element (`media/modules/bootstrap-image.ts`) instead of loading the file a
 * second time. The standalone viewer has no bootstrap, so this simulates it:
 * the file's blob URL also gets an <img>, published as the bootstrap's
 * `nativeImage`. Every readout must equal the plain load's: what is inspected,
 * pixel values (alpha included) and region statistics.
 */

async function request(page: Page, operation: string, args: Record<string, unknown> = {}) {
  return page.evaluate(({ operation, args }) => new Promise<Record<string, any>>((resolve, reject) => {
    const id = crypto.randomUUID();
    const receive = (event: Event) => {
      const message = (event as CustomEvent).detail;
      if (message.type === 'automationResult' && message.id === id) {
        clearTimeout(timer); window.removeEventListener('__testViewerMessage', receive); resolve(message);
      }
    };
    const timer = setTimeout(() => { window.removeEventListener('__testViewerMessage', receive); reject(new Error('No automation response')); }, 5000);
    window.addEventListener('__testViewerMessage', receive);
    window.postMessage({ type: 'automationRequest', id, operation, args }, location.origin);
  }), { operation, args });
}

async function captureViewerMessages(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'acquireVsCodeApi', { configurable: true, set(factory) {
      Object.defineProperty(window, 'acquireVsCodeApi', { configurable: true, value: () => {
        const api = factory();
        const post = api.postMessage;
        api.postMessage = (message: unknown) => {
          window.dispatchEvent(new CustomEvent('__testViewerMessage', { detail: message }));
          return post(message);
        };
        return api;
      } });
    } });
  });
}

async function simulateNativeFirstPaint(page: Page) {
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = create(object);
      if (object instanceof File && /\.(png|jpe?g|webp|avif|bmp|ico)$/i.test(object.name)) {
        const image = document.createElement('img');
        image.id = 'native-fast-preview';
        image.className = 'scale-to-fit';
        image.src = url;
        document.body.appendChild(image);
        (window as any).__tiffVisualizerBootstrap = { nativeImage: image, visibleTotalMs: null };
        (window as any).__nativeAdoptions = ((window as any).__nativeAdoptions || 0) + 1;
      }
      return url;
    };
  });
}

function makeBmp(width: number, height: number): Buffer {
  const rowBytes = Math.ceil(width * 3 / 4) * 4;
  const file = Buffer.alloc(54 + rowBytes * height);
  file.write('BM', 0, 'latin1');
  file.writeUInt32LE(file.length, 2);
  file.writeUInt32LE(54, 10);
  file.writeUInt32LE(40, 14);
  file.writeInt32LE(width, 18);
  file.writeInt32LE(height, 22);
  file.writeUInt16LE(1, 26);
  file.writeUInt16LE(24, 28);
  for (let y = 0; y < height; y++) for (let x = 0; x < width * 3; x++) file[54 + y * rowBytes + x] = (x * 37 + y * 11) & 255;
  return file;
}

async function readouts(page: Page, file: string) {
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles(file);
  await expect(page.locator('body')).toHaveClass(/ready/);
  await expect.poll(async () => (await request(page, 'inspect')).result?.width ?? 0).toBeGreaterThan(0);
  const inspect = (await request(page, 'inspect')).result;
  const { width, height } = inspect;
  const pixels = [];
  for (const [fx, fy] of [[0, 0], [0.5, 0.5], [0.99, 0.01], [0.3, 0.8], [1, 1]]) {
    const x = Math.min(width - 1, Math.floor(fx * width)), y = Math.min(height - 1, Math.floor(fy * height));
    pixels.push((await request(page, 'pixel', { x, y })).result);
  }
  const region = (await request(page, 'region', { x: 0, y: 0, width, height })).result;
  // ROI ids are random per request, blob URLs per page.
  return JSON.parse(JSON.stringify({ inspect, pixels, region }, (key, value) => key === 'roiId' || key === 'src' ? undefined : value));
}

test('adopting the native first-paint image keeps every readout', async ({ page, browser }, testInfo) => {
  test.setTimeout(120000);
  // Encoded by Chromium from a canvas with translucent pixels.
  await page.goto('/');
  const encoded = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 61; canvas.height = 47;
    const ctx = canvas.getContext('2d')!;
    const data = ctx.createImageData(61, 47);
    for (let i = 0; i < data.data.length; i++) data.data[i] = (i * 73 + (i >> 7) * 29) & 255;
    for (let i = 3; i < data.data.length; i += 16) data.data[i] = 255;
    ctx.putImageData(data, 0, 0);
    const out: Record<string, string> = {};
    for (const [name, type] of [['rgba.png', 'image/png'], ['photo.jpg', 'image/jpeg'], ['rgba.webp', 'image/webp']]) {
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), type, 0.9));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      out[name] = btoa(binary);
    }
    return out;
  });
  const files = [path.resolve('test-samples/png_u8_rgb.png'), path.resolve('test-samples/png_u16_gray.png')];
  for (const [name, base64] of Object.entries(encoded)) {
    const file = testInfo.outputPath(name);
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    files.push(file);
  }
  const bmp = testInfo.outputPath('rgb.bmp');
  fs.writeFileSync(bmp, makeBmp(37, 23));
  files.push(bmp);

  // A fresh context per load: a reloaded page restores the previous file's state.
  const load = async (file: string, nativeFirstPaint: boolean) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await captureViewerMessages(page);
    if (nativeFirstPaint) await simulateNativeFirstPaint(page);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const result = await readouts(page, file);
    const adoptions = await page.evaluate(() => (window as any).__nativeAdoptions ?? 0);
    // Taken by a processor (one-shot) and, in gamma mode, the element on screen.
    const taken = await page.evaluate(() => (window as any).__tiffVisualizerBootstrap?.nativeImage === null);
    const shown = await page.evaluate(() => !!document.querySelector('img#native-fast-preview')?.isConnected);
    await context.close();
    return { result, adoptions, taken, shown, errors };
  };
  let shownCount = 0;
  for (const file of files) {
    const name = path.basename(file);
    const plain = await load(file, false);
    const native = await load(file, true);
    expect(native.adoptions, name).toBe(1);
    // A 24-bit BMP is read directly instead (faster than Chromium's decode).
    expect(native.taken, name).toBe(!name.endsWith('.bmp'));
    shownCount += native.shown ? 1 : 0;
    expect([...plain.errors, ...native.errors], name).toEqual([]);
    expect(native.result, name).toEqual(plain.result);
  }
  expect(shownCount).toBeGreaterThan(0);
});

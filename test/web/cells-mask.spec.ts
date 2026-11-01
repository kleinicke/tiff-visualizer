import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
const script = buildSync({ stdin: { contents: `export { ImageCells } from './media/modules/cells/image-cells'; export { readMaskImage } from './media/modules/cells/mask-reader';`, resolveDir: root }, bundle: true, define: { 'import.meta.url': 'window.location.href' }, format: 'iife', globalName: 'MaskTest', write: false, logLevel: 'silent' }).outputFiles[0].text;

// A real uncompressed TIFF exercises the production decoder, worker and tracer.
function tiff(values: number[], width: number, bits = 16, sampleFormat = 1): number[] {
  const tags = [[256, 4, width], [257, 4, values.length / width], [258, 3, bits], [259, 3, 1], [262, 3, 1], [273, 4, 0], [277, 3, 1], [278, 4, values.length / width], [279, 4, values.length * bits / 8], [339, 3, sampleFormat]];
  const offset = 8 + 2 + tags.length * 12 + 4;
  tags[5][2] = offset;
  const bytes = new Uint8Array(offset + values.length * bits / 8), view = new DataView(bytes.buffer);
  bytes.set([73, 73, 42, 0, 8, 0, 0, 0]); view.setUint16(8, tags.length, true);
  tags.forEach(([tag, type, value], i) => { const at = 10 + i * 12; view.setUint16(at, tag, true); view.setUint16(at + 2, type, true); view.setUint32(at + 4, 1, true); view.setUint32(at + 8, value, true); });
  values.forEach((value, i) => { const at = offset + i * bits / 8; if (sampleFormat === 3) view.setFloat32(at, value, true); else if (bits === 32) view.setUint32(at, value, true); else view.setUint16(at, value, true); });
  return [...bytes];
}
async function open(page: Page) {
  await page.route('**/mask-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body><canvas id="image" width="8" height="4" style="position:absolute;left:20px;top:20px;width:400px;height:200px"></canvas><style>.cells-overlay{position:fixed;inset:0;pointer-events:none}</style></body>' }));
  for (const asset of ['xeniumTileWorker.bundle.js', 'xeniumCellsWorker.bundle.js', 'wasm/transcripts-wasm.wasm']) {
    await page.route(`**/media/${asset}`, route => route.fulfill({ path: path.join(root, 'media', asset), contentType: asset.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' }));
  }
  await page.goto('/mask-test');
  await page.addScriptTag({ content: script });
  await page.evaluate(() => {
    const w = window as any;
    w.__tiffVisualizerVendorAssets = { codecWasm: '/media/wasm/codec-wasm.wasm', transcriptsWasm: '/media/wasm/transcripts-wasm.wasm', workers: { 'xeniumTileWorker.bundle.js': '/media/xeniumTileWorker.bundle.js', 'xeniumCellsWorker.bundle.js': '/media/xeniumCellsWorker.bundle.js' } };
    w.files = {};
    w.cells = new w.MaskTest.ImageCells({ getImageElement: () => document.getElementById('image'), getImageSize: () => ({ width: 8, height: 4 }), getMicronsPerPixel: () => null, getIdColumns: () => ['Object'], onChange() {}, postMessage(message: any) { w.cells.onHostFile({ requestId: message.requestId, spec: w.files[message.text] }); } });
    w.cells.setResource('first.tif');
  });
}

test('mask TIFF, CSV matching, selection, coloring, alignment and image switching', async ({ page }) => {
  await open(page);
  await page.evaluate(bytes => {
    const w = window as any;
    w.files['mask.tif'] = { name: 'mask', path: 'mask.tif', kind: 'boundaries', found: true, bytes: new Uint8Array(bytes).buffer };
    w.files['metrics.csv'] = { name: 'metrics', path: 'metrics.csv', kind: 'table', found: true, bytes: new TextEncoder().encode('Object,Marker\n2,B\n1,A\n').buffer };
    w.cells.model().addSource('mask.tif');
  }, tiff([1, 1, 2, 2, 1, 1, 2, 2], 4));
  await expect.poll(() => page.evaluate(() => (window as any).cells.model().sets.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).cells.model().sets[0].count)).toBe(2);
  await page.evaluate(() => (window as any).cells.model().sets[0].addTable('metrics.csv'));
  await expect.poll(() => page.evaluate(() => (window as any).cells.model().sets[0].tables[0]?.state)).toBe('loaded');
  await page.evaluate(() => (window as any).cells.model().sets[0].view.setMetric('metrics · Marker'));
  expect(await page.evaluate(() => (window as any).cells.model().sets[0].view.discrete.rows.map((row: any) => row.label))).toEqual(['A', 'B']);
  await expect.poll(() => page.locator('.cells-overlay').evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d')!, dpr = window.devicePixelRatio;
    const left = [...context.getImageData(100 * dpr, 100 * dpr, 1, 1).data];
    const right = [...context.getImageData(300 * dpr, 100 * dpr, 1, 1).data];
    return left[3] > 0 && right[3] > 0 && left.slice(0, 3).join() !== right.slice(0, 3).join();
  })).toBe(true);
  await page.mouse.click(100, 100);
  const selection = await page.evaluate(() => (window as any).cells.model().sets[0].view.selection);
  expect(selection.count).toBe(1);
  expect(selection.rows).toContainEqual({ label: 'metrics · Marker', value: 'A' });
  expect(selection.rows.some((row: any) => /area/i.test(row.label) && Number(row.value) === 16)).toBe(true);
  // Change the displayed image size and position just as zoom/pan does. Selection must follow it.
  await page.evaluate(() => { const w = window as any; Object.assign(document.getElementById('image')!.style, { left: '100px', top: '80px', width: '600px', height: '300px' }); w.cells.redraw(); });
  await page.mouse.click(550, 150);
  expect(await page.evaluate(() => (window as any).cells.model().sets[0].view.selection.rows)).toContainEqual({ label: 'metrics · Marker', value: 'B' });
  expect(await page.locator('.cells-overlay').evaluate((canvas: HTMLCanvasElement) => Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data).some((v, i) => i % 4 === 3 && v > 0))).toBe(true);
  await page.evaluate(() => (window as any).cells.setResource('second.tif'));
  expect(await page.evaluate(() => (window as any).cells.model().sets.length)).toBe(0);
  await expect(page.locator('.cells-overlay')).toHaveCount(0);
});

test('mask import refuses ambiguous large IDs and non-finite samples', async ({ page }) => {
  await open(page);
  for (const [values, format, message] of [[ [16777216, 16777217], 1, '16,777,216' ], [ [NaN, 1], 3, 'non-finite' ], [ [Infinity, 1], 3, 'non-finite' ], [ [-1, 1], 3, 'negative' ], [ [1.5, 1], 3, 'fractional' ]] as [number[], number, string][]) {
    const error = await page.evaluate(async bytes => { try { await (window as any).MaskTest.readMaskImage(new Uint8Array(bytes).buffer); return ''; } catch (e) { return String(e); } }, tiff(values, 2, 32, format));
    expect(error).toContain(message);
  }
  const labels = await page.evaluate(async bytes => [...(await (window as any).MaskTest.readMaskImage(new Uint8Array(bytes).buffer)).data], tiff([16777215, 70000], 2, 32));
  expect(labels).toEqual([16777215, 70000]);
});

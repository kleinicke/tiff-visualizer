import { test, expect, type Page } from '@playwright/test';
const { npy, npz, researchEntries } = require('../lib/numpy-dataset-fixtures.cjs');

async function pixel(page: Page) {
  return page.evaluate(() => new Promise<number[]>((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => reject(new Error('Pixel request timed out')), 5000);
    const listener = (event: Event) => {
      const message = (event as CustomEvent).detail;
      if (message.type !== 'automationResult' || message.id !== id) return;
      window.removeEventListener('__numpyMessage', listener); clearTimeout(timer);
      if (message.error?.includes('Original pixel data is not available')) resolve([]);
      else if (message.error) reject(new Error(message.error));
      else resolve(message.result.values);
    };
    window.addEventListener('__numpyMessage', listener);
    window.postMessage({ type: 'automationRequest', id, operation: 'pixel', args: { x: 0, y: 0 } }, location.origin);
  }));
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'acquireVsCodeApi', { configurable: true, set(factory) {
      Object.defineProperty(window, 'acquireVsCodeApi', { configurable: true, value: () => {
        const api = factory(); const post = api.postMessage;
        api.postMessage = (message: unknown) => {
          window.dispatchEvent(new CustomEvent('__numpyMessage', { detail: message }));
          return post(message);
        };
        return api;
      } });
    } });
    const NativeWorker = window.Worker;
    (window as any).__numpyRequests = [];
    window.Worker = class extends NativeWorker {
      postMessage(message: any, transfer: any) {
        if (message?.format === 'npy') {
          (window as any).__numpyRequests.push({ bytes: message.buffer?.byteLength, dataset: message.options?.numpyDataset });
        }
        super.postMessage(message, transfer);
      }
    };
  });
});

for (const compressed of [false, true]) {
  test(`NumPy ${compressed ? 'compressed' : 'stored'} archive uses shared array, layout and plane controls`, async ({ page }) => {
    await page.goto('/');
    await page.locator('#web-file-input').setInputFiles({ name: 'research.npz', mimeType: 'application/octet-stream', buffer: npz(researchEntries(), { compressed }) });
    await expect(page.locator('body')).toHaveClass(/ready/);
    const overlay = page.locator('.dataset-overlay');
    const array = overlay.locator('select').first();
    await expect(array).toBeVisible();
    await expect(array).toHaveValue('1'); // Prefer depth over K, which was stored first.
    await expect.poll(() => pixel(page)).toEqual([0]);
    const slider = overlay.locator('input[type=range]').last();
    await slider.fill('2'); await slider.dispatchEvent('input');
    await expect.poll(() => pixel(page)).toEqual([200]);
    await expect(overlay).not.toHaveClass(/dataset-overlay--loading/);
    const layout = overlay.locator('select').nth(1);
    await layout.selectOption('1');
    await expect.poll(() => pixel(page)).toEqual([0, 100, 200]);
    await expect(overlay.locator('input[type=range]')).toHaveCount(0);
    await array.selectOption('4');
    await expect.poll(() => pixel(page)).toEqual([0, 50, 100]);
    await slider.fill('2'); await slider.dispatchEvent('input');
    await expect.poll(() => pixel(page)).toEqual([120, 170, 220]);
    // Shared NumPy defaults auto-normalize [120, 220] across RGB channels.
    // Verify the rendered pixels as well as the unchanged scientific samples.
    await expect.poll(() => page.locator('body > canvas:not(.measure-overlay)').first().evaluate((source: HTMLCanvasElement) => {
      const copy = document.createElement('canvas'); copy.width = source.width; copy.height = source.height;
      const ctx = copy.getContext('2d')!; ctx.drawImage(source, 0, 0);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    })).toEqual([0, 127, 255, 255]);
    await array.selectOption('6');
    await expect.poll(() => pixel(page)).toEqual([8]);
    await expect(overlay.locator('input[type=range]')).toHaveCount(0);
    const requests = await page.evaluate(() => (window as any).__numpyRequests);
    expect(requests.filter((r: any) => r.bytes === 0).length).toBeGreaterThanOrEqual(3);
    expect(requests.filter((r: any) => r.bytes > 0)).toHaveLength(1);
  });
}

test('array shortcuts keep working when only the array dropdown remains', async ({ page }) => {
  const entries = [
    ['stack', npy([2, 5, 6], { value: () => 10 })],
    ['K', npy([3, 3], { value: () => 20 })],
    ['other', npy([2, 5, 6], { value: () => 30 })],
  ];
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles({ name: 'shortcuts.npz', mimeType: 'application/octet-stream', buffer: npz(entries) });
  const overlay = page.locator('.dataset-overlay');
  const array = overlay.locator('select').first();
  await expect.poll(() => pixel(page)).toEqual([10]);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  for (const [key, index, value] of [
    [']', '1', 20], [']', '2', 30],
    ['[', '1', 20], ['[', '0', 10],
    ['PageDown', '1', 20], ['PageDown', '2', 30],
    ['PageUp', '1', 20], ['PageUp', '0', 10],
    ['[', '2', 30], [']', '0', 10],
  ] as const) {
    await page.keyboard.press(key);
    await expect(array).toHaveValue(index);
    await expect.poll(() => pixel(page)).toEqual([value]);
    await expect(overlay).not.toHaveClass(/dataset-overlay--loading/);
    if (index === '1') {
      await expect(overlay.locator('select')).toHaveCount(1);
      await expect(overlay.locator('input[type=range]')).toHaveCount(0);
    }
  }
});

test('Fortran NPY stack uses the same slice control and keeps numeric samples', async ({ page }) => {
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles({ name: 'stack.npy', mimeType: 'application/octet-stream', buffer: npy([2, 5, 6], { fortran: true, value: (_, c) => c[0] * 100 + c[1] * 6 + c[2] }) });
  const slider = page.locator('.dataset-overlay input[type=range]');
  await expect(slider).toBeVisible();
  await expect.poll(() => pixel(page)).toEqual([0]);
  await slider.fill('1'); await slider.dispatchEvent('input');
  await expect.poll(() => pixel(page)).toEqual([100]);
  await expect(page.locator('.dataset-overlay')).not.toHaveClass(/dataset-overlay--loading/);
});


test('compressed NumPy also opens when workers are unavailable', async ({ page }) => {
  await page.addInitScript(() => { window.Worker = class { constructor() { throw new Error('Workers disabled for fallback test'); } } as any; });
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles({ name: 'fallback.npz', mimeType: 'application/octet-stream', buffer: npz(researchEntries(), { compressed: true }) });
  await expect(page.locator('body')).toHaveClass(/ready/);
  await expect.poll(() => pixel(page)).toEqual([0]);
  const slider = page.locator('.dataset-overlay input[type=range]').last();
  await slider.fill('2'); await slider.dispatchEvent('input');
  await expect.poll(() => pixel(page)).toEqual([200]);
});


test('array and layout changes retain independent slices and clamp shorter axes', async ({ page }) => {
  const entries = [
    ['prediction', npy([3, 5, 6], { value: (_, c) => c[0] * 100 })],
    ['reference', npy([3, 5, 6], { value: (_, c) => c[0] * 100 + 10 })],
    ['rgb', npy([3, 5, 6, 3], { dtype: '|u1', value: (_, c) => c[0] * 60 + c[3] * 50 })],
    ['shorter', npy([2, 5, 6], { value: (_, c) => c[0] * 100 + 20 })],
    ['batch', npy([2, 3, 5, 6], { value: (_, c) => c[0] * 100 + c[1] * 10 })],
  ];
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles({ name: 'selection.npz', mimeType: 'application/octet-stream', buffer: npz(entries, { compressed: true }) });
  const overlay = page.locator('.dataset-overlay');
  const array = overlay.locator('select').first();
  const view = overlay.locator('input[type=range]').first();
  await expect(view).toBeVisible();
  await view.fill('1'); await view.dispatchEvent('input');
  await expect.poll(() => pixel(page)).toEqual([100]);
  await array.selectOption('1');
  await expect.poll(() => pixel(page)).toEqual([110]);
  await expect(view).toHaveValue('1');
  await array.selectOption('2');
  await expect.poll(() => pixel(page)).toEqual([60, 110, 160]);
  await expect(view).toHaveValue('1');
  await view.fill('2'); await view.dispatchEvent('input');
  await expect.poll(() => pixel(page)).toEqual([120, 170, 220]);
  await array.selectOption('3');
  await expect.poll(() => pixel(page)).toEqual([120]);
  await expect(view).toHaveValue('1'); // clamp index 2 to the new maximum 1
  await array.selectOption('4');
  await expect.poll(() => pixel(page)).toEqual([100]);
  await expect(view).toHaveValue('1');
  await overlay.locator('input[type=range]').nth(1).fill('2');
  await overlay.locator('input[type=range]').nth(1).dispatchEvent('input');
  await expect.poll(() => pixel(page)).toEqual([120]);
  await expect(view).toHaveValue('1');
  await overlay.locator('select').nth(1).selectOption('1');
  await expect.poll(() => pixel(page)).toEqual([100, 110, 120]);
  await expect(view).toHaveValue('1');
  await expect(overlay).not.toHaveClass(/dataset-overlay--loading/);
});

// Dispatch the key and physical code independently to model non-US layouts.
async function navigationKey(page: Page, key: string, code: string, modifiers: Record<string, boolean> = {}) {
  await page.evaluate(({ key, code, modifiers }) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...modifiers }));
  }, { key, code, modifiers });
}

test('navigation follows physical keys, labels the layout, and applies custom bindings live', async ({ page }) => {
  await page.addInitScript(() => {
    const keyboard = new EventTarget();
    (keyboard as any).getLayoutMap = async () => new Map([['BracketLeft', 'ü'], ['BracketRight', '+'], ['Comma', ','], ['Period', '.']]);
    Object.defineProperty(navigator, 'keyboard', { value: keyboard, configurable: true });
  });
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles({ name: 'keys.npz', mimeType: 'application/octet-stream', buffer: npz([
    ['stack', npy([2, 5, 6], { value: () => 10 })],
    ['K', npy([3, 3], { value: () => 20 })],
    ['other', npy([2, 5, 6], { value: () => 30 })],
  ]) });
  const hint = page.locator('.dataset-axis-hint').first();
  await expect.poll(() => pixel(page)).toEqual([10]);
  await expect(hint).toHaveText('Ü +');
  await navigationKey(page, '+', 'BracketRight');
  await expect.poll(() => pixel(page)).toEqual([20]);
  await navigationKey(page, '+', 'BracketRight');
  await expect.poll(() => pixel(page)).toEqual([30]);
  await navigationKey(page, 'ü', 'BracketLeft');
  await expect.poll(() => pixel(page)).toEqual([20]);
  // Option-produced literal brackets remain available, without mistaking
  // Ctrl shortcuts for navigation.
  await navigationKey(page, ']', 'Digit9', { altKey: true });
  await expect.poll(() => pixel(page)).toEqual([30]);
  await page.evaluate(() => window.postMessage({ type: 'updateSettings', settings: { navigationShortcuts: { '1': ['KeyJ', 'KeyK'] } } }, location.origin));
  await expect(hint).toHaveText('J K');
  await navigationKey(page, 'j', 'KeyJ');
  await expect.poll(() => pixel(page)).toEqual([20]);
  // Overridden bindings replace their old aliases.
  await navigationKey(page, '+', 'BracketRight');
  await navigationKey(page, 'k', 'KeyK', { ctrlKey: true });
  await expect.poll(() => pixel(page)).toEqual([20]);
  await navigationKey(page, 'k', 'KeyK');
  await expect.poll(() => pixel(page)).toEqual([30]);
  await page.evaluate(() => window.postMessage({ type: 'updateSettings', settings: { navigationShortcuts: {} } }, location.origin));
  await expect(hint).toHaveText('Ü +');
  await navigationKey(page, '+', 'BracketRight');
  await expect.poll(() => pixel(page)).toEqual([10]);
  await page.evaluate(() => {
    const keyboard = (navigator as any).keyboard;
    keyboard.getLayoutMap = async () => new Map([['BracketLeft', 'å'], ['BracketRight', '^']]);
    keyboard.dispatchEvent(new Event('layoutchange'));
  });
  await expect(hint).toHaveText('Å ^');
});

test('navigation survives a Keyboard API without EventTarget and denied layout lookup', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': "style-src 'self'" } });
  });
  await page.addInitScript(() => {
    (window as any).__styleViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      if (event.effectiveDirective.startsWith('style-src')) (window as any).__styleViolations.push(event.blockedURI);
    });
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'keyboard', { value: { getLayoutMap: async () => { throw new Error('Not allowed'); } }, configurable: true });
  });
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles({ name: 'keys.npz', mimeType: 'application/octet-stream', buffer: npz([
    ['first', npy([3, 3])], ['second', npy([3, 3])],
  ]) });
  const array = page.locator('.dataset-overlay select').first();
  await expect(array).toBeVisible();
  await navigationKey(page, 'ü', 'BracketLeft');
  await expect(array).toHaveValue('1');
  await navigationKey(page, '+', 'BracketRight');
  await expect(array).toHaveValue('0');
  await expect(page.locator('.dataset-axis-hint').first()).toHaveText('Ü +');
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => (window as any).__styleViolations)).toEqual([]);
  await expect(page.locator('.histogram-tooltip')).toHaveCSS('position', 'absolute');
  await expect(page.locator('.histogram-labels')).toHaveCSS('display', 'flex');
});

async function depthPlane(page: Page) {
  return page.evaluate(() => new Promise<any>((resolve, reject) => {
    const id = crypto.randomUUID();
    const listener = (event: Event) => {
      const message = (event as CustomEvent).detail;
      if (message.type !== 'depthPlaneResult' || message.id !== id) return;
      clearTimeout(timer); window.removeEventListener('__numpyMessage', listener);
      resolve({ error: message.error, bytes: message.bytes ? Array.from(message.bytes) : undefined });
    };
    const timer = setTimeout(() => { window.removeEventListener('__numpyMessage', listener); reject(new Error('Depth export timed out')); }, 5000);
    window.addEventListener('__numpyMessage', listener);
    window.postMessage({type:'requestDepthPlane',id},location.origin);
  }));
}

test('depth handoff exports the selected raw array and slice and rejects RGB', async ({ page }) => {
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles({ name:'depth.npz',mimeType:'application/octet-stream',buffer:npz([
    ['first',npy([3,5,6],{value:()=>1})],
    ['depth',npy([3,5,6],{value:(_,c)=>1000+c[0]*100+c[1]*6+c[2]})],
    ['rgb',npy([5,6,3])],
  ]) });
  const overlay=page.locator('.dataset-overlay');
  await expect(overlay).toBeVisible();
  await overlay.locator('select').first().selectOption('1');
  await expect.poll(()=>pixel(page)).toEqual([1000]);
  await overlay.locator('input[type=range]').fill('2');
  await overlay.locator('input[type=range]').dispatchEvent('input');
  await expect.poll(()=>pixel(page)).toEqual([1200]);
  await expect(overlay).not.toHaveClass(/dataset-overlay--loading/);
  const result=await depthPlane(page);
  expect(result.error).toBeUndefined();
  const bytes=Buffer.from(result.bytes);
  const offset=10+bytes.readUInt16LE(8);
  expect(bytes.subarray(10,offset).toString()).toContain("'shape': (5, 6)");
  expect(Array.from({length:30},(_,i)=>bytes.readDoubleLE(offset+i*8))).toEqual(Array.from({length:30},(_,i)=>1200+i));
  await overlay.locator('select').first().selectOption('2');
  await expect.poll(()=>pixel(page)).toEqual([0,1,2]);
  await expect(overlay).not.toHaveClass(/dataset-overlay--loading/);
  expect((await depthPlane(page)).error).toContain('single-channel');
});


test('German defaults move plane sliders without Shift and US hints retain symbols', async ({ page }) => {
  await page.addInitScript(() => {
    const keyboard = new EventTarget();
    (keyboard as any).getLayoutMap = async () => new Map([
      ['BracketLeft', 'ü'], ['BracketRight', '+'], ['Comma', ','], ['Period', '.'],
      ['Semicolon', 'ö'], ['Quote', 'ä'],
    ]);
    Object.defineProperty(navigator, 'keyboard', { value: keyboard, configurable: true });
  });
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles({ name: 'planes.npz', mimeType: 'application/octet-stream', buffer: npz(researchEntries()) });
  const overlay = page.locator('.dataset-overlay');
  await expect.poll(() => pixel(page)).toEqual([0]);
  await expect(overlay.locator('.dataset-axis-hint').nth(2)).toHaveText(', .');
  await navigationKey(page, '.', 'Period');
  await expect.poll(() => pixel(page)).toEqual([100]);
  await navigationKey(page, ',', 'Comma');
  await expect.poll(() => pixel(page)).toEqual([0]);
  await page.evaluate(() => {
    const keyboard = (navigator as any).keyboard;
    keyboard.getLayoutMap = async () => new Map([
      ['BracketLeft', '['], ['BracketRight', ']'], ['Comma', ','], ['Period', '.'],
      ['Semicolon', ';'], ['Quote', "'"],
    ]);
    keyboard.dispatchEvent(new Event('layoutchange'));
  });
  await expect(overlay.locator('.dataset-axis-hint').nth(2)).toHaveText('< >');
  await navigationKey(page, '>', 'Period', { shiftKey: true });
  await expect.poll(() => pixel(page)).toEqual([100]);
});

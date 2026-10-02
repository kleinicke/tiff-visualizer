import { test, expect } from '@playwright/test';
import path from 'node:path';

test('CZI keeps the latest requested plane while decoding and clears its loading light', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message: any, transfer: any) {
        if (message?.format === 'czi') {
          setTimeout(() => super.postMessage(message, transfer), 400);
        } else super.postMessage(message, transfer);
      }
    };
  });
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles(path.resolve('test-samples/scientific/synthetic-stack.czi'));
  const ranges = page.locator('.dataset-overlay input[type=range]');
  await expect(ranges.first()).toBeVisible();
  const slider = ranges.last();
  const max = Number(await slider.getAttribute('max'));
  expect(max).toBeGreaterThan(0);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveValue('1');
  // Press again while the first decode is deliberately delayed. The controls
  // must advance immediately, and the completed older plane must not reset them.
  await page.keyboard.press('ArrowRight');
  const target = String(2 % (max + 1));
  await expect(slider).toHaveValue(target);
  await expect(page.locator('.dataset-overlay')).not.toHaveClass(/dataset-overlay--loading/, { timeout: 15000 });
  await expect(slider).toHaveValue(target);
  await expect(page.locator('body')).toHaveClass(/ready/);
  // Keep requesting planes for several decode cycles. Completed canvases must
  // appear before input stops, rather than starving the preview until keyup.
  await page.evaluate(() => {
    const state = { frames: 0, presses: 0, running: true };
    (window as any).__scrub = state;
    const observer = new MutationObserver(records => {
      if (!state.running) return;
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof HTMLCanvasElement && !node.classList.contains('measure-overlay')) state.frames++;
      }
    });
    observer.observe(document.body, { childList: true });
    const timer = setInterval(() => {
      state.presses++;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
    }, 40);
    (window as any).__stopScrub = () => { clearInterval(timer); state.running = false; observer.disconnect(); };
  });
  try {
    await expect.poll(() => page.evaluate(() => (window as any).__scrub.frames), { timeout: 10000 }).toBeGreaterThanOrEqual(2);
  } finally { await page.evaluate(() => (window as any).__stopScrub()); }
  const presses = await page.evaluate(() => (window as any).__scrub.presses);
  const finalTarget = String((Number(target) + presses) % (max + 1));
  await expect(slider).toHaveValue(finalTarget);
  await expect(page.locator('.dataset-overlay')).not.toHaveClass(/dataset-overlay--loading/, { timeout: 15000 });
  await expect(slider).toHaveValue(finalTarget);

});

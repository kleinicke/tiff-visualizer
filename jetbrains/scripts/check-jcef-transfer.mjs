// Exercise the packaged Java file server in the real JetBrains browser, where
// response.blob() used to fail for large files even though Chromium tests passed.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.connectOverCDP(process.env.JCEF_ENDPOINT || 'http://127.0.0.1:9223', { noDefaults: true });
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('/image/'));
if (!page) throw new Error('Open an image in the isolated test IDE first');
const original = page.url();
try {
  await page.addInitScript(() => {
    window.__websiteShellMounted = false;
    const selector = '.web-toolbar,.web-empty-state,.web-legal-nav,.web-url-dialog';
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches(selector) || node.querySelector(selector))) window.__websiteShellMounted = true;
      }
    }).observe(document, { childList: true, subtree: true });
  });
  for (const sample of process.argv.slice(2)) {
    const java = path.join(process.env.JAVA_HOME, 'bin/java');
    const server = spawn(java, ['-cp', [path.join(root, 'build/classes/java/main'), path.join(root, 'build/resources/main')].join(path.delimiter), path.join(root, 'scripts/smoke-server.java'), path.resolve(sample), 'image'], { stdio: ['pipe', 'pipe', 'inherit'] });
    try {
      const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Server startup timed out')), 30000);
        server.stdout.once('data', data => { clearTimeout(timer); resolve(data.toString().trim()); });
        server.once('error', reject);
      });
      await page.goto(url);
      await page.waitForFunction(() => document.documentElement.dataset.jetbrainsFileDelivered === 'true', null, { timeout: 60000 });
      await page.waitForFunction(() => window.scientificImageHost?.snapshot().ready && document.querySelector('body > canvas:not(.measure-overlay)')?.width > 1, null, { timeout: 60000 });
      if (sample.endsWith('.czi')) {
        const expected = await page.evaluate(() => {
          const sliders = [...document.querySelectorAll('.dataset-overlay input[type=range]')];
          const slider = sliders.at(-1);
          if (!slider) throw new Error('CZI navigation slider missing');
          const target = (Number(slider.value) + 2) % (Number(slider.max) + 1);
          for (let i = 0; i < 2; i++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
          return String(target);
        });
        await expect(page.locator('.dataset-overlay input[type=range]').last()).toHaveValue(expected);
        await expect(page.locator('.dataset-overlay')).not.toHaveClass(/dataset-overlay--loading/, { timeout: 30000 });
        await expect(page.locator('.dataset-overlay input[type=range]').last()).toHaveValue(expected);
        await page.evaluate(() => {
          window.__scrubFrames = 0;
          window.__scrubObserver = new MutationObserver(records => {
            for (const record of records) for (const node of record.addedNodes) {
              if (node instanceof HTMLCanvasElement && !node.classList.contains('measure-overlay')) window.__scrubFrames++;
            }
          });
          window.__scrubObserver.observe(document.body, { childList: true });
          window.__scrubTimer = setInterval(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true })), 40);
        });
        try {
          await expect.poll(() => page.evaluate(() => window.__scrubFrames), { timeout: 15000 }).toBeGreaterThanOrEqual(2);
        } finally {
          await page.evaluate(() => { clearInterval(window.__scrubTimer); window.__scrubObserver.disconnect(); });
        }
        await expect(page.locator('.dataset-overlay')).not.toHaveClass(/dataset-overlay--loading/, { timeout: 30000 });
        console.log('CZI continuous preview, rapid navigation and loading-light reset passed in JCEF');
      }
      expect(await page.evaluate(() => window.__websiteShellMounted)).toBe(false);
      await expect(page.locator('[role=alert]')).toHaveCount(0);
      console.log(`${path.basename(sample)}: ${await page.evaluate(() => window.scientificImageHost.snapshot().size)}, delivered and rendered; website shell never mounted`);
    } finally { server.kill(); }
  }
} finally {
  await page.goto(original).catch(() => {});
  await browser.close();
}

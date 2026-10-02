// Tests the actual JCEF page; native Save/Cancel/Overwrite dialogs are manual.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const browser = await chromium.connectOverCDP(process.env.JCEF_ENDPOINT || 'http://127.0.0.1:9223', { noDefaults: true });
try {
  const pages = browser.contexts().flatMap(context => context.pages()).filter(page => page.url().includes('/image/index.html'));
  if (!pages.length) throw new Error('Open an image in the isolated IDE first');
  let nativeStatusEditors = 0;
  for (const [index, page] of pages.entries()) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.reload();
    await page.waitForFunction(() => document.body.classList.contains('ready') && window.scientificImageHost?.snapshot().size);
    await expect(page.locator('.web-toolbar')).toBeHidden();
    const nativeStatus = await page.evaluate(() => document.documentElement.classList.contains('jetbrains-native-status'));
    if (nativeStatus) { await expect(page.locator('.web-status-bar')).toBeHidden(); nativeStatusEditors++; }
    else await expect(page.locator('.web-status-bar')).toBeVisible();
    await page.evaluate(() => window.scientificImageHost.adjust('gamma', [1.8, 2.2]));
    await expect.poll(() => page.evaluate(() => window.scientificImageHost.snapshot().gamma.in)).toBe(1.8);
    await page.evaluate(() => window.scientificImageHost.adjust('auto', []));
    // Capture the generated download bytes without opening a native save dialog.
    await page.evaluate(() => {
      window.__exportResult = null;
      window.__anchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (!this.download) return window.__anchorClick.call(this);
        fetch(this.href).then(r => r.arrayBuffer()).then(data => { window.__exportResult = { name: this.download, bytes: Array.from(new Uint8Array(data)) }; });
      };
      window.scientificImageHost.command('exportLayers');
    });
    await page.waitForFunction(() => window.__exportResult);
    const result = await page.evaluate(() => { HTMLAnchorElement.prototype.click = window.__anchorClick; return window.__exportResult; });
    expect(Buffer.from(result.bytes).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const directory = path.resolve('jetbrains/build/release-evidence');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `jcef-export-${index}.png`), Buffer.from(result.bytes));
    await page.screenshot({ path: path.join(directory, `jcef-image-${index}.png`) });
    expect(errors).toEqual([]);
    console.log(`JCEF editor ${index}: gamma, export and reload passed`);
  }
  expect(nativeStatusEditors, 'At least the selected editor must use native status widgets').toBeGreaterThan(0);
  console.log(`${nativeStatusEditors} editor(s) connected to native status widgets`);
} finally { await browser.close(); }

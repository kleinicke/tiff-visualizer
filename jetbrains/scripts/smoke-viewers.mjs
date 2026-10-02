import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java';
const classpath = [path.join(root, 'build/classes/java/main'), path.join(root, 'build/resources/main')].join(path.delimiter);
if (process.argv.length < 3) throw new Error('Pass image sample paths');
const browser = await chromium.launch();
try {
  for (const [kind, sample] of process.argv.slice(2).map(sample => ['image', sample])) {
    if (!sample) throw new Error('Pass image sample paths');
    const host = spawn(java, ['-cp', classpath, path.join(root, 'scripts/smoke-server.java'), path.resolve(sample), kind], { stdio: ['pipe', 'pipe', 'inherit'] });
    try {
      const line = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Java host startup timed out')), 30000);
        host.stdout.once('data', data => { clearTimeout(timeout); resolve(data); });
        host.once('error', error => { clearTimeout(timeout); reject(error); });
        host.once('exit', code => { clearTimeout(timeout); reject(new Error(`Java host exited: ${code}`)); });
      });
      const page = await browser.newPage();
      await page.setViewportSize({ width: 856, height: 900 });
      const failures = [];
      page.on('pageerror', error => failures.push(error.message));
      page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
      page.on('response', response => { if (response.status() >= 400) console.error(response.status(), response.url()); });
      await page.goto(line.toString().trim());
      await page.waitForFunction(() => document.documentElement.dataset.jetbrainsFileDelivered === 'true');
      if (kind === 'image') {
        await page.waitForFunction(() => {
          const canvas = document.querySelector('body > canvas:not(.measure-overlay)');
          return canvas && canvas.width > 1 && canvas.height > 1;
        });
      }
      if (kind === 'image') {
        await page.waitForFunction(() => window.scientificImageHost?.snapshot().ready);
        await page.waitForFunction(() => /^\d+x\d+$/.test(document.getElementById('web-status-size').textContent));
        await page.evaluate(() => {
          const canvas = document.querySelector('body > canvas:not(.measure-overlay)');
          const size = document.getElementById('web-status-size');
          const dimensions = size.textContent;
          const rect = canvas.getBoundingClientRect();
          canvas.dispatchEvent(new MouseEvent('mouseenter', { clientX: rect.left + 10, clientY: rect.top + 10 }));
          if (size.textContent === dimensions) throw new Error('Pixel readout did not appear');
          canvas.dispatchEvent(new MouseEvent('mouseleave'));
          if (size.textContent !== dimensions) throw new Error('Dimensions were not restored after mouse leave');
          const bar = document.querySelector('.web-status-bar');
          if (bar.scrollWidth <= bar.clientWidth && Math.abs(bar.lastElementChild.getBoundingClientRect().right - bar.getBoundingClientRect().right) > 2) {
            throw new Error('Status controls are not aligned to the right');
          }
        });
        await page.evaluate(() => window.scientificImageHost.adjust('range', [0, 128]));
        const range = await page.evaluate(() => window.scientificImageHost.snapshot().normalization);
        if (range.max !== 128 || range.autoNormalize) throw new Error('Native range adjustment not applied');
        await page.evaluate(() => window.scientificImageHost.adjust('gamma', [1, 2.2]));
        const gamma = await page.evaluate(() => window.scientificImageHost.snapshot());
        if (gamma.gamma.in !== 1 || !gamma.normalization.gammaMode) throw new Error('Native gamma adjustment not applied');
        await page.evaluate(() => window.scientificImageHost.adjust('auto', []));
        await page.evaluate(() => {
          window.__nativeStatus = [];
          window.jetbrainsConnectStatus(json => window.__nativeStatus.push(JSON.parse(json)));
          const items = window.__nativeStatus.at(-1).statusItems;
          if (!items.some(item => item.id === 'size' && item.text.includes('x'))) throw new Error('Native status snapshot omitted dimensions');
          document.documentElement.classList.add('jetbrains-native-status');
          window.scientificImageHost.statusAction('gamma');
        });
        if (await page.locator('.web-status-bar').isVisible()) throw new Error('Duplicate viewer status bar remained visible');
        if (!await page.locator('#web-control-popover').isVisible()) throw new Error('Native gamma action failed to open settings');
        await page.locator('#web-control-popover input[name="gammaIn"]').fill('1.8');
        await page.locator('#web-control-popover button[type="submit"]').click();
        await page.waitForFunction(() => window.__nativeStatus.at(-1)?.gamma.in === 1.8);
        await page.evaluate(() => {
          window.jetbrainsDisconnectStatus();
          document.documentElement.classList.remove('jetbrains-native-status');
        });
        if (await page.locator('.web-toolbar').isVisible()) throw new Error('Website branding leaked into IDE');
        if (await page.locator('#web-status-options').isVisible() || await page.locator('#web-status-layers').isVisible()) throw new Error('Website-only status actions leaked into IDE');
        if (!await page.locator('.web-status-bar').isVisible()) throw new Error('Contextual status controls are missing');
        await page.evaluate(() => {
          const panel = document.createElement('div');
          panel.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:100px;overflow:auto;z-index:999999';
          const content = document.createElement('div');
          content.style.cssText = 'width:1000px;height:1000px';
          panel.append(content);
          document.body.append(panel);
          try {
            const pan = (dx, dy) => window.jetbrainsPan(50 / innerWidth, 50 / innerHeight, dx, dy);
            pan(0, 0.8); pan(0, 0.8);
            if (panel.scrollTop !== 1) throw new Error('Small native pan deltas were lost');
            pan(12, 8);
            if (panel.scrollLeft !== 12 || panel.scrollTop !== 9) throw new Error('Native pan missed the scrollable panel');
            panel.addEventListener('wheel', event => event.preventDefault(), { passive: false, once: true });
            pan(0, 20);
            if (panel.scrollTop !== 9) throw new Error('Native pan ignored a custom wheel handler');
          } finally { panel.remove(); }
        });
      }
      // Exercise the real export pipeline, validate the PNG header and reopen
      // the saved file through the shared file-input path.
      const dimensions = await page.evaluate(async () => {
        const canvas = document.querySelector('body > canvas:not(.measure-overlay)');
        const reference = document.createElement('canvas');
        reference.width = canvas.width; reference.height = canvas.height;
        const ctx = reference.getContext('2d'); ctx.drawImage(canvas, 0, 0);
        window.__exportPixels = Array.from(ctx.getImageData(0, 0, reference.width, reference.height).data);
        return [canvas.width, canvas.height];
      });

      const downloadPromise = page.waitForEvent('download');
      await page.evaluate(() => window.scientificImageHost.command('exportLayers'));
      const download = await downloadPromise.catch(async error => { console.error(await page.locator('body').innerText()); throw error; });
      assert.equal(download.suggestedFilename(), 'scientific-image-export.png');
      const exportDir = path.join(root, 'build/release-evidence');
      await mkdir(exportDir, { recursive: true });
      const exported = path.join(exportDir, `${path.basename(sample)}.png`);
      await download.saveAs(exported);
      const bytes = await readFile(exported);
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], dimensions);
      await page.evaluate(async encoded => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], { type: 'image/png' }));
        const decoded = document.createElement('canvas'); decoded.width = bitmap.width; decoded.height = bitmap.height;
        const ctx = decoded.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
        const pixels = ctx.getImageData(0, 0, decoded.width, decoded.height).data;
        if (pixels.length !== window.__exportPixels.length || pixels.some((v, i) => v !== window.__exportPixels[i])) throw new Error('PNG export pixels differ from displayed image');
      }, bytes.toString('base64'));
      await page.evaluate(() => { window.__previousCanvas = document.querySelector('body > canvas:not(.measure-overlay)'); });
      await page.locator('#web-file-input').setInputFiles(exported);
      await page.waitForFunction(() => {
        const current = document.querySelector('body > canvas:not(.measure-overlay)');
        return current && current !== window.__previousCanvas && document.body.classList.contains('ready');
      });
      await page.reload();
      await page.waitForFunction(() => document.body.classList.contains('ready') && document.documentElement.dataset.jetbrainsFileDelivered === 'true');
      console.log(`${path.basename(sample)}: PNG export dimensions, pixel equality and reopen passed`);
      // Svelte keeps the legal navigation mounted; embedded-host CSS hides it.
      if (await page.locator('.web-legal-nav:visible, .bottom-right-nav:visible').count()) throw new Error('Website legal navigation leaked into IDE');
      if (failures.length) throw new Error(failures.join('\n'));
      await page.screenshot({ path: path.join(root, `build/${kind}-smoke.png`) });
      console.log(`${kind}: selected file decoded and rendered through the Java host`);
      await page.close();
    } finally { host.stdin.end('\n'); host.kill(); }
  }
} finally { await browser.close(); }

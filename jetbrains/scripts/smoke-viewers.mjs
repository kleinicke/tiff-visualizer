import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java';
const classpath = [path.join(root, 'build/classes/java/main'), path.join(root, 'build/resources/main')].join(path.delimiter);
const browser = await chromium.launch();
try {
  for (const [kind, sample] of [['image', process.argv[2]], ['ply', process.argv[3]]]) {
    if (!sample) throw new Error('Pass TIFF and PLY sample paths');
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
      await page.goto(line.toString().trim());
      await page.waitForFunction(() => document.documentElement.dataset.jetbrainsFileDelivered === 'true');
      if (kind === 'image') {
        await page.waitForFunction(() => {
          const canvas = document.querySelector('body > canvas:not(.measure-overlay)');
          return canvas && canvas.width > 1 && canvas.height > 1;
        });
      } else {
        await page.waitForFunction(() => window.visualizer?.meshes?.length > 0);
        if (await page.locator('.bottom-right-nav').count()) throw new Error('Website footer leaked into IDE');
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
        if (await page.locator('.web-toolbar').isVisible()) throw new Error('Website branding leaked into IDE');
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
      if (await page.locator('.web-legal-nav, .bottom-right-nav').count()) throw new Error('Website legal navigation leaked into IDE');
      if (failures.length) throw new Error(failures.join('\n'));
      await page.screenshot({ path: path.join(root, `build/${kind}-smoke.png`) });
      console.log(`${kind}: selected file decoded and rendered through the Java host`);
      await page.close();
    } finally { host.stdin.end('\n'); host.kill(); }
  }
} finally { await browser.close(); }

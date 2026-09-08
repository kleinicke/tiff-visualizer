import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/**
 * End-to-end smoke test for the REAL webview bundle.
 *
 * Every other suite in this repo tests a module in isolation: it bundles one
 * source file with esbuild and drives its exported class. That is useful, but
 * it cannot catch anything that only goes wrong once the shipped bundle is
 * loaded the way VS Code loads it. Three such bugs reached the user in a
 * single session while every existing test stayed green:
 *
 *   1. `tiff-wasm-wrapper.ts` dynamically imported '../wasm/tiff-wasm.js'.
 *      That specifier resolves against the BUNDLE (media/), not the source
 *      file, so it 404'd at the repository root and silently disabled
 *      main-thread WASM for every format.
 *   2. The follow-up fix loaded the glue from its own directory instead, which
 *      moved the 404 to media/wasm/wasm/tiff-wasm.wasm, because the glue's
 *      patched payload URL assumes it was bundled.
 *   3. A WebGPU texture over the device budget produced a blank canvas while
 *      reporting a successful render.
 *
 * (1) and (2) are pure packaging faults: the code is correct, the paths are
 * not. Only loading the actual bundle finds them. This suite therefore serves
 * the repository over HTTP, loads `media/imagePreview.bundle.js` into a page
 * with the globals VS Code provides, and asserts that nothing 404s and that
 * the WASM module actually initializes.
 *
 * Run with: npx playwright test test/playwright/webview-bundle.spec.ts
 */

const repoRoot = path.join(__dirname, '..', '..');

const CONTENT_TYPES: Record<string, string> = {
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.wasm': 'application/wasm',
	'.json': 'application/json',
};

/**
 * Serves repository files for any request under /media/, mirroring how the
 * webview resolves its resources. Requests that escape the repository or name
 * a missing file are answered 404 so the test can observe them, exactly as the
 * webview's resource loader would.
 */
async function serveRepository(page: import('@playwright/test').Page, missing: string[]) {
	await page.route('**/*', async route => {
		const url = new URL(route.request().url());
		if (url.hostname !== 'tiff-visualizer.test') { return route.continue(); }
		const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
		const filePath = path.join(repoRoot, relative);
		if (!filePath.startsWith(repoRoot) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
			missing.push(relative);
			return route.fulfill({ status: 404, body: 'not found' });
		}
		return route.fulfill({
			status: 200,
			contentType: CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
			body: fs.readFileSync(filePath),
		});
	});
}

test('the shipped webview bundle loads and initializes WASM with no missing resources', async ({ page }) => {
	const bundlePath = path.join(repoRoot, 'media', 'imagePreview.bundle.js');
	expect(fs.existsSync(bundlePath), 'run `npm run compile` first').toBe(true);

	const missing: string[] = [];
	const consoleLines: string[] = [];
	const pageErrors: string[] = [];
	page.on('console', message => consoleLines.push(message.text()));
	page.on('pageerror', error => pageErrors.push(String(error)));
	await serveRepository(page, missing);

	// The DOM and globals the extension's generated HTML provides. Without
	// `acquireVsCodeApi` the bundle throws immediately.
	await page.goto('https://tiff-visualizer.test/harness.html', { waitUntil: 'domcontentloaded' }).catch(() => { /* served below */ });
	await page.setContent(`<!DOCTYPE html><html><body class="container image">
		<div class="loading-indicator"></div>
		<div class="image-load-error"><p>error</p></div>
		<meta id="image-preview-settings"
			data-settings='{"isMac":false,"gpuAcceleration":true,"src":"https://tiff-visualizer.test/test-samples/house.tif","resourceUri":"https://tiff-visualizer.test/test-samples/house.tif"}'
			data-resource="https://tiff-visualizer.test/test-samples/house.tif"
			data-folder="https://tiff-visualizer.test/test-samples/"
			data-version="1">
	</body></html>`);
	await page.addScriptTag({ url: 'https://tiff-visualizer.test/web/vendor-assets.js' });
  await page.addScriptTag({ content: `window.messages = [];
    window.acquireVsCodeApi = () => ({
      postMessage(message) {
        window.messages.push(message);
        if (message.type === 'formatInfo') window.postMessage({ type: 'updateSettings', isInitialRender: true,
          settings: { normalization: { min: 0, max: 255, autoNormalize: false, gammaMode: true }, gamma: { in: 2.2, out: 2.2 }, brightness: { offset: 0 } }
        }, '*');
      }, setState(){}, getState(){ return undefined; }
    });` });

	await page.addScriptTag({ url: 'https://tiff-visualizer.test/media/imagePreview.bundle.js', type: 'module' })
		.catch(error => { pageErrors.push(`bundle failed to load: ${error}`); });

  // Decode a real image: an old startup log is not proof the decoder ran.
  await expect(page.locator('body')).toHaveClass(/ready/, { timeout: 15_000 });
  const format = await page.evaluate(() => (window as any).messages.find((message: any) => message.type === 'formatInfo')?.value);
  expect(format?.decodedWith).toMatch(/^wasm/);

	const wasmMissing = missing.filter(name => name.includes('wasm'));
	expect(wasmMissing, `the bundle requested WASM resources that do not exist: ${wasmMissing.join(', ')}`).toEqual([]);

  expect(pageErrors, `bundle raised errors: ${pageErrors.join(' | ')}`).toEqual([]);

});

test('Svelte comparison renders filenames safely and preserves its host protocol under CSP', async ({ page }) => {
  const missing: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await serveRepository(page, missing);
  const filename = '<img src=x onerror=alert(1)>.png';
  const images = [{ filename, uri: 'file:///comparison.png', webviewUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }];
  await page.route('**/comparison-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-test'; style-src https://tiff-visualizer.test; img-src data:">
    <link rel="stylesheet" href="/media/comparisonPanel.css"><link rel="stylesheet" href="/media/comparisonPanel.bundle.css"></head><body>
    <script nonce="test">window.messages = []; window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message) }); window.imageData = ${JSON.stringify(images).replace(/</g, '\\u003c')};</script>
    <script nonce="test" src="/media/comparisonPanel.bundle.js"></script></body></html>` }));
  await page.goto('https://tiff-visualizer.test/comparison-test');
  await expect(page.locator('.image-filename')).toHaveText(filename);
  await expect(page.locator('.image-count')).toHaveText('1 images');
  await expect(page.locator('.image-filename img')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window as any).messages)).toEqual([
    { type: 'openImageInMainEditor', uri: images[0].uri }, { type: 'removeImage', uri: images[0].uri }, { type: 'closePanel' },
  ]);
  expect(errors).toEqual([]);
  expect(missing).toEqual([]);
});

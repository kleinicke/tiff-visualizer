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
	await page.goto('https://tiff-visualizer.test/media/harness.html', { waitUntil: 'domcontentloaded' }).catch(() => { /* served below */ });
	await page.setContent(`<!DOCTYPE html><html><body class="container image">
		<div class="loading-indicator"></div>
		<div class="image-load-error"><p>error</p></div>
		<meta id="image-preview-settings"
			data-settings='{"isMac":false,"gpuAcceleration":true}'
			data-resource="https://tiff-visualizer.test/test-samples/house.tif"
			data-folder="https://tiff-visualizer.test/test-samples/"
			data-version="1">
	</body></html>`);
	await page.addScriptTag({ content: 'window.acquireVsCodeApi = () => ({ postMessage(){}, setState(){}, getState(){ return undefined; } });' });

	await page.addScriptTag({ url: 'https://tiff-visualizer.test/media/imagePreview.bundle.js', type: 'module' })
		.catch(error => { pageErrors.push(`bundle failed to load: ${error}`); });

	// The wrapper reports WASM availability once at startup; wait for either
	// outcome rather than a fixed delay.
	await page.waitForFunction(
		() => (window as any).__wasmStartupSeen === true,
		null, { timeout: 15_000 },
	).catch(() => { /* asserted through the console lines below */ });
	await page.waitForTimeout(2000);

	const wasmMissing = missing.filter(name => name.includes('wasm'));
	expect(wasmMissing, `the bundle requested WASM resources that do not exist: ${wasmMissing.join(', ')}`).toEqual([]);

	const unavailable = consoleLines.filter(line => line.includes('Rust/WASM decoder unavailable'));
	expect(unavailable, `WASM failed to initialize in the bundle: ${unavailable.join(' | ')}`).toEqual([]);

	const fatal = pageErrors.filter(error => !/Cannot read|is not defined/.test(error));
	expect(fatal, `bundle raised errors: ${fatal.join(' | ')}`).toEqual([]);

	// Positive confirmation: the shared decoder came up.
	expect(
		consoleLines.some(line => line.includes('Rust/WASM decoder ready')),
		`expected the startup readiness log; saw:\n${consoleLines.slice(0, 40).join('\n')}`,
	).toBe(true);
});

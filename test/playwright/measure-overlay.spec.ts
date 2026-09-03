import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import fs from 'fs';
import path from 'path';

/**
 * The measurement overlay in a real browser, against the real stylesheet.
 *
 * Everything here exists because the overlay's visibility depends on things a
 * unit test cannot see: the webview puts the image directly on
 * `<body class="container image">` (a flex container), the overlay is a
 * viewport-sized fixed canvas appended to that same body, and whether one
 * paints over the other is decided by CSS stacking, not by any code path.
 *
 * The assertions therefore read pixels back off a screenshot rather than
 * inspecting object state: "the code ran" is not the question, "is it on
 * screen" is.
 */

const ROOT = path.join(__dirname, '..', '..');

function bundleOverlay(): string {
	return buildSync({
		entryPoints: [path.join(ROOT, 'media', 'modules', 'measure', 'roi-overlay.ts')],
		bundle: true,
		write: false,
		format: 'iife',
		globalName: 'MeasureOverlayTest',
		platform: 'browser',
		target: 'chrome100',
		// The overlay pulls in the ROI manager through its constructor argument
		// only, so re-export it here to build the same object graph the webview
		// does.
		footer: { js: 'window.MeasureOverlayTest.__loaded = true;' },
	}).outputFiles[0].text;
}

function bundleManager(): string {
	return buildSync({
		entryPoints: [path.join(ROOT, 'media', 'modules', 'measure', 'roi-manager.ts')],
		bundle: true,
		write: false,
		format: 'iife',
		globalName: 'MeasureManagerTest',
		platform: 'browser',
		target: 'chrome100',
	}).outputFiles[0].text;
}

/**
 * Reproduce the webview's DOM exactly: body carries the container classes and
 * the image canvas is its only child. Getting this wrong would make the test
 * pass while the extension stays broken.
 */
async function setupPage(page: import('@playwright/test').Page, options: { scaleToFit?: boolean } = {}) {
	const css = fs.readFileSync(path.join(ROOT, 'media', 'imagePreview.css'), 'utf8');
	await page.setViewportSize({ width: 800, height: 600 });
	await page.setContent(`<!doctype html><html><head><style>${css}</style></head>
<body class="container image ready"></body></html>`);

	await page.evaluate((scaleToFit) => {
		const canvas = document.createElement('canvas');
		canvas.width = 200;
		canvas.height = 150;
		canvas.style.width = '200px';
		canvas.style.height = '150px';
		canvas.style.flex = 'none';
		if (scaleToFit) { canvas.className = 'scale-to-fit'; }
		const ctx = canvas.getContext('2d')!;
		// Mid grey, so both the red and the green overlay tints are unambiguous.
		ctx.fillStyle = '#808080';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		document.body.appendChild(canvas);
		(window as any).__imageElement = canvas;
	}, options.scaleToFit === true);

	await page.addScriptTag({ content: bundleManager() });
	await page.addScriptTag({ content: bundleOverlay() });

	await page.evaluate(() => {
		const { RoiManager } = (window as any).MeasureManagerTest;
		const { RoiOverlay } = (window as any).MeasureOverlayTest;
		const manager = new RoiManager();
		const image = (window as any).__imageElement as HTMLCanvasElement;
		const plane = new Float32Array(image.width * image.height).fill(50);

		const overlay = new RoiOverlay(manager, {
			getImageElement: () => image,
			getSource: () => ({
				width: image.width, height: image.height, channels: 1,
				data: plane, isFloat: true, typeMax: 255,
			}),
			getScalarPlane: () => plane,
			getCalibration: () => (window as any).__calibration
				|| ({ pixelWidth: 1, pixelHeight: 1, unit: 'px', origin: 'none' }),
			onCalibrationLine: () => { /* not exercised here */ },
			onRoiEdited: () => { /* not exercised here */ },
			onHint: () => { /* not exercised here */ },
		});
		(window as any).__overlay = overlay;
		(window as any).__manager = manager;
	});
}

test('the scale bar can be dragged outside the image and stays put while zooming', async ({ page }) => {
	await setupPage(page);
	await page.evaluate(() => {
		(window as any).__calibration = {
			pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm', origin: 'tags',
		};
		(window as any).__overlay.setShowScaleBar(true);
	});
	await redraw(page);

	const handle = page.locator('.measure-scale-bar-handle');
	await expect(handle).toBeVisible();
	const initial = await handle.boundingBox();
	expect(initial).not.toBeNull();

	await page.mouse.move(initial!.x + initial!.width / 2, initial!.y + initial!.height / 2);
	await page.mouse.down();
	await page.mouse.move(680, 80);
	await page.mouse.up();
	await redraw(page);

	const moved = await handle.boundingBox();
	const imageRect = await page.evaluate(() => {
		const rect = ((window as any).__imageElement as HTMLElement).getBoundingClientRect();
		return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
	});
	expect(moved).not.toBeNull();
	expect(moved!.x).toBeGreaterThan(imageRect.right);

	await page.evaluate(() => {
		const image = (window as any).__imageElement as HTMLCanvasElement;
		image.style.width = '400px';
		image.style.height = '300px';
		(window as any).__overlay.redraw();
	});
	const zoomed = await handle.boundingBox();
	expect(zoomed).not.toBeNull();
	expect(Math.abs(zoomed!.x - moved!.x)).toBeLessThanOrEqual(1);
	expect(Math.abs(zoomed!.y - moved!.y)).toBeLessThanOrEqual(1);
});

/** Force a synchronous redraw and wait for the frame to land. */
async function redraw(page: import('@playwright/test').Page) {
	await page.evaluate(() => (window as any).__overlay.redraw());
	await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(null))));
}

/**
 * Read a pixel from a screenshot of the whole page, so what is measured is what
 * a user would actually see, including stacking order.
 */
async function pixelAt(page: import('@playwright/test').Page, x: number, y: number): Promise<[number, number, number]> {
	const shot = await page.screenshot({ type: 'png' });
	const base64 = shot.toString('base64');
	return page.evaluate(async ({ data, px, py }) => {
		const image = new Image();
		image.src = `data:image/png;base64,${data}`;
		await image.decode();
		const canvas = document.createElement('canvas');
		canvas.width = image.width;
		canvas.height = image.height;
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(image, 0, 0);
		const pixel = ctx.getImageData(px, py, 1, 1).data;
		return [pixel[0], pixel[1], pixel[2]] as [number, number, number];
	}, { data: base64, px: Math.round(x), py: Math.round(y) });
}

/** Centre of the image element, in viewport coordinates. */
async function imageCentre(page: import('@playwright/test').Page): Promise<{ x: number; y: number }> {
	return page.evaluate(() => {
		const rect = ((window as any).__imageElement as HTMLElement).getBoundingClientRect();
		return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
	});
}

test('the overlay canvas paints above the image', async ({ page }) => {
	await setupPage(page);
	await page.evaluate(() => {
		const overlay = (window as any).__overlay;
		overlay.setActive(true);
		overlay.setMaskPreview({
			width: 200, height: 150,
			mask: new Uint8Array(200 * 150).fill(1),
			accepted: null,
			opacity: 0.45,
		});
	});
	await redraw(page);

	const centre = await imageCentre(page);
	const [r, g, b] = await pixelAt(page, centre.x, centre.y);

	// The image is #808080; a red mask at 45% must pull red clearly above the
	// other two channels. If the overlay were behind the image, or not drawn,
	// this would still read as neutral grey.
	expect(r, `expected a red tint over the image, read rgb(${r}, ${g}, ${b})`).toBeGreaterThan(g + 25);
	expect(r).toBeGreaterThan(b + 25);
});

test('accepted objects are tinted green and the rest stays red', async ({ page }) => {
	await setupPage(page);
	await page.evaluate(() => {
		const overlay = (window as any).__overlay;
		overlay.setActive(true);
		const mask = new Uint8Array(200 * 150).fill(1);
		const accepted = new Uint8Array(200 * 150);
		// Accept the left half only.
		for (let y = 0; y < 150; y++) {
			for (let x = 0; x < 100; x++) { accepted[y * 200 + x] = 1; }
		}
		overlay.setMaskPreview({ width: 200, height: 150, mask, accepted, opacity: 0.5 });
	});
	await redraw(page);

	const rect = await page.evaluate(() => {
		const r = ((window as any).__imageElement as HTMLElement).getBoundingClientRect();
		return { left: r.left, top: r.top, width: r.width, height: r.height };
	});

	const left = await pixelAt(page, rect.left + rect.width * 0.25, rect.top + rect.height / 2);
	const right = await pixelAt(page, rect.left + rect.width * 0.75, rect.top + rect.height / 2);

	expect(left[1], `left half should be green, read rgb(${left.join(', ')})`).toBeGreaterThan(left[0] + 20);
	expect(right[0], `right half should be red, read rgb(${right.join(', ')})`).toBeGreaterThan(right[1] + 20);
});

test('a drawn ROI outline is visible', async ({ page }) => {
	await setupPage(page);
	await page.evaluate(() => {
		const overlay = (window as any).__overlay;
		const manager = (window as any).__manager;
		overlay.setActive(true);
		manager.add({
			id: 'r1', name: 'R1', kind: 'rect',
			x: 20, y: 20, width: 160, height: 110, color: '#ffd400',
		});
	});
	await redraw(page);

	// Sample the top edge of the rectangle, which is a horizontal run of the
	// ROI colour and therefore robust to a pixel of rounding either way.
	const point = await page.evaluate(() => {
		const rect = ((window as any).__imageElement as HTMLElement).getBoundingClientRect();
		const scale = rect.width / 200;
		return { x: rect.left + 100 * scale, y: rect.top + 20 * scale + 0.5 };
	});
	const [r, g, b] = await pixelAt(page, point.x, point.y);

	// #ffd400 over grey: red and green high, blue low.
	expect(b, `expected the ROI outline colour, read rgb(${r}, ${g}, ${b})`).toBeLessThan(r - 30);
	expect(g).toBeGreaterThan(b + 20);
});

test('the overlay still lands on the image in fit-to-window mode', async ({ page }) => {
	// scale-to-fit changes the element's layout size, which is exactly the case
	// where a naive overlay that assumed the natural size would drift.
	await setupPage(page, { scaleToFit: true });
	await page.evaluate(() => {
		const overlay = (window as any).__overlay;
		overlay.setActive(true);
		const mask = new Uint8Array(200 * 150);
		// A block in the lower-right quadrant of the image.
		for (let y = 100; y < 150; y++) {
			for (let x = 150; x < 200; x++) { mask[y * 200 + x] = 1; }
		}
		overlay.setMaskPreview({ width: 200, height: 150, mask, accepted: null, opacity: 0.6 });
	});
	await redraw(page);

	const points = await page.evaluate(() => {
		const rect = ((window as any).__imageElement as HTMLElement).getBoundingClientRect();
		return {
			inside: { x: rect.left + rect.width * 0.9, y: rect.top + rect.height * 0.85 },
			outside: { x: rect.left + rect.width * 0.2, y: rect.top + rect.height * 0.2 },
		};
	});

	const inside = await pixelAt(page, points.inside.x, points.inside.y);
	const outside = await pixelAt(page, points.outside.x, points.outside.y);

	expect(inside[0], `masked corner should be red, read rgb(${inside.join(', ')})`).toBeGreaterThan(inside[1] + 25);
	expect(Math.abs(outside[0] - outside[1]),
		`unmasked area should stay neutral, read rgb(${outside.join(', ')})`).toBeLessThan(12);
});

/**
 * The regression that made the whole feature invisible.
 *
 * `imagePreview.ts` clears the container of every `img`/`canvas` on each image
 * load so a new image starts on a clean background, and the container is
 * `document.body` — the same element this overlay attaches to. The overlay was
 * therefore deleted during the very first load and never appeared, with no
 * error anywhere: a detached canvas accepts every draw call and simply shows
 * nothing.
 */
test('the overlay survives the container being cleared of canvases', async ({ page }) => {
	await setupPage(page);
	await page.evaluate(() => {
		const overlay = (window as any).__overlay;
		overlay.setActive(true);
		overlay.setMaskPreview({
			width: 200, height: 150,
			mask: new Uint8Array(200 * 150).fill(1),
			accepted: null,
			opacity: 0.45,
		});

		// Exactly what the image load path does, minus the overlay exemption —
		// so this test fails if the self-healing re-attach is ever removed.
		document.body.querySelectorAll('img, canvas').forEach(element => {
			if (element !== (window as any).__imageElement) { element.remove(); }
		});
	});
	await redraw(page);

	const centre = await imageCentre(page);
	const [r, g, b] = await pixelAt(page, centre.x, centre.y);
	expect(r, `overlay did not come back after the sweep, read rgb(${r}, ${g}, ${b})`).toBeGreaterThan(g + 25);
});

test('nothing is painted while the overlay is inactive', async ({ page }) => {
	await setupPage(page);
	await page.evaluate(() => {
		const overlay = (window as any).__overlay;
		overlay.setMaskPreview({
			width: 200, height: 150,
			mask: new Uint8Array(200 * 150).fill(1),
			accepted: null,
		});
		// setActive was never called: a user who has not opened the panel must
		// see the image exactly as before.
	});
	await redraw(page);

	const centre = await imageCentre(page);
	const [r, g, b] = await pixelAt(page, centre.x, centre.y);
	expect(Math.abs(r - g), `inactive overlay tinted the image: rgb(${r}, ${g}, ${b})`).toBeLessThan(10);
	expect(Math.abs(g - b)).toBeLessThan(10);
});

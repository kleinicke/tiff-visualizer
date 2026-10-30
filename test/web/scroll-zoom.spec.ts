import { expect, test, type Page } from '@playwright/test';
import * as path from 'node:path';

const image = (page: Page) => page.locator('body > canvas:not(.measure-overlay):not(.detail-patch)').first();
async function settle(page: Page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function setting(page: Page, enabled: boolean) {
  await page.evaluate(scrollToZoom => window.postMessage({ type: 'updateSettings', settings: { scrollToZoom } }, '*'), enabled);
  await settle(page);
}
async function scale(page: Page, scale: number | 'fit') {
  await page.evaluate(scale => window.postMessage({ type: 'setScale', scale }, '*'), scale);
  await settle(page);
}
async function open(page: Page, enabled = true) {
  await page.goto('/');
  await page.locator('#web-file-input').setInputFiles(path.resolve('test-samples/house.tif'));
  await expect.poll(() => image(page).evaluate((element: HTMLCanvasElement) => element.width)).toBe(512);
  await settle(page);
  await setting(page, enabled);
}
async function rect(page: Page) { return (await image(page).boundingBox())!; }
async function drag(page: Page, x: number, y: number, dx: number, dy: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
  await settle(page);
}

for (const initial of ['fit', 0.5, 4] as const) {
  test(`scroll zoom anchors at the cursor from ${initial}`, async ({ page }) => {
    await open(page); await scale(page, initial);
    const before = await rect(page);
    const x = Math.max(100, Math.min(900, before.x + before.width * 0.35));
    const y = Math.max(150, Math.min(500, before.y + before.height * 0.4));
    const u = (x - before.x) / before.width, v = (y - before.y) / before.height;
    await page.mouse.move(x, y); await page.mouse.wheel(0, -100);
    await expect.poll(async () => (await rect(page)).width).toBeGreaterThan(before.width);
    const after = await rect(page);
    expect(Math.abs(after.x + u * after.width - x)).toBeLessThan(2);
    expect(Math.abs(after.y + v * after.height - y)).toBeLessThan(2);
  });

  test(`drag pans and reverses without zooming from ${initial}`, async ({ page }) => {
    await open(page); await scale(page, initial);
    const before = await rect(page);
    const x = Math.max(100, Math.min(850, before.x + before.width / 2));
    const y = Math.max(160, Math.min(450, before.y + before.height / 2));
    await drag(page, x, y, 65, 35);
    const moved = await rect(page);
    expect(moved.x - before.x).toBeCloseTo(65, 0);
    expect(moved.y - before.y).toBeCloseTo(35, 0);
    expect(moved.width).toBeCloseTo(before.width, 0);
    await drag(page, x + 65, y + 35, -65, -35);
    const restored = await rect(page);
    expect(restored.x).toBeCloseTo(before.x, 0); expect(restored.y).toBeCloseTo(before.y, 0);
  });
}

test('double click fits and clears the drag displacement', async ({ page }) => {
  await open(page); await scale(page, 2);
  await drag(page, 600, 350, 60, 30);
  await page.mouse.dblclick(600, 350);
  await expect(page.locator('#web-status-zoom')).toHaveText('Whole Image');
  expect(await image(page).evaluate(element => element.style.translate)).toBe('');
});

test('disabling scroll zoom clears translation without changing magnification', async ({ page }) => {
  await open(page); await scale(page, 0.5);
  const before = await rect(page);
  await drag(page, 640, 350, 80, 40);
  expect((await rect(page)).x).toBeCloseTo(before.x + 80, 0);
  await setting(page, false);
  const after = await rect(page);
  expect(after.x).toBeCloseTo(before.x, 0); expect(after.y).toBeCloseTo(before.y, 0);
  expect(after.width).toBeCloseTo(before.width, 0);
  await drag(page, 640, 350, 60, 30);
  expect((await rect(page)).x).toBeCloseTo(after.x, 0);
});

test('disabled mode retains scrolling and modifier zoom without click zoom', async ({ page }) => {
  await open(page, false); await scale(page, 4);
  const before = await rect(page);
  await page.mouse.move(600, 400); await page.mouse.wheel(0, 150);
  await expect.poll(async () => (await rect(page)).y).toBeLessThan(before.y);
  expect((await rect(page)).width).toBeCloseTo(before.width, 0);
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
  await expect.poll(async () => (await rect(page)).width).toBeGreaterThan(before.width);
  await page.mouse.dblclick(600, 350);
  await expect(page.locator('#web-status-zoom')).not.toHaveText('Whole Image');
});

test('measurement drawing takes priority over drag panning', async ({ page }) => {
  await open(page); await scale(page, 1);
  await page.evaluate(() => window.postMessage({ type: 'toggleMeasure' }, '*'));
  const panel = page.locator('.measure-panel');
  await panel.getByRole('button', { name: 'Rect', exact: true }).click();
  const before = await rect(page);
  await drag(page, 600, 350, 45, 30);
  expect((await rect(page)).x).toBeCloseTo(before.x, 0);
  await panel.locator('.measure-tab').getByText('ROIs', { exact: true }).click();
  await expect(panel.locator('.measure-roi-name')).toHaveCount(1);
});
test('right click still opens the image menu', async ({ page }) => {
  await open(page);
  await image(page).click({ button: 'right' });
  await expect(page.getByText('Channels…', { exact: true })).toBeVisible();
});

for (const enabled of [false, true]) {
  test(`layer move takes priority over viewer pan (${enabled})`, async ({ page }) => {
    await open(page, enabled);
    await page.locator('#web-file-input').evaluate((input: HTMLInputElement) => { input.dataset.mode = 'layers'; });
    await page.locator('#web-file-input').setInputFiles(path.resolve('test-samples/orientation_tag5.tif'));
    const panel = page.locator('.layers-panel');
    await expect(panel.locator('.layer-row')).toHaveCount(2);
    await scale(page, 1);
    const row = panel.locator('.layer-row').first();
    await row.locator('.layer-move').click();
    const offset = Number(await row.getByTitle('X offset', { exact: true }).inputValue());
    const before = await rect(page);
    await drag(page, 600, 350, 48, 32);
    await expect.poll(async () => Number(await row.getByTitle('X offset', { exact: true }).inputValue())).toBeGreaterThan(offset);
    expect((await rect(page)).x).toBeCloseTo(before.x, 0);
  });
}

for (const enabled of [false, true]) {
  test(`single clicks never zoom (${enabled})`, async ({ page }) => {
    await open(page, enabled); await scale(page, 1);
    // Include the old activation message to ensure the obsolete handler is gone.
    await page.evaluate(() => window.postMessage({ type: 'setActive', value: true }, '*'));
    const before = await rect(page);
    await page.mouse.click(600, 350); await settle(page);
    expect(await rect(page)).toEqual(before);
    await page.keyboard.down('Alt');
    await page.mouse.click(600, 350); await page.keyboard.up('Alt'); await settle(page);
    expect(await rect(page)).toEqual(before);
  });
}

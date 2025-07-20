import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

// Utility: open a file by clicking in the explorer
async function openFileByExplorer(page: any, filename: string) {
  await page.waitForSelector('.explorer-folders-view', { timeout: 20000 });
  const rootFolder = await page.locator('.explorer-folders-view .monaco-list-row').first();
  await rootFolder.click({ force: true });
  const fileNode = await page.locator('.explorer-folders-view .monaco-list-row', { hasText: filename }).first();
  await fileNode.waitFor({ state: 'visible', timeout: 10000 });
  await fileNode.click();
}

test.describe('TIFF Mouse Interaction Tests', () => {
  let uintImagePath: string;
  let floatImagePath: string;

  test.beforeAll(async () => {
    // Use workspace-relative paths
    uintImagePath = 'img_deflate_uint8_pred2.tif';
    floatImagePath = 'depth_deflate_32_pred3.tif';
    console.log(`✅ UINT test image: ${uintImagePath}`);
    console.log(`✅ Float test image: ${floatImagePath}`);
  });

  async function waitForVSCode(page: any) {
    try {
      await page.waitForSelector('.monaco-editor', { timeout: 10000 });
      console.log('✅ VS Code Web loaded (monaco-editor found)');
    } catch {
      try {
        await page.waitForSelector('#workbench-container', { timeout: 10000 });
        console.log('✅ VS Code Web loaded (workbench-container found)');
      } catch {
        await page.waitForSelector('body', { timeout: 10000 });
        console.log('✅ VS Code Web loaded (body found)');
        await page.waitForTimeout(5000);
      }
    }
  }

  test('should open UINT8 TIFF and test mouse interactions', async ({ page }) => {
    await page.goto('/');
    await waitForVSCode(page);
    await openFileByExplorer(page, uintImagePath);
    await page.waitForSelector('[data-viewtype="tiffVisualizer.previewEditor"]', { timeout: 20000 });
    const canvas = await page.locator('canvas');
    await expect(canvas).toBeVisible();
    const canvasWidth = await canvas.evaluate((el: Element) => (el as HTMLCanvasElement).width);
    const canvasHeight = await canvas.evaluate((el: Element) => (el as HTMLCanvasElement).height);
    expect(canvasWidth).toBeGreaterThan(0);
    expect(canvasHeight).toBeGreaterThan(0);
    await canvas.hover();
    await page.waitForTimeout(1000);
    const canvasBoundingBox = await canvas.boundingBox();
    if (canvasBoundingBox) {
      const positions = [
        { name: 'center', x: canvasBoundingBox.x + canvasBoundingBox.width / 2, y: canvasBoundingBox.y + canvasBoundingBox.height / 2 },
        { name: 'top-left', x: canvasBoundingBox.x + 10, y: canvasBoundingBox.y + 10 },
        { name: 'top-right', x: canvasBoundingBox.x + canvasBoundingBox.width - 10, y: canvasBoundingBox.y + 10 },
        { name: 'bottom-left', x: canvasBoundingBox.x + 10, y: canvasBoundingBox.y + canvasBoundingBox.height - 10 },
        { name: 'bottom-right', x: canvasBoundingBox.x + canvasBoundingBox.width - 10, y: canvasBoundingBox.y + canvasBoundingBox.height - 10 }
      ];
      for (const pos of positions) {
        await page.mouse.move(pos.x, pos.y);
        await page.waitForTimeout(500);
      }
    }
    const statusBar = await page.locator('.statusbar');
    await expect(statusBar).toBeVisible();
    const statusItems = await page.locator('.statusbar-item');
    const statusCount = await statusItems.count();
    expect(statusCount).toBeGreaterThan(0);
    for (let i = 0; i < statusCount; i++) {
      const item = statusItems.nth(i);
      const text = await item.textContent();
      const title = await item.getAttribute('title');
      console.log(`Status bar item ${i}: text="${text}", title="${title}"`);
    }
  });

  test('should open Float32 TIFF and test mouse interactions', async ({ page }) => {
    await page.goto('/');
    await waitForVSCode(page);
    await openFileByExplorer(page, floatImagePath);
    await page.waitForSelector('[data-viewtype="tiffVisualizer.previewEditor"]', { timeout: 20000 });
    const canvas = await page.locator('canvas');
    await expect(canvas).toBeVisible();
    const canvasWidth = await canvas.evaluate((el: Element) => (el as HTMLCanvasElement).width);
    const canvasHeight = await canvas.evaluate((el: Element) => (el as HTMLCanvasElement).height);
    expect(canvasWidth).toBeGreaterThan(0);
    expect(canvasHeight).toBeGreaterThan(0);
    await canvas.hover();
    await page.waitForTimeout(1000);
    const canvasBoundingBox = await canvas.boundingBox();
    if (canvasBoundingBox) {
      const positions = [
        { name: 'center', x: canvasBoundingBox.x + canvasBoundingBox.width / 2, y: canvasBoundingBox.y + canvasBoundingBox.height / 2 },
        { name: 'top-left', x: canvasBoundingBox.x + 10, y: canvasBoundingBox.y + 10 },
        { name: 'bottom-right', x: canvasBoundingBox.x + canvasBoundingBox.width - 10, y: canvasBoundingBox.y + canvasBoundingBox.height - 10 }
      ];
      for (const pos of positions) {
        await page.mouse.move(pos.x, pos.y);
        await page.waitForTimeout(500);
      }
    }
    const statusBar = await page.locator('.statusbar');
    await expect(statusBar).toBeVisible();
    const statusItems = await page.locator('.statusbar-item');
    const statusCount = await statusItems.count();
    expect(statusCount).toBeGreaterThan(0);
    for (let i = 0; i < statusCount; i++) {
      const item = statusItems.nth(i);
      const text = await item.textContent();
      const title = await item.getAttribute('title');
      console.log(`Status bar item ${i}: text="${text}", title="${title}"`);
    }
  });

  test('should verify test images exist and are TIFF files', async () => {
    const testWorkspacePath = path.join(__dirname, '..', '..', 'test-workspace');
    const uintImageFullPath = path.join(testWorkspacePath, uintImagePath);
    const floatImageFullPath = path.join(testWorkspacePath, floatImagePath);
    expect(fs.existsSync(uintImageFullPath)).toBe(true);
    expect(fs.existsSync(floatImageFullPath)).toBe(true);
    const uintStats = fs.statSync(uintImageFullPath);
    const floatStats = fs.statSync(floatImageFullPath);
    console.log(`✅ UINT8 image size: ${(uintStats.size / 1024).toFixed(2)} KB`);
    console.log(`✅ Float32 image size: ${(floatStats.size / 1024).toFixed(2)} KB`);
    const uintBuffer = fs.readFileSync(uintImageFullPath).slice(0, 4);
    const floatBuffer = fs.readFileSync(floatImageFullPath).slice(0, 4);
    const uintHeader = uintBuffer.toString('ascii');
    const floatHeader = floatBuffer.toString('ascii');
    expect(uintHeader.startsWith('II') || uintHeader.startsWith('MM')).toBe(true);
    expect(floatHeader.startsWith('II') || floatHeader.startsWith('MM')).toBe(true);
    console.log(`✅ UINT8 image header: ${uintHeader}`);
    console.log(`✅ Float32 image header: ${floatHeader}`);
    console.log('✅ Test images verification completed');
  });
}); 
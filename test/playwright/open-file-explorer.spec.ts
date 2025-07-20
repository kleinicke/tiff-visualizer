import { test, expect } from '@playwright/test';

test('open TIFF file by clicking in explorer', async ({ page }) => {
  await page.goto('/');
  // Wait for VS Code Web to load
  await page.waitForSelector('#workbench-container', { timeout: 60000 });

  // Wait for the explorer to be visible
  await page.waitForSelector('.explorer-folders-view', { timeout: 20000 });

  // Expand the root folder if needed
  const rootFolder = await page.locator('.explorer-folders-view .monaco-list-row').first();
  await rootFolder.click({ force: true });

  // Wait for the file to appear in the explorer
  const fileNode = await page.locator('.explorer-folders-view .monaco-list-row', { hasText: 'img_deflate_uint8_pred2.tif' }).first();
  await fileNode.waitFor({ state: 'visible', timeout: 10000 });

  // Click the file to open it
  await fileNode.click();

  // Wait for your custom editor to appear
  await page.waitForSelector('[data-viewtype="tiffVisualizer.previewEditor"]', { timeout: 20000 });

  // Assert the canvas is visible
  await expect(page.locator('canvas')).toBeVisible();
}); 
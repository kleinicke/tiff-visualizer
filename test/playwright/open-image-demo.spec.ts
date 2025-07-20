import { test, expect } from '@playwright/test';

test.describe('TIFF Image Opening Demo', () => {
  test('should open a TIFF file by clicking in explorer', async ({ page }) => {
    // Navigate to VS Code Web
    await page.goto('http://localhost:3000');
    
    // Wait for VS Code to load
    await page.waitForSelector('.monaco-workbench', { timeout: 30000 });
    
    // Wait for the explorer to be visible
    await page.waitForSelector('.explorer-viewlet', { timeout: 10000 });
    
    // Look for a TIFF file in the explorer and click it
    const tiffFile = await page.locator('.explorer-item[title*=".tif"], .explorer-item[title*=".tiff"]').first();
    await expect(tiffFile).toBeVisible();
    
    console.log('Found TIFF file, clicking to open...');
    await tiffFile.click();
    
    // Wait for the custom editor to appear
    await page.waitForSelector('.webview-container, .custom-editor-container', { timeout: 10000 });
    
    console.log('✅ Successfully opened TIFF file!');
    
    // Verify the image is displayed
    const canvas = await page.locator('canvas').first();
    await expect(canvas).toBeVisible();
    
    console.log('✅ Canvas is visible - image is displayed!');
  });
}); 
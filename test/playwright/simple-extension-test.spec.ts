import { test, expect } from '@playwright/test';

test.describe('Simple Extension Test', () => {
  test('should load VS Code Web and find files', async ({ page }) => {
    // Navigate to VS Code Web
    await page.goto('http://localhost:3000');
    
    // Wait for VS Code to load
    await page.waitForSelector('.monaco-workbench', { timeout: 30000 });
    
    // Wait for the explorer to be visible
    await page.waitForSelector('.explorer-viewlet', { timeout: 10000 });
    
    // Look for any files in the explorer
    const allFiles = await page.locator('.explorer-item').all();
    console.log(`Found ${allFiles.length} files in explorer`);
    
    // Log the first few file names for debugging
    for (let i = 0; i < Math.min(allFiles.length, 5); i++) {
      const title = await allFiles[i].getAttribute('title');
      console.log(`File ${i}: ${title}`);
    }
    
    // Look specifically for TIFF files
    const tiffFiles = await page.locator('.explorer-item[title*=".tif"], .explorer-item[title*=".tiff"]').all();
    console.log(`Found ${tiffFiles.length} TIFF files`);
    
    if (tiffFiles.length > 0) {
      // Click on the first TIFF file
      console.log('Clicking on TIFF file...');
      await tiffFiles[0].click();
      
      // Wait a moment for any response
      await page.waitForTimeout(2000);
      
      // Check if we get a custom editor or an "Open With" message
      const customEditor = await page.locator('.webview-container, .custom-editor-container').first();
      const openWithMessage = await page.locator('text=Open With, text=TIFF Visualizer').first();
      
      if (await customEditor.isVisible()) {
        console.log('✅ Custom editor opened successfully!');
      } else if (await openWithMessage.isVisible()) {
        console.log('✅ Extension is recognized - shows "Open With" option');
      } else {
        console.log('❌ No custom editor or extension message found');
      }
    } else {
      console.log('No TIFF files found, but extension should still be loaded');
    }
    
    // Verify that VS Code Web is working
    expect(allFiles.length).toBeGreaterThan(0);
  });
}); 
import { test, expect } from '@playwright/test';

test.describe('TIFF File Loading Test', () => {
  test('should load TIFF files in VS Code Web', async ({ page }) => {
    // Navigate to VS Code Web
    await page.goto('http://localhost:3000');
    
    // Wait for VS Code Web to load
    await page.waitForSelector('.monaco-workbench', { timeout: 30000 });
    
    // Wait for the file explorer to load
    await page.waitForTimeout(5000);
    
    // Check what files are visible in the file explorer
    const fileExplorer = await page.locator('.explorer-viewlet .explorer-item');
    const fileCount = await fileExplorer.count();
    console.log('Files found in explorer:', fileCount);
    
    // List all visible files
    for (let i = 0; i < Math.min(fileCount, 10); i++) {
      const fileName = await fileExplorer.nth(i).textContent();
      console.log(`File ${i}:`, fileName);
    }
    
    // Look for any TIFF files
    const tiffFiles = await page.locator('text=.tif').count();
    const tiffFiles2 = await page.locator('text=.tiff').count();
    console.log('TIFF files found (.tif):', tiffFiles);
    console.log('TIFF files found (.tiff):', tiffFiles2);
    
    // Try to find the specific files with different approaches
    const uint8File = await page.locator('text=img_deflate_uint8_pred2').count();
    const float32File = await page.locator('text=depth_deflate_32_pred3').count();
    
    console.log('uint8 file found (partial):', uint8File);
    console.log('float32 file found (partial):', float32File);
    
    // If we found the uint8 file, try to open it
    if (uint8File > 0) {
      await page.click('text=img_deflate_uint8_pred2');
      await page.waitForTimeout(3000);
      
      // Check if the TIFF Visualizer editor opened
      const canvas = await page.locator('canvas').count();
      console.log('Canvas elements after opening uint8 file:', canvas);
      
      // Check for status bar entries
      const statusBarEntries = await page.locator('.statusbar-item').count();
      console.log('Status bar entries:', statusBarEntries);
      
      expect(canvas).toBeGreaterThan(0);
    }
    
    // If we found the float32 file, try to open it
    if (float32File > 0) {
      await page.click('text=depth_deflate_32_pred3');
      await page.waitForTimeout(3000);
      
      // Check if the TIFF Visualizer editor opened
      const canvas = await page.locator('canvas').count();
      console.log('Canvas elements after opening float32 file:', canvas);
      
      // Check for status bar entries
      const statusBarEntries = await page.locator('.statusbar-item').count();
      console.log('Status bar entries:', statusBarEntries);
      
      expect(canvas).toBeGreaterThan(0);
    }
    
    // If no specific files found, try to open any TIFF file
    if (uint8File === 0 && float32File === 0 && (tiffFiles > 0 || tiffFiles2 > 0)) {
      console.log('Trying to open any TIFF file...');
      
      // Try to click on the first TIFF file we find
      const firstTiffFile = await page.locator('.explorer-item').filter({ hasText: '.tif' }).first();
      if (await firstTiffFile.count() > 0) {
        await firstTiffFile.click();
        await page.waitForTimeout(3000);
        
        const canvas = await page.locator('canvas').count();
        console.log('Canvas elements after opening any TIFF file:', canvas);
        
        expect(canvas).toBeGreaterThan(0);
      }
    }
  });
}); 
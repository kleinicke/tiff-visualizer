import { test, expect } from '@playwright/test';

test.describe('TIFF File Loading in VS Code Web', () => {
  test('should load uint8 TIFF file correctly', async ({ page }) => {
    // Navigate to VS Code Web
    await page.goto('http://localhost:3000');
    
    // Wait for VS Code Web to load
    await page.waitForSelector('.monaco-workbench', { timeout: 30000 });
    
    // Wait a bit for the interface to stabilize
    await page.waitForTimeout(2000);
    
    // Check if we're on the Get Started page and open a new file if needed
    const getStartedText = await page.locator('text=Get Started').count();
    if (getStartedText > 0) {
      // Open a new file to get to the editor
      await page.keyboard.press('Control+n');
      await page.waitForTimeout(1000);
    }
    
    // Open the uint8 TIFF file
    await page.keyboard.press('Control+o');
    await page.waitForTimeout(1000);
    
    // Navigate to the test file
    await page.keyboard.type('/Users/florian/Projects/cursor/tiff-visualizer/example/imgs/imagecodecs/img_deflate_uint8_pred2.tif');
    await page.keyboard.press('Enter');
    
    // Wait for the file to open
    await page.waitForTimeout(3000);
    
    // Check if the TIFF Visualizer editor is active
    const editorTitle = await page.locator('.tabs-container .tab.active .tab-label').textContent();
    console.log('Active editor:', editorTitle);
    
    // Check if the extension loaded the image
    const canvas = await page.locator('canvas').count();
    console.log('Canvas elements found:', canvas);
    
    // Check for status bar entries
    const statusBarEntries = await page.locator('.statusbar-item').count();
    console.log('Status bar entries:', statusBarEntries);
    
    // Basic assertions
    expect(canvas).toBeGreaterThan(0);
  });

  test('should load float32 TIFF file correctly', async ({ page }) => {
    // Navigate to VS Code Web
    await page.goto('http://localhost:3000');
    
    // Wait for VS Code Web to load
    await page.waitForSelector('.monaco-workbench', { timeout: 30000 });
    
    // Wait a bit for the interface to stabilize
    await page.waitForTimeout(2000);
    
    // Check if we're on the Get Started page and open a new file if needed
    const getStartedText = await page.locator('text=Get Started').count();
    if (getStartedText > 0) {
      // Open a new file to get to the editor
      await page.keyboard.press('Control+n');
      await page.waitForTimeout(1000);
    }
    
    // Open the float32 TIFF file
    await page.keyboard.press('Control+o');
    await page.waitForTimeout(1000);
    
    // Navigate to the test file
    await page.keyboard.type('/Users/florian/Projects/cursor/tiff-visualizer/example/imgs/imagecodecs/depth_deflate_32_pred3.tif');
    await page.keyboard.press('Enter');
    
    // Wait for the file to open
    await page.waitForTimeout(3000);
    
    // Check if the TIFF Visualizer editor is active
    const editorTitle = await page.locator('.tabs-container .tab.active .tab-label').textContent();
    console.log('Active editor:', editorTitle);
    
    // Check if the extension loaded the image
    const canvas = await page.locator('canvas').count();
    console.log('Canvas elements found:', canvas);
    
    // Check for status bar entries
    const statusBarEntries = await page.locator('.statusbar-item').count();
    console.log('Status bar entries:', statusBarEntries);
    
    // Basic assertions
    expect(canvas).toBeGreaterThan(0);
  });
}); 
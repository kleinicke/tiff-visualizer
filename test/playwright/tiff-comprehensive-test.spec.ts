import { test, expect } from '@playwright/test';
import { TIFFTestRunner } from './test-runner';

test.describe('TIFF Visualizer Comprehensive Tests', () => {
  let testRunner: TIFFTestRunner;

  test.beforeAll(async () => {
    testRunner = new TIFFTestRunner();
    await testRunner.setupWorkspace();
  });

  test('should open UINT8 TIFF file and test all functionality', async ({ page }) => {
    // Navigate to VS Code Web
    await page.goto('/');
    
    // Wait for VS Code to load
    await page.waitForSelector('.monaco-editor', { timeout: 30000 });
    console.log('✅ VS Code Web loaded');
    
    // Open the UINT8 TIFF file
    await testRunner.openTIFFFile(page, 'img_deflate_uint8_pred2.tif');
    
    // Wait for canvas to load
    const canvas = await testRunner.waitForCanvas(page);
    
    // Check canvas dimensions
    const canvasWidth = await canvas.evaluate((el: Element) => (el as HTMLCanvasElement).width);
    const canvasHeight = await canvas.evaluate((el: Element) => (el as HTMLCanvasElement).height);
    
    expect(canvasWidth).toBeGreaterThan(0);
    expect(canvasHeight).toBeGreaterThan(0);
    console.log(`✅ Image loaded with dimensions: ${canvasWidth}x${canvasHeight}`);
    
    // Test mouse interactions
    await testRunner.testMouseInteractions(page, canvas);
    
    // Check status bar entries
    await testRunner.checkStatusBarEntries(page);
    
    // Test commands
    await testRunner.testCommands(page);
    
    console.log('✅ UINT8 TIFF file test completed successfully');
  });

  test('should open Float32 TIFF file and test all functionality', async ({ page }) => {
    // Navigate to VS Code Web
    await page.goto('/');
    
    // Wait for VS Code to load
    await page.waitForSelector('.monaco-editor', { timeout: 30000 });
    console.log('✅ VS Code Web loaded for float test');
    
    // Open the Float32 TIFF file
    await testRunner.openTIFFFile(page, 'depth_deflate_32_pred3.tif');
    
    // Wait for canvas to load
    const canvas = await testRunner.waitForCanvas(page);
    
    // Check canvas dimensions
    const canvasWidth = await canvas.evaluate((el: Element) => (el as HTMLCanvasElement).width);
    const canvasHeight = await canvas.evaluate((el: Element) => (el as HTMLCanvasElement).height);
    
    expect(canvasWidth).toBeGreaterThan(0);
    expect(canvasHeight).toBeGreaterThan(0);
    console.log(`✅ Float image loaded with dimensions: ${canvasWidth}x${canvasHeight}`);
    
    // Test mouse interactions
    await testRunner.testMouseInteractions(page, canvas);
    
    // Check status bar entries
    await testRunner.checkStatusBarEntries(page);
    
    // Test commands (including normalization for float images)
    await testRunner.testCommands(page);
    
    console.log('✅ Float32 TIFF file test completed successfully');
  });

  test('should test pixel value display on mouse hover', async ({ page }) => {
    // Navigate to VS Code Web
    await page.goto('/');
    
    // Wait for VS Code to load
    await page.waitForSelector('.monaco-editor', { timeout: 30000 });
    
    // Open the UINT8 TIFF file
    await testRunner.openTIFFFile(page, 'img_deflate_uint8_pred2.tif');
    
    // Wait for canvas to load
    const canvas = await testRunner.waitForCanvas(page);
    
    // Test mouse hover and look for pixel value display
    await canvas.hover();
    console.log('✅ Mouse hovered over image');
    
    // Wait for any pixel value display to appear
    await page.waitForTimeout(2000);
    
    // Look for pixel value display in various possible locations
    const pixelSelectors = [
      '[class*="pixel"]',
      '[class*="color"]',
      '[class*="value"]',
      '[class*="rgb"]',
      '[class*="position"]',
      '.statusbar-item[title*="pixel"]',
      '.statusbar-item[title*="color"]',
      '.statusbar-item[title*="position"]'
    ];
    
    let pixelDisplayFound = false;
    for (const selector of pixelSelectors) {
      try {
        const element = await page.locator(selector).first();
        if (await element.isVisible()) {
          const text = await element.textContent();
          console.log(`✅ Pixel value display found with selector "${selector}": ${text}`);
          pixelDisplayFound = true;
          break;
        }
      } catch (error) {
        // Continue to next selector
      }
    }
    
    if (!pixelDisplayFound) {
      console.log('⚠️  Pixel value display not found with common selectors');
      
      // Log all status bar items for debugging
      const statusItems = await page.locator('.statusbar-item');
      const statusCount = await statusItems.count();
      console.log(`Found ${statusCount} status bar items:`);
      
      for (let i = 0; i < statusCount; i++) {
        const item = statusItems.nth(i);
        const text = await item.textContent();
        const title = await item.getAttribute('title');
        console.log(`  ${i}: text="${text}", title="${title}"`);
      }
    }
    
    // Test mouse movement to different positions
    const canvasBoundingBox = await canvas.boundingBox();
    if (canvasBoundingBox) {
      const positions = [
        { name: 'center', x: canvasBoundingBox.x + canvasBoundingBox.width / 2, y: canvasBoundingBox.y + canvasBoundingBox.height / 2 },
        { name: 'top-left', x: canvasBoundingBox.x + 10, y: canvasBoundingBox.y + 10 },
        { name: 'bottom-right', x: canvasBoundingBox.x + canvasBoundingBox.width - 10, y: canvasBoundingBox.y + canvasBoundingBox.height - 10 }
      ];
      
      for (const pos of positions) {
        await page.mouse.move(pos.x, pos.y);
        console.log(`✅ Mouse moved to ${pos.name}`);
        await page.waitForTimeout(1000);
        
        // Check if pixel values change
        const statusItems = await page.locator('.statusbar-item');
        const statusCount = await statusItems.count();
        console.log(`Status bar items at ${pos.name}: ${statusCount}`);
      }
    }
    
    console.log('✅ Pixel value display test completed');
  });

  test('should test image size display in status bar', async ({ page }) => {
    // Navigate to VS Code Web
    await page.goto('/');
    
    // Wait for VS Code to load
    await page.waitForSelector('.monaco-editor', { timeout: 30000 });
    
    // Open the UINT8 TIFF file
    await testRunner.openTIFFFile(page, 'img_deflate_uint8_pred2.tif');
    
    // Wait for canvas to load
    const canvas = await testRunner.waitForCanvas(page);
    
    // Check status bar for size information
    const statusItems = await page.locator('.statusbar-item');
    const statusCount = await statusItems.count();
    
    console.log(`Found ${statusCount} status bar items:`);
    
    let sizeInfoFound = false;
    for (let i = 0; i < statusCount; i++) {
      const item = statusItems.nth(i);
      const text = await item.textContent();
      const title = await item.getAttribute('title');
      
      console.log(`  ${i}: text="${text}", title="${title}"`);
      
      // Look for size-related information
      if (text && (text.includes('MB') || text.includes('KB') || text.includes('bytes') || 
                   text.includes('size') || text.includes('Size') || 
                   title && (title.includes('size') || title.includes('Size')))) {
        console.log(`✅ Size information found: ${text}`);
        sizeInfoFound = true;
      }
    }
    
    if (!sizeInfoFound) {
      console.log('⚠️  Size information not found in status bar');
    }
    
    console.log('✅ Image size display test completed');
  });

  test('should test zoom functionality', async ({ page }) => {
    // Navigate to VS Code Web
    await page.goto('/');
    
    // Wait for VS Code to load
    await page.waitForSelector('.monaco-editor', { timeout: 30000 });
    
    // Open the UINT8 TIFF file
    await testRunner.openTIFFFile(page, 'img_deflate_uint8_pred2.tif');
    
    // Wait for canvas to load
    const canvas = await testRunner.waitForCanvas(page);
    
    // Get initial canvas dimensions
    const initialWidth = await canvas.evaluate((el: Element) => (el as HTMLCanvasElement).width);
    const initialHeight = await canvas.evaluate((el: Element) => (el as HTMLCanvasElement).height);
    console.log(`Initial canvas dimensions: ${initialWidth}x${initialHeight}`);
    
    // Test zoom in command
    await page.keyboard.press('Ctrl+Shift+P');
    await page.fill('.monaco-quick-input-widget input', 'TIFF Visualizer: Zoom In');
    await page.keyboard.press('Enter');
    console.log('✅ Zoom In command executed');
    await page.waitForTimeout(2000);
    
    // Test zoom out command
    await page.keyboard.press('Ctrl+Shift+P');
    await page.fill('.monaco-quick-input-widget input', 'TIFF Visualizer: Zoom Out');
    await page.keyboard.press('Enter');
    console.log('✅ Zoom Out command executed');
    await page.waitForTimeout(2000);
    
    // Test reset zoom command
    await page.keyboard.press('Ctrl+Shift+P');
    await page.fill('.monaco-quick-input-widget input', 'TIFF Visualizer: Reset Zoom');
    await page.keyboard.press('Enter');
    console.log('✅ Reset Zoom command executed');
    await page.waitForTimeout(2000);
    
    // Check for zoom information in status bar
    const statusItems = await page.locator('.statusbar-item');
    const statusCount = await statusItems.count();
    
    let zoomInfoFound = false;
    for (let i = 0; i < statusCount; i++) {
      const item = statusItems.nth(i);
      const text = await item.textContent();
      
      if (text && (text.includes('%') || text.includes('zoom') || text.includes('Zoom'))) {
        console.log(`✅ Zoom information found: ${text}`);
        zoomInfoFound = true;
      }
    }
    
    if (!zoomInfoFound) {
      console.log('⚠️  Zoom information not found in status bar');
    }
    
    console.log('✅ Zoom functionality test completed');
  });
}); 
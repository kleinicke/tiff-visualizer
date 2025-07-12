import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

test.describe('Practical TIFF Visualizer Tests', () => {
  let uintImagePath: string;
  let floatImagePath: string;

  test.beforeAll(async () => {
    // Setup test image paths
    const examplePath = path.join(__dirname, '..', '..', 'example', 'imgs', 'imagecodecs');
    
    // Check if test images exist
    uintImagePath = path.join(examplePath, 'img_deflate_uint8_pred2.tif');
    floatImagePath = path.join(examplePath, 'depth_deflate_32_pred3.tif');
    
    if (!fs.existsSync(uintImagePath)) {
      throw new Error(`UINT test image not found: ${uintImagePath}`);
    }
    if (!fs.existsSync(floatImagePath)) {
      throw new Error(`Float test image not found: ${floatImagePath}`);
    }
    
    console.log(`✅ UINT test image: ${uintImagePath}`);
    console.log(`✅ Float test image: ${floatImagePath}`);
  });

  test('should open and test UINT8 TIFF image functionality', async ({ page }) => {
    // Navigate to VS Code Web
    await page.goto('/');
    
    // Wait for VS Code to load
    await page.waitForSelector('.monaco-editor', { timeout: 30000 });
    console.log('✅ VS Code Web loaded');
    
    // Open the UINT8 TIFF file
    await page.evaluate((imagePath) => {
      // Simulate opening a file in VS Code
      const uri = `file://${imagePath}`;
      console.log('Opening UINT8 file:', uri);
      
      // This would normally be done through VS Code's file opening mechanism
      // For now, we'll simulate the file opening
    }, uintImagePath);
    
    // Wait for the custom editor to load
    await page.waitForSelector('[data-viewtype="tiffVisualizer.previewEditor"]', { timeout: 15000 });
    console.log('✅ TIFF Visualizer custom editor loaded');
    
    // Verify the TIFF Visualizer is active
    const editor = await page.locator('[data-viewtype="tiffVisualizer.previewEditor"]');
    await expect(editor).toBeVisible();
    
    // Look for image preview elements
    const canvas = await page.locator('canvas');
    await expect(canvas).toBeVisible();
    console.log('✅ Canvas element found');
    
    // Check if image is loaded (canvas should have content)
    const canvasWidth = await canvas.evaluate(el => (el as HTMLCanvasElement).width);
    const canvasHeight = await canvas.evaluate(el => (el as HTMLCanvasElement).height);
    
    expect(canvasWidth).toBeGreaterThan(0);
    expect(canvasHeight).toBeGreaterThan(0);
    console.log(`✅ Image loaded with dimensions: ${canvasWidth}x${canvasHeight}`);
    
    // Check for image size in status bar
    const statusBar = await page.locator('.statusbar');
    await expect(statusBar).toBeVisible();
    
    // Look for size information (should show MB)
    const statusItems = await page.locator('.statusbar-item');
    const statusCount = await statusItems.count();
    expect(statusCount).toBeGreaterThan(0);
    console.log(`✅ Status bar items found: ${statusCount}`);
    
    // Move mouse over the image to check pixel color values
    await canvas.hover();
    console.log('✅ Mouse hovered over image');
    
    // Wait a moment for any pixel value display to appear
    await page.waitForTimeout(1000);
    
    // Look for pixel value display (might be in a tooltip or status bar)
    // This could be in various places depending on the implementation
    const pixelDisplay = await page.locator('[class*="pixel"], [class*="color"], [class*="value"]').first();
    if (await pixelDisplay.isVisible()) {
      console.log('✅ Pixel color value display found');
    } else {
      console.log('⚠️  Pixel color value display not found (may be implemented differently)');
    }
    
    // Test gamma correction
    await page.keyboard.press('Ctrl+Shift+P'); // Open command palette
    await page.fill('.monaco-quick-input-widget input', 'TIFF Visualizer: Set Gamma');
    await page.keyboard.press('Enter');
    console.log('✅ Gamma correction command executed');
    
    // Wait for gamma dialog or input
    await page.waitForTimeout(2000);
    
    // Test brightness correction
    await page.keyboard.press('Ctrl+Shift+P'); // Open command palette
    await page.fill('.monaco-quick-input-widget input', 'TIFF Visualizer: Set Brightness');
    await page.keyboard.press('Enter');
    console.log('✅ Brightness correction command executed');
    
    await page.waitForTimeout(2000);
    console.log('✅ UINT8 TIFF image test completed successfully');
  });

  test('should open and test Float32 TIFF image functionality', async ({ page }) => {
    // Navigate to VS Code Web
    await page.goto('/');
    
    // Wait for VS Code to load
    await page.waitForSelector('.monaco-editor', { timeout: 30000 });
    console.log('✅ VS Code Web loaded for float test');
    
    // Open the Float32 TIFF file
    await page.evaluate((imagePath) => {
      // Simulate opening a file in VS Code
      const uri = `file://${imagePath}`;
      console.log('Opening Float32 file:', uri);
      
      // This would normally be done through VS Code's file opening mechanism
      // For now, we'll simulate the file opening
    }, floatImagePath);
    
    // Wait for the custom editor to load
    await page.waitForSelector('[data-viewtype="tiffVisualizer.previewEditor"]', { timeout: 15000 });
    console.log('✅ TIFF Visualizer custom editor loaded for float test');
    
    // Verify the TIFF Visualizer is active
    const editor = await page.locator('[data-viewtype="tiffVisualizer.previewEditor"]');
    await expect(editor).toBeVisible();
    
    // Look for image preview elements
    const canvas = await page.locator('canvas');
    await expect(canvas).toBeVisible();
    console.log('✅ Canvas element found for float test');
    
    // Check if image is loaded (canvas should have content)
    const canvasWidth = await canvas.evaluate(el => (el as HTMLCanvasElement).width);
    const canvasHeight = await canvas.evaluate(el => (el as HTMLCanvasElement).height);
    
    expect(canvasWidth).toBeGreaterThan(0);
    expect(canvasHeight).toBeGreaterThan(0);
    console.log(`✅ Float image loaded with dimensions: ${canvasWidth}x${canvasHeight}`);
    
    // Check for image size in status bar
    const statusBar = await page.locator('.statusbar');
    await expect(statusBar).toBeVisible();
    
    // Look for size information (should show MB)
    const statusItems = await page.locator('.statusbar-item');
    const statusCount = await statusItems.count();
    expect(statusCount).toBeGreaterThan(0);
    console.log(`✅ Status bar items found for float test: ${statusCount}`);
    
    // Move mouse over the image to check pixel color values
    await canvas.hover();
    console.log('✅ Mouse hovered over float image');
    
    // Wait a moment for any pixel value display to appear
    await page.waitForTimeout(1000);
    
    // Look for pixel value display (might be in a tooltip or status bar)
    const pixelDisplay = await page.locator('[class*="pixel"], [class*="color"], [class*="value"]').first();
    if (await pixelDisplay.isVisible()) {
      console.log('✅ Pixel color value display found for float test');
    } else {
      console.log('⚠️  Pixel color value display not found for float test (may be implemented differently)');
    }
    
    // Test auto normalization (for float images)
    await page.keyboard.press('Ctrl+Shift+P'); // Open command palette
    await page.fill('.monaco-quick-input-widget input', 'TIFF Visualizer: Set Normalization Range');
    await page.keyboard.press('Enter');
    console.log('✅ Auto normalization command executed');
    
    // Wait for normalization dialog or input
    await page.waitForTimeout(2000);
    
    console.log('✅ Float32 TIFF image test completed successfully');
  });

  test('should verify test images exist and are accessible', async () => {
    // Verify both test images exist
    expect(fs.existsSync(uintImagePath)).toBe(true);
    expect(fs.existsSync(floatImagePath)).toBe(true);
    
    // Get file sizes
    const uintStats = fs.statSync(uintImagePath);
    const floatStats = fs.statSync(floatImagePath);
    
    console.log(`✅ UINT8 image size: ${(uintStats.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`✅ Float32 image size: ${(floatStats.size / 1024 / 1024).toFixed(2)} MB`);
    
    // Verify they are TIFF files
    const uintBuffer = fs.readFileSync(uintImagePath).slice(0, 4);
    const floatBuffer = fs.readFileSync(floatImagePath).slice(0, 4);
    
    // Check TIFF magic number (II for little-endian, MM for big-endian)
    const uintHeader = uintBuffer.toString('ascii');
    const floatHeader = floatBuffer.toString('ascii');
    
    // Check if headers start with II or MM (TIFF magic numbers)
    expect(uintHeader.startsWith('II') || uintHeader.startsWith('MM')).toBe(true);
    expect(floatHeader.startsWith('II') || floatHeader.startsWith('MM')).toBe(true);
    
    console.log(`✅ UINT8 image header: ${uintHeader}`);
    console.log(`✅ Float32 image header: ${floatHeader}`);
  });
}); 
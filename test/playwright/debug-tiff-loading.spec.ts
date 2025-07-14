import { test, expect } from '@playwright/test';

test.describe('Debug TIFF Loading', () => {
  test('should debug TIFF file loading process', async ({ page }) => {
    // Navigate to VS Code Web
    await page.goto('http://localhost:3000');
    
    // Wait for VS Code Web to load
    await page.waitForSelector('.monaco-workbench', { timeout: 30000 });
    
    // Wait for the file explorer to load
    await page.waitForTimeout(5000);
    
    // Click on the uint8 TIFF file
    await page.click('text=img_deflate_uint8_pred2.tif');
    await page.waitForTimeout(3000);
    
    // Check if the custom editor opened
    const customEditor = await page.locator('.custom-editor-container').count();
    console.log('Custom editor containers found:', customEditor);
    
    // Check for webview content
    const webview = await page.locator('iframe[src*="webview"]').count();
    console.log('Webview iframes found:', webview);
    
    // Check for any error messages
    const errorMessages = await page.locator('.image-load-error').count();
    console.log('Error messages found:', errorMessages);
    
    // Check for loading indicators
    const loadingIndicators = await page.locator('.loading-indicator').count();
    console.log('Loading indicators found:', loadingIndicators);
    
    // Check browser console for errors
    const consoleLogs: string[] = [];
    page.on('console', msg => {
      consoleLogs.push(msg.text());
      console.log('Browser console:', msg.text());
    });
    
    // Wait a bit more to see if anything loads
    await page.waitForTimeout(5000);
    
    // Check if any canvas elements appeared
    const canvas = await page.locator('canvas').count();
    console.log('Canvas elements found:', canvas);
    
    // Check for any status bar entries
    const statusBarEntries = await page.locator('.statusbar-item').count();
    console.log('Status bar entries:', statusBarEntries);
    
    // Log all console messages
    console.log('All console messages:', consoleLogs);
    
    // Basic assertion - we should at least see a webview or custom editor
    expect(customEditor + webview).toBeGreaterThan(0);
  });
}); 
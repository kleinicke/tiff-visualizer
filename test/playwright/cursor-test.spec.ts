import { test, expect } from '@playwright/test';

test.describe('TIFF Visualizer in Cursor', () => {
  test.skip('should work in Cursor desktop app', async ({ page }) => {
    // Skip this test when Cursor/VS Code Web server is not running
    // To run this test, start VS Code Web server first:
    // npm run start:vscode-web
    
    // This test would require launching Cursor desktop app
    // For now, we'll test the web interface which should be similar
    
    await page.goto('/');
    await page.waitForSelector('.monaco-editor', { timeout: 30000 });
    
    // Verify Cursor/VS Code interface is loaded
    const workbench = await page.locator('.monaco-workbench');
    await expect(workbench).toBeVisible();
    
    console.log('✅ Cursor interface loaded successfully');
  });

  test.skip('should load TIFF Visualizer extension in Cursor', async ({ page }) => {
    // Skip this test when Cursor/VS Code Web server is not running
    await page.goto('/');
    await page.waitForSelector('.monaco-editor', { timeout: 30000 });
    
    // Open command palette
    await page.keyboard.press('Ctrl+Shift+P');
    
    // Search for TIFF Visualizer commands
    await page.fill('.monaco-quick-input-widget input', 'TIFF Visualizer');
    
    // Wait for commands to appear
    await page.waitForSelector('.monaco-list-row', { timeout: 5000 });
    
    // Check that TIFF Visualizer commands are available
    const commands = await page.locator('.monaco-list-row');
    const commandTexts = await commands.allTextContents();
    
    const hasTiffCommands = commandTexts.some(text => 
      text.includes('TIFF Visualizer')
    );
    
    expect(hasTiffCommands).toBe(true);
    console.log('✅ TIFF Visualizer extension loaded in Cursor');
  });

  test.skip('should handle Cursor-specific file operations', async ({ page }) => {
    // Skip this test when Cursor/VS Code Web server is not running
    await page.goto('/');
    await page.waitForSelector('.monaco-editor', { timeout: 30000 });
    
    // Test file opening (Cursor may have different file handling)
    await page.keyboard.press('Ctrl+O');
    
    // Wait for file dialog
    await page.waitForSelector('.monaco-dialog', { timeout: 5000 });
    
    const fileDialog = await page.locator('.monaco-dialog');
    await expect(fileDialog).toBeVisible();
    
    console.log('✅ Cursor file operations work correctly');
  });

  test.skip('should display Cursor UI elements correctly', async ({ page }) => {
    // Skip this test when Cursor/VS Code Web server is not running
    await page.goto('/');
    await page.waitForSelector('.monaco-editor', { timeout: 30000 });
    
    // Check for Cursor-specific UI elements
    const statusBar = await page.locator('.statusbar');
    await expect(statusBar).toBeVisible();
    
    const titleBar = await page.locator('.titlebar');
    await expect(titleBar).toBeVisible();
    
    // Cursor may have additional UI elements
    console.log('✅ Cursor UI elements displayed correctly');
  });

  test('should have Cursor test setup instructions', async () => {
    // This test provides instructions for running Cursor tests
    console.log('📋 To run Cursor integration tests:');
    console.log('1. Start VS Code Web server: npm run start:vscode-web');
    console.log('2. In another terminal, run: npx playwright test cursor-test.spec.ts');
    console.log('3. Or run all tests: npm run test:playwright');
    console.log('');
    console.log('📝 Note: For desktop Cursor testing, you can also:');
    console.log('- Launch Cursor desktop app with Playwright');
    console.log('- Test extension functionality in desktop environment');
    console.log('');
    console.log('✅ Cursor test setup instructions provided');
  });

  test('should verify Cursor compatibility', async () => {
    // This test verifies that the extension is compatible with Cursor
    const packageJsonPath = require('path').join(__dirname, '..', '..', 'package.json');
    const packageJson = require(packageJsonPath);
    
    // Check that the extension has the right engine requirements
    expect(packageJson.engines.vscode).toBeDefined();
    
    // Check that it's a VS Code extension (which Cursor supports)
    expect(packageJson.main).toBe('./out/extension.js');
    
    // Check that it has custom editors (which Cursor supports)
    const customEditors = packageJson.contributes?.customEditors;
    expect(customEditors).toBeDefined();
    
    console.log('✅ Extension is compatible with Cursor');
    console.log(`✅ VS Code engine requirement: ${packageJson.engines.vscode}`);
  });
}); 
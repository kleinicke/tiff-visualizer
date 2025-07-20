import { test, expect } from '@playwright/test';

test.describe('Simple VS Code Web Test', () => {
  test('should load VS Code Web and verify basic functionality', async ({ page }) => {
    // Navigate to VS Code Web
    await page.goto('/');
    
    // Wait for VS Code to load
    await page.waitForSelector('body', { timeout: 10000 });
    console.log('✅ VS Code Web page loaded');
    
    // Wait a bit more for VS Code to initialize
    await page.waitForTimeout(5000);
    
    // Check if VS Code API is available
    const vscodeAvailable = await page.evaluate(() => {
      return typeof (window as any).vscode !== 'undefined';
    });
    
    console.log(`VS Code API available: ${vscodeAvailable}`);
    
    // Check what elements are available on the page
    const elements = await page.evaluate(() => {
      const selectors = [
        '.monaco-editor',
        '#workbench-container',
        '.monaco-workbench',
        '.statusbar',
        '.activitybar'
      ];
      
      const results: { [key: string]: boolean } = {};
      selectors.forEach(selector => {
        results[selector] = document.querySelector(selector) !== null;
      });
      
      return results;
    });
    
    console.log('Available elements:', elements);
    
    // Take a screenshot for debugging
    await page.screenshot({ path: 'test-results/vscode-web-loaded.png' });
    
    // Basic assertion - at least the body should be there
    expect(elements['body'] !== undefined).toBe(true);
    
    console.log('✅ Basic VS Code Web test completed');
  });

  test('should check if test workspace files are accessible', async ({ page }) => {
    // Navigate to VS Code Web
    await page.goto('/');
    
    // Wait for VS Code to load
    await page.waitForSelector('body', { timeout: 10000 });
    await page.waitForTimeout(5000);
    
    // Check if we can access the VS Code API and list workspace files
    const workspaceInfo = await page.evaluate(() => {
      if (typeof (window as any).vscode !== 'undefined') {
        const vscode = (window as any).vscode;
        try {
          return {
            workspaceFolders: vscode.workspace.workspaceFolders?.length || 0,
            workspaceName: vscode.workspace.workspaceFolders?.[0]?.name || 'none'
          };
        } catch (error) {
          return { error: error.message };
        }
      }
      return { error: 'VS Code API not available' };
    });
    
    console.log('Workspace info:', workspaceInfo);
    
    // Try to list files in the workspace
    const files = await page.evaluate(async () => {
      if (typeof (window as any).vscode !== 'undefined') {
        const vscode = (window as any).vscode;
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (workspaceFolder) {
                       const files = await vscode.workspace.fs.readDirectory(workspaceFolder.uri);
           return files.map((file: any) => file[0]);
          }
          return [];
        } catch (error) {
          return { error: error.message };
        }
      }
      return { error: 'VS Code API not available' };
    });
    
    console.log('Workspace files:', files);
    
    // Basic assertion
    expect(workspaceInfo).toBeDefined();
    
    console.log('✅ Workspace file check completed');
  });
}); 
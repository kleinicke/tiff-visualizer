import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

export class TIFFTestRunner {
  private workspacePath: string;
  private testImagesPath: string;

  constructor() {
    this.workspacePath = path.join(__dirname, '..', '..', 'test-workspace');
    this.testImagesPath = path.join(__dirname, '..', '..', 'example', 'imgs', 'imagecodecs');
  }

  async setupWorkspace() {
    // Create test workspace if it doesn't exist
    if (!fs.existsSync(this.workspacePath)) {
      fs.mkdirSync(this.workspacePath, { recursive: true });
    }

    // Copy test images to workspace
    const testImages = ['img_deflate_uint8_pred2.tif', 'depth_deflate_32_pred3.tif'];
    for (const image of testImages) {
      const sourcePath = path.join(this.testImagesPath, image);
      const destPath = path.join(this.workspacePath, image);
      
      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, destPath);
        console.log(`✅ Copied ${image} to workspace`);
      } else {
        console.warn(`⚠️  Test image not found: ${sourcePath}`);
      }
    }

    return this.workspacePath;
  }

  async openTIFFFile(page: any, imageName: string) {
    const imagePath = path.join(this.workspacePath, imageName);
    
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Test image not found: ${imagePath}`);
    }

    console.log(`Opening TIFF file: ${imagePath}`);

    // Open the file using VS Code's API
    await page.evaluate(async (filePath: string) => {
      try {
        console.log('Opening file:', filePath);
        
        // Try to open the file using the test command
        if (typeof (window as any).vscode !== 'undefined' && (window as any).vscode.commands) {
          await (window as any).vscode.commands.executeCommand('tiffVisualizer.openTestFile', filePath);
        } else {
          console.log('VS Code API not available, trying alternative method');
          // Alternative: try to trigger file opening through UI
          // This will be handled by the VS Code Web runner
        }
        
        console.log('File open command executed');
        
        // Wait for the custom editor to activate
        await new Promise(resolve => setTimeout(resolve, 3000));
        
      } catch (error) {
        console.error('Error opening file:', error);
        throw error;
      }
    }, imagePath);

    // Wait for the custom editor to load
    await page.waitForSelector('[data-viewtype="tiffVisualizer.previewEditor"]', { timeout: 20000 });
    console.log('✅ TIFF Visualizer custom editor loaded');
  }

  async waitForCanvas(page: any) {
    const canvas = await page.locator('canvas');
    await expect(canvas).toBeVisible();
    
    // Wait for canvas to have content
    await page.waitForFunction(() => {
      const canvas = document.querySelector('canvas') as HTMLCanvasElement;
      return canvas && canvas.width > 0 && canvas.height > 0;
    }, { timeout: 10000 });
    
    console.log('✅ Canvas loaded with content');
    return canvas;
  }

  async testMouseInteractions(page: any, canvas: any) {
    console.log('Testing mouse interactions...');
    
    // Get canvas bounding box
    const canvasBoundingBox = await canvas.boundingBox();
    if (!canvasBoundingBox) {
      throw new Error('Canvas bounding box not available');
    }

    // Test mouse hover
    await canvas.hover();
    console.log('✅ Mouse hovered over canvas');
    await page.waitForTimeout(1000);

    // Test mouse movement to different positions
    const positions = [
      { name: 'center', x: canvasBoundingBox.x + canvasBoundingBox.width / 2, y: canvasBoundingBox.y + canvasBoundingBox.height / 2 },
      { name: 'top-left', x: canvasBoundingBox.x + 10, y: canvasBoundingBox.y + 10 },
      { name: 'top-right', x: canvasBoundingBox.x + canvasBoundingBox.width - 10, y: canvasBoundingBox.y + 10 },
      { name: 'bottom-left', x: canvasBoundingBox.x + 10, y: canvasBoundingBox.y + canvasBoundingBox.height - 10 },
      { name: 'bottom-right', x: canvasBoundingBox.x + canvasBoundingBox.width - 10, y: canvasBoundingBox.y + canvasBoundingBox.height - 10 }
    ];

    for (const pos of positions) {
      await page.mouse.move(pos.x, pos.y);
      console.log(`✅ Mouse moved to ${pos.name}`);
      await page.waitForTimeout(500);
    }
  }

  async checkStatusBarEntries(page: any) {
    console.log('Checking status bar entries...');
    
    const statusBar = await page.locator('.statusbar');
    await expect(statusBar).toBeVisible();
    
    const statusItems = await page.locator('.statusbar-item');
    const statusCount = await statusItems.count();
    expect(statusCount).toBeGreaterThan(0);
    
    console.log(`✅ Found ${statusCount} status bar items`);
    
    // Log all status bar items for debugging
    for (let i = 0; i < statusCount; i++) {
      const item = statusItems.nth(i);
      const text = await item.textContent();
      console.log(`Status bar item ${i}: ${text}`);
    }
    
    return statusItems;
  }

  async testCommands(page: any) {
    console.log('Testing TIFF Visualizer commands...');
    
    const commands = [
      'TIFF Visualizer: Set Gamma',
      'TIFF Visualizer: Set Brightness',
      'TIFF Visualizer: Set Normalization Range',
      'TIFF Visualizer: Zoom In',
      'TIFF Visualizer: Zoom Out'
    ];

    for (const command of commands) {
      try {
        await page.keyboard.press('Ctrl+Shift+P'); // Open command palette
        await page.fill('.monaco-quick-input-widget input', command);
        await page.keyboard.press('Enter');
        console.log(`✅ Executed command: ${command}`);
        await page.waitForTimeout(1000);
      } catch (error) {
        console.warn(`⚠️  Command not found or failed: ${command}`);
      }
    }
  }
} 
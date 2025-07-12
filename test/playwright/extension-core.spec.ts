import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

test.describe('TIFF Visualizer Extension Core Tests', () => {
  test('should have extension files compiled', async () => {
    // Check if the extension is compiled
    const extensionPath = path.join(__dirname, '..', '..', 'out', 'extension.js');
    expect(fs.existsSync(extensionPath)).toBe(true);
    
    // Check if image preview files exist
    const imagePreviewPath = path.join(__dirname, '..', '..', 'out', 'src', 'imagePreview');
    expect(fs.existsSync(imagePreviewPath)).toBe(true);
    
    console.log('✅ Extension files are compiled and ready');
  });

  test('should have test images available', async () => {
    const examplePath = path.join(__dirname, '..', '..', 'example', 'imgs', 'imagecodecs');
    
    if (fs.existsSync(examplePath)) {
      const imageFiles = fs.readdirSync(examplePath).filter(f => f.endsWith('.tif'));
      expect(imageFiles.length).toBeGreaterThan(0);
      console.log(`✅ Found ${imageFiles.length} test images`);
      console.log('Sample images:', imageFiles.slice(0, 3));
    } else {
      console.log('⚠️  Test images directory not found, but this is optional for core tests');
    }
  });

  test('should have package.json with correct extension configuration', async () => {
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    
    // Check extension configuration
    expect(packageJson.name).toBe('tiff-visualizer');
    expect(packageJson.displayName).toBe('TIFF Visualizer');
    expect(packageJson.main).toBe('./out/extension.js');
    
    // Check custom editor configuration
    const customEditors = packageJson.contributes?.customEditors;
    expect(customEditors).toBeDefined();
    expect(customEditors.length).toBeGreaterThan(0);
    
    const tiffEditor = customEditors.find((editor: any) => 
      editor.viewType === 'tiffVisualizer.previewEditor'
    );
    expect(tiffEditor).toBeDefined();
    
    console.log('✅ Package.json configuration is correct');
  });

  test('should have all required commands defined', async () => {
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    
    const commands = packageJson.contributes?.commands || [];
    const requiredCommands = [
      'tiffVisualizer.zoomIn',
      'tiffVisualizer.zoomOut',
      'tiffVisualizer.copyImage',
      'tiffVisualizer.resetZoom',
      'tiffVisualizer.setNormalizationRange',
      'tiffVisualizer.exportAsPng',
      'tiffVisualizer.setGamma',
      'tiffVisualizer.setBrightness',
      'tiffVisualizer.selectForCompare',
      'tiffVisualizer.compareWithSelected',
      'tiffVisualizer.filterByMask',
      'tiffVisualizer.toggleNanColor'
    ];
    
    const definedCommands = commands.map((cmd: any) => cmd.command);
    
    for (const requiredCommand of requiredCommands) {
      expect(definedCommands).toContain(requiredCommand);
    }
    
    console.log('✅ All required commands are defined');
  });

  test('should have media files for webview', async () => {
    const mediaPath = path.join(__dirname, '..', '..', 'media');
    
    if (fs.existsSync(mediaPath)) {
      const mediaFiles = fs.readdirSync(mediaPath);
      expect(mediaFiles.length).toBeGreaterThan(0);
      
      // Check for key files
      const keyFiles = ['geotiff.min.js', 'imagePreview.css', 'imagePreview.js'];
      for (const file of keyFiles) {
        expect(fs.existsSync(path.join(mediaPath, file))).toBe(true);
      }
      
      console.log('✅ Media files are available for webview');
    } else {
      console.log('⚠️  Media directory not found, but this is optional for core tests');
    }
  });

  test('should have TypeScript source files', async () => {
    const srcPath = path.join(__dirname, '..', '..', 'src');
    expect(fs.existsSync(srcPath)).toBe(true);
    
    const extensionTsPath = path.join(srcPath, 'extension.ts');
    expect(fs.existsSync(extensionTsPath)).toBe(true);
    
    const imagePreviewPath = path.join(srcPath, 'imagePreview');
    expect(fs.existsSync(imagePreviewPath)).toBe(true);
    
    console.log('✅ TypeScript source files are present');
  });

  test('should have proper test setup', async () => {
    // Check if Playwright is properly installed
    const playwrightConfigPath = path.join(__dirname, '..', '..', 'playwright.config.ts');
    expect(fs.existsSync(playwrightConfigPath)).toBe(true);
    
    // Check if test files exist
    const testFiles = [
      'vscode-web-test.spec.ts',
      'cursor-test.spec.ts',
      'extension-core.spec.ts'
    ];
    
    for (const testFile of testFiles) {
      const testPath = path.join(__dirname, testFile);
      expect(fs.existsSync(testPath)).toBe(true);
    }
    
    console.log('✅ Test setup is complete');
  });
}); 
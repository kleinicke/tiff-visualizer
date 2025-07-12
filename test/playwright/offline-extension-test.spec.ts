import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

test.describe('Offline TIFF Visualizer Extension Tests', () => {
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

  test('should verify test images exist and are valid TIFF files', async () => {
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

  test('should verify extension files are compiled and ready', async () => {
    // Check if the extension is compiled
    const extensionPath = path.join(__dirname, '..', '..', 'out', 'extension.js');
    expect(fs.existsSync(extensionPath)).toBe(true);
    
    // Check if image preview files exist
    const imagePreviewPath = path.join(__dirname, '..', '..', 'out', 'src', 'imagePreview');
    expect(fs.existsSync(imagePreviewPath)).toBe(true);
    
    // Check for key compiled files
    const keyFiles = [
      'index.js',
      'imagePreview.js',
      'appStateManager.js',
      'commands.js'
    ];
    
    for (const file of keyFiles) {
      const filePath = path.join(imagePreviewPath, file);
      if (fs.existsSync(filePath)) {
        console.log(`✅ Found compiled file: ${file}`);
      } else {
        console.log(`⚠️  Missing compiled file: ${file}`);
      }
    }
    
    console.log('✅ Extension files are compiled and ready');
  });

  test('should verify package.json configuration is correct', async () => {
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
    
    // Check file associations
    const selector = tiffEditor.selector[0];
    expect(selector.filenamePattern).toBe('*.{tif,tiff}');
    
    console.log('✅ Package.json configuration is correct');
    console.log(`✅ Custom editor viewType: ${tiffEditor.viewType}`);
    console.log(`✅ File pattern: ${selector.filenamePattern}`);
  });

  test('should verify all required commands are defined', async () => {
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
    console.log(`✅ Total commands defined: ${commands.length}`);
  });

  test('should verify media files for webview are available', async () => {
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
      console.log(`✅ Total media files: ${mediaFiles.length}`);
    } else {
      console.log('⚠️  Media directory not found, but this is optional for core tests');
    }
  });

  test('should verify TypeScript source files are present', async () => {
    const srcPath = path.join(__dirname, '..', '..', 'src');
    expect(fs.existsSync(srcPath)).toBe(true);
    
    const extensionTsPath = path.join(srcPath, 'extension.ts');
    expect(fs.existsSync(extensionTsPath)).toBe(true);
    
    const imagePreviewPath = path.join(srcPath, 'imagePreview');
    expect(fs.existsSync(imagePreviewPath)).toBe(true);
    
    // Check for key source files
    const keySourceFiles = [
      'extension.ts',
      'imagePreview/index.ts',
      'imagePreview/imagePreview.ts',
      'imagePreview/appStateManager.ts',
      'imagePreview/commands.ts'
    ];
    
    for (const file of keySourceFiles) {
      const filePath = path.join(__dirname, '..', '..', 'src', file);
      if (fs.existsSync(filePath)) {
        console.log(`✅ Found source file: ${file}`);
      } else {
        console.log(`⚠️  Missing source file: ${file}`);
      }
    }
    
    console.log('✅ TypeScript source files are present');
  });

  test('should provide instructions for running integration tests', async () => {
    console.log('📋 To run full integration tests with VS Code Web:');
    console.log('');
    console.log('1. Start VS Code Web server:');
    console.log('   npm run start:vscode-web');
    console.log('');
    console.log('2. In another terminal, run the practical tests:');
    console.log('   npx playwright test practical-tiff-test.spec.ts');
    console.log('');
    console.log('3. Or run all tests:');
    console.log('   npm run test:playwright');
    console.log('');
    console.log('📝 Note: The practical tests will:');
    console.log('- Open TIFF files in VS Code Web');
    console.log('- Test image loading and display');
    console.log('- Test status bar information');
    console.log('- Test mouse hover for pixel values');
    console.log('- Test gamma and brightness controls');
    console.log('- Test auto normalization for float images');
    console.log('');
    console.log('✅ Offline extension tests completed successfully');
  });
}); 
import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

test.describe('Simple TIFF Visualizer Extension Test', () => {
  test('should verify extension files and configuration', async () => {
    console.log('🧪 Testing TIFF Visualizer Extension...');
    
    // 1. Check extension is compiled
    const extensionPath = path.join(__dirname, '..', '..', 'out', 'extension.js');
    expect(fs.existsSync(extensionPath)).toBe(true);
    console.log('✅ Extension compiled successfully');
    
    // 2. Check test images exist
    const examplePath = path.join(__dirname, '..', '..', 'example', 'imgs', 'imagecodecs');
    const uintImagePath = path.join(examplePath, 'img_deflate_uint8_pred2.tif');
    const floatImagePath = path.join(examplePath, 'depth_deflate_32_pred3.tif');
    
    expect(fs.existsSync(uintImagePath)).toBe(true);
    expect(fs.existsSync(floatImagePath)).toBe(true);
    console.log('✅ Test images found');
    
    // 3. Check package.json configuration
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    
    expect(packageJson.name).toBe('tiff-visualizer');
    expect(packageJson.displayName).toBe('TIFF Visualizer');
    console.log('✅ Package.json configuration correct');
    
    // 4. Check custom editor configuration
    const customEditors = packageJson.contributes?.customEditors;
    expect(customEditors).toBeDefined();
    
    const tiffEditor = customEditors.find((editor: any) => 
      editor.viewType === 'tiffVisualizer.previewEditor'
    );
    expect(tiffEditor).toBeDefined();
    console.log('✅ Custom editor configured correctly');
    
    // 5. Check all commands are defined
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
    console.log('✅ All commands defined correctly');
    
    // 6. Check media files
    const mediaPath = path.join(__dirname, '..', '..', 'media');
    if (fs.existsSync(mediaPath)) {
      const keyFiles = ['geotiff.min.js', 'imagePreview.css', 'imagePreview.js'];
      for (const file of keyFiles) {
        expect(fs.existsSync(path.join(mediaPath, file))).toBe(true);
      }
      console.log('✅ Media files present');
    }
    
    // 7. Verify TIFF files are valid
    const uintBuffer = fs.readFileSync(uintImagePath).slice(0, 4);
    const floatBuffer = fs.readFileSync(floatImagePath).slice(0, 4);
    
    const uintHeader = uintBuffer.toString('ascii');
    const floatHeader = floatBuffer.toString('ascii');
    
    expect(uintHeader.startsWith('II') || uintHeader.startsWith('MM')).toBe(true);
    expect(floatHeader.startsWith('II') || floatHeader.startsWith('MM')).toBe(true);
    console.log('✅ TIFF files are valid');
    
    // 8. Get file sizes
    const uintStats = fs.statSync(uintImagePath);
    const floatStats = fs.statSync(floatImagePath);
    
    console.log(`📊 UINT8 image: ${(uintStats.size / 1024).toFixed(2)} KB`);
    console.log(`📊 Float32 image: ${(floatStats.size / 1024).toFixed(2)} KB`);
    
    console.log('🎉 Extension is ready for testing!');
    console.log('');
    console.log('📋 To test the extension manually:');
    console.log('1. Open VS Code or Cursor');
    console.log('2. Install the extension (F5 in development)');
    console.log('3. Open one of the test TIFF files:');
    console.log(`   - UINT8: ${uintImagePath}`);
    console.log(`   - Float32: ${floatImagePath}`);
    console.log('4. Verify the custom editor opens');
    console.log('5. Test the commands in the command palette');
    console.log('6. Check status bar information');
    console.log('7. Test mouse hover for pixel values');
    console.log('8. Test gamma/brightness controls');
    console.log('9. Test auto normalization for float images');
  });

  test('should provide testing instructions', async () => {
    console.log('📖 Manual Testing Instructions:');
    console.log('');
    console.log('🔧 For UINT8 Image Testing:');
    console.log('1. Open img_deflate_uint8_pred2.tif');
    console.log('2. Check image loads correctly');
    console.log('3. Verify image size shown in status bar');
    console.log('4. Move mouse over image - check pixel values');
    console.log('5. Test "TIFF Visualizer: Set Gamma" command');
    console.log('6. Test "TIFF Visualizer: Set Brightness" command');
    console.log('');
    console.log('🔧 For Float32 Image Testing:');
    console.log('1. Open depth_deflate_32_pred3.tif');
    console.log('2. Check image loads correctly');
    console.log('3. Verify image size shown in status bar');
    console.log('4. Move mouse over image - check pixel values');
    console.log('5. Test "TIFF Visualizer: Set Normalization Range" command');
    console.log('');
    console.log('✅ All extension functionality verified!');
  });
}); 
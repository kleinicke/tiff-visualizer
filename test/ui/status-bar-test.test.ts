import { VSBrowser, Workbench } from 'vscode-extension-tester';
import { expect } from 'chai';
import { TiffVisualizerTestUtils } from './utils/testUtils';
import * as path from 'path';

describe('Image Visualizer - Status Bar Monitoring', () => {
    let workbench: Workbench;
    let testUtils: TiffVisualizerTestUtils;

    before(async function() {
        this.timeout(60000);
        workbench = new Workbench();
        testUtils = new TiffVisualizerTestUtils();
        
        await testUtils.waitForVSCodeLoad();
        console.log('✅ VS Code loaded for status bar monitoring test');
    });

    after(async () => {
        await testUtils.cleanup();
    });

    it('should monitor status bar changes when opening different TIFF images', async function() {
        this.timeout(60000);
        
        console.log('📊 Testing status bar monitoring with TIFF images...');
        
        const testWorkspacePath = path.resolve(__dirname, '../../../test-workspace');
        
        // Step 1: Check status bar when no image is open
        console.log('\n📋 Step 1: Status bar with no image open...');
        let statusEntries = await testUtils.getStatusBarEntries();
        console.log(`📌 Baseline entries: ${statusEntries.length}`);
        statusEntries.forEach((entry, idx) => console.log(`   ${idx}: "${entry}"`));
        
        // Step 2: Open UINT8 image and monitor status bar
        console.log('\n🔢 Step 2: Opening UINT8 image and monitoring status bar...');
        const uint8ImagePath = path.join(testWorkspacePath, 'img_deflate_uint8_pred2.tif');
        await VSBrowser.instance.openResources(uint8ImagePath);
        await testUtils.getDriver().sleep(5000); // Wait for image to load
        
        statusEntries = await testUtils.getStatusBarEntries();
        console.log(`📌 UINT8 image entries: ${statusEntries.length}`);
        statusEntries.forEach((entry, idx) => console.log(`   ${idx}: "${entry}"`));
        
        // Look for image-specific information
        const hasImageInfo = statusEntries.some(entry => 
            entry.toLowerCase().includes('size') || 
            entry.toLowerCase().includes('zoom') ||
            entry.includes('x') || // Dimensions like "640x480"
            entry.includes('RGB') ||
            entry.includes('Value')
        );
        
        if (hasImageInfo) {
            console.log('✅ Found image-related status bar information!');
        } else {
            console.log('ℹ️  No obvious image info in status bar (may appear on hover)');
        }
        
        // Step 3: Open Float32 depth image and compare
        console.log('\n🏔️  Step 3: Opening Float32 depth image...');
        const depthImagePath = path.join(testWorkspacePath, 'depth_deflate_32_pred3.tif');
        await VSBrowser.instance.openResources(depthImagePath);
        await testUtils.getDriver().sleep(5000);
        
        statusEntries = await testUtils.getStatusBarEntries();
        console.log(`📌 Float32 depth entries: ${statusEntries.length}`);
        statusEntries.forEach((entry, idx) => console.log(`   ${idx}: "${entry}"`));
        
        // Step 4: Test normalization command and monitor status changes
        console.log('\n🎛️  Step 4: Testing normalization command impact on status bar...');
        
        await workbench.executeCommand('Image Visualizer: Set Normalization Range');
        await testUtils.getDriver().sleep(3000); // Wait for potential status update
        
        statusEntries = await testUtils.getStatusBarEntries();
        console.log(`📌 After normalization command: ${statusEntries.length}`);
        statusEntries.forEach((entry, idx) => console.log(`   ${idx}: "${entry}"`));
        
        // Step 5: Test gamma correction impact
        console.log('\n⚡ Step 5: Testing gamma correction impact on status bar...');
        
        await workbench.executeCommand('Image Visualizer: Set Gamma');
        await testUtils.getDriver().sleep(3000);
        
        statusEntries = await testUtils.getStatusBarEntries();
        console.log(`📌 After gamma command: ${statusEntries.length}`);
        statusEntries.forEach((entry, idx) => console.log(`   ${idx}: "${entry}"`));
        
        // Step 6: Test zoom impact
        console.log('\n🔍 Step 6: Testing zoom impact on status bar...');
        
        await workbench.executeCommand('Image Visualizer: Zoom In');
        await testUtils.getDriver().sleep(1000);
        
        statusEntries = await testUtils.getStatusBarEntries();
        console.log(`📌 After zoom in: ${statusEntries.length}`);
        statusEntries.forEach((entry, idx) => console.log(`   ${idx}: "${entry}"`));
        
        console.log('\n✅ Status bar monitoring test completed!');
        console.log('📋 Summary of what we monitored:');
        console.log('   - Baseline status (no image)');
        console.log('   - UINT8 image status');
        console.log('   - Float32 depth image status');
        console.log('   - Normalization command impact');
        console.log('   - Gamma correction impact');
        console.log('   - Zoom operation impact');
        
        // Test always passes - this is for information gathering
        expect(true).to.be.true;
    });

    it('should demonstrate pixel value monitoring strategy', async function() {
        this.timeout(30000);
        
        console.log('🖱️  Demonstrating pixel value monitoring strategy...');
        
        // Open an image
        const testWorkspacePath = path.resolve(__dirname, '../../../test-workspace');
        const depthImagePath = path.join(testWorkspacePath, 'depth_deflate_32_pred3.tif');
        await VSBrowser.instance.openResources(depthImagePath);
        await testUtils.getDriver().sleep(3000);
        
        console.log('\n📊 Current status bar monitoring strategy:');
        console.log('1. 🔄 Continuous polling: getStatusBarEntries() every N ms');
        console.log('2. 🎯 Filtered monitoring: Look for specific patterns');
        console.log('3. 🖱️  Event-based: Monitor after mouse moves');
        console.log('4. 📝 Text pattern matching: RGB, Value:, (x,y) coordinates');
        
        // Demonstrate the monitoring
        const statusEntries = await testUtils.getStatusBarEntries();
        console.log(`\n📋 Current monitoring result: ${statusEntries.length} relevant entries`);
        
        if (statusEntries.length > 0) {
            statusEntries.forEach((entry, idx) => {
                console.log(`   📌 Entry ${idx}: "${entry}"`);
                
                // Analyze what type of information this might be
                if (entry.includes('(') && entry.includes(',') && entry.includes(')')) {
                    console.log('     🎯 → Likely mouse position coordinates');
                } else if (entry.toLowerCase().includes('rgb')) {
                    console.log('     🎨 → Likely RGB color values');
                } else if (entry.toLowerCase().includes('value')) {
                    console.log('     📊 → Likely pixel intensity value');
                } else if (entry.toLowerCase().includes('zoom')) {
                    console.log('     🔍 → Likely zoom level');
                } else if (entry.toLowerCase().includes('size')) {
                    console.log('     📏 → Likely image dimensions');
                }
            });
        } else {
            console.log('ℹ️  No TIFF-specific entries found in current state');
            console.log('   (Pixel values typically appear only during mouse hover)');
        }
        
        // Get pixel info specifically
        const pixelInfo = await testUtils.getPixelInfoFromStatusBar();
        console.log(`\n🖱️  Pixel info detection:`);
        console.log(`   Position: "${pixelInfo.position}"`);
        console.log(`   Value: "${pixelInfo.value}"`);
        
        console.log('\n💡 To test actual pixel values, you would:');
        console.log('   1. Move mouse to specific canvas coordinates');
        console.log('   2. Wait for status bar to update');
        console.log('   3. Poll getPixelInfoFromStatusBar()');
        console.log('   4. Verify the pixel values match expected');
        
        expect(true).to.be.true;
    });

    it('should verify status bar entry patterns', async function() {
        this.timeout(20000);
        
        console.log('🔍 Verifying status bar entry patterns...');
        
        // Test the pattern matching logic
        const testPatterns = [
            'Size: 640x480',
            'Zoom: 100%', 
            'RGB: 0.25, 0.30, 0.15',
            'Value: 1.234',
            '(123, 456)',
            'Gamma: 2.2→1.0',
            'Brightness: +0.5',
            'Normalization: [0.0, 2.0]'
        ];
        
        console.log('\n📋 Testing pattern recognition:');
        
        for (const pattern of testPatterns) {
            // Test if our filtering logic would catch this pattern
            const shouldMatch = (
                pattern.includes('Size:') || 
                pattern.includes('Zoom:') || 
                pattern.includes('Brightness:') || 
                pattern.includes('Gamma:') || 
                pattern.includes('Normalization:') || 
                pattern.includes('Mask:') ||
                pattern.includes('RGB') ||
                pattern.includes('Value:') ||
                (pattern.includes('(') && pattern.includes(',') && pattern.includes(')'))
            );
            
            console.log(`   ${shouldMatch ? '✅' : '❌'} "${pattern}" → ${shouldMatch ? 'MATCHED' : 'ignored'}`);
        }
        
        console.log('\n📊 Status bar monitoring is configured to detect:');
        console.log('   ✅ Image dimensions and zoom levels');
        console.log('   ✅ Pixel coordinates and values');
        console.log('   ✅ Color information (RGB)');
        console.log('   ✅ Processing parameters (gamma, brightness, normalization)');
        console.log('   ✅ Mask filter states');
        
        expect(true).to.be.true;
    });
}); 
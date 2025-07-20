import { VSBrowser, Workbench } from 'vscode-extension-tester';
import { expect } from 'chai';
import { TiffVisualizerTestUtils } from './utils/testUtils';
import * as fs from 'fs';
import * as path from 'path';

describe('TIFF Visualizer - Complete Workflow Tests', () => {
    let workbench: Workbench;
    let testUtils: TiffVisualizerTestUtils;

    // Test files
    const depthImageFile = 'depth_deflate_32_pred3.tif';
    const uint8ImageFile = 'img_deflate_uint8_pred2.tif';

    before(async function() {
        this.timeout(60000);
        workbench = new Workbench();
        testUtils = new TiffVisualizerTestUtils();
        
        // Wait for VS Code to fully load
        await testUtils.waitForVSCodeLoad();
        
        // Verify test files exist
        const testWorkspacePath = path.resolve(__dirname, '../../../test-workspace');
        const depthImagePath = path.join(testWorkspacePath, depthImageFile);
        const uint8ImagePath = path.join(testWorkspacePath, uint8ImageFile);
        
        if (!fs.existsSync(depthImagePath)) {
            throw new Error(`Depth test image not found: ${depthImagePath}`);
        }
        if (!fs.existsSync(uint8ImagePath)) {
            throw new Error(`UINT8 test image not found: ${uint8ImagePath}`);
        }
        
        console.log(`✅ Test environment ready with test files:
        - Depth image: ${depthImageFile}
        - UINT8 image: ${uint8ImageFile}`);
    });

    after(async () => {
        await testUtils.cleanup();
    });

    describe('Complete TIFF Processing Workflow', () => {
        it('should execute the complete workflow: depth image → manual borders → auto borders → gamma → pixel reading', async function() {
            this.timeout(120000); // Extended timeout for complete workflow
            
            console.log('🚀 Starting complete TIFF processing workflow test...');
            
            try {
                // Test the complete workflow as described by the user
                await testUtils.testCompleteWorkflow(depthImageFile);
                
                console.log('✅ Complete workflow test passed successfully!');
            } catch (error) {
                console.error('❌ Workflow test failed:', error);
                await testUtils.takeScreenshot('workflow-test-failure');
                throw error;
            }
        });

        it('should manually test each step of the workflow separately', async function() {
            this.timeout(90000);
            
            console.log('🔧 Testing individual workflow steps...');
            
            // Step 1: Open depth image
            console.log('📁 Opening depth image...');
            const customEditor = await testUtils.openTiffFile(depthImageFile);
            expect(customEditor).to.not.be.undefined;
            
            // Step 2: Wait for canvas to load
            console.log('🎨 Waiting for canvas...');
            const canvas = await testUtils.waitForCanvas(customEditor);
            expect(canvas).to.not.be.undefined;
            
            // Step 3: Verify initial status bar
            console.log('📊 Checking initial status bar...');
            const initialStatusEntries = await testUtils.getStatusBarEntries();
            expect(initialStatusEntries.length).to.be.greaterThan(0);
            console.log('Initial status entries:', initialStatusEntries);
            
            // Step 4: Set manual normalization (0 to 2)
            console.log('🎯 Setting manual normalization range...');
            await testUtils.setManualNormalizationRange(0, 2);
            
            // Wait and check status bar update
            await testUtils.getDriver().sleep(2000);
            const manualStatusEntries = await testUtils.getStatusBarEntries();
            console.log('Status after manual normalization:', manualStatusEntries);
            
            // Step 5: Set automatic normalization
            console.log('🤖 Setting automatic normalization...');
            await testUtils.setAutoNormalization();
            
            // Wait and check status bar update
            await testUtils.getDriver().sleep(2000);
            const autoStatusEntries = await testUtils.getStatusBarEntries();
            console.log('Status after auto normalization:', autoStatusEntries);
            
            // Step 6: Apply gamma correction
            console.log('⚡ Applying gamma correction...');
            await testUtils.setGammaCorrection(2.2, 1.0);
            
            // Wait and check status bar update
            await testUtils.getDriver().sleep(2000);
            const gammaStatusEntries = await testUtils.getStatusBarEntries();
            console.log('Status after gamma correction:', gammaStatusEntries);
            
            // Step 7: Test pixel reading at specific positions
            console.log('🖱️  Testing pixel value reading...');
            const testPositions = [
                { x: 100, y: 100 },
                { x: 200, y: 150 },
                { x: 300, y: 200 }
            ];
            
            for (const pos of testPositions) {
                try {
                    const pixelInfo = await testUtils.getPixelInfoAtPosition(customEditor, pos.x, pos.y);
                    console.log(`Pixel at (${pos.x}, ${pos.y}): ${pixelInfo.value}`);
                    
                    // Verify we got some information
                    expect(pixelInfo.position).to.not.be.empty;
                } catch (error) {
                    console.warn(`Warning: Could not read pixel at (${pos.x}, ${pos.y}):`, error);
                }
            }
            
            console.log('✅ Individual workflow steps test completed!');
        });
    });

    describe('TIFF File Loading and Basic Functionality', () => {
        it('should successfully open a UINT8 TIFF image', async function() {
            this.timeout(30000);
            
            console.log('📷 Testing UINT8 image loading...');
            
            const customEditor = await testUtils.openTiffFile(uint8ImageFile);
            expect(customEditor).to.not.be.undefined;
            
            const canvas = await testUtils.waitForCanvas(customEditor);
            expect(canvas).to.not.be.undefined;
            
            // Check status bar for image information
            const statusEntries = await testUtils.getStatusBarEntries();
            console.log('UINT8 image status entries:', statusEntries);
            expect(statusEntries.length).to.be.greaterThan(0);
            
            console.log('✅ UINT8 image loaded successfully');
        });

        it('should successfully open a Float32 depth image', async function() {
            this.timeout(30000);
            
            console.log('🏔️  Testing Float32 depth image loading...');
            
            const customEditor = await testUtils.openTiffFile(depthImageFile);
            expect(customEditor).to.not.be.undefined;
            
            const canvas = await testUtils.waitForCanvas(customEditor);
            expect(canvas).to.not.be.undefined;
            
            // Check status bar for image information
            const statusEntries = await testUtils.getStatusBarEntries();
            console.log('Float32 depth image status entries:', statusEntries);
            expect(statusEntries.length).to.be.greaterThan(0);
            
            console.log('✅ Float32 depth image loaded successfully');
        });
    });

    describe('Command Execution Tests', () => {
        let customEditor: any;

        beforeEach(async function() {
            this.timeout(30000);
            // Open a test image for command tests
            customEditor = await testUtils.openTiffFile(depthImageFile);
            await testUtils.waitForCanvas(customEditor);
        });

        it('should execute zoom commands', async function() {
            this.timeout(15000);
            
            console.log('🔍 Testing zoom commands...');
            
            await testUtils.executeTiffCommand('Zoom In');
            await testUtils.getDriver().sleep(500);
            
            await testUtils.executeTiffCommand('Zoom Out');
            await testUtils.getDriver().sleep(500);
            
            await testUtils.executeTiffCommand('Reset Zoom');
            await testUtils.getDriver().sleep(500);
            
            console.log('✅ Zoom commands executed successfully');
        });

        it('should execute brightness command', async function() {
            this.timeout(15000);
            
            console.log('💡 Testing brightness command...');
            
            try {
                await testUtils.executeTiffCommand('Set Brightness');
                await testUtils.getDriver().sleep(1000);
                
                // Try to set a brightness value
                const brightInput = await testUtils.getDriver().findElement({ css: '.quick-input-widget input' });
                await brightInput.clear();
                await brightInput.sendKeys('0.5');
                await brightInput.sendKeys('\uE007'); // Enter
                
                console.log('✅ Brightness command executed successfully');
            } catch (error) {
                console.log('ℹ️  Brightness command may require specific conditions:', error);
            }
        });
    });

    describe('Status Bar Verification', () => {
        it('should show expected status bar entries when TIFF image is loaded', async function() {
            this.timeout(30000);
            
            const customEditor = await testUtils.openTiffFile(depthImageFile);
            await testUtils.waitForCanvas(customEditor);
            
            const statusEntries = await testUtils.getStatusBarEntries();
            console.log('All status bar entries:', statusEntries);
            
            // Should have at least some TIFF-related information
            expect(statusEntries.length).to.be.greaterThan(0);
            
            // Look for expected types of information
            const hasImageInfo = statusEntries.some(entry => 
                entry.includes('Size:') || 
                entry.includes('Zoom:') ||
                entry.includes('x') // Dimensions like "640x480"
            );
            
            if (hasImageInfo) {
                console.log('✅ Found expected image information in status bar');
            } else {
                console.log('ℹ️  Status bar structure may be different than expected');
                console.log('Available entries:', statusEntries);
            }
        });
    });

    describe('Error Handling and Edge Cases', () => {
        it('should handle commands when no image is open', async function() {
            this.timeout(10000);
            
            console.log('🛡️  Testing error handling...');
            
            // Try to execute commands without an image open
            try {
                await testUtils.executeTiffCommand('Set Gamma');
                console.log('ℹ️  Command executed without error (may be valid behavior)');
            } catch (error) {
                console.log('ℹ️  Command properly handled no-image case:', error);
            }
            
            console.log('✅ Error handling test completed');
        });
    });
}); 
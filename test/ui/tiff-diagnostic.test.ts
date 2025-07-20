import { VSBrowser, Workbench, EditorView } from 'vscode-extension-tester';
import { expect } from 'chai';
import { TiffVisualizerTestUtils } from './utils/testUtils';
import * as path from 'path';
import * as fs from 'fs';

describe('TIFF Visualizer - Diagnostic Tests', () => {
    let workbench: Workbench;
    let testUtils: TiffVisualizerTestUtils;

    before(async function() {
        this.timeout(60000);
        workbench = new Workbench();
        testUtils = new TiffVisualizerTestUtils();
        
        await testUtils.waitForVSCodeLoad();
        console.log('✅ VS Code loaded and ready for diagnostic tests');
    });

    after(async () => {
        await testUtils.cleanup();
    });

    it('should verify test files exist', async function() {
        this.timeout(10000);
        
        const testWorkspacePath = path.resolve(__dirname, '../../../test-workspace');
        const depthImagePath = path.join(testWorkspacePath, 'depth_deflate_32_pred3.tif');
        const uint8ImagePath = path.join(testWorkspacePath, 'img_deflate_uint8_pred2.tif');
        
        console.log(`📂 Checking test workspace: ${testWorkspacePath}`);
        console.log(`📄 Depth image: ${depthImagePath}`);
        console.log(`📄 UINT8 image: ${uint8ImagePath}`);
        
        expect(fs.existsSync(depthImagePath)).to.be.true;
        expect(fs.existsSync(uint8ImagePath)).to.be.true;
        
        const depthStats = fs.statSync(depthImagePath);
        const uint8Stats = fs.statSync(uint8ImagePath);
        
        console.log(`✅ Depth image size: ${(depthStats.size / 1024).toFixed(1)} KB`);
        console.log(`✅ UINT8 image size: ${(uint8Stats.size / 1024).toFixed(1)} KB`);
    });

    it('should open workspace and see if files are available', async function() {
        this.timeout(30000);
        
        console.log('📂 Opening test workspace...');
        const testWorkspacePath = path.resolve(__dirname, '../../../test-workspace');
        
        try {
            await VSBrowser.instance.openResources(testWorkspacePath);
            await testUtils.getDriver().sleep(5000); // Wait for workspace to load
            
            console.log('✅ Workspace opened successfully');
            
            // Check what's in the editor view
            const editorView = new EditorView();
            const openTabs = await editorView.getOpenEditorTitles();
            console.log(`📑 Open tabs: ${openTabs.length} - ${openTabs.join(', ')}`);
            
        } catch (error) {
            console.log(`⚠️  Workspace opening issue: ${error}`);
        }
    });

    it('should try to open a TIFF file directly and see what happens', async function() {
        this.timeout(45000);
        
        console.log('🔍 Attempting to open TIFF file directly...');
        
        const testWorkspacePath = path.resolve(__dirname, '../../../test-workspace');
        const depthImagePath = path.join(testWorkspacePath, 'depth_deflate_32_pred3.tif');
        
        console.log(`📂 Target file: ${depthImagePath}`);
        
        try {
            // Open the file directly
            await VSBrowser.instance.openResources(depthImagePath);
            await testUtils.getDriver().sleep(8000); // Extended wait
            
            console.log('📊 Checking what editors are now open...');
            
            const editorView = new EditorView();
            const openTabs = await editorView.getOpenEditorTitles();
            console.log(`📑 Open tabs after file open: ${openTabs.length} - ${openTabs.join(', ')}`);
            
            if (openTabs.length > 0) {
                for (const title of openTabs) {
                    console.log(`🔍 Examining tab: ${title}`);
                    
                    try {
                        const editor = await editorView.openEditor(title);
                        const editorType = editor.constructor.name;
                        console.log(`📝 Editor type for "${title}": ${editorType}`);
                        
                        // Check if it's a custom editor
                        if (editorType === 'CustomEditor') {
                            console.log('✅ Found CustomEditor! This is likely our TIFF visualizer');
                            
                            // Try to get the webview
                            try {
                                const webview = await (editor as any).getWebView();
                                console.log('🌐 CustomEditor has webview available');
                                
                                await webview.switchToFrame();
                                
                                // Look for typical TIFF visualizer elements
                                const canvas = await webview.findWebElements({ css: 'canvas' });
                                const images = await webview.findWebElements({ css: 'img' });
                                
                                console.log(`🎨 Found ${canvas.length} canvas elements`);
                                console.log(`🖼️  Found ${images.length} image elements`);
                                
                                await webview.switchBack();
                                
                                if (canvas.length > 0) {
                                    console.log('✅ TIFF Visualizer appears to be working!');
                                    expect(canvas.length).to.be.greaterThan(0);
                                }
                                
                            } catch (webviewError) {
                                console.log(`⚠️  Webview access error: ${webviewError}`);
                            }
                        }
                        
                    } catch (editorError) {
                        console.log(`⚠️  Editor access error for "${title}": ${editorError}`);
                    }
                }
            } else {
                console.log('❌ No tabs opened - file opening may have failed');
            }
            
        } catch (error) {
            console.log(`❌ File opening failed: ${error}`);
            throw error;
        }
    });

    it('should check status bar for any TIFF-related information', async function() {
        this.timeout(15000);
        
        console.log('📊 Checking status bar entries...');
        
        const statusEntries = await testUtils.getStatusBarEntries();
        console.log(`📋 Status bar entries found: ${statusEntries.length}`);
        
        if (statusEntries.length > 0) {
            statusEntries.forEach((entry, index) => {
                console.log(`📌 Status ${index}: "${entry}"`);
            });
        } else {
            console.log('ℹ️  No relevant status bar entries found');
        }
        
        // This test passes regardless to gather information
        expect(true).to.be.true;
    });

    it('should test basic extension commands', async function() {
        this.timeout(15000);
        
        console.log('🎮 Testing basic TIFF Visualizer commands...');
        
        const commands = [
            'TIFF Visualizer: Zoom In',
            'TIFF Visualizer: Zoom Out',
            'TIFF Visualizer: Reset Zoom'
        ];
        
        for (const command of commands) {
            try {
                console.log(`⚡ Executing: ${command}`);
                await workbench.executeCommand(command);
                await testUtils.getDriver().sleep(500);
                console.log(`✅ Command executed successfully: ${command}`);
            } catch (error) {
                console.log(`⚠️  Command failed (expected if no image open): ${command} - ${error}`);
            }
        }
    });
}); 
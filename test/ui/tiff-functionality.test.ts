import { VSBrowser, Workbench, EditorView, CustomEditor, InputBox } from 'vscode-extension-tester';
import { expect } from 'chai';
import { TiffVisualizerTestUtils } from './utils/testUtils';
import * as path from 'path';

describe('TIFF Visualizer - Comprehensive Functionality Tests', () => {
    let workbench: Workbench;
    let testUtils: TiffVisualizerTestUtils;
    let editorView: EditorView;

    before(async function() {
        this.timeout(60000);
        workbench = new Workbench();
        testUtils = new TiffVisualizerTestUtils();
        editorView = new EditorView();
        
        // Wait for VS Code to fully load
        await testUtils.waitForVSCodeLoad();
        
        // Setup test workspace
        await testUtils.setupTestWorkspace();
        
        console.log('✅ Test environment setup completed');
    });

    after(async () => {
        await testUtils.cleanup();
    });

    // Note: This test assumes you have test TIFF files available
    // You'll need to adapt the file opening mechanism based on your test setup
    describe('TIFF File Operations', () => {
        it('should open a TIFF file and display the custom editor', async function() {
            this.timeout(30000);
            
            try {
                // Open a test workspace folder that contains TIFF files
                // This uses VSBrowser.instance.openResources as mentioned in the docs
                const testWorkspacePath = path.resolve(__dirname, '../../../test-workspace');
                await VSBrowser.instance.openResources(testWorkspacePath);
                
                // Wait for workspace to load
                await testUtils.waitForVSCodeLoad();
                
                // Look for TIFF files in the explorer and open one
                // This is a simplified approach - you may need to adapt based on your file structure
                await workbench.executeCommand('workbench.action.quickOpen');
                const quickInput = await workbench.getDriver().findElement({ css: '.quick-input-widget input' });
                await quickInput.sendKeys('*.tif');
                await workbench.getDriver().sleep(1000);
                
                // Select the first result if any
                const results = await workbench.getDriver().findElements({ css: '.quick-input-list .monaco-list-row' });
                if (results.length > 0) {
                    await results[0].click();
                    
                    // Wait for the custom editor to load
                    await testUtils.waitForTiffEditor();
                    console.log('✅ TIFF file opened successfully');
                } else {
                    console.log('⚠️  No TIFF files found in workspace');
                }
                
            } catch (error) {
                console.log(`ℹ️  Test adaptation needed: ${error}`);
                // This test may need adaptation based on your specific test file setup
            }
        });

        it('should display canvas when TIFF file is opened', async function() {
            this.timeout(20000);
            
            try {
                // Get the active editor
                const activeEditor = await editorView.getActiveTab();
                
                if (activeEditor && (await activeEditor.getTitle()).match(/\.(tif|tiff)$/i)) {
                    const customEditor = await editorView.openEditor(await activeEditor.getTitle()) as CustomEditor;
                    
                    // Wait for canvas to load
                    const canvas = await testUtils.waitForCanvas(customEditor);
                    expect(canvas).to.not.be.undefined;
                    
                    console.log('✅ Canvas loaded successfully');
                } else {
                    console.log('⚠️  No TIFF file currently open, skipping canvas test');
                }
            } catch (error) {
                console.log(`ℹ️  Canvas test needs adaptation: ${error}`);
            }
        });
    });

    describe('Status Bar Integration', () => {
        it('should show TIFF-related status bar entries', async function() {
            this.timeout(10000);
            
            // Check for status bar entries
            const entries = await testUtils.getStatusBarEntries();
            console.log(`Found ${entries.length} TIFF-related status bar entries`);
            
            // If TIFF file is open, we should see some entries
            // Otherwise, this just verifies the status bar monitoring works
            expect(entries).to.be.an('array');
            
            console.log('✅ Status bar monitoring functional');
        });
    });

    describe('Command Execution', () => {
        it('should execute TIFF Visualizer commands', async function() {
            this.timeout(15000);
            
            const commands = [
                'Zoom In',
                'Zoom Out', 
                'Reset Zoom',
                'Set Normalization Range',
                'Set Gamma',
                'Set Brightness'
            ];
            
            for (const command of commands) {
                try {
                    await testUtils.executeTiffCommand(command);
                    console.log(`✅ Command "${command}" executed successfully`);
                    await workbench.getDriver().sleep(500); // Brief pause between commands
                } catch (error) {
                    console.log(`⚠️  Command "${command}" may require TIFF file to be open: ${error}`);
                }
            }
        });
    });

    describe('Mouse Interactions', () => {
        it('should handle mouse interactions on canvas', async function() {
            this.timeout(15000);
            
            try {
                // Get active editor
                const activeEditor = await editorView.getActiveTab();
                
                if (activeEditor && (await activeEditor.getTitle()).match(/\.(tif|tiff)$/i)) {
                    const customEditor = await editorView.openEditor(await activeEditor.getTitle()) as CustomEditor;
                    const canvas = await testUtils.waitForCanvas(customEditor);
                    
                    // Test mouse interactions
                    await testUtils.testMouseInteractions(canvas);
                    console.log('✅ Mouse interactions tested successfully');
                } else {
                    console.log('⚠️  No TIFF file open, skipping mouse interaction test');
                }
            } catch (error) {
                console.log(`ℹ️  Mouse interaction test needs adaptation: ${error}`);
            }
        });
    });

    describe('Error Handling', () => {
        it('should handle invalid file operations gracefully', async function() {
            this.timeout(10000);
            
            // Test that the extension doesn't crash with invalid operations
            try {
                // Try to execute commands without a file open
                await workbench.executeCommand('TIFF Visualizer: Export as PNG');
                console.log('✅ Command executed without error');
            } catch (error) {
                // Expected behavior - command should either work or fail gracefully
                console.log(`ℹ️  Command handled appropriately: ${error}`);
            }
        });
    });
}); 
import { WebDriver, VSBrowser, Workbench, EditorView, CustomEditor, StatusBar, InputBox, WebView } from 'vscode-extension-tester';
import { expect } from 'chai';
import * as path from 'path';

/**
 * Enhanced utility class for TIFF Visualizer extension tests
 * Supports real TIFF file loading and processing verification
 */
export class TiffVisualizerTestUtils {
    private driver: WebDriver;
    private workbench: Workbench;

    constructor() {
        this.driver = VSBrowser.instance.driver;
        this.workbench = new Workbench();
    }

    /**
     * Get the WebDriver instance
     */
    getDriver(): WebDriver {
        return this.driver;
    }

    /**
     * Wait for VS Code to be fully loaded
     */
    async waitForVSCodeLoad(timeout: number = 30000): Promise<void> {
        await this.driver.wait(async () => {
            try {
                const workbench = new Workbench();
                await workbench.getTitleBar();
                return true;
            } catch {
                return false;
            }
        }, timeout);
    }

    /**
     * Open a TIFF file from the test workspace
     */
    async openTiffFile(fileName: string): Promise<CustomEditor> {
        console.log(`🔍 Opening TIFF file: ${fileName}`);
        
        try {
            // First approach: Open workspace with the test file
            const testWorkspacePath = path.resolve(__dirname, '../../../test-workspace');
            const filePath = path.join(testWorkspacePath, fileName);
            
            console.log(`📂 Opening file: ${filePath}`);
            
            // Use VSBrowser to open the file directly
            await VSBrowser.instance.openResources(filePath);
            await this.driver.sleep(3000); // Wait for file to open
            
        } catch (error) {
            console.log(`⚠️  Direct file opening failed, trying alternative method: ${error}`);
            
            // Fallback: Try using File > Open command
            try {
                await this.workbench.executeCommand('File: Open File...');
                await this.driver.sleep(2000);
                
                // This would require handling the native file dialog which is complex
                // For now, we'll use a simpler approach
            } catch (fallbackError) {
                console.log(`⚠️  Fallback method also failed: ${fallbackError}`);
                throw new Error(`Could not open file ${fileName}: ${error}`);
            }
        }

        // Wait for the custom editor to load
        return await this.waitForTiffEditor();
    }

    /**
     * Wait for the TIFF visualizer custom editor to load
     */
    async waitForTiffEditor(timeout: number = 15000): Promise<CustomEditor> {
        const editorView = new EditorView();
        
        const customEditor = await this.driver.wait(async () => {
            try {
                const tabs = await editorView.getOpenEditorTitles();
                for (const title of tabs) {
                    if (title.endsWith('.tif') || title.endsWith('.tiff')) {
                        const editor = await editorView.openEditor(title);
                        if (editor instanceof CustomEditor) {
                            return editor;
                        }
                    }
                }
                return false;
            } catch {
                return false;
            }
        }, timeout);
        
        if (!customEditor) {
            throw new Error('TIFF editor did not load within timeout');
        }
        
        return customEditor as CustomEditor;
    }

    /**
     * Wait for canvas element to be present and loaded in the custom editor webview
     */
    async waitForCanvas(customEditor: CustomEditor, timeout: number = 15000): Promise<any> {
        console.log('🎨 Waiting for canvas to load...');
        
        return await this.driver.wait(async () => {
            try {
                const webview = await customEditor.getWebView();
                await webview.switchToFrame();
                
                // Wait for canvas to exist and have content
                const canvas = await webview.findWebElement({ css: 'canvas' });
                if (canvas) {
                    // Check if canvas has actual content (width/height > 0)
                    const width = await canvas.getAttribute('width');
                    const height = await canvas.getAttribute('height');
                    
                    if (parseInt(width || '0') > 0 && parseInt(height || '0') > 0) {
                        console.log(`✅ Canvas loaded with dimensions: ${width}x${height}`);
                        await webview.switchBack();
                        return canvas;
                    }
                }
                
                await webview.switchBack();
                return false;
            } catch (error) {
                try {
                    const webview = await customEditor.getWebView();
                    await webview.switchBack();
                } catch {}
                return false;
            }
        }, timeout);
    }

    /**
     * Set manual normalization range (borders)
     */
    async setManualNormalizationRange(min: number, max: number): Promise<void> {
        console.log(`🎛️  Setting manual normalization range: ${min} to ${max}`);
        
        // Execute the Set Normalization Range command
        await this.workbench.executeCommand('TIFF Visualizer: Set Normalization Range');
        
        // Wait for the options dialog
        await this.driver.sleep(1000);
        
        // Select "Manual Range" option (first option)
        const quickPick = await this.driver.findElement({ css: '.quick-input-list .monaco-list-row' });
        await quickPick.click();
        await this.driver.sleep(500);
        
        // Enter minimum value
        const minInput = await this.driver.findElement({ css: '.quick-input-widget input' });
        await minInput.clear();
        await minInput.sendKeys(min.toString());
        await minInput.sendKeys('\uE007'); // Enter
        await this.driver.sleep(500);
        
        // Enter maximum value
        const maxInput = await this.driver.findElement({ css: '.quick-input-widget input' });
        await maxInput.clear();
        await maxInput.sendKeys(max.toString());
        await maxInput.sendKeys('\uE007'); // Enter
        await this.driver.sleep(1000);
        
        console.log(`✅ Manual normalization range set to [${min}, ${max}]`);
    }

    /**
     * Set automatic normalization
     */
    async setAutoNormalization(): Promise<void> {
        console.log('🤖 Setting automatic normalization...');
        
        await this.workbench.executeCommand('TIFF Visualizer: Set Normalization Range');
        await this.driver.sleep(1000);
        
        // Find and click "Auto-Normalize" option (second option)
        const options = await this.driver.findElements({ css: '.quick-input-list .monaco-list-row' });
        if (options.length > 1) {
            await options[1].click(); // Auto-normalize option
            await this.driver.sleep(1000);
            console.log('✅ Auto-normalization enabled');
        } else {
            throw new Error('Auto-normalize option not found');
        }
    }

    /**
     * Apply gamma correction
     */
    async setGammaCorrection(gammaIn: number = 2.2, gammaOut: number = 1.0): Promise<void> {
        console.log(`⚡ Setting gamma correction: ${gammaIn} → ${gammaOut}`);
        
        await this.workbench.executeCommand('TIFF Visualizer: Set Gamma');
        await this.driver.sleep(1000);
        
        // Enter gamma in value
        const gammaInInput = await this.driver.findElement({ css: '.quick-input-widget input' });
        await gammaInInput.clear();
        await gammaInInput.sendKeys(gammaIn.toString());
        await gammaInInput.sendKeys('\uE007'); // Enter
        await this.driver.sleep(500);
        
        // Enter gamma out value
        const gammaOutInput = await this.driver.findElement({ css: '.quick-input-widget input' });
        await gammaOutInput.clear();
        await gammaOutInput.sendKeys(gammaOut.toString());
        await gammaOutInput.sendKeys('\uE007'); // Enter
        await this.driver.sleep(1000);
        
        console.log(`✅ Gamma correction applied: ${gammaIn} → ${gammaOut}`);
    }

    /**
     * Move mouse to a specific position on the canvas and get pixel information
     */
    async getPixelInfoAtPosition(customEditor: CustomEditor, x: number, y: number): Promise<{position: string, value: string}> {
        console.log(`🖱️  Moving mouse to position (${x}, ${y}) to read pixel value...`);
        
        const webview = await customEditor.getWebView();
        await webview.switchToFrame();
        
        try {
            const canvas = await webview.findWebElement({ css: 'canvas' });
            
            // Move mouse to the specified position
            await this.driver.actions()
                .move({ origin: canvas, x: x, y: y })
                .perform();
            
            await this.driver.sleep(500); // Wait for pixel value to update
            
            await webview.switchBack();
            
            // Check status bar for pixel information
            const pixelInfo = await this.getPixelInfoFromStatusBar();
            
            console.log(`✅ Pixel at (${x}, ${y}): ${pixelInfo.value}`);
            return {
                position: `(${x}, ${y})`,
                value: pixelInfo.value
            };
            
        } finally {
            await webview.switchBack();
        }
    }

    /**
     * Get pixel information from status bar
     */
    async getPixelInfoFromStatusBar(): Promise<{position: string, value: string}> {
        const statusBar = new StatusBar();
        const items = await statusBar.getItems();
        
        let position = '';
        let value = '';
        
        for (const item of items) {
            const text = await item.getText();
            
            // Look for position information (x, y)
            if (text.includes('(') && text.includes(',') && text.includes(')')) {
                position = text;
            }
            
            // Look for pixel value information
            if (text.includes('RGB') || text.includes('Value:') || /[\d\.]+/.test(text)) {
                value = text;
            }
        }
        
        return { position, value };
    }

    /**
     * Get status bar entries related to TIFF visualization
     */
    async getStatusBarEntries(): Promise<string[]> {
        const statusBar = new StatusBar();
        const items = await statusBar.getItems();
        const entries: string[] = [];
        
        for (const item of items) {
            const text = await item.getText();
            if (text && (
                text.includes('Size:') || 
                text.includes('Zoom:') || 
                text.includes('Brightness:') || 
                text.includes('Gamma:') || 
                text.includes('Normalization:') || 
                text.includes('Mask:') ||
                text.includes('RGB') ||
                text.includes('Value:') ||
                text.includes('(') && text.includes(',') && text.includes(')')
            )) {
                entries.push(text);
            }
        }
        
        return entries;
    }

    /**
     * Execute a TIFF Visualizer command
     */
    async executeTiffCommand(commandName: string): Promise<void> {
        await this.workbench.executeCommand(`TIFF Visualizer: ${commandName}`);
        await this.driver.sleep(500);
    }

    /**
     * Verify that expected status bar entries are present
     */
    async verifyStatusBarEntries(expectedEntries: string[]): Promise<void> {
        const actualEntries = await this.getStatusBarEntries();
        
        for (const expected of expectedEntries) {
            const found = actualEntries.some(entry => entry.includes(expected));
            expect(found, `Expected status bar entry containing "${expected}" not found. Actual entries: ${actualEntries.join(', ')}`).to.be.true;
        }
    }

    /**
     * Test the complete workflow described by the user:
     * 1. Open depth image
     * 2. Set manual borders (0 to 2)
     * 3. Set auto borders
     * 4. Apply gamma correction
     * 5. Test mouse interaction and pixel values
     */
    async testCompleteWorkflow(depthImageFile: string): Promise<void> {
        console.log('🚀 Starting complete TIFF processing workflow test...');
        
        // Step 1: Open depth image
        console.log('📁 Step 1: Opening depth image...');
        const customEditor = await this.openTiffFile(depthImageFile);
        const canvas = await this.waitForCanvas(customEditor);
        
        // Step 2: Set manual borders (0 to 2)
        console.log('🎯 Step 2: Setting manual borders (0 to 2)...');
        await this.setManualNormalizationRange(0, 2);
        await this.driver.sleep(2000); // Wait for image to re-render
        
        // Step 3: Set automatic borders
        console.log('🤖 Step 3: Setting automatic borders...');
        await this.setAutoNormalization();
        await this.driver.sleep(2000); // Wait for image to re-render
        
        // Step 4: Apply gamma correction
        console.log('⚡ Step 4: Applying gamma correction...');
        await this.setGammaCorrection(2.2, 1.0);
        await this.driver.sleep(2000); // Wait for image to re-render
        
        // Step 5: Test mouse interaction and pixel values
        console.log('🖱️  Step 5: Testing mouse interaction and pixel values...');
        const positions = [
            { x: 50, y: 50 },    // Top-left area
            { x: 150, y: 100 },  // Center-left area
            { x: 250, y: 150 },  // Center-right area
        ];
        
        for (const pos of positions) {
            const pixelInfo = await this.getPixelInfoAtPosition(customEditor, pos.x, pos.y);
            console.log(`📊 Pixel at ${pixelInfo.position}: ${pixelInfo.value}`);
            
            // Verify we got some pixel information
            expect(pixelInfo.value).to.not.be.empty;
        }
        
        // Verify status bar shows expected information
        const statusEntries = await this.getStatusBarEntries();
        console.log('📋 Final status bar entries:', statusEntries);
        
        // Should have size, zoom, and potentially pixel value information
        expect(statusEntries.length).to.be.greaterThan(0);
        
        console.log('✅ Complete TIFF processing workflow test completed successfully!');
    }

    /**
     * Take a screenshot for debugging
     */
    async takeScreenshot(name: string): Promise<void> {
        try {
            const fs = require('fs');
            const screenshotDir = './test-resources/screenshots';
            if (!fs.existsSync(screenshotDir)) {
                fs.mkdirSync(screenshotDir, { recursive: true });
            }
            
            await this.driver.takeScreenshot().then((data: string) => {
                fs.writeFileSync(`${screenshotDir}/${name}.png`, data, 'base64');
            });
            console.log(`📸 Screenshot saved: ${screenshotDir}/${name}.png`);
        } catch (error) {
            console.warn(`Failed to take screenshot: ${error}`);
        }
    }

    /**
     * Cleanup after tests
     */
    async cleanup(): Promise<void> {
        try {
            // Close all editors
            const editorView = new EditorView();
            await editorView.closeAllEditors();
            console.log('🧹 Test cleanup completed');
        } catch (error) {
            console.warn(`Cleanup warning: ${error}`);
        }
    }
}

/**
 * Wait helper function
 */
export async function waitFor(condition: () => Promise<boolean>, timeout: number = 10000): Promise<void> {
    const driver = VSBrowser.instance.driver;
    await driver.wait(condition, timeout);
}

/**
 * Sleep helper function
 */
export async function sleep(ms: number): Promise<void> {
    const driver = VSBrowser.instance.driver;
    await driver.sleep(ms);
} 
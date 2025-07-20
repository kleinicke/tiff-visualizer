import { WebDriver, VSBrowser, Workbench, EditorView, CustomEditor, StatusBar } from 'vscode-extension-tester';
import { expect } from 'chai';

/**
 * Utility class for TIFF Visualizer extension tests
 */
export class TiffVisualizerTestUtils {
    private driver: WebDriver;
    private workbench: Workbench;

    constructor() {
        this.driver = VSBrowser.instance.driver;
        this.workbench = new Workbench();
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
     * Open a TIFF file from the explorer
     */
    async openTiffFile(fileName: string): Promise<void> {
        // Use the command palette to open file
        await this.workbench.executeCommand('File: Open...');
        
        // Wait for the dialog and handle file selection
        // This will need to be adapted based on how files are provided in the test workspace
        await this.driver.sleep(1000);
    }

    /**
     * Wait for the TIFF visualizer custom editor to load
     */
    async waitForTiffEditor(timeout: number = 10000): Promise<CustomEditor> {
        const editorView = new EditorView();
        
        return await this.driver.wait(async () => {
            try {
                const editors = await editorView.getOpenEditorTitles();
                for (const title of editors) {
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
        }, timeout) as CustomEditor;
    }

    /**
     * Wait for canvas element to be present in the custom editor
     */
    async waitForCanvas(customEditor: CustomEditor, timeout: number = 10000): Promise<any> {
        return await this.driver.wait(async () => {
            try {
                const webview = await customEditor.getWebView();
                await webview.switchToFrame();
                const canvas = await webview.findWebElement({ css: 'canvas' });
                await webview.switchBack();
                return canvas;
            } catch {
                await customEditor.getWebView().then(wv => wv.switchBack()).catch(() => {});
                return false;
            }
        }, timeout);
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
            if (text.includes('Size:') || text.includes('Zoom:') || text.includes('Brightness:') || 
                text.includes('Gamma:') || text.includes('Normalization:') || text.includes('Mask:')) {
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
    }

    /**
     * Test mouse interactions on the canvas
     */
    async testMouseInteractions(canvas: any): Promise<void> {
        // Get canvas dimensions
        const rect = await this.driver.executeScript(`
            return arguments[0].getBoundingClientRect();
        `, canvas);

        // Perform mouse actions
        const actions = this.driver.actions();
        
        // Click in the center
        await actions.move({ 
            origin: canvas, 
            x: Math.floor(rect.width / 2), 
            y: Math.floor(rect.height / 2) 
        }).click().perform();

        // Scroll wheel simulation (if supported)
        await actions.scroll(0, 0, 0, 5, canvas).perform();
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
     * Take a screenshot for debugging
     */
    async takeScreenshot(name: string): Promise<void> {
        try {
            await this.driver.takeScreenshot().then(data => {
                require('fs').writeFileSync(`./test-resources/screenshots/${name}.png`, data, 'base64');
            });
        } catch (error) {
            console.warn(`Failed to take screenshot: ${error}`);
        }
    }

    /**
     * Setup test workspace with TIFF files
     */
    async setupTestWorkspace(): Promise<void> {
        // This would copy test TIFF files to the workspace
        // Implementation depends on how you want to provide test files
        console.log('Setting up test workspace...');
    }

    /**
     * Cleanup after tests
     */
    async cleanup(): Promise<void> {
        try {
            // Close all editors
            const editorView = new EditorView();
            await editorView.closeAllEditors();
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
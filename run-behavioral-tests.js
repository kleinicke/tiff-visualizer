const { runTests } = require('@vscode/test-electron');
const path = require('path');

/**
 * Behavioral test runner for Image Visualizer extension
 * Tests the actual behavior with real TIFF images
 */
async function main() {
    try {
        const extensionDevelopmentPath = path.resolve(__dirname);
        const extensionTestsPath = path.resolve(__dirname, './out/test/behavioral.test.js');
        const testWorkspace = path.resolve(__dirname, './test-workspace');

        console.log('🧪 Running Image Visualizer Behavioral Tests...');
        console.log('📁 Extension path:', extensionDevelopmentPath);
        console.log('🧪 Test path:', extensionTestsPath);
        console.log('🖼️  Test workspace:', testWorkspace);

        // Download VS Code, unzip it and run the integration test
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [
                testWorkspace,
                '--disable-extensions', // Disable other extensions to avoid conflicts
                '--disable-workspace-trust', // Skip workspace trust dialog  
                '--disable-updates' // Disable update checks
            ]
        });
        
        console.log('✅ All behavioral tests passed!');
    } catch (err) {
        console.error('❌ Behavioral tests failed:', err);
        process.exit(1);
    }
}

main(); 
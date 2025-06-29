import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Simple test runner for behavioral tests
 */
async function main() {
	try {
		// The folder containing the Extension Manifest package.json
		const extensionDevelopmentPath = path.resolve(__dirname, '../../');

		// The path to test runner module
		const extensionTestsPath = path.resolve(__dirname, './suite/index');

		// Download VS Code, unzip it and run the integration test
		await runTests({ 
			extensionDevelopmentPath, 
			extensionTestsPath,
			launchArgs: ['--disable-extensions']
		});
	} catch (err) {
		console.error('Failed to run tests:', err);
		process.exit(1);
	}
}

main(); 
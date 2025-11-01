import * as vscode from 'vscode';
import { BinarySizeStatusBarEntry } from './binarySizeStatusBarEntry';
import { registerImagePreviewSupport } from './imagePreview/index';

// Shared output channel for the extension
let outputChannel: vscode.OutputChannel;

export function getOutputChannel(): vscode.OutputChannel {
	return outputChannel;
}

export function activate(context: vscode.ExtensionContext) {
	// Create output channel for debugging (without showing it to avoid focus stealing)
	outputChannel = vscode.window.createOutputChannel('TIFF Visualizer Debug');
	context.subscriptions.push(outputChannel);

	outputChannel.appendLine('='.repeat(50));
	outputChannel.appendLine('Extension activated');
	outputChannel.appendLine('='.repeat(50));

	const binarySizeStatusBarEntry = new BinarySizeStatusBarEntry();
	context.subscriptions.push(binarySizeStatusBarEntry);

	const disposable = registerImagePreviewSupport(context, binarySizeStatusBarEntry);
	context.subscriptions.push(disposable);
}

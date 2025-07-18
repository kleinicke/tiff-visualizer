import * as vscode from 'vscode';
import { BinarySizeStatusBarEntry } from './binarySizeStatusBarEntry';
import { registerImagePreviewSupport } from './imagePreview/index';

let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
	// Create output channel for debugging
	outputChannel = vscode.window.createOutputChannel('TIFF Visualizer Debug');
	outputChannel.show();
	
	outputChannel.appendLine('='.repeat(50));
	outputChannel.appendLine('TIFF Visualizer extension is being activated...');
	outputChannel.appendLine(`Extension path: ${context.extensionPath}`);
	outputChannel.appendLine(`Extension URI: ${context.extensionUri.toString()}`);
	
	console.log('TIFF Visualizer extension is being activated...');
	
	const binarySizeStatusBarEntry = new BinarySizeStatusBarEntry();
	context.subscriptions.push(binarySizeStatusBarEntry);

	const disposable = registerImagePreviewSupport(context, binarySizeStatusBarEntry);
	context.subscriptions.push(disposable);
	
	outputChannel.appendLine('TIFF Visualizer extension activated successfully');
	outputChannel.appendLine('='.repeat(50));
	console.log('TIFF Visualizer extension activated successfully');
}

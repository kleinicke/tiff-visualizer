import * as vscode from 'vscode';
import { BinarySizeStatusBarEntry } from '../binarySizeStatusBarEntry';
import { SizeStatusBarEntry } from './sizeStatusBarEntry';
import { ZoomStatusBarEntry } from './zoomStatusBarEntry';
import { NormalizationStatusBarEntry } from './normalizationStatusBarEntry';
import { GammaStatusBarEntry } from './gammaStatusBarEntry';
import { BrightnessStatusBarEntry } from './brightnessStatusBarEntry';
import { MaskFilterStatusBarEntry } from './maskFilterStatusBarEntry';
import { ImagePreviewManager } from './imagePreviewManager';
import { registerImagePreviewCommands } from './commands';

// Re-export the main classes for backward compatibility
export { ImagePreviewManager } from './imagePreviewManager';
export { ImagePreview } from './imagePreview';

export function registerImagePreviewSupport(context: vscode.ExtensionContext, binarySizeStatusBarEntry: BinarySizeStatusBarEntry): vscode.Disposable {
	const outputChannel = vscode.window.createOutputChannel('TIFF Visualizer Debug');
	
	outputChannel.appendLine('TIFF Visualizer: Registering image preview support...');
	console.log('TIFF Visualizer: Registering image preview support...');
	
	const disposables: vscode.Disposable[] = [];

	// Create status bar entries
	const sizeStatusBarEntry = new SizeStatusBarEntry();
	disposables.push(sizeStatusBarEntry);

	const zoomStatusBarEntry = new ZoomStatusBarEntry();
	disposables.push(zoomStatusBarEntry);

	const normalizationStatusBarEntry = new NormalizationStatusBarEntry();
	disposables.push(normalizationStatusBarEntry);

	const gammaStatusBarEntry = new GammaStatusBarEntry();
	disposables.push(gammaStatusBarEntry);

	const brightnessStatusBarEntry = new BrightnessStatusBarEntry();
	disposables.push(brightnessStatusBarEntry);

	const maskFilterStatusBarEntry = new MaskFilterStatusBarEntry();
	disposables.push(maskFilterStatusBarEntry);

	// Create the preview manager
	const previewManager = new ImagePreviewManager(
		context.extensionUri,
		sizeStatusBarEntry,
		binarySizeStatusBarEntry,
		zoomStatusBarEntry,
		normalizationStatusBarEntry,
		gammaStatusBarEntry,
		brightnessStatusBarEntry,
		maskFilterStatusBarEntry
	);

	// Register the custom editor provider
	outputChannel.appendLine(`TIFF Visualizer: Registering custom editor provider for viewType: ${ImagePreviewManager.viewType}`);
	console.log('TIFF Visualizer: Registering custom editor provider for viewType:', ImagePreviewManager.viewType);
	disposables.push(vscode.window.registerCustomEditorProvider(ImagePreviewManager.viewType, previewManager, {
		supportsMultipleEditorsPerDocument: true,
	}));

	// Register commands
	disposables.push(registerImagePreviewCommands(context, previewManager, binarySizeStatusBarEntry));

	outputChannel.appendLine('TIFF Visualizer: Image preview support registered successfully');
	console.log('TIFF Visualizer: Image preview support registered successfully');
	return vscode.Disposable.from(...disposables);
} 
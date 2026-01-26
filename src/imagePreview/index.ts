import * as vscode from 'vscode';
import { BinarySizeStatusBarEntry } from '../binarySizeStatusBarEntry';
import { SizeStatusBarEntry } from './sizeStatusBarEntry';
import { ZoomStatusBarEntry } from './zoomStatusBarEntry';
import { NormalizationStatusBarEntry } from './normalizationStatusBarEntry';
import { GammaStatusBarEntry } from './gammaStatusBarEntry';
import { BrightnessStatusBarEntry } from './brightnessStatusBarEntry';
import { MaskFilterStatusBarEntry } from './maskFilterStatusBarEntry';
import { HistogramStatusBarEntry } from './histogramStatusBarEntry';
import { ColorPickerModeStatusBarEntry } from './colorPickerModeStatusBarEntry';
import { ImagePreviewManager } from './imagePreviewManager';
import { registerImagePreviewCommands } from './commands';
import { registerComparisonPanelSupport } from '../comparisonPanel/index';
import { getOutputChannel } from '../extension';

// Re-export the main classes for backward compatibility
export { ImagePreviewManager } from './imagePreviewManager';
export { ImagePreview } from './imagePreview';

export function registerImagePreviewSupport(context: vscode.ExtensionContext, binarySizeStatusBarEntry: BinarySizeStatusBarEntry): vscode.Disposable {
	const outputChannel = getOutputChannel();

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

	const histogramStatusBarEntry = new HistogramStatusBarEntry();
	disposables.push(histogramStatusBarEntry);

	const colorPickerModeStatusBarEntry = new ColorPickerModeStatusBarEntry();
	disposables.push(colorPickerModeStatusBarEntry);

	// Create the preview manager
	const previewManager = new ImagePreviewManager(
		context.extensionUri,
		sizeStatusBarEntry,
		binarySizeStatusBarEntry,
		zoomStatusBarEntry,
		normalizationStatusBarEntry,
		gammaStatusBarEntry,
		brightnessStatusBarEntry,
		maskFilterStatusBarEntry,
		histogramStatusBarEntry,
		colorPickerModeStatusBarEntry
	);

	// Register the custom editor provider
	const viewType = ImagePreviewManager.getViewType();
	disposables.push(vscode.window.registerCustomEditorProvider(viewType, previewManager, {
		supportsMultipleEditorsPerDocument: true,
	}));

	// Register commands
	disposables.push(registerImagePreviewCommands(context, previewManager, sizeStatusBarEntry, binarySizeStatusBarEntry));

	// Register comparison panel support
	disposables.push(registerComparisonPanelSupport(context));

	outputChannel.appendLine('Image preview support registered successfully');
	return vscode.Disposable.from(...disposables);
} 
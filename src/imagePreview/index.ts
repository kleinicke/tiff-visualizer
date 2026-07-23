import * as vscode from 'vscode';
import { BinarySizeStatusBarEntry } from '../binarySizeStatusBarEntry';
import { SizeStatusBarEntry } from './sizeStatusBarEntry';
import { ZoomStatusBarEntry } from './zoomStatusBarEntry';
import { NormalizationStatusBarEntry } from './normalizationStatusBarEntry';
import { GammaStatusBarEntry } from './gammaStatusBarEntry';
import { BrightnessStatusBarEntry } from './brightnessStatusBarEntry';
import { LayersStatusBarEntry } from './layersStatusBarEntry';
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

	const layersStatusBarEntry = new LayersStatusBarEntry();
	disposables.push(layersStatusBarEntry);

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
		layersStatusBarEntry,
		histogramStatusBarEntry,
		colorPickerModeStatusBarEntry
	);

	// Register the primary custom editor provider (default priority)
	const viewType = ImagePreviewManager.getViewType();
	disposables.push(vscode.window.registerCustomEditorProvider(viewType, previewManager, {
		supportsMultipleEditorsPerDocument: true,
		webviewOptions: { retainContextWhenHidden: true },
	}));

	// Register the option-priority provider contributed for formats handled by
	// VS Code's built-in image viewer. Keeping the built-in viewer as the default
	// is important because it provides Git's old/new image diff experience;
	// users can still select Scientific Image Visualizer from Open With.
	const viewTypeOption = ImagePreviewManager.optionViewType;
	disposables.push(vscode.window.registerCustomEditorProvider(viewTypeOption, previewManager, {
		supportsMultipleEditorsPerDocument: true,
		webviewOptions: { retainContextWhenHidden: true },
	}));

	// Restore dedicated Layers windows after a full VS Code restart. The webview
	// reloads and rebuilds its layer stack from its persisted state.
	disposables.push(vscode.window.registerWebviewPanelSerializer(ImagePreviewManager.layerViewType, {
		async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: any) {
			const resourceUri = state?.currentResourceUri;
			if (!resourceUri) {
				panel.dispose();
				return;
			}
			previewManager.reviveLayerView(panel, vscode.Uri.parse(resourceUri));
		}
	}));

	// Register commands
	disposables.push(registerImagePreviewCommands(context, previewManager, sizeStatusBarEntry, binarySizeStatusBarEntry));

	// Register comparison panel support
	disposables.push(registerComparisonPanelSupport(context));

	outputChannel.appendLine('Image preview support registered successfully');
	return vscode.Disposable.from(...disposables);
}

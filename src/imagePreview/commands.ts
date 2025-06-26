import * as vscode from 'vscode';
import { BinarySizeStatusBarEntry } from '../binarySizeStatusBarEntry';
import { ImagePreviewManager } from './imagePreviewManager';

export function registerImagePreviewCommands(
	context: vscode.ExtensionContext, 
	previewManager: ImagePreviewManager,
	binarySizeStatusBarEntry: BinarySizeStatusBarEntry
): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.zoomIn', () => {
		previewManager.activePreview?.zoomIn();
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.zoomOut', () => {
		previewManager.activePreview?.zoomOut();
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.resetZoom', () => {
		previewManager.activePreview?.resetZoom();
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.copyImage', async () => {
		const activePreview = previewManager.activePreview;
		if (activePreview) {
			activePreview.copyImage();
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.exportAsPng', async () => {
		const activePreview = previewManager.activePreview;
		if (activePreview) {
			try {
				const result = await activePreview.exportAsPng();
				if (result) {
					const saveUri = await vscode.window.showSaveDialog({
						filters: { 'PNG Images': ['png'] },
						defaultUri: vscode.Uri.file(activePreview.resource.path.replace(/\.[^/.]+$/, '.png'))
					});
					
					if (saveUri) {
						const buffer = Buffer.from(result.split(',')[1], 'base64');
						await vscode.workspace.fs.writeFile(saveUri, buffer);
						vscode.window.showInformationMessage(`Image exported to ${saveUri.fsPath}`);
					}
				}
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to export image: ${error}`);
			}
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.setNormalizationRange', async () => {
		const currentConfig = previewManager.getNormalizationConfig();
		const activePreview = previewManager.activePreview;
		
		// First show a QuickPick with options
		const options = [
			{
				label: (!currentConfig.autoNormalize && !currentConfig.gammaMode) ? '$(check) Manual Range' : '$(square) Manual Range',
				description: 'Set custom min/max values',
				detail: `Current: [${currentConfig.min.toFixed(2)}, ${currentConfig.max.toFixed(2)}]`,
				action: 'manual'
			},
			{
				label: currentConfig.autoNormalize ? '$(check) Auto-Normalize' : '$(square) Auto-Normalize',
				description: 'Automatically use image min/max values',
				detail: 'Normalize each float image from its actual min to max pixel values',
				action: 'auto'
			},
			{
				label: currentConfig.gammaMode ? '$(check) Gamma/Brightness Mode' : '$(square) Gamma/Brightness Mode',
				description: 'Normalize to fixed 0-1 range and enable gamma/brightness controls',
				detail: 'Always normalize to 0-1 range, then apply gamma and brightness adjustments',
				action: 'gamma'
			}
		];

		const selected = await vscode.window.showQuickPick(options, {
			placeHolder: 'Choose normalization method',
			title: 'Image Normalization Settings',
			canPickMany: false,
			matchOnDescription: false,
			matchOnDetail: false
		});

		if (!selected) {
			return;
		}

		if (selected.action === 'auto') {
			previewManager.setAutoNormalize(true);
			previewManager.updateAllPreviews();
			if (activePreview) {
				activePreview.updateStatusBar();
			}
			vscode.window.showInformationMessage('Auto-normalization enabled. Images will be normalized using their actual min/max values.');
		} else if (selected.action === 'gamma') {
			previewManager.setGammaMode(true);
			previewManager.updateAllPreviews();
			if (activePreview) {
				activePreview.updateStatusBar();
			}
			vscode.window.showInformationMessage('Gamma/Brightness mode enabled. Images will be normalized to 0-1 range with gamma/brightness controls.');
		} else {
			// Manual range setting
			previewManager.setAutoNormalize(false);
			previewManager.setGammaMode(false);
			
			const minValue = await vscode.window.showInputBox({
				prompt: 'Enter the minimum value for normalization',
				value: currentConfig.min.toString(),
				validateInput: text => {
					return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
				}
			});

			if (minValue === undefined) {
				return;
			}

			const maxValue = await vscode.window.showInputBox({
				prompt: 'Enter the maximum value for normalization',
				value: currentConfig.max.toString(),
				validateInput: text => {
					const num = parseFloat(text);
					return isNaN(num) ? 'Please enter a valid number.' : 
						   num <= parseFloat(minValue) ? 'Maximum must be greater than minimum.' : null;
				}
			});

			if (maxValue === undefined) {
				return;
			}

			const min = parseFloat(minValue);
			const max = parseFloat(maxValue);

			previewManager.setTempNormalization(min, max);
			previewManager.updateAllPreviews();
			if (activePreview) {
				activePreview.updateStatusBar();
			}
			vscode.window.showInformationMessage(`Normalization range set to [${min.toFixed(2)}, ${max.toFixed(2)}]`);
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.setGamma', async () => {
		const currentPreview = previewManager.activePreview;
		const normConfig = previewManager.getNormalizationConfig();
		
		// Check if this is a float TIFF and not in gamma mode
		if (currentPreview && currentPreview.isFloatTiff && !normConfig.gammaMode) {
			const choice = await vscode.window.showQuickPick([
				{
					label: '$(arrow-right) Switch to Gamma/Brightness Mode',
					description: 'Enable gamma correction for this float image',
					detail: 'Use current normalization range with gamma/brightness controls',
					action: 'switch'
				},
				{
					label: '$(edit) Set Gamma (Manual Mode)',
					description: 'Set gamma values for manual normalization',
					detail: 'Keep current normalization mode and set gamma values',
					action: 'manual'
				},
				{
					label: '$(x) Cancel',
					description: 'Go back without changes',
					action: 'cancel'
				}
			], {
				placeHolder: 'Float image detected - Choose how to apply gamma correction',
				title: 'Gamma Correction for Float Image',
				canPickMany: false,
				matchOnDescription: false,
				matchOnDetail: false
			});

			if (!choice || choice.action === 'cancel') {
				return;
			}

			if (choice.action === 'switch') {
				previewManager.setGammaMode(true);
				previewManager.updateAllPreviews();
				if (currentPreview) {
					currentPreview.updateStatusBar();
				}
				vscode.window.showInformationMessage('Switched to Gamma/Brightness mode. Current normalization range will be used with gamma/brightness controls.');
				return;
			}
		}

		const currentConfig = previewManager.getGammaConfig();

		const gammaIn = await vscode.window.showInputBox({
			prompt: 'Enter the source gamma value. (Default: 2.2, Linear: 1.0)',
			value: currentConfig.in.toString(),
			validateInput: text => {
				return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
			}
		});

		if (gammaIn === undefined) {
			return;
		}

		const gammaOut = await vscode.window.showInputBox({
			prompt: 'Enter the target gamma value. (Default: 2.2, Linear: 1.0)',
			value: currentConfig.out.toString(),
			validateInput: text => {
				return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
			}
		});

		if (gammaOut === undefined) {
			return;
		}

		const gammaInValue = parseFloat(gammaIn);
		const gammaOutValue = parseFloat(gammaOut);

		previewManager.setTempGamma(gammaInValue, gammaOutValue);
		previewManager.updateAllPreviews();
		if (currentPreview) {
			currentPreview.updateStatusBar();
		}
		vscode.window.showInformationMessage(`Gamma correction set to In: ${gammaInValue.toFixed(2)}, Out: ${gammaOutValue.toFixed(2)}`);
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.setBrightness', async () => {
		const currentConfig = previewManager.getBrightnessConfig();
		const currentPreview = previewManager.activePreview;

		const brightness = await vscode.window.showInputBox({
			prompt: 'Enter brightness offset in stops. (0 = no change, +1 = 2x brighter, -1 = 2x darker)',
			value: currentConfig.offset.toString(),
			validateInput: text => {
				return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
			}
		});

		if (brightness === undefined) {
			return;
		}

		const brightnessValue = parseFloat(brightness);
		previewManager.setTempBrightness(brightnessValue);
		previewManager.updateAllPreviews();
		if (currentPreview) {
			currentPreview.updateStatusBar();
		}
		vscode.window.showInformationMessage(`Brightness offset set to ${brightnessValue.toFixed(2)} stops`);
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.setComparisonBase', async () => {
		const activePreview = previewManager.activePreview;
		if (!activePreview) {
			return;
		}

		const currentBase = previewManager.getComparisonBase();
		
		if (currentBase) {
			// Already has a comparison base, offer to clear it
			const choice = await vscode.window.showQuickPick([
				{
					label: '$(file-media) Choose New Comparison Image',
					description: 'Select a different image to compare with',
					action: 'choose'
				},
				{
					label: '$(x) Clear Comparison',
					description: 'Remove the current comparison image',
					action: 'clear'
				}
			], {
				placeHolder: `Current comparison: ${currentBase.fsPath}`,
				title: 'Image Comparison',
				canPickMany: false,
				matchOnDescription: false,
				matchOnDetail: false
			});

			if (!choice) {
				return;
			}

			if (choice.action === 'clear') {
				previewManager.setComparisonBase(undefined);
				vscode.window.showInformationMessage('Comparison cleared.');
				return;
			}
		}

		// Choose a new comparison image
		const uris = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: {
				'Images': ['tif', 'tiff', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp']
			},
			title: 'Select Comparison Image'
		});

		if (uris && uris.length > 0) {
			const comparisonUri = uris[0];
			previewManager.setComparisonBase(comparisonUri);
			activePreview.startComparison(comparisonUri);
			vscode.window.showInformationMessage(`Comparison set to: ${comparisonUri.fsPath}`);
		}
	}));

	return vscode.Disposable.from(...disposables);
} 
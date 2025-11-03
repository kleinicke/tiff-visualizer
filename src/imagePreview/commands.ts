import * as vscode from 'vscode';
import { BinarySizeStatusBarEntry } from '../binarySizeStatusBarEntry';
import { ImagePreviewManager } from './imagePreviewManager';
import { ComparisonPanel } from '../comparisonPanel/comparisonPanel';
import { getOutputChannel } from '../extension';

/**
 * Logs command execution to the output channel
 */
function logCommand(commandName: string, status: 'start' | 'success' | 'error', details?: string) {
	const output = getOutputChannel();
	const timestamp = new Date().toLocaleTimeString();
	const statusIcon = status === 'start' ? '▶️' : status === 'success' ? '✅' : '❌';

	if (status === 'start') {
		output.appendLine(`[${timestamp}] ${statusIcon} Command: ${commandName}`);
	} else if (status === 'success') {
		output.appendLine(`[${timestamp}] ${statusIcon} Command: ${commandName} - SUCCESS${details ? ` (${details})` : ''}`);
	} else {
		output.appendLine(`[${timestamp}] ${statusIcon} Command: ${commandName} - FAILED${details ? ` - ${details}` : ''}`);
	}
}

export function registerImagePreviewCommands(
	context: vscode.ExtensionContext,
	previewManager: ImagePreviewManager,
	binarySizeStatusBarEntry: BinarySizeStatusBarEntry
): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.zoomIn', () => {
		logCommand('zoomIn', 'start');
		try {
			previewManager.activePreview?.zoomIn();
			logCommand('zoomIn', 'success');
		} catch (error) {
			logCommand('zoomIn', 'error', String(error));
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.zoomOut', () => {
		logCommand('zoomOut', 'start');
		try {
			previewManager.activePreview?.zoomOut();
			logCommand('zoomOut', 'success');
		} catch (error) {
			logCommand('zoomOut', 'error', String(error));
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.resetZoom', () => {
		logCommand('resetZoom', 'start');
		try {
			previewManager.activePreview?.resetZoom();
			logCommand('resetZoom', 'success');
		} catch (error) {
			logCommand('resetZoom', 'error', String(error));
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.copyImage', async () => {
		logCommand('copyImage', 'start');
		try {
			const activePreview = previewManager.activePreview;
			if (activePreview) {
				activePreview.copyImage();
				logCommand('copyImage', 'success');
			} else {
				logCommand('copyImage', 'error', 'No active preview');
			}
		} catch (error) {
			logCommand('copyImage', 'error', String(error));
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.exportAsPng', async () => {
		logCommand('exportAsPng', 'start');
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
						logCommand('exportAsPng', 'success', saveUri.fsPath);
					} else {
						logCommand('exportAsPng', 'error', 'User cancelled save dialog');
					}
				} else {
					logCommand('exportAsPng', 'error', 'No result from exportAsPng');
				}
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to export image: ${error}`);
				logCommand('exportAsPng', 'error', String(error));
			}
		} else {
			logCommand('exportAsPng', 'error', 'No active preview');
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.setNormalizationRange', async () => {
		logCommand('setNormalizationRange', 'start');
		const currentConfig = previewManager.getNormalizationConfig();
		const activePreview = previewManager.activePreview;

		// Check if we have an RGB image (3 or more channels)
		const formatInfo = activePreview?.getManager().appStateManager.uiState.formatInfo;
		// 24-bit mode only for 8-bit uint RGB images
		const isRgb8BitUint = formatInfo &&
			formatInfo.samplesPerPixel >= 3 &&
			formatInfo.bitsPerSample === 8 &&
			formatInfo.sampleFormat !== 3; // Not float
		const isSingleChannelUint = formatInfo && formatInfo.samplesPerPixel === 1 && formatInfo.sampleFormat !== 3; // Not float
		const rgbModeEnabled = previewManager.appStateManager.imageSettings.rgbAs24BitGrayscale;
		const normalizedFloatModeEnabled = previewManager.appStateManager.imageSettings.normalizedFloatMode;

		// First show a QuickPick with options
		const options: Array<vscode.QuickPickItem & { action?: string }> = [
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

		// Add RGB 24-bit mode option only for 8-bit uint RGB images
		if (isRgb8BitUint) {
			options.push(
				{
					label: '',
					kind: vscode.QuickPickItemKind.Separator
				},
				{
					label: rgbModeEnabled ? '$(check) RGB as 24-bit Grayscale' : '$(square) RGB as 24-bit Grayscale',
					description: 'Interpret RGB channels as single 24-bit value',
					detail: 'Combines R, G, B into one 24-bit integer: (R<<16)|(G<<8)|B (0-16777215)',
					action: 'rgb24bit'
				}
			);
		}

		// Add normalized float mode option for single-channel uint images
		if (isSingleChannelUint) {
			options.push(
				{
					label: '',
					kind: vscode.QuickPickItemKind.Separator
				},
				{
					label: normalizedFloatModeEnabled ? '$(check) Normalized Float Mode' : '$(square) Normalized Float Mode',
					description: 'Display uint values as normalized floats (0-1)',
					detail: 'Color picker shows float values, normalization borders use float range',
					action: 'normalizedFloat'
				}
			);
		}

		// Create a custom QuickPick to disable input
		const quickPick = vscode.window.createQuickPick<typeof options[0]>();
		quickPick.items = options;
		quickPick.placeholder = 'Choose normalization method';
		quickPick.title = 'Image Normalization Settings';
		quickPick.canSelectMany = false;
		quickPick.ignoreFocusOut = false;
		
		// Disable the input box by making it non-interactive
		quickPick.value = '';
		
		const selected = await new Promise<typeof options[0] | undefined>((resolve) => {
			quickPick.onDidChangeSelection(selection => {
				if (selection.length > 0) {
					resolve(selection[0]);
					quickPick.hide();
				}
			});
			
			quickPick.onDidHide(() => {
				resolve(undefined);
				quickPick.dispose();
			});
			
			// Prevent typing by immediately clearing any input
			quickPick.onDidChangeValue(() => {
				quickPick.value = '';
			});
			
			quickPick.show();
		});

		if (!selected) {
			logCommand('setNormalizationRange', 'error', 'User cancelled');
			return;
		}

		if (selected.action === 'auto') {
			previewManager.setAutoNormalize(true);
			previewManager.updateAllPreviews();
			if (activePreview) {
				activePreview.updateStatusBar();
			}
			logCommand('setNormalizationRange', 'success', 'Auto-normalize enabled');
		} else if (selected.action === 'gamma') {
			previewManager.setGammaMode(true);
			previewManager.updateAllPreviews();
			if (activePreview) {
				activePreview.updateStatusBar();
			}
			logCommand('setNormalizationRange', 'success', 'Gamma/brightness mode enabled');
		} else if (selected.action === 'rgb24bit') {
			// Toggle RGB as 24-bit grayscale mode
			const newState = !previewManager.appStateManager.imageSettings.rgbAs24BitGrayscale;

			if (newState) {
				// Enabling 24-bit mode - ask for scale factor
				const scaleFactorInput = await vscode.window.showInputBox({
					prompt: 'Enter scale factor for 24-bit values (divides values for display in color picker)',
					value: previewManager.appStateManager.imageSettings.scale24BitFactor.toString(),
					placeHolder: '1000',
					validateInput: text => {
						const num = parseFloat(text);
						return isNaN(num) || num <= 0 ? 'Please enter a positive number.' : null;
					}
				});

				if (scaleFactorInput === undefined) {
					logCommand('setNormalizationRange', 'error', 'User cancelled 24-bit scale factor input');
					return; // User cancelled
				}

				const scaleFactor = parseFloat(scaleFactorInput);
				previewManager.appStateManager.setRgbAs24BitGrayscale(true, scaleFactor);
				logCommand('setNormalizationRange', 'success', `RGB 24-bit mode enabled with scale factor: ${scaleFactor}`);
			} else {
				// Disabling 24-bit mode
				previewManager.appStateManager.setRgbAs24BitGrayscale(false);
				logCommand('setNormalizationRange', 'success', 'RGB 24-bit mode disabled');
			}

			previewManager.updateAllPreviews();
			if (activePreview) {
				activePreview.updateStatusBar();
			}
		} else if (selected.action === 'normalizedFloat') {
			// Toggle normalized float mode
			const newState = !previewManager.appStateManager.imageSettings.normalizedFloatMode;
			previewManager.appStateManager.setNormalizedFloatMode(newState);
			previewManager.updateAllPreviews();
			if (activePreview) {
				activePreview.updateStatusBar();
			}
			logCommand('setNormalizationRange', 'success', `Normalized float mode ${newState ? 'enabled' : 'disabled'}`);
		} else {
			// Manual range setting
			previewManager.setAutoNormalize(false);
			previewManager.setGammaMode(false);

			const minValue = await vscode.window.showInputBox({
				prompt: '↓ Enter the minimum value for normalization',
				value: currentConfig.min.toString(),
				validateInput: text => {
					return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
				}
			});

			if (minValue === undefined) {
				logCommand('setNormalizationRange', 'error', 'User cancelled min value input');
				return;
			}

			const maxValue = await vscode.window.showInputBox({
				prompt: '↑ Enter the maximum value for normalization',
				value: currentConfig.max.toString(),
				validateInput: text => {
					const num = parseFloat(text);
					return isNaN(num) ? 'Please enter a valid number.' :
						   num <= parseFloat(minValue) ? 'Maximum must be greater than minimum.' : null;
				}
			});

			if (maxValue === undefined) {
				logCommand('setNormalizationRange', 'error', 'User cancelled max value input');
				return;
			}

			const min = parseFloat(minValue);
			const max = parseFloat(maxValue);

			previewManager.setTempNormalization(min, max);
			previewManager.updateAllPreviews();
			if (activePreview) {
				activePreview.updateStatusBar();
			}
			logCommand('setNormalizationRange', 'success', `Manual range: [${min}, ${max}]`);
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.setGamma', async () => {
		logCommand('setGamma', 'start');
		const currentPreview = previewManager.activePreview;
		const normConfig = previewManager.getNormalizationConfig();

		// Check if not in gamma mode (offer to switch to gamma mode)
		if (currentPreview && !normConfig.gammaMode) {
			const gammaOptions = [
				{
					label: '$(arrow-right) Switch to Gamma/Brightness Mode',
					description: 'Enable gamma correction for this image',
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
			];

			// Create a custom QuickPick to disable input
			const gammaQuickPick = vscode.window.createQuickPick<typeof gammaOptions[0]>();
			gammaQuickPick.items = gammaOptions;
			gammaQuickPick.placeholder = 'Not in gamma mode - Choose how to apply gamma correction';
			gammaQuickPick.title = 'Gamma Correction';
			gammaQuickPick.canSelectMany = false;
			gammaQuickPick.ignoreFocusOut = false;
			gammaQuickPick.value = '';
			
			const choice = await new Promise<typeof gammaOptions[0] | undefined>((resolve) => {
				gammaQuickPick.onDidChangeSelection(selection => {
					if (selection.length > 0) {
						resolve(selection[0]);
						gammaQuickPick.hide();
					}
				});
				
				gammaQuickPick.onDidHide(() => {
					resolve(undefined);
					gammaQuickPick.dispose();
				});
				
				// Prevent typing by immediately clearing any input
				gammaQuickPick.onDidChangeValue(() => {
					gammaQuickPick.value = '';
				});
				
				gammaQuickPick.show();
			});

			if (!choice || choice.action === 'cancel') {
				logCommand('setGamma', 'error', 'User cancelled');
				return;
			}

			if (choice.action === 'switch') {
				previewManager.setGammaMode(true);
				previewManager.updateAllPreviews();
				if (currentPreview) {
					currentPreview.updateStatusBar();
				}
				logCommand('setGamma', 'success', 'Switched to gamma/brightness mode');
				return;
			}
		}

		const currentConfig = previewManager.getGammaConfig();

		const gammaIn = await vscode.window.showInputBox({
			prompt: '← Enter the source gamma value. (Default: 2.2, Linear: 1.0)',
			value: currentConfig.in.toString(),
			validateInput: text => {
				return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
			}
		});

		if (gammaIn === undefined) {
			logCommand('setGamma', 'error', 'User cancelled gamma in input');
			return;
		}

		const gammaOut = await vscode.window.showInputBox({
			prompt: '→ Enter the target gamma value. (Default: 2.2, Linear: 1.0)',
			value: currentConfig.out.toString(),
			validateInput: text => {
				return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
			}
		});

		if (gammaOut === undefined) {
			logCommand('setGamma', 'error', 'User cancelled gamma out input');
			return;
		}

		const gammaInValue = parseFloat(gammaIn);
		const gammaOutValue = parseFloat(gammaOut);

		previewManager.setTempGamma(gammaInValue, gammaOutValue);
		previewManager.updateAllPreviews();
		if (currentPreview) {
			currentPreview.updateStatusBar();
		}
		logCommand('setGamma', 'success', `Gamma set: in=${gammaInValue}, out=${gammaOutValue}`);
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.setBrightness', async () => {
		logCommand('setBrightness', 'start');
		const currentConfig = previewManager.getBrightnessConfig();
		const currentPreview = previewManager.activePreview;

		const brightness = await vscode.window.showInputBox({
			prompt: 'Enter brightness offset in exposure stops (applied in linear space (2^Exposure) after removing gamma, then gamma is reapplied)',
			placeHolder: '0 = no change, +1 = 2× brighter, -1 = 2× darker in linear space',
			value: currentConfig.offset.toString(),
			validateInput: text => {
				return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
			}
		});

		if (brightness === undefined) {
			logCommand('setBrightness', 'error', 'User cancelled');
			return;
		}

		const brightnessValue = parseFloat(brightness);
		previewManager.setTempBrightness(brightnessValue);
		previewManager.updateAllPreviews();
		if (currentPreview) {
			currentPreview.updateStatusBar();
		}
		logCommand('setBrightness', 'success', `Brightness set: ${brightnessValue}`);
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.setComparisonBase', async () => {
		logCommand('setComparisonBase', 'start');
		const activePreview = previewManager.activePreview;
		if (!activePreview) {
			logCommand('setComparisonBase', 'error', 'No active preview');
			return;
		}

		const currentBase = previewManager.getComparisonBase();
		
		if (currentBase) {
			// Already has a comparison base, offer to clear it
			const comparisonOptions = [
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
			];

			// Create a custom QuickPick to disable input
			const comparisonQuickPick = vscode.window.createQuickPick<typeof comparisonOptions[0]>();
			comparisonQuickPick.items = comparisonOptions;
			comparisonQuickPick.placeholder = `Current comparison: ${currentBase.fsPath}`;
			comparisonQuickPick.title = 'Image Comparison';
			comparisonQuickPick.canSelectMany = false;
			comparisonQuickPick.ignoreFocusOut = false;
			comparisonQuickPick.value = '';
			
			const choice = await new Promise<typeof comparisonOptions[0] | undefined>((resolve) => {
				comparisonQuickPick.onDidChangeSelection(selection => {
					if (selection.length > 0) {
						resolve(selection[0]);
						comparisonQuickPick.hide();
					}
				});
				
				comparisonQuickPick.onDidHide(() => {
					resolve(undefined);
					comparisonQuickPick.dispose();
				});
				
				// Prevent typing by immediately clearing any input
				comparisonQuickPick.onDidChangeValue(() => {
					comparisonQuickPick.value = '';
				});
				
				comparisonQuickPick.show();
			});

			if (!choice) {
				logCommand('setComparisonBase', 'error', 'User cancelled');
				return;
			}

			if (choice.action === 'clear') {
				previewManager.setComparisonBase(undefined);
				vscode.window.showInformationMessage('Comparison cleared.');
				logCommand('setComparisonBase', 'success', 'Comparison cleared');
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
			logCommand('setComparisonBase', 'success', comparisonUri.fsPath);
		} else {
			logCommand('setComparisonBase', 'error', 'No file selected');
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.filterByMask', async () => {
		logCommand('filterByMask', 'start');
		const activePreview = previewManager.activePreview;
		if (!activePreview) {
			vscode.window.showErrorMessage('No active TIFF preview found.');
			logCommand('filterByMask', 'error', 'No active preview');
			return;
		}

		const imageUri = activePreview.resource.toString();
		const currentMasks = previewManager.settingsManager.getMaskFilterSettings(imageUri);
		
		// Build mask management options
		const maskOptions: Array<{
			label: string;
			description: string;
			detail: string;
			action: string;
			maskIndex?: number;
		}> = [];

		// Add existing masks
		currentMasks.forEach((mask, index) => {
			const fileName = mask.maskUri.split('/').pop() || mask.maskUri.split('\\').pop() || 'Unknown';
			const status = mask.enabled ? '$(check)' : '$(x)';
			const direction = mask.filterHigher ? 'Higher' : 'Lower';
			
			maskOptions.push({
				label: `${status} Mask ${index + 1}: ${fileName}`,
				description: `Threshold: ${mask.threshold}, Filter: ${direction}`,
				detail: mask.enabled ? 'Click to edit or disable' : 'Click to enable',
				action: 'edit',
				maskIndex: index
			});
		});

		// Add action options
		maskOptions.push({
			label: '$(plus) Add New Mask',
			description: 'Add a new mask filter',
			detail: 'Select mask file and configure parameters',
			action: 'add'
		});

		if (currentMasks.length > 0) {
			maskOptions.push({
				label: '$(trash) Remove All Masks',
				description: 'Remove all mask filters for this image',
				detail: 'This will delete all masks permanently',
				action: 'removeAll'
			});
		}

		// Create QuickPick
		const maskQuickPick = vscode.window.createQuickPick<typeof maskOptions[0]>();
		maskQuickPick.items = maskOptions;
		maskQuickPick.placeholder = 'Manage mask filters for this image';
		maskQuickPick.title = 'Mask Filter Management';
		maskQuickPick.canSelectMany = false;
		maskQuickPick.ignoreFocusOut = false;
		maskQuickPick.value = '';
		
		const choice = await new Promise<typeof maskOptions[0] | undefined>((resolve) => {
			maskQuickPick.onDidChangeSelection(selection => {
				if (selection.length > 0) {
					resolve(selection[0]);
					maskQuickPick.hide();
				}
			});
			
			maskQuickPick.onDidHide(() => {
				resolve(undefined);
				maskQuickPick.dispose();
			});
			
			maskQuickPick.onDidChangeValue(() => {
				maskQuickPick.value = '';
			});
			
			maskQuickPick.show();
		});

		if (!choice) {
			logCommand('filterByMask', 'error', 'User cancelled');
			return;
		}

		// Handle the selected action
		if (choice.action === 'add') {
			const result = await addNewMask(previewManager, imageUri);
			if (result) {
				logCommand('filterByMask', 'success', `Mask added: ${result}`);
			} else {
				logCommand('filterByMask', 'error', 'Failed to add mask');
			}
		} else if (choice.action === 'edit' && choice.maskIndex !== undefined) {
			const result = await editMask(previewManager, imageUri, choice.maskIndex);
			if (result) {
				logCommand('filterByMask', 'success', `Mask ${choice.maskIndex} ${result}`);
			} else {
				logCommand('filterByMask', 'error', 'Failed to edit mask');
			}
		} else if (choice.action === 'removeAll') {
			// Remove all masks
			while (currentMasks.length > 0) {
				previewManager.settingsManager.removeMaskFilter(imageUri, 0);
			}
			previewManager.updateAllPreviews();
			vscode.window.showInformationMessage('All mask filters removed.');
			logCommand('filterByMask', 'success', 'All masks removed');
		}
	}));

	// Helper function to add a new mask
	async function addNewMask(previewManager: ImagePreviewManager, imageUri: string): Promise<string | null> {
		// Step 1: Select mask image
		const maskUris = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: {
				'TIFF Images': ['tif', 'tiff']
			},
			title: 'Select Mask Image (TIFF)',
			openLabel: 'Select Mask'
		});

		if (!maskUris || maskUris.length === 0) {
			return null;
		}

		const maskUri = maskUris[0];

		// Step 2: Set threshold value
		const threshold = await vscode.window.showInputBox({
			prompt: 'Enter threshold value for filtering',
			value: '0.5',
			validateInput: text => {
				return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
			}
		});

		if (threshold === undefined) {
			return null;
		}

		const thresholdValue = parseFloat(threshold);

		// Step 3: Choose filter direction
		const directionOptions = [
			{
				label: '$(arrow-up) Filter Higher Values',
				description: 'Set pixels to NaN where mask values are higher than threshold',
				detail: 'Pixels with mask values > threshold will be filtered out',
				action: true
			},
			{
				label: '$(arrow-down) Filter Lower Values',
				description: 'Set pixels to NaN where mask values are lower than threshold',
				detail: 'Pixels with mask values < threshold will be filtered out',
				action: false
			}
		];

		const directionQuickPick = vscode.window.createQuickPick<typeof directionOptions[0]>();
		directionQuickPick.items = directionOptions;
		directionQuickPick.placeholder = 'Choose filtering direction';
		directionQuickPick.title = 'Filter Direction';
		directionQuickPick.canSelectMany = false;
		directionQuickPick.ignoreFocusOut = false;
		directionQuickPick.value = '';
		
		const directionChoice = await new Promise<typeof directionOptions[0] | undefined>((resolve) => {
			directionQuickPick.onDidChangeSelection(selection => {
				if (selection.length > 0) {
					resolve(selection[0]);
					directionQuickPick.hide();
				}
			});
			
			directionQuickPick.onDidHide(() => {
				resolve(undefined);
				directionQuickPick.dispose();
			});
			
			directionQuickPick.onDidChangeValue(() => {
				directionQuickPick.value = '';
			});
			
			directionQuickPick.show();
		});

		if (!directionChoice) {
			return null;
		}

		// Add the new mask
		const newMask = {
			maskUri: maskUri.toString(),
			threshold: thresholdValue,
			filterHigher: directionChoice.action,
			enabled: true
		};

		previewManager.settingsManager.addMaskFilter(imageUri, newMask);
		previewManager.updateAllPreviews();

		const directionText = directionChoice.action ? 'higher' : 'lower';
		const fileName = maskUri.fsPath.split('/').pop() || maskUri.fsPath.split('\\').pop() || 'Unknown';
		vscode.window.showInformationMessage(
			`New mask added: ${fileName}\nThreshold: ${thresholdValue}, Filter: ${directionText} values`
		);
		return `${fileName} (threshold: ${thresholdValue}, filter: ${directionText})`;
	}

	// Helper function to edit an existing mask
	async function editMask(previewManager: ImagePreviewManager, imageUri: string, maskIndex: number): Promise<string | null> {
		const masks = previewManager.settingsManager.getMaskFilterSettings(imageUri);
		const mask = masks[maskIndex];

		if (!mask) {
			vscode.window.showErrorMessage('Mask not found.');
			return null;
		}

		// Show edit options
		const editOptions = [
			{
				label: mask.enabled ? '$(x) Disable Mask' : '$(check) Enable Mask',
				description: mask.enabled ? 'Temporarily disable this mask' : 'Enable this mask',
				action: 'toggle'
			},
			{
				label: '$(edit) Edit Parameters',
				description: 'Change threshold and filter direction',
				action: 'edit'
			},
			{
				label: '$(trash) Delete Mask',
				description: 'Permanently remove this mask',
				action: 'delete'
			}
		];

		const editQuickPick = vscode.window.createQuickPick<typeof editOptions[0]>();
		editQuickPick.items = editOptions;
		editQuickPick.placeholder = 'Choose action for this mask';
		editQuickPick.title = 'Edit Mask';
		editQuickPick.canSelectMany = false;
		editQuickPick.ignoreFocusOut = false;
		editQuickPick.value = '';
		
		const editChoice = await new Promise<typeof editOptions[0] | undefined>((resolve) => {
			editQuickPick.onDidChangeSelection(selection => {
				if (selection.length > 0) {
					resolve(selection[0]);
					editQuickPick.hide();
				}
			});
			
			editQuickPick.onDidHide(() => {
				resolve(undefined);
				editQuickPick.dispose();
			});
			
			editQuickPick.onDidChangeValue(() => {
				editQuickPick.value = '';
			});
			
			editQuickPick.show();
		});

		if (!editChoice) {
			return null;
		}

		if (editChoice.action === 'toggle') {
			previewManager.settingsManager.setMaskFilterEnabled(imageUri, maskIndex, !mask.enabled);
			previewManager.updateAllPreviews();
			vscode.window.showInformationMessage(`Mask ${mask.enabled ? 'disabled' : 'enabled'}.`);
			return mask.enabled ? 'disabled' : 'enabled';
		} else if (editChoice.action === 'delete') {
			previewManager.settingsManager.removeMaskFilter(imageUri, maskIndex);
			previewManager.updateAllPreviews();
			vscode.window.showInformationMessage('Mask deleted.');
			return 'deleted';
		} else if (editChoice.action === 'edit') {
			// Edit threshold
			const threshold = await vscode.window.showInputBox({
				prompt: 'Enter new threshold value for filtering',
				value: mask.threshold.toString(),
				validateInput: text => {
					return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
				}
			});

			if (threshold === undefined) {
				return null;
			}

			const thresholdValue = parseFloat(threshold);

			// Edit direction
			const directionOptions = [
				{
					label: '$(arrow-up) Filter Higher Values',
					description: 'Set pixels to NaN where mask values are higher than threshold',
					detail: 'Pixels with mask values > threshold will be filtered out',
					action: true
				},
				{
					label: '$(arrow-down) Filter Lower Values',
					description: 'Set pixels to NaN where mask values are lower than threshold',
					detail: 'Pixels with mask values < threshold will be filtered out',
					action: false
				}
			];

			const directionQuickPick = vscode.window.createQuickPick<typeof directionOptions[0]>();
			directionQuickPick.items = directionOptions;
			directionQuickPick.placeholder = 'Choose filtering direction';
			directionQuickPick.title = 'Filter Direction';
			directionQuickPick.canSelectMany = false;
			directionQuickPick.ignoreFocusOut = false;
			directionQuickPick.value = '';
			
			// Pre-select current direction
			directionQuickPick.activeItems = [directionOptions[mask.filterHigher ? 0 : 1]];
			
			const directionChoice = await new Promise<typeof directionOptions[0] | undefined>((resolve) => {
				directionQuickPick.onDidChangeSelection(selection => {
					if (selection.length > 0) {
						resolve(selection[0]);
						directionQuickPick.hide();
					}
				});
				
				directionQuickPick.onDidHide(() => {
					resolve(undefined);
					directionQuickPick.dispose();
				});
				
				directionQuickPick.onDidChangeValue(() => {
					directionQuickPick.value = '';
				});
				
				directionQuickPick.show();
			});

			if (!directionChoice) {
				return null;
			}

			// Update the mask
			previewManager.settingsManager.updateMaskFilter(imageUri, maskIndex, {
				threshold: thresholdValue,
				filterHigher: directionChoice.action
			});
			previewManager.updateAllPreviews();

			const directionText = directionChoice.action ? 'higher' : 'lower';
			vscode.window.showInformationMessage(
				`Mask updated: Threshold: ${thresholdValue}, Filter: ${directionText} values`
			);
			return `edited (threshold: ${thresholdValue}, filter: ${directionText})`;
		}
		return null;
	}

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.toggleNanColor', () => {
		logCommand('toggleNanColor', 'start');
		try {
			const currentColor = previewManager.settingsManager.getNanColor();
			previewManager.settingsManager.toggleNanColor();
			previewManager.updateAllPreviews();

			const newColor = previewManager.settingsManager.getNanColor();
			vscode.window.showInformationMessage(`NaN color changed to: ${newColor}`);
			logCommand('toggleNanColor', 'success', `Changed to: ${newColor}`);
		} catch (error) {
			logCommand('toggleNanColor', 'error', String(error));
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.openWith', async (resource?: vscode.Uri) => {
		logCommand('openWith', 'start');
		if (!resource) {
			// Try to get the resource from the active editor
			const activeEditor = vscode.window.activeTextEditor;
			if (activeEditor) {
				resource = activeEditor.document.uri;
			}
		}

		if (!resource) {
			vscode.window.showErrorMessage('No file selected to open with TIFF Visualizer.');
			logCommand('openWith', 'error', 'No file selected');
			return;
		}

		// Open the file with the TIFF Visualizer custom editor
		try {
			await vscode.commands.executeCommand('vscode.openWith', resource, 'tiffVisualizer.previewEditor');
			logCommand('openWith', 'success', resource.fsPath);
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to open with TIFF Visualizer: ${error}`);
			logCommand('openWith', 'error', String(error));
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.openNextToCurrent', async (resource?: vscode.Uri) => {
		logCommand('openNextToCurrent', 'start');
		if (!resource) {
			vscode.window.showErrorMessage('No file selected to open next to current image.');
			logCommand('openNextToCurrent', 'error', 'No file selected');
			return;
		}

		const activePreview = previewManager.activePreview;
		if (!activePreview) {
			vscode.window.showErrorMessage('No active TIFF Visualizer preview found. Please open a TIFF image first.');
			logCommand('openNextToCurrent', 'error', 'No active preview');
			return;
		}

		// Add the image to the current preview's collection
		try {
			await activePreview.addToImageCollection(resource);
			vscode.window.showInformationMessage(`Added ${resource.fsPath.split('/').pop()} to image collection. Press 't' to toggle between images.`);
			logCommand('openNextToCurrent', 'success', resource.fsPath);
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to add image to collection: ${error}`);
			logCommand('openNextToCurrent', 'error', String(error));
		}
	}));

	// Comparison Panel Commands
	disposables.push(vscode.commands.registerCommand('tiffVisualizer.selectForCompare', async () => {
		logCommand('selectForCompare', 'start');
		const activePreview = previewManager.activePreview;
		if (!activePreview) {
			vscode.window.showErrorMessage('No active TIFF Visualizer preview found.');
			logCommand('selectForCompare', 'error', 'No active preview');
			return;
		}

		try {
			// Add current image to the comparison panel
			const panel = ComparisonPanel.create(context.extensionUri);
			panel.addImage(activePreview.resource);

			vscode.window.showInformationMessage(`Added ${activePreview.resource.fsPath.split('/').pop()} to comparison panel.`);

			// Set context to show that we have a comparison image
			vscode.commands.executeCommand('setContext', 'tiffVisualizer.hasComparisonImage', true);
			logCommand('selectForCompare', 'success', activePreview.resource.fsPath);
		} catch (error) {
			logCommand('selectForCompare', 'error', String(error));
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.compareWithSelected', async () => {
		logCommand('compareWithSelected', 'start');
		const activePreview = previewManager.activePreview;
		if (!activePreview) {
			vscode.window.showErrorMessage('No active TIFF Visualizer preview found.');
			logCommand('compareWithSelected', 'error', 'No active preview');
			return;
		}

		try {
			// Get or create comparison panel and add current image
			const panel = ComparisonPanel.create(context.extensionUri);
			panel.addImage(activePreview.resource);

			vscode.window.showInformationMessage(`Added ${activePreview.resource.fsPath.split('/').pop()} to comparison panel.`);
			logCommand('compareWithSelected', 'success', activePreview.resource.fsPath);
		} catch (error) {
			logCommand('compareWithSelected', 'error', String(error));
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.resetAllSettings', async () => {
		logCommand('resetAllSettings', 'start');
		const choice = await vscode.window.showWarningMessage(
			'Reset all TIFF Visualizer settings to defaults? This will clear all cached normalization, gamma, and brightness settings for all image formats.',
			{ modal: true },
			'Reset All',
			'Cancel'
		);

		if (choice === 'Reset All') {
			try {
				previewManager.appStateManager.clearAllCaches();
				previewManager.appStateManager.resetToDefaults();

				// Refresh all open previews to apply default settings
				previewManager.updateAllPreviews();

				vscode.window.showInformationMessage('All TIFF Visualizer settings have been reset to defaults.');
				logCommand('resetAllSettings', 'success');
			} catch (error) {
				logCommand('resetAllSettings', 'error', String(error));
			}
		} else {
			logCommand('resetAllSettings', 'error', 'User cancelled');
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.toggleHistogram', () => {
		logCommand('toggleHistogram', 'start');
		try {
			previewManager.activePreview?.toggleHistogram();
			logCommand('toggleHistogram', 'success');
		} catch (error) {
			logCommand('toggleHistogram', 'error', String(error));
		}
	}));

	disposables.push(vscode.commands.registerCommand('tiffVisualizer.convertColormapToFloat', async () => {
		logCommand('convertColormapToFloat', 'start');
		const activePreview = previewManager.activePreview;
		if (!activePreview) {
			vscode.window.showErrorMessage('No active image preview found.');
			logCommand('convertColormapToFloat', 'error', 'No active preview');
			return;
		}

		// Step 1: Select colormap
		const colormapOptions = [
			{ label: 'Viridis', description: 'Purple-blue-green-yellow perceptually uniform colormap', value: 'viridis' },
			{ label: 'Plasma', description: 'Purple-pink-orange perceptually uniform colormap', value: 'plasma' },
			{ label: 'Inferno', description: 'Black-purple-orange-yellow perceptually uniform colormap', value: 'inferno' },
			{ label: 'Magma', description: 'Black-purple-pink-yellow perceptually uniform colormap', value: 'magma' },
			{ label: 'Jet', description: 'Rainbow colormap (blue-cyan-green-yellow-red)', value: 'jet' },
			{ label: 'Hot', description: 'Black-red-orange-yellow-white colormap', value: 'hot' },
			{ label: 'Cool', description: 'Cyan-magenta colormap', value: 'cool' },
			{ label: 'Turbo', description: 'Improved rainbow colormap', value: 'turbo' },
			{ label: 'Gray', description: 'Grayscale colormap', value: 'gray' }
		];

		const colormapPick = vscode.window.createQuickPick();
		colormapPick.items = colormapOptions;
		colormapPick.placeholder = 'Select the colormap used in your image';
		colormapPick.title = 'Colormap Selection';
		colormapPick.canSelectMany = false;
		colormapPick.ignoreFocusOut = false;
		colormapPick.value = '';

		const selectedColormap = await new Promise<typeof colormapOptions[0] | undefined>((resolve) => {
			colormapPick.onDidChangeSelection(selection => {
				if (selection.length > 0) {
					resolve(selection[0] as typeof colormapOptions[0]);
					colormapPick.hide();
				}
			});

			colormapPick.onDidHide(() => {
				resolve(undefined);
				colormapPick.dispose();
			});

			colormapPick.onDidChangeValue(() => {
				colormapPick.value = '';
			});

			colormapPick.show();
		});

		if (!selectedColormap) {
			logCommand('convertColormapToFloat', 'error', 'User cancelled colormap selection');
			return;
		}

		// Step 2: Select mapping mode
		const mappingOptions = [
			{
				label: 'Linear - Normal',
				description: 'Linear mapping from dark to bright',
				detail: 'Colormap start → minimum value, Colormap end → maximum value',
				value: { inverted: false, logarithmic: false }
			},
			{
				label: 'Linear - Inverted',
				description: 'Linear mapping from bright to dark',
				detail: 'Colormap start → maximum value, Colormap end → minimum value',
				value: { inverted: true, logarithmic: false }
			},
			{
				label: 'Logarithmic - Normal',
				description: 'Logarithmic mapping from dark to bright',
				detail: 'Better for data with large dynamic range (e.g., 0.001 to 1000)',
				value: { inverted: false, logarithmic: true }
			},
			{
				label: 'Logarithmic - Inverted',
				description: 'Logarithmic mapping from bright to dark',
				detail: 'Inverted logarithmic scale for high dynamic range data',
				value: { inverted: true, logarithmic: true }
			}
		];

		const mappingPick = vscode.window.createQuickPick();
		mappingPick.items = mappingOptions;
		mappingPick.placeholder = 'Select mapping mode';
		mappingPick.title = 'Colormap Mapping Mode';
		mappingPick.canSelectMany = false;
		mappingPick.ignoreFocusOut = false;
		mappingPick.value = '';

		const selectedMapping = await new Promise<typeof mappingOptions[0] | undefined>((resolve) => {
			mappingPick.onDidChangeSelection(selection => {
				if (selection.length > 0) {
					resolve(selection[0] as typeof mappingOptions[0]);
					mappingPick.hide();
				}
			});

			mappingPick.onDidHide(() => {
				resolve(undefined);
				mappingPick.dispose();
			});

			mappingPick.onDidChangeValue(() => {
				mappingPick.value = '';
			});

			mappingPick.show();
		});

		if (!selectedMapping) {
			logCommand('convertColormapToFloat', 'error', 'User cancelled mapping selection');
			return;
		}

		// Step 3: Get minimum value
		const minPrompt = selectedMapping.value.inverted
			? 'Enter the minimum value (corresponds to the end of the colormap - brightest)'
			: 'Enter the minimum value (corresponds to the start of the colormap - darkest)';

		const minValue = await vscode.window.showInputBox({
			prompt: minPrompt,
			value: '0',
			placeHolder: '0',
			validateInput: text => {
				return isNaN(parseFloat(text)) ? 'Please enter a valid number.' : null;
			}
		});

		if (minValue === undefined) {
			logCommand('convertColormapToFloat', 'error', 'User cancelled min value input');
			return;
		}

		// Step 4: Get maximum value
		const maxPrompt = selectedMapping.value.inverted
			? 'Enter the maximum value (corresponds to the start of the colormap - darkest)'
			: 'Enter the maximum value (corresponds to the end of the colormap - brightest)';

		const maxValue = await vscode.window.showInputBox({
			prompt: maxPrompt,
			value: '1',
			placeHolder: '1',
			validateInput: text => {
				const num = parseFloat(text);
				return isNaN(num) ? 'Please enter a valid number.' :
					   num <= parseFloat(minValue) ? 'Maximum must be greater than minimum.' : null;
			}
		});

		if (maxValue === undefined) {
			logCommand('convertColormapToFloat', 'error', 'User cancelled max value input');
			return;
		}

		const min = parseFloat(minValue);
		const max = parseFloat(maxValue);

		// Send conversion request to webview
		// Cast to ImagePreview to access getWebview method
		const preview = activePreview as any;
		if (preview.getWebview) {
			preview.getWebview().postMessage({
				type: 'convertColormapToFloat',
				colormap: selectedColormap.value,
				min: min,
				max: max,
				inverted: selectedMapping.value.inverted,
				logarithmic: selectedMapping.value.logarithmic
			});

			const mappingDesc = selectedMapping.value.logarithmic
				? (selectedMapping.value.inverted ? 'logarithmic inverted' : 'logarithmic')
				: (selectedMapping.value.inverted ? 'inverted' : 'normal');

			vscode.window.showInformationMessage(
				`Converting ${selectedColormap.label} colormap to float values [${min}, ${max}] (${mappingDesc})...`
			);
			logCommand('convertColormapToFloat', 'success', `${selectedColormap.value} [${min}, ${max}] ${mappingDesc}`);
		} else {
			logCommand('convertColormapToFloat', 'error', 'No webview available');
		}
	}));
	disposables.push(vscode.commands.registerCommand('tiffVisualizer.revertToOriginal', async () => {
		logCommand('revertToOriginal', 'start');
		const activePreview = previewManager.activePreview;
		if (!activePreview) {
			vscode.window.showErrorMessage('No active image preview found.');
			logCommand('revertToOriginal', 'error', 'No active preview');
			return;
		}

		// Reset the RGB 24-bit mode
		previewManager.appStateManager.setRgbAs24BitGrayscale(false);

		// Send revert message to webview to reload original image
		const preview = activePreview as any;
		if (preview.getWebview) {
			preview.getWebview().postMessage({
				type: 'revertToOriginal'
			});
		}

		previewManager.updateAllPreviews();
		if (activePreview) {
			activePreview.updateStatusBar();
		}

		logCommand('revertToOriginal', 'success', 'Reverted to original image');
	}));

	return vscode.Disposable.from(...disposables);
} 
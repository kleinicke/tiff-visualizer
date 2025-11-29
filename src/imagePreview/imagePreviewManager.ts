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
import { ImageSettingsManager } from './imageSettings';
import { AppStateManager } from './appStateManager';
import { ImagePreview } from './imagePreview';
import type { IImagePreview, IImagePreviewManager } from './types';
import { getOutputChannel } from '../extension';

export class ImagePreviewManager implements vscode.CustomReadonlyEditorProvider, IImagePreviewManager {

	public static readonly viewType = 'tiffVisualizer.previewEditor';

	// Export the viewType to ensure it's preserved in the build
	public static getViewType() {
		return this.viewType;
	}

	private readonly _previews = new Set<IImagePreview>();
	private _activePreview: IImagePreview | undefined;
	private readonly _settingsManager = new ImageSettingsManager();
	private readonly _appStateManager = new AppStateManager();

	constructor(
		private readonly extensionRoot: vscode.Uri,
		private readonly sizeStatusBarEntry: SizeStatusBarEntry,
		private readonly binarySizeStatusBarEntry: BinarySizeStatusBarEntry,
		private readonly zoomStatusBarEntry: ZoomStatusBarEntry,
		private readonly normalizationStatusBarEntry: NormalizationStatusBarEntry,
		private readonly gammaStatusBarEntry: GammaStatusBarEntry,
		private readonly brightnessStatusBarEntry: BrightnessStatusBarEntry,
		private readonly maskFilterStatusBarEntry: MaskFilterStatusBarEntry,
		private readonly histogramStatusBarEntry: HistogramStatusBarEntry,
		private readonly colorPickerModeStatusBarEntry: ColorPickerModeStatusBarEntry,
	) {
		// Listen for active editor changes to hide status bar items when switching away
		// This handles text editors
		vscode.window.onDidChangeActiveTextEditor(() => {
			this.hideStatusBarIfNotActive();
		});

		// Listen for active tab changes to handle all editor types (including image viewers)
		vscode.window.tabGroups.onDidChangeTabs(() => {
			this.hideStatusBarIfNotActive();
		});

		// Also listen for tab group changes
		vscode.window.tabGroups.onDidChangeTabGroups(() => {
			this.hideStatusBarIfNotActive();
		});
	}

	/**
	 * Hide status bar entries if no active TIFF preview is showing
	 */
	private hideStatusBarIfNotActive(): void {
		// If no active preview or the active editor is not our custom editor, hide all items
		if (!this._activePreview || !this._activePreview.isPreviewActive()) {
			this.sizeStatusBarEntry.forceHide();
			this.binarySizeStatusBarEntry.forceHide();
			this.zoomStatusBarEntry.forceHide();
			this.normalizationStatusBarEntry.forceHide();
			this.gammaStatusBarEntry.forceHide();
			this.brightnessStatusBarEntry.forceHide();
			this.maskFilterStatusBarEntry.hide();
			this.histogramStatusBarEntry.hide();
			this.colorPickerModeStatusBarEntry.hide();
		}
	}

	public get settingsManager(): ImageSettingsManager {
		return this._settingsManager;
	}

	public get appStateManager(): AppStateManager {
		return this._appStateManager;
	}

	public getNormalizationConfig() {
		return this._appStateManager.imageSettings.normalization;
	}

	public getGammaConfig() {
		return this._appStateManager.imageSettings.gamma;
	}

	public getBrightnessConfig() {
		return this._appStateManager.imageSettings.brightness;
	}

	/**
	 * Ensures the active preview's format is set as current before modifying settings.
	 * This prevents commands from accidentally modifying the wrong format's settings.
	 */
	private ensureActivePreviewFormat(): void {
		if (this._activePreview && 'getCurrentFormat' in this._activePreview) {
			const format = (this._activePreview as any).getCurrentFormat();
			if (format && format !== this._appStateManager.currentFormat) {
				this._appStateManager.setImageFormat(format);
			}
		}
	}

	public setTempNormalization(min: number, max: number) {
		this.ensureActivePreviewFormat();
		const format = this._appStateManager.currentFormat;
		getOutputChannel().appendLine(`[${format}] Normalization: [${min.toFixed(2)}, ${max.toFixed(2)}]`);
		this._appStateManager.updateNormalization(min, max);
	}

	public setAutoNormalize(enabled: boolean) {
		this.ensureActivePreviewFormat();
		const format = this._appStateManager.currentFormat;
		getOutputChannel().appendLine(`[${format}] Auto-normalize: ${enabled ? 'ON' : 'OFF'}`);
		this._appStateManager.setAutoNormalize(enabled);
	}

	public setGammaMode(enabled: boolean) {
		this.ensureActivePreviewFormat();
		const format = this._appStateManager.currentFormat;
		getOutputChannel().appendLine(`[${format}] Gamma mode: ${enabled ? 'ON' : 'OFF'}`);
		this._appStateManager.setGammaMode(enabled);
	}

	public setTempGamma(gammaIn: number, gammaOut: number) {
		this.ensureActivePreviewFormat();
		const format = this._appStateManager.currentFormat;
		getOutputChannel().appendLine(`[${format}] Gamma: in=${gammaIn.toFixed(2)}, out=${gammaOut.toFixed(2)}`);
		this._appStateManager.updateGamma(gammaIn, gammaOut);
	}

	public setTempBrightness(offset: number) {
		this.ensureActivePreviewFormat();
		const format = this._appStateManager.currentFormat;
		getOutputChannel().appendLine(`[${format}] Brightness: ${offset >= 0 ? '+' : ''}${offset}`);
		this._appStateManager.updateBrightness(offset);
	}

	public setComparisonBase(uri: vscode.Uri | undefined) {
		this._settingsManager.setComparisonBase(uri);
	}

	public getComparisonBase(): vscode.Uri | undefined {
		return this._settingsManager.comparisonBaseUri;
	}

	public updateAllPreviews() {
		// Only update previews that match the current format
		const currentFormat = this._appStateManager.currentFormat;

		for (const preview of this._previews) {
			// Check if this preview matches the current format
			if ('getCurrentFormat' in preview) {
				const previewFormat = (preview as any).getCurrentFormat();
				if (previewFormat === currentFormat) {
					preview.updatePreview();
				}
			} else {
				// Fallback: update preview if format can't be determined
				preview.updatePreview();
			}
		}
	}

	public async openCustomDocument(uri: vscode.Uri) {
		return { uri, dispose: () => { } };
	}

	public async resolveCustomEditor(
		document: vscode.CustomDocument,
		webviewEditor: vscode.WebviewPanel,
	): Promise<void> {
		// Capture timestamp immediately when file is opened
		const openTimestamp = Date.now();

		// Log when opening a new file
		const fileName = document.uri.path.split('/').pop() || document.uri.path;
		getOutputChannel().appendLine(`📂 Opened 1: ${fileName}`);

		this.createPreview(ImagePreview, this.extensionRoot, document, webviewEditor, openTimestamp);
	}

	public createPreview(
		PreviewClass: any,
		extensionRoot: vscode.Uri,
		document: vscode.CustomDocument,
		webviewEditor: vscode.WebviewPanel,
		openTimestamp?: number
	): void {
		const preview = new PreviewClass(extensionRoot, document.uri, webviewEditor, this.sizeStatusBarEntry, this.binarySizeStatusBarEntry, this.zoomStatusBarEntry, this.normalizationStatusBarEntry, this.gammaStatusBarEntry, this.brightnessStatusBarEntry, this.maskFilterStatusBarEntry, this.histogramStatusBarEntry, this.colorPickerModeStatusBarEntry, this, openTimestamp);
		this._previews.add(preview);
		this.setActivePreview(preview);

		webviewEditor.onDidDispose(() => { this._previews.delete(preview); });

		webviewEditor.onDidChangeViewState(() => {
			if (webviewEditor.active) {
				this.setActivePreview(preview);
			} else if (this._activePreview === preview && !webviewEditor.active) {
				this.setActivePreview(undefined);
			}
		});
	}

	public get activePreview() {
		return this._activePreview;
	}

	public getPreviewFor(resource: vscode.Uri, viewColumn?: vscode.ViewColumn): IImagePreview | undefined {
		for (const preview of this._previews) {
			if (preview.resource.toString() === resource.toString()) {
				if (!viewColumn || preview.viewColumn === viewColumn) {
					return preview;
				}
			}
		}
		return undefined;
	}

	private setActivePreview(value: IImagePreview | undefined): void {
		this._activePreview = value;

		// When switching to a new preview, load its format settings into AppStateManager
		if (value && 'getCurrentFormat' in value) {
			const format = (value as any).getCurrentFormat();
			if (format) {
				// Update the open timestamp to now when the preview becomes active
				if (value && 'setOpenTimestamp' in value) {
					(value as any).setOpenTimestamp(Date.now());
				}

				// Log when opening a new file (or switching back to it)
				const resource = (value as any).resource;
				if (resource) {
					const fileName = resource.path.split('/').pop() || resource.path;
					getOutputChannel().appendLine(`📂 Reopened: ${fileName}`);
				}

				// Switch AppStateManager to this preview's format
				// This will load the cached settings for this format
				this._appStateManager.setImageFormat(format);

				// Update the status bar to reflect the new format's settings
				if ('updateStatusBar' in value) {
					(value as any).updateStatusBar();
				}
			}
		}

		// Update context for menu visibility
		vscode.commands.executeCommand('setContext', 'tiffVisualizer.hasActivePreview', !!value);
	}
} 
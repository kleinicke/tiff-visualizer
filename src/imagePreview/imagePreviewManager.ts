import * as vscode from 'vscode';
import { BinarySizeStatusBarEntry } from '../binarySizeStatusBarEntry';
import { SizeStatusBarEntry } from './sizeStatusBarEntry';
import { ZoomStatusBarEntry } from './zoomStatusBarEntry';
import { NormalizationStatusBarEntry } from './normalizationStatusBarEntry';
import { GammaStatusBarEntry } from './gammaStatusBarEntry';
import { BrightnessStatusBarEntry } from './brightnessStatusBarEntry';
import { MaskFilterStatusBarEntry } from './maskFilterStatusBarEntry';
import { HistogramStatusBarEntry } from './histogramStatusBarEntry';
import { ImageSettingsManager } from './imageSettings';
import { AppStateManager } from './appStateManager';
import { ImagePreview } from './imagePreview';
import type { IImagePreview, IImagePreviewManager } from './types';

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
			console.log(`[ImagePreviewManager] ensureActivePreviewFormat: Active preview format = ${format}, Current global format = ${this._appStateManager.currentFormat}`);
			if (format && format !== this._appStateManager.currentFormat) {
				console.log(`[ImagePreviewManager] Switching global format from ${this._appStateManager.currentFormat} to ${format}`);
				this._appStateManager.setImageFormat(format);
			} else {
				console.log(`[ImagePreviewManager] Format already matches, no switch needed`);
			}
		} else {
			console.log(`[ImagePreviewManager] No active preview or format not available`);
		}
	}

	public setTempNormalization(min: number, max: number) {
		this.ensureActivePreviewFormat();
		this._appStateManager.updateNormalization(min, max);
	}

	public setAutoNormalize(enabled: boolean) {
		this.ensureActivePreviewFormat();
		this._appStateManager.setAutoNormalize(enabled);
	}

	public setGammaMode(enabled: boolean) {
		this.ensureActivePreviewFormat();
		this._appStateManager.setGammaMode(enabled);
	}

	public setTempGamma(gammaIn: number, gammaOut: number) {
		this.ensureActivePreviewFormat();
		this._appStateManager.updateGamma(gammaIn, gammaOut);
	}

	public setTempBrightness(offset: number) {
		this.ensureActivePreviewFormat();
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
		console.log(`[ImagePreviewManager] updateAllPreviews called for format: ${currentFormat}`);

		for (const preview of this._previews) {
			// Check if this preview matches the current format
			if ('getCurrentFormat' in preview) {
				const previewFormat = (preview as any).getCurrentFormat();
				if (previewFormat === currentFormat) {
					console.log(`[ImagePreviewManager] Updating preview with format ${previewFormat} (matches current format)`);
					preview.updatePreview();
				} else {
					console.log(`[ImagePreviewManager] Skipping preview with format ${previewFormat} (current format is ${currentFormat})`);
				}
			} else {
				// Fallback: update preview if format can't be determined
				console.log(`[ImagePreviewManager] Updating preview (format unknown)`);
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
		this.createPreview(ImagePreview, this.extensionRoot, document, webviewEditor);
	}

	public createPreview(
		PreviewClass: any,
		extensionRoot: vscode.Uri,
		document: vscode.CustomDocument,
		webviewEditor: vscode.WebviewPanel
	): void {
		const preview = new PreviewClass(extensionRoot, document.uri, webviewEditor, this.sizeStatusBarEntry, this.binarySizeStatusBarEntry, this.zoomStatusBarEntry, this.normalizationStatusBarEntry, this.gammaStatusBarEntry, this.brightnessStatusBarEntry, this.maskFilterStatusBarEntry, this.histogramStatusBarEntry, this);
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
				console.log(`[ImagePreviewManager] Active preview changed to format: ${format}`);
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
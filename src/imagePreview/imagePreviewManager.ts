import * as vscode from 'vscode';
import { BinarySizeStatusBarEntry } from '../binarySizeStatusBarEntry';
import { SizeStatusBarEntry } from './sizeStatusBarEntry';
import { ZoomStatusBarEntry } from './zoomStatusBarEntry';
import { NormalizationStatusBarEntry } from './normalizationStatusBarEntry';
import { GammaStatusBarEntry } from './gammaStatusBarEntry';
import { BrightnessStatusBarEntry } from './brightnessStatusBarEntry';
import { MaskFilterStatusBarEntry } from './maskFilterStatusBarEntry';
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

	public setTempNormalization(min: number, max: number) {
		this._appStateManager.updateNormalization(min, max);
	}

	public setAutoNormalize(enabled: boolean) {
		this._appStateManager.setAutoNormalize(enabled);
	}

	public setGammaMode(enabled: boolean) {
		this._appStateManager.setGammaMode(enabled);
	}

	public setTempGamma(gammaIn: number, gammaOut: number) {
		this._appStateManager.updateGamma(gammaIn, gammaOut);
	}

	public setTempBrightness(offset: number) {
		this._appStateManager.updateBrightness(offset);
	}

	public setComparisonBase(uri: vscode.Uri | undefined) {
		this._settingsManager.setComparisonBase(uri);
	}

	public getComparisonBase(): vscode.Uri | undefined {
		return this._settingsManager.comparisonBaseUri;
	}

	public updateAllPreviews() {
		for (const preview of this._previews) {
			preview.updatePreview();
		}
	}

	public async openCustomDocument(uri: vscode.Uri) {
		return { uri, dispose: () => { } };
	}

	public async resolveCustomEditor(
		document: vscode.CustomDocument,
		webviewEditor: vscode.WebviewPanel,
	): Promise<void> {
		const outputChannel = vscode.window.createOutputChannel('TIFF Visualizer Debug');
		outputChannel.appendLine(`TIFF Visualizer: resolveCustomEditor called for ${document.uri.toString()}`);
		console.log('TIFF Visualizer: resolveCustomEditor called for', document.uri.toString());
		
		this.createPreview(ImagePreview, this.extensionRoot, document, webviewEditor);
		
		outputChannel.appendLine('TIFF Visualizer: ImagePreview created successfully');
		console.log('TIFF Visualizer: ImagePreview created successfully');
	}

	public createPreview(
		PreviewClass: any,
		extensionRoot: vscode.Uri,
		document: vscode.CustomDocument,
		webviewEditor: vscode.WebviewPanel
	): void {
		const preview = new PreviewClass(extensionRoot, document.uri, webviewEditor, this.sizeStatusBarEntry, this.binarySizeStatusBarEntry, this.zoomStatusBarEntry, this.normalizationStatusBarEntry, this.gammaStatusBarEntry, this.brightnessStatusBarEntry, this.maskFilterStatusBarEntry, this);
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
		// Update context for menu visibility
		vscode.commands.executeCommand('setContext', 'tiffVisualizer.hasActivePreview', !!value);
	}
} 
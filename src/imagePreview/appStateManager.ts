import * as vscode from 'vscode';

// Core state interfaces
export interface NormalizationSettings {
	min: number;
	max: number;
	autoNormalize: boolean;
	gammaMode: boolean;
}

export interface GammaSettings {
	in: number;
	out: number;
}

export interface BrightnessSettings {
	offset: number;
}

export interface ImageSettings {
	normalization: NormalizationSettings;
	gamma: GammaSettings;
	brightness: BrightnessSettings;
}

export interface ImageStats {
	min: number;
	max: number;
}

export interface UIState {
	zoom: any;
	imageSize: string | undefined;
	isFloat: boolean;
	formatInfo: any;
	pixelPosition: any;
}

export interface StatusBarState {
	activePreview: any;
	visibleEntries: Set<string>;
}

// Events emitted by the state manager
export interface AppStateEvents {
	'settings:changed': ImageSettings;
	'ui:changed': UIState;
	'stats:changed': ImageStats;
	'preview:activated': any;
	'preview:deactivated': any;
}

/**
 * Centralized state manager for the TIFF Visualizer extension.
 * Handles all application state including image settings, UI state, and coordination.
 */
export class AppStateManager {
	private readonly _onDidChangeSettings = new vscode.EventEmitter<ImageSettings>();
	private readonly _onDidChangeUI = new vscode.EventEmitter<UIState>();
	private readonly _onDidChangeStats = new vscode.EventEmitter<ImageStats>();
	private readonly _onDidActivatePreview = new vscode.EventEmitter<any>();
	private readonly _onDidDeactivatePreview = new vscode.EventEmitter<any>();

	// Public event emitters
	public readonly onDidChangeSettings = this._onDidChangeSettings.event;
	public readonly onDidChangeUI = this._onDidChangeUI.event;
	public readonly onDidChangeStats = this._onDidChangeStats.event;
	public readonly onDidActivatePreview = this._onDidActivatePreview.event;
	public readonly onDidDeactivatePreview = this._onDidDeactivatePreview.event;

	// State storage
	private _imageSettings: ImageSettings = {
		normalization: {
			min: 0.0,
			max: 1.0,
			autoNormalize: false,
			gammaMode: false
		},
		gamma: {
			in: 2.2,
			out: 2.2
		},
		brightness: {
			offset: 0
		}
	};

	private _uiState: UIState = {
		zoom: 'fit',
		imageSize: undefined,
		isFloat: false,
		formatInfo: undefined,
		pixelPosition: undefined
	};

	private _imageStats: ImageStats | undefined;
	private _comparisonBaseUri: vscode.Uri | undefined;
	private _statusBarState: StatusBarState = {
		activePreview: undefined,
		visibleEntries: new Set()
	};

	// Getters for readonly access
	public get imageSettings(): Readonly<ImageSettings> {
		return this._imageSettings;
	}

	public get uiState(): Readonly<UIState> {
		return this._uiState;
	}

	public get imageStats(): Readonly<ImageStats> | undefined {
		return this._imageStats;
	}

	public get comparisonBaseUri(): vscode.Uri | undefined {
		return this._comparisonBaseUri;
	}

	public get activePreview(): any {
		return this._statusBarState.activePreview;
	}

	// Image Settings Management
	public updateNormalization(min: number, max: number): void {
		if (this._imageSettings.normalization.min !== min || this._imageSettings.normalization.max !== max) {
			this._imageSettings.normalization.min = min;
			this._imageSettings.normalization.max = max;
			this._emitSettingsChanged();
		}
	}

	public setAutoNormalize(enabled: boolean): void {
		if (this._imageSettings.normalization.autoNormalize !== enabled) {
			this._imageSettings.normalization.autoNormalize = enabled;
			if (enabled) {
				this._imageSettings.normalization.gammaMode = false; // Disable gamma mode when auto-normalize is enabled
			}
			this._emitSettingsChanged();
		}
	}

	public setGammaMode(enabled: boolean): void {
		if (this._imageSettings.normalization.gammaMode !== enabled) {
			this._imageSettings.normalization.gammaMode = enabled;
			if (enabled) {
				// When enabling gamma mode, preserve current normalization range
				if (this._imageSettings.normalization.autoNormalize) {
					// Coming from auto-normalize: disable auto mode but keep existing manual values
					this._imageSettings.normalization.autoNormalize = false;
				}
				// If coming from manual mode, keep the current manual values
			}
			this._emitSettingsChanged();
		}
	}

	public updateGamma(gammaIn: number, gammaOut: number): void {
		if (this._imageSettings.gamma.in !== gammaIn || this._imageSettings.gamma.out !== gammaOut) {
			this._imageSettings.gamma.in = gammaIn;
			this._imageSettings.gamma.out = gammaOut;
			this._emitSettingsChanged();
		}
	}

	public updateBrightness(offset: number): void {
		if (this._imageSettings.brightness.offset !== offset) {
			this._imageSettings.brightness.offset = offset;
			this._emitSettingsChanged();
		}
	}

	// UI State Management
	public setImageZoom(zoom: any): void {
		if (this._uiState.zoom !== zoom) {
			this._uiState.zoom = zoom;
			this._emitUIChanged();
		}
	}

	public setImageSize(size: string | undefined): void {
		if (this._uiState.imageSize !== size) {
			this._uiState.imageSize = size;
			this._emitUIChanged();
		}
	}

	public setIsFloat(isFloat: boolean): void {
		if (this._uiState.isFloat !== isFloat) {
			this._uiState.isFloat = isFloat;
			this._emitUIChanged();
		}
	}

	public setFormatInfo(formatInfo: any): void {
		if (this._uiState.formatInfo !== formatInfo) {
			this._uiState.formatInfo = formatInfo;
			this._emitUIChanged();
		}
	}

	public setPixelPosition(position: any): void {
		if (this._uiState.pixelPosition !== position) {
			this._uiState.pixelPosition = position;
			this._emitUIChanged();
		}
	}

	// Image Stats Management
	public updateImageStats(min: number, max: number): void {
		if (!this._imageStats || this._imageStats.min !== min || this._imageStats.max !== max) {
			this._imageStats = { min, max };
			this._onDidChangeStats.fire(this._imageStats);
		}
	}

	// Comparison Management
	public setComparisonBase(uri: vscode.Uri | undefined): void {
		this._comparisonBaseUri = uri;
		vscode.commands.executeCommand('setContext', 'tiffVisualizer.hasComparisonImage', !!uri);
	}

	// Preview Management
	public setActivePreview(preview: any): void {
		const wasActive = this._statusBarState.activePreview;
		this._statusBarState.activePreview = preview;
		
		if (wasActive !== preview) {
			if (wasActive) {
				this._onDidDeactivatePreview.fire(wasActive);
			}
			if (preview) {
				this._onDidActivatePreview.fire(preview);
			}
		}
	}

	// Status Bar Coordination
	public registerStatusBarEntry(entryId: string): void {
		this._statusBarState.visibleEntries.add(entryId);
	}

	public unregisterStatusBarEntry(entryId: string): void {
		this._statusBarState.visibleEntries.delete(entryId);
	}

	public isStatusBarEntryRegistered(entryId: string): boolean {
		return this._statusBarState.visibleEntries.has(entryId);
	}

	public hideAllStatusBarEntries(): void {
		// This will be implemented with the status bar refactoring
		// For now, emit deactivation event
		if (this._statusBarState.activePreview) {
			this._onDidDeactivatePreview.fire(this._statusBarState.activePreview);
		}
	}

	// Private event emitters
	private _emitSettingsChanged(): void {
		this._onDidChangeSettings.fire(this._imageSettings);
	}

	private _emitUIChanged(): void {
		this._onDidChangeUI.fire(this._uiState);
	}

	// Disposal
	public dispose(): void {
		this._onDidChangeSettings.dispose();
		this._onDidChangeUI.dispose();
		this._onDidChangeStats.dispose();
		this._onDidActivatePreview.dispose();
		this._onDidDeactivatePreview.dispose();
	}
} 
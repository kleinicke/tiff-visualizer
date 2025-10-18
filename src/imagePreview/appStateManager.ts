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
	rgbAs24BitGrayscale: boolean;
}

// Image format types for per-format settings
export type ImageFormatType = 'png' | 'jpg' | 'ppm' | 'tiff-float' | 'tiff-int' | 'pfm' | 'npy-float' | 'npy-uint';

export interface ImageStats {
	min: number;
	max: number;
}

export interface UIState {
	zoom: any;
	imageSize: string | undefined;
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
		},
		rgbAs24BitGrayscale: false
	};

	private _uiState: UIState = {
		zoom: 'fit',
		imageSize: undefined,
		formatInfo: undefined,
		pixelPosition: undefined
	};

	private _imageStats: ImageStats | undefined;
	private _comparisonBaseUri: vscode.Uri | undefined;
	private _statusBarState: StatusBarState = {
		activePreview: undefined,
		visibleEntries: new Set()
	};

	// Per-format settings cache
	private _formatSettingsCache: Map<ImageFormatType, ImageSettings> = new Map();
	private _currentFormat: ImageFormatType | undefined;

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

	public setRgbAs24BitGrayscale(enabled: boolean): void {
		if (this._imageSettings.rgbAs24BitGrayscale !== enabled) {
			this._imageSettings.rgbAs24BitGrayscale = enabled;
			this._emitSettingsChanged();
		}
	}

	// Per-format Settings Management
	public setImageFormat(format: ImageFormatType): void {
		console.log(`[AppStateManager] setImageFormat called with format: ${format}`);

		// Save current settings for the previous format
		if (this._currentFormat) {
			console.log(`[AppStateManager] Saving settings for previous format: ${this._currentFormat}`);
			this._formatSettingsCache.set(this._currentFormat, this._deepCopySettings(this._imageSettings));
		}

		this._currentFormat = format;

		// Load settings for the new format
		const cachedSettings = this._formatSettingsCache.get(format);
		if (cachedSettings) {
			console.log(`[AppStateManager] ⚠️  USING CACHED SETTINGS for format: ${format}`);
			console.log(`[AppStateManager]   Cached: autoNormalize=${cachedSettings.normalization.autoNormalize}, gammaMode=${cachedSettings.normalization.gammaMode}, range=[${cachedSettings.normalization.min}, ${cachedSettings.normalization.max}]`);
			console.log(`[AppStateManager]   Cached gamma: in=${cachedSettings.gamma.in}, out=${cachedSettings.gamma.out}`);
			console.log(`[AppStateManager]   Cached brightness: offset=${cachedSettings.brightness.offset}`);
			console.log(`[AppStateManager]   💡 Use "Reset All Settings" command to clear cache and apply new defaults`);
			this._imageSettings = this._deepCopySettings(cachedSettings);
			this._emitSettingsChanged();
		} else {
			// Use default settings for this format
			const defaults = this._getDefaultSettingsForFormat(format);
			console.log(`[AppStateManager] Using default settings for format: ${format}`, defaults);
			this._imageSettings = defaults;
			this._emitSettingsChanged();
		}
	}

	private _deepCopySettings(settings: ImageSettings): ImageSettings {
		return {
			normalization: { ...settings.normalization },
			gamma: { ...settings.gamma },
			brightness: { ...settings.brightness },
			rgbAs24BitGrayscale: settings.rgbAs24BitGrayscale
		};
	}

	private _getDefaultSettingsForFormat(format: ImageFormatType): ImageSettings {
		console.log(`\n========================================`);
		console.log(`[AppStateManager] 📋 Getting defaults for format: ${format}`);
		console.log(`========================================`);

		// Base defaults - gamma correction settings apply to all
		const defaults: ImageSettings = {
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
			},
			rgbAs24BitGrayscale: false
		};

		// ============================================
		// NORMALIZATION DEFAULT RULES (SIMPLE & CLEAR)
		// ============================================

		// Rule 1: Integer formats → Gamma mode with type-specific ranges
		// (Ranges will be set by webview based on actual bit depth)
		if (format === 'npy-uint' || format === 'tiff-int' || format === 'ppm' || format === 'png' || format === 'jpg') {
			defaults.normalization.gammaMode = true;
			defaults.normalization.autoNormalize = false;
			defaults.normalization.min = 0;
			defaults.normalization.max = 1; // Will be overridden by webview based on bit depth
			console.log(`[AppStateManager] ✓ INTEGER FORMAT → Gamma mode`);
			console.log(`[AppStateManager]   Reason: Integer data needs type-specific ranges (uint8=0-255, uint16=0-65535, etc.)`);
			console.log(`[AppStateManager]   Settings: gammaMode=true, autoNormalize=false`);
		}

		// Rule 2: Float images (TIFF, PFM) → Gamma mode with 0-1 range
		// (These are typically images stored as floats, expected in 0-1 range)
		else if (format === 'tiff-float' || format === 'pfm') {
			defaults.normalization.gammaMode = true;
			defaults.normalization.autoNormalize = false;
			defaults.normalization.min = 0;
			defaults.normalization.max = 1;
			console.log(`[AppStateManager] ✓ FLOAT IMAGE FORMAT → Gamma mode with [0, 1] range`);
			console.log(`[AppStateManager]   Reason: Float images are typically normalized to 0-1`);
			console.log(`[AppStateManager]   Settings: gammaMode=true, autoNormalize=false, range=[0,1]`);
		}

		// Rule 3: Float data (NPY) → Auto-normalize to actual data range
		// (Scientific data can have any range, needs auto-detection)
		else if (format === 'npy-float') {
			defaults.normalization.gammaMode = false;
			defaults.normalization.autoNormalize = true;
			// min/max will be computed from actual data
			console.log(`[AppStateManager] ✓ FLOAT DATA FORMAT → Auto-normalize mode`);
			console.log(`[AppStateManager]   Reason: Scientific float data can have arbitrary ranges`);
			console.log(`[AppStateManager]   Settings: gammaMode=false, autoNormalize=true`);
		}

		// Fallback: Unknown formats
		else {
			defaults.normalization.gammaMode = false;
			defaults.normalization.autoNormalize = true;
			console.log(`[AppStateManager] ⚠️  UNKNOWN FORMAT → Auto-normalize mode (fallback)`);
			console.log(`[AppStateManager]   Settings: gammaMode=false, autoNormalize=true`);
		}

		console.log(`[AppStateManager] 📦 Final defaults:`, JSON.stringify(defaults, null, 2));
		console.log(`========================================\n`);
		return defaults;
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

	// Cache Management
	public clearAllCaches(): void {
		this._formatSettingsCache.clear();
	}

	public resetToDefaults(format?: ImageFormatType): void {
		if (format) {
			// Reset specific format
			this._formatSettingsCache.delete(format);
			if (this._currentFormat === format) {
				this._imageSettings = this._getDefaultSettingsForFormat(format);
				this._emitSettingsChanged();
			}
		} else {
			// Reset all
			this._formatSettingsCache.clear();
			if (this._currentFormat) {
				this._imageSettings = this._getDefaultSettingsForFormat(this._currentFormat);
				this._emitSettingsChanged();
			}
		}
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
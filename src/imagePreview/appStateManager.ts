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
	scale24BitFactor: number; // Divide 24-bit values by this for display (default 1000)
	normalizedFloatMode: boolean; // Convert uint images to normalized float (0-1 range)
}

// Image format types for per-format settings
export type ImageFormatType = 'png' | 'jpg' | 'ppm' | 'tiff-float' | 'tiff-int' | 'exr-float' | 'pfm' | 'npy-float' | 'npy-uint';

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

export interface HistogramState {
	isVisible: boolean;
	position?: { top: number; left: number };
	scaleMode: 'linear' | 'sqrt';
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
	private readonly _onDidChangeHistogramState = new vscode.EventEmitter<HistogramState>();

	// Public event emitters
	public readonly onDidChangeSettings = this._onDidChangeSettings.event;
	public readonly onDidChangeUI = this._onDidChangeUI.event;
	public readonly onDidChangeStats = this._onDidChangeStats.event;
	public readonly onDidActivatePreview = this._onDidActivatePreview.event;
	public readonly onDidDeactivatePreview = this._onDidDeactivatePreview.event;
	public readonly onDidChangeHistogramState = this._onDidChangeHistogramState.event;

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
		rgbAs24BitGrayscale: false,
		scale24BitFactor: 1000,
		normalizedFloatMode: false
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

	// Global histogram state (persists across all images)
	private _histogramState: HistogramState = {
		isVisible: false,
		position: undefined,
		scaleMode: 'sqrt'
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

	public get currentFormat(): ImageFormatType | undefined {
		return this._currentFormat;
	}

	public get histogramState(): Readonly<HistogramState> {
		return this._histogramState;
	}

	// Histogram State Management
	public setHistogramVisible(isVisible: boolean): void {
		if (this._histogramState.isVisible !== isVisible) {
			this._histogramState.isVisible = isVisible;
			this._onDidChangeHistogramState.fire(this._histogramState);
		}
	}

	public setHistogramPosition(position: { top: number; left: number } | undefined): void {
		this._histogramState.position = position;
		this._onDidChangeHistogramState.fire(this._histogramState);
	}

	public setHistogramScaleMode(mode: 'linear' | 'sqrt'): void {
		if (this._histogramState.scaleMode !== mode) {
			this._histogramState.scaleMode = mode;
			this._onDidChangeHistogramState.fire(this._histogramState);
		}
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

	public setRgbAs24BitGrayscale(enabled: boolean, scaleFactor?: number): void {
		if (this._imageSettings.rgbAs24BitGrayscale !== enabled) {
			this._imageSettings.rgbAs24BitGrayscale = enabled;

			// Update scale factor if provided
			if (scaleFactor !== undefined) {
				this._imageSettings.scale24BitFactor = scaleFactor;
			}

			// When enabling 24-bit mode, use auto-normalize by default
			if (enabled) {
				// Enable auto-normalize mode for 24-bit (user requirement)
				this._imageSettings.normalization.autoNormalize = true;
				this._imageSettings.normalization.gammaMode = false;
			} else if (!enabled) {
				// When disabling 24-bit mode, switch back to gamma mode
				this._imageSettings.normalization.autoNormalize = false;
				this._imageSettings.normalization.gammaMode = true;
				this._imageSettings.normalization.min = 0;
				this._imageSettings.normalization.max = 255;
			}

			this._emitSettingsChanged();
		}
	}

	public setScale24BitFactor(factor: number): void {
		if (this._imageSettings.scale24BitFactor !== factor) {
			this._imageSettings.scale24BitFactor = factor;
			this._emitSettingsChanged();
		}
	}

	public setNormalizedFloatMode(enabled: boolean): void {
		if (this._imageSettings.normalizedFloatMode !== enabled) {
			this._imageSettings.normalizedFloatMode = enabled;
			this._emitSettingsChanged();
		}
	}

	// Per-format Settings Management
	public setImageFormat(format: ImageFormatType): void {
		// Save current settings for the previous format
		if (this._currentFormat) {
			this._formatSettingsCache.set(this._currentFormat, this._deepCopySettings(this._imageSettings));
		}

		this._currentFormat = format;

		// Load settings for the new format
		const cachedSettings = this._formatSettingsCache.get(format);
		if (cachedSettings) {
			this._imageSettings = this._deepCopySettings(cachedSettings);
			this._emitSettingsChanged();
		} else {
			// Use default settings for this format
			const defaults = this._getDefaultSettingsForFormat(format);
			this._imageSettings = defaults;
			this._emitSettingsChanged();
		}
	}

	private _deepCopySettings(settings: ImageSettings): ImageSettings {
		return {
			normalization: { ...settings.normalization },
			gamma: { ...settings.gamma },
			brightness: { ...settings.brightness },
			rgbAs24BitGrayscale: settings.rgbAs24BitGrayscale,
			scale24BitFactor: settings.scale24BitFactor,
			normalizedFloatMode: settings.normalizedFloatMode
		};
	}

	private _getDefaultSettingsForFormat(format: ImageFormatType): ImageSettings {
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
			rgbAs24BitGrayscale: false,
			scale24BitFactor: 1000,
			normalizedFloatMode: false
		};

		// Rule 1: Integer formats → Gamma mode with type-specific ranges
		// (Ranges will be set by webview based on actual bit depth)
		if (format === 'npy-uint' || format === 'tiff-int' || format === 'ppm' || format === 'png' || format === 'jpg') {
			defaults.normalization.gammaMode = true;
			defaults.normalization.autoNormalize = false;
			defaults.normalization.min = 0;
			defaults.normalization.max = 1; // Will be overridden by webview based on bit depth
		}
		// Rule 2: Float images (TIFF, PFM) → Gamma mode with 0-1 range
		// (These are typically images stored as floats, expected in 0-1 range)
		else if (format === 'tiff-float' || format === 'pfm') {
			defaults.normalization.gammaMode = true;
			defaults.normalization.autoNormalize = false;
			defaults.normalization.min = 0;
			defaults.normalization.max = 1;
		}
		// Rule 3: Float data (NPY) → Auto-normalize to actual data range
		// (Scientific data can have any range, needs auto-detection)
		else if (format === 'npy-float') {
			defaults.normalization.gammaMode = false;
			defaults.normalization.autoNormalize = true;
		}
		// Fallback: Unknown formats
		else {
			defaults.normalization.gammaMode = false;
			defaults.normalization.autoNormalize = true;
		}

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
		this._onDidChangeHistogramState.dispose();
	}
} 
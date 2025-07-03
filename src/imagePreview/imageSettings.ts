import * as vscode from 'vscode';

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

export interface MaskFilterSettings {
	maskUri: string;
	threshold: number;
	filterHigher: boolean;
	enabled: boolean;
}

export interface ImageSettings {
	normalization: NormalizationSettings;
	gamma: GammaSettings;
	brightness: BrightnessSettings;
	maskFilters: MaskFilterSettings[];
	nanColor: 'black' | 'fuchsia';
}

export interface ImageStats {
	min: number;
	max: number;
}

export class ImageSettingsManager {
	private readonly _onDidChangeSettings = new vscode.EventEmitter<ImageSettings>();
	public readonly onDidChangeSettings = this._onDidChangeSettings.event;

	private _settings: ImageSettings = {
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
		maskFilters: [],
		nanColor: 'black'
	};

	// Store mask filter settings per image URI
	private _perImageMaskFilters = new Map<string, MaskFilterSettings[]>();

	private _imageStats: ImageStats | undefined;
	private _comparisonBaseUri: vscode.Uri | undefined;

	public get settings(): Readonly<ImageSettings> {
		return this._settings;
	}

	public get imageStats(): Readonly<ImageStats> | undefined {
		return this._imageStats;
	}

	public get comparisonBaseUri(): vscode.Uri | undefined {
		return this._comparisonBaseUri;
	}

	public updateNormalization(min: number, max: number): void {
		if (this._settings.normalization.min !== min || this._settings.normalization.max !== max) {
			this._settings.normalization.min = min;
			this._settings.normalization.max = max;
			this._fireSettingsChanged();
		}
	}

	public setAutoNormalize(enabled: boolean): void {
		if (this._settings.normalization.autoNormalize !== enabled) {
			this._settings.normalization.autoNormalize = enabled;
			if (enabled) {
				this._settings.normalization.gammaMode = false; // Disable gamma mode when auto-normalize is enabled
			}
			this._fireSettingsChanged();
		}
	}

	public setGammaMode(enabled: boolean): void {
		if (this._settings.normalization.gammaMode !== enabled) {
			this._settings.normalization.gammaMode = enabled;
			if (enabled) {
				// When enabling gamma mode, preserve current normalization range
				if (this._settings.normalization.autoNormalize) {
					// Coming from auto-normalize: disable auto mode but keep existing manual values
					this._settings.normalization.autoNormalize = false;
				}
				// If coming from manual mode, keep the current manual values
			}
			this._fireSettingsChanged();
		}
	}

	public updateGamma(gammaIn: number, gammaOut: number): void {
		if (this._settings.gamma.in !== gammaIn || this._settings.gamma.out !== gammaOut) {
			this._settings.gamma.in = gammaIn;
			this._settings.gamma.out = gammaOut;
			this._fireSettingsChanged();
		}
	}

	public updateBrightness(offset: number): void {
		if (this._settings.brightness.offset !== offset) {
			this._settings.brightness.offset = offset;
			this._fireSettingsChanged();
		}
	}

	public addMaskFilter(imageUri: string, mask: MaskFilterSettings): void {
		const arr = this._perImageMaskFilters.get(imageUri) || [];
		arr.push(mask);
		this._perImageMaskFilters.set(imageUri, arr);
		this._fireSettingsChanged();
	}

	public updateMaskFilter(imageUri: string, index: number, mask: Partial<MaskFilterSettings>): void {
		const arr = this._perImageMaskFilters.get(imageUri);
		if (arr && arr[index]) {
			arr[index] = { ...arr[index], ...mask };
			this._fireSettingsChanged();
		}
	}

	public removeMaskFilter(imageUri: string, index: number): void {
		const arr = this._perImageMaskFilters.get(imageUri);
		if (arr && arr[index]) {
			arr.splice(index, 1);
			this._fireSettingsChanged();
		}
	}

	public setMaskFilterEnabled(imageUri: string, index: number, enabled: boolean): void {
		const arr = this._perImageMaskFilters.get(imageUri);
		if (arr && arr[index]) {
			arr[index].enabled = enabled;
			this._fireSettingsChanged();
		}
	}

	public getMaskFilterSettings(imageUri: string): MaskFilterSettings[] {
		// Migration: if old single maskFilter exists, convert to array
		// (Assume migration logic is handled elsewhere if needed)
		return this._perImageMaskFilters.get(imageUri) || [];
	}

	public getSettingsForImage(imageUri: string): Readonly<ImageSettings> {
		return {
			...this._settings,
			maskFilters: this.getMaskFilterSettings(imageUri)
		};
	}

	public toggleNanColor(): void {
		this._settings.nanColor = this._settings.nanColor === 'black' ? 'fuchsia' : 'black';
		this._fireSettingsChanged();
	}

	public getNanColor(): 'black' | 'fuchsia' {
		return this._settings.nanColor;
	}

	public updateImageStats(min: number, max: number): void {
		if (!this._imageStats || this._imageStats.min !== min || this._imageStats.max !== max) {
			this._imageStats = { min, max };
			// Image stats change doesn't trigger settings change event
		}
	}

	public setComparisonBase(uri: vscode.Uri | undefined): void {
		this._comparisonBaseUri = uri;
		vscode.commands.executeCommand('setContext', 'tiffVisualizer.hasComparisonImage', !!uri);
	}

	private _fireSettingsChanged(): void {
		this._onDidChangeSettings.fire(this._settings);
	}

	public dispose(): void {
		this._onDidChangeSettings.dispose();
	}
} 
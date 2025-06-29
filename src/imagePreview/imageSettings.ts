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

export interface ImageSettings {
	normalization: NormalizationSettings;
	gamma: GammaSettings;
	brightness: BrightnessSettings;
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
		}
	};

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
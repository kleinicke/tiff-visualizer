import * as vscode from 'vscode';
import type { ImageStats } from './appStateManager';

export interface MaskFilterSettings {
	maskUri: string;
	threshold: number;
	filterHigher: boolean;
	enabled: boolean;
}

export class ImageSettingsManager {
	private readonly _onDidChangeSettings = new vscode.EventEmitter<void>();
	public readonly onDidChangeSettings = this._onDidChangeSettings.event;

	// Store mask filter settings per image URI
	private _perImageMaskFilters = new Map<string, MaskFilterSettings[]>();

	private _imageStats: ImageStats | undefined;
	private _comparisonBaseUri: vscode.Uri | undefined;
	private _nanColor: 'black' | 'fuchsia' = 'black';

	public get imageStats(): Readonly<ImageStats> | undefined {
		return this._imageStats;
	}

	public get comparisonBaseUri(): vscode.Uri | undefined {
		return this._comparisonBaseUri;
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
		return this._perImageMaskFilters.get(imageUri) || [];
	}

	public toggleNanColor(): void {
		this._nanColor = this._nanColor === 'black' ? 'fuchsia' : 'black';
		this._fireSettingsChanged();
	}

	public getNanColor(): 'black' | 'fuchsia' {
		return this._nanColor;
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
		this._onDidChangeSettings.fire();
	}

	public dispose(): void {
		this._onDidChangeSettings.dispose();
	}
} 
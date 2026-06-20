import * as vscode from 'vscode';
import type { ImageStats } from './appStateManager';

export class ImageSettingsManager {
	private readonly _onDidChangeSettings = new vscode.EventEmitter<void>();
	public readonly onDidChangeSettings = this._onDidChangeSettings.event;

	private _imageStats: ImageStats | undefined;
	private _comparisonBaseUri: vscode.Uri | undefined;
	private _nanColor: 'black' | 'fuchsia' = 'black';
	private _colorPickerShowModified: boolean = false;

	public get imageStats(): Readonly<ImageStats> | undefined {
		return this._imageStats;
	}

	public get comparisonBaseUri(): vscode.Uri | undefined {
		return this._comparisonBaseUri;
	}

	public toggleNanColor(): void {
		this._nanColor = this._nanColor === 'black' ? 'fuchsia' : 'black';
		this._fireSettingsChanged();
	}

	public getNanColor(): 'black' | 'fuchsia' {
		return this._nanColor;
	}

	public toggleColorPickerShowModified(): void {
		this._colorPickerShowModified = !this._colorPickerShowModified;
		this._fireSettingsChanged();
	}

	public getColorPickerShowModified(): boolean {
		return this._colorPickerShowModified;
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

import * as vscode from 'vscode';
import type { ImageStats } from './appStateManager';

/**
 * How a pixel with no value is drawn. The webview's `nan-color.ts` resolves
 * these names to actual colours; this side only cycles between them.
 */
export type NanColorName = 'black' | 'fuchsia' | 'transparent';
const NAN_COLOR_CYCLE: readonly NanColorName[] = ['black', 'fuchsia', 'transparent'];

export class ImageSettingsManager {
	private readonly _onDidChangeSettings = new vscode.EventEmitter<void>();
	public readonly onDidChangeSettings = this._onDidChangeSettings.event;

	private _imageStats: ImageStats | undefined;
	private _comparisonBaseUri: vscode.Uri | undefined;
	private _nanColor: NanColorName = 'black';
	private _colorPickerShowModified: boolean = false;
	/**
	 * Whether the idle scale bar is drawn, for the whole session.
	 *
	 * It used to live only on the webview's overlay object, so it reset to "on"
	 * every time a webview was created — opening another image, or VS Code
	 * reloading the view after a tab move. Turning it off is a deliberate
	 * choice about how the user wants to read images, not a per-file one, so it
	 * belongs beside the other session preferences here.
	 */
	private _showScaleBar: boolean = true;

	public get imageStats(): Readonly<ImageStats> | undefined {
		return this._imageStats;
	}

	public get comparisonBaseUri(): vscode.Uri | undefined {
		return this._comparisonBaseUri;
	}

	/**
	 * Cycle how pixels with no value are drawn: black, then fuchsia, then
	 * transparent. Three states rather than two because "absent" is a real
	 * third answer — a transparent hole lets a layer underneath show through
	 * and exports as a hole, which is what GDAL and QGIS do with nodata.
	 */
	public toggleNanColor(): void {
		this._nanColor = NAN_COLOR_CYCLE[(NAN_COLOR_CYCLE.indexOf(this._nanColor) + 1) % NAN_COLOR_CYCLE.length];
		this._fireSettingsChanged();
	}

	public getNanColor(): NanColorName {
		return this._nanColor;
	}

	public toggleColorPickerShowModified(): void {
		this._colorPickerShowModified = !this._colorPickerShowModified;
		this._fireSettingsChanged();
	}

	public getColorPickerShowModified(): boolean {
		return this._colorPickerShowModified;
	}

	public toggleScaleBar(): boolean {
		this._showScaleBar = !this._showScaleBar;
		this._fireSettingsChanged();
		return this._showScaleBar;
	}

	public getShowScaleBar(): boolean {
		return this._showScaleBar;
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

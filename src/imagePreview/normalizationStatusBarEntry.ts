import * as vscode from 'vscode';
import { PreviewStatusBarEntry } from '../ownedStatusBarEntry';

const NORMALIZATION_RANGE_COMMAND_ID = 'tiffVisualizer.setNormalizationRange';

export class NormalizationStatusBarEntry extends PreviewStatusBarEntry {

	private _imageRealMin: number | undefined;
	private _imageRealMax: number | undefined;

	private _normMin: number | undefined;
	private _normMax: number | undefined;

	constructor() {
		super(
			'tiffVisualizer.normalization',
			'Image Normalization',
			vscode.StatusBarAlignment.Right,
			101
		);
		this.entry.command = NORMALIZATION_RANGE_COMMAND_ID;
	}

	public show(autoNormalize?: boolean, gammaMode?: boolean) {
		let text = '';

		if (autoNormalize) {
			// Show the actual image range when auto-normalizing
			text = `Auto-Norm: [${(this._imageRealMin ?? 0).toFixed(2)}, ${(this._imageRealMax ?? 1).toFixed(2)}]`;
		} else if (gammaMode) {
			text = `Gamma-Norm: [0.00, 1.00]`;
		} else {
			// Manual normalization - show the user-set range
			text = `Norm: [${(this._normMin ?? 0).toFixed(2)}, ${(this._normMax ?? 1).toFixed(2)}]`;
		}

		// Build tooltip with image range information
		let tooltip = '';
		if (this._imageRealMin !== undefined && this._imageRealMax !== undefined) {
			tooltip = `Image Range: [${this._imageRealMin.toFixed(2)}, ${this._imageRealMax.toFixed(2)}]\n\n`;
		}

		if (autoNormalize) {
			tooltip += 'Auto-normalize enabled - Click to change normalization settings';
		} else if (gammaMode) {
			tooltip += 'Gamma/Brightness mode enabled - Click to change normalization settings';
		} else {
			tooltip += 'Click to set custom normalization range for floating-point images';
		}

		this.showItem(this, text);
		this.entry.tooltip = tooltip;
	}

	public updateImageStats(min: number, max: number) {
		this._imageRealMin = min;
		this._imageRealMax = max;
	}

	public updateNormalization(min: number | null, max: number | null) {
		this._normMin = min ?? undefined;
		this._normMax = max ?? undefined;
	}
} 
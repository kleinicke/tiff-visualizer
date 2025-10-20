import * as vscode from 'vscode';
import { PreviewStatusBarEntry } from '../ownedStatusBarEntry';

const NORMALIZATION_RANGE_COMMAND_ID = 'tiffVisualizer.setNormalizationRange';

export class NormalizationStatusBarEntry extends PreviewStatusBarEntry {

	private _imageRealMin: number | undefined;
	private _imageRealMax: number | undefined;

	private _normMin: number | undefined;
	private _normMax: number | undefined;
	private _rgbAs24BitMode: boolean = false;
	private _normalizedFloatMode: boolean = false;
	private _bitsPerSample: number | undefined;
	private _sampleFormat: number | undefined;

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

		// Determine the normalization range based on data type
		const isFloat = this._sampleFormat === 3;
		let typeMaxValue = 1;
		if (!isFloat) {
			if (this._bitsPerSample === 16) {
				typeMaxValue = 65535;
			} else if (this._bitsPerSample === 8) {
				typeMaxValue = 255;
			} else {
				typeMaxValue = 255; // fallback
			}
		}

		if (autoNormalize) {
			// Show the actual image range when auto-normalizing
			if (this._rgbAs24BitMode && this._imageRealMax !== undefined && this._imageRealMax > 1000) {
				// For 24-bit mode with large values, use integer formatting
				text = `Auto-Norm: [${Math.round(this._imageRealMin ?? 0)}, ${Math.round(this._imageRealMax ?? 16777215)}]`;
			} else if (this._normalizedFloatMode) {
				// For normalized float mode, convert uint range to 0-1
				const minNorm = (this._imageRealMin ?? 0) / (this._imageRealMax ?? 255);
				const maxNorm = (this._imageRealMax ?? 255) / (this._imageRealMax ?? 255);
				text = `Auto-Norm: [${minNorm.toFixed(2)}, ${maxNorm.toFixed(2)}]`;
			} else {
				text = `Auto-Norm: [${(this._imageRealMin ?? 0).toFixed(2)}, ${(this._imageRealMax ?? 1).toFixed(2)}]`;
			}
		} else if (gammaMode) {
			// For gamma mode, don't show the range in the main text (only in tooltip)
			text = `Gamma-Norm`;
		} else {
			// Manual normalization - show the user-set range as-is
			if (this._rgbAs24BitMode && (this._normMax ?? 1) > 1000) {
				// For 24-bit mode with large values, use integer formatting
				text = `Norm: [${Math.round(this._normMin ?? 0)}, ${Math.round(this._normMax ?? 16777215)}]`;
			} else {
				// For all other cases, show the values as entered by the user
				text = `Norm: [${(this._normMin ?? 0).toFixed(2)}, ${(this._normMax ?? 1).toFixed(2)}]`;
			}
		}

		// Build tooltip with image range and normalization information
		let tooltip = '';
		if (this._imageRealMin !== undefined && this._imageRealMax !== undefined) {
			tooltip = `Image Range: [${this._imageRealMin.toFixed(2)}, ${this._imageRealMax.toFixed(2)}]\n`;
		}

		// Add normalization range to tooltip
		if (gammaMode) {
			// For gamma mode, show normalization range in tooltip
			if (this._rgbAs24BitMode) {
				tooltip += `Normalization: [0, 16777215]\n`;
			} else if (this._normalizedFloatMode || isFloat) {
				tooltip += `Normalization: [0.00, 1.00]\n`;
			} else {
				tooltip += `Normalization: [0, ${typeMaxValue}]\n`;
			}
		} else if (!autoNormalize && this._normMin !== undefined && this._normMax !== undefined) {
			// For manual mode, show the normalization range in tooltip as well
			tooltip += `Normalization: [${this._normMin.toFixed(2)}, ${this._normMax.toFixed(2)}]\n`;
		}

		tooltip += '\n';
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

	public setRgbAs24BitMode(enabled: boolean) {
		this._rgbAs24BitMode = enabled;
	}

	public setNormalizedFloatMode(enabled: boolean) {
		this._normalizedFloatMode = enabled;
	}

	public updateFormatInfo(bitsPerSample: number, sampleFormat: number) {
		this._bitsPerSample = bitsPerSample;
		this._sampleFormat = sampleFormat;
	}
} 
import * as vscode from 'vscode';
import { Disposable } from '../util/dispose';

const NORMALIZATION_RANGE_COMMAND_ID = 'tiffVisualizer.setNormalizationRange';

export class NormalizationStatusBarEntry extends Disposable {
	private readonly _entry: vscode.StatusBarItem;

	private _imageRealMin: number | undefined;
	private _imageRealMax: number | undefined;

	private _normMin: number | undefined;
	private _normMax: number | undefined;

	constructor() {
		super();
		this._entry = this._register(vscode.window.createStatusBarItem(
			'tiffVisualizer.normalization',
			vscode.StatusBarAlignment.Right,
			101,
		));
		this._entry.name = 'Image Normalization';
		this._entry.command = NORMALIZATION_RANGE_COMMAND_ID;
	}

	public show(autoNormalize?: boolean, gammaMode?: boolean) {
		let text = `Norm: [${(this._normMin ?? 0).toFixed(2)}, ${(this._normMax ?? 1).toFixed(2)}]`;
		
		if (autoNormalize) {
			text = `Auto-Norm: [${(this._imageRealMin ?? 0).toFixed(2)}, ${(this._imageRealMax ?? 1).toFixed(2)}]`;
		} else if (gammaMode) {
			text = `Gamma-Norm: [0.00, 1.00]`;
		}

		if (this._imageRealMin !== undefined && this._imageRealMax !== undefined && !autoNormalize && !gammaMode) {
			text = `Image: [${this._imageRealMin.toFixed(2)}, ${this._imageRealMax.toFixed(2)}] | ${text}`;
		}

		this._entry.text = text;
		this._entry.tooltip = autoNormalize 
			? 'Auto-normalize enabled - Click to change normalization settings'
			: gammaMode
			? 'Gamma/Brightness mode enabled - Click to change normalization settings'
			: 'Click to set custom normalization range for floating-point images';
		this._entry.show();
	}

	public hide() {
		this._entry.hide();
	}

	public updateImageStats(min: number, max: number) {
		this._imageRealMin = min;
		this._imageRealMax = max;
	}

	public updateNormalization(min: number, max: number) {
		this._normMin = min;
		this._normMax = max;
	}
} 
import * as vscode from 'vscode';
import { Disposable } from '../util/dispose';

const NORMALIZATION_RANGE_COMMAND_ID = 'imagePreview.setNormalizationRange';

export class NormalizationStatusBarEntry extends Disposable {
	private readonly _entry: vscode.StatusBarItem;

	private _imageRealMin: number | undefined;
	private _imageRealMax: number | undefined;

	constructor() {
		super();
		this._entry = this._register(vscode.window.createStatusBarItem(
			'imagePreview.normalization',
			vscode.StatusBarAlignment.Right,
			101,
		));
		this._entry.name = 'Image Preview Normalization';
		this._entry.command = NORMALIZATION_RANGE_COMMAND_ID;
	}

	public show() {
		const config = vscode.workspace.getConfiguration('mediaPreview.tiff');
		const normMin = config.get('normalization.min', 0);
		const normMax = config.get('normalization.max', 1);

		let text = `Norm: [${normMin.toFixed(2)}, ${normMax.toFixed(2)}]`;

		if (this._imageRealMin !== undefined && this._imageRealMax !== undefined) {
			text = `Image: [${this._imageRealMin.toFixed(2)}, ${this._imageRealMax.toFixed(2)}] | ${text}`;
		}

		this._entry.text = text;
		this._entry.tooltip = 'Click to set custom normalization range for floating-point images';
		this._entry.show();
	}

	public hide() {
		this._entry.hide();
	}

	public updateImageStats(min: number, max: number) {
		this._imageRealMin = min;
		this._imageRealMax = max;
		this.show();
	}
} 
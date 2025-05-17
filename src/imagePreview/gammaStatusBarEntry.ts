import * as vscode from 'vscode';
import { Disposable } from '../util/dispose';

const GAMMA_COMMAND_ID = 'tiffVisualizer.setGamma';

export class GammaStatusBarEntry extends Disposable {
	private readonly _entry: vscode.StatusBarItem;

	private _gammaIn: number | undefined;
	private _gammaOut: number | undefined;

	constructor() {
		super();
		this._entry = this._register(vscode.window.createStatusBarItem(
			'tiffVisualizer.gamma',
			vscode.StatusBarAlignment.Right,
			100,
		));
		this._entry.name = 'Image Gamma';
		this._entry.command = GAMMA_COMMAND_ID;
	}

	public show() {
		const text = `γ: ${(this._gammaIn ?? 2.2).toFixed(1)}→${(this._gammaOut ?? 2.2).toFixed(1)}`;
		this._entry.text = text;
		this._entry.tooltip = 'Click to set gamma correction';
		this._entry.show();
	}

	public hide() {
		this._entry.hide();
	}

	public updateGamma(gammaIn: number, gammaOut: number) {
		this._gammaIn = gammaIn;
		this._gammaOut = gammaOut;
		this.show();
	}
} 
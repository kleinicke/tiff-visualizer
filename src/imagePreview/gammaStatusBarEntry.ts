import * as vscode from 'vscode';
import { PreviewStatusBarEntry } from '../ownedStatusBarEntry';


export class GammaStatusBarEntry extends PreviewStatusBarEntry {
	private _gammaIn: number | undefined;
	private _gammaOut: number | undefined;

	constructor() {
		super(
			'tiffVisualizer.gamma',
			'Image Gamma',
			vscode.StatusBarAlignment.Right,
			100
		);
		this.entry.command = { command: 'tiffVisualizer.focusDisplay', title: 'Open display controls', arguments: ['gamma'] };
	}

	public show() {
		const text = `γ: ${(this._gammaIn ?? 2.2).toFixed(1)}→${(this._gammaOut ?? 2.2).toFixed(1)}`;
		this.entry.text = text;
		this.entry.tooltip = 'Click to set gamma correction';
		this.entry.show();
	}

	public hide() {
		this.entry.hide();
	}

	public updateGamma(gammaIn: number, gammaOut: number) {
		this._gammaIn = gammaIn;
		this._gammaOut = gammaOut;
		this.show();
	}
} 
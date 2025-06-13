import * as vscode from 'vscode';
import { PreviewStatusBarEntry } from '../ownedStatusBarEntry';

export class SizeStatusBarEntry extends PreviewStatusBarEntry {
	private _pixelPosition: string | undefined;

	constructor() {
		super('status.tiffVisualizer.size', vscode.l10n.t("Image Size"), vscode.StatusBarAlignment.Right, 110 /* to the left of zoom (102) */);
	}

	public show(owner: unknown, text: string) {
		this.showItem(owner, text);
	}

	public showPixelPosition(owner: unknown, text: string) {
		this._pixelPosition = text;
		this.showItem(owner, text);
	}

	public hidePixelPosition(owner: unknown) {
		if (this._pixelPosition) {
			this._pixelPosition = undefined;
			this.hide(owner);
		}
	}
}

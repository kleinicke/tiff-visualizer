import * as vscode from 'vscode';
import { PreviewStatusBarEntry } from '../ownedStatusBarEntry';

const MASK_FILTER_COMMAND_ID = 'tiffVisualizer.filterByMask';

export class MaskFilterStatusBarEntry extends PreviewStatusBarEntry {
	private _enabled: boolean = false;
	private _maskUri: string | undefined;
	private _threshold: number = 0.5;
	private _filterHigher: boolean = true;

	constructor() {
		super(
			'tiffVisualizer.maskFilter',
			'Mask Filter',
			vscode.StatusBarAlignment.Right,
			97 // To appear next to binary size (98)
		);
		this.entry.command = MASK_FILTER_COMMAND_ID;
	}

	public show() {
		if (this._enabled) {
			const directionText = this._filterHigher ? '>' : '<';
			const text = `Mask: ${directionText}${this._threshold.toFixed(2)}`;
			this.entry.text = text;
			this.entry.tooltip = `Mask filter active\nThreshold: ${this._threshold}\nFilter: ${this._filterHigher ? 'higher' : 'lower'} values\nClick to configure`;
			this.entry.show();
		} else {
			this.hide();
		}
	}

	public hide() {
		this.entry.hide();
	}

	public updateMaskFilter(enabled: boolean, maskUri?: string, threshold?: number, filterHigher?: boolean) {
		this._enabled = enabled;
		if (maskUri !== undefined) {
			this._maskUri = maskUri;
		}
		if (threshold !== undefined) {
			this._threshold = threshold;
		}
		if (filterHigher !== undefined) {
			this._filterHigher = filterHigher;
		}
		this.show();
	}
} 
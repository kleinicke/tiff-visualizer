import * as vscode from 'vscode';
import { StatusBarEntryInterface } from './statusBarEntryInterface';

export class ColorPickerModeStatusBarEntry implements StatusBarEntryInterface {
	private readonly _statusBarEntry: vscode.StatusBarItem;
	private _showModified: boolean = false;

	constructor() {
		this._statusBarEntry = vscode.window.createStatusBarItem('tiffVisualizer.colorPickerMode', vscode.StatusBarAlignment.Right, 101);
		this._statusBarEntry.name = 'TIFF Visualizer Color Picker Mode';
		this._statusBarEntry.command = 'tiffVisualizer.toggleColorPickerMode';
		this.updateMode(false);
		// Don't show initially - let updateStatusBar control visibility
	}

	public show(): void {
		this._statusBarEntry.show();
	}

	public hide(): void {
		this._statusBarEntry.hide();
	}

	public updateMode(showModified: boolean): void {
		this._showModified = showModified;
		if (showModified) {
			this._statusBarEntry.text = '$(eye) Modified';
			this._statusBarEntry.tooltip = 'Color picker shows modified values (gamma + exposure)\nClick to show original values';
		} else {
			this._statusBarEntry.text = '$(eye-closed) Original';
			this._statusBarEntry.tooltip = 'Color picker shows original values\nClick to show modified values (gamma + exposure)';
		}
	}

	public dispose(): void {
		this._statusBarEntry.dispose();
	}
}

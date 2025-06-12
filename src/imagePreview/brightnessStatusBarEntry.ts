import * as vscode from 'vscode';
import { Disposable } from '../util/dispose';

const BRIGHTNESS_COMMAND_ID = 'tiffVisualizer.setBrightness';

export class BrightnessStatusBarEntry extends Disposable {
	private readonly _entry: vscode.StatusBarItem;
	private _brightness: number | undefined;

	constructor() {
		super();
		this._entry = this._register(vscode.window.createStatusBarItem(
			'tiffVisualizer.brightness',
			vscode.StatusBarAlignment.Right,
			99, // To appear next to gamma
		));
		this._entry.name = 'Image Preview Brightness';
		this._entry.command = BRIGHTNESS_COMMAND_ID;
	}

	public show() {
		const text = `Brightness: ${(this._brightness ?? 0)}`;
		this._entry.text = text;
		this._entry.tooltip = 'Click to set brightness offset';
		this._entry.show();
	}

	public hide() {
		this._entry.hide();
	}

	public updateBrightness(brightness: number) {
		this._brightness = brightness;
		this.show();
	}
} 
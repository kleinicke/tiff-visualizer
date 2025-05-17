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
		this._entry.name = 'Image Brightness';
		this._entry.command = BRIGHTNESS_COMMAND_ID;
	}

	public show() {
		const stops = this._brightness ?? 0;
		const text = `Exposure: ${stops >= 0 ? '+' : ''}${stops.toFixed(1)} EV`;
		this._entry.text = text;
		this._entry.tooltip = 'Click to set exposure compensation in stops';
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
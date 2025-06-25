import * as vscode from 'vscode';
import { PreviewStatusBarEntry } from '../ownedStatusBarEntry';

const BRIGHTNESS_COMMAND_ID = 'tiffVisualizer.setBrightness';

export class BrightnessStatusBarEntry extends PreviewStatusBarEntry {
	private _brightness: number | undefined;

	constructor() {
		super(
			'tiffVisualizer.brightness',
			'Image Brightness',
			vscode.StatusBarAlignment.Right,
			99 // To appear next to gamma
		);
		this.entry.command = BRIGHTNESS_COMMAND_ID;
	}

	public show() {
		const stops = this._brightness ?? 0;
		const text = `Exposure: ${stops >= 0 ? '+' : ''}${stops.toFixed(1)} EV`;
		this.entry.text = text;
		this.entry.tooltip = 'Click to set exposure compensation in stops';
		this.entry.show();
	}

	public hide() {
		this.entry.hide();
	}

	public updateBrightness(brightness: number) {
		this._brightness = brightness;
		this.show();
	}
} 
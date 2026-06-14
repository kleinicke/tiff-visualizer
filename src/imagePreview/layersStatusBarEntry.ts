import * as vscode from 'vscode';
import { PreviewStatusBarEntry } from '../ownedStatusBarEntry';

const LAYERS_COMMAND_ID = 'tiffVisualizer.toggleLayers';

/**
 * Status bar button that opens the Layers panel for image compositing.
 * Replaces the former mask-filter button.
 */
export class LayersStatusBarEntry extends PreviewStatusBarEntry {
	constructor() {
		super(
			'tiffVisualizer.layers',
			'Layers',
			vscode.StatusBarAlignment.Right,
			97 // Same slot the mask filter button used (next to binary size)
		);
		this.entry.command = LAYERS_COMMAND_ID;
		this.entry.text = '$(layers) Layers';
		this.entry.tooltip = 'Open the Layers view — stack images and blend them (add, subtract, multiply, …)';
	}

	public show() {
		this.entry.text = '$(layers) Layers';
		this.entry.show();
	}

	public hide() {
		this.entry.hide();
	}
}

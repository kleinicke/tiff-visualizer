import * as vscode from 'vscode';
import { StatusBarEntryInterface } from './statusBarEntryInterface';

export class HistogramStatusBarEntry implements StatusBarEntryInterface {
	private readonly _statusBarEntry: vscode.StatusBarItem;
	private _isVisible: boolean = false;

	private readonly _onDidChangeVisibility = new vscode.EventEmitter<boolean>();
	public readonly onDidChangeVisibility = this._onDidChangeVisibility.event;

	constructor() {
		this._statusBarEntry = vscode.window.createStatusBarItem('tiffVisualizer.histogram', vscode.StatusBarAlignment.Right, 103);
		this._statusBarEntry.name = 'TIFF Visualizer Histogram';
		this._statusBarEntry.text = '$(graph)';
		this._statusBarEntry.tooltip = 'Toggle Histogram';
		this._statusBarEntry.command = 'tiffVisualizer.toggleHistogram';
	}

	public show(): void {
		// Temporarily hidden - keeping functionality for future use
		// this._statusBarEntry.show();
	}

	public hide(): void {
		this._statusBarEntry.hide();
	}

	public updateVisibility(isVisible: boolean): void {
		this._isVisible = isVisible;
		// Update icon to show active state
		if (isVisible) {
			this._statusBarEntry.text = '$(graph) $(check)';
			this._statusBarEntry.tooltip = 'Hide Histogram';
		} else {
			this._statusBarEntry.text = '$(graph)';
			this._statusBarEntry.tooltip = 'Show Histogram';
		}
		this._onDidChangeVisibility.fire(isVisible);
	}

	public getVisibility(): boolean {
		return this._isVisible;
	}

	public dispose(): void {
		this._statusBarEntry.dispose();
		this._onDidChangeVisibility.dispose();
	}
}

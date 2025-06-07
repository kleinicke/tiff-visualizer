/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export class PixelPositionStatusBarEntry implements vscode.Disposable {
	private readonly _entry: vscode.StatusBarItem;

	constructor() {
		this._entry = vscode.window.createStatusBarItem('image-preview.pixel-position', vscode.StatusBarAlignment.Right, 100);
	}

	public dispose(): void {
		this._entry.dispose();
	}

	public show(owner: unknown, text: string) {
		this._entry.text = text;
		this._entry.show();
	}

	public hide(owner: unknown) {
		this._entry.hide();
	}
} 
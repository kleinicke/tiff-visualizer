import * as vscode from 'vscode';
import { PreviewStatusBarEntry as OwnedStatusBarEntry } from '../ownedStatusBarEntry';


const selectZoomLevelCommandId = '_tiffVisualizer.selectZoomLevel';

export type Scale = number | 'fit';

export class ZoomStatusBarEntry extends OwnedStatusBarEntry {

	private readonly _onDidChangeScale = this._register(new vscode.EventEmitter<{ scale: Scale }>());
	public readonly onDidChangeScale = this._onDidChangeScale.event;

	constructor() {
		super('status.tiffVisualizer.zoom', vscode.l10n.t("Image Zoom"), vscode.StatusBarAlignment.Right, 110 /* to the left of image size (102) */);

		this._register(vscode.commands.registerCommand(selectZoomLevelCommandId, async () => {
			type MyPickItem = vscode.QuickPickItem & { scale: Scale };

			const scales: Scale[] = [10, 5, 2, 1, 0.5, 0.2, 'fit'];
			const options = scales.map((scale): MyPickItem => ({
				label: this.zoomLabel(scale),
				scale
			}));

			const pick = await vscode.window.showQuickPick(options, {
				placeHolder: vscode.l10n.t("Select zoom level")
			});
			if (pick) {
				this._onDidChangeScale.fire({ scale: pick.scale });
			}
		}));

		this.entry.command = selectZoomLevelCommandId;
	}

	public show(owner: unknown, scale: Scale) {
		this.showItem(owner, this.zoomLabel(scale));
	}

	private zoomLabel(scale: Scale): string {
		return scale === 'fit'
			? vscode.l10n.t("Whole Image")
			: `${Math.round(scale * 100)}%`;
	}
}

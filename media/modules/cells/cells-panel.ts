import CellsPanelComponent from '../../../ui/components/cells/CellsPanel.svelte';
import { mountView } from '../../../ui/mount.js';
import type { CellsPanelModel } from './cells-model.js';

export interface CellsPanelView {
	visible: boolean;
	cells: CellsPanelModel;
	close: () => void;
}

/** The floating Cells panel of the single-image viewer: the Cells section on its own. */
export class CellsPanel {
	private visible = false;
	private readonly view;

	constructor(private readonly getCells: () => CellsPanelModel, private readonly onVisibilityChange: (visible: boolean) => void) {
		this.view = mountView(CellsPanelComponent, this.snapshot());
	}

	private snapshot(): CellsPanelView { return { visible: this.visible, cells: this.getCells(), close: () => this.hide() }; }
	show(): void { this.set(true); }
	hide(): void { this.set(false); }
	toggle(): void { this.set(!this.visible); }
	isVisible(): boolean { return this.visible; }
	render(): void { this.view.update(this.snapshot()); }
	dispose(): void { this.view.dispose(); }

	private set(visible: boolean): void {
		if (visible === this.visible) { return; }
		this.visible = visible;
		this.render();
		this.onVisibilityChange(visible);
	}
}

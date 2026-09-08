import type { SettingsManager } from './settings-manager.js';
import type { TagEntry } from './tiff-tag-utils.js';
import Metadata from '../../ui/components/Metadata.svelte';
import { mountView } from '../../ui/mount.js';

export interface VsCodeApi {
	postMessage: (msg: any) => any;
}

export interface MetadataInfo {
	formatLabel: string;
	fileFields: Record<string, string>;
	tags: TagEntry[];
	stats: { min: number; max: number; mean: number; std: number; validCount: number; nonFiniteCount: number; totalCount: number } | null;
}


export interface MetadataModel {
  visible: boolean;
  info: MetadataInfo | null;
  close: () => void;
  formatNumber: (value: number) => string;
}

export class MetadataPanel {
  isVisible = false;
  lastInfo: MetadataInfo | null = null;
  private view;
  constructor(public settingsManager: SettingsManager, public vscode: VsCodeApi) {
    this.view = mountView(Metadata, this.snapshot());
  }
  private snapshot(): MetadataModel {
    return { visible: this.isVisible, info: this.lastInfo, close: () => this.hide(), formatNumber: value => this.formatNumber(value) };
  }
  show(skipNotification = false): void {
    this.isVisible = true;
    this.view.update(this.snapshot());
    if (!skipNotification) this.vscode.postMessage({ type: 'metadataVisibilityChanged', isVisible: true });
  }
  hide(skipNotification = false): void {
    this.isVisible = false;
    this.view.update(this.snapshot());
    if (!skipNotification) this.vscode.postMessage({ type: 'metadataVisibilityChanged', isVisible: false });
  }
  toggle(): void { if (this.isVisible) this.hide(); else this.show(); }
  getVisibility(): boolean { return this.isVisible; }
  render(info: MetadataInfo | null): void { this.lastInfo = info; this.view.update(this.snapshot()); }
  dispose(): void { this.view.dispose(); }
	formatNumber(value: number): string {
		if (!Number.isFinite(value)) { return String(value); }
		if (Math.abs(value) !== 0 && (Math.abs(value) < 0.001 || Math.abs(value) >= 100000)) {
			return value.toExponential(3);
		}
		return value.toPrecision(6).replace(/\.?0+$/, '') || '0';
	}

}

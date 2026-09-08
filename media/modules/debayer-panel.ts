import { DEFAULT_DEBAYER, type DebayerSettings } from './debayer.js';
import Debayer from '../../ui/components/Debayer.svelte';
import { mountView } from '../../ui/mount.js';

export interface DebayerModel {
  visible: boolean;
  settings: DebayerSettings;
  change: (patch: Partial<DebayerSettings>) => void;
  close: () => void;
}

/** Settings and engine callbacks stay outside the component. */
export class DebayerPanel {
  private visible = false;
  private settings: DebayerSettings = { ...DEFAULT_DEBAYER };
  private view;
  constructor(private onChange: (settings: DebayerSettings) => void) {
    this.view = mountView(Debayer, this.snapshot());
  }
  private snapshot(): DebayerModel {
    return { visible: this.visible, settings: this.getSettings(), close: () => this.hide(),
      change: patch => { this.setSettings(patch); this.onChange(this.getSettings()); } };
  }
  getSettings(): DebayerSettings { return { ...this.settings }; }
  setSettings(settings: Partial<DebayerSettings>): void {
    this.settings = { ...this.settings, ...settings };
    this.view.update(this.snapshot());
  }
  reportGains(gains: { r: number; g: number; b: number }): void {
    if (this.settings.autoWb) this.setSettings({ gainR: gains.r, gainG: gains.g, gainB: gains.b });
  }
  show(): void { this.visible = true; this.view.update(this.snapshot()); }
  hide(): void { this.visible = false; this.view.update(this.snapshot()); }
  isVisible(): boolean { return this.visible; }
  toggle(): void { if (this.visible) this.hide(); else this.show(); }
  dispose(): void { this.view.dispose(); }
}

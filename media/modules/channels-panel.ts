import { autoRange, channelStats, type ChannelPlane, type ChannelSettings } from './channel-composite.js';
import Channels from '../../ui/components/Channels.svelte';
import { mountView } from '../../ui/mount.js';

export interface ChannelsPanelHost {
	getPlanes: () => ChannelPlane[];
	getSettings: () => ChannelSettings[];
	setSettings: (settings: ChannelSettings[]) => void;
	isComposite: () => boolean;
	setComposite: (enabled: boolean) => void;
	getSolo: () => number | null;
	setSolo: (index: number | null) => void;
	/** Re-render the image with the current settings. */
	onChange: (options?: { interactive?: boolean }) => void;
	/** Which backend drew the last composite, for the status line. */
	getBackend?: () => 'webgpu' | 'cpu';
}


export interface ChannelsModel {
  visible: boolean;
  planes: { index: number; name: string; min: number; max: number }[];
  settings: ChannelSettings[];
  solo: number | null;
  composite: boolean;
  backend: string;
  close: () => void;
  toggleComposite: () => void;
  setSolo: (index: number) => void;
  update: (index: number, patch: Partial<ChannelSettings>, interactive?: boolean) => void;
  range: (index: number | null, auto: boolean) => void;
  showAll: () => void;
}
export class ChannelsPanel {
  private visible = false;
  private sourcePlanes: ChannelPlane[] | null = null;
  private planeDescriptors: ChannelsModel['planes'] = [];
  private view;
  constructor(private host: ChannelsPanelHost) { this.view = mountView(Channels, this.snapshot(false)); }
  private snapshot(readHost = true): ChannelsModel {
    const planes = readHost ? this.host.getPlanes() : [];
    if (planes !== this.sourcePlanes) {
      this.sourcePlanes = planes;
      this.planeDescriptors = planes.map(plane => ({ index: plane.index, name: plane.name,
        ...channelStats(plane, Math.max(1, Math.floor(plane.data.length / 200_000))) }));
    }
    return {
      visible: this.visible,
      // Only small UI descriptors cross the bridge, never reactive pixel buffers.
      planes: this.planeDescriptors,
      settings: this.host.getSettings(), solo: this.host.getSolo(), composite: this.host.isComposite(),
      backend: this.host.getBackend?.() ?? 'cpu', close: () => this.hide(),
      toggleComposite: () => { this.host.setComposite(!this.host.isComposite()); this.render(); },
      setSolo: index => { this.host.setSolo(this.host.getSolo() === index ? null : index); this.host.onChange(); this.render(); },
      update: (index, patch, interactive) => {
        const settings = this.host.getSettings().slice();
        settings[index] = { ...settings[index], ...patch };
        this.host.setSettings(settings); this.host.onChange({ interactive }); this.render();
      },
      range: (index, auto) => {
        const planes = this.host.getPlanes();
        this.host.setSettings(this.host.getSettings().map((setting, i) => {
          if (index !== null && index !== i) return setting;
          const range = auto ? autoRange(planes[i]) : channelStats(planes[i]);
          return { ...setting, min: range.min, max: range.max };
        }));
        this.host.onChange(); this.render();
      },
      showAll: () => {
        this.host.setSolo(null);
        this.host.setSettings(this.host.getSettings().map(setting => ({ ...setting, visible: true })));
        this.host.onChange(); this.render();
      },
    };
  }
  show(): void { this.visible = true; this.render(); }
  hide(): void { this.visible = false; this.render(); }
  isVisible(): boolean { return this.visible; }
  toggle(): void { if (this.visible) this.hide(); else this.show(); }
  render(): void { this.view.update(this.snapshot()); }
  dispose(): void { this.view.dispose(); }
}

import { autoRange, channelStats, type ChannelPlane, type ChannelSettings, type ResolvedChannelGroup } from './channel-composite.js';
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
	/** Progress or failure text while the planes are not (all) available. */
	getStatus?: () => string | null;
	/**
	 * The channel the selector overlay is showing, when the image has one and
	 * the composite is off; null when there is no such link.
	 */
	getCurrentChannel?: () => number | null;
	/** Show one channel through the selector overlay. False when there is no selector to drive. */
	selectChannel?: (index: number) => boolean;
	/** The configured groups, matched against the current channels. */
	getGroups?: () => ResolvedChannelGroup[];
	getGroupSolo?: () => string | null;
	/** Solo a whole group (or clear it with null). Exclusive with a single-channel solo. */
	setGroupSolo?: (name: string | null) => void;
}

export interface ChannelGroupRow {
  name: string;
  total: number;
  found: number;
  /** How many of the matched channels are switched on. */
  on: number;
  missing: string[];
  /** Positions of the matched channels, for filtering the list. */
  positions: number[];
  /** Of the matched channels: all, some or none are switched on. */
  state: 'all' | 'some' | 'none';
  soloed: boolean;
}


export interface ChannelsModel {
  visible: boolean;
  planes: { index: number; name: string; min: number; max: number }[];
  settings: ChannelSettings[];
  solo: number | null;
  composite: boolean;
  backend: string;
  status: string | null;
  /** The channel the selector shows (single-channel view), or null. */
  current: number | null;
  groups: ChannelGroupRow[];
  close: () => void;
  toggleComposite: () => void;
  setSolo: (index: number) => void;
  update: (index: number, patch: Partial<ChannelSettings>, interactive?: boolean) => void;
  range: (index: number | null, auto: boolean) => void;
  selectAll: () => void;
  deselectAll: () => void;
  toggleGroup: (name: string) => void;
  soloGroup: (name: string) => void;
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
    const settings = this.host.getSettings();
    const groupSolo = readHost ? this.host.getGroupSolo?.() ?? null : null;
    const groups: ChannelGroupRow[] = (readHost ? this.host.getGroups?.() ?? [] : []).map(group => {
      const on = group.positions.filter(position => settings[position]?.visible).length;
      return {
        name: group.name, total: group.total, found: group.positions.length, on, missing: group.missing, positions: group.positions,
        state: on === 0 ? 'none' : on === group.positions.length ? 'all' : 'some',
        soloed: groupSolo === group.name,
      };
    });
    return {
      visible: this.visible,
      // Only small UI descriptors cross the bridge, never reactive pixel buffers.
      planes: this.planeDescriptors,
      groups, settings, solo: this.host.getSolo(), composite: this.host.isComposite(),
      backend: this.host.getBackend?.() ?? 'cpu', status: this.host.getStatus?.() ?? null,
      current: readHost && !this.host.isComposite() ? this.host.getCurrentChannel?.() ?? null : null, close: () => this.hide(),
      toggleComposite: () => { this.host.setComposite(!this.host.isComposite()); this.render(); },
      setSolo: index => {
        // Without the composite there is nothing to solo: the button chooses
        // which channel the selector shows, so panel and selector agree.
        if (!this.host.isComposite() && this.host.selectChannel?.(index)) { this.render(); return; }
        this.host.setSolo(this.host.getSolo() === index ? null : index); this.host.onChange(); this.render(); },
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
      selectAll: () => this.setAllVisible(true),
      deselectAll: () => this.setAllVisible(false),
      toggleGroup: name => {
        // From "none" or "some" everything in the group goes on; from "all" it goes off.
        const group = this.host.getGroups?.().find(entry => entry.name === name);
        if (!group || !group.positions.length) return;
        const settings = this.host.getSettings();
        const target = !group.positions.every(position => settings[position]?.visible);
        this.host.setSettings(settings.map((setting, position) => group.positions.includes(position) ? { ...setting, visible: target } : setting));
        this.host.onChange(); this.render();
      },
      soloGroup: name => {
        this.host.setGroupSolo?.(this.host.getGroupSolo?.() === name ? null : name);
        this.host.onChange(); this.render();
      },
    };
  }
  /** Switch every channel on or off, and drop any solo so the result is what it says. */
  private setAllVisible(visible: boolean): void {
    this.host.setSolo(null);
    this.host.setGroupSolo?.(null);
    this.host.setSettings(this.host.getSettings().map(setting => ({ ...setting, visible })));
    this.host.onChange(); this.render();
  }
  show(): void { this.visible = true; this.render(); }
  hide(): void { this.visible = false; this.render(); }
  isVisible(): boolean { return this.visible; }
  toggle(): void { if (this.visible) this.hide(); else this.show(); }
  render(): void { this.view.update(this.snapshot()); }
  dispose(): void { this.view.dispose(); }
}

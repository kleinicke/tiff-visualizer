import type { DisplaySettings } from './display-settings';

export type DebayerAlgorithm = 'nearest' | 'bilinear' | 'malvar';
export type DebayerView = 'rgb' | 'r' | 'g' | 'b' | 'i' | 'mosaic';

export interface DebayerSettings {
    enabled: boolean;
    pattern: string;
    algorithm: DebayerAlgorithm;
    offsetX: number;
    offsetY: number;
    view: DebayerView;
    autoWb: boolean;
    gainR: number;
    gainG: number;
    gainB: number;
    /** Sensor black level in raw units; 0 with whiteLevel 0 disables levelling. */
    blackLevel: number;
    whiteLevel: number;
}

/** User defaults for the Channels panel (`tiffVisualizer.channels.*`). */
export interface ChannelDefaults {
    /** Open images whose channels come from OME/ImageJ metadata in composite mode. */
    autoComposite?: boolean;
    /** Tint by channel name, matched case-insensitively, e.g. { "DAPI": "#3399ff" }. */
    colorsByName?: Record<string, string>;
    /** Tint by 1-based channel number, as the panel labels them, e.g. { "1": "#00ff00" }. */
    colorsByNumber?: Record<string, string>;
    /** Named channel groups; members are channel names or 1-based numbers. Validated by the viewer. */
    groups?: Record<string, unknown>;
}

export interface ImageSettings extends Partial<DisplaySettings> {
  nanColor?: string;
  displayColormap?: string;
  debayer?: DebayerSettings;
  colorPickerShowModified?: boolean;
  /** Session-wide idle scale bar visibility, owned by the extension host. */
  showScaleBar?: boolean;
  gpuAcceleration?: boolean;
  navigationShortcuts?: Record<string, string[]>;
  channelDefaults?: ChannelDefaults;
  /** Experimental: read rectangles out of large tiled TIFFs. See viewport-tiles.ts. */
  experimentalRegionDecode?: boolean;
  plyVisualizerInstalled?: boolean;
  resourceUri?: string;
  src?: string;
	/** Original HTTP(S) TIFF URL; activates the range-backed byte source. */
	remoteTiffUrl?: string;
	/** Content-derived registry hint; overrides a missing or misleading suffix. */
	formatHint?: string;
  loadStartTime?: number;
  surfaceMode?: 'editor' | 'layers';
  extensionVersion?: string;
  vscodeVersion?: string;
}


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

export interface ImageSettings extends Partial<DisplaySettings> {
  nanColor?: string;
  displayColormap?: string;
  debayer?: DebayerSettings;
  colorPickerShowModified?: boolean;
  /** Session-wide idle scale bar visibility, owned by the extension host. */
  showScaleBar?: boolean;
  gpuAcceleration?: boolean;
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


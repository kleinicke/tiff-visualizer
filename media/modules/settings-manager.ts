"use strict";

export interface NormalizationSettings {
  min: number;
  max: number;
  autoNormalize: boolean;
  gammaMode: boolean;
}

export interface GammaSettings {
  in: number;
  out: number;
}

export interface BrightnessSettings {
  offset: number;
}

export interface ImageSettings {
  normalization?: NormalizationSettings;
  gamma?: GammaSettings;
  brightness?: BrightnessSettings;
  nanColor?: string;
  displayColormap?: string;
  rgbAs24BitGrayscale?: boolean;
  scale24BitFactor?: number;
  normalizedFloatMode?: boolean;
  colorPickerShowModified?: boolean;
  gpuAcceleration?: boolean;
  plyVisualizerInstalled?: boolean;
  resourceUri?: string;
  src?: string;
  loadStartTime?: number;
  jxlWasmSrc?: string;
  rawWorkerSrc?: string;
  rawWasmSrc?: string;
  surfaceMode?: 'editor' | 'layers';
}

export interface SettingsConstants {
  PIXELATION_THRESHOLD: number;
  SCALE_PINCH_FACTOR: number;
  MAX_SCALE: number;
  MIN_SCALE: number;
  ZOOM_LEVELS: number[];
}

export interface SettingsUpdateResult {
  changed: boolean;
  changedKeys: string[];
  parametersOnly: boolean;
  changedStructure: boolean;
}

/**
 * Settings Manager Module
 * Handles application settings and configuration
 */
export class SettingsManager {
  private _settings: ImageSettings;
  private _constants: SettingsConstants;
  private _isMac: boolean;

  constructor() {
    this._settings = this._loadSettings();
    this._constants = {
      PIXELATION_THRESHOLD: 3,
      SCALE_PINCH_FACTOR: 0.075,
      MAX_SCALE: 200,
      MIN_SCALE: 0.1,
      ZOOM_LEVELS: [
        0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.5, 2, 3, 5, 7, 10, 15,
        20, 30, 50, 70, 100, 200,
      ],
    };
    this._isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  }

  /**
   * Load settings from the DOM
   */
  private _loadSettings(): ImageSettings {
    const element = document.getElementById("image-preview-settings");
    if (element) {
      const data = element.getAttribute("data-settings");
      if (data) {
        return JSON.parse(data);
      }
    }
    throw new Error("Could not load settings");
  }

  /**
   * Get application settings
   */
  get settings(): ImageSettings {
    return this._settings;
  }

  /**
   * Get application constants
   */
  get constants(): SettingsConstants {
    return this._constants;
  }

  /**
   * Check if running on Mac
   */
  get isMac(): boolean {
    return this._isMac;
  }

  /**
   * Update settings from new data (for real-time updates)
   * @param newSettings - New settings object
   * @returns What changed
   */
  updateSettings(newSettings: ImageSettings): SettingsUpdateResult {
    if (!newSettings) {
      return { changed: false, changedKeys: [], parametersOnly: false, changedStructure: false };
    }

    // Track what changed
    const changes: SettingsUpdateResult = {
      changed: false,
      changedKeys: [],
      parametersOnly: false,
      changedStructure: false
    };

    // Check if only parameters changed (gamma, brightness, normalization ranges)
    const oldSettings = this._settings;

    // Check parameter changes
    const gammaChanged = newSettings.gamma !== undefined &&
      JSON.stringify(oldSettings.gamma) !== JSON.stringify(newSettings.gamma);
    const brightnessChanged = newSettings.brightness !== undefined &&
      JSON.stringify(oldSettings.brightness) !== JSON.stringify(newSettings.brightness);
    const normRangeChanged = newSettings.normalization !== undefined &&
      (oldSettings.normalization?.min !== newSettings.normalization.min ||
        oldSettings.normalization?.max !== newSettings.normalization.max);
    const normAutoChanged = newSettings.normalization !== undefined &&
      oldSettings.normalization?.autoNormalize !== newSettings.normalization.autoNormalize;
    const normGammaModeChanged = newSettings.normalization !== undefined &&
      oldSettings.normalization?.gammaMode !== newSettings.normalization.gammaMode;

    // Check structural changes
    const rgbModeChanged = newSettings.rgbAs24BitGrayscale !== undefined &&
      oldSettings.rgbAs24BitGrayscale !== newSettings.rgbAs24BitGrayscale;
    const scaleModeChanged = newSettings.scale24BitFactor !== undefined &&
      oldSettings.scale24BitFactor !== newSettings.scale24BitFactor;
    const floatModeChanged = newSettings.normalizedFloatMode !== undefined &&
      oldSettings.normalizedFloatMode !== newSettings.normalizedFloatMode;
    const nanColorChanged = newSettings.nanColor !== undefined &&
      (oldSettings.nanColor ?? 'black') !== newSettings.nanColor;
    const displayColormapChanged = newSettings.displayColormap !== undefined &&
      (oldSettings.displayColormap ?? 'none') !== newSettings.displayColormap;

    const colorPickerModeChanged = newSettings.colorPickerShowModified !== undefined &&
      oldSettings.colorPickerShowModified !== newSettings.colorPickerShowModified;

    const changedFields: [boolean, string][] = [
      [gammaChanged, 'gamma'],
      [brightnessChanged, 'brightness'],
      [normRangeChanged, 'normalization.range'],
      [normAutoChanged, 'normalization.auto'],
      [normGammaModeChanged, 'normalization.gammaMode'],
      [rgbModeChanged, 'rgbAs24BitGrayscale'],
      [scaleModeChanged, 'scale24BitFactor'],
      [floatModeChanged, 'normalizedFloatMode'],
      [nanColorChanged, 'nanColor'],
      [displayColormapChanged, 'displayColormap'],
      [colorPickerModeChanged, 'colorPickerShowModified'],
    ];
    changes.changedKeys = changedFields.filter(([changed]) => changed).map(([, key]) => key);
    changes.changed = changes.changedKeys.length > 0;

    if (rgbModeChanged || scaleModeChanged || floatModeChanged) {
      changes.changedStructure = true;
    }

    // If only gamma, brightness, normalization ranges, nanColor, or colorPickerMode changed, it's parameters-only
    if (changes.changed &&
      ((gammaChanged || brightnessChanged || normRangeChanged || normAutoChanged || normGammaModeChanged || nanColorChanged || displayColormapChanged || colorPickerModeChanged) &&
        !rgbModeChanged && !scaleModeChanged && !floatModeChanged)) {
      changes.parametersOnly = true;
    } else if (changes.changedStructure) {
      console.log('⚠️ Structural changes detected:', {
        rgbModeChanged,
        scaleModeChanged,
        floatModeChanged,
        nanColorChanged
      });
    }

    // Deep merge to ensure nested objects are fully replaced
    this._settings = {
      ...this._settings,
      ...newSettings,
      normalization: newSettings.normalization
        ? { ...newSettings.normalization }
        : this._settings.normalization,
      gamma: newSettings.gamma
        ? { ...newSettings.gamma }
        : this._settings.gamma,
      brightness: newSettings.brightness
        ? { ...newSettings.brightness }
        : this._settings.brightness,
    };

    return changes;
  }
}

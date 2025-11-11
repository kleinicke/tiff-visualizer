// @ts-check
"use strict";

/**
 * @typedef {Object} NormalizationSettings
 * @property {number} min
 * @property {number} max
 * @property {boolean} autoNormalize
 * @property {boolean} gammaMode
 */

/**
 * @typedef {Object} GammaSettings
 * @property {number} in
 * @property {number} out
 */

/**
 * @typedef {Object} BrightnessSettings
 * @property {number} offset
 */

/**
 * @typedef {Object} MaskFilterSettings
 * @property {string} maskUri
 * @property {number} threshold
 * @property {boolean} filterHigher
 * @property {boolean} enabled
 */

/**
 * @typedef {Object} ImageSettings
 * @property {NormalizationSettings} [normalization]
 * @property {GammaSettings} [gamma]
 * @property {BrightnessSettings} [brightness]
 * @property {MaskFilterSettings[]} [maskFilters]
 * @property {string} [nanColor]
 * @property {boolean} [rgbAs24BitGrayscale]
 * @property {number} [scale24BitFactor]
 * @property {boolean} [normalizedFloatMode]
 * @property {boolean} [colorPickerShowModified]
 * @property {string} [resourceUri]
 * @property {string} [src]
 */

/**
 * Settings Manager Module
 * Handles application settings and configuration
 */
export class SettingsManager {
  constructor() {
    /** @type {ImageSettings} */
    this._settings = this._loadSettings();
    /** @type {{PIXELATION_THRESHOLD: number, SCALE_PINCH_FACTOR: number, MAX_SCALE: number, MIN_SCALE: number, ZOOM_LEVELS: number[]}} */
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
    /** @type {boolean} */
    this._isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  }

  /**
   * Load settings from the DOM
   * @private
   * @returns {ImageSettings}
   */
  _loadSettings() {
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
   * @returns {ImageSettings}
   */
  get settings() {
    return this._settings;
  }

  /**
   * Get application constants
   * @returns {{PIXELATION_THRESHOLD: number, SCALE_PINCH_FACTOR: number, MAX_SCALE: number, MIN_SCALE: number, ZOOM_LEVELS: number[]}}
   */
  get constants() {
    return this._constants;
  }

  /**
   * Check if running on Mac
   * @returns {boolean}
   */
  get isMac() {
    return this._isMac;
  }

  /**
   * Update settings from new data (for real-time updates)
   * @param {ImageSettings} newSettings - New settings object
   * @returns {{parametersOnly: boolean, changedMasks: boolean, changedStructure: boolean}} - What changed
   */
  updateSettings(newSettings) {
    if (!newSettings) {
      return { parametersOnly: false, changedMasks: false, changedStructure: false };
    }

    // Track what changed
    const changes = {
      parametersOnly: false,
      changedMasks: false,
      changedStructure: false
    };

    // Check if only parameters changed (gamma, brightness, normalization ranges)
    const oldSettings = this._settings;

    // Check parameter changes
    const gammaChanged = JSON.stringify(oldSettings.gamma) !== JSON.stringify(newSettings.gamma);
    const brightnessChanged = JSON.stringify(oldSettings.brightness) !== JSON.stringify(newSettings.brightness);
    const normRangeChanged = oldSettings.normalization?.min !== newSettings.normalization?.min ||
                             oldSettings.normalization?.max !== newSettings.normalization?.max;
    const normAutoChanged = oldSettings.normalization?.autoNormalize !== newSettings.normalization?.autoNormalize;
    const normGammaModeChanged = oldSettings.normalization?.gammaMode !== newSettings.normalization?.gammaMode;

    // Check structural changes
    const masksChanged = JSON.stringify(oldSettings.maskFilters) !== JSON.stringify(newSettings.maskFilters);
    const rgbModeChanged = oldSettings.rgbAs24BitGrayscale !== newSettings.rgbAs24BitGrayscale;
    const scaleModeChanged = oldSettings.scale24BitFactor !== newSettings.scale24BitFactor;
    const floatModeChanged = oldSettings.normalizedFloatMode !== newSettings.normalizedFloatMode;
    const nanColorChanged = oldSettings.nanColor !== newSettings.nanColor;

    // Determine change type
    if (masksChanged) {
      changes.changedMasks = true;
    }

    if (rgbModeChanged || scaleModeChanged || floatModeChanged) {
      changes.changedStructure = true;
    }

    // Determine if anything changed at all
    const somethingChanged = gammaChanged || brightnessChanged || normRangeChanged ||
                             normAutoChanged || normGammaModeChanged || masksChanged ||
                             rgbModeChanged || scaleModeChanged || floatModeChanged || nanColorChanged;

    // If only gamma, brightness, or normalization ranges changed, it's parameters-only
    // Also treat "no changes" as parameters-only to avoid unnecessary slow path
    if (!somethingChanged ||
        ((gammaChanged || brightnessChanged || normRangeChanged || normAutoChanged || normGammaModeChanged) &&
         !masksChanged && !rgbModeChanged && !scaleModeChanged && !floatModeChanged && !nanColorChanged)) {
      changes.parametersOnly = true;
    } else {
      console.log('⚠️ Structural changes detected:', {
        masksChanged,
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
      maskFilters: newSettings.maskFilters
        ? [...newSettings.maskFilters]
        : this._settings.maskFilters,
    };

    return changes;
  }
}

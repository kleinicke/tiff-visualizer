// @ts-check
"use strict";

import { COLORMAP_TABLES } from './colormap-converter.js';

/**
 * Helper class for normalization, gamma, and brightness corrections.
 * Centralizes logic for range calculation and LUT generation.
 */
export class NormalizationHelper {
    /**
     * Calculate the normalization range (min/max) based on settings and stats.
     * @param {Object} settings - Image settings
     * @param {Object} stats - Image statistics {min, max}
     * @param {number} typeMax - Maximum value for the data type (e.g., 255, 65535, or 1.0 for float)
     * @param {boolean} isFloat - Whether the image data is floating point
     * @returns {{min: number, max: number}} Calculated min/max range
     */
    static getNormalizationRange(settings, stats, typeMax, isFloat = false) {
        let normMin, normMax;

        if (settings.normalization && settings.normalization.autoNormalize) {
            // Auto-normalize: use stats
            // Fallback to 0-typeMax if stats are missing/invalid
            normMin = (stats && Number.isFinite(stats.min)) ? stats.min : 0;
            normMax = (stats && Number.isFinite(stats.max)) ? stats.max : typeMax;
        } else if (settings.normalization && settings.normalization.gammaMode) {
            // Gamma mode: use full range of the type
            normMin = 0;
            normMax = typeMax;
        } else if (settings.normalization && (settings.normalization.min !== undefined && settings.normalization.max !== undefined)) {
            // Manual mode: use user-specified range
            normMin = settings.normalization.min;
            normMax = settings.normalization.max;

            // If normalized float mode is enabled for integer images, scale up the range
            // (User provides 0.0-1.0, we map to 0-typeMax)
            if (settings.normalizedFloatMode && !isFloat) {
                normMin *= typeMax;
                normMax *= typeMax;
            }
        } else {
            // Default fallback (usually behaves like gamma mode)
            normMin = 0;
            normMax = typeMax;
        }

        return { min: normMin, max: normMax };
    }

    /**
     * Apply gamma (power-law) and brightness corrections to a normalized value (0-1).
     *
     * Uses the standard napari-style power-law transform:
     *   output = clamp(normalized, 0, 1) ^ gamma   *   2^exposure
     *
     * where `gamma` is settings.gamma.out (gamma.in is unused and kept at 1.0).
     *
     * Behaviour:
     *   gamma = 1.0  → no change (identity)
     *   gamma < 1.0  → brighter midtones (e.g. 0.5 → sqrt, lifts shadows)
     *   gamma > 1.0  → darker midtones  (e.g. 2.0 → square, crushes shadows)
     *
     * Applied AFTER range normalization, so it never affects the min/max settings.
     *
     * @param {number} normalized - Value already mapped to [0, 1] by the range step
     * @param {Object} settings   - Settings object with gamma and brightness
     * @returns {number} Corrected value (may be outside [0,1] due to brightness)
     */
    static applyGammaAndBrightness(normalized, settings) {
        const gamma = settings.gamma?.out ?? 1.0;
        const exposureStops = settings.brightness?.offset ?? 0;

        // Clamp to [0,1] before power — pow(negative, fractional) is NaN
        const clamped = Math.max(0, Math.min(1, normalized));

        // Power-law transform (napari convention): output = input ^ gamma
        const powered = gamma !== 1.0 ? Math.pow(clamped, gamma) : clamped;

        // Exposure (brightness): multiply by 2^stops in linear space
        return powered * Math.pow(2, exposureStops);
    }

    /**
     * Generate a lookup table for gamma and brightness corrections.
     * @param {Object} settings - Settings object
     * @param {number} bitDepth - Bit depth (8 or 16)
     * @param {number} maxValue - Maximum input value (255 or 65535)
     * @param {number} normMin - Normalization minimum
     * @param {number} normMax - Normalization maximum
     * @returns {Uint8Array} LUT array mapping input values to output 0-255
     */
    static generateLut(settings, bitDepth, maxValue, normMin, normMax) {
        const perfStart = performance.now();
        const lutSize = maxValue + 1;
        const lut = new Uint8Array(lutSize);
        const range = normMax - normMin;
        const invRange = range > 0 ? 1.0 / range : 0;

        for (let i = 0; i < lutSize; i++) {
            // Map input value to normalized float range
            const value = i;
            let normalized = (value - normMin) * invRange;

            // Apply gamma and brightness
            normalized = this.applyGammaAndBrightness(normalized, settings);

            // Clamp and convert to 0-255
            const output = Math.round(Math.max(0, Math.min(1, normalized)) * 255);
            lut[i] = output;
        }

        console.log(`[LUT] ${bitDepth}-bit LUT generation took ${(performance.now() - perfStart).toFixed(2)}ms`);
        return lut;
    }

    /**
     * Check if the transformation is identity (gamma=1, brightness=0).
     * Identity means the output equals the normalised input with no adjustment.
     * @param {Object} settings - Settings object
     * @returns {boolean} True if identity transformation
     */
    static isIdentityTransformation(settings) {
        const gamma = settings.gamma?.out ?? 1.0;
        const exposureStops = settings.brightness?.offset ?? 0;

        return Math.abs(gamma - 1.0) < 0.001 &&
            Math.abs(exposureStops) < 0.001;
    }

    /**
     * Calculate the effective input range that maps to the visible output range (0-1).
     * Values outside this range will be clipped to 0 or 1.
     * This allows skipping expensive calculations for clipped pixels.
     * 
     * @param {Object} settings - Image settings
     * @param {number} normMin - Normalization minimum
     * @param {number} normMax - Normalization maximum
     * @returns {{min: number, max: number}} Effective input range
     */
    static getEffectiveVisualizationRange(settings, normMin, normMax) {
        const gamma = settings.gamma?.out ?? 1.0;
        const exposureStops = settings.brightness?.offset ?? 0;
        const range = normMax - normMin;

        // If identity transform, effective range is just the normalization range
        if (this.isIdentityTransformation(settings)) {
            return { min: normMin, max: normMax };
        }

        // Forward transform (napari power-law):
        //   1. normalized = (V - normMin) / range
        //   2. powered    = clamp(normalized, 0, 1) ^ gamma
        //   3. output     = powered * 2^exposure
        //
        // Reversing for output = 0:  V = normMin  (0^gamma * anything = 0)
        const vMin = normMin;

        // Reversing for output = 1:
        //   powered * 2^exposure = 1  =>  powered = 2^(-exposure)
        //   normalized^gamma = 2^(-exposure)  =>  normalized = 2^(-exposure/gamma)
        //   V = normalized * range + normMin
        const normalizedThreshold = Math.pow(2, -exposureStops / (gamma > 0 ? gamma : 1.0));
        const vMax = normalizedThreshold * range + normMin;

        return { min: vMin, max: vMax };
    }
}

/**
 * Centralized statistics calculator for image data.
 * Eliminates duplication across processors.
 */
export class ImageStatsCalculator {
    /**
     * Calculate min/max statistics for float data.
     * @param {Float32Array} data - Image data
     * @param {number} width - Image width  
     * @param {number} height - Image height
     * @param {number} channels - Number of channels
     * @returns {{min: number, max: number}} Statistics
     */
    static calculateFloatStats(data, width, height, channels) {
        const perfStart = performance.now();
        let minVal = Infinity;
        let maxVal = -Infinity;

        const len = width * height;
        for (let i = 0; i < len; i++) {
            for (let c = 0; c < Math.min(channels, 3); c++) {
                const val = data[i * channels + c];
                if (Number.isFinite(val)) {
                    if (val < minVal) minVal = val;
                    if (val > maxVal) maxVal = val;
                }
            }
        }

        console.log(`[Stats] Float stats calculation took ${(performance.now() - perfStart).toFixed(2)}ms`);
        return { min: minVal, max: maxVal };
    }

    /**
     * Calculate min/max statistics for integer data.
     * @param {Uint8Array|Uint16Array} data - Image data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} channels - Number of channels
     * @returns {{min: number, max: number}} Statistics
     */
    static calculateIntegerStats(data, width, height, channels) {
        let minVal = Infinity;
        let maxVal = -Infinity;

        const len = width * height;
        for (let i = 0; i < len; i++) {
            for (let c = 0; c < Math.min(channels, 3); c++) {
                const val = data[i * channels + c];
                if (val < minVal) minVal = val;
                if (val > maxVal) maxVal = val;
            }
        }

        return { min: minVal, max: maxVal };
    }
}

/**
 * Centralized image renderer for all data types (uint8, uint16, float32).
 * Handles normalization, gamma/brightness correction, and NaN handling.
 */
export class ImageRenderer {
    /**
     * Render typed array to ImageData with normalization and corrections.
     * @param {Uint8Array|Uint16Array|Float32Array|Float16Array} data - Image data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} channels - Number of channels (1, 3, or 4)
     * @param {boolean} isFloat - Whether data is floating point (float16 or float32)
     * @param {{min: number, max: number}} stats - Image statistics
     * @param {Object} settings - Normalization/gamma/brightness settings
     * @param {Object} [options={}] - Additional options { nanColor }
     * @returns {ImageData} Rendered image data
     */
    static render(data, width, height, channels, isFloat, stats, settings, options = {}) {
        const perfStart = performance.now();
        const result = this._renderInternal(data, width, height, channels, isFloat, stats, settings, options);

        if (options.flipY) {
            const flipped = this._flipY(result);
            console.log(`[Render] Total render time: ${(performance.now() - perfStart).toFixed(2)}ms (with flip)`);
            return flipped;
        }
        console.log(`[Render] Total render time: ${(performance.now() - perfStart).toFixed(2)}ms`);
        return result;
    }

    static _renderInternal(data, width, height, channels, isFloat, stats, settings, options = {}) {
        // Include colormap from settings if not in options
        if (options.colormap === undefined && settings.colormap) {
            options = { ...options, colormap: settings.colormap };
        }

        // Determine typeMax based on data type
        let typeMax;
        if (options.typeMax !== undefined) {
            typeMax = options.typeMax;
        } else if (isFloat) {
            typeMax = 1.0;
        } else if (data instanceof Uint16Array) {
            typeMax = 65535;
        } else {
            typeMax = 255;
        }

        // Check mode first
        const isGammaMode = settings.normalization?.gammaMode || false;

        // Early optimization: In gamma mode with identity transform, skip stats calculation
        // and use full type range directly (no need for actual data min/max)
        const isIdentity = NormalizationHelper.isIdentityTransformation(settings);

        let min, max;
        if (isGammaMode && isIdentity) {
            // Gamma mode + identity: use full type range, no stats needed
            min = 0;
            max = typeMax;
        } else {
            // Other modes: need to calculate proper normalization range from stats
            const range = NormalizationHelper.getNormalizationRange(
                settings, stats, typeMax, isFloat
            );
            min = range.min;
            max = range.max;
        }

        if (isGammaMode && isIdentity) {
            // Fast path: gamma mode with no actual gamma/brightness correction — just normalize
            if (isFloat) {
                return this._renderFloatDirect(data, width, height, channels, min, max, options);
            } else if (data instanceof Uint16Array) {
                return this._renderUint16Direct(data, width, height, channels, min, max);
            } else {
                return this._renderUint8Direct(data, width, height, channels, min, max);
            }
        } else if (!isIdentity) {
            // Non-identity gamma/brightness: apply LUT regardless of range mode
            // This ensures gamma works even when the user sets a manual min/max range
            if (isFloat) {
                return this._renderFloatWithLUT(data, width, height, channels, min, max, settings, options);
            } else if (data instanceof Uint16Array) {
                return this._renderUint16WithLUT(data, width, height, channels, min, max, settings, options);
            } else {
                return this._renderUint8WithLUT(data, width, height, channels, min, max, settings, options);
            }
        } else {
            // Manual range, identity transform: direct normalization only
            if (isFloat) {
                return this._renderFloatDirect(data, width, height, channels, min, max, options);
            } else if (data instanceof Uint16Array) {
                return this._renderUint16Direct(data, width, height, channels, min, max, options);
            } else {
                return this._renderUint8Direct(data, width, height, channels, min, max, options);
            }
        }
    }

    /**
     * Flip ImageData vertically
     * @param {ImageData} imageData 
     * @returns {ImageData}
     */
    static _flipY(imageData) {
        const width = imageData.width;
        const height = imageData.height;
        const data = imageData.data;
        const lineSize = width * 4;
        const tempLine = new Uint8ClampedArray(lineSize);

        for (let y = 0; y < height / 2; y++) {
            const topOffset = y * lineSize;
            const bottomOffset = (height - 1 - y) * lineSize;

            // Copy top line to temp
            tempLine.set(data.subarray(topOffset, topOffset + lineSize));

            // Copy bottom to top
            data.copyWithin(topOffset, bottomOffset, bottomOffset + lineSize);

            // Copy temp to bottom
            data.set(tempLine, bottomOffset);
        }
        return imageData;
    }


    /**
     * Render float32 data directly (no gamma/brightness, just normalization).
     * Used in non-gamma mode or identity transform in gamma mode.
     * @private
     */
    static _renderFloatDirect(data, width, height, channels, min, max, options) {
        const out = new Uint8ClampedArray(width * height * 4);
        const nanColor = options.nanColor || { r: 255, g: 0, b: 255 }; // Magenta default
        const range = max - min;
        const invRange = range > 0 ? 1.0 / range : 0;

        for (let i = 0; i < width * height; i++) {
            let r, g, b;

            if (channels === 1) {
                const value = data[i];
                if (!Number.isFinite(value)) {
                    r = nanColor.r;
                    g = nanColor.g;
                    b = nanColor.b;
                } else {
                    const normalized = (value - min) * invRange;
                    if (normalized < 0 || normalized > 1) {
                        r = g = b = 0;
                    } else {
                        const intensity = Math.round(normalized * 255);
                        if (options.colormap && COLORMAP_TABLES[options.colormap]) {
                            const entry = COLORMAP_TABLES[options.colormap][intensity];
                            r = entry[0]; g = entry[1]; b = entry[2];
                        } else {
                            r = g = b = intensity;
                        }
                    }
                }
            } else if (channels === 3) {
                const idx = i * 3;
                const rVal = data[idx];
                const gVal = data[idx + 1];
                const bVal = data[idx + 2];

                if (!Number.isFinite(rVal) || !Number.isFinite(gVal) || !Number.isFinite(bVal)) {
                    r = nanColor.r;
                    g = nanColor.g;
                    b = nanColor.b;
                } else {
                    const rNorm = (rVal - min) * invRange;
                    const gNorm = (gVal - min) * invRange;
                    const bNorm = (bVal - min) * invRange;
                    r = (rNorm < 0 || rNorm > 1) ? 0 : Math.round(rNorm * 255);
                    g = (gNorm < 0 || gNorm > 1) ? 0 : Math.round(gNorm * 255);
                    b = (bNorm < 0 || bNorm > 1) ? 0 : Math.round(bNorm * 255);
                }
            } else if (channels === 4) {
                const idx = i * 4;
                const rVal = data[idx];
                const gVal = data[idx + 1];
                const bVal = data[idx + 2];
                const aVal = data[idx + 3];

                if (!Number.isFinite(rVal) || !Number.isFinite(gVal) || !Number.isFinite(bVal)) {
                    r = nanColor.r;
                    g = nanColor.g;
                    b = nanColor.b;
                } else {
                    const rNorm = (rVal - min) * invRange;
                    const gNorm = (gVal - min) * invRange;
                    const bNorm = (bVal - min) * invRange;
                    r = (rNorm < 0 || rNorm > 1) ? 0 : Math.round(rNorm * 255);
                    g = (gNorm < 0 || gNorm > 1) ? 0 : Math.round(gNorm * 255);
                    b = (bNorm < 0 || bNorm > 1) ? 0 : Math.round(bNorm * 255);
                }

                const p = i * 4;
                out[p] = r;
                out[p + 1] = g;
                out[p + 2] = b;
                out[p + 3] = Number.isFinite(aVal) ? Math.round(Math.max(0, Math.min(1, aVal)) * 255) : 255;
                continue;
            }

            const p = i * 4;
            out[p] = r;
            out[p + 1] = g;
            out[p + 2] = b;
            out[p + 3] = 255;
        }

        return new ImageData(out, width, height);
    }

    /**
     * Render float32 data with gamma/brightness using 16-bit LUT.
     * Used in gamma mode with non-identity transform.
     * @private
     */
    static _renderFloatWithLUT(data, width, height, channels, min, max, settings, options) {
        const out = new Uint8ClampedArray(width * height * 4);
        const nanColor = options.nanColor || { r: 255, g: 0, b: 255 };

        // Generate 16-bit LUT for gamma/brightness
        const { min: vMin, max: vMax } = NormalizationHelper.getEffectiveVisualizationRange(settings, min, max);

        // For float, we map the quantized 0-65535 range to the LUT.
        // Since we already accounted for brightness/exposure in getEffectiveVisualizationRange (by expanding/shrinking vMin/vMax),
        // we must NOT apply it again in the LUT. The LUT should only handle gamma.
        const lutSettings = {
            ...settings,
            brightness: {
                ...settings.brightness,
                offset: 0
            }
        };
        const lut = NormalizationHelper.generateLut(lutSettings, 16, 65535, 0, 65535);
        const vRange = vMax - vMin;
        const invVRange = vRange > 0 ? 65535 / vRange : 0;

        for (let i = 0; i < width * height; i++) {
            let r, g, b;

            if (channels === 1) {
                const value = data[i];
                if (!Number.isFinite(value)) {
                    r = nanColor.r;
                    g = nanColor.g;
                    b = nanColor.b;
                } else if (value < min || value > max) {
                    r = g = b = 0;
                } else {
                    const lutIdx = Math.round(Math.max(0, Math.min(65535, (value - vMin) * invVRange)));
                    r = g = b = lut[lutIdx];
                    if (options.colormap && COLORMAP_TABLES[options.colormap]) {
                        const entry = COLORMAP_TABLES[options.colormap][r];
                        r = entry[0]; g = entry[1]; b = entry[2];
                    }
                }
            } else if (channels === 3) {
                const idx = i * 3;
                const rVal = data[idx];
                const gVal = data[idx + 1];
                const bVal = data[idx + 2];

                if (!Number.isFinite(rVal) || !Number.isFinite(gVal) || !Number.isFinite(bVal)) {
                    r = nanColor.r;
                    g = nanColor.g;
                    b = nanColor.b;
                } else {
                    r = (rVal < min || rVal > max) ? 0 : lut[Math.round(Math.max(0, Math.min(65535, (rVal - vMin) * invVRange)))];
                    g = (gVal < min || gVal > max) ? 0 : lut[Math.round(Math.max(0, Math.min(65535, (gVal - vMin) * invVRange)))];
                    b = (bVal < min || bVal > max) ? 0 : lut[Math.round(Math.max(0, Math.min(65535, (bVal - vMin) * invVRange)))];
                }
            } else if (channels === 4) {
                const idx = i * 4;
                const rVal = data[idx];
                const gVal = data[idx + 1];
                const bVal = data[idx + 2];
                const aVal = data[idx + 3];

                if (!Number.isFinite(rVal) || !Number.isFinite(gVal) || !Number.isFinite(bVal)) {
                    r = nanColor.r;
                    g = nanColor.g;
                    b = nanColor.b;
                } else {
                    r = (rVal < min || rVal > max) ? 0 : lut[Math.round(Math.max(0, Math.min(65535, (rVal - vMin) * invVRange)))];
                    g = (gVal < min || gVal > max) ? 0 : lut[Math.round(Math.max(0, Math.min(65535, (gVal - vMin) * invVRange)))];
                    b = (bVal < min || bVal > max) ? 0 : lut[Math.round(Math.max(0, Math.min(65535, (bVal - vMin) * invVRange)))];
                }

                const p = i * 4;
                out[p] = r;
                out[p + 1] = g;
                out[p + 2] = b;
                out[p + 3] = Number.isFinite(aVal) ? Math.round(Math.max(0, Math.min(1, aVal)) * 255) : 255;
                continue;
            }

            const p = i * 4;
            out[p] = r;
            out[p + 1] = g;
            out[p + 2] = b;
            out[p + 3] = 255;
        }

        return new ImageData(out, width, height);
    }

    /**
     * Render uint16 data directly (no gamma, just normalization).
     * @private
     */
    static _renderUint16Direct(data, width, height, channels, min, max, options = {}) {
        const out = new Uint8ClampedArray(width * height * 4);

        if (options.rgbAs24BitGrayscale && channels >= 3) {
            // Scale 16-bit down to 8-bit for 24-bit display
            const range = max - min;
            const invRange = range > 0 ? 1.0 / range : 0;

            for (let i = 0; i < width * height; i++) {
                const idx = i * channels;
                // Scale 16-bit (0-65535) to 8-bit (0-255)
                const r = Math.round(data[idx] / 257);
                const g = Math.round(data[idx + 1] / 257);
                const b = Math.round(data[idx + 2] / 257);
                const val24 = (r << 16) | (g << 8) | b;

                const normalized = (val24 - min) * invRange;
                const val8 = (normalized < 0 || normalized > 1) ? 0 : Math.round(normalized * 255);

                const p = i * 4;
                out[p] = val8;
                out[p + 1] = val8;
                out[p + 2] = val8;
                out[p + 3] = 255;
            }
            return new ImageData(out, width, height);
        }
        const range = max - min;
        const invRange = range > 0 ? 255.0 / range : 0;

        for (let i = 0; i < width * height; i++) {
            let r, g, b;

            if (channels === 1) {
                const raw = data[i];
                if (raw < min || raw > max) { r = g = b = 0; }
                else {
                    r = g = b = Math.round((raw - min) * invRange);
                    if (options.colormap && COLORMAP_TABLES[options.colormap]) {
                        const entry = COLORMAP_TABLES[options.colormap][r];
                        r = entry[0]; g = entry[1]; b = entry[2];
                    }
                }
            } else if (channels === 3) {
                const idx = i * 3;
                const rRaw = data[idx], gRaw = data[idx + 1], bRaw = data[idx + 2];
                r = (rRaw < min || rRaw > max) ? 0 : Math.round((rRaw - min) * invRange);
                g = (gRaw < min || gRaw > max) ? 0 : Math.round((gRaw - min) * invRange);
                b = (bRaw < min || bRaw > max) ? 0 : Math.round((bRaw - min) * invRange);
            } else if (channels === 4) {
                const idx = i * 4;
                const rRaw = data[idx], gRaw = data[idx + 1], bRaw = data[idx + 2];
                r = (rRaw < min || rRaw > max) ? 0 : Math.round((rRaw - min) * invRange);
                g = (gRaw < min || gRaw > max) ? 0 : Math.round((gRaw - min) * invRange);
                b = (bRaw < min || bRaw > max) ? 0 : Math.round((bRaw - min) * invRange);

                const p = i * 4;
                out[p] = r;
                out[p + 1] = g;
                out[p + 2] = b;
                out[p + 3] = Math.round(data[idx + 3] / 257); // 65535 -> 255
                continue;
            }

            const p = i * 4;
            out[p] = r;
            out[p + 1] = g;
            out[p + 2] = b;
            out[p + 3] = 255;
        }

        return new ImageData(out, width, height);
    }

    /**
     * Render uint16 data with gamma/brightness using LUT.
     * @private
     */
    static _renderUint16WithLUT(data, width, height, channels, min, max, settings, options = {}) {
        const out = new Uint8ClampedArray(width * height * 4);

        if (options.rgbAs24BitGrayscale && channels >= 3) {
            // Scale 16-bit down to 8-bit for 24-bit display
            const range = max - min;
            const invRange = range > 0 ? 1.0 / range : 0;

            for (let i = 0; i < width * height; i++) {
                const idx = i * channels;
                // Scale 16-bit (0-65535) to 8-bit (0-255)
                const r = Math.round(data[idx] / 257);
                const g = Math.round(data[idx + 1] / 257);
                const b = Math.round(data[idx + 2] / 257);
                const val24 = (r << 16) | (g << 8) | b;

                let normalized = (val24 - min) * invRange;
                normalized = NormalizationHelper.applyGammaAndBrightness(normalized, settings);
                const val8 = (normalized < 0 || normalized > 1) ? 0 : Math.round(normalized * 255);

                const p = i * 4;
                out[p] = val8;
                out[p + 1] = val8;
                out[p + 2] = val8;
                out[p + 3] = 255;
            }
            return new ImageData(out, width, height);
        }

        // Generate 16-bit LUT
        const normMin = Math.round(Math.max(0, Math.min(65535, min)));
        const normMax = Math.round(Math.max(0, Math.min(65535, max)));
        const lut = NormalizationHelper.generateLut(settings, 16, 65535, normMin, normMax);

        for (let i = 0; i < width * height; i++) {
            let r, g, b;

            if (channels === 1) {
                const rawVal = data[i];
                if (rawVal > normMax) { r = g = b = 0; }
                else {
                    r = g = b = lut[Math.min(65535, rawVal)];
                    if (options.colormap && COLORMAP_TABLES[options.colormap]) {
                        const entry = COLORMAP_TABLES[options.colormap][r];
                        r = entry[0]; g = entry[1]; b = entry[2];
                    }
                }
            } else if (channels === 3) {
                const idx = i * 3;
                r = data[idx] > normMax ? 0 : lut[Math.min(65535, data[idx])];
                g = data[idx + 1] > normMax ? 0 : lut[Math.min(65535, data[idx + 1])];
                b = data[idx + 2] > normMax ? 0 : lut[Math.min(65535, data[idx + 2])];
            } else if (channels === 4) {
                const idx = i * 4;
                r = data[idx] > normMax ? 0 : lut[Math.min(65535, data[idx])];
                g = data[idx + 1] > normMax ? 0 : lut[Math.min(65535, data[idx + 1])];
                b = data[idx + 2] > normMax ? 0 : lut[Math.min(65535, data[idx + 2])];

                const p = i * 4;
                out[p] = r;
                out[p + 1] = g;
                out[p + 2] = b;
                out[p + 3] = Math.round(data[idx + 3] / 257); // 65535 -> 255
                continue;
            }

            const p = i * 4;
            out[p] = r;
            out[p + 1] = g;
            out[p + 2] = b;
            out[p + 3] = 255;
        }

        return new ImageData(out, width, height);
    }

    /**
     * Render uint8 data directly (no gamma, just normalization).
     * @private
     */
    static _renderUint8Direct(data, width, height, channels, min, max, options = {}) {
        const out = new Uint8ClampedArray(width * height * 4);

        if (options.rgbAs24BitGrayscale && channels >= 3) {
            const range = max - min;
            const invRange = range > 0 ? 1.0 / range : 0;

            for (let i = 0; i < width * height; i++) {
                const idx = i * channels;
                const r = data[idx];
                const g = data[idx + 1];
                const b = data[idx + 2];
                const val24 = (r << 16) | (g << 8) | b;

                const normalized = (val24 - min) * invRange;
                const val8 = (normalized < 0 || normalized > 1) ? 0 : Math.round(normalized * 255);

                const p = i * 4;
                out[p] = val8;
                out[p + 1] = val8;
                out[p + 2] = val8;
                out[p + 3] = 255;
            }
            return new ImageData(out, width, height);
        }

        if (min === 0 && max === 255) {
            // Ultra-fast path: direct copy for full range
            for (let i = 0; i < width * height; i++) {
                const p = i * 4;
                if (channels === 1) {
                    const value = data[i];
                    if (options.colormap && COLORMAP_TABLES[options.colormap]) {
                        const entry = COLORMAP_TABLES[options.colormap][value];
                        out[p] = entry[0]; out[p + 1] = entry[1]; out[p + 2] = entry[2];
                    } else {
                        out[p] = out[p + 1] = out[p + 2] = value;
                    }
                } else if (channels === 3) {
                    const idx = i * 3;
                    out[p] = data[idx];
                    out[p + 1] = data[idx + 1];
                    out[p + 2] = data[idx + 2];
                } else if (channels === 4) {
                    const idx = i * 4;
                    out[p] = data[idx];
                    out[p + 1] = data[idx + 1];
                    out[p + 2] = data[idx + 2];
                    out[p + 3] = data[idx + 3];
                    continue;
                }
                out[p + 3] = 255;
            }
        } else {
            // Normalize to custom range
            const range = max - min;
            const invRange = range > 0 ? 255.0 / range : 0;

            for (let i = 0; i < width * height; i++) {
                let r, g, b;

                if (channels === 1) {
                    const raw = data[i];
                    if (raw < min || raw > max) { r = g = b = 0; }
                    else {
                        r = g = b = Math.round((raw - min) * invRange);
                        if (options.colormap && COLORMAP_TABLES[options.colormap]) {
                            const entry = COLORMAP_TABLES[options.colormap][r];
                            r = entry[0]; g = entry[1]; b = entry[2];
                        }
                    }
                } else if (channels === 3) {
                    const idx = i * 3;
                    const rRaw = data[idx], gRaw = data[idx + 1], bRaw = data[idx + 2];
                    r = (rRaw < min || rRaw > max) ? 0 : Math.round((rRaw - min) * invRange);
                    g = (gRaw < min || gRaw > max) ? 0 : Math.round((gRaw - min) * invRange);
                    b = (bRaw < min || bRaw > max) ? 0 : Math.round((bRaw - min) * invRange);
                } else if (channels === 4) {
                    const idx = i * 4;
                    const rRaw = data[idx], gRaw = data[idx + 1], bRaw = data[idx + 2];
                    r = (rRaw < min || rRaw > max) ? 0 : Math.round((rRaw - min) * invRange);
                    g = (gRaw < min || gRaw > max) ? 0 : Math.round((gRaw - min) * invRange);
                    b = (bRaw < min || bRaw > max) ? 0 : Math.round((bRaw - min) * invRange);

                    const p = i * 4;
                    out[p] = r;
                    out[p + 1] = g;
                    out[p + 2] = b;
                    out[p + 3] = data[idx + 3];
                    continue;
                }

                const p = i * 4;
                out[p] = r;
                out[p + 1] = g;
                out[p + 2] = b;
                out[p + 3] = 255;
            }
        }

        return new ImageData(out, width, height);
    }

    /**
     * Render uint8 data with gamma/brightness using LUT.
     * @private
     */
    static _renderUint8WithLUT(data, width, height, channels, min, max, settings, options = {}) {
        const out = new Uint8ClampedArray(width * height * 4);

        if (options.rgbAs24BitGrayscale && channels >= 3) {
            const range = max - min;
            const invRange = range > 0 ? 1.0 / range : 0;

            for (let i = 0; i < width * height; i++) {
                const idx = i * channels;
                const r = data[idx];
                const g = data[idx + 1];
                const b = data[idx + 2];
                const val24 = (r << 16) | (g << 8) | b;

                let normalized = (val24 - min) * invRange;
                normalized = NormalizationHelper.applyGammaAndBrightness(normalized, settings);
                const val8 = (normalized < 0 || normalized > 1) ? 0 : Math.round(normalized * 255);

                const p = i * 4;
                out[p] = val8;
                out[p + 1] = val8;
                out[p + 2] = val8;
                out[p + 3] = 255;
            }
            return new ImageData(out, width, height);
        }

        // Generate 8-bit LUT
        const normMin = Math.round(Math.max(0, Math.min(255, min)));
        const normMax = Math.round(Math.max(0, Math.min(255, max)));
        const lut = NormalizationHelper.generateLut(settings, 8, 255, normMin, normMax);

        for (let i = 0; i < width * height; i++) {
            let r, g, b;

            if (channels === 1) {
                const rawVal = data[i];
                if (rawVal > normMax) { r = g = b = 0; }
                else {
                    r = g = b = lut[rawVal];
                    if (options.colormap && COLORMAP_TABLES[options.colormap]) {
                        const entry = COLORMAP_TABLES[options.colormap][r];
                        r = entry[0]; g = entry[1]; b = entry[2];
                    }
                }
            } else if (channels === 3) {
                const idx = i * 3;
                r = data[idx] > normMax ? 0 : lut[data[idx]];
                g = data[idx + 1] > normMax ? 0 : lut[data[idx + 1]];
                b = data[idx + 2] > normMax ? 0 : lut[data[idx + 2]];
            } else if (channels === 4) {
                const idx = i * 4;
                r = data[idx] > normMax ? 0 : lut[data[idx]];
                g = data[idx + 1] > normMax ? 0 : lut[data[idx + 1]];
                b = data[idx + 2] > normMax ? 0 : lut[data[idx + 2]];

                const p = i * 4;
                out[p] = r;
                out[p + 1] = g;
                out[p + 2] = b;
                out[p + 3] = data[idx + 3];
                continue;
            }

            const p = i * 4;
            out[p] = r;
            out[p + 1] = g;
            out[p + 2] = b;
            out[p + 3] = 255;
        }

        return new ImageData(out, width, height);
    }
}

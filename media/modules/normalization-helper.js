// @ts-check
"use strict";

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
     * Apply gamma and brightness corrections to a normalized value (0-1).
     * @param {number} normalizedValue - Value in 0-1 range (can be outside for float)
     * @param {Object} settings - Image settings
     * @returns {number} Corrected value
     */
    static applyGammaAndBrightness(normalizedValue, settings) {
        const gammaIn = settings.gamma?.in ?? 1.0;
        const gammaOut = settings.gamma?.out ?? 1.0;
        const exposureStops = settings.brightness?.offset ?? 0;

        // Optimization: Skip if no changes
        if (Math.abs(gammaIn - 1.0) < 0.001 && Math.abs(gammaOut - 1.0) < 0.001 && Math.abs(exposureStops) < 0.001) {
            return normalizedValue;
        }

        // 1. Remove input gamma (linearize)
        let linear = Math.pow(normalizedValue, gammaIn);

        // 2. Apply brightness (exposure)
        if (exposureStops !== 0) {
            linear = linear * Math.pow(2, exposureStops);
        }

        // 3. Apply output gamma
        return Math.pow(linear, 1.0 / gammaOut);
    }

    /**
     * Generate a LUT for the given settings and bit depth.
     * @param {Object} settings - Image settings
     * @param {number} bitDepth - Bit depth (8 or 16)
     * @param {number} maxValue - Maximum value (255 or 65535)
     * @param {number} [min] - Optional minimum value for normalization (from stats)
     * @param {number} [max] - Optional maximum value for normalization (from stats)
     * @returns {Uint8Array} LUT mapping input values to 0-255 output values
     */
    static generateLut(settings, bitDepth, maxValue, min, max) {
        const size = maxValue + 1;
        const lut = new Uint8Array(size);

        // Create stats object if min/max are provided
        const stats = (min !== undefined && max !== undefined) ? { min, max } : null;

        // Get normalization range using the shared logic
        const { min: normMin, max: normMax } = this.getNormalizationRange(settings, stats, maxValue, false);

        const range = normMax - normMin;
        const invRange = range > 0 ? 1.0 / range : 0;

        const gammaIn = settings.gamma?.in ?? 1.0;
        const gammaOut = settings.gamma?.out ?? 1.0;

        // Use the centralized identity check
        if (this.isIdentityTransformation(settings)) {
            // Identity gamma: linear mapping
            for (let i = 0; i < size; i++) {
                let normalized;
                if (range > 0) {
                    normalized = (i - normMin) * invRange;
                } else {
                    normalized = 0;
                }
                lut[i] = Math.round(Math.max(0, Math.min(1, normalized)) * 255);
            }
        } else {
            // Full gamma correction
            for (let i = 0; i < size; i++) {
                let normalized;
                if (range > 0) {
                    normalized = (i - normMin) * invRange;
                } else {
                    normalized = 0;
                }

                // Apply gamma/brightness
                const corrected = this.applyGammaAndBrightness(normalized, settings);

                lut[i] = Math.round(Math.max(0, Math.min(1, corrected)) * 255);
            }
        }

        return lut;
    }

    /**
     * Check if the current settings represent an identity transformation (no gamma/brightness changes).
     * @param {Object} settings - Image settings
     * @returns {boolean} True if identity transformation
     */
    static isIdentityTransformation(settings) {
        const gammaIn = settings.gamma?.in ?? 1.0;
        const gammaOut = settings.gamma?.out ?? 1.0;
        const exposureStops = settings.brightness?.offset ?? 0;

        return Math.abs(gammaIn - 1.0) < 0.001 &&
            Math.abs(gammaOut - 1.0) < 0.001 &&
            Math.abs(exposureStops) < 0.001;
    }
}


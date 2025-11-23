// @ts-check
"use strict";

/**
 * Helper class for generating Look-Up Tables (LUTs) for gamma and brightness correction.
 * This significantly improves performance by pre-calculating values instead of computing per-pixel.
 */
export class LutHelper {
    /**
     * Generate a LUT for the given settings and bit depth
     * @param {Object} settings - Image settings (gamma, brightness, normalization)
     * @param {number} bitDepth - Bit depth of the image (8 or 16)
     * @param {number} maxValue - Maximum value for the bit depth (255 or 65535)
     * @returns {Uint8Array} LUT mapping input values to 0-255 output values
     */
    static generateLut(settings, bitDepth, maxValue) {
        // Determine LUT size based on bit depth
        // For 8-bit: 256 entries
        // For 16-bit: 65536 entries (larger but still fast to generate and lookup)
        const size = maxValue + 1;
        const lut = new Uint8Array(size);

        const gammaIn = settings.gamma?.in ?? 1.0;
        const gammaOut = settings.gamma?.out ?? 1.0;
        const exposureStops = settings.brightness?.offset ?? 0;

        // Check for identity transform
        const isIdentity = Math.abs(gammaIn - gammaOut) < 0.001 && Math.abs(exposureStops) < 0.001;

        // Normalization range
        let normMin = 0;
        let normMax = maxValue;

        if (settings.normalization) {
            if (settings.normalization.autoNormalize) {
                // Auto-normalize uses min/max from stats (passed in via settings or handled by caller)
                // Note: For LUT generation, we usually assume the caller has set up normalization.min/max correctly
                normMin = settings.normalization.min;
                normMax = settings.normalization.max;
            } else if (!settings.normalization.gammaMode) {
                // Manual mode
                normMin = settings.normalization.min;
                normMax = settings.normalization.max;

                // If normalized float mode, scale up
                if (settings.normalizedFloatMode) {
                    normMin *= maxValue;
                    normMax *= maxValue;
                }
            }
        }

        const range = normMax - normMin;
        const invRange = range > 0 ? 1.0 / range : 0;

        // Pre-calculate constants for the loop
        const exposureFactor = Math.pow(2, exposureStops);
        const invGammaOut = 1.0 / gammaOut;

        // Generate LUT entries
        for (let i = 0; i < size; i++) {
            // 1. Normalize to 0-1
            let normalized = (i - normMin) * invRange;

            // Clamp to 0-1
            if (normalized < 0) normalized = 0;
            if (normalized > 1) normalized = 1;

            if (isIdentity) {
                // Fast path for identity
                lut[i] = Math.round(normalized * 255);
                continue;
            }

            // 2. Remove input gamma (linearize)
            let linear = Math.pow(normalized, gammaIn);

            // 3. Apply brightness (exposure)
            linear = linear * exposureFactor;

            // 4. Apply output gamma
            let output = Math.pow(linear, invGammaOut);

            // 5. Scale to 0-255 and clamp
            if (output < 0) output = 0;
            if (output > 1) output = 1;

            lut[i] = Math.round(output * 255);
        }

        return lut;
    }
}

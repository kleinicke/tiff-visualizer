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
     * @param {number} normalized - Value in range 0-1
     * @param {Object} settings - Settings object with gamma and brightness
     * @returns {number} Corrected value (may be outside [0,1])
     */
    static applyGammaAndBrightness(normalized, settings) {
        const gammaIn = settings.gamma?.in ?? 1.0;
        const gammaOut = settings.gamma?.out ?? 1.0;
        const exposureStops = settings.brightness?.offset ?? 0;

        // Apply input gamma (linearize)
        let linear = Math.pow(normalized, gammaIn);

        // Apply exposure (brightness)
        linear *= Math.pow(2, exposureStops);

        // Apply output gamma (encode)
        const output = Math.pow(linear, 1.0 / gammaOut);

        return output;
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

        return lut;
    }

    /**
     * Check if the transformation is identity (no gamma/brightness changes).
     * @param {Object} settings - Settings object
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
        const gammaIn = settings.gamma?.in ?? 1.0;
        const gammaOut = settings.gamma?.out ?? 1.0;
        const exposureStops = settings.brightness?.offset ?? 0;
        const range = normMax - normMin;

        // If identity transform, effective range is just the normalization range
        if (this.isIdentityTransformation(settings)) {
            return { min: normMin, max: normMax };
        }

        // We want to find input values V such that:
        // Output(V) = 0  =>  V_min
        // Output(V) = 1  =>  V_max

        // The forward transform is:
        // 1. normalized = (V - normMin) / range
        // 2. linear = normalized ^ gammaIn
        // 3. exposed = linear * 2^exposure
        // 4. output = exposed ^ (1/gammaOut)

        // Reversing for Output = 0:
        // 0 = exposed ^ (1/gammaOut) => exposed = 0
        // 0 = linear * 2^exposure => linear = 0
        // 0 = normalized ^ gammaIn => normalized = 0
        // 0 = (V - normMin) / range => V = normMin
        // So V_min is always normMin (unless we have negative exposure/gamma weirdness, but usually 0 maps to 0)
        const vMin = normMin;

        // Reversing for Output = 1:
        // 1 = exposed ^ (1/gammaOut) => exposed = 1
        // 1 = linear * 2^exposure => linear = 1 / 2^exposure = 2^(-exposure)
        // linear = normalized ^ gammaIn => normalized = linear ^ (1/gammaIn)
        // normalized = (2^(-exposure)) ^ (1/gammaIn)
        // V = normalized * range + normMin

        const exposureFactor = Math.pow(2, exposureStops);
        // If exposure is very high, we see very dark things. If exposure is low, we only see bright things.

        // Let's trace back from Output=1
        // exposed = 1
        // linear = 1 / exposureFactor
        const linearThreshold = 1.0 / exposureFactor;

        // normalized = linearThreshold ^ (1/gammaIn)
        const normalizedThreshold = Math.pow(linearThreshold, 1.0 / gammaIn);

        // V = normalizedThreshold * range + normMin
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
        const result = this._renderInternal(data, width, height, channels, isFloat, stats, settings, options);

        if (options.flipY) {
            return this._flipY(result);
        }
        return result;
    }

    static _renderInternal(data, width, height, channels, isFloat, stats, settings, options = {}) {
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

        // Get normalization range based on mode
        const { min, max } = NormalizationHelper.getNormalizationRange(
            settings, stats, typeMax, isFloat
        );

        if (isGammaMode) {
            // Gamma mode: check if we can skip gamma processing (identity transform)
            const isIdentity = NormalizationHelper.isIdentityTransformation(settings);

            if (isIdentity) {
                // Identity in gamma mode: just normalize, no LUT needed
                if (isFloat) {
                    return this._renderFloatDirect(data, width, height, channels, min, max, options);
                } else if (data instanceof Uint16Array) {
                    return this._renderUint16Direct(data, width, height, channels, min, max);
                } else {
                    return this._renderUint8Direct(data, width, height, channels, min, max);
                }
            } else {
                // Non-identity in gamma mode: use LUT
                if (isFloat) {
                    return this._renderFloatWithLUT(data, width, height, channels, min, max, settings, options);
                } else if (data instanceof Uint16Array) {
                    return this._renderUint16WithLUT(data, width, height, channels, min, max, settings, options);
                } else {
                    return this._renderUint8WithLUT(data, width, height, channels, min, max, settings, options);
                }
            }
        } else {
            // Not in gamma mode: direct normalization only (no gamma/brightness, no LUT)
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
                    r = g = b = nanColor.r;
                } else {
                    const normalized = (value - min) * invRange;
                    const intensity = Math.round(Math.max(0, Math.min(1, normalized)) * 255);
                    r = g = b = intensity;
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
                    r = Math.round(Math.max(0, Math.min(1, (rVal - min) * invRange)) * 255);
                    g = Math.round(Math.max(0, Math.min(1, (gVal - min) * invRange)) * 255);
                    b = Math.round(Math.max(0, Math.min(1, (bVal - min) * invRange)) * 255);
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
                    r = Math.round(Math.max(0, Math.min(1, (rVal - min) * invRange)) * 255);
                    g = Math.round(Math.max(0, Math.min(1, (gVal - min) * invRange)) * 255);
                    b = Math.round(Math.max(0, Math.min(1, (bVal - min) * invRange)) * 255);
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
        // For float, we map the quantized 0-65535 range to the LUT, not the float values directly
        const lut = NormalizationHelper.generateLut(settings, 16, 65535, 0, 65535);
        const vRange = vMax - vMin;
        const invVRange = vRange > 0 ? 65535 / vRange : 0;

        for (let i = 0; i < width * height; i++) {
            let r, g, b;

            if (channels === 1) {
                const value = data[i];
                if (!Number.isFinite(value)) {
                    r = g = b = nanColor.r;
                } else {
                    const lutIdx = Math.round(Math.max(0, Math.min(65535, (value - vMin) * invVRange)));
                    r = g = b = lut[lutIdx];
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
                    const rIdx = Math.round(Math.max(0, Math.min(65535, (rVal - vMin) * invVRange)));
                    const gIdx = Math.round(Math.max(0, Math.min(65535, (gVal - vMin) * invVRange)));
                    const bIdx = Math.round(Math.max(0, Math.min(65535, (bVal - vMin) * invVRange)));
                    r = lut[rIdx];
                    g = lut[gIdx];
                    b = lut[bIdx];
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
                    const rIdx = Math.round(Math.max(0, Math.min(65535, (rVal - vMin) * invVRange)));
                    const gIdx = Math.round(Math.max(0, Math.min(65535, (gVal - vMin) * invVRange)));
                    const bIdx = Math.round(Math.max(0, Math.min(65535, (bVal - vMin) * invVRange)));
                    r = lut[rIdx];
                    g = lut[gIdx];
                    b = lut[bIdx];
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
                const val8 = Math.round(Math.max(0, Math.min(1, normalized)) * 255);

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
                const value = Math.max(min, Math.min(max, data[i]));
                r = g = b = Math.round((value - min) * invRange);
            } else if (channels === 3) {
                const idx = i * 3;
                r = Math.round((Math.max(min, Math.min(max, data[idx])) - min) * invRange);
                g = Math.round((Math.max(min, Math.min(max, data[idx + 1])) - min) * invRange);
                b = Math.round((Math.max(min, Math.min(max, data[idx + 2])) - min) * invRange);
            } else if (channels === 4) {
                const idx = i * 4;
                r = Math.round((Math.max(min, Math.min(max, data[idx])) - min) * invRange);
                g = Math.round((Math.max(min, Math.min(max, data[idx + 1])) - min) * invRange);
                b = Math.round((Math.max(min, Math.min(max, data[idx + 2])) - min) * invRange);

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
                const val8 = Math.round(Math.max(0, Math.min(1, normalized)) * 255);

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
                const value = Math.min(65535, data[i]);
                r = g = b = lut[value];
            } else if (channels === 3) {
                const idx = i * 3;
                r = lut[Math.min(65535, data[idx])];
                g = lut[Math.min(65535, data[idx + 1])];
                b = lut[Math.min(65535, data[idx + 2])];
            } else if (channels === 4) {
                const idx = i * 4;
                r = lut[Math.min(65535, data[idx])];
                g = lut[Math.min(65535, data[idx + 1])];
                b = lut[Math.min(65535, data[idx + 2])];

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
                const val8 = Math.round(Math.max(0, Math.min(1, normalized)) * 255);

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
                    out[p] = out[p + 1] = out[p + 2] = value;
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
                    const value = Math.max(min, Math.min(max, data[i]));
                    r = g = b = Math.round((value - min) * invRange);
                } else if (channels === 3) {
                    const idx = i * 3;
                    r = Math.round((Math.max(min, Math.min(max, data[idx])) - min) * invRange);
                    g = Math.round((Math.max(min, Math.min(max, data[idx + 1])) - min) * invRange);
                    b = Math.round((Math.max(min, Math.min(max, data[idx + 2])) - min) * invRange);
                } else if (channels === 4) {
                    const idx = i * 4;
                    r = Math.round((Math.max(min, Math.min(max, data[idx])) - min) * invRange);
                    g = Math.round((Math.max(min, Math.min(max, data[idx + 1])) - min) * invRange);
                    b = Math.round((Math.max(min, Math.min(max, data[idx + 2])) - min) * invRange);

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
                const val8 = Math.round(Math.max(0, Math.min(1, normalized)) * 255);

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
                r = g = b = lut[data[i]];
            } else if (channels === 3) {
                const idx = i * 3;
                r = lut[data[idx]];
                g = lut[data[idx + 1]];
                b = lut[data[idx + 2]];
            } else if (channels === 4) {
                const idx = i * 4;
                r = lut[data[idx]];
                g = lut[data[idx + 1]];
                b = lut[data[idx + 2]];

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

// @ts-check
"use strict";

import { PerfTrace } from './perf-trace.js';
import { getColormapLut } from './colormaps.js';

/** @typedef {import('./settings-manager.js').ImageSettings} ImageSettings */

/**
 * @typedef {{nanColor?: {r:number,g:number,b:number}, flipY?: boolean, typeMax?: number, rgbAs24BitGrayscale?: boolean, planarData?: any, collectHistogram?: boolean, renderHistogramResult?: any}} RenderOptions
 */

/**
 * Helper class for normalization, gamma, and brightness corrections.
 * Centralizes logic for range calculation and LUT generation.
 */
export class NormalizationHelper {
    /**
     * Calculate the normalization range (min/max) based on settings and stats.
     * @param {ImageSettings} settings - Image settings
     * @param {{min: number, max: number}|null|undefined} stats - Image statistics {min, max}
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
     * Whether rendering needs exact data min/max for the current settings.
     * Manual range and gamma-mode renders can use their configured/full range
     * without scanning the image first.
     * @param {ImageSettings} settings
     */
    static needsStats(settings) {
        return !settings.normalization?.gammaMode && settings.normalization?.autoNormalize !== false;
    }

    /**
     * Apply gamma and brightness corrections to a normalized value (0-1).
     * @param {number} normalized - Value in range 0-1
     * @param {ImageSettings} settings - Settings object with gamma and brightness
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
     * @param {ImageSettings} settings - Settings object
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
     * Check if the transformation is identity (no effective gamma/brightness changes).
     * Identity occurs when gammaIn === gammaOut (they cancel out) and brightness is 0.
     * This is because (value^gammaIn)^(1/gammaOut) = value when gammaIn === gammaOut.
     * @param {ImageSettings} settings - Settings object
     * @returns {boolean} True if identity transformation
     */
    static isIdentityTransformation(settings) {
        const gammaIn = settings.gamma?.in ?? 1.0;
        const gammaOut = settings.gamma?.out ?? 1.0;
        const exposureStops = settings.brightness?.offset ?? 0;

        // Identity when gammaIn equals gammaOut (they cancel) and no brightness adjustment
        return Math.abs(gammaIn - gammaOut) < 0.001 &&
            Math.abs(exposureStops) < 0.001;
    }

    /**
     * Calculate the effective input range that maps to the visible output range (0-1).
     * Values outside this range will be clipped to 0 or 1.
     * This allows skipping expensive calculations for clipped pixels.
     * 
     * @param {ImageSettings} settings - Image settings
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
        const perfStart = performance.now();
        let minVal = Infinity;
        let maxVal = -Infinity;

        const len = width * height;
        if (channels === 1) {
            for (let i = 0; i < len; i++) {
                const val = data[i];
                if (val === val && val !== Infinity && val !== -Infinity) {
                    if (val < minVal) minVal = val;
                    if (val > maxVal) maxVal = val;
                }
            }
        } else {
            const scanChannels = Math.min(channels, 3);
            for (let i = 0; i < len; i++) {
                const base = i * channels;
                for (let c = 0; c < scanChannels; c++) {
                    const val = data[base + c];
                    if (val === val && val !== Infinity && val !== -Infinity) {
                        if (val < minVal) minVal = val;
                        if (val > maxVal) maxVal = val;
                    }
                }
            }
        }

        console.log(`[Stats] Float stats calculation took ${(performance.now() - perfStart).toFixed(2)}ms`);
        PerfTrace.mark('stats');
        return { min: minVal, max: maxVal };
    }

    /**
     * Calculate min/max statistics for integer data.
     * @param {Uint8Array|Uint8ClampedArray|Uint16Array} data - Image data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} channels - Number of channels
     * @returns {{min: number, max: number}} Statistics
     */
    static calculateIntegerStats(data, width, height, channels, rgbAs24Bit = false) {
        let minVal = Infinity;
        let maxVal = -Infinity;

        const len = width * height;
        if (rgbAs24Bit && channels >= 3) {
            for (let i = 0; i < len; i++) {
                const idx = i * channels;
                const val24 = (data[idx] << 16) | (data[idx + 1] << 8) | data[idx + 2];
                if (val24 < minVal) minVal = val24;
                if (val24 > maxVal) maxVal = val24;
            }
        } else if (channels === 1) {
            for (let i = 0; i < len; i++) {
                const val = data[i];
                if (val < minVal) minVal = val;
                if (val > maxVal) maxVal = val;
            }
        } else {
            const scanChannels = Math.min(channels, 3);
            for (let i = 0; i < len; i++) {
                const base = i * channels;
                for (let c = 0; c < scanChannels; c++) {
                    const val = data[base + c];
                    if (val < minVal) minVal = val;
                    if (val > maxVal) maxVal = val;
                }
            }
        }

        PerfTrace.mark('stats');
        return { min: minVal, max: maxVal };
    }

    /**
     * On-demand extended statistics (mean/std/valid & non-finite counts) for
     * the Metadata panel. Not part of the hot render path — computed once
     * when the panel is opened, using the same first-3-channels scan
     * convention as calculateFloatStats/calculateIntegerStats above.
     * @param {ArrayLike<number>} data
     * @param {number} width
     * @param {number} height
     * @param {number} channels
     * @returns {{min:number,max:number,mean:number,std:number,validCount:number,nonFiniteCount:number,totalCount:number}}
     */
    static calculateExtendedStats(data, width, height, channels) {
        let minVal = Infinity;
        let maxVal = -Infinity;
        let sum = 0;
        let sumSq = 0;
        let validCount = 0;
        let nonFiniteCount = 0;

        const len = width * height;
        const scanChannels = channels === 1 ? 1 : Math.min(channels, 3);
        for (let i = 0; i < len; i++) {
            const base = i * channels;
            for (let c = 0; c < scanChannels; c++) {
                const val = data[base + c];
                if (Number.isFinite(val)) {
                    if (val < minVal) minVal = val;
                    if (val > maxVal) maxVal = val;
                    sum += val;
                    sumSq += val * val;
                    validCount++;
                } else {
                    nonFiniteCount++;
                }
            }
        }

        const mean = validCount > 0 ? sum / validCount : NaN;
        const variance = validCount > 0 ? Math.max(0, sumSq / validCount - mean * mean) : NaN;
        return {
            min: validCount > 0 ? minVal : NaN,
            max: validCount > 0 ? maxVal : NaN,
            mean,
            std: Math.sqrt(variance),
            validCount,
            nonFiniteCount,
            totalCount: len * scanChannels
        };
    }
}

/**
 * Centralized image renderer for all data types (uint8, uint16, float32).
 * Handles normalization, gamma/brightness correction, and NaN handling.
 */
export class ImageRenderer {
    /**
     * Build the histogram payload consumed by HistogramOverlay from a histogram
     * collected during a render pass.
     * @private
     * @param {Uint32Array} hist
     * @param {number} nanCount
     * @param {{min:number,max:number,isFloat:boolean}} valueRange
     * @param {{min:number,max:number,sum:number,count:number}} original
     * @returns {any}
     */
    static _finishSingleChannelRenderHistogram(hist, nanCount, valueRange, original) {
        const histG = new Uint32Array(hist);
        const histB = new Uint32Array(hist);
        const histLum = new Uint32Array(hist);
        const calculateBinStats = (/** @type {Uint32Array} */ h) => {
            let minBin = 0, maxBin = 255, sum = 0, count = 0;
            for (let i = 0; i < 256; i++) {
                if (h[i] > 0) {
                    if (count === 0) minBin = i;
                    maxBin = i;
                    sum += i * h[i];
                    count += h[i];
                }
            }
            return { minBin, maxBin, meanBin: count > 0 ? sum / count : 0, total: count };
        };
        const binStats = calculateBinStats(hist);
        const mean = original.count > 0 ? original.sum / original.count : 0;
        const min = original.count > 0 ? original.min : 0;
        const max = original.count > 0 ? original.max : 0;
        return {
            histogramData: {
                r: hist,
                g: histG,
                b: histB,
                luminance: histLum,
                nanCount,
                stats: {
                    r: binStats,
                    g: binStats,
                    b: binStats,
                    luminance: binStats
                }
            },
            originalStats: {
                r: { min, max, mean, total: original.count },
                g: { min, max, mean, total: original.count },
                b: { min, max, mean, total: original.count }
            },
            valueRange
        };
    }

    /**
     * Render typed array to ImageData with normalization and corrections.
     * @param {Uint8Array|Uint16Array|Float32Array|ArrayLike<number>} data - Image data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} channels - Number of channels (1, 3, or 4)
     * @param {boolean} isFloat - Whether data is floating point (float16 or float32)
     * @param {{min: number, max: number}|null|undefined} stats - Image statistics
     * @param {ImageSettings} settings - Normalization/gamma/brightness settings
     * @param {RenderOptions} [options={}] - Additional options
     * @returns {ImageData} Rendered image data
     */
    static render(data, width, height, channels, isFloat, stats, settings, options = {}) {
        const perfStart = performance.now();
        const result = this._renderInternal(data, width, height, channels, isFloat, stats, settings, options);

        // Apply a display colormap (pseudocolor) to single-channel images. This is
        // a non-destructive render-time step: the grayscale intensity already
        // written by the render paths is used as the colormap index. NaN pixels
        // (rendered as nanColor) are left untouched. Applied before flipY since
        // flipping only reorders rows. Works for every format and for layers,
        // because they all funnel through this method.
        if (channels === 1 && settings && settings.displayColormap && settings.displayColormap !== 'none') {
            this._applyDisplayColormap(result, data, isFloat, settings.displayColormap);
        }

        if (options.flipY) {
            const flipped = this._flipY(result);
            console.log(`[Render] Total render time: ${(performance.now() - perfStart).toFixed(2)}ms (with flip)`);
            PerfTrace.mark('render');
            return flipped;
        }
        console.log(`[Render] Total render time: ${(performance.now() - perfStart).toFixed(2)}ms`);
        PerfTrace.mark('render');
        return result;
    }

    /**
     * @param {ArrayLike<number>} data
     * @param {number} width
     * @param {number} height
     * @param {number} channels
     * @param {boolean} isFloat
     * @param {{min:number,max:number}|null|undefined} stats
     * @param {ImageSettings} settings
     * @param {RenderOptions} [options]
     */
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

        if (isGammaMode) {
            if (isIdentity) {
                // Identity in gamma mode: just normalize, no LUT needed
                if (isFloat) {
                    return this._renderFloatDirect(data, width, height, channels, min, max, options);
                } else if (data instanceof Uint16Array) {
                    return this._renderUint16Direct(data, width, height, channels, min, max, options);
                } else {
                    return this._renderUint8Direct(data, width, height, channels, min, max, options);
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
     * Remap a freshly-rendered single-channel (grayscale) ImageData through a
     * colormap, in place. The grayscale value of each pixel (out[p], 0-255) is
     * used as the lookup index. Pixels whose source value is non-finite were
     * rendered as nanColor and are skipped so they keep their NaN color.
     * @private
     * @param {ImageData} imageData
     * @param {ArrayLike<number>} data - original single-channel source data
     * @param {boolean} isFloat - whether source can contain NaN/Inf
     * @param {string} colormapName
     */
    static _applyDisplayColormap(imageData, data, isFloat, colormapName) {
        const lut = getColormapLut(colormapName);
        if (!lut) { return; }
        const out = imageData.data;
        const n = imageData.width * imageData.height;
        for (let i = 0; i < n; i++) {
            // Only float sources can hold NaN/Inf; integer sources never do.
            if (isFloat && !Number.isFinite(data[i])) { continue; }
            const p = i * 4;
            const ci = out[p] * 3; // grayscale intensity (r === g === b) as index
            out[p] = lut[ci];
            out[p + 1] = lut[ci + 1];
            out[p + 2] = lut[ci + 2];
            // alpha (out[p + 3]) preserved
        }
    }


    /**
     * Render float32 data directly (no gamma/brightness, just normalization).
     * Used in non-gamma mode or identity transform in gamma mode.
     * @private
     * @param {ArrayLike<number>} data
     * @param {number} width
     * @param {number} height
     * @param {number} channels
     * @param {number} min
     * @param {number} max
     * @param {RenderOptions} options
     */
    static _renderFloatDirect(data, width, height, channels, min, max, options) {
        const out = new Uint8ClampedArray(width * height * 4);
        const nanColor = options.nanColor || { r: 255, g: 0, b: 255 }; // Magenta default
        const range = max - min;
        const invRange = range > 0 ? 1.0 / range : 0;
        const collectHistogram = options.collectHistogram === true && channels === 1;
        const renderHist = collectHistogram ? new Uint32Array(256) : null;
        let renderHistNanCount = 0;
        const renderOriginal = { min: Infinity, max: -Infinity, sum: 0, count: 0 };

        if (channels === 1) {
            for (let i = 0; i < width * height; i++) {
                const p = i * 4;
                const value = data[i];
                if (!Number.isFinite(value)) {
                    out[p] = nanColor.r;
                    out[p + 1] = nanColor.g;
                    out[p + 2] = nanColor.b;
                    out[p + 3] = 255;
                    if (renderHist) { renderHistNanCount++; }
                    continue;
                }

                const normalized = (value - min) * invRange;
                const intensity = Math.round(Math.max(0, Math.min(1, normalized)) * 255);
                out[p] = intensity;
                out[p + 1] = intensity;
                out[p + 2] = intensity;
                out[p + 3] = 255;

                if (renderHist) {
                    renderHist[intensity]++;
                    if (value < renderOriginal.min) renderOriginal.min = value;
                    if (value > renderOriginal.max) renderOriginal.max = value;
                    renderOriginal.sum += value;
                    renderOriginal.count++;
                }
            }

            if (renderHist) {
                options.renderHistogramResult = this._finishSingleChannelRenderHistogram(
                    renderHist,
                    renderHistNanCount,
                    { min, max, isFloat: true },
                    renderOriginal
                );
            }

            return new ImageData(out, width, height);
        }

        for (let i = 0; i < width * height; i++) {
            let r = 0, g = 0, b = 0;

            if (channels === 1) {
                const value = data[i];
                if (!Number.isFinite(value)) {
                    r = nanColor.r;
                    g = nanColor.g;
                    b = nanColor.b;
                    renderHistNanCount++;
                } else {
                    const normalized = (value - min) * invRange;
                    const intensity = Math.round(Math.max(0, Math.min(1, normalized)) * 255);
                    r = g = b = intensity;
                    if (renderHist) {
                        renderHist[intensity]++;
                        if (value < renderOriginal.min) renderOriginal.min = value;
                        if (value > renderOriginal.max) renderOriginal.max = value;
                        renderOriginal.sum += value;
                        renderOriginal.count++;
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

        if (renderHist) {
            options.renderHistogramResult = this._finishSingleChannelRenderHistogram(
                renderHist,
                renderHistNanCount,
                { min, max, isFloat: true },
                renderOriginal
            );
        }

        return new ImageData(out, width, height);
    }

    /**
     * Render float32 data with gamma/brightness using 16-bit LUT.
     * Used in gamma mode with non-identity transform.
     * @private
     * @param {ArrayLike<number>} data
     * @param {number} width
     * @param {number} height
     * @param {number} channels
     * @param {number} min
     * @param {number} max
     * @param {ImageSettings} settings
     * @param {RenderOptions} options
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
        const collectHistogram = options.collectHistogram === true && channels === 1;
        const renderHist = collectHistogram ? new Uint32Array(256) : null;
        let renderHistNanCount = 0;
        const renderOriginal = { min: Infinity, max: -Infinity, sum: 0, count: 0 };

        if (channels === 1) {
            for (let i = 0; i < width * height; i++) {
                const p = i * 4;
                const value = data[i];
                if (!Number.isFinite(value)) {
                    out[p] = nanColor.r;
                    out[p + 1] = nanColor.g;
                    out[p + 2] = nanColor.b;
                    out[p + 3] = 255;
                    if (renderHist) { renderHistNanCount++; }
                    continue;
                }

                const lutIdx = Math.round(Math.max(0, Math.min(65535, (value - vMin) * invVRange)));
                const intensity = lut[lutIdx];
                out[p] = intensity;
                out[p + 1] = intensity;
                out[p + 2] = intensity;
                out[p + 3] = 255;

                if (renderHist) {
                    renderHist[intensity]++;
                    if (value < renderOriginal.min) renderOriginal.min = value;
                    if (value > renderOriginal.max) renderOriginal.max = value;
                    renderOriginal.sum += value;
                    renderOriginal.count++;
                }
            }

            if (renderHist) {
                options.renderHistogramResult = this._finishSingleChannelRenderHistogram(
                    renderHist,
                    renderHistNanCount,
                    { min, max, isFloat: true },
                    renderOriginal
                );
            }

            return new ImageData(out, width, height);
        }

        for (let i = 0; i < width * height; i++) {
            let r = 0, g = 0, b = 0;

            if (channels === 1) {
                const value = data[i];
                if (!Number.isFinite(value)) {
                    r = nanColor.r;
                    g = nanColor.g;
                    b = nanColor.b;
                    renderHistNanCount++;
                } else {
                    const lutIdx = Math.round(Math.max(0, Math.min(65535, (value - vMin) * invVRange)));
                    r = g = b = lut[lutIdx];
                    if (renderHist) {
                        renderHist[r]++;
                        if (value < renderOriginal.min) renderOriginal.min = value;
                        if (value > renderOriginal.max) renderOriginal.max = value;
                        renderOriginal.sum += value;
                        renderOriginal.count++;
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

        if (renderHist) {
            options.renderHistogramResult = this._finishSingleChannelRenderHistogram(
                renderHist,
                renderHistNanCount,
                { min, max, isFloat: true },
                renderOriginal
            );
        }

        return new ImageData(out, width, height);
    }

    /**
     * Render uint16 data directly (no gamma, just normalization).
     * @private
     * @param {ArrayLike<number>} data
     * @param {number} width
     * @param {number} height
     * @param {number} channels
     * @param {number} min
     * @param {number} max
     * @param {RenderOptions} [options]
     */
    static _renderUint16Direct(data, width, height, channels, min, max, options = {}) {
        const out = new Uint8ClampedArray(width * height * 4);
        const nanColor = options.nanColor || { r: 255, g: 0, b: 255 };

        if (options.rgbAs24BitGrayscale && channels >= 3) {
            // Scale 16-bit down to 8-bit for 24-bit display
            const range = max - min;
            const invRange = range > 0 ? 1.0 / range : 0;

            for (let i = 0; i < width * height; i++) {
                const idx = i * channels;
                const rVal = data[idx], gVal = data[idx + 1], bVal = data[idx + 2];
                const p = i * 4;

                if (!Number.isFinite(rVal) || !Number.isFinite(gVal) || !Number.isFinite(bVal)) {
                    out[p] = nanColor.r; out[p + 1] = nanColor.g; out[p + 2] = nanColor.b; out[p + 3] = 255;
                    continue;
                }

                const r = Math.round(rVal / 257);
                const g = Math.round(gVal / 257);
                const b = Math.round(bVal / 257);
                const val24 = (r << 16) | (g << 8) | b;

                const normalized = (val24 - min) * invRange;
                const val8 = Math.round(Math.max(0, Math.min(1, normalized)) * 255);

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
            let r = 0, g = 0, b = 0;

            if (channels === 1) {
                const value = data[i];
                if (!Number.isFinite(value)) {
                    const p = i * 4;
                    out[p] = nanColor.r; out[p + 1] = nanColor.g; out[p + 2] = nanColor.b; out[p + 3] = 255;
                    continue;
                }
                r = g = b = Math.round((Math.max(min, Math.min(max, value)) - min) * invRange);
            } else if (channels === 3) {
                const idx = i * 3;
                const rVal = data[idx], gVal = data[idx + 1], bVal = data[idx + 2];
                if (!Number.isFinite(rVal) || !Number.isFinite(gVal) || !Number.isFinite(bVal)) {
                    const p = i * 4;
                    out[p] = nanColor.r; out[p + 1] = nanColor.g; out[p + 2] = nanColor.b; out[p + 3] = 255;
                    continue;
                }
                r = Math.round((Math.max(min, Math.min(max, rVal)) - min) * invRange);
                g = Math.round((Math.max(min, Math.min(max, gVal)) - min) * invRange);
                b = Math.round((Math.max(min, Math.min(max, bVal)) - min) * invRange);
            } else if (channels === 4) {
                const idx = i * 4;
                const rVal = data[idx], gVal = data[idx + 1], bVal = data[idx + 2];
                if (!Number.isFinite(rVal) || !Number.isFinite(gVal) || !Number.isFinite(bVal)) {
                    const p = i * 4;
                    out[p] = nanColor.r; out[p + 1] = nanColor.g; out[p + 2] = nanColor.b; out[p + 3] = 255;
                    continue;
                }
                r = Math.round((Math.max(min, Math.min(max, rVal)) - min) * invRange);
                g = Math.round((Math.max(min, Math.min(max, gVal)) - min) * invRange);
                b = Math.round((Math.max(min, Math.min(max, bVal)) - min) * invRange);

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
     * @param {ArrayLike<number>} data
     * @param {number} width
     * @param {number} height
     * @param {number} channels
     * @param {number} min
     * @param {number} max
     * @param {ImageSettings} settings
     * @param {RenderOptions} [options]
     */
    static _renderUint16WithLUT(data, width, height, channels, min, max, settings, options = {}) {
        const out = new Uint8ClampedArray(width * height * 4);
        const nanColor = options.nanColor || { r: 255, g: 0, b: 255 };

        if (options.rgbAs24BitGrayscale && channels >= 3) {
            // Scale 16-bit down to 8-bit for 24-bit display
            const range = max - min;
            const invRange = range > 0 ? 1.0 / range : 0;

            for (let i = 0; i < width * height; i++) {
                const idx = i * channels;
                const rVal = data[idx], gVal = data[idx + 1], bVal = data[idx + 2];
                const p = i * 4;

                if (!Number.isFinite(rVal) || !Number.isFinite(gVal) || !Number.isFinite(bVal)) {
                    out[p] = nanColor.r; out[p + 1] = nanColor.g; out[p + 2] = nanColor.b; out[p + 3] = 255;
                    continue;
                }

                const r = Math.round(rVal / 257);
                const g = Math.round(gVal / 257);
                const b = Math.round(bVal / 257);
                const val24 = (r << 16) | (g << 8) | b;

                let normalized = (val24 - min) * invRange;
                normalized = NormalizationHelper.applyGammaAndBrightness(normalized, settings);
                const val8 = Math.round(Math.max(0, Math.min(1, normalized)) * 255);

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
            let r = 0, g = 0, b = 0;

            if (channels === 1) {
                const value = data[i];
                if (!Number.isFinite(value)) {
                    const p = i * 4;
                    out[p] = nanColor.r; out[p + 1] = nanColor.g; out[p + 2] = nanColor.b; out[p + 3] = 255;
                    continue;
                }
                r = g = b = lut[Math.min(65535, value)];
            } else if (channels === 3) {
                const idx = i * 3;
                const rVal = data[idx], gVal = data[idx + 1], bVal = data[idx + 2];
                if (!Number.isFinite(rVal) || !Number.isFinite(gVal) || !Number.isFinite(bVal)) {
                    const p = i * 4;
                    out[p] = nanColor.r; out[p + 1] = nanColor.g; out[p + 2] = nanColor.b; out[p + 3] = 255;
                    continue;
                }
                r = lut[Math.min(65535, rVal)];
                g = lut[Math.min(65535, gVal)];
                b = lut[Math.min(65535, bVal)];
            } else if (channels === 4) {
                const idx = i * 4;
                const rVal = data[idx], gVal = data[idx + 1], bVal = data[idx + 2];
                if (!Number.isFinite(rVal) || !Number.isFinite(gVal) || !Number.isFinite(bVal)) {
                    const p = i * 4;
                    out[p] = nanColor.r; out[p + 1] = nanColor.g; out[p + 2] = nanColor.b; out[p + 3] = 255;
                    continue;
                }
                r = lut[Math.min(65535, rVal)];
                g = lut[Math.min(65535, gVal)];
                b = lut[Math.min(65535, bVal)];

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
     * @param {ArrayLike<number>} data
     * @param {number} width
     * @param {number} height
     * @param {number} channels
     * @param {number} min
     * @param {number} max
     * @param {RenderOptions} [options]
     */
    static _renderUint8Direct(data, width, height, channels, min, max, options = {}) {
        const out = new Uint8ClampedArray(width * height * 4);
        const nanColor = options.nanColor || { r: 255, g: 0, b: 255 };

        if (options.rgbAs24BitGrayscale && channels >= 3) {
            const range = max - min;
            const invRange = range > 0 ? 1.0 / range : 0;

            for (let i = 0; i < width * height; i++) {
                const idx = i * channels;
                const rVal = data[idx], gVal = data[idx + 1], bVal = data[idx + 2];
                const p = i * 4;

                if (!Number.isFinite(rVal) || !Number.isFinite(gVal) || !Number.isFinite(bVal)) {
                    out[p] = nanColor.r; out[p + 1] = nanColor.g; out[p + 2] = nanColor.b; out[p + 3] = 255;
                    continue;
                }

                const val24 = (rVal << 16) | (gVal << 8) | bVal;
                const normalized = (val24 - min) * invRange;
                const val8 = Math.round(Math.max(0, Math.min(1, normalized)) * 255);

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
                    if (!Number.isFinite(value)) {
                        out[p] = nanColor.r; out[p + 1] = nanColor.g; out[p + 2] = nanColor.b; out[p + 3] = 255;
                        continue;
                    }
                    out[p] = out[p + 1] = out[p + 2] = value;
                } else if (channels === 3) {
                    const idx = i * 3;
                    const rVal = data[idx], gVal = data[idx + 1], bVal = data[idx + 2];
                    if (!Number.isFinite(rVal) || !Number.isFinite(gVal) || !Number.isFinite(bVal)) {
                        out[p] = nanColor.r; out[p + 1] = nanColor.g; out[p + 2] = nanColor.b; out[p + 3] = 255;
                        continue;
                    }
                    out[p] = rVal;
                    out[p + 1] = gVal;
                    out[p + 2] = bVal;
                } else if (channels === 4) {
                    const idx = i * 4;
                    const rVal = data[idx], gVal = data[idx + 1], bVal = data[idx + 2];
                    if (!Number.isFinite(rVal) || !Number.isFinite(gVal) || !Number.isFinite(bVal)) {
                        out[p] = nanColor.r; out[p + 1] = nanColor.g; out[p + 2] = nanColor.b; out[p + 3] = 255;
                        continue;
                    }
                    out[p] = rVal;
                    out[p + 1] = gVal;
                    out[p + 2] = bVal;
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
                let r = 0, g = 0, b = 0;

                if (channels === 1) {
                    const value = data[i];
                    if (!Number.isFinite(value)) {
                        const p = i * 4;
                        out[p] = nanColor.r; out[p + 1] = nanColor.g; out[p + 2] = nanColor.b; out[p + 3] = 255;
                        continue;
                    }
                    r = g = b = Math.round((Math.max(min, Math.min(max, value)) - min) * invRange);
                } else if (channels === 3) {
                    const idx = i * 3;
                    const rVal = data[idx], gVal = data[idx + 1], bVal = data[idx + 2];
                    if (!Number.isFinite(rVal) || !Number.isFinite(gVal) || !Number.isFinite(bVal)) {
                        const p = i * 4;
                        out[p] = nanColor.r; out[p + 1] = nanColor.g; out[p + 2] = nanColor.b; out[p + 3] = 255;
                        continue;
                    }
                    r = Math.round((Math.max(min, Math.min(max, rVal)) - min) * invRange);
                    g = Math.round((Math.max(min, Math.min(max, gVal)) - min) * invRange);
                    b = Math.round((Math.max(min, Math.min(max, bVal)) - min) * invRange);
                } else if (channels === 4) {
                    const idx = i * 4;
                    const rVal = data[idx], gVal = data[idx + 1], bVal = data[idx + 2];
                    if (!Number.isFinite(rVal) || !Number.isFinite(gVal) || !Number.isFinite(bVal)) {
                        const p = i * 4;
                        out[p] = nanColor.r; out[p + 1] = nanColor.g; out[p + 2] = nanColor.b; out[p + 3] = 255;
                        continue;
                    }
                    r = Math.round((Math.max(min, Math.min(max, rVal)) - min) * invRange);
                    g = Math.round((Math.max(min, Math.min(max, gVal)) - min) * invRange);
                    b = Math.round((Math.max(min, Math.min(max, bVal)) - min) * invRange);

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
     * @param {ArrayLike<number>} data
     * @param {number} width
     * @param {number} height
     * @param {number} channels
     * @param {number} min
     * @param {number} max
     * @param {ImageSettings} settings
     * @param {RenderOptions} [options]
     */
    static _renderUint8WithLUT(data, width, height, channels, min, max, settings, options = {}) {
        const out = new Uint8ClampedArray(width * height * 4);
        const nanColor = options.nanColor || { r: 255, g: 0, b: 255 };

        if (options.rgbAs24BitGrayscale && channels >= 3) {
            const range = max - min;
            const invRange = range > 0 ? 1.0 / range : 0;

            for (let i = 0; i < width * height; i++) {
                const idx = i * channels;
                const rVal = data[idx], gVal = data[idx + 1], bVal = data[idx + 2];
                const p = i * 4;

                if (!Number.isFinite(rVal) || !Number.isFinite(gVal) || !Number.isFinite(bVal)) {
                    out[p] = nanColor.r; out[p + 1] = nanColor.g; out[p + 2] = nanColor.b; out[p + 3] = 255;
                    continue;
                }

                const val24 = (rVal << 16) | (gVal << 8) | bVal;
                let normalized = (val24 - min) * invRange;
                normalized = NormalizationHelper.applyGammaAndBrightness(normalized, settings);
                const val8 = Math.round(Math.max(0, Math.min(1, normalized)) * 255);

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
            let r = 0, g = 0, b = 0;

            if (channels === 1) {
                const value = data[i];
                if (!Number.isFinite(value)) {
                    const p = i * 4;
                    out[p] = nanColor.r; out[p + 1] = nanColor.g; out[p + 2] = nanColor.b; out[p + 3] = 255;
                    continue;
                }
                r = g = b = lut[value];
            } else if (channels === 3) {
                const idx = i * 3;
                const rVal = data[idx], gVal = data[idx + 1], bVal = data[idx + 2];
                if (!Number.isFinite(rVal) || !Number.isFinite(gVal) || !Number.isFinite(bVal)) {
                    const p = i * 4;
                    out[p] = nanColor.r; out[p + 1] = nanColor.g; out[p + 2] = nanColor.b; out[p + 3] = 255;
                    continue;
                }
                r = lut[rVal];
                g = lut[gVal];
                b = lut[bVal];
            } else if (channels === 4) {
                const idx = i * 4;
                const rVal = data[idx], gVal = data[idx + 1], bVal = data[idx + 2];
                if (!Number.isFinite(rVal) || !Number.isFinite(gVal) || !Number.isFinite(bVal)) {
                    const p = i * 4;
                    out[p] = nanColor.r; out[p + 1] = nanColor.g; out[p + 2] = nanColor.b; out[p + 3] = 255;
                    continue;
                }
                r = lut[rVal];
                g = lut[gVal];
                b = lut[bVal];

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

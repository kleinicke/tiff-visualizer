// @ts-check
"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';
import parseHdr from 'parse-hdr';

/**
 * HDR (RGBE) Processor for TIFF Visualizer
 * Parses Radiance HDR format files and renders them to ImageData
 */
export class HdrProcessor {
    constructor(settingsManager, vscode) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        this._lastRaw = null; // { width, height, data: Float32Array }
        this._pendingRenderData = null; // Store data waiting for format-specific settings
        this._isInitialLoad = true; // Track if this is the first render
        /** @type {{min: number, max: number} | undefined} */
        this._cachedStats = undefined; // Cache for min/max stats (only used in stats mode)
    }

    _detectSingleChannelRgb(data) {
        const eps = 1e-12;
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let maxR = 0;
        let maxG = 0;
        let maxB = 0;

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            if (Number.isFinite(r)) {
                const ar = Math.abs(r);
                sumR += ar;
                maxR = Math.max(maxR, ar);
            }
            if (Number.isFinite(g)) {
                const ag = Math.abs(g);
                sumG += ag;
                maxG = Math.max(maxG, ag);
            }
            if (Number.isFinite(b)) {
                const ab = Math.abs(b);
                sumB += ab;
                maxB = Math.max(maxB, ab);
            }
        }

        const sums = [sumR, sumG, sumB];
        const maxes = [maxR, maxG, maxB];
        const total = sumR + sumG + sumB;
        if (!(total > eps)) {
            return -1;
        }

        const dominantIndex = sums[1] > sums[0] ? (sums[2] > sums[1] ? 2 : 1) : (sums[2] > sums[0] ? 2 : 0);
        const dominantSum = sums[dominantIndex];
        const dominantMax = maxes[dominantIndex];
        const otherA = sums[(dominantIndex + 1) % 3];
        const otherB = sums[(dominantIndex + 2) % 3];
        const otherMaxA = maxes[(dominantIndex + 1) % 3];
        const otherMaxB = maxes[(dominantIndex + 2) % 3];

        const dominantRatio = dominantSum / total;
        const othersTinyVsDominant = otherA <= dominantSum * 1e-4 && otherB <= dominantSum * 1e-4;
        const othersLowAbsolute = otherMaxA <= dominantMax * 1e-3 && otherMaxB <= dominantMax * 1e-3;

        if (dominantRatio >= 0.999 && othersTinyVsDominant && othersLowAbsolute) {
            return dominantIndex;
        }

        return -1;
    }

    _remapSingleChannelToGray(data, channelIndex) {
        const remapped = new Float32Array(data.length);
        for (let i = 0; i < data.length; i += 4) {
            const v = data[i + channelIndex];
            remapped[i] = v;
            remapped[i + 1] = v;
            remapped[i + 2] = v;
            remapped[i + 3] = 1.0;
        }
        return remapped;
    }

    async processHdr(src) {
        const response = await fetch(src);
        const buffer = await response.arrayBuffer();
        
        // Parse the HDR file using parse-hdr
        // Returns { shape: [width, height], exposure, gamma, data: Float32Array }
        const parsed = parseHdr(buffer);
        const width = parsed.shape[0];
        const height = parsed.shape[1];
        let data = parsed.data; // The floating point pixel array [R, G, B, A, R, G, B, A, ..]
        const singleChannelIndex = this._detectSingleChannelRgb(data);
        if (singleChannelIndex >= 0) {
            // Some "single-channel HDR" test files store values in only one RGB component.
            // Remap that component to grayscale so visualization is channel-agnostic.
            data = this._remapSingleChannelToGray(data, singleChannelIndex);
        }
        const channels = 4; // parse-hdr returns RGBA float data

        // Invalidate stats cache for new image
        this._cachedStats = undefined;

        this._lastRaw = { width, height, data, channels };

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        // Send format info BEFORE rendering (for deferred rendering)
        if (this._isInitialLoad) {
            this._postFormatInfo(width, height, channels, 'HDR');
            this._pendingRenderData = { displayData: data, width, height, channels };
            // Return placeholder
            const placeholderImageData = new ImageData(width, height);
            return { canvas, imageData: placeholderImageData };
        }

        // Non-initial loads - render immediately
        this._postFormatInfo(width, height, channels, 'HDR');
        const imageData = this._toImageDataFloat(data, width, height, channels);
        this.vscode.postMessage({ type: 'refresh-status' });
        return { canvas, imageData };
    }

    _toImageDataFloat(data, width, height, channels = 3) {
        const settings = this.settingsManager.settings;
        const isGammaMode = settings.normalization?.gammaMode || false;

        // Calculate stats if needed (for auto-normalize or just to have them)
        /** @type {{min: number, max: number} | undefined} */
        let stats = this._cachedStats;
        if (!stats && !isGammaMode) {
            stats = ImageStatsCalculator.calculateFloatStats(data, width, height, channels);
            this._cachedStats = stats;

            if (this.vscode) {
                this.vscode.postMessage({ type: 'stats', value: stats });
            }
        }

        // Use centralized ImageRenderer
        return ImageRenderer.render(
            data,
            width,
            height,
            channels,
            true, // isFloat (float32)
            stats || { min: 0, max: 1 },
            settings,
            {} // No special options for HDR
        );
    }

    getColorAtPixel(x, y, naturalWidth, naturalHeight) {
        if (!this._lastRaw) return '';
        const { width, height, data, channels } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';

        const idx = y * width + x;

        // Helper to format individual values (avoid scientific notation)
        const formatValue = (v) => {
            if (Number.isNaN(v)) return 'NaN';
            if (v === Infinity) return 'Inf';
            if (v === -Infinity) return '-Inf';
            // Show up to 6 decimal places, but remove trailing zeros
            return parseFloat(v.toFixed(6)).toString();
        };

        if (channels === 3 || channels === 4) {
            // RGB/RGBA float data - return RGB values for consistency with other float viewers
            const baseIdx = idx * channels;
            if (baseIdx >= 0 && baseIdx + 2 < data.length) {
                const r = data[baseIdx];
                const g = data[baseIdx + 1];
                const b = data[baseIdx + 2];
                return `${formatValue(r)} ${formatValue(g)} ${formatValue(b)}`;
            }
        }
        return '';
    }

    _postFormatInfo(width, height, channels, formatLabel) {
        if (!this.vscode) return;
        this.vscode.postMessage({
            type: 'formatInfo',
            value: {
                width,
                height,
                compression: '1',
                predictor: 3,
                photometricInterpretation: 2, // RGB
                planarConfig: 1, // Chunky
                samplesPerPixel: channels,
                bitsPerSample: 32,
                sampleFormat: 3, // Float
                formatLabel,
                formatType: 'hdr', // For per-format settings
                isInitialLoad: this._isInitialLoad // Signal that this is the first load
            }
        });
    }

    /**
     * Perform the initial render if it was deferred
     * Called when format-specific settings have been applied
     * @returns {ImageData|null} - The rendered image data, or null if no pending render
     */
    performDeferredRender() {
        if (!this._pendingRenderData) {
            return null;
        }

        const { displayData, width, height, channels } = this._pendingRenderData;
        this._pendingRenderData = null;
        this._isInitialLoad = false;

        // Now render with the correct format-specific settings
        const imageData = this._toImageDataFloat(displayData, width, height, channels);

        // Force status refresh
        this.vscode.postMessage({ type: 'refresh-status' });

        return imageData;
    }

    /**
     * Re-render HDR with current settings (for real-time updates)
     * @returns {ImageData | null}
     */
    renderHdrWithSettings() {
        if (!this._lastRaw) return null;
        const { width, height, data, channels } = this._lastRaw;
        return this._toImageDataFloat(data, width, height, channels);
    }
}

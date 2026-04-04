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

    async processHdr(src) {
        const response = await fetch(src);
        const buffer = await response.arrayBuffer();
        
        // Parse the HDR file using parse-hdr
        // Returns { shape: [width, height], exposure, gamma, data: Float32Array }
        const parsed = parseHdr(buffer);
        const width = parsed.shape[0];
        const height = parsed.shape[1];
        const data = parsed.data; // The floating point pixel array [R, G, B, R, G, B, ..]
        const channels = 3; // RGBE decodes to RGB float data

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

        if (channels === 3) {
            // RGB data - return space-separated values
            const baseIdx = idx * 3;
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

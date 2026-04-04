// @ts-check
"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';

/** @typedef {import('./settings-manager.js').SettingsManager} SettingsManager */
/** @typedef {import('./settings-manager.js').ImageSettings} ImageSettings */
/** @typedef {{postMessage: (msg: any) => any}} VsCodeApi */

/**
 * PFM Processor for TIFF Visualizer
 * Supports grayscale (Pf) and RGB (PF) portable float map files
 */
export class PfmProcessor {
    /**
     * @param {SettingsManager} settingsManager
     * @param {VsCodeApi} vscode
     */
    constructor(settingsManager, vscode) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        this._lastRaw = null; // { width, height, data: Float32Array }
        this._pendingRenderData = null; // Store data waiting for format-specific settings
        this._isInitialLoad = true; // Track if this is the first render
        /** @type {{min: number, max: number} | undefined} */
        this._cachedStats = undefined; // Cache for min/max stats (only used in stats mode)
    }

    /** @param {string} src */
    async processPfm(src) {
        const response = await fetch(src);
        const buffer = await response.arrayBuffer();
        const { width, height, channels, data } = this._parsePfm(buffer);
        // Keep color data for RGB PFM files
        let displayData = data;

        // PFM format stores rows from bottom to top, so we need to flip vertically
        displayData = this._flipImageVertically(displayData, width, height, channels);

        // Invalidate stats cache for new image
        this._cachedStats = undefined;

        this._lastRaw = { width, height, data: displayData, channels };

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        // Send format info BEFORE rendering (for deferred rendering)
        if (this._isInitialLoad) {
            this._postFormatInfo(width, height, channels, 'PFM');
            this._pendingRenderData = { displayData, width, height, channels };
            // Return placeholder
            const placeholderImageData = new ImageData(width, height);
            return { canvas, imageData: placeholderImageData };
        }

        // Non-initial loads - render immediately
        this._postFormatInfo(width, height, channels, 'PFM');
        const imageData = this._toImageDataFloat(displayData, width, height, channels);
        this.vscode.postMessage({ type: 'refresh-status' });
        return { canvas, imageData };
    }

    /** @param {ArrayBuffer} arrayBuffer */
    _parsePfm(arrayBuffer) {
        const text = new TextDecoder('ascii').decode(arrayBuffer);
        // Read header lines
        const lines = text.split(/\n/);
        let idx = 0;
        while (idx < lines.length && lines[idx].trim() === '') idx++;
        const type = lines[idx++].trim();
        if (type !== 'PF' && type !== 'Pf') throw new Error('Invalid PFM magic');
        // Skip comments
        while (idx < lines.length && lines[idx].trim().startsWith('#')) idx++;
        const dims = lines[idx++].trim().split(/\s+/).map(n => parseInt(n, 10));
        const width = dims[0];
        const height = dims[1];
        const scale = parseFloat(lines[idx++].trim());
        const littleEndian = scale < 0;
        const channels = type === 'PF' ? 3 : 1;
        // Find start byte offset of pixel data
        const headerUpTo = lines.slice(0, idx).join('\n') + '\n';
        const headerBytes = new TextEncoder().encode(headerUpTo).length;
        const bytesPerPixel = 4 * channels;
        const dv = new DataView(arrayBuffer, headerBytes);
        const pixels = width * height;
        const out = new Float32Array(pixels * channels);
        let o = 0;
        for (let i = 0; i < pixels; i++) {
            for (let c = 0; c < channels; c++) {
                const v = dv.getFloat32((i * channels + c) * 4, littleEndian);
                out[o++] = v;
            }
        }
        return { width, height, channels, data: out };
    }

    /**
     * @param {Float32Array} data
     * @param {number} width
     * @param {number} height
     * @param {number} [channels]
     */
    _toImageDataFloat(data, width, height, channels = 1) {
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
            { nanColor: this._getNanColor(settings) }
        );
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {number} naturalWidth
     * @param {number} naturalHeight
     */
    getColorAtPixel(x, y, naturalWidth, naturalHeight) {
        if (!this._lastRaw) return '';
        const { width, height, data, channels } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';

        const idx = y * width + x;

        // Helper to format individual values (avoid scientific notation)
        const formatValue = (/** @type {number} */ v) => {
            if (Number.isNaN(v)) return 'NaN';
            if (v === Infinity) return 'Inf';
            if (v === -Infinity) return '-Inf';
            // Use fixed decimal notation to avoid scientific notation
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
        } else {
            // Grayscale data
            const value = data[idx];
            return formatValue(value);
        }
        return '';
    }

    /**
     * @param {any} settings
     * @returns {{r: number, g: number, b: number}}
     */
    _getNanColor(settings) {
        if (settings.nanColor === 'fuchsia') {
            return { r: 255, g: 0, b: 255 };
        } else {
            return { r: 0, g: 0, b: 0 };
        }
    }

    /**
     * @param {number} width
     * @param {number} height
     * @param {number} channels
     * @param {string} formatLabel
     */
    _postFormatInfo(width, height, channels, formatLabel) {
        if (!this.vscode) return;
        this.vscode.postMessage({
            type: 'formatInfo',
            value: {
                width,
                height,
                compression: '1',
                predictor: 3,
                photometricInterpretation: channels === 3 ? 2 : 1,
                planarConfig: 1,
                samplesPerPixel: channels,
                bitsPerSample: 32,
                sampleFormat: 3,
                formatLabel,
                formatType: 'pfm', // For per-format settings
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
     * Re-render PFM with current settings (for real-time updates)
     * @returns {ImageData | null}
     */
    renderPfmWithSettings() {
        if (!this._lastRaw) return null;
        const { width, height, data, channels } = this._lastRaw;
        return this._toImageDataFloat(data, width, height, channels);
    }

    /**
     * Update settings and trigger re-render
     * @param {ImageSettings} settings - New settings
     */
    updateSettings(settings) {
        this.settingsManager.updateSettings(settings);
        // Invalidate cached stats when settings change (especially for auto-normalize)
        if (settings.normalization?.autoNormalize !== this.settingsManager.settings.normalization?.autoNormalize) {
            this._cachedStats = undefined;
        }
        // Post message to trigger re-render in main code
        if (this.vscode) {
            this.vscode.postMessage({ type: 'settings-updated' });
        }
    }

    /**
     * @param {Float32Array} data
     * @param {number} width
     * @param {number} height
     * @param {number} [channels]
     */
    _flipImageVertically(data, width, height, channels = 1) {
        const flipped = new Float32Array(data.length);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (channels === 3) {
                    // RGB data - flip each channel
                    const srcIdx = (y * width + x) * 3;
                    const dstIdx = ((height - 1 - y) * width + x) * 3;
                    flipped[dstIdx] = data[srcIdx];         // R
                    flipped[dstIdx + 1] = data[srcIdx + 1]; // G
                    flipped[dstIdx + 2] = data[srcIdx + 2]; // B
                } else {
                    // Grayscale data
                    const srcIdx = y * width + x;
                    const dstIdx = (height - 1 - y) * width + x;
                    flipped[dstIdx] = data[srcIdx];
                }
            }
        }
        return flipped;
    }
}



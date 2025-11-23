// @ts-check
"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';

/**
 * Convert IEEE 754 half-precision (float16) to single-precision (float32)
 * @param {number} uint16 - The 16-bit representation
 * @returns {number} The float32 value
 */
function float16ToFloat32(uint16) {
    const sign = (uint16 & 0x8000) >> 15;
    const exponent = (uint16 & 0x7C00) >> 10;
    const fraction = uint16 & 0x03FF;

    if (exponent === 0) {
        // Subnormal or zero
        if (fraction === 0) {
            return sign ? -0.0 : 0.0;
        }
        // Subnormal numbers
        return (sign ? -1 : 1) * Math.pow(2, -14) * (fraction / 1024);
    } else if (exponent === 0x1F) {
        // Infinity or NaN
        return fraction ? NaN : (sign ? -Infinity : Infinity);
    }

    // Normalized number
    return (sign ? -1 : 1) * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

/**
 * NPY/NPZ Processor for TIFF Visualizer
 * Parses NumPy .npy and .npz files and renders them to ImageData
 */
export class NpyProcessor {
    constructor(settingsManager, vscode) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        this._lastRaw = null; // { width, height, data: Float32Array, dtype: string, showNorm: boolean }
        this._pendingRenderData = null; // Store data waiting for format-specific settings
        this._isInitialLoad = true; // Track if this is the first render
        /** @type {{min: number, max: number} | undefined} */
        this._cachedStats = undefined; // Cache for min/max stats (only used in stats mode)
    }

    async processNpy(src) {
        // Invalidate stats cache for new image
        this._cachedStats = undefined;

        const response = await fetch(src);
        const buffer = await response.arrayBuffer();
        const view = new DataView(buffer);

        // NPZ (ZIP) signature 0x04034b50
        if (buffer.byteLength >= 4 && view.getUint32(0, true) === 0x04034b50) {
            const { data, width, height, dtype, showNorm, channels } = this._parseNpz(buffer);
            this._lastRaw = { width, height, data, dtype, showNorm, channels };

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            // Send format info BEFORE rendering (for deferred rendering)
            if (this._isInitialLoad) {
                this._postFormatInfo(width, height, 'NPY');
                this._pendingRenderData = { data, width, height };
                // Return placeholder
                const placeholderImageData = new ImageData(width, height);
                return { canvas, imageData: placeholderImageData };
            }

            // Non-initial loads - render immediately
            const imageData = this._toImageDataFloat(data, width, height);
            this.vscode.postMessage({ type: 'refresh-status' });
            return { canvas, imageData };
        }

        const { data, width, height, dtype, showNorm, channels } = this._parseNpy(buffer);
        this._lastRaw = { width, height, data, dtype, showNorm, channels };

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        // Send format info BEFORE rendering (for deferred rendering)
        if (this._isInitialLoad) {
            this._postFormatInfo(width, height, 'NPY');
            this._pendingRenderData = { data, width, height };
            // Return placeholder
            const placeholderImageData = new ImageData(width, height);
            return { canvas, imageData: placeholderImageData };
        }

        // Non-initial loads - render immediately
        const imageData = this._toImageDataFloat(data, width, height);
        this.vscode.postMessage({ type: 'refresh-status' });
        return { canvas, imageData };
    }

    _parseNpy(arrayBuffer) {
        const view = new DataView(arrayBuffer);
        // Magic '\x93NUMPY'
        const magic = new Uint8Array(arrayBuffer, 0, 6);
        const expected = [0x93, 0x4E, 0x55, 0x4D, 0x50, 0x59];
        for (let i = 0; i < 6; i++) {
            if (magic[i] !== expected[i]) {
                throw new Error('Invalid NPY file');
            }
        }
        const major = view.getUint8(6);
        const minor = view.getUint8(7);
        if (major !== 1 && major !== 2) {
            throw new Error(`Unsupported NPY version ${major}.${minor}`);
        }
        const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
        const headerStart = major === 1 ? 10 : 12;
        const headerBytes = new Uint8Array(arrayBuffer, headerStart, headerLen);
        const header = new TextDecoder('latin1').decode(headerBytes);
        const shapeMatch = header.match(/'shape':\s*\(([^)]+)\)/);
        if (!shapeMatch) throw new Error('NPY missing shape');
        const dims = shapeMatch[1].split(',').map(s => s.trim()).filter(Boolean).map(s => parseInt(s, 10));
        const dtypeMatch = header.match(/'descr':\s*'([^']+)'/);
        if (!dtypeMatch) throw new Error('NPY missing dtype');
        const dtype = dtypeMatch[1];

        // Determine if this is a float type
        const showNorm = dtype.includes('f');

        let height, width, channels = 1;
        if (dims.length === 2) {
            height = dims[0];
            width = dims[1];
        } else if (dims.length === 3) {
            height = dims[0];
            width = dims[1];
            channels = dims[2];
        } else {
            throw new Error(`Unsupported NPY dims ${dims.length}`);
        }
        const elems = width * height * channels;
        const off = headerStart + headerLen;
        let raw;
        if (dtype === '<f4' || dtype === '=f4') {
            raw = new Float32Array(arrayBuffer, off, elems);
        } else if (dtype === '>f4') {
            const bytes = new Uint8Array(arrayBuffer, off, elems * 4);
            raw = new Float32Array(elems);
            for (let i = 0; i < elems; i++) {
                const j = i * 4;
                const b0 = bytes[j + 3];
                const b1 = bytes[j + 2];
                const b2 = bytes[j + 1];
                const b3 = bytes[j + 0];
                raw[i] = new Float32Array(new Uint8Array([b0, b1, b2, b3]).buffer)[0];
            }
        } else if (dtype.endsWith('f8')) {
            const src = new Float64Array(arrayBuffer, off, elems);
            raw = new Float32Array(elems);
            for (let i = 0; i < elems; i++) raw[i] = src[i];
        } else if (dtype.includes('f2')) {
            // Float16 (half precision) - JavaScript doesn't have native Float16Array
            // We need to decode manually
            const bytes = new Uint8Array(arrayBuffer, off, elems * 2);
            const little = dtype.startsWith('<') || dtype.startsWith('=');
            raw = new Float32Array(elems);
            for (let i = 0; i < elems; i++) {
                const p = i * 2;
                const uint16 = little ?
                    bytes[p] | (bytes[p + 1] << 8) :
                    (bytes[p] << 8) | bytes[p + 1];
                raw[i] = float16ToFloat32(uint16);
            }
        } else {
            // Fallback for integers
            const bytes = parseInt(dtype.slice(-1), 10);
            const little = dtype.startsWith('<') || dtype.startsWith('=');
            const dv = new DataView(arrayBuffer, off);
            raw = new Float32Array(elems);
            for (let i = 0; i < elems; i++) {
                const p = i * bytes;
                let v = 0;
                if (bytes === 1) v = dtype.includes('u') ? dv.getUint8(p) : dv.getInt8(p);
                else if (bytes === 2) v = dtype.includes('u') ? dv.getUint16(p, little) : dv.getInt16(p, little);
                else if (bytes === 4) v = dtype.includes('u') ? dv.getUint32(p, little) : dv.getInt32(p, little);
                else v = Number(dtype.includes('u') ? dv.getBigUint64(p, little) : dv.getBigInt64(p, little));
                raw[i] = v;
            }
        }
        let data;
        if (channels === 1) {
            data = raw;
        } else if (channels === 3 || channels === 4) {
            // Keep RGB/RGBA data intact
            data = raw;
        } else {
            // For other channel counts, take first channel only
            data = new Float32Array(width * height);
            for (let i = 0; i < width * height; i++) data[i] = raw[i * channels + 0];
        }
        return { data, width, height, dtype, showNorm, channels };
    }

    _parseNpz(arrayBuffer) {
        const view = new DataView(arrayBuffer);
        let offset = 0;
        const arrays = {};
        while (offset < arrayBuffer.byteLength - 4) {
            const sig = view.getUint32(offset, true);
            if (sig !== 0x04034b50) { offset++; continue; }
            const comp = view.getUint16(offset + 8, true);
            const nameLen = view.getUint16(offset + 26, true);
            const extraLen = view.getUint16(offset + 28, true);
            const compSize = view.getUint32(offset + 18, true);
            const fileName = new TextDecoder().decode(new Uint8Array(arrayBuffer, offset + 30, nameLen));
            const dataOffset = offset + 30 + nameLen + extraLen;
            if (fileName.endsWith('.npy') && comp === 0) {
                const slice = arrayBuffer.slice(dataOffset, dataOffset + compSize);
                const { data, width, height, dtype, showNorm, channels } = this._parseNpy(slice);
                arrays[fileName.replace('.npy', '')] = { data, width, height, dtype, showNorm, channels };
            }
            offset = dataOffset + compSize;
        }
        // Choose best candidate
        const keys = Object.keys(arrays);
        if (keys.length === 0) throw new Error('NPZ contains no uncompressed .npy arrays');
        let pick = keys.find(k => /depth|dispar|inv|z|range/i.test(k));
        if (!pick) pick = keys[0];
        const a = arrays[pick];
        return { data: a.data, width: a.width, height: a.height, dtype: a.dtype, showNorm: a.showNorm, channels: a.channels };
    }

    _toImageDataFloat(data, width, height) {
        const channels = this._lastRaw?.channels || 1;
        const settings = this.settingsManager.settings;
        const rgbAs24BitMode = settings.rgbAs24BitGrayscale && channels === 3;
        const dtype = this._lastRaw?.dtype || 'f4';
        const isFloat = dtype.includes('f');
        const isGammaMode = settings.normalization?.gammaMode || false;

        // Calculate stats if needed (for auto-normalize or just to have them)
        /** @type {{min: number, max: number} | undefined} */
        let stats = this._cachedStats;

        if (!stats && !isGammaMode) {
            if (isFloat) {
                stats = ImageStatsCalculator.calculateFloatStats(data, width, height, channels);
            } else {
                stats = ImageStatsCalculator.calculateIntegerStats(data, width, height, channels, rgbAs24BitMode);
            }
            this._cachedStats = stats;

            if (this.vscode) {
                this.vscode.postMessage({ type: 'stats', value: stats });
            }
        }

        const nanColor = this._getNanColor(settings);

        // Determine typeMax for integer types
        let typeMax;
        if (!isFloat) {
            if (dtype.includes('1')) typeMax = 255;
            else if (dtype.includes('2')) typeMax = 65535;
            else if (dtype.includes('4')) typeMax = 4294967295; // 32-bit
        }

        // Create options object
        const options = {
            nanColor: nanColor,
            rgbAs24BitGrayscale: rgbAs24BitMode,
            flipY: false, // NPY is usually top-down
            typeMax: typeMax
        };

        return ImageRenderer.render(
            data,
            width,
            height,
            channels,
            true, // Always true since NPY stores everything as Float32Array
            stats || { min: 0, max: 1 },
            settings,
            options
        );
    }


    /**
     * Re-render NPY with current settings (for real-time updates)
     * @returns {ImageData | null}
     */
    renderNpyWithSettings() {
        if (!this._lastRaw) return null;
        const { width, height, data } = this._lastRaw;
        return this._toImageDataFloat(data, width, height);
    }

    getColorAtPixel(x, y, naturalWidth, naturalHeight) {
        if (!this._lastRaw) return '';
        const { width, height, data, channels, dtype } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';

        const pixelIdx = y * width + x;
        const settings = this.settingsManager.settings;
        const rgbAs24BitMode = settings.rgbAs24BitGrayscale && channels === 3;
        const normalizedFloatMode = settings.normalizedFloatMode;

        if (rgbAs24BitMode) {
            // RGB as 24-bit grayscale: show combined value
            const srcIdx = pixelIdx * 3;
            const rVal = Math.round(Math.max(0, Math.min(255, data[srcIdx + 0])));
            const gVal = Math.round(Math.max(0, Math.min(255, data[srcIdx + 1])));
            const bVal = Math.round(Math.max(0, Math.min(255, data[srcIdx + 2])));
            const combined24bit = (rVal << 16) | (gVal << 8) | bVal;

            // Apply scale factor for display
            const scaleFactor = settings.scale24BitFactor || 1000;
            const scaledValue = (combined24bit / scaleFactor).toFixed(3);
            return scaledValue;
        } else if (channels === 3) {
            // RGB data - return space-separated values (avoid scientific notation)
            const srcIdx = pixelIdx * 3;
            const r = data[srcIdx + 0];
            const g = data[srcIdx + 1];
            const b = data[srcIdx + 2];
            if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
                const formatNumber = (n) => {
                    // Use fixed decimal notation to avoid scientific notation
                    // Show up to 6 decimal places, but remove trailing zeros
                    return parseFloat(n.toFixed(6)).toString();
                };
                return `${formatNumber(r)} ${formatNumber(g)} ${formatNumber(b)}`;
            }
        } else if (channels === 4) {
            // RGBA data - return space-separated values with α: prefix for alpha
            const srcIdx = pixelIdx * 4;
            const r = data[srcIdx + 0];
            const g = data[srcIdx + 1];
            const b = data[srcIdx + 2];
            const a = data[srcIdx + 3];
            if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && Number.isFinite(a)) {
                const formatNumber = (n) => {
                    // Use fixed decimal notation to avoid scientific notation
                    // Show up to 6 decimal places, but remove trailing zeros
                    return parseFloat(n.toFixed(6)).toString();
                };
                return `${formatNumber(r)} ${formatNumber(g)} ${formatNumber(b)} α:${formatNumber(a)}`;
            }
        } else {
            // Grayscale data
            const value = data[pixelIdx];
            if (Number.isFinite(value)) {
                const formatNumber = (n) => {
                    // Use fixed decimal notation to avoid scientific notation
                    // Show up to 6 decimal places, but remove trailing zeros
                    return parseFloat(n.toFixed(6)).toString();
                };
                // Check if normalized float mode is enabled for uint images
                if (normalizedFloatMode && dtype && !dtype.includes('f')) {
                    // Convert uint to normalized float (0-1)
                    let maxValue = 255;
                    if (dtype.includes('u2') || dtype.includes('i2')) {
                        maxValue = dtype.includes('u') ? 65535 : 32767;
                    } else if (dtype.includes('u4') || dtype.includes('i4')) {
                        maxValue = dtype.includes('u') ? 4294967295 : 2147483647;
                    }
                    const normalized = value / maxValue;
                    return formatNumber(normalized);
                }
                return formatNumber(value);
            }
        }
        return '';
    }

    /**
     * Send format info to VS Code
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {string} formatLabel - Format label
     */
    _postFormatInfo(width, height, formatLabel) {
        if (!this.vscode) return;

        // Determine actual bit depth and sample format from dtype
        let bitsPerSample = 32;
        let sampleFormat = 3; // Float

        if (this._lastRaw && this._lastRaw.dtype) {
            const dtype = this._lastRaw.dtype;

            // Determine sample format: 1=uint, 2=int, 3=float
            if (dtype.includes('f')) {
                sampleFormat = 3; // Float
                if (dtype.includes('f2')) bitsPerSample = 16;
                else if (dtype.includes('f4')) bitsPerSample = 32;
                else if (dtype.includes('f8')) bitsPerSample = 64;
            } else if (dtype.includes('u')) {
                sampleFormat = 1; // Unsigned int
                if (dtype.includes('u1')) bitsPerSample = 8;
                else if (dtype.includes('u2')) bitsPerSample = 16;
                else if (dtype.includes('u4')) bitsPerSample = 32;
                else if (dtype.includes('u8')) bitsPerSample = 64;
            } else if (dtype.includes('i')) {
                sampleFormat = 2; // Signed int
                if (dtype.includes('i1')) bitsPerSample = 8;
                else if (dtype.includes('i2')) bitsPerSample = 16;
                else if (dtype.includes('i4')) bitsPerSample = 32;
                else if (dtype.includes('i8')) bitsPerSample = 64;
            }
        }

        const channels = this._lastRaw?.channels || 1;

        // Determine specific NPY format type for per-format settings
        let formatType = 'npy';
        if (sampleFormat === 3) {
            formatType = 'npy-float';
        } else if (sampleFormat === 1 || sampleFormat === 2) {
            formatType = 'npy-uint';
        }

        this.vscode.postMessage({
            type: 'formatInfo',
            value: {
                width,
                height,
                compression: '1',
                predictor: 3,
                photometricInterpretation: channels >= 3 ? 2 : 1,
                planarConfig: 1,
                samplesPerPixel: channels,
                bitsPerSample,
                sampleFormat,
                formatLabel,
                formatType, // For per-format settings: 'npy-float' or 'npy-uint'
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

        const { data, width, height } = this._pendingRenderData;
        this._pendingRenderData = null;
        this._isInitialLoad = false;

        // Now render with the correct format-specific settings
        const imageData = this._toImageDataFloat(data, width, height);

        // Force status refresh so normalization UI appears
        this.vscode.postMessage({ type: 'refresh-status' });

        return imageData;
    }

    /**
     * Get NaN color from settings
     * @param {Object} settings
     * @returns {{r: number, g: number, b: number}}
     */
    _getNanColor(settings) {
        if (settings.nanColor) {
            // Handle hex string
            if (typeof settings.nanColor === 'string') {
                const hex = settings.nanColor.replace('#', '');
                return {
                    r: parseInt(hex.substring(0, 2), 16),
                    g: parseInt(hex.substring(2, 4), 16),
                    b: parseInt(hex.substring(4, 6), 16)
                };
            }
            // Handle object
            return settings.nanColor;
        }
        return { r: 255, g: 0, b: 0 }; // Default red
    }
}



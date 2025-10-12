// @ts-check
"use strict";

/**
 * PFM Processor for TIFF Visualizer
 * Supports grayscale (Pf) and RGB (PF) portable float map files
 */
export class PfmProcessor {
    constructor(settingsManager, vscode) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        this._lastRaw = null; // { width, height, data: Float32Array }
    }

    async processPfm(src) {
        const response = await fetch(src);
        const buffer = await response.arrayBuffer();
        const { width, height, channels, data } = this._parsePfm(buffer);
        // Keep color data for RGB PFM files
        let displayData = data;
        
        // PFM format stores rows from bottom to top, so we need to flip vertically
        displayData = this._flipImageVertically(displayData, width, height, channels);
        
        this._lastRaw = { width, height, data: displayData, channels };
        this._postFormatInfo(width, height, channels, 'PFM');
        const imageData = this._toImageDataFloat(displayData, width, height, channels);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        // Force status refresh so normalization UI appears immediately
        this.vscode.postMessage({ type: 'refresh-status' });
        return { canvas, imageData };
    }

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

    _toImageDataFloat(data, width, height, channels = 1) {
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < data.length; i++) {
            const v = data[i];
            if (!Number.isFinite(v)) continue;
            if (v < min) min = v;
            if (v > max) max = v;
        }
        const settings = this.settingsManager.settings;
        let normMin, normMax;
        if (settings.normalization && settings.normalization.autoNormalize) {
            normMin = min; normMax = max;
        } else if (settings.normalization && settings.normalization.gammaMode) {
            normMin = 0; normMax = 1;
        } else if (settings.normalization) {
            if (settings.normalization.min === 0 && settings.normalization.max === 1 && (min < 0 || max > 1)) {
                normMin = min; normMax = max;
            } else {
                normMin = settings.normalization.min; normMax = settings.normalization.max;
            }
        } else {
            normMin = min; normMax = max;
        }
        const range = normMax - normMin || 1;
        const out = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < width * height; i++) {
            let r, g, b;
            
            if (channels === 3) {
                // RGB data
                r = (data[i * 3 + 0] - normMin) / range;
                g = (data[i * 3 + 1] - normMin) / range;
                b = (data[i * 3 + 2] - normMin) / range;
            } else {
                // Grayscale data
                const n = (data[i] - normMin) / range;
                r = g = b = n;
            }
            
            r = Math.max(0, Math.min(1, r));
            g = Math.max(0, Math.min(1, g));
            b = Math.max(0, Math.min(1, b));
            
            if (settings.normalization && settings.normalization.gammaMode) {
                const gammaIn = settings.gamma?.in ?? 1.0;
                const gammaOut = settings.gamma?.out ?? 1.0;
                const exposureStops = settings.brightness?.offset ?? 0;

                // Correct order: remove input gamma → apply brightness → apply output gamma
                // Step 1: Remove input gamma (linearize) - raise to gammaIn power
                r = Math.pow(r, gammaIn);
                g = Math.pow(g, gammaIn);
                b = Math.pow(b, gammaIn);

                // Step 2: Apply brightness in linear space
                const brightnessFactor = Math.pow(2, exposureStops);
                r = r * brightnessFactor;
                g = g * brightnessFactor;
                b = b * brightnessFactor;

                // Step 3: Apply output gamma - raise to 1/gammaOut power
                r = Math.pow(r, 1.0 / gammaOut);
                g = Math.pow(g, 1.0 / gammaOut);
                b = Math.pow(b, 1.0 / gammaOut);

                r = Math.max(0, Math.min(1, r));
                g = Math.max(0, Math.min(1, g));
                b = Math.max(0, Math.min(1, b));
            }
            
            const p = i * 4;
            out[p] = Math.round(r * 255);     // R
            out[p + 1] = Math.round(g * 255); // G
            out[p + 2] = Math.round(b * 255); // B
            out[p + 3] = 255;                 // A
        }
        if (this.vscode) {
            this.vscode.postMessage({ type: 'showNorm', value: true });
            this.vscode.postMessage({ type: 'stats', value: { min, max } });
        }
        return new ImageData(out, width, height);
    }

    getColorAtPixel(x, y, naturalWidth, naturalHeight) {
        if (!this._lastRaw) return '';
        const { width, height, data, channels } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';
        
        const idx = y * width + x;
        if (channels === 3) {
            // RGB data
            const baseIdx = idx * 3;
            if (baseIdx >= 0 && baseIdx + 2 < data.length) {
                const r = data[baseIdx];
                const g = data[baseIdx + 1];
                const b = data[baseIdx + 2];
                
                if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
                    return `RGB(${r.toPrecision(4)}, ${g.toPrecision(4)}, ${b.toPrecision(4)})`;
                }
                
                // Handle special values
                const formatValue = (v) => {
                    if (Number.isNaN(v)) return 'NaN';
                    if (v === Infinity) return 'Inf';
                    if (v === -Infinity) return '-Inf';
                    return v.toPrecision(4);
                };
                return `RGB(${formatValue(r)}, ${formatValue(g)}, ${formatValue(b)})`;
            }
        } else {
            // Grayscale data
            const value = data[idx];
            if (Number.isFinite(value)) {
                return value.toPrecision(4);
            }
            // Show specific invalid values instead of generic "nan"
            if (Number.isNaN(value)) {
                return 'NaN';
            } else if (value === Infinity) {
                return 'Inf';
            } else if (value === -Infinity) {
                return '-Inf';
            } else {
                // Fallback for any other non-finite values
                return 'invalid';
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
                photometricInterpretation: channels === 3 ? 2 : 1,
                planarConfig: 1,
                samplesPerPixel: channels,
                bitsPerSample: 32,
                sampleFormat: 3,
                formatLabel,
                formatType: 'pfm' // For per-format settings
            }
        });
    }

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



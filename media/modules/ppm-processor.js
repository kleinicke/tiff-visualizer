// @ts-check
"use strict";

/**
 * PPM/PGM Processor for TIFF Visualizer
 * Supports PGM (grayscale) and PPM (RGB) portable pixmap files
 * Both ASCII (P2/P3) and binary (P5/P6) formats
 */
export class PpmProcessor {
    constructor(settingsManager, vscode) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        this._lastRaw = null; // { width, height, data: Uint8Array|Uint16Array, maxval, channels }
    }

    async processPpm(src) {
        const response = await fetch(src);
        const buffer = await response.arrayBuffer();
        const { width, height, channels, data, maxval, format } = this._parsePpm(buffer);
        
        // Convert to grayscale if RGB for display consistency with other processors
        let displayData;
        if (channels === 1) {
            displayData = data;
        } else {
            // Convert RGB to grayscale using luminance formula
            const pixelCount = width * height;
            displayData = new (data.constructor)(pixelCount);
            for (let i = 0; i < pixelCount; i++) {
                const r = data[i * 3 + 0];
                const g = data[i * 3 + 1];
                const b = data[i * 3 + 2];
                // Standard luminance formula
                displayData[i] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
            }
        }

        // PPM stores pixels from top-to-bottom, which is the correct orientation for canvas
        // No flipping needed unless specifically required by the format
        
        this._lastRaw = { width, height, data: displayData, maxval, channels };
        this._postFormatInfo(width, height, channels, format, maxval);
        
        const imageData = this._toImageData(displayData, width, height, maxval);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        
        // Force status refresh
        this.vscode.postMessage({ type: 'refresh-status' });
        return { canvas, imageData };
    }

    _parsePpm(arrayBuffer) {
        const uint8Array = new Uint8Array(arrayBuffer);
        let offset = 0;
        
        // Helper function to read next token
        const readToken = () => {
            // Skip whitespace and comments
            while (offset < uint8Array.length) {
                const char = uint8Array[offset];
                if (char === 35) { // '#' - comment
                    // Skip to end of line
                    while (offset < uint8Array.length && uint8Array[offset] !== 10) {
                        offset++;
                    }
                    if (offset < uint8Array.length) offset++; // Skip newline
                } else if (char === 32 || char === 9 || char === 10 || char === 13) { // whitespace
                    offset++;
                } else {
                    break;
                }
            }
            
            // Read token
            let token = '';
            while (offset < uint8Array.length) {
                const char = uint8Array[offset];
                if (char === 32 || char === 9 || char === 10 || char === 13 || char === 35) {
                    break;
                }
                token += String.fromCharCode(char);
                offset++;
            }
            return token;
        };

        // Read magic number
        const magic = readToken();
        if (!['P2', 'P3', 'P5', 'P6'].includes(magic)) {
            throw new Error(`Invalid PPM/PGM magic number: ${magic}`);
        }

        const isAscii = magic === 'P2' || magic === 'P3';
        const channels = (magic === 'P2' || magic === 'P5') ? 1 : 3;
        const format = magic === 'P2' ? 'PGM (ASCII)' : 
                     magic === 'P3' ? 'PPM (ASCII)' :
                     magic === 'P5' ? 'PGM (Binary)' : 'PPM (Binary)';

        // Read dimensions
        const width = parseInt(readToken(), 10);
        const height = parseInt(readToken(), 10);
        const maxval = parseInt(readToken(), 10);

        if (width <= 0 || height <= 0 || maxval <= 0) {
            throw new Error('Invalid PPM/PGM dimensions or maxval');
        }

        const pixelCount = width * height;
        const totalValues = pixelCount * channels;
        
        // Determine data type based on maxval
        const use16bit = maxval > 255;
        const DataType = use16bit ? Uint16Array : Uint8Array;
        const data = new DataType(totalValues);

        if (isAscii) {
            // ASCII format - read space-separated values
            for (let i = 0; i < totalValues; i++) {
                const token = readToken();
                const value = parseInt(token, 10);
                if (isNaN(value) || value < 0 || value > maxval) {
                    throw new Error(`Invalid pixel value: ${token}`);
                }
                data[i] = value;
            }
        } else {
            // Binary format
            const bytesPerValue = use16bit ? 2 : 1;
            const expectedBytes = totalValues * bytesPerValue;
            
            if (offset + expectedBytes > uint8Array.length) {
                throw new Error('Insufficient data for binary PPM/PGM');
            }

            if (use16bit) {
                // 16-bit values (big-endian as per PPM spec)
                const dataView = new DataView(arrayBuffer, offset);
                for (let i = 0; i < totalValues; i++) {
                    data[i] = dataView.getUint16(i * 2, false); // false = big-endian
                }
            } else {
                // 8-bit values
                for (let i = 0; i < totalValues; i++) {
                    data[i] = uint8Array[offset + i];
                }
            }
        }

        return { width, height, channels, data, maxval, format };
    }

    _toImageData(data, width, height, maxval) {
        const settings = this.settingsManager.settings;
        const out = new Uint8ClampedArray(width * height * 4);
        
        // Normalize to 0-255 range
        const scale = 255 / maxval;
        
        for (let i = 0; i < width * height; i++) {
            let value = data[i] * scale;
            
            // Apply gamma and brightness if in gamma mode
            if (settings.normalization && settings.normalization.gammaMode) {
                value = value / 255; // Normalize to 0-1
                const gi = settings.gamma?.in ?? 1.0;
                const go = settings.gamma?.out ?? 1.0;
                value = Math.pow(value, gi / go);
                const stops = settings.brightness?.offset ?? 0;
                value = value * Math.pow(2, stops);
                value = Math.max(0, Math.min(1, value));
                value = value * 255; // Back to 0-255
            }
            
            const pixelValue = Math.round(Math.max(0, Math.min(255, value)));
            const p = i * 4;
            out[p] = pixelValue;     // R
            out[p + 1] = pixelValue; // G
            out[p + 2] = pixelValue; // B
            out[p + 3] = 255;        // A
        }

        // Send stats to VS Code
        if (this.vscode) {
            let min = Infinity, max = -Infinity;
            for (let i = 0; i < data.length; i++) {
                const value = data[i];
                if (value < min) min = value;
                if (value > max) max = value;
            }
            this.vscode.postMessage({ type: 'isFloat', value: false });
            this.vscode.postMessage({ type: 'stats', value: { min, max } });
        }

        return new ImageData(out, width, height);
    }

    getColorAtPixel(x, y, naturalWidth, naturalHeight) {
        if (!this._lastRaw) return '';
        const { width, height, data } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';
        
        const idx = y * width + x;
        if (idx >= 0 && idx < data.length) {
            return data[idx].toString();
        }
        return '';
    }

    _flipImageVertically(data, width, height) {
        const flipped = new (data.constructor)(data.length);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const srcIdx = y * width + x;
                const dstIdx = (height - 1 - y) * width + x;
                flipped[dstIdx] = data[srcIdx];
            }
        }
        return flipped;
    }

    _postFormatInfo(width, height, channels, formatLabel, maxval) {
        if (!this.vscode) return;
        this.vscode.postMessage({
            type: 'formatInfo',
            value: {
                width,
                height,
                compression: 'None',
                predictor: 1,
                photometricInterpretation: channels === 3 ? 2 : 1,
                planarConfig: 1,
                samplesPerPixel: channels,
                bitsPerSample: maxval > 255 ? 16 : 8,
                sampleFormat: 1, // Unsigned integer
                formatLabel,
                maxval
            }
        });
    }
}
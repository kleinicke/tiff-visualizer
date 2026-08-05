"use strict";

import { getWasmModuleSync, getWasmModule } from './tiff-wasm-wrapper.js';

/**
 * CFA (colour filter array) debayering as a non-destructive view transform.
 *
 * Shape deliberately mirrors `displayColormap`: the raw single-channel plane
 * stays untouched, and this runs inside the render path whenever a debayer
 * parameter changes. Because it takes a plain plane it is format agnostic —
 * TIFF, PNG, NPY, PGM all reach it identically.
 *
 * The heavy lifting is Rust/WASM (`wasm/tiff-decoder/src/demosaic.rs`); the JS
 * fallback below is a straight port of the generic path so the feature still
 * works if WASM fails to load.
 */

export type DebayerAlgorithm = 'nearest' | 'bilinear' | 'malvar';
export type DebayerView = 'rgb' | 'r' | 'g' | 'b' | 'i' | 'mosaic';

export interface DebayerSettings {
    enabled: boolean;
    pattern: string;
    algorithm: DebayerAlgorithm;
    offsetX: number;
    offsetY: number;
    view: DebayerView;
    autoWb: boolean;
    gainR: number;
    gainG: number;
    gainB: number;
    /** Sensor black level in raw units; 0 with whiteLevel 0 disables levelling. */
    blackLevel: number;
    whiteLevel: number;
}

export const DEFAULT_DEBAYER: DebayerSettings = {
    // On by default: this object only ever applies once the user has opened the
    // debayer panel, and an inert panel that needs a second click to do anything
    // reads as broken. Images are unaffected until `settings.debayer` is set.
    enabled: true,
    pattern: 'rggb',
    algorithm: 'malvar',
    offsetX: 0,
    offsetY: 0,
    view: 'rgb',
    autoWb: false,
    gainR: 1,
    gainG: 1,
    gainB: 1,
    blackLevel: 0,
    whiteLevel: 0,
};

export interface PatternInfo {
    id: string;
    label: string;
    period: number;
    channels: number;
    /** Label for the 4th slot, or null when the pattern has none. */
    fourthLabel: string | null;
    description: string;
}

/**
 * Supported CFA layouts. Must stay in sync with `pattern_from_name` in
 * `demosaic.rs` — the id strings are the wire format.
 */
export const PATTERNS: PatternInfo[] = [
    { id: 'rggb', label: 'RGGB', period: 2, channels: 3, fourthLabel: null, description: 'Bayer, red first' },
    { id: 'bggr', label: 'BGGR', period: 2, channels: 3, fourthLabel: null, description: 'Bayer, blue first' },
    { id: 'grbg', label: 'GRBG', period: 2, channels: 3, fourthLabel: null, description: 'Bayer, green/red row first' },
    { id: 'gbrg', label: 'GBRG', period: 2, channels: 3, fourthLabel: null, description: 'Bayer, green/blue row first' },
    { id: 'rgbi_4x4', label: 'RGB-IR (4×4)', period: 4, channels: 4, fourthLabel: 'IR', description: 'OmniVision-style RGB-IR, BGRG/GIGI/RGBG/GIGI' },
    { id: 'xtrans', label: 'X-Trans (6×6)', period: 6, channels: 3, fourthLabel: null, description: 'Fuji X-Trans' },
    { id: 'rccb', label: 'RCCB', period: 2, channels: 4, fourthLabel: 'Clear', description: 'Automotive, two clear sites' },
    { id: 'rccc', label: 'RCCC', period: 2, channels: 4, fourthLabel: 'Clear', description: 'Automotive, one red + three clear' },
    { id: 'rgbw', label: 'RGBW', period: 2, channels: 4, fourthLabel: 'W', description: 'Kodak-style panchromatic' },
    { id: 'quad_rggb', label: 'Quad Bayer (4×4)', period: 4, channels: 3, fourthLabel: null, description: 'Tetracell, 2×2 blocks per colour' },
];

export function getPatternInfo(id: string): PatternInfo {
    return PATTERNS.find(p => p.id === id) || PATTERNS[0];
}

/** Kick off WASM loading so the synchronous render path finds it ready. */
export function warmUpDebayer(): void {
    void getWasmModule();
}

/** Event name fired when a decoder recognises a self-declared CFA image. */
export const CFA_DETECTED_EVENT = 'tiffvis:cfa-detected';

/**
 * Announce whether the just-decoded image declares itself a CFA mosaic.
 *
 * A DOM event rather than a direct call so decoders stay unaware of the panel;
 * fired on every decode (including with `false`) so a previous detection cannot
 * leak into the next image.
 */
export function announceCfaDetection(detected: boolean): void {
    // Decoders also run in the decode worker and under Node in tests, where
    // there is no window (or only a partial stub). Detection is advisory, so a
    // missing event target must never break a decode.
    const target: any = typeof window !== 'undefined' ? window : undefined;
    if (!target || typeof target.dispatchEvent !== 'function' || typeof CustomEvent === 'undefined') {
        return;
    }
    try {
        target.dispatchEvent(new CustomEvent(CFA_DETECTED_EVENT, { detail: { detected } }));
    } catch {
        // Advisory only -- never let it affect decoding.
    }
}

export interface DemosaicOutput {
    data: Float32Array;
    channels: number;
    /** Gains actually applied — differs from the request when auto WB is on. */
    gains: { r: number; g: number; b: number };
    usedWasm: boolean;
}

// --- JS fallback ------------------------------------------------------------

const CH = { R: 0, G: 1, B: 2, I: 3 } as const;

/** Channel-slot grids, mirroring `pattern_from_name` in demosaic.rs. */
const GRIDS: Record<string, number[]> = {
    rggb: [0, 1, 1, 2],
    bggr: [2, 1, 1, 0],
    grbg: [1, 0, 2, 1],
    gbrg: [1, 2, 0, 1],
    rgbi_4x4: [
        2, 1, 0, 1,
        1, 3, 1, 3,
        0, 1, 2, 1,
        1, 3, 1, 3,
    ],
    xtrans: [
        1, 2, 0, 1, 0, 2,
        0, 1, 1, 2, 1, 1,
        2, 1, 1, 0, 1, 1,
        1, 0, 2, 1, 2, 0,
        2, 1, 1, 0, 1, 1,
        0, 1, 1, 2, 1, 1,
    ],
    rccb: [0, 3, 3, 2],
    rccc: [0, 3, 3, 3],
    rgbw: [0, 1, 2, 3],
    quad_rggb: [
        0, 0, 1, 1,
        0, 0, 1, 1,
        1, 1, 2, 2,
        1, 1, 2, 2,
    ],
};

function fillRadius(period: number): number {
    return period === 2 ? 1 : period === 4 ? 2 : 3;
}

/**
 * Normalised-convolution fill, the same algorithm as the Rust generic path.
 * Slower than WASM but correct for every pattern.
 */
function demosaicJs(
    plane: Float32Array,
    width: number,
    height: number,
    settings: DebayerSettings,
): DemosaicOutput {
    const info = getPatternInfo(settings.pattern);
    const period = info.period;
    const grid = GRIDS[info.id] || GRIDS.rggb;
    const nch = info.channels;
    const ox = ((settings.offsetX % period) + period) % period;
    const oy = ((settings.offsetY % period) + period) % period;
    const at = (x: number, y: number) => grid[((y + oy) % period) * period + ((x + ox) % period)];

    // Black / white level.
    const levelled = new Float32Array(width * height);
    if (settings.whiteLevel > settings.blackLevel) {
        const scale = 1 / (settings.whiteLevel - settings.blackLevel);
        for (let i = 0; i < levelled.length; i++) {
            levelled[i] = (plane[i] - settings.blackLevel) * scale;
        }
    } else {
        levelled.set(plane.subarray(0, width * height));
    }

    // White balance, before interpolation.
    let gr = settings.gainR, gg = settings.gainG, gb = settings.gainB;
    if (settings.autoWb) {
        const sums = [0, 0, 0, 0];
        const counts = [0, 0, 0, 0];
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const c = at(x, y);
                sums[c] += levelled[y * width + x];
                counts[c]++;
            }
        }
        const mean = (c: number) => (counts[c] > 0 ? sums[c] / counts[c] : 0);
        const mg = mean(CH.G);
        const reference = mg > 1e-9 ? mg : mean(CH.I);
        const gain = (m: number) => (m > 1e-9 && reference > 1e-9 ? reference / m : 1);
        gr = gain(mean(CH.R));
        gg = gain(mg);
        gb = gain(mean(CH.B));
    }
    if (Math.abs(gr - 1) > 1e-6 || Math.abs(gg - 1) > 1e-6 || Math.abs(gb - 1) > 1e-6) {
        const gains = [gr, gg, gb, 1];
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                levelled[y * width + x] *= gains[at(x, y)];
            }
        }
    }

    // Interpolate.
    const radius = fillRadius(period);
    const weight = (d: number) => radius + 1 - Math.abs(d);
    const out = new Float32Array(width * height * nch);
    const nearest = settings.algorithm === 'nearest';

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const own = at(x, y);
            const ownValue = levelled[y * width + x];
            const base = (y * width + x) * nch;
            for (let c = 0; c < nch; c++) {
                if (c === own) { out[base + c] = ownValue; continue; }
                let num = 0, den = 0, best = ownValue, bestD = Infinity;
                for (let dy = -radius; dy <= radius; dy++) {
                    const sy = y + dy;
                    if (sy < 0 || sy >= height) { continue; }
                    for (let dx = -radius; dx <= radius; dx++) {
                        const sx = x + dx;
                        if (sx < 0 || sx >= width) { continue; }
                        if (at(sx, sy) !== c) { continue; }
                        const v = levelled[sy * width + sx];
                        if (nearest) {
                            const d = Math.abs(dx) + Math.abs(dy);
                            if (d < bestD) { bestD = d; best = v; }
                        } else {
                            const w = weight(dx) * weight(dy);
                            num += w * v;
                            den += w;
                        }
                    }
                }
                out[base + c] = nearest ? best : (den > 0 ? num / den : ownValue);
            }
        }
    }

    // Match the Rust path: clamp to the valid range when levelling defined one.
    if (settings.whiteLevel > settings.blackLevel) {
        for (let i = 0; i < out.length; i++) {
            out[i] = out[i] < 0 ? 0 : out[i] > 1 ? 1 : out[i];
        }
    }

    return { data: out, channels: nch, gains: { r: gr, g: gg, b: gb }, usedWasm: false };
}

// --- cache ------------------------------------------------------------------

function signature(s: DebayerSettings, width: number, height: number): string {
    // `view` is intentionally excluded: switching channel view reuses the cached
    // demosaic and only re-slices, which is what makes view switching feel free.
    return [
        s.pattern, s.algorithm, s.offsetX, s.offsetY,
        s.autoWb ? 'auto' : `${s.gainR},${s.gainG},${s.gainB}`,
        s.blackLevel, s.whiteLevel, width, height,
    ].join('|');
}

let cacheSource: ArrayLike<number> | null = null;
let cacheSig = '';
let cacheResult: DemosaicOutput | null = null;

/**
 * Gains from the most recent demosaic. The only way to see what auto WB
 * resolved to, since it is computed inside the render pass.
 */
export function getLastDebayerGains(): { r: number; g: number; b: number } | null {
    return cacheResult ? cacheResult.gains : null;
}

/**
 * Demosaiced samples at a pixel, for the pixel inspector.
 *
 * Reads the buffer the last render produced, so it always agrees with what is
 * on screen. Returns null when debayering is not active, letting the inspector
 * fall through to the raw mosaic value.
 *
 * Note these are interpolated values, not measurements: only the one channel
 * actually sampled at this site is real. Switch the view to Raw to read the
 * sensor value back.
 */
export function getDebayeredPixel(x: number, y: number, width: number): number[] | null {
    if (!cacheResult) { return null; }
    const { data, channels } = cacheResult;
    const index = (y * width + x) * channels;
    if (index < 0 || index + channels > data.length) { return null; }
    const out: number[] = [];
    for (let c = 0; c < channels; c++) { out.push(data[index + c]); }
    return out;
}

export function invalidateDebayerCache(): void {
    cacheSource = null;
    cacheSig = '';
    cacheResult = null;
}

/**
 * Demosaic a single-channel plane, caching the result.
 *
 * The cache is keyed on source identity plus every parameter that affects the
 * interpolation, so gamma/brightness/normalisation changes re-render without
 * re-demosaicing — that is what keeps the sliders interactive.
 */
export function demosaicPlane(
    plane: ArrayLike<number>,
    width: number,
    height: number,
    settings: DebayerSettings,
): DemosaicOutput {
    const sig = signature(settings, width, height);
    if (cacheSource === plane && cacheSig === sig && cacheResult) {
        return cacheResult;
    }

    const src = plane instanceof Float32Array
        ? plane
        : Float32Array.from(plane as ArrayLike<number>);

    let result: DemosaicOutput;
    const wasm = getWasmModuleSync();
    if (wasm && typeof wasm.demosaic === 'function') {
        try {
            const r = wasm.demosaic(
                src, width, height, settings.pattern, settings.algorithm,
                settings.offsetX, settings.offsetY,
                settings.blackLevel, settings.whiteLevel,
                settings.autoWb, settings.gainR, settings.gainG, settings.gainB,
            );
            result = {
                data: r.take_data(),
                channels: r.channels,
                gains: { r: r.gain_r, g: r.gain_g, b: r.gain_b },
                usedWasm: true,
            };
            r.free?.();
        } catch (error) {
            console.warn('[Debayer] WASM demosaic failed, falling back to JS:', error);
            result = demosaicJs(src, width, height, settings);
        }
    } else {
        result = demosaicJs(src, width, height, settings);
    }

    cacheSource = plane;
    cacheSig = sig;
    cacheResult = result;
    return result;
}

/**
 * Slice a demosaiced buffer down to the requested view.
 *
 * Single-channel views return `channels: 1`, so the existing display-colormap
 * and histogram paths keep working on them unchanged.
 */
export function extractView(
    result: DemosaicOutput,
    view: DebayerView,
): { data: Float32Array; channels: number } {
    if (view === 'rgb') {
        // Drop a 4th channel: the renderer would read it as alpha.
        if (result.channels === 4) {
            const n = result.data.length / 4;
            const rgb = new Float32Array(n * 3);
            for (let i = 0; i < n; i++) {
                rgb[i * 3] = result.data[i * 4];
                rgb[i * 3 + 1] = result.data[i * 4 + 1];
                rgb[i * 3 + 2] = result.data[i * 4 + 2];
            }
            return { data: rgb, channels: 3 };
        }
        return { data: result.data, channels: 3 };
    }

    const index = view === 'r' ? 0 : view === 'g' ? 1 : view === 'b' ? 2 : 3;
    if (index >= result.channels) {
        // e.g. IR requested on a plain Bayer pattern.
        return { data: result.data, channels: result.channels };
    }
    const n = result.data.length / result.channels;
    const single = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        single[i] = result.data[i * result.channels + index];
    }
    return { data: single, channels: 1 };
}

/**
 * Whether debayering should run for this image.
 *
 * Only single-channel images qualify; anything already demosaiced is left
 * alone even when the setting is on, so toggling it cannot corrupt RGB images.
 */
export function shouldDebayer(settings: DebayerSettings | undefined, channels: number): boolean {
    return !!settings && settings.enabled && channels === 1 && settings.view !== 'mosaic';
}

/**
 * True when the file declares itself a CFA image.
 * PhotometricInterpretation 32803 is TIFF/EP + DNG's CFA tag.
 *
 * Most machine-vision cameras write plain grayscale (photometric 1) with no CFA
 * tag at all, so a false result here says nothing — it just means we cannot
 * auto-enable and the user has to pick the pattern.
 */
export function isDeclaredCfa(photometricInterpretation: number | undefined): boolean {
    return photometricInterpretation === 32803;
}

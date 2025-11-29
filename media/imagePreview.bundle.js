var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// media/wasm/tiff-wasm.js
var tiff_wasm_exports = {};
__export(tiff_wasm_exports, {
  TiffResult: () => TiffResult,
  decode_tiff: () => decode_tiff,
  default: () => tiff_wasm_default,
  initSync: () => initSync
});
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}
function decodeText(ptr, len) {
  numBytesDecoded += len;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}
function getStringFromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return decodeText(ptr, len);
}
function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === void 0) {
    const buf = cachedTextEncoder.encode(arg);
    const ptr2 = malloc(buf.length, 1) >>> 0;
    getUint8ArrayMemory0().subarray(ptr2, ptr2 + buf.length).set(buf);
    WASM_VECTOR_LEN = buf.length;
    return ptr2;
  }
  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;
  const mem = getUint8ArrayMemory0();
  let offset = 0;
  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 127) break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset);
    }
    ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
    const ret = cachedTextEncoder.encodeInto(arg, view);
    offset += ret.written;
    ptr = realloc(ptr, len, offset, 1) >>> 0;
  }
  WASM_VECTOR_LEN = offset;
  return ptr;
}
function getDataViewMemory0() {
  if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || cachedDataViewMemory0.buffer.detached === void 0 && cachedDataViewMemory0.buffer !== wasm.memory.buffer) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
  }
  return cachedDataViewMemory0;
}
function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}
function getFloat32ArrayMemory0() {
  if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
    cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
  }
  return cachedFloat32ArrayMemory0;
}
function getArrayF32FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}
function passArray8ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 1, 1) >>> 0;
  getUint8ArrayMemory0().set(arg, ptr / 1);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
function takeFromExternrefTable0(idx) {
  const value = wasm.__wbindgen_externrefs.get(idx);
  wasm.__externref_table_dealloc(idx);
  return value;
}
function decode_tiff(data) {
  const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ret = wasm.decode_tiff(ptr0, len0);
  if (ret[2]) {
    throw takeFromExternrefTable0(ret[1]);
  }
  return TiffResult.__wrap(ret[0]);
}
async function __wbg_load(module, imports) {
  if (typeof Response === "function" && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e) {
        const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);
        if (validResponse && module.headers.get("Content-Type") !== "application/wasm") {
          console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);
        } else {
          throw e;
        }
      }
    }
    const bytes = await module.arrayBuffer();
    return await WebAssembly.instantiate(bytes, imports);
  } else {
    const instance = await WebAssembly.instantiate(module, imports);
    if (instance instanceof WebAssembly.Instance) {
      return { instance, module };
    } else {
      return instance;
    }
  }
}
function __wbg_get_imports() {
  const imports = {};
  imports.wbg = {};
  imports.wbg.__wbg___wbindgen_throw_b855445ff6a94295 = function(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
  };
  imports.wbg.__wbg_error_7534b8e9a36f1ab4 = function(arg0, arg1) {
    let deferred0_0;
    let deferred0_1;
    try {
      deferred0_0 = arg0;
      deferred0_1 = arg1;
      console.error(getStringFromWasm0(arg0, arg1));
    } finally {
      wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
    }
  };
  imports.wbg.__wbg_log_8cec76766b8c0e33 = function(arg0) {
    console.log(arg0);
  };
  imports.wbg.__wbg_new_8a6f238a6ece86ea = function() {
    const ret = new Error();
    return ret;
  };
  imports.wbg.__wbg_now_793306c526e2e3b6 = function() {
    const ret = Date.now();
    return ret;
  };
  imports.wbg.__wbg_stack_0ed75d68575b0f3c = function(arg0, arg1) {
    const ret = arg1.stack;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
  };
  imports.wbg.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
  };
  imports.wbg.__wbindgen_init_externref_table = function() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, void 0);
    table.set(offset + 0, void 0);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
    ;
  };
  return imports;
}
function __wbg_finalize_init(instance, module) {
  wasm = instance.exports;
  __wbg_init.__wbindgen_wasm_module = module;
  cachedDataViewMemory0 = null;
  cachedFloat32ArrayMemory0 = null;
  cachedUint8ArrayMemory0 = null;
  wasm.__wbindgen_start();
  return wasm;
}
function initSync(module) {
  if (wasm !== void 0) return wasm;
  if (typeof module !== "undefined") {
    if (Object.getPrototypeOf(module) === Object.prototype) {
      ({ module } = module);
    } else {
      console.warn("using deprecated parameters for `initSync()`; pass a single object instead");
    }
  }
  const imports = __wbg_get_imports();
  if (!(module instanceof WebAssembly.Module)) {
    module = new WebAssembly.Module(module);
  }
  const instance = new WebAssembly.Instance(module, imports);
  return __wbg_finalize_init(instance, module);
}
async function __wbg_init(module_or_path) {
  if (wasm !== void 0) return wasm;
  if (typeof module_or_path !== "undefined") {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ({ module_or_path } = module_or_path);
    } else {
      console.warn("using deprecated parameters for the initialization function; pass a single object instead");
    }
  }
  if (typeof module_or_path === "undefined") {
    module_or_path = new URL("wasm/tiff-wasm.wasm", import.meta.url);
  }
  const imports = __wbg_get_imports();
  if (typeof module_or_path === "string" || typeof Request === "function" && module_or_path instanceof Request || typeof URL === "function" && module_or_path instanceof URL) {
    module_or_path = fetch(module_or_path);
  }
  const { instance, module } = await __wbg_load(await module_or_path, imports);
  return __wbg_finalize_init(instance, module);
}
var wasm, cachedUint8ArrayMemory0, cachedTextDecoder, MAX_SAFARI_DECODE_BYTES, numBytesDecoded, WASM_VECTOR_LEN, cachedTextEncoder, cachedDataViewMemory0, cachedFloat32ArrayMemory0, TiffResultFinalization, TiffResult, EXPECTED_RESPONSE_TYPES, tiff_wasm_default;
var init_tiff_wasm = __esm({
  "media/wasm/tiff-wasm.js"() {
    "use strict";
    cachedUint8ArrayMemory0 = null;
    cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    MAX_SAFARI_DECODE_BYTES = 2146435072;
    numBytesDecoded = 0;
    WASM_VECTOR_LEN = 0;
    cachedTextEncoder = new TextEncoder();
    if (!("encodeInto" in cachedTextEncoder)) {
      cachedTextEncoder.encodeInto = function(arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
          read: arg.length,
          written: buf.length
        };
      };
    }
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    TiffResultFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
    }, unregister: () => {
    } } : new FinalizationRegistry((ptr) => wasm.__wbg_tiffresult_free(ptr >>> 0, 1));
    TiffResult = class _TiffResult {
      static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(_TiffResult.prototype);
        obj.__wbg_ptr = ptr;
        TiffResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
      }
      __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TiffResultFinalization.unregister(this);
        return ptr;
      }
      free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_tiffresult_free(ptr, 0);
      }
      /**
       * @returns {number}
       */
      get compression() {
        const ret = wasm.tiffresult_compression(this.__wbg_ptr);
        return ret >>> 0;
      }
      /**
       * @returns {number}
       */
      get sample_format() {
        const ret = wasm.tiffresult_sample_format(this.__wbg_ptr);
        return ret >>> 0;
      }
      /**
       * Get raw data as bytes (for transferring to JS)
       * @returns {Uint8Array}
       */
      get_data_bytes() {
        const ret = wasm.tiffresult_get_data_bytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
      }
      /**
       * @returns {number}
       */
      get bits_per_sample() {
        const ret = wasm.tiffresult_bits_per_sample(this.__wbg_ptr);
        return ret >>> 0;
      }
      /**
       * Get data as Float32Array (most common for visualization)
       * @returns {Float32Array}
       */
      get_data_as_f32() {
        const ret = wasm.tiffresult_get_data_as_f32(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
      }
      /**
       * @returns {number}
       */
      get planar_configuration() {
        const ret = wasm.tiffresult_planar_configuration(this.__wbg_ptr);
        return ret >>> 0;
      }
      /**
       * @returns {number}
       */
      get photometric_interpretation() {
        const ret = wasm.tiffresult_photometric_interpretation(this.__wbg_ptr);
        return ret >>> 0;
      }
      /**
       * @returns {number}
       */
      get width() {
        const ret = wasm.tiffresult_width(this.__wbg_ptr);
        return ret >>> 0;
      }
      /**
       * @returns {number}
       */
      get height() {
        const ret = wasm.tiffresult_height(this.__wbg_ptr);
        return ret >>> 0;
      }
      /**
       * @returns {number}
       */
      get channels() {
        const ret = wasm.tiffresult_channels(this.__wbg_ptr);
        return ret >>> 0;
      }
      /**
       * @returns {number}
       */
      get max_value() {
        const ret = wasm.tiffresult_max_value(this.__wbg_ptr);
        return ret;
      }
      /**
       * @returns {number}
       */
      get min_value() {
        const ret = wasm.tiffresult_min_value(this.__wbg_ptr);
        return ret;
      }
      /**
       * @returns {number}
       */
      get predictor() {
        const ret = wasm.tiffresult_predictor(this.__wbg_ptr);
        return ret >>> 0;
      }
    };
    if (Symbol.dispose) TiffResult.prototype[Symbol.dispose] = TiffResult.prototype.free;
    EXPECTED_RESPONSE_TYPES = /* @__PURE__ */ new Set(["basic", "cors", "default"]);
    tiff_wasm_default = __wbg_init;
  }
});

// media/modules/settings-manager.js
var SettingsManager = class {
  constructor() {
    this._settings = this._loadSettings();
    this._constants = {
      PIXELATION_THRESHOLD: 3,
      SCALE_PINCH_FACTOR: 0.075,
      MAX_SCALE: 200,
      MIN_SCALE: 0.1,
      ZOOM_LEVELS: [
        0.1,
        0.2,
        0.3,
        0.4,
        0.5,
        0.6,
        0.7,
        0.8,
        0.9,
        1,
        1.5,
        2,
        3,
        5,
        7,
        10,
        15,
        20,
        30,
        50,
        70,
        100,
        200
      ]
    };
    this._isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  }
  /**
   * Load settings from the DOM
   * @private
   * @returns {ImageSettings}
   */
  _loadSettings() {
    const element = document.getElementById("image-preview-settings");
    if (element) {
      const data = element.getAttribute("data-settings");
      if (data) {
        return JSON.parse(data);
      }
    }
    throw new Error("Could not load settings");
  }
  /**
   * Get application settings
   * @returns {ImageSettings}
   */
  get settings() {
    return this._settings;
  }
  /**
   * Get application constants
   * @returns {{PIXELATION_THRESHOLD: number, SCALE_PINCH_FACTOR: number, MAX_SCALE: number, MIN_SCALE: number, ZOOM_LEVELS: number[]}}
   */
  get constants() {
    return this._constants;
  }
  /**
   * Check if running on Mac
   * @returns {boolean}
   */
  get isMac() {
    return this._isMac;
  }
  /**
   * Update settings from new data (for real-time updates)
   * @param {ImageSettings} newSettings - New settings object
   * @returns {{parametersOnly: boolean, changedMasks: boolean, changedStructure: boolean}} - What changed
   */
  updateSettings(newSettings) {
    if (!newSettings) {
      return { parametersOnly: false, changedMasks: false, changedStructure: false };
    }
    const changes = {
      parametersOnly: false,
      changedMasks: false,
      changedStructure: false
    };
    const oldSettings = this._settings;
    const gammaChanged = JSON.stringify(oldSettings.gamma) !== JSON.stringify(newSettings.gamma);
    const brightnessChanged = JSON.stringify(oldSettings.brightness) !== JSON.stringify(newSettings.brightness);
    const normRangeChanged = oldSettings.normalization?.min !== newSettings.normalization?.min || oldSettings.normalization?.max !== newSettings.normalization?.max;
    const normAutoChanged = oldSettings.normalization?.autoNormalize !== newSettings.normalization?.autoNormalize;
    const normGammaModeChanged = oldSettings.normalization?.gammaMode !== newSettings.normalization?.gammaMode;
    const masksChanged = JSON.stringify(oldSettings.maskFilters || []) !== JSON.stringify(newSettings.maskFilters || []);
    const rgbModeChanged = oldSettings.rgbAs24BitGrayscale !== newSettings.rgbAs24BitGrayscale;
    const scaleModeChanged = oldSettings.scale24BitFactor !== newSettings.scale24BitFactor;
    const floatModeChanged = oldSettings.normalizedFloatMode !== newSettings.normalizedFloatMode;
    const nanColorChanged = (oldSettings.nanColor ?? "black") !== (newSettings.nanColor ?? "black");
    if (masksChanged) {
      changes.changedMasks = true;
    }
    if (rgbModeChanged || scaleModeChanged || floatModeChanged) {
      changes.changedStructure = true;
    }
    const somethingChanged = gammaChanged || brightnessChanged || normRangeChanged || normAutoChanged || normGammaModeChanged || masksChanged || rgbModeChanged || scaleModeChanged || floatModeChanged || nanColorChanged;
    if (!somethingChanged || (gammaChanged || brightnessChanged || normRangeChanged || normAutoChanged || normGammaModeChanged || nanColorChanged) && !masksChanged && !rgbModeChanged && !scaleModeChanged && !floatModeChanged) {
      changes.parametersOnly = true;
    } else {
      console.log("\u26A0\uFE0F Structural changes detected:", {
        masksChanged,
        rgbModeChanged,
        scaleModeChanged,
        floatModeChanged,
        nanColorChanged
      });
    }
    this._settings = {
      ...this._settings,
      ...newSettings,
      normalization: newSettings.normalization ? { ...newSettings.normalization } : this._settings.normalization,
      gamma: newSettings.gamma ? { ...newSettings.gamma } : this._settings.gamma,
      brightness: newSettings.brightness ? { ...newSettings.brightness } : this._settings.brightness,
      maskFilters: newSettings.maskFilters ? [...newSettings.maskFilters] : this._settings.maskFilters
    };
    return changes;
  }
};

// media/modules/normalization-helper.js
var NormalizationHelper = class {
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
      normMin = stats && Number.isFinite(stats.min) ? stats.min : 0;
      normMax = stats && Number.isFinite(stats.max) ? stats.max : typeMax;
    } else if (settings.normalization && settings.normalization.gammaMode) {
      normMin = 0;
      normMax = typeMax;
    } else if (settings.normalization && (settings.normalization.min !== void 0 && settings.normalization.max !== void 0)) {
      normMin = settings.normalization.min;
      normMax = settings.normalization.max;
      if (settings.normalizedFloatMode && !isFloat) {
        normMin *= typeMax;
        normMax *= typeMax;
      }
    } else {
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
    const gammaIn = settings.gamma?.in ?? 1;
    const gammaOut = settings.gamma?.out ?? 1;
    const exposureStops = settings.brightness?.offset ?? 0;
    let linear = Math.pow(normalized, gammaIn);
    linear *= Math.pow(2, exposureStops);
    const output = Math.pow(linear, 1 / gammaOut);
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
    const perfStart = performance.now();
    const lutSize = maxValue + 1;
    const lut = new Uint8Array(lutSize);
    const range = normMax - normMin;
    const invRange = range > 0 ? 1 / range : 0;
    for (let i = 0; i < lutSize; i++) {
      const value = i;
      let normalized = (value - normMin) * invRange;
      normalized = this.applyGammaAndBrightness(normalized, settings);
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
   * @param {Object} settings - Settings object
   * @returns {boolean} True if identity transformation
   */
  static isIdentityTransformation(settings) {
    const gammaIn = settings.gamma?.in ?? 1;
    const gammaOut = settings.gamma?.out ?? 1;
    const exposureStops = settings.brightness?.offset ?? 0;
    return Math.abs(gammaIn - gammaOut) < 1e-3 && Math.abs(exposureStops) < 1e-3;
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
    const gammaIn = settings.gamma?.in ?? 1;
    const gammaOut = settings.gamma?.out ?? 1;
    const exposureStops = settings.brightness?.offset ?? 0;
    const range = normMax - normMin;
    if (this.isIdentityTransformation(settings)) {
      return { min: normMin, max: normMax };
    }
    const vMin = normMin;
    const exposureFactor = Math.pow(2, exposureStops);
    const linearThreshold = 1 / exposureFactor;
    const normalizedThreshold = Math.pow(linearThreshold, 1 / gammaIn);
    const vMax = normalizedThreshold * range + normMin;
    return { min: vMin, max: vMax };
  }
};
var ImageStatsCalculator = class {
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
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < Math.min(channels, 3); c++) {
        const val = data[i * channels + c];
        if (Number.isFinite(val)) {
          if (val < minVal) minVal = val;
          if (val > maxVal) maxVal = val;
        }
      }
    }
    console.log(`[Stats] Float stats calculation took ${(performance.now() - perfStart).toFixed(2)}ms`);
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
};
var ImageRenderer = class {
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
    const perfStart = performance.now();
    const result = this._renderInternal(data, width, height, channels, isFloat, stats, settings, options);
    if (options.flipY) {
      const flipped = this._flipY(result);
      console.log(`[Render] Total render time: ${(performance.now() - perfStart).toFixed(2)}ms (with flip)`);
      return flipped;
    }
    console.log(`[Render] Total render time: ${(performance.now() - perfStart).toFixed(2)}ms`);
    return result;
  }
  static _renderInternal(data, width, height, channels, isFloat, stats, settings, options = {}) {
    let typeMax;
    if (options.typeMax !== void 0) {
      typeMax = options.typeMax;
    } else if (isFloat) {
      typeMax = 1;
    } else if (data instanceof Uint16Array) {
      typeMax = 65535;
    } else {
      typeMax = 255;
    }
    const isGammaMode = settings.normalization?.gammaMode || false;
    const isIdentity = NormalizationHelper.isIdentityTransformation(settings);
    let min, max;
    if (isGammaMode && isIdentity) {
      min = 0;
      max = typeMax;
    } else {
      const range = NormalizationHelper.getNormalizationRange(
        settings,
        stats,
        typeMax,
        isFloat
      );
      min = range.min;
      max = range.max;
    }
    if (isGammaMode) {
      if (isIdentity) {
        if (isFloat) {
          return this._renderFloatDirect(data, width, height, channels, min, max, options);
        } else if (data instanceof Uint16Array) {
          return this._renderUint16Direct(data, width, height, channels, min, max);
        } else {
          return this._renderUint8Direct(data, width, height, channels, min, max);
        }
      } else {
        if (isFloat) {
          return this._renderFloatWithLUT(data, width, height, channels, min, max, settings, options);
        } else if (data instanceof Uint16Array) {
          return this._renderUint16WithLUT(data, width, height, channels, min, max, settings, options);
        } else {
          return this._renderUint8WithLUT(data, width, height, channels, min, max, settings, options);
        }
      }
    } else {
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
      tempLine.set(data.subarray(topOffset, topOffset + lineSize));
      data.copyWithin(topOffset, bottomOffset, bottomOffset + lineSize);
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
    const nanColor = options.nanColor || { r: 255, g: 0, b: 255 };
    const range = max - min;
    const invRange = range > 0 ? 1 / range : 0;
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
        const p2 = i * 4;
        out[p2] = r;
        out[p2 + 1] = g;
        out[p2 + 2] = b;
        out[p2 + 3] = Number.isFinite(aVal) ? Math.round(Math.max(0, Math.min(1, aVal)) * 255) : 255;
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
    const { min: vMin, max: vMax } = NormalizationHelper.getEffectiveVisualizationRange(settings, min, max);
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
        const p2 = i * 4;
        out[p2] = r;
        out[p2 + 1] = g;
        out[p2 + 2] = b;
        out[p2 + 3] = Number.isFinite(aVal) ? Math.round(Math.max(0, Math.min(1, aVal)) * 255) : 255;
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
      const range2 = max - min;
      const invRange2 = range2 > 0 ? 1 / range2 : 0;
      for (let i = 0; i < width * height; i++) {
        const idx = i * channels;
        const r = Math.round(data[idx] / 257);
        const g = Math.round(data[idx + 1] / 257);
        const b = Math.round(data[idx + 2] / 257);
        const val24 = r << 16 | g << 8 | b;
        const normalized = (val24 - min) * invRange2;
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
    const invRange = range > 0 ? 255 / range : 0;
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
        const p2 = i * 4;
        out[p2] = r;
        out[p2 + 1] = g;
        out[p2 + 2] = b;
        out[p2 + 3] = Math.round(data[idx + 3] / 257);
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
      const range = max - min;
      const invRange = range > 0 ? 1 / range : 0;
      for (let i = 0; i < width * height; i++) {
        const idx = i * channels;
        const r = Math.round(data[idx] / 257);
        const g = Math.round(data[idx + 1] / 257);
        const b = Math.round(data[idx + 2] / 257);
        const val24 = r << 16 | g << 8 | b;
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
        const p2 = i * 4;
        out[p2] = r;
        out[p2 + 1] = g;
        out[p2 + 2] = b;
        out[p2 + 3] = Math.round(data[idx + 3] / 257);
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
      const invRange = range > 0 ? 1 / range : 0;
      for (let i = 0; i < width * height; i++) {
        const idx = i * channels;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const val24 = r << 16 | g << 8 | b;
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
      const range = max - min;
      const invRange = range > 0 ? 255 / range : 0;
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
          const p2 = i * 4;
          out[p2] = r;
          out[p2 + 1] = g;
          out[p2 + 2] = b;
          out[p2 + 3] = data[idx + 3];
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
      const invRange = range > 0 ? 1 / range : 0;
      for (let i = 0; i < width * height; i++) {
        const idx = i * channels;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const val24 = r << 16 | g << 8 | b;
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
        const p2 = i * 4;
        out[p2] = r;
        out[p2 + 1] = g;
        out[p2 + 2] = b;
        out[p2 + 3] = data[idx + 3];
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
};

// media/modules/tiff-wasm-wrapper.js
var wasmModule = null;
var wasmInitPromise = null;
async function initWasm() {
  if (wasmModule) {
    return wasmModule;
  }
  if (wasmInitPromise) {
    return wasmInitPromise;
  }
  wasmInitPromise = (async () => {
    try {
      const { default: init, decode_tiff: decode_tiff2 } = await Promise.resolve().then(() => (init_tiff_wasm(), tiff_wasm_exports));
      await init();
      wasmModule = { decode_tiff: decode_tiff2 };
      return wasmModule;
    } catch (error) {
      console.warn("Failed to load WASM module, will use geotiff.js fallback:", error);
      return null;
    }
  })();
  return wasmInitPromise;
}
var TiffWasmProcessor = class {
  constructor() {
    this.wasm = null;
  }
  /**
   * Initialize the WASM module
   * @returns {Promise\u003cboolean\u003e} - True if WASM loaded, false if falling back to JS
   */
  async init() {
    this.wasm = await initWasm();
    return this.wasm !== null;
  }
  /**
   * Check if WASM is available
   * @returns {boolean}
   */
  isAvailable() {
    return this.wasm !== null;
  }
  /**
   * Decode a TIFF file from an ArrayBuffer
   * @param {ArrayBuffer} buffer - TIFF file data
   * @returns {Promise\u003cTiffDecodeResult\u003e}
   */
  async decode(buffer) {
    if (!this.wasm) {
      throw new Error("WASM not initialized. Call init() first.");
    }
    const uint8Array = new Uint8Array(buffer);
    const result = this.wasm.decode_tiff(uint8Array);
    const decodeResult = {
      width: result.width,
      height: result.height,
      channels: result.channels,
      bitsPerSample: result.bits_per_sample,
      sampleFormat: result.sample_format,
      compression: result.compression,
      predictor: result.predictor,
      photometricInterpretation: result.photometric_interpretation,
      planarConfiguration: result.planar_configuration,
      data: new Float32Array(result.get_data_as_f32()),
      min: result.min_value,
      max: result.max_value
    };
    return decodeResult;
  }
};

// media/modules/tiff-processor.js
var GeoTIFF = window.GeoTIFF;
var TiffProcessor = class {
  constructor(settingsManager, vscode) {
    this.settingsManager = settingsManager;
    this.vscode = vscode;
    this.rawTiffData = null;
    this._pendingRenderData = null;
    this._isInitialLoad = true;
    this._maskCache = /* @__PURE__ */ new Map();
    this._lastImageData = null;
    this._lastStatistics = null;
    this._convertedFloatData = null;
    this._wasmProcessor = new TiffWasmProcessor();
    this._wasmAvailable = false;
    this._wasmProcessor.init().then((available) => {
      this._wasmAvailable = available;
      if (available) {
        console.log("[TiffProcessor] WASM decoder initialized successfully");
      } else {
        console.log("[TiffProcessor] Using geotiff.js fallback");
      }
    }).catch((err) => {
      console.warn("[TiffProcessor] WASM initialization failed:", err);
      this._wasmAvailable = false;
    });
  }
  /**
   * Clamp a value between min and max
   * @param {number} value
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
  /**
   * Get NaN color based on settings
   * @param {Object} settings - Current settings
   * @returns {Object} - RGB values for NaN color
   */
  /**
   * Get NaN color from settings
   * @param {any} settings - Settings object
   * @returns {{r: number, g: number, b: number}}
   */
  _getNanColor(settings) {
    if (settings.nanColor === "fuchsia") {
      return { r: 255, g: 0, b: 255 };
    } else {
      return { r: 0, g: 0, b: 0 };
    }
  }
  /**
   * Process TIFF file from URL
   * @param {string} src - TIFF file URL
   * @returns {Promise<{canvas: HTMLCanvasElement, imageData: ImageData, tiffData: Object}>}
   */
  async processTiff(src) {
    const startTime = performance.now();
    try {
      const response = await fetch(src);
      const buffer = await response.arrayBuffer();
      const fetchTime = performance.now() - startTime;
      console.log(`[TiffProcessor] Fetch time: ${fetchTime.toFixed(2)}ms`);
      if (!this._wasmAvailable && this._wasmProcessor) {
        await this._wasmProcessor.init();
        this._wasmAvailable = this._wasmProcessor.isAvailable();
      }
      const settings = this.settingsManager.settings;
      const use24BitMode = settings.rgbAs24BitGrayscale || false;
      let useWasm = this._wasmAvailable && !use24BitMode;
      console.log(`[TiffProcessor] Decode decision: wasmAvailable=${this._wasmAvailable}, 24BitMode=${use24BitMode}, willUseWasm=${useWasm}`);
      if (useWasm) {
        try {
          const decodeStart2 = performance.now();
          const wasmResult = await this._wasmProcessor.decode(buffer);
          const decodeTime2 = performance.now() - decodeStart2;
          console.log(`[TiffProcessor] WASM decode time: ${decodeTime2.toFixed(2)}ms`);
          const width2 = wasmResult.width;
          const height2 = wasmResult.height;
          const samplesPerPixel2 = wasmResult.channels;
          const bitsPerSample2 = wasmResult.bitsPerSample;
          const sampleFormat2 = wasmResult.sampleFormat;
          const rasters2 = [];
          if (samplesPerPixel2 === 1) {
            rasters2.push(wasmResult.data);
          } else {
            for (let c = 0; c < samplesPerPixel2; c++) {
              const channel = new Float32Array(width2 * height2);
              for (let i = 0; i < width2 * height2; i++) {
                channel[i] = wasmResult.data[i * samplesPerPixel2 + c];
              }
              rasters2.push(channel);
            }
          }
          const data2 = wasmResult.data;
          const compression2 = wasmResult.compression;
          const predictor2 = wasmResult.predictor;
          const photometricInterpretation2 = wasmResult.photometricInterpretation;
          const planarConfig2 = wasmResult.planarConfiguration;
          console.log(`[TiffProcessor] Using metadata from WASM: compression=${compression2}, predictor=${predictor2}`);
          const image2 = {
            getWidth: () => width2,
            getHeight: () => height2,
            getSamplesPerPixel: () => samplesPerPixel2,
            getBitsPerSample: () => bitsPerSample2,
            getSampleFormat: () => sampleFormat2
          };
          this.rawTiffData = {
            image: image2,
            rasters: rasters2,
            ifd: {
              width: width2,
              height: height2,
              t339: sampleFormat2,
              t277: samplesPerPixel2,
              t284: 1,
              // Planar config (chunky)
              t258: bitsPerSample2
            },
            data: data2
          };
          if (this.vscode && this._isInitialLoad) {
            const showNormTiff = sampleFormat2 === 3;
            const formatType = showNormTiff ? "tiff-float" : "tiff-int";
            this.vscode.postMessage({
              type: "formatInfo",
              value: {
                width: width2,
                height: height2,
                sampleFormat: sampleFormat2,
                compression: compression2,
                predictor: predictor2,
                photometricInterpretation: photometricInterpretation2,
                planarConfig: planarConfig2,
                samplesPerPixel: samplesPerPixel2,
                bitsPerSample: bitsPerSample2,
                formatType,
                isInitialLoad: true,
                decodedWith: "wasm"
              }
            });
            this._pendingRenderData = { image: image2, rasters: rasters2 };
            const canvas3 = document.createElement("canvas");
            canvas3.width = width2;
            canvas3.height = height2;
            const placeholderImageData = new ImageData(width2, height2);
            return { canvas: canvas3, imageData: placeholderImageData, tiffData: this.rawTiffData };
          }
          const canvas2 = document.createElement("canvas");
          canvas2.width = width2;
          canvas2.height = height2;
          const imageData2 = await this.renderTiff(image2, rasters2);
          const totalTime2 = performance.now() - startTime;
          console.log(`[TiffProcessor] Total WASM processing time: ${totalTime2.toFixed(2)}ms`);
          return { canvas: canvas2, imageData: imageData2, tiffData: this.rawTiffData };
        } catch (wasmError) {
          console.warn("[TiffProcessor] WASM decoding failed, falling back to geotiff.js:", wasmError);
        }
      }
      const decodeStart = performance.now();
      const tiff = await GeoTIFF.fromArrayBuffer(buffer);
      const image = await tiff.getImage();
      const sampleFormat = image.getSampleFormat();
      const width = image.getWidth();
      const height = image.getHeight();
      const fileDir = image.fileDirectory || {};
      const compression = fileDir.Compression || "Unknown";
      const predictor = fileDir.Predictor;
      const photometricInterpretation = fileDir.PhotometricInterpretation;
      const planarConfig = fileDir.PlanarConfiguration;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const rasters = await image.readRasters();
      const decodeTime = performance.now() - decodeStart;
      console.log(`[TiffProcessor] geotiff.js decode time: ${decodeTime.toFixed(2)}ms`);
      const samplesPerPixel = image.getSamplesPerPixel();
      const bitsPerSample = image.getBitsPerSample();
      let data;
      const showNormFormat = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;
      if (showNormFormat) {
        data = new Float32Array(width * height * samplesPerPixel);
      } else if (bitsPerSample === 16) {
        data = new Uint16Array(width * height * samplesPerPixel);
      } else {
        data = new Uint8Array(width * height * samplesPerPixel);
      }
      if (samplesPerPixel === 1) {
        data.set(rasters[0]);
      } else {
        for (let i = 0; i < rasters[0].length; i++) {
          for (let j = 0; j < samplesPerPixel; j++) {
            data[i * samplesPerPixel + j] = rasters[j][i];
          }
        }
      }
      this.rawTiffData = {
        image,
        rasters,
        ifd: {
          width,
          height,
          t339: Array.isArray(sampleFormat) ? sampleFormat[0] : sampleFormat,
          // SampleFormat
          t277: samplesPerPixel,
          // SamplesPerPixel
          t284: 1,
          // PlanarConfiguration (chunky)
          t258: bitsPerSample
          // BitsPerSample
        },
        data
      };
      if (this.vscode && this._isInitialLoad) {
        const showNormTiff = sampleFormat === 3;
        const formatType = showNormTiff ? "tiff-float" : "tiff-int";
        this.vscode.postMessage({
          type: "formatInfo",
          value: {
            width,
            height,
            sampleFormat,
            compression,
            predictor,
            photometricInterpretation,
            planarConfig,
            samplesPerPixel: image.getSamplesPerPixel(),
            bitsPerSample: image.getBitsPerSample(),
            formatType,
            // For per-format settings
            isInitialLoad: true,
            // Signal that this is the first load
            decodedWith: use24BitMode ? "geotiff.js (24-bit mode)" : "geotiff.js"
          }
        });
        this._pendingRenderData = { image, rasters };
        const placeholderImageData = new ImageData(width, height);
        return { canvas, imageData: placeholderImageData, tiffData: this.rawTiffData };
      }
      const imageData = await this.renderTiff(image, rasters);
      const totalTime = performance.now() - startTime;
      console.log(`[TiffProcessor] Total geotiff.js processing time: ${totalTime.toFixed(2)}ms`);
      return { canvas, imageData, tiffData: this.rawTiffData };
    } catch (error) {
      console.error("Error processing TIFF:", error);
      throw error;
    }
  }
  /**
   * Render TIFF data to ImageData with current settings
   * @param {*} image - GeoTIFF image object
   * @param {*} rasters - Raster data
   * @returns {Promise<ImageData>}
   */
  async renderTiffWithSettings(image, rasters) {
    const rastersCopy = [];
    for (let i = 0; i < rasters.length; i++) {
      rastersCopy.push(new Float32Array(rasters[i]));
    }
    const settings = this.settingsManager.settings;
    if (settings.maskFilters && settings.maskFilters.length > 0) {
      try {
        for (const maskFilter of settings.maskFilters) {
          if (maskFilter.enabled && maskFilter.maskUri) {
            const maskData = await this.loadMaskImage(maskFilter.maskUri);
            for (let band = 0; band < rastersCopy.length; band++) {
              const filteredData = this.applyMaskFilter(
                rastersCopy[band],
                maskData,
                maskFilter.threshold,
                maskFilter.filterHigher
              );
              rastersCopy[band] = filteredData;
            }
          }
        }
      } catch (error) {
        console.error("Error applying mask filters:", error);
      }
    }
    const width = image.getWidth();
    const height = image.getHeight();
    const sampleFormat = image.getSampleFormat();
    const bitsPerSample = image.getBitsPerSample();
    const channels = rastersCopy.length;
    const showNorm = Array.isArray(sampleFormat) ? sampleFormat.includes(3) : sampleFormat === 3;
    const isFloat = showNorm;
    let stats = this._lastStatistics;
    const isGammaMode = settings.normalization?.gammaMode || false;
    if (!stats && !isGammaMode) {
      if (isFloat) {
        let min = Infinity;
        let max = -Infinity;
        if (settings.rgbAs24BitGrayscale && rastersCopy.length >= 3) {
          for (let j = 0; j < rastersCopy[0].length; j++) {
            const values = [];
            for (let i = 0; i < 3; i++) {
              const value = rastersCopy[i][j];
              if (!isNaN(value) && isFinite(value)) {
                values.push(Math.round(Math.max(0, Math.min(255, value))));
              } else {
                values.push(0);
              }
            }
            const combined24bit = values[0] << 16 | values[1] << 8 | values[2];
            min = Math.min(min, combined24bit);
            max = Math.max(max, combined24bit);
          }
        } else {
          for (let i = 0; i < Math.min(rastersCopy.length, 3); i++) {
            for (let j = 0; j < rastersCopy[i].length; j++) {
              const value = rastersCopy[i][j];
              if (!isNaN(value) && isFinite(value)) {
                min = Math.min(min, value);
                max = Math.max(max, value);
              }
            }
          }
        }
        stats = { min, max };
      } else {
        let min = Infinity;
        let max = -Infinity;
        if (settings.rgbAs24BitGrayscale && rastersCopy.length >= 3) {
          for (let j = 0; j < rastersCopy[0].length; j++) {
            const values = [];
            for (let i = 0; i < 3; i++) {
              const value = rastersCopy[i][j];
              values.push(Math.round(Math.max(0, Math.min(255, value))));
            }
            const combined24bit = values[0] << 16 | values[1] << 8 | values[2];
            min = Math.min(min, combined24bit);
            max = Math.max(max, combined24bit);
          }
        } else {
          for (let i = 0; i < Math.min(rastersCopy.length, 3); i++) {
            for (let j = 0; j < rastersCopy[i].length; j++) {
              const value = rastersCopy[i][j];
              min = Math.min(min, value);
              max = Math.max(max, value);
            }
          }
        }
        stats = { min, max };
      }
      this._lastStatistics = stats;
    }
    if (this.vscode && stats) {
      this.vscode.postMessage({ type: "stats", value: stats });
    }
    const nanColor = this._getNanColor(settings);
    let interleavedData;
    const len = width * height;
    if (isFloat) {
      interleavedData = new Float32Array(len * channels);
    } else if (bitsPerSample === 16) {
      interleavedData = new Uint16Array(len * channels);
    } else {
      interleavedData = new Uint8Array(len * channels);
    }
    if (channels === 1) {
      interleavedData.set(rastersCopy[0]);
    } else {
      for (let i = 0; i < len; i++) {
        for (let c = 0; c < channels; c++) {
          interleavedData[i * channels + c] = rastersCopy[c][i];
        }
      }
    }
    const options = {
      nanColor,
      rgbAs24BitGrayscale: settings.rgbAs24BitGrayscale
    };
    return ImageRenderer.render(
      interleavedData,
      width,
      height,
      channels,
      isFloat,
      stats || { min: 0, max: 1 },
      settings,
      options
    );
  }
  /**
   * Fast render TIFF data with current settings (skips mask loading and uses cached statistics)
   * @param {*} image - GeoTIFF image object
   * @param {*} rasters - Raster data
   * @param {boolean} skipMasks - Whether to skip mask filtering
   * @returns {Promise<ImageData>}
   */
  async renderTiffWithSettingsFast(image, rasters, skipMasks = true) {
    return this.renderTiffWithSettings(image, rasters);
  }
  async renderTiff(image, rasters) {
    return this.renderTiffWithSettings(image, rasters);
  }
  /**
   * Load mask image for filtering
   * @param {string} maskSrc - Mask TIFF file URL
   * @returns {Promise<Float32Array>}
   */
  async loadMaskImage(maskSrc) {
    if (this._maskCache.has(maskSrc)) {
      return this._maskCache.get(maskSrc);
    }
    try {
      const response = await fetch(maskSrc);
      const buffer = await response.arrayBuffer();
      const tiff = await GeoTIFF.fromArrayBuffer(buffer);
      const image = await tiff.getImage();
      const rasters = await image.readRasters();
      const maskData = new Float32Array(rasters[0]);
      this._maskCache.set(maskSrc, maskData);
      return maskData;
    } catch (error) {
      console.error("Error loading mask image:", error);
      throw error;
    }
  }
  /**
   * Clear the mask cache (call when mask URIs change)
   */
  clearMaskCache() {
    this._maskCache.clear();
  }
  /**
   * Apply mask filtering to image data
   * @param {Float32Array} imageData - Original image data
   * @param {Float32Array} maskData - Mask data
   * @param {number} threshold - Threshold value
   * @param {boolean} filterHigher - Whether to filter higher or lower values
   * @returns {Float32Array} - Filtered image data
   */
  applyMaskFilter(imageData, maskData, threshold, filterHigher) {
    const filteredData = new Float32Array(imageData.length);
    for (let i = 0; i < imageData.length; i++) {
      const maskValue = maskData[i];
      const imageValue = imageData[i];
      let shouldFilter = false;
      if (filterHigher) {
        shouldFilter = maskValue > threshold;
      } else {
        shouldFilter = maskValue < threshold;
      }
      if (shouldFilter) {
        filteredData[i] = NaN;
      } else {
        filteredData[i] = imageValue;
      }
    }
    return filteredData;
  }
  /**
   * Get color at specific pixel coordinates
   * @param {number} x
   * @param {number} y
   * @param {number} naturalWidth
   * @param {number} naturalHeight
   * @returns {string}
   */
  getColorAtPixel(x, y, naturalWidth, naturalHeight) {
    if (this._convertedFloatData) {
      const pixelIndex2 = y * naturalWidth + x;
      const floatValue = this._convertedFloatData.floatData[pixelIndex2];
      return floatValue.toPrecision(6);
    }
    if (!this.rawTiffData) {
      return "";
    }
    const ifd = this.rawTiffData.ifd;
    const data = this.rawTiffData.data;
    const pixelIndex = y * naturalWidth + x;
    const format = ifd.t339;
    const samples = ifd.t277;
    const planarConfig = ifd.t284;
    const bitsPerSample = ifd.t258;
    const settings = this.settingsManager.settings;
    if (samples === 1) {
      const value = data[pixelIndex];
      if (settings.normalizedFloatMode && format !== 3) {
        const maxValue = bitsPerSample === 16 ? 65535 : 255;
        const normalized = value / maxValue;
        return normalized.toPrecision(4);
      }
      return format === 3 ? value.toPrecision(4) : value.toString();
    } else if (samples >= 3) {
      const values = [];
      if (planarConfig === 2) {
        const planeSize = naturalWidth * naturalHeight;
        for (let i = 0; i < samples; i++) {
          const value = data[pixelIndex + i * planeSize];
          values.push(format === 3 ? value.toPrecision(4) : value.toString().padStart(3, "0"));
        }
      } else {
        for (let i = 0; i < samples; i++) {
          const value = data[pixelIndex * samples + i];
          values.push(format === 3 ? value.toPrecision(4) : value.toString().padStart(3, "0"));
        }
      }
      if (settings.rgbAs24BitGrayscale && samples >= 3) {
        const r = parseInt(values[0]);
        const g = parseInt(values[1]);
        const b = parseInt(values[2]);
        const combined24bit = r << 16 | g << 8 | b;
        const scaleFactor = settings.scale24BitFactor || 1e3;
        const scaledValue = (combined24bit / scaleFactor).toFixed(3);
        return scaledValue;
      }
      if (format === 3) {
        return values.join(" ");
      } else {
        return values.slice(0, 3).join(" ");
      }
    }
    return "";
  }
  /**
   * Fast parameter update - DISABLED to prevent double-correction
   * We always re-render from raw TIFF data to ensure correct gamma/brightness application
   * @param {ImageData} existingImageData - Current image data
   * @returns {Promise<ImageData|null>} - Always returns null to force full re-render
   */
  async fastParameterUpdate(existingImageData) {
    return null;
  }
  /**
   * Perform the initial render if it was deferred
   * Called when format-specific settings have been applied
   * @returns {Promise<ImageData|null>} - The rendered image data, or null if no pending render
   */
  async performDeferredRender() {
    const perfStart = performance.now();
    if (!this._pendingRenderData) {
      return null;
    }
    const { image, rasters } = this._pendingRenderData;
    this._pendingRenderData = null;
    this._isInitialLoad = false;
    const imageData = await this.renderTiff(image, rasters);
    console.log(`[TiffProcessor] Deferred render took ${(performance.now() - perfStart).toFixed(2)}ms`);
    return imageData;
  }
};

// media/modules/exr-processor.js
var ExrProcessor = class {
  constructor(settingsManager, vscode) {
    this.settingsManager = settingsManager;
    this.vscode = vscode;
    this._lastRaw = null;
    this._pendingRenderData = null;
    this._isInitialLoad = true;
    this._cachedStats = void 0;
  }
  /**
   * Clamp a value between min and max
   * @param {number} value
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
  /**
   * Get NaN color based on settings
   * @param {Object} settings - Current settings
   * @returns {Object} - RGB values for NaN color
   */
  _getNanColor(settings) {
    if (settings.nanColor === "fuchsia") {
      return { r: 255, g: 0, b: 255 };
    } else {
      return { r: 0, g: 0, b: 0 };
    }
  }
  /**
   * Process EXR file from URL
   * @param {string} src - EXR file URL
   * @returns {Promise<{canvas: HTMLCanvasElement, imageData: ImageData, exrData: Object}>}
   */
  async processExr(src) {
    try {
      if (typeof parseExr === "undefined") {
        throw new Error("parseExr library not loaded. Make sure parse-exr is included.");
      }
      const response = await fetch(src);
      const buffer = await response.arrayBuffer();
      this._cachedStats = void 0;
      const FloatType = 1015;
      const exrResult = parseExr(buffer, FloatType);
      const { width, height, data, format, type } = exrResult;
      let channels;
      if (format === 1023) {
        channels = 4;
      } else if (format === 1028) {
        channels = 1;
      } else {
        const pixelCount = width * height;
        const totalValues = data.length;
        channels = totalValues / pixelCount;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      this.rawExrData = {
        width,
        height,
        data,
        // Float32Array or Uint16Array
        channels,
        type,
        // 1015 = Float32, 1016 = HalfFloat
        format,
        isFloat: true
        // EXR is always floating point
      };
      if (this.vscode && this._isInitialLoad) {
        this.vscode.postMessage({
          type: "formatInfo",
          value: {
            width,
            height,
            channels,
            samplesPerPixel: channels,
            dataType: type === 1016 ? "float16" : "float32",
            isHdr: true,
            formatLabel: "EXR",
            formatType: "exr-float",
            // For per-format settings
            isInitialLoad: true
            // Signal that this is the first load
          }
        });
        this._pendingRenderData = { width, height, data, channels, type, format };
        const placeholderImageData = new ImageData(width, height);
        return {
          canvas,
          imageData: placeholderImageData,
          exrData: this.rawExrData
        };
      }
      const imageData = this.renderExrToCanvas(canvas, this.settingsManager.settings);
      return {
        canvas,
        imageData,
        exrData: this.rawExrData
      };
    } catch (error) {
      console.error("Error processing EXR:", error);
      throw error;
    }
  }
  /**
   * Render EXR data to canvas with current settings
   * @param {HTMLCanvasElement} canvas - Target canvas
   * @param {Object} settings - Current rendering settings
   * @returns {ImageData} - Rendered image data
   */
  renderExrToCanvas(canvas, settings) {
    if (!this.rawExrData) {
      throw new Error("No EXR data loaded");
    }
    const { width, height, data, channels } = this.rawExrData;
    const ctx = canvas.getContext("2d");
    const isGammaMode = settings.normalization?.gammaMode || false;
    let stats = this._cachedStats;
    if (!stats && !isGammaMode) {
      stats = ImageStatsCalculator.calculateFloatStats(data, width, height, channels);
      this._cachedStats = stats;
      const isAutoNormalize = settings.normalization?.autoNormalize !== false;
      if (isAutoNormalize && this.settingsManager && this.settingsManager.settings.normalization) {
        this.settingsManager.settings.normalization.min = stats.min;
        this.settingsManager.settings.normalization.max = stats.max;
      }
    }
    const nanColor = this._getNanColor(settings);
    const options = {
      nanColor,
      // EXR data is typically bottom-up, so we need to flip it for display
      flipY: true
    };
    const imageData = ImageRenderer.render(
      data,
      width,
      height,
      channels,
      true,
      // isFloat
      stats || { min: 0, max: 1 },
      settings,
      options
    );
    ctx.putImageData(imageData, 0, 0);
    return imageData;
  }
  /**
   * Get pixel value at coordinates for inspection
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @returns {Array<number>} - Pixel values (raw HDR values)
   */
  getPixelValue(x, y) {
    if (!this.rawExrData) return null;
    const { width, height, data, channels } = this.rawExrData;
    if (x < 0 || x >= width || y < 0 || y >= height) return null;
    const flippedY = height - 1 - y;
    const dataIndex = (flippedY * width + x) * channels;
    const values = [];
    for (let i = 0; i < channels; i++) {
      values.push(data[dataIndex + i]);
    }
    return values;
  }
  /**
   * Update rendering with new settings (called when settings change)
   * @param {Object} settings - New settings
   * @returns {ImageData|null} - Updated image data
   */
  updateSettings(settings) {
    if (this._pendingRenderData && this._isInitialLoad) {
      const { width, height } = this._pendingRenderData;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const imageData = this.renderExrToCanvas(canvas, settings);
      this._isInitialLoad = false;
      this._pendingRenderData = null;
      return imageData;
    } else if (this.rawExrData) {
      const { width, height } = this.rawExrData;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return this.renderExrToCanvas(canvas, settings);
    }
    return null;
  }
};

// media/modules/npy-processor.js
function float16ToFloat32(uint16) {
  const sign = (uint16 & 32768) >> 15;
  const exponent = (uint16 & 31744) >> 10;
  const fraction = uint16 & 1023;
  if (exponent === 0) {
    if (fraction === 0) {
      return sign ? -0 : 0;
    }
    return (sign ? -1 : 1) * Math.pow(2, -14) * (fraction / 1024);
  } else if (exponent === 31) {
    return fraction ? NaN : sign ? -Infinity : Infinity;
  }
  return (sign ? -1 : 1) * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}
var NpyProcessor = class {
  constructor(settingsManager, vscode) {
    this.settingsManager = settingsManager;
    this.vscode = vscode;
    this._lastRaw = null;
    this._pendingRenderData = null;
    this._isInitialLoad = true;
    this._cachedStats = void 0;
  }
  async processNpy(src) {
    this._cachedStats = void 0;
    const response = await fetch(src);
    const buffer = await response.arrayBuffer();
    const view = new DataView(buffer);
    if (buffer.byteLength >= 4 && view.getUint32(0, true) === 67324752) {
      const { data: data2, width: width2, height: height2, dtype: dtype2, showNorm: showNorm2, channels: channels2 } = this._parseNpz(buffer);
      this._lastRaw = { width: width2, height: height2, data: data2, dtype: dtype2, showNorm: showNorm2, channels: channels2 };
      const canvas2 = document.createElement("canvas");
      canvas2.width = width2;
      canvas2.height = height2;
      if (this._isInitialLoad) {
        this._postFormatInfo(width2, height2, "NPY");
        this._pendingRenderData = { data: data2, width: width2, height: height2 };
        const placeholderImageData = new ImageData(width2, height2);
        return { canvas: canvas2, imageData: placeholderImageData };
      }
      const imageData2 = this._toImageDataFloat(data2, width2, height2);
      this.vscode.postMessage({ type: "refresh-status" });
      return { canvas: canvas2, imageData: imageData2 };
    }
    const { data, width, height, dtype, showNorm, channels } = this._parseNpy(buffer);
    this._lastRaw = { width, height, data, dtype, showNorm, channels };
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    if (this._isInitialLoad) {
      this._postFormatInfo(width, height, "NPY");
      this._pendingRenderData = { data, width, height };
      const placeholderImageData = new ImageData(width, height);
      return { canvas, imageData: placeholderImageData };
    }
    const imageData = this._toImageDataFloat(data, width, height);
    this.vscode.postMessage({ type: "refresh-status" });
    return { canvas, imageData };
  }
  _parseNpy(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const magic = new Uint8Array(arrayBuffer, 0, 6);
    const expected = [147, 78, 85, 77, 80, 89];
    for (let i = 0; i < 6; i++) {
      if (magic[i] !== expected[i]) {
        throw new Error("Invalid NPY file");
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
    const header = new TextDecoder("latin1").decode(headerBytes);
    const shapeMatch = header.match(/'shape':\s*\(([^)]+)\)/);
    if (!shapeMatch) throw new Error("NPY missing shape");
    const dims = shapeMatch[1].split(",").map((s) => s.trim()).filter(Boolean).map((s) => parseInt(s, 10));
    const dtypeMatch = header.match(/'descr':\s*'([^']+)'/);
    if (!dtypeMatch) throw new Error("NPY missing dtype");
    const dtype = dtypeMatch[1];
    const showNorm = dtype.includes("f");
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
    if (dtype === "<f4" || dtype === "=f4") {
      raw = new Float32Array(arrayBuffer, off, elems);
    } else if (dtype === ">f4") {
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
    } else if (dtype.endsWith("f8")) {
      const src = new Float64Array(arrayBuffer, off, elems);
      raw = new Float32Array(elems);
      for (let i = 0; i < elems; i++) raw[i] = src[i];
    } else if (dtype.includes("f2")) {
      const bytes = new Uint8Array(arrayBuffer, off, elems * 2);
      const little = dtype.startsWith("<") || dtype.startsWith("=");
      raw = new Float32Array(elems);
      for (let i = 0; i < elems; i++) {
        const p = i * 2;
        const uint16 = little ? bytes[p] | bytes[p + 1] << 8 : bytes[p] << 8 | bytes[p + 1];
        raw[i] = float16ToFloat32(uint16);
      }
    } else {
      const bytes = parseInt(dtype.slice(-1), 10);
      const little = dtype.startsWith("<") || dtype.startsWith("=");
      const dv = new DataView(arrayBuffer, off);
      raw = new Float32Array(elems);
      for (let i = 0; i < elems; i++) {
        const p = i * bytes;
        let v = 0;
        if (bytes === 1) v = dtype.includes("u") ? dv.getUint8(p) : dv.getInt8(p);
        else if (bytes === 2) v = dtype.includes("u") ? dv.getUint16(p, little) : dv.getInt16(p, little);
        else if (bytes === 4) v = dtype.includes("u") ? dv.getUint32(p, little) : dv.getInt32(p, little);
        else v = Number(dtype.includes("u") ? dv.getBigUint64(p, little) : dv.getBigInt64(p, little));
        raw[i] = v;
      }
    }
    let data;
    if (channels === 1) {
      data = raw;
    } else if (channels === 3 || channels === 4) {
      data = raw;
    } else {
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
      if (sig !== 67324752) {
        offset++;
        continue;
      }
      const comp = view.getUint16(offset + 8, true);
      const nameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);
      const compSize = view.getUint32(offset + 18, true);
      const fileName = new TextDecoder().decode(new Uint8Array(arrayBuffer, offset + 30, nameLen));
      const dataOffset = offset + 30 + nameLen + extraLen;
      if (fileName.endsWith(".npy") && comp === 0) {
        const slice = arrayBuffer.slice(dataOffset, dataOffset + compSize);
        const { data, width, height, dtype, showNorm, channels } = this._parseNpy(slice);
        arrays[fileName.replace(".npy", "")] = { data, width, height, dtype, showNorm, channels };
      }
      offset = dataOffset + compSize;
    }
    const keys = Object.keys(arrays);
    if (keys.length === 0) throw new Error("NPZ contains no uncompressed .npy arrays");
    let pick = keys.find((k) => /depth|dispar|inv|z|range/i.test(k));
    if (!pick) pick = keys[0];
    const a = arrays[pick];
    return { data: a.data, width: a.width, height: a.height, dtype: a.dtype, showNorm: a.showNorm, channels: a.channels };
  }
  _toImageDataFloat(data, width, height) {
    const channels = this._lastRaw?.channels || 1;
    const settings = this.settingsManager.settings;
    const rgbAs24BitMode = settings.rgbAs24BitGrayscale && channels === 3;
    const dtype = this._lastRaw?.dtype || "f4";
    const isFloat = dtype.includes("f");
    const isGammaMode = settings.normalization?.gammaMode || false;
    let stats = this._cachedStats;
    if (!stats && !isGammaMode) {
      if (isFloat) {
        stats = ImageStatsCalculator.calculateFloatStats(data, width, height, channels);
      } else {
        stats = ImageStatsCalculator.calculateIntegerStats(data, width, height, channels, rgbAs24BitMode);
      }
      this._cachedStats = stats;
      if (this.vscode) {
        this.vscode.postMessage({ type: "stats", value: stats });
      }
    }
    const nanColor = this._getNanColor(settings);
    let typeMax;
    if (!isFloat) {
      if (dtype.includes("1")) typeMax = 255;
      else if (dtype.includes("2")) typeMax = 65535;
      else if (dtype.includes("4")) typeMax = 4294967295;
    }
    const options = {
      nanColor,
      rgbAs24BitGrayscale: rgbAs24BitMode,
      flipY: false,
      // NPY is usually top-down
      typeMax
    };
    return ImageRenderer.render(
      data,
      width,
      height,
      channels,
      true,
      // Always true since NPY stores everything as Float32Array
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
    if (!this._lastRaw) return "";
    const { width, height, data, channels, dtype } = this._lastRaw;
    if (width !== naturalWidth || height !== naturalHeight) return "";
    const pixelIdx = y * width + x;
    const settings = this.settingsManager.settings;
    const rgbAs24BitMode = settings.rgbAs24BitGrayscale && channels === 3;
    const normalizedFloatMode = settings.normalizedFloatMode;
    if (rgbAs24BitMode) {
      const srcIdx = pixelIdx * 3;
      const rVal = Math.round(Math.max(0, Math.min(255, data[srcIdx + 0])));
      const gVal = Math.round(Math.max(0, Math.min(255, data[srcIdx + 1])));
      const bVal = Math.round(Math.max(0, Math.min(255, data[srcIdx + 2])));
      const combined24bit = rVal << 16 | gVal << 8 | bVal;
      const scaleFactor = settings.scale24BitFactor || 1e3;
      const scaledValue = (combined24bit / scaleFactor).toFixed(3);
      return scaledValue;
    } else if (channels === 3) {
      const srcIdx = pixelIdx * 3;
      const r = data[srcIdx + 0];
      const g = data[srcIdx + 1];
      const b = data[srcIdx + 2];
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        const formatNumber = (n) => {
          return parseFloat(n.toFixed(6)).toString();
        };
        return `${formatNumber(r)} ${formatNumber(g)} ${formatNumber(b)}`;
      }
    } else if (channels === 4) {
      const srcIdx = pixelIdx * 4;
      const r = data[srcIdx + 0];
      const g = data[srcIdx + 1];
      const b = data[srcIdx + 2];
      const a = data[srcIdx + 3];
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && Number.isFinite(a)) {
        const formatNumber = (n) => {
          return parseFloat(n.toFixed(6)).toString();
        };
        return `${formatNumber(r)} ${formatNumber(g)} ${formatNumber(b)} \u03B1:${formatNumber(a)}`;
      }
    } else {
      const value = data[pixelIdx];
      if (Number.isFinite(value)) {
        const formatNumber = (n) => {
          return parseFloat(n.toFixed(6)).toString();
        };
        if (normalizedFloatMode && dtype && !dtype.includes("f")) {
          let maxValue = 255;
          if (dtype.includes("u2") || dtype.includes("i2")) {
            maxValue = dtype.includes("u") ? 65535 : 32767;
          } else if (dtype.includes("u4") || dtype.includes("i4")) {
            maxValue = dtype.includes("u") ? 4294967295 : 2147483647;
          }
          const normalized = value / maxValue;
          return formatNumber(normalized);
        }
        return formatNumber(value);
      }
    }
    return "";
  }
  /**
   * Send format info to VS Code
   * @param {number} width - Image width
   * @param {number} height - Image height
   * @param {string} formatLabel - Format label
   */
  _postFormatInfo(width, height, formatLabel) {
    if (!this.vscode) return;
    let bitsPerSample = 32;
    let sampleFormat = 3;
    if (this._lastRaw && this._lastRaw.dtype) {
      const dtype = this._lastRaw.dtype;
      if (dtype.includes("f")) {
        sampleFormat = 3;
        if (dtype.includes("f2")) bitsPerSample = 16;
        else if (dtype.includes("f4")) bitsPerSample = 32;
        else if (dtype.includes("f8")) bitsPerSample = 64;
      } else if (dtype.includes("u")) {
        sampleFormat = 1;
        if (dtype.includes("u1")) bitsPerSample = 8;
        else if (dtype.includes("u2")) bitsPerSample = 16;
        else if (dtype.includes("u4")) bitsPerSample = 32;
        else if (dtype.includes("u8")) bitsPerSample = 64;
      } else if (dtype.includes("i")) {
        sampleFormat = 2;
        if (dtype.includes("i1")) bitsPerSample = 8;
        else if (dtype.includes("i2")) bitsPerSample = 16;
        else if (dtype.includes("i4")) bitsPerSample = 32;
        else if (dtype.includes("i8")) bitsPerSample = 64;
      }
    }
    const channels = this._lastRaw?.channels || 1;
    let formatType = "npy";
    if (sampleFormat === 3) {
      formatType = "npy-float";
    } else if (sampleFormat === 1 || sampleFormat === 2) {
      formatType = "npy-uint";
    }
    this.vscode.postMessage({
      type: "formatInfo",
      value: {
        width,
        height,
        compression: "1",
        predictor: 3,
        photometricInterpretation: channels >= 3 ? 2 : 1,
        planarConfig: 1,
        samplesPerPixel: channels,
        bitsPerSample,
        sampleFormat,
        formatLabel,
        formatType,
        // For per-format settings: 'npy-float' or 'npy-uint'
        isInitialLoad: this._isInitialLoad
        // Signal that this is the first load
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
    const imageData = this._toImageDataFloat(data, width, height);
    this.vscode.postMessage({ type: "refresh-status" });
    return imageData;
  }
  /**
   * Get NaN color from settings
   * @param {Object} settings
   * @returns {{r: number, g: number, b: number}}
   */
  _getNanColor(settings) {
    if (settings.nanColor) {
      if (typeof settings.nanColor === "string") {
        const hex = settings.nanColor.replace("#", "");
        return {
          r: parseInt(hex.substring(0, 2), 16),
          g: parseInt(hex.substring(2, 4), 16),
          b: parseInt(hex.substring(4, 6), 16)
        };
      }
      return settings.nanColor;
    }
    return { r: 255, g: 0, b: 0 };
  }
};

// media/modules/pfm-processor.js
var PfmProcessor = class {
  constructor(settingsManager, vscode) {
    this.settingsManager = settingsManager;
    this.vscode = vscode;
    this._lastRaw = null;
    this._pendingRenderData = null;
    this._isInitialLoad = true;
    this._cachedStats = void 0;
  }
  async processPfm(src) {
    const response = await fetch(src);
    const buffer = await response.arrayBuffer();
    const { width, height, channels, data } = this._parsePfm(buffer);
    let displayData = data;
    displayData = this._flipImageVertically(displayData, width, height, channels);
    this._cachedStats = void 0;
    this._lastRaw = { width, height, data: displayData, channels };
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    if (this._isInitialLoad) {
      this._postFormatInfo(width, height, channels, "PFM");
      this._pendingRenderData = { displayData, width, height, channels };
      const placeholderImageData = new ImageData(width, height);
      return { canvas, imageData: placeholderImageData };
    }
    this._postFormatInfo(width, height, channels, "PFM");
    const imageData = this._toImageDataFloat(displayData, width, height, channels);
    this.vscode.postMessage({ type: "refresh-status" });
    return { canvas, imageData };
  }
  _parsePfm(arrayBuffer) {
    const text = new TextDecoder("ascii").decode(arrayBuffer);
    const lines = text.split(/\n/);
    let idx = 0;
    while (idx < lines.length && lines[idx].trim() === "") idx++;
    const type = lines[idx++].trim();
    if (type !== "PF" && type !== "Pf") throw new Error("Invalid PFM magic");
    while (idx < lines.length && lines[idx].trim().startsWith("#")) idx++;
    const dims = lines[idx++].trim().split(/\s+/).map((n) => parseInt(n, 10));
    const width = dims[0];
    const height = dims[1];
    const scale = parseFloat(lines[idx++].trim());
    const littleEndian = scale < 0;
    const channels = type === "PF" ? 3 : 1;
    const headerUpTo = lines.slice(0, idx).join("\n") + "\n";
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
    const settings = this.settingsManager.settings;
    const isGammaMode = settings.normalization?.gammaMode || false;
    let stats = this._cachedStats;
    if (!stats && !isGammaMode) {
      stats = ImageStatsCalculator.calculateFloatStats(data, width, height, channels);
      this._cachedStats = stats;
      if (this.vscode) {
        this.vscode.postMessage({ type: "stats", value: stats });
      }
    }
    return ImageRenderer.render(
      data,
      width,
      height,
      channels,
      true,
      // isFloat (float32)
      stats || { min: 0, max: 1 },
      settings,
      {}
      // No special options for PFM
    );
  }
  getColorAtPixel(x, y, naturalWidth, naturalHeight) {
    if (!this._lastRaw) return "";
    const { width, height, data, channels } = this._lastRaw;
    if (width !== naturalWidth || height !== naturalHeight) return "";
    const idx = y * width + x;
    const formatValue = (v) => {
      if (Number.isNaN(v)) return "NaN";
      if (v === Infinity) return "Inf";
      if (v === -Infinity) return "-Inf";
      return parseFloat(v.toFixed(6)).toString();
    };
    if (channels === 3) {
      const baseIdx = idx * 3;
      if (baseIdx >= 0 && baseIdx + 2 < data.length) {
        const r = data[baseIdx];
        const g = data[baseIdx + 1];
        const b = data[baseIdx + 2];
        return `${formatValue(r)} ${formatValue(g)} ${formatValue(b)}`;
      }
    } else {
      const value = data[idx];
      return formatValue(value);
    }
    return "";
  }
  _postFormatInfo(width, height, channels, formatLabel) {
    if (!this.vscode) return;
    this.vscode.postMessage({
      type: "formatInfo",
      value: {
        width,
        height,
        compression: "1",
        predictor: 3,
        photometricInterpretation: channels === 3 ? 2 : 1,
        planarConfig: 1,
        samplesPerPixel: channels,
        bitsPerSample: 32,
        sampleFormat: 3,
        formatLabel,
        formatType: "pfm",
        // For per-format settings
        isInitialLoad: this._isInitialLoad
        // Signal that this is the first load
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
    const imageData = this._toImageDataFloat(displayData, width, height, channels);
    this.vscode.postMessage({ type: "refresh-status" });
    return imageData;
  }
  /**
   * Update settings and trigger re-render
   * @param {Object} settings - New settings
   */
  updateSettings(settings) {
    this.settingsManager.updateSettings(settings);
    if (settings.normalization?.autoNormalize !== this.settingsManager.settings.normalization?.autoNormalize) {
      this._cachedStats = null;
    }
    if (this.vscode) {
      this.vscode.postMessage({ type: "settings-updated" });
    }
  }
  _flipImageVertically(data, width, height, channels = 1) {
    const flipped = new Float32Array(data.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (channels === 3) {
          const srcIdx = (y * width + x) * 3;
          const dstIdx = ((height - 1 - y) * width + x) * 3;
          flipped[dstIdx] = data[srcIdx];
          flipped[dstIdx + 1] = data[srcIdx + 1];
          flipped[dstIdx + 2] = data[srcIdx + 2];
        } else {
          const srcIdx = y * width + x;
          const dstIdx = (height - 1 - y) * width + x;
          flipped[dstIdx] = data[srcIdx];
        }
      }
    }
    return flipped;
  }
};

// media/modules/ppm-processor.js
var PpmProcessor = class {
  constructor(settingsManager, vscode) {
    this.settingsManager = settingsManager;
    this.vscode = vscode;
    this._lastRaw = null;
    this._pendingRenderData = null;
    this._isInitialLoad = true;
    this._cachedStats = void 0;
  }
  async processPpm(src) {
    const response = await fetch(src);
    const buffer = await response.arrayBuffer();
    const { width, height, channels, data, maxval, format } = this._parsePpm(buffer);
    const displayData = data;
    this._cachedStats = void 0;
    this._lastRaw = { width, height, data: displayData, maxval, channels };
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    if (this._isInitialLoad) {
      this._postFormatInfo(width, height, channels, format, maxval);
      this._pendingRenderData = { displayData, width, height, maxval, channels };
      const placeholderImageData = new ImageData(width, height);
      return { canvas, imageData: placeholderImageData };
    }
    this._postFormatInfo(width, height, channels, format, maxval);
    const imageData = this._toImageDataWithNormalization(displayData, width, height, maxval, channels);
    this.vscode.postMessage({ type: "refresh-status" });
    return { canvas, imageData };
  }
  _parsePpm(arrayBuffer) {
    const uint8Array = new Uint8Array(arrayBuffer);
    let offset = 0;
    const readToken = () => {
      while (offset < uint8Array.length) {
        const char = uint8Array[offset];
        if (char === 35) {
          while (offset < uint8Array.length && uint8Array[offset] !== 10) {
            offset++;
          }
          if (offset < uint8Array.length) offset++;
        } else if (char === 32 || char === 9 || char === 10 || char === 13) {
          offset++;
        } else {
          break;
        }
      }
      let token = "";
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
    const magic = readToken();
    if (!["P1", "P2", "P3", "P4", "P5", "P6"].includes(magic)) {
      throw new Error(`Invalid PPM/PGM/PBM magic number: ${magic}`);
    }
    const isAscii = magic === "P1" || magic === "P2" || magic === "P3";
    const channels = magic === "P1" || magic === "P4" || magic === "P2" || magic === "P5" ? 1 : 3;
    const format = magic === "P1" ? "PBM (ASCII)" : magic === "P2" ? "PGM (ASCII)" : magic === "P3" ? "PPM (ASCII)" : magic === "P4" ? "PBM (Binary)" : magic === "P5" ? "PGM (Binary)" : "PPM (Binary)";
    const isPbm = magic === "P1" || magic === "P4";
    const width = parseInt(readToken(), 10);
    const height = parseInt(readToken(), 10);
    const maxval = isPbm ? 1 : parseInt(readToken(), 10);
    if (width <= 0 || height <= 0 || !isPbm && maxval <= 0) {
      throw new Error("Invalid PPM/PGM/PBM dimensions or maxval");
    }
    const pixelCount = width * height;
    const totalValues = pixelCount * channels;
    const use16bit = !isPbm && maxval > 255;
    const DataType = use16bit ? Uint16Array : Uint8Array;
    const data = new DataType(totalValues);
    if (isPbm && isAscii) {
      for (let i = 0; i < totalValues; i++) {
        const token = readToken();
        const value = parseInt(token, 10);
        if (value !== 0 && value !== 1) {
          throw new Error(`Invalid PBM pixel value: ${token} (must be 0 or 1)`);
        }
        data[i] = value === 0 ? 255 : 0;
      }
    } else if (isPbm && !isAscii) {
      const bytesPerRow = Math.ceil(width / 8);
      const expectedBytes = bytesPerRow * height;
      if (offset + expectedBytes > uint8Array.length) {
        throw new Error("Insufficient data for binary PBM");
      }
      let dataIdx = 0;
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          const byteIdx = offset + row * bytesPerRow + Math.floor(col / 8);
          const bitIdx = 7 - col % 8;
          const bit = uint8Array[byteIdx] >> bitIdx & 1;
          data[dataIdx++] = bit === 0 ? 255 : 0;
        }
      }
    } else if (isAscii) {
      for (let i = 0; i < totalValues; i++) {
        const token = readToken();
        const value = parseInt(token, 10);
        if (isNaN(value) || value < 0 || value > maxval) {
          throw new Error(`Invalid pixel value: ${token}`);
        }
        data[i] = value;
      }
    } else {
      if (offset < uint8Array.length) {
        const char = uint8Array[offset];
        if (char === 32 || char === 9 || char === 10 || char === 13) {
          offset++;
        }
      }
      const bytesPerValue = use16bit ? 2 : 1;
      const expectedBytes = totalValues * bytesPerValue;
      if (offset + expectedBytes > uint8Array.length) {
        throw new Error("Insufficient data for binary PPM/PGM");
      }
      if (use16bit) {
        const dataView = new DataView(arrayBuffer, offset);
        for (let i = 0; i < totalValues; i++) {
          data[i] = dataView.getUint16(i * 2, false);
        }
      } else {
        for (let i = 0; i < totalValues; i++) {
          data[i] = uint8Array[offset + i];
        }
      }
    }
    return { width, height, channels, data, maxval, format };
  }
  _toImageDataWithNormalization(data, width, height, maxval, channels = 1) {
    const settings = this.settingsManager.settings;
    const rgbAs24BitMode = settings.rgbAs24BitGrayscale && channels === 3;
    const isGammaMode = settings.normalization?.gammaMode || false;
    let stats = this._cachedStats;
    if (!stats && !isGammaMode) {
      if (rgbAs24BitMode) {
        let min = Infinity;
        let max = -Infinity;
        const len = width * height;
        const is16Bit = data instanceof Uint16Array;
        for (let i = 0; i < len; i++) {
          const srcIdx = i * 3;
          let r, g, b;
          if (is16Bit) {
            r = Math.round(data[srcIdx] / 257);
            g = Math.round(data[srcIdx + 1] / 257);
            b = Math.round(data[srcIdx + 2] / 257);
          } else {
            r = data[srcIdx];
            g = data[srcIdx + 1];
            b = data[srcIdx + 2];
          }
          const combined24bit = r << 16 | g << 8 | b;
          if (combined24bit < min) min = combined24bit;
          if (combined24bit > max) max = combined24bit;
        }
        stats = { min, max };
      } else {
        stats = ImageStatsCalculator.calculateIntegerStats(data, width, height, channels);
      }
      this._cachedStats = stats;
    }
    const options = {
      rgbAs24BitGrayscale: rgbAs24BitMode,
      typeMax: rgbAs24BitMode ? 16777215 : maxval
    };
    return ImageRenderer.render(
      data,
      width,
      height,
      channels,
      false,
      // isFloat
      stats,
      settings,
      options
    );
  }
  /**
   * Re-render PPM/PGM with current settings (for real-time updates)
   */
  renderPgmWithSettings() {
    if (!this._lastRaw) return null;
    const { width, height, data, maxval, channels } = this._lastRaw;
    return this._toImageDataWithNormalization(data, width, height, maxval, channels);
  }
  /**
   * Get color at specific pixel
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @param {number} naturalWidth - Image natural width
   * @param {number} naturalHeight - Image natural height
   * @returns {string} Color string
   */
  getColorAtPixel(x, y, naturalWidth, naturalHeight) {
    if (!this._lastRaw) return "";
    const { width, height, data, channels, maxval } = this._lastRaw;
    if (width !== naturalWidth || height !== naturalHeight) return "";
    const settings = this.settingsManager.settings;
    const rgbAs24BitMode = settings.rgbAs24BitGrayscale && channels === 3;
    const normalizedFloatMode = settings.normalizedFloatMode;
    const idx = y * width + x;
    if (rgbAs24BitMode) {
      const baseIdx = idx * 3;
      if (baseIdx >= 0 && baseIdx + 2 < data.length) {
        const r = Math.round(Math.max(0, Math.min(255, data[baseIdx])));
        const g = Math.round(Math.max(0, Math.min(255, data[baseIdx + 1])));
        const b = Math.round(Math.max(0, Math.min(255, data[baseIdx + 2])));
        const combined24bit = r << 16 | g << 8 | b;
        const scaleFactor = settings.scale24BitFactor || 1e3;
        const scaledValue = (combined24bit / scaleFactor).toFixed(3);
        return scaledValue;
      }
    } else if (channels === 3) {
      const baseIdx = idx * 3;
      if (baseIdx >= 0 && baseIdx + 2 < data.length) {
        const r = data[baseIdx];
        const g = data[baseIdx + 1];
        const b = data[baseIdx + 2];
        return `${r} ${g} ${b}`;
      }
    } else {
      if (idx >= 0 && idx < data.length) {
        const value = data[idx];
        if (normalizedFloatMode) {
          const normalized = value / maxval;
          return normalized.toPrecision(4);
        }
        return value.toString();
      }
    }
    return "";
  }
  _flipImageVertically(data, width, height) {
    const flipped = new data.constructor(data.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcIdx = y * width + x;
        const dstIdx = (height - 1 - y) * width + x;
        flipped[dstIdx] = data[srcIdx];
      }
    }
    return flipped;
  }
  /**
   * Send format info to VS Code
   * @param {number} width - Image width
   * @param {number} height - Image height
   * @param {number} channels - Number of channels
   * @param {string} formatLabel - Format label
   * @param {number} maxval - Maximum value
   */
  _postFormatInfo(width, height, channels, formatLabel, maxval) {
    if (!this.vscode) return;
    this.vscode.postMessage({
      type: "formatInfo",
      value: {
        width,
        height,
        compression: "None",
        predictor: 1,
        photometricInterpretation: channels === 3 ? 2 : 1,
        planarConfig: 1,
        samplesPerPixel: channels,
        bitsPerSample: maxval > 255 ? 16 : 8,
        sampleFormat: 1,
        // Unsigned integer
        formatLabel,
        maxval,
        formatType: "ppm",
        // For per-format settings
        isInitialLoad: this._isInitialLoad
        // Signal that this is the first load
      }
    });
  }
  /**
   * Perform the initial render if it was deferred
   * Called when format-specific settings have been applied
   * @returns {ImageData|null} - The rendered image data, or null if no pending render
   */
  /**
   * Perform deferred rendering using stored data and current settings
   * @returns {ImageData|null} Rendered image data or null
   */
  performDeferredRender() {
    if (!this._pendingRenderData) {
      return null;
    }
    const { displayData, width, height, maxval, channels } = this._pendingRenderData;
    this._pendingRenderData = null;
    this._isInitialLoad = false;
    const imageData = this._toImageDataWithNormalization(displayData, width, height, maxval, channels);
    this.vscode.postMessage({ type: "refresh-status" });
    return imageData;
  }
};

// media/modules/png-processor.js
var PngProcessor = class {
  /**
   * @param {any} settingsManager
   * @param {any} vscode
   */
  constructor(settingsManager, vscode) {
    this.settingsManager = settingsManager;
    this.vscode = vscode;
    this._lastRaw = null;
    this._pendingRenderData = null;
    this._isInitialLoad = true;
    this._cachedStats = void 0;
  }
  /**
   * Process PNG/JPEG file - uses native API for 8-bit PNGs and all JPEGs, UPNG for 16-bit PNGs
   * Note: JPEG handling is included here since JPEGs are always 8-bit and use the same native Image API path
   * @param {string} src - Source URI
   * @returns {Promise<{canvas: HTMLCanvasElement, imageData: ImageData}>}
   */
  async processPng(src) {
    const isJpeg = src.toLowerCase().includes(".jpg") || src.toLowerCase().includes(".jpeg");
    if (isJpeg) {
      return this._processWithNativeAPI(src);
    }
    try {
      this._cachedStats = void 0;
      const response = await fetch(src);
      const arrayBuffer = await response.arrayBuffer();
      const bitDepth = this._detectPngBitDepth(arrayBuffer);
      if (bitDepth === 8 || bitDepth === null) {
        return this._processWithNativeAPI(src);
      }
      const png = UPNG.decode(arrayBuffer);
      const width = png.width;
      const height = png.height;
      let pngBitDepth = png.depth;
      const colorType = png.ctype;
      let channels;
      switch (colorType) {
        case 0:
          channels = 1;
          break;
        // Grayscale
        case 2:
          channels = 3;
          break;
        // RGB
        case 3:
          channels = 3;
          break;
        // Palette → RGB
        case 4:
          channels = 2;
          break;
        // Gray + Alpha
        case 6:
          channels = 4;
          break;
        // RGBA
        default:
          channels = 3;
      }
      let rawData;
      if (colorType === 3) {
        const rgba = UPNG.toRGBA8(png);
        rawData = new Uint8Array(rgba[0]);
        channels = 4;
        pngBitDepth = 8;
      } else {
        if (pngBitDepth === 16) {
          const uint8Data = new Uint8Array(png.data);
          const uint16Data = new Uint16Array(uint8Data.length / 2);
          for (let i = 0; i < uint16Data.length; i++) {
            const byteIdx = i * 2;
            const highByte = uint8Data[byteIdx];
            const lowByte = uint8Data[byteIdx + 1];
            uint16Data[i] = highByte << 8 | lowByte;
          }
          rawData = uint16Data;
        } else {
          rawData = new Uint8Array(png.data);
        }
      }
      this._lastRaw = {
        width,
        height,
        data: rawData,
        channels,
        bitDepth: pngBitDepth,
        maxValue: pngBitDepth === 16 ? 65535 : 255,
        isRgbaFormat: false
        // UPNG path stores raw channel format
      };
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      if (this._isInitialLoad) {
        this._postFormatInfo(width, height, channels, bitDepth, "PNG");
        this._pendingRenderData = true;
        const placeholderImageData = new ImageData(width, height);
        return { canvas, imageData: placeholderImageData };
      }
      this._postFormatInfo(width, height, channels, pngBitDepth, "PNG");
      const imageData = this._renderToImageData();
      this.vscode.postMessage({ type: "refresh-status" });
      return { canvas, imageData };
    } catch (error) {
      console.error("UPNG.js processing failed, falling back to browser Image API:", error);
      return this._processWithNativeAPI(src);
    }
  }
  /**
   * Process image using native browser Image API (for 8-bit PNGs and JPEGs)
   * @param {string} src - Source URI
   * @returns {Promise<{canvas: HTMLCanvasElement, imageData: ImageData}>}
   */
  async _processWithNativeAPI(src) {
    const image = new Image();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("Could not get canvas context");
    }
    return new Promise((resolve, reject) => {
      image.onload = () => {
        try {
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          ctx.drawImage(image, 0, 0);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const rawData = imageData.data;
          let hasAlpha = false;
          for (let i = 3; i < rawData.length; i += 4) {
            if (rawData[i] < 255) {
              hasAlpha = true;
              break;
            }
          }
          this._lastRaw = {
            width: canvas.width,
            height: canvas.height,
            data: rawData,
            channels: 4,
            // Native API always returns RGBA (4 channels)
            bitDepth: 8,
            maxValue: 255,
            isRgbaFormat: true,
            // Fallback path stores RGBA format from getImageData
            originalImageData: imageData
            // Store for zero-copy fast path
          };
          const format = src.toLowerCase().includes(".png") ? "PNG" : src.toLowerCase().includes(".jpg") || src.toLowerCase().includes(".jpeg") ? "JPEG" : "Image";
          this._postFormatInfo(canvas.width, canvas.height, this._lastRaw.channels, 8, format);
          this._pendingRenderData = true;
          const placeholderImageData = new ImageData(canvas.width, canvas.height);
          resolve({ canvas, imageData: placeholderImageData });
        } catch (error) {
          reject(error);
        }
      };
      image.onerror = () => {
        reject(new Error("Failed to load image"));
      };
      image.src = src;
    });
  }
  /**
   * Render raw image data to ImageData with gamma/brightness corrections
   * @returns {ImageData}
   */
  _renderToImageData() {
    if (!this._lastRaw) return new ImageData(1, 1);
    const { width, height, data, channels, bitDepth, maxValue, originalImageData } = this._lastRaw;
    const settings = this.settingsManager.settings;
    const isFloat = false;
    const isIdentity = NormalizationHelper.isIdentityTransformation(settings);
    const isGammaMode = settings.normalization?.gammaMode || false;
    const rgbAs24BitMode = settings.rgbAs24BitGrayscale && channels >= 3;
    if (originalImageData && isGammaMode && isIdentity && !rgbAs24BitMode && bitDepth === 8) {
      return originalImageData;
    }
    let stats = this._cachedStats;
    if (!stats && !isGammaMode) {
      stats = ImageStatsCalculator.calculateIntegerStats(data, width, height, channels);
      this._cachedStats = stats;
    }
    if (isGammaMode && !stats) {
      stats = { min: 0, max: maxValue };
    }
    const options = {
      rgbAs24BitGrayscale: settings.rgbAs24BitGrayscale && channels >= 3,
      typeMax: maxValue
    };
    return ImageRenderer.render(
      data,
      width,
      height,
      channels,
      isFloat,
      stats,
      settings,
      options
    );
  }
  /**
   * Fallback gamma rendering for browser Image API path
   * Re-render PNG with current settings (for real-time updates)
   * @returns {ImageData | null}
   */
  renderPngWithSettings() {
    if (!this._lastRaw) return null;
    return this._renderToImageData();
  }
  /**
   * Get color value at specific pixel coordinates
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @param {number} naturalWidth - Image width
   * @param {number} naturalHeight - Image height
   * @returns {string} Formatted color string
   */
  getColorAtPixel(x, y, naturalWidth, naturalHeight) {
    if (!this._lastRaw) return "";
    const { width, height, data, channels, bitDepth, maxValue } = this._lastRaw;
    if (width !== naturalWidth || height !== naturalHeight) return "";
    const pixelIdx = y * width + x;
    const dataIdx = pixelIdx * channels;
    const settings = this.settingsManager.settings;
    if (dataIdx >= 0 && dataIdx < data.length) {
      if (channels === 1) {
        const value = data[dataIdx];
        if (settings.normalizedFloatMode) {
          const normalized = value / maxValue;
          return normalized.toPrecision(4);
        }
        return value.toString();
      } else if (channels === 2) {
        const maxVal = bitDepth === 16 ? 65535 : 255;
        const gray = data[dataIdx];
        const alpha = data[dataIdx + 1];
        return `${gray} \u03B1:${(alpha / maxVal).toFixed(2)}`;
      } else if (channels === 3 || channels === 4) {
        const r = data[dataIdx];
        const g = data[dataIdx + 1];
        const b = data[dataIdx + 2];
        if (settings.rgbAs24BitGrayscale && channels >= 3) {
          const rByte = bitDepth === 16 ? Math.round(r / 257) : r;
          const gByte = bitDepth === 16 ? Math.round(g / 257) : g;
          const bByte = bitDepth === 16 ? Math.round(b / 257) : b;
          const combined24bit = rByte << 16 | gByte << 8 | bByte;
          const scaleFactor = settings.scale24BitFactor || 1e3;
          const scaledValue = (combined24bit / scaleFactor).toFixed(3);
          if (channels === 4) {
            const maxVal = bitDepth === 16 ? 65535 : 255;
            const a = data[dataIdx + 3];
            return `${scaledValue} \u03B1:${(a / maxVal).toFixed(2)}`;
          } else {
            return scaledValue;
          }
        }
        if (channels === 3) {
          if (bitDepth === 16) {
            return `${r} ${g} ${b}`;
          } else {
            return `${r.toString().padStart(3, "0")} ${g.toString().padStart(3, "0")} ${b.toString().padStart(3, "0")}`;
          }
        } else {
          const maxVal = bitDepth === 16 ? 65535 : 255;
          const a = data[dataIdx + 3];
          if (bitDepth === 16) {
            return `${r} ${g} ${b} \u03B1:${(a / maxVal).toFixed(2)}`;
          } else {
            return `${r.toString().padStart(3, "0")} ${g.toString().padStart(3, "0")} ${b.toString().padStart(3, "0")} \u03B1:${(a / maxVal).toFixed(2)}`;
          }
        }
      }
    }
    return "";
  }
  /**
   * Post format information to VS Code
   * @param {number} width
   * @param {number} height
   * @param {number} channels
   * @param {number} bitDepth
   * @param {string} formatLabel
   */
  _postFormatInfo(width, height, channels, bitDepth, formatLabel) {
    if (!this.vscode) return;
    const formatType = formatLabel === "JPEG" ? "jpg" : "png";
    this.vscode.postMessage({
      type: "formatInfo",
      value: {
        width,
        height,
        compression: "Deflate",
        predictor: 1,
        photometricInterpretation: channels >= 3 ? 2 : 1,
        planarConfig: 1,
        samplesPerPixel: channels,
        bitsPerSample: bitDepth,
        sampleFormat: 1,
        // Unsigned integer
        formatLabel: `${formatLabel} (${bitDepth}-bit)`,
        formatType,
        // 'png' or 'jpg' for independent settings
        isInitialLoad: this._isInitialLoad
        // Signal that this is the first load
      }
    });
  }
  /**
   * Perform the initial render if it was deferred
   * Called when format-specific settings have been applied
   * @returns {ImageData|null} - The rendered image data, or null if no pending render
   */
  performDeferredRender() {
    if (!this._pendingRenderData || !this._lastRaw) {
      return null;
    }
    this._pendingRenderData = null;
    this._isInitialLoad = false;
    const imageData = this._renderToImageData();
    this.vscode.postMessage({ type: "refresh-status" });
    return imageData;
  }
  /**
   * Detect PNG bit depth by reading the IHDR chunk
   * @param {ArrayBuffer} arrayBuffer - PNG file data
   * @returns {number|null} - Bit depth (1, 2, 4, 8, or 16), or null if detection fails
   */
  _detectPngBitDepth(arrayBuffer) {
    try {
      const data = new Uint8Array(arrayBuffer);
      if (data.length < 8 || data[0] !== 137 || data[1] !== 80 || data[2] !== 78 || data[3] !== 71) {
        console.warn("PNG: Invalid PNG signature");
        return null;
      }
      const bitDepth = data[24];
      return bitDepth;
    } catch (error) {
      console.error("PNG: Failed to detect bit depth:", error);
      return null;
    }
  }
};

// media/modules/zoom-controller.js
var ZoomController = class {
  constructor(settingsManager, vscode) {
    this.settingsManager = settingsManager;
    this.vscode = vscode;
    const initialState = vscode.getState() || { scale: "fit", offsetX: 0, offsetY: 0 };
    this.scale = initialState.scale;
    this.initialState = initialState;
    this.container = document.body;
    this.imageElement = null;
    this.canvas = null;
    this.hasLoadedImage = false;
  }
  /**
   * Set the image element reference
   * @param {HTMLElement} element
   */
  setImageElement(element) {
    this.imageElement = element;
  }
  /**
   * Set the canvas reference
   * @param {HTMLCanvasElement} canvas
   */
  setCanvas(canvas) {
    this.canvas = canvas;
  }
  /**
   * Mark that image has been loaded
   */
  setImageLoaded() {
    this.hasLoadedImage = true;
  }
  /**
   * Update scale with new value
   * @param {number|string} newScale
   */
  updateScale(newScale) {
    if (!this.imageElement || !this.hasLoadedImage || !this.imageElement.parentElement) {
      return;
    }
    const constants = this.settingsManager.constants;
    const wasInFitMode = this.scale === "fit";
    if (newScale === "fit") {
      this.scale = "fit";
      this.imageElement.classList.add("scale-to-fit");
      this.imageElement.classList.remove("pixelated");
      this.imageElement.style.transform = "";
      this.imageElement.style.transformOrigin = "";
      this.imageElement.style.width = "";
      this.imageElement.style.height = "";
      this.imageElement.style.margin = "";
      this.vscode.setState(void 0);
    } else {
      const oldScale = this.scale;
      this.scale = this._clamp(newScale, constants.MIN_SCALE, constants.MAX_SCALE);
      if (this.scale >= constants.PIXELATION_THRESHOLD) {
        this.imageElement.classList.add("pixelated");
      } else {
        this.imageElement.classList.remove("pixelated");
      }
      const canvas = (
        /** @type {HTMLCanvasElement} */
        this.imageElement
      );
      const naturalWidth = canvas.width;
      const naturalHeight = canvas.height;
      const prevScale = wasInFitMode ? canvas.clientWidth / naturalWidth : (
        /** @type {number} */
        oldScale
      );
      const viewportCenterX = window.scrollX + this.container.clientWidth / 2;
      const viewportCenterY = window.scrollY + this.container.clientHeight / 2;
      const rectBefore = this.imageElement.getBoundingClientRect();
      const elemLeftDoc = window.scrollX + rectBefore.left;
      const elemTopDoc = window.scrollY + rectBefore.top;
      const centerXImage = (viewportCenterX - elemLeftDoc) / prevScale;
      const centerYImage = (viewportCenterY - elemTopDoc) / prevScale;
      this.imageElement.classList.remove("scale-to-fit");
      this.imageElement.style.transform = "";
      this.imageElement.style.transformOrigin = "";
      this.imageElement.style.width = `${naturalWidth * this.scale}px`;
      this.imageElement.style.height = `${naturalHeight * this.scale}px`;
      const canScrollX = this.container.scrollWidth > this.container.clientWidth + 1;
      const canScrollY = this.container.scrollHeight > this.container.clientHeight + 1;
      this.imageElement.style.marginLeft = canScrollX ? "0" : "auto";
      this.imageElement.style.marginRight = canScrollX ? "0" : "auto";
      this.imageElement.style.marginTop = canScrollY ? "0" : "auto";
      this.imageElement.style.marginBottom = canScrollY ? "0" : "auto";
      const rectAfter = this.imageElement.getBoundingClientRect();
      const elemLeftDocAfter = window.scrollX + rectAfter.left;
      const elemTopDocAfter = window.scrollY + rectAfter.top;
      let newScrollX = centerXImage * this.scale + elemLeftDocAfter - this.container.clientWidth / 2;
      let newScrollY = centerYImage * this.scale + elemTopDocAfter - this.container.clientHeight / 2;
      const maxScrollX = Math.max(0, this.container.scrollWidth - this.container.clientWidth);
      const maxScrollY = Math.max(0, this.container.scrollHeight - this.container.clientHeight);
      newScrollX = Math.min(Math.max(0, newScrollX), maxScrollX);
      newScrollY = Math.min(Math.max(0, newScrollY), maxScrollY);
      window.scrollTo(newScrollX, newScrollY);
      this.vscode.setState({ scale: this.scale, offsetX: newScrollX, offsetY: newScrollY });
    }
    this.vscode.postMessage({
      type: "zoom",
      value: this.scale
    });
  }
  /**
   * Zoom in to next level
   */
  zoomIn() {
    if (!this.imageElement || !this.hasLoadedImage) {
      return;
    }
    if (this.scale === "fit") {
      this.firstZoom();
    }
    const zoomLevels = this.settingsManager.constants.ZOOM_LEVELS;
    let i = 0;
    for (; i < zoomLevels.length; ++i) {
      if (zoomLevels[i] > this.scale) {
        break;
      }
    }
    this.updateScale(zoomLevels[i] || this.settingsManager.constants.MAX_SCALE);
  }
  /**
   * Zoom out to previous level
   */
  zoomOut() {
    if (!this.imageElement || !this.hasLoadedImage) {
      return;
    }
    if (this.scale === "fit") {
      this.firstZoom();
    }
    const zoomLevels = this.settingsManager.constants.ZOOM_LEVELS;
    let i = zoomLevels.length - 1;
    for (; i >= 0; --i) {
      if (zoomLevels[i] < this.scale) {
        break;
      }
    }
    this.updateScale(zoomLevels[i] || this.settingsManager.constants.MIN_SCALE);
  }
  /**
   * Calculate first zoom level based on current display size
   */
  firstZoom() {
    if (!this.imageElement || !this.hasLoadedImage) {
      return;
    }
    const canvas = (
      /** @type {HTMLCanvasElement} */
      this.imageElement
    );
    this.scale = canvas.clientWidth / canvas.width;
    this.updateScale(this.scale);
  }
  /**
   * Reset zoom to fit
   */
  resetZoom() {
    this.updateScale("fit");
  }
  /**
   * Handle mouse wheel events for zooming
   * @param {WheelEvent} e
   * @param {boolean} ctrlPressed
   * @param {boolean} altPressed
   */
  handleWheelZoom(e, ctrlPressed, altPressed) {
    if (!this.imageElement || !this.hasLoadedImage) {
      return;
    }
    const isScrollWheelKeyPressed = this.settingsManager.isMac ? altPressed : ctrlPressed;
    if (!isScrollWheelKeyPressed && !e.ctrlKey) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (this.scale === "fit") {
      this.firstZoom();
    }
    const delta = e.deltaY > 0 ? 1 : -1;
    this.updateScale(this.scale * (1 - delta * this.settingsManager.constants.SCALE_PINCH_FACTOR));
  }
  /**
   * Apply initial zoom and scroll position
   */
  applyInitialZoom() {
    this.updateScale(this.scale);
    if (this.initialState.scale !== "fit") {
      window.scrollTo(this.initialState.offsetX, this.initialState.offsetY);
    }
  }
  /**
   * Save current state
   */
  saveState() {
    const entry = this.vscode.getState();
    if (entry) {
      this.vscode.setState(entry);
    }
  }
  /**
   * Get current zoom state for image switching
   */
  getCurrentState() {
    return {
      scale: this.scale,
      x: window.scrollX,
      y: window.scrollY
    };
  }
  /**
   * Restore zoom state after image switching
   */
  restoreState(state) {
    if (state && state.scale !== void 0) {
      this.updateScale(state.scale);
      if (state.x !== void 0 && state.y !== void 0) {
        setTimeout(() => {
          window.scrollTo(state.x, state.y);
        }, 50);
      }
    }
  }
  /**
   * Clamp a value between min and max
   * @private
   */
  _clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
};

// media/modules/mouse-handler.js
var MouseHandler = class {
  constructor(settingsManager, vscode, tiffProcessor) {
    this.settingsManager = settingsManager;
    this.vscode = vscode;
    this.tiffProcessor = tiffProcessor;
    this.exrProcessor = null;
    this.npyProcessor = null;
    this.pfmProcessor = null;
    this.ppmProcessor = null;
    this.pngProcessor = null;
    this.ctrlPressed = false;
    this.altPressed = false;
    this.isActive = false;
    this.consumeClick = true;
    this.container = document.body;
    this.imageElement = null;
    this._setupKeyboardListeners();
  }
  /**
   * Set the image element reference
   * @param {HTMLElement} element
   */
  setImageElement(element) {
    this.imageElement = element;
  }
  setExrProcessor(proc) {
    this.exrProcessor = proc;
  }
  setNpyProcessor(proc) {
    this.npyProcessor = proc;
  }
  setPfmProcessor(proc) {
    this.pfmProcessor = proc;
  }
  setPpmProcessor(proc) {
    this.ppmProcessor = proc;
  }
  setPngProcessor(proc) {
    this.pngProcessor = proc;
  }
  /**
   * Set active state
   * @param {boolean} value
   */
  setActive(value) {
    this.isActive = value;
    if (value) {
      if (this.settingsManager.isMac ? this.altPressed : this.ctrlPressed) {
        this.container.classList.remove("zoom-in");
        this.container.classList.add("zoom-out");
      } else {
        this.container.classList.remove("zoom-out");
        this.container.classList.add("zoom-in");
      }
    } else {
      this.ctrlPressed = false;
      this.altPressed = false;
      this.container.classList.remove("zoom-out");
      this.container.classList.remove("zoom-in");
    }
  }
  /**
   * Add mouse listeners to an element
   * @param {HTMLElement} element
   */
  addMouseListeners(element) {
    element.addEventListener("mouseenter", (e) => this._handleMouseEnter(e));
    element.addEventListener("mousemove", (e) => this._handleMouseMove(e));
    element.addEventListener("mouseleave", (e) => this._handleMouseLeave(e));
  }
  /**
   * Handle mouse enter event
   * @private
   */
  _handleMouseEnter(e) {
    if (!this.imageElement) return;
    const pixelInfo = this._getPixelInfo(e);
    if (pixelInfo) {
      this.vscode.postMessage({ type: "pixelFocus", value: pixelInfo });
    } else {
      this.vscode.postMessage({ type: "pixelBlur" });
    }
  }
  /**
   * Handle mouse move event
   * @private
   */
  _handleMouseMove(e) {
    if (!this.imageElement) return;
    const pixelInfo = this._getPixelInfo(e);
    if (pixelInfo) {
      this.vscode.postMessage({ type: "pixelFocus", value: pixelInfo });
    } else {
      this.vscode.postMessage({ type: "pixelBlur" });
    }
  }
  /**
   * Handle mouse leave event
   * @private
   */
  _handleMouseLeave(e) {
    this.vscode.postMessage({
      type: "pixelBlur"
    });
  }
  /**
   * Get pixel information at mouse position
   * @private
   */
  _getPixelInfo(e) {
    if (!this.imageElement) return "";
    const rect = this.imageElement.getBoundingClientRect();
    const canvas = (
      /** @type {HTMLCanvasElement} */
      this.imageElement
    );
    const naturalWidth = canvas.width;
    const naturalHeight = canvas.height;
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom || rect.width <= 0 || rect.height <= 0) {
      return "";
    }
    const ratioX = (e.clientX - rect.left) / rect.width;
    const ratioY = (e.clientY - rect.top) / rect.height;
    let x = Math.floor(ratioX * naturalWidth);
    let y = Math.floor(ratioY * naturalHeight);
    x = Math.min(Math.max(0, x), Math.max(0, naturalWidth - 1));
    y = Math.min(Math.max(0, y), Math.max(0, naturalHeight - 1));
    const color = this._getColorAtPixel(x, y, naturalWidth, naturalHeight);
    return `${x}x${y} ${color}`;
  }
  /**
   * Apply gamma and brightness transformations to a pixel value
   * The correct order is: remove input gamma → apply exposure in linear space → apply output gamma
   * @private
   * @param {number} value - Normalized pixel value (0-1)
   * @returns {number} - Transformed value
   */
  _applyGammaBrightness(value) {
    const gamma = this.settingsManager.settings.gamma || { in: 1, out: 1 };
    const brightness = this.settingsManager.settings.brightness || { offset: 0 };
    let linear = Math.pow(value, gamma.in);
    const exposureStops = brightness.offset;
    linear = linear * Math.pow(2, exposureStops);
    let corrected = Math.pow(Math.max(0, linear), 1 / gamma.out);
    return corrected;
  }
  /**
   * Get color at specific pixel coordinates
   * @private
   */
  _getColorAtPixel(x, y, naturalWidth, naturalHeight) {
    const showModified = this.settingsManager.settings.colorPickerShowModified || false;
    if (this.tiffProcessor) {
      const tiffColor = this.tiffProcessor.getColorAtPixel(x, y, naturalWidth, naturalHeight);
      if (tiffColor) {
        if (showModified) {
          const values = this._parseTiffColor(tiffColor);
          if (values) {
            const transformed = values.map((v) => this._applyGammaBrightness(v));
            return this._formatColorValues(transformed, values.length);
          }
        }
        return tiffColor;
      }
    }
    if (this.exrProcessor && this.exrProcessor.rawExrData) {
      const pixelValues = this.exrProcessor.getPixelValue(x, y);
      if (pixelValues) {
        if (showModified) {
          const transformed = [];
          for (let i = 0; i < pixelValues.length; i++) {
            const v = pixelValues[i];
            if (isNaN(v) || !isFinite(v)) {
              transformed.push(v);
            } else if (i === 3 && pixelValues.length === 4) {
              transformed.push(v);
            } else {
              transformed.push(this._applyGammaBrightness(v));
            }
          }
          if (transformed.length === 1) {
            return transformed[0].toFixed(6);
          } else if (transformed.length === 3) {
            return `${transformed[0].toFixed(6)} ${transformed[1].toFixed(6)} ${transformed[2].toFixed(6)}`;
          } else if (transformed.length === 4) {
            return `${transformed[0].toFixed(6)} ${transformed[1].toFixed(6)} ${transformed[2].toFixed(6)} \u03B1:${transformed[3].toFixed(6)}`;
          }
        } else {
          if (pixelValues.length === 1) {
            return pixelValues[0].toFixed(6);
          } else if (pixelValues.length === 3) {
            return `${pixelValues[0].toFixed(6)} ${pixelValues[1].toFixed(6)} ${pixelValues[2].toFixed(6)}`;
          } else if (pixelValues.length === 4) {
            return `${pixelValues[0].toFixed(6)} ${pixelValues[1].toFixed(6)} ${pixelValues[2].toFixed(6)} \u03B1:${pixelValues[3].toFixed(6)}`;
          }
        }
      }
    }
    if (this.npyProcessor) {
      const v = this.npyProcessor.getColorAtPixel(x, y, naturalWidth, naturalHeight);
      if (v) {
        if (showModified) {
          const values = this._parseFloatColor(v);
          if (values) {
            const transformed = values.map((val) => this._applyGammaBrightness(val));
            return this._formatColorValues(transformed, values.length);
          }
        }
        return v;
      }
    }
    if (this.pfmProcessor) {
      const v = this.pfmProcessor.getColorAtPixel(x, y, naturalWidth, naturalHeight);
      if (v) {
        if (showModified) {
          const values = this._parseFloatColor(v);
          if (values) {
            const transformed = values.map((val) => this._applyGammaBrightness(val));
            return this._formatColorValues(transformed, values.length);
          }
        }
        return v;
      }
    }
    if (this.ppmProcessor) {
      const v = this.ppmProcessor.getColorAtPixel(x, y, naturalWidth, naturalHeight);
      if (v) {
        if (showModified) {
          const values = this._parseIntColor(v);
          if (values) {
            const normalized = values.map((val) => val / 255);
            const transformed = normalized.map((val) => this._applyGammaBrightness(val));
            const scaled = transformed.map((val) => Math.round(Math.max(0, Math.min(1, val)) * 255));
            return this._formatColorValues(scaled, values.length, true);
          }
        }
        return v;
      }
    }
    if (this.pngProcessor) {
      const v = this.pngProcessor.getColorAtPixel(x, y, naturalWidth, naturalHeight);
      if (v) {
        if (showModified) {
          const values = this._parseIntColor(v);
          if (values) {
            const normalized = values.map((val) => val / 255);
            const transformed = normalized.map((val) => this._applyGammaBrightness(val));
            const scaled = transformed.map((val) => Math.round(Math.max(0, Math.min(1, val)) * 255));
            return this._formatColorValues(scaled, values.length, true);
          }
        }
        return v;
      }
    }
    if (this.imageElement) {
      const canvas = (
        /** @type {HTMLCanvasElement} */
        this.imageElement
      );
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        const pixel = ctx.getImageData(x, y, 1, 1).data;
        if (showModified) {
          const normalized = Array.from(pixel.slice(0, 3)).map((v) => v / 255);
          const transformed = normalized.map((val) => this._applyGammaBrightness(val));
          const scaled = transformed.map((val) => Math.round(Math.max(0, Math.min(1, val)) * 255));
          return `${scaled[0].toString().padStart(3, "0")} ${scaled[1].toString().padStart(3, "0")} ${scaled[2].toString().padStart(3, "0")}`;
        }
        return `${pixel[0].toString().padStart(3, "0")} ${pixel[1].toString().padStart(3, "0")} ${pixel[2].toString().padStart(3, "0")}`;
      }
    }
    return "";
  }
  /**
   * Parse TIFF color string to array of values
   * @private
   * @param {string} colorStr - Color string from TIFF processor
   * @returns {Array<number>|null} - Array of numeric values or null
   */
  _parseTiffColor(colorStr) {
    try {
      const parts = colorStr.trim().split(/\s+/);
      const values = parts.map((p) => {
        const num = parseFloat(p);
        return isNaN(num) ? null : num;
      });
      return values.every((v) => v !== null) ? values : null;
    } catch (e) {
      return null;
    }
  }
  /**
   * Parse float color string to array of values (space-separated floats or NaN/Inf)
   * Handles formats like: "1.234 2.345 3.456" or "1.234 2.345 3.456 A:4.567" or "NaN Inf -Inf"
   * @private
   * @param {string} colorStr - Color string
   * @returns {Array<number>|null} - Array of numeric values or null
   */
  _parseFloatColor(colorStr) {
    try {
      const parts = colorStr.trim().split(/\s+/);
      const values = parts.map((p) => {
        const cleanPart = p.replace("A:", "");
        if (cleanPart === "NaN") return NaN;
        if (cleanPart === "Inf") return Infinity;
        if (cleanPart === "-Inf") return -Infinity;
        const num = parseFloat(cleanPart);
        return isNaN(num) && cleanPart !== "NaN" ? null : num;
      });
      return values.every((v) => v !== null) ? values : null;
    } catch (e) {
      return null;
    }
  }
  /**
   * Parse integer color string to array of values (0-255)
   * @private
   * @param {string} colorStr - Color string like "255 128 64"
   * @returns {Array<number>|null} - Array of numeric values or null
   */
  _parseIntColor(colorStr) {
    try {
      const parts = colorStr.trim().split(/\s+/);
      const values = parts.map((p) => {
        const num = parseInt(p, 10);
        return isNaN(num) ? null : num;
      });
      return values.every((v) => v !== null) ? values : null;
    } catch (e) {
      return null;
    }
  }
  /**
   * Format color values back to string
   * Handles both integer and float formats consistently
   * @private
   * @param {Array<number>} values - Color values
   * @param {number} count - Number of values (for formatting)
   * @param {boolean} [asIntegers] - If true, format as padded integers
   * @returns {string} - Formatted color string
   */
  _formatColorValues(values, count, asIntegers = false) {
    const formatted = values.slice(0, count).map((v, idx) => {
      if (asIntegers) {
        return Math.round(v).toString().padStart(3, "0");
      } else {
        return v.toFixed(6);
      }
    });
    if (count === 4) {
      return `${formatted[0]} ${formatted[1]} ${formatted[2]} \u03B1:${formatted[3]}`;
    }
    return formatted.join(" ");
  }
  /**
   * Setup keyboard event listeners
   * @private
   */
  _setupKeyboardListeners() {
    window.addEventListener("keydown", (e) => this._handleKeyDown(e));
    window.addEventListener("keyup", (e) => this._handleKeyUp(e));
    window.addEventListener("blur", () => this._handleBlur());
  }
  /**
   * Handle key down events
   * @private
   */
  _handleKeyDown(e) {
    if (!this.imageElement) return;
    if (e.key === "Control") {
      this.ctrlPressed = true;
    } else if (e.key === "Alt") {
      this.altPressed = true;
    }
    this._updateCursorState();
  }
  /**
   * Handle key up events
   * @private
   */
  _handleKeyUp(e) {
    if (!this.imageElement) return;
    if (e.key === "Control") {
      this.ctrlPressed = false;
    } else if (e.key === "Alt") {
      this.altPressed = false;
    }
    this._updateCursorState();
  }
  /**
   * Handle window blur (lost focus)
   * @private
   */
  _handleBlur() {
    this.ctrlPressed = false;
    this.altPressed = false;
    this._updateCursorState();
  }
  /**
   * Update cursor state based on key presses
   * @private
   */
  _updateCursorState() {
    if (!this.isActive) return;
    if (this.settingsManager.isMac ? this.altPressed : this.ctrlPressed) {
      this.container.classList.remove("zoom-in");
      this.container.classList.add("zoom-out");
    } else {
      this.container.classList.remove("zoom-out");
      this.container.classList.add("zoom-in");
    }
  }
  /**
   * Get current keyboard state
   */
  getKeyboardState() {
    return {
      ctrlPressed: this.ctrlPressed,
      altPressed: this.altPressed
    };
  }
};

// media/modules/histogram-overlay.js
var HistogramOverlay = class {
  constructor(settingsManager, vscode) {
    this.settingsManager = settingsManager;
    this.vscode = vscode;
    this.overlay = null;
    this.canvas = null;
    this.ctx = null;
    this.isVisible = false;
    this.histogramData = null;
    this.scaleMode = "linear";
    this.channelMode = "combined";
    this.numBins = 256;
    this.isDragging = false;
    this.dragOffset = { x: 0, y: 0 };
    this.hoveredBin = -1;
    this.createOverlay();
  }
  /**
   * Create the histogram overlay DOM structure
   */
  createOverlay() {
    this.overlay = document.createElement("div");
    this.overlay.className = "histogram-overlay";
    this.overlay.style.display = "none";
    const header = document.createElement("div");
    header.className = "histogram-header";
    const title = document.createElement("div");
    title.className = "histogram-title";
    title.textContent = "Histogram";
    const scaleToggle = document.createElement("button");
    scaleToggle.className = "histogram-button";
    scaleToggle.textContent = "Linear Mode";
    scaleToggle.title = "Toggle Linear/Log scale";
    scaleToggle.onclick = () => this.toggleScaleMode(scaleToggle);
    const closeBtn = document.createElement("button");
    closeBtn.className = "histogram-close";
    closeBtn.textContent = "\xD7";
    closeBtn.title = "Close histogram";
    closeBtn.onclick = () => this.hide();
    header.appendChild(title);
    header.appendChild(scaleToggle);
    header.appendChild(closeBtn);
    this.canvas = document.createElement("canvas");
    this.canvas.className = "histogram-canvas";
    this.canvas.width = 300;
    this.canvas.height = 150;
    this.ctx = this.canvas.getContext("2d");
    this.canvas.addEventListener("mousemove", (e) => this.handleMouseMove(e));
    this.canvas.addEventListener("mouseleave", () => this.handleMouseLeave());
    const labels = document.createElement("div");
    labels.className = "histogram-labels";
    labels.style.display = "flex";
    labels.style.justifyContent = "space-between";
    labels.style.padding = "0 5px";
    labels.style.fontSize = "10px";
    labels.style.color = "#cccccc";
    labels.style.marginTop = "2px";
    this.minLabel = document.createElement("span");
    this.minLabel.textContent = "0";
    this.maxLabel = document.createElement("span");
    this.maxLabel.textContent = "255";
    labels.appendChild(this.minLabel);
    labels.appendChild(this.maxLabel);
    const stats = document.createElement("div");
    stats.className = "histogram-stats";
    stats.id = "histogram-stats";
    this.tooltip = document.createElement("div");
    this.tooltip.className = "histogram-tooltip";
    this.tooltip.style.position = "absolute";
    this.tooltip.style.display = "none";
    this.tooltip.style.backgroundColor = "rgba(0, 0, 0, 0.8)";
    this.tooltip.style.color = "white";
    this.tooltip.style.padding = "4px 8px";
    this.tooltip.style.borderRadius = "4px";
    this.tooltip.style.fontSize = "11px";
    this.tooltip.style.pointerEvents = "none";
    this.tooltip.style.zIndex = "1000";
    this.overlay.appendChild(header);
    this.overlay.appendChild(this.canvas);
    this.overlay.appendChild(labels);
    this.overlay.appendChild(stats);
    this.overlay.appendChild(this.tooltip);
    header.style.cursor = "move";
    header.onmousedown = (e) => this.startDrag(e);
    document.body.appendChild(this.overlay);
  }
  /**
   * Handle mouse move over canvas
   */
  handleMouseMove(e) {
    if (!this.histogramData) return;
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const x = (e.clientX - rect.left) * scaleX;
    const width = this.canvas.width;
    const padding = 5;
    const graphWidth = width - 2 * padding;
    const binWidth = graphWidth / this.numBins;
    let binIndex = Math.floor((x - padding) / binWidth);
    binIndex = Math.max(0, Math.min(binIndex, this.numBins - 1));
    if (this.hoveredBin !== binIndex) {
      this.hoveredBin = binIndex;
      this.render();
    }
    this.updateTooltip(e.clientX, e.clientY, binIndex);
  }
  /**
   * Handle mouse leave canvas
   */
  handleMouseLeave() {
    this.hoveredBin = -1;
    this.tooltip.style.display = "none";
    this.render();
  }
  /**
   * Update tooltip content and position
   */
  updateTooltip(clientX, clientY, binIndex) {
    if (!this.histogramData || binIndex < 0) return;
    const rCount = this.histogramData.r[binIndex];
    const gCount = this.histogramData.g[binIndex];
    const bCount = this.histogramData.b[binIndex];
    const lumCount = this.histogramData.luminance[binIndex];
    let content = `<strong>Value: ${binIndex}</strong><br>`;
    if (this.channelMode === "combined" || this.channelMode === "separate") {
      content += `<span style="color: #ff8888">R: ${rCount.toLocaleString()}</span><br>`;
      content += `<span style="color: #88ff88">G: ${gCount.toLocaleString()}</span><br>`;
      content += `<span style="color: #8888ff">B: ${bCount.toLocaleString()}</span>`;
    } else {
      content += `Count: ${lumCount.toLocaleString()}`;
    }
    this.tooltip.innerHTML = content;
    this.tooltip.style.display = "block";
    const overlayRect = this.overlay.getBoundingClientRect();
    const tooltipX = clientX - overlayRect.left + 10;
    const tooltipY = clientY - overlayRect.top + 10;
    this.tooltip.style.left = `${tooltipX}px`;
    this.tooltip.style.top = `${tooltipY}px`;
  }
  /**
   * Show the histogram overlay
   */
  show() {
    this.isVisible = true;
    this.overlay.style.display = "flex";
    this.vscode.postMessage({ type: "requestHistogram" });
  }
  /**
   * Hide the histogram overlay
   */
  hide() {
    this.isVisible = false;
    this.overlay.style.display = "none";
    this.vscode.postMessage({ type: "histogramClosed" });
  }
  /**
   * Toggle histogram visibility
   */
  toggle() {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }
  /**
   * Toggle between linear and log scale
   */
  toggleScaleMode(button) {
    this.scaleMode = this.scaleMode === "linear" ? "log" : "linear";
    button.textContent = this.scaleMode === "linear" ? "Linear Mode" : "Log Mode";
    this.render();
  }
  /**
   * Compute histogram from image data
   * @param {ImageData} imageData - Canvas ImageData object
   */
  computeHistogram(imageData) {
    if (!imageData) return null;
    const data = imageData.data;
    const width = imageData.width;
    const height = imageData.height;
    const numPixels = width * height;
    const histR = new Array(this.numBins).fill(0);
    const histG = new Array(this.numBins).fill(0);
    const histB = new Array(this.numBins).fill(0);
    const histLum = new Array(this.numBins).fill(0);
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a === 0) continue;
      histR[r]++;
      histG[g]++;
      histB[b]++;
      const lum = Math.floor(0.299 * r + 0.587 * g + 0.114 * b);
      histLum[lum]++;
    }
    const stats = this.computeStats(data);
    return {
      r: histR,
      g: histG,
      b: histB,
      luminance: histLum,
      stats,
      numPixels
    };
  }
  /**
   * Compute statistics from raw pixel data
   */
  computeStats(data) {
    let minR = 255, maxR = 0, sumR = 0;
    let minG = 255, maxG = 0, sumG = 0;
    let minB = 255, maxB = 0, sumB = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a === 0) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      sumR += r;
      minG = Math.min(minG, g);
      maxG = Math.max(maxG, g);
      sumG += g;
      minB = Math.min(minB, b);
      maxB = Math.max(maxB, b);
      sumB += b;
      count++;
    }
    return {
      r: { min: minR, max: maxR, mean: sumR / count },
      g: { min: minG, max: maxG, mean: sumG / count },
      b: { min: minB, max: maxB, mean: sumB / count }
    };
  }
  /**
   * Update histogram with new data
   */
  update(imageData) {
    this.histogramData = this.computeHistogram(imageData);
    if (this.isVisible) {
      this.render();
    }
  }
  /**
   * Render the histogram to canvas
   */
  render() {
    if (!this.histogramData || !this.ctx) return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const padding = 5;
    const graphHeight = height - 2 * padding;
    const graphWidth = width - 2 * padding;
    this.ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--vscode-editor-background") || "#1e1e1e";
    this.ctx.fillRect(0, 0, width, height);
    let histograms = [];
    let colors = [];
    if (this.channelMode === "combined") {
      histograms = [this.histogramData.r, this.histogramData.g, this.histogramData.b];
      colors = ["rgba(255, 100, 100, 0.5)", "rgba(100, 255, 100, 0.5)", "rgba(100, 100, 255, 0.5)"];
    } else if (this.channelMode === "separate") {
      histograms = [this.histogramData.r, this.histogramData.g, this.histogramData.b];
      colors = ["rgba(255, 50, 50, 0.7)", "rgba(50, 255, 50, 0.7)", "rgba(50, 50, 255, 0.7)"];
    } else {
      histograms = [this.histogramData.luminance];
      colors = ["rgba(200, 200, 200, 0.8)"];
    }
    let maxValue = 0;
    for (const hist of histograms) {
      for (let i = 0; i < hist.length; i++) {
        maxValue = Math.max(maxValue, hist[i]);
      }
    }
    const scaleValue = (val) => {
      if (this.scaleMode === "log") {
        return val > 0 ? Math.log10(val + 1) : 0;
      }
      return val;
    };
    const scaledMax = scaleValue(maxValue);
    const binWidth = graphWidth / this.numBins;
    for (let h = 0; h < histograms.length; h++) {
      const hist = histograms[h];
      const color = colors[h];
      this.ctx.fillStyle = color;
      this.ctx.beginPath();
      for (let i = 0; i < this.numBins; i++) {
        const x = padding + i * binWidth;
        const scaledValue = scaleValue(hist[i]);
        const barHeight = scaledMax > 0 ? scaledValue / scaledMax * graphHeight : 0;
        const y = height - padding - barHeight;
        this.ctx.fillRect(x, y, Math.max(1, binWidth - 0.5), barHeight);
      }
    }
    if (this.hoveredBin >= 0 && this.hoveredBin < this.numBins) {
      const x = padding + this.hoveredBin * binWidth;
      this.ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
      this.ctx.fillRect(x, padding, Math.max(1, binWidth - 0.5), graphHeight);
      this.ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(x + binWidth / 2, padding);
      this.ctx.lineTo(x + binWidth / 2, height - padding);
      this.ctx.stroke();
    }
    this.ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue("--vscode-panel-border") || "#454545";
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(padding, padding, graphWidth, graphHeight);
    this.updateStatsDisplay();
  }
  /**
   * Update statistics display
   */
  updateStatsDisplay() {
    if (!this.histogramData) return;
    const statsEl = document.getElementById("histogram-stats");
    if (!statsEl) return;
    const stats = this.histogramData.stats;
    const isGrayscale = stats.r.min === stats.g.min && stats.g.min === stats.b.min && stats.r.max === stats.g.max && stats.g.max === stats.b.max;
    if (isGrayscale || this.channelMode === "luminance") {
      const s = stats.r;
      statsEl.innerHTML = `
				<span>Min: ${s.min}</span>
				<span>Max: ${s.max}</span>
				<span>Mean: ${s.mean.toFixed(1)}</span>
			`;
    } else {
      statsEl.innerHTML = `
				<span style="color: #ff6666;">R: ${stats.r.min}-${stats.r.max} (${stats.r.mean.toFixed(0)})</span>
				<span style="color: #66ff66;">G: ${stats.g.min}-${stats.g.max} (${stats.g.mean.toFixed(0)})</span>
				<span style="color: #6666ff;">B: ${stats.b.min}-${stats.b.max} (${stats.b.mean.toFixed(0)})</span>
			`;
    }
  }
  /**
   * Start dragging the overlay
   */
  startDrag(e) {
    this.isDragging = true;
    const rect = this.overlay.getBoundingClientRect();
    this.dragOffset = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
    const onMouseMove = (e2) => {
      if (!this.isDragging) return;
      const x = e2.clientX - this.dragOffset.x;
      const y = e2.clientY - this.dragOffset.y;
      const maxX = window.innerWidth - this.overlay.offsetWidth;
      const maxY = window.innerHeight - this.overlay.offsetHeight;
      this.overlay.style.left = Math.max(0, Math.min(x, maxX)) + "px";
      this.overlay.style.top = Math.max(0, Math.min(y, maxY)) + "px";
      this.overlay.style.right = "auto";
      this.overlay.style.bottom = "auto";
    };
    const onMouseUp = () => {
      this.isDragging = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    e.preventDefault();
  }
  /**
   * Get current visibility state
   */
  getVisibility() {
    return this.isVisible;
  }
};

// media/modules/colormap-converter.js
var ColormapConverter = class {
  constructor() {
    this.colormaps = this.initializeColormaps();
  }
  /**
   * Initialize colormap lookup tables
   * Each colormap is an array of 256 [r, g, b] values
   */
  initializeColormaps() {
    return {
      viridis: this.generateViridis(),
      plasma: this.generatePlasma(),
      inferno: this.generateInferno(),
      magma: this.generateMagma(),
      jet: this.generateJet(),
      hot: this.generateHot(),
      cool: this.generateCool(),
      turbo: this.generateTurbo(),
      gray: this.generateGray()
    };
  }
  /**
   * Convert a colormap image to float values
   * @param {ImageData} imageData - The source image data
   * @param {string} colormapName - Name of the colormap to use
   * @param {number} minValue - Minimum value to map to
   * @param {number} maxValue - Maximum value to map to
   * @param {boolean} inverted - Whether to invert the mapping
   * @param {boolean} logarithmic - Whether to use logarithmic mapping
   * @returns {Float32Array} Array of float values
   */
  convertToFloat(imageData, colormapName, minValue, maxValue, inverted = false, logarithmic = false) {
    const colormap = this.colormaps[colormapName];
    if (!colormap) {
      throw new Error(`Unknown colormap: ${colormapName}`);
    }
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;
    const floatData = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const pixelOffset = i * 4;
      const r = data[pixelOffset];
      const g = data[pixelOffset + 1];
      const b = data[pixelOffset + 2];
      let index = this.findClosestColormapIndex(r, g, b, colormap);
      if (inverted) {
        index = 255 - index;
      }
      const normalizedValue = index / 255;
      let finalValue;
      if (logarithmic) {
        const useLogMin = Math.abs(minValue) < 1e-10 ? 1e-10 : Math.abs(minValue);
        const useLogMax = Math.abs(maxValue) < 1e-10 ? 1e-10 : Math.abs(maxValue);
        const logMin = Math.log10(useLogMin);
        const logMax = Math.log10(useLogMax);
        const logValue = logMin + normalizedValue * (logMax - logMin);
        finalValue = Math.pow(10, logValue);
        if (minValue < 0 && maxValue < 0) {
          finalValue = -finalValue;
        } else if (minValue < 0) {
          finalValue = minValue + normalizedValue * (maxValue - minValue);
        }
      } else {
        finalValue = minValue + normalizedValue * (maxValue - minValue);
      }
      floatData[i] = finalValue;
    }
    return floatData;
  }
  /**
   * Find the closest colormap index for a given RGB color
   * @param {number} r - Red value (0-255)
   * @param {number} g - Green value (0-255)
   * @param {number} b - Blue value (0-255)
   * @param {Array} colormap - Colormap lookup table
   * @returns {number} Index of closest color (0-255)
   */
  findClosestColormapIndex(r, g, b, colormap) {
    let minDistance = Infinity;
    let closestIndex = 0;
    for (let i = 0; i < colormap.length; i++) {
      const [cr, cg, cb] = colormap[i];
      const distance = Math.sqrt(
        (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
      );
      if (distance < minDistance) {
        minDistance = distance;
        closestIndex = i;
      }
    }
    return closestIndex;
  }
  // Colormap generation functions
  // Each generates 256 RGB values
  generateGray() {
    const colormap = [];
    for (let i = 0; i < 256; i++) {
      colormap.push([i, i, i]);
    }
    return colormap;
  }
  generateJet() {
    const colormap = [];
    for (let i = 0; i < 256; i++) {
      const value = i / 255;
      let r, g, b;
      if (value < 0.125) {
        r = 0;
        g = 0;
        b = 0.5 + value * 4;
      } else if (value < 0.375) {
        r = 0;
        g = (value - 0.125) * 4;
        b = 1;
      } else if (value < 0.625) {
        r = (value - 0.375) * 4;
        g = 1;
        b = 1 - (value - 0.375) * 4;
      } else if (value < 0.875) {
        r = 1;
        g = 1 - (value - 0.625) * 4;
        b = 0;
      } else {
        r = 1 - (value - 0.875) * 4;
        g = 0;
        b = 0;
      }
      colormap.push([
        Math.round(r * 255),
        Math.round(g * 255),
        Math.round(b * 255)
      ]);
    }
    return colormap;
  }
  generateHot() {
    const colormap = [];
    for (let i = 0; i < 256; i++) {
      const value = i / 255;
      let r, g, b;
      if (value < 0.33) {
        r = value / 0.33;
        g = 0;
        b = 0;
      } else if (value < 0.66) {
        r = 1;
        g = (value - 0.33) / 0.33;
        b = 0;
      } else {
        r = 1;
        g = 1;
        b = (value - 0.66) / 0.34;
      }
      colormap.push([
        Math.round(r * 255),
        Math.round(g * 255),
        Math.round(b * 255)
      ]);
    }
    return colormap;
  }
  generateCool() {
    const colormap = [];
    for (let i = 0; i < 256; i++) {
      const value = i / 255;
      colormap.push([
        Math.round(value * 255),
        Math.round((1 - value) * 255),
        255
      ]);
    }
    return colormap;
  }
  // Viridis colormap (perceptually uniform)
  generateViridis() {
    const colormap = [];
    const viridisData = [
      [0.267004, 4874e-6, 0.329415],
      [0.282623, 0.140926, 0.457517],
      [0.253935, 0.265254, 0.529983],
      [0.206756, 0.371758, 0.553117],
      [0.163625, 0.471133, 0.558148],
      [0.127568, 0.566949, 0.550556],
      [0.134692, 0.658636, 0.517649],
      [0.266941, 0.748751, 0.440573],
      [0.477504, 0.821444, 0.318195],
      [0.741388, 0.873449, 0.149561],
      [0.993248, 0.906157, 0.143936]
    ];
    for (let i = 0; i < 256; i++) {
      const pos = i / 255 * (viridisData.length - 1);
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const color1 = viridisData[Math.min(idx, viridisData.length - 1)];
      const color2 = viridisData[Math.min(idx + 1, viridisData.length - 1)];
      colormap.push([
        Math.round((color1[0] * (1 - frac) + color2[0] * frac) * 255),
        Math.round((color1[1] * (1 - frac) + color2[1] * frac) * 255),
        Math.round((color1[2] * (1 - frac) + color2[2] * frac) * 255)
      ]);
    }
    return colormap;
  }
  // Plasma colormap (perceptually uniform)
  generatePlasma() {
    const colormap = [];
    const plasmaData = [
      [0.050383, 0.029803, 0.527975],
      [0.287076, 0.010384, 0.62701],
      [0.47623, 0.011158, 0.657865],
      [0.647257, 0.125289, 0.593542],
      [0.785914, 0.27429, 0.472908],
      [0.87785, 0.439704, 0.345067],
      [0.936213, 0.605205, 0.231465],
      [0.972355, 0.771125, 0.155626],
      [0.994617, 0.938336, 0.165141],
      [0.987053, 0.991438, 0.749504]
    ];
    for (let i = 0; i < 256; i++) {
      const pos = i / 255 * (plasmaData.length - 1);
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const color1 = plasmaData[Math.min(idx, plasmaData.length - 1)];
      const color2 = plasmaData[Math.min(idx + 1, plasmaData.length - 1)];
      colormap.push([
        Math.round((color1[0] * (1 - frac) + color2[0] * frac) * 255),
        Math.round((color1[1] * (1 - frac) + color2[1] * frac) * 255),
        Math.round((color1[2] * (1 - frac) + color2[2] * frac) * 255)
      ]);
    }
    return colormap;
  }
  // Inferno colormap (perceptually uniform)
  generateInferno() {
    const colormap = [];
    const infernoData = [
      [1462e-6, 466e-6, 0.013866],
      [0.094329, 0.042852, 0.225802],
      [0.239903, 0.067979, 0.343397],
      [0.41247, 0.102815, 0.380271],
      [0.591217, 0.15541, 0.347824],
      [0.758643, 0.237267, 0.275196],
      [0.88965, 0.360829, 0.210001],
      [0.969788, 0.514135, 0.186861],
      [0.994738, 0.683489, 0.240902],
      [0.988362, 0.998364, 0.644924]
    ];
    for (let i = 0; i < 256; i++) {
      const pos = i / 255 * (infernoData.length - 1);
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const color1 = infernoData[Math.min(idx, infernoData.length - 1)];
      const color2 = infernoData[Math.min(idx + 1, infernoData.length - 1)];
      colormap.push([
        Math.round((color1[0] * (1 - frac) + color2[0] * frac) * 255),
        Math.round((color1[1] * (1 - frac) + color2[1] * frac) * 255),
        Math.round((color1[2] * (1 - frac) + color2[2] * frac) * 255)
      ]);
    }
    return colormap;
  }
  // Magma colormap (perceptually uniform)
  generateMagma() {
    const colormap = [];
    const magmaData = [
      [1462e-6, 466e-6, 0.013866],
      [0.091904, 0.051667, 0.200303],
      [0.234547, 0.090739, 0.348341],
      [0.408198, 0.131574, 0.416555],
      [0.595732, 0.180653, 0.421399],
      [0.776405, 0.26663, 0.373397],
      [0.92401, 0.40637, 0.33072],
      [0.987622, 0.583041, 0.382914],
      [0.996212, 0.771453, 0.543135],
      [0.987053, 0.991438, 0.749504]
    ];
    for (let i = 0; i < 256; i++) {
      const pos = i / 255 * (magmaData.length - 1);
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const color1 = magmaData[Math.min(idx, magmaData.length - 1)];
      const color2 = magmaData[Math.min(idx + 1, magmaData.length - 1)];
      colormap.push([
        Math.round((color1[0] * (1 - frac) + color2[0] * frac) * 255),
        Math.round((color1[1] * (1 - frac) + color2[1] * frac) * 255),
        Math.round((color1[2] * (1 - frac) + color2[2] * frac) * 255)
      ]);
    }
    return colormap;
  }
  // Turbo colormap (improved rainbow)
  generateTurbo() {
    const colormap = [];
    const turboData = [
      [0.18995, 0.07176, 0.23217],
      [0.25107, 0.25237, 0.63374],
      [0.19659, 0.47276, 0.823],
      [0.12756, 0.66813, 0.82565],
      [0.13094, 0.8203, 0.65899],
      [0.37408, 0.92478, 0.41642],
      [0.66987, 0.95987, 0.19659],
      [0.90842, 0.8764, 0.10899],
      [0.98999, 0.6445, 0.03932],
      [0.93702, 0.25023, 0.01583]
    ];
    for (let i = 0; i < 256; i++) {
      const pos = i / 255 * (turboData.length - 1);
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const color1 = turboData[Math.min(idx, turboData.length - 1)];
      const color2 = turboData[Math.min(idx + 1, turboData.length - 1)];
      colormap.push([
        Math.round((color1[0] * (1 - frac) + color2[0] * frac) * 255),
        Math.round((color1[1] * (1 - frac) + color2[1] * frac) * 255),
        Math.round((color1[2] * (1 - frac) + color2[2] * frac) * 255)
      ]);
    }
    return colormap;
  }
};

// media/imagePreview.js
(function() {
  const originalVscode = acquireVsCodeApi();
  let currentFormatInfo = null;
  const vscode = {
    postMessage: (message) => {
      if (message.type === "formatInfo" && message.value) {
        currentFormatInfo = message.value;
      }
      return originalVscode.postMessage(message);
    },
    setState: originalVscode.setState,
    getState: originalVscode.getState
  };
  const settingsManager = new SettingsManager();
  const tiffProcessor = new TiffProcessor(settingsManager, vscode);
  const exrProcessor = new ExrProcessor(settingsManager, vscode);
  const zoomController = new ZoomController(settingsManager, vscode);
  const mouseHandler = new MouseHandler(settingsManager, vscode, tiffProcessor);
  const npyProcessor = new NpyProcessor(settingsManager, vscode);
  const pfmProcessor = new PfmProcessor(settingsManager, vscode);
  const ppmProcessor = new PpmProcessor(settingsManager, vscode);
  const pngProcessor = new PngProcessor(settingsManager, vscode);
  const histogramOverlay = new HistogramOverlay(settingsManager, vscode);
  const colormapConverter = new ColormapConverter();
  mouseHandler.setNpyProcessor(npyProcessor);
  mouseHandler.setPfmProcessor(pfmProcessor);
  mouseHandler.setPpmProcessor(ppmProcessor);
  mouseHandler.setPngProcessor(pngProcessor);
  mouseHandler.setExrProcessor(exrProcessor);
  let hasLoadedImage = false;
  let canvas = null;
  let imageElement = null;
  let primaryImageData = null;
  let peerImageData = null;
  let peerImageUris = [];
  let isShowingPeer = false;
  let initialLoadStartTime = 0;
  let extensionLoadStartTime = 0;
  let currentLoadFormat = "";
  let colormapConversionState = null;
  let originalImageData = null;
  let hasAppliedConversion = false;
  const persistedState = vscode.getState();
  if (persistedState) {
    peerImageUris = persistedState.peerImageUris || [];
    isShowingPeer = persistedState.isShowingPeer || false;
    colormapConversionState = persistedState.colormapConversionState || null;
  }
  let imageCollection = {
    totalImages: 1,
    currentIndex: 0,
    show: false
  };
  let overlayElement = null;
  function saveState() {
    const state = {
      peerImageUris,
      isShowingPeer,
      currentResourceUri: settingsManager.settings.resourceUri,
      colormapConversionState,
      timestamp: Date.now()
    };
    vscode.setState(state);
  }
  const container = document.body;
  const image = document.createElement("img");
  function initialize() {
    initialLoadStartTime = performance.now();
    extensionLoadStartTime = settingsManager.settings.loadStartTime || 0;
    setupImageLoading();
    setupMessageHandling();
    setupEventListeners();
    createImageCollectionOverlay();
    window.addEventListener("beforeunload", saveState);
    window.addEventListener("pagehide", saveState);
    const settings = settingsManager.settings;
    const resourceUri = settings.resourceUri;
    if (resourceUri.toLowerCase().endsWith(".tif") || resourceUri.toLowerCase().endsWith(".tiff")) {
      handleTiff(settings.src);
    } else if (resourceUri.toLowerCase().endsWith(".exr")) {
      handleExr(settings.src);
    } else if (resourceUri.toLowerCase().endsWith(".pfm")) {
      handlePfm(settings.src);
    } else if (resourceUri.toLowerCase().endsWith(".ppm") || resourceUri.toLowerCase().endsWith(".pgm") || resourceUri.toLowerCase().endsWith(".pbm")) {
      handlePpm(settings.src);
    } else if (resourceUri.toLowerCase().endsWith(".png") || resourceUri.toLowerCase().endsWith(".jpg") || resourceUri.toLowerCase().endsWith(".jpeg")) {
      handlePng(settings.src);
    } else if (resourceUri.toLowerCase().endsWith(".npy") || resourceUri.toLowerCase().endsWith(".npz")) {
      handleNpy(settings.src);
    } else {
      image.src = settings.src;
    }
    if (peerImageUris.length > 0) {
      for (const peerUri of peerImageUris) {
        vscode.postMessage({
          type: "restorePeerImage",
          peerUri
        });
      }
      setTimeout(() => {
        for (const peerUri of peerImageUris) {
          handleStartComparison(peerUri);
        }
      }, 1e3);
    }
    if (colormapConversionState) {
      const checkAndApplyColormap = async () => {
        if (hasLoadedImage && canvas) {
          await handleColormapConversion(
            colormapConversionState.colormapName,
            colormapConversionState.minValue,
            colormapConversionState.maxValue,
            colormapConversionState.inverted,
            colormapConversionState.logarithmic
          );
        } else {
          setTimeout(checkAndApplyColormap, 50);
        }
      };
      setTimeout(checkAndApplyColormap, 100);
    }
  }
  function reloadImage() {
    hasLoadedImage = false;
    canvas = null;
    imageElement = null;
    primaryImageData = null;
    peerImageData = null;
    vscode.postMessage({ type: "stats", value: null });
    container.className = "container image";
    const existingImages = container.querySelectorAll("img, canvas");
    existingImages.forEach((el) => el.remove());
    const loadingIndicator = container.querySelector(".loading-indicator");
    if (loadingIndicator) {
      loadingIndicator.remove();
    }
    container.classList.add("loading");
    const settings = settingsManager.settings;
    const resourceUri = settings.resourceUri || "";
    zoomController.resetZoom();
    if (resourceUri.toLowerCase().endsWith(".tif") || resourceUri.toLowerCase().endsWith(".tiff")) {
      handleTiff(settings.src);
    } else if (resourceUri.toLowerCase().endsWith(".pfm")) {
      handlePfm(settings.src);
    } else if (resourceUri.toLowerCase().endsWith(".ppm") || resourceUri.toLowerCase().endsWith(".pgm") || resourceUri.toLowerCase().endsWith(".pbm")) {
      handlePpm(settings.src);
    } else if (resourceUri.toLowerCase().endsWith(".png") || resourceUri.toLowerCase().endsWith(".jpg") || resourceUri.toLowerCase().endsWith(".jpeg")) {
      handlePng(settings.src);
    } else if (resourceUri.toLowerCase().endsWith(".npy") || resourceUri.toLowerCase().endsWith(".npz")) {
      handleNpy(settings.src);
    } else {
      image.src = settings.src || "";
    }
  }
  function sendFormatInfo(formatInfo) {
    vscode.postMessage({
      type: "formatInfo",
      value: formatInfo
    });
  }
  function logToOutput(message) {
    vscode.postMessage({
      type: "log",
      value: message
    });
  }
  function setupImageLoading() {
    container.classList.add("image");
    image.classList.add("scale-to-fit");
    image.addEventListener("load", () => {
      if (hasLoadedImage) return;
      onImageLoaded();
    });
    image.addEventListener("error", () => {
      if (hasLoadedImage) return;
      onImageError();
    });
  }
  function onImageLoaded() {
    hasLoadedImage = true;
    canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.classList.add("scale-to-fit");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      onImageError();
      return;
    }
    ctx.drawImage(image, 0, 0);
    imageElement = canvas;
    finalizeImageSetup();
  }
  function onImageError() {
    hasLoadedImage = true;
    container.classList.add("error");
    container.classList.remove("loading");
  }
  async function handleTiff(src) {
    currentLoadFormat = "TIFF";
    try {
      const result = await tiffProcessor.processTiff(src);
      canvas = result.canvas;
      primaryImageData = result.imageData;
      imageElement = canvas;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.putImageData(primaryImageData, 0, 0);
      }
      hasLoadedImage = true;
      finalizeImageSetup();
      if (!tiffProcessor._pendingRenderData) {
        const endTime = performance.now();
        const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
        const totalTime = extensionLoadStartTime ? Date.now() - extensionLoadStartTime : webviewTime;
        logToOutput(`[Perf] TIFF Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
      }
    } catch (error) {
      console.error("Error handling TIFF:", error);
      onImageError();
    }
  }
  async function handleExr(src) {
    currentLoadFormat = "EXR";
    try {
      const result = await exrProcessor.processExr(src);
      canvas = result.canvas;
      primaryImageData = result.imageData;
      imageElement = canvas;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.putImageData(primaryImageData, 0, 0);
      }
      hasLoadedImage = true;
      finalizeImageSetup();
      if (!exrProcessor._pendingRenderData) {
        const endTime = performance.now();
        const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
        const totalTime = extensionLoadStartTime ? Date.now() - extensionLoadStartTime : webviewTime;
        logToOutput(`[Perf] EXR Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
      }
    } catch (error) {
      console.error("Error handling EXR:", error);
      onImageError();
    }
  }
  async function handlePfm(src) {
    currentLoadFormat = "PFM";
    try {
      const result = await pfmProcessor.processPfm(src);
      canvas = result.canvas;
      primaryImageData = result.imageData;
      imageElement = canvas;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.putImageData(primaryImageData, 0, 0);
      }
      hasLoadedImage = true;
      finalizeImageSetup();
      if (!pfmProcessor._pendingRenderData) {
        const endTime = performance.now();
        const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
        const totalTime = extensionLoadStartTime ? Date.now() - extensionLoadStartTime : webviewTime;
        logToOutput(`[Perf] PFM Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
      }
    } catch (error) {
      console.error("Error handling PFM:", error);
      onImageError();
    }
  }
  async function handlePpm(src) {
    currentLoadFormat = "PPM/PGM";
    try {
      const result = await ppmProcessor.processPpm(src);
      canvas = result.canvas;
      primaryImageData = result.imageData;
      imageElement = canvas;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.putImageData(primaryImageData, 0, 0);
      }
      hasLoadedImage = true;
      finalizeImageSetup();
      if (!ppmProcessor._pendingRenderData) {
        const endTime = performance.now();
        const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
        const totalTime = extensionLoadStartTime ? Date.now() - extensionLoadStartTime : webviewTime;
        logToOutput(`[Perf] PPM/PGM Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
      }
    } catch (error) {
      console.error("Error handling PPM/PGM:", error);
      onImageError();
    }
  }
  async function handlePng(src) {
    currentLoadFormat = "PNG/JPEG";
    try {
      const result = await pngProcessor.processPng(src);
      canvas = result.canvas;
      primaryImageData = result.imageData;
      imageElement = canvas;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.putImageData(primaryImageData, 0, 0);
      }
      hasLoadedImage = true;
      finalizeImageSetup();
      if (!pngProcessor._pendingRenderData) {
        const endTime = performance.now();
        const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
        const totalTime = extensionLoadStartTime ? Date.now() - extensionLoadStartTime : webviewTime;
        logToOutput(`[Perf] PNG/JPEG Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
      }
    } catch (error) {
      console.error("Error handling PNG/JPEG:", error);
      onImageError();
    }
  }
  async function handleNpy(src) {
    currentLoadFormat = "NPY/NPZ";
    try {
      const result = await npyProcessor.processNpy(src);
      canvas = result.canvas;
      primaryImageData = result.imageData;
      imageElement = canvas;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.putImageData(primaryImageData, 0, 0);
      }
      hasLoadedImage = true;
      finalizeImageSetup();
      if (!npyProcessor._pendingRenderData) {
        const endTime = performance.now();
        const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
        const totalTime = extensionLoadStartTime ? Date.now() - extensionLoadStartTime : webviewTime;
        logToOutput(`[Perf] NPY/NPZ Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
      }
    } catch (error) {
      console.error("Error handling NPY/NPZ:", error);
      onImageError();
    }
  }
  function finalizeImageSetup() {
    zoomController.setImageElement(imageElement);
    zoomController.setCanvas(canvas);
    zoomController.setImageLoaded();
    mouseHandler.setImageElement(imageElement);
    vscode.postMessage({
      type: "size",
      value: `${imageElement.width}x${imageElement.height}`
    });
    container.classList.remove("loading");
    container.classList.add("ready");
    container.append(imageElement);
    zoomController.applyInitialZoom();
    mouseHandler.addMouseListeners(imageElement);
    updateHistogramData();
  }
  function setupMessageHandling() {
    window.addEventListener("message", async (e) => {
      if (e.origin !== window.origin) {
        console.error("Dropping message from unknown origin in image preview");
        return;
      }
      await handleVSCodeMessage(e.data);
    });
    vscode.postMessage({ type: "get-initial-data" });
  }
  async function handleVSCodeMessage(message) {
    switch (message.type) {
      case "setScale":
        zoomController.updateScale(message.scale);
        break;
      case "setActive":
        mouseHandler.setActive(message.value);
        break;
      case "zoomIn":
        zoomController.zoomIn();
        break;
      case "zoomOut":
        zoomController.zoomOut();
        break;
      case "resetZoom":
        zoomController.resetZoom();
        break;
      case "exportAsPng":
        exportAsPng();
        break;
      case "start-comparison":
        handleStartComparison(message.peerUri);
        break;
      case "copyImage":
        copyImage();
        break;
      case "updateSettings":
        const oldResourceUri = settingsManager.settings.resourceUri;
        const changes = settingsManager.updateSettings(message.settings);
        const newResourceUri = settingsManager.settings.resourceUri;
        if (message.isInitialRender && canvas) {
          let deferredImageData = null;
          if (tiffProcessor._pendingRenderData) {
            deferredImageData = await tiffProcessor.performDeferredRender();
          } else if (npyProcessor._pendingRenderData) {
            deferredImageData = npyProcessor.performDeferredRender();
          } else if (pngProcessor._pendingRenderData) {
            deferredImageData = pngProcessor.performDeferredRender();
          } else if (ppmProcessor._pendingRenderData) {
            deferredImageData = ppmProcessor.performDeferredRender();
          } else if (pfmProcessor._pendingRenderData) {
            deferredImageData = pfmProcessor.performDeferredRender();
          } else if (exrProcessor._pendingRenderData) {
            deferredImageData = exrProcessor.updateSettings(settingsManager.settings);
          }
          if (deferredImageData) {
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (ctx) {
              ctx.putImageData(deferredImageData, 0, 0);
              primaryImageData = deferredImageData;
              updateHistogramData();
            }
            if (initialLoadStartTime > 0) {
              const endTime = performance.now();
              const webviewTime = (endTime - initialLoadStartTime).toFixed(2);
              const totalTime = extensionLoadStartTime ? Date.now() - extensionLoadStartTime : webviewTime;
              logToOutput(`[Perf] ${currentLoadFormat} Image loaded in ${webviewTime}ms (total: ${totalTime}ms)`);
              initialLoadStartTime = 0;
            }
          }
        } else if (oldResourceUri !== newResourceUri) {
          reloadImage();
        } else {
          const startTime = performance.now();
          updateImageWithNewSettings(changes);
          const endTime = performance.now();
          logToOutput(`[Perf] Re-render (Gamma/Brightness) took ${(endTime - startTime).toFixed(2)}ms`);
        }
        break;
      case "mask-filter-settings":
        const maskChanges = settingsManager.updateSettings(message.settings);
        updateImageWithNewSettings(maskChanges);
        break;
      case "updateImageCollectionOverlay":
        updateImageCollectionOverlay(message.data);
        break;
      case "getZoomState":
        const zoomState = zoomController.getCurrentState();
        vscode.postMessage({
          type: "zoomStateResponse",
          state: zoomState
        });
        break;
      case "getComparisonState":
        const comparisonState = {
          peerUris: peerImageUris,
          isShowingPeer
        };
        vscode.postMessage({
          type: "comparisonStateResponse",
          state: comparisonState
        });
        break;
      case "restoreZoomState":
        if (message.state) {
          zoomController.restoreState(message.state);
        }
        break;
      case "restoreComparisonState":
        if (message.state && message.state.peerUris && message.state.peerUris.length > 0) {
          peerImageUris = message.state.peerUris;
          isShowingPeer = message.state.isShowingPeer;
          for (const peerUri of peerImageUris) {
            handleStartComparison(peerUri);
          }
        }
        break;
      case "switchToImage":
        switchToNewImage(message.uri, message.resourceUri);
        break;
      case "toggleHistogram":
        histogramOverlay.toggle();
        updateHistogramData();
        vscode.postMessage({
          type: "histogramVisibilityChanged",
          isVisible: histogramOverlay.getVisibility()
        });
        break;
      case "requestHistogram":
        updateHistogramData();
        break;
      case "convertColormapToFloat":
        await handleColormapConversion(
          message.colormap,
          message.min,
          message.max,
          message.inverted || false,
          message.logarithmic || false
        );
        break;
      case "revertToOriginal":
        handleRevertToOriginal();
        break;
    }
  }
  function updateHistogramData() {
    if (!canvas || !hasLoadedImage) {
      return;
    }
    if (!histogramOverlay.getVisibility()) {
      return;
    }
    try {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      histogramOverlay.update(imageData);
    } catch (error) {
      console.error("Error updating histogram:", error);
    }
  }
  async function handleColormapConversion(colormapName, minValue, maxValue, inverted, logarithmic) {
    if (!canvas || !hasLoadedImage) {
      console.error("No image loaded for colormap conversion");
      return;
    }
    try {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        console.error("Could not get canvas context");
        return;
      }
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const floatData = colormapConverter.convertToFloat(
        imageData,
        colormapName,
        minValue,
        maxValue,
        inverted,
        logarithmic
      );
      const width = imageData.width;
      const height = imageData.height;
      const floatImageData = new ImageData(width, height);
      if (settingsManager.settings.normalization) {
        settingsManager.settings.normalization.autoNormalize = true;
        settingsManager.settings.normalization.min = minValue;
        settingsManager.settings.normalization.max = maxValue;
      }
      for (let i = 0; i < floatData.length; i++) {
        const value = floatData[i];
        const normalized = (value - minValue) / (maxValue - minValue) * 255;
        const clamped = Math.max(0, Math.min(255, normalized));
        const offset = i * 4;
        floatImageData.data[offset] = clamped;
        floatImageData.data[offset + 1] = clamped;
        floatImageData.data[offset + 2] = clamped;
        floatImageData.data[offset + 3] = 255;
      }
      ctx.putImageData(floatImageData, 0, 0);
      primaryImageData = floatImageData;
      if (imageElement === canvas) {
        canvas.style.display = "none";
        canvas.offsetHeight;
        canvas.style.display = "";
      }
      zoomController.updateScale(zoomController.scale || "fit");
      tiffProcessor._convertedFloatData = {
        floatData,
        width,
        height,
        min: minValue,
        max: maxValue
      };
      tiffProcessor.rawTiffData = null;
      if (exrProcessor) exrProcessor.rawExrData = null;
      if (npyProcessor) npyProcessor._lastRaw = null;
      if (ppmProcessor) ppmProcessor._lastRaw = null;
      if (pfmProcessor) pfmProcessor._lastRaw = null;
      if (pngProcessor) pngProcessor._lastRaw = null;
      vscode.postMessage({
        type: "stats",
        value: { min: minValue, max: maxValue }
      });
      sendFormatInfo({
        width,
        height,
        bitsPerSample: 32,
        sampleFormat: 3,
        // Float
        samplesPerPixel: 1,
        formatType: "colormap-converted",
        isInitialLoad: false
      });
      updateHistogramData();
      colormapConversionState = {
        colormapName,
        minValue,
        maxValue,
        inverted,
        logarithmic
      };
      hasAppliedConversion = true;
      saveState();
      console.log(`Colormap conversion complete: ${colormapName} [${minValue}, ${maxValue}]`);
    } catch (error) {
      console.error("Error during colormap conversion:", error);
      vscode.postMessage({
        type: "error",
        message: `Colormap conversion failed: ${error.message}`
      });
    }
  }
  function handleRevertToOriginal() {
    if (!canvas || !hasLoadedImage) {
      console.error("No image loaded to revert");
      return;
    }
    try {
      const settings = settingsManager.settings;
      const resourceUri = settings.resourceUri || "";
      colormapConversionState = null;
      hasAppliedConversion = false;
      originalImageData = null;
      tiffProcessor.rawTiffData = null;
      if (exrProcessor) exrProcessor.rawExrData = null;
      if (npyProcessor) npyProcessor._lastRaw = null;
      if (ppmProcessor) ppmProcessor._lastRaw = null;
      if (pfmProcessor) pfmProcessor._lastRaw = null;
      if (pngProcessor) pngProcessor._lastRaw = null;
      tiffProcessor._convertedFloatData = null;
      reloadImage();
      vscode.postMessage({
        type: "notifyRevert",
        message: "Reverted to original image"
      });
      console.log("Reverted to original image");
    } catch (error) {
      console.error("Error reverting to original image:", error);
      vscode.postMessage({
        type: "error",
        message: `Failed to revert to original image: ${error.message}`
      });
    }
  }
  async function updateImageWithNewSettings(changes) {
    if (!canvas || !hasLoadedImage) {
      return;
    }
    if (!changes) {
      changes = { parametersOnly: false, changedMasks: false, changedStructure: false };
    }
    if (changes.changedMasks && tiffProcessor._maskCache) {
      tiffProcessor.clearMaskCache();
    }
    if (primaryImageData && tiffProcessor.rawTiffData) {
      try {
        if (changes.parametersOnly) {
          const newImageData2 = await tiffProcessor.renderTiffWithSettingsFast(
            tiffProcessor.rawTiffData.image,
            tiffProcessor.rawTiffData.rasters,
            true
            // skipMasks flag
          );
          const ctx2 = canvas.getContext("2d");
          if (ctx2 && newImageData2) {
            ctx2.putImageData(newImageData2, 0, 0);
            primaryImageData = newImageData2;
            updateHistogramData();
          }
          return;
        }
        const newImageData = await tiffProcessor.renderTiffWithSettings(
          tiffProcessor.rawTiffData.image,
          tiffProcessor.rawTiffData.rasters
        );
        const ctx = canvas.getContext("2d");
        if (ctx && newImageData) {
          console.log("\u2705 CANVAS UPDATE (TIFF slow path): Applying new ImageData to canvas");
          ctx.putImageData(newImageData, 0, 0);
          primaryImageData = newImageData;
          updateHistogramData();
        }
        console.log("\u2728 Slow path complete, returning");
        return;
      } catch (error) {
        console.error("\u274C Error updating TIFF image with new settings:", error);
      }
      console.log("\u21A9\uFE0F Returning after TIFF processing (even on error)");
      return;
    }
    if (primaryImageData && exrProcessor && exrProcessor.rawExrData) {
      console.log("\u{1F4C4} Processing EXR update");
      try {
        const newImageData = exrProcessor.updateSettings(settingsManager.settings);
        if (newImageData) {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            console.log("\u2705 CANVAS UPDATE (EXR): Applying new ImageData to canvas");
            ctx.putImageData(newImageData, 0, 0);
            primaryImageData = newImageData;
            updateHistogramData();
          }
        }
      } catch (error) {
        console.error("\u274C Error updating EXR image with new settings:", error);
      }
      return;
    } else if (primaryImageData && ppmProcessor && ppmProcessor._lastRaw) {
      try {
        const newImageData = ppmProcessor.renderPgmWithSettings();
        if (newImageData) {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.putImageData(newImageData, 0, 0);
            primaryImageData = newImageData;
            updateHistogramData();
          }
        }
      } catch (error) {
        console.error("Error updating PGM image with new settings:", error);
      }
    } else if (primaryImageData && npyProcessor && npyProcessor._lastRaw) {
      try {
        const newImageData = npyProcessor.renderNpyWithSettings();
        if (newImageData) {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.putImageData(newImageData, 0, 0);
            primaryImageData = newImageData;
            updateHistogramData();
          }
        }
      } catch (error) {
        console.error("Error updating NPY image with new settings:", error);
      }
    } else if (primaryImageData && pngProcessor && pngProcessor._lastRaw) {
      try {
        const newImageData = pngProcessor.renderPngWithSettings();
        if (newImageData) {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.putImageData(newImageData, 0, 0);
            primaryImageData = newImageData;
          }
        }
      } catch (error) {
        console.error("Error updating PNG/JPEG image with new settings:", error);
      }
    }
  }
  function setupEventListeners() {
    container.addEventListener("wheel", (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
      }
      const keyState = mouseHandler.getKeyboardState();
      zoomController.handleWheelZoom(e, keyState.ctrlPressed, keyState.altPressed);
    }, { passive: false });
    container.addEventListener("mousedown", (e) => {
      if (!imageElement || !hasLoadedImage) {
        return;
      }
      if (e.button !== 0) {
        return;
      }
      const keyState = mouseHandler.getKeyboardState();
      mouseHandler.consumeClick = !mouseHandler.isActive;
    });
    container.addEventListener("click", (e) => {
      if (!imageElement || !hasLoadedImage) {
        return;
      }
      if (e.button !== 0) {
        return;
      }
      if (mouseHandler.consumeClick) {
        mouseHandler.consumeClick = false;
        return;
      }
      if (zoomController.scale === "fit") {
        zoomController.firstZoom();
      }
      const keyState = mouseHandler.getKeyboardState();
      if (!(settingsManager.isMac ? keyState.altPressed : keyState.ctrlPressed)) {
        zoomController.zoomIn();
      } else {
        zoomController.zoomOut();
      }
    });
    window.addEventListener("scroll", () => {
      if (!imageElement || !hasLoadedImage || !imageElement.parentElement || zoomController.scale === "fit") {
        return;
      }
      const entry = vscode.getState();
      if (entry) {
        vscode.setState({ scale: entry.scale, offsetX: window.scrollX, offsetY: window.scrollY });
      }
    }, { passive: true });
    document.addEventListener("copy", () => {
      copyImage();
    });
    document.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const existingMenu = document.querySelector(".custom-context-menu");
      if (existingMenu) {
        existingMenu.remove();
      }
      const menu = document.createElement("div");
      menu.className = "custom-context-menu";
      menu.style.left = `${e.clientX}px`;
      menu.style.top = `${e.clientY}px`;
      const createMenuItem = (text, action) => {
        const item = document.createElement("div");
        item.className = "context-menu-item";
        item.textContent = text;
        item.addEventListener("click", (e2) => {
          e2.stopPropagation();
          menu.remove();
          setTimeout(() => action(), 0);
        });
        return item;
      };
      const createSeparator = () => {
        const separator = document.createElement("div");
        separator.className = "context-menu-separator";
        return separator;
      };
      menu.appendChild(createMenuItem("Copy", () => {
        vscode.postMessage({ type: "executeCommand", command: "tiffVisualizer.copyImage" });
      }));
      menu.appendChild(createMenuItem("Export as PNG", () => {
        vscode.postMessage({ type: "executeCommand", command: "tiffVisualizer.exportAsPng" });
      }));
      menu.appendChild(createSeparator());
      menu.appendChild(createMenuItem("Toggle Histogram (beta)", () => {
        vscode.postMessage({ type: "executeCommand", command: "tiffVisualizer.toggleHistogram" });
      }));
      const isRgbImage = currentFormatInfo && currentFormatInfo.samplesPerPixel >= 3;
      if (isRgbImage) {
        menu.appendChild(createSeparator());
        menu.appendChild(createMenuItem("Convert Colormap to Float", () => {
          vscode.postMessage({ type: "executeCommand", command: "tiffVisualizer.convertColormapToFloat" });
        }));
      }
      if (hasAppliedConversion) {
        menu.appendChild(createSeparator());
        menu.appendChild(createMenuItem("Revert to Original", () => {
          vscode.postMessage({ type: "executeCommand", command: "tiffVisualizer.revertToOriginal" });
        }));
      }
      menu.appendChild(createSeparator());
      menu.appendChild(createMenuItem("Filter by Mask (beta)", () => {
        vscode.postMessage({ type: "executeCommand", command: "tiffVisualizer.filterByMask" });
      }));
      menu.appendChild(createSeparator());
      const currentNanColor = settingsManager.settings.nanColor || "black";
      const nextNanColor = currentNanColor === "black" ? "fuchsia" : "black";
      menu.appendChild(createMenuItem(`Show NaN Color as ${nextNanColor}`, () => {
        vscode.postMessage({ type: "executeCommand", command: "tiffVisualizer.toggleNanColor" });
      }));
      const isShowingModified = settingsManager.settings.colorPickerShowModified || false;
      const nextColorMode = isShowingModified ? "Original Values" : "Modified Values";
      menu.appendChild(createMenuItem(`Color Picker: Show ${nextColorMode}`, () => {
        vscode.postMessage({ type: "executeCommand", command: "tiffVisualizer.toggleColorPickerMode" });
      }));
      document.body.appendChild(menu);
      const removeMenu = (event) => {
        if (!menu.contains(event.target)) {
          menu.remove();
          document.removeEventListener("click", removeMenu);
        }
      };
      setTimeout(() => {
        document.addEventListener("click", removeMenu);
      }, 0);
    });
    document.addEventListener("cut", (e) => {
      e.preventDefault();
    });
    document.addEventListener("paste", (e) => {
      e.preventDefault();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "c" && peerImageData) {
        isShowingPeer = !isShowingPeer;
        const imageData = isShowingPeer ? peerImageData : primaryImageData;
        const ctx = canvas.getContext("2d");
        if (ctx && imageData) {
          ctx.putImageData(imageData, 0, 0);
        }
        saveState();
      }
    });
    document.querySelector(".open-file-link")?.addEventListener("click", (e) => {
      e.preventDefault();
      vscode.postMessage({ type: "reopen-as-text" });
    });
    window.addEventListener("keydown", (e) => {
      if (imageCollection.totalImages > 1) {
        if (e.key.toLowerCase() === "t") {
          e.preventDefault();
          vscode.postMessage({ type: "toggleImage" });
        } else if (e.key.toLowerCase() === "r") {
          e.preventDefault();
          vscode.postMessage({ type: "toggleImageReverse" });
        }
      }
    });
    window.addEventListener("beforeunload", () => {
      zoomController.saveState();
    });
  }
  function createImageCollectionOverlay() {
    overlayElement = document.createElement("div");
    overlayElement.classList.add("image-collection-overlay");
    overlayElement.style.display = "none";
    overlayElement.innerHTML = `
			<div class="overlay-content">
				<span class="image-counter">1 of 1</span>
				<span class="toggle-hint">Press 't'/'r' to navigate</span>
			</div>
		`;
    document.body.appendChild(overlayElement);
  }
  function updateImageCollectionOverlay(data) {
    if (!overlayElement) return;
    imageCollection = data;
    if (data.show && data.totalImages > 1) {
      const counter = overlayElement.querySelector(".image-counter");
      if (counter) {
        counter.textContent = `${data.currentIndex + 1} of ${data.totalImages}`;
      }
      overlayElement.style.display = "block";
    } else {
      overlayElement.style.display = "none";
    }
  }
  function switchToNewImage(uri, resourceUri) {
    settingsManager.settings.resourceUri = resourceUri;
    settingsManager.settings.src = uri;
    hasLoadedImage = false;
    canvas = null;
    imageElement = null;
    primaryImageData = null;
    const container2 = document.body;
    container2.className = "container";
    const existingImages = container2.querySelectorAll("img, canvas");
    existingImages.forEach((el) => el.remove());
    container2.classList.add("loading");
    loadImageByType(uri, resourceUri);
  }
  function loadImageByType(uri, resourceUri) {
    const lower = resourceUri.toLowerCase();
    if (lower.endsWith(".tif") || lower.endsWith(".tiff")) {
      handleTiff(uri);
    } else if (lower.endsWith(".pfm")) {
      handlePfm(uri);
    } else if (lower.endsWith(".ppm") || lower.endsWith(".pgm") || lower.endsWith(".pbm")) {
      handlePpm(uri);
    } else if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
      handlePng(uri);
    } else if (lower.endsWith(".npy") || lower.endsWith(".npz")) {
      handleNpy(uri);
    } else {
      const newImage = document.createElement("img");
      newImage.classList.add("scale-to-fit");
      newImage.src = uri;
      newImage.addEventListener("load", () => {
        if (hasLoadedImage) return;
        canvas = document.createElement("canvas");
        canvas.width = newImage.naturalWidth;
        canvas.height = newImage.naturalHeight;
        canvas.classList.add("scale-to-fit");
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(newImage, 0, 0);
        }
        imageElement = canvas;
        finalizeImageSetup();
      });
      newImage.addEventListener("error", () => {
        if (hasLoadedImage) return;
        onImageError();
      });
    }
  }
  function exportAsPng() {
    if (canvas) {
      vscode.postMessage({
        type: "didExportAsPng",
        payload: canvas.toDataURL("image/png")
      });
    } else if (image && image.src) {
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = image.naturalWidth;
      tempCanvas.height = image.naturalHeight;
      const ctx = tempCanvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(image, 0, 0);
        vscode.postMessage({
          type: "didExportAsPng",
          payload: tempCanvas.toDataURL("image/png")
        });
        tempCanvas.remove();
      }
    }
  }
  function showNotification(message, type = "success") {
    const existingNotification = document.querySelector(".copy-notification");
    if (existingNotification) {
      existingNotification.remove();
    }
    const notification = document.createElement("div");
    notification.className = `copy-notification copy-notification-${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);
    if (type === "success") {
      setTimeout(() => {
        notification.classList.add("copy-notification-fadeout");
        setTimeout(() => {
          if (notification.parentElement) {
            notification.remove();
          }
        }, 300);
      }, 3e3);
    }
    notification.addEventListener("click", () => {
      notification.classList.add("copy-notification-fadeout");
      setTimeout(() => {
        if (notification.parentElement) {
          notification.remove();
        }
      }, 300);
    });
  }
  async function copyImage(retries = 5) {
    if (!document.hasFocus() && retries > 0) {
      setTimeout(() => {
        copyImage(retries - 1);
      }, 20);
      return;
    }
    if (!canvas && (!image || !image.naturalWidth)) {
      showNotification("No image loaded to copy", "error");
      console.error("Copy failed: No image available");
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "image/png": new Promise((resolve, reject) => {
          const copyCanvas = document.createElement("canvas");
          const ctx = copyCanvas.getContext("2d");
          if (!ctx) {
            return reject(new Error("Could not get canvas context"));
          }
          if (canvas) {
            copyCanvas.width = canvas.width;
            copyCanvas.height = canvas.height;
            ctx.drawImage(canvas, 0, 0);
          } else {
            copyCanvas.width = image.naturalWidth;
            copyCanvas.height = image.naturalHeight;
            ctx.drawImage(image, 0, 0);
          }
          copyCanvas.toBlob((blob) => {
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error("Could not create blob"));
            }
            copyCanvas.remove();
          }, "image/png");
        })
      })]);
      showNotification("Image copied to clipboard", "success");
    } catch (e) {
      console.error("Copy failed:", e);
      showNotification(`Failed to copy image: ${e.message}`, "error");
    }
  }
  async function handleStartComparison(peerUri) {
    try {
      vscode.postMessage({ type: "show-loading" });
      if (!peerImageUris.includes(peerUri)) {
        peerImageUris.push(peerUri);
      }
      const result = await tiffProcessor.processTiff(peerUri);
      peerImageData = result.imageData;
      saveState();
      vscode.postMessage({ type: "comparison-ready" });
    } catch (error) {
      console.error("Failed to load peer image for comparison:", error);
      vscode.postMessage({ type: "show-error", message: "Failed to load comparison image." });
    }
  }
  initialize();
})();
//# sourceMappingURL=imagePreview.bundle.js.map

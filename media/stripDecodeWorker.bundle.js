// media/wasm/tiff-wasm.js
var wasm;
var cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}
var cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
var MAX_SAFARI_DECODE_BYTES = 2146435072;
var numBytesDecoded = 0;
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
var cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
  if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
    cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
  }
  return cachedUint16ArrayMemory0;
}
function getArrayU16FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len);
}
function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}
var cachedFloat32ArrayMemory0 = null;
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
var WASM_VECTOR_LEN = 0;
var cachedTextEncoder = new TextEncoder();
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
var cachedDataViewMemory0 = null;
function getDataViewMemory0() {
  if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || cachedDataViewMemory0.buffer.detached === void 0 && cachedDataViewMemory0.buffer !== wasm.memory.buffer) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
  }
  return cachedDataViewMemory0;
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
function passArrayF32ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 4, 4) >>> 0;
  getFloat32ArrayMemory0().set(arg, ptr / 4);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
var cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
  if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
    cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
  }
  return cachedFloat64ArrayMemory0;
}
function passArrayF64ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 8, 8) >>> 0;
  getFloat64ArrayMemory0().set(arg, ptr / 8);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
function passArray16ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 2, 2) >>> 0;
  getUint16ArrayMemory0().set(arg, ptr / 2);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
var cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
  if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
    cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
  }
  return cachedUint32ArrayMemory0;
}
function passArray32ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 4, 4) >>> 0;
  getUint32ArrayMemory0().set(arg, ptr / 4);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
var cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
  if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
    cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
  }
  return cachedInt32ArrayMemory0;
}
function getArrayI32FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}
function getArrayU32FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}
function decode_exr_zip_f32_blocks(blob, counts, rows, width) {
  const ptr0 = passArray8ToWasm0(blob, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray32ToWasm0(counts, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ptr2 = passArray32ToWasm0(rows, wasm.__wbindgen_malloc);
  const len2 = WASM_VECTOR_LEN;
  const ret = wasm.decode_exr_zip_f32_blocks(ptr0, len0, ptr1, len1, ptr2, len2, width);
  if (ret[3]) {
    throw takeFromExternrefTable0(ret[2]);
  }
  var v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
  wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
  return v4;
}
function decode_tiff_strip_range_raw(blob, counts, first_strip, width, height, channels, bits_per_sample, compression, rows_per_strip, predictor, sample_format, little_endian, tile_width, tile_length, blocks_across, lerc_additional_compression) {
  const ptr0 = passArray8ToWasm0(blob, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray32ToWasm0(counts, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm.decode_tiff_strip_range_raw(ptr0, len0, ptr1, len1, first_strip, width, height, channels, bits_per_sample, compression, rows_per_strip, predictor, sample_format, little_endian, tile_width, tile_length, blocks_across, lerc_additional_compression);
  if (ret[3]) {
    throw takeFromExternrefTable0(ret[2]);
  }
  var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
  wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
  return v3;
}
function decode_tiff_float_strip_range(blob, counts, first_strip, width, height, channels, bits_per_sample, compression, rows_per_strip, predictor, sample_format, little_endian, tile_width, tile_length, blocks_across, lerc_additional_compression) {
  const ptr0 = passArray8ToWasm0(blob, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passArray32ToWasm0(counts, wasm.__wbindgen_malloc);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm.decode_tiff_float_strip_range(ptr0, len0, ptr1, len1, first_strip, width, height, channels, bits_per_sample, compression, rows_per_strip, predictor, sample_format, little_endian, tile_width, tile_length, blocks_across, lerc_additional_compression);
  if (ret[3]) {
    throw takeFromExternrefTable0(ret[2]);
  }
  var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
  wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
  return v3;
}
function getArrayF64FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}
var DecodedArrayFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_decodedarray_free(ptr >>> 0, 1));
var DecodedArray = class _DecodedArray {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(_DecodedArray.prototype);
    obj.__wbg_ptr = ptr;
    DecodedArrayFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    DecodedArrayFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_decodedarray_free(ptr, 0);
  }
  /**
   * @returns {number}
   */
  get sample_kind() {
    const ret = wasm.decodedarray_sample_kind(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get valid_count() {
    const ret = wasm.decodedarray_valid_count(this.__wbg_ptr);
    return ret;
  }
  discard_data() {
    wasm.decodedarray_discard_data(this.__wbg_ptr);
  }
  /**
   * @returns {string}
   */
  get format_label() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.decodedarray_format_label(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  /**
   * @returns {string}
   */
  get metadata_json() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.decodedarray_metadata_json(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  /**
   * @returns {number}
   */
  get sample_format() {
    const ret = wasm.decodedarray_sample_format(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get bits_per_sample() {
    const ret = wasm.decodedarray_bits_per_sample(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {Uint8Array}
   */
  take_data_as_u8() {
    const ret = wasm.decodedarray_take_data_as_u8(this.__wbg_ptr);
    if (ret[3]) {
      throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
  }
  /**
   * @returns {boolean}
   */
  get can_reuse_source() {
    const ret = wasm.decodedarray_can_reuse_source(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @returns {number}
   */
  get non_finite_count() {
    const ret = wasm.decodedarray_non_finite_count(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {Float32Array}
   */
  take_data_as_f32() {
    const ret = wasm.decodedarray_take_data_as_f32(this.__wbg_ptr);
    if (ret[3]) {
      throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
  /**
   * @returns {Uint16Array}
   */
  take_data_as_u16() {
    const ret = wasm.decodedarray_take_data_as_u16(this.__wbg_ptr);
    if (ret[3]) {
      throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
    return v1;
  }
  /**
   * @returns {number}
   */
  get source_data_offset() {
    const ret = wasm.decodedarray_source_data_offset(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {string}
   */
  get source_numeric_type() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.decodedarray_source_numeric_type(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  /**
   * @param {Uint8Array} target
   */
  copy_data_as_u8_into(target) {
    const ret = wasm.decodedarray_copy_data_as_u8_into(this.__wbg_ptr, target);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * Consume the decoded carrier while copying it directly into a
   * JavaScript-owned buffer. Unlike returning `Vec<T>`, wasm-bindgen does
   * not allocate a second JS typed array here; callers can reuse the source
   * ArrayBuffer that was already transferred into the decode worker.
   * @param {Float32Array} target
   */
  copy_data_as_f32_into(target) {
    const ret = wasm.decodedarray_copy_data_as_f32_into(this.__wbg_ptr, target);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Uint16Array} target
   */
  copy_data_as_u16_into(target) {
    const ret = wasm.decodedarray_copy_data_as_u16_into(this.__wbg_ptr, target);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @returns {number}
   */
  get width() {
    const ret = wasm.decodedarray_width(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get height() {
    const ret = wasm.decodedarray_height(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get channels() {
    const ret = wasm.decodedarray_channels(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get data_len() {
    const ret = wasm.decodedarray_data_len(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get data_max() {
    const ret = wasm.decodedarray_data_max(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get data_min() {
    const ret = wasm.decodedarray_data_min(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get type_max() {
    const ret = wasm.decodedarray_type_max(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get type_min() {
    const ret = wasm.decodedarray_type_min(this.__wbg_ptr);
    return ret;
  }
};
if (Symbol.dispose) DecodedArray.prototype[Symbol.dispose] = DecodedArray.prototype.free;
var DemosaicResultFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_demosaicresult_free(ptr >>> 0, 1));
var DemosaicResult = class _DemosaicResult {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(_DemosaicResult.prototype);
    obj.__wbg_ptr = ptr;
    DemosaicResultFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    DemosaicResultFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_demosaicresult_free(ptr, 0);
  }
  /**
   * @returns {number}
   */
  get width() {
    const ret = wasm.demosaicresult_width(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get gain_b() {
    const ret = wasm.demosaicresult_gain_b(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get gain_g() {
    const ret = wasm.demosaicresult_gain_g(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get gain_r() {
    const ret = wasm.demosaicresult_gain_r(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get height() {
    const ret = wasm.demosaicresult_height(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get channels() {
    const ret = wasm.demosaicresult_channels(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {Float32Array}
   */
  take_data() {
    const ret = wasm.demosaicresult_take_data(this.__wbg_ptr);
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
};
if (Symbol.dispose) DemosaicResult.prototype[Symbol.dispose] = DemosaicResult.prototype.free;
var ExrResultFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_exrresult_free(ptr >>> 0, 1));
var ExrResult = class _ExrResult {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(_ExrResult.prototype);
    obj.__wbg_ptr = ptr;
    ExrResultFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    ExrResultFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_exrresult_free(ptr, 0);
  }
  /**
   * @returns {string}
   */
  get all_tags_json() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.exrresult_all_tags_json(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  /**
   * @returns {number}
   */
  get timing_pack_ms() {
    const ret = wasm.decodedarray_type_max(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get timing_read_ms() {
    const ret = wasm.decodedarray_type_min(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get timing_total_ms() {
    const ret = wasm.decodedarray_data_min(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {Float32Array}
   */
  take_data_as_f32() {
    const ret = wasm.exrresult_take_data_as_f32(this.__wbg_ptr);
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
  /**
   * @returns {string}
   */
  get channel_names_csv() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.exrresult_channel_names_csv(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  /**
   * @returns {string}
   */
  get displayed_channels_csv() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.exrresult_displayed_channels_csv(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  /**
   * @returns {number}
   */
  get width() {
    const ret = wasm.exrresult_width(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get format() {
    const ret = wasm.decodedarray_height(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get height() {
    const ret = wasm.exrresult_height(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get channels() {
    const ret = wasm.decodedarray_width(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get data_max() {
    const ret = wasm.decodedarray_non_finite_count(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get data_min() {
    const ret = wasm.decodedarray_data_max(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get data_type() {
    const ret = wasm.decodedarray_channels(this.__wbg_ptr);
    return ret >>> 0;
  }
};
if (Symbol.dispose) ExrResult.prototype[Symbol.dispose] = ExrResult.prototype.free;
var ExrZipPlanJsFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_exrzipplanjs_free(ptr >>> 0, 1));
var ExrZipPlanJs = class _ExrZipPlanJs {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(_ExrZipPlanJs.prototype);
    obj.__wbg_ptr = ptr;
    ExrZipPlanJsFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    ExrZipPlanJsFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_exrzipplanjs_free(ptr, 0);
  }
  /**
   * @returns {string}
   */
  get channel_name() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.exrzipplanjs_channel_name(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  /**
   * @returns {string}
   */
  get all_tags_json() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.exrzipplanjs_all_tags_json(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  /**
   * @returns {Int32Array}
   */
  get y_coordinates() {
    const ret = wasm.exrzipplanjs_y_coordinates(this.__wbg_ptr);
    var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
  /**
   * Move the compressed payload into JavaScript without retaining a second
   * copy in the plan object.
   * @returns {Uint8Array}
   */
  take_compressed() {
    const ret = wasm.exrzipplanjs_take_compressed(this.__wbg_ptr);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
  }
  /**
   * @returns {number}
   */
  get width() {
    const ret = wasm.exrzipplanjs_width(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {Uint32Array}
   */
  get counts() {
    const ret = wasm.exrzipplanjs_counts(this.__wbg_ptr);
    var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
  /**
   * @returns {number}
   */
  get data_y() {
    const ret = wasm.exrzipplanjs_data_y(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get height() {
    const ret = wasm.decodedarray_bits_per_sample(this.__wbg_ptr);
    return ret >>> 0;
  }
};
if (Symbol.dispose) ExrZipPlanJs.prototype[Symbol.dispose] = ExrZipPlanJs.prototype.free;
var HdrResultFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_hdrresult_free(ptr >>> 0, 1));
var HdrResult = class _HdrResult {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(_HdrResult.prototype);
    obj.__wbg_ptr = ptr;
    HdrResultFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    HdrResultFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_hdrresult_free(ptr, 0);
  }
  /**
   * @returns {string}
   */
  get all_tags_json() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.hdrresult_all_tags_json(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  /**
   * @returns {Float32Array}
   */
  take_data_as_f32() {
    const ret = wasm.hdrresult_take_data_as_f32(this.__wbg_ptr);
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
  /**
   * @returns {Float64Array}
   */
  take_metadata_as_f64() {
    const ret = wasm.hdrresult_take_metadata_as_f64(this.__wbg_ptr);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
  }
  /**
   * @returns {number}
   */
  get channels() {
    const ret = wasm.hdrresult_channels(this.__wbg_ptr);
    return ret >>> 0;
  }
};
if (Symbol.dispose) HdrResult.prototype[Symbol.dispose] = HdrResult.prototype.free;
var HistogramResultFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_histogramresult_free(ptr >>> 0, 1));
var HistogramResult = class _HistogramResult {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(_HistogramResult.prototype);
    obj.__wbg_ptr = ptr;
    HistogramResultFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    HistogramResultFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_histogramresult_free(ptr, 0);
  }
  /**
   * @returns {number}
   */
  get non_finite_count() {
    const ret = wasm.histogramresult_non_finite_count(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get max() {
    const ret = wasm.decodedarray_type_max(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get min() {
    const ret = wasm.decodedarray_type_min(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get total() {
    const ret = wasm.histogramresult_total(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {Int32Array}
   */
  get counts() {
    const ret = wasm.histogramresult_counts(this.__wbg_ptr);
    var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
};
if (Symbol.dispose) HistogramResult.prototype[Symbol.dispose] = HistogramResult.prototype.free;
var ImageStatsFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_imagestats_free(ptr >>> 0, 1));
var ImageStats = class _ImageStats {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(_ImageStats.prototype);
    obj.__wbg_ptr = ptr;
    ImageStatsFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    ImageStatsFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_imagestats_free(ptr, 0);
  }
  /**
   * @returns {number}
   */
  get total_count() {
    const ret = wasm.imagestats_total_count(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get valid_count() {
    const ret = wasm.decodedarray_non_finite_count(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get non_finite_count() {
    const ret = wasm.decodedarray_valid_count(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get max() {
    const ret = wasm.decodedarray_type_max(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get min() {
    const ret = wasm.decodedarray_type_min(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get std() {
    const ret = wasm.decodedarray_data_max(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get mean() {
    const ret = wasm.decodedarray_data_min(this.__wbg_ptr);
    return ret;
  }
};
if (Symbol.dispose) ImageStats.prototype[Symbol.dispose] = ImageStats.prototype.free;
var JpegResultFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_jpegresult_free(ptr >>> 0, 1));
var JpegResult = class _JpegResult {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(_JpegResult.prototype);
    obj.__wbg_ptr = ptr;
    JpegResultFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    JpegResultFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_jpegresult_free(ptr, 0);
  }
  /**
   * @returns {Uint8Array}
   */
  take_data_as_u8() {
    const ret = wasm.jpegresult_take_data_as_u8(this.__wbg_ptr);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
  }
  /**
   * @returns {number}
   */
  get width() {
    const ret = wasm.demosaicresult_width(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get height() {
    const ret = wasm.demosaicresult_height(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get channels() {
    const ret = wasm.demosaicresult_channels(this.__wbg_ptr);
    return ret >>> 0;
  }
};
if (Symbol.dispose) JpegResult.prototype[Symbol.dispose] = JpegResult.prototype.free;
var LabelResultFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_labelresult_free(ptr >>> 0, 1));
var LabelResult = class _LabelResult {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(_LabelResult.prototype);
    obj.__wbg_ptr = ptr;
    LabelResultFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    LabelResultFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_labelresult_free(ptr, 0);
  }
  /**
   * Moves the label image out. One-shot; see `DecodedArray::take_data_as_f32`.
   * @returns {Int32Array}
   */
  take_labels_as_i32() {
    const ret = wasm.labelresult_take_labels_as_i32(this.__wbg_ptr);
    if (ret[3]) {
      throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
  /**
   * @returns {number}
   */
  get count() {
    const ret = wasm.demosaicresult_width(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get width() {
    const ret = wasm.demosaicresult_height(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get height() {
    const ret = wasm.demosaicresult_channels(this.__wbg_ptr);
    return ret >>> 0;
  }
};
if (Symbol.dispose) LabelResult.prototype[Symbol.dispose] = LabelResult.prototype.free;
var PngResultFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_pngresult_free(ptr >>> 0, 1));
var PngResult = class _PngResult {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(_PngResult.prototype);
    obj.__wbg_ptr = ptr;
    PngResultFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    PngResultFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_pngresult_free(ptr, 0);
  }
  /**
   * @returns {number}
   */
  get color_type() {
    const ret = wasm.decodedarray_width(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get timing_total_ms() {
    const ret = wasm.decodedarray_data_max(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {Uint16Array}
   */
  take_data_as_u16() {
    const ret = wasm.pngresult_take_data_as_u16(this.__wbg_ptr);
    var v1 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
    return v1;
  }
  /**
   * @returns {number}
   */
  get timing_decode_ms() {
    const ret = wasm.decodedarray_type_max(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get timing_convert_ms() {
    const ret = wasm.decodedarray_data_min(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get timing_read_info_ms() {
    const ret = wasm.decodedarray_type_min(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get width() {
    const ret = wasm.pngresult_width(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get height() {
    const ret = wasm.pngresult_height(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get channels() {
    const ret = wasm.exrresult_width(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get bit_depth() {
    const ret = wasm.exrresult_height(this.__wbg_ptr);
    return ret >>> 0;
  }
};
if (Symbol.dispose) PngResult.prototype[Symbol.dispose] = PngResult.prototype.free;
var RgbaLayerCompositorFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_rgbalayercompositor_free(ptr >>> 0, 1));
var RgbaLayerCompositor = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    RgbaLayerCompositorFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_rgbalayercompositor_free(ptr, 0);
  }
  /**
   * @returns {number}
   */
  get covered_count() {
    const ret = wasm.exrzipplanjs_width(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @param {Int8Array} source
   * @param {number} width
   * @param {number} height
   * @param {number} channels
   * @param {number} source_type_max
   * @param {number} offset_x
   * @param {number} offset_y
   * @param {number} opacity
   * @param {number} blend_mode
   */
  add_channels_i8(source, width, height, channels, source_type_max, offset_x, offset_y, opacity, blend_mode) {
    const ptr0 = passArray8ToWasm0(source, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_add_channels_i8(this.__wbg_ptr, ptr0, len0, width, height, channels, source_type_max, offset_x, offset_y, opacity, blend_mode);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Uint8Array} source
   * @param {number} width
   * @param {number} height
   * @param {number} channels
   * @param {number} source_type_max
   * @param {number} offset_x
   * @param {number} offset_y
   * @param {number} opacity
   * @param {number} blend_mode
   */
  add_channels_u8(source, width, height, channels, source_type_max, offset_x, offset_y, opacity, blend_mode) {
    const ptr0 = passArray8ToWasm0(source, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_add_channels_u8(this.__wbg_ptr, ptr0, len0, width, height, channels, source_type_max, offset_x, offset_y, opacity, blend_mode);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} opacity
   * @param {number} blend_mode
   */
  finish_isolated(opacity, blend_mode) {
    const ret = wasm.rgbalayercompositor_finish_isolated(this.__wbg_ptr, opacity, blend_mode);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Float32Array} source
   * @param {number} width
   * @param {number} height
   * @param {number} channels
   * @param {number} source_type_max
   * @param {number} offset_x
   * @param {number} offset_y
   * @param {number} opacity
   * @param {number} blend_mode
   */
  add_channels_f32(source, width, height, channels, source_type_max, offset_x, offset_y, opacity, blend_mode) {
    const ptr0 = passArrayF32ToWasm0(source, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_add_channels_f32(this.__wbg_ptr, ptr0, len0, width, height, channels, source_type_max, offset_x, offset_y, opacity, blend_mode);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Float64Array} source
   * @param {number} width
   * @param {number} height
   * @param {number} channels
   * @param {number} source_type_max
   * @param {number} offset_x
   * @param {number} offset_y
   * @param {number} opacity
   * @param {number} blend_mode
   */
  add_channels_f64(source, width, height, channels, source_type_max, offset_x, offset_y, opacity, blend_mode) {
    const ptr0 = passArrayF64ToWasm0(source, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_add_channels_f64(this.__wbg_ptr, ptr0, len0, width, height, channels, source_type_max, offset_x, offset_y, opacity, blend_mode);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Int16Array} source
   * @param {number} width
   * @param {number} height
   * @param {number} channels
   * @param {number} source_type_max
   * @param {number} offset_x
   * @param {number} offset_y
   * @param {number} opacity
   * @param {number} blend_mode
   */
  add_channels_i16(source, width, height, channels, source_type_max, offset_x, offset_y, opacity, blend_mode) {
    const ptr0 = passArray16ToWasm0(source, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_add_channels_i16(this.__wbg_ptr, ptr0, len0, width, height, channels, source_type_max, offset_x, offset_y, opacity, blend_mode);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Int32Array} source
   * @param {number} width
   * @param {number} height
   * @param {number} channels
   * @param {number} source_type_max
   * @param {number} offset_x
   * @param {number} offset_y
   * @param {number} opacity
   * @param {number} blend_mode
   */
  add_channels_i32(source, width, height, channels, source_type_max, offset_x, offset_y, opacity, blend_mode) {
    const ptr0 = passArray32ToWasm0(source, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_add_channels_i32(this.__wbg_ptr, ptr0, len0, width, height, channels, source_type_max, offset_x, offset_y, opacity, blend_mode);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Uint16Array} source
   * @param {number} width
   * @param {number} height
   * @param {number} channels
   * @param {number} source_type_max
   * @param {number} offset_x
   * @param {number} offset_y
   * @param {number} opacity
   * @param {number} blend_mode
   */
  add_channels_u16(source, width, height, channels, source_type_max, offset_x, offset_y, opacity, blend_mode) {
    const ptr0 = passArray16ToWasm0(source, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_add_channels_u16(this.__wbg_ptr, ptr0, len0, width, height, channels, source_type_max, offset_x, offset_y, opacity, blend_mode);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Uint32Array} source
   * @param {number} width
   * @param {number} height
   * @param {number} channels
   * @param {number} source_type_max
   * @param {number} offset_x
   * @param {number} offset_y
   * @param {number} opacity
   * @param {number} blend_mode
   */
  add_channels_u32(source, width, height, channels, source_type_max, offset_x, offset_y, opacity, blend_mode) {
    const ptr0 = passArray32ToWasm0(source, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_add_channels_u32(this.__wbg_ptr, ptr0, len0, width, height, channels, source_type_max, offset_x, offset_y, opacity, blend_mode);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * Start an isolated clipping surface from one 8-bit RGBA raster. Filters
   * modify this straight-colour surface before its original blend mode and
   * opacity are applied to the main document.
   * @param {Uint8Array} source
   * @param {number} width
   * @param {number} height
   * @param {number} offset_x
   * @param {number} offset_y
   */
  begin_isolated_u8(source, width, height, offset_x, offset_y) {
    const ptr0 = passArray8ToWasm0(source, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_begin_isolated_u8(this.__wbg_ptr, ptr0, len0, width, height, offset_x, offset_y);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Float32Array} source
   * @param {number} width
   * @param {number} height
   * @param {number} source_type_max
   * @param {number} offset_x
   * @param {number} offset_y
   */
  begin_isolated_f32(source, width, height, source_type_max, offset_x, offset_y) {
    const ptr0 = passArrayF32ToWasm0(source, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_begin_isolated_f32(this.__wbg_ptr, ptr0, len0, width, height, source_type_max, offset_x, offset_y);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Uint16Array} source
   * @param {number} width
   * @param {number} height
   * @param {number} source_type_max
   * @param {number} offset_x
   * @param {number} offset_y
   */
  begin_isolated_u16(source, width, height, source_type_max, offset_x, offset_y) {
    const ptr0 = passArray16ToWasm0(source, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_begin_isolated_u16(this.__wbg_ptr, ptr0, len0, width, height, source_type_max, offset_x, offset_y);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} hue_degrees
   * @param {number} saturation_delta
   * @param {number} lightness_delta
   * @param {boolean} colorize
   * @param {number} amount
   */
  isolated_apply_hue(hue_degrees, saturation_delta, lightness_delta, colorize, amount) {
    const ret = wasm.rgbalayercompositor_isolated_apply_hue(this.__wbg_ptr, hue_degrees, saturation_delta, lightness_delta, colorize, amount);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * Apply three 256-entry channel LUTs to the active isolated surface.
   * Values in the LUT use the compositor's native value range.
   * @param {Float32Array} tables
   * @param {number} amount
   */
  isolated_apply_lut(tables, amount) {
    const ptr0 = passArrayF32ToWasm0(tables, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_isolated_apply_lut(this.__wbg_ptr, ptr0, len0, amount);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * Apply the remaining pixel-local document adjustments. The operation
   * codes and compact parameter layouts are defined by the layer worker:
   * 2 brightness/contrast, 3 exposure, 4 invert, 5 channel mixer,
   * 6 color balance, 7 black & white, 8 threshold, 9 posterize,
   * 10 gradient-map LUT.
   * @param {number} operation
   * @param {Float32Array} parameters
   * @param {number} amount
   */
  isolated_apply_direct(operation, parameters, amount) {
    const ptr0 = passArrayF32ToWasm0(parameters, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_isolated_apply_direct(this.__wbg_ptr, operation, ptr0, len0, amount);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} channels
   * @returns {Float32Array}
   */
  take_data_as_channels(channels) {
    const ret = wasm.rgbalayercompositor_take_data_as_channels(this.__wbg_ptr, channels);
    if (ret[3]) {
      throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
  /**
   * @returns {Float32Array}
   */
  take_isolated_surface() {
    const ret = wasm.rgbalayercompositor_take_isolated_surface(this.__wbg_ptr);
    if (ret[3]) {
      throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
  /**
   * @param {Float32Array} source
   * @param {number} source_type_max
   * @param {number} opacity
   * @param {number} blend_mode
   */
  isolated_add_f32_surface(source, source_type_max, opacity, blend_mode) {
    const ptr0 = passArrayF32ToWasm0(source, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_isolated_add_f32_surface(this.__wbg_ptr, ptr0, len0, source_type_max, opacity, blend_mode);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Float32Array} source
   * @param {number} source_type_max
   * @param {number} opacity
   * @param {number} blend_mode
   */
  add_arithmetic_f32_surface(source, source_type_max, opacity, blend_mode) {
    const ptr0 = passArrayF32ToWasm0(source, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_add_arithmetic_f32_surface(this.__wbg_ptr, ptr0, len0, source_type_max, opacity, blend_mode);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Uint8Array} mask
   * @param {number} width
   * @param {number} height
   * @param {number} channels
   * @param {number} type_max
   * @param {number} offset_x
   * @param {number} offset_y
   * @param {boolean} invert
   */
  isolated_apply_alpha_mask_u8(mask, width, height, channels, type_max, offset_x, offset_y, invert) {
    const ptr0 = passArray8ToWasm0(mask, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_isolated_apply_alpha_mask_u8(this.__wbg_ptr, ptr0, len0, width, height, channels, type_max, offset_x, offset_y, invert);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * Apply master plus six selective hue/saturation ranges. `parameters`
   * contains master H/S/L followed by six records of
   * a/b/c/d/H/S/L for red, yellow, green, cyan, blue, and magenta.
   * @param {Float32Array} parameters
   * @param {number} amount
   */
  isolated_apply_selective_hue(parameters, amount) {
    const ptr0 = passArrayF32ToWasm0(parameters, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_isolated_apply_selective_hue(this.__wbg_ptr, ptr0, len0, amount);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Float32Array} mask
   * @param {number} width
   * @param {number} height
   * @param {number} channels
   * @param {number} type_max
   * @param {number} offset_x
   * @param {number} offset_y
   * @param {boolean} invert
   */
  isolated_apply_alpha_mask_f32(mask, width, height, channels, type_max, offset_x, offset_y, invert) {
    const ptr0 = passArrayF32ToWasm0(mask, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_isolated_apply_alpha_mask_f32(this.__wbg_ptr, ptr0, len0, width, height, channels, type_max, offset_x, offset_y, invert);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Uint16Array} mask
   * @param {number} width
   * @param {number} height
   * @param {number} channels
   * @param {number} type_max
   * @param {number} offset_x
   * @param {number} offset_y
   * @param {boolean} invert
   */
  isolated_apply_alpha_mask_u16(mask, width, height, channels, type_max, offset_x, offset_y, invert) {
    const ptr0 = passArray16ToWasm0(mask, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_isolated_apply_alpha_mask_u16(this.__wbg_ptr, ptr0, len0, width, height, channels, type_max, offset_x, offset_y, invert);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  isolated_begin_masked_adjustment() {
    const ret = wasm.rgbalayercompositor_isolated_begin_masked_adjustment(this.__wbg_ptr);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Float32Array} source
   * @param {number} source_type_max
   * @param {number} condition
   * @param {number} threshold
   */
  apply_brightness_mask_f32_surface(source, source_type_max, condition, threshold) {
    const ptr0 = passArrayF32ToWasm0(source, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_apply_brightness_mask_f32_surface(this.__wbg_ptr, ptr0, len0, source_type_max, condition, threshold);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Float32Array} source
   * @param {number} source_type_max
   * @param {number} opacity
   * @param {number} blend_mode
   */
  isolated_add_arithmetic_f32_surface(source, source_type_max, opacity, blend_mode) {
    const ptr0 = passArrayF32ToWasm0(source, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_isolated_add_arithmetic_f32_surface(this.__wbg_ptr, ptr0, len0, source_type_max, opacity, blend_mode);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Uint8Array} mask
   * @param {number} width
   * @param {number} height
   * @param {number} channels
   * @param {number} type_max
   * @param {number} offset_x
   * @param {number} offset_y
   * @param {boolean} invert
   */
  isolated_finish_masked_adjustment_u8(mask, width, height, channels, type_max, offset_x, offset_y, invert) {
    const ptr0 = passArray8ToWasm0(mask, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_isolated_finish_masked_adjustment_u8(this.__wbg_ptr, ptr0, len0, width, height, channels, type_max, offset_x, offset_y, invert);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Float32Array} mask
   * @param {number} width
   * @param {number} height
   * @param {number} channels
   * @param {number} type_max
   * @param {number} offset_x
   * @param {number} offset_y
   * @param {boolean} invert
   */
  isolated_finish_masked_adjustment_f32(mask, width, height, channels, type_max, offset_x, offset_y, invert) {
    const ptr0 = passArrayF32ToWasm0(mask, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_isolated_finish_masked_adjustment_f32(this.__wbg_ptr, ptr0, len0, width, height, channels, type_max, offset_x, offset_y, invert);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Uint16Array} mask
   * @param {number} width
   * @param {number} height
   * @param {number} channels
   * @param {number} type_max
   * @param {number} offset_x
   * @param {number} offset_y
   * @param {boolean} invert
   */
  isolated_finish_masked_adjustment_u16(mask, width, height, channels, type_max, offset_x, offset_y, invert) {
    const ptr0 = passArray16ToWasm0(mask, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_isolated_finish_masked_adjustment_u16(this.__wbg_ptr, ptr0, len0, width, height, channels, type_max, offset_x, offset_y, invert);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} width
   * @param {number} height
   * @param {number} type_max
   */
  constructor(width, height, type_max) {
    const ret = wasm.rgbalayercompositor_new(width, height, type_max);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    this.__wbg_ptr = ret[0] >>> 0;
    RgbaLayerCompositorFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
  /**
   * @param {Uint8Array} source
   * @param {number} width
   * @param {number} height
   * @param {number} offset_x
   * @param {number} offset_y
   * @param {number} opacity
   * @param {number} blend_mode
   */
  add_u8(source, width, height, offset_x, offset_y, opacity, blend_mode) {
    const ptr0 = passArray8ToWasm0(source, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_add_u8(this.__wbg_ptr, ptr0, len0, width, height, offset_x, offset_y, opacity, blend_mode);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Float32Array} source
   * @param {number} width
   * @param {number} height
   * @param {number} source_type_max
   * @param {number} offset_x
   * @param {number} offset_y
   * @param {number} opacity
   * @param {number} blend_mode
   */
  add_f32(source, width, height, source_type_max, offset_x, offset_y, opacity, blend_mode) {
    const ptr0 = passArrayF32ToWasm0(source, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_add_f32(this.__wbg_ptr, ptr0, len0, width, height, source_type_max, offset_x, offset_y, opacity, blend_mode);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Uint16Array} source
   * @param {number} width
   * @param {number} height
   * @param {number} source_type_max
   * @param {number} offset_x
   * @param {number} offset_y
   * @param {number} opacity
   * @param {number} blend_mode
   */
  add_u16(source, width, height, source_type_max, offset_x, offset_y, opacity, blend_mode) {
    const ptr0 = passArray16ToWasm0(source, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgbalayercompositor_add_u16(this.__wbg_ptr, ptr0, len0, width, height, source_type_max, offset_x, offset_y, opacity, blend_mode);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @returns {number}
   */
  get max_value() {
    const ret = wasm.rgbalayercompositor_max_value(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get min_value() {
    const ret = wasm.rgbalayercompositor_min_value(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {Float32Array}
   */
  take_data() {
    const ret = wasm.rgbalayercompositor_take_data(this.__wbg_ptr);
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
};
if (Symbol.dispose) RgbaLayerCompositor.prototype[Symbol.dispose] = RgbaLayerCompositor.prototype.free;
var StabilityCurveResultFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_stabilitycurveresult_free(ptr >>> 0, 1));
var StabilityCurveResult = class _StabilityCurveResult {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(_StabilityCurveResult.prototype);
    obj.__wbg_ptr = ptr;
    StabilityCurveResultFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    StabilityCurveResultFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_stabilitycurveresult_free(ptr, 0);
  }
  /**
   * @returns {Uint32Array}
   */
  get object_counts() {
    const ret = wasm.stabilitycurveresult_object_counts(this.__wbg_ptr);
    var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
  /**
   * @returns {number}
   */
  get plateau_width() {
    const ret = wasm.stabilitycurveresult_plateau_width(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get suggested_bin() {
    const ret = wasm.exrresult_height(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {Float64Array}
   */
  get area_fractions() {
    const ret = wasm.stabilitycurveresult_area_fractions(this.__wbg_ptr);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
  }
  /**
   * @returns {Int32Array}
   */
  get bins() {
    const ret = wasm.stabilitycurveresult_bins(this.__wbg_ptr);
    var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
  /**
   * @returns {Float64Array}
   */
  get values() {
    const ret = wasm.stabilitycurveresult_values(this.__wbg_ptr);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
  }
};
if (Symbol.dispose) StabilityCurveResult.prototype[Symbol.dispose] = StabilityCurveResult.prototype.free;
var TiffFloatStripPlanJsFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_tifffloatstripplanjs_free(ptr >>> 0, 1));
var TiffFloatStripPlanJs = class _TiffFloatStripPlanJs {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(_TiffFloatStripPlanJs.prototype);
    obj.__wbg_ptr = ptr;
    TiffFloatStripPlanJsFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    TiffFloatStripPlanJsFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_tifffloatstripplanjs_free(ptr, 0);
  }
  /**
   * @returns {number}
   */
  get tile_width() {
    const ret = wasm.decodedarray_height(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * Blocks in the file, which is what `offsets`/`counts` list.
   * @returns {number}
   */
  get block_count() {
    const ret = wasm.tifffloatstripplanjs_block_count(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get compression() {
    const ret = wasm.pngresult_height(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * Units of work, NOT blocks: tile rows for a tiled file.
   * @returns {number}
   */
  get strip_count() {
    const ret = wasm.tifffloatstripplanjs_strip_count(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get tile_length() {
    const ret = wasm.exrzipplanjs_width(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get blocks_across() {
    const ret = wasm.decodedarray_bits_per_sample(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {boolean}
   */
  get little_endian() {
    const ret = wasm.tifffloatstripplanjs_little_endian(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @returns {number}
   */
  get sample_format() {
    const ret = wasm.exrresult_height(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get rows_per_strip() {
    const ret = wasm.stabilitycurveresult_plateau_width(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get bits_per_sample() {
    const ret = wasm.hdrresult_channels(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * Blocks per unit of work: 1 for strips, one per tile column for tiles.
   * @returns {number}
   */
  get blocks_per_unit() {
    const ret = wasm.tifffloatstripplanjs_blocks_per_unit(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get lerc_additional_compression() {
    const ret = wasm.exrzipplanjs_data_y(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get width() {
    const ret = wasm.histogramresult_non_finite_count(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {Float64Array}
   */
  get counts() {
    const ret = wasm.tifffloatstripplanjs_counts(this.__wbg_ptr);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
  }
  /**
   * @returns {number}
   */
  get height() {
    const ret = wasm.tifffloatstripplanjs_height(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * Strip byte offsets as f64 (exact for any offset below 2^53, which covers
   * BigTIFF in practice and avoids BigInt64Array plumbing on the JS side).
   * @returns {Float64Array}
   */
  get offsets() {
    const ret = wasm.tifffloatstripplanjs_offsets(this.__wbg_ptr);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
  }
  /**
   * @returns {number}
   */
  get channels() {
    const ret = wasm.tifffloatstripplanjs_channels(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get predictor() {
    const ret = wasm.tifffloatstripplanjs_predictor(this.__wbg_ptr);
    return ret >>> 0;
  }
};
if (Symbol.dispose) TiffFloatStripPlanJs.prototype[Symbol.dispose] = TiffFloatStripPlanJs.prototype.free;
var TiffResultFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_tiffresult_free(ptr >>> 0, 1));
var TiffResult = class _TiffResult {
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
  get tile_count() {
    const ret = wasm.tiffresult_tile_count(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get tile_width() {
    const ret = wasm.tiffresult_tile_width(this.__wbg_ptr);
    return ret >>> 0;
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
  get strip_count() {
    const ret = wasm.tiffresult_strip_count(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get tile_length() {
    const ret = wasm.tiffresult_tile_length(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {string}
   */
  get all_tags_json() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.tiffresult_all_tags_json(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  /**
   * @returns {boolean}
   */
  get direct_decode() {
    const ret = wasm.tiffresult_direct_decode(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @returns {number}
   */
  get sample_format() {
    const ret = wasm.tiffresult_sample_format(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
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
  get rows_per_strip() {
    const ret = wasm.tiffresult_rows_per_strip(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  get timing_pack_ms() {
    const ret = wasm.tiffresult_timing_pack_ms(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get bits_per_sample() {
    const ret = wasm.tiffresult_bits_per_sample(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
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
  get timing_stats_ms() {
    const ret = wasm.tiffresult_timing_stats_ms(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {Float32Array}
   */
  take_data_as_f32() {
    const ret = wasm.tiffresult_take_data_as_f32(this.__wbg_ptr);
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
  /**
   * @returns {number}
   */
  get timing_decode_ms() {
    const ret = wasm.decodedarray_valid_count(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get timing_convert_ms() {
    const ret = wasm.imagestats_total_count(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get timing_metadata_ms() {
    const ret = wasm.decodedarray_non_finite_count(this.__wbg_ptr);
    return ret;
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
  get strip_byte_count_max() {
    const ret = wasm.tiffresult_strip_byte_count_max(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get strip_byte_count_total() {
    const ret = wasm.tiffresult_strip_byte_count_total(this.__wbg_ptr);
    return ret;
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
    const ret = wasm.decodedarray_source_data_offset(this.__wbg_ptr);
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
   * @returns {string}
   */
  get ome_xml() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.tiffresult_ome_xml(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
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
    const ret = wasm.decodedarray_data_max(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  get min_value() {
    const ret = wasm.decodedarray_data_min(this.__wbg_ptr);
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
var TiffStripMetadataJsFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_tiffstripmetadatajs_free(ptr >>> 0, 1));
var TiffStripMetadataJs = class _TiffStripMetadataJs {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(_TiffStripMetadataJs.prototype);
    obj.__wbg_ptr = ptr;
    TiffStripMetadataJsFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    TiffStripMetadataJsFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_tiffstripmetadatajs_free(ptr, 0);
  }
  /**
   * @returns {number}
   */
  get page_count() {
    const ret = wasm.histogramresult_non_finite_count(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {string}
   */
  get all_tags_json() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.tiffstripmetadatajs_all_tags_json(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  /**
   * @returns {number}
   */
  get photometric_interpretation() {
    const ret = wasm.tifffloatstripplanjs_height(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {string}
   */
  get ome_xml() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.tiffstripmetadatajs_ome_xml(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
};
if (Symbol.dispose) TiffStripMetadataJs.prototype[Symbol.dispose] = TiffStripMetadataJs.prototype.free;
var EXPECTED_RESPONSE_TYPES = /* @__PURE__ */ new Set(["basic", "cors", "default"]);
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
  imports.wbg.__wbg_length_4126f257d88ef51e = function(arg0) {
    const ret = arg0.length;
    return ret;
  };
  imports.wbg.__wbg_length_58bec3c3f0487eb5 = function(arg0) {
    const ret = arg0.length;
    return ret;
  };
  imports.wbg.__wbg_length_69bca3cb64fc8748 = function(arg0) {
    const ret = arg0.length;
    return ret;
  };
  imports.wbg.__wbg_new_8a6f238a6ece86ea = function() {
    const ret = new Error();
    return ret;
  };
  imports.wbg.__wbg_now_793306c526e2e3b6 = function() {
    const ret = Date.now();
    return ret;
  };
  imports.wbg.__wbg_set_7a75d83ea249c6e0 = function(arg0, arg1, arg2) {
    arg0.set(getArrayU16FromWasm0(arg1, arg2));
  };
  imports.wbg.__wbg_set_9e6516df7b7d0f19 = function(arg0, arg1, arg2) {
    arg0.set(getArrayU8FromWasm0(arg1, arg2));
  };
  imports.wbg.__wbg_set_eaa55bcb7597ecca = function(arg0, arg1, arg2) {
    arg0.set(getArrayF32FromWasm0(arg1, arg2));
  };
  imports.wbg.__wbg_stack_0ed75d68575b0f3c = function(arg0, arg1) {
    const ret = arg1.stack;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
  };
  imports.wbg.__wbg_subarray_480600f3d6a9f26c = function(arg0, arg1, arg2) {
    const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
    return ret;
  };
  imports.wbg.__wbg_subarray_b24c6237257bcd4d = function(arg0, arg1, arg2) {
    const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
    return ret;
  };
  imports.wbg.__wbg_subarray_e9ae4d887d066081 = function(arg0, arg1, arg2) {
    const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
    return ret;
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
  cachedFloat64ArrayMemory0 = null;
  cachedInt32ArrayMemory0 = null;
  cachedUint16ArrayMemory0 = null;
  cachedUint32ArrayMemory0 = null;
  cachedUint8ArrayMemory0 = null;
  wasm.__wbindgen_start();
  return wasm;
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
var tiff_wasm_default = __wbg_init;

// media/strip-decode-worker.ts
var ready = null;
self.onmessage = async (event) => {
  const message = event.data;
  if (message?.type === "init") {
    try {
      ready = tiff_wasm_default({ module_or_path: message.tiffWasmModule || message.tiffWasmBuffer });
      await ready;
      self.postMessage({ type: "ready" });
    } catch (error) {
      self.postMessage({ type: "ready", error: String(error?.message || error) });
    }
    return;
  }
  const job = message;
  try {
    await ready;
    const started = performance.now();
    if (job.kind === "exr-zip") {
      const bytes = decode_exr_zip_f32_blocks(
        new Uint8Array(job.blob),
        new Uint32Array(job.counts),
        new Uint32Array(job.rows),
        job.width
      );
      const samples2 = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      let min2 = Infinity;
      let max2 = -Infinity;
      let sawNonFinite2 = false;
      for (let index = 0; index < samples2.length; index++) {
        const value = samples2[index];
        if (value < min2) {
          min2 = value;
        }
        if (value > max2) {
          max2 = value;
        }
        if (!Number.isFinite(value)) {
          sawNonFinite2 = true;
        }
      }
      if (sawNonFinite2 || !Number.isFinite(min2) || !Number.isFinite(max2)) {
        min2 = Infinity;
        max2 = -Infinity;
        for (let index = 0; index < samples2.length; index++) {
          const value = samples2[index];
          if (Number.isFinite(value)) {
            if (value < min2) {
              min2 = value;
            }
            if (value > max2) {
              max2 = value;
            }
          }
        }
      }
      self.postMessage(
        { id: job.id, samples: samples2, min: min2, max: max2, ms: performance.now() - started },
        [bytes.buffer]
      );
      return;
    }
    if (job.raw) {
      const bytes = decode_tiff_strip_range_raw(
        new Uint8Array(job.blob),
        new Uint32Array(job.counts),
        job.firstStrip,
        job.width,
        job.height,
        job.channels,
        job.bitsPerSample,
        job.compression,
        job.rowsPerStrip,
        job.predictor,
        job.sampleFormat,
        job.littleEndian,
        job.tileWidth || 0,
        job.tileLength || 0,
        job.blocksAcross || 1,
        job.lercAdditionalCompression || 0
      );
      const view = job.bitsPerSample === 8 ? bytes : job.sampleFormat === 3 ? new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4) : new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      let rmin = Infinity;
      let rmax = -Infinity;
      let nonFinite = false;
      for (let i = 0; i < view.length; i++) {
        const value = view[i];
        if (value < rmin) {
          rmin = value;
        }
        if (value > rmax) {
          rmax = value;
        }
        if (value !== value) {
          nonFinite = true;
        }
      }
      if (nonFinite || !Number.isFinite(rmin) || !Number.isFinite(rmax)) {
        rmin = Infinity;
        rmax = -Infinity;
        for (let i = 0; i < view.length; i++) {
          const value = view[i];
          if (Number.isFinite(value)) {
            if (value < rmin) {
              rmin = value;
            }
            if (value > rmax) {
              rmax = value;
            }
          }
        }
      }
      self.postMessage(
        { id: job.id, samples: view, min: rmin, max: rmax, ms: performance.now() - started },
        [bytes.buffer]
      );
      return;
    }
    const samples = decode_tiff_float_strip_range(
      new Uint8Array(job.blob),
      new Uint32Array(job.counts),
      job.firstStrip,
      job.width,
      job.height,
      job.channels,
      job.bitsPerSample,
      job.compression,
      job.rowsPerStrip,
      job.predictor,
      job.sampleFormat,
      job.littleEndian,
      job.tileWidth || 0,
      job.tileLength || 0,
      job.blocksAcross || 1,
      job.lercAdditionalCompression || 0
    );
    let min = Infinity;
    let max = -Infinity;
    let sawNonFinite = false;
    for (let i = 0; i < samples.length; i++) {
      const value = samples[i];
      if (value < min) {
        min = value;
      }
      if (value > max) {
        max = value;
      }
      if (value !== value) {
        sawNonFinite = true;
      }
    }
    if (sawNonFinite || !Number.isFinite(min) || !Number.isFinite(max)) {
      min = Infinity;
      max = -Infinity;
      for (let i = 0; i < samples.length; i++) {
        const value = samples[i];
        if (Number.isFinite(value)) {
          if (value < min) {
            min = value;
          }
          if (value > max) {
            max = value;
          }
        }
      }
    }
    self.postMessage(
      { id: job.id, samples, min, max, ms: performance.now() - started },
      [samples.buffer]
    );
  } catch (error) {
    self.postMessage({ id: job.id, error: String(error?.message || error) });
  }
};
//# sourceMappingURL=stripDecodeWorker.bundle.js.map

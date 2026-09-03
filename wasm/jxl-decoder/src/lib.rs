//! JavaScript-facing adapter for JPEG XL, built as a SEPARATE WebAssembly
//! module from `wasm/tiff-decoder`.
//!
//! jxl-rs is by a wide margin the largest decoder in the tree. Linking it into
//! the main module would grow the module every TIFF, EXR, DICOM and NumPy open
//! already downloads, to the benefit of one format. So it lives here instead,
//! and `media/modules/jxl-processor.ts` fetches this module the first time a
//! `.jxl` file or an embedded JPEG XL codestream is opened and never otherwise.
//! The shared TIFF and DICOM parsers are compiled here as well, so containers
//! are retried whole and cannot drift from the core parser.
//!
//! Like `wasm/tiff-decoder/src/decoder_bindings.rs`, this stays boring: all
//! parsing lives in `scientific-image-decoders`.

use scientific_image_decoders as core;
use wasm_bindgen::prelude::*;

/// The decoded image, shaped so `assembleDecoded` in
/// `media/modules/wasm-decoders.ts` can read it unchanged.
///
/// It is deliberately NARROWER than the main module's `DecodedArray`: JPEG XL
/// always arrives here as f32 samples (`sample_kind` 0) built inside the
/// decoder, so the u8/u16 carriers and the zero-copy `can_reuse_source` path —
/// which exist for formats whose bytes are already a JavaScript TypedArray —
/// have nothing to do. Exposing stubs for them would only invite a caller to
/// believe in a fast path that is not there.
#[wasm_bindgen]
pub struct JxlDecoded {
    inner: core::DecodedArray,
}

#[wasm_bindgen]
impl JxlDecoded {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.inner.width()
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.inner.height()
    }
    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 {
        self.inner.channels()
    }
    #[wasm_bindgen(getter)]
    pub fn bits_per_sample(&self) -> u32 {
        self.inner.bits_per_sample()
    }
    #[wasm_bindgen(getter)]
    pub fn sample_format(&self) -> u32 {
        self.inner.sample_format()
    }
    #[wasm_bindgen(getter)]
    pub fn type_min(&self) -> f64 {
        self.inner.type_min()
    }
    #[wasm_bindgen(getter)]
    pub fn type_max(&self) -> f64 {
        self.inner.type_max()
    }
    #[wasm_bindgen(getter)]
    pub fn source_numeric_type(&self) -> String {
        self.inner.source_numeric_type()
    }
    /// Always 0 (f32) — see the note on the struct.
    #[wasm_bindgen(getter)]
    pub fn sample_kind(&self) -> u32 {
        self.inner.sample_kind()
    }
    #[wasm_bindgen(getter)]
    pub fn format_label(&self) -> String {
        self.inner.format_label()
    }
    #[wasm_bindgen(getter)]
    pub fn metadata_json(&self) -> String {
        self.inner.metadata_json()
    }
    #[wasm_bindgen(getter)]
    pub fn data_min(&self) -> f64 {
        self.inner.data_min()
    }
    #[wasm_bindgen(getter)]
    pub fn data_max(&self) -> f64 {
        self.inner.data_max()
    }
    #[wasm_bindgen(getter)]
    pub fn non_finite_count(&self) -> f64 {
        self.inner.non_finite_count()
    }
    #[wasm_bindgen(getter)]
    pub fn valid_count(&self) -> f64 {
        self.inner.valid_count()
    }
    #[wasm_bindgen(getter)]
    pub fn data_len(&self) -> usize {
        self.inner.data_len()
    }

    /// ONE-SHOT, exactly like the main module's `take_data_as_f32`: the samples
    /// are moved out, and a second call throws.
    pub fn take_data_as_f32(&mut self) -> Result<Vec<f32>, JsValue> {
        self.inner
            .take_data_as_f32()
            .map_err(|e| JsValue::from_str(e.message()))
    }
}

#[wasm_bindgen]
pub fn decode_jxl_fast(data: &[u8]) -> Result<JxlDecoded, JsValue> {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
    core::decode_jxl_fast(data)
        .map(|inner| JxlDecoded { inner })
        .map_err(|e| JsValue::from_str(e.message()))
}

#[wasm_bindgen]
pub fn decode_dicom_fast(data: &[u8], frame_index: u32) -> Result<JxlDecoded, JsValue> {
    core::decode_dicom_fast(data, frame_index)
        .map(|inner| JxlDecoded { inner })
        .map_err(|e| JsValue::from_str(e.message()))
}

/// TIFF result contract mirrored from the main adapter. Keeping the container
/// whole preserves orientation, tags, page navigation, and OME/Geo metadata.
#[wasm_bindgen]
pub struct TiffResult {
    inner: core::TiffResult,
}

#[wasm_bindgen]
impl TiffResult {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.inner.width()
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.inner.height()
    }
    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 {
        self.inner.channels()
    }
    #[wasm_bindgen(getter)]
    pub fn bits_per_sample(&self) -> u32 {
        self.inner.bits_per_sample()
    }
    #[wasm_bindgen(getter)]
    pub fn sample_format(&self) -> u32 {
        self.inner.sample_format()
    }
    #[wasm_bindgen(getter)]
    pub fn sample_kind(&self) -> u32 {
        self.inner.sample_kind()
    }
    #[wasm_bindgen(getter)]
    pub fn data_len(&self) -> usize {
        self.inner.data_len()
    }
    #[wasm_bindgen(getter)]
    pub fn min_value(&self) -> f64 {
        self.inner.min_value()
    }
    #[wasm_bindgen(getter)]
    pub fn max_value(&self) -> f64 {
        self.inner.max_value()
    }
    #[wasm_bindgen(getter)]
    pub fn compression(&self) -> u32 {
        self.inner.compression()
    }
    #[wasm_bindgen(getter)]
    pub fn predictor(&self) -> u32 {
        self.inner.predictor()
    }
    #[wasm_bindgen(getter)]
    pub fn photometric_interpretation(&self) -> u32 {
        self.inner.photometric_interpretation()
    }
    #[wasm_bindgen(getter)]
    pub fn planar_configuration(&self) -> u32 {
        self.inner.planar_configuration()
    }
    #[wasm_bindgen(getter)]
    pub fn rows_per_strip(&self) -> u32 {
        self.inner.rows_per_strip()
    }
    #[wasm_bindgen(getter)]
    pub fn strip_count(&self) -> u32 {
        self.inner.strip_count()
    }
    #[wasm_bindgen(getter)]
    pub fn strip_byte_count_total(&self) -> f64 {
        self.inner.strip_byte_count_total()
    }
    #[wasm_bindgen(getter)]
    pub fn strip_byte_count_max(&self) -> f64 {
        self.inner.strip_byte_count_max()
    }
    #[wasm_bindgen(getter)]
    pub fn tile_width(&self) -> u32 {
        self.inner.tile_width()
    }
    #[wasm_bindgen(getter)]
    pub fn tile_length(&self) -> u32 {
        self.inner.tile_length()
    }
    #[wasm_bindgen(getter)]
    pub fn tile_count(&self) -> u32 {
        self.inner.tile_count()
    }
    #[wasm_bindgen(getter)]
    pub fn direct_decode(&self) -> bool {
        self.inner.direct_decode()
    }
    #[wasm_bindgen(getter)]
    pub fn ome_xml(&self) -> String {
        self.inner.ome_xml()
    }
    #[wasm_bindgen(getter)]
    pub fn geo_json(&self) -> String {
        self.inner.geo_json()
    }
    #[wasm_bindgen(getter)]
    pub fn page_directory_json(&self) -> String {
        self.inner.page_directory_json()
    }
    #[wasm_bindgen(getter)]
    pub fn all_tags_json(&self) -> String {
        self.inner.all_tags_json()
    }
    pub fn get_data_as_f32(&self) -> Vec<f32> {
        self.inner.get_data_as_f32()
    }
    pub fn take_data_as_f32(&mut self) -> Vec<f32> {
        self.inner.take_data_as_f32()
    }
    pub fn take_data_as_u8(&mut self) -> Vec<u8> {
        self.inner.take_data_as_u8()
    }
}

fn tiff_result(result: Result<core::TiffResult, core::DecodeError>) -> Result<TiffResult, JsValue> {
    result
        .map(|inner| TiffResult { inner })
        .map_err(|e| JsValue::from_str(e.message()))
}

#[wasm_bindgen]
pub fn decode_tiff(data: &[u8]) -> Result<TiffResult, JsValue> {
    tiff_result(core::decode_tiff(data))
}

#[wasm_bindgen]
pub fn decode_tiff_fast(data: &[u8]) -> Result<TiffResult, JsValue> {
    tiff_result(core::decode_tiff_fast(data))
}

#[wasm_bindgen]
pub fn decode_tiff_page(data: &[u8], page_index: u32) -> Result<TiffResult, JsValue> {
    tiff_result(core::decode_tiff_page(data, page_index))
}

#[wasm_bindgen]
pub fn decode_tiff_page_fast(data: &[u8], page_index: u32) -> Result<TiffResult, JsValue> {
    tiff_result(core::decode_tiff_page_fast(data, page_index))
}

#[wasm_bindgen]
pub fn tiff_page_count(data: &[u8]) -> Result<u32, JsValue> {
    core::tiff_page_count(data).map_err(|e| JsValue::from_str(e.message()))
}

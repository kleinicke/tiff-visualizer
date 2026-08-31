//! JavaScript-facing adapter for JPEG XL, built as a SEPARATE WebAssembly
//! module from `wasm/tiff-decoder`.
//!
//! jxl-rs is by a wide margin the largest decoder in the tree. Linking it into
//! the main module would grow the module every TIFF, EXR, DICOM and NumPy open
//! already downloads, to the benefit of one format. So it lives here instead,
//! and `media/modules/jxl-processor.ts` fetches this module the first time a
//! `.jxl` file is opened and never otherwise.
//!
//! The consequence to keep in mind: JPEG XL EMBEDDED in another container —
//! TIFF compression 50002, or a DICOM JPEG XL transfer syntax — is decoded
//! inside the main module and therefore still has no decoder. Supporting those
//! means either linking jxl-rs into the main module after all, or routing the
//! embedded codestream out to this one.
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

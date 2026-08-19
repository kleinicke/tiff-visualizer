//! JavaScript-facing adapter for `scientific-image-decoders`.
//!
//! Keep this module deliberately boring: it translates Rust errors to
//! `JsValue` and exposes the stable API expected by the extension. All byte
//! parsing and pixel decoding belongs in the dependency crate.

use scientific_image_decoders as core;
use wasm_bindgen::prelude::*;

fn prepare() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

fn js_error(error: core::DecodeError) -> JsValue {
    JsValue::from_str(error.message())
}

#[wasm_bindgen]
pub struct DecodedArray {
    inner: core::DecodedArray,
}

impl From<core::DecodedArray> for DecodedArray {
    fn from(inner: core::DecodedArray) -> Self {
        Self { inner }
    }
}

#[wasm_bindgen]
impl DecodedArray {
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
    #[wasm_bindgen(getter)]
    pub fn source_data_offset(&self) -> usize {
        self.inner.source_data_offset()
    }
    #[wasm_bindgen(getter)]
    pub fn can_reuse_source(&self) -> bool {
        self.inner.can_reuse_source()
    }
    pub fn discard_data(&mut self) {
        self.inner.discard_data();
    }

    /// Consume the decoded carrier while copying it directly into a
    /// JavaScript-owned buffer. Unlike returning `Vec<T>`, wasm-bindgen does
    /// not allocate a second JS typed array here; callers can reuse the source
    /// ArrayBuffer that was already transferred into the decode worker.
    pub fn copy_data_as_f32_into(&mut self, target: &js_sys::Float32Array) -> Result<(), JsValue> {
        let data = self.inner.take_data_as_f32().map_err(js_error)?;
        if target.length() < data.len() as u32 {
            return Err(JsValue::from_str(
                "Float32 target is smaller than decoded data",
            ));
        }
        target.subarray(0, data.len() as u32).copy_from(&data);
        Ok(())
    }

    pub fn copy_data_as_u8_into(&mut self, target: &js_sys::Uint8Array) -> Result<(), JsValue> {
        let data = self.inner.take_data_as_u8().map_err(js_error)?;
        if target.length() < data.len() as u32 {
            return Err(JsValue::from_str(
                "Uint8 target is smaller than decoded data",
            ));
        }
        target.subarray(0, data.len() as u32).copy_from(&data);
        Ok(())
    }

    pub fn copy_data_as_u16_into(&mut self, target: &js_sys::Uint16Array) -> Result<(), JsValue> {
        let data = self.inner.take_data_as_u16().map_err(js_error)?;
        if target.length() < data.len() as u32 {
            return Err(JsValue::from_str(
                "Uint16 target is smaller than decoded data",
            ));
        }
        target.subarray(0, data.len() as u32).copy_from(&data);
        Ok(())
    }

    pub fn take_data_as_f32(&mut self) -> Result<Vec<f32>, JsValue> {
        self.inner.take_data_as_f32().map_err(js_error)
    }

    pub fn take_data_as_u8(&mut self) -> Result<Vec<u8>, JsValue> {
        self.inner.take_data_as_u8().map_err(js_error)
    }

    pub fn take_data_as_u16(&mut self) -> Result<Vec<u16>, JsValue> {
        self.inner.take_data_as_u16().map_err(js_error)
    }
}

#[wasm_bindgen]
pub struct JpegResult {
    inner: core::JpegResult,
}

#[wasm_bindgen]
impl JpegResult {
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
    pub fn take_data_as_u8(&mut self) -> Vec<u8> {
        self.inner.take_data_as_u8()
    }
}

#[wasm_bindgen]
pub struct HdrResult {
    inner: core::HdrResult,
}

#[wasm_bindgen]
impl HdrResult {
    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 {
        self.inner.channels()
    }
    #[wasm_bindgen(getter)]
    pub fn all_tags_json(&self) -> String {
        self.inner.all_tags_json()
    }
    pub fn take_data_as_f32(&mut self) -> Vec<f32> {
        self.inner.take_data_as_f32()
    }
    pub fn take_metadata_as_f64(&mut self) -> Vec<f64> {
        self.inner.take_metadata_as_f64()
    }
}

#[wasm_bindgen]
pub struct PngResult {
    inner: core::PngResult,
}

#[wasm_bindgen]
impl PngResult {
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
    pub fn bit_depth(&self) -> u32 {
        self.inner.bit_depth()
    }
    #[wasm_bindgen(getter)]
    pub fn color_type(&self) -> u32 {
        self.inner.color_type()
    }
    #[wasm_bindgen(getter)]
    pub fn timing_read_info_ms(&self) -> f64 {
        self.inner.timing_read_info_ms()
    }
    #[wasm_bindgen(getter)]
    pub fn timing_decode_ms(&self) -> f64 {
        self.inner.timing_decode_ms()
    }
    #[wasm_bindgen(getter)]
    pub fn timing_convert_ms(&self) -> f64 {
        self.inner.timing_convert_ms()
    }
    #[wasm_bindgen(getter)]
    pub fn timing_total_ms(&self) -> f64 {
        self.inner.timing_total_ms()
    }
    pub fn take_data_as_u16(&mut self) -> Vec<u16> {
        self.inner.take_data_as_u16()
    }
}

#[wasm_bindgen]
pub struct ExrResult {
    inner: core::ExrResult,
}

#[wasm_bindgen]
impl ExrResult {
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
    pub fn channel_names_csv(&self) -> String {
        self.inner.channel_names_csv()
    }
    #[wasm_bindgen(getter)]
    pub fn displayed_channels_csv(&self) -> String {
        self.inner.displayed_channels_csv()
    }
    #[wasm_bindgen(getter)]
    pub fn format(&self) -> u32 {
        self.inner.format()
    }
    #[wasm_bindgen(getter)]
    pub fn data_type(&self) -> u32 {
        self.inner.data_type()
    }
    #[wasm_bindgen(getter)]
    pub fn timing_read_ms(&self) -> f64 {
        self.inner.timing_read_ms()
    }
    #[wasm_bindgen(getter)]
    pub fn timing_pack_ms(&self) -> f64 {
        self.inner.timing_pack_ms()
    }
    #[wasm_bindgen(getter)]
    pub fn timing_total_ms(&self) -> f64 {
        self.inner.timing_total_ms()
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
    pub fn all_tags_json(&self) -> String {
        self.inner.all_tags_json()
    }
    pub fn take_data_as_f32(&mut self) -> Vec<f32> {
        self.inner.take_data_as_f32()
    }
}

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
    pub fn min_value(&self) -> f64 {
        self.inner.min_value()
    }
    #[wasm_bindgen(getter)]
    pub fn max_value(&self) -> f64 {
        self.inner.max_value()
    }
    #[wasm_bindgen(getter)]
    pub fn timing_metadata_ms(&self) -> f64 {
        self.inner.timing_metadata_ms()
    }
    #[wasm_bindgen(getter)]
    pub fn timing_decode_ms(&self) -> f64 {
        self.inner.timing_decode_ms()
    }
    #[wasm_bindgen(getter)]
    pub fn timing_convert_ms(&self) -> f64 {
        self.inner.timing_convert_ms()
    }
    #[wasm_bindgen(getter)]
    pub fn timing_stats_ms(&self) -> f64 {
        self.inner.timing_stats_ms()
    }
    #[wasm_bindgen(getter)]
    pub fn timing_pack_ms(&self) -> f64 {
        self.inner.timing_pack_ms()
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
    pub fn all_tags_json(&self) -> String {
        self.inner.all_tags_json()
    }
    pub fn get_data_bytes(&self) -> Vec<u8> {
        self.inner.get_data_bytes()
    }
    pub fn get_data_as_f32(&self) -> Vec<f32> {
        self.inner.get_data_as_f32()
    }
    pub fn take_data_as_f32(&mut self) -> Vec<f32> {
        self.inner.take_data_as_f32()
    }
}

#[wasm_bindgen]
pub struct DemosaicResult {
    inner: core::DemosaicResult,
}

#[wasm_bindgen]
impl DemosaicResult {
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
    pub fn gain_r(&self) -> f32 {
        self.inner.gain_r()
    }
    #[wasm_bindgen(getter)]
    pub fn gain_g(&self) -> f32 {
        self.inner.gain_g()
    }
    #[wasm_bindgen(getter)]
    pub fn gain_b(&self) -> f32 {
        self.inner.gain_b()
    }
    pub fn take_data(&mut self) -> Vec<f32> {
        self.inner.take_data()
    }
}

#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn demosaic(
    data: &[f32],
    width: u32,
    height: u32,
    pattern: &str,
    algorithm: &str,
    offset_x: u32,
    offset_y: u32,
    black: f32,
    white: f32,
    auto_wb: bool,
    gain_r: f32,
    gain_g: f32,
    gain_b: f32,
) -> Result<DemosaicResult, JsValue> {
    core::demosaic(
        data, width, height, pattern, algorithm, offset_x, offset_y, black, white, auto_wb, gain_r,
        gain_g, gain_b,
    )
    .map(|inner| DemosaicResult { inner })
    .map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_jpeg_fast(data: &[u8]) -> Result<JpegResult, JsValue> {
    prepare();
    core::decode_jpeg_fast(data)
        .map(|inner| JpegResult { inner })
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_tiff(data: &[u8]) -> Result<TiffResult, JsValue> {
    prepare();
    core::decode_tiff(data)
        .map(|inner| TiffResult { inner })
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn tiff_page_count(data: &[u8]) -> Result<u32, JsValue> {
    core::tiff_page_count(data).map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_tiff_page(data: &[u8], page_index: u32) -> Result<TiffResult, JsValue> {
    prepare();
    core::decode_tiff_page(data, page_index)
        .map(|inner| TiffResult { inner })
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn extract_exif_tags(data: &[u8]) -> String {
    core::extract_exif_tags(data)
}

#[wasm_bindgen]
pub fn decode_tiff_fast(data: &[u8]) -> Result<TiffResult, JsValue> {
    prepare();
    core::decode_tiff_fast(data)
        .map(|inner| TiffResult { inner })
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_tiff_page_fast(data: &[u8], page_index: u32) -> Result<TiffResult, JsValue> {
    prepare();
    core::decode_tiff_page_fast(data, page_index)
        .map(|inner| TiffResult { inner })
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_exr_fast(data: &[u8]) -> Result<ExrResult, JsValue> {
    prepare();
    core::decode_exr_fast(data)
        .map(|inner| ExrResult { inner })
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_png16_fast(data: &[u8]) -> Result<PngResult, JsValue> {
    prepare();
    core::decode_png16_fast(data)
        .map(|inner| PngResult { inner })
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_hdr_fast(data: &[u8]) -> Result<HdrResult, JsValue> {
    prepare();
    core::decode_hdr_fast(data)
        .map(|inner| HdrResult { inner })
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_pfm_fast(data: &[u8], top_down: bool) -> Result<DecodedArray, JsValue> {
    prepare();
    core::decode_pfm_fast(data, top_down)
        .map(Into::into)
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_pfm_display_fast(data: &[u8], top_down: bool) -> Result<DecodedArray, JsValue> {
    prepare();
    core::decode_pfm_display_fast(data, top_down)
        .map(Into::into)
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_ppm_fast(data: &[u8]) -> Result<DecodedArray, JsValue> {
    prepare();
    core::decode_ppm_fast(data)
        .map(Into::into)
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_ppm_display_fast(data: Vec<u8>) -> Result<DecodedArray, JsValue> {
    prepare();
    core::decode_ppm_display_owned(data)
        .map(Into::into)
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_npy_fast(data: &[u8]) -> Result<DecodedArray, JsValue> {
    prepare();
    core::decode_npy_fast(data)
        .map(Into::into)
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_npy_display_fast(data: &[u8]) -> Result<DecodedArray, JsValue> {
    prepare();
    core::decode_npy_display_fast(data)
        .map(Into::into)
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_fits_fast(data: &[u8]) -> Result<DecodedArray, JsValue> {
    prepare();
    core::decode_fits_fast(data)
        .map(Into::into)
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_netcdf_fast(data: &[u8], options_json: &str) -> Result<DecodedArray, JsValue> {
    prepare();
    core::decode_netcdf_fast(data, options_json)
        .map(Into::into)
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_dicom_fast(data: &[u8], frame_index: u32) -> Result<DecodedArray, JsValue> {
    prepare();
    core::decode_dicom_fast(data, frame_index)
        .map(Into::into)
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_czi_fast(data: &[u8], options_json: &str) -> Result<DecodedArray, JsValue> {
    prepare();
    core::decode_czi_fast(data, options_json)
        .map(Into::into)
        .map_err(js_error)
}

// --- Strip-parallel decoding of predictor-3 float TIFFs ---------------------
//
// `tiff_float_strip_plan` is called once (cheap: it only parses the IFD) to
// learn the strip layout. The caller then slices the file per worker and each
// worker calls `decode_tiff_float_strip_range` with just its own strips.

#[wasm_bindgen]
pub struct TiffFloatStripPlanJs {
    inner: core::TiffFloatStripPlan,
}

#[wasm_bindgen]
impl TiffFloatStripPlanJs {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.inner.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.inner.height
    }
    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 {
        self.inner.channels
    }
    #[wasm_bindgen(getter)]
    pub fn bits_per_sample(&self) -> u32 {
        self.inner.bits_per_sample
    }
    #[wasm_bindgen(getter)]
    pub fn compression(&self) -> u32 {
        self.inner.compression
    }
    #[wasm_bindgen(getter)]
    pub fn rows_per_strip(&self) -> u32 {
        self.inner.rows_per_strip
    }
    #[wasm_bindgen(getter)]
    pub fn predictor(&self) -> u32 {
        self.inner.predictor
    }
    #[wasm_bindgen(getter)]
    pub fn sample_format(&self) -> u32 {
        self.inner.sample_format
    }
    #[wasm_bindgen(getter)]
    pub fn little_endian(&self) -> bool {
        self.inner.little_endian
    }
    #[wasm_bindgen(getter)]
    pub fn strip_count(&self) -> u32 {
        self.inner.offsets.len() as u32
    }
    /// Strip byte offsets as f64 (exact for any offset below 2^53, which covers
    /// BigTIFF in practice and avoids BigInt64Array plumbing on the JS side).
    #[wasm_bindgen(getter)]
    pub fn offsets(&self) -> Vec<f64> {
        self.inner.offsets.iter().map(|v| *v as f64).collect()
    }
    #[wasm_bindgen(getter)]
    pub fn counts(&self) -> Vec<f64> {
        self.inner.counts.iter().map(|v| *v as f64).collect()
    }
}

#[wasm_bindgen]
pub fn tiff_float_strip_plan(data: &[u8]) -> Option<TiffFloatStripPlanJs> {
    core::tiff_float_strip_plan(data).map(|inner| TiffFloatStripPlanJs { inner })
}

/// Decode strips `[first_strip, first_strip + counts.len())`.
///
/// `blob` is those strips' compressed bytes concatenated in order; `counts`
/// their individual lengths. The geometry arguments come from the plan.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn decode_tiff_float_strip_range(
    blob: &[u8],
    counts: &[u32],
    first_strip: u32,
    width: u32,
    height: u32,
    channels: u32,
    bits_per_sample: u32,
    compression: u32,
    rows_per_strip: u32,
    predictor: u32,
    sample_format: u32,
    little_endian: bool,
) -> Result<Vec<f32>, JsValue> {
    let plan = core::TiffFloatStripPlan {
        width,
        height,
        channels,
        bits_per_sample,
        compression,
        predictor,
        sample_format,
        little_endian,
        rows_per_strip,
        offsets: Vec::new(),
        counts: Vec::new(),
    };
    core::decode_tiff_float_strip_range(blob, counts, first_strip, &plan)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub struct TiffStripMetadataJs {
    inner: core::TiffStripMetadata,
}

#[wasm_bindgen]
impl TiffStripMetadataJs {
    #[wasm_bindgen(getter)]
    pub fn page_count(&self) -> u32 {
        self.inner.page_count
    }
    #[wasm_bindgen(getter)]
    pub fn photometric_interpretation(&self) -> u32 {
        self.inner.photometric_interpretation
    }
    #[wasm_bindgen(getter)]
    pub fn all_tags_json(&self) -> String {
        self.inner.all_tags_json.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn ome_xml(&self) -> String {
        self.inner.ome_xml.clone()
    }
}

/// Tags and page count for a strip-parallel decode. Parses the IFD only — the
/// pixels come from `decode_tiff_float_strip_range` on the worker pool.
#[wasm_bindgen]
pub fn tiff_strip_metadata(data: &[u8]) -> Result<TiffStripMetadataJs, JsValue> {
    core::tiff_strip_metadata(data)
        .map(|inner| TiffStripMetadataJs { inner })
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Like `decode_tiff_float_strip_range`, but returns native little-endian
/// sample bytes so the caller can wrap them in the carrier type its pipeline
/// expects with no conversion pass.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn decode_tiff_strip_range_raw(
    blob: &[u8],
    counts: &[u32],
    first_strip: u32,
    width: u32,
    height: u32,
    channels: u32,
    bits_per_sample: u32,
    compression: u32,
    rows_per_strip: u32,
    predictor: u32,
    sample_format: u32,
    little_endian: bool,
) -> Result<Vec<u8>, JsValue> {
    let plan = core::TiffFloatStripPlan {
        width,
        height,
        channels,
        bits_per_sample,
        compression,
        predictor,
        sample_format,
        little_endian,
        rows_per_strip,
        offsets: Vec::new(),
        counts: Vec::new(),
    };
    core::decode_tiff_strip_range_raw(blob, counts, first_strip, &plan)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

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
    /// GeoTIFF georeferencing as JSON — the unpacked key directory's CRS plus
    /// the raster-to-model transform. Empty for a TIFF that carries none.
    #[wasm_bindgen(getter)]
    pub fn geo_json(&self) -> String {
        self.inner.geo_json()
    }
    /// What the file's other images are — pages, pyramid overviews, or masks —
    /// as JSON. Empty for a file with no readable directory. See
    /// `formats::tiff::pages`.
    #[wasm_bindgen(getter)]
    pub fn page_directory_json(&self) -> String {
        self.inner.page_directory_json()
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
    pub fn take_data_as_u8(&mut self) -> Vec<u8> {
        self.inner.take_data_as_u8()
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

/// One rectangle of one page, decoded on its own.
///
/// The cost follows the rectangle rather than the image, which is what lets a
/// viewport of a gigapixel scene be shown at full resolution. Returns an error
/// for layouts that are only decoded whole; the caller falls back to
/// `decode_tiff_page`.
#[wasm_bindgen]
pub struct TiffRegionJs {
    inner: core::TiffRegionResult,
}

#[wasm_bindgen]
impl TiffRegionJs {
    #[wasm_bindgen(getter)]
    pub fn x(&self) -> u32 {
        self.inner.region.x
    }
    #[wasm_bindgen(getter)]
    pub fn y(&self) -> u32 {
        self.inner.region.y
    }
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.inner.region.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.inner.region.height
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
    pub fn sample_format(&self) -> u32 {
        self.inner.sample_format
    }
    /// Strips or tiles actually read. The number a caller watches to confirm
    /// the cost is following the window and not the file.
    #[wasm_bindgen(getter)]
    pub fn blocks_decoded(&self) -> u32 {
        self.inner.blocks_decoded
    }
    /// Moves the samples out; a second call returns an empty array, as with the
    /// other decode results.
    pub fn take_data_as_f32(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.inner.data_f32)
    }
}

#[wasm_bindgen]
pub fn decode_tiff_region(
    data: &[u8],
    page_index: u32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<TiffRegionJs, JsValue> {
    prepare();
    core::decode_tiff_region(data, page_index, x, y, width, height)
        .map(|inner| TiffRegionJs { inner })
        .map_err(js_error)
}

/// A TIFF source retained inside WebAssembly for repeated viewport reads.
///
/// Passing `&[u8]` through wasm-bindgen copies the source into linear memory.
/// Keeping that copy here makes the cost occur once when an image is opened,
/// rather than once per tile (which is prohibitive for large local COGs).
#[wasm_bindgen]
pub struct TiffRegionDecoder {
    data: Vec<u8>,
}

#[wasm_bindgen]
impl TiffRegionDecoder {
    #[wasm_bindgen(constructor)]
    pub fn new(data: &[u8]) -> Self {
        prepare();
        Self {
            data: data.to_vec(),
        }
    }

    pub fn decode(
        &self,
        page_index: u32,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    ) -> Result<TiffRegionJs, JsValue> {
        core::decode_tiff_region(&self.data, page_index, x, y, width, height)
            .map(|inner| TiffRegionJs { inner })
            .map_err(js_error)
    }
}

/// Whether a page can be served a region at a time, without decoding anything.
#[wasm_bindgen]
pub fn tiff_region_decode_available(data: &[u8], page_index: u32) -> bool {
    core::tiff_region_decode_available(data, page_index)
}

/// Classify every image in a TIFF's IFD chain without decoding pixels. Used
/// when a page directory is wanted for a file that was not decoded through
/// this module (or before deciding which page to decode).
#[wasm_bindgen]
pub fn tiff_page_directory(data: &[u8]) -> String {
    core::tiff_page_directory_json(data)
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

/// Metadata plus the independently compressed scanline blocks for the common
/// single-channel Float32 ZIP16 EXR layout. `None` means the caller must use
/// the full compatibility decoder.
#[wasm_bindgen]
pub struct ExrZipPlanJs {
    inner: core::ExrZipPlan,
}

#[wasm_bindgen]
impl ExrZipPlanJs {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.inner.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.inner.height
    }
    #[wasm_bindgen(getter)]
    pub fn data_y(&self) -> i32 {
        self.inner.data_y
    }
    #[wasm_bindgen(getter)]
    pub fn channel_name(&self) -> String {
        self.inner.channel_name.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn counts(&self) -> Vec<u32> {
        self.inner.counts.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn y_coordinates(&self) -> Vec<i32> {
        self.inner.y_coordinates.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn all_tags_json(&self) -> String {
        self.inner.all_tags_json.clone()
    }
    /// Move the compressed payload into JavaScript without retaining a second
    /// copy in the plan object.
    pub fn take_compressed(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.inner.compressed)
    }
}

#[wasm_bindgen]
pub fn exr_zip_f32_plan(data: &[u8]) -> Result<Option<ExrZipPlanJs>, JsValue> {
    prepare();
    core::exr_zip_f32_plan(data)
        .map(|plan| plan.map(|inner| ExrZipPlanJs { inner }))
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_exr_zip_f32_blocks(
    blob: &[u8],
    counts: &[u32],
    rows: &[u32],
    width: u32,
) -> Result<Vec<u8>, JsValue> {
    core::decode_exr_zip_f32_blocks(blob, counts, rows, width)
        .map_err(|e| JsValue::from_str(&e.to_string()))
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

/// Standalone JPEG XR (`.jxr`, `.wdp`, `.hdp`). The TIFF path decodes the same
/// codestream under compression 34934; this reads the pixel format off the
/// codestream itself, there being no TIFF tags to describe it.
///
/// Present only in the codec module: the decoder is 189 KiB and no other
/// format in the core build needs it.
#[cfg(feature = "heavy-codecs")]
#[wasm_bindgen]
pub fn decode_jpegxr_fast(data: &[u8]) -> Result<DecodedArray, JsValue> {
    prepare();
    core::decode_jpegxr_fast(data)
        .map(Into::into)
        .map_err(js_error)
}

/// Standalone JPEG 2000 (`.jp2`, `.jpf`, `.jpx`, `.j2k`, `.j2c`, `.jpc`). The
/// TIFF path decodes the same codestream under compression 34712; this reads
/// the geometry and precision off the codestream itself, there being no TIFF
/// tags to describe them.
///
/// Present only in the codec module, for the same reason as JPEG XR above: no
/// format in the core build needs the JPEG 2000 decoder.
#[cfg(feature = "heavy-codecs")]
#[wasm_bindgen]
pub fn decode_jpeg2000_fast(data: &[u8]) -> Result<DecodedArray, JsValue> {
    prepare();
    core::decode_jpeg2000_fast(data)
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

#[wasm_bindgen]
pub fn decode_nd2_fast(data: &[u8], options_json: &str) -> Result<DecodedArray, JsValue> {
    prepare();
    core::decode_nd2_fast(data, options_json)
        .map(Into::into)
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_lif_fast(data: &[u8], options_json: &str) -> Result<DecodedArray, JsValue> {
    prepare();
    core::decode_lif_fast(data, options_json)
        .map(Into::into)
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_sdt_fast(data: &[u8], options_json: &str) -> Result<DecodedArray, JsValue> {
    prepare();
    core::decode_sdt_fast(data, options_json)
        .map(Into::into)
        .map_err(js_error)
}

// --- Parallel decoding, one strip or tile ROW per unit of work -------------
//
// `tiff_float_strip_plan` is called once (cheap: it only parses the IFD) to
// learn the layout. The caller then slices the file per worker and each worker
// calls `decode_tiff_float_strip_range` with just its own units' blocks.
//
// A UNIT is a strip, or a whole tile row: both are full-width bands, so a
// worker's output drops into the image at one offset. `blocks_per_unit` says
// how many entries of `offsets`/`counts` each unit consumes.

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
    pub fn planar_configuration(&self) -> u32 {
        self.inner.planar_configuration
    }
    #[wasm_bindgen(getter)]
    pub fn orientation(&self) -> u32 {
        self.inner.orientation
    }
    #[wasm_bindgen(getter)]
    pub fn photometric_interpretation(&self) -> u32 {
        self.inner.photometric_interpretation
    }
    #[wasm_bindgen(getter)]
    pub fn little_endian(&self) -> bool {
        self.inner.little_endian
    }
    #[wasm_bindgen(getter)]
    pub fn tile_width(&self) -> u32 {
        self.inner.tile_width
    }
    #[wasm_bindgen(getter)]
    pub fn tile_length(&self) -> u32 {
        self.inner.tile_length
    }
    /// Blocks per unit of work: 1 for strips, one per tile column for tiles.
    #[wasm_bindgen(getter)]
    pub fn blocks_per_unit(&self) -> u32 {
        if self.inner.planar_configuration == 2 {
            self.inner.channels.max(1)
        } else if self.inner.tile_width > 0 && self.inner.tile_length > 0 {
            self.inner.blocks_across.max(1)
        } else {
            1
        }
    }
    #[wasm_bindgen(getter)]
    pub fn blocks_across(&self) -> u32 {
        self.inner.blocks_across
    }
    #[wasm_bindgen(getter)]
    pub fn lerc_additional_compression(&self) -> u32 {
        self.inner.lerc_additional_compression
    }
    /// Units of work, NOT blocks: tile rows for a tiled file.
    #[wasm_bindgen(getter)]
    pub fn strip_count(&self) -> u32 {
        (self.inner.offsets.len() as u32) / self.blocks_per_unit().max(1)
    }
    /// Blocks in the file, which is what `offsets`/`counts` list.
    #[wasm_bindgen(getter)]
    pub fn block_count(&self) -> u32 {
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

/// Decode the units `[first_strip, first_strip + counts.len() / blocks_per_unit)`.
///
/// `blob` is those units' blocks' compressed bytes concatenated in order;
/// `counts` their individual lengths, one entry per BLOCK. The geometry
/// arguments come from the plan; `tile_width`/`tile_length` are zero for a
/// stripped file, in which case a unit is one strip.
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
    planar_configuration: u32,
    orientation: u32,
    tile_width: u32,
    tile_length: u32,
    blocks_across: u32,
    lerc_additional_compression: u32,
    photometric_interpretation: u32,
) -> Result<Vec<f32>, JsValue> {
    let plan = core::TiffFloatStripPlan {
        width,
        height,
        channels,
        bits_per_sample,
        compression,
        predictor,
        sample_format,
        planar_configuration,
        orientation,
        photometric_interpretation,
        little_endian,
        rows_per_strip,
        tile_width,
        tile_length,
        blocks_across,
        lerc_additional_compression,
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
    #[wasm_bindgen(getter)]
    pub fn geo_json(&self) -> String {
        self.inner.geo_json.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn page_directory_json(&self) -> String {
        self.inner.page_directory_json.clone()
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
    planar_configuration: u32,
    orientation: u32,
    tile_width: u32,
    tile_length: u32,
    blocks_across: u32,
    lerc_additional_compression: u32,
    photometric_interpretation: u32,
) -> Result<Vec<u8>, JsValue> {
    let plan = core::TiffFloatStripPlan {
        width,
        height,
        channels,
        bits_per_sample,
        compression,
        predictor,
        sample_format,
        planar_configuration,
        orientation,
        photometric_interpretation,
        little_endian,
        rows_per_strip,
        tile_width,
        tile_length,
        blocks_across,
        lerc_additional_compression,
        offsets: Vec::new(),
        counts: Vec::new(),
    };
    core::decode_tiff_strip_range_raw(blob, counts, first_strip, &plan)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

//! Fast TIFF decoder for WebAssembly
//!
//! This library provides high-performance TIFF decoding for use in browser environments
//! through WebAssembly. It's designed to be a drop-in replacement for slow parts of
//! geotiff.js while maintaining compatibility with existing JavaScript code.

mod demosaic;
pub use demosaic::{demosaic, DemosaicResult};

mod formats;
mod pipeline;
mod compositor;

pub use compositor::RgbaLayerCompositor;

use formats::tiff::decode_tiff_impl;
use formats::tiff::tags::extract_bare_ifd_tags_json;
use formats::exr::decode_exr_impl;
use formats::png::decode_png16_impl;
use formats::hdr::decode_hdr_impl;
use formats::pfm::decode_pfm_impl;
use formats::netpbm::decode_ppm_impl;
use formats::npy::decode_npy_impl;

use wasm_bindgen::prelude::*;
use std::io::Cursor;
use std::mem;
use tiff::decoder::Decoder;

#[cfg(feature = "console_error_panic_hook")]
pub use console_error_panic_hook::set_once as set_panic_hook;

/// Result type for TIFF decoding operations
#[wasm_bindgen]
pub struct TiffResult {
    width: u32,
    height: u32,
    channels: u32,
    bits_per_sample: u32,
    sample_format: u32, // 1=uint, 2=int, 3=float
    // Metadata fields
    compression: u32,
    predictor: u32,
    photometric_interpretation: u32,
    planar_configuration: u32,
    rows_per_strip: u32,
    strip_count: u32,
    strip_byte_count_total: u64,
    strip_byte_count_max: u64,
    tile_width: u32,
    tile_length: u32,
    tile_count: u32,
    direct_decode: bool,
    // Data stored as bytes, interpreted based on sample_format
    data: Vec<u8>,
    // Float representation used by the webview render pipeline. For float TIFFs
    // this avoids converting decoded f32 pixels to bytes and back again.
    data_f32: Vec<f32>,
    // Computed statistics
    min_value: f64,
    max_value: f64,
    timing_metadata_ms: f64,
    timing_decode_ms: f64,
    timing_convert_ms: f64,
    timing_stats_ms: f64,
    timing_pack_ms: f64,
    // JSON array of every tag found in the main IFD, plus any Exif/GPS sub-IFD,
    // as `{"tag":<u16>,"name":"<Tag debug name>","group":"TIFF"|"Exif"|"GPS","value":"<string>"}`.
    all_tags_json: String,
    // OME-XML always lives in the first IFD's ImageDescription. Carry it with
    // every page result so restoring directly to a later page still has the
    // dataset's C/Z/T semantics without decoding page zero first.
    ome_xml: String,
}

#[wasm_bindgen]
pub struct ExrResult {
    width: u32,
    height: u32,
    channels: u32,
    data_f32: Vec<f32>,
    channel_names_csv: String,
    displayed_channels_csv: String,
    format: u32,
    data_type: u32,
    timing_read_ms: f64,
    timing_pack_ms: f64,
    timing_total_ms: f64,
    // JSON array of every EXR header attribute (image + layer, named fields
    // plus the crate's generic "other"/custom-attribute bags), in the same
    // {"tag","name","group","value"} shape as TiffResult.all_tags_json.
    all_tags_json: String,
}

#[wasm_bindgen]
pub struct PngResult {
    width: u32,
    height: u32,
    channels: u32,
    bit_depth: u32,
    color_type: u32,
    data_u16: Vec<u16>,
    timing_read_info_ms: f64,
    timing_decode_ms: f64,
    timing_convert_ms: f64,
    timing_total_ms: f64,
}

#[wasm_bindgen]
pub struct HdrResult {
    data_f32: Vec<f32>,
    metadata_f64: Vec<f64>,
    all_tags_json: String,
}

#[wasm_bindgen]
pub struct PfmResult {
    width: u32,
    height: u32,
    channels: u32,
    data_f32: Vec<f32>,
}

#[wasm_bindgen]
pub struct PpmResult {
    width: u32,
    height: u32,
    channels: u32,
    maxval: u32,
    is_16bit: bool,
    format: String,
    data_u8: Vec<u8>,
    data_u16: Vec<u16>,
}

#[wasm_bindgen]
pub struct NpyResult {
    width: u32,
    height: u32,
    channels: u32,
    dtype: String,
    show_norm: bool,
    data_f32: Vec<f32>,
}

#[wasm_bindgen]
impl NpyResult {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 { self.width }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 { self.height }

    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 { self.channels }

    #[wasm_bindgen(getter)]
    pub fn dtype(&self) -> String { self.dtype.clone() }

    #[wasm_bindgen(getter)]
    pub fn show_norm(&self) -> bool { self.show_norm }

    #[wasm_bindgen]
    pub fn take_data_as_f32(&mut self) -> Vec<f32> {
        mem::take(&mut self.data_f32)
    }
}

#[wasm_bindgen]
impl PfmResult {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 { self.width }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 { self.height }

    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 { self.channels }

    #[wasm_bindgen]
    pub fn take_data_as_f32(&mut self) -> Vec<f32> {
        mem::take(&mut self.data_f32)
    }
}

#[wasm_bindgen]
impl PpmResult {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 { self.width }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 { self.height }

    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 { self.channels }

    #[wasm_bindgen(getter)]
    pub fn maxval(&self) -> u32 { self.maxval }

    #[wasm_bindgen(getter)]
    pub fn is_16bit(&self) -> bool { self.is_16bit }

    #[wasm_bindgen(getter)]
    pub fn format(&self) -> String { self.format.clone() }

    /// Returns the raster as `Vec<u8>` when `is_16bit` is false; otherwise an
    /// empty `Vec`.
    #[wasm_bindgen]
    pub fn take_data_as_u8(&mut self) -> Vec<u8> {
        mem::take(&mut self.data_u8)
    }

    /// Returns the raster as `Vec<u16>` when `is_16bit` is true; otherwise an
    /// empty `Vec`.
    #[wasm_bindgen]
    pub fn take_data_as_u16(&mut self) -> Vec<u16> {
        mem::take(&mut self.data_u16)
    }
}

/// Small, format-neutral result used when a container (currently DICOM)
/// supplies an individual JPEG codestream to the shared Rust decoder.
#[wasm_bindgen]
pub struct JpegResult {
    width: u32,
    height: u32,
    channels: u32,
    data_u8: Vec<u8>,
}

#[wasm_bindgen]
impl JpegResult {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 { self.width }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 { self.height }

    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 { self.channels }

    #[wasm_bindgen]
    pub fn take_data_as_u8(&mut self) -> Vec<u8> {
        mem::take(&mut self.data_u8)
    }
}

/// Decode a complete JPEG codestream. DICOM parsing and frame extraction stay
/// in TypeScript; this reuses the same zune-jpeg codec already used by TIFF.
#[wasm_bindgen]
pub fn decode_jpeg_fast(data: &[u8]) -> Result<JpegResult, JsValue> {
    use zune_jpeg::JpegDecoder;

    let mut decoder = JpegDecoder::new(Cursor::new(data));
    let pixels = decoder.decode()
        .map_err(|e| JsValue::from_str(&format!("JPEG decode failed: {:?}", e)))?;
    let info = decoder.info()
        .ok_or_else(|| JsValue::from_str("JPEG: missing image info"))?;
    let pixel_count = (info.width as usize).saturating_mul(info.height as usize);
    if pixel_count == 0 || pixels.len() % pixel_count != 0 {
        return Err(JsValue::from_str("JPEG: invalid decoded dimensions"));
    }
    let channels = (pixels.len() / pixel_count) as u32;
    if channels != 1 && channels != 3 && channels != 4 {
        return Err(JsValue::from_str("JPEG: unsupported decoded channel count"));
    }
    Ok(JpegResult {
        width: info.width as u32,
        height: info.height as u32,
        channels,
        data_u8: pixels,
    })
}

#[wasm_bindgen]
impl HdrResult {
    #[wasm_bindgen(getter)]
    pub fn all_tags_json(&self) -> String {
        self.all_tags_json.clone()
    }

    #[wasm_bindgen]
    pub fn take_data_as_f32(&mut self) -> Vec<f32> {
        mem::take(&mut self.data_f32)
    }

    #[wasm_bindgen]
    pub fn take_metadata_as_f64(&mut self) -> Vec<f64> {
        mem::take(&mut self.metadata_f64)
    }
}

#[wasm_bindgen]
impl PngResult {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 { self.width }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 { self.height }

    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 { self.channels }

    #[wasm_bindgen(getter)]
    pub fn bit_depth(&self) -> u32 { self.bit_depth }

    #[wasm_bindgen(getter)]
    pub fn color_type(&self) -> u32 { self.color_type }

    #[wasm_bindgen(getter)]
    pub fn timing_read_info_ms(&self) -> f64 { self.timing_read_info_ms }

    #[wasm_bindgen(getter)]
    pub fn timing_decode_ms(&self) -> f64 { self.timing_decode_ms }

    #[wasm_bindgen(getter)]
    pub fn timing_convert_ms(&self) -> f64 { self.timing_convert_ms }

    #[wasm_bindgen(getter)]
    pub fn timing_total_ms(&self) -> f64 { self.timing_total_ms }

    #[wasm_bindgen]
    pub fn take_data_as_u16(&mut self) -> Vec<u16> {
        mem::take(&mut self.data_u16)
    }
}

#[wasm_bindgen]
impl ExrResult {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 {
        self.channels
    }

    #[wasm_bindgen(getter)]
    pub fn channel_names_csv(&self) -> String {
        self.channel_names_csv.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn displayed_channels_csv(&self) -> String {
        self.displayed_channels_csv.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn format(&self) -> u32 {
        self.format
    }

    #[wasm_bindgen(getter)]
    pub fn data_type(&self) -> u32 {
        self.data_type
    }

    #[wasm_bindgen(getter)]
    pub fn timing_read_ms(&self) -> f64 {
        self.timing_read_ms
    }

    #[wasm_bindgen(getter)]
    pub fn timing_pack_ms(&self) -> f64 {
        self.timing_pack_ms
    }

    #[wasm_bindgen(getter)]
    pub fn timing_total_ms(&self) -> f64 {
        self.timing_total_ms
    }

    #[wasm_bindgen(getter)]
    pub fn all_tags_json(&self) -> String {
        self.all_tags_json.clone()
    }

    #[wasm_bindgen]
    pub fn take_data_as_f32(&mut self) -> Vec<f32> {
        mem::take(&mut self.data_f32)
    }
}

#[wasm_bindgen]
impl TiffResult {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 {
        self.channels
    }

    #[wasm_bindgen(getter)]
    pub fn bits_per_sample(&self) -> u32 {
        self.bits_per_sample
    }

    #[wasm_bindgen(getter)]
    pub fn sample_format(&self) -> u32 {
        self.sample_format
    }

    #[wasm_bindgen(getter)]
    pub fn min_value(&self) -> f64 {
        self.min_value
    }

    #[wasm_bindgen(getter)]
    pub fn max_value(&self) -> f64 {
        self.max_value
    }

    #[wasm_bindgen(getter)]
    pub fn timing_metadata_ms(&self) -> f64 {
        self.timing_metadata_ms
    }

    #[wasm_bindgen(getter)]
    pub fn timing_decode_ms(&self) -> f64 {
        self.timing_decode_ms
    }

    #[wasm_bindgen(getter)]
    pub fn timing_convert_ms(&self) -> f64 {
        self.timing_convert_ms
    }

    #[wasm_bindgen(getter)]
    pub fn timing_stats_ms(&self) -> f64 {
        self.timing_stats_ms
    }

    #[wasm_bindgen(getter)]
    pub fn timing_pack_ms(&self) -> f64 {
        self.timing_pack_ms
    }

    #[wasm_bindgen(getter)]
    pub fn compression(&self) -> u32 {
        self.compression
    }

    #[wasm_bindgen(getter)]
    pub fn predictor(&self) -> u32 {
        self.predictor
    }

    #[wasm_bindgen(getter)]
    pub fn photometric_interpretation(&self) -> u32 {
        self.photometric_interpretation
    }

    #[wasm_bindgen(getter)]
    pub fn planar_configuration(&self) -> u32 {
        self.planar_configuration
    }

    #[wasm_bindgen(getter)]
    pub fn rows_per_strip(&self) -> u32 {
        self.rows_per_strip
    }

    #[wasm_bindgen(getter)]
    pub fn strip_count(&self) -> u32 {
        self.strip_count
    }

    #[wasm_bindgen(getter)]
    pub fn strip_byte_count_total(&self) -> f64 {
        self.strip_byte_count_total as f64
    }

    #[wasm_bindgen(getter)]
    pub fn strip_byte_count_max(&self) -> f64 {
        self.strip_byte_count_max as f64
    }

    #[wasm_bindgen(getter)]
    pub fn tile_width(&self) -> u32 {
        self.tile_width
    }

    #[wasm_bindgen(getter)]
    pub fn tile_length(&self) -> u32 {
        self.tile_length
    }

    #[wasm_bindgen(getter)]
    pub fn tile_count(&self) -> u32 {
        self.tile_count
    }

    #[wasm_bindgen(getter)]
    pub fn direct_decode(&self) -> bool {
        self.direct_decode
    }

    #[wasm_bindgen(getter)]
    pub fn ome_xml(&self) -> String {
        self.ome_xml.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn all_tags_json(&self) -> String {
        self.all_tags_json.clone()
    }

    /// Get raw data as bytes (for transferring to JS)
    #[wasm_bindgen]
    pub fn get_data_bytes(&self) -> Vec<u8> {
        if self.data.is_empty() && !self.data_f32.is_empty() {
            let mut bytes = Vec::with_capacity(self.data_f32.len() * 4);
            for &value in &self.data_f32 {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            return bytes;
        }
        self.data.clone()
    }

    /// Get data as Float32Array (most common for visualization)
    #[wasm_bindgen]
    pub fn get_data_as_f32(&self) -> Vec<f32> {
        if !self.data_f32.is_empty() {
            return self.data_f32.clone();
        }

        match self.sample_format {
            3 => {
                // Already float32
                self.data
                    .chunks_exact(4)
                    .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
                    .collect()
            }
            1 | 2 => {
                // Convert integers to float
                match self.bits_per_sample {
                    8 => self.data.iter().map(|&v| v as f32).collect(),
                    // 9..=15 covers the sub-16-bit direct decode path
                    // (try_decode_subbit_strips): those samples are still
                    // packed as 2 bytes each (via convert_u16_to_bytes_simd),
                    // just with a smaller reported bits_per_sample.
                    9..=16 => self.data
                        .chunks_exact(2)
                        .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]) as f32)
                        .collect(),
                    32 => self.data
                        .chunks_exact(4)
                        .map(|bytes| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32)
                        .collect(),
                    _ => vec![],
                }
            }
            _ => vec![],
        }
    }

    /// Move float data out of the result when possible. This avoids cloning the
    /// decoded f32 vector before wasm-bindgen copies it into JS-owned memory.
    #[wasm_bindgen]
    pub fn take_data_as_f32(&mut self) -> Vec<f32> {
        if !self.data_f32.is_empty() {
            return mem::take(&mut self.data_f32);
        }
        self.get_data_as_f32()
    }
}

/// Decode a TIFF file from an ArrayBuffer
/// Returns TiffResult with image data and metadata
#[wasm_bindgen]
pub fn decode_tiff(data: &[u8]) -> Result<TiffResult, JsValue> {
    decode_tiff_impl(data, true, 0)
}

/// Bytes safe to hand to `Decoder::new`, with a CFA photometric neutralized.
///
/// The `tiff` crate rejects PhotometricInterpretation 32803 when it opens a
/// file, so *every* entry point that constructs a `Decoder` has to go through
/// this or CFA/Bayer files fail before any pixels are touched. Borrows the
/// input unchanged when there is no CFA tag, so the common path copies nothing.
pub(crate) fn cfa_safe_bytes(data: &[u8]) -> std::borrow::Cow<'_, [u8]> {
    match demosaic::neutralize_cfa_photometric(data) {
        Some(patched) => std::borrow::Cow::Owned(patched),
        None => std::borrow::Cow::Borrowed(data),
    }
}

/// Return the number of top-level image file directories (pages) in a TIFF.
#[wasm_bindgen]
pub fn tiff_page_count(data: &[u8]) -> Result<u32, JsValue> {
    let bytes = cfa_safe_bytes(data);
    let mut decoder = Decoder::new(Cursor::new(bytes.as_ref()))
        .map_err(|e| JsValue::from_str(&format!("Failed to create decoder: {}", e)))?;
    let mut count = 1u32;
    while decoder.more_images() {
        decoder.next_image()
            .map_err(|e| JsValue::from_str(&format!("Failed to enumerate TIFF pages: {}", e)))?;
        count = count.saturating_add(1);
    }
    Ok(count)
}

/// Decode an arbitrary zero-based TIFF page and compute min/max statistics.
#[wasm_bindgen]
pub fn decode_tiff_page(data: &[u8], page_index: u32) -> Result<TiffResult, JsValue> {
    decode_tiff_impl(data, true, page_index)
}

/// Walk a raw Exif-only IFD blob (a JPEG APP1 payload with its "Exif\0\0"
/// prefix already stripped, or a PNG eXIf chunk's raw bytes) and return
/// every tag as JSON, in the same shape as `TiffResult.all_tags_json`.
///
/// These blobs are TIFF-*structured* (byte order + magic 42 + IFD entries)
/// but are not full TIFF files — they carry no ImageWidth/PhotometricInterpretation/
/// etc., so the `tiff` crate's `Decoder::new()` (which always validates a
/// full image directory) rejects them. `extract_bare_ifd_tags_json` reads
/// the IFD structure directly instead, bypassing `Decoder` entirely; real
/// `.tif`/`.tiff` files keep using the `Decoder`-based `extract_all_tags_json`
/// via `decode_tiff`/`decode_tiff_fast` above.
#[wasm_bindgen]
pub fn extract_exif_tags(data: &[u8]) -> String {
    extract_bare_ifd_tags_json(data)
}

/// Decode a TIFF file without eagerly computing min/max statistics.
///
/// The webview render path computes stats lazily when a non-gamma mode needs
/// them. Skipping eager stats saves a full pass over large float TIFFs during
/// the common gamma-mode initial load.
#[wasm_bindgen]
pub fn decode_tiff_fast(data: &[u8]) -> Result<TiffResult, JsValue> {
    decode_tiff_impl(data, false, 0)
}

/// Decode an arbitrary zero-based TIFF page without eagerly computing stats.
#[wasm_bindgen]
pub fn decode_tiff_page_fast(data: &[u8], page_index: u32) -> Result<TiffResult, JsValue> {
    decode_tiff_impl(data, false, page_index)
}

#[wasm_bindgen]
pub fn decode_exr_fast(data: &[u8]) -> Result<ExrResult, JsValue> {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();

    decode_exr_impl(data)
}

#[wasm_bindgen]
pub fn decode_png16_fast(data: &[u8]) -> Result<PngResult, JsValue> {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();

    decode_png16_impl(data)
}

#[wasm_bindgen]
pub fn decode_hdr_fast(data: &[u8]) -> Result<HdrResult, JsValue> {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();

    decode_hdr_impl(data)
}

/// Decode a Portable Float Map (PFM). `top_down` requests a vertical flip so
/// row 0 of the output is the PFM file's last (topmost, in image space) row —
/// the worker always passes `true` to match the existing TS parser's
/// `{ topDown: true }` call.
#[wasm_bindgen]
pub fn decode_pfm_fast(data: &[u8], top_down: bool) -> Result<PfmResult, JsValue> {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();

    decode_pfm_impl(data, top_down)
}

/// Decode a NetPBM image (PBM/PGM/PPM, ASCII or binary).
#[wasm_bindgen]
pub fn decode_ppm_fast(data: &[u8]) -> Result<PpmResult, JsValue> {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();

    decode_ppm_impl(data)
}

/// Decode a NumPy `.npy` file or a `.npz` archive. Dispatches internally on
/// the ZIP local-file-header signature in the first 4 bytes, mirroring the
/// worker's existing `case 'npy':` dispatch.
#[wasm_bindgen]
pub fn decode_npy_fast(data: &[u8]) -> Result<NpyResult, JsValue> {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();

    let parsed = decode_npy_impl(data)?;
    Ok(NpyResult {
        width: parsed.width,
        height: parsed.height,
        channels: parsed.channels,
        dtype: parsed.dtype,
        show_norm: parsed.show_norm,
        data_f32: parsed.data,
    })
}

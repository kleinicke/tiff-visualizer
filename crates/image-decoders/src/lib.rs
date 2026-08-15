//! Reusable decoders for scientific, medical, HDR, and standard images.
//!
//! This crate contains byte parsing and pixel decoding only. It deliberately
//! has no JavaScript-facing API; applications provide their own native, WASM,
//! or FFI adapters around these Rust types.

use std::fmt;

/// Error returned when encoded bytes cannot be decoded.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DecodeError(String);

impl DecodeError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    pub fn message(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for DecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for DecodeError {}

#[cfg(any(feature = "demosaic", feature = "tiff"))]
mod demosaic;
#[cfg(any(feature = "demosaic", feature = "tiff"))]
pub use demosaic::{demosaic, DemosaicResult};

mod formats;
mod pipeline;
#[cfg(any(feature = "tiff", feature = "exr", feature = "png", feature = "hdr"))]
mod time;
pub use pipeline::stats;

#[cfg(feature = "czi")]
use formats::czi::decode_czi_impl;
#[cfg(feature = "dicom")]
use formats::dicom::decode_dicom_impl;
#[cfg(feature = "exr")]
use formats::exr::decode_exr_impl;
#[cfg(feature = "fits")]
use formats::fits::decode_fits_impl;
#[cfg(feature = "hdr")]
use formats::hdr::decode_hdr_impl;
#[cfg(feature = "netcdf")]
use formats::netcdf::decode_netcdf_impl;
#[cfg(feature = "netpbm")]
use formats::netpbm::decode_ppm_impl;
#[cfg(feature = "npy")]
use formats::npy::decode_npy_impl;
#[cfg(feature = "pfm")]
use formats::pfm::decode_pfm_impl;
#[cfg(feature = "png")]
use formats::png::decode_png16_impl;
#[cfg(feature = "tiff")]
use formats::tiff::{decode_tiff_impl, tags::extract_bare_ifd_tags_json};

#[cfg(any(feature = "jpeg", feature = "tiff"))]
use std::io::Cursor;
use std::mem;
#[cfg(feature = "tiff")]
use tiff::decoder::Decoder;

/// Result type for TIFF decoding operations
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

pub struct HdrResult {
    data_f32: Vec<f32>,
    metadata_f64: Vec<f64>,
    all_tags_json: String,
}

/// Unified result type for every format whose decoder needs nothing beyond a
/// plain raster: PFM, NetPBM (PBM/PGM/PPM), NPY/NPZ, FITS, classic NetCDF and
/// DICOM. These used to be four near-identical structs (`PfmResult`,
/// `PpmResult`, `NpyResult`, `ScientificResult`) that each restated the same
/// handful of concepts in slightly different words; `DecodedArray` is the one
/// shape all six `decode_*_fast` entry points below return.
///
/// - `sample_format`: 1 = unsigned int, 2 = signed int, 3 = float (the same
///   TIFF convention `TiffResult.sample_format` already uses).
/// - `sample_kind`: which `take_data_as_*` getter actually holds data —
///   0 = `take_data_as_f32`, 1 = `take_data_as_u8`, 2 = `take_data_as_u16`.
///   The other two getters return an empty `Vec` for a given result.
/// - `format_label`: a human sub-variant string (e.g. "PGM (Binary)"); `""`
///   when the format has no such concept.
/// - `metadata_json`: a JSON object string (`formats/json_value.rs`), mirroring
///   the TS `metadata: Record<string, any>` shape; `"{}"` when the format has
///   no extra metadata.
pub struct DecodedArray {
    width: u32,
    height: u32,
    channels: u32,
    bits_per_sample: u32,
    sample_format: u32,
    type_min: f64,
    type_max: f64,
    source_numeric_type: String,
    sample_kind: u32,
    format_label: String,
    metadata_json: String,
    data_f32: Vec<f32>,
    data_u8: Vec<u8>,
    data_u16: Vec<u16>,
    /// Guards the one-shot `take_data_as_*` contract below.
    taken: bool,
    /// Sample statistics, ported from `ImageStatsCalculator.calculateFloatStats`
    /// / `.calculateIntegerStats` (`media/modules/normalization-helper.ts`) and
    /// filled in by `finalize_stats()` below. See that method for why this is
    /// computed unconditionally rather than behind a "needs stats" flag.
    data_min: f64,
    data_max: f64,
    non_finite_count: f64,
    valid_count: f64,
}

impl DecodedArray {
    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn channels(&self) -> u32 {
        self.channels
    }

    pub fn bits_per_sample(&self) -> u32 {
        self.bits_per_sample
    }

    pub fn sample_format(&self) -> u32 {
        self.sample_format
    }

    pub fn type_min(&self) -> f64 {
        self.type_min
    }

    pub fn type_max(&self) -> f64 {
        self.type_max
    }

    pub fn source_numeric_type(&self) -> String {
        self.source_numeric_type.clone()
    }

    pub fn sample_kind(&self) -> u32 {
        self.sample_kind
    }

    pub fn format_label(&self) -> String {
        self.format_label.clone()
    }

    pub fn metadata_json(&self) -> String {
        self.metadata_json.clone()
    }

    pub fn data_min(&self) -> f64 {
        self.data_min
    }

    pub fn data_max(&self) -> f64 {
        self.data_max
    }

    pub fn non_finite_count(&self) -> f64 {
        self.non_finite_count
    }

    pub fn valid_count(&self) -> f64 {
        self.valid_count
    }

    /// Moves the raster out as `Vec<f32>` (valid when `sample_kind == 0`).
    ///
    /// ONE-SHOT. The samples are moved rather than copied, because copying a
    /// multi-hundred-megabyte raster to satisfy a second caller would be a
    /// serious cost to pay for a mistake. A second call therefore CANNOT
    /// return the data — but it now fails loudly instead of handing back an
    /// empty `Vec`, which is what silently produced blank images and
    /// `undefined` samples twice in this project's history.
    pub fn take_data_as_f32(&mut self) -> Result<Vec<f32>, DecodeError> {
        self.claim("take_data_as_f32")?;
        Ok(mem::take(&mut self.data_f32))
    }

    /// Moves the raster out as `Vec<u8>` (valid when `sample_kind == 1`).
    /// One-shot; see [`DecodedArray::take_data_as_f32`].
    pub fn take_data_as_u8(&mut self) -> Result<Vec<u8>, DecodeError> {
        self.claim("take_data_as_u8")?;
        Ok(mem::take(&mut self.data_u8))
    }

    /// Moves the raster out as `Vec<u16>` (valid when `sample_kind == 2`).
    /// One-shot; see [`DecodedArray::take_data_as_f32`].
    pub fn take_data_as_u16(&mut self) -> Result<Vec<u16>, DecodeError> {
        self.claim("take_data_as_u16")?;
        Ok(mem::take(&mut self.data_u16))
    }
}

impl DecodedArray {
    /// Enforces the one-shot contract shared by the three takers. The samples
    /// live in ONE of the three buffers, so claiming any of them consumes the
    /// result: asking for the wrong carrier is a caller bug too, and is better
    /// reported than answered with an empty array.
    fn claim(&mut self, method: &str) -> Result<(), DecodeError> {
        if self.taken {
            return Err(DecodeError::new(&format!(
                "DecodedArray::{method} called more than once. The decoded samples are \
                 moved out on the first call, not copied. Take them once and reuse that \
                 array (media/modules/wasm-decoders.ts does this for every format)."
            )));
        }
        self.taken = true;
        Ok(())
    }

    /// Scans the samples once and fills `data_min`/`data_max`/`non_finite_count`/
    /// `valid_count`, ported from `ImageStatsCalculator.calculateFloatStats` /
    /// `.calculateIntegerStats` (`media/modules/normalization-helper.ts`) via
    /// the shared `pipeline::stats` helpers — same channel-scanning convention
    /// (`scan_channels`), same non-finite exclusion rules, same "no valid
    /// samples" min/max fallback (`extended = false` keeps +/-Infinity, which
    /// is what the render-time normalization range this feeds expects).
    ///
    /// Called unconditionally for every `DecodedArray`-producing decoder,
    /// NOT behind a "does the caller actually need stats" flag. The old JS
    /// path (`NormalizationHelper.needsStats`) skipped the scan in gamma
    /// mode, which mattered when most formats defaulted to gamma mode — they
    /// no longer do (auto-normalize is the default for TIFF-float,
    /// TIFF-int-signed/wide, NPY, FITS, DICOM, NetCDF and CZI), so the scan
    /// runs on nearly every load anyway. Measured at ~4% of total decode time
    /// for a 5120x5120 f32 raster (36ms stats vs 757ms decode), with the
    /// samples already resident in wasm memory here — cheaper than the
    /// ~100MB copy back to JS a lazy JS-side rescan would need. Do not
    /// reintroduce a conditional here; if a genuinely stats-free fast path is
    /// ever needed, it should be a deliberate new decision, not a reflex
    /// port of the old flag.
    #[cfg(any(
        feature = "pfm",
        feature = "netpbm",
        feature = "npy",
        feature = "fits",
        feature = "netcdf",
        feature = "dicom",
        feature = "czi"
    ))]
    fn finalize_stats(mut self) -> Self {
        let stats = match self.sample_kind {
            1 => pipeline::stats::compute_image_stats_uint_impl(
                &self.data_u8,
                self.width,
                self.height,
                self.channels,
                false,
            ),
            2 => pipeline::stats::compute_image_stats_uint_impl(
                &self.data_u16,
                self.width,
                self.height,
                self.channels,
                false,
            ),
            _ => pipeline::stats::compute_image_stats_f32_impl(
                &self.data_f32,
                self.width,
                self.height,
                self.channels,
                false,
            ),
        };
        self.data_min = stats.min;
        self.data_max = stats.max;
        self.non_finite_count = stats.non_finite_count;
        self.valid_count = stats.valid_count;
        self
    }
}

#[cfg(any(
    feature = "fits",
    feature = "netcdf",
    feature = "dicom",
    feature = "czi"
))]
impl From<formats::scientific_common::ScientificParsed> for DecodedArray {
    fn from(p: formats::scientific_common::ScientificParsed) -> Self {
        DecodedArray {
            taken: false,
            width: p.width,
            height: p.height,
            channels: p.channels,
            bits_per_sample: p.bits_per_sample,
            sample_format: p.sample_format,
            type_min: p.type_min,
            type_max: p.type_max,
            source_numeric_type: p.source_numeric_type,
            sample_kind: 0,
            format_label: String::new(),
            metadata_json: p.metadata_json,
            data_f32: p.data,
            data_u8: Vec::new(),
            data_u16: Vec::new(),
            data_min: 0.0,
            data_max: 0.0,
            non_finite_count: 0.0,
            valid_count: 0.0,
        }
        .finalize_stats()
    }
}

/// Small, format-neutral result used when a container (currently DICOM)
/// supplies an individual JPEG codestream to the shared Rust decoder.
pub struct JpegResult {
    width: u32,
    height: u32,
    channels: u32,
    data_u8: Vec<u8>,
}

impl JpegResult {
    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn channels(&self) -> u32 {
        self.channels
    }

    pub fn take_data_as_u8(&mut self) -> Vec<u8> {
        mem::take(&mut self.data_u8)
    }
}

/// Decode a complete JPEG codestream. DICOM parsing and frame extraction stay
/// in TypeScript; this reuses the same zune-jpeg codec already used by TIFF.
#[cfg(feature = "jpeg")]
pub fn decode_jpeg_fast(data: &[u8]) -> Result<JpegResult, DecodeError> {
    use zune_jpeg::JpegDecoder;

    let mut decoder = JpegDecoder::new(Cursor::new(data));
    let pixels = decoder
        .decode()
        .map_err(|e| DecodeError::new(&format!("JPEG decode failed: {:?}", e)))?;
    let info = decoder
        .info()
        .ok_or_else(|| DecodeError::new("JPEG: missing image info"))?;
    let pixel_count = (info.width as usize).saturating_mul(info.height as usize);
    if pixel_count == 0 || pixels.len() % pixel_count != 0 {
        return Err(DecodeError::new("JPEG: invalid decoded dimensions"));
    }
    let channels = (pixels.len() / pixel_count) as u32;
    if channels != 1 && channels != 3 && channels != 4 {
        return Err(DecodeError::new("JPEG: unsupported decoded channel count"));
    }
    Ok(JpegResult {
        width: info.width as u32,
        height: info.height as u32,
        channels,
        data_u8: pixels,
    })
}

impl HdrResult {
    pub fn all_tags_json(&self) -> String {
        self.all_tags_json.clone()
    }

    pub fn take_data_as_f32(&mut self) -> Vec<f32> {
        mem::take(&mut self.data_f32)
    }

    pub fn take_metadata_as_f64(&mut self) -> Vec<f64> {
        mem::take(&mut self.metadata_f64)
    }
}

impl PngResult {
    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn channels(&self) -> u32 {
        self.channels
    }

    pub fn bit_depth(&self) -> u32 {
        self.bit_depth
    }

    pub fn color_type(&self) -> u32 {
        self.color_type
    }

    pub fn timing_read_info_ms(&self) -> f64 {
        self.timing_read_info_ms
    }

    pub fn timing_decode_ms(&self) -> f64 {
        self.timing_decode_ms
    }

    pub fn timing_convert_ms(&self) -> f64 {
        self.timing_convert_ms
    }

    pub fn timing_total_ms(&self) -> f64 {
        self.timing_total_ms
    }

    pub fn take_data_as_u16(&mut self) -> Vec<u16> {
        mem::take(&mut self.data_u16)
    }
}

impl ExrResult {
    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn channels(&self) -> u32 {
        self.channels
    }

    pub fn channel_names_csv(&self) -> String {
        self.channel_names_csv.clone()
    }

    pub fn displayed_channels_csv(&self) -> String {
        self.displayed_channels_csv.clone()
    }

    pub fn format(&self) -> u32 {
        self.format
    }

    pub fn data_type(&self) -> u32 {
        self.data_type
    }

    pub fn timing_read_ms(&self) -> f64 {
        self.timing_read_ms
    }

    pub fn timing_pack_ms(&self) -> f64 {
        self.timing_pack_ms
    }

    pub fn timing_total_ms(&self) -> f64 {
        self.timing_total_ms
    }

    pub fn all_tags_json(&self) -> String {
        self.all_tags_json.clone()
    }

    pub fn take_data_as_f32(&mut self) -> Vec<f32> {
        mem::take(&mut self.data_f32)
    }
}

impl TiffResult {
    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn channels(&self) -> u32 {
        self.channels
    }

    pub fn bits_per_sample(&self) -> u32 {
        self.bits_per_sample
    }

    pub fn sample_format(&self) -> u32 {
        self.sample_format
    }

    pub fn min_value(&self) -> f64 {
        self.min_value
    }

    pub fn max_value(&self) -> f64 {
        self.max_value
    }

    pub fn timing_metadata_ms(&self) -> f64 {
        self.timing_metadata_ms
    }

    pub fn timing_decode_ms(&self) -> f64 {
        self.timing_decode_ms
    }

    pub fn timing_convert_ms(&self) -> f64 {
        self.timing_convert_ms
    }

    pub fn timing_stats_ms(&self) -> f64 {
        self.timing_stats_ms
    }

    pub fn timing_pack_ms(&self) -> f64 {
        self.timing_pack_ms
    }

    pub fn compression(&self) -> u32 {
        self.compression
    }

    pub fn predictor(&self) -> u32 {
        self.predictor
    }

    pub fn photometric_interpretation(&self) -> u32 {
        self.photometric_interpretation
    }

    pub fn planar_configuration(&self) -> u32 {
        self.planar_configuration
    }

    pub fn rows_per_strip(&self) -> u32 {
        self.rows_per_strip
    }

    pub fn strip_count(&self) -> u32 {
        self.strip_count
    }

    pub fn strip_byte_count_total(&self) -> f64 {
        self.strip_byte_count_total as f64
    }

    pub fn strip_byte_count_max(&self) -> f64 {
        self.strip_byte_count_max as f64
    }

    pub fn tile_width(&self) -> u32 {
        self.tile_width
    }

    pub fn tile_length(&self) -> u32 {
        self.tile_length
    }

    pub fn tile_count(&self) -> u32 {
        self.tile_count
    }

    pub fn direct_decode(&self) -> bool {
        self.direct_decode
    }

    pub fn ome_xml(&self) -> String {
        self.ome_xml.clone()
    }

    pub fn all_tags_json(&self) -> String {
        self.all_tags_json.clone()
    }

    /// Get raw data as bytes (for transferring to JS)
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
                    9..=16 => self
                        .data
                        .chunks_exact(2)
                        .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]) as f32)
                        .collect(),
                    32 => self
                        .data
                        .chunks_exact(4)
                        .map(|bytes| {
                            u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32
                        })
                        .collect(),
                    _ => vec![],
                }
            }
            _ => vec![],
        }
    }

    /// Move float data out of the result when possible. This avoids cloning the
    /// decoded f32 vector before wasm-bindgen copies it into JS-owned memory.
    pub fn take_data_as_f32(&mut self) -> Vec<f32> {
        if !self.data_f32.is_empty() {
            return mem::take(&mut self.data_f32);
        }
        self.get_data_as_f32()
    }
}

/// Decode a TIFF file from an ArrayBuffer
/// Returns TiffResult with image data and metadata
#[cfg(feature = "tiff")]
pub fn decode_tiff(data: &[u8]) -> Result<TiffResult, DecodeError> {
    decode_tiff_impl(data, true, 0)
}

/// Bytes safe to hand to `Decoder::new`, with a CFA photometric neutralized.
///
/// The `tiff` crate rejects PhotometricInterpretation 32803 when it opens a
/// file, so *every* entry point that constructs a `Decoder` has to go through
/// this or CFA/Bayer files fail before any pixels are touched. Borrows the
/// input unchanged when there is no CFA tag, so the common path copies nothing.
#[cfg(feature = "tiff")]
pub fn cfa_safe_bytes(data: &[u8]) -> std::borrow::Cow<'_, [u8]> {
    match demosaic::neutralize_cfa_photometric(data) {
        Some(patched) => std::borrow::Cow::Owned(patched),
        None => std::borrow::Cow::Borrowed(data),
    }
}

/// Return the number of top-level image file directories (pages) in a TIFF.
#[cfg(feature = "tiff")]
pub fn tiff_page_count(data: &[u8]) -> Result<u32, DecodeError> {
    let bytes = cfa_safe_bytes(data);
    let mut decoder = Decoder::new(Cursor::new(bytes.as_ref()))
        .map_err(|e| DecodeError::new(&format!("Failed to create decoder: {}", e)))?;
    let mut count = 1u32;
    while decoder.more_images() {
        decoder
            .next_image()
            .map_err(|e| DecodeError::new(&format!("Failed to enumerate TIFF pages: {}", e)))?;
        count = count.saturating_add(1);
    }
    Ok(count)
}

/// Decode an arbitrary zero-based TIFF page and compute min/max statistics.
#[cfg(feature = "tiff")]
pub fn decode_tiff_page(data: &[u8], page_index: u32) -> Result<TiffResult, DecodeError> {
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
#[cfg(feature = "tiff")]
pub fn extract_exif_tags(data: &[u8]) -> String {
    extract_bare_ifd_tags_json(data)
}

/// Decode a TIFF file without eagerly computing min/max statistics.
///
/// The webview render path computes stats lazily when a non-gamma mode needs
/// them. Skipping eager stats saves a full pass over large float TIFFs during
/// the common gamma-mode initial load.
#[cfg(feature = "tiff")]
pub fn decode_tiff_fast(data: &[u8]) -> Result<TiffResult, DecodeError> {
    decode_tiff_impl(data, false, 0)
}

/// Decode an arbitrary zero-based TIFF page without eagerly computing stats.
#[cfg(feature = "tiff")]
pub fn decode_tiff_page_fast(data: &[u8], page_index: u32) -> Result<TiffResult, DecodeError> {
    decode_tiff_impl(data, false, page_index)
}

#[cfg(feature = "exr")]
pub fn decode_exr_fast(data: &[u8]) -> Result<ExrResult, DecodeError> {
    decode_exr_impl(data)
}

#[cfg(feature = "png")]
pub fn decode_png16_fast(data: &[u8]) -> Result<PngResult, DecodeError> {
    decode_png16_impl(data)
}

#[cfg(feature = "hdr")]
pub fn decode_hdr_fast(data: &[u8]) -> Result<HdrResult, DecodeError> {
    decode_hdr_impl(data)
}

/// Decode a Portable Float Map (PFM). `top_down` requests a vertical flip so
/// row 0 of the output is the PFM file's last (topmost, in image space) row —
/// the worker always passes `true` to match the existing TS parser's
/// `{ topDown: true }` call.
#[cfg(feature = "pfm")]
pub fn decode_pfm_fast(data: &[u8], top_down: bool) -> Result<DecodedArray, DecodeError> {
    decode_pfm_impl(data, top_down)
}

/// Decode a NetPBM image (PBM/PGM/PPM, ASCII or binary).
#[cfg(feature = "netpbm")]
pub fn decode_ppm_fast(data: &[u8]) -> Result<DecodedArray, DecodeError> {
    decode_ppm_impl(data)
}

/// Decode a NumPy `.npy` file or a `.npz` archive. Dispatches internally on
/// the ZIP local-file-header signature in the first 4 bytes, mirroring the
/// worker's existing `case 'npy':` dispatch.
#[cfg(feature = "npy")]
pub fn decode_npy_fast(data: &[u8]) -> Result<DecodedArray, DecodeError> {
    decode_npy_impl(data)
}

/// Decode a FITS file's first primary/IMAGE HDU with at least two axes.
#[cfg(feature = "fits")]
pub fn decode_fits_fast(data: &[u8]) -> Result<DecodedArray, DecodeError> {
    Ok(decode_fits_impl(data)?.into())
}

/// Decode a classic NetCDF (CDF-1/CDF-2) file as either a regular raster or
/// an MPAS `nCells` polygon mesh. `options_json` is the JSON-serialized
/// `NetCdfDecodeOptions` (`{ variableName?, indices? }`).
#[cfg(feature = "netcdf")]
pub fn decode_netcdf_fast(data: &[u8], options_json: &str) -> Result<DecodedArray, DecodeError> {
    Ok(decode_netcdf_impl(data, options_json)?.into())
}

/// Decode one native (uncompressed) DICOM frame. `frame_index` selects a
/// frame from a multi-frame `NumberOfFrames` dataset (clamped to range).
/// Compressed (encapsulated) Pixel Data is rejected with the same error text
/// the TS parser uses, so `decode-worker.ts`'s existing JPEG-Baseline
/// fallback (TS frame extraction + the shared `decode_jpeg_fast`) keeps
/// working unchanged against this decoder.
#[cfg(feature = "dicom")]
pub fn decode_dicom_fast(data: &[u8], frame_index: u32) -> Result<DecodedArray, DecodeError> {
    Ok(decode_dicom_impl(data, frame_index)?.into())
}

/// Decode a Zeiss CZI plane. `options_json` is the JSON-serialized
/// `CziDecodeOptions` (`{ indices?: Record<string, number> }`) selecting the
/// Z/C/T/... coordinate to assemble; unspecified axes default to their first
/// coordinate. Compressed subblocks (JPEG/LZW/JPEG XR/Zstd) are rejected —
/// only uncompressed subblocks decode.
#[cfg(feature = "czi")]
pub fn decode_czi_fast(data: &[u8], options_json: &str) -> Result<DecodedArray, DecodeError> {
    Ok(decode_czi_impl(data, options_json)?.into())
}

// Canonical Rust names. The `*_fast` spellings above are retained because the
// WASM adapter's public JavaScript API has used them for years.
#[cfg(feature = "czi")]
pub use decode_czi_fast as decode_czi;
#[cfg(feature = "dicom")]
pub use decode_dicom_fast as decode_dicom;
#[cfg(feature = "exr")]
pub use decode_exr_fast as decode_exr;
#[cfg(feature = "fits")]
pub use decode_fits_fast as decode_fits;
#[cfg(feature = "hdr")]
pub use decode_hdr_fast as decode_hdr;
#[cfg(feature = "jpeg")]
pub use decode_jpeg_fast as decode_jpeg;
#[cfg(feature = "netcdf")]
pub use decode_netcdf_fast as decode_netcdf;
#[cfg(feature = "npy")]
pub use decode_npy_fast as decode_numpy;
#[cfg(feature = "pfm")]
pub use decode_pfm_fast as decode_pfm;
#[cfg(feature = "png")]
pub use decode_png16_fast as decode_png16;
#[cfg(feature = "netpbm")]
pub use decode_ppm_fast as decode_netpbm;

//! Fast TIFF decoder for WebAssembly
//! 
//! This library provides high-performance TIFF decoding for use in browser environments
//! through WebAssembly. It's designed to be a drop-in replacement for slow parts of
//! geotiff.js while maintaining compatibility with existing JavaScript code.

mod demosaic;
pub use demosaic::{demosaic, DemosaicResult};

use wasm_bindgen::prelude::*;
use std::io::Cursor;
use std::mem;
use exr::prelude::FlatSamples;
use tiff::decoder::{Decoder, DecodingResult};

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

/// Return the number of top-level image file directories (pages) in a TIFF.
#[wasm_bindgen]
pub fn tiff_page_count(data: &[u8]) -> Result<u32, JsValue> {
    let mut decoder = Decoder::new(Cursor::new(data))
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

fn decode_png16_impl(data: &[u8]) -> Result<PngResult, JsValue> {
    let start_time = js_sys::Date::now();
    let cursor = Cursor::new(data);
    let mut limits = png::Limits::default();
    limits.bytes = 512 * 1024 * 1024;
    let decoder = png::Decoder::new_with_limits(cursor, limits);
    let mut reader = decoder.read_info()
        .map_err(|e| JsValue::from_str(&format!("Failed to read PNG info: {}", e)))?;
    let read_info_time = js_sys::Date::now() - start_time;

    let decode_start = js_sys::Date::now();
    let mut raw = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut raw)
        .map_err(|e| JsValue::from_str(&format!("Failed to decode PNG frame: {}", e)))?;
    raw.truncate(info.buffer_size());
    let decode_time = js_sys::Date::now() - decode_start;

    if info.bit_depth != png::BitDepth::Sixteen {
        return Err(JsValue::from_str("Rust PNG fast path only supports 16-bit PNG output"));
    }
    let channels = match info.color_type {
        png::ColorType::Grayscale => 1,
        png::ColorType::Rgb => 3,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgba => 4,
        png::ColorType::Indexed => return Err(JsValue::from_str("Rust PNG fast path does not support indexed 16-bit PNG")),
    };

    let expected_values = (info.width as usize)
        .checked_mul(info.height as usize)
        .and_then(|v| v.checked_mul(channels as usize))
        .ok_or_else(|| JsValue::from_str("PNG dimensions overflow"))?;
    if raw.len() < expected_values * 2 {
        return Err(JsValue::from_str("PNG decoded byte count is smaller than expected"));
    }

    let convert_start = js_sys::Date::now();
    let mut values: Vec<u16> = Vec::with_capacity(expected_values);
    let src_ptr = raw.as_ptr();
    let dst = values.as_mut_ptr();
    for i in 0..expected_values {
        // SAFETY: `raw` was checked to contain at least `expected_values * 2`
        // bytes, and `values` has capacity for every output sample.
        unsafe {
            let be = (src_ptr.add(i * 2) as *const u16).read_unaligned();
            dst.add(i).write(u16::from_be(be));
        }
    }
    unsafe {
        values.set_len(expected_values);
    }
    let convert_time = js_sys::Date::now() - convert_start;
    let total_time = js_sys::Date::now() - start_time;

    Ok(PngResult {
        width: info.width,
        height: info.height,
        channels,
        bit_depth: 16,
        color_type: png_color_type_to_u32(info.color_type),
        data_u16: values,
        timing_read_info_ms: read_info_time,
        timing_decode_ms: decode_time,
        timing_convert_ms: convert_time,
        timing_total_ms: total_time,
    })
}

fn png_color_type_to_u32(color_type: png::ColorType) -> u32 {
    match color_type {
        png::ColorType::Grayscale => 0,
        png::ColorType::Rgb => 2,
        png::ColorType::Indexed => 3,
        png::ColorType::GrayscaleAlpha => 4,
        png::ColorType::Rgba => 6,
    }
}

#[wasm_bindgen]
pub fn decode_hdr_fast(data: &[u8]) -> Result<HdrResult, JsValue> {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();

    decode_hdr_impl(data)
}

/// Turn Radiance HDR header lines into generic {name, value} tags: `KEY=VALUE`
/// lines split on the first `=`, `#`-prefixed lines become "Comment" rows,
/// anything else (e.g. the resolution line) is kept verbatim under "Header".
fn hdr_header_lines_to_json(lines: &[String]) -> String {
    let mut out = Vec::new();
    for line in lines {
        let (name, value) = if let Some(rest) = line.strip_prefix('#') {
            ("Comment", rest.trim())
        } else if let Some(eq_pos) = line.find('=') {
            (&line[..eq_pos], &line[eq_pos + 1..])
        } else {
            ("Header", line.as_str())
        };
        push_generic_attr_row(&mut out, "HDR", name, value.to_string());
    }
    format!("[{}]", out.join(","))
}

fn decode_hdr_impl(data: &[u8]) -> Result<HdrResult, JsValue> {
    let start_time = js_sys::Date::now();
    let mut offset = 0usize;
    let mut width = 0usize;
    let mut height = 0usize;
    let mut exposure = 1.0f32;
    let mut gamma = 1.0f32;
    let mut rle = false;
    // Every non-empty header line (comments, SOFTWARE=, VIEW=, custom fields,
    // and the recognized ones below), kept generically for the Metadata panel.
    let mut header_lines: Vec<String> = Vec::new();

    for _ in 0..128 {
        let line_start = offset;
        while offset < data.len() && data[offset] != b'\n' {
            offset += 1;
        }
        if offset >= data.len() {
            return Err(JsValue::from_str("HDR header ended before resolution line"));
        }
        let line_bytes = &data[line_start..offset];
        offset += 1;
        let line = std::str::from_utf8(line_bytes)
            .map_err(|_| JsValue::from_str("HDR header is not UTF-8"))?
            .trim();
        if !line.is_empty() {
            header_lines.push(line.to_string());
        }
        if line == "FORMAT=32-bit_rle_rgbe" {
            rle = true;
        } else if let Some(value) = line.strip_prefix("EXPOSURE=") {
            exposure = value.trim().parse::<f32>().unwrap_or(1.0);
        } else if let Some(value) = line.strip_prefix("GAMMA=") {
            gamma = value.trim().parse::<f32>().unwrap_or(1.0);
        } else if line.starts_with("-Y ") && line.contains(" +X ") {
            let mut parts = line.split_whitespace();
            if parts.next() == Some("-Y") {
                height = parts.next()
                    .ok_or_else(|| JsValue::from_str("Missing HDR height"))?
                    .parse::<usize>()
                    .map_err(|_| JsValue::from_str("Invalid HDR height"))?;
                if parts.next() != Some("+X") {
                    return Err(JsValue::from_str("Unsupported HDR orientation"));
                }
                width = parts.next()
                    .ok_or_else(|| JsValue::from_str("Missing HDR width"))?
                    .parse::<usize>()
                    .map_err(|_| JsValue::from_str("Invalid HDR width"))?;
                break;
            }
        }
    }

    let header_time = js_sys::Date::now() - start_time;
    if width == 0 || height == 0 {
        return Err(JsValue::from_str("HDR resolution line not found"));
    }
    if !rle {
        return Err(JsValue::from_str("Only FORMAT=32-bit_rle_rgbe HDR files are supported"));
    }
    if width > 0x7fff {
        return Err(JsValue::from_str("HDR scanline is too wide for RLE"));
    }

    let pixel_count = width.checked_mul(height)
        .ok_or_else(|| JsValue::from_str("HDR dimensions overflow"))?;
    let mut scanline = vec![0u8; width * 4];
    let mut output = vec![0f32; pixel_count * 4];
    let mut scales = [0f32; 256];
    for e in 1..256 {
        scales[e] = 2f32.powi(e as i32 - 128) / 255.0;
    }
    let mut rle_time = 0.0;
    let mut convert_time = 0.0;

    for y in 0..height {
        let rle_start = js_sys::Date::now();
        if offset + 4 > data.len() {
            return Err(JsValue::from_str("Unexpected EOF in HDR scanline header"));
        }
        let b0 = data[offset];
        let b1 = data[offset + 1];
        let b2 = data[offset + 2];
        let b3 = data[offset + 3];
        offset += 4;
        if b0 != 2 || b1 != 2 || (b2 & 0x80) != 0 {
            return Err(JsValue::from_str("HDR file is not new-style RLE encoded"));
        }
        let scanline_width = ((b2 as usize) << 8) | b3 as usize;
        if scanline_width != width {
            return Err(JsValue::from_str("HDR scanline width mismatch"));
        }
        for channel in 0..4 {
            let mut ptr = channel * width;
            let end = ptr + width;
            while ptr < end {
                if offset + 2 > data.len() {
                    return Err(JsValue::from_str("Unexpected EOF in HDR RLE data"));
                }
                let count_byte = data[offset];
                let value = data[offset + 1];
                offset += 2;
                if count_byte > 128 {
                    let count = (count_byte - 128) as usize;
                    if count == 0 || ptr + count > end {
                        return Err(JsValue::from_str("Bad HDR RLE run"));
                    }
                    scanline[ptr..ptr + count].fill(value);
                    ptr += count;
                } else {
                    let count = count_byte as usize;
                    if count == 0 || ptr + count > end {
                        return Err(JsValue::from_str("Bad HDR RLE literal"));
                    }
                    scanline[ptr] = value;
                    ptr += 1;
                    if count > 1 {
                        let remaining = count - 1;
                        if offset + remaining > data.len() {
                            return Err(JsValue::from_str("Unexpected EOF in HDR literal"));
                        }
                        scanline[ptr..ptr + remaining].copy_from_slice(&data[offset..offset + remaining]);
                        ptr += remaining;
                        offset += remaining;
                    }
                }
            }
        }
        rle_time += js_sys::Date::now() - rle_start;

        let convert_start = js_sys::Date::now();
        let row_offset = y * width * 4;
        for x in 0..width {
            let e = scanline[x + width * 3] as usize;
            let out = row_offset + x * 4;
            if e == 0 {
                output[out] = 0.0;
                output[out + 1] = 0.0;
                output[out + 2] = 0.0;
            } else {
                let scale = scales[e];
                output[out] = scanline[x] as f32 * scale;
                output[out + 1] = scanline[x + width] as f32 * scale;
                output[out + 2] = scanline[x + width * 2] as f32 * scale;
            }
            output[out + 3] = 1.0;
        }
        convert_time += js_sys::Date::now() - convert_start;
    }

    Ok(HdrResult {
        data_f32: output,
        metadata_f64: vec![
            width as f64,
            height as f64,
            exposure as f64,
            gamma as f64,
            header_time,
            rle_time,
            convert_time,
            js_sys::Date::now() - start_time,
        ],
        all_tags_json: hdr_header_lines_to_json(&header_lines),
    })
}

/// Push one `{"tag":null,"name":...,"group":...,"value":...}` JSON fragment.
fn push_generic_attr_row(out: &mut Vec<String>, group: &str, name: &str, value_debug: String) {
    out.push(format!(
        "{{\"tag\":null,\"name\":\"{}\",\"group\":\"{}\",\"value\":\"{}\"}}",
        json_escape(name), json_escape(group), json_escape(&value_debug)
    ));
}

/// Dump every EXR header attribute (image + layer) as JSON, generically:
/// each named `Option<T>` field on `ImageAttributes`/`LayerAttributes` plus
/// the crate's own catch-all `other` maps for custom/vendor attributes, so
/// nothing an EXR file carries is left out.
fn extract_exr_tags_json(
    image_attrs: &exr::meta::header::ImageAttributes,
    layer_attrs: &exr::meta::header::LayerAttributes,
) -> String {
    let mut out = Vec::new();
    const GROUP: &str = "EXR";

    macro_rules! opt_field {
        ($field:expr, $name:expr) => {
            if let Some(v) = &$field {
                push_generic_attr_row(&mut out, GROUP, $name, format!("{:?}", v));
            }
        };
    }

    push_generic_attr_row(&mut out, GROUP, "displayWindow", format!("{:?}", image_attrs.display_window));
    push_generic_attr_row(&mut out, GROUP, "pixelAspect", format!("{}", image_attrs.pixel_aspect));
    opt_field!(image_attrs.chromaticities, "chromaticities");
    opt_field!(image_attrs.time_code, "timeCode");
    for (key, value) in image_attrs.other.iter() {
        push_generic_attr_row(&mut out, GROUP, &key.to_string(), format!("{:?}", value));
    }

    opt_field!(layer_attrs.layer_name, "layerName");
    push_generic_attr_row(&mut out, GROUP, "layerPosition", format!("{:?}", layer_attrs.layer_position));
    push_generic_attr_row(&mut out, GROUP, "screenWindowCenter", format!("{:?}", layer_attrs.screen_window_center));
    push_generic_attr_row(&mut out, GROUP, "screenWindowWidth", format!("{}", layer_attrs.screen_window_width));
    opt_field!(layer_attrs.white_luminance, "whiteLuminance");
    opt_field!(layer_attrs.adopted_neutral, "adoptedNeutral");
    opt_field!(layer_attrs.rendering_transform_name, "renderingTransformName");
    opt_field!(layer_attrs.look_modification_transform_name, "lookModificationTransformName");
    opt_field!(layer_attrs.horizontal_density, "horizontalDensity");
    opt_field!(layer_attrs.owner, "owner");
    opt_field!(layer_attrs.comments, "comments");
    opt_field!(layer_attrs.capture_date, "captureDate");
    opt_field!(layer_attrs.utc_offset, "utcOffset");
    opt_field!(layer_attrs.longitude, "longitude");
    opt_field!(layer_attrs.latitude, "latitude");
    opt_field!(layer_attrs.altitude, "altitude");
    opt_field!(layer_attrs.focus, "focus");
    opt_field!(layer_attrs.exposure, "exposure");
    opt_field!(layer_attrs.aperture, "aperture");
    opt_field!(layer_attrs.iso_speed, "isoSpeed");
    opt_field!(layer_attrs.environment_map, "environmentMap");
    opt_field!(layer_attrs.film_key_code, "filmKeyCode");
    opt_field!(layer_attrs.wrap_mode_name, "wrapModeName");
    opt_field!(layer_attrs.frames_per_second, "framesPerSecond");
    opt_field!(layer_attrs.multi_view_names, "multiViewNames");
    opt_field!(layer_attrs.world_to_camera, "worldToCamera");
    opt_field!(layer_attrs.world_to_normalized_device, "worldToNormalizedDevice");
    opt_field!(layer_attrs.deep_image_state, "deepImageState");
    opt_field!(layer_attrs.original_data_window, "originalDataWindow");
    opt_field!(layer_attrs.view_name, "viewName");
    opt_field!(layer_attrs.software_name, "softwareName");
    opt_field!(layer_attrs.near_clip_plane, "nearClipPlane");
    opt_field!(layer_attrs.far_clip_plane, "farClipPlane");
    opt_field!(layer_attrs.horizontal_field_of_view, "horizontalFieldOfView");
    opt_field!(layer_attrs.vertical_field_of_view, "verticalFieldOfView");
    for (key, value) in layer_attrs.other.iter() {
        push_generic_attr_row(&mut out, GROUP, &key.to_string(), format!("{:?}", value));
    }

    format!("[{}]", out.join(","))
}

fn decode_exr_impl(data: &[u8]) -> Result<ExrResult, JsValue> {
    use exr::prelude::*;

    let start_time = js_sys::Date::now();
    let cursor = Cursor::new(data);
    let image = read()
        .no_deep_data()
        .largest_resolution_level()
        .all_channels()
        .first_valid_layer()
        .all_attributes()
        .from_buffered(cursor)
        .map_err(|e| JsValue::from_str(&format!("Failed to decode EXR: {}", e)))?;
    let read_time = js_sys::Date::now() - start_time;
    let pack_start = js_sys::Date::now();

    let layer = image.layer_data;
    let width = layer.size.0;
    let height = layer.size.1;
    if width == 0 || height == 0 {
        return Err(JsValue::from_str("EXR has empty dimensions"));
    }

    let mut channels = layer.channel_data.list;
    if channels.is_empty() {
        return Err(JsValue::from_str("EXR has no flat channels"));
    }

    let pixel_count = width
        .checked_mul(height)
        .ok_or_else(|| JsValue::from_str("EXR dimensions overflow"))?;
    let channel_names: Vec<String> = channels.iter().map(|channel| channel.name.to_string()).collect();
    let selection = select_exr_display_channels(&channel_names);
    if selection.source_indices.is_empty() {
        return Err(JsValue::from_str("EXR has no displayable channels"));
    }

    for &index in selection.source_indices.iter().flatten() {
        let channel = &channels[index];
        if channel.sampling.0 != 1 || channel.sampling.1 != 1 {
            return Err(JsValue::from_str("Subsampled EXR channels are not supported by the Rust fast path"));
        }
        if channel.sample_data.len() < pixel_count {
            return Err(JsValue::from_str("EXR channel sample count is smaller than the image dimensions"));
        }
    }

    let output_channels = selection.source_indices.len();
    let interleaved = if output_channels == 1 {
        let source_index = selection.source_indices[0]
            .ok_or_else(|| JsValue::from_str("EXR grayscale selection unexpectedly has no source channel"))?;
        let samples = mem::replace(&mut channels[source_index].sample_data, FlatSamples::F32(Vec::new()));
        exr_samples_into_f32_vec(samples, pixel_count)
    } else {
        let mut interleaved = vec![0.0f32; pixel_count * output_channels];
        for (out_channel, source_index) in selection.source_indices.iter().enumerate() {
            if let Some(source_index) = source_index {
                copy_exr_channel_to_interleaved(
                    &channels[*source_index].sample_data,
                    &mut interleaved,
                    out_channel,
                    output_channels,
                    pixel_count,
                );
            } else {
                fill_exr_interleaved_channel(&mut interleaved, out_channel, output_channels, pixel_count, 1.0);
            }
        }
        interleaved
    };

    let format = if output_channels == 1 { 1028 } else { 1023 };
    let pack_time = js_sys::Date::now() - pack_start;
    let total_time = js_sys::Date::now() - start_time;
    let all_tags_json = extract_exr_tags_json(&image.attributes, &layer.attributes);

    Ok(ExrResult {
        width: width as u32,
        height: height as u32,
        channels: output_channels as u32,
        data_f32: interleaved,
        channel_names_csv: channel_names.join(","),
        displayed_channels_csv: selection.displayed_names.join(","),
        format,
        data_type: 1015,
        timing_read_ms: read_time,
        timing_pack_ms: pack_time,
        timing_total_ms: total_time,
        all_tags_json,
    })
}

struct ExrChannelSelection {
    source_indices: Vec<Option<usize>>,
    displayed_names: Vec<String>,
}

fn select_exr_display_channels(channel_names: &[String]) -> ExrChannelSelection {
    let mut y = None;
    let mut r = None;
    let mut g = None;
    let mut b = None;
    let mut a = None;

    for (index, name) in channel_names.iter().enumerate() {
        let base = exr_base_channel_name(name);
        match base {
            "Y" => y.get_or_insert(index),
            "R" => r.get_or_insert(index),
            "G" => g.get_or_insert(index),
            "B" => b.get_or_insert(index),
            "A" => a.get_or_insert(index),
            "Z" | "z" | "depth" | "Depth" | "DEPTH" => y.get_or_insert(index),
            _ if channel_names.len() == 1 => y.get_or_insert(index),
            _ => continue,
        };
    }

    if let (Some(r), Some(g), Some(b)) = (r, g, b) {
        let mut source_indices = vec![Some(r), Some(g), Some(b)];
        let mut displayed_names = vec![
            channel_names[r].clone(),
            channel_names[g].clone(),
            channel_names[b].clone(),
        ];
        if let Some(a) = a {
            source_indices.push(Some(a));
            displayed_names.push(channel_names[a].clone());
        } else {
            source_indices.push(None);
        }
        return ExrChannelSelection { source_indices, displayed_names };
    }

    if let Some(index) = y {
        return ExrChannelSelection {
            source_indices: vec![Some(index)],
            displayed_names: vec![channel_names[index].clone()],
        };
    }

    for (index, name) in channel_names.iter().enumerate() {
        let base = exr_base_channel_name(name);
        if base == "R" || base == "G" || base == "B" {
            return ExrChannelSelection {
                source_indices: vec![Some(index)],
                displayed_names: vec![channel_names[index].clone()],
            };
        }
    }

    ExrChannelSelection { source_indices: Vec::new(), displayed_names: Vec::new() }
}

fn exr_base_channel_name(name: &str) -> &str {
    name.rsplit('.').next().unwrap_or(name)
}

fn copy_exr_channel_to_interleaved(
    samples: &FlatSamples,
    out: &mut [f32],
    out_channel: usize,
    output_channels: usize,
    pixel_count: usize,
) {
    match samples {
        FlatSamples::F16(values) => {
            for i in 0..pixel_count {
                out[i * output_channels + out_channel] = values[i].to_f32();
            }
        }
        FlatSamples::F32(values) => {
            for i in 0..pixel_count {
                out[i * output_channels + out_channel] = values[i];
            }
        }
        FlatSamples::U32(values) => {
            for i in 0..pixel_count {
                out[i * output_channels + out_channel] = values[i] as f32;
            }
        }
    }
}

fn exr_samples_into_f32_vec(samples: FlatSamples, pixel_count: usize) -> Vec<f32> {
    match samples {
        FlatSamples::F16(values) => {
            let mut out = Vec::with_capacity(pixel_count);
            for value in values.into_iter().take(pixel_count) {
                out.push(value.to_f32());
            }
            out
        }
        FlatSamples::F32(mut values) => {
            values.truncate(pixel_count);
            values
        }
        FlatSamples::U32(values) => {
            let mut out = Vec::with_capacity(pixel_count);
            for value in values.into_iter().take(pixel_count) {
                out.push(value as f32);
            }
            out
        }
    }
}

fn fill_exr_interleaved_channel(
    out: &mut [f32],
    out_channel: usize,
    output_channels: usize,
    pixel_count: usize,
    value: f32,
) {
    for i in 0..pixel_count {
        out[i * output_channels + out_channel] = value;
    }
}

/// Escape a string for embedding as a JSON string literal.
fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Render any TIFF tag value as a human-readable string, regardless of its
/// underlying type. Falls back to `Debug` for the rarer/deprecated variants
/// (e.g. `RationalBig`) so this stays correct as the `tiff` crate's
/// `#[non_exhaustive]` `Value` enum grows.
fn value_to_display_string(value: &tiff::decoder::ifd::Value) -> String {
    use tiff::decoder::ifd::Value;
    match value {
        Value::Byte(v) => v.to_string(),
        Value::Short(v) => v.to_string(),
        Value::SignedByte(v) => v.to_string(),
        Value::SignedShort(v) => v.to_string(),
        Value::Signed(v) => v.to_string(),
        Value::SignedBig(v) => v.to_string(),
        Value::Unsigned(v) => v.to_string(),
        Value::UnsignedBig(v) => v.to_string(),
        Value::Float(v) => v.to_string(),
        Value::Double(v) => v.to_string(),
        Value::Rational(n, d) if *d != 0 => format!("{}/{} ({:.6})", n, d, *n as f64 / *d as f64),
        Value::Rational(n, d) => format!("{}/{}", n, d),
        Value::SRational(n, d) if *d != 0 => format!("{}/{} ({:.6})", n, d, *n as f64 / *d as f64),
        Value::SRational(n, d) => format!("{}/{}", n, d),
        Value::Ascii(s) => s.trim_end_matches('\0').to_string(),
        Value::Ifd(v) => format!("IFD@{}", v),
        Value::IfdBig(v) => format!("IFD@{}", v),
        Value::List(items) => items
            .iter()
            .map(value_to_display_string)
            .collect::<Vec<_>>()
            .join(", "),
        other => format!("{:?}", other),
    }
}

/// Recursively serialize every tag in `entries` (and, for `ExifDirectory` /
/// `GpsDirectory` pointer tags, the sub-IFD they point to) into `out` as JSON
/// object fragments. This walks the raw tag map generically, so it surfaces
/// every tag present in the file rather than a curated subset.
fn append_ifd_tags(
    decoder: &mut Decoder<Cursor<&[u8]>>,
    entries: Vec<(tiff::tags::Tag, tiff::decoder::ifd::Value)>,
    group: &str,
    out: &mut Vec<String>,
) {
    use tiff::tags::Tag;

    for (tag, value) in entries {
        if matches!(tag, Tag::ExifDirectory | Tag::GpsDirectory) {
            if let Ok(ptr) = value.clone().into_ifd_pointer() {
                if let Ok(subdir) = decoder.read_directory(ptr) {
                    let sub_entries: Vec<_> = decoder
                        .read_directory_tags(&subdir)
                        .tag_iter()
                        .filter_map(|r| r.ok())
                        .collect();
                    let sub_group = if matches!(tag, Tag::ExifDirectory) { "Exif" } else { "GPS" };
                    append_ifd_tags(decoder, sub_entries, sub_group, out);
                    continue;
                }
            }
        }

        out.push(format!(
            "{{\"tag\":{},\"name\":\"{}\",\"group\":\"{}\",\"value\":\"{}\"}}",
            tag.to_u16(),
            json_escape(&format!("{:?}", tag)),
            json_escape(group),
            json_escape(&value_to_display_string(&value))
        ));
    }
}

/// Dump every tag in the file's main IFD (plus any Exif/GPS sub-IFD) as a JSON
/// array. Independent of whichever specialized pixel-decode path is used, so
/// it's recomputed cheaply (a handful of IFD entries, not the pixel data)
/// wherever a `TiffResult` is built.
fn extract_all_tags_json(data: &[u8]) -> String {
    extract_page_tags_json(data, 0)
}

fn extract_ome_xml(data: &[u8]) -> String {
    let mut decoder = match Decoder::new(Cursor::new(data)) {
        Ok(d) => d,
        Err(_) => return String::new(),
    };
    let description = decoder
        .get_tag_ascii_string(tiff::tags::Tag::ImageDescription)
        .unwrap_or_default();
    let trimmed = description.trim_start_matches('\u{feff}').trim_start();
	// The recommended OME-TIFF header includes a warning XML comment before
	// the OME root, so detection must not require OME to be the first token.
    if trimmed.contains("<OME") || trimmed.contains(":OME") {
        description
    } else {
        String::new()
    }
}

fn extract_page_tags_json(data: &[u8], page_index: u32) -> String {
    let mut decoder = match Decoder::new(Cursor::new(data)) {
        Ok(d) => d,
        Err(_) => return "[]".to_string(),
    };
    for _ in 0..page_index {
        if decoder.next_image().is_err() {
            return "[]".to_string();
        }
    }
    let main_entries: Vec<_> = decoder
        .image_ifd()
        .tag_iter()
        .filter_map(|r| r.ok())
        .collect();
    let mut out = Vec::new();
    append_ifd_tags(&mut decoder, main_entries, "TIFF", &mut out);
    format!("[{}]", out.join(","))
}

/// TIFF/Exif field type sizes in bytes, per the TIFF6/Exif spec (type IDs 1-12).
fn ifd_type_size(type_id: u16) -> usize {
    match type_id {
        1 | 2 | 6 | 7 => 1,  // BYTE, ASCII, SBYTE, UNDEFINED
        3 | 8 => 2,          // SHORT, SSHORT
        4 | 9 | 11 => 4,     // LONG, SLONG, FLOAT
        5 | 10 | 12 => 8,    // RATIONAL, SRATIONAL, DOUBLE
        _ => 0,
    }
}

/// Render one IFD entry's value bytes as a human-readable string, generically
/// across all twelve standard TIFF/Exif field types. Caps very long arrays at
/// 16 shown elements, mirroring `value_to_display_string`'s `List` handling.
fn format_bare_ifd_value(data: &[u8], type_id: u16, count: u32, inline_bytes: &[u8], big_endian: bool) -> String {
    let elem_size = ifd_type_size(type_id);
    if elem_size == 0 {
        return format!("<unsupported field type {}>", type_id);
    }
    let total_size = elem_size.saturating_mul(count as usize);
    let bytes: &[u8] = if total_size <= 4 {
        &inline_bytes[..total_size.min(inline_bytes.len())]
    } else {
        let offset = if big_endian {
            u32::from_be_bytes([inline_bytes[0], inline_bytes[1], inline_bytes[2], inline_bytes[3]])
        } else {
            u32::from_le_bytes([inline_bytes[0], inline_bytes[1], inline_bytes[2], inline_bytes[3]])
        } as usize;
        match data.get(offset..offset.saturating_add(total_size)) {
            Some(b) => b,
            None => return "<value out of range>".to_string(),
        }
    };

    let u16_at = |i: usize| -> u16 { let b = &bytes[i * 2..i * 2 + 2]; if big_endian { u16::from_be_bytes([b[0], b[1]]) } else { u16::from_le_bytes([b[0], b[1]]) } };
    let i16_at = |i: usize| -> i16 { let b = &bytes[i * 2..i * 2 + 2]; if big_endian { i16::from_be_bytes([b[0], b[1]]) } else { i16::from_le_bytes([b[0], b[1]]) } };
    let u32_at = |i: usize| -> u32 { let b = &bytes[i * 4..i * 4 + 4]; if big_endian { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } };
    let i32_at = |i: usize| -> i32 { let b = &bytes[i * 4..i * 4 + 4]; if big_endian { i32::from_be_bytes([b[0], b[1], b[2], b[3]]) } else { i32::from_le_bytes([b[0], b[1], b[2], b[3]]) } };
    let f32_at = |i: usize| -> f32 { let b = &bytes[i * 4..i * 4 + 4]; if big_endian { f32::from_be_bytes([b[0], b[1], b[2], b[3]]) } else { f32::from_le_bytes([b[0], b[1], b[2], b[3]]) } };
    let f64_at = |i: usize| -> f64 { let b = &bytes[i * 8..i * 8 + 8]; let a = [b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]; if big_endian { f64::from_be_bytes(a) } else { f64::from_le_bytes(a) } };

    let join_all = |n: usize, render: &dyn Fn(usize) -> String| -> String {
        (0..n).map(render).collect::<Vec<_>>().join(", ")
    };

    let n = count as usize;
    match type_id {
        2 => { // ASCII: NUL-terminated string
            let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
            String::from_utf8_lossy(&bytes[..end]).to_string()
        }
        1 | 7 => join_all(bytes.len(), &|i| bytes[i].to_string()), // BYTE, UNDEFINED
        6 => join_all(bytes.len(), &|i| (bytes[i] as i8).to_string()), // SBYTE
        3 => join_all(n, &|i| u16_at(i).to_string()),
        8 => join_all(n, &|i| i16_at(i).to_string()),
        4 => join_all(n, &|i| u32_at(i).to_string()),
        9 => join_all(n, &|i| i32_at(i).to_string()),
        11 => join_all(n, &|i| f32_at(i).to_string()),
        12 => join_all(n, &|i| f64_at(i).to_string()),
        5 => join_all(n, &|i| { // RATIONAL: pairs of u32
            let (num, den) = (u32_at(i * 2), u32_at(i * 2 + 1));
            if den != 0 { format!("{}/{} ({:.6})", num, den, num as f64 / den as f64) } else { format!("{}/{}", num, den) }
        }),
        10 => join_all(n, &|i| { // SRATIONAL: pairs of i32
            let (num, den) = (i32_at(i * 2), i32_at(i * 2 + 1));
            if den != 0 { format!("{}/{} ({:.6})", num, den, num as f64 / den as f64) } else { format!("{}/{}", num, den) }
        }),
        _ => "<unsupported field type>".to_string(),
    }
}

/// Recursively walk a raw IFD's entries (byte-level, no `tiff` crate
/// `Decoder`) starting at `ifd_offset`, pushing each as a JSON tag row and
/// following the Exif (0x8769) / GPS (0x8825) sub-IFD pointer tags.
fn walk_bare_ifd(data: &[u8], ifd_offset: usize, big_endian: bool, group: &str, out: &mut Vec<String>, depth: u32) {
    if depth > 4 { return; } // guard against absurd/cyclic offsets in malformed input
    let read_u16 = |offset: usize| -> Option<u16> {
        let b = data.get(offset..offset + 2)?;
        Some(if big_endian { u16::from_be_bytes([b[0], b[1]]) } else { u16::from_le_bytes([b[0], b[1]]) })
    };
    let read_u32 = |offset: usize| -> Option<u32> {
        let b = data.get(offset..offset + 4)?;
        Some(if big_endian { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) })
    };

    let entry_count = match read_u16(ifd_offset) { Some(c) => c as usize, None => return };
    for i in 0..entry_count {
        let entry_offset = ifd_offset + 2 + i * 12;
        let (Some(tag_id), Some(type_id), Some(count)) = (
            read_u16(entry_offset),
            read_u16(entry_offset + 2),
            read_u32(entry_offset + 4),
        ) else { continue };
        let value_bytes = match data.get(entry_offset + 8..entry_offset + 12) {
            Some(b) => b,
            None => continue,
        };

        // Exif (0x8769) / GPS (0x8825) sub-IFD pointer tags: a single LONG offset.
        if (tag_id == 0x8769 || tag_id == 0x8825) && type_id == 4 && count == 1 {
            if let Some(sub_offset) = read_u32(entry_offset + 8) {
                let sub_group = if tag_id == 0x8769 { "Exif" } else { "GPS" };
                walk_bare_ifd(data, sub_offset as usize, big_endian, sub_group, out, depth + 1);
                continue;
            }
        }

        let tag_name = format!("{:?}", tiff::tags::Tag::from_u16_exhaustive(tag_id));
        let value_str = format_bare_ifd_value(data, type_id, count, value_bytes, big_endian);
        push_generic_attr_row(out, group, &tag_name, value_str);
    }
}

/// Entry point for `extract_exif_tags`: parse a bare Exif-structured blob
/// (JPEG APP1 payload sans "Exif\0\0", or a PNG eXIf chunk) into JSON tags.
fn extract_bare_ifd_tags_json(data: &[u8]) -> String {
    if data.len() < 8 {
        return "[]".to_string();
    }
    let big_endian = match &data[0..2] {
        b"II" => false,
        b"MM" => true,
        _ => return "[]".to_string(),
    };
    let read_u16 = |offset: usize| -> u16 {
        let b = &data[offset..offset + 2];
        if big_endian { u16::from_be_bytes([b[0], b[1]]) } else { u16::from_le_bytes([b[0], b[1]]) }
    };
    let read_u32 = |offset: usize| -> u32 {
        let b = &data[offset..offset + 4];
        if big_endian { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) }
    };
    if read_u16(2) != 42 {
        return "[]".to_string();
    }
    let ifd0_offset = read_u32(4) as usize;

    let mut out = Vec::new();
    walk_bare_ifd(data, ifd0_offset, big_endian, "Exif", &mut out, 0);
    format!("[{}]", out.join(","))
}

/// Total sample element count (width * height * channels) actually held by a
/// decoded raster, regardless of which typed variant it came back as.
fn decoding_result_len(result: &DecodingResult) -> usize {
    match result {
        DecodingResult::U8(v) => v.len(),
        DecodingResult::U16(v) => v.len(),
        DecodingResult::U32(v) => v.len(),
        DecodingResult::U64(v) => v.len(),
        DecodingResult::I8(v) => v.len(),
        DecodingResult::I16(v) => v.len(),
        DecodingResult::I32(v) => v.len(),
        DecodingResult::I64(v) => v.len(),
        DecodingResult::F32(v) => v.len(),
        DecodingResult::F64(v) => v.len(),
        DecodingResult::F16(v) => v.len(),
    }
}

/// Naive, uncalibrated CMYK -> RGB conversion (no ICC profile applied):
/// `R = (max-C)*(max-K)/max`, and likewise for G/B from M/Y. `max` is the
/// full-scale value for the sample's numeric range (2^bits-1 for integer
/// data, 1.0 for float data already stored in a normalized 0..1 range).
fn cmyk_to_rgb_f64(c: f64, m: f64, y: f64, k: f64, max: f64) -> (f64, f64, f64) {
    if max <= 0.0 {
        return (0.0, 0.0, 0.0);
    }
    let r = (max - c) * (max - k) / max;
    let g = (max - m) * (max - k) / max;
    let b = (max - y) * (max - k) / max;
    (r, g, b)
}

/// Convert CMYK (4 samples/pixel) or CMYKA (5 samples/pixel) interleaved
/// pixel data to RGB / RGBA, sharing the same conversion regardless of which
/// decode path (`try_decode_uncompressed_strips`, `try_decode_general_strips_tiles`,
/// or the `decoder.read_image()` fallback) produced `result` - all of them
/// hand back raw, unconverted C,M,Y,K(,A) samples. A CMYKA alpha sample is
/// passed through unchanged (not treated as a fifth color channel). Sample
/// kinds this doesn't have a defined conversion for (signed integers, 64-bit
/// float/int) are passed through unconverted - CMYK TIFFs in practice are
/// unsigned-integer or float32.
fn convert_cmyk_to_rgb(result: DecodingResult, channels: u32) -> (DecodingResult, u32) {
    if channels != 4 && channels != 5 {
        return (result, channels);
    }
    let has_alpha = channels == 5;
    let out_channels = if has_alpha { 4 } else { 3 };
    let stride = channels as usize;

    macro_rules! convert_int {
        ($data:expr, $max:expr) => {{
            let max = $max as f64;
            let pixel_count = $data.len() / stride;
            let mut out = Vec::with_capacity(pixel_count * out_channels as usize);
            for px in $data.chunks_exact(stride) {
                let (r, g, b) = cmyk_to_rgb_f64(px[0] as f64, px[1] as f64, px[2] as f64, px[3] as f64, max);
                out.push(r.round().clamp(0.0, max) as _);
                out.push(g.round().clamp(0.0, max) as _);
                out.push(b.round().clamp(0.0, max) as _);
                if has_alpha {
                    out.push(px[4]);
                }
            }
            out
        }};
    }

    match result {
        DecodingResult::U8(data) => (DecodingResult::U8(convert_int!(data, u8::MAX)), out_channels),
        DecodingResult::U16(data) => (DecodingResult::U16(convert_int!(data, u16::MAX)), out_channels),
        DecodingResult::U32(data) => (DecodingResult::U32(convert_int!(data, u32::MAX)), out_channels),
        DecodingResult::F32(data) => {
            let pixel_count = data.len() / stride;
            let mut out = Vec::with_capacity(pixel_count * out_channels as usize);
            for px in data.chunks_exact(stride) {
                let (r, g, b) = cmyk_to_rgb_f64(px[0] as f64, px[1] as f64, px[2] as f64, px[3] as f64, 1.0);
                out.push(r as f32);
                out.push(g as f32);
                out.push(b as f32);
                if has_alpha {
                    out.push(px[4]);
                }
            }
            (DecodingResult::F32(out), out_channels)
        }
        // No defined CMYK conversion for these sample kinds (signed data
        // doesn't fit the [0, max] ink-coverage model, and 64-bit CMYK TIFFs
        // aren't a thing in practice) - leave the raw samples/channel count
        // untouched rather than silently mis-converting them.
        other => (other, channels),
    }
}

/// Orientation tag (274) values 2-8 the TIFF spec defines beyond the default
/// (1, top-left/no transform). Rows/columns below assume the interleaved
/// buffer's natural row-major layout (row 0 first, left-to-right).
#[derive(Clone, Copy, PartialEq)]
enum TiffOrientation {
    TopLeft = 1,
    TopRight = 2,
    BottomRight = 3,
    BottomLeft = 4,
    LeftTop = 5,
    RightTop = 6,
    RightBottom = 7,
    LeftBottom = 8,
}

impl TiffOrientation {
    fn from_tag(value: u32) -> Self {
        match value {
            2 => TiffOrientation::TopRight,
            3 => TiffOrientation::BottomRight,
            4 => TiffOrientation::BottomLeft,
            5 => TiffOrientation::LeftTop,
            6 => TiffOrientation::RightTop,
            7 => TiffOrientation::RightBottom,
            8 => TiffOrientation::LeftBottom,
            _ => TiffOrientation::TopLeft,
        }
    }

    /// True for the transpose variants (5-8), which swap width and height.
    fn transposes(self) -> bool {
        matches!(
            self,
            TiffOrientation::LeftTop | TiffOrientation::RightTop | TiffOrientation::RightBottom | TiffOrientation::LeftBottom
        )
    }
}

/// Apply a TIFF Orientation tag transform to an interleaved pixel buffer,
/// generic over sample type (`T: Copy`) and channel count, so it works for
/// every `DecodingResult` variant (bytes, u16, f32, ...) without duplicating
/// the geometry per type. Returns the (possibly swapped) output width/height
/// alongside the transformed buffer. `TopLeft` (the default / no tag) is a
/// no-op handled by the caller before this is invoked.
fn apply_orientation<T: Copy>(
    data: &[T],
    width: u32,
    height: u32,
    channels: u32,
    orientation: TiffOrientation,
) -> (Vec<T>, u32, u32) {
    let (w, h, c) = (width as usize, height as usize, channels as usize);
    let (out_w, out_h) = if orientation.transposes() { (h, w) } else { (w, h) };
    let mut out = Vec::with_capacity(w * h * c);
    // SAFETY-free: just push in the destination's row-major order, reading
    // whichever source pixel maps to that destination position.
    for out_y in 0..out_h {
        for out_x in 0..out_w {
            // For each orientation, (src_x, src_y) is the source pixel that
            // belongs at destination (out_x, out_y).
            let (src_x, src_y) = match orientation {
                TiffOrientation::TopLeft => (out_x, out_y),
                TiffOrientation::TopRight => (w - 1 - out_x, out_y),
                TiffOrientation::BottomRight => (w - 1 - out_x, h - 1 - out_y),
                TiffOrientation::BottomLeft => (out_x, h - 1 - out_y),
                TiffOrientation::LeftTop => (out_y, out_x),
                TiffOrientation::RightTop => (out_y, h - 1 - out_x),
                TiffOrientation::RightBottom => (w - 1 - out_y, h - 1 - out_x),
                TiffOrientation::LeftBottom => (w - 1 - out_y, out_x),
            };
            let src_index = (src_y * w + src_x) * c;
            out.extend_from_slice(&data[src_index..src_index + c]);
        }
    }
    (out, out_w as u32, out_h as u32)
}

/// Shared post-decode finalization for the decode paths that produce their
/// own complete `TiffResult` early (`decode_ccitt`, `decode_jpeg_ycbcr`,
/// `decode_palette`) rather than flowing through `decode_tiff_impl`'s main
/// pipeline: CMYK->RGB conversion (a no-op unless `photometric_interpretation`
/// is 5 - none of the three callers ever produce genuine 4-sample CMYK data,
/// but the call is kept uniform so a future photometric-interpretation fix-up
/// only needs to be added once) followed by the Orientation tag transform.
/// `data` is always plain one-byte-per-sample interleaved bytes for these
/// callers (CCITT/palette are already 8-bit grayscale/RGB, JPEG-YCbCr is
/// decoded straight to 8-bit RGB), so `bytes_per_pixel` doubles as the sample
/// stride here, unlike the main pipeline's `data_bytes` where it can be a
/// packed multi-byte sample width. Returns the finalized buffer plus the
/// (possibly transposed) width/height and (possibly CMYK-converted) channel
/// count. `decode_tiff_impl`'s own main pipeline applies the same two
/// building blocks (`convert_cmyk_to_rgb` / `apply_orientation`) itself
/// rather than through this helper, since its CMYK step has to run on typed
/// samples before they are packed into bytes/f32 (see the comment there).
fn finalize_decode_bytes(
    data: Vec<u8>,
    width: u32,
    height: u32,
    channels: u32,
    photometric_interpretation: u32,
    orientation: TiffOrientation,
) -> (Vec<u8>, u32, u32, u32) {
    let (data, channels) = if photometric_interpretation == 5 {
        match convert_cmyk_to_rgb(DecodingResult::U8(data), channels) {
            (DecodingResult::U8(converted), converted_channels) => (converted, converted_channels),
            _ => unreachable!("convert_cmyk_to_rgb preserves the U8 variant for U8 input"),
        }
    } else {
        (data, channels)
    };

    if orientation == TiffOrientation::TopLeft {
        return (data, width, height, channels);
    }
    let pixel_count = (width as usize) * (height as usize);
    let bytes_per_pixel = if pixel_count > 0 { data.len() / pixel_count } else { 0 };
    if bytes_per_pixel == 0 {
        return (data, width, height, channels);
    }
    let (oriented, w, h) = apply_orientation(&data, width, height, bytes_per_pixel as u32, orientation);
    (oriented, w, h, channels)
}

fn decode_tiff_impl(data: &[u8], compute_stats: bool, page_index: u32) -> Result<TiffResult, JsValue> {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();

    let start_time = js_sys::Date::now();

    // CFA (Bayer) files declare PhotometricInterpretation 32803, which the tiff
    // crate refuses in Decoder::new. Their pixels are an ordinary single-channel
    // plane, so decode against a copy that says BlackIsZero and put the real
    // value back afterwards -- the webview keys CFA auto-detection off it.
    let cfa_patched = demosaic::neutralize_cfa_photometric(data);
    let data: &[u8] = cfa_patched.as_deref().unwrap_or(data);
    let cfa_photometric = cfa_patched.as_ref().map(|_| demosaic::PHOTOMETRIC_CFA);

    let cursor = Cursor::new(data);
    let mut decoder = Decoder::new(cursor)
        .map_err(|e| JsValue::from_str(&format!("Failed to create decoder: {}", e)))?;

    for current in 0..page_index {
        if !decoder.more_images() {
            return Err(JsValue::from_str(&format!(
                "TIFF page index {} is out of range (only {} page(s))",
                page_index,
                current + 1
            )));
        }
        decoder.next_image()
            .map_err(|e| JsValue::from_str(&format!("Failed to select TIFF page {}: {}", page_index, e)))?;
    }

    let (width, height) = decoder.dimensions()
        .map_err(|e| JsValue::from_str(&format!("Failed to get dimensions: {}", e)))?;

    // Palette (RGBPalette, PhotometricInterpretation 3) images are rejected by
    // the tiff crate's colortype()/read_image(), so handle them via a dedicated
    // index + ColorMap path before those calls error out.
    let photometric_early = decoder.get_tag_u32(tiff::tags::Tag::PhotometricInterpretation).unwrap_or(1);
    if photometric_early == 3 {
        return decode_palette(data, width, height, page_index);
    }

    // Get color type and bits per sample
    let color_type = decoder.colortype()
        .map_err(|e| JsValue::from_str(&format!("Failed to get color type: {}", e)))?;

    // `channels` MUST equal the actual per-pixel stride of the buffer we hand
    // back below, so SamplesPerPixel (tag 277) - not `color_type` - is the
    // authoritative source: `tiff::ColorType` only reports the samples that
    // belong to the photometric interpretation (e.g. RGB(_) => 3 num_samples())
    // and silently drops any additional "extra" samples that aren't alpha
    // (see e.g. shapes_hyper.tif: PhotometricInterpretation RGB with 4 extra
    // unspecified bands - SamplesPerPixel=7 but ColorType::RGB(_).num_samples()
    // is 3). Falling back to color_type.num_samples() only covers the rare
    // case where the tag itself is missing (default is 1 per the TIFF spec).
    let samples_per_pixel_tag = decoder.get_tag_u32(tiff::tags::Tag::SamplesPerPixel).unwrap_or(0);
    let mut channels = if samples_per_pixel_tag > 0 {
        samples_per_pixel_tag
    } else {
        color_type.num_samples() as u32
    };
    // YCbCr strips are always converted to interleaved RGB by the tiff crate
    // (and by decode_jpeg_ycbcr below), so the buffer is 3 samples/pixel
    // regardless of what SamplesPerPixel says.
    if matches!(color_type, tiff::ColorType::YCbCr(_)) {
        channels = 3;
    }

    // Try to get bits per sample. `ColorType::bit_depth()` covers every
    // variant (including `Multiband`/`CMYKA`, which the old hand-rolled match
    // silently defaulted to 8 for), so use it directly.
    let mut bits_per_sample = color_type.bit_depth() as u32;

    // Extract metadata from decoder
    // Get compression method (default to 1 = None if not found)
    let compression = decoder.get_tag_u32(tiff::tags::Tag::Compression)
        .unwrap_or(1);
    
    // Get predictor (default to 1 = None if not found)
    let predictor = decoder.get_tag_u32(tiff::tags::Tag::Predictor)
        .unwrap_or(1);
    
    // Get photometric interpretation (default to 1 = BlackIsZero if not found).
    // For a neutralized CFA file this reads the substituted BlackIsZero, which
    // is what the decode paths below should branch on; the real 32803 is put
    // back only when the result is assembled.
    let photometric_interpretation = decoder.get_tag_u32(tiff::tags::Tag::PhotometricInterpretation)
        .unwrap_or(1);
    
    // Get planar configuration (default to 1 = Chunky if not found)
    let planar_configuration = decoder.get_tag_u32(tiff::tags::Tag::PlanarConfiguration)
        .unwrap_or(1);

    // Orientation tag (274, default 1 = top-left / no transform). Applied as a
    // pixel-buffer transform near the end of this function (after the decode
    // path produces its final interleaved bytes/floats), and via
    // `finalize_decode_bytes` for the CCITT/JPEG-YCbCr/palette early-return
    // paths below, so it's shared by every decode path uniformly. The raw tag
    // value is preserved here for `extract_all_tags_json` to report in the
    // Metadata panel.
    let orientation = TiffOrientation::from_tag(
        decoder.get_tag_u32(tiff::tags::Tag::Orientation).unwrap_or(1)
    );

    let rows_per_strip = decoder.get_tag_u32(tiff::tags::Tag::RowsPerStrip).unwrap_or(height);
    let strip_byte_counts = decoder.get_tag_u64_vec(tiff::tags::Tag::StripByteCounts).unwrap_or_default();
    let strip_count = strip_byte_counts.len() as u32;
    let strip_byte_count_total = strip_byte_counts.iter().copied().sum::<u64>();
    let strip_byte_count_max = strip_byte_counts.iter().copied().max().unwrap_or(0);
    let tile_width = decoder.get_tag_u32(tiff::tags::Tag::TileWidth).unwrap_or(0);
    let tile_length = decoder.get_tag_u32(tiff::tags::Tag::TileLength).unwrap_or(0);
    let tile_count = decoder.get_tag_u64_vec(tiff::tags::Tag::TileByteCounts)
        .map(|counts| counts.len() as u32)
        .unwrap_or(0);

    // CCITT fax compressions: 2 (Modified Huffman), 3 (Group 3 / T.4) and
    // 4 (Group 4 / T.6). The tiff crate only decodes Group 4, so route all of
    // them through hayro-ccitt, which understands the TIFF encoding options.
    if compression == 2 || compression == 3 || compression == 4 {
        let offsets = decoder.get_tag_u64_vec(tiff::tags::Tag::StripOffsets)
            .map_err(|e| JsValue::from_str(&format!("CCITT: missing StripOffsets: {}", e)))?;
        let counts = decoder.get_tag_u64_vec(tiff::tags::Tag::StripByteCounts)
            .map_err(|e| JsValue::from_str(&format!("CCITT: missing StripByteCounts: {}", e)))?;
        // FillOrder defaults to 1 (MSB first); T4Options (tag 292) defaults to 0.
        let fill_order = decoder.get_tag_u32(tiff::tags::Tag::FillOrder).unwrap_or(1);
        let t4_options = decoder.get_tag_u32(tiff::tags::Tag::Unknown(292)).unwrap_or(0);
        // Each strip is an independent CCITT stream; default to a single strip.
        let rows_per_strip = decoder.get_tag_u32(tiff::tags::Tag::RowsPerStrip).unwrap_or(height);
        let mut result = decode_ccitt(
            data, width, height, compression, predictor,
            photometric_interpretation, planar_configuration,
            &offsets, &counts, fill_order, t4_options, rows_per_strip, orientation,
        )?;
        result.all_tags_json = extract_page_tags_json(data, page_index);
        return Ok(result);
    }

    // JPEG-compressed YCbCr (compression 7, PhotometricInterpretation 6). The
    // tiff crate applies a YCbCr->RGB conversion on top of zune-jpeg's already
    // converted RGB output (a double conversion), which tints grayscale-stored
    // images. Decode the JPEG strips directly with zune-jpeg, which is correct.
    if compression == 7 && photometric_interpretation == 6 {
        let mut result = decode_jpeg_ycbcr(data, &mut decoder, width, height, orientation)?;
        result.all_tags_json = extract_page_tags_json(data, page_index);
        return Ok(result);
    }

    let decode_start = js_sys::Date::now();

    // Read image data (decompression happens here). ZSTD (50000) is decoded
    // with the pure-Rust ruzstd crate rather than the tiff crate's C zstd, so
    // the WASM build needs no C toolchain. The decompressed strips are rebuilt
    // into an uncompressed TIFF and handed back to the tiff crate, which still
    // performs predictor un-application and type/endianness handling.
    let mut direct_decode = false;
    let mut decode_result = if compression == 50000 {
        decode_zstd(data, &mut decoder)?
    } else if let Some(result) = try_decode_general_strips_tiles(
        data,
        &mut decoder,
        width,
        height,
        channels,
        bits_per_sample,
        compression,
        predictor,
        planar_configuration,
        tile_width,
        tile_length,
    )? {
        direct_decode = true;
        result
    } else if let Some(result) = try_decode_subbit_strips(
        data,
        &mut decoder,
        width,
        height,
        channels,
        bits_per_sample,
        compression,
        predictor,
        planar_configuration,
    )? {
        direct_decode = true;
        result
    } else if let Some(result) = try_decode_uncompressed_strips(
        data,
        &mut decoder,
        width,
        height,
        channels,
        bits_per_sample,
        compression,
        predictor,
        planar_configuration,
    )? {
        direct_decode = true;
        result
    } else {
        decoder.read_image()
            .map_err(|e| JsValue::from_str(&format!("Failed to decode image: {}", e)))?
    };

    // The direct-decode paths above (`try_decode_general_strips_tiles`,
    // `try_decode_subbit_strips`, `try_decode_uncompressed_strips`) are
    // channel-count-agnostic and always emit exactly `channels` samples/pixel,
    // so this is a no-op for them. But the `decoder.read_image()` fallback can
    // silently *compact away* extra (non-alpha) samples down to whatever
    // `color_type.num_samples()` implies (see `Image::readout_for_size` /
    // `compact_photometric_bytes` in the tiff crate) - e.g. an RGB image with
    // extra unspecified bands only comes back with 3 samples/pixel. Re-derive
    // `channels` from the buffer we actually got so the reported stride never
    // lies about the data, per that path too.
    if !direct_decode {
        let element_count = decoding_result_len(&decode_result);
        let pixel_count = (width as usize) * (height as usize);
        if pixel_count > 0 && element_count % pixel_count == 0 {
            let actual_channels = (element_count / pixel_count) as u32;
            if actual_channels > 0 {
                channels = actual_channels;
            }
        }
    }

    // CMYK (PhotometricInterpretation 5): both direct-decode paths above and
    // the `read_image()` fallback hand back raw C,M,Y,K (or C,M,Y,K,A)
    // samples untouched. The webview render pipeline only understands
    // grayscale/RGB(A), so without this it treats 4-sample CMYK as RGBA -
    // wrong colors, and the K (black) channel misread as alpha (dark areas
    // turn transparent). Convert to RGB(A) once here, shared by every decode
    // path, and re-derive `channels` from the conversion's actual output
    // rather than assuming 3. `photometric_interpretation` reported in
    // TiffResult/metadata below is intentionally left as the raw tag value
    // (5) - only the pixel data changes.
    if photometric_interpretation == 5 {
        let (converted, converted_channels) = convert_cmyk_to_rgb(decode_result, channels);
        decode_result = converted;
        channels = converted_channels;
    }

    let decompress_time = js_sys::Date::now() - decode_start;
    let convert_start = js_sys::Date::now();
    let mut stats_time = 0.0;
    let mut pack_time = 0.0;

    // Determine sample format and convert data to bytes
    let (mut data_bytes, mut data_f32, sample_format, min_val, max_val) = match decode_result {
        DecodingResult::U8(data) => {
            if bits_per_sample == 1 {
                // Uncompressed (or LZW/PackBits/Deflate) bilevel images are
                // returned as MSB-first packed bits with each row padded to a
                // byte boundary. Expand to one byte per pixel so they render
                // like any other 8-bit grayscale image.
                let pack_start = js_sys::Date::now();
                let expanded = unpack_bilevel(&data, width, height, photometric_interpretation);
                bits_per_sample = 8;
                pack_time += js_sys::Date::now() - pack_start;
                let (min, max) = if compute_stats {
                    let stats_start = js_sys::Date::now();
                    let stats = compute_stats_u8(&expanded);
                    stats_time += js_sys::Date::now() - stats_start;
                    (stats.0 as f64, stats.1 as f64)
                } else {
                    (f64::NAN, f64::NAN)
                };
                (expanded, Vec::new(), 1u32, min, max)
            } else {
                let (min, max) = if compute_stats {
                    let stats_start = js_sys::Date::now();
                    let stats = compute_stats_u8(&data);
                    stats_time += js_sys::Date::now() - stats_start;
                    (stats.0 as f64, stats.1 as f64)
                } else {
                    (f64::NAN, f64::NAN)
                };
                (data, Vec::new(), 1u32, min, max)
            }
        }
        DecodingResult::U16(data) => {
            let (min, max) = if compute_stats {
                let stats_start = js_sys::Date::now();
                let stats = compute_stats_u16(&data);
                stats_time += js_sys::Date::now() - stats_start;
                (stats.0 as f64, stats.1 as f64)
            } else {
                (f64::NAN, f64::NAN)
            };
            // SIMD-optimized byte conversion
            let pack_start = js_sys::Date::now();
            let bytes = convert_u16_to_bytes_simd(&data);
            pack_time += js_sys::Date::now() - pack_start;
            (bytes, Vec::new(), 1u32, min, max)
        }
        DecodingResult::U32(data) => {
            let (min, max) = if compute_stats {
                let stats_start = js_sys::Date::now();
                let stats = compute_stats_u32(&data);
                stats_time += js_sys::Date::now() - stats_start;
                (stats.0 as f64, stats.1 as f64)
            } else {
                (f64::NAN, f64::NAN)
            };
            let pack_start = js_sys::Date::now();
            let bytes: Vec<u8> = data.iter()
                .flat_map(|&v| v.to_le_bytes())
                .collect();
            pack_time += js_sys::Date::now() - pack_start;
            (bytes, Vec::new(), 1u32, min, max)
        }
        DecodingResult::U64(data) => {
            let (min, max) = if compute_stats {
                let stats_start = js_sys::Date::now();
                let stats = compute_stats_u64(&data);
                stats_time += js_sys::Date::now() - stats_start;
                (stats.0 as f64, stats.1 as f64)
            } else {
                (f64::NAN, f64::NAN)
            };
            let pack_start = js_sys::Date::now();
            let bytes: Vec<u8> = data.iter()
                .flat_map(|&v| v.to_le_bytes())
                .collect();
            pack_time += js_sys::Date::now() - pack_start;
            (bytes, Vec::new(), 1u32, min, max)
        }
        DecodingResult::I8(data) => {
            let (min, max) = if compute_stats {
                let stats_start = js_sys::Date::now();
                let stats = compute_stats_i8(&data);
                stats_time += js_sys::Date::now() - stats_start;
                (stats.0 as f64, stats.1 as f64)
            } else {
                (f64::NAN, f64::NAN)
            };
            let pack_start = js_sys::Date::now();
            let ubytes: Vec<u8> = data.iter().map(|&v| v as u8).collect();
            pack_time += js_sys::Date::now() - pack_start;
            (ubytes, Vec::new(), 2u32, min, max)
        }
        DecodingResult::I16(data) => {
            let (min, max) = if compute_stats {
                let stats_start = js_sys::Date::now();
                let stats = compute_stats_i16(&data);
                stats_time += js_sys::Date::now() - stats_start;
                (stats.0 as f64, stats.1 as f64)
            } else {
                (f64::NAN, f64::NAN)
            };
            let pack_start = js_sys::Date::now();
            let bytes: Vec<u8> = data.iter()
                .flat_map(|&v| v.to_le_bytes())
                .collect();
            pack_time += js_sys::Date::now() - pack_start;
            (bytes, Vec::new(), 2u32, min, max)
        }
        DecodingResult::I32(data) => {
            let (min, max) = if compute_stats {
                let stats_start = js_sys::Date::now();
                let stats = compute_stats_i32(&data);
                stats_time += js_sys::Date::now() - stats_start;
                (stats.0 as f64, stats.1 as f64)
            } else {
                (f64::NAN, f64::NAN)
            };
            let pack_start = js_sys::Date::now();
            let bytes: Vec<u8> = data.iter()
                .flat_map(|&v| v.to_le_bytes())
                .collect();
            pack_time += js_sys::Date::now() - pack_start;
            (bytes, Vec::new(), 2u32, min, max)
        }
        DecodingResult::I64(data) => {
            let (min, max) = if compute_stats {
                let stats_start = js_sys::Date::now();
                let stats = compute_stats_i64(&data);
                stats_time += js_sys::Date::now() - stats_start;
                (stats.0 as f64, stats.1 as f64)
            } else {
                (f64::NAN, f64::NAN)
            };
            let pack_start = js_sys::Date::now();
            let bytes: Vec<u8> = data.iter()
                .flat_map(|&v| v.to_le_bytes())
                .collect();
            pack_time += js_sys::Date::now() - pack_start;
            (bytes, Vec::new(), 2u32, min, max)
        }
        DecodingResult::F32(data) => {
            let (min, max) = if compute_stats {
                let stats_start = js_sys::Date::now();
                let stats = compute_stats_f32(&data);
                stats_time += js_sys::Date::now() - stats_start;
                stats
            } else {
                (f64::NAN, f64::NAN)
            };
            (Vec::new(), data, 3u32, min, max)
        }
        DecodingResult::F64(data) => {
            let (min, max) = if compute_stats {
                let stats_start = js_sys::Date::now();
                let stats = compute_stats_f64(&data);
                stats_time += js_sys::Date::now() - stats_start;
                stats
            } else {
                (f64::NAN, f64::NAN)
            };
            let pack_start = js_sys::Date::now();
            let mut values = Vec::with_capacity(data.len());
            for &val in &data {
                values.push(val as f32);
            }
            pack_time += js_sys::Date::now() - pack_start;
            (Vec::new(), values, 3u32, min, max)
        }
        DecodingResult::F16(data) => {
            // Convert f16 to f32 for processing and pre-allocate
            let pack_start = js_sys::Date::now();
            let mut values = Vec::with_capacity(data.len());
            let mut min_val = f32::INFINITY;
            let mut max_val = f32::NEG_INFINITY;

            if compute_stats {
                for &val in &data {
                    let f32_val = val.to_f32();
                    if f32_val < min_val { min_val = f32_val; }
                    if f32_val > max_val { max_val = f32_val; }
                    values.push(f32_val);
                }
            } else {
                for &val in &data {
                    values.push(val.to_f32());
                }
            }
            pack_time += js_sys::Date::now() - pack_start;
            let min = if compute_stats { min_val as f64 } else { f64::NAN };
            let max = if compute_stats { max_val as f64 } else { f64::NAN };
            (Vec::new(), values, 3u32, min, max)
        }
    };

    // Orientation tag (274): apply here, once, to whichever final buffer the
    // decode path produced (bytes for integer samples, f32 for float) - this
    // is after bilevel unpacking above so every buffer at this point is a
    // plain one-sample-per-element interleaved raster, regardless of which
    // decode path produced it. `bytes_per_pixel` is measured from the actual
    // buffer rather than trusted from `bits_per_sample`, since sub-16-bit
    // direct-decoded samples (9-15 bit) are packed as 2 bytes/sample even
    // though `bits_per_sample` reports the true (smaller) bit depth.
    let (width, height) = if orientation == TiffOrientation::TopLeft {
        (width, height)
    } else if !data_bytes.is_empty() {
        let pixel_count = (width as usize) * (height as usize);
        let bytes_per_pixel = if pixel_count > 0 { data_bytes.len() / pixel_count } else { 0 };
        if bytes_per_pixel > 0 {
            let (oriented, w, h) = apply_orientation(&data_bytes, width, height, bytes_per_pixel as u32, orientation);
            data_bytes = oriented;
            (w, h)
        } else {
            (width, height)
        }
    } else if !data_f32.is_empty() {
        let (oriented, w, h) = apply_orientation(&data_f32, width, height, channels, orientation);
        data_f32 = oriented;
        (w, h)
    } else {
        (width, height)
    };

    let convert_time = js_sys::Date::now() - convert_start;
    let total_time = js_sys::Date::now() - start_time;
    let metadata_time = total_time - decompress_time - convert_time;

    let result = Ok(TiffResult {
        width,
        height,
        channels,
        bits_per_sample,
        sample_format,
        compression,
        predictor,
        // Report the file's real CFA tag, not the BlackIsZero we substituted.
        photometric_interpretation: cfa_photometric.unwrap_or(photometric_interpretation),
        planar_configuration,
        rows_per_strip,
        strip_count,
        strip_byte_count_total,
        strip_byte_count_max,
        tile_width,
        tile_length,
        tile_count,
        direct_decode,
        data: data_bytes,
        data_f32,
        min_value: min_val,
        max_value: max_val,
        timing_metadata_ms: metadata_time,
        timing_decode_ms: decompress_time,
        timing_convert_ms: convert_time,
        timing_stats_ms: stats_time,
        timing_pack_ms: pack_time,
        all_tags_json: extract_page_tags_json(data, page_index),
        ome_xml: extract_ome_xml(data),
    });

    web_sys::console::log_1(&format!(
        "[Rust] Total: {:.2}ms (metadata: {:.2}ms, decompress: {:.2}ms, convert: {:.2}ms)", 
        total_time, metadata_time, decompress_time, convert_time
    ).into());
    
    result
}

fn tiff_is_little_endian(data: &[u8]) -> Option<bool> {
    match data.get(0..4)? {
        b"II*\0" | b"II+\0" => Some(true),
        b"MM\0*" | b"MM\0+" => Some(false),
        _ => None,
    }
}

fn try_decode_uncompressed_strips(
    data: &[u8],
    decoder: &mut Decoder<Cursor<&[u8]>>,
    width: u32,
    height: u32,
    channels: u32,
    bits_per_sample: u32,
    compression: u32,
    predictor: u32,
    planar_configuration: u32,
) -> Result<Option<DecodingResult>, JsValue> {
    use tiff::tags::Tag;

    if compression != 1 || predictor != 1 || planar_configuration != 1 {
        return Ok(None);
    }
    if bits_per_sample == 0 || bits_per_sample % 8 != 0 {
        return Ok(None);
    }
    if decoder.get_tag_u64_vec(Tag::TileOffsets).is_ok() {
        return Ok(None);
    }

    let little_endian = match tiff_is_little_endian(data) {
        Some(value) => value,
        None => return Ok(None),
    };
    let offsets = match decoder.get_tag_u64_vec(Tag::StripOffsets) {
        Ok(value) if !value.is_empty() => value,
        _ => return Ok(None),
    };
    let counts = match decoder.get_tag_u64_vec(Tag::StripByteCounts) {
        Ok(value) if value.len() == offsets.len() => value,
        _ => return Ok(None),
    };

    let sample_format = decoder.get_tag_u64_vec(Tag::SampleFormat)
        .ok()
        .and_then(|values| values.first().copied())
        .unwrap_or(1) as u32;
    let sample_count = (width as usize)
        .checked_mul(height as usize)
        .and_then(|v| v.checked_mul(channels as usize))
        .ok_or_else(|| JsValue::from_str("Direct TIFF decode: image dimensions overflow"))?;
    let bytes_per_sample = (bits_per_sample / 8) as usize;
    let expected_bytes = sample_count
        .checked_mul(bytes_per_sample)
        .ok_or_else(|| JsValue::from_str("Direct TIFF decode: raster byte count overflow"))?;

    let total_available = counts.iter().try_fold(0usize, |acc, &count| {
        acc.checked_add(count as usize)
    }).ok_or_else(|| JsValue::from_str("Direct TIFF decode: strip byte count overflow"))?;
    if total_available < expected_bytes {
        return Ok(None);
    }

    let mut raster = Vec::with_capacity(expected_bytes);
    for (&offset, &count) in offsets.iter().zip(counts.iter()) {
        if raster.len() >= expected_bytes {
            break;
        }
        let start = offset as usize;
        let count_usize = count as usize;
        let end = match start.checked_add(count_usize) {
            Some(value) => value,
            None => return Ok(None),
        };
        if end > data.len() {
            return Ok(None);
        }
        let remaining = expected_bytes - raster.len();
        let take = remaining.min(count_usize);
        raster.extend_from_slice(&data[start..start + take]);
    }
    if raster.len() != expected_bytes {
        return Ok(None);
    }

    let result = match (sample_format, bits_per_sample) {
        (1, 8) => DecodingResult::U8(raster),
        (1, 16) => {
            let values = raster.chunks_exact(2)
                .map(|b| {
                    if little_endian {
                        u16::from_le_bytes([b[0], b[1]])
                    } else {
                        u16::from_be_bytes([b[0], b[1]])
                    }
                })
                .collect();
            DecodingResult::U16(values)
        }
        (1, 32) => {
            let values = raster.chunks_exact(4)
                .map(|b| {
                    if little_endian {
                        u32::from_le_bytes([b[0], b[1], b[2], b[3]])
                    } else {
                        u32::from_be_bytes([b[0], b[1], b[2], b[3]])
                    }
                })
                .collect();
            DecodingResult::U32(values)
        }
        (2, 8) => DecodingResult::I8(raster.into_iter().map(|v| v as i8).collect()),
        (2, 16) => {
            let values = raster.chunks_exact(2)
                .map(|b| {
                    if little_endian {
                        i16::from_le_bytes([b[0], b[1]])
                    } else {
                        i16::from_be_bytes([b[0], b[1]])
                    }
                })
                .collect();
            DecodingResult::I16(values)
        }
        (2, 32) => {
            let values = raster.chunks_exact(4)
                .map(|b| {
                    if little_endian {
                        i32::from_le_bytes([b[0], b[1], b[2], b[3]])
                    } else {
                        i32::from_be_bytes([b[0], b[1], b[2], b[3]])
                    }
                })
                .collect();
            DecodingResult::I32(values)
        }
        (3, 32) => {
            let values = raster.chunks_exact(4)
                .map(|b| {
                    if little_endian {
                        f32::from_le_bytes([b[0], b[1], b[2], b[3]])
                    } else {
                        f32::from_be_bytes([b[0], b[1], b[2], b[3]])
                    }
                })
                .collect();
            DecodingResult::F32(values)
        }
        (3, 64) => {
            let values = raster.chunks_exact(8)
                .map(|b| {
                    if little_endian {
                        f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])
                    } else {
                        f64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])
                    }
                })
                .collect();
            DecodingResult::F64(values)
        }
        _ => return Ok(None),
    };

    Ok(Some(result))
}

/// Decompress one strip/tile's compressed bytes (compression None/LZW/
/// Deflate) into exactly `expected_len` bytes, shared by
/// `try_decode_subbit_strips` and `try_decode_general_strips_tiles`.
///
/// LZW is decoded through weezl's low-level `decode_bytes` (rather than the
/// `decode()`/`into_vec()` convenience wrapper) precisely because it does
/// *not* require an end-of-information code: it simply stops once the
/// caller-provided output buffer is full. Some encoders (seen in tiled TIFFs)
/// omit the EOI code on the last tile of an image, which the `tiff` crate's
/// own LZW reader rejects with "no lzw end code found"; libtiff tolerates
/// this, and so does this path, since we already know the exact decompressed
/// size from the image/tile geometry and don't need the stream to tell us
/// when to stop.
fn decompress_strip_or_tile(block: &[u8], compression: u32, expected_len: usize, context: &str) -> Result<Vec<u8>, JsValue> {
    use std::io::Read;

    match compression {
        1 => Ok(block.to_vec()),
        5 => {
            let mut lzw = weezl::decode::Decoder::with_tiff_size_switch(weezl::BitOrder::Msb, 8);
            let mut out = vec![0u8; expected_len];
            let mut in_pos = 0usize;
            let mut out_pos = 0usize;
            while out_pos < expected_len {
                let result = lzw.decode_bytes(&block[in_pos..], &mut out[out_pos..]);
                in_pos += result.consumed_in;
                out_pos += result.consumed_out;
                match result.status {
                    Ok(weezl::LzwStatus::Ok) => {}
                    Ok(weezl::LzwStatus::Done) => break,
                    Ok(weezl::LzwStatus::NoProgress) => {
                        if in_pos >= block.len() {
                            // Input exhausted before an EOI code appeared.
                            // Tolerate this the same way libtiff does; the
                            // caller already validates `out` was filled to
                            // the expected length below.
                            break;
                        }
                        return Err(JsValue::from_str(&format!("{}: LZW decode stalled before end of input", context)));
                    }
                    Err(e) => return Err(JsValue::from_str(&format!("{}: LZW decode failed: {}", context, e))),
                }
            }
            if out_pos < expected_len {
                return Err(JsValue::from_str(&format!(
                    "{}: LZW stream produced {} bytes, expected {}", context, out_pos, expected_len
                )));
            }
            Ok(out)
        }
        8 | 32946 => {
            let mut zd = flate2::read::ZlibDecoder::new(block);
            let mut buf = Vec::new();
            zd.read_to_end(&mut buf)
                .map_err(|e| JsValue::from_str(&format!("{}: Deflate decode failed: {}", context, e)))?;
            Ok(buf)
        }
        _ => Err(JsValue::from_str(&format!("{}: compression {} is not supported", context, compression))),
    }
}

/// Unpack `samples_per_row` MSB-first, bit-packed unsigned samples from a
/// single decompressed row. Samples are packed continuously (not padded per
/// sample), only the row as a whole is padded to a byte boundary. Shared by
/// `try_decode_subbit_strips` and `try_decode_general_strips_tiles`.
fn unpack_msb_packed_row(row: &[u8], samples_per_row: usize, bits_per_sample: u32) -> Vec<u16> {
    let max_value = (1u32 << bits_per_sample) - 1;
    let mut out = Vec::with_capacity(samples_per_row);
    let mut bit_buf: u64 = 0;
    let mut bit_count: u32 = 0;
    let mut byte_idx = 0usize;
    for _ in 0..samples_per_row {
        while bit_count < bits_per_sample {
            let byte = row.get(byte_idx).copied().unwrap_or(0);
            byte_idx += 1;
            bit_buf = (bit_buf << 8) | byte as u64;
            bit_count += 8;
        }
        let shift = bit_count - bits_per_sample;
        let value = ((bit_buf >> shift) & (max_value as u64)) as u16;
        out.push(value);
        bit_count -= bits_per_sample;
        bit_buf &= (1u64 << bit_count) - 1;
    }
    out
}

/// Apply the horizontal (predictor 2) differencing predictor in place to one
/// decoded row of `row_width` pixels x `channels` samples, wrapping modulo
/// 2^bits_per_sample (via `max_value`). Shared by `try_decode_subbit_strips`
/// and `try_decode_general_strips_tiles`.
fn apply_horizontal_predictor2(row_values: &mut [u16], row_width: usize, channels: usize, max_value: u32) {
    for x in 1..row_width {
        for c in 0..channels {
            let idx = x * channels + c;
            let prev = row_values[idx - channels] as u32;
            let cur = row_values[idx] as u32;
            row_values[idx] = ((cur + prev) & max_value) as u16;
        }
    }
}

/// Decode chunky, strip-based, unsigned-integer samples whose bit depth is
/// non-byte-aligned (9..=15 bits, e.g. 10/12/14-bit RGB or grayscale, common
/// for RAW-derived TIFFs). The tiff crate's read_image() only supports 8/16/
/// 32/64-bit samples for multi-sample color types (1/2/4-bit for single-
/// channel Gray), so it rejects these with "color type RGB(14) is
/// unsupported" before decompression is even attempted. Fetch the strips,
/// decompress them ourselves (None/LZW/Deflate), unpack the MSB-first
/// bit-packed samples (each row padded to a byte boundary), and apply the
/// horizontal predictor if present. Values are left in their native range
/// (0..2^bits-1), not rescaled to 16-bit.
///
/// Returns `Ok(None)` when the bit depth is outside 9..=15 or the layout is
/// otherwise not handled here (PlanarConfiguration 2 and tiled layouts are
/// handled by the more general `try_decode_general_strips_tiles`, tried
/// after this one). Returns `Err` for cases within this path's scope that
/// are known to not be decodable (LSB fill order, non-unsigned sample
/// format, unsupported predictor).
#[allow(clippy::too_many_arguments)]
fn try_decode_subbit_strips(
    data: &[u8],
    decoder: &mut Decoder<Cursor<&[u8]>>,
    width: u32,
    height: u32,
    channels: u32,
    bits_per_sample: u32,
    compression: u32,
    predictor: u32,
    planar_configuration: u32,
) -> Result<Option<DecodingResult>, JsValue> {
    use tiff::tags::Tag;

    if !(9..=15).contains(&bits_per_sample) {
        return Ok(None);
    }
    if planar_configuration != 1 {
        // Planar sub-16-bit is a separate, parked issue: fall through so the
        // tiff crate produces its usual (clear) "unsupported color type" error.
        return Ok(None);
    }
    if compression != 1 && compression != 5 && compression != 8 && compression != 32946 {
        return Ok(None);
    }
    if decoder.get_tag_u64_vec(Tag::TileOffsets).is_ok() {
        return Err(JsValue::from_str(
            "Sub-16-bit TIFF: tiled layout is not supported by the direct decode path",
        ));
    }
    if predictor != 1 && predictor != 2 {
        return Err(JsValue::from_str(&format!(
            "Sub-16-bit TIFF: predictor {} is not supported", predictor
        )));
    }
    let fill_order = decoder.get_tag_u32(Tag::FillOrder).unwrap_or(1);
    if fill_order != 1 {
        return Err(JsValue::from_str(
            "Sub-16-bit TIFF: FillOrder 2 (LSB-first) is not supported",
        ));
    }
    let sample_format = decoder.get_tag_u64_vec(Tag::SampleFormat)
        .ok()
        .and_then(|values| values.first().copied())
        .unwrap_or(1) as u32;
    if sample_format != 1 {
        return Err(JsValue::from_str(&format!(
            "Sub-16-bit TIFF: sample format {} is not supported (only unsigned integer)", sample_format
        )));
    }

    let offsets = match decoder.get_tag_u64_vec(Tag::StripOffsets) {
        Ok(value) if !value.is_empty() => value,
        _ => return Ok(None),
    };
    let counts = match decoder.get_tag_u64_vec(Tag::StripByteCounts) {
        Ok(value) if value.len() == offsets.len() => value,
        _ => return Ok(None),
    };
    let rows_per_strip = decoder.get_tag_u32(Tag::RowsPerStrip).unwrap_or(height).max(1);

    let samples_per_row = (width as usize).saturating_mul(channels as usize);
    let row_bytes = (samples_per_row * bits_per_sample as usize + 7) / 8;
    let max_value = (1u32 << bits_per_sample) - 1;

    let mut out: Vec<u16> = Vec::with_capacity(samples_per_row.saturating_mul(height as usize));
    let mut rows_decoded: u32 = 0;

    for (&offset, &count) in offsets.iter().zip(counts.iter()) {
        if rows_decoded >= height {
            break;
        }
        let start = offset as usize;
        let end = start.saturating_add(count as usize);
        if end > data.len() {
            return Err(JsValue::from_str("Sub-16-bit TIFF: strip byte range out of bounds"));
        }
        let strip = &data[start..end];

        let rows_in_strip = rows_per_strip.min(height - rows_decoded) as usize;
        let expected_bytes = row_bytes.saturating_mul(rows_in_strip);
        let decompressed = decompress_strip_or_tile(strip, compression, expected_bytes, "Sub-16-bit TIFF")?;
        if decompressed.len() < expected_bytes {
            return Err(JsValue::from_str(&format!(
                "Sub-16-bit TIFF: strip decompressed to {} bytes, expected at least {}",
                decompressed.len(), expected_bytes
            )));
        }

        for row_idx in 0..rows_in_strip {
            let row = &decompressed[row_idx * row_bytes..(row_idx + 1) * row_bytes];
            let mut row_values = unpack_msb_packed_row(row, samples_per_row, bits_per_sample);

            if predictor == 2 {
                apply_horizontal_predictor2(&mut row_values, width as usize, channels as usize, max_value);
            }

            out.extend_from_slice(&row_values);
        }
        rows_decoded += rows_in_strip as u32;
    }

    if rows_decoded != height {
        return Err(JsValue::from_str(&format!(
            "Sub-16-bit TIFF: decoded {} of {} rows", rows_decoded, height
        )));
    }

    Ok(Some(DecodingResult::U16(out)))
}

/// Decode strip- or tile-based, unsigned-integer TIFFs for the two cases the
/// `tiff` crate's `read_image()` gets wrong or refuses outright:
///
///  - **Any `PlanarConfiguration == 2` image** (strips or tiles, any of the
///    compressions handled here). `read_image()`'s own doc comment admits its
///    planar handling is "not correct" -- depending on version it either
///    reads only the first plane or concatenates planes sequentially into one
///    buffer instead of interleaving them per sample, producing a
///    scrambled-but-no-error image (three copies of the picture, wrong
///    colors, etc).
///  - **Tiled LZW** (chunky or planar). Some encoders omit the LZW
///    end-of-information code on the final tile of an image; the `tiff`
///    crate's LZW reader treats a stream that runs out of input before EOI as
///    a hard error ("no lzw end code found"), where libtiff tolerates it.
///    `decompress_strip_or_tile` decodes LZW through weezl's low-level
///    buffer API, which naturally tolerates this since it stops once the
///    (known in advance, from the tile geometry) output size is reached.
///
/// Chunky, non-tiled images are left alone (`Ok(None)`) so the faster
/// existing paths (`try_decode_uncompressed_strips`, `try_decode_subbit_strips`,
/// or the `tiff` crate's own `read_image()`) keep handling them exactly as
/// before -- this path is deliberately scoped to only the cases above so it
/// never adds overhead to the common chunky path.
///
/// Always produces **chunky, interleaved** output regardless of the file's
/// on-disk planar configuration, matching what every format processor on the
/// JS side expects (the caller still reports the true
/// `PlanarConfiguration` tag value in `TiffResult` metadata).
///
/// Supports 8-bit and 9..=16-bit unsigned integer samples (matching what
/// `TiffResult::get_data_as_f32` knows how to unpack), predictor 1/2,
/// compression None/LZW/Deflate, and MSB-first fill order. Returns `Err` with
/// a clear message for anything else within its trigger scope (planar float,
/// planar 32-bit, LSB fill order, unsupported predictor/compression) rather
/// than silently producing wrong pixels.
#[allow(clippy::too_many_arguments)]
fn try_decode_general_strips_tiles(
    data: &[u8],
    decoder: &mut Decoder<Cursor<&[u8]>>,
    width: u32,
    height: u32,
    channels: u32,
    bits_per_sample: u32,
    compression: u32,
    predictor: u32,
    planar_configuration: u32,
    tile_width: u32,
    tile_length: u32,
) -> Result<Option<DecodingResult>, JsValue> {
    use tiff::tags::Tag;

    let is_tiled = tile_width > 0 && tile_length > 0;
    if planar_configuration != 2 && !(is_tiled && compression == 5) {
        return Ok(None);
    }

    const CTX: &str = "Planar/tiled TIFF";

    if bits_per_sample != 8 && !(9..=16).contains(&bits_per_sample) {
        return Err(JsValue::from_str(&format!(
            "{}: {}-bit samples are not supported", CTX, bits_per_sample
        )));
    }
    if compression != 1 && compression != 5 && compression != 8 && compression != 32946 {
        return Err(JsValue::from_str(&format!("{}: compression {} is not supported", CTX, compression)));
    }
    if predictor != 1 && predictor != 2 {
        return Err(JsValue::from_str(&format!("{}: predictor {} is not supported", CTX, predictor)));
    }
    let fill_order = decoder.get_tag_u32(Tag::FillOrder).unwrap_or(1);
    if fill_order != 1 {
        return Err(JsValue::from_str(&format!("{}: FillOrder 2 (LSB-first) is not supported", CTX)));
    }
    let sample_format = decoder.get_tag_u64_vec(Tag::SampleFormat)
        .ok()
        .and_then(|values| values.first().copied())
        .unwrap_or(1) as u32;
    if sample_format != 1 {
        return Err(JsValue::from_str(&format!(
            "{}: sample format {} is not supported (only unsigned integer)", CTX, sample_format
        )));
    }

    let planes = if planar_configuration == 2 { channels } else { 1 };
    let channels_per_block = if planar_configuration == 2 { 1 } else { channels };

    // Block geometry. Strips span the full image width and are never padded
    // (the last strip may simply have fewer rows than `rows_per_strip`).
    // Tiles are always TileWidth x TileLength; edge tiles that overhang the
    // image are zero-padded by the encoder to that full size, so the decoded
    // rows/columns past width/height are dropped below when assembling the
    // output.
    let (block_width, block_height, blocks_across, blocks_down, rows_per_strip) = if is_tiled {
        let across = ((width as u64) + tile_width as u64 - 1) / tile_width as u64;
        let down = ((height as u64) + tile_length as u64 - 1) / tile_length as u64;
        (tile_width, tile_length, across as u32, down as u32, 0u32)
    } else {
        let rps = decoder.get_tag_u32(Tag::RowsPerStrip).unwrap_or(height).max(1);
        let down = ((height as u64) + rps as u64 - 1) / rps as u64;
        (width, rps, 1u32, down as u32, rps)
    };
    let blocks_per_plane = (blocks_across as u64) * (blocks_down as u64);

    let offsets = (if is_tiled {
        decoder.get_tag_u64_vec(Tag::TileOffsets)
    } else {
        decoder.get_tag_u64_vec(Tag::StripOffsets)
    }).map_err(|e| JsValue::from_str(&format!("{}: missing offsets: {}", CTX, e)))?;
    let counts = (if is_tiled {
        decoder.get_tag_u64_vec(Tag::TileByteCounts)
    } else {
        decoder.get_tag_u64_vec(Tag::StripByteCounts)
    }).map_err(|e| JsValue::from_str(&format!("{}: missing byte counts: {}", CTX, e)))?;

    let expected_blocks = blocks_per_plane.checked_mul(planes as u64)
        .ok_or_else(|| JsValue::from_str(&format!("{}: block count overflow", CTX)))?;
    if offsets.len() as u64 != expected_blocks || counts.len() as u64 != expected_blocks {
        return Err(JsValue::from_str(&format!(
            "{}: expected {} strip/tile offsets, found {}", CTX, expected_blocks, offsets.len()
        )));
    }

    let max_value = (1u32 << bits_per_sample.min(31)) - 1;
    let samples_per_row = (block_width as usize) * (channels_per_block as usize);
    let row_bytes = (samples_per_row * bits_per_sample as usize + 7) / 8;
    let mut out: Vec<u16> = vec![0u16; (width as usize) * (height as usize) * (channels as usize)];

    let mut block_idx = 0usize;
    for plane in 0..planes {
        for tile_row in 0..blocks_down {
            for tile_col in 0..blocks_across {
                let offset = offsets[block_idx];
                let count = counts[block_idx];
                block_idx += 1;

                let start = offset as usize;
                let end = start.saturating_add(count as usize);
                if end > data.len() {
                    return Err(JsValue::from_str(&format!("{}: strip/tile byte range out of bounds", CTX)));
                }
                let block_bytes = &data[start..end];

                let image_row_start = if is_tiled { tile_row * tile_length } else { tile_row * rows_per_strip };
                let image_col_start = tile_col * block_width;
                let valid_rows = block_height.min(height.saturating_sub(image_row_start));
                let valid_cols = block_width.min(width.saturating_sub(image_col_start));

                let expected_bytes = row_bytes.saturating_mul(block_height as usize);
                let decompressed = decompress_strip_or_tile(block_bytes, compression, expected_bytes, CTX)?;
                if decompressed.len() < expected_bytes {
                    return Err(JsValue::from_str(&format!(
                        "{}: block decompressed to {} bytes, expected at least {}",
                        CTX, decompressed.len(), expected_bytes
                    )));
                }

                for row_idx in 0..(block_height as usize) {
                    if (row_idx as u32) >= valid_rows {
                        continue;
                    }
                    let row = &decompressed[row_idx * row_bytes..(row_idx + 1) * row_bytes];
                    let mut row_values = unpack_msb_packed_row(row, samples_per_row, bits_per_sample);

                    if predictor == 2 {
                        apply_horizontal_predictor2(&mut row_values, block_width as usize, channels_per_block as usize, max_value);
                    }

                    let out_row = (image_row_start as usize) + row_idx;
                    let out_row_base = out_row * (width as usize) * (channels as usize);

                    for col in 0..(valid_cols as usize) {
                        let out_col = (image_col_start as usize) + col;
                        for c in 0..(channels_per_block as usize) {
                            let dest_channel = if planar_configuration == 2 { plane as usize } else { c };
                            out[out_row_base + out_col * (channels as usize) + dest_channel] =
                                row_values[col * (channels_per_block as usize) + c];
                        }
                    }
                }
            }
        }
    }

    if bits_per_sample == 8 {
        Ok(Some(DecodingResult::U8(out.into_iter().map(|v| v as u8).collect())))
    } else {
        Ok(Some(DecodingResult::U16(out)))
    }
}

/// Decode a ZSTD-compressed TIFF (compression 50000) using the pure-Rust
/// ruzstd crate. We decompress each strip, concatenate the raster (still
/// predictor-encoded), rebuild it as a single-strip *uncompressed* TIFF that
/// keeps the predictor tag, and hand that back to the tiff crate so it performs
/// predictor un-application and type/endianness handling for us.
///
/// Tiled images and planar configuration 2 are not supported by this path.
fn decode_zstd(
    original: &[u8],
    decoder: &mut Decoder<Cursor<&[u8]>>,
) -> Result<DecodingResult, JsValue> {
    use std::io::Read;
    use tiff::tags::Tag;

    if decoder.get_tag_u64_vec(Tag::TileOffsets).is_ok() {
        return Err(JsValue::from_str("ZSTD: tiled TIFFs are not supported by the pure-Rust path"));
    }
    let planar = decoder.get_tag_u32(Tag::PlanarConfiguration).unwrap_or(1);
    if planar != 1 {
        return Err(JsValue::from_str("ZSTD: planar configuration 2 is not supported"));
    }

    let (width, height) = decoder.dimensions()
        .map_err(|e| JsValue::from_str(&format!("ZSTD: dimensions: {}", e)))?;
    let offsets = decoder.get_tag_u64_vec(Tag::StripOffsets)
        .map_err(|e| JsValue::from_str(&format!("ZSTD: StripOffsets: {}", e)))?;
    let counts = decoder.get_tag_u64_vec(Tag::StripByteCounts)
        .map_err(|e| JsValue::from_str(&format!("ZSTD: StripByteCounts: {}", e)))?;
    let spp = decoder.get_tag_u32(Tag::SamplesPerPixel).unwrap_or(1);
    let predictor = decoder.get_tag_u32(Tag::Predictor).unwrap_or(1);
    let photometric = decoder.get_tag_u32(Tag::PhotometricInterpretation).unwrap_or(1);
    let bits: Vec<u32> = decoder.get_tag_u64_vec(Tag::BitsPerSample)
        .map(|v| v.into_iter().map(|b| b as u32).collect())
        .unwrap_or_else(|_| vec![8; spp as usize]);
    let sample_format: Vec<u32> = decoder.get_tag_u64_vec(Tag::SampleFormat)
        .map(|v| v.into_iter().map(|s| s as u32).collect())
        .unwrap_or_else(|_| vec![1; spp as usize]);

    // Decompress every strip with pure-Rust ruzstd, concatenated in row order.
    let mut raster: Vec<u8> = Vec::new();
    for (off, cnt) in offsets.iter().zip(counts.iter()) {
        let start = *off as usize;
        let end = start.saturating_add(*cnt as usize);
        if end > original.len() {
            return Err(JsValue::from_str("ZSTD: strip byte range out of bounds"));
        }
        let mut dec = ruzstd::decoding::StreamingDecoder::new(Cursor::new(&original[start..end]))
            .map_err(|e| JsValue::from_str(&format!("ZSTD: decoder init: {:?}", e)))?;
        dec.read_to_end(&mut raster)
            .map_err(|e| JsValue::from_str(&format!("ZSTD: decompress: {:?}", e)))?;
    }

    // Match the rebuilt TIFF's byte order to the original so multi-byte samples
    // are interpreted correctly.
    let little_endian = original.get(0..2) != Some(b"MM");
    let rebuilt = build_uncompressed_tiff(
        little_endian, width, height, spp, &bits, &sample_format, photometric, predictor, &raster,
    );
    let mut d = Decoder::new(Cursor::new(rebuilt.as_slice()))
        .map_err(|e| JsValue::from_str(&format!("ZSTD: rebuilt decoder: {}", e)))?;
    d.read_image()
        .map_err(|e| JsValue::from_str(&format!("ZSTD: rebuilt read_image: {}", e)))
}

/// Build a minimal single-strip, uncompressed classic TIFF wrapping `raster`,
/// preserving the tags the decoder needs (incl. the predictor, which the tiff
/// crate then un-applies). `raster` must be the full image in row order.
#[allow(clippy::too_many_arguments)]
fn build_uncompressed_tiff(
    le: bool,
    width: u32,
    height: u32,
    spp: u32,
    bits: &[u32],
    sample_format: &[u32],
    photometric: u32,
    predictor: u32,
    raster: &[u8],
) -> Vec<u8> {
    let u16b = |v: u16| if le { v.to_le_bytes() } else { v.to_be_bytes() };
    let u32b = |v: u32| if le { v.to_le_bytes() } else { v.to_be_bytes() };
    // SHORT (type 3) and LONG (type 4) tag values. Single SHORT values are
    // left-justified in the 4-byte value field; arrays are stored externally.
    let short_val = |v: u32| { let b = u16b(v as u16); [b[0], b[1], 0, 0] };
    let long_val = |v: u32| u32b(v);

    const N_TAGS: u16 = 12;
    let ifd_offset: u32 = 8;
    let ifd_size: u32 = 2 + (N_TAGS as u32) * 12 + 4;
    let after_ifd = ifd_offset + ifd_size;

    // BitsPerSample (258) / SampleFormat (339): a SHORT array fits inline in the
    // 4-byte value field when count <= 2; otherwise it is stored externally and
    // the value field holds the offset.
    let pack_inline = |vals: &[u32]| -> [u8; 4] {
        let mut f = [0u8; 4];
        for (i, &v) in vals.iter().enumerate().take(2) {
            let b = u16b(v as u16);
            f[2 * i] = b[0];
            f[2 * i + 1] = b[1];
        }
        f
    };
    let mut ext: Vec<u8> = Vec::new();
    let bits_field = if spp <= 2 {
        pack_inline(bits)
    } else {
        let off = after_ifd + ext.len() as u32;
        for &b in bits { ext.extend_from_slice(&u16b(b as u16)); }
        u32b(off)
    };
    let sf_field = if spp <= 2 {
        pack_inline(sample_format)
    } else {
        let off = after_ifd + ext.len() as u32;
        for &s in sample_format { ext.extend_from_slice(&u16b(s as u16)); }
        u32b(off)
    };
    let data_off = after_ifd + ext.len() as u32;

    let mut buf: Vec<u8> = Vec::with_capacity(data_off as usize + raster.len());
    buf.extend_from_slice(if le { b"II" } else { b"MM" });
    buf.extend_from_slice(&u16b(42));
    buf.extend_from_slice(&u32b(ifd_offset));
    buf.extend_from_slice(&u16b(N_TAGS));

    let put = |buf: &mut Vec<u8>, tag: u16, typ: u16, count: u32, valfield: [u8; 4]| {
        buf.extend_from_slice(&u16b(tag));
        buf.extend_from_slice(&u16b(typ));
        buf.extend_from_slice(&u32b(count));
        buf.extend_from_slice(&valfield);
    };

    // Tags must be in ascending order.
    put(&mut buf, 256, 4, 1, long_val(width));               // ImageWidth
    put(&mut buf, 257, 4, 1, long_val(height));              // ImageLength
    put(&mut buf, 258, 3, spp, bits_field);                  // BitsPerSample
    put(&mut buf, 259, 3, 1, short_val(1));                  // Compression = none
    put(&mut buf, 262, 3, 1, short_val(photometric));        // PhotometricInterpretation
    put(&mut buf, 273, 4, 1, long_val(data_off));            // StripOffsets
    put(&mut buf, 277, 3, 1, short_val(spp));                // SamplesPerPixel
    put(&mut buf, 278, 4, 1, long_val(height));              // RowsPerStrip
    put(&mut buf, 279, 4, 1, long_val(raster.len() as u32)); // StripByteCounts
    put(&mut buf, 284, 3, 1, short_val(1));                  // PlanarConfiguration = chunky
    put(&mut buf, 317, 3, 1, short_val(predictor));          // Predictor
    put(&mut buf, 339, 3, spp, sf_field);                    // SampleFormat

    buf.extend_from_slice(&u32b(0)); // next IFD offset
    buf.extend_from_slice(&ext);
    buf.extend_from_slice(raster);
    buf
}

/// Reconstruct a complete JPEG datastream from the optional shared JPEGTables
/// and one strip's image data (the TIFF Technote 2 abbreviated-stream layout):
/// a single SOI, then the tables, then the strip's frame.
fn build_jpeg(tables: Option<&[u8]>, strip: &[u8]) -> Vec<u8> {
    match tables {
        Some(t) => {
            let t = if t.ends_with(&[0xFF, 0xD9]) { &t[..t.len() - 2] } else { t };
            let s = if strip.starts_with(&[0xFF, 0xD8]) { &strip[2..] } else { strip };
            let mut out = Vec::with_capacity(t.len() + s.len());
            out.extend_from_slice(t);
            out.extend_from_slice(s);
            out
        }
        None => strip.to_vec(),
    }
}

/// Decode a JPEG-compressed YCbCr TIFF (compression 7, photometric 6) by
/// decoding each strip's JPEG directly with zune-jpeg. The tiff crate applies a
/// second YCbCr->RGB conversion on top of zune-jpeg's already-RGB output, which
/// tints the image; decoding the strips ourselves avoids that. Tiled images are
/// not handled here.
fn decode_jpeg_ycbcr(
    data: &[u8],
    decoder: &mut Decoder<Cursor<&[u8]>>,
    width: u32,
    height: u32,
    orientation: TiffOrientation,
) -> Result<TiffResult, JsValue> {
    use tiff::tags::Tag;
    use zune_jpeg::JpegDecoder;

    if decoder.get_tag_u64_vec(Tag::TileOffsets).is_ok() {
        return Err(JsValue::from_str("JPEG: tiled YCbCr JPEG is not supported by the direct path"));
    }
    let offsets = decoder.get_tag_u64_vec(Tag::StripOffsets)
        .map_err(|e| JsValue::from_str(&format!("JPEG: StripOffsets: {}", e)))?;
    let counts = decoder.get_tag_u64_vec(Tag::StripByteCounts)
        .map_err(|e| JsValue::from_str(&format!("JPEG: StripByteCounts: {}", e)))?;
    // JPEGTables (tag 347): optional abbreviated table stream shared by strips.
    let tables: Option<Vec<u8>> = decoder.get_tag_u8_vec(Tag::Unknown(347)).ok();

    let mut rgb: Vec<u8> = Vec::with_capacity((width as usize).saturating_mul(height as usize) * 3);
    let mut channels = 3u32;
    for (off, cnt) in offsets.iter().zip(counts.iter()) {
        let start = *off as usize;
        let end = start.saturating_add(*cnt as usize);
        if end > data.len() {
            return Err(JsValue::from_str("JPEG: strip byte range out of bounds"));
        }
        let jpeg = build_jpeg(tables.as_deref(), &data[start..end]);
        let mut jd = JpegDecoder::new(Cursor::new(jpeg));
        let px = jd.decode()
            .map_err(|e| JsValue::from_str(&format!("JPEG decode failed: {:?}", e)))?;
        let info = jd.info()
            .ok_or_else(|| JsValue::from_str("JPEG: missing image info"))?;
        let pixels = (info.width as usize).saturating_mul(info.height as usize);
        if pixels == 0 {
            return Err(JsValue::from_str("JPEG: empty strip"));
        }
        channels = (px.len() / pixels) as u32;
        rgb.extend_from_slice(&px);
    }
    if channels != 1 && channels != 3 {
        return Err(JsValue::from_str("JPEG: unexpected channel count"));
    }

    // Data is now decoded RGB (or grayscale), never CMYK, so
    // `finalize_decode_bytes`'s CMYK step is a no-op here and only the
    // Orientation transform actually does anything.
    let photometric_interpretation = if channels == 3 { 2 } else { 1 };
    let (rgb, width, height, channels) =
        finalize_decode_bytes(rgb, width, height, channels, photometric_interpretation, orientation);

    let (min, max) = compute_stats_u8(&rgb);
    Ok(TiffResult {
        width,
        height,
        channels,
        bits_per_sample: 8,
        sample_format: 1,
        compression: 7,
        predictor: 1,
        photometric_interpretation,
        planar_configuration: 1,
        rows_per_strip: decoder.get_tag_u32(Tag::RowsPerStrip).unwrap_or(height),
        strip_count: counts.len() as u32,
        strip_byte_count_total: counts.iter().copied().sum::<u64>(),
        strip_byte_count_max: counts.iter().copied().max().unwrap_or(0),
        tile_width: 0,
        tile_length: 0,
        tile_count: 0,
        direct_decode: false,
        data: rgb,
        data_f32: Vec::new(),
        min_value: min as f64,
        max_value: max as f64,
        timing_metadata_ms: 0.0,
        timing_decode_ms: 0.0,
        timing_convert_ms: 0.0,
        timing_stats_ms: 0.0,
        timing_pack_ms: 0.0,
        all_tags_json: extract_all_tags_json(data),
        ome_xml: extract_ome_xml(data),
    })
}

/// Expand MSB-first packed bilevel (1-bit) data to one byte per pixel.
///
/// Each row is padded to a byte boundary. Pixel polarity follows the TIFF
/// PhotometricInterpretation tag: 0 = WhiteIsZero, 1 = BlackIsZero.
fn unpack_bilevel(data: &[u8], width: u32, height: u32, photometric: u32) -> Vec<u8> {
    let width = width as usize;
    let height = height as usize;
    let row_bytes = (width + 7) / 8;
    let white_is_zero = photometric == 0;
    let mut out = Vec::with_capacity(width.saturating_mul(height));
    for y in 0..height {
        let row_start = y * row_bytes;
        for x in 0..width {
            let byte = data.get(row_start + x / 8).copied().unwrap_or(0);
            let bit = (byte >> (7 - (x % 8))) & 1;
            let white = if white_is_zero { bit == 0 } else { bit == 1 };
            out.push(if white { 255 } else { 0 });
        }
    }
    out
}

/// Rewrite one IFD's PhotometricInterpretation (tag 262) from
/// RGBPalette (3) to BlackIsZero (1), in place, so the tiff crate will decode
/// the raw palette indices instead of refusing the image. Returns false (and
/// leaves the buffer untouched) for anything it does not understand, e.g.
/// BigTIFF.
fn patch_photometric_to_grayscale(buf: &mut [u8], page_index: u32) -> bool {
    if buf.len() < 8 {
        return false;
    }
    let le = match &buf[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return false,
    };
    let rd16 = |b: &[u8]| if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) };
    let rd32 = |b: &[u8]| if le {
        u32::from_le_bytes([b[0], b[1], b[2], b[3]])
    } else {
        u32::from_be_bytes([b[0], b[1], b[2], b[3]])
    };
    // Only classic TIFF (magic 42) is handled; BigTIFF (43) is left to fall back.
    if rd16(&buf[2..4]) != 42 {
        return false;
    }
    let mut ifd = rd32(&buf[4..8]) as usize;
    for _ in 0..page_index {
        if ifd + 2 > buf.len() {
            return false;
        }
        let count = rd16(&buf[ifd..ifd + 2]) as usize;
        let next_offset_pos = ifd + 2 + count * 12;
        if next_offset_pos + 4 > buf.len() {
            return false;
        }
        ifd = rd32(&buf[next_offset_pos..next_offset_pos + 4]) as usize;
        if ifd == 0 {
            return false;
        }
    }
    if ifd + 2 > buf.len() {
        return false;
    }
    let count = rd16(&buf[ifd..ifd + 2]) as usize;
    for i in 0..count {
        let e = ifd + 2 + i * 12;
        if e + 12 > buf.len() {
            return false;
        }
        if rd16(&buf[e..e + 2]) == 262 {
            // SHORT value stored inline in the entry's value field.
            let one = if le { [1u8, 0u8] } else { [0u8, 1u8] };
            buf[e + 8] = one[0];
            buf[e + 9] = one[1];
            return true;
        }
    }
    false
}

/// Decode a palette (RGBPalette) TIFF by reading the raw indices and expanding
/// them through the ColorMap tag into interleaved 8-bit RGB.
fn decode_palette(data: &[u8], width: u32, height: u32, page_index: u32) -> Result<TiffResult, JsValue> {
    use tiff::tags::Tag;

    // ColorMap (tag 320): 3 * 2^bits 16-bit entries, laid out as all reds, then
    // all greens, then all blues.
    let cmap = {
        let mut d = Decoder::new(Cursor::new(data))
            .map_err(|e| JsValue::from_str(&format!("Palette: decoder init: {}", e)))?;
        for _ in 0..page_index {
            d.next_image().map_err(|e| JsValue::from_str(&format!("Palette: page select: {}", e)))?;
        }
        d.get_tag_u16_vec(Tag::Unknown(320))
            .map_err(|e| JsValue::from_str(&format!("Palette: missing ColorMap: {}", e)))?
    };
    if cmap.is_empty() || cmap.len() % 3 != 0 {
        return Err(JsValue::from_str("Palette: invalid ColorMap length"));
    }
    let n_colors = cmap.len() / 3;

    // Patch the photometric tag so the tiff crate decodes the indices for us,
    // reusing all of its compression / predictor / strip handling.
    let mut patched = data.to_vec();
    if !patch_photometric_to_grayscale(&mut patched, page_index) {
        return Err(JsValue::from_str("Palette: could not patch photometric tag"));
    }

    let mut d = Decoder::new(Cursor::new(patched.as_slice()))
        .map_err(|e| JsValue::from_str(&format!("Palette: patched decoder init: {}", e)))?;
    for _ in 0..page_index {
        d.next_image().map_err(|e| JsValue::from_str(&format!("Palette: patched page select: {}", e)))?;
    }
    let compression = d.get_tag_u32(Tag::Compression).unwrap_or(1);
    let predictor = d.get_tag_u32(Tag::Predictor).unwrap_or(1);
    let planar = d.get_tag_u32(Tag::PlanarConfiguration).unwrap_or(1);
    let rows_per_strip = d.get_tag_u32(Tag::RowsPerStrip).unwrap_or(height);
    let strip_byte_counts = d.get_tag_u64_vec(Tag::StripByteCounts).unwrap_or_default();
    let tile_width = d.get_tag_u32(Tag::TileWidth).unwrap_or(0);
    let tile_length = d.get_tag_u32(Tag::TileLength).unwrap_or(0);
    let tile_count = d.get_tag_u64_vec(Tag::TileByteCounts)
        .map(|counts| counts.len() as u32)
        .unwrap_or(0);
    // Orientation tag (274): the early-return palette path bypasses
    // `decode_tiff_impl`'s own Orientation-tag read (it returns before that
    // point), so read it here off the same patched decoder and finalize
    // through `finalize_decode_bytes` below like every other path.
    let orientation = TiffOrientation::from_tag(d.get_tag_u32(Tag::Orientation).unwrap_or(1));

    let indices: Vec<usize> = match d.read_image()
        .map_err(|e| JsValue::from_str(&format!("Palette: index decode failed: {}", e)))?
    {
        DecodingResult::U8(v) => v.iter().map(|&x| x as usize).collect(),
        DecodingResult::U16(v) => v.iter().map(|&x| x as usize).collect(),
        _ => return Err(JsValue::from_str("Palette: unexpected index sample type")),
    };

    // ColorMap entries are 16-bit; scale down to 8-bit per channel.
    let mut rgb = Vec::with_capacity(indices.len().saturating_mul(3));
    for &i in &indices {
        if i < n_colors {
            rgb.push((cmap[i] >> 8) as u8);
            rgb.push((cmap[n_colors + i] >> 8) as u8);
            rgb.push((cmap[2 * n_colors + i] >> 8) as u8);
        } else {
            rgb.extend_from_slice(&[0, 0, 0]);
        }
    }

    // Palette output is already expanded RGB (photometric_interpretation 2,
    // never 5/CMYK), so `finalize_decode_bytes`'s CMYK step is a no-op here
    // and only the Orientation transform actually does anything.
    let (rgb, width, height, channels) = finalize_decode_bytes(rgb, width, height, 3, 2, orientation);

    let (min, max) = compute_stats_u8(&rgb);
    Ok(TiffResult {
        width,
        height,
        channels,
        bits_per_sample: 8,
        sample_format: 1,
        compression,
        predictor,
        photometric_interpretation: 2, // expanded to RGB
        planar_configuration: planar,
        rows_per_strip,
        strip_count: strip_byte_counts.len() as u32,
        strip_byte_count_total: strip_byte_counts.iter().copied().sum::<u64>(),
        strip_byte_count_max: strip_byte_counts.iter().copied().max().unwrap_or(0),
        tile_width,
        tile_length,
        tile_count,
        direct_decode: false,
        data: rgb,
        data_f32: Vec::new(),
        min_value: min as f64,
        max_value: max as f64,
        timing_metadata_ms: 0.0,
        timing_decode_ms: 0.0,
        timing_convert_ms: 0.0,
        timing_stats_ms: 0.0,
        timing_pack_ms: 0.0,
        all_tags_json: extract_page_tags_json(data, page_index),
        ome_xml: extract_ome_xml(data),
    })
}

/// Decode a CCITT-fax-compressed TIFF (compression 2, 3 or 4) using hayro-ccitt.
///
/// CCITT data is bilevel; we expand it to one byte per pixel (0 = black,
/// 255 = white) and report it as an 8-bit grayscale image so it flows through
/// the same rendering path as any other integer TIFF.
#[allow(clippy::too_many_arguments)]
fn decode_ccitt(
    data: &[u8],
    width: u32,
    height: u32,
    compression: u32,
    predictor: u32,
    photometric_interpretation: u32,
    planar_configuration: u32,
    offsets: &[u64],
    counts: &[u64],
    fill_order: u32,
    t4_options: u32,
    rows_per_strip: u32,
    orientation: TiffOrientation,
) -> Result<TiffResult, JsValue> {
    use hayro_ccitt::{decode, DecodeSettings, DecoderContext, EncodingMode, Decoder as CcittDecoder};

    // Map the TIFF compression + T4Options to a hayro encoding mode.
    let two_dimensional = (t4_options & 0b1) != 0; // bit 0: 2D coding
    // Compression 2 (Modified Huffman) byte-aligns every row; for Group 3 this
    // is controlled by T4Options bit 2 (EncodedByteAlign).
    let byte_aligned = compression == 2 || (t4_options & 0b100) != 0;
    let encoding = match compression {
        4 => EncodingMode::Group4,
        3 if two_dimensional => EncodingMode::Group3_2D { k: u32::MAX },
        // Compression 2 (Modified Huffman) and 3 (Group 3, 1D).
        _ => EncodingMode::Group3_1D,
    };
    let end_of_line = matches!(encoding, EncodingMode::Group3_2D { .. });

    // hayro-ccitt emits a "white" pel for TIFF sample value 0 (the CCITT
    // convention). Map that to a display value through PhotometricInterpretation
    // exactly like unpack_bilevel does, so a CCITT image renders identically to
    // the same image stored uncompressed. (0 = WhiteIsZero, 1 = BlackIsZero.)
    let white_pel_value: u8 = if photometric_interpretation == 0 { 255 } else { 0 };
    let black_pel_value: u8 = 255 - white_pel_value;

    // hayro-ccitt streams decoded pixels through this collector.
    struct Collector {
        pixels: Vec<u8>,
        width: u32,
        cur_x: u32,
        white_value: u8,
        black_value: u8,
    }
    impl CcittDecoder for Collector {
        fn push_pixel(&mut self, white: bool) {
            if self.cur_x < self.width {
                self.pixels.push(if white { self.white_value } else { self.black_value });
                self.cur_x += 1;
            }
        }
        fn push_pixel_chunk(&mut self, white: bool, chunk_count: u32) {
            for _ in 0..(chunk_count * 8) {
                self.push_pixel(white);
            }
        }
        fn next_line(&mut self) {
            // Pad a short final run with the background (white) color so every
            // row is exactly `width` pixels.
            while self.cur_x < self.width {
                self.pixels.push(self.white_value);
                self.cur_x += 1;
            }
            self.cur_x = 0;
        }
    }

    let expected = (width as usize).saturating_mul(height as usize);
    let mut collector = Collector {
        pixels: Vec::with_capacity(expected),
        width,
        cur_x: 0,
        white_value: white_pel_value,
        black_value: black_pel_value,
    };

    // Each strip is an independent CCITT stream covering up to rows_per_strip
    // rows. Decode them one at a time (resetting the decoder per strip) and
    // accumulate the pixel rows, rather than concatenating the bitstreams.
    let rps = if rows_per_strip == 0 { height } else { rows_per_strip };
    for (i, (off, cnt)) in offsets.iter().zip(counts.iter()).enumerate() {
        let start = *off as usize;
        let end = start.saturating_add(*cnt as usize);
        if end > data.len() {
            return Err(JsValue::from_str("CCITT: strip byte range out of bounds"));
        }
        let rows_in_strip = height.saturating_sub(i as u32 * rps).min(rps);
        if rows_in_strip == 0 {
            break;
        }
        // FillOrder 2 stores the least-significant bit first; hayro expects MSB.
        let mut strip = data[start..end].to_vec();
        if fill_order == 2 {
            for b in strip.iter_mut() {
                *b = b.reverse_bits();
            }
        }
        let settings = DecodeSettings {
            columns: width,
            rows: rows_in_strip,
            end_of_block: true,
            end_of_line,
            rows_are_byte_aligned: byte_aligned,
            encoding,
            invert_black: false,
        };
        let mut ctx = DecoderContext::new(settings);
        collector.cur_x = 0;
        decode(&strip, &mut collector, &mut ctx)
            .map_err(|e| JsValue::from_str(&format!("CCITT strip {} decode failed: {:?}", i, e)))?;
    }

    let mut pixels = collector.pixels;
    pixels.resize(expected, white_pel_value);

    // CCITT data is always bilevel grayscale (photometric_interpretation is 0
    // or 1 here, never 5), so `finalize_decode_bytes`'s CMYK step is a no-op
    // and only the Orientation transform actually does anything.
    let (pixels, width, height, channels) =
        finalize_decode_bytes(pixels, width, height, 1, photometric_interpretation, orientation);

    let (min, max) = compute_stats_u8(&pixels);

    Ok(TiffResult {
        width,
        height,
        channels,
        bits_per_sample: 8,
        sample_format: 1,
        compression,
        predictor,
        photometric_interpretation,
        planar_configuration,
        rows_per_strip,
        strip_count: counts.len() as u32,
        strip_byte_count_total: counts.iter().copied().sum::<u64>(),
        strip_byte_count_max: counts.iter().copied().max().unwrap_or(0),
        tile_width: 0,
        tile_length: 0,
        tile_count: 0,
        direct_decode: false,
        data: pixels,
        data_f32: Vec::new(),
        min_value: min as f64,
        max_value: max as f64,
        timing_metadata_ms: 0.0,
        timing_decode_ms: 0.0,
        timing_convert_ms: 0.0,
        timing_stats_ms: 0.0,
        timing_pack_ms: 0.0,
        all_tags_json: extract_all_tags_json(data),
        ome_xml: extract_ome_xml(data),
    })
}

// SIMD-optimized conversion functions

/// Convert u16 slice to little-endian bytes using SIMD
#[inline]
fn convert_u16_to_bytes_simd(data: &[u16]) -> Vec<u8> {
    use wide::*;
    
    let mut bytes = Vec::with_capacity(data.len() * 2);
    
    // Process 8 u16s at a time (128-bit SIMD)
    let chunks = data.chunks_exact(8);
    let remainder = chunks.remainder();
    
    for chunk in chunks {
        let simd = u16x8::new([
            chunk[0], chunk[1], chunk[2], chunk[3],
            chunk[4], chunk[5], chunk[6], chunk[7]
        ]);
        
        let arr = simd.to_array();
        for val in arr {
            bytes.extend_from_slice(&val.to_le_bytes());
        }
    }
    
    // Handle remainder
    for &val in remainder {
        bytes.extend_from_slice(&val.to_le_bytes());
    }
    
    bytes
}

// Statistics computation functions

fn compute_stats_u8(data: &[u8]) -> (u8, u8) {
    let mut min = u8::MAX;
    let mut max = u8::MIN;
    for &v in data {
        min = min.min(v);
        max = max.max(v);
    }
    (min, max)
}

fn compute_stats_u16(data: &[u16]) -> (u16, u16) {
    let mut min = u16::MAX;
    let mut max = u16::MIN;
    for &v in data {
        min = min.min(v);
        max = max.max(v);
    }
    (min, max)
}

fn compute_stats_u32(data: &[u32]) -> (u32, u32) {
    let mut min = u32::MAX;
    let mut max = u32::MIN;
    for &v in data {
        min = min.min(v);
        max = max.max(v);
    }
    (min, max)
}

fn compute_stats_u64(data: &[u64]) -> (u64, u64) {
    let mut min = u64::MAX;
    let mut max = u64::MIN;
    for &v in data {
        min = min.min(v);
        max = max.max(v);
    }
    (min, max)
}

fn compute_stats_i8(data: &[i8]) -> (i8, i8) {
    let mut min = i8::MAX;
    let mut max = i8::MIN;
    for &v in data {
        min = min.min(v);
        max = max.max(v);
    }
    (min, max)
}

fn compute_stats_i16(data: &[i16]) -> (i16, i16) {
    let mut min = i16::MAX;
    let mut max = i16::MIN;
    for &v in data {
        min = min.min(v);
        max = max.max(v);
    }
    (min, max)
}

fn compute_stats_i32(data: &[i32]) -> (i32, i32) {
    let mut min = i32::MAX;
    let mut max = i32::MIN;
    for &v in data {
        min = min.min(v);
        max = max.max(v);
    }
    (min, max)
}

fn compute_stats_i64(data: &[i64]) -> (i64, i64) {
    let mut min = i64::MAX;
    let mut max = i64::MIN;
    for &v in data {
        min = min.min(v);
        max = max.max(v);
    }
    (min, max)
}

fn compute_stats_f32(data: &[f32]) -> (f64, f64) {
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for &v in data {
        if !v.is_nan() && v.is_finite() {
            let v64 = v as f64;
            min = min.min(v64);
            max = max.max(v64);
        }
    }
    (min, max)
}

fn compute_stats_f64(data: &[f64]) -> (f64, f64) {
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for &v in data {
        if !v.is_nan() && v.is_finite() {
            min = min.min(v);
            max = max.max(v);
        }
    }
    (min, max)
}

/// Persistent full-resolution RGBA compositor used by the layer worker.
///
/// Keeping the accumulation buffer in WASM is important: only each source
/// layer crosses the JS/WASM boundary once and only the finished composite is
/// copied back. The TypeScript compositor remains the correctness fallback for
/// hierarchy, masks, adjustments, arithmetic modes, and non-RGBA stacks.
#[wasm_bindgen]
pub struct RgbaLayerCompositor {
    width: u32,
    height: u32,
    type_max: f32,
    data: Vec<f32>,
    isolated: Option<Vec<f32>>,
    isolated_clip_alpha: Option<Vec<f32>>,
    isolated_snapshot: Option<Vec<f32>>,
    covered_count: u32,
}

#[wasm_bindgen]
impl RgbaLayerCompositor {
    fn validate_mask<T>(
        &self,
        mask: &[T],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
    ) -> Result<(), JsValue> {
        if channels == 0 {
            return Err(JsValue::from_str("Raster mask must have at least one channel"));
        }
        self.validate_type_max(type_max)?;
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(channels as usize))
            .ok_or_else(|| JsValue::from_str("Raster mask dimensions overflow"))?;
        if mask.len() != expected {
            return Err(JsValue::from_str(
                "Raster mask length does not match its dimensions",
            ));
        }
        Ok(())
    }

    fn mask_factor<T, F>(
        mask: &[T],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
        offset_x: i32,
        offset_y: i32,
        invert: bool,
        canvas_x: u32,
        canvas_y: u32,
        convert: &F,
    ) -> f32
    where
        F: Fn(&T) -> f32,
    {
        let mask_x = canvas_x as i64 - offset_x as i64;
        let mask_y = canvas_y as i64 - offset_y as i64;
        let mut factor = if mask_x < 0
            || mask_y < 0
            || mask_x >= width as i64
            || mask_y >= height as i64
        {
            0.0
        } else {
            let index =
                (mask_y as usize * width as usize + mask_x as usize) * channels as usize;
            let value = convert(&mask[index]);
            if value.is_finite() {
                (value / type_max).clamp(0.0, 1.0)
            } else {
                0.0
            }
        };
        if invert {
            factor = 1.0 - factor;
        }
        factor
    }

    fn apply_isolated_alpha_mask<T, F>(
        &mut self,
        mask: &[T],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
        offset_x: i32,
        offset_y: i32,
        invert: bool,
        convert: F,
    ) -> Result<(), JsValue>
    where
        F: Fn(&T) -> f32,
    {
        self.validate_mask(mask, width, height, channels, type_max)?;
        let canvas_width = self.width;
        let mut clip_alpha = self.isolated_clip_alpha.as_mut();
        let surface = self
            .isolated
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        for (pixel_index, pixel) in surface.chunks_exact_mut(4).enumerate() {
            let x = pixel_index as u32 % canvas_width;
            let y = pixel_index as u32 / canvas_width;
            let factor = Self::mask_factor(
                mask, width, height, channels, type_max, offset_x, offset_y, invert, x, y,
                &convert,
            );
            pixel[3] *= factor;
            if let Some(alpha) = clip_alpha.as_deref_mut() {
                alpha[pixel_index] *= factor;
            }
        }
        Ok(())
    }

    fn finish_isolated_masked_adjustment<T, F>(
        &mut self,
        mask: &[T],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
        offset_x: i32,
        offset_y: i32,
        invert: bool,
        convert: F,
    ) -> Result<(), JsValue>
    where
        F: Fn(&T) -> f32,
    {
        self.validate_mask(mask, width, height, channels, type_max)?;
        let original = self
            .isolated_snapshot
            .take()
            .ok_or_else(|| JsValue::from_str("No masked adjustment snapshot is active"))?;
        let canvas_width = self.width;
        let adjusted = self
            .isolated
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        for (pixel_index, (output, before)) in adjusted
            .chunks_exact_mut(4)
            .zip(original.chunks_exact(4))
            .enumerate()
        {
            let x = pixel_index as u32 % canvas_width;
            let y = pixel_index as u32 / canvas_width;
            let factor = Self::mask_factor(
                mask, width, height, channels, type_max, offset_x, offset_y, invert, x, y,
                &convert,
            );
            for channel in 0..3 {
                output[channel] = before[channel] + (output[channel] - before[channel]) * factor;
            }
            output[3] = before[3];
        }
        Ok(())
    }

    fn add_channels<T, F>(
        &mut self,
        source: &[T],
        width: u32,
        height: u32,
        channels: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
        convert: F,
    ) -> Result<(), JsValue>
    where
        F: Fn(&T) -> f32,
    {
        if !(1..=4).contains(&channels) {
            return Err(JsValue::from_str("Layer source must have one to four channels"));
        }
        self.validate_type_max(source_type_max)?;
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(channels as usize))
            .ok_or_else(|| JsValue::from_str("Layer source dimensions overflow"))?;
        if source.len() != expected {
            return Err(JsValue::from_str(
                "Layer source length does not match its dimensions and channel count",
            ));
        }
        self.add_source_channels(
            width,
            height,
            channels,
            offset_x,
            offset_y,
            opacity,
            blend_mode,
            source_type_max,
            |index| convert(&source[index]),
        );
        Ok(())
    }

    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32, type_max: f32) -> Result<RgbaLayerCompositor, JsValue> {
        if width == 0 || height == 0 || !type_max.is_finite() || type_max <= 0.0 {
            return Err(JsValue::from_str("Invalid RGBA compositor dimensions or type maximum"));
        }
        let pixel_count = (width as usize)
            .checked_mul(height as usize)
            .ok_or_else(|| JsValue::from_str("RGBA compositor dimensions overflow"))?;
        let value_count = pixel_count
            .checked_mul(4)
            .ok_or_else(|| JsValue::from_str("RGBA compositor allocation overflow"))?;
        Ok(RgbaLayerCompositor {
            width,
            height,
            type_max,
            data: vec![0.0; value_count],
            isolated: None,
            isolated_clip_alpha: None,
            isolated_snapshot: None,
            covered_count: 0,
        })
    }

    pub fn add_u8(
        &mut self,
        source: &[u8],
        width: u32,
        height: u32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.validate_source(source.len(), width, height)?;
        self.add_source(width, height, offset_x, offset_y, opacity, blend_mode, 255.0, |index| {
            source[index] as f32
        });
        Ok(())
    }

    pub fn add_u16(
        &mut self,
        source: &[u16],
        width: u32,
        height: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.validate_source(source.len(), width, height)?;
        self.validate_type_max(source_type_max)?;
        self.add_source(width, height, offset_x, offset_y, opacity, blend_mode, source_type_max, |index| {
            source[index] as f32
        });
        Ok(())
    }

    pub fn add_f32(
        &mut self,
        source: &[f32],
        width: u32,
        height: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.validate_source(source.len(), width, height)?;
        self.validate_type_max(source_type_max)?;
        self.add_source(width, height, offset_x, offset_y, opacity, blend_mode, source_type_max, |index| {
            source[index]
        });
        Ok(())
    }

    pub fn add_channels_u8(
        &mut self,
        source: &[u8],
        width: u32,
        height: u32,
        channels: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.add_channels(
            source,
            width,
            height,
            channels,
            source_type_max,
            offset_x,
            offset_y,
            opacity,
            blend_mode,
            |value| *value as f32,
        )
    }

    pub fn add_channels_u16(
        &mut self,
        source: &[u16],
        width: u32,
        height: u32,
        channels: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.add_channels(
            source,
            width,
            height,
            channels,
            source_type_max,
            offset_x,
            offset_y,
            opacity,
            blend_mode,
            |value| *value as f32,
        )
    }

    pub fn add_channels_u32(
        &mut self,
        source: &[u32],
        width: u32,
        height: u32,
        channels: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.add_channels(
            source,
            width,
            height,
            channels,
            source_type_max,
            offset_x,
            offset_y,
            opacity,
            blend_mode,
            |value| *value as f32,
        )
    }

    pub fn add_channels_i8(
        &mut self,
        source: &[i8],
        width: u32,
        height: u32,
        channels: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.add_channels(
            source,
            width,
            height,
            channels,
            source_type_max,
            offset_x,
            offset_y,
            opacity,
            blend_mode,
            |value| *value as f32,
        )
    }

    pub fn add_channels_i16(
        &mut self,
        source: &[i16],
        width: u32,
        height: u32,
        channels: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.add_channels(
            source,
            width,
            height,
            channels,
            source_type_max,
            offset_x,
            offset_y,
            opacity,
            blend_mode,
            |value| *value as f32,
        )
    }

    pub fn add_channels_i32(
        &mut self,
        source: &[i32],
        width: u32,
        height: u32,
        channels: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.add_channels(
            source,
            width,
            height,
            channels,
            source_type_max,
            offset_x,
            offset_y,
            opacity,
            blend_mode,
            |value| *value as f32,
        )
    }

    pub fn add_channels_f32(
        &mut self,
        source: &[f32],
        width: u32,
        height: u32,
        channels: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.add_channels(
            source,
            width,
            height,
            channels,
            source_type_max,
            offset_x,
            offset_y,
            opacity,
            blend_mode,
            |value| *value,
        )
    }

    pub fn add_channels_f64(
        &mut self,
        source: &[f64],
        width: u32,
        height: u32,
        channels: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.add_channels(
            source,
            width,
            height,
            channels,
            source_type_max,
            offset_x,
            offset_y,
            opacity,
            blend_mode,
            |value| *value as f32,
        )
    }

    /// Start an isolated clipping surface from one 8-bit RGBA raster. Filters
    /// modify this straight-colour surface before its original blend mode and
    /// opacity are applied to the main document.
    pub fn begin_isolated_u8(
        &mut self,
        source: &[u8],
        width: u32,
        height: u32,
        offset_x: i32,
        offset_y: i32,
    ) -> Result<(), JsValue> {
        let mut surface = RgbaLayerCompositor::new(self.width, self.height, self.type_max)?;
        surface.add_u8(source, width, height, offset_x, offset_y, 1.0, 0)?;
        self.isolated_clip_alpha = Some(surface.data.chunks_exact(4).map(|pixel| pixel[3]).collect());
        self.isolated = Some(surface.data);
        Ok(())
    }

    pub fn begin_isolated_u16(
        &mut self,
        source: &[u16],
        width: u32,
        height: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
    ) -> Result<(), JsValue> {
        let mut surface = RgbaLayerCompositor::new(self.width, self.height, self.type_max)?;
        surface.add_u16(
            source,
            width,
            height,
            source_type_max,
            offset_x,
            offset_y,
            1.0,
            0,
        )?;
        self.isolated_clip_alpha = Some(surface.data.chunks_exact(4).map(|pixel| pixel[3]).collect());
        self.isolated = Some(surface.data);
        Ok(())
    }

    pub fn begin_isolated_f32(
        &mut self,
        source: &[f32],
        width: u32,
        height: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
    ) -> Result<(), JsValue> {
        let mut surface = RgbaLayerCompositor::new(self.width, self.height, self.type_max)?;
        surface.add_f32(
            source,
            width,
            height,
            source_type_max,
            offset_x,
            offset_y,
            1.0,
            0,
        )?;
        self.isolated_clip_alpha = Some(surface.data.chunks_exact(4).map(|pixel| pixel[3]).collect());
        self.isolated = Some(surface.data);
        Ok(())
    }

    pub fn isolated_apply_alpha_mask_u8(
        &mut self,
        mask: &[u8],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
        offset_x: i32,
        offset_y: i32,
        invert: bool,
    ) -> Result<(), JsValue> {
        self.apply_isolated_alpha_mask(
            mask, width, height, channels, type_max, offset_x, offset_y, invert,
            |value| *value as f32,
        )
    }

    pub fn isolated_apply_alpha_mask_u16(
        &mut self,
        mask: &[u16],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
        offset_x: i32,
        offset_y: i32,
        invert: bool,
    ) -> Result<(), JsValue> {
        self.apply_isolated_alpha_mask(
            mask, width, height, channels, type_max, offset_x, offset_y, invert,
            |value| *value as f32,
        )
    }

    pub fn isolated_apply_alpha_mask_f32(
        &mut self,
        mask: &[f32],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
        offset_x: i32,
        offset_y: i32,
        invert: bool,
    ) -> Result<(), JsValue> {
        self.apply_isolated_alpha_mask(
            mask, width, height, channels, type_max, offset_x, offset_y, invert,
            |value| *value,
        )
    }

    pub fn isolated_begin_masked_adjustment(&mut self) -> Result<(), JsValue> {
        let surface = self
            .isolated
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        self.isolated_snapshot = Some(surface.clone());
        Ok(())
    }

    pub fn isolated_finish_masked_adjustment_u8(
        &mut self,
        mask: &[u8],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
        offset_x: i32,
        offset_y: i32,
        invert: bool,
    ) -> Result<(), JsValue> {
        self.finish_isolated_masked_adjustment(
            mask, width, height, channels, type_max, offset_x, offset_y, invert,
            |value| *value as f32,
        )
    }

    pub fn isolated_finish_masked_adjustment_u16(
        &mut self,
        mask: &[u16],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
        offset_x: i32,
        offset_y: i32,
        invert: bool,
    ) -> Result<(), JsValue> {
        self.finish_isolated_masked_adjustment(
            mask, width, height, channels, type_max, offset_x, offset_y, invert,
            |value| *value as f32,
        )
    }

    pub fn isolated_finish_masked_adjustment_f32(
        &mut self,
        mask: &[f32],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
        offset_x: i32,
        offset_y: i32,
        invert: bool,
    ) -> Result<(), JsValue> {
        self.finish_isolated_masked_adjustment(
            mask, width, height, channels, type_max, offset_x, offset_y, invert,
            |value| *value,
        )
    }

    /// Apply three 256-entry channel LUTs to the active isolated surface.
    /// Values in the LUT use the compositor's native value range.
    pub fn isolated_apply_lut(&mut self, tables: &[f32], amount: f32) -> Result<(), JsValue> {
        if tables.len() != 256 * 3 {
            return Err(JsValue::from_str(
                "Layer adjustment LUT must contain three 256-entry tables",
            ));
        }
        let amount = amount.clamp(0.0, 1.0);
        let type_max = self.type_max;
        let surface = self
            .isolated
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        if amount <= 0.0 {
            return Ok(());
        }
        for pixel in surface.chunks_exact_mut(4) {
            if pixel[3] <= 0.0 {
                continue;
            }
            for channel in 0..3 {
                let original = pixel[channel];
                if !original.is_finite() {
                    continue;
                }
                let position = (original * 255.0 / type_max).clamp(0.0, 255.0);
                let low = position.floor() as usize;
                let high = (low + 1).min(255);
                let fraction = position - low as f32;
                let base = channel * 256;
                let adjusted =
                    tables[base + low] + (tables[base + high] - tables[base + low]) * fraction;
                pixel[channel] = original + (adjusted - original) * amount;
            }
        }
        Ok(())
    }

    pub fn isolated_apply_hue(
        &mut self,
        hue_degrees: f32,
        saturation_delta: f32,
        lightness_delta: f32,
        colorize: bool,
        amount: f32,
    ) -> Result<(), JsValue> {
        let amount = amount.clamp(0.0, 1.0);
        let type_max = self.type_max;
        let surface = self
            .isolated
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        if amount <= 0.0 {
            return Ok(());
        }
        for pixel in surface.chunks_exact_mut(4) {
            if pixel[3] <= 0.0 || pixel[..3].iter().any(|value| !value.is_finite()) {
                continue;
            }
            let original = [pixel[0], pixel[1], pixel[2]];
            let (mut hue, mut saturation, mut lightness) = rgb_to_hsl_f32(
                original[0] / type_max,
                original[1] / type_max,
                original[2] / type_max,
            );
            if colorize {
                hue = hue_degrees.rem_euclid(360.0);
                saturation = saturation_delta.clamp(0.0, 1.0);
                let delta = lightness_delta.clamp(-1.0, 1.0);
                lightness = if delta < 0.0 {
                    lightness * (1.0 + delta)
                } else {
                    lightness + (1.0 - lightness) * delta
                };
            } else {
                hue = (hue + hue_degrees).rem_euclid(360.0);
                saturation = (saturation + saturation_delta).clamp(0.0, 1.0);
                lightness = (lightness + lightness_delta).clamp(0.0, 1.0);
            }
            let adjusted = hsl_to_rgb_f32(hue, saturation, lightness);
            for channel in 0..3 {
                let value = adjusted[channel] * type_max;
                pixel[channel] = original[channel] + (value - original[channel]) * amount;
            }
        }
        Ok(())
    }

    /// Apply master plus six selective hue/saturation ranges. `parameters`
    /// contains master H/S/L followed by six records of
    /// a/b/c/d/H/S/L for red, yellow, green, cyan, blue, and magenta.
    pub fn isolated_apply_selective_hue(
        &mut self,
        parameters: &[f32],
        amount: f32,
    ) -> Result<(), JsValue> {
        if parameters.len() != 45 {
            return Err(JsValue::from_str(
                "Selective hue parameters must contain 45 values",
            ));
        }
        let amount = amount.clamp(0.0, 1.0);
        let type_max = self.type_max;
        let surface = self
            .isolated
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        if amount <= 0.0 {
            return Ok(());
        }
        let centers = [0.0, 60.0, 120.0, 180.0, 240.0, 300.0];
        for pixel in surface.chunks_exact_mut(4) {
            if pixel[3] <= 0.0 || pixel[..3].iter().any(|value| !value.is_finite()) {
                continue;
            }
            let original = [pixel[0], pixel[1], pixel[2]];
            let (mut hue, mut saturation, mut lightness) = rgb_to_hsl_f32(
                original[0] / type_max,
                original[1] / type_max,
                original[2] / type_max,
            );
            let source_hue = hue;
            hue = (hue + parameters[0]).rem_euclid(360.0);
            saturation = (saturation + parameters[1] / 100.0).clamp(0.0, 1.0);
            lightness = (lightness + parameters[2] / 100.0).clamp(0.0, 1.0);
            for range in 0..6 {
                let base = 3 + range * 7;
                let weight = configured_hue_range_weight_f32(
                    source_hue,
                    [
                        parameters[base],
                        parameters[base + 1],
                        parameters[base + 2],
                        parameters[base + 3],
                    ],
                    centers[range],
                );
                hue = (hue + parameters[base + 4] * weight).rem_euclid(360.0);
                saturation =
                    (saturation + parameters[base + 5] / 100.0 * weight).clamp(0.0, 1.0);
                lightness =
                    (lightness + parameters[base + 6] / 100.0 * weight).clamp(0.0, 1.0);
            }
            let adjusted = hsl_to_rgb_f32(hue, saturation, lightness);
            for channel in 0..3 {
                let value = adjusted[channel] * type_max;
                pixel[channel] = original[channel] + (value - original[channel]) * amount;
            }
        }
        Ok(())
    }

    /// Apply the remaining pixel-local document adjustments. The operation
    /// codes and compact parameter layouts are defined by the layer worker:
    /// 2 brightness/contrast, 3 exposure, 4 invert, 5 channel mixer,
    /// 6 color balance, 7 black & white, 8 threshold, 9 posterize,
    /// 10 gradient-map LUT.
    pub fn isolated_apply_direct(
        &mut self,
        operation: u32,
        parameters: &[f32],
        amount: f32,
    ) -> Result<(), JsValue> {
        validate_direct_adjustment(operation, parameters)?;
        let amount = amount.clamp(0.0, 1.0);
        let type_max = self.type_max;
        let surface = self
            .isolated
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        if amount <= 0.0 {
            return Ok(());
        }
        for pixel in surface.chunks_exact_mut(4) {
            if pixel[3] <= 0.0 || pixel[..3].iter().any(|value| !value.is_finite()) {
                continue;
            }
            let original = [pixel[0], pixel[1], pixel[2]];
            let adjusted = apply_direct_adjustment(
                operation,
                parameters,
                [
                    original[0] / type_max,
                    original[1] / type_max,
                    original[2] / type_max,
                ],
            );
            for channel in 0..3 {
                let value = adjusted[channel] * type_max;
                pixel[channel] = original[channel] + (value - original[channel]) * amount;
            }
        }
        Ok(())
    }

    pub fn isolated_add_f32_surface(
        &mut self,
        source: &[f32],
        source_type_max: f32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.validate_source(source.len(), self.width, self.height)?;
        self.validate_type_max(source_type_max)?;
        let clip_alpha = self
            .isolated_clip_alpha
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No isolated clipping base is active"))?;
        let surface = self
            .isolated
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        let opacity = opacity.clamp(0.0, 1.0);
        let value_scale = self.type_max / source_type_max;
        for (pixel_index, output) in surface.chunks_exact_mut(4).enumerate() {
            let source_index = pixel_index * 4;
            let alpha_value = source[source_index + 3];
            let clip = clip_alpha[pixel_index] / self.type_max;
            if !alpha_value.is_finite() || !clip.is_finite() {
                output[0] = f32::NAN;
                output[1] = f32::NAN;
                output[2] = f32::NAN;
                output[3] = self.type_max;
                continue;
            }
            let source_alpha =
                (alpha_value / source_type_max * opacity * clip).clamp(0.0, 1.0);
            if source_alpha <= 0.0 {
                continue;
            }
            let destination_alpha = output[3] / self.type_max;
            let output_alpha = source_alpha + destination_alpha * (1.0 - source_alpha);
            for channel in 0..3 {
                output[channel] = composite_rgba_channel(
                    output[channel],
                    source[source_index + channel] * value_scale,
                    blend_mode,
                    source_alpha,
                    destination_alpha,
                    output_alpha,
                    self.type_max,
                );
            }
            output[3] = output_alpha * self.type_max;
        }
        Ok(())
    }

    pub fn isolated_add_arithmetic_f32_surface(
        &mut self,
        source: &[f32],
        source_type_max: f32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.validate_source(source.len(), self.width, self.height)?;
        self.validate_type_max(source_type_max)?;
        if !(8..=15).contains(&blend_mode) {
            return Err(JsValue::from_str("Invalid isolated arithmetic blend mode"));
        }
        let clip_alpha = self
            .isolated_clip_alpha
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No isolated clipping base is active"))?;
        let output = self
            .isolated
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        let opacity = opacity.clamp(0.0, 1.0);
        for pixel_index in 0..(self.width as usize * self.height as usize) {
            let index = pixel_index * 4;
            let factor = (source[index + 3] / source_type_max
                * clip_alpha[pixel_index]
                / self.type_max
                * opacity)
                .clamp(0.0, 1.0);
            if factor <= 0.0 {
                continue;
            }
            let was_covered = output[index + 3] > 0.0;
            for channel in 0..3 {
                let value = source[index + channel];
                if !was_covered {
                    output[index + channel] = value;
                } else {
                    let below = output[index + channel];
                    let result = arithmetic_layer_channel(below, value, blend_mode);
                    output[index + channel] = if factor >= 1.0 {
                        result
                    } else if result.is_finite() && below.is_finite() {
                        below + (result - below) * factor
                    } else {
                        f32::NAN
                    };
                }
            }
            output[index + 3] = self.type_max;
        }
        Ok(())
    }

    pub fn apply_brightness_mask_f32_surface(
        &mut self,
        source: &[f32],
        source_type_max: f32,
        condition: u32,
        threshold: f32,
    ) -> Result<(), JsValue> {
        self.validate_source(source.len(), self.width, self.height)?;
        self.validate_type_max(source_type_max)?;
        let value_scale = self.type_max / source_type_max;
        for pixel_index in 0..(self.width as usize * self.height as usize) {
            let destination = pixel_index * 4;
            if self.data[destination + 3] <= 0.0 || source[destination + 3] <= 0.0 {
                continue;
            }
            let value = (0.2126 * source[destination]
                + 0.7152 * source[destination + 1]
                + 0.0722 * source[destination + 2])
                * value_scale;
            let keep = match condition {
                1 => value > threshold,
                2 => value >= threshold,
                3 => value < threshold,
                4 => value <= threshold,
                5 => value == threshold,
                6 => value.is_finite(),
                7 => !value.is_finite(),
                _ => true,
            };
            if !keep {
                self.data[destination] = 0.0;
                self.data[destination + 1] = 0.0;
                self.data[destination + 2] = 0.0;
                self.data[destination + 3] = 0.0;
                self.covered_count = self.covered_count.saturating_sub(1);
            }
        }
        Ok(())
    }

    pub fn add_arithmetic_f32_surface(
        &mut self,
        source: &[f32],
        source_type_max: f32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.validate_source(source.len(), self.width, self.height)?;
        self.validate_type_max(source_type_max)?;
        if !(8..=15).contains(&blend_mode) {
            return Err(JsValue::from_str("Invalid arithmetic layer blend mode"));
        }
        let opacity = opacity.clamp(0.0, 1.0);
        for pixel_index in 0..(self.width as usize * self.height as usize) {
            let index = pixel_index * 4;
            let factor = (source[index + 3] / source_type_max * opacity).clamp(0.0, 1.0);
            if factor <= 0.0 {
                continue;
            }
            let was_covered = self.data[index + 3] > 0.0;
            for channel in 0..3 {
                let value = source[index + channel];
                if !was_covered {
                    self.data[index + channel] = value;
                } else {
                    let below = self.data[index + channel];
                    let result = arithmetic_layer_channel(below, value, blend_mode);
                    self.data[index + channel] = if factor >= 1.0 {
                        result
                    } else if result.is_finite() && below.is_finite() {
                        below + (result - below) * factor
                    } else {
                        f32::NAN
                    };
                }
            }
            self.data[index + 3] = self.type_max;
            if !was_covered {
                self.covered_count += 1;
            }
        }
        Ok(())
    }

    pub fn take_isolated_surface(&mut self) -> Result<Vec<f32>, JsValue> {
        self.isolated_clip_alpha = None;
        self.isolated_snapshot = None;
        self.isolated
            .take()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))
    }

    pub fn finish_isolated(&mut self, opacity: f32, blend_mode: u32) -> Result<(), JsValue> {
        let surface = self
            .isolated
            .take()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        self.add_source(
            self.width,
            self.height,
            0,
            0,
            opacity,
            blend_mode,
            self.type_max,
            |index| surface[index],
        );
        self.isolated_clip_alpha = None;
        self.isolated_snapshot = None;
        Ok(())
    }

    #[wasm_bindgen(getter)]
    pub fn covered_count(&self) -> u32 {
        self.covered_count
    }

    #[wasm_bindgen(getter)]
    pub fn min_value(&self) -> f32 {
        self.stats().0
    }

    #[wasm_bindgen(getter)]
    pub fn max_value(&self) -> f32 {
        self.stats().1
    }

    pub fn take_data(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.data)
    }

    pub fn take_data_as_channels(&mut self, channels: u32) -> Result<Vec<f32>, JsValue> {
        if channels == 4 {
            return Ok(std::mem::take(&mut self.data));
        }
        if channels != 1 && channels != 3 {
            return Err(JsValue::from_str(
                "RGBA compositor output must use one, three, or four channels",
            ));
        }
        let mut output = Vec::with_capacity(
            (self.width as usize)
                .saturating_mul(self.height as usize)
                .saturating_mul(channels as usize),
        );
        for pixel in self.data.chunks_exact(4) {
            if pixel[3] <= 0.0 {
                for _ in 0..channels {
                    output.push(f32::NAN);
                }
            } else if channels == 1 {
                output.push(pixel[0]);
            } else {
                output.extend_from_slice(&pixel[..3]);
            }
        }
        self.data.clear();
        Ok(output)
    }
}

fn rgb_to_hsl_f32(red: f32, green: f32, blue: f32) -> (f32, f32, f32) {
    let maximum = red.max(green).max(blue);
    let minimum = red.min(green).min(blue);
    let delta = maximum - minimum;
    let lightness = (maximum + minimum) * 0.5;
    if delta <= 0.0 {
        return (0.0, 0.0, lightness);
    }
    let raw_hue = if maximum == red {
        ((green - blue) / delta).rem_euclid(6.0)
    } else if maximum == green {
        (blue - red) / delta + 2.0
    } else {
        (red - green) / delta + 4.0
    };
    let saturation = delta / (1.0 - (2.0 * lightness - 1.0).abs()).max(1e-6);
    ((raw_hue * 60.0).rem_euclid(360.0), saturation, lightness)
}

fn hsl_to_rgb_f32(hue: f32, saturation: f32, lightness: f32) -> [f32; 3] {
    let chroma = (1.0 - (2.0 * lightness - 1.0).abs()) * saturation;
    let section = hue.rem_euclid(360.0) / 60.0;
    let x = chroma * (1.0 - (section.rem_euclid(2.0) - 1.0).abs());
    let (red, green, blue) = if section < 1.0 {
        (chroma, x, 0.0)
    } else if section < 2.0 {
        (x, chroma, 0.0)
    } else if section < 3.0 {
        (0.0, chroma, x)
    } else if section < 4.0 {
        (0.0, x, chroma)
    } else if section < 5.0 {
        (x, 0.0, chroma)
    } else {
        (chroma, 0.0, x)
    };
    let offset = lightness - chroma * 0.5;
    [red + offset, green + offset, blue + offset]
}

fn clamp_unit_f32(value: f32) -> f32 {
    value.clamp(0.0, 1.0)
}

fn luminance_f32(color: [f32; 3]) -> f32 {
    0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]
}

fn hue_range_weight_f32(hue: f32, center: f32) -> f32 {
    let distance = ((hue - center + 540.0).rem_euclid(360.0) - 180.0).abs();
    if distance <= 30.0 {
        1.0
    } else if distance >= 60.0 {
        0.0
    } else {
        (60.0 - distance) / 30.0
    }
}

fn configured_hue_range_weight_f32(
    hue: f32,
    mut boundaries: [f32; 4],
    fallback_center: f32,
) -> f32 {
    if boundaries.iter().any(|value| !value.is_finite()) {
        return hue_range_weight_f32(hue, fallback_center);
    }
    while boundaries[1] < boundaries[0] {
        boundaries[1] += 360.0;
    }
    while boundaries[2] < boundaries[1] {
        boundaries[2] += 360.0;
    }
    while boundaries[3] < boundaries[2] {
        boundaries[3] += 360.0;
    }
    let mut weight: f32 = 0.0;
    let mut candidate = hue - 360.0;
    while candidate <= hue + 720.0 {
        if candidate >= boundaries[0] && candidate <= boundaries[3] {
            let value = if candidate < boundaries[1] {
                (candidate - boundaries[0]) / (boundaries[1] - boundaries[0]).max(1e-6)
            } else if candidate <= boundaries[2] {
                1.0
            } else {
                (boundaries[3] - candidate) / (boundaries[3] - boundaries[2]).max(1e-6)
            };
            weight = weight.max(value);
        }
        candidate += 360.0;
    }
    weight.clamp(0.0, 1.0)
}

fn validate_direct_adjustment(operation: u32, parameters: &[f32]) -> Result<(), JsValue> {
    let valid = match operation {
        2 => parameters.len() >= 2,
        3 => parameters.len() >= 3,
        4 => true,
        5 => parameters.len() >= 17,
        6 => parameters.len() >= 10,
        7 => parameters.len() >= 6,
        8 | 9 => !parameters.is_empty(),
        10 => parameters.len() == 256 * 3,
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(JsValue::from_str(
            "Invalid Rust/Wasm direct adjustment operation or parameters",
        ))
    }
}

fn apply_direct_adjustment(operation: u32, parameters: &[f32], color: [f32; 3]) -> [f32; 3] {
    let [mut red, mut green, mut blue] = color;
    match operation {
        2 => {
            let brightness = parameters[0] / 100.0;
            let contrast = (parameters[1] / 100.0).clamp(-0.99, 0.99);
            let factor = (1.0 + contrast) / (1.0 - contrast);
            red = (red - 0.5) * factor + 0.5 + brightness;
            green = (green - 0.5) * factor + 0.5 + brightness;
            blue = (blue - 0.5) * factor + 0.5 + brightness;
        }
        3 => {
            let multiplier = 2.0_f32.powf(parameters[0]);
            let offset = parameters[1];
            let gamma = parameters[2].max(0.01);
            red = (red * multiplier + offset).max(0.0).powf(1.0 / gamma);
            green = (green * multiplier + offset)
                .max(0.0)
                .powf(1.0 / gamma);
            blue = (blue * multiplier + offset).max(0.0).powf(1.0 / gamma);
        }
        4 => {
            red = 1.0 - red;
            green = 1.0 - green;
            blue = 1.0 - blue;
        }
        5 => {
            let source = [red, green, blue];
            let mix = |base: usize| {
                source[0] * parameters[base] / 100.0
                    + source[1] * parameters[base + 1] / 100.0
                    + source[2] * parameters[base + 2] / 100.0
                    + parameters[base + 3] / 100.0
            };
            if parameters[0] > 0.5 {
                let gray = mix(13);
                red = gray;
                green = gray;
                blue = gray;
            } else {
                red = mix(1);
                green = mix(5);
                blue = mix(9);
            }
        }
        6 => {
            let original_lightness = rgb_to_hsl_f32(red, green, blue).2;
            let light = luminance_f32([red, green, blue]);
            let weights = [
                clamp_unit_f32((0.5 - light) * 2.0),
                1.0 - (light - 0.5).abs() * 2.0,
                clamp_unit_f32((light - 0.5) * 2.0),
            ];
            for range in 0..3 {
                let base = range * 3;
                red += parameters[base] / 100.0 * weights[range];
                green += parameters[base + 1] / 100.0 * weights[range];
                blue += parameters[base + 2] / 100.0 * weights[range];
            }
            if parameters[9] > 0.5 {
                let (hue, saturation, _) =
                    rgb_to_hsl_f32(clamp_unit_f32(red), clamp_unit_f32(green), clamp_unit_f32(blue));
                [red, green, blue] = hsl_to_rgb_f32(hue, saturation, original_lightness);
            }
        }
        7 => {
            let (hue, saturation, _) = rgb_to_hsl_f32(red, green, blue);
            let centers = [0.0, 60.0, 120.0, 180.0, 240.0, 300.0];
            let mut weighted = 0.0;
            let mut total = 0.0;
            for index in 0..6 {
                let weight = hue_range_weight_f32(hue, centers[index]);
                weighted += parameters[index] * weight;
                total += weight;
            }
            let gray = luminance_f32([red, green, blue])
                + (((if total > 0.0 { weighted / total } else { 50.0 }) - 50.0) / 100.0)
                    * saturation
                    * 0.5;
            red = gray;
            green = gray;
            blue = gray;
        }
        8 => {
            let value = if luminance_f32([red, green, blue]) * 255.0 >= parameters[0] {
                1.0
            } else {
                0.0
            };
            red = value;
            green = value;
            blue = value;
        }
        9 => {
            let levels = parameters[0].round().clamp(2.0, 255.0);
            let quantize = |value: f32| (value * (levels - 1.0)).round() / (levels - 1.0);
            red = quantize(red);
            green = quantize(green);
            blue = quantize(blue);
        }
        10 => {
            let position = clamp_unit_f32(luminance_f32([red, green, blue])) * 255.0;
            let low = position.floor() as usize;
            let high = (low + 1).min(255);
            let fraction = position - low as f32;
            for channel in 0..3 {
                let base = channel * 256;
                let value = parameters[base + low]
                    + (parameters[base + high] - parameters[base + low]) * fraction;
                match channel {
                    0 => red = value,
                    1 => green = value,
                    _ => blue = value,
                }
            }
        }
        _ => {}
    }
    [clamp_unit_f32(red), clamp_unit_f32(green), clamp_unit_f32(blue)]
}

impl RgbaLayerCompositor {
    fn validate_source(&self, length: usize, width: u32, height: u32) -> Result<(), JsValue> {
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| JsValue::from_str("RGBA source dimensions overflow"))?;
        if length != expected {
            return Err(JsValue::from_str("RGBA source length does not match its dimensions"));
        }
        Ok(())
    }

    fn validate_type_max(&self, source_type_max: f32) -> Result<(), JsValue> {
        if !source_type_max.is_finite() || source_type_max <= 0.0 {
            return Err(JsValue::from_str("Invalid RGBA source type maximum"));
        }
        Ok(())
    }

    fn add_source<F>(
        &mut self,
        source_width: u32,
        source_height: u32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
        source_type_max: f32,
        sample: F,
    )
    where
        F: Fn(usize) -> f32,
    {
        let opacity = opacity.clamp(0.0, 1.0);
        if opacity <= 0.0 {
            return;
        }
        let x_start = offset_x.max(0) as u32;
        let y_start = offset_y.max(0) as u32;
        let x_end = self.width.min((offset_x as i64 + source_width as i64).max(0) as u32);
        let y_end = self.height.min((offset_y as i64 + source_height as i64).max(0) as u32);
        if x_start >= x_end || y_start >= y_end {
            return;
        }
        let value_scale = self.type_max / source_type_max;
        for y in y_start..y_end {
            let source_y = (y as i64 - offset_y as i64) as usize;
            for x in x_start..x_end {
                let source_x = (x as i64 - offset_x as i64) as usize;
                let source_index = (source_y * source_width as usize + source_x) * 4;
                let destination_index = (y as usize * self.width as usize + x as usize) * 4;
                let source_alpha_value = sample(source_index + 3);
                if !source_alpha_value.is_finite() {
                    self.cover_invalid(destination_index);
                    continue;
                }
                let source_alpha = (source_alpha_value / source_type_max * opacity).clamp(0.0, 1.0);
                if source_alpha <= 0.0 {
                    continue;
                }
                let destination_alpha = self.data[destination_index + 3] / self.type_max;
                let output_alpha = source_alpha + destination_alpha * (1.0 - source_alpha);
                let was_covered = destination_alpha > 0.0;
                for channel in 0..3 {
                    let source_value = sample(source_index + channel) * value_scale;
                    let below = self.data[destination_index + channel];
                    self.data[destination_index + channel] = composite_rgba_channel(
                        below,
                        source_value,
                        blend_mode,
                        source_alpha,
                        destination_alpha,
                        output_alpha,
                        self.type_max,
                    );
                }
                self.data[destination_index + 3] = output_alpha * self.type_max;
                if !was_covered {
                    self.covered_count += 1;
                }
            }
        }
    }

    fn add_source_channels<F>(
        &mut self,
        source_width: u32,
        source_height: u32,
        channels: u32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
        source_type_max: f32,
        sample: F,
    ) where
        F: Fn(usize) -> f32,
    {
        let opacity = opacity.clamp(0.0, 1.0);
        if opacity <= 0.0 {
            return;
        }
        let x_start = offset_x.max(0) as u32;
        let y_start = offset_y.max(0) as u32;
        let x_end = self
            .width
            .min((offset_x as i64 + source_width as i64).max(0) as u32);
        let y_end = self
            .height
            .min((offset_y as i64 + source_height as i64).max(0) as u32);
        if x_start >= x_end || y_start >= y_end {
            return;
        }
        let value_scale = self.type_max / source_type_max;
        for y in y_start..y_end {
            let source_y = (y as i64 - offset_y as i64) as usize;
            for x in x_start..x_end {
                let source_x = (x as i64 - offset_x as i64) as usize;
                let source_index =
                    (source_y * source_width as usize + source_x) * channels as usize;
                let destination_index = (y as usize * self.width as usize + x as usize) * 4;
                if (8..=15).contains(&blend_mode) {
                    let was_covered = self.data[destination_index + 3] > 0.0;
                    for channel in 0..3 {
                        let source_channel = if channels <= 2 {
                            0
                        } else {
                            channel.min(channels as usize - 1)
                        };
                        let source_value = sample(source_index + source_channel);
                        if !was_covered {
                            self.data[destination_index + channel] = source_value;
                        } else {
                            let below = self.data[destination_index + channel];
                            let result =
                                arithmetic_layer_channel(below, source_value, blend_mode);
                            self.data[destination_index + channel] = if opacity >= 1.0 {
                                result
                            } else if result.is_finite() && below.is_finite() {
                                below + (result - below) * opacity
                            } else {
                                f32::NAN
                            };
                        }
                    }
                    self.data[destination_index + 3] = self.type_max;
                    if !was_covered {
                        self.covered_count += 1;
                    }
                    continue;
                }
                let source_alpha_value = if channels == 2 || channels == 4 {
                    sample(source_index + channels as usize - 1)
                } else {
                    source_type_max
                };
                if !source_alpha_value.is_finite() {
                    self.cover_invalid(destination_index);
                    continue;
                }
                let source_alpha =
                    (source_alpha_value / source_type_max * opacity).clamp(0.0, 1.0);
                if source_alpha <= 0.0 {
                    continue;
                }
                let destination_alpha = self.data[destination_index + 3] / self.type_max;
                let output_alpha = source_alpha + destination_alpha * (1.0 - source_alpha);
                let was_covered = destination_alpha > 0.0;
                for channel in 0..3 {
                    let source_channel = if channels <= 2 {
                        0
                    } else {
                        channel.min(channels as usize - 1)
                    };
                    let source_value = sample(source_index + source_channel) * value_scale;
                    let below = self.data[destination_index + channel];
                    self.data[destination_index + channel] = composite_rgba_channel(
                        below,
                        source_value,
                        blend_mode,
                        source_alpha,
                        destination_alpha,
                        output_alpha,
                        self.type_max,
                    );
                }
                self.data[destination_index + 3] = output_alpha * self.type_max;
                if !was_covered {
                    self.covered_count += 1;
                }
            }
        }
    }

    fn cover_invalid(&mut self, destination_index: usize) {
        if self.data[destination_index + 3] <= 0.0 {
            self.covered_count += 1;
        }
        self.data[destination_index] = f32::NAN;
        self.data[destination_index + 1] = f32::NAN;
        self.data[destination_index + 2] = f32::NAN;
        self.data[destination_index + 3] = self.type_max;
    }

    fn stats(&self) -> (f32, f32) {
        let mut minimum = f32::INFINITY;
        let mut maximum = f32::NEG_INFINITY;
        for pixel in self.data.chunks_exact(4) {
            if pixel[3] <= 0.0 {
                continue;
            }
            for value in &pixel[..3] {
                if value.is_finite() {
                    minimum = minimum.min(*value);
                    maximum = maximum.max(*value);
                }
            }
        }
        if minimum == f32::INFINITY {
            (0.0, 0.0)
        } else {
            (minimum, maximum)
        }
    }
}

fn composite_rgba_channel(
    below: f32,
    source: f32,
    mode: u32,
    source_alpha: f32,
    destination_alpha: f32,
    output_alpha: f32,
    type_max: f32,
) -> f32 {
    if destination_alpha <= 0.0 || source_alpha >= 1.0 && mode == 0 {
        return source;
    }
    if !below.is_finite() || !source.is_finite() {
        return f32::NAN;
    }
    if mode == 0 {
        return (source * source_alpha + below * destination_alpha * (1.0 - source_alpha)) / output_alpha;
    }
    let blended = match mode {
        1 => below * source / type_max,
        2 => type_max - (type_max - below) * (type_max - source) / type_max,
        3 => {
            if below <= type_max * 0.5 {
                2.0 * below * source / type_max
            } else {
                type_max - 2.0 * (type_max - below) * (type_max - source) / type_max
            }
        }
        4 => below.min(source),
        5 => below.max(source),
        6 => (below - source).abs(),
        7 => below + source - 2.0 * below * source / type_max,
        _ => source,
    };
    ((1.0 - source_alpha) * destination_alpha * below
        + (1.0 - destination_alpha) * source_alpha * source
        + destination_alpha * source_alpha * blended)
        / output_alpha
}

fn arithmetic_layer_channel(below: f32, source: f32, mode: u32) -> f32 {
    match mode {
        8 => below + source,
        9 => below - source,
        10 => (below - source).abs(),
        11 => below * source,
        12 => {
            if source == 0.0 {
                f32::NAN
            } else {
                below / source
            }
        }
        13 => below.min(source),
        14 => below.max(source),
        15 => (below + source) * 0.5,
        _ => source,
    }
}

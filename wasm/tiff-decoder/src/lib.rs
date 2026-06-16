//! Fast TIFF decoder for WebAssembly
//! 
//! This library provides high-performance TIFF decoding for use in browser environments
//! through WebAssembly. It's designed to be a drop-in replacement for slow parts of
//! geotiff.js while maintaining compatibility with existing JavaScript code.

use wasm_bindgen::prelude::*;
use std::io::Cursor;
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
    // Data stored as bytes, interpreted based on sample_format
    data: Vec<u8>,
    // Computed statistics
    min_value: f64,
    max_value: f64,
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

    /// Get raw data as bytes (for transferring to JS)
    #[wasm_bindgen]
    pub fn get_data_bytes(&self) -> Vec<u8> {
        self.data.clone()
    }

    /// Get data as Float32Array (most common for visualization)
    #[wasm_bindgen]
    pub fn get_data_as_f32(&self) -> Vec<f32> {
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
                    16 => self.data
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
}

/// Decode a TIFF file from an ArrayBuffer
/// Returns TiffResult with image data and metadata
#[wasm_bindgen]
pub fn decode_tiff(data: &[u8]) -> Result<TiffResult, JsValue> {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();

    let start_time = js_sys::Date::now();

    let cursor = Cursor::new(data);
    let mut decoder = Decoder::new(cursor)
        .map_err(|e| JsValue::from_str(&format!("Failed to create decoder: {}", e)))?;

    let (width, height) = decoder.dimensions()
        .map_err(|e| JsValue::from_str(&format!("Failed to get dimensions: {}", e)))?;

    // Palette (RGBPalette, PhotometricInterpretation 3) images are rejected by
    // the tiff crate's colortype()/read_image(), so handle them via a dedicated
    // index + ColorMap path before those calls error out.
    let photometric_early = decoder.get_tag_u32(tiff::tags::Tag::PhotometricInterpretation).unwrap_or(1);
    if photometric_early == 3 {
        return decode_palette(data, width, height);
    }

    // Get color type and bits per sample
    let color_type = decoder.colortype()
        .map_err(|e| JsValue::from_str(&format!("Failed to get color type: {}", e)))?;

    let channels = match color_type {
        tiff::ColorType::Gray(_) => 1,
        tiff::ColorType::GrayA(_) => 2,
        tiff::ColorType::RGB(_) => 3,
        tiff::ColorType::RGBA(_) => 4,
        tiff::ColorType::CMYK(_) => 4,
        // JPEG-compressed TIFFs are commonly stored as YCbCr; the tiff crate
        // decodes them to interleaved RGB, so report 3 channels here.
        tiff::ColorType::YCbCr(_) => 3,
        _ => 1,
    };

    // Try to get bits per sample
    let mut bits_per_sample = match &color_type {
        tiff::ColorType::Gray(bits) => *bits as u32,
        tiff::ColorType::GrayA(bits) => *bits as u32,
        tiff::ColorType::RGB(bits) => *bits as u32,
        tiff::ColorType::RGBA(bits) => *bits as u32,
        tiff::ColorType::CMYK(bits) => *bits as u32,
        tiff::ColorType::YCbCr(bits) => *bits as u32,
        _ => 8,
    };

    // Extract metadata from decoder
    // Get compression method (default to 1 = None if not found)
    let compression = decoder.get_tag_u32(tiff::tags::Tag::Compression)
        .unwrap_or(1);
    
    // Get predictor (default to 1 = None if not found)
    let predictor = decoder.get_tag_u32(tiff::tags::Tag::Predictor)
        .unwrap_or(1);
    
    // Get photometric interpretation (default to 1 = BlackIsZero if not found)
    let photometric_interpretation = decoder.get_tag_u32(tiff::tags::Tag::PhotometricInterpretation)
        .unwrap_or(1);
    
    // Get planar configuration (default to 1 = Chunky if not found)
    let planar_configuration = decoder.get_tag_u32(tiff::tags::Tag::PlanarConfiguration)
        .unwrap_or(1);

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
        return decode_ccitt(
            data, width, height, compression, predictor,
            photometric_interpretation, planar_configuration,
            &offsets, &counts, fill_order, t4_options,
        );
    }

    let decode_start = js_sys::Date::now();

    // Read image data (decompression happens here)
    let decode_result = decoder.read_image()
        .map_err(|e| JsValue::from_str(&format!("Failed to decode image: {}", e)))?;
    
    let decompress_time = js_sys::Date::now() - decode_start;
    let convert_start = js_sys::Date::now();

    // Determine sample format and convert data to bytes
    let (data_bytes, sample_format, min_val, max_val) = match decode_result {
        DecodingResult::U8(data) => {
            if bits_per_sample == 1 {
                // Uncompressed (or LZW/PackBits/Deflate) bilevel images are
                // returned as MSB-first packed bits with each row padded to a
                // byte boundary. Expand to one byte per pixel so they render
                // like any other 8-bit grayscale image.
                let expanded = unpack_bilevel(&data, width, height, photometric_interpretation);
                bits_per_sample = 8;
                let (min, max) = compute_stats_u8(&expanded);
                (expanded, 1u32, min as f64, max as f64)
            } else {
                let (min, max) = compute_stats_u8(&data);
                (data, 1u32, min as f64, max as f64)
            }
        }
        DecodingResult::U16(data) => {
            let (min, max) = compute_stats_u16(&data);
            // SIMD-optimized byte conversion
            let bytes = convert_u16_to_bytes_simd(&data);
            (bytes, 1u32, min as f64, max as f64)
        }
        DecodingResult::U32(data) => {
            let (min, max) = compute_stats_u32(&data);
            let bytes: Vec<u8> = data.iter()
                .flat_map(|&v| v.to_le_bytes())
                .collect();
            (bytes, 1u32, min as f64, max as f64)
        }
        DecodingResult::U64(data) => {
            let (min, max) = compute_stats_u64(&data);
            let bytes: Vec<u8> = data.iter()
                .flat_map(|&v| v.to_le_bytes())
                .collect();
            (bytes, 1u32, min as f64, max as f64)
        }
        DecodingResult::I8(data) => {
            let (min, max) = compute_stats_i8(&data);
            let ubytes: Vec<u8> = data.iter().map(|&v| v as u8).collect();
            (ubytes, 2u32, min as f64, max as f64)
        }
        DecodingResult::I16(data) => {
            let (min, max) = compute_stats_i16(&data);
            let bytes: Vec<u8> = data.iter()
                .flat_map(|&v| v.to_le_bytes())
                .collect();
            (bytes, 2u32, min as f64, max as f64)
        }
        DecodingResult::I32(data) => {
            let (min, max) = compute_stats_i32(&data);
            let bytes: Vec<u8> = data.iter()
                .flat_map(|&v| v.to_le_bytes())
                .collect();
            (bytes, 2u32, min as f64, max as f64)
        }
        DecodingResult::I64(data) => {
            let (min, max) = compute_stats_i64(&data);
            let bytes: Vec<u8> = data.iter()
                .flat_map(|&v| v.to_le_bytes())
                .collect();
            (bytes, 2u32, min as f64, max as f64)
        }
        DecodingResult::F32(data) => {
            let (min, max) = compute_stats_f32(&data);
            // SIMD-optimized byte conversion
            let bytes = convert_f32_to_bytes_simd(&data);
            (bytes, 3u32, min as f64, max as f64)
        }
        DecodingResult::F64(data) => {
            let (min, max) = compute_stats_f64(&data);
            // Convert to f32 for consistency and pre-allocate
            let mut bytes = Vec::with_capacity(data.len() * 4);
            for &val in &data {
                bytes.extend_from_slice(&(val as f32).to_le_bytes());
            }
            (bytes, 3u32, min, max)
        }
        DecodingResult::F16(data) => {
            // Convert f16 to f32 for processing and pre-allocate
            let mut bytes = Vec::with_capacity(data.len() * 4);
            let mut min_val = f32::INFINITY;
            let mut max_val = f32::NEG_INFINITY;
            
            for &val in &data {
                let f32_val = val.to_f32();
                if f32_val < min_val { min_val = f32_val; }
                if f32_val > max_val { max_val = f32_val; }
                bytes.extend_from_slice(&f32_val.to_le_bytes());
            }
            (bytes, 3u32, min_val as f64, max_val as f64)
        }
    };

    let result = Ok(TiffResult {
        width,
        height,
        channels,
        bits_per_sample,
        sample_format,
        compression,
        predictor,
        photometric_interpretation,
        planar_configuration,
        data: data_bytes,
        min_value: min_val,
        max_value: max_val,
    });
    
    let convert_time = js_sys::Date::now() - convert_start;
    let total_time = js_sys::Date::now() - start_time;
    let metadata_time = total_time - decompress_time - convert_time;
    
    web_sys::console::log_1(&format!(
        "[Rust] Total: {:.2}ms (metadata: {:.2}ms, decompress: {:.2}ms, convert: {:.2}ms)", 
        total_time, metadata_time, decompress_time, convert_time
    ).into());
    
    result
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

/// Rewrite the first IFD's PhotometricInterpretation (tag 262) from
/// RGBPalette (3) to BlackIsZero (1), in place, so the tiff crate will decode
/// the raw palette indices instead of refusing the image. Returns false (and
/// leaves the buffer untouched) for anything it does not understand, e.g.
/// BigTIFF.
fn patch_photometric_to_grayscale(buf: &mut [u8]) -> bool {
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
    let ifd = rd32(&buf[4..8]) as usize;
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
fn decode_palette(data: &[u8], width: u32, height: u32) -> Result<TiffResult, JsValue> {
    use tiff::tags::Tag;

    // ColorMap (tag 320): 3 * 2^bits 16-bit entries, laid out as all reds, then
    // all greens, then all blues.
    let cmap = {
        let mut d = Decoder::new(Cursor::new(data))
            .map_err(|e| JsValue::from_str(&format!("Palette: decoder init: {}", e)))?;
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
    if !patch_photometric_to_grayscale(&mut patched) {
        return Err(JsValue::from_str("Palette: could not patch photometric tag"));
    }

    let mut d = Decoder::new(Cursor::new(patched.as_slice()))
        .map_err(|e| JsValue::from_str(&format!("Palette: patched decoder init: {}", e)))?;
    let compression = d.get_tag_u32(Tag::Compression).unwrap_or(1);
    let predictor = d.get_tag_u32(Tag::Predictor).unwrap_or(1);
    let planar = d.get_tag_u32(Tag::PlanarConfiguration).unwrap_or(1);

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

    let (min, max) = compute_stats_u8(&rgb);
    Ok(TiffResult {
        width,
        height,
        channels: 3,
        bits_per_sample: 8,
        sample_format: 1,
        compression,
        predictor,
        photometric_interpretation: 2, // expanded to RGB
        planar_configuration: planar,
        data: rgb,
        min_value: min as f64,
        max_value: max as f64,
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
) -> Result<TiffResult, JsValue> {
    use hayro_ccitt::{decode, DecodeSettings, DecoderContext, EncodingMode, Decoder as CcittDecoder};

    // Concatenate the raw compressed bytes of every strip.
    let mut compressed: Vec<u8> = Vec::new();
    for (off, cnt) in offsets.iter().zip(counts.iter()) {
        let start = *off as usize;
        let end = start.saturating_add(*cnt as usize);
        if end > data.len() {
            return Err(JsValue::from_str("CCITT: strip byte range out of bounds"));
        }
        compressed.extend_from_slice(&data[start..end]);
    }

    // TIFF FillOrder 2 stores the least-significant bit first; hayro-ccitt
    // expects most-significant-bit-first data, so flip each byte.
    if fill_order == 2 {
        for b in compressed.iter_mut() {
            *b = b.reverse_bits();
        }
    }

    // Map the TIFF compression + T4Options to a hayro encoding mode.
    let two_dimensional = (t4_options & 0b1) != 0; // bit 0: 2D coding
    let byte_aligned = (t4_options & 0b100) != 0; // bit 2: EncodedByteAlign
    let (encoding, end_of_line) = match compression {
        4 => (EncodingMode::Group4, false),
        3 if two_dimensional => (EncodingMode::Group3_2D { k: u32::MAX }, true),
        // Compression 2 (Modified Huffman) and 3 (Group 3, 1D).
        _ => (EncodingMode::Group3_1D, false),
    };

    let settings = DecodeSettings {
        columns: width,
        rows: height,
        end_of_block: true,
        end_of_line,
        rows_are_byte_aligned: byte_aligned,
        encoding,
        invert_black: false,
    };

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
    let mut ctx = DecoderContext::new(settings);
    let mut collector = Collector {
        pixels: Vec::with_capacity(expected),
        width,
        cur_x: 0,
        white_value: white_pel_value,
        black_value: black_pel_value,
    };
    decode(&compressed, &mut collector, &mut ctx)
        .map_err(|e| JsValue::from_str(&format!("CCITT decode failed: {:?}", e)))?;

    let mut pixels = collector.pixels;
    pixels.resize(expected, white_pel_value);

    let (min, max) = compute_stats_u8(&pixels);

    Ok(TiffResult {
        width,
        height,
        channels: 1,
        bits_per_sample: 8,
        sample_format: 1,
        compression,
        predictor,
        photometric_interpretation,
        planar_configuration,
        data: pixels,
        min_value: min as f64,
        max_value: max as f64,
    })
}

// SIMD-optimized conversion functions

/// Convert f32 slice to little-endian bytes using SIMD
#[inline]
fn convert_f32_to_bytes_simd(data: &[f32]) -> Vec<u8> {
    use wide::*;
    
    let mut bytes = Vec::with_capacity(data.len() * 4);
    
    // Process 4 f32s at a time (128-bit SIMD)
    let chunks = data.chunks_exact(4);
    let remainder = chunks.remainder();
    
    for chunk in chunks {
        // Load 4 f32 values into SIMD register
        let simd = f32x4::new([chunk[0], chunk[1], chunk[2], chunk[3]]);
        
        // Convert each to bytes and append
        let arr = simd.to_array();
        for val in arr {
            bytes.extend_from_slice(&val.to_le_bytes());
        }
    }
    
    // Handle remaining values (0-3) with scalar code
    for &val in remainder {
        bytes.extend_from_slice(&val.to_le_bytes());
    }
    
    bytes
}

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

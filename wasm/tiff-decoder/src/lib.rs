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

    // Get color type and bits per sample
    let color_type = decoder.colortype()
        .map_err(|e| JsValue::from_str(&format!("Failed to get color type: {}", e)))?;

    let channels = match color_type {
        tiff::ColorType::Gray(_) => 1,
        tiff::ColorType::GrayA(_) => 2,
        tiff::ColorType::RGB(_) => 3,
        tiff::ColorType::RGBA(_) => 4,
        tiff::ColorType::CMYK(_) => 4,
        _ => 1,
    };

    // Try to get bits per sample
    let bits_per_sample = match &color_type {
        tiff::ColorType::Gray(bits) => *bits as u32,
        tiff::ColorType::GrayA(bits) => *bits as u32,
        tiff::ColorType::RGB(bits) => *bits as u32,
        tiff::ColorType::RGBA(bits) => *bits as u32,
        tiff::ColorType::CMYK(bits) => *bits as u32,
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

    let decode_start = js_sys::Date::now();
    
    // Read image data
    let decode_result = decoder.read_image()
        .map_err(|e| JsValue::from_str(&format!("Failed to decode image: {}", e)))?;

    // Determine sample format and convert data to bytes
    let (data_bytes, sample_format, min_val, max_val) = match decode_result {
        DecodingResult::U8(data) => {
            let (min, max) = compute_stats_u8(&data);
            (data, 1u32, min as f64, max as f64)
        }
        DecodingResult::U16(data) => {
            let (min, max) = compute_stats_u16(&data);
            let bytes: Vec<u8> = data.iter()
                .flat_map(|&v| v.to_le_bytes())
                .collect();
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
            // Pre-allocate for better performance
            let mut bytes = Vec::with_capacity(data.len() * 4);
            for &val in &data {
                bytes.extend_from_slice(&val.to_le_bytes());
            }
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
    
    let total_time = js_sys::Date::now() - start_time;
    let actual_decode_time = js_sys::Date::now() - decode_start;
    web_sys::console::log_1(&format!("[Rust] Total time: {:.2}ms (metadata: {:.2}ms, decode+convert: {:.2}ms)", 
        total_time, total_time - actual_decode_time, actual_decode_time).into());
    
    result
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

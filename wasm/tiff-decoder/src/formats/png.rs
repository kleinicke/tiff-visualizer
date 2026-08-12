use crate::PngResult;
use std::io::Cursor;
use wasm_bindgen::JsValue;

pub(crate) fn decode_png16_impl(data: &[u8]) -> Result<PngResult, JsValue> {
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

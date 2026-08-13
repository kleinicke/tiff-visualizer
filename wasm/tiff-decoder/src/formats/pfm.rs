//! Portable Float Map (PFM) decoder.
//!
//! Bit-exact port of `PfmProcessor._parsePfm` in
//! `media/modules/pfm-processor.ts`. Preserves the same header-line reading
//! quirks (leading empty-line skipping, `#` comment skipping before the
//! dimensions/scale lines, trailing space/tab trimming) and the same
//! top-down vertical-flip semantics.

use crate::DecodedArray;
use wasm_bindgen::JsValue;

/// Read one line the same way the TS `readLine` closure does: skip leading
/// CR/LF, read up to the next CR/LF, trim trailing space/tab, `.trim()` the
/// result, then skip trailing CR/LF.
fn read_line(bytes: &[u8], offset: &mut usize) -> String {
    while *offset < bytes.len() && (bytes[*offset] == 10 || bytes[*offset] == 13) {
        *offset += 1;
    }
    let start = *offset;
    while *offset < bytes.len() && bytes[*offset] != 10 && bytes[*offset] != 13 {
        *offset += 1;
    }
    let mut end = *offset;
    while end > start && (bytes[end - 1] == 32 || bytes[end - 1] == 9) {
        end -= 1;
    }
    let line: String = bytes[start..end].iter().map(|&b| b as char).collect();
    let trimmed = line.trim().to_string();
    while *offset < bytes.len() && (bytes[*offset] == 10 || bytes[*offset] == 13) {
        *offset += 1;
    }
    trimmed
}

/// Loose `parseInt(str, 10)` equivalent: optional sign, then a run of ASCII
/// digits; stops at (rather than rejecting on) the first non-digit. Returns
/// `None` when there are no digits at all (JS `NaN`).
fn parse_int_js(s: &str) -> Option<i64> {
    let bytes = s.as_bytes();
    let mut i = 0;
    let n = bytes.len();
    while i < n && (bytes[i] == b' ' || bytes[i] == b'\t' || bytes[i] == b'\n' || bytes[i] == b'\r') {
        i += 1;
    }
    let mut sign: i64 = 1;
    if i < n && (bytes[i] == b'+' || bytes[i] == b'-') {
        if bytes[i] == b'-' { sign = -1; }
        i += 1;
    }
    let digits_start = i;
    while i < n && bytes[i].is_ascii_digit() { i += 1; }
    if i == digits_start { return None; }
    s[digits_start..i].parse::<i64>().ok().map(|v| v * sign)
}

/// Loose `parseFloat` equivalent: parses the longest valid float prefix
/// (optional sign, digits, optional fractional part, optional exponent) and
/// ignores anything after it. Returns `f64::NAN` if no valid prefix exists.
fn parse_float_js(s: &str) -> f64 {
    let s = s.trim_start();
    let bytes = s.as_bytes();
    let n = bytes.len();
    let mut i = 0;
    if i < n && (bytes[i] == b'+' || bytes[i] == b'-') { i += 1; }
    let int_start = i;
    while i < n && bytes[i].is_ascii_digit() { i += 1; }
    let mut has_digits = i > int_start;
    let mut mant_end = i;
    if i < n && bytes[i] == b'.' {
        let frac_start = i + 1;
        let mut j = frac_start;
        while j < n && bytes[j].is_ascii_digit() { j += 1; }
        if j > frac_start { has_digits = true; }
        mant_end = j;
        i = j;
    }
    if !has_digits { return f64::NAN; }
    let mut end = mant_end;
    if i < n && (bytes[i] == b'e' || bytes[i] == b'E') {
        let mut j = i + 1;
        if j < n && (bytes[j] == b'+' || bytes[j] == b'-') { j += 1; }
        let exp_digits_start = j;
        while j < n && bytes[j].is_ascii_digit() { j += 1; }
        if j > exp_digits_start { end = j; }
    }
    s[..end].parse::<f64>().unwrap_or(f64::NAN)
}

fn read_f32(bytes: &[u8], byte_offset: usize, little_endian: bool) -> Result<f32, JsValue> {
    let slice = bytes.get(byte_offset..byte_offset + 4)
        .ok_or_else(|| JsValue::from_str("PFM: unexpected end of data while reading samples"))?;
    let arr: [u8; 4] = slice.try_into().unwrap();
    Ok(if little_endian { f32::from_le_bytes(arr) } else { f32::from_be_bytes(arr) })
}

pub(crate) fn decode_pfm_impl(data: &[u8], top_down: bool) -> Result<DecodedArray, JsValue> {
    let mut offset = 0usize;

    let mut magic = read_line(data, &mut offset);
    // Mirrors the TS `while (type === '') { type = readLine(); }` loop, but
    // bounded: once the offset stops advancing there is nothing left to read
    // (the TS version would spin forever on a file that is empty or only
    // whitespace — a pre-existing quirk we don't need to reproduce as a hang).
    while magic.is_empty() {
        let before = offset;
        magic = read_line(data, &mut offset);
        if magic.is_empty() && offset == before {
            return Err(JsValue::from_str("Invalid PFM magic"));
        }
    }
    if magic != "PF" && magic != "Pf" {
        return Err(JsValue::from_str("Invalid PFM magic"));
    }

    let mut dims_line = read_line(data, &mut offset);
    while dims_line.starts_with('#') || dims_line.is_empty() {
        let before = offset;
        dims_line = read_line(data, &mut offset);
        if dims_line.is_empty() && offset == before { break; }
    }
    let dims: Vec<&str> = dims_line.split_whitespace().collect();
    let width = dims.get(0).and_then(|s| parse_int_js(s))
        .ok_or_else(|| JsValue::from_str("Invalid PFM dimensions"))?;
    let height = dims.get(1).and_then(|s| parse_int_js(s))
        .ok_or_else(|| JsValue::from_str("Invalid PFM dimensions"))?;
    if width <= 0 || height <= 0 {
        return Err(JsValue::from_str("Invalid PFM dimensions"));
    }
    let width = width as usize;
    let height = height as usize;

    let mut scale_line = read_line(data, &mut offset);
    while scale_line.starts_with('#') || scale_line.is_empty() {
        let before = offset;
        scale_line = read_line(data, &mut offset);
        if scale_line.is_empty() && offset == before { break; }
    }
    let scale = parse_float_js(&scale_line);
    let little_endian = scale < 0.0;

    let channels: usize = if magic == "PF" { 3 } else { 1 };
    let values_per_row = width * channels;
    let pixels = width * height;
    let mut out = vec![0f32; pixels * channels];

    if top_down {
        for y in 0..height {
            let src_row = height - 1 - y;
            let mut src_byte = offset + src_row * values_per_row * 4;
            let dst_start = y * values_per_row;
            for x in 0..values_per_row {
                out[dst_start + x] = read_f32(data, src_byte, little_endian)?;
                src_byte += 4;
            }
        }
    } else {
        for i in 0..out.len() {
            out[i] = read_f32(data, offset + i * 4, little_endian)?;
        }
    }

    Ok(DecodedArray {
            taken: false,
        width: width as u32,
        height: height as u32,
        channels: channels as u32,
        bits_per_sample: 32,
        sample_format: 3,
        type_min: 0.0,
        type_max: 1.0,
        source_numeric_type: "float32".to_string(),
        sample_kind: 0,
        format_label: String::new(),
        metadata_json: "{}".to_string(),
        data_f32: out,
        data_u8: Vec::new(),
        data_u16: Vec::new(),
    })
}

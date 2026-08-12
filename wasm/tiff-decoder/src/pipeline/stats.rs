/// Convert u16 slice to little-endian bytes using SIMD
#[inline]
pub(crate) fn convert_u16_to_bytes_simd(data: &[u16]) -> Vec<u8> {
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

pub(crate) fn compute_stats_u8(data: &[u8]) -> (u8, u8) {
    let mut min = u8::MAX;
    let mut max = u8::MIN;
    for &v in data {
        min = min.min(v);
        max = max.max(v);
    }
    (min, max)
}

pub(crate) fn compute_stats_u16(data: &[u16]) -> (u16, u16) {
    let mut min = u16::MAX;
    let mut max = u16::MIN;
    for &v in data {
        min = min.min(v);
        max = max.max(v);
    }
    (min, max)
}

pub(crate) fn compute_stats_u32(data: &[u32]) -> (u32, u32) {
    let mut min = u32::MAX;
    let mut max = u32::MIN;
    for &v in data {
        min = min.min(v);
        max = max.max(v);
    }
    (min, max)
}

pub(crate) fn compute_stats_u64(data: &[u64]) -> (u64, u64) {
    let mut min = u64::MAX;
    let mut max = u64::MIN;
    for &v in data {
        min = min.min(v);
        max = max.max(v);
    }
    (min, max)
}

pub(crate) fn compute_stats_i8(data: &[i8]) -> (i8, i8) {
    let mut min = i8::MAX;
    let mut max = i8::MIN;
    for &v in data {
        min = min.min(v);
        max = max.max(v);
    }
    (min, max)
}

pub(crate) fn compute_stats_i16(data: &[i16]) -> (i16, i16) {
    let mut min = i16::MAX;
    let mut max = i16::MIN;
    for &v in data {
        min = min.min(v);
        max = max.max(v);
    }
    (min, max)
}

pub(crate) fn compute_stats_i32(data: &[i32]) -> (i32, i32) {
    let mut min = i32::MAX;
    let mut max = i32::MIN;
    for &v in data {
        min = min.min(v);
        max = max.max(v);
    }
    (min, max)
}

pub(crate) fn compute_stats_i64(data: &[i64]) -> (i64, i64) {
    let mut min = i64::MAX;
    let mut max = i64::MIN;
    for &v in data {
        min = min.min(v);
        max = max.max(v);
    }
    (min, max)
}

pub(crate) fn compute_stats_f32(data: &[f32]) -> (f64, f64) {
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

pub(crate) fn compute_stats_f64(data: &[f64]) -> (f64, f64) {
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

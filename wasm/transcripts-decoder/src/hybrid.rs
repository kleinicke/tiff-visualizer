//! Parquet's RLE / bit-packed hybrid encoding (definition levels, dictionary indices, booleans).

use crate::Error;

/// Decode exactly `count` values of `width` bits into `out`; returns the bytes consumed.
pub fn decode(data: &[u8], width: u32, count: usize, out: &mut Vec<u32>) -> Result<usize, Error> {
    if width > 32 { return Err(Error::Unsupported); }
    out.reserve(count);
    let target = out.len() + count;
    let value_bytes = width.div_ceil(8) as usize;
    let mut pos = 0usize;
    while out.len() < target {
        // Run header: a varint whose low bit says bit-packed (1) or repeated (0).
        let mut header = 0u64;
        let mut shift = 0;
        loop {
            let byte = *data.get(pos).ok_or(Error::Malformed)?;
            pos += 1;
            header |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 { break; }
            shift += 7;
            if shift > 63 { return Err(Error::Malformed); }
        }
        if header & 1 == 0 {
            let run = (header >> 1) as usize;
            let mut value = 0u32;
            for index in 0..value_bytes { value |= u32::from(*data.get(pos + index).ok_or(Error::Malformed)?) << (8 * index); }
            pos += value_bytes;
            let take = run.min(target - out.len());
            out.resize(out.len() + take, value);
        } else {
            let groups = (header >> 1) as usize;
            let values = groups * 8;
            let bytes = groups * width as usize;
            let take = values.min(target - out.len());
            // Some writers leave off the padding of the final group.
            let needed = (take * width as usize).div_ceil(8);
            let packed = data.get(pos..pos + needed).ok_or(Error::Malformed)?;
            pos = (pos + bytes).min(data.len());
            unpack(packed, width, take, out);
        }
    }
    Ok(pos)
}

/// Unpack `count` values of `width` bits, least significant bit first.
fn unpack(packed: &[u8], width: u32, count: usize, out: &mut Vec<u32>) {
    if width == 0 {
        out.resize(out.len() + count, 0);
        return;
    }
    let mask = if width == 32 { u64::from(u32::MAX) } else { (1u64 << width) - 1 };
    let mut buffer = 0u64;
    let mut bits = 0u32;
    let mut at = 0usize;
    for _ in 0..count {
        while bits < width {
            buffer |= u64::from(packed[at]) << bits;
            at += 1;
            bits += 8;
        }
        out.push((buffer & mask) as u32);
        buffer >>= width;
        bits -= width;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_and_packed_runs() {
        // 5 x value 3 (width 2), then one packed group of 8 values 0..=3,0..=3 (width 2)
        let data = [0x0a, 0x03, 0x03, 0xe4, 0xe4];
        let mut out = Vec::new();
        let used = decode(&data, 2, 13, &mut out).unwrap();
        assert_eq!(used, data.len());
        assert_eq!(out, vec![3, 3, 3, 3, 3, 0, 1, 2, 3, 0, 1, 2, 3]);
    }

    #[test]
    fn final_group_without_padding() {
        // 3 values of width 2 in a group of 8 whose padding bytes were left off: one byte, not two.
        let mut out = Vec::new();
        decode(&[0x03, 0b00_10_01_00], 2, 3, &mut out).unwrap();
        assert_eq!(out, vec![0, 1, 2]);
    }

    #[test]
    fn width_zero_and_wide_values() {
        let mut out = Vec::new();
        decode(&[0x06, 0x00 /* no value bytes at width 0 */], 0, 3, &mut out).unwrap();
        assert_eq!(out, vec![0, 0, 0]);
        let mut out = Vec::new();
        // packed group, width 12: values 1..=8
        let mut bits = 0u128;
        for (index, value) in (1u128..=8).enumerate() { bits |= value << (12 * index); }
        let mut data = vec![0x03];
        data.extend_from_slice(&bits.to_le_bytes()[..12]);
        decode(&data, 12, 8, &mut out).unwrap();
        assert_eq!(out, (1..=8).collect::<Vec<u32>>());
    }

    #[test]
    fn truncated_input_is_an_error() {
        let mut out = Vec::new();
        assert!(decode(&[0x03, 0xff], 12, 8, &mut out).is_err());
    }
}

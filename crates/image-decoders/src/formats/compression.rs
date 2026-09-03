//! Small byte-in/byte-out codecs shared by more than one container.

use crate::DecodeError;

/// Decode TIFF-flavoured LZW into exactly the byte count the container's
/// geometry declares. CZI compression 2 uses the same MSB-first stream and
/// TIFF code-width transition as TIFF compression 5.
#[cfg(any(feature = "tiff", feature = "czi"))]
pub(crate) fn decode_tiff_lzw(
    block: &[u8],
    expected_len: usize,
    context: &str,
) -> Result<Vec<u8>, DecodeError> {
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
                    break;
                }
                return Err(DecodeError::new(&format!(
                    "{}: LZW decode stalled before end of input",
                    context
                )));
            }
            Err(e) => {
                return Err(DecodeError::new(&format!(
                    "{}: LZW decode failed: {}",
                    context, e
                )))
            }
        }
    }
    if out_pos < expected_len {
        return Err(DecodeError::new(&format!(
            "{}: LZW stream produced {} bytes, expected {}",
            context, out_pos, expected_len
        )));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::decode_tiff_lzw;

    #[test]
    fn shared_lzw_round_trips_across_code_width_changes() {
        let input: Vec<u8> = (0..4096)
            .map(|i| ((i * 37 + i / 11) & 0xff) as u8)
            .collect();
        let encoded = weezl::encode::Encoder::with_tiff_size_switch(weezl::BitOrder::Msb, 8)
            .encode(&input)
            .expect("encode fixture");
        assert_eq!(
            decode_tiff_lzw(&encoded, input.len(), "shared LZW fixture").unwrap(),
            input
        );
    }
}

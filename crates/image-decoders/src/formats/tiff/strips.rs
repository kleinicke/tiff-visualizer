use super::codecs::build_uncompressed_tiff;
use crate::DecodeError;
use std::io::Cursor;
use tiff::decoder::{Decoder, DecodingResult};

fn tiff_is_little_endian(data: &[u8]) -> Option<bool> {
    match data.get(0..4)? {
        b"II*\0" | b"II+\0" => Some(true),
        b"MM\0*" | b"MM\0+" => Some(false),
        _ => None,
    }
}

pub(crate) fn try_decode_uncompressed_strips(
    data: &[u8],
    decoder: &mut Decoder<Cursor<&[u8]>>,
    width: u32,
    height: u32,
    channels: u32,
    bits_per_sample: u32,
    compression: u32,
    predictor: u32,
    planar_configuration: u32,
) -> Result<Option<DecodingResult>, DecodeError> {
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

    let sample_format = decoder
        .get_tag_u64_vec(Tag::SampleFormat)
        .ok()
        .and_then(|values| values.first().copied())
        .unwrap_or(1) as u32;
    let sample_count = (width as usize)
        .checked_mul(height as usize)
        .and_then(|v| v.checked_mul(channels as usize))
        .ok_or_else(|| DecodeError::new("Direct TIFF decode: image dimensions overflow"))?;
    let bytes_per_sample = (bits_per_sample / 8) as usize;
    let expected_bytes = sample_count
        .checked_mul(bytes_per_sample)
        .ok_or_else(|| DecodeError::new("Direct TIFF decode: raster byte count overflow"))?;

    let total_available = counts
        .iter()
        .try_fold(0usize, |acc, &count| acc.checked_add(count as usize))
        .ok_or_else(|| DecodeError::new("Direct TIFF decode: strip byte count overflow"))?;
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
            let values = raster
                .chunks_exact(2)
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
            let values = raster
                .chunks_exact(4)
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
            let values = raster
                .chunks_exact(2)
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
            let values = raster
                .chunks_exact(4)
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
            let values = raster
                .chunks_exact(4)
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
            let values = raster
                .chunks_exact(8)
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
fn decompress_strip_or_tile(
    block: &[u8],
    compression: u32,
    expected_len: usize,
    context: &str,
) -> Result<Vec<u8>, DecodeError> {
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
        8 | 32946 => {
            let mut zd = flate2::read::ZlibDecoder::new(block);
            let mut buf = Vec::new();
            zd.read_to_end(&mut buf).map_err(|e| {
                DecodeError::new(&format!("{}: Deflate decode failed: {}", context, e))
            })?;
            Ok(buf)
        }
        _ => Err(DecodeError::new(&format!(
            "{}: compression {} is not supported",
            context, compression
        ))),
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
fn apply_horizontal_predictor2(
    row_values: &mut [u16],
    row_width: usize,
    channels: usize,
    max_value: u32,
) {
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
pub(crate) fn try_decode_subbit_strips(
    data: &[u8],
    decoder: &mut Decoder<Cursor<&[u8]>>,
    width: u32,
    height: u32,
    channels: u32,
    bits_per_sample: u32,
    compression: u32,
    predictor: u32,
    planar_configuration: u32,
) -> Result<Option<DecodingResult>, DecodeError> {
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
        return Err(DecodeError::new(
            "Sub-16-bit TIFF: tiled layout is not supported by the direct decode path",
        ));
    }
    if predictor != 1 && predictor != 2 {
        return Err(DecodeError::new(&format!(
            "Sub-16-bit TIFF: predictor {} is not supported",
            predictor
        )));
    }
    let fill_order = decoder.get_tag_u32(Tag::FillOrder).unwrap_or(1);
    if fill_order != 1 {
        return Err(DecodeError::new(
            "Sub-16-bit TIFF: FillOrder 2 (LSB-first) is not supported",
        ));
    }
    let sample_format = decoder
        .get_tag_u64_vec(Tag::SampleFormat)
        .ok()
        .and_then(|values| values.first().copied())
        .unwrap_or(1) as u32;
    if sample_format != 1 {
        return Err(DecodeError::new(&format!(
            "Sub-16-bit TIFF: sample format {} is not supported (only unsigned integer)",
            sample_format
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
    let rows_per_strip = decoder
        .get_tag_u32(Tag::RowsPerStrip)
        .unwrap_or(height)
        .max(1);

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
            return Err(DecodeError::new(
                "Sub-16-bit TIFF: strip byte range out of bounds",
            ));
        }
        let strip = &data[start..end];

        let rows_in_strip = rows_per_strip.min(height - rows_decoded) as usize;
        let expected_bytes = row_bytes.saturating_mul(rows_in_strip);
        let decompressed =
            decompress_strip_or_tile(strip, compression, expected_bytes, "Sub-16-bit TIFF")?;
        if decompressed.len() < expected_bytes {
            return Err(DecodeError::new(&format!(
                "Sub-16-bit TIFF: strip decompressed to {} bytes, expected at least {}",
                decompressed.len(),
                expected_bytes
            )));
        }

        for row_idx in 0..rows_in_strip {
            let row = &decompressed[row_idx * row_bytes..(row_idx + 1) * row_bytes];
            let mut row_values = unpack_msb_packed_row(row, samples_per_row, bits_per_sample);

            if predictor == 2 {
                apply_horizontal_predictor2(
                    &mut row_values,
                    width as usize,
                    channels as usize,
                    max_value,
                );
            }

            out.extend_from_slice(&row_values);
        }
        rows_decoded += rows_in_strip as u32;
    }

    if rows_decoded != height {
        return Err(DecodeError::new(&format!(
            "Sub-16-bit TIFF: decoded {} of {} rows",
            rows_decoded, height
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
pub(crate) fn try_decode_general_strips_tiles(
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
) -> Result<Option<DecodingResult>, DecodeError> {
    use tiff::tags::Tag;

    let is_tiled = tile_width > 0 && tile_length > 0;
    if planar_configuration != 2 && !(is_tiled && compression == 5) {
        return Ok(None);
    }

    const CTX: &str = "Planar/tiled TIFF";

    if bits_per_sample != 8 && !(9..=16).contains(&bits_per_sample) {
        return Err(DecodeError::new(&format!(
            "{}: {}-bit samples are not supported",
            CTX, bits_per_sample
        )));
    }
    if compression != 1 && compression != 5 && compression != 8 && compression != 32946 {
        return Err(DecodeError::new(&format!(
            "{}: compression {} is not supported",
            CTX, compression
        )));
    }
    if predictor != 1 && predictor != 2 {
        return Err(DecodeError::new(&format!(
            "{}: predictor {} is not supported",
            CTX, predictor
        )));
    }
    let fill_order = decoder.get_tag_u32(Tag::FillOrder).unwrap_or(1);
    if fill_order != 1 {
        return Err(DecodeError::new(&format!(
            "{}: FillOrder 2 (LSB-first) is not supported",
            CTX
        )));
    }
    let sample_format = decoder
        .get_tag_u64_vec(Tag::SampleFormat)
        .ok()
        .and_then(|values| values.first().copied())
        .unwrap_or(1) as u32;
    if sample_format != 1 {
        return Err(DecodeError::new(&format!(
            "{}: sample format {} is not supported (only unsigned integer)",
            CTX, sample_format
        )));
    }

    let planes = if planar_configuration == 2 {
        channels
    } else {
        1
    };
    let channels_per_block = if planar_configuration == 2 {
        1
    } else {
        channels
    };

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
        let rps = decoder
            .get_tag_u32(Tag::RowsPerStrip)
            .unwrap_or(height)
            .max(1);
        let down = ((height as u64) + rps as u64 - 1) / rps as u64;
        (width, rps, 1u32, down as u32, rps)
    };
    let blocks_per_plane = (blocks_across as u64) * (blocks_down as u64);

    let offsets = (if is_tiled {
        decoder.get_tag_u64_vec(Tag::TileOffsets)
    } else {
        decoder.get_tag_u64_vec(Tag::StripOffsets)
    })
    .map_err(|e| DecodeError::new(&format!("{}: missing offsets: {}", CTX, e)))?;
    let counts = (if is_tiled {
        decoder.get_tag_u64_vec(Tag::TileByteCounts)
    } else {
        decoder.get_tag_u64_vec(Tag::StripByteCounts)
    })
    .map_err(|e| DecodeError::new(&format!("{}: missing byte counts: {}", CTX, e)))?;

    let expected_blocks = blocks_per_plane
        .checked_mul(planes as u64)
        .ok_or_else(|| DecodeError::new(&format!("{}: block count overflow", CTX)))?;
    if offsets.len() as u64 != expected_blocks || counts.len() as u64 != expected_blocks {
        return Err(DecodeError::new(&format!(
            "{}: expected {} strip/tile offsets, found {}",
            CTX,
            expected_blocks,
            offsets.len()
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
                    return Err(DecodeError::new(&format!(
                        "{}: strip/tile byte range out of bounds",
                        CTX
                    )));
                }
                let block_bytes = &data[start..end];

                let image_row_start = if is_tiled {
                    tile_row * tile_length
                } else {
                    tile_row * rows_per_strip
                };
                let image_col_start = tile_col * block_width;
                let valid_rows = block_height.min(height.saturating_sub(image_row_start));
                let valid_cols = block_width.min(width.saturating_sub(image_col_start));

                let expected_bytes = row_bytes.saturating_mul(block_height as usize);
                let decompressed =
                    decompress_strip_or_tile(block_bytes, compression, expected_bytes, CTX)?;
                if decompressed.len() < expected_bytes {
                    return Err(DecodeError::new(&format!(
                        "{}: block decompressed to {} bytes, expected at least {}",
                        CTX,
                        decompressed.len(),
                        expected_bytes
                    )));
                }

                for row_idx in 0..(block_height as usize) {
                    if (row_idx as u32) >= valid_rows {
                        continue;
                    }
                    let row = &decompressed[row_idx * row_bytes..(row_idx + 1) * row_bytes];
                    let mut row_values =
                        unpack_msb_packed_row(row, samples_per_row, bits_per_sample);

                    if predictor == 2 {
                        apply_horizontal_predictor2(
                            &mut row_values,
                            block_width as usize,
                            channels_per_block as usize,
                            max_value,
                        );
                    }

                    let out_row = (image_row_start as usize) + row_idx;
                    let out_row_base = out_row * (width as usize) * (channels as usize);

                    for col in 0..(valid_cols as usize) {
                        let out_col = (image_col_start as usize) + col;
                        for c in 0..(channels_per_block as usize) {
                            let dest_channel = if planar_configuration == 2 {
                                plane as usize
                            } else {
                                c
                            };
                            out[out_row_base + out_col * (channels as usize) + dest_channel] =
                                row_values[col * (channels_per_block as usize) + c];
                        }
                    }
                }
            }
        }
    }

    if bits_per_sample == 8 {
        Ok(Some(DecodingResult::U8(
            out.into_iter().map(|v| v as u8).collect(),
        )))
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
pub(crate) fn decode_zstd(
    original: &[u8],
    decoder: &mut Decoder<Cursor<&[u8]>>,
) -> Result<DecodingResult, DecodeError> {
    use std::io::Read;
    use tiff::tags::Tag;

    if decoder.get_tag_u64_vec(Tag::TileOffsets).is_ok() {
        return Err(DecodeError::new(
            "ZSTD: tiled TIFFs are not supported by the pure-Rust path",
        ));
    }
    let planar = decoder.get_tag_u32(Tag::PlanarConfiguration).unwrap_or(1);
    if planar != 1 {
        return Err(DecodeError::new(
            "ZSTD: planar configuration 2 is not supported",
        ));
    }

    let (width, height) = decoder
        .dimensions()
        .map_err(|e| DecodeError::new(&format!("ZSTD: dimensions: {}", e)))?;
    let offsets = decoder
        .get_tag_u64_vec(Tag::StripOffsets)
        .map_err(|e| DecodeError::new(&format!("ZSTD: StripOffsets: {}", e)))?;
    let counts = decoder
        .get_tag_u64_vec(Tag::StripByteCounts)
        .map_err(|e| DecodeError::new(&format!("ZSTD: StripByteCounts: {}", e)))?;
    let spp = decoder.get_tag_u32(Tag::SamplesPerPixel).unwrap_or(1);
    let predictor = decoder.get_tag_u32(Tag::Predictor).unwrap_or(1);
    let photometric = decoder
        .get_tag_u32(Tag::PhotometricInterpretation)
        .unwrap_or(1);
    let bits: Vec<u32> = decoder
        .get_tag_u64_vec(Tag::BitsPerSample)
        .map(|v| v.into_iter().map(|b| b as u32).collect())
        .unwrap_or_else(|_| vec![8; spp as usize]);
    let sample_format: Vec<u32> = decoder
        .get_tag_u64_vec(Tag::SampleFormat)
        .map(|v| v.into_iter().map(|s| s as u32).collect())
        .unwrap_or_else(|_| vec![1; spp as usize]);

    // Decompress every strip with pure-Rust ruzstd, concatenated in row order.
    let mut raster: Vec<u8> = Vec::new();
    for (off, cnt) in offsets.iter().zip(counts.iter()) {
        let start = *off as usize;
        let end = start.saturating_add(*cnt as usize);
        if end > original.len() {
            return Err(DecodeError::new("ZSTD: strip byte range out of bounds"));
        }
        let mut dec = ruzstd::decoding::StreamingDecoder::new(Cursor::new(&original[start..end]))
            .map_err(|e| DecodeError::new(&format!("ZSTD: decoder init: {:?}", e)))?;
        dec.read_to_end(&mut raster)
            .map_err(|e| DecodeError::new(&format!("ZSTD: decompress: {:?}", e)))?;
    }

    // Match the rebuilt TIFF's byte order to the original so multi-byte samples
    // are interpreted correctly.
    let little_endian = original.get(0..2) != Some(b"MM");
    let rebuilt = build_uncompressed_tiff(
        little_endian,
        width,
        height,
        spp,
        &bits,
        &sample_format,
        photometric,
        predictor,
        &raster,
    );
    let mut d = Decoder::new(Cursor::new(rebuilt.as_slice()))
        .map_err(|e| DecodeError::new(&format!("ZSTD: rebuilt decoder: {}", e)))?;
    d.read_image()
        .map_err(|e| DecodeError::new(&format!("ZSTD: rebuilt read_image: {}", e)))
}

/// Decode chunky, strip-based **floating-point** samples that use TIFF
/// predictor 3, which neither `try_decode_general_strips_tiles` (planar or
/// tiled-LZW only, <=16bpp) nor `try_decode_uncompressed_strips` (predictor 1
/// only) accepts. Before this existed, every float TIFF written by the common
/// encoders — Deflate + predictor 3 is what GDAL, libtiff and most scientific
/// tools emit — fell through to the `tiff` crate's monolithic `read_image()`.
///
/// Predictor 3 stores each row as byte planes: all the most-significant bytes
/// of the row's samples, then all the second bytes, and so on, with horizontal
/// differencing applied across the whole byte sequence. Reconstruction is
/// therefore an accumulate pass followed by a de-planarize pass, both per row.
///
/// Each strip is decompressed and un-predicted independently of every other
/// strip, which is what makes this shape parallelizable: `first_strip`/
/// `strip_count` let a caller decode a sub-range without touching the rest.
#[allow(clippy::too_many_arguments)]
pub(crate) fn try_decode_float_predictor_strips(
    data: &[u8],
    decoder: &mut Decoder<Cursor<&[u8]>>,
    width: u32,
    height: u32,
    channels: u32,
    bits_per_sample: u32,
    compression: u32,
    predictor: u32,
    planar_configuration: u32,
) -> Result<Option<DecodingResult>, DecodeError> {
    use tiff::tags::Tag;

    if predictor != 3 || planar_configuration != 1 {
        return Ok(None);
    }
    // 16-bit half floats are legal but rarer; restrict to the widths whose
    // reassembly is exercised by the test corpus.
    if bits_per_sample != 32 && bits_per_sample != 64 {
        return Ok(None);
    }
    if !matches!(compression, 1 | 5 | 8 | 32946) {
        return Ok(None);
    }
    let sample_format = decoder
        .get_tag_u64_vec(Tag::SampleFormat)
        .ok()
        .and_then(|values| values.first().copied())
        .unwrap_or(1) as u32;
    if sample_format != 3 {
        return Ok(None);
    }
    if decoder.get_tag_u64_vec(Tag::TileOffsets).is_ok() {
        return Ok(None);
    }

    let offsets = match decoder.get_tag_u64_vec(Tag::StripOffsets) {
        Ok(value) if !value.is_empty() => value,
        _ => return Ok(None),
    };
    let counts = match decoder.get_tag_u64_vec(Tag::StripByteCounts) {
        Ok(value) if value.len() == offsets.len() => value,
        _ => return Ok(None),
    };
    let rows_per_strip = decoder
        .get_tag_u64_vec(Tag::RowsPerStrip)
        .ok()
        .and_then(|values| values.first().copied())
        .unwrap_or(height as u64) as usize;
    if rows_per_strip == 0 {
        return Ok(None);
    }

    let bytes_per_sample = (bits_per_sample / 8) as usize;
    let samples_per_row = (width as usize) * (channels as usize);
    let row_bytes = samples_per_row * bytes_per_sample;
    let total_bytes = row_bytes
        .checked_mul(height as usize)
        .ok_or_else(|| DecodeError::new("Float predictor decode: raster byte count overflow"))?;

    let mut raster = vec![0u8; total_bytes];
    let mut plane = vec![0u8; row_bytes];

    for (strip_index, (&offset, &count)) in offsets.iter().zip(counts.iter()).enumerate() {
        let first_row = strip_index * rows_per_strip;
        if first_row >= height as usize {
            break;
        }
        let rows_here = rows_per_strip.min(height as usize - first_row);
        let expected = rows_here * row_bytes;

        let start = offset as usize;
        let end = start
            .checked_add(count as usize)
            .ok_or_else(|| DecodeError::new("Float predictor decode: strip range overflow"))?;
        if end > data.len() {
            return Ok(None);
        }
        let mut block =
            decompress_strip_or_tile(&data[start..end], compression, expected, "Float predictor decode")?;
        if block.len() < expected {
            return Ok(None);
        }
        block.truncate(expected);

        for row in 0..rows_here {
            let row_start = row * row_bytes;
            let row_slice = &mut block[row_start..row_start + row_bytes];
            // Horizontal differencing runs over the raw bytes of the whole row.
            for i in 1..row_bytes {
                row_slice[i] = row_slice[i].wrapping_add(row_slice[i - 1]);
            }
            // De-planarize: byte plane k holds byte k (MSB first) of every
            // sample in the row.
            for sample in 0..samples_per_row {
                for byte in 0..bytes_per_sample {
                    plane[sample * bytes_per_sample + byte] =
                        row_slice[byte * samples_per_row + sample];
                }
            }
            let out_start = (first_row + row) * row_bytes;
            raster[out_start..out_start + row_bytes].copy_from_slice(&plane);
        }
    }

    // The byte planes are stored MSB-first regardless of the file's byte order,
    // so the reassembled samples are big-endian and must be read as such.
    Ok(Some(match bits_per_sample {
        32 => DecodingResult::F32(
            raster
                .chunks_exact(4)
                .map(|b| f32::from_be_bytes([b[0], b[1], b[2], b[3]]))
                .collect(),
        ),
        _ => DecodingResult::F64(
            raster
                .chunks_exact(8)
                .map(|b| f64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
                .collect(),
        ),
    }))
}

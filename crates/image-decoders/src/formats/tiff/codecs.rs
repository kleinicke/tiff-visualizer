use super::orientation::TiffOrientation;
use super::tags::{extract_all_tags_json, extract_ome_xml, extract_page_tags_json};
use super::{finalize_decode_bytes, patch_photometric_to_grayscale};
use crate::pipeline::stats::compute_stats_u8;
use crate::DecodeError;
use crate::TiffResult;
use std::io::Cursor;
use tiff::decoder::{Decoder, DecodingResult};

/// Build a minimal single-strip, uncompressed classic TIFF wrapping `raster`,
/// preserving the tags the decoder needs (incl. the predictor, which the tiff
/// crate then un-applies). `raster` must be the full image in row order.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_uncompressed_tiff(
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
    let short_val = |v: u32| {
        let b = u16b(v as u16);
        [b[0], b[1], 0, 0]
    };
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
        for &b in bits {
            ext.extend_from_slice(&u16b(b as u16));
        }
        u32b(off)
    };
    let sf_field = if spp <= 2 {
        pack_inline(sample_format)
    } else {
        let off = after_ifd + ext.len() as u32;
        for &s in sample_format {
            ext.extend_from_slice(&u16b(s as u16));
        }
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
    put(&mut buf, 256, 4, 1, long_val(width)); // ImageWidth
    put(&mut buf, 257, 4, 1, long_val(height)); // ImageLength
    put(&mut buf, 258, 3, spp, bits_field); // BitsPerSample
    put(&mut buf, 259, 3, 1, short_val(1)); // Compression = none
    put(&mut buf, 262, 3, 1, short_val(photometric)); // PhotometricInterpretation
    put(&mut buf, 273, 4, 1, long_val(data_off)); // StripOffsets
    put(&mut buf, 277, 3, 1, short_val(spp)); // SamplesPerPixel
    put(&mut buf, 278, 4, 1, long_val(height)); // RowsPerStrip
    put(&mut buf, 279, 4, 1, long_val(raster.len() as u32)); // StripByteCounts
    put(&mut buf, 284, 3, 1, short_val(1)); // PlanarConfiguration = chunky
    put(&mut buf, 317, 3, 1, short_val(predictor)); // Predictor
    put(&mut buf, 339, 3, spp, sf_field); // SampleFormat

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
            let t = if t.ends_with(&[0xFF, 0xD9]) {
                &t[..t.len() - 2]
            } else {
                t
            };
            let s = if strip.starts_with(&[0xFF, 0xD8]) {
                &strip[2..]
            } else {
                strip
            };
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
pub(crate) fn decode_jpeg_ycbcr(
    data: &[u8],
    decoder: &mut Decoder<Cursor<&[u8]>>,
    width: u32,
    height: u32,
    orientation: TiffOrientation,
) -> Result<TiffResult, DecodeError> {
    use tiff::tags::Tag;
    use zune_jpeg::JpegDecoder;

    if decoder.get_tag_u64_vec(Tag::TileOffsets).is_ok() {
        return Err(DecodeError::new(
            "JPEG: tiled YCbCr JPEG is not supported by the direct path",
        ));
    }
    let offsets = decoder
        .get_tag_u64_vec(Tag::StripOffsets)
        .map_err(|e| DecodeError::new(&format!("JPEG: StripOffsets: {}", e)))?;
    let counts = decoder
        .get_tag_u64_vec(Tag::StripByteCounts)
        .map_err(|e| DecodeError::new(&format!("JPEG: StripByteCounts: {}", e)))?;
    // JPEGTables (tag 347): optional abbreviated table stream shared by strips.
    let tables: Option<Vec<u8>> = decoder.get_tag_u8_vec(Tag::Unknown(347)).ok();

    let mut rgb: Vec<u8> = Vec::with_capacity((width as usize).saturating_mul(height as usize) * 3);
    let mut channels = 3u32;
    for (off, cnt) in offsets.iter().zip(counts.iter()) {
        let start = *off as usize;
        let end = start.saturating_add(*cnt as usize);
        if end > data.len() {
            return Err(DecodeError::new("JPEG: strip byte range out of bounds"));
        }
        let jpeg = build_jpeg(tables.as_deref(), &data[start..end]);
        let mut jd = JpegDecoder::new(Cursor::new(jpeg));
        let px = jd
            .decode()
            .map_err(|e| DecodeError::new(&format!("JPEG decode failed: {:?}", e)))?;
        let info = jd
            .info()
            .ok_or_else(|| DecodeError::new("JPEG: missing image info"))?;
        let pixels = (info.width as usize).saturating_mul(info.height as usize);
        if pixels == 0 {
            return Err(DecodeError::new("JPEG: empty strip"));
        }
        channels = (px.len() / pixels) as u32;
        rgb.extend_from_slice(&px);
    }
    if channels != 1 && channels != 3 {
        return Err(DecodeError::new("JPEG: unexpected channel count"));
    }

    // Data is now decoded RGB (or grayscale), never CMYK, so
    // `finalize_decode_bytes`'s CMYK step is a no-op here and only the
    // Orientation transform actually does anything.
    let photometric_interpretation = if channels == 3 { 2 } else { 1 };
    let (rgb, width, height, channels) = finalize_decode_bytes(
        rgb,
        width,
        height,
        channels,
        photometric_interpretation,
        orientation,
    );

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
pub(crate) fn unpack_bilevel(data: &[u8], width: u32, height: u32, photometric: u32) -> Vec<u8> {
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

/// Decode a palette (RGBPalette) TIFF by reading the raw indices and expanding
/// them through the ColorMap tag into interleaved 8-bit RGB.
pub(crate) fn decode_palette(
    data: &[u8],
    width: u32,
    height: u32,
    page_index: u32,
) -> Result<TiffResult, DecodeError> {
    use tiff::tags::Tag;

    // ColorMap (tag 320): 3 * 2^bits 16-bit entries, laid out as all reds, then
    // all greens, then all blues.
    let cmap = {
        let mut d = Decoder::new(Cursor::new(data))
            .map_err(|e| DecodeError::new(&format!("Palette: decoder init: {}", e)))?;
        for _ in 0..page_index {
            d.next_image()
                .map_err(|e| DecodeError::new(&format!("Palette: page select: {}", e)))?;
        }
        d.get_tag_u16_vec(Tag::Unknown(320))
            .map_err(|e| DecodeError::new(&format!("Palette: missing ColorMap: {}", e)))?
    };
    if cmap.is_empty() || cmap.len() % 3 != 0 {
        return Err(DecodeError::new("Palette: invalid ColorMap length"));
    }
    let n_colors = cmap.len() / 3;

    // Patch the photometric tag so the tiff crate decodes the indices for us,
    // reusing all of its compression / predictor / strip handling.
    let mut patched = data.to_vec();
    if !patch_photometric_to_grayscale(&mut patched, page_index) {
        return Err(DecodeError::new("Palette: could not patch photometric tag"));
    }

    let mut d = Decoder::new(Cursor::new(patched.as_slice()))
        .map_err(|e| DecodeError::new(&format!("Palette: patched decoder init: {}", e)))?;
    for _ in 0..page_index {
        d.next_image()
            .map_err(|e| DecodeError::new(&format!("Palette: patched page select: {}", e)))?;
    }
    let compression = d.get_tag_u32(Tag::Compression).unwrap_or(1);
    let predictor = d.get_tag_u32(Tag::Predictor).unwrap_or(1);
    let planar = d.get_tag_u32(Tag::PlanarConfiguration).unwrap_or(1);
    let rows_per_strip = d.get_tag_u32(Tag::RowsPerStrip).unwrap_or(height);
    let strip_byte_counts = d.get_tag_u64_vec(Tag::StripByteCounts).unwrap_or_default();
    let tile_width = d.get_tag_u32(Tag::TileWidth).unwrap_or(0);
    let tile_length = d.get_tag_u32(Tag::TileLength).unwrap_or(0);
    let tile_count = d
        .get_tag_u64_vec(Tag::TileByteCounts)
        .map(|counts| counts.len() as u32)
        .unwrap_or(0);
    // Orientation tag (274): the early-return palette path bypasses
    // `decode_tiff_impl`'s own Orientation-tag read (it returns before that
    // point), so read it here off the same patched decoder and finalize
    // through `finalize_decode_bytes` below like every other path.
    let orientation = TiffOrientation::from_tag(d.get_tag_u32(Tag::Orientation).unwrap_or(1));

    let indices: Vec<usize> = match d
        .read_image()
        .map_err(|e| DecodeError::new(&format!("Palette: index decode failed: {}", e)))?
    {
        DecodingResult::U8(v) => v.iter().map(|&x| x as usize).collect(),
        DecodingResult::U16(v) => v.iter().map(|&x| x as usize).collect(),
        _ => return Err(DecodeError::new("Palette: unexpected index sample type")),
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
    let (rgb, width, height, channels) =
        finalize_decode_bytes(rgb, width, height, 3, 2, orientation);

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
pub(crate) fn decode_ccitt(
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
) -> Result<TiffResult, DecodeError> {
    use hayro_ccitt::{
        decode, DecodeSettings, Decoder as CcittDecoder, DecoderContext, EncodingMode,
    };

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
    let white_pel_value: u8 = if photometric_interpretation == 0 {
        255
    } else {
        0
    };
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
                self.pixels.push(if white {
                    self.white_value
                } else {
                    self.black_value
                });
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
    let rps = if rows_per_strip == 0 {
        height
    } else {
        rows_per_strip
    };
    for (i, (off, cnt)) in offsets.iter().zip(counts.iter()).enumerate() {
        let start = *off as usize;
        let end = start.saturating_add(*cnt as usize);
        if end > data.len() {
            return Err(DecodeError::new("CCITT: strip byte range out of bounds"));
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
            .map_err(|e| DecodeError::new(&format!("CCITT strip {} decode failed: {:?}", i, e)))?;
    }

    let mut pixels = collector.pixels;
    pixels.resize(expected, white_pel_value);

    // CCITT data is always bilevel grayscale (photometric_interpretation is 0
    // or 1 here, never 5), so `finalize_decode_bytes`'s CMYK step is a no-op
    // and only the Orientation transform actually does anything.
    let (pixels, width, height, channels) = finalize_decode_bytes(
        pixels,
        width,
        height,
        1,
        photometric_interpretation,
        orientation,
    );

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

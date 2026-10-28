//! Reads one flat column chunk (all the pages of a column in a row group) into a Vec.
//!
//! Supported: UNCOMPRESSED or ZSTD pages, data page v1 and v2, no nulls;
//! PLAIN, dictionary (PLAIN_DICTIONARY / RLE_DICTIONARY), RLE (booleans) and
//! BYTE_STREAM_SPLIT (floats) values. Anything else is `Error::Unsupported`,
//! and the caller falls back to a general Parquet reader.

use crate::{hybrid, thrift, zstd, Error};

pub const BOOLEAN: u32 = 0;
pub const FLOAT: u32 = 4;
pub const DOUBLE: u32 = 5;
pub const BYTE_ARRAY: u32 = 6;

const UNCOMPRESSED: u32 = 0;
const ZSTD: u32 = 6;

const ENCODING_PLAIN: i64 = 0;
const ENCODING_PLAIN_DICTIONARY: i64 = 2;
const ENCODING_RLE: i64 = 3;
const ENCODING_RLE_DICTIONARY: i64 = 8;
const ENCODING_BYTE_STREAM_SPLIT: i64 = 9;

#[derive(Clone, Copy)]
pub struct Chunk<'a> {
    pub data: &'a [u8],
    /// Parquet CompressionCodec: 0 uncompressed, 6 zstd.
    pub codec: u32,
    /// Parquet physical Type: 0 boolean, 4 float, 5 double, 6 byte array.
    pub kind: u32,
    /// Rows (values) in the chunk.
    pub count: usize,
    /// Maximum definition level: 0 for a required column, 1 for an optional one.
    pub max_def: u32,
}

struct Header {
    page_type: i64,
    uncompressed: usize,
    compressed: usize,
    count: usize,
    encoding: i64,
    def_len: usize,
    rep_len: usize,
    nulls: usize,
    is_compressed: bool,
}

fn int_field(reader: &mut thrift::Reader, kind: u8) -> Result<i64, Error> {
    if thrift::is_i32(kind) { reader.int() } else { Err(Error::Malformed) }
}

fn read_header(data: &[u8], pos: &mut usize) -> Result<Header, Error> {
    let mut reader = thrift::Reader { data, pos: *pos };
    let mut header = Header { page_type: -1, uncompressed: 0, compressed: 0, count: 0, encoding: -1, def_len: 0, rep_len: 0, nulls: 0, is_compressed: true };
    let mut last = 0;
    while let Some((id, kind)) = reader.field(&mut last)? {
        match id {
            1 => header.page_type = int_field(&mut reader, kind)?,
            2 => header.uncompressed = int_field(&mut reader, kind)? as usize,
            3 => header.compressed = int_field(&mut reader, kind)? as usize,
            // DataPageHeader (5) and DictionaryPageHeader (7): 1 = num_values, 2 = encoding.
            5 | 7 if thrift::is_struct(kind) => {
                let mut inner = 0;
                while let Some((id, kind)) = reader.field(&mut inner)? {
                    match id {
                        1 => header.count = int_field(&mut reader, kind)? as usize,
                        2 => header.encoding = int_field(&mut reader, kind)?,
                        _ => reader.skip(kind)?,
                    }
                }
            }
            // DataPageHeaderV2.
            8 if thrift::is_struct(kind) => {
                let mut inner = 0;
                while let Some((id, kind)) = reader.field(&mut inner)? {
                    match id {
                        1 => header.count = int_field(&mut reader, kind)? as usize,
                        2 => header.nulls = int_field(&mut reader, kind)? as usize,
                        4 => header.encoding = int_field(&mut reader, kind)?,
                        5 => header.def_len = int_field(&mut reader, kind)? as usize,
                        6 => header.rep_len = int_field(&mut reader, kind)? as usize,
                        7 => header.is_compressed = thrift::is_true(kind),
                        _ => reader.skip(kind)?,
                    }
                }
            }
            _ => reader.skip(kind)?,
        }
    }
    *pos = reader.pos;
    Ok(header)
}

struct Page<'a> {
    dictionary: bool,
    encoding: i64,
    count: usize,
    values: &'a [u8],
}

fn inflate<'s>(codec: u32, source: &[u8], size: usize, scratch: &'s mut Vec<u8>) -> Result<&'s [u8], Error> {
    match codec {
        ZSTD => {
            scratch.clear();
            scratch.resize(size, 0);
            let written = zstd::decompress(source, scratch).map_err(|_| Error::Zstd)?;
            if written != size { return Err(Error::Zstd); }
            Ok(&scratch[..])
        }
        _ => Err(Error::Unsupported),
    }
}

/// Call `visit` with each page's values (levels already checked and removed).
fn pages(chunk: &Chunk, mut visit: impl FnMut(Page) -> Result<(), Error>) -> Result<(), Error> {
    if chunk.codec != UNCOMPRESSED && chunk.codec != ZSTD { return Err(Error::Unsupported); }
    if chunk.max_def > 1 { return Err(Error::Unsupported); }
    let mut pos = 0usize;
    let mut rows = 0usize;
    let mut scratch: Vec<u8> = Vec::new();
    let mut levels: Vec<u32> = Vec::new();
    while pos < chunk.data.len() && rows < chunk.count {
        let header = read_header(chunk.data, &mut pos)?;
        let body = chunk.data.get(pos..pos + header.compressed).ok_or(Error::Malformed)?;
        pos += header.compressed;
        let values: &[u8] = match header.page_type {
            // Dictionary page, data page v1
            2 | 0 => {
                let page: &[u8] = if chunk.codec == ZSTD { inflate(ZSTD, body, header.uncompressed, &mut scratch)? } else { body };
                if header.page_type == 0 && chunk.max_def > 0 {
                    let length = u32::from_le_bytes(page.get(0..4).ok_or(Error::Malformed)?.try_into().unwrap()) as usize;
                    let encoded = page.get(4..4 + length).ok_or(Error::Malformed)?;
                    levels.clear();
                    hybrid::decode(encoded, 1, header.count, &mut levels)?;
                    if levels.iter().any(|&level| level != 1) { return Err(Error::Nulls); }
                    &page[4 + length..]
                } else { page }
            }
            // Data page v2: levels come first, uncompressed.
            3 => {
                let skip = header.rep_len + header.def_len;
                if header.nulls != 0 { return Err(Error::Nulls); }
                let payload = body.get(skip..).ok_or(Error::Malformed)?;
                if header.is_compressed && chunk.codec == ZSTD {
                    let size = header.uncompressed.checked_sub(skip).ok_or(Error::Malformed)?;
                    inflate(ZSTD, payload, size, &mut scratch)?
                } else { payload }
            }
            1 => continue,
            _ => return Err(Error::Unsupported),
        };
        let dictionary = header.page_type == 2;
        visit(Page { dictionary, encoding: header.encoding, count: header.count, values })?;
        if !dictionary { rows += header.count; }
    }
    if rows != chunk.count { return Err(Error::Malformed); }
    Ok(())
}

fn extend_floats(out: &mut Vec<f32>, kind: u32, values: &[u8], count: usize) -> Result<(), Error> {
    match kind {
        FLOAT => {
            let bytes = values.get(..count * 4).ok_or(Error::Malformed)?;
            #[cfg(target_endian = "little")]
            {
                let at = out.len();
                out.reserve(count);
                // SAFETY: capacity for `count` more f32s was reserved, and every bit pattern is a valid f32.
                unsafe {
                    std::ptr::copy_nonoverlapping(bytes.as_ptr(), out.as_mut_ptr().add(at).cast::<u8>(), count * 4);
                    out.set_len(at + count);
                }
            }
            #[cfg(not(target_endian = "little"))]
            out.extend(bytes.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())));
        }
        DOUBLE => {
            let bytes = values.get(..count * 8).ok_or(Error::Malformed)?;
            out.extend((0..count).map(|i| f64::from_le_bytes(bytes[i * 8..i * 8 + 8].try_into().unwrap()) as f32));
        }
        _ => return Err(Error::Unsupported),
    }
    Ok(())
}

fn split_floats(out: &mut Vec<f32>, kind: u32, values: &[u8], count: usize) -> Result<(), Error> {
    match kind {
        FLOAT => {
            let bytes = values.get(..count * 4).ok_or(Error::Malformed)?;
            out.extend((0..count).map(|i| f32::from_le_bytes([bytes[i], bytes[count + i], bytes[2 * count + i], bytes[3 * count + i]])));
        }
        DOUBLE => {
            let bytes = values.get(..count * 8).ok_or(Error::Malformed)?;
            out.extend((0..count).map(|i| {
                let mut b = [0u8; 8];
                for (k, slot) in b.iter_mut().enumerate() { *slot = bytes[k * count + i]; }
                f64::from_le_bytes(b) as f32
            }));
        }
        _ => return Err(Error::Unsupported),
    }
    Ok(())
}

/// A float or double column, as f32.
pub fn read_floats(chunk: &Chunk) -> Result<Vec<f32>, Error> {
    if chunk.kind != FLOAT && chunk.kind != DOUBLE { return Err(Error::Unsupported); }
    let mut out: Vec<f32> = Vec::with_capacity(chunk.count);
    let mut dictionary: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    pages(chunk, |page| {
        if page.dictionary {
            dictionary.clear();
            return extend_floats(&mut dictionary, chunk.kind, page.values, page.count);
        }
        match page.encoding {
            ENCODING_PLAIN => extend_floats(&mut out, chunk.kind, page.values, page.count),
            ENCODING_BYTE_STREAM_SPLIT => split_floats(&mut out, chunk.kind, page.values, page.count),
            ENCODING_PLAIN_DICTIONARY | ENCODING_RLE_DICTIONARY => {
                let width = u32::from(*page.values.first().ok_or(Error::Malformed)?);
                indices.clear();
                hybrid::decode(&page.values[1..], width, page.count, &mut indices)?;
                for &index in &indices { out.push(*dictionary.get(index as usize).ok_or(Error::Malformed)?); }
                Ok(())
            }
            _ => Err(Error::Unsupported),
        }
    })?;
    Ok(out)
}

/// A boolean column, one byte (0 or 1) per row.
pub fn read_bools(chunk: &Chunk) -> Result<Vec<u8>, Error> {
    if chunk.kind != BOOLEAN { return Err(Error::Unsupported); }
    let mut out: Vec<u8> = Vec::with_capacity(chunk.count);
    let mut run: Vec<u32> = Vec::new();
    pages(chunk, |page| {
        if page.dictionary { return Err(Error::Unsupported); }
        match page.encoding {
            ENCODING_PLAIN => {
                let bytes = page.values.get(..page.count.div_ceil(8)).ok_or(Error::Malformed)?;
                out.extend((0..page.count).map(|row| (bytes[row >> 3] >> (row & 7)) & 1));
                Ok(())
            }
            ENCODING_RLE => {
                let length = u32::from_le_bytes(page.values.get(0..4).ok_or(Error::Malformed)?.try_into().unwrap()) as usize;
                let encoded = page.values.get(4..4 + length).ok_or(Error::Malformed)?;
                run.clear();
                hybrid::decode(encoded, 1, page.count, &mut run)?;
                out.extend(run.iter().map(|&value| value as u8));
                Ok(())
            }
            _ => Err(Error::Unsupported),
        }
    })?;
    Ok(out)
}

/// A byte-array (string) column, one id per row. `map` turns each distinct string into an id; for a
/// dictionary-encoded column it is called once per dictionary entry rather than once per row.
pub fn read_strings(chunk: &Chunk, map: &mut dyn FnMut(&[u8]) -> u32) -> Result<Vec<u32>, Error> {
    if chunk.kind != BYTE_ARRAY { return Err(Error::Unsupported); }
    let mut out: Vec<u32> = Vec::with_capacity(chunk.count);
    let mut ids: Vec<u32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    pages(chunk, |page| {
        let mut at = 0usize;
        let mut next = |values: &[u8]| -> Result<u32, Error> {
            let length = u32::from_le_bytes(values.get(at..at + 4).ok_or(Error::Malformed)?.try_into().unwrap()) as usize;
            let bytes = values.get(at + 4..at + 4 + length).ok_or(Error::Malformed)?;
            at += 4 + length;
            Ok(map(bytes))
        };
        if page.dictionary {
            ids.clear();
            for _ in 0..page.count { ids.push(next(page.values)?); }
            return Ok(());
        }
        match page.encoding {
            ENCODING_PLAIN => {
                for _ in 0..page.count { out.push(next(page.values)?); }
                Ok(())
            }
            ENCODING_PLAIN_DICTIONARY | ENCODING_RLE_DICTIONARY => {
                let width = u32::from(*page.values.first().ok_or(Error::Malformed)?);
                indices.clear();
                hybrid::decode(&page.values[1..], width, page.count, &mut indices)?;
                for &index in &indices { out.push(*ids.get(index as usize).ok_or(Error::Malformed)?); }
                Ok(())
            }
            _ => Err(Error::Unsupported),
        }
    })?;
    Ok(out)
}

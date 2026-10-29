//! Decodes the columns of a Xenium `transcripts.parquet` row group straight into typed arrays.
//!
//! The page reads zstd, dictionary indices and plain floats without building a JS value per
//! cell, which is what makes the generic route slow. The caller (JavaScript) reads the footer,
//! fetches each column chunk's bytes and hands them over with a small descriptor table:
//!
//!   per column, six u32s: [ptr, len, codec, physical type, row count, max definition level]
//!
//! `tx_scan` tells which genes a row group holds and how often; `tx_pack` returns the rows of
//! known genes (see `tx_set_genes`) as gene code, x, y and quality arrays. Both return 0 or an
//! error code; a non-zero code means "use the general reader for this row group".
//!
//! `mask_trace` is a second, unrelated entry: it traces a label mask (a cell segmentation saved as an image)
//! into polygons. See `mask.rs`.
//!
//! Plain C ABI, no imports: instantiate with `WebAssembly.instantiate(module, {})`.

mod column;
mod hybrid;
mod mask;
mod thrift;
mod zstd;

use column::Chunk;
use std::cell::RefCell;
use std::collections::HashMap;

const NONE: u32 = u32::MAX;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// A codec, encoding or type this decoder does not handle.
    Unsupported,
    /// The column has nulls.
    Nulls,
    /// The bytes do not parse.
    Malformed,
    /// A page failed to decompress.
    Zstd,
    /// `tx_set_genes` has not been called, or the columns disagree on the row count.
    Setup,
}

impl Error {
    fn code(self) -> i32 {
        match self { Error::Unsupported => 1, Error::Nulls => 2, Error::Malformed => 3, Error::Zstd => 4, Error::Setup => 5 }
    }
}

#[derive(Default)]
struct State {
    genes: HashMap<Vec<u8>, u32>,
    names: Vec<u8>,
    offsets: Vec<u32>,
    counts: Vec<u32>,
    wide: bool,
    gene16: Vec<u16>,
    gene32: Vec<u32>,
    x: Vec<f32>,
    y: Vec<f32>,
    q: Vec<u8>,
    col: Vec<u8>,
    col_ids: Vec<u32>,
    col_names: Vec<u8>,
    col_offsets: Vec<u32>,
}

thread_local! { static STATE: RefCell<State> = RefCell::new(State::default()); }

/// SAFETY: `table` points at `index + 1` descriptors of six u32s whose ranges are valid.
unsafe fn chunk<'a>(table: *const u32, index: usize) -> Chunk<'a> {
    let d = std::slice::from_raw_parts(table.add(index * 6), 6);
    let data: &[u8] = if d[1] == 0 { &[] } else { std::slice::from_raw_parts(d[0] as *const u8, d[1] as usize) };
    Chunk { data, codec: d[2], kind: d[3], count: d[4] as usize, max_def: d[5] }
}

fn code(result: Result<(), Error>) -> i32 { match result { Ok(()) => 0, Err(error) => error.code() } }

#[no_mangle]
pub extern "C" fn tx_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len.max(1));
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// # Safety
/// `pointer` and `len` must be those of a `tx_alloc` allocation.
#[no_mangle]
pub unsafe extern "C" fn tx_free(pointer: *mut u8, len: usize) { drop(Vec::from_raw_parts(pointer, 0, len.max(1))); }

/// The gene list the codes of `tx_pack` refer to: `count` names, name i being `blob[offsets[i]..offsets[i + 1]]`.
///
/// # Safety
/// `blob` must be valid for `blob_len` bytes and `offsets` for `count + 1` u32s.
#[no_mangle]
pub unsafe extern "C" fn tx_set_genes(blob: *const u8, blob_len: usize, offsets: *const u32, count: usize) -> i32 {
    let blob = std::slice::from_raw_parts(blob, blob_len);
    let offsets = std::slice::from_raw_parts(offsets, count + 1);
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        state.genes.clear();
        for index in 0..count {
            let (start, end) = (offsets[index] as usize, offsets[index + 1] as usize);
            if start > end || end > blob.len() { return Error::Malformed.code(); }
            state.genes.insert(blob[start..end].to_vec(), index as u32);
        }
        state.wide = count >= 65535;
        0
    })
}

/// Columns: 0 = feature_name, 1 = is_gene (a descriptor with len 0 means there is none).
///
/// # Safety
/// `table` must point at two descriptors whose ranges are valid.
#[no_mangle]
pub unsafe extern "C" fn tx_scan(table: *const u32) -> i32 {
    let feature = chunk(table, 0);
    let flags = chunk(table, 1);
    code(scan(&feature, if flags.data.is_empty() { None } else { Some(&flags) }))
}

fn scan(feature: &Chunk, flags: Option<&Chunk>) -> Result<(), Error> {
    let mut interner: HashMap<Vec<u8>, u32> = HashMap::new();
    let mut found: Vec<Vec<u8>> = Vec::new();
    let ids = column::read_strings(feature, &mut |bytes| {
        if let Some(&id) = interner.get(bytes) { return id; }
        let id = found.len() as u32;
        found.push(bytes.to_vec());
        interner.insert(bytes.to_vec(), id);
        id
    })?;
    let is_gene = match flags { Some(flags) => Some(column::read_bools(flags)?), None => None };
    if let Some(flags) = &is_gene { if flags.len() != ids.len() { return Err(Error::Setup); } }
    let mut counts = vec![0u32; found.len()];
    match &is_gene {
        Some(flags) => for (row, &id) in ids.iter().enumerate() { if flags[row] != 0 { counts[id as usize] += 1; } },
        None => for &id in &ids { counts[id as usize] += 1; },
    }
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        state.names.clear();
        state.offsets.clear();
        state.counts.clear();
        state.offsets.push(0);
        for (name, &count) in found.iter().zip(&counts) {
            if count == 0 { continue; }
            state.names.extend_from_slice(name);
            let end = state.names.len() as u32;
            state.offsets.push(end);
            state.counts.push(count);
        }
    });
    Ok(())
}

/// Columns: 0 = feature_name, 1 = x_location, 2 = y_location, 3 = qv.
///
/// # Safety
/// `table` must point at four descriptors whose ranges are valid.
#[no_mangle]
pub unsafe extern "C" fn tx_pack(table: *const u32) -> i32 {
    let (feature, x, y, q) = (chunk(table, 0), chunk(table, 1), chunk(table, 2), chunk(table, 3));
    code(pack(&feature, &x, &y, &q))
}

/// The quality value as the viewer stores it: rounded, clamped to 0-255, NaN as 0.
fn quality(value: f32) -> u8 {
    if value >= 255.0 { 255 } else if value > 0.0 { (f64::from(value) + 0.5).floor() as u8 } else { 0 }
}

fn pack(feature: &Chunk, x: &Chunk, y: &Chunk, q: &Chunk) -> Result<(), Error> {
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        if state.genes.is_empty() { return Err(Error::Setup); }
        let ids = { let genes = &state.genes; column::read_strings(feature, &mut |bytes| genes.get(bytes).copied().unwrap_or(NONE))? };
        let mut xs = column::read_floats(x)?;
        let mut ys = column::read_floats(y)?;
        let qs = column::read_floats(q)?;
        let rows = ids.len();
        if xs.len() != rows || ys.len() != rows || qs.len() != rows { return Err(Error::Setup); }
        let wide = state.wide;
        let mut gene16: Vec<u16> = Vec::new();
        let mut gene32: Vec<u32> = Vec::new();
        if wide { gene32.reserve(rows); } else { gene16.reserve(rows); }
        let mut quality8: Vec<u8> = Vec::with_capacity(rows);
        let mut kept = 0usize;
        for row in 0..rows {
            let id = ids[row];
            if id == NONE { continue; }
            if wide { gene32.push(id); } else { gene16.push(id as u16); }
            xs[kept] = xs[row];
            ys[kept] = ys[row];
            quality8.push(quality(qs[row]));
            kept += 1;
        }
        xs.truncate(kept);
        ys.truncate(kept);
        state.gene16 = gene16;
        state.gene32 = gene32;
        state.x = xs;
        state.y = ys;
        state.q = quality8;
        Ok(())
    })
}

fn with<T>(read: impl FnOnce(&State) -> T) -> T { STATE.with(|state| read(&state.borrow())) }

#[no_mangle] pub extern "C" fn tx_scan_count() -> usize { with(|s| s.counts.len()) }
#[no_mangle] pub extern "C" fn tx_scan_names_len() -> usize { with(|s| s.names.len()) }
#[no_mangle] pub extern "C" fn tx_scan_names_ptr() -> *const u8 { with(|s| s.names.as_ptr()) }
#[no_mangle] pub extern "C" fn tx_scan_offsets_ptr() -> *const u32 { with(|s| s.offsets.as_ptr()) }
#[no_mangle] pub extern "C" fn tx_scan_counts_ptr() -> *const u32 { with(|s| s.counts.as_ptr()) }

#[no_mangle] pub extern "C" fn tx_out_rows() -> usize { with(|s| s.x.len()) }
#[no_mangle] pub extern "C" fn tx_out_wide() -> u32 { with(|s| u32::from(s.wide)) }
#[no_mangle] pub extern "C" fn tx_out_gene_ptr() -> *const u8 { with(|s| if s.wide { s.gene32.as_ptr().cast() } else { s.gene16.as_ptr().cast() }) }
#[no_mangle] pub extern "C" fn tx_out_x_ptr() -> *const f32 { with(|s| s.x.as_ptr()) }
#[no_mangle] pub extern "C" fn tx_out_y_ptr() -> *const f32 { with(|s| s.y.as_ptr()) }
#[no_mangle] pub extern "C" fn tx_out_q_ptr() -> *const u8 { with(|s| s.q.as_ptr()) }

/// Concatenate the chunks of one numeric column (one per row group) into `col`; with `narrow`,
/// INT64 values are returned as INT32 (an error if one does not fit).
///
/// # Safety
/// `table` must point at `chunks` descriptors whose ranges are valid.
#[no_mangle]
pub unsafe extern "C" fn tx_col_fixed(table: *const u32, chunks: usize, narrow: u32) -> i32 {
    let mut out: Vec<u8> = Vec::new();
    let mut kind = 0;
    for index in 0..chunks {
        let piece = chunk(table, index);
        kind = piece.kind;
        if let Err(error) = column::read_fixed(&piece, &mut out) { return error.code(); }
    }
    if narrow != 0 && kind == column::INT64 {
        let mut narrowed = Vec::with_capacity(out.len() / 2);
        for row in 0..out.len() / 8 {
            let value = &out[row * 8..row * 8 + 8];
            let low = i32::from_le_bytes([value[0], value[1], value[2], value[3]]);
            let high = i32::from_le_bytes([value[4], value[5], value[6], value[7]]);
            if high != low >> 31 { return Error::Unsupported.code(); }
            narrowed.extend_from_slice(&low.to_le_bytes());
        }
        out = narrowed;
    }
    STATE.with(|state| state.borrow_mut().col = out);
    0
}

/// Concatenate the chunks of one string column into `col_ids` (an id per row) and the distinct
/// strings in first-seen order.
///
/// # Safety
/// `table` must point at `chunks` descriptors whose ranges are valid.
#[no_mangle]
pub unsafe extern "C" fn tx_col_strings(table: *const u32, chunks: usize) -> i32 {
    let mut interner: HashMap<Vec<u8>, u32> = HashMap::new();
    let mut names: Vec<u8> = Vec::new();
    let mut offsets: Vec<u32> = vec![0];
    let mut ids: Vec<u32> = Vec::new();
    for index in 0..chunks {
        let piece = chunk(table, index);
        let mut last: Option<(Vec<u8>, u32)> = None;
        let result = column::read_strings(&piece, &mut |bytes| {
            if let Some((previous, id)) = &last { if previous.as_slice() == bytes { return *id; } }
            let id = match interner.get(bytes) {
                Some(&id) => id,
                None => {
                    let id = (offsets.len() - 1) as u32;
                    names.extend_from_slice(bytes);
                    offsets.push(names.len() as u32);
                    interner.insert(bytes.to_vec(), id);
                    id
                }
            };
            last = Some((bytes.to_vec(), id));
            id
        });
        match result { Ok(part) => ids.extend_from_slice(&part), Err(error) => return error.code() }
    }
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        state.col_ids = ids;
        state.col_names = names;
        state.col_offsets = offsets;
    });
    0
}

#[no_mangle] pub extern "C" fn tx_col_len() -> usize { with(|s| s.col.len()) }
#[no_mangle] pub extern "C" fn tx_col_ptr() -> *const u8 { with(|s| s.col.as_ptr()) }
#[no_mangle] pub extern "C" fn tx_col_ids_len() -> usize { with(|s| s.col_ids.len()) }
#[no_mangle] pub extern "C" fn tx_col_ids_ptr() -> *const u32 { with(|s| s.col_ids.as_ptr()) }
#[no_mangle] pub extern "C" fn tx_col_names_count() -> usize { with(|s| s.col_offsets.len().saturating_sub(1)) }
#[no_mangle] pub extern "C" fn tx_col_names_len() -> usize { with(|s| s.col_names.len()) }
#[no_mangle] pub extern "C" fn tx_col_names_ptr() -> *const u8 { with(|s| s.col_names.as_ptr()) }
#[no_mangle] pub extern "C" fn tx_col_offsets_ptr() -> *const u32 { with(|s| s.col_offsets.as_ptr()) }

/// Release the column buffers (they can be large).
#[no_mangle]
pub extern "C" fn tx_col_clear() {
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        state.col = Vec::new();
        state.col_ids = Vec::new();
        state.col_names = Vec::new();
        state.col_offsets = Vec::new();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quality_matches_the_viewer() {
        assert_eq!(quality(300.0), 255);
        assert_eq!(quality(254.5), 255);
        assert_eq!(quality(10.4), 10);
        assert_eq!(quality(10.5), 11);
        assert_eq!(quality(-2.0), 0);
        assert_eq!(quality(f32::NAN), 0);
        assert_eq!(quality(0.49999997), 0);
    }
}

//! The one zstd decoder this module links in (see the features in Cargo.toml).

#[cfg(not(any(feature = "pure-zstd", feature = "c-zstd")))]
compile_error!("enable the `pure-zstd` or the `c-zstd` feature");

/// Decompress one zstd frame into `dst`, returning the number of bytes written.
#[cfg(feature = "c-zstd")]
pub fn decompress(src: &[u8], dst: &mut [u8]) -> Result<usize, ()> {
    // SAFETY: both slices are valid for the lengths given.
    let written = unsafe { zstd_sys::ZSTD_decompress(dst.as_mut_ptr().cast(), dst.len(), src.as_ptr().cast(), src.len()) };
    if unsafe { zstd_sys::ZSTD_isError(written) } != 0 { Err(()) } else { Ok(written) }
}

#[cfg(all(feature = "pure-zstd", not(feature = "c-zstd")))]
pub fn decompress(src: &[u8], dst: &mut [u8]) -> Result<usize, ()> {
    use ruzstd::decoding::FrameDecoder;
    use std::cell::RefCell;
    thread_local! { static DECODER: RefCell<FrameDecoder> = RefCell::new(FrameDecoder::new()); }
    DECODER.with(|decoder| decoder.borrow_mut().decode_all(src, dst).map_err(|_| ()))
}

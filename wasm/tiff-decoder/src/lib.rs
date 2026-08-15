mod decoder_bindings;
pub use decoder_bindings::*;

mod measure;
mod compositor;
mod pipeline {
    pub mod stats {
        pub use scientific_image_decoders::stats::*;
    }
}

pub use compositor::RgbaLayerCompositor;

use std::mem;
use wasm_bindgen::prelude::*;

/// Result of `compute_image_stats_f32/u8/u16`, ported from
/// `ImageStatsCalculator` in `media/modules/normalization-helper.ts`. Unlike
/// `DecodedArray`, this is small (7 numbers) so it uses plain getters —
/// no one-shot `take_*` contract needed.
#[wasm_bindgen]
pub struct ImageStats {
    min: f64,
    max: f64,
    mean: f64,
    std: f64,
    valid_count: f64,
    non_finite_count: f64,
    total_count: f64,
}

#[wasm_bindgen]
impl ImageStats {
    #[wasm_bindgen(getter)]
    pub fn min(&self) -> f64 { self.min }
    #[wasm_bindgen(getter)]
    pub fn max(&self) -> f64 { self.max }
    #[wasm_bindgen(getter)]
    pub fn mean(&self) -> f64 { self.mean }
    #[wasm_bindgen(getter)]
    pub fn std(&self) -> f64 { self.std }
    #[wasm_bindgen(getter)]
    pub fn valid_count(&self) -> f64 { self.valid_count }
    #[wasm_bindgen(getter)]
    pub fn non_finite_count(&self) -> f64 { self.non_finite_count }
    #[wasm_bindgen(getter)]
    pub fn total_count(&self) -> f64 { self.total_count }
}

impl From<pipeline::stats::RawImageStats> for ImageStats {
    fn from(r: pipeline::stats::RawImageStats) -> Self {
        ImageStats {
            min: r.min,
            max: r.max,
            mean: r.mean,
            std: r.std,
            valid_count: r.valid_count,
            non_finite_count: r.non_finite_count,
            total_count: r.total_count,
        }
    }
}

/// Min/max/mean/std/valid & non-finite counts over a float32 raster, ported
/// from `ImageStatsCalculator.calculateFloatStats` (`extended = false`) and
/// `.calculateExtendedStats` (`extended = true`) in
/// `media/modules/normalization-helper.ts`. `extended` only changes the
/// "no valid samples" min/max fallback (+/-Infinity vs NaN) — every other
/// field is always computed. See `pipeline::stats::compute_image_stats_f32_impl`
/// for the exact non-finite-handling semantics this must stay bit-identical
/// to (CLAUDE.md's `!Number.isFinite()` rule).
#[wasm_bindgen]
pub fn compute_image_stats_f32(data: &[f32], width: u32, height: u32, channels: u32, extended: bool) -> ImageStats {
    pipeline::stats::compute_image_stats_f32_impl(data, width, height, channels, extended).into()
}

/// Min/max/mean/std over a uint8 raster, ported from
/// `ImageStatsCalculator.calculateIntegerStats`. `rgb_as_24bit` packs the
/// first three channels into one 24-bit value (see
/// `pipeline::stats::compute_image_stats_uint_impl`); it only takes effect
/// when `channels >= 3`, matching the TS guard.
#[wasm_bindgen]
pub fn compute_image_stats_u8(data: &[u8], width: u32, height: u32, channels: u32, rgb_as_24bit: bool) -> ImageStats {
    pipeline::stats::compute_image_stats_uint_impl(data, width, height, channels, rgb_as_24bit).into()
}

/// Min/max/mean/std over a uint16 raster. See `compute_image_stats_u8`.
#[wasm_bindgen]
pub fn compute_image_stats_u16(data: &[u16], width: u32, height: u32, channels: u32, rgb_as_24bit: bool) -> ImageStats {
    pipeline::stats::compute_image_stats_uint_impl(data, width, height, channels, rgb_as_24bit).into()
}

/// Connected-component labelling result.
///
/// `take_labels_as_i32` follows the same one-shot convention as
/// `DecodedArray`: a full-resolution label image is large, so it is moved out
/// rather than copied, and a second call fails loudly instead of returning an
/// empty array.
#[wasm_bindgen]
pub struct LabelResult {
    labels: Vec<i32>,
    count: u32,
    width: u32,
    height: u32,
    taken: bool,
}

#[wasm_bindgen]
impl LabelResult {
    #[wasm_bindgen(getter)]
    pub fn count(&self) -> u32 { self.count }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 { self.width }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 { self.height }

    /// Moves the label image out. One-shot; see `DecodedArray::take_data_as_f32`.
    #[wasm_bindgen]
    pub fn take_labels_as_i32(&mut self) -> Result<Vec<i32>, JsValue> {
        if self.taken {
            return Err(JsValue::from_str(
                "LabelResult::take_labels_as_i32 called more than once. The labels are moved \
                 out on the first call, not copied. Take them once and reuse that array."
            ));
        }
        self.taken = true;
        Ok(mem::take(&mut self.labels))
    }
}

/// Labels connected runs of non-zero mask entries. `connectivity` is 4 or 8.
#[wasm_bindgen]
pub fn label_components_fast(
    mask: &[u8],
    width: u32,
    height: u32,
    connectivity: u32,
) -> Result<LabelResult, JsValue> {
    let w = width as usize;
    let h = height as usize;
    let expected = w.checked_mul(h)
        .ok_or_else(|| JsValue::from_str("Mask dimensions overflow"))?;
    if mask.len() < expected {
        return Err(JsValue::from_str(&format!(
            "Mask has {} entries but {}x{} needs {}", mask.len(), width, height, expected
        )));
    }
    let out = measure::components::label_components(mask, w, h, connectivity);
    Ok(LabelResult { labels: out.labels, count: out.count, width, height, taken: false })
}

// ---------------------------------------------------------------------------
// Thresholding (media/modules/measure/threshold.ts)
// ---------------------------------------------------------------------------

/// A 256-bin histogram of a scalar plane. Small enough that getters clone
/// rather than following the one-shot `take_*` convention used for
/// full-resolution rasters.
#[wasm_bindgen]
pub struct HistogramResult {
    counts: Vec<i32>,
    min: f64,
    max: f64,
    total: u32,
    non_finite_count: u32,
}

#[wasm_bindgen]
impl HistogramResult {
    #[wasm_bindgen(getter)]
    pub fn counts(&self) -> Vec<i32> { self.counts.clone() }
    #[wasm_bindgen(getter)]
    pub fn min(&self) -> f64 { self.min }
    #[wasm_bindgen(getter)]
    pub fn max(&self) -> f64 { self.max }
    #[wasm_bindgen(getter)]
    pub fn total(&self) -> u32 { self.total }
    #[wasm_bindgen(getter)]
    pub fn non_finite_count(&self) -> u32 { self.non_finite_count }
}

/// Build the 256-bin histogram of a scalar plane. `step` subsamples for
/// interactive use (pass 1 for the full plane).
#[wasm_bindgen]
pub fn build_histogram_fast(plane: &[f32], step: u32) -> HistogramResult {
    let h = measure::threshold::build_histogram(plane, step.max(1) as usize);
    HistogramResult { counts: h.counts, min: h.min, max: h.max, total: h.total, non_finite_count: h.non_finite_count }
}

fn counts_from_slice(counts: &[i32]) -> Result<[i32; measure::threshold::HISTOGRAM_BINS], JsValue> {
    if counts.len() != measure::threshold::HISTOGRAM_BINS {
        return Err(JsValue::from_str(&format!(
            "Histogram must have exactly {} bins, got {}", measure::threshold::HISTOGRAM_BINS, counts.len()
        )));
    }
    let mut out = [0i32; measure::threshold::HISTOGRAM_BINS];
    out.copy_from_slice(counts);
    Ok(out)
}

/// Apply one auto-threshold method to a 256-bin histogram. Returns a bin
/// index, or -1 on failure. Unknown method names fall back to Otsu.
#[wasm_bindgen]
pub fn auto_threshold_bin_fast(counts: &[i32], method: &str) -> Result<i32, JsValue> {
    let counts = counts_from_slice(counts)?;
    Ok(measure::threshold::auto_threshold_bin(&counts, method))
}

/// Binary mask from a global value window.
#[wasm_bindgen]
pub fn global_threshold_mask_fast(plane: &[f32], low: f64, high: f64) -> Vec<u8> {
    measure::threshold::global_threshold_mask(plane, low, high)
}

/// Per-pixel local threshold surface (Sauvola/Niblack/Phansalkar/mean/median).
/// `r` and `offset` use NaN to mean "use the method's default", matching the
/// TypeScript's optional `r?`/`offset?` fields.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn local_threshold_mask_fast(
    plane: &[f32],
    width: u32,
    height: u32,
    method: &str,
    radius: f64,
    k: f64,
    r: f64,
    offset: f64,
    dark_background: bool,
) -> Result<Vec<u8>, JsValue> {
    let w = width as usize;
    let h = height as usize;
    let expected = w.checked_mul(h).ok_or_else(|| JsValue::from_str("Plane dimensions overflow"))?;
    if plane.len() < expected {
        return Err(JsValue::from_str(&format!(
            "Plane has {} samples but {}x{} needs {}", plane.len(), width, height, expected
        )));
    }
    let options = measure::threshold::LocalThresholdOptions {
        method: method.to_string(),
        radius,
        k,
        r: if r.is_finite() { Some(r) } else { None },
        offset: if offset.is_finite() { Some(offset) } else { None },
        dark_background,
    };
    Ok(measure::threshold::local_threshold_mask(plane, w, h, &options))
}

/// Any global auto-threshold method applied per neighbourhood, bilinearly
/// interpolated between tiles. `min_contrast` uses NaN to mean "use the
/// method's default (0.25)".
#[wasm_bindgen]
pub fn local_auto_threshold_mask_fast(
    plane: &[f32],
    width: u32,
    height: u32,
    method: &str,
    radius: f64,
    dark_background: bool,
    min_contrast: f64,
) -> Result<Vec<u8>, JsValue> {
    let w = width as usize;
    let h = height as usize;
    let expected = w.checked_mul(h).ok_or_else(|| JsValue::from_str("Plane dimensions overflow"))?;
    if plane.len() < expected {
        return Err(JsValue::from_str(&format!(
            "Plane has {} samples but {}x{} needs {}", plane.len(), width, height, expected
        )));
    }
    let options = measure::threshold::LocalAutoThresholdOptions {
        method: method.to_string(),
        radius,
        dark_background,
        min_contrast: if min_contrast.is_finite() { Some(min_contrast) } else { None },
    };
    Ok(measure::threshold::local_auto_threshold_mask(plane, w, h, &options))
}

/// Object count / area-fraction as a function of threshold, for the stability
/// curve UI. Small result (default 64 points), so getters clone.
#[wasm_bindgen]
pub struct StabilityCurveResult {
    bins: Vec<i32>,
    values: Vec<f64>,
    object_counts: Vec<u32>,
    area_fractions: Vec<f64>,
    suggested_bin: i32,
    plateau_width: i32,
}

#[wasm_bindgen]
impl StabilityCurveResult {
    #[wasm_bindgen(getter)]
    pub fn bins(&self) -> Vec<i32> { self.bins.clone() }
    #[wasm_bindgen(getter)]
    pub fn values(&self) -> Vec<f64> { self.values.clone() }
    #[wasm_bindgen(getter)]
    pub fn object_counts(&self) -> Vec<u32> { self.object_counts.clone() }
    #[wasm_bindgen(getter)]
    pub fn area_fractions(&self) -> Vec<f64> { self.area_fractions.clone() }
    #[wasm_bindgen(getter)]
    pub fn suggested_bin(&self) -> i32 { self.suggested_bin }
    #[wasm_bindgen(getter)]
    pub fn plateau_width(&self) -> i32 { self.plateau_width }
}

#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn compute_stability_curve_fast(
    plane: &[f32],
    width: u32,
    height: u32,
    histogram_min: f64,
    histogram_max: f64,
    samples: u32,
    max_pixels: u32,
    dark_background: bool,
) -> Result<StabilityCurveResult, JsValue> {
    let w = width as usize;
    let h = height as usize;
    let expected = w.checked_mul(h).ok_or_else(|| JsValue::from_str("Plane dimensions overflow"))?;
    if plane.len() < expected {
        return Err(JsValue::from_str(&format!(
            "Plane has {} samples but {}x{} needs {}", plane.len(), width, height, expected
        )));
    }
    // Only min/max feed `compute_stability_curve` (via threshold_value_from_bin);
    // total/non_finite_count are unused by it, so a dummy histogram is fine.
    let histogram = measure::threshold::ScalarHistogram {
        counts: Vec::new(),
        min: histogram_min,
        max: histogram_max,
        total: 0,
        non_finite_count: 0,
    };
    let curve = measure::threshold::compute_stability_curve(
        plane, w, h, &histogram,
        samples.max(1) as usize,
        max_pixels.max(1) as usize,
        dark_background,
    );
    let mut bins = Vec::with_capacity(curve.points.len());
    let mut values = Vec::with_capacity(curve.points.len());
    let mut object_counts = Vec::with_capacity(curve.points.len());
    let mut area_fractions = Vec::with_capacity(curve.points.len());
    for p in &curve.points {
        bins.push(p.bin);
        values.push(p.value);
        object_counts.push(p.object_count);
        area_fractions.push(p.area_fraction);
    }
    Ok(StabilityCurveResult {
        bins, values, object_counts, area_fractions,
        suggested_bin: curve.suggested_bin,
        plateau_width: curve.plateau_width,
    })
}

/// Fills enclosed holes in a binary mask. Returns a mask of the same size.
#[wasm_bindgen]
pub fn fill_mask_holes_fast(mask: &[u8], width: u32, height: u32) -> Result<Vec<u8>, JsValue> {
    let (w, h) = (width as usize, height as usize);
    let expected = w.checked_mul(h).ok_or_else(|| JsValue::from_str("Mask dimensions overflow"))?;
    if mask.len() < expected {
        return Err(JsValue::from_str(&format!(
            "Mask has {} entries but {}x{} needs {}", mask.len(), width, height, expected)));
    }
    Ok(measure::morphology::fill_mask_holes(mask, w, h))
}

/// SQUARED Euclidean distance from each set pixel to the nearest background
/// pixel — the same convention the TypeScript used, so callers that compare
/// against a squared radius keep working unchanged.
#[wasm_bindgen]
pub fn distance_transform_fast(mask: &[u8], width: u32, height: u32) -> Result<Vec<f64>, JsValue> {
    let (w, h) = (width as usize, height as usize);
    let expected = w.checked_mul(h).ok_or_else(|| JsValue::from_str("Mask dimensions overflow"))?;
    if mask.len() < expected {
        return Err(JsValue::from_str(&format!(
            "Mask has {} entries but {}x{} needs {}", mask.len(), width, height, expected)));
    }
    Ok(measure::morphology::distance_transform(mask, w, h))
}

/// Separable Gaussian blur. Non-finite samples are skipped and the weights
/// renormalised, so a NaN neighbour is ignored rather than darkening the result.
#[wasm_bindgen]
pub fn gaussian_blur_fast(plane: &[f32], width: u32, height: u32, sigma: f64) -> Result<Vec<f32>, JsValue> {
    let (w, h) = (width as usize, height as usize);
    let expected = w.checked_mul(h).ok_or_else(|| JsValue::from_str("Plane dimensions overflow"))?;
    if plane.len() < expected {
        return Err(JsValue::from_str(&format!(
            "Plane has {} samples but {}x{} needs {}", plane.len(), width, height, expected)));
    }
    Ok(measure::filters::gaussian_blur(plane, w, h, sigma))
}

/// Background subtraction by morphological opening.
#[wasm_bindgen]
pub fn subtract_background_fast(
    plane: &[f32], width: u32, height: u32, radius: f64, light_background: bool,
) -> Result<Vec<f32>, JsValue> {
    let (w, h) = (width as usize, height as usize);
    let expected = w.checked_mul(h).ok_or_else(|| JsValue::from_str("Plane dimensions overflow"))?;
    if plane.len() < expected {
        return Err(JsValue::from_str(&format!(
            "Plane has {} samples but {}x{} needs {}", plane.len(), width, height, expected)));
    }
    Ok(measure::filters::subtract_background(plane, w, h, radius, light_background))
}

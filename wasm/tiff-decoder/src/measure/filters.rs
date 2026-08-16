//! Separable image filters used to pre-process a plane before thresholding.
//!
//! Ports of `gaussianBlur` and `subtractBackground` from
//! `media/modules/measure/segmentation.ts`. Both run over the whole image
//! before every threshold pass, so they sit directly in the interactive path.
//!
//! Non-finite samples are SKIPPED rather than propagated, and the weights are
//! renormalised by what was actually used. That is deliberate in the original
//! and preserved here: treating a NaN neighbour as zero would darken the
//! result instead of ignoring it, which matters for scientific images where
//! NaN marks "no measurement" rather than "black".

/// Gaussian blur, separated into a horizontal then a vertical pass.
///
/// Returns a copy when `sigma <= 0`, matching the TypeScript, so callers can
/// pass a disabled setting without branching.
pub(crate) fn gaussian_blur(plane: &[f32], width: usize, height: usize, sigma: f64) -> Vec<f32> {
    if !(sigma > 0.0) {
        return plane.to_vec();
    }
    let pixels = width.saturating_mul(height);
    if pixels == 0 || plane.len() < pixels {
        return plane.to_vec();
    }

    let radius = ((sigma * 3.0).ceil() as isize).max(1);
    let span = (radius * 2 + 1) as usize;
    let mut kernel = vec![0.0f64; span];
    let mut sum = 0.0f64;
    for i in -radius..=radius {
        let weight = (-((i * i) as f64) / (2.0 * sigma * sigma)).exp();
        kernel[(i + radius) as usize] = weight;
        sum += weight;
    }
    for k in kernel.iter_mut() {
        *k /= sum;
    }

    let mut horizontal = vec![0.0f32; pixels];
    for y in 0..height {
        for x in 0..width {
            let mut accumulated = 0.0f64;
            let mut weight_sum = 0.0f64;
            for k in -radius..=radius {
                let sx = (x as isize + k).clamp(0, width as isize - 1) as usize;
                let v = plane[y * width + sx];
                if !v.is_finite() {
                    continue;
                }
                let w = kernel[(k + radius) as usize];
                accumulated += v as f64 * w;
                weight_sum += w;
            }
            horizontal[y * width + x] = if weight_sum > 0.0 {
                (accumulated / weight_sum) as f32
            } else {
                f32::NAN
            };
        }
    }

    let mut out = vec![0.0f32; pixels];
    for y in 0..height {
        for x in 0..width {
            let mut accumulated = 0.0f64;
            let mut weight_sum = 0.0f64;
            for k in -radius..=radius {
                let sy = (y as isize + k).clamp(0, height as isize - 1) as usize;
                let v = horizontal[sy * width + x];
                if !v.is_finite() {
                    continue;
                }
                let w = kernel[(k + radius) as usize];
                accumulated += v as f64 * w;
                weight_sum += w;
            }
            out[y * width + x] = if weight_sum > 0.0 {
                (accumulated / weight_sum) as f32
            } else {
                f32::NAN
            };
        }
    }
    out
}

/// Sliding min (or max) over every window of size `2*radius+1`, in O(1)
/// amortised time per output regardless of radius.
///
/// van Herk / Gil-Werman: the input is cut into blocks the width of the
/// window, and a forward and backward running extremum is computed inside each
/// block. Any window of exactly that width straddles at most one block
/// boundary, so its extremum is `min(suffix[start], prefix[end])` — two
/// lookups instead of a `2r+1` scan. The naive version cost O(r) per pixel,
/// which dominated background subtraction at useful radii.
///
/// Non-finite samples are neutralised by substituting the operation's identity
/// (+inf for min, -inf for max) so they never win, exactly reproducing the
/// "skip non-finite" rule of the original. The same substitution pads the ends,
/// which makes the window shrink at the borders instead of wrapping — again
/// matching the original's clamped bounds.
fn sliding_extremum(input: &[f32], n: usize, radius: usize, minimum: bool) -> Vec<f32> {
    let identity = if minimum {
        f32::INFINITY
    } else {
        f32::NEG_INFINITY
    };
    let better = |a: f32, b: f32| -> f32 {
        if minimum {
            if b < a {
                b
            } else {
                a
            }
        } else if b > a {
            b
        } else {
            a
        }
    };
    if n == 0 {
        return Vec::new();
    }
    let k = radius * 2 + 1;
    // Pad by `radius` on both sides with the identity element.
    let padded_len = n + radius * 2;
    let mut padded = vec![identity; padded_len];
    for i in 0..n {
        let v = input[i];
        padded[i + radius] = if v.is_finite() { v } else { identity };
    }
    // Round the working length up to a whole number of blocks so the prefix and
    // suffix scans never run off the end.
    let blocks = padded_len.div_ceil(k);
    let working = blocks * k;

    let mut prefix = vec![identity; working];
    let mut suffix = vec![identity; working];
    let at = |i: usize| -> f32 {
        if i < padded_len {
            padded[i]
        } else {
            identity
        }
    };

    for b in 0..blocks {
        let start = b * k;
        let end = start + k;
        let mut running = identity;
        for i in start..end {
            running = better(running, at(i));
            prefix[i] = running;
        }
        running = identity;
        for i in (start..end).rev() {
            running = better(running, at(i));
            suffix[i] = running;
        }
    }

    let mut out = vec![0.0f32; n];
    for i in 0..n {
        // Output i corresponds to padded window [i, i + k - 1].
        let best = better(suffix[i], prefix[i + k - 1]);
        out[i] = if best.is_finite() { best } else { f32::NAN };
    }
    out
}

/// Separable min/max filter over a square window of `radius`.
///
/// Named "disc" in the original for its morphological role; the window is
/// actually square, and the port keeps that shape so results match.
fn disc_filter(
    plane: &[f32],
    width: usize,
    height: usize,
    radius: isize,
    minimum: bool,
) -> Vec<f32> {
    let pixels = width.saturating_mul(height);
    let r = radius.max(0) as usize;
    let mut horizontal = vec![0.0f32; pixels];

    let mut row = vec![0.0f32; width];
    for y in 0..height {
        row.copy_from_slice(&plane[y * width..y * width + width]);
        let filtered = sliding_extremum(&row, width, r, minimum);
        horizontal[y * width..y * width + width].copy_from_slice(&filtered);
    }

    let mut out = vec![0.0f32; pixels];
    let mut column = vec![0.0f32; height];
    for x in 0..width {
        for y in 0..height {
            column[y] = horizontal[y * width + x];
        }
        let filtered = sliding_extremum(&column, height, r, minimum);
        for y in 0..height {
            out[y * width + x] = filtered[y];
        }
    }
    out
}

/// The pre-optimisation O(r)-per-pixel filter, kept as a test oracle so the
/// fast path above is checked against the definition it replaced rather than
/// against itself.
#[cfg(test)]
fn disc_filter_naive(
    plane: &[f32],
    width: usize,
    height: usize,
    radius: isize,
    minimum: bool,
) -> Vec<f32> {
    let pixels = width.saturating_mul(height);
    let mut horizontal = vec![0.0f32; pixels];
    let better = |a: f32, b: f32| -> f32 {
        if minimum {
            if b < a {
                b
            } else {
                a
            }
        } else if b > a {
            b
        } else {
            a
        }
    };
    let seed = if minimum {
        f32::INFINITY
    } else {
        f32::NEG_INFINITY
    };

    for y in 0..height {
        for x in 0..width {
            let mut best = seed;
            let x0 = (x as isize - radius).max(0) as usize;
            let x1 = (x as isize + radius).min(width as isize - 1) as usize;
            for k in x0..=x1 {
                let v = plane[y * width + k];
                if v.is_finite() {
                    best = better(best, v);
                }
            }
            horizontal[y * width + x] = if best.is_finite() { best } else { f32::NAN };
        }
    }
    let mut out = vec![0.0f32; pixels];
    for y in 0..height {
        let y0 = (y as isize - radius).max(0) as usize;
        let y1 = (y as isize + radius).min(height as isize - 1) as usize;
        for x in 0..width {
            let mut best = seed;
            for k in y0..=y1 {
                let v = horizontal[k * width + x];
                if v.is_finite() {
                    best = better(best, v);
                }
            }
            out[y * width + x] = if best.is_finite() { best } else { f32::NAN };
        }
    }
    out
}

fn negate(plane: &[f32]) -> Vec<f32> {
    plane
        .iter()
        .map(|&v| if v.is_finite() { -v } else { f32::NAN })
        .collect()
}

/// Rolling-ball-style background subtraction: an opening (erode then dilate)
/// estimates the background, which is then removed from the source.
pub(crate) fn subtract_background(
    plane: &[f32],
    width: usize,
    height: usize,
    radius: f64,
    light_background: bool,
) -> Vec<f32> {
    let pixels = width.saturating_mul(height);
    if pixels == 0 || plane.len() < pixels {
        return plane.to_vec();
    }
    let r = (radius.round() as isize).max(1);
    let source: Vec<f32> = if light_background {
        negate(plane)
    } else {
        plane[..pixels].to_vec()
    };
    let eroded = disc_filter(&source, width, height, r, true);
    let background = disc_filter(&eroded, width, height, r, false);

    let mut out = vec![0.0f32; pixels];
    for i in 0..pixels {
        let v = source[i];
        out[i] = if v.is_finite() {
            v - background[i]
        } else {
            f32::NAN
        };
    }
    if light_background {
        negate(&out)
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blur_conserves_mass_on_a_delta() {
        // A single unit impulse spread by a normalised kernel must keep its
        // total, because every output pixel renormalises by the weight used.
        let mut plane = vec![0.0f32; 9 * 9];
        plane[4 * 9 + 4] = 1.0;
        let out = gaussian_blur(&plane, 9, 9, 1.0);
        let total: f64 = out.iter().map(|&v| v as f64).sum();
        assert!((total - 1.0).abs() < 1e-3, "mass {total} should stay ~1");
        // The peak must remain at the impulse.
        let peak = out.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        assert_eq!(out[4 * 9 + 4], peak);
    }

    #[test]
    fn blur_ignores_non_finite_neighbours() {
        // A NaN neighbour must be skipped, not treated as zero: the result
        // beside it stays close to the finite values around it.
        let plane = vec![1.0f32, f32::NAN, 1.0, 1.0, 1.0, 1.0];
        let out = gaussian_blur(&plane, 3, 2, 1.0);
        for (i, v) in out.iter().enumerate() {
            assert!(v.is_finite(), "index {i} became {v}");
            assert!((v - 1.0).abs() < 1e-5, "index {i} = {v}, expected ~1");
        }
    }

    #[test]
    fn zero_sigma_returns_a_copy() {
        let plane = vec![1.0f32, 2.0, 3.0];
        assert_eq!(gaussian_blur(&plane, 3, 1, 0.0), plane);
    }

    /// Deterministic pseudo-random plane with non-finite samples sprinkled in,
    /// so the fast filter is exercised on the awkward cases rather than smooth data.
    fn noisy_plane(width: usize, height: usize, seed: u32) -> Vec<f32> {
        let mut state = seed | 1;
        (0..width * height)
            .map(|i| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                match i % 17 {
                    3 => f32::NAN,
                    11 => f32::INFINITY,
                    13 => f32::NEG_INFINITY,
                    _ => ((state >> 8) as f32 / 65_536.0) - 128.0,
                }
            })
            .collect()
    }

    #[test]
    fn fast_sliding_filter_matches_the_naive_definition() {
        // The O(1) van Herk path must agree with the O(r) scan it replaced for
        // every radius, both operations, and awkward geometries — including
        // radii larger than the image, where the window is clamped everywhere.
        for &(w, h) in &[(1usize, 1usize), (7, 1), (1, 7), (16, 9), (33, 17)] {
            let plane = noisy_plane(w, h, (w * 31 + h) as u32);
            for &r in &[0isize, 1, 2, 3, 5, 8, 40] {
                for &minimum in &[true, false] {
                    let fast = disc_filter(&plane, w, h, r, minimum);
                    let naive = disc_filter_naive(&plane, w, h, r, minimum);
                    assert_eq!(fast.len(), naive.len());
                    for i in 0..fast.len() {
                        let (a, b) = (fast[i], naive[i]);
                        assert!(
                            (a.is_nan() && b.is_nan()) || a == b,
                            "{w}x{h} r={r} min={minimum} index {i}: fast {a} != naive {b}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn background_subtraction_flattens_a_ramp() {
        // A monotonic ramp is entirely background: opening reproduces it, so
        // subtracting leaves nothing but the local detail (zero here).
        let width = 16;
        let plane: Vec<f32> = (0..width).map(|x| x as f32).collect();
        let out = subtract_background(&plane, width, 1, 4.0, false);
        for v in &out {
            assert!(v.is_finite() && *v >= 0.0, "unexpected {v}");
        }
        // The first sample sits at the ramp's minimum, so nothing is removed.
        assert_eq!(out[0], 0.0);
    }
}

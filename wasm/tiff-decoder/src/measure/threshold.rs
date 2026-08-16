//! Thresholding.
//!
//! Port of `media/modules/measure/threshold.ts`. All global methods operate on
//! a 256-bin histogram of the scalar image and return a **bin index**; the
//! caller maps that back to a data value. Binning is what makes the whole
//! auto-threshold gallery affordable to recompute live: the histogram is built
//! once and every method is then a few hundred operations.
//!
//! The methods are the classical ones catalogued by Sezgin & Sankur and shipped
//! in ImageJ's Auto Threshold plugin; the implementations below follow those
//! published formulations bit-for-bit against the TypeScript they replace, so
//! `test/measurement-test.js` (compared against ImageJ-derived expectations)
//! keeps passing unweakened.
//!
//! `local_threshold_mask` and `local_auto_threshold_mask` run over the full
//! image on every keystroke in the Measure panel's range fields, which is why
//! they are the hottest thing in this module.

pub(crate) const HISTOGRAM_BINS: usize = 256;

/// A 256-bin histogram of a scalar plane, plus the data range it was built
/// from and how many samples were finite vs. not.
pub(crate) struct ScalarHistogram {
    pub counts: Vec<i32>,
    pub min: f64,
    pub max: f64,
    pub total: u32,
    pub non_finite_count: u32,
}

/// Map a bin index back to the data value at the bin's lower edge.
pub(crate) fn bin_to_value(histogram: &ScalarHistogram, bin: i32) -> f64 {
    if histogram.max == histogram.min {
        return histogram.min;
    }
    histogram.min + (bin as f64 / HISTOGRAM_BINS as f64) * (histogram.max - histogram.min)
}

/// Turn a method's bin index into a usable cut value. Every method returns
/// the last bin that belongs to the *background*, so the cut sits at that
/// bin's upper edge (ImageJ's "foreground is > threshold" convention).
pub(crate) fn threshold_value_from_bin(histogram: &ScalarHistogram, bin: i32) -> f64 {
    bin_to_value(histogram, bin + 1)
}

// `valueToBin` (the inverse of `binToValue`) is NOT ported here: it is O(1)
// scalar arithmetic called synchronously from canvas-drawing code in
// `measure-panel.ts` (positioning the stability-curve marker), and stays in
// TypeScript for that reason — see the note at the top of `threshold.ts`.
// A Rust twin would be dead weight and a second implementation to keep in
// sync, so it does not exist here.

/// Build the 256-bin histogram of a scalar plane. `step` subsamples for
/// interactive use; every method below is scale-invariant in the counts, so a
/// subsampled histogram picks the same threshold as the full one to within a
/// bin on any realistic image.
pub(crate) fn build_histogram(plane: &[f32], step: usize) -> ScalarHistogram {
    let step = step.max(1);
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    let mut non_finite: u32 = 0;
    let mut i = 0usize;
    while i < plane.len() {
        let v = plane[i] as f64;
        if !v.is_finite() {
            non_finite += 1;
        } else {
            if v < min {
                min = v;
            }
            if v > max {
                max = v;
            }
        }
        i += step;
    }

    let mut counts = vec![0i32; HISTOGRAM_BINS];
    if !min.is_finite() || !max.is_finite() {
        return ScalarHistogram {
            counts,
            min: 0.0,
            max: 0.0,
            total: 0,
            non_finite_count: non_finite,
        };
    }

    let mut total: u32 = 0;
    if max == min {
        let mut i = 0usize;
        while i < plane.len() {
            if (plane[i] as f64).is_finite() {
                counts[0] += 1;
                total += 1;
            }
            i += step;
        }
        return ScalarHistogram {
            counts,
            min,
            max,
            total,
            non_finite_count: non_finite,
        };
    }

    let scale = HISTOGRAM_BINS as f64 / (max - min);
    let mut i = 0usize;
    while i < plane.len() {
        let v = plane[i] as f64;
        if v.is_finite() {
            let mut bin = ((v - min) * scale).floor() as i64;
            if bin >= HISTOGRAM_BINS as i64 {
                bin = HISTOGRAM_BINS as i64 - 1;
            }
            if bin < 0 {
                bin = 0;
            }
            counts[bin as usize] += 1;
            total += 1;
        }
        i += step;
    }
    ScalarHistogram {
        counts,
        min,
        max,
        total,
        non_finite_count: non_finite,
    }
}

/// Apply one auto-threshold method. Returns a bin index, or -1 on failure.
/// Unknown method names fall back to Otsu, matching the TypeScript `default`.
pub(crate) fn auto_threshold_bin(counts: &[i32; HISTOGRAM_BINS], method: &str) -> i32 {
    match method {
        "otsu" => otsu(counts),
        "isodata" => iso_data(counts),
        "li" => li(counts),
        "triangle" => triangle(counts),
        "yen" => yen(counts),
        "huang" => huang(counts),
        "maxEntropy" => max_entropy(counts),
        "mean" => mean_threshold(counts),
        "moments" => moments(counts),
        "percentile" => percentile(counts),
        "shanbhag" => shanbhag(counts),
        "minimum" => minimum(counts),
        "intermodes" => intermodes(counts),
        _ => otsu(counts),
    }
}

fn total_of(counts: &[i32; HISTOGRAM_BINS]) -> i64 {
    counts.iter().map(|&c| c as i64).sum()
}

/// Otsu 1979: maximise between-class variance.
fn otsu(counts: &[i32; HISTOGRAM_BINS]) -> i32 {
    let n = total_of(counts);
    if n == 0 {
        return -1;
    }
    let mut sum: f64 = 0.0;
    for i in 0..HISTOGRAM_BINS {
        sum += (i as f64) * counts[i] as f64;
    }
    let mut sum_background: f64 = 0.0;
    let mut weight_background: i64 = 0;
    let mut best: i32 = -1;
    let mut best_variance: f64 = -1.0;
    for t in 0..HISTOGRAM_BINS {
        weight_background += counts[t] as i64;
        if weight_background == 0 {
            continue;
        }
        let weight_foreground = n - weight_background;
        if weight_foreground == 0 {
            break;
        }
        sum_background += (t as f64) * counts[t] as f64;
        let mean_background = sum_background / weight_background as f64;
        let mean_foreground = (sum - sum_background) / weight_foreground as f64;
        let delta = mean_background - mean_foreground;
        let variance = weight_background as f64 * weight_foreground as f64 * delta * delta;
        if variance > best_variance {
            best_variance = variance;
            best = t as i32;
        }
    }
    best
}

/// Ridler-Calvard iterative isodata, as used by ImageJ's "Default".
fn iso_data(counts: &[i32; HISTOGRAM_BINS]) -> i32 {
    let mut t: i32 = 0;
    for i in 0..HISTOGRAM_BINS {
        if counts[i] > 0 {
            t = i as i32;
            break;
        }
    }
    let mut previous: i32 = -1;
    let mut guard = 0;
    let mut threshold: i32 = (HISTOGRAM_BINS / 2) as i32;
    while threshold != previous && guard < 1000 {
        guard += 1;
        previous = threshold;
        let mut sum_below: f64 = 0.0;
        let mut count_below: i64 = 0;
        let mut sum_above: f64 = 0.0;
        let mut count_above: i64 = 0;
        for i in 0..=(threshold.max(0) as usize).min(HISTOGRAM_BINS - 1) {
            sum_below += (i as f64) * counts[i] as f64;
            count_below += counts[i] as i64;
        }
        let start = (threshold + 1).max(0) as usize;
        for i in start..HISTOGRAM_BINS {
            sum_above += (i as f64) * counts[i] as f64;
            count_above += counts[i] as i64;
        }
        if count_below == 0 || count_above == 0 {
            break;
        }
        let mean_below = sum_below / count_below as f64;
        let mean_above = sum_above / count_above as f64;
        threshold = ((mean_below + mean_above) / 2.0).round() as i32;
    }
    if threshold < t {
        t
    } else {
        threshold
    }
}

/// Li & Tam: iterative minimum cross-entropy.
fn li(counts: &[i32; HISTOGRAM_BINS]) -> i32 {
    let n = total_of(counts);
    if n == 0 {
        return -1;
    }
    let mut mean: f64 = 0.0;
    for i in 0..HISTOGRAM_BINS {
        mean += (i as f64) * counts[i] as f64;
    }
    mean /= n as f64;

    let mut new_threshold = mean;
    let mut old_threshold: f64;
    let mut guard = 0;
    loop {
        old_threshold = new_threshold;
        let t = (old_threshold + 0.5).floor();
        let t_idx = if t < 0.0 {
            0i64
        } else if t >= HISTOGRAM_BINS as f64 {
            HISTOGRAM_BINS as i64 - 1
        } else {
            t as i64
        };
        let t_idx = t_idx as usize;

        let mut sum_back: f64 = 0.0;
        let mut count_back: i64 = 0;
        for i in 0..=t_idx {
            sum_back += (i as f64) * counts[i] as f64;
            count_back += counts[i] as i64;
        }
        let mut sum_fore: f64 = 0.0;
        let mut count_fore: i64 = 0;
        for i in (t_idx + 1)..HISTOGRAM_BINS {
            sum_fore += (i as f64) * counts[i] as f64;
            count_fore += counts[i] as i64;
        }

        let mean_back = if count_back > 0 {
            sum_back / count_back as f64
        } else {
            0.0
        };
        let mean_fore = if count_fore > 0 {
            sum_fore / count_fore as f64
        } else {
            0.0
        };
        let a = if mean_back > 0.0 { mean_back } else { 1e-9 };
        let b = if mean_fore > 0.0 { mean_fore } else { 1e-9 };
        new_threshold = (b - a) / (b.ln() - a.ln());
        if !new_threshold.is_finite() {
            break;
        }
        guard += 1;
        if (new_threshold - old_threshold).abs() <= 0.5 || guard >= 1000 {
            break;
        }
    }
    new_threshold.floor() as i32
}

/// Zack's triangle method: farthest point from the peak-to-tail chord.
fn triangle(counts: &[i32; HISTOGRAM_BINS]) -> i32 {
    let mut peak = 0usize;
    for i in 1..HISTOGRAM_BINS {
        if counts[i] > counts[peak] {
            peak = i;
        }
    }

    let mut first = 0usize;
    while first < HISTOGRAM_BINS && counts[first] == 0 {
        first += 1;
    }
    let mut last = HISTOGRAM_BINS - 1;
    while last > 0 && counts[last] == 0 {
        last -= 1;
    }
    if first >= last {
        return -1;
    }

    if peak - first < last - peak {
        let mut reversed = [0i32; HISTOGRAM_BINS];
        for i in 0..HISTOGRAM_BINS {
            reversed[i] = counts[HISTOGRAM_BINS - 1 - i];
        }
        let result = triangle_one_sided(&reversed);
        return if result < 0 {
            result
        } else {
            HISTOGRAM_BINS as i32 - 1 - result
        };
    }
    triangle_one_sided(counts)
}

fn triangle_one_sided(counts: &[i32; HISTOGRAM_BINS]) -> i32 {
    let mut peak = 0usize;
    for i in 1..HISTOGRAM_BINS {
        if counts[i] > counts[peak] {
            peak = i;
        }
    }
    let mut last = HISTOGRAM_BINS - 1;
    while last > peak && counts[last] == 0 {
        last -= 1;
    }
    if last <= peak {
        return peak as i32;
    }

    let dx = (last - peak) as f64;
    let dy = (counts[last] - counts[peak]) as f64;
    let norm = {
        let n = dx.hypot(dy);
        if n == 0.0 {
            1.0
        } else {
            n
        }
    };
    let mut best = peak;
    let mut best_distance: f64 = -1.0;
    for i in peak..=last {
        let distance =
            (dy * (i - peak) as f64 - dx * (counts[i] - counts[peak]) as f64).abs() / norm;
        if distance > best_distance {
            best_distance = distance;
            best = i;
        }
    }
    best as i32
}

/// Yen, Chang & Chang maximum-correlation criterion.
fn yen(counts: &[i32; HISTOGRAM_BINS]) -> i32 {
    let n = total_of(counts);
    if n == 0 {
        return -1;
    }
    let mut p = [0f64; HISTOGRAM_BINS];
    for i in 0..HISTOGRAM_BINS {
        p[i] = counts[i] as f64 / n as f64;
    }

    let mut p1 = [0f64; HISTOGRAM_BINS];
    let mut p1_squared = [0f64; HISTOGRAM_BINS];
    p1[0] = p[0];
    p1_squared[0] = p[0] * p[0];
    for i in 1..HISTOGRAM_BINS {
        p1[i] = p1[i - 1] + p[i];
        p1_squared[i] = p1_squared[i - 1] + p[i] * p[i];
    }
    let mut p2_squared = [0f64; HISTOGRAM_BINS];
    p2_squared[HISTOGRAM_BINS - 1] = 0.0;
    for i in (0..HISTOGRAM_BINS - 1).rev() {
        p2_squared[i] = p2_squared[i + 1] + p[i + 1] * p[i + 1];
    }

    let mut best: i32 = -1;
    let mut best_criterion = f64::NEG_INFINITY;
    for t in 0..HISTOGRAM_BINS {
        let a = p1_squared[t] * p2_squared[t];
        let b = p1[t] * (1.0 - p1[t]);
        let criterion = (if a > 0.0 { -1.0 * a.ln() } else { 0.0 })
            + (if b > 0.0 { 2.0 * b.ln() } else { 0.0 });
        if criterion > best_criterion {
            best_criterion = criterion;
            best = t as i32;
        }
    }
    best
}

/// Huang & Wang fuzzy-membership minimisation.
fn huang(counts: &[i32; HISTOGRAM_BINS]) -> i32 {
    let mut first = 0usize;
    while first < HISTOGRAM_BINS && counts[first] == 0 {
        first += 1;
    }
    let mut last = HISTOGRAM_BINS - 1;
    while last > first && counts[last] == 0 {
        last -= 1;
    }
    if first == last {
        return first as i32;
    }
    if first >= HISTOGRAM_BINS {
        return -1;
    }

    let mut cumulative = [0f64; HISTOGRAM_BINS];
    let mut weighted = [0f64; HISTOGRAM_BINS];
    cumulative[first] = counts[first] as f64;
    weighted[first] = first as f64 * counts[first] as f64;
    for i in first.max(1)..=last {
        cumulative[i] = cumulative[i - 1] + counts[i] as f64;
        weighted[i] = weighted[i - 1] + i as f64 * counts[i] as f64;
    }

    let c = (last - first) as f64;
    let c = if c == 0.0 { 1.0 } else { c };
    let mut membership_cost = [0f64; HISTOGRAM_BINS];
    for i in 0..HISTOGRAM_BINS {
        let membership = 1.0 / (1.0 + (i as f64).abs() / c);
        membership_cost[i] =
            -membership * membership.ln() - (1.0 - membership) * (1.0 - membership).ln();
    }

    let mut best = first;
    let mut best_entropy = f64::INFINITY;
    for t in first..=last {
        let mut entropy = 0.0;
        let mean_low = if cumulative[t] > 0.0 {
            (weighted[t] / cumulative[t]).round()
        } else {
            0.0
        };
        for i in first..=t {
            let idx = ((i as f64 - mean_low).abs()) as usize;
            let idx = idx.min(HISTOGRAM_BINS - 1);
            entropy += membership_cost[idx] * counts[i] as f64;
        }
        let high_count = cumulative[last] - cumulative[t];
        let mean_high = if high_count > 0.0 {
            ((weighted[last] - weighted[t]) / high_count).round()
        } else {
            0.0
        };
        for i in (t + 1)..=last {
            let idx = ((i as f64 - mean_high).abs()) as usize;
            let idx = idx.min(HISTOGRAM_BINS - 1);
            entropy += membership_cost[idx] * counts[i] as f64;
        }
        if entropy < best_entropy {
            best_entropy = entropy;
            best = t;
        }
    }
    best as i32
}

/// Kapur, Sahoo & Wong maximum entropy.
fn max_entropy(counts: &[i32; HISTOGRAM_BINS]) -> i32 {
    let n = total_of(counts);
    if n == 0 {
        return -1;
    }
    let mut p = [0f64; HISTOGRAM_BINS];
    for i in 0..HISTOGRAM_BINS {
        p[i] = counts[i] as f64 / n as f64;
    }

    let mut cumulative = [0f64; HISTOGRAM_BINS];
    cumulative[0] = p[0];
    for i in 1..HISTOGRAM_BINS {
        cumulative[i] = cumulative[i - 1] + p[i];
    }

    let mut best: i32 = -1;
    let mut best_entropy = f64::NEG_INFINITY;
    for t in 0..HISTOGRAM_BINS {
        let p_background = cumulative[t];
        let p_foreground = 1.0 - p_background;
        if p_background <= 0.0 || p_foreground <= 0.0 {
            continue;
        }
        let mut background_entropy = 0.0;
        for i in 0..=t {
            if p[i] > 0.0 {
                background_entropy -= (p[i] / p_background) * (p[i] / p_background).ln();
            }
        }
        let mut foreground_entropy = 0.0;
        for i in (t + 1)..HISTOGRAM_BINS {
            if p[i] > 0.0 {
                foreground_entropy -= (p[i] / p_foreground) * (p[i] / p_foreground).ln();
            }
        }
        let entropy = background_entropy + foreground_entropy;
        if entropy > best_entropy {
            best_entropy = entropy;
            best = t as i32;
        }
    }
    best
}

fn mean_threshold(counts: &[i32; HISTOGRAM_BINS]) -> i32 {
    let n = total_of(counts);
    if n == 0 {
        return -1;
    }
    let mut sum: f64 = 0.0;
    for i in 0..HISTOGRAM_BINS {
        sum += (i as f64) * counts[i] as f64;
    }
    (sum / n as f64).floor() as i32
}

/// Tsai's moment-preserving threshold.
fn moments(counts: &[i32; HISTOGRAM_BINS]) -> i32 {
    let n = total_of(counts);
    if n == 0 {
        return -1;
    }
    let (mut m1, mut m2, mut m3) = (0f64, 0f64, 0f64);
    for i in 0..HISTOGRAM_BINS {
        let p = counts[i] as f64 / n as f64;
        m1 += i as f64 * p;
        m2 += (i * i) as f64 * p;
        m3 += (i * i * i) as f64 * p;
    }
    let cd = m2 - m1 * m1;
    if cd == 0.0 {
        return -1;
    }
    let c0 = (-m2 * m2 + m1 * m3) / cd;
    let c1 = (-m3 + m2 * m1) / cd;
    let discriminant = c1 * c1 - 4.0 * c0;
    if discriminant < 0.0 {
        return -1;
    }
    let root = discriminant.sqrt();
    let z0 = 0.5 * (-c1 - root);
    let z1 = 0.5 * (-c1 + root);
    let pd = z1 - z0;
    if pd == 0.0 {
        return -1;
    }
    let p0 = (z1 - m1) / pd;

    let mut cumulative = 0.0;
    for i in 0..HISTOGRAM_BINS {
        cumulative += counts[i] as f64 / n as f64;
        if cumulative > p0 {
            return i as i32;
        }
    }
    -1
}

/// Doyle's percentile method, assuming half the image is foreground.
fn percentile(counts: &[i32; HISTOGRAM_BINS]) -> i32 {
    let n = total_of(counts);
    if n == 0 {
        return -1;
    }
    let target = 0.5;
    let mut best: i32 = -1;
    let mut best_distance = f64::INFINITY;
    let mut cumulative: i64 = 0;
    for i in 0..HISTOGRAM_BINS {
        cumulative += counts[i] as i64;
        let distance = (cumulative as f64 / n as f64 - target).abs();
        if distance < best_distance {
            best_distance = distance;
            best = i as i32;
        }
    }
    best
}

/// Shanbhag's information-measure threshold.
fn shanbhag(counts: &[i32; HISTOGRAM_BINS]) -> i32 {
    let n = total_of(counts);
    if n == 0 {
        return -1;
    }
    let mut p = [0f64; HISTOGRAM_BINS];
    for i in 0..HISTOGRAM_BINS {
        p[i] = counts[i] as f64 / n as f64;
    }
    let mut cumulative = [0f64; HISTOGRAM_BINS];
    cumulative[0] = p[0];
    for i in 1..HISTOGRAM_BINS {
        cumulative[i] = cumulative[i - 1] + p[i];
    }

    let mut best: i32 = -1;
    let mut best_distance = f64::INFINITY;
    for t in 0..HISTOGRAM_BINS {
        let p_background = cumulative[t];
        let p_foreground = 1.0 - p_background;
        if p_background <= 0.0 || p_foreground <= 0.0 {
            continue;
        }

        let mut background_term = 0.0;
        let mut running = 1.0;
        let mut i = 1usize;
        while i <= t {
            let idx = t - i + 1;
            running *= (p_background - p[idx]) / p_background;
            if !(running > 0.0) {
                break;
            }
            background_term -= p[i] * running.ln();
            i += 1;
        }
        background_term /= p_background;

        let mut foreground_term = 0.0;
        running = 1.0;
        let mut j = 1usize;
        while t + j < HISTOGRAM_BINS {
            running *= (p_foreground - p[t + j]) / p_foreground;
            if !(running > 0.0) {
                break;
            }
            foreground_term -= p[t + j] * running.ln();
            j += 1;
        }
        foreground_term /= p_foreground;

        let distance = (background_term - foreground_term).abs();
        if distance < best_distance {
            best_distance = distance;
            best = t as i32;
        }
    }
    best
}

/// Smooth the histogram until it has exactly two local maxima.
fn smooth_to_bimodal(counts: &[i32; HISTOGRAM_BINS]) -> Option<[f64; HISTOGRAM_BINS]> {
    let mut smoothed = [0f64; HISTOGRAM_BINS];
    for i in 0..HISTOGRAM_BINS {
        smoothed[i] = counts[i] as f64;
    }
    for _ in 0..10000 {
        let mut peaks = 0;
        for i in 1..HISTOGRAM_BINS - 1 {
            if smoothed[i - 1] < smoothed[i] && smoothed[i + 1] < smoothed[i] {
                peaks += 1;
            }
        }
        if peaks <= 2 {
            return if peaks == 2 { Some(smoothed) } else { None };
        }
        let mut next = [0f64; HISTOGRAM_BINS];
        for i in 0..HISTOGRAM_BINS {
            let a = smoothed[if i == 0 { 0 } else { i - 1 }];
            let b = smoothed[i];
            let c = smoothed[(i + 1).min(HISTOGRAM_BINS - 1)];
            next[i] = (a + b + c) / 3.0;
        }
        smoothed = next;
    }
    None
}

/// Prewitt & Mendelsohn minimum: the valley between the two smoothed peaks.
fn minimum(counts: &[i32; HISTOGRAM_BINS]) -> i32 {
    let smoothed = match smooth_to_bimodal(counts) {
        Some(s) => s,
        None => return -1,
    };
    for i in 1..HISTOGRAM_BINS - 1 {
        if smoothed[i - 1] > smoothed[i] && smoothed[i + 1] >= smoothed[i] {
            return i as i32;
        }
    }
    -1
}

/// Prewitt & Mendelsohn intermodes: the midpoint between the two peaks.
fn intermodes(counts: &[i32; HISTOGRAM_BINS]) -> i32 {
    let smoothed = match smooth_to_bimodal(counts) {
        Some(s) => s,
        None => return -1,
    };
    let mut peaks: Vec<usize> = Vec::new();
    for i in 1..HISTOGRAM_BINS - 1 {
        if smoothed[i - 1] < smoothed[i] && smoothed[i + 1] < smoothed[i] {
            peaks.push(i);
        }
    }
    if peaks.len() != 2 {
        return -1;
    }
    ((peaks[0] + peaks[1]) as f64 / 2.0).floor() as i32
}

// ---------------------------------------------------------------------------
// Stability curve
// ---------------------------------------------------------------------------

pub(crate) struct StabilityPoint {
    pub bin: i32,
    pub value: f64,
    pub object_count: u32,
    pub area_fraction: f64,
}

pub(crate) struct StabilityCurve {
    pub points: Vec<StabilityPoint>,
    pub suggested_bin: i32,
    pub plateau_width: i32,
}

/// Object count and area as a function of threshold. Cost is kept bounded by
/// measuring on a downsampled image: plateau structure is a property of the
/// intensity distribution, not of resolution.
pub(crate) fn compute_stability_curve(
    plane: &[f32],
    width: usize,
    height: usize,
    histogram: &ScalarHistogram,
    samples: usize,
    max_pixels: usize,
    dark_background: bool,
) -> StabilityCurve {
    let samples = samples.clamp(8, 128);
    let (small, small_width, small_height) = downsample(plane, width, height, max_pixels);

    let mut points: Vec<StabilityPoint> = Vec::with_capacity(samples);
    let mut mask = vec![0u8; small_width * small_height];
    for s in 0..samples {
        let bin =
            ((s as f64 / (samples as f64 - 1.0)) * (HISTOGRAM_BINS as f64 - 1.0)).round() as i32;
        let value = threshold_value_from_bin(histogram, bin);
        let mut inside: u32 = 0;
        for i in 0..small.len() {
            let v = small[i] as f64;
            let on = v.is_finite()
                && (if dark_background {
                    v >= value
                } else {
                    v <= value
                });
            mask[i] = if on { 1 } else { 0 };
            if on {
                inside += 1;
            }
        }
        points.push(StabilityPoint {
            bin,
            value,
            object_count: count_components(&mask, small_width, small_height),
            area_fraction: if mask.is_empty() {
                0.0
            } else {
                inside as f64 / mask.len() as f64
            },
        });
    }

    // The useful plateau is a run where the object count barely moves *and*
    // something is actually selected.
    let mut best_start: usize = 0;
    let mut best_length: usize = 0;
    let mut run_start: usize = 0;
    for i in 1..=points.len() {
        let ended = i == points.len() || {
            let diff =
                (points[i].object_count as i64 - points[run_start].object_count as i64).abs();
            diff as f64 > (1.0f64).max(points[run_start].object_count as f64 * 0.1)
        };
        if !ended {
            continue;
        }
        let length = i - run_start;
        let mid_index = run_start + length / 2;
        let midpoint = &points[mid_index.min(points.len() - 1)];
        let usable = midpoint.object_count > 0
            && midpoint.area_fraction > 0.0005
            && midpoint.area_fraction < 0.95;
        if usable && length > best_length {
            best_length = length;
            best_start = run_start;
        }
        run_start = i;
    }

    let suggested_index = if best_length > 0 {
        best_start + best_length / 2
    } else {
        points.len() / 2
    };

    let suggested_bin = points.get(suggested_index).map(|p| p.bin).unwrap_or(128);
    StabilityCurve {
        points,
        suggested_bin,
        plateau_width: best_length as i32,
    }
}

/// Box-average downsample to at most `max_pixels`, preserving aspect ratio.
pub(crate) fn downsample(
    plane: &[f32],
    width: usize,
    height: usize,
    max_pixels: usize,
) -> (Vec<f32>, usize, usize) {
    let pixels = width.saturating_mul(height);
    if pixels <= max_pixels || pixels == 0 {
        return (plane.to_vec(), width, height);
    }
    let factor = ((pixels as f64 / max_pixels as f64).sqrt()).ceil().max(1.0) as usize;
    let out_width = (width / factor).max(1);
    let out_height = (height / factor).max(1);
    let mut out = vec![0f32; out_width * out_height];
    for y in 0..out_height {
        for x in 0..out_width {
            let mut sum = 0f64;
            let mut n = 0u32;
            for dy in 0..factor {
                let sy = y * factor + dy;
                if sy >= height {
                    break;
                }
                for dx in 0..factor {
                    let sx = x * factor + dx;
                    if sx >= width {
                        break;
                    }
                    let v = plane[sy * width + sx];
                    if v.is_finite() {
                        sum += v as f64;
                        n += 1;
                    }
                }
            }
            out[y * out_width + x] = if n > 0 {
                (sum / n as f64) as f32
            } else {
                f32::NAN
            };
        }
    }
    (out, out_width, out_height)
}

/// Four-connected component count of a binary mask.
fn count_components(mask: &[u8], width: usize, height: usize) -> u32 {
    if mask.is_empty() {
        return 0;
    }
    let mut visited = vec![0u8; mask.len()];
    let mut stack: Vec<usize> = Vec::new();
    let mut components: u32 = 0;
    for start in 0..mask.len() {
        if mask[start] == 0 || visited[start] != 0 {
            continue;
        }
        components += 1;
        stack.push(start);
        visited[start] = 1;
        while let Some(index) = stack.pop() {
            let x = index % width;
            let y = index / width;
            if x > 0 && mask[index - 1] != 0 && visited[index - 1] == 0 {
                visited[index - 1] = 1;
                stack.push(index - 1);
            }
            if x + 1 < width && mask[index + 1] != 0 && visited[index + 1] == 0 {
                visited[index + 1] = 1;
                stack.push(index + 1);
            }
            if y > 0 && mask[index - width] != 0 && visited[index - width] == 0 {
                visited[index - width] = 1;
                stack.push(index - width);
            }
            if y + 1 < height && mask[index + width] != 0 && visited[index + width] == 0 {
                visited[index + width] = 1;
                stack.push(index + width);
            }
        }
    }
    components
}

// ---------------------------------------------------------------------------
// Local adaptive thresholding
// ---------------------------------------------------------------------------

pub(crate) struct LocalThresholdOptions {
    pub method: String,
    pub radius: f64,
    pub k: f64,
    pub r: Option<f64>,
    pub offset: Option<f64>,
    pub dark_background: bool,
}

/// Per-pixel threshold surface (Sauvola / Niblack / Phansalkar / local mean /
/// local median). Polarity is normalised first: those methods are all
/// published for document binarisation (foreground darker than surroundings),
/// so bright-object images are reflected about the data range before the
/// formulas run and the comparison stays `value <= threshold`.
pub(crate) fn local_threshold_mask(
    input_plane: &[f32],
    width: usize,
    height: usize,
    options: &LocalThresholdOptions,
) -> Vec<u8> {
    let radius = (options.radius.round() as i64).max(1) as isize;
    let k = options.k;
    let bright_objects = options.dark_background;
    let mut out = vec![0u8; width.saturating_mul(height)];
    if out.is_empty() {
        return out;
    }

    let mut source_min = f64::INFINITY;
    let mut source_max = f64::NEG_INFINITY;
    for &v in input_plane.iter() {
        let v = v as f64;
        if !v.is_finite() {
            continue;
        }
        if v < source_min {
            source_min = v;
        }
        if v > source_max {
            source_max = v;
        }
    }
    if !source_min.is_finite() || !source_max.is_finite() {
        return out;
    }

    let plane: Vec<f32> = if bright_objects {
        let pivot = source_min + source_max;
        input_plane
            .iter()
            .map(|&v| {
                let v = v as f64;
                if v.is_finite() {
                    (pivot - v) as f32
                } else {
                    f32::NAN
                }
            })
            .collect()
    } else {
        input_plane.to_vec()
    };

    if options.method == "median" {
        return local_median_mask(
            &plane,
            width,
            height,
            radius as usize,
            options.offset.unwrap_or(0.0),
        );
    }

    let stride = width + 1;
    let mut sum = vec![0f64; stride * (height + 1)];
    let mut sum_squares = vec![0f64; stride * (height + 1)];
    let mut counts = vec![0f64; stride * (height + 1)];
    for y in 0..height {
        for x in 0..width {
            let v = plane[y * width + x] as f64;
            let finite = v.is_finite();
            let value = if finite { v } else { 0.0 };
            let i = (y + 1) * stride + (x + 1);
            let up = y * stride + (x + 1);
            let left = (y + 1) * stride + x;
            let up_left = y * stride + x;
            sum[i] = value + sum[up] + sum[left] - sum[up_left];
            sum_squares[i] =
                value * value + sum_squares[up] + sum_squares[left] - sum_squares[up_left];
            counts[i] =
                (if finite { 1.0 } else { 0.0 }) + counts[up] + counts[left] - counts[up_left];
        }
    }

    let rect_sum = |table: &[f64], x0: usize, y0: usize, x1: usize, y1: usize| -> f64 {
        table[(y1 + 1) * stride + (x1 + 1)]
            - table[y0 * stride + (x1 + 1)]
            - table[(y1 + 1) * stride + x0]
            + table[y0 * stride + x0]
    };

    let range = if source_max > source_min {
        source_max - source_min
    } else {
        1.0
    };
    let r = options.r.unwrap_or(range / 2.0);
    let offset = options.offset.unwrap_or(0.0);
    let global_min = source_min;

    for y in 0..height {
        let y0 = y.saturating_sub(radius.max(0) as usize);
        let y1 = (y + radius.max(0) as usize).min(height - 1);
        for x in 0..width {
            let value = plane[y * width + x] as f64;
            if !value.is_finite() {
                continue;
            }
            let x0 = x.saturating_sub(radius.max(0) as usize);
            let x1 = (x + radius.max(0) as usize).min(width - 1);
            let n = rect_sum(&counts, x0, y0, x1, y1);
            if n <= 0.0 {
                continue;
            }
            let mean = rect_sum(&sum, x0, y0, x1, y1) / n;
            let mean_squares = rect_sum(&sum_squares, x0, y0, x1, y1) / n;
            let variance = (mean_squares - mean * mean).max(0.0);
            let sigma = variance.sqrt();

            let threshold = match options.method.as_str() {
                "sauvola" => mean * (1.0 + k * (sigma / r - 1.0)),
                "niblack" => mean - k * sigma,
                "phansalkar" => {
                    let normalized = if range > 0.0 {
                        (mean - global_min) / range
                    } else {
                        0.0
                    };
                    mean * (1.0 + 2.0 * (-10.0 * normalized).exp() + k * (sigma / r - 1.0))
                }
                _ => mean - offset,
            };

            if value <= threshold {
                out[y * width + x] = 1;
            }
        }
    }

    out
}

/// Local median threshold. Operates on the polarity-normalised plane, so
/// foreground is whatever falls at or below the local median minus the offset.
fn local_median_mask(
    plane: &[f32],
    width: usize,
    height: usize,
    radius: usize,
    offset: f64,
) -> Vec<u8> {
    let mut out = vec![0u8; width.saturating_mul(height)];
    if out.is_empty() {
        return out;
    }
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for &v in plane.iter() {
        let v = v as f64;
        if !v.is_finite() {
            continue;
        }
        if v < min {
            min = v;
        }
        if v > max {
            max = v;
        }
    }
    if !min.is_finite() || max <= min {
        return out;
    }
    let bins = 64usize;
    let scale = bins as f64 / (max - min);

    let mut counts = vec![0i32; bins];
    for y in 0..height {
        let y0 = y.saturating_sub(radius);
        let y1 = (y + radius).min(height - 1);
        for x in 0..width {
            let value = plane[y * width + x] as f64;
            if !value.is_finite() {
                continue;
            }
            let x0 = x.saturating_sub(radius);
            let x1 = (x + radius).min(width - 1);
            counts.iter_mut().for_each(|c| *c = 0);
            let mut n: i64 = 0;
            for wy in y0..=y1 {
                for wx in x0..=x1 {
                    let v = plane[wy * width + wx] as f64;
                    if !v.is_finite() {
                        continue;
                    }
                    let mut bin = ((v - min) * scale).floor() as i64;
                    if bin >= bins as i64 {
                        bin = bins as i64 - 1;
                    }
                    if bin < 0 {
                        bin = 0;
                    }
                    counts[bin as usize] += 1;
                    n += 1;
                }
            }
            if n == 0 {
                continue;
            }
            let mut cumulative: i64 = 0;
            let mut median_bin = 0usize;
            for b in 0..bins {
                cumulative += counts[b] as i64;
                if cumulative * 2 >= n {
                    median_bin = b;
                    break;
                }
            }
            let median = min + (median_bin as f64 + 0.5) / scale;
            if value <= median - offset {
                out[y * width + x] = 1;
            }
        }
    }
    out
}

pub(crate) struct LocalAutoThresholdOptions {
    pub method: String,
    pub radius: f64,
    pub dark_background: bool,
    pub min_contrast: Option<f64>,
}

/// Run any of the global methods **per neighbourhood** instead of once, on a
/// grid of tiles bilinearly interpolated between — the threshold surface of a
/// real image varies on the scale of illumination, not per pixel.
pub(crate) fn local_auto_threshold_mask(
    plane: &[f32],
    width: usize,
    height: usize,
    options: &LocalAutoThresholdOptions,
) -> Vec<u8> {
    let radius = (options.radius.round() as i64).max(4) as usize;
    let dark_background = options.dark_background;
    let min_contrast_fraction = options.min_contrast.unwrap_or(0.25);
    let mut out = vec![0u8; width.saturating_mul(height)];
    if out.is_empty() {
        return out;
    }

    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for &v in plane.iter() {
        let v = v as f64;
        if !v.is_finite() {
            continue;
        }
        if v < min {
            min = v;
        }
        if v > max {
            max = v;
        }
    }
    if !min.is_finite() || max <= min {
        return out;
    }
    let bin_scale = HISTOGRAM_BINS as f64 / (max - min);

    let tile = radius.max(1);
    let tiles_x = ((width + tile - 1) / tile + 1).max(2);
    let tiles_y = ((height + tile - 1) / tile + 1).max(2);
    let mut grid = vec![0f64; tiles_x * tiles_y];
    let mut valid = vec![0u8; tiles_x * tiles_y];
    let mut counts = [0i32; HISTOGRAM_BINS];

    for ty in 0..tiles_y {
        let centre_y = ty * tile;
        let y0 = centre_y.saturating_sub(radius);
        let y1 = (centre_y + radius).min(height - 1);
        for tx in 0..tiles_x {
            let centre_x = tx * tile;
            let x0 = centre_x.saturating_sub(radius);
            let x1 = (centre_x + radius).min(width - 1);

            counts.iter_mut().for_each(|c| *c = 0);
            let mut total: i64 = 0;
            let mut window_min = f64::INFINITY;
            let mut window_max = f64::NEG_INFINITY;
            for y in y0..=y1 {
                let row = y * width;
                for x in x0..=x1 {
                    let v = plane[row + x] as f64;
                    if !v.is_finite() {
                        continue;
                    }
                    if v < window_min {
                        window_min = v;
                    }
                    if v > window_max {
                        window_max = v;
                    }
                    let mut bin = ((v - min) * bin_scale).floor() as i64;
                    if bin >= HISTOGRAM_BINS as i64 {
                        bin = HISTOGRAM_BINS as i64 - 1;
                    }
                    if bin < 0 {
                        bin = 0;
                    }
                    counts[bin as usize] += 1;
                    total += 1;
                }
            }

            let empty = max + (max - min).abs() + 1.0;
            let mut value = empty;
            let mut is_valid = false;
            if total > 0 && (window_max - window_min) >= min_contrast_fraction * (max - min) {
                let bin = auto_threshold_bin(&counts, &options.method);
                if bin >= 0 {
                    value = min + ((bin as f64 + 1.0) / HISTOGRAM_BINS as f64) * (max - min);
                    is_valid = true;
                }
            }
            grid[ty * tiles_x + tx] = value;
            valid[ty * tiles_x + tx] = if is_valid { 1 } else { 0 };
        }
    }

    for y in 0..height {
        let gy = y as f64 / tile as f64;
        let ty0 = (gy.floor() as usize).min(tiles_y - 1);
        let ty1 = (ty0 + 1).min(tiles_y - 1);
        let fy = gy - ty0 as f64;
        let nearest_y = (gy.round() as usize).min(tiles_y - 1);
        for x in 0..width {
            let value = plane[y * width + x] as f64;
            if !value.is_finite() {
                continue;
            }
            let gx = x as f64 / tile as f64;
            let nearest_x = (gx.round() as usize).min(tiles_x - 1);
            if valid[nearest_y * tiles_x + nearest_x] == 0 {
                continue;
            }

            let tx0 = (gx.floor() as usize).min(tiles_x - 1);
            let tx1 = (tx0 + 1).min(tiles_x - 1);
            let fx = gx - tx0 as f64;

            let mut weighted = 0.0;
            let mut weight = 0.0;
            let corners = [
                (ty0, tx0, (1.0 - fx) * (1.0 - fy)),
                (ty0, tx1, fx * (1.0 - fy)),
                (ty1, tx0, (1.0 - fx) * fy),
                (ty1, tx1, fx * fy),
            ];
            for (cy, cx, w) in corners {
                let index = cy * tiles_x + cx;
                if valid[index] == 0 || w <= 0.0 {
                    continue;
                }
                weighted += grid[index] * w;
                weight += w;
            }
            if weight <= 0.0 {
                continue;
            }
            let threshold = weighted / weight;

            let on = if dark_background {
                value >= threshold
            } else {
                value <= threshold
            };
            if on {
                out[y * width + x] = 1;
            }
        }
    }

    out
}

/// Binary mask from a global value window.
pub(crate) fn global_threshold_mask(plane: &[f32], low: f64, high: f64) -> Vec<u8> {
    let mut out = vec![0u8; plane.len()];
    for i in 0..plane.len() {
        let v = plane[i] as f64;
        if v.is_finite() && v >= low && v <= high {
            out[i] = 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bimodal_counts() -> [i32; HISTOGRAM_BINS] {
        // Two well-separated clusters: 0..50 low, 200..255 high.
        let mut counts = [0i32; HISTOGRAM_BINS];
        for i in 0..50 {
            counts[i] = 10;
        }
        for i in 200..HISTOGRAM_BINS {
            counts[i] = 10;
        }
        counts
    }

    #[test]
    fn otsu_splits_bimodal_histogram_in_the_gap() {
        let counts = bimodal_counts();
        let bin = otsu(&counts);
        assert!(
            bin >= 49 && bin < 200,
            "expected split in the gap, got {bin}"
        );
    }

    #[test]
    fn build_histogram_counts_finite_samples_and_range() {
        let plane: Vec<f32> = vec![0.0, 1.0, 2.0, f32::NAN, 3.0, f32::INFINITY];
        let hist = build_histogram(&plane, 1);
        assert_eq!(hist.non_finite_count, 2);
        assert_eq!(hist.total, 4);
        assert_eq!(hist.min, 0.0);
        assert_eq!(hist.max, 3.0);
    }

    #[test]
    fn global_threshold_mask_respects_bounds_and_nan() {
        let plane = [0.0f32, 1.0, 2.0, f32::NAN, 5.0];
        let mask = global_threshold_mask(&plane, 1.0, 3.0);
        assert_eq!(mask, vec![0, 1, 1, 0, 0]);
    }

    #[test]
    fn degenerate_inputs_do_not_panic() {
        assert_eq!(global_threshold_mask(&[], 0.0, 1.0), Vec::<u8>::new());
        let opts = LocalThresholdOptions {
            method: "sauvola".to_string(),
            radius: 3.0,
            k: 0.5,
            r: None,
            offset: None,
            dark_background: true,
        };
        assert_eq!(local_threshold_mask(&[], 0, 0, &opts), Vec::<u8>::new());
        let opts2 = LocalAutoThresholdOptions {
            method: "otsu".to_string(),
            radius: 8.0,
            dark_background: true,
            min_contrast: None,
        };
        assert_eq!(
            local_auto_threshold_mask(&[], 0, 0, &opts2),
            Vec::<u8>::new()
        );
        assert_eq!(build_histogram(&[], 1).total, 0);
    }

    #[test]
    fn local_threshold_mask_flags_bright_blob_on_dark_background() {
        // 9x9 image, uniform low background with a bright 3x3 blob in the
        // centre; dark_background=true means "objects are brighter".
        let width = 9usize;
        let height = 9usize;
        let mut plane = vec![10.0f32; width * height];
        for y in 3..6 {
            for x in 3..6 {
                plane[y * width + x] = 200.0;
            }
        }
        let opts = LocalThresholdOptions {
            method: "sauvola".to_string(),
            radius: 4.0,
            k: 0.5,
            r: None,
            offset: None,
            dark_background: true,
        };
        let mask = local_threshold_mask(&plane, width, height, &opts);
        assert_eq!(
            mask[4 * width + 4],
            1,
            "centre of the bright blob must be foreground"
        );
        assert_eq!(mask[0], 0, "background corner must stay background");
    }

    #[test]
    fn bin_to_value_and_threshold_value_from_bin_agree_with_the_binning_convention() {
        let histogram = ScalarHistogram {
            counts: vec![0; HISTOGRAM_BINS],
            min: 0.0,
            max: 256.0,
            total: 0,
            non_finite_count: 0,
        };
        // bin_to_value maps bin i to its lower edge; threshold_value_from_bin
        // (used by callers as "the cut") is defined as the *next* bin's lower
        // edge, i.e. this bin's upper edge.
        assert_eq!(bin_to_value(&histogram, 130), 130.0);
        assert_eq!(threshold_value_from_bin(&histogram, 130), 131.0);
    }
}

//! Traces the outlines of a label mask (an unsigned integer image where cell `n` is painted with
//! the value `n` and 0 is background) into polygons.
//!
//! Every east-going edge on the top of a labelled pixel whose upper neighbour differs starts a
//! loop that is followed with the label on its right-hand side. Each loop is a closed ring of
//! pixel corners; outer rings run clockwise on screen (positive area here) and holes run the
//! other way, so keeping the positive rings gives the 4-connected pieces of a label (pieces that
//! touch only at a corner are separate). A cell is one polygon, so only the largest piece of a
//! label is kept; stray fragments are noise in a segmentation. Rings are thinned with
//! Douglas-Peucker so that the staircase of a rasterised outline costs a handful of vertices,
//! and polygons come out in ascending label order.
//!
//! Plain C ABI like the rest of this module: `mask_trace` reads a mask from wasm memory
//! (`tx_alloc`) and the `mask_*` getters expose the result as typed-array views.

use std::cell::RefCell;
use std::collections::HashMap;

/// The polygons of a mask, one per label: label per polygon, `offsets` (in vertices, one more than polygons)
/// into `xy`, and `x, y` pairs in pixel corners (the mask's own pixel units).
#[derive(Default, Debug, PartialEq)]
pub struct Traced {
    pub labels: Vec<u32>,
    pub offsets: Vec<u32>,
    pub xy: Vec<f32>,
}

/// Why a mask could not be traced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaskError {
    /// Width or height is 0, the sample size is not 1, 2 or 4 bytes, or the buffer is too short.
    Shape,
    /// A ring did not close: cannot happen for a valid mask, so it guards against a bug.
    Open,
}

struct Mask<'a, F: Fn(usize) -> u32> {
    label: &'a F,
    width: i64,
    height: i64,
}

impl<F: Fn(usize) -> u32> Mask<'_, F> {
    /// The label at a pixel; outside the image it is background.
    #[inline]
    fn at(&self, x: i64, y: i64) -> u32 {
        if x < 0 || y < 0 || x >= self.width || y >= self.height { 0 } else { (self.label)((y * self.width + x) as usize) }
    }
}

/// Direction 0 east, 1 south, 2 west, 3 north (y grows downwards). Moving in `d` towards `(x, y)`,
/// the pixels just ahead of the corner on the right and on the left of the path.
#[inline]
fn ahead(d: u8, x: i64, y: i64) -> ((i64, i64), (i64, i64)) {
    match d {
        0 => ((x, y), (x, y - 1)),
        1 => ((x - 1, y), (x, y)),
        2 => ((x - 1, y - 1), (x - 1, y)),
        _ => ((x, y - 1), (x - 1, y - 1)),
    }
}

/// Follow one ring from the top edge of pixel `(sx, sy)`. Returns the corners where the path
/// turns, and marks every east-going edge it uses in `visited`.
fn follow<F: Fn(usize) -> u32>(mask: &Mask<F>, label: u32, sx: i64, sy: i64, visited: &mut [u64]) -> Result<Vec<(i64, i64)>, MaskError> {
    let limit = 4 * (mask.width + 1) * (mask.height + 1) + 8;
    let (mut x, mut y, mut d) = (sx, sy, 0u8);
    let mut corners = vec![(sx, sy)];
    let mut steps = 0i64;
    loop {
        if d == 0 {
            let at = (y * mask.width + x) as usize;
            visited[at >> 6] |= 1 << (at & 63);
        }
        match d { 0 => x += 1, 1 => y += 1, 2 => x -= 1, _ => y -= 1 }
        let (right, left) = ahead(d, x, y);
        let next = if mask.at(right.0, right.1) != label { (d + 1) % 4 }
            else if mask.at(left.0, left.1) == label { (d + 3) % 4 }
            else { d };
        if x == sx && y == sy && next == 0 { return Ok(corners); }
        if next != d { corners.push((x, y)); }
        d = next;
        steps += 1;
        if steps > limit { return Err(MaskError::Open); }
    }
}

fn twice_area(ring: &[(i64, i64)]) -> i64 {
    let mut sum = 0i64;
    for index in 0..ring.len() {
        let (x0, y0) = ring[index];
        let (x1, y1) = ring[(index + 1) % ring.len()];
        sum += x0 * y1 - x1 * y0;
    }
    sum
}

fn distance_to_segment(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let length = dx * dx + dy * dy;
    if length == 0.0 { return ((p.0 - a.0).powi(2) + (p.1 - a.1).powi(2)).sqrt(); }
    let t = (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / length).clamp(0.0, 1.0);
    ((p.0 - (a.0 + t * dx)).powi(2) + (p.1 - (a.1 + t * dy)).powi(2)).sqrt()
}

/// Douglas-Peucker on a closed ring: split at the corner farthest from the first, then thin each half.
fn simplify(ring: &[(i64, i64)], epsilon: f64) -> Vec<(i64, i64)> {
    if epsilon <= 0.0 || ring.len() <= 4 { return ring.to_vec(); }
    let point = |index: usize| (ring[index].0 as f64, ring[index].1 as f64);
    let far = (1..ring.len())
        .max_by(|&a, &b| {
            let da = (point(a).0 - point(0).0).powi(2) + (point(a).1 - point(0).1).powi(2);
            let db = (point(b).0 - point(0).0).powi(2) + (point(b).1 - point(0).1).powi(2);
            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(1);
    let mut keep = vec![false; ring.len()];
    keep[0] = true;
    keep[far] = true;
    // Spans (first, last) over the ring indices, the second wrapping back to index 0.
    let mut stack = vec![(0usize, far), (far, ring.len())];
    while let Some((first, last)) = stack.pop() {
        if last <= first + 1 { continue; }
        let (a, b) = (point(first), point(last % ring.len()));
        let mut worst = (0.0f64, first);
        for index in first + 1..last {
            let distance = distance_to_segment(point(index), a, b);
            if distance > worst.0 { worst = (distance, index); }
        }
        if worst.0 > epsilon {
            keep[worst.1] = true;
            stack.push((first, worst.1));
            stack.push((worst.1, last));
        }
    }
    let thinned: Vec<(i64, i64)> = ring.iter().zip(&keep).filter(|&(_, &kept)| kept).map(|(&corner, _)| corner).collect();
    if thinned.len() < 3 { ring.to_vec() } else { thinned }
}

/// Trace a mask whose pixel `i` (row-major) has the label `label(i)`.
pub fn trace<F: Fn(usize) -> u32>(label: F, width: usize, height: usize, epsilon: f64) -> Result<Traced, MaskError> {
    if width == 0 || height == 0 { return Err(MaskError::Shape); }
    let mask = Mask { label: &label, width: width as i64, height: height as i64 };
    let mut visited = vec![0u64; (width * height).div_ceil(64)];
    // The largest piece per label so far: its area and thinned ring.
    let mut best: HashMap<u32, (i64, Vec<(i64, i64)>)> = HashMap::new();
    for y in 0..height as i64 {
        for x in 0..width as i64 {
            let value = mask.at(x, y);
            if value == 0 || mask.at(x, y - 1) == value { continue; }
            let at = (y * mask.width + x) as usize;
            if visited[at >> 6] & (1 << (at & 63)) != 0 { continue; }
            let ring = follow(&mask, value, x, y, &mut visited)?;
            let area = twice_area(&ring);
            if area <= 0 { continue; }
            if best.get(&value).is_some_and(|(kept, _)| *kept >= area) { continue; }
            best.insert(value, (area, simplify(&ring, epsilon)));
        }
    }
    let mut labels: Vec<u32> = best.keys().copied().collect();
    labels.sort_unstable();
    let mut out = Traced::default();
    out.offsets.push(0);
    for label in labels {
        for &(cx, cy) in &best[&label].1 {
            out.xy.push(cx as f32);
            out.xy.push(cy as f32);
        }
        out.labels.push(label);
        out.offsets.push((out.xy.len() / 2) as u32);
    }
    Ok(out)
}

thread_local! { static TRACED: RefCell<Traced> = RefCell::new(Traced::default()); }

/// Trace the mask of `width` x `height` samples of `bytes` (1, 2 or 4, little-endian) at `data`.
/// Returns 0, or 1 for a bad shape and 2 for a ring that did not close.
///
/// # Safety
/// `data` must be valid for `width * height * bytes` bytes.
#[no_mangle]
pub unsafe extern "C" fn mask_trace(data: *const u8, width: usize, height: usize, bytes: usize, epsilon: f32) -> i32 {
    if !matches!(bytes, 1 | 2 | 4) || width.checked_mul(height).and_then(|n| n.checked_mul(bytes)).is_none() { return 1; }
    if width == 0 || height == 0 { return 1; }
    let samples = std::slice::from_raw_parts(data, width * height * bytes);
    let result = match bytes {
        1 => trace(|i| u32::from(samples[i]), width, height, f64::from(epsilon)),
        2 => trace(|i| u32::from(u16::from_le_bytes([samples[2 * i], samples[2 * i + 1]])), width, height, f64::from(epsilon)),
        _ => trace(|i| u32::from_le_bytes([samples[4 * i], samples[4 * i + 1], samples[4 * i + 2], samples[4 * i + 3]]), width, height, f64::from(epsilon)),
    };
    match result {
        Ok(traced) => { TRACED.with(|state| *state.borrow_mut() = traced); 0 }
        Err(MaskError::Shape) => 1,
        Err(MaskError::Open) => 2,
    }
}

#[no_mangle]
pub extern "C" fn mask_polygons() -> usize { TRACED.with(|state| state.borrow().labels.len()) }
#[no_mangle]
pub extern "C" fn mask_vertices() -> usize { TRACED.with(|state| state.borrow().xy.len() / 2) }
#[no_mangle]
pub extern "C" fn mask_labels_ptr() -> *const u32 { TRACED.with(|state| state.borrow().labels.as_ptr()) }
#[no_mangle]
pub extern "C" fn mask_offsets_ptr() -> *const u32 { TRACED.with(|state| state.borrow().offsets.as_ptr()) }
#[no_mangle]
pub extern "C" fn mask_xy_ptr() -> *const f32 { TRACED.with(|state| state.borrow().xy.as_ptr()) }
#[no_mangle]
pub extern "C" fn mask_clear() { TRACED.with(|state| *state.borrow_mut() = Traced::default()); }

#[cfg(test)]
mod tests {
    use super::*;

    fn run(rows: &[&str], epsilon: f64) -> Traced {
        let height = rows.len();
        let width = rows[0].len();
        let pixels: Vec<u32> = rows.iter().flat_map(|row| row.bytes().map(|b| if b == b'.' { 0 } else { u32::from(b - b'0') })).collect();
        trace(|i| pixels[i], width, height, epsilon).unwrap()
    }

    fn ring(traced: &Traced, polygon: usize) -> Vec<(f32, f32)> {
        let (a, b) = (traced.offsets[polygon] as usize, traced.offsets[polygon + 1] as usize);
        (a..b).map(|i| (traced.xy[2 * i], traced.xy[2 * i + 1])).collect()
    }

    fn area(ring: &[(f32, f32)]) -> f32 {
        (0..ring.len()).map(|i| { let (x0, y0) = ring[i]; let (x1, y1) = ring[(i + 1) % ring.len()]; x0 * y1 - x1 * y0 }).sum::<f32>() / 2.0
    }

    #[test]
    fn a_square_is_four_corners() {
        let traced = run(&["....", ".11.", ".11.", "...."], 0.0);
        assert_eq!(traced.labels, vec![1]);
        assert_eq!(ring(&traced, 0), vec![(1.0, 1.0), (3.0, 1.0), (3.0, 3.0), (1.0, 3.0)]);
    }

    #[test]
    fn an_l_shape_keeps_its_area() {
        let traced = run(&["11.", "11.", "111"], 0.0);
        assert_eq!(traced.labels, vec![1]);
        assert_eq!(area(&ring(&traced, 0)), 7.0);
        assert_eq!(ring(&traced, 0).len(), 6);
    }

    #[test]
    fn touching_labels_each_get_a_polygon() {
        let traced = run(&["1122", "1122"], 0.0);
        assert_eq!(traced.labels, vec![1, 2]);
        assert_eq!(area(&ring(&traced, 0)), 4.0);
        assert_eq!(area(&ring(&traced, 1)), 4.0);
    }

    #[test]
    fn a_hole_is_dropped() {
        let traced = run(&["111", "1.1", "111"], 0.0);
        assert_eq!(traced.labels, vec![1]);
        assert_eq!(area(&ring(&traced, 0)), 9.0);
    }

    #[test]
    fn a_label_inside_a_hole_is_its_own_polygon() {
        let traced = run(&["11111", "1...1", "1.2.1", "1...1", "11111"], 0.0);
        assert_eq!(traced.labels, vec![1, 2]);
        assert_eq!(area(&ring(&traced, 1)), 1.0);
    }

    #[test]
    fn diagonal_pieces_are_separate_and_only_the_largest_is_kept() {
        let traced = run(&["1.", ".1"], 0.0);
        assert_eq!(traced.labels, vec![1]);
        assert_eq!(area(&ring(&traced, 0)), 1.0);
        let traced = run(&["11.", "11.", "..1"], 0.0);
        assert_eq!(traced.labels, vec![1]);
        assert_eq!(area(&ring(&traced, 0)), 4.0);
    }

    #[test]
    fn polygons_come_out_in_label_order() {
        let traced = run(&["3.1", "3.2"], 0.0);
        assert_eq!(traced.labels, vec![1, 2, 3]);
    }

    #[test]
    fn a_mask_with_nothing_in_it_has_no_polygons() {
        let traced = run(&["...", "..."], 0.5);
        assert!(traced.labels.is_empty());
        assert_eq!(traced.offsets, vec![0]);
    }

    #[test]
    fn simplifying_keeps_a_disc_close_to_its_area() {
        let size = 41usize;
        let rows: Vec<String> = (0..size).map(|y| (0..size).map(|x| {
            let (dx, dy) = (x as f64 - 20.0, y as f64 - 20.0);
            if dx * dx + dy * dy <= 15.0 * 15.0 { '1' } else { '.' }
        }).collect()).collect();
        let refs: Vec<&str> = rows.iter().map(String::as_str).collect();
        let exact = run(&refs, 0.0);
        let thin = run(&refs, 0.75);
        assert!(thin.xy.len() < exact.xy.len() * 6 / 10, "{} vs {}", thin.xy.len(), exact.xy.len());
        let (a, b) = (area(&ring(&exact, 0)), area(&ring(&thin, 0)));
        assert!((a - b).abs() / a < 0.03, "{a} vs {b}");
    }

    #[test]
    fn samples_are_read_little_endian_at_each_width() {
        let bytes16: Vec<u8> = [0u16, 258, 258, 0].iter().flat_map(|v| v.to_le_bytes()).collect();
        let bytes32: Vec<u8> = [0u32, 70000, 70000, 0].iter().flat_map(|v| v.to_le_bytes()).collect();
        let bytes8 = [0u8, 7, 7, 0];
        unsafe {
            assert_eq!(mask_trace(bytes8.as_ptr(), 2, 2, 1, 0.0), 0);
            assert_eq!(TRACED.with(|s| s.borrow().labels.clone()), vec![7, 7]);
            assert_eq!(mask_trace(bytes16.as_ptr(), 2, 2, 2, 0.0), 0);
            assert_eq!(TRACED.with(|s| s.borrow().labels.clone()), vec![258, 258]);
            assert_eq!(mask_trace(bytes32.as_ptr(), 2, 2, 4, 0.0), 0);
            assert_eq!(TRACED.with(|s| s.borrow().labels.clone()), vec![70000, 70000]);
            assert_eq!(mask_trace(bytes8.as_ptr(), 2, 2, 3, 0.0), 1);
            assert_eq!(mask_trace(bytes8.as_ptr(), 0, 2, 1, 0.0), 1);
        }
    }

    #[test]
    fn a_large_mask_traces_every_cell_once() {
        let (cells, size) = (50usize, 10usize);
        let width = cells * size;
        let trace_all = trace(|i| { let (x, y) = (i % width, i / width); ((y / size) * cells + x / size + 1) as u32 }, width, width, 0.0).unwrap();
        assert_eq!(trace_all.labels.len(), cells * cells);
        assert!(trace_all.labels.windows(2).all(|w| w[0] < w[1]));
    }
}

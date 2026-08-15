//! Mask morphology: hole filling and the Euclidean distance transform.
//!
//! Ports of `fillMaskHoles` and `distanceTransform` from
//! `media/modules/measure/particles.ts`. Both walk the whole raster and both
//! feed particle analysis, so they run on full-resolution masks.

/// Fills interior holes by flooding the background inward from outside the image.
///
/// The flood runs on a one-pixel padded border so a hole touching the image
/// edge is still reachable from outside; anything the flood cannot reach is
/// enclosed and therefore filled.
pub(crate) fn fill_mask_holes(mask: &[u8], width: usize, height: usize) -> Vec<u8> {
    let pixels = width.saturating_mul(height);
    if pixels == 0 || mask.len() < pixels {
        return vec![0; pixels.min(mask.len())];
    }
    let padded_width = width + 2;
    let padded_height = height + 2;
    let mut outside = vec![0u8; padded_width * padded_height];
    let mut stack: Vec<i32> = Vec::with_capacity(padded_width * padded_height);

    stack.push(0);
    outside[0] = 1;

    let is_background = |px: isize, py: isize| -> bool {
        let x = px - 1;
        let y = py - 1;
        if x < 0 || y < 0 || x >= width as isize || y >= height as isize {
            return true;
        }
        mask[y as usize * width + x as usize] == 0
    };

    while let Some(index) = stack.pop() {
        let index = index as usize;
        let px = (index % padded_width) as isize;
        let py = (index / padded_width) as isize;
        let mut push = |nx: isize, ny: isize, outside: &mut Vec<u8>, stack: &mut Vec<i32>| {
            if nx < 0 || ny < 0 || nx >= padded_width as isize || ny >= padded_height as isize {
                return;
            }
            let neighbour = ny as usize * padded_width + nx as usize;
            if outside[neighbour] != 0 || !is_background(nx, ny) {
                return;
            }
            outside[neighbour] = 1;
            stack.push(neighbour as i32);
        };
        push(px - 1, py, &mut outside, &mut stack);
        push(px + 1, py, &mut outside, &mut stack);
        push(px, py - 1, &mut outside, &mut stack);
        push(px, py + 1, &mut outside, &mut stack);
    }

    let mut filled = vec![0u8; pixels];
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            let unreachable = outside[(y + 1) * padded_width + (x + 1)] == 0;
            filled[index] = if mask[index] != 0 || unreachable { 1 } else { 0 };
        }
    }
    filled
}

const INF: f64 = 1e20;

/// Felzenszwalb–Huttenlocher lower envelope of parabolas, one axis at a time.
///
/// `f` is the input row/column, `d` receives the transformed values. `v` and
/// `z` are the parabola sites and their intersection boundaries, allocated by
/// the caller so the two-pass transform reuses them.
fn transform_1d(f: &[f64], d: &mut [f64], v: &mut [i32], z: &mut [f64], n: usize) {
    if n == 0 {
        return;
    }
    let mut k: usize = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for q in 1..n {
        let qf = q as f64;
        let mut s = {
            let vk = v[k] as f64;
            ((f[q] + qf * qf) - (f[v[k] as usize] + vk * vk)) / (2.0 * qf - 2.0 * vk)
        };
        while s <= z[k] {
            // `k` cannot underflow: z[0] is -INF, so the loop always stops.
            k = k.saturating_sub(1);
            let vk = v[k] as f64;
            s = ((f[q] + qf * qf) - (f[v[k] as usize] + vk * vk)) / (2.0 * qf - 2.0 * vk);
            if k == 0 && s <= z[0] {
                break;
            }
        }
        k += 1;
        v[k] = q as i32;
        z[k] = s;
        z[k + 1] = INF;
    }
    k = 0;
    for q in 0..n {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let dv = q as f64 - v[k] as f64;
        d[q] = dv * dv + f[v[k] as usize];
    }
}

/// Squared Euclidean distance from every set pixel to the nearest background
/// pixel. Matches the TypeScript, which also returns SQUARED distances.
pub(crate) fn distance_transform(mask: &[u8], width: usize, height: usize) -> Vec<f64> {
    let pixels = width.saturating_mul(height);
    if pixels == 0 || mask.len() < pixels {
        return vec![0.0; pixels.min(mask.len())];
    }
    let mut result = vec![0.0f64; pixels];
    for i in 0..pixels {
        result[i] = if mask[i] != 0 { INF } else { 0.0 };
    }

    let size = width.max(height);
    let mut f = vec![0.0f64; size];
    let mut d = vec![0.0f64; size];
    let mut v = vec![0i32; size];
    let mut z = vec![0.0f64; size + 1];

    for x in 0..width {
        for y in 0..height {
            f[y] = result[y * width + x];
        }
        transform_1d(&f, &mut d, &mut v, &mut z, height);
        for y in 0..height {
            result[y * width + x] = d[y];
        }
    }
    for y in 0..height {
        for x in 0..width {
            f[x] = result[y * width + x];
        }
        transform_1d(&f, &mut d, &mut v, &mut z, width);
        for x in 0..width {
            result[y * width + x] = d[x];
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_an_enclosed_hole_but_not_a_bay() {
        // Ring with a hole in the middle -> hole fills.
        let ring = [
            1, 1, 1,
            1, 0, 1,
            1, 1, 1,
        ];
        assert_eq!(fill_mask_holes(&ring, 3, 3), vec![1u8; 9]);

        // Same shape opened at the right edge: the gap connects to the outside,
        // so it must NOT be filled.
        let bay = [
            1, 1, 1,
            1, 0, 0,
            1, 1, 1,
        ];
        let filled = fill_mask_holes(&bay, 3, 3);
        assert_eq!(filled[4], 0, "a bay open to the border is not a hole");
    }

    #[test]
    fn distance_transform_matches_hand_computed_values() {
        // A 5x1 row of set pixels flanked by background: squared distance to
        // the nearest zero is 1,4,4,4,1 -> but the ends are adjacent to
        // background, so 1,4,9,4,1 for a 5-wide run bounded on both sides.
        let mask = [0u8, 1, 1, 1, 0];
        let d = distance_transform(&mask, 5, 1);
        assert_eq!(d[0], 0.0);
        assert_eq!(d[1], 1.0);
        assert_eq!(d[2], 4.0);
        assert_eq!(d[3], 1.0);
        assert_eq!(d[4], 0.0);
    }

    #[test]
    fn degenerate_inputs_do_not_panic() {
        assert!(fill_mask_holes(&[], 0, 0).is_empty());
        assert!(distance_transform(&[], 0, 0).is_empty());
        assert!(distance_transform(&[1], 4, 4).len() <= 1);
    }
}

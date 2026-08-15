//! Connected-component labelling.
//!
//! Port of `labelComponents` in `media/modules/measure/particles.ts`. This is
//! the measurement step that hurts most in JavaScript: it touches every pixel
//! of a full-resolution mask twice and chases union-find pointers in between,
//! so it scales with image size rather than with the number of objects.
//!
//! The algorithm is deliberately identical to the TypeScript it replaces —
//! single raster pass assigning provisional labels, union-find to merge them,
//! second pass resolving roots and renumbering densely — because
//! `test/measurement-test.js` compares particle counts and geometry against
//! values chosen to match ImageJ. A "better" algorithm that numbered objects
//! differently would fail those tests for the wrong reason.

/// Result of a labelling pass. `labels` is row-major, 0 = background, objects
/// numbered 1..=count in raster order of first appearance.
pub(crate) struct Labelled {
    pub labels: Vec<i32>,
    pub count: u32,
}

/// Union-find over provisional labels, with the same "smaller root wins"
/// tie-break the TypeScript uses. That choice is observable: it decides which
/// provisional label survives a merge, and therefore the dense renumbering.
struct UnionFind {
    parent: Vec<i32>,
}

impl UnionFind {
    fn new(capacity: usize) -> Self {
        UnionFind { parent: vec![0; capacity] }
    }

    fn find(&mut self, a: i32) -> i32 {
        let mut root = a;
        while self.parent[root as usize] != root {
            root = self.parent[root as usize];
        }
        // Path compression keeps the second pass near-linear on striped shapes.
        let mut node = a;
        while self.parent[node as usize] != root {
            let next = self.parent[node as usize];
            self.parent[node as usize] = root;
            node = next;
        }
        root
    }

    fn union(&mut self, a: i32, b: i32) {
        let root_a = self.find(a);
        let root_b = self.find(b);
        if root_a != root_b {
            self.parent[root_a.max(root_b) as usize] = root_a.min(root_b);
        }
    }
}

/// Labels connected runs of non-zero mask entries.
///
/// `connectivity` is 4 or 8; anything else is treated as 8, matching the
/// TypeScript default. Eight-connectivity is the default because objects
/// touching only at a corner are almost always one object in practice.
pub(crate) fn label_components(
    mask: &[u8],
    width: usize,
    height: usize,
    connectivity: u32,
) -> Labelled {
    let pixels = width.saturating_mul(height);
    if pixels == 0 || mask.len() < pixels {
        return Labelled { labels: vec![0; pixels.min(mask.len())], count: 0 };
    }

    let mut labels = vec![0i32; pixels];
    // Worst case is one provisional label per two pixels (a checkerboard).
    let mut uf = UnionFind::new(pixels / 2 + 2);
    let mut next_label: i32 = 1;
    let eight = connectivity != 4;

    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            if mask[index] == 0 {
                continue;
            }

            // Only already-visited neighbours are consulted, so a single
            // forward pass sees every adjacency exactly once.
            let mut best: i32 = 0;
            let mut consider = |nx: isize, ny: isize, labels: &[i32], uf: &mut UnionFind, best: &mut i32| {
                if nx < 0 || ny < 0 || nx >= width as isize || ny >= height as isize {
                    return;
                }
                let neighbour = labels[ny as usize * width + nx as usize];
                if neighbour == 0 {
                    return;
                }
                if *best == 0 {
                    *best = neighbour;
                } else {
                    uf.union(*best, neighbour);
                    *best = (*best).min(neighbour);
                }
            };

            let (xi, yi) = (x as isize, y as isize);
            consider(xi - 1, yi, &labels, &mut uf, &mut best);
            consider(xi, yi - 1, &labels, &mut uf, &mut best);
            if eight {
                consider(xi - 1, yi - 1, &labels, &mut uf, &mut best);
                consider(xi + 1, yi - 1, &labels, &mut uf, &mut best);
            }

            if best == 0 {
                // Running out of provisional labels stops labelling entirely,
                // as in the TypeScript: the remaining pixels stay background
                // rather than being merged into an arbitrary object.
                if next_label as usize >= uf.parent.len() {
                    break;
                }
                uf.parent[next_label as usize] = next_label;
                labels[index] = next_label;
                next_label += 1;
            } else {
                labels[index] = best;
            }
        }
    }

    // Second pass: resolve to root labels and renumber them densely, so the
    // caller sees 1..=count with no gaps.
    let mut remap = vec![0i32; next_label.max(1) as usize];
    let mut count: i32 = 0;
    for i in 0..labels.len() {
        let label = labels[i];
        if label == 0 {
            continue;
        }
        let root = uf.find(label);
        if remap[root as usize] == 0 {
            count += 1;
            remap[root as usize] = count;
        }
        labels[i] = remap[root as usize];
    }

    Labelled { labels, count: count.max(0) as u32 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separates_diagonal_objects_by_connectivity() {
        // Two pixels touching only at a corner: one object under
        // 8-connectivity, two under 4-connectivity.
        let mask = [1u8, 0, 0, 1];
        assert_eq!(label_components(&mask, 2, 2, 8).count, 1);
        assert_eq!(label_components(&mask, 2, 2, 4).count, 2);
    }

    #[test]
    fn renumbers_densely_after_merges() {
        // A U shape: the two arms get separate provisional labels that merge
        // on the bottom row, so the result must be a single object numbered 1.
        let mask = [
            1, 0, 1,
            1, 0, 1,
            1, 1, 1,
        ];
        let out = label_components(&mask, 3, 3, 4);
        assert_eq!(out.count, 1);
        assert!(out.labels.iter().all(|&l| l == 0 || l == 1));
    }

    #[test]
    fn empty_and_degenerate_inputs_do_not_panic() {
        assert_eq!(label_components(&[], 0, 0, 8).count, 0);
        assert_eq!(label_components(&[0, 0], 2, 1, 8).count, 0);
        // Mask shorter than width*height must not index out of bounds.
        assert_eq!(label_components(&[1], 4, 4, 8).count, 0);
    }
}

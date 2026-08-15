//! Measurement algorithms (Phase 3 of the Rust migration).
//!
//! Pure compute over rasters and masks: no DOM, no GPU, no VS Code API. ROI
//! drawing and hit-testing stay in TypeScript — they are canvas and pointer
//! code, which is the other side of this repository's Rust/TS boundary rule.

pub(crate) mod components;
pub(crate) mod filters;
pub(crate) mod morphology;
pub(crate) mod threshold;

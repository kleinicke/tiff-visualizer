mod adjustments;
mod blend;

use adjustments::{
    apply_direct_adjustment, configured_hue_range_weight_f32, hsl_to_rgb_f32, rgb_to_hsl_f32,
    validate_direct_adjustment,
};
use blend::{arithmetic_layer_channel, composite_rgba_channel};
use wasm_bindgen::prelude::*;

/// Persistent full-resolution RGBA compositor used by the layer worker.
///
/// Keeping the accumulation buffer in WASM is important: only each source
/// layer crosses the JS/WASM boundary once and only the finished composite is
/// copied back. The TypeScript compositor remains the correctness fallback for
/// hierarchy, masks, adjustments, arithmetic modes, and non-RGBA stacks.
#[wasm_bindgen]
pub struct RgbaLayerCompositor {
    width: u32,
    height: u32,
    type_max: f32,
    data: Vec<f32>,
    isolated: Option<Vec<f32>>,
    isolated_clip_alpha: Option<Vec<f32>>,
    isolated_snapshot: Option<Vec<f32>>,
    covered_count: u32,
}

#[wasm_bindgen]
impl RgbaLayerCompositor {
    fn validate_mask<T>(
        &self,
        mask: &[T],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
    ) -> Result<(), JsValue> {
        if channels == 0 {
            return Err(JsValue::from_str("Raster mask must have at least one channel"));
        }
        self.validate_type_max(type_max)?;
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(channels as usize))
            .ok_or_else(|| JsValue::from_str("Raster mask dimensions overflow"))?;
        if mask.len() != expected {
            return Err(JsValue::from_str(
                "Raster mask length does not match its dimensions",
            ));
        }
        Ok(())
    }

    fn mask_factor<T, F>(
        mask: &[T],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
        offset_x: i32,
        offset_y: i32,
        invert: bool,
        canvas_x: u32,
        canvas_y: u32,
        convert: &F,
    ) -> f32
    where
        F: Fn(&T) -> f32,
    {
        let mask_x = canvas_x as i64 - offset_x as i64;
        let mask_y = canvas_y as i64 - offset_y as i64;
        let mut factor = if mask_x < 0
            || mask_y < 0
            || mask_x >= width as i64
            || mask_y >= height as i64
        {
            0.0
        } else {
            let index =
                (mask_y as usize * width as usize + mask_x as usize) * channels as usize;
            let value = convert(&mask[index]);
            if value.is_finite() {
                (value / type_max).clamp(0.0, 1.0)
            } else {
                0.0
            }
        };
        if invert {
            factor = 1.0 - factor;
        }
        factor
    }

    fn apply_isolated_alpha_mask<T, F>(
        &mut self,
        mask: &[T],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
        offset_x: i32,
        offset_y: i32,
        invert: bool,
        convert: F,
    ) -> Result<(), JsValue>
    where
        F: Fn(&T) -> f32,
    {
        self.validate_mask(mask, width, height, channels, type_max)?;
        let canvas_width = self.width;
        let mut clip_alpha = self.isolated_clip_alpha.as_mut();
        let surface = self
            .isolated
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        for (pixel_index, pixel) in surface.chunks_exact_mut(4).enumerate() {
            let x = pixel_index as u32 % canvas_width;
            let y = pixel_index as u32 / canvas_width;
            let factor = Self::mask_factor(
                mask, width, height, channels, type_max, offset_x, offset_y, invert, x, y,
                &convert,
            );
            pixel[3] *= factor;
            if let Some(alpha) = clip_alpha.as_deref_mut() {
                alpha[pixel_index] *= factor;
            }
        }
        Ok(())
    }

    fn finish_isolated_masked_adjustment<T, F>(
        &mut self,
        mask: &[T],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
        offset_x: i32,
        offset_y: i32,
        invert: bool,
        convert: F,
    ) -> Result<(), JsValue>
    where
        F: Fn(&T) -> f32,
    {
        self.validate_mask(mask, width, height, channels, type_max)?;
        let original = self
            .isolated_snapshot
            .take()
            .ok_or_else(|| JsValue::from_str("No masked adjustment snapshot is active"))?;
        let canvas_width = self.width;
        let adjusted = self
            .isolated
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        for (pixel_index, (output, before)) in adjusted
            .chunks_exact_mut(4)
            .zip(original.chunks_exact(4))
            .enumerate()
        {
            let x = pixel_index as u32 % canvas_width;
            let y = pixel_index as u32 / canvas_width;
            let factor = Self::mask_factor(
                mask, width, height, channels, type_max, offset_x, offset_y, invert, x, y,
                &convert,
            );
            for channel in 0..3 {
                output[channel] = before[channel] + (output[channel] - before[channel]) * factor;
            }
            output[3] = before[3];
        }
        Ok(())
    }

    fn add_channels<T, F>(
        &mut self,
        source: &[T],
        width: u32,
        height: u32,
        channels: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
        convert: F,
    ) -> Result<(), JsValue>
    where
        F: Fn(&T) -> f32,
    {
        if !(1..=4).contains(&channels) {
            return Err(JsValue::from_str("Layer source must have one to four channels"));
        }
        self.validate_type_max(source_type_max)?;
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(channels as usize))
            .ok_or_else(|| JsValue::from_str("Layer source dimensions overflow"))?;
        if source.len() != expected {
            return Err(JsValue::from_str(
                "Layer source length does not match its dimensions and channel count",
            ));
        }
        self.add_source_channels(
            width,
            height,
            channels,
            offset_x,
            offset_y,
            opacity,
            blend_mode,
            source_type_max,
            |index| convert(&source[index]),
        );
        Ok(())
    }

    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32, type_max: f32) -> Result<RgbaLayerCompositor, JsValue> {
        if width == 0 || height == 0 || !type_max.is_finite() || type_max <= 0.0 {
            return Err(JsValue::from_str("Invalid RGBA compositor dimensions or type maximum"));
        }
        let pixel_count = (width as usize)
            .checked_mul(height as usize)
            .ok_or_else(|| JsValue::from_str("RGBA compositor dimensions overflow"))?;
        let value_count = pixel_count
            .checked_mul(4)
            .ok_or_else(|| JsValue::from_str("RGBA compositor allocation overflow"))?;
        Ok(RgbaLayerCompositor {
            width,
            height,
            type_max,
            data: vec![0.0; value_count],
            isolated: None,
            isolated_clip_alpha: None,
            isolated_snapshot: None,
            covered_count: 0,
        })
    }

    pub fn add_u8(
        &mut self,
        source: &[u8],
        width: u32,
        height: u32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.validate_source(source.len(), width, height)?;
        self.add_source(width, height, offset_x, offset_y, opacity, blend_mode, 255.0, |index| {
            source[index] as f32
        });
        Ok(())
    }

    pub fn add_u16(
        &mut self,
        source: &[u16],
        width: u32,
        height: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.validate_source(source.len(), width, height)?;
        self.validate_type_max(source_type_max)?;
        self.add_source(width, height, offset_x, offset_y, opacity, blend_mode, source_type_max, |index| {
            source[index] as f32
        });
        Ok(())
    }

    pub fn add_f32(
        &mut self,
        source: &[f32],
        width: u32,
        height: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.validate_source(source.len(), width, height)?;
        self.validate_type_max(source_type_max)?;
        self.add_source(width, height, offset_x, offset_y, opacity, blend_mode, source_type_max, |index| {
            source[index]
        });
        Ok(())
    }

    pub fn add_channels_u8(
        &mut self,
        source: &[u8],
        width: u32,
        height: u32,
        channels: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.add_channels(
            source,
            width,
            height,
            channels,
            source_type_max,
            offset_x,
            offset_y,
            opacity,
            blend_mode,
            |value| *value as f32,
        )
    }

    pub fn add_channels_u16(
        &mut self,
        source: &[u16],
        width: u32,
        height: u32,
        channels: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.add_channels(
            source,
            width,
            height,
            channels,
            source_type_max,
            offset_x,
            offset_y,
            opacity,
            blend_mode,
            |value| *value as f32,
        )
    }

    pub fn add_channels_u32(
        &mut self,
        source: &[u32],
        width: u32,
        height: u32,
        channels: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.add_channels(
            source,
            width,
            height,
            channels,
            source_type_max,
            offset_x,
            offset_y,
            opacity,
            blend_mode,
            |value| *value as f32,
        )
    }

    pub fn add_channels_i8(
        &mut self,
        source: &[i8],
        width: u32,
        height: u32,
        channels: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.add_channels(
            source,
            width,
            height,
            channels,
            source_type_max,
            offset_x,
            offset_y,
            opacity,
            blend_mode,
            |value| *value as f32,
        )
    }

    pub fn add_channels_i16(
        &mut self,
        source: &[i16],
        width: u32,
        height: u32,
        channels: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.add_channels(
            source,
            width,
            height,
            channels,
            source_type_max,
            offset_x,
            offset_y,
            opacity,
            blend_mode,
            |value| *value as f32,
        )
    }

    pub fn add_channels_i32(
        &mut self,
        source: &[i32],
        width: u32,
        height: u32,
        channels: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.add_channels(
            source,
            width,
            height,
            channels,
            source_type_max,
            offset_x,
            offset_y,
            opacity,
            blend_mode,
            |value| *value as f32,
        )
    }

    pub fn add_channels_f32(
        &mut self,
        source: &[f32],
        width: u32,
        height: u32,
        channels: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.add_channels(
            source,
            width,
            height,
            channels,
            source_type_max,
            offset_x,
            offset_y,
            opacity,
            blend_mode,
            |value| *value,
        )
    }

    pub fn add_channels_f64(
        &mut self,
        source: &[f64],
        width: u32,
        height: u32,
        channels: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.add_channels(
            source,
            width,
            height,
            channels,
            source_type_max,
            offset_x,
            offset_y,
            opacity,
            blend_mode,
            |value| *value as f32,
        )
    }

    /// Start an isolated clipping surface from one 8-bit RGBA raster. Filters
    /// modify this straight-colour surface before its original blend mode and
    /// opacity are applied to the main document.
    pub fn begin_isolated_u8(
        &mut self,
        source: &[u8],
        width: u32,
        height: u32,
        offset_x: i32,
        offset_y: i32,
    ) -> Result<(), JsValue> {
        let mut surface = RgbaLayerCompositor::new(self.width, self.height, self.type_max)?;
        surface.add_u8(source, width, height, offset_x, offset_y, 1.0, 0)?;
        self.isolated_clip_alpha = Some(surface.data.chunks_exact(4).map(|pixel| pixel[3]).collect());
        self.isolated = Some(surface.data);
        Ok(())
    }

    pub fn begin_isolated_u16(
        &mut self,
        source: &[u16],
        width: u32,
        height: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
    ) -> Result<(), JsValue> {
        let mut surface = RgbaLayerCompositor::new(self.width, self.height, self.type_max)?;
        surface.add_u16(
            source,
            width,
            height,
            source_type_max,
            offset_x,
            offset_y,
            1.0,
            0,
        )?;
        self.isolated_clip_alpha = Some(surface.data.chunks_exact(4).map(|pixel| pixel[3]).collect());
        self.isolated = Some(surface.data);
        Ok(())
    }

    pub fn begin_isolated_f32(
        &mut self,
        source: &[f32],
        width: u32,
        height: u32,
        source_type_max: f32,
        offset_x: i32,
        offset_y: i32,
    ) -> Result<(), JsValue> {
        let mut surface = RgbaLayerCompositor::new(self.width, self.height, self.type_max)?;
        surface.add_f32(
            source,
            width,
            height,
            source_type_max,
            offset_x,
            offset_y,
            1.0,
            0,
        )?;
        self.isolated_clip_alpha = Some(surface.data.chunks_exact(4).map(|pixel| pixel[3]).collect());
        self.isolated = Some(surface.data);
        Ok(())
    }

    pub fn isolated_apply_alpha_mask_u8(
        &mut self,
        mask: &[u8],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
        offset_x: i32,
        offset_y: i32,
        invert: bool,
    ) -> Result<(), JsValue> {
        self.apply_isolated_alpha_mask(
            mask, width, height, channels, type_max, offset_x, offset_y, invert,
            |value| *value as f32,
        )
    }

    pub fn isolated_apply_alpha_mask_u16(
        &mut self,
        mask: &[u16],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
        offset_x: i32,
        offset_y: i32,
        invert: bool,
    ) -> Result<(), JsValue> {
        self.apply_isolated_alpha_mask(
            mask, width, height, channels, type_max, offset_x, offset_y, invert,
            |value| *value as f32,
        )
    }

    pub fn isolated_apply_alpha_mask_f32(
        &mut self,
        mask: &[f32],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
        offset_x: i32,
        offset_y: i32,
        invert: bool,
    ) -> Result<(), JsValue> {
        self.apply_isolated_alpha_mask(
            mask, width, height, channels, type_max, offset_x, offset_y, invert,
            |value| *value,
        )
    }

    pub fn isolated_begin_masked_adjustment(&mut self) -> Result<(), JsValue> {
        let surface = self
            .isolated
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        self.isolated_snapshot = Some(surface.clone());
        Ok(())
    }

    pub fn isolated_finish_masked_adjustment_u8(
        &mut self,
        mask: &[u8],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
        offset_x: i32,
        offset_y: i32,
        invert: bool,
    ) -> Result<(), JsValue> {
        self.finish_isolated_masked_adjustment(
            mask, width, height, channels, type_max, offset_x, offset_y, invert,
            |value| *value as f32,
        )
    }

    pub fn isolated_finish_masked_adjustment_u16(
        &mut self,
        mask: &[u16],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
        offset_x: i32,
        offset_y: i32,
        invert: bool,
    ) -> Result<(), JsValue> {
        self.finish_isolated_masked_adjustment(
            mask, width, height, channels, type_max, offset_x, offset_y, invert,
            |value| *value as f32,
        )
    }

    pub fn isolated_finish_masked_adjustment_f32(
        &mut self,
        mask: &[f32],
        width: u32,
        height: u32,
        channels: u32,
        type_max: f32,
        offset_x: i32,
        offset_y: i32,
        invert: bool,
    ) -> Result<(), JsValue> {
        self.finish_isolated_masked_adjustment(
            mask, width, height, channels, type_max, offset_x, offset_y, invert,
            |value| *value,
        )
    }

    /// Apply three 256-entry channel LUTs to the active isolated surface.
    /// Values in the LUT use the compositor's native value range.
    pub fn isolated_apply_lut(&mut self, tables: &[f32], amount: f32) -> Result<(), JsValue> {
        if tables.len() != 256 * 3 {
            return Err(JsValue::from_str(
                "Layer adjustment LUT must contain three 256-entry tables",
            ));
        }
        let amount = amount.clamp(0.0, 1.0);
        let type_max = self.type_max;
        let surface = self
            .isolated
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        if amount <= 0.0 {
            return Ok(());
        }
        for pixel in surface.chunks_exact_mut(4) {
            if pixel[3] <= 0.0 {
                continue;
            }
            for channel in 0..3 {
                let original = pixel[channel];
                if !original.is_finite() {
                    continue;
                }
                let position = (original * 255.0 / type_max).clamp(0.0, 255.0);
                let low = position.floor() as usize;
                let high = (low + 1).min(255);
                let fraction = position - low as f32;
                let base = channel * 256;
                let adjusted =
                    tables[base + low] + (tables[base + high] - tables[base + low]) * fraction;
                pixel[channel] = original + (adjusted - original) * amount;
            }
        }
        Ok(())
    }

    pub fn isolated_apply_hue(
        &mut self,
        hue_degrees: f32,
        saturation_delta: f32,
        lightness_delta: f32,
        colorize: bool,
        amount: f32,
    ) -> Result<(), JsValue> {
        let amount = amount.clamp(0.0, 1.0);
        let type_max = self.type_max;
        let surface = self
            .isolated
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        if amount <= 0.0 {
            return Ok(());
        }
        for pixel in surface.chunks_exact_mut(4) {
            if pixel[3] <= 0.0 || pixel[..3].iter().any(|value| !value.is_finite()) {
                continue;
            }
            let original = [pixel[0], pixel[1], pixel[2]];
            let (mut hue, mut saturation, mut lightness) = rgb_to_hsl_f32(
                original[0] / type_max,
                original[1] / type_max,
                original[2] / type_max,
            );
            if colorize {
                hue = hue_degrees.rem_euclid(360.0);
                saturation = saturation_delta.clamp(0.0, 1.0);
                let delta = lightness_delta.clamp(-1.0, 1.0);
                lightness = if delta < 0.0 {
                    lightness * (1.0 + delta)
                } else {
                    lightness + (1.0 - lightness) * delta
                };
            } else {
                hue = (hue + hue_degrees).rem_euclid(360.0);
                saturation = (saturation + saturation_delta).clamp(0.0, 1.0);
                lightness = (lightness + lightness_delta).clamp(0.0, 1.0);
            }
            let adjusted = hsl_to_rgb_f32(hue, saturation, lightness);
            for channel in 0..3 {
                let value = adjusted[channel] * type_max;
                pixel[channel] = original[channel] + (value - original[channel]) * amount;
            }
        }
        Ok(())
    }

    /// Apply master plus six selective hue/saturation ranges. `parameters`
    /// contains master H/S/L followed by six records of
    /// a/b/c/d/H/S/L for red, yellow, green, cyan, blue, and magenta.
    pub fn isolated_apply_selective_hue(
        &mut self,
        parameters: &[f32],
        amount: f32,
    ) -> Result<(), JsValue> {
        if parameters.len() != 45 {
            return Err(JsValue::from_str(
                "Selective hue parameters must contain 45 values",
            ));
        }
        let amount = amount.clamp(0.0, 1.0);
        let type_max = self.type_max;
        let surface = self
            .isolated
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        if amount <= 0.0 {
            return Ok(());
        }
        let centers = [0.0, 60.0, 120.0, 180.0, 240.0, 300.0];
        for pixel in surface.chunks_exact_mut(4) {
            if pixel[3] <= 0.0 || pixel[..3].iter().any(|value| !value.is_finite()) {
                continue;
            }
            let original = [pixel[0], pixel[1], pixel[2]];
            let (mut hue, mut saturation, mut lightness) = rgb_to_hsl_f32(
                original[0] / type_max,
                original[1] / type_max,
                original[2] / type_max,
            );
            let source_hue = hue;
            hue = (hue + parameters[0]).rem_euclid(360.0);
            saturation = (saturation + parameters[1] / 100.0).clamp(0.0, 1.0);
            lightness = (lightness + parameters[2] / 100.0).clamp(0.0, 1.0);
            for range in 0..6 {
                let base = 3 + range * 7;
                let weight = configured_hue_range_weight_f32(
                    source_hue,
                    [
                        parameters[base],
                        parameters[base + 1],
                        parameters[base + 2],
                        parameters[base + 3],
                    ],
                    centers[range],
                );
                hue = (hue + parameters[base + 4] * weight).rem_euclid(360.0);
                saturation =
                    (saturation + parameters[base + 5] / 100.0 * weight).clamp(0.0, 1.0);
                lightness =
                    (lightness + parameters[base + 6] / 100.0 * weight).clamp(0.0, 1.0);
            }
            let adjusted = hsl_to_rgb_f32(hue, saturation, lightness);
            for channel in 0..3 {
                let value = adjusted[channel] * type_max;
                pixel[channel] = original[channel] + (value - original[channel]) * amount;
            }
        }
        Ok(())
    }

    /// Apply the remaining pixel-local document adjustments. The operation
    /// codes and compact parameter layouts are defined by the layer worker:
    /// 2 brightness/contrast, 3 exposure, 4 invert, 5 channel mixer,
    /// 6 color balance, 7 black & white, 8 threshold, 9 posterize,
    /// 10 gradient-map LUT.
    pub fn isolated_apply_direct(
        &mut self,
        operation: u32,
        parameters: &[f32],
        amount: f32,
    ) -> Result<(), JsValue> {
        validate_direct_adjustment(operation, parameters)?;
        let amount = amount.clamp(0.0, 1.0);
        let type_max = self.type_max;
        let surface = self
            .isolated
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        if amount <= 0.0 {
            return Ok(());
        }
        for pixel in surface.chunks_exact_mut(4) {
            if pixel[3] <= 0.0 || pixel[..3].iter().any(|value| !value.is_finite()) {
                continue;
            }
            let original = [pixel[0], pixel[1], pixel[2]];
            let adjusted = apply_direct_adjustment(
                operation,
                parameters,
                [
                    original[0] / type_max,
                    original[1] / type_max,
                    original[2] / type_max,
                ],
            );
            for channel in 0..3 {
                let value = adjusted[channel] * type_max;
                pixel[channel] = original[channel] + (value - original[channel]) * amount;
            }
        }
        Ok(())
    }

    pub fn isolated_add_f32_surface(
        &mut self,
        source: &[f32],
        source_type_max: f32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.validate_source(source.len(), self.width, self.height)?;
        self.validate_type_max(source_type_max)?;
        let clip_alpha = self
            .isolated_clip_alpha
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No isolated clipping base is active"))?;
        let surface = self
            .isolated
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        let opacity = opacity.clamp(0.0, 1.0);
        let value_scale = self.type_max / source_type_max;
        for (pixel_index, output) in surface.chunks_exact_mut(4).enumerate() {
            let source_index = pixel_index * 4;
            let alpha_value = source[source_index + 3];
            let clip = clip_alpha[pixel_index] / self.type_max;
            if !alpha_value.is_finite() || !clip.is_finite() {
                output[0] = f32::NAN;
                output[1] = f32::NAN;
                output[2] = f32::NAN;
                output[3] = self.type_max;
                continue;
            }
            let source_alpha =
                (alpha_value / source_type_max * opacity * clip).clamp(0.0, 1.0);
            if source_alpha <= 0.0 {
                continue;
            }
            let destination_alpha = output[3] / self.type_max;
            let output_alpha = source_alpha + destination_alpha * (1.0 - source_alpha);
            for channel in 0..3 {
                output[channel] = composite_rgba_channel(
                    output[channel],
                    source[source_index + channel] * value_scale,
                    blend_mode,
                    source_alpha,
                    destination_alpha,
                    output_alpha,
                    self.type_max,
                );
            }
            output[3] = output_alpha * self.type_max;
        }
        Ok(())
    }

    pub fn isolated_add_arithmetic_f32_surface(
        &mut self,
        source: &[f32],
        source_type_max: f32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.validate_source(source.len(), self.width, self.height)?;
        self.validate_type_max(source_type_max)?;
        if !(8..=15).contains(&blend_mode) {
            return Err(JsValue::from_str("Invalid isolated arithmetic blend mode"));
        }
        let clip_alpha = self
            .isolated_clip_alpha
            .as_ref()
            .ok_or_else(|| JsValue::from_str("No isolated clipping base is active"))?;
        let output = self
            .isolated
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        let opacity = opacity.clamp(0.0, 1.0);
        for pixel_index in 0..(self.width as usize * self.height as usize) {
            let index = pixel_index * 4;
            let factor = (source[index + 3] / source_type_max
                * clip_alpha[pixel_index]
                / self.type_max
                * opacity)
                .clamp(0.0, 1.0);
            if factor <= 0.0 {
                continue;
            }
            let was_covered = output[index + 3] > 0.0;
            for channel in 0..3 {
                let value = source[index + channel];
                if !was_covered {
                    output[index + channel] = value;
                } else {
                    let below = output[index + channel];
                    let result = arithmetic_layer_channel(below, value, blend_mode);
                    output[index + channel] = if factor >= 1.0 {
                        result
                    } else if result.is_finite() && below.is_finite() {
                        below + (result - below) * factor
                    } else {
                        f32::NAN
                    };
                }
            }
            output[index + 3] = self.type_max;
        }
        Ok(())
    }

    pub fn apply_brightness_mask_f32_surface(
        &mut self,
        source: &[f32],
        source_type_max: f32,
        condition: u32,
        threshold: f32,
    ) -> Result<(), JsValue> {
        self.validate_source(source.len(), self.width, self.height)?;
        self.validate_type_max(source_type_max)?;
        let value_scale = self.type_max / source_type_max;
        for pixel_index in 0..(self.width as usize * self.height as usize) {
            let destination = pixel_index * 4;
            if self.data[destination + 3] <= 0.0 || source[destination + 3] <= 0.0 {
                continue;
            }
            let value = (0.2126 * source[destination]
                + 0.7152 * source[destination + 1]
                + 0.0722 * source[destination + 2])
                * value_scale;
            let keep = match condition {
                1 => value > threshold,
                2 => value >= threshold,
                3 => value < threshold,
                4 => value <= threshold,
                5 => value == threshold,
                6 => value.is_finite(),
                7 => !value.is_finite(),
                _ => true,
            };
            if !keep {
                self.data[destination] = 0.0;
                self.data[destination + 1] = 0.0;
                self.data[destination + 2] = 0.0;
                self.data[destination + 3] = 0.0;
                self.covered_count = self.covered_count.saturating_sub(1);
            }
        }
        Ok(())
    }

    pub fn add_arithmetic_f32_surface(
        &mut self,
        source: &[f32],
        source_type_max: f32,
        opacity: f32,
        blend_mode: u32,
    ) -> Result<(), JsValue> {
        self.validate_source(source.len(), self.width, self.height)?;
        self.validate_type_max(source_type_max)?;
        if !(8..=15).contains(&blend_mode) {
            return Err(JsValue::from_str("Invalid arithmetic layer blend mode"));
        }
        let opacity = opacity.clamp(0.0, 1.0);
        for pixel_index in 0..(self.width as usize * self.height as usize) {
            let index = pixel_index * 4;
            let factor = (source[index + 3] / source_type_max * opacity).clamp(0.0, 1.0);
            if factor <= 0.0 {
                continue;
            }
            let was_covered = self.data[index + 3] > 0.0;
            for channel in 0..3 {
                let value = source[index + channel];
                if !was_covered {
                    self.data[index + channel] = value;
                } else {
                    let below = self.data[index + channel];
                    let result = arithmetic_layer_channel(below, value, blend_mode);
                    self.data[index + channel] = if factor >= 1.0 {
                        result
                    } else if result.is_finite() && below.is_finite() {
                        below + (result - below) * factor
                    } else {
                        f32::NAN
                    };
                }
            }
            self.data[index + 3] = self.type_max;
            if !was_covered {
                self.covered_count += 1;
            }
        }
        Ok(())
    }

    pub fn take_isolated_surface(&mut self) -> Result<Vec<f32>, JsValue> {
        self.isolated_clip_alpha = None;
        self.isolated_snapshot = None;
        self.isolated
            .take()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))
    }

    pub fn finish_isolated(&mut self, opacity: f32, blend_mode: u32) -> Result<(), JsValue> {
        let surface = self
            .isolated
            .take()
            .ok_or_else(|| JsValue::from_str("No active isolated layer surface"))?;
        self.add_source(
            self.width,
            self.height,
            0,
            0,
            opacity,
            blend_mode,
            self.type_max,
            |index| surface[index],
        );
        self.isolated_clip_alpha = None;
        self.isolated_snapshot = None;
        Ok(())
    }

    #[wasm_bindgen(getter)]
    pub fn covered_count(&self) -> u32 {
        self.covered_count
    }

    #[wasm_bindgen(getter)]
    pub fn min_value(&self) -> f32 {
        self.stats().0
    }

    #[wasm_bindgen(getter)]
    pub fn max_value(&self) -> f32 {
        self.stats().1
    }

    pub fn take_data(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.data)
    }

    pub fn take_data_as_channels(&mut self, channels: u32) -> Result<Vec<f32>, JsValue> {
        if channels == 4 {
            return Ok(std::mem::take(&mut self.data));
        }
        if channels != 1 && channels != 3 {
            return Err(JsValue::from_str(
                "RGBA compositor output must use one, three, or four channels",
            ));
        }
        let mut output = Vec::with_capacity(
            (self.width as usize)
                .saturating_mul(self.height as usize)
                .saturating_mul(channels as usize),
        );
        for pixel in self.data.chunks_exact(4) {
            if pixel[3] <= 0.0 {
                for _ in 0..channels {
                    output.push(f32::NAN);
                }
            } else if channels == 1 {
                output.push(pixel[0]);
            } else {
                output.extend_from_slice(&pixel[..3]);
            }
        }
        self.data.clear();
        Ok(output)
    }
}

impl RgbaLayerCompositor {
    fn validate_source(&self, length: usize, width: u32, height: u32) -> Result<(), JsValue> {
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| JsValue::from_str("RGBA source dimensions overflow"))?;
        if length != expected {
            return Err(JsValue::from_str("RGBA source length does not match its dimensions"));
        }
        Ok(())
    }

    fn validate_type_max(&self, source_type_max: f32) -> Result<(), JsValue> {
        if !source_type_max.is_finite() || source_type_max <= 0.0 {
            return Err(JsValue::from_str("Invalid RGBA source type maximum"));
        }
        Ok(())
    }

    fn add_source<F>(
        &mut self,
        source_width: u32,
        source_height: u32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
        source_type_max: f32,
        sample: F,
    )
    where
        F: Fn(usize) -> f32,
    {
        let opacity = opacity.clamp(0.0, 1.0);
        if opacity <= 0.0 {
            return;
        }
        let x_start = offset_x.max(0) as u32;
        let y_start = offset_y.max(0) as u32;
        let x_end = self.width.min((offset_x as i64 + source_width as i64).max(0) as u32);
        let y_end = self.height.min((offset_y as i64 + source_height as i64).max(0) as u32);
        if x_start >= x_end || y_start >= y_end {
            return;
        }
        let value_scale = self.type_max / source_type_max;
        for y in y_start..y_end {
            let source_y = (y as i64 - offset_y as i64) as usize;
            for x in x_start..x_end {
                let source_x = (x as i64 - offset_x as i64) as usize;
                let source_index = (source_y * source_width as usize + source_x) * 4;
                let destination_index = (y as usize * self.width as usize + x as usize) * 4;
                let source_alpha_value = sample(source_index + 3);
                if !source_alpha_value.is_finite() {
                    self.cover_invalid(destination_index);
                    continue;
                }
                let source_alpha = (source_alpha_value / source_type_max * opacity).clamp(0.0, 1.0);
                if source_alpha <= 0.0 {
                    continue;
                }
                let destination_alpha = self.data[destination_index + 3] / self.type_max;
                let output_alpha = source_alpha + destination_alpha * (1.0 - source_alpha);
                let was_covered = destination_alpha > 0.0;
                for channel in 0..3 {
                    let source_value = sample(source_index + channel) * value_scale;
                    let below = self.data[destination_index + channel];
                    self.data[destination_index + channel] = composite_rgba_channel(
                        below,
                        source_value,
                        blend_mode,
                        source_alpha,
                        destination_alpha,
                        output_alpha,
                        self.type_max,
                    );
                }
                self.data[destination_index + 3] = output_alpha * self.type_max;
                if !was_covered {
                    self.covered_count += 1;
                }
            }
        }
    }

    fn add_source_channels<F>(
        &mut self,
        source_width: u32,
        source_height: u32,
        channels: u32,
        offset_x: i32,
        offset_y: i32,
        opacity: f32,
        blend_mode: u32,
        source_type_max: f32,
        sample: F,
    ) where
        F: Fn(usize) -> f32,
    {
        let opacity = opacity.clamp(0.0, 1.0);
        if opacity <= 0.0 {
            return;
        }
        let x_start = offset_x.max(0) as u32;
        let y_start = offset_y.max(0) as u32;
        let x_end = self
            .width
            .min((offset_x as i64 + source_width as i64).max(0) as u32);
        let y_end = self
            .height
            .min((offset_y as i64 + source_height as i64).max(0) as u32);
        if x_start >= x_end || y_start >= y_end {
            return;
        }
        let value_scale = self.type_max / source_type_max;
        for y in y_start..y_end {
            let source_y = (y as i64 - offset_y as i64) as usize;
            for x in x_start..x_end {
                let source_x = (x as i64 - offset_x as i64) as usize;
                let source_index =
                    (source_y * source_width as usize + source_x) * channels as usize;
                let destination_index = (y as usize * self.width as usize + x as usize) * 4;
                if (8..=15).contains(&blend_mode) {
                    let was_covered = self.data[destination_index + 3] > 0.0;
                    for channel in 0..3 {
                        let source_channel = if channels <= 2 {
                            0
                        } else {
                            channel.min(channels as usize - 1)
                        };
                        let source_value = sample(source_index + source_channel);
                        if !was_covered {
                            self.data[destination_index + channel] = source_value;
                        } else {
                            let below = self.data[destination_index + channel];
                            let result =
                                arithmetic_layer_channel(below, source_value, blend_mode);
                            self.data[destination_index + channel] = if opacity >= 1.0 {
                                result
                            } else if result.is_finite() && below.is_finite() {
                                below + (result - below) * opacity
                            } else {
                                f32::NAN
                            };
                        }
                    }
                    self.data[destination_index + 3] = self.type_max;
                    if !was_covered {
                        self.covered_count += 1;
                    }
                    continue;
                }
                let source_alpha_value = if channels == 2 || channels == 4 {
                    sample(source_index + channels as usize - 1)
                } else {
                    source_type_max
                };
                if !source_alpha_value.is_finite() {
                    self.cover_invalid(destination_index);
                    continue;
                }
                let source_alpha =
                    (source_alpha_value / source_type_max * opacity).clamp(0.0, 1.0);
                if source_alpha <= 0.0 {
                    continue;
                }
                let destination_alpha = self.data[destination_index + 3] / self.type_max;
                let output_alpha = source_alpha + destination_alpha * (1.0 - source_alpha);
                let was_covered = destination_alpha > 0.0;
                for channel in 0..3 {
                    let source_channel = if channels <= 2 {
                        0
                    } else {
                        channel.min(channels as usize - 1)
                    };
                    let source_value = sample(source_index + source_channel) * value_scale;
                    let below = self.data[destination_index + channel];
                    self.data[destination_index + channel] = composite_rgba_channel(
                        below,
                        source_value,
                        blend_mode,
                        source_alpha,
                        destination_alpha,
                        output_alpha,
                        self.type_max,
                    );
                }
                self.data[destination_index + 3] = output_alpha * self.type_max;
                if !was_covered {
                    self.covered_count += 1;
                }
            }
        }
    }

    fn cover_invalid(&mut self, destination_index: usize) {
        if self.data[destination_index + 3] <= 0.0 {
            self.covered_count += 1;
        }
        self.data[destination_index] = f32::NAN;
        self.data[destination_index + 1] = f32::NAN;
        self.data[destination_index + 2] = f32::NAN;
        self.data[destination_index + 3] = self.type_max;
    }

    fn stats(&self) -> (f32, f32) {
        let mut minimum = f32::INFINITY;
        let mut maximum = f32::NEG_INFINITY;
        for pixel in self.data.chunks_exact(4) {
            if pixel[3] <= 0.0 {
                continue;
            }
            for value in &pixel[..3] {
                if value.is_finite() {
                    minimum = minimum.min(*value);
                    maximum = maximum.max(*value);
                }
            }
        }
        if minimum == f32::INFINITY {
            (0.0, 0.0)
        } else {
            (minimum, maximum)
        }
    }
}

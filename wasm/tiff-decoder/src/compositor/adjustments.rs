use wasm_bindgen::JsValue;

pub(crate) fn rgb_to_hsl_f32(red: f32, green: f32, blue: f32) -> (f32, f32, f32) {
    let maximum = red.max(green).max(blue);
    let minimum = red.min(green).min(blue);
    let delta = maximum - minimum;
    let lightness = (maximum + minimum) * 0.5;
    if delta <= 0.0 {
        return (0.0, 0.0, lightness);
    }
    let raw_hue = if maximum == red {
        ((green - blue) / delta).rem_euclid(6.0)
    } else if maximum == green {
        (blue - red) / delta + 2.0
    } else {
        (red - green) / delta + 4.0
    };
    let saturation = delta / (1.0 - (2.0 * lightness - 1.0).abs()).max(1e-6);
    ((raw_hue * 60.0).rem_euclid(360.0), saturation, lightness)
}

pub(crate) fn hsl_to_rgb_f32(hue: f32, saturation: f32, lightness: f32) -> [f32; 3] {
    let chroma = (1.0 - (2.0 * lightness - 1.0).abs()) * saturation;
    let section = hue.rem_euclid(360.0) / 60.0;
    let x = chroma * (1.0 - (section.rem_euclid(2.0) - 1.0).abs());
    let (red, green, blue) = if section < 1.0 {
        (chroma, x, 0.0)
    } else if section < 2.0 {
        (x, chroma, 0.0)
    } else if section < 3.0 {
        (0.0, chroma, x)
    } else if section < 4.0 {
        (0.0, x, chroma)
    } else if section < 5.0 {
        (x, 0.0, chroma)
    } else {
        (chroma, 0.0, x)
    };
    let offset = lightness - chroma * 0.5;
    [red + offset, green + offset, blue + offset]
}

fn clamp_unit_f32(value: f32) -> f32 {
    value.clamp(0.0, 1.0)
}

fn luminance_f32(color: [f32; 3]) -> f32 {
    0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]
}

fn hue_range_weight_f32(hue: f32, center: f32) -> f32 {
    let distance = ((hue - center + 540.0).rem_euclid(360.0) - 180.0).abs();
    if distance <= 30.0 {
        1.0
    } else if distance >= 60.0 {
        0.0
    } else {
        (60.0 - distance) / 30.0
    }
}

pub(crate) fn configured_hue_range_weight_f32(
    hue: f32,
    mut boundaries: [f32; 4],
    fallback_center: f32,
) -> f32 {
    if boundaries.iter().any(|value| !value.is_finite()) {
        return hue_range_weight_f32(hue, fallback_center);
    }
    while boundaries[1] < boundaries[0] {
        boundaries[1] += 360.0;
    }
    while boundaries[2] < boundaries[1] {
        boundaries[2] += 360.0;
    }
    while boundaries[3] < boundaries[2] {
        boundaries[3] += 360.0;
    }
    let mut weight: f32 = 0.0;
    let mut candidate = hue - 360.0;
    while candidate <= hue + 720.0 {
        if candidate >= boundaries[0] && candidate <= boundaries[3] {
            let value = if candidate < boundaries[1] {
                (candidate - boundaries[0]) / (boundaries[1] - boundaries[0]).max(1e-6)
            } else if candidate <= boundaries[2] {
                1.0
            } else {
                (boundaries[3] - candidate) / (boundaries[3] - boundaries[2]).max(1e-6)
            };
            weight = weight.max(value);
        }
        candidate += 360.0;
    }
    weight.clamp(0.0, 1.0)
}

pub(crate) fn validate_direct_adjustment(
    operation: u32,
    parameters: &[f32],
) -> Result<(), JsValue> {
    let valid = match operation {
        2 => parameters.len() >= 2,
        3 => parameters.len() >= 3,
        4 => true,
        5 => parameters.len() >= 17,
        6 => parameters.len() >= 10,
        7 => parameters.len() >= 6,
        8 | 9 => !parameters.is_empty(),
        10 => parameters.len() == 256 * 3,
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(JsValue::from_str(
            "Invalid Rust/Wasm direct adjustment operation or parameters",
        ))
    }
}

pub(crate) fn apply_direct_adjustment(
    operation: u32,
    parameters: &[f32],
    color: [f32; 3],
) -> [f32; 3] {
    let [mut red, mut green, mut blue] = color;
    match operation {
        2 => {
            let brightness = parameters[0] / 100.0;
            let contrast = (parameters[1] / 100.0).clamp(-0.99, 0.99);
            let factor = (1.0 + contrast) / (1.0 - contrast);
            red = (red - 0.5) * factor + 0.5 + brightness;
            green = (green - 0.5) * factor + 0.5 + brightness;
            blue = (blue - 0.5) * factor + 0.5 + brightness;
        }
        3 => {
            let multiplier = 2.0_f32.powf(parameters[0]);
            let offset = parameters[1];
            let gamma = parameters[2].max(0.01);
            red = (red * multiplier + offset).max(0.0).powf(1.0 / gamma);
            green = (green * multiplier + offset).max(0.0).powf(1.0 / gamma);
            blue = (blue * multiplier + offset).max(0.0).powf(1.0 / gamma);
        }
        4 => {
            red = 1.0 - red;
            green = 1.0 - green;
            blue = 1.0 - blue;
        }
        5 => {
            let source = [red, green, blue];
            let mix = |base: usize| {
                source[0] * parameters[base] / 100.0
                    + source[1] * parameters[base + 1] / 100.0
                    + source[2] * parameters[base + 2] / 100.0
                    + parameters[base + 3] / 100.0
            };
            if parameters[0] > 0.5 {
                let gray = mix(13);
                red = gray;
                green = gray;
                blue = gray;
            } else {
                red = mix(1);
                green = mix(5);
                blue = mix(9);
            }
        }
        6 => {
            let original_lightness = rgb_to_hsl_f32(red, green, blue).2;
            let light = luminance_f32([red, green, blue]);
            let weights = [
                clamp_unit_f32((0.5 - light) * 2.0),
                1.0 - (light - 0.5).abs() * 2.0,
                clamp_unit_f32((light - 0.5) * 2.0),
            ];
            for range in 0..3 {
                let base = range * 3;
                red += parameters[base] / 100.0 * weights[range];
                green += parameters[base + 1] / 100.0 * weights[range];
                blue += parameters[base + 2] / 100.0 * weights[range];
            }
            if parameters[9] > 0.5 {
                let (hue, saturation, _) = rgb_to_hsl_f32(
                    clamp_unit_f32(red),
                    clamp_unit_f32(green),
                    clamp_unit_f32(blue),
                );
                [red, green, blue] = hsl_to_rgb_f32(hue, saturation, original_lightness);
            }
        }
        7 => {
            let (hue, saturation, _) = rgb_to_hsl_f32(red, green, blue);
            let centers = [0.0, 60.0, 120.0, 180.0, 240.0, 300.0];
            let mut weighted = 0.0;
            let mut total = 0.0;
            for index in 0..6 {
                let weight = hue_range_weight_f32(hue, centers[index]);
                weighted += parameters[index] * weight;
                total += weight;
            }
            let gray = luminance_f32([red, green, blue])
                + (((if total > 0.0 { weighted / total } else { 50.0 }) - 50.0) / 100.0)
                    * saturation
                    * 0.5;
            red = gray;
            green = gray;
            blue = gray;
        }
        8 => {
            let value = if luminance_f32([red, green, blue]) * 255.0 >= parameters[0] {
                1.0
            } else {
                0.0
            };
            red = value;
            green = value;
            blue = value;
        }
        9 => {
            let levels = parameters[0].round().clamp(2.0, 255.0);
            let quantize = |value: f32| (value * (levels - 1.0)).round() / (levels - 1.0);
            red = quantize(red);
            green = quantize(green);
            blue = quantize(blue);
        }
        10 => {
            let position = clamp_unit_f32(luminance_f32([red, green, blue])) * 255.0;
            let low = position.floor() as usize;
            let high = (low + 1).min(255);
            let fraction = position - low as f32;
            for channel in 0..3 {
                let base = channel * 256;
                let value = parameters[base + low]
                    + (parameters[base + high] - parameters[base + low]) * fraction;
                match channel {
                    0 => red = value,
                    1 => green = value,
                    _ => blue = value,
                }
            }
        }
        _ => {}
    }
    [
        clamp_unit_f32(red),
        clamp_unit_f32(green),
        clamp_unit_f32(blue),
    ]
}

pub(crate) fn composite_rgba_channel(
    below: f32,
    source: f32,
    mode: u32,
    source_alpha: f32,
    destination_alpha: f32,
    output_alpha: f32,
    type_max: f32,
) -> f32 {
    if destination_alpha <= 0.0 || source_alpha >= 1.0 && mode == 0 {
        return source;
    }
    if !below.is_finite() || !source.is_finite() {
        return f32::NAN;
    }
    if mode == 0 {
        return (source * source_alpha + below * destination_alpha * (1.0 - source_alpha))
            / output_alpha;
    }
    let blended = match mode {
        1 => below * source / type_max,
        2 => type_max - (type_max - below) * (type_max - source) / type_max,
        3 => {
            if below <= type_max * 0.5 {
                2.0 * below * source / type_max
            } else {
                type_max - 2.0 * (type_max - below) * (type_max - source) / type_max
            }
        }
        4 => below.min(source),
        5 => below.max(source),
        6 => (below - source).abs(),
        7 => below + source - 2.0 * below * source / type_max,
        _ => source,
    };
    ((1.0 - source_alpha) * destination_alpha * below
        + (1.0 - destination_alpha) * source_alpha * source
        + destination_alpha * source_alpha * blended)
        / output_alpha
}

pub(crate) fn arithmetic_layer_channel(below: f32, source: f32, mode: u32) -> f32 {
    match mode {
        8 => below + source,
        9 => below - source,
        10 => (below - source).abs(),
        11 => below * source,
        12 => {
            if source == 0.0 {
                f32::NAN
            } else {
                below / source
            }
        }
        13 => below.min(source),
        14 => below.max(source),
        15 => (below + source) * 0.5,
        _ => source,
    }
}

"""Validation shared by Python, REST and MCP, before any renderer mutation."""

import math


def number(value, name, low, high):
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or not low <= value <= high
    ):
        raise ValueError(f"{name} must be finite and in {low}..{high}")
    return value


def pixel_coordinates(x, y):
    if any(isinstance(v, bool) or not isinstance(v, int) or v < 0 for v in (x, y)):
        raise ValueError("Pixel coordinates must be nonnegative integers (zero-based)")
    return {"x": x, "y": y}


def display_options(
    *, exposure=None, gamma=None, value_range=None, auto=None, zoom=None
):
    result = {}
    if exposure is not None:
        result["exposure"] = number(exposure, "exposure", -16, 16)
    for key, value in [("gamma", gamma), ("value_range", value_range)]:
        if value is not None:
            if not isinstance(value, (list, tuple)) or len(value) != 2:
                raise ValueError(f"{key} must contain two numbers")
            result[key] = [
                number(
                    v,
                    key,
                    0.001 if key == "gamma" else -1e300,
                    100 if key == "gamma" else 1e300,
                )
                for v in value
            ]
    if value_range is not None and value_range[0] >= value_range[1]:
        raise ValueError("value_range min must be less than max")
    if auto is not None:
        if not isinstance(auto, bool):
            raise ValueError("auto must be a boolean")
        result["auto"] = auto
    if (
        sum(
            [
                gamma is not None or exposure is not None,
                value_range is not None,
                auto is not None,
            ]
        )
        > 1
    ):
        raise ValueError(
            "Choose gamma/exposure, value_range, or auto in one call; these select different display modes"
        )
    if zoom is not None:
        result["zoom"] = "fit" if zoom == "fit" else number(zoom, "zoom", 0.001, 200)
    if not result:
        raise ValueError("Provide at least one display setting")
    return result

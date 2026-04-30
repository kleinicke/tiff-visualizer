# Float and TIFF Visualizer for Visual Studio Code

A Image viewer for Visual Studio Code, for the formats tiff, exr, npy, png, jpg, ppm, pfm and pgm.
It visualizes 8 and 16 bit uint images and 16 and 32 bit float images. The visualization of all images can be normalized to a specified range.
Additionally it allows for brightness and gamma corrections and offers a color value picker.

![tiff-visualizer](https://github.com/kleinicke/tiff-visualizer/releases/download/v1.0.0/TiffVisualizerVSCode.gif)

## Features

- **Advanced TIFF Support**: Opens and displays complex TIFF files, including those with multiple channels and floating-point data types. Also supports compressed TIFF images using Deflate or LZW with predictors.
- **Additional files Support**: Support for exr, npy, png, jpg, ppm, pfm and pgm images with uint8/16 and float16/32 support for bw, rgb and rgba images.
- **Interactive Pixel Inspection**: Hover over any pixel to see its exact value in the status bar. For multi-channel images, all channel values are displayed.
- **Dynamic Normalization**: Interactively adjust the normalization range for floating-point images to reveal hidden details or choose automatic normalization.
- **Gamma and Brightness Correction**: Adjust image appearance with a per-layer control panel. **Gamma** uses the standard power-law transform: `output = input^γ` (napari convention). γ = 1.0 → no change; γ < 1.0 → brighter midtones (e.g. 0.5 = square-root lift); γ > 1.0 → darker midtones (e.g. 2.0 = square). Gamma is applied to the 0–1 normalised intensity *after* the min/max range step, so it is fully independent of the range sliders. **Brightness** applies an exposure shift of `2^stops` in linear space on top of the gamma result. On single-channel images, gamma is applied before the colormap lookup.
- **Keep All Settings for Session**: A single VS Code Window keeps the settings applied on one image for all images.
- **Export as PNG**: Export the image, with the chosen image visualization as PNG for easy sharing.

Float Image Visualization Options:
![float-options](assets/tiffVisualizerFloatOptions.png)

## Control Panel

Each image (or layer) has an in-viewer control panel with the following adjustments:

| Control | Formula | Behaviour |
|---------|---------|-----------|
| **Range Min / Max** | Maps `[min, max]` → `[0, 1]` | Values below Min → black; above Max → white (or first/last colormap colour). Switches to manual normalization mode. For EXR/float use actual data units (e.g. −1.0 to 2.5); for uint16 use 0–65535. |
| **Gamma** | `output = input^γ` (napari power-law) | γ = 1.0 → no change. γ < 1.0 → brighter midtones (e.g. 0.5 = square-root lift). γ > 1.0 → darker midtones (e.g. 2.0 = square). Applied to the 0–1 normalised intensity *after* the range step — independent of Min/Max. On single-channel images, applied before the colormap lookup. |
| **Brightness** | `output *= 2^stops` | +1 stop = 2× brighter; −1 stop = half as bright. Applied in linear space after gamma. |
| **Colormap** | LUT applied to normalised 0–1 intensity | Only active for single-channel (grayscale) images. Applied after range + gamma. Choices: viridis, plasma, inferno, magma, jet, hot, cool, turbo, gray. |
| **Opacity** | Per-layer alpha blend | Controls how strongly this layer composites over the layers beneath it. |

## About

The extension is built on top of the built-in [VS Code Media Preview extension](https://github.com/microsoft/vscode/tree/main/extensions/media-preview). TIFF support uses the [geotiff library](https://github.com/geotiffjs/geotiff.js/). All coding was performed using Cursor and claude code.

## Known Issues and Missing Features

- Adding a Histogram
- Allow to rotate the image
- Allow going fast through all images
- Compare two images on top of each other to spot differences easily
- Issue with lzw from tifffile. lzw images from oiiotool work ...

## Feature Requests and Issues

If you have use cases that would be helpful for others or find problems, feel free to suggest them on the [GitHub repository](https://github.com/kleinicke/tiff-visualizer/issues). If you know how to fix bugs or how to implement certain features, feel free to contribute.

## Build notice

Instead of downloading from the Marketplace, you can also build from source by cloning the repo and building it by running:

```bash
cd image-visualizer
npm install
npm install -g vsce
vsce package
```

Then install the generated .vsix file via Extensions > Install from VSIX...

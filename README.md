# Float and TIFF Visualizer for Visual Studio Code

Inspect high-bit-depth, floating-point, scientific, and camera image files directly inside Visual Studio Code.

Supports TIFF, EXR, NPY/NPZ, PNG, JPEG, WebP, AVIF, HDR, JXL, TGA, BMP, ICO, PPM, PFM, PBM and PGM.

The viewer supports 8-bit and 16-bit integer images as well as 16-bit and 32-bit floating-point images. You can inspect exact pixel values, normalize image data to custom ranges, adjust gamma and brightness, compare images, and export the current visualization as PNG.

![tiff-visualizer](https://github.com/kleinicke/tiff-visualizer/releases/download/v1.0.0/TiffVisualizerVSCode.gif)

## Features

- **Advanced TIFF Support**: Opens high-bit-depth, floating-point, multi-channel, and compressed TIFF files. Fast TIFF loading via Rust/WebAssembly, with geotiff.js fallback for compatibility.
- **Scientific Image Inspection**: Inspect uint8, uint16, float16, and float32 image data in grayscale, RGB, and RGBA images.
- **Interactive Pixel Values**: Hover over any pixel to see its exact value in the status bar. For multi-channel images, all channel values are displayed.
- **Dynamic Normalization**: Adjust the visualization range interactively, use automatic min/max normalization, or view integer images as normalized float values.
- **Gamma and Brightness Correction**: Adjust source gamma, target gamma, and brightness while preserving linear-space behavior.
- **Histogram View**: Show a histogram overlay to inspect the current image distribution while tuning the visualization.
- **Image Collections and Comparison**: Add images to a collection for fast navigation and easier comparison. Use wildcards to load multiple images at once.
  ![collection](https://github.com/kleinicke/tiff-visualizer/releases/download/v1.0.0/Collection.gif)
- **Mask Filtering and NaN Color**: Apply threshold-based mask filters and choose how NaN values are displayed.
- **Session-Wide Settings**: A single VS Code window keeps visualization settings across opened images.
- **Export and Copy**: Export the current visualization as PNG, copy the image, or copy image zoom level to the clipboard to paste onto other image.
- **VS Code Native Controls**: Most options are available from the right-click menu, command palette, or clickable status bar entries.

## How to Use

Open a supported image file in VS Code and choose **TIFF Visualizer** if VS Code asks which editor to use.

Use the status bar or right-click menu to change normalization, gamma, brightness, histogram visibility, mask filters, and export options.

For browsing or comparing multiple files, use **Add Images to Collection** from the command palette or editor context menu.

Float Image Visualization Options:
![float-options](assets/tiffVisualizerFloatOptions.png)

## Feature Requests and Issues

If you have use cases that would be helpful for others or find problems, feel free to suggest them on the [GitHub repository](https://github.com/kleinicke/tiff-visualizer/issues).
I'm open adding more file formats that can serve you.

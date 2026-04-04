# Float and TIFF Visualizer for Visual Studio Code

An image viewer for Visual Studio Code, supporting multiple formats (TIFF, EXR, NPY, PNG, JPG, PPM, PFM, PGM). Visualize 8/16-bit uint and 16/32-bit float images with powerful interactive tools.

![tiff-visualizer](https://github.com/kleinicke/tiff-visualizer/releases/download/v1.0.0/TiffVisualizerVSCode.gif)

## Key Features in Action

### 1. Advanced Image Inspection
Easily inspect complex data types, multi-channel images, and see exact pixel values on hover straight from the status bar.
![Feature 1 Video](https://github.com/kleinicke/tiff-visualizer/releases/download/v1.0.0/TiffVisualizerVSCode.gif)

### 2. Dynamic Normalization & Adjustments 
Interactively adjust normalization for floating-point images to reveal hidden details or apply automatic bounds. Correct brightness and gamma interactively in a linear space.
![Feature 2 Video](https://github.com/kleinicke/tiff-visualizer/releases/download/v1.0.0/TiffVisualizerVSCode.gif)

### 3. Layer Blending & Colormaps
Apply overlay layers, perform mathematical blending operations (add, subtract, etc.), and use custom colormaps with visual legends.
![Feature 3 Video](https://github.com/kleinicke/tiff-visualizer/releases/download/v1.0.0/TiffVisualizerVSCode.gif)

### 4. Export & Session Persistence
Keep the settings applied on one image for all images in exactly the same window. Export your final visual results directly as PNGs.
![Feature 4 Video](https://github.com/kleinicke/tiff-visualizer/releases/download/v1.0.0/TiffVisualizerVSCode.gif)

## Additional Features & Formats

- **Supported Formats**: `tiff`, `exr`, `npy`, `png`, `jpg`, `ppm`, `pfm`, `pgm`.
- **Advanced TIFFs**: Supports Deflate or LZW compression with predictors.
- **Color Types**: bw, rgb, rgba images with uint8/16 and float16/32 bit depth.

## Float Image Visualization Options

![float-options](assets/tiffVisualizerFloatOptions.png)

## Installation & Build

Instead of downloading from the Marketplace, build from source:

```bash
git clone https://github.com/kleinicke/tiff-visualizer
cd tiff-visualizer
npm install
npm install -g vsce
vsce package
```

Then install the generated `.vsix` file via `Extensions > Install from VSIX...`

## About & Contributing

The extension is built on top of the built-in [VS Code Media Preview extension](https://github.com/microsoft/vscode/tree/main/extensions/media-preview). TIFF support uses the [geotiff library](https://github.com/geotiffjs/geotiff.js/). All coding was performed using Cursor and Claude Code.

If you have use cases that would be helpful for others or find problems, feel free to suggest them on the [GitHub repository](https://github.com/kleinicke/tiff-visualizer/issues). If you know how to fix bugs or how to implement certain features, feel free to contribute.

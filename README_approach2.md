# Float and TIFF Visualizer for Visual Studio Code

Welcome to the ultimate tool for viewing and analyzing scientific and complex imagery directly inside VS Code. 

![tiff-visualizer](https://github.com/kleinicke/tiff-visualizer/releases/download/v1.0.0/TiffVisualizerVSCode.gif)

## How It Works: A Guided Tour

### Step 1: Open & Inspect Data
From standard formats like PNG/JPG to complex scientific imagery like TIFFs, EXRs, and NPY arrays—just click to open them. Hover over any pixel to read precise values in the status bar across all channels.
![Step 1 Video](https://github.com/kleinicke/tiff-visualizer/releases/download/v1.0.0/TiffVisualizerVSCode.gif)

### Step 2: Normalize & Correct
Float images often hold data outside visible bounds. Use dynamic normalization controls to map data ranges. Apply gamma and brightness operations in true linear space for perfect visibility. 
![Step 2 Video](https://github.com/kleinicke/tiff-visualizer/releases/download/v1.0.0/TiffVisualizerVSCode.gif)

### Step 3: Blend with Overlays
Need to compare data sets or apply masks? The Overlay Panel lets you blend multi-layer images on the fly using add, subtract, multiply, and colormap mapping.
![Step 3 Video](https://github.com/kleinicke/tiff-visualizer/releases/download/v1.0.0/TiffVisualizerVSCode.gif)

### Step 4: Retain & Export
Analyzing a whole folder? Your visualization settings persist across images in the same window. Found the perfect view? Export it immediately to PNG for sharing.
![Step 4 Video](https://github.com/kleinicke/tiff-visualizer/releases/download/v1.0.0/TiffVisualizerVSCode.gif)

## Supported File Types
`tiff`, `exr`, `npy`, `png`, `jpg`, `ppm`, `pfm`, `pgm`. Supports floats up to 32-bit and compressed TIFF files (Deflate/LZW).

## Float Image Options Panel
![float-options](assets/tiffVisualizerFloatOptions.png)

## Installation & Build Instructions

Instead of downloading from the Marketplace, you can build from source:

```bash
git clone https://github.com/kleinicke/tiff-visualizer
cd tiff-visualizer
npm install
npm install -g vsce
vsce package
```

Then install the generated `.vsix` file via `Extensions > Install from VSIX...`

## Community
Bug reports and suggestions are welcome via our [GitHub Issues](https://github.com/kleinicke/tiff-visualizer/issues).

# TIFF Visualizer for Visual Studio Code

A TIFF viewer for Visual Studio Code, to display uint and floating-point images while allowing brightness and gamma corrections.
For floating-point images, this extension allows easier handling by allowing setting the ranges, the image is normalized to.

## Features

- **Advanced TIFF Support**: Opens and displays complex TIFF files, including those with multiple channels and floating-point data types. Also supports compressed TIFF images using Deflate or LZW with predictors.
- **Interactive Pixel Inspection**: Hover over any pixel to see its exact value in the status bar. For multi-channel images, all channel values are displayed.
- **Dynamic Normalization**: Interactively adjust the normalization range for floating-point images to reveal hidden details.
- **Gamma and Brightness Correction**: Add or remove gamma correction for an image. To change brightness, the source gamma correction is removed, the brightness change (2**Change) is multiplied in linear space onto the image, and the target gamma correction is applied.
- **Keep All Settings for Session**: A single VS Code Window keeps the settings applied on one image for all images. 
- **Export as PNG**: Export the image, with the chosen image visualization as PNG for easy sharing.

## About

The extension is built on the built-in [VS Code Media Preview extension](https://github.com/microsoft/vscode/tree/main/extensions/media-preview). To add TIFF support, the [geotiff library](https://github.com/geotiffjs/geotiff.js/) is used. All coding was performed using Cursor.

## Known Issues and Missing Features

- Image jumps to top left, when starting to zoom in
- Adding a Histogram
- Allow to rotate the image
- Allow going fast through all images
- Compare two images on top of each other to spot differences easily
- Add option to use features of extension on other image formats, but it should be deactivated by default

## Feature Requests and Issues

If you have use cases that would be helpful for others or find problems, feel free to suggest them on the [GitHub repository](https://github.com/kleinicke/tiff-visualizer/issues). If you know how to fix bugs or how to implement certain features, feel free to contribute.

## Release Notes

### 1.0.0

Initial release of TIFF Visualizer.


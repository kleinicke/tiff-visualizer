# Float and TIFF Visualizer for Visual Studio Code

A Image viewer for Visual Studio Code, for the formats tiff, exr, npy, png, jpg, ppm, pfm and pgm.
It visualizes 8 and 16 bit uint images and 16 and 32 bit float images. The visualization of all images can be normalized to a specified range.
Additionally it allows for brightness and gamma corrections and offers a color value picker.

![tiff-visualizer](https://github.com/kleinicke/tiff-visualizer/releases/download/v1.0.0/TiffVisualizerVSCode.gif)

## Features

- **Advanced TIFF Support**: Opens and displays complex TIFF files, including those with multiple channels and floating-point data types. Also supports compressed TIFF images using Deflate or LZW with predictors.
- **Additional files Support**: Support for exr, npy, png, jpg, ppm, pfm and pgm images with uint8/16 and float16/32 support for bw, rgb and rgba images.
- **Interactive Pixel Inspection**: Hover over any pixel to see its exact value in the status bar. For multi-channel images, all channel values are displayed.
- **Add image to collection**: For fast skipping through images and easier comparison. Use wildcards to load multiple at once.
- **Dynamic Normalization**: Interactively adjust the normalization range for floating-point images to reveal hidden details or choose automatic normalization.
- **Gamma and Brightness Correction**: Add or remove gamma correction for an image. To change brightness, the source gamma correction is removed, the brightness change (2\*\*Change) is multiplied in linear space onto the image, and the target gamma correction is applied.
- **Keep All Settings for Session**: A single VS Code Window keeps the settings applied on one image for all images.
- **Export as PNG**: Export the image, with the chosen image visualization as PNG for easy sharing.

Float Image Visualization Options:
![float-options](assets/tiffVisualizerFloatOptions.png)

## Feature Requests and Issues

If you have use cases that would be helpful for others or find problems, feel free to suggest them on the [GitHub repository](https://github.com/kleinicke/tiff-visualizer/issues).
I'm open adding more file formats that can serve you.

# TIFF Visualizer for Visual Studio Code

A powerful TIFF viewer for Visual Studio Code, based on the vscode media viewer extension.
For rendering the tif images the geotiff library is used.

The differences to previous tif extensions are improvements regarding floating point tif images. By default they are normalized to the range 0 to 1, but this can be easily changed by a click on the corresponding box in the status bar when having an image opened.

Also the color value of a certain pixel can be determined by moving the mouse over it.


![TIFF Visualizer Demo](https://github.com/user-attachments/assets/53610931-4a61-45a1-bb38-51820b330366)


## Features

- **Advanced TIFF Support**: Opens and displays complex TIFF files, including those with multiple channels and floating-point data types.
- **Interactive Pixel Inspection**: Hover over any pixel to see its exact value in the status bar. For multi-channel images, all channel values are displayed.
- **Dynamic Normalization**: Interactively adjust the normalization range for floating-point images to reveal hidden details.
- **Seamless Zoom and Pan**: Effortlessly zoom and pan to explore large images.
- **Intuitive UI**: A clean and user-friendly interface that integrates smoothly with Visual Studio Code.

## Requirements

There are no external dependencies or requirements to use this extension.

## Extension Settings

This extension contributes the following settings:

* `mediaPreview.tiff.normalization.min`: The minimum value for floating-point data normalization (default: `0.0`).
* `mediaPreview.tiff.normalization.max`: The maximum value for floating-point data normalization (default: `1.0`).

## Known Issues

There are currently no known issues. Please report any bugs or feature requests on the [GitHub issues page](https://github.com/kleinicke/tiff-visualizer/issues).

## Release Notes

### 1.0.0

Initial release of TIFF Visualizer.


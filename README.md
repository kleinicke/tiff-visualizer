# Scientific Image Visualizer for Visual Studio Code

Inspect high-bit-depth, floating-point, scientific, and camera image files directly inside Visual Studio Code.

Supports TIFF/OME-TIFF (including embedded multi-file filesets), FITS, DICOM, classic NetCDF, EXR, NPY/NPZ,
PNG, JPEG, WebP, AVIF, HDR, JXL, TGA, BMP, ICO, PPM, PFM, PBM and PGM.

The viewer supports 8-bit and 16-bit integer images as well as 16-bit and 32-bit floating-point images. You can inspect exact pixel values, normalize image data to custom ranges, adjust gamma and brightness, compare images, and export the current visualization as PNG. Uses Rust for decoding several formats and the GPU for rendering to provide the fastest possible extension.

![tiff-visualizer](https://github.com/kleinicke/tiff-visualizer/releases/download/v1.0.0/TiffVisualizerVSCode.gif)

## Supported Sample Types

| Format                         | uint8 | uint16 | float16 | float32 | Notes                                                                       |
| ------------------------------ | ----: | -----: | ------: | ------: | --------------------------------------------------------------------------- |
| TIFF                           |   Yes |    Yes |     Yes |     Yes | Decoded by a Rust/WASM decoder by default (uint8/16/32, int, float16/32/64) |
| EXR                            |    No |     No |     Yes |     Yes | HDR floating-point format                                                   |
| NPY/NPZ                        |   Yes |    Yes |     Yes |     Yes | Also supports float64 and int8/16/32/64, uint32/64                          |
| FITS                           |   Yes |    Yes |      No |     Yes | Numeric image HDUs; also int32/int64 and float64                            |
| DICOM                          |   Yes |    Yes |      No |     Yes | Native and JPEG Baseline; folder/series and multi-frame navigation           |
| NetCDF                         |   Yes |    Yes |      No |     Yes | Classic CDF-1/CDF-2 rasters and MPAS cell meshes; variable/dimension controls |
| PFM                            |    No |     No |      No |     Yes | Portable Float Map                                                          |
| HDR                            |    No |     No |      No |     Yes | Radiance RGBE, decoded to float32                                           |
| PNG                            |   Yes |    Yes |      No |      No | Palette PNGs become 8-bit RGBA                                              |
| PPM/PGM/PBM                    |   Yes |    Yes |      No |      No | PBM is 1-bit, shown as 8-bit                                                |
| JPEG/WebP/AVIF/BMP/ICO/TGA/JXL |   Yes |     No |      No |      No | Decoded as 8-bit image data in the extension                                |

NetCDF-4/HDF5 and DICOM compression other than JPEG Baseline are not yet supported.
Small synthetic files for manual checks live in `test-samples/scientific/`.
Extensionless DICOM studies can be opened with **TIFF Visualizer: Open Folder as DICOM Dataset**. The viewer scans technical headers, groups images by series, removes duplicate SOP instances, and orders slices spatially.

## Features

- **Fast and versatile TIFF Support**: Fast TIFF decoding using ![Rust](https://github.com/image-rs/image-tiff). Opens high-bit-depth, floating-point, multi-channel, and compressed TIFF files.
- **Advanced TIFF Support**: Opens high-bit-depth, floating-point, multi-channel, and compressed TIFF files. Fast TIFF loading via Rust/WebAssembly, with geotiff.js fallback for compatibility.
- **Scientific Image Inspection**: Inspect uint8, uint16, float16, and float32 image data in grayscale, RGB, and RGBA images.
- **Dataset Navigation**: Browse DICOM series/slices and multi-file OME C/Z/T planes as one logical dataset while the viewer switches physical files transparently.
- **Interactive Pixel Values**: Hover over any pixel to see its exact value in the status bar. For multi-channel images, all channel values are displayed.
- **Dynamic Normalization**: Adjust the visualization range interactively, use automatic min/max normalization, or view integer images as normalized float values.
- **Gamma and Brightness Correction**: Adjust source gamma, target gamma, and brightness while preserving linear-space behavior.
- **Histogram View**: Show a histogram overlay to inspect the current image distribution while tuning the visualization.
- **Image Collections**: Group related images in one preview and quickly move between them without opening a tab for every file. Add individual images, folders, paths, or wildcard matches from the command palette and editor context menu.
  ![collection](https://github.com/kleinicke/tiff-visualizer/releases/download/v1.0.0/Collection.gif)
- **Layers View**: Open one or more images in a dedicated Layers window for compositing and visual comparison.
  Easily get the difference between two images or apply a mask onto one. This layer view allows dedicated compositions between multiple images.
- **NaN Color**: Choose how NaN values are displayed.
- **Session-Wide Settings**: A single VS Code window keeps visualization settings across opened images.
- **Export and Copy**: Export the current visualization as PNG, copy the image, or copy image zoom level to the clipboard to paste onto other image.
- **VS Code Native Controls**: Most options are available from the right-click menu, command palette, or clickable status bar entries.
- **Metadata panel** shows file info, image statistics (min/max/mean/std) and Exif/GPS sub-IFD tags.

## How to Use

Open a supported image file in VS Code and choose **Scientific Image Visualizer** if VS Code asks which editor to use.

Use the status bar or right-click menu to change normalization, gamma, brightness, histogram visibility, mask filters, and export options.

For browsing a related set of files, use **Add Images to Collection** from the command palette or Explorer context menu. The collection overlay shows the current image and lets you navigate or remove entries.

Use **Open Layers View** from the command palette or status bar to create a new Layers window from the currently displayed image. When viewing a collection, choose whether to use only the current image or stack the complete collection. Add further images using the Layers panel's **+** button or **Add Image as Layer**.

Float Image Visualization Options:
![float-options](assets/tiffVisualizerFloatOptions.png)

## Multi-dimensional and multi-view images

- **OME-TIFF:** Navigate images/series, channels, Z slices, and timepoints from OME-XML. Multi-file datasets are presented as one logical image while C/Z/T changes transparently select the referenced TIFF and IFD. `BinaryOnly` members automatically follow metadata stored in a master OME-TIFF or companion `.ome`/`.ome.xml` file.
- **DICOM:** Use **TIFF Visualizer: Open Folder as DICOM Dataset**, select an acquisition series, and navigate its slices and available time, echo, and frame dimensions. Physical files remain grouped by DICOM identity instead of being mixed into a filename-sorted collection. Multi-frame objects, including JPEG Baseline objects, expose a Frame control.
- **Ordinary multi-page TIFF:** Navigate top-level pages even when no semantic dimension metadata is available.
- **NetCDF:** Select a numeric variable and move through its non-spatial dimensions. Regular X/Y arrays render as rasters; MPAS `nCells` fields render on their unstructured cell polygons in an equirectangular mesh view.

> **Medical-use notice:** DICOM support is provided for developer, research, and scientific visualization workflows. This extension is not a certified or cleared medical device and is not intended for diagnosis, treatment planning, clinical decision-making, or other clinical use. Do not rely on it as the sole means of viewing or interpreting medical images.

## Decoder architecture

- **TIFF and OME-TIFF pixels:** Rust/WebAssembly using the `tiff` crate and its codecs, with geotiff.js as a compatibility fallback. OME-XML metadata and dimension mapping are parsed in TypeScript.
- **DICOM:** A lightweight TypeScript parser reads the container, technical headers, series metadata, and native pixel data. Encapsulated JPEG Baseline frames are extracted in TypeScript and decoded in Rust/WebAssembly with `zune-jpeg`; browser JPEG decoding is the fallback.
- **FITS and classic NetCDF:** Dependency-free TypeScript parsers run in the decode worker. The NetCDF path understands regular multidimensional rasters and MPAS cell geometry; NetCDF-4/HDF5 remains separate future work.
- **EXR and other formats:** The viewer uses a mixture of Rust/WebAssembly, focused JavaScript libraries, and browser-native codecs according to the format.

## Feature Requests and Issues

If you have use cases that would be helpful for others or find problems, feel free to suggest them on the [GitHub repository](https://github.com/kleinicke/tiff-visualizer/issues).
I'm open adding more file formats that can serve you.

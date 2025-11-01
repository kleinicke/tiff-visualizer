# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a VS Code extension that provides advanced image visualization for scientific and HDR imagery. It supports TIFF (including floating-point), OpenEXR, NumPy arrays (.npy), NetPBM formats (PPM, PGM, PBM, PFM), and standard formats (PNG, JPG), with interactive analysis features including normalization, gamma/brightness correction, pixel inspection, and image comparison.

## Development Commands

### Build & Development
```bash
npm install              # Install dependencies
npm run compile          # Build using esbuild (creates 3 bundles: Node.js, Web, Webview)
npm run watch            # Watch mode for development
npm run vscode:prepublish # Production build
```

### Testing & Quality
```bash
npm run test             # Run all tests (behavior + visualization)
npm run test:behavior    # Run behavioral tests (fast, no VS Code required)
npm run test:visualization # Run visualization tests
npm run test:ui          # Run UI tests with Extension Tester
npm run lint             # Run ESLint
npm run pretest          # Compile and lint before testing
```

### Extension Testing
- Press **F5** in VS Code to launch Extension Development Host
- Test files in `example/` directory (various TIFF formats)
- The extension auto-registers for: `.tif`, `.tiff`, `.exr`, `.pfm`, `.npy`, `.npz`, `.ppm`, `.pgm`, `.pbm`, `.png`, `.jpg`, `.jpeg`

### Packaging
```bash
npm install -g @vscode/vsce
vsce package            # Creates .vsix file for distribution
```

## Architecture Overview

### Triple Build System
The extension uses a sophisticated three-bundle build approach:

1. **Extension bundle** (`out/extension.js`) - Node.js target for VS Code desktop API integration
2. **Web bundle** (`out/extension.web.js`) - Browser target for VS Code Web/vscode.dev support
3. **Webview bundle** (`media/imagePreview.js`) - Browser-based visualization with ES6 modules

This allows the extension to work in both desktop VS Code and browser-based VS Code (vscode.dev).

### Custom Editor Pattern
Uses VS Code's `CustomReadonlyEditorProvider` API:
- **View Type**: `tiffVisualizer.previewEditor`
- **File associations**: `*.{tif,tiff,exr,pfm,npy,npz,ppm,pgm,pbm,png,jpeg,jpg}`
- **Registration**: Handled in [src/imagePreview/index.ts](src/imagePreview/index.ts)
- **Provider Implementation**: [src/imagePreview/imagePreviewManager.ts](src/imagePreview/imagePreviewManager.ts)

### Centralized State Management
**AppStateManager** ([src/imagePreview/appStateManager.ts](src/imagePreview/appStateManager.ts)) is the single source of truth for:
- **Image settings**: Normalization ranges, gamma, brightness (global across session)
- **Per-format settings**: Different defaults for TIFF-float, TIFF-int, EXR, NPY, etc.
- **UI state**: Zoom level, image size, format info, pixel position
- **Image statistics**: Min/max values from current image
- **Event coordination**: Emits events when state changes to update UI components

This centralized design ensures consistency across all status bar entries and command handlers.

### Message Passing Architecture
Extension host ↔ Webview communication via `postMessage` (handled by [messageHandlers.ts](src/imagePreview/messageHandlers.ts)):
- **Inbound** (webview → extension): Image loaded, stats calculated, pixel focus/blur, zoom changes
- **Outbound** (extension → webview): Settings updates, command execution (export, normalization, gamma, brightness)
- **MessageRouter pattern**: Type-based routing to specific handler classes

### Modular Webview Design
The webview ([media/imagePreview.js](media/imagePreview.js)) uses ES6 modules for maintainability:

- **SettingsManager** ([media/modules/settings-manager.js](media/modules/settings-manager.js)): Global settings and state management
- **Format Processors**: Separate modules for each format
  - **TiffProcessor**: TIFF using geotiff.js library
  - **ExrProcessor**: OpenEXR using parse-exr library
  - **NpyProcessor**: NumPy arrays (.npy)
  - **PfmProcessor**: Portable Float Map
  - **PpmProcessor**: Portable PixMap formats (PPM/PGM/PBM)
  - **PngProcessor**: PNG with uint8/16 and float16/32 support
- **ZoomController**: Pan/zoom with mouse/trackpad
- **MouseHandler**: Pixel inspection, hover effects
- **HistogramOverlay**: Histogram visualization (experimental)
- **ColormapConverter**: Converts colormap images to float values using various colormaps (viridis, plasma, jet, etc.)

### Status Bar Integration
Comprehensive status bar system with 8+ specialized entries:
- **Size** ([sizeStatusBarEntry.ts](src/imagePreview/sizeStatusBarEntry.ts)): Image dimensions, pixel position on hover
- **Zoom** ([zoomStatusBarEntry.ts](src/imagePreview/zoomStatusBarEntry.ts)): Current zoom level with click to reset
- **Normalization** ([normalizationStatusBarEntry.ts](src/imagePreview/normalizationStatusBarEntry.ts)): Float range controls (for float images)
- **Gamma** ([gammaStatusBarEntry.ts](src/imagePreview/gammaStatusBarEntry.ts)): Gamma correction (in/out)
- **Brightness** ([brightnessStatusBarEntry.ts](src/imagePreview/brightnessStatusBarEntry.ts)): Brightness adjustment in linear space
- **Binary Size** ([binarySizeStatusBarEntry.ts](src/binarySizeStatusBarEntry.ts)): File size information
- **Mask Filter** ([maskFilterStatusBarEntry.ts](src/imagePreview/maskFilterStatusBarEntry.ts)): Pixel filtering by mask
- **Histogram** ([histogramStatusBarEntry.ts](src/imagePreview/histogramStatusBarEntry.ts)): Toggle histogram overlay

Each status bar entry implements `StatusBarEntryInterface` and registers with `ImagePreviewManager`.

### Comparison Panel Feature
Side-by-side image comparison ([src/comparisonPanel/comparisonPanel.ts](src/comparisonPanel/comparisonPanel.ts)):
- Separate webview panel for comparing multiple images
- Commands: "Select for Compare", "Compare with Selected", "Open Comparison Panel"
- Persists comparison state across tab switches
- Allows adding/removing images dynamically

## Key Development Patterns

### Image Processing Pipeline
1. **Detection**: File extension check
2. **Loading**: Format-specific processor loads image data
3. **Type Detection**: Automatic float vs integer, bit depth detection
4. **Statistics**: Calculate min/max for normalization
5. **Rendering**: Canvas-based display with ImageData manipulation
6. **Enhancement**: Apply gamma, brightness, normalization in render loop

### Settings Management Strategy
- **Global settings**: Normalization, gamma, brightness applied across all images in session
- **Per-format defaults**: Different defaults for TIFF-float vs TIFF-int vs EXR, etc.
- **Image-specific state**: Per-file mask filters, comparison selection
- **Automatic persistence**: Settings maintained during VS Code session via AppStateManager
- **Real-time updates**: Settings changes trigger re-render via message passing

### Command System
All commands registered with `tiffVisualizer.` prefix ([src/imagePreview/commands.ts](src/imagePreview/commands.ts)):
- **Zoom**: `zoomIn`, `zoomOut`, `resetZoom`
- **Image adjustments**: `setGamma`, `setBrightness`, `setNormalizationRange`
- **Export**: `exportAsPng`, `copyImage`
- **Comparison**: `selectForCompare`, `compareWithSelected`, `openComparisonPanel`, `openNextToCurrent`
- **Filters**: `filterByMask`, `toggleNanColor`
- **Colormap conversion**: `convertColormapToFloat` - converts colormap images to float values
- **Reset**: `resetAllSettings`
- **Histogram**: `toggleHistogram` (Ctrl+H / Cmd+H)

Commands work via:
1. User invokes command → registered handler in extension host
2. Handler may show input prompts or directly update AppStateManager
3. AppStateManager fires change event → status bar updates
4. Extension sends message to webview → webview re-renders

### Float Image Handling
Sophisticated normalization system for float images:
- **Auto normalization**: Calculates min/max from actual data
- **Manual normalization**: User specifies range (e.g., 0.0 to 1.0)
- **Gamma mode**: Apply gamma before or after normalization
- **NaN handling**: Display NaN pixels as black or fuchsia
- **24-bit mode**: Special handling for depth data stored as RGB

### OpenEXR (EXR) Format Support
Comprehensive HDR image support via parse-exr library ([media/modules/exr-processor.js](media/modules/exr-processor.js)):
- **Float precision**: Supports both Float16 (half) and Float32 formats
- **Channel support**: Grayscale (1 channel), RGB (3 channels), RGBA (4 channels)
- **Y-axis flipping**: Automatically handles EXR bottom-left origin vs canvas top-left origin
- **HDR tone mapping**: Applies normalization, gamma, and brightness in sequence
- **Pixel inspection**: Returns raw HDR float values for accurate analysis
- **Per-format defaults**: Uses gamma mode with 0-1 range by default (configurable in AppStateManager)
- **Auto-normalization**: Scans all pixel values to detect actual data range for HDR content
- **Initial load pattern**: Sends format info before rendering to get correct per-format settings
- **Re-rendering**: Supports real-time settings updates without reloading file

## Build Configuration Details

### ESBuild Setup ([esbuild.js](esbuild.js))
```javascript
// Three separate builds:
1. Extension (Node.js) → out/extension.js
2. Extension (Browser) → out/extension.web.js
3. Webview (Browser) → media/imagePreview.js (built in esbuild.js if needed)

// External libraries bundled with webview:
- geotiff.min.js (copied from node_modules during build)
- parse-exr.js (OpenEXR support)
- upng.min.js (PNG decoding)
- pako.min.js (compression support)
```

### Dependencies
- **Core Processing**: `geotiff` (TIFF), `parse-exr` (EXR), `pako` (compression), `upng-js` (PNG)
- **VS Code**: `vscode-uri` (URI handling)
- **Runtime**: `tslib` (TypeScript runtime)
- **Dev Tools**: `esbuild` (bundling), `typescript`, `eslint`
- **Testing**: `mocha`, `chai`, `vscode-extension-tester`

## Testing Strategy

### Three-Tier Testing
1. **Behavioral tests** ([test/simple-behavior-test.js](test/simple-behavior-test.js)): Fast unit tests without VS Code
   - Tests AppStateManager logic in isolation
   - No VS Code API required
   - Run with: `npm run test:behavior`

2. **Visualization tests** ([test/visualization-test.js](test/visualization-test.js)): Image processing verification
   - Tests format processors work correctly
   - Run with: `npm run test:visualization`

3. **UI tests** (Extension Tester): Full VS Code integration tests
   - Tests extension activation, commands, webview interaction
   - Run with: `npm run test:ui`

### Test Images
Test images in `example/` directory:
- **Formats**: UINT8, UINT16, Float32, Float64, OpenEXR
- **Compression**: LZW, Deflate with predictors
- **Use cases**: Scientific imagery, depth maps, disparity maps, HDR

## File Organization

```
src/
├── extension.ts                      # Main extension entry point, activates extension
├── imagePreview/                     # Core image preview functionality
│   ├── index.ts                      # Registers custom editor provider and commands
│   ├── imagePreviewManager.ts        # CustomReadonlyEditorProvider implementation
│   ├── imagePreview.ts               # Main preview class, manages webview
│   ├── appStateManager.ts            # CENTRALIZED state management (settings, UI state)
│   ├── imageSettings.ts              # Per-image settings (mask filters, comparison state)
│   ├── messageHandlers.ts            # Routes messages from webview to handlers
│   ├── messageHandlerSystem.ts       # Message handler interface definitions
│   ├── commands.ts                   # Command implementations
│   ├── types.ts                      # TypeScript interfaces
│   └── *StatusBarEntry.ts            # Individual status bar components (8+ files)
├── comparisonPanel/                  # Side-by-side comparison feature
│   ├── index.ts                      # Comparison panel registration
│   └── comparisonPanel.ts            # Comparison webview panel implementation
├── util/                             # Utility functions (dispose, DOM helpers)
├── ownedStatusBarEntry.ts            # Base class for status bar entries
├── binarySizeStatusBarEntry.ts       # File size status bar entry
└── mediaPreview.ts                   # Base media preview class

media/
├── imagePreview.js                   # Main webview application (orchestrates modules)
├── modules/                          # Modular webview components
│   ├── settings-manager.js           # Webview-side settings management
│   ├── tiff-processor.js             # TIFF loading/processing
│   ├── exr-processor.js              # OpenEXR support
│   ├── npy-processor.js              # NumPy array support
│   ├── pfm-processor.js              # Portable Float Map
│   ├── ppm-processor.js              # PPM/PGM/PBM formats
│   ├── png-processor.js              # PNG with float support
│   ├── zoom-controller.js            # Pan/zoom functionality
│   ├── mouse-handler.js              # Pixel inspection
│   ├── histogram-overlay.js          # Histogram visualization
│   └── colormap-converter.js         # Colormap to float conversion
├── geotiff.min.js                    # TIFF processing library (copied from node_modules)
├── parse-exr.js                      # EXR processing library
├── upng.min.js                       # PNG decoding
├── pako.min.js                       # Compression support
├── comparisonPanel.js                # Comparison panel webview script
└── *.css, *.svg                      # Styling and assets

test/
├── simple-behavior-test.js           # Fast behavioral tests
├── visualization-test.js             # Image processing tests
└── ui/                               # Extension Tester UI tests

example/
└── Various test images in different formats
```

## Common Development Tasks

### Adding New Status Bar Features
1. Create new `*StatusBarEntry.ts` in [src/imagePreview/](src/imagePreview/)
2. Implement `StatusBarEntryInterface` interface
3. Register in `ImagePreviewManager` constructor
4. Add state to `AppStateManager` if needed
5. Add message handling in [messageHandlers.ts](src/imagePreview/messageHandlers.ts) if webview needs to update it
6. Add command in [commands.ts](src/imagePreview/commands.ts) if user interaction needed

### Adding New Image Format Support
1. Create new processor module in [media/modules/](media/modules/) (e.g., `myformat-processor.js`)
2. Implement loading, type detection, and rendering logic
3. Add file extension check in [media/imagePreview.js](media/imagePreview.js) initialization
4. Register file pattern in [package.json](package.json) `customEditors.selector`
5. Add format type to `ImageFormatType` in [appStateManager.ts](src/imagePreview/appStateManager.ts)
6. Set up default settings for the format in `AppStateManager.getDefaultSettings()`
7. Update MouseHandler to support pixel inspection for the new format

### Adding New Commands
1. Register command in [package.json](package.json) `contributes.commands` section
2. Implement handler in [src/imagePreview/commands.ts](src/imagePreview/commands.ts)
3. Update `AppStateManager` if command changes global state
4. Add webview message handling in [messageHandlers.ts](src/imagePreview/messageHandlers.ts) if UI interaction needed
5. Add keyboard shortcut in [package.json](package.json) `contributes.keybindings` if desired
6. Add to context menu in [package.json](package.json) `contributes.menus` if appropriate

### Debugging Extension Host vs Webview
- **Extension host** (TypeScript): Use VS Code debugger (F5), set breakpoints in `src/`
- **Webview** (JavaScript): Use Developer Tools (Help > Toggle Developer Tools), check Console tab
- **Message passing**: Add `console.log` in both extension host and webview to trace messages

### Working with Format Processors
When modifying or debugging format processors (TIFF, EXR, NPY, etc.):
- **Initial load pattern**: Format processors should send `formatInfo` message BEFORE first render
  - This allows AppStateManager to load per-format default settings
  - Store pending render data and wait for settings update callback
  - Example: See ExrProcessor._pendingRenderData and _isInitialLoad pattern
- **Re-rendering**: Implement `updateSettings(settings)` method for real-time updates
- **Raw data storage**: Keep raw data (Float32Array, etc.) for pixel inspection and re-renders
- **Coordinate systems**: Handle origin differences (EXR: bottom-left, Canvas: top-left)
- **Type detection**: Auto-detect bit depth, channels, and data type, send via `formatInfo`

## Important Notes

### Multi-Format Support
The extension handles diverse image formats with format-specific logic:
- **TIFF**: via geotiff.js, supports LZW/Deflate compression, predictors, multi-channel
- **OpenEXR**: via parse-exr, supports HDR, float16/float32, with special handling:
  - Uses FloatType (1015) for Float32Array with decoded values
  - Automatically flips Y-axis (EXR uses bottom-left origin)
  - Stores raw float data for pixel inspection and re-rendering
  - Initial load sends format info before rendering for correct per-format settings
- **NPY/NPZ**: Native NumPy array parsing, supports float and uint types
- **PFM/PPM/PGM/PBM**: NetPBM formats, both binary and ASCII
- **PNG/JPG**: Standard formats with uint8/16 and float16/32 extensions

### Library Integration
- **geotiff.min.js**: Browser build automatically copied from node_modules during build
- **parse-exr.js**: Bundled with extension for OpenEXR support
- **upng.min.js**: PNG decoding with transparency support
- **pako.min.js**: Zlib decompression for various formats

### Security & Performance
- **CSP Compliance**: Webview uses Content Security Policy with nonce-based script loading
- **Cross-platform**: Works in both desktop VS Code and VS Code Web (vscode.dev)
- **Memory Management**: Large files handled efficiently with TypedArrays and canvas rendering
- **Performance**: Canvas-based rendering for pixel-level access, real-time gamma/normalization

### State Persistence
- **Session state**: AppStateManager keeps settings during VS Code window session
- **Webview state**: Uses `vscode.getState()`/`vscode.setState()` for tab switch persistence
- **No workspace state**: Settings reset when VS Code window closes (by design)

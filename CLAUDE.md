# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a VS Code extension that provides advanced TIFF image visualization capabilities, including support for floating-point data types, scientific imagery, and interactive analysis features.

## Development Commands

### Build & Development
```bash
npm install              # Install dependencies
npm run compile          # Build using esbuild (both Node.js and web targets)
npm run watch            # Watch mode for development
npm run vscode:prepublish # Production build
```

### Testing & Quality
```bash
npm run test             # Run all tests (behavior + visualization)
npm run test:behavior    # Run behavioral tests
npm run test:visualization # Run visualization tests
npm run test:ui          # Run UI tests with Extension Tester
npm run lint             # Run ESLint
npm run pretest          # Compile and lint before testing
```

### Extension Testing
- Use F5 in VS Code to launch Extension Development Host
- Test files available in `example/` and `test-workspace/` directories
- Playwright-based tests in `test/playwright/` for web functionality

## Architecture Overview

### Dual Build System
The extension uses a sophisticated dual-target build system:

- **Extension bundle** (`out/extension.js`) - Node.js target for VS Code API integration
- **Web bundle** (`out/extension.web.js`) - Browser target for VS Code Web support
- **Webview bundle** (`media/imagePreview.js`) - Browser-based visualization using modular architecture

### Custom Editor Pattern
Uses VS Code's `CustomReadonlyEditorProvider` API:
- **View Type**: `tiffVisualizer.previewEditor`
- **File associations**: `*.tif`, `*.tiff`
- **Registration**: Handled in `src/imagePreview/index.ts`

### Message Passing Architecture
Extension host ↔ Webview communication via `postMessage`:
- Image data transfer and processing
- Settings synchronization
- Command execution (zoom, gamma, brightness, normalization)
- Pixel value inspection and status updates

### Modular Webview Design
The webview (`media/imagePreview.js`) uses ES6 modules:
- **SettingsManager**: Global settings and state management
- **TiffProcessor**: TIFF loading and processing using geotiff.js
- **ZoomController**: Pan/zoom functionality
- **MouseHandler**: Pixel inspection and interactions

### Status Bar Integration
Comprehensive status bar system with multiple entries:
- **Size**: Image dimensions
- **Zoom**: Current zoom level
- **Normalization**: Float range controls (TIFF-specific)
- **Gamma/Brightness**: Color correction controls
- **Binary Size**: File size information
- **Mask Filter**: Pixel filtering capabilities

## Key Development Patterns

### TIFF Processing Pipeline
1. **Detection**: File extension check (`.tif`, `.tiff`)
2. **Loading**: geotiff.js library for TIFF parsing
3. **Type Detection**: Automatic float vs integer detection
4. **Rendering**: Canvas-based display with pixel-level access
5. **Enhancement**: Gamma correction, brightness, normalization

### Settings Management
- **Global settings**: Applied across all images in session
- **Image-specific settings**: Per-file normalization and adjustments
- **Automatic persistence**: Settings maintained during VS Code session
- **Real-time updates**: Settings changes immediately reflected in UI

### Command System
All commands registered with `tiffVisualizer.` prefix:
- Zoom controls (in, out, reset)
- Image adjustments (gamma, brightness, normalization)
- Export functionality (PNG export)
- Comparison tools (select/compare)

## Build Configuration Details

### ESBuild Setup (`esbuild.js`)
- **Multiple targets**: Node.js extension + browser webview
- **External dependencies**: `vscode` API excluded from bundle
- **Source maps**: Enabled for debugging
- **Watch mode**: Automatic rebuilds during development
- **Test compilation**: Automatic test file detection and compilation

### Dependencies
- **Core**: `geotiff` (TIFF processing), `tslib` (TypeScript runtime)
- **Dev tools**: ESBuild (bundling), TypeScript, ESLint
- **Testing**: Mocha, Chai, VS Code Extension Tester, Playwright

## Testing Strategy

### Multi-Layer Testing
1. **Behavioral tests**: Core extension functionality
2. **Visualization tests**: Image processing verification  
3. **UI tests**: Extension Tester for VS Code integration
4. **Playwright tests**: End-to-end browser testing in VS Code Web

### Test Images
Comprehensive test suite with various TIFF formats:
- **Location**: `example/imgs/imagecodecs/`, `example/imgs/oiio/`
- **Formats**: UINT8, UINT16, Float32, Float64
- **Compression**: LZW, Deflate with predictors
- **Use case**: Scientific imagery, depth maps, disparity maps

## File Organization

```
src/
├── extension.ts              # Main extension entry point
├── imagePreview/            
│   ├── index.ts             # Registration and command handling
│   ├── imagePreviewManager.ts # Custom editor provider
│   ├── imagePreview.ts      # Main preview class
│   ├── imageSettings.ts     # Settings management
│   ├── appStateManager.ts   # Application state
│   ├── messageHandlers.ts   # Webview message routing
│   └── *StatusBarEntry.ts   # Individual status bar components
├── util/                    # Utility functions
└── adapters/               # VS Code API adapters

media/
├── imagePreview.js         # Main webview application
├── modules/                # Modular webview components
├── geotiff.min.js         # TIFF processing library
└── *.css, *.svg           # Styling and assets
```

## Common Development Tasks

### Adding New Status Bar Features
1. Create new `*StatusBarEntry.ts` in `src/imagePreview/`
2. Implement `StatusBarEntryInterface`
3. Register in `ImagePreviewManager` constructor
4. Add message handling in `messageHandlers.ts`

### Extending TIFF Processing
1. Modify `TiffProcessor` module in `media/modules/`
2. Update settings schema in `imageSettings.ts`
3. Add corresponding status bar entries if needed
4. Update message passing between extension and webview

### Adding New Commands
1. Register command in `package.json` contributes section
2. Implement handler in `src/imagePreview/commands.ts`
3. Add webview message handling if UI interaction needed
4. Update keyboard shortcuts or context menus as appropriate

## Important Notes

- **geotiff.js Integration**: Browser build automatically copied from node_modules during build
- **CSP Compliance**: Webview uses Content Security Policy with nonce-based script loading
- **Cross-platform**: Works in both desktop VS Code and VS Code Web
- **Memory Management**: Large TIFF files handled with chunked processing
- **Performance**: Canvas-based rendering for pixel-level access and real-time updates
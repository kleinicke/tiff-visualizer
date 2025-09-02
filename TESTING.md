# TIFF Visualizer Testing Guide

This guide explains how to set up and run tests for the TIFF Visualizer VS Code extension using Playwright.

## Overview

The TIFF Visualizer extension uses Playwright to test its functionality in VS Code Web. The tests focus on:

- Opening TIFF files automatically
- Mouse interactions and pixel value display
- Status bar information (image size, zoom level, etc.)
- Extension commands (zoom, brightness, gamma, normalization)
- Canvas rendering and image display

## Prerequisites

### Required Files

The tests require specific TIFF test images located in:
- `example/imgs/imagecodecs/img_deflate_uint8_pred2.tif` (UINT8 test image)
- `example/imgs/imagecodecs/depth_deflate_32_pred3.tif` (Float32 test image)

### Dependencies

1. **Playwright**: `@playwright/test`
2. **VS Code Web Test Utilities**: `@vscode/test-web`
3. **Node.js**: Version 16 or higher

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Setup Playwright

```bash
# Run the setup script
npm run setup:playwright

# Or manually:
npm install @playwright/test
npx playwright install
```

### 3. Verify Test Images

```bash
# Check if test images exist
ls -la example/imgs/imagecodecs/
```

## Running Tests

### Quick Start

```bash
# Run all TIFF tests
npm run test:tiff

# Run tests in UI mode (recommended for development)
npm run test:tiff:ui

# Run tests in debug mode
npm run test:tiff:debug

# Run only mouse interaction tests
npm run test:tiff:mouse
```

### Manual Test Execution

```bash
# Start VS Code Web server (in one terminal)
npm run start:vscode-web

# Run tests (in another terminal)
npx playwright test tiff-mouse-test.spec.ts
```

## Test Files

### `tiff-mouse-test.spec.ts`
- **Purpose**: Tests mouse interactions and pixel value display
- **Features Tested**:
  - Opening UINT8 and Float32 TIFF files
  - Mouse hover and movement over images
  - Status bar information display
  - Extension commands execution
  - Canvas rendering verification

### `tiff-comprehensive-test.spec.ts`
- **Purpose**: Comprehensive functionality testing
- **Features Tested**:
  - All mouse interaction features
  - Detailed status bar analysis
  - Zoom functionality
  - Command execution with error handling

### `tiff-interactive-test.spec.ts`
- **Purpose**: Interactive test scenarios
- **Features Tested**:
  - File opening mechanisms
  - Pixel value reading
  - Status bar entries validation

## Test Structure

### Test Flow

1. **Setup**: Verify test images exist and are valid TIFF files
2. **VS Code Web Launch**: Start VS Code Web server
3. **File Opening**: Open TIFF files using VS Code API
4. **Canvas Verification**: Ensure image renders correctly
5. **Mouse Testing**: Test mouse interactions and pixel reading
6. **Status Bar Testing**: Verify status bar displays correct information
7. **Command Testing**: Execute extension commands
8. **Cleanup**: Stop VS Code Web server

### Key Test Functions

```typescript
// Open TIFF file in VS Code Web
async function openTIFFFile(page: any, imagePath: string)

// Wait for canvas to load with content
async function waitForCanvas(page: any)

// Test mouse interactions across image
async function testMouseInteractions(page: any, canvas: any)

// Check status bar entries
async function checkStatusBarEntries(page: any)
```

## Expected Test Results

### Successful Test Indicators

- ✅ VS Code Web loads successfully
- ✅ TIFF files open in custom editor
- ✅ Canvas element is visible and has content
- ✅ Mouse interactions work across image
- ✅ Status bar shows relevant information
- ✅ Extension commands execute without errors

### What to Look For

1. **Image Display**: Canvas should show the TIFF image content
2. **Mouse Position**: Mouse coordinates should update when moving over image
3. **Pixel Values**: Color values should display when hovering over pixels
4. **Status Bar**: Should show image size, zoom level, and other metadata
5. **Commands**: Gamma, brightness, and normalization commands should execute

## Troubleshooting

### Common Issues

#### 1. Images Not Opening
```bash
# Check if test images exist
ls -la example/imgs/imagecodecs/

# Verify TIFF file headers
file example/imgs/imagecodecs/*.tif
```

#### 2. VS Code Web Not Starting
```bash
# Check if port 3000 is available
lsof -i :3000

# Try starting manually
npx @vscode/test-web --extensionDevelopmentPath=. --port=3000
```

#### 3. Canvas Not Loading
- Ensure VS Code Web has loaded completely
- Check browser console for JavaScript errors
- Verify extension is activated

#### 4. Mouse Interactions Not Working
- Check if canvas element is properly rendered
- Verify mouse coordinates are within canvas bounds
- Ensure pixel value display is implemented

### Debug Mode

```bash
# Run tests in debug mode with browser visible
npm run test:tiff:debug

# Run specific test with debugging
npx playwright test tiff-mouse-test.spec.ts --debug
```

### Verbose Logging

The tests include extensive console logging to help debug issues:

```typescript
console.log('✅ VS Code Web loaded');
console.log('✅ TIFF Visualizer custom editor loaded');
console.log('✅ Canvas element found');
console.log(`✅ Image loaded with dimensions: ${width}x${height}`);
console.log('✅ Mouse hovered over image');
console.log(`✅ Mouse moved to ${position}`);
```

## Test Configuration

### Playwright Configuration

The tests use the following configuration:

```typescript
// playwright.config.ts
export default defineConfig({
  testDir: './test/playwright',
  use: {
    baseURL: 'http://localhost:3000',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run start:vscode-web',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
});
```

### VS Code Web Configuration

The VS Code Web server is configured to:
- Load the TIFF Visualizer extension
- Use the test workspace
- Enable extension development mode

## Continuous Integration

### GitHub Actions Example

```yaml
name: TIFF Visualizer Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npm run test:tiff
      - uses: actions/upload-artifact@v3
        if: always()
        with:
          name: test-results
          path: test-results/
```

## Best Practices

### Writing Tests

1. **Use descriptive test names**: Clearly indicate what functionality is being tested
2. **Include proper setup/teardown**: Ensure clean test environment
3. **Add comprehensive logging**: Help with debugging test failures
4. **Test error scenarios**: Include negative test cases
5. **Verify expected behavior**: Don't just check for absence of errors

### Test Maintenance

1. **Keep test images small**: Use minimal TIFF files for faster tests
2. **Update tests with new features**: Add tests for new extension functionality
3. **Monitor test stability**: Address flaky tests promptly
4. **Document test scenarios**: Keep this guide updated

## Contributing

When adding new tests:

1. Follow the existing test structure
2. Add appropriate logging
3. Test both UINT8 and Float32 TIFF files
4. Include error handling
5. Update this documentation

## Support

For issues with testing:

1. Check the console output for detailed error messages
2. Run tests in debug mode to see browser interactions
3. Verify all prerequisites are met
4. Check the GitHub repository for known issues

---

This testing framework ensures the TIFF Visualizer extension works correctly across different image types and provides a reliable way to verify functionality during development. 
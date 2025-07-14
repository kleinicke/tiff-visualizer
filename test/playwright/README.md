# Playwright Testing for TIFF Visualizer Extension

This directory contains Playwright tests for the TIFF Visualizer VS Code extension.

## Overview

Playwright can be used to test VS Code extensions in several ways:

1. **VS Code Web Testing**: Test the extension in VS Code's web version
2. **Custom Editor Testing**: Test the webview content of custom editors
3. **UI Automation**: Automate VS Code interface interactions

## Setup

### 1. Install Dependencies

```bash
npm install
```

This will install Playwright and its browsers.

### 2. Install Playwright Browsers

```bash
npx playwright install
```

### 3. VS Code Web Setup

For testing VS Code Web, you'll need to set up a local VS Code Web server:

```bash
# Install VS Code Web test utilities
npm install -g @vscode/test-web

# Start VS Code Web with your extension
npm run start:vscode-web
```

## Running Tests

### Basic Test Commands

```bash
# Run all Playwright tests
npm run test:playwright

# Run tests with UI mode (interactive)
npm run test:playwright:ui

# Run tests in debug mode
npm run test:playwright:debug

# Run specific test file
npx playwright test vscode-web-test.spec.ts

# Run tests in specific browser
npx playwright test --project=chromium
```

### Test Modes

1. **Headless Mode** (default): Runs tests without browser UI
2. **UI Mode**: Opens Playwright UI for interactive testing
3. **Debug Mode**: Runs tests with browser visible and paused on failures

## Testing with Cursor

Since Cursor is a VS Code fork, you can test your extension in Cursor by:

### 1. Cursor Web Testing

```bash
# Modify the webServer command in playwright.config.ts to point to Cursor Web
# You may need to find Cursor's web endpoint or run Cursor in web mode
```

### 2. Cursor Desktop Testing

For desktop Cursor testing, you can use Playwright's ability to launch desktop applications:

```typescript
// In your test file
test('test in Cursor desktop', async ({ page }) => {
  // Launch Cursor desktop app
  const browser = await chromium.launch({
    executablePath: '/Applications/Cursor.app/Contents/MacOS/Cursor' // macOS path
  });
  
  // Test your extension
});
```

## Test Structure

### Current Tests

1. **`vscode-web-test.spec.ts`**: Basic VS Code Web interface tests
2. **`tiff-visualizer.spec.ts`**: Comprehensive TIFF Visualizer functionality tests

### Test Categories

- **UI Tests**: Verify VS Code interface elements
- **Extension Tests**: Test extension commands and functionality
- **Custom Editor Tests**: Test TIFF file opening and display
- **Integration Tests**: Test full workflows

## Writing Tests

### Basic Test Structure

```typescript
import { test, expect } from '@playwright/test';

test.describe('Your Test Suite', () => {
  test('should do something', async ({ page }) => {
    // Navigate to VS Code Web
    await page.goto('/');
    
    // Wait for VS Code to load
    await page.waitForSelector('.monaco-editor');
    
    // Your test logic here
    await expect(page.locator('.some-element')).toBeVisible();
  });
});
```

### VS Code Specific Selectors

```typescript
// Common VS Code selectors
const selectors = {
  workbench: '.monaco-workbench',
  editor: '.monaco-editor',
  statusBar: '.statusbar',
  activityBar: '.activitybar',
  sidebar: '.sidebar',
  commandPalette: '.monaco-quick-input-widget',
  contextMenu: '.monaco-menu'
};
```

### Testing Custom Editors

```typescript
test('should open TIFF file in custom editor', async ({ page }) => {
  // Open a TIFF file
  await page.evaluate(() => {
    // Simulate file opening
    vscode.workspace.openTextDocument(uri);
  });
  
  // Wait for custom editor
  await page.waitForSelector('[data-viewtype="tiffVisualizer.previewEditor"]');
  
  // Test custom editor content
  const canvas = await page.locator('canvas');
  await expect(canvas).toBeVisible();
});
```

## Configuration

### Playwright Config

The `playwright.config.ts` file configures:

- Test directory: `./test/playwright`
- Browsers: Chromium, Firefox, WebKit
- Web server: VS Code Web on localhost:3000
- Screenshots and videos on failure
- Parallel test execution

### Environment Variables

```bash
# Run tests in CI mode
CI=true npm run test:playwright

# Run with specific browser
PLAYWRIGHT_BROWSER=chromium npm run test:playwright
```

## Debugging

### Debug Mode

```bash
npm run test:playwright:debug
```

This will:
- Open browser in visible mode
- Pause on test failures
- Allow step-by-step debugging

### Screenshots and Videos

Failed tests automatically generate:
- Screenshots in `test-results/`
- Videos in `test-results/`
- Traces for debugging

### Logs

```bash
# Run with debug logging
DEBUG=pw:api npm run test:playwright
```

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Playwright Tests
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
      - run: npm run test:playwright
      - uses: actions/upload-artifact@v3
        if: always()
        with:
          name: playwright-report
          path: playwright-report/
```

## Limitations and Considerations

### VS Code Web Limitations

1. **File System Access**: Limited file system access in web version
2. **Native APIs**: Some VS Code APIs may not work in web
3. **Performance**: Web version may be slower than desktop

### Cursor Compatibility

1. **API Differences**: Cursor may have different APIs than VS Code
2. **Web Endpoints**: Cursor's web version may have different endpoints
3. **Extension Loading**: Extension loading mechanism may differ

### Best Practices

1. **Test Real Scenarios**: Focus on user workflows
2. **Handle Async Operations**: VS Code operations are often async
3. **Use Reliable Selectors**: VS Code UI can change between versions
4. **Test Multiple Browsers**: Ensure cross-browser compatibility

## Troubleshooting

### Common Issues

1. **Tests Timeout**: Increase timeout values for slow operations
2. **Selector Not Found**: VS Code UI may have changed
3. **Extension Not Loaded**: Check extension activation
4. **File Access Issues**: Use proper file URIs and permissions

### Getting Help

- [Playwright Documentation](https://playwright.dev/)
- [VS Code Extension Testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
- [VS Code Web](https://github.com/microsoft/vscode/wiki/Adopt-a-Codebase-in-VS-Code-Web) 
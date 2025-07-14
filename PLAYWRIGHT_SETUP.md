# Playwright Testing Setup for TIFF Visualizer Extension

## Quick Start

### 1. Install Playwright
```bash
npm run setup:playwright
```

### 2. Run Tests
```bash
# Run all tests
npm run test:playwright

# Run with UI (interactive)
npm run test:playwright:ui

# Run in debug mode
npm run test:playwright:debug
```

## What I've Set Up

### ✅ **Playwright Configuration**
- `playwright.config.ts` - Main configuration file
- Supports Chromium, Firefox, and WebKit browsers
- Automatic screenshots and videos on failure
- VS Code Web integration

### ✅ **Test Files**
- `test/playwright/vscode-web-test.spec.ts` - Basic VS Code Web tests
- `test/playwright/tiff-visualizer.spec.ts` - Comprehensive extension tests
- `test/playwright/cursor-test.spec.ts` - Cursor-specific tests

### ✅ **Package Scripts**
- `npm run test:playwright` - Run all Playwright tests
- `npm run test:playwright:ui` - Interactive UI mode
- `npm run test:playwright:debug` - Debug mode
- `npm run setup:playwright` - Setup script

### ✅ **CI/CD Integration**
- `.github/workflows/playwright-tests.yml` - GitHub Actions workflow
- Automatic testing on push/PR
- Separate job for Cursor testing

### ✅ **Documentation**
- `test/playwright/README.md` - Detailed documentation
- Setup scripts and troubleshooting guides

## Testing VS Code Extensions with Playwright

### **Yes, you can test VS Code extensions with Playwright!**

Playwright is excellent for testing VS Code extensions because:

1. **VS Code Web**: VS Code has a web version that runs in browsers
2. **Custom Editors**: Your TIFF Visualizer uses custom editors (webviews)
3. **UI Automation**: Playwright can automate VS Code interface interactions
4. **Cross-browser**: Test in multiple browsers (Chrome, Firefox, Safari)

### **Testing Approaches**

1. **VS Code Web Testing**: Test extension in VS Code's web version
2. **Custom Editor Testing**: Test webview content directly
3. **UI Integration**: Test VS Code interface interactions
4. **Command Testing**: Test extension commands and workflows

## Testing in Cursor

### **Yes, you can test in Cursor!**

Since Cursor is a VS Code fork:

1. **Similar APIs**: Most VS Code APIs work in Cursor
2. **Web Version**: Cursor has a web version for testing
3. **Desktop Testing**: Can launch Cursor desktop app with Playwright
4. **Extension Compatibility**: Extensions generally work in both

### **Cursor-Specific Considerations**

- **API Differences**: Some APIs may behave differently
- **UI Elements**: Cursor may have additional UI elements
- **Performance**: May have different performance characteristics
- **File Handling**: File operations might differ slightly

## What the Tests Cover

### **VS Code Web Tests**
- Interface loading and responsiveness
- Extension command availability
- File operations
- UI element visibility

### **TIFF Visualizer Tests**
- Custom editor loading
- Image preview display
- Status bar entries
- Zoom controls
- Context menu commands
- Different image formats

### **Cursor Tests**
- Cursor-specific functionality
- UI element compatibility
- File operation differences
- Extension loading in Cursor

## Running Tests Locally

### **Prerequisites**
```bash
# Install dependencies
npm install

# Setup Playwright
npm run setup:playwright
```

### **Test Commands**
```bash
# Run all tests
npm run test:playwright

# Run specific test file
npx playwright test vscode-web-test.spec.ts

# Run in specific browser
npx playwright test --project=chromium

# Run with UI (interactive)
npm run test:playwright:ui

# Run in debug mode
npm run test:playwright:debug
```

### **VS Code Web Setup**
```bash
# Start VS Code Web server
npm run start:vscode-web

# In another terminal, run tests
npm run test:playwright
```

## Automated Testing

### **GitHub Actions**
The workflow automatically:
- Runs tests on push/PR
- Tests in multiple browsers
- Generates reports and artifacts
- Separate testing for Cursor compatibility

### **CI/CD Benefits**
- **Early Detection**: Catch issues before they reach users
- **Cross-browser**: Test in Chrome, Firefox, Safari
- **Regression Testing**: Ensure new changes don't break existing functionality
- **Documentation**: Test results serve as living documentation

## Debugging Tests

### **Debug Mode**
```bash
npm run test:playwright:debug
```
- Opens browser in visible mode
- Pauses on failures
- Step-by-step debugging

### **UI Mode**
```bash
npm run test:playwright:ui
```
- Interactive test runner
- Real-time test execution
- Easy debugging and development

### **Screenshots and Videos**
Failed tests automatically generate:
- Screenshots in `test-results/`
- Videos in `test-results/`
- Traces for debugging

## Limitations and Considerations

### **VS Code Web Limitations**
- Limited file system access
- Some native APIs may not work
- Performance may differ from desktop

### **Cursor Compatibility**
- API differences between VS Code and Cursor
- UI element variations
- Extension loading differences

### **Best Practices**
- Test real user workflows
- Handle async operations properly
- Use reliable selectors
- Test multiple browsers

## Next Steps

1. **Run the setup**: `npm run setup:playwright`
2. **Start with basic tests**: `npm run test:playwright`
3. **Explore interactive mode**: `npm run test:playwright:ui`
4. **Add more specific tests** for your extension features
5. **Integrate with your CI/CD** pipeline

## Resources

- [Playwright Documentation](https://playwright.dev/)
- [VS Code Extension Testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
- [VS Code Web](https://github.com/microsoft/vscode/wiki/Adopt-a-Codebase-in-VS-Code-Web)
- [Cursor Documentation](https://cursor.sh/docs)

---

**Ready to test your TIFF Visualizer extension with Playwright! 🚀** 
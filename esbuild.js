const { build } = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');

// Build extension for Node.js (desktop)
const extensionBuildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  target: 'node16',
  external: ['vscode'],
  sourcemap: true,
};

// Build extension for browser (web)
const extensionWebBuildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.web.js',
  platform: 'browser',
  target: 'es2020',
  external: ['vscode'],
  sourcemap: true,
  format: 'iife',
  globalName: 'TIFFVisualizerExtension'
};

// Build AppStateManager separately for testing
const appStateManagerBuildOptions = {
  entryPoints: ['src/imagePreview/appStateManager.ts'],
  bundle: true,
  outfile: 'out/src/imagePreview/appStateManager.js',
  platform: 'node',
  target: 'node16',
  external: ['vscode'],
  sourcemap: true,
  format: 'cjs'
};

// Build webview scripts
const webviewBuildOptions = {
  entryPoints: ['media/imagePreview.js'],
  bundle: true,
  outfile: 'media/imagePreview.bundle.js',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  format: 'esm',
};

// Build tests if they exist
const testBuildOptions = {
  entryPoints: [],
  bundle: true,
  outdir: 'out/test',
  platform: 'node',
  target: 'node16',
  external: [
    'vscode',
    'assert',
    'mocha',
    'chai',
    'vscode-extension-tester',
    'selenium-webdriver',
    'keytar',
    '@aws-sdk/client-s3',
    'monocart-coverage-reports',
    'unzipper',
    'c8'
  ],
  sourcemap: true,
  format: 'cjs'
};

// Find test files recursively
function findTestFiles(dir) {
  let testFiles = [];
  if (fs.existsSync(dir)) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        testFiles = testFiles.concat(findTestFiles(fullPath));
      } else if (item.endsWith('.test.ts')) {
        testFiles.push(fullPath);
      }
    }
  }
  return testFiles;
}

const testFiles = findTestFiles('test');
if (testFiles.length > 0) {
  testBuildOptions.entryPoints = testFiles;
  console.log('Found test files:', testFiles);
}

if (isWatch) {
  extensionBuildOptions.watch = {
    onRebuild(error) {
      if (error) {
        console.error('extension watch build failed:', error);
      } else {
        console.log('extension watch build succeeded');
      }
    },
  };

  if (testBuildOptions.entryPoints.length > 0) {
    testBuildOptions.watch = {
      onRebuild(error) {
        if (error) {
          console.error('test watch build failed:', error);
        } else {
          console.log('test watch build succeeded');
        }
      },
    };
  }

  webviewBuildOptions.watch = {
    onRebuild(error) {
      if (error) {
        console.error('webview watch build failed:', error);
      } else {
        console.log('webview watch build succeeded');
      }
    },
  };
}

async function buildAll() {
  try {
    // Build extension for Node.js
    await build(extensionBuildOptions);
    console.log('Extension (Node.js) built successfully');

    // Build extension for browser
    await build(extensionWebBuildOptions);
    console.log('Extension (Web) built successfully');

    // Build AppStateManager separately for testing
    await build(appStateManagerBuildOptions);
    console.log('AppStateManager built successfully');

    // Build webview scripts
    await build(webviewBuildOptions);
    console.log('Webview scripts built successfully');

    // Build tests if they exist
    if (testBuildOptions.entryPoints.length > 0) {
      await build(testBuildOptions);
      console.log('Tests built successfully');
    }
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

buildAll(); 
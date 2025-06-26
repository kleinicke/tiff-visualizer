const { build } = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');

// Build extension
const extensionBuildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  target: 'node16',
  external: ['vscode'],
  sourcemap: true,
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

// Build tests if they exist
const testBuildOptions = {
  entryPoints: [],
  bundle: true,
  outdir: 'out/test',
  platform: 'node',
  target: 'node16',
  external: ['vscode', 'assert', 'mocha'],
  sourcemap: true,
  format: 'cjs'
};

// Find test files
const testDir = 'test';
if (fs.existsSync(testDir)) {
  const testFiles = fs.readdirSync(testDir)
    .filter(file => file.endsWith('.test.ts'))
    .map(file => path.join(testDir, file));
  
  if (testFiles.length > 0) {
    testBuildOptions.entryPoints = testFiles;
    console.log('Found test files:', testFiles);
  }
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
}

async function buildAll() {
  try {
    // Build extension
    await build(extensionBuildOptions);
    console.log('Extension built successfully');
    
    // Build AppStateManager separately for testing
    await build(appStateManagerBuildOptions);
    console.log('AppStateManager built successfully');
    
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
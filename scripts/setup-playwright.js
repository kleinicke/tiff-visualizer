#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🚀 Setting up Playwright for VS Code Extension Testing...\n');

// Check if package.json exists
const packageJsonPath = path.join(process.cwd(), 'package.json');
if (!fs.existsSync(packageJsonPath)) {
  console.error('❌ package.json not found. Please run this script from the project root.');
  process.exit(1);
}

try {
  // Install Playwright if not already installed
  console.log('📦 Installing Playwright...');
  execSync('npm install @playwright/test', { stdio: 'inherit' });
  
  // Install Playwright browsers
  console.log('🌐 Installing Playwright browsers...');
  execSync('npx playwright install', { stdio: 'inherit' });
  
  // Install VS Code Web test utilities
  console.log('🔧 Installing VS Code Web test utilities...');
  execSync('npm install @vscode/test-web', { stdio: 'inherit' });
  
  console.log('\n✅ Playwright setup complete!');
  console.log('\n📋 Next steps:');
  console.log('1. Run tests: npm run test:playwright');
  console.log('2. Run tests with UI: npm run test:playwright:ui');
  console.log('3. Run tests in debug mode: npm run test:playwright:debug');
  console.log('\n📖 See test/playwright/README.md for detailed documentation');
  
} catch (error) {
  console.error('❌ Setup failed:', error.message);
  process.exit(1);
} 
// Script to bundle parse-exr and fflate for browser use
const fs = require('fs');
const path = require('path');

console.log('Bundling parse-exr for browser...');

// Read fflate
const fflatePath = path.join(__dirname, '../node_modules/fflate/esm/browser.js');
const fflateContent = fs.readFileSync(fflatePath, 'utf8');

// Read parse-exr
const parseExrPath = path.join(__dirname, '../node_modules/parse-exr/index.js');
let parseExrContent = fs.readFileSync(parseExrPath, 'utf8');

// Replace the import statement with a reference to the fflate object
// We'll bundle fflate as a module and make it available
parseExrContent = parseExrContent.replace('import * as fflate from "fflate";', '// fflate bundled below');

// Create the bundled file
const bundled = `// Bundled parse-exr with fflate for browser use
// Auto-generated - do not edit manually

(function() {
'use strict';

// ========== fflate module ==========
const fflate = (function() {
  const exports = {};
  const module = { exports };

  ${fflateContent.replace(/export \{[^}]+\};?/g, '').replace(/export /g, 'exports.')}

  return exports;
})();

// ========== parse-exr module ==========
${parseExrContent}

// Expose parseExr to global scope
window.parseExr = parseExr;
window.parseExrTypes = {
  FloatType,
  HalfFloatType,
  RGBAFormat,
  RedFormat,
  NoColorSpace,
  LinearSRGBColorSpace
};

console.log('parse-exr loaded successfully');
})();
`;

// Write the bundled file
const outputPath = path.join(__dirname, '../media/parse-exr.js');
fs.writeFileSync(outputPath, bundled, 'utf8');

console.log(`✓ Bundled parse-exr written to ${outputPath}`);
console.log(`  Size: ${(bundled.length / 1024).toFixed(2)} KB`);

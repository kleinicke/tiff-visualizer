#!/bin/bash
set -e

# Ensure wasm-pack is installed
if ! command -v wasm-pack &> /dev/null; then
    echo "wasm-pack could not be found. Please install it first."
    exit 1
fi

echo "Building WASM module..."
cd wasm/tiff-decoder

# Build with wasm-pack
# SIMD128 is enabled deliberately: it is a codegen-only change (identical
# decoder output) worth 5-64% on the decode paths. See BACKLOG.md item 11 step 3d.
RUSTFLAGS="-C target-feature=+simd128" \
  wasm-pack build --target web --out-dir ../../media/wasm --out-name tiff-wasm --no-typescript

echo "WASM build complete!"

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
wasm-pack build --target web --out-dir ../../media/wasm --out-name tiff-wasm --no-typescript

echo "WASM build complete!"

#!/bin/sh
# C compiler for building wasm32 C code (zstd) with `zig cc`; point CC_wasm32_unknown_unknown at this
# script (or at any clang that can target wasm32). See docs/xenium.md, "Rebuilding the transcripts decoder".
args=""
for a in "$@"; do case "$a" in --target=wasm32-unknown-unknown|-fuse-ld=*) ;; *) args="$args $a";; esac; done
exec zig cc -target wasm32-freestanding -fno-sanitize=undefined $args

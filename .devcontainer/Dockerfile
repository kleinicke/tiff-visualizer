FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm

# Install Rust via rustup
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.94.0
ENV PATH="/root/.cargo/bin:${PATH}"

# Add wasm32 target and install wasm-pack + wasm-opt
RUN rustup target add wasm32-unknown-unknown \
    && cargo install wasm-pack --version 0.14.0 \
    && apt-get update && apt-get install -y --no-install-recommends \
       binaryen \
    && rm -rf /var/lib/apt/lists/*

# Install vsce globally for packaging
RUN npm install -g @vscode/vsce

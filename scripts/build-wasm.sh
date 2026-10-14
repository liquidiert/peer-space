#!/usr/bin/env bash
# Builds the iroh media wasm module and generates JS bindings into src/wasm/.
# Needs: rustup target add wasm32-unknown-unknown, clang, and
# cargo install wasm-bindgen-cli --version 0.2.128 (must match Cargo.toml).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
( cd crates/peer-media && cargo build --release )
wasm-bindgen --target web --out-dir src/wasm \
  crates/peer-media/target/wasm32-unknown-unknown/release/peer_media.wasm
# wasm-opt roughly halves the module. Install binaryen, or use `bunx --package binaryen wasm-opt`.
WASM_OPT=${WASM_OPT:-$(command -v wasm-opt || true)}
if [ -n "$WASM_OPT" ]; then
  # The features rustc's wasm32 target enables by default.
  $WASM_OPT -Os --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals --enable-reference-types --enable-multivalue \
    src/wasm/peer_media_bg.wasm -o src/wasm/peer_media_bg.wasm
else
  echo "wasm-opt not found: the module is not size-optimized" >&2
fi
ls -lh src/wasm/peer_media_bg.wasm

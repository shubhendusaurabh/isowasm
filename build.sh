#!/usr/bin/env sh
# Builds the wasm module + JS bindings into pkg/ and copies them into demo/pkg/.
# Requirements:
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli --version <same as wasm-bindgen in Cargo.lock>
#   wasm-opt (optional, from binaryen) shrinks the output
set -e
cd "$(dirname "$0")"

cargo build --target wasm32-unknown-unknown --release
rm -rf pkg
wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/isowasm.wasm
if command -v wasm-opt >/dev/null; then
  wasm-opt -Os --enable-bulk-memory --enable-nontrapping-float-to-int --enable-reference-types \
    -o pkg/isowasm_bg.wasm pkg/isowasm_bg.wasm
fi
rm -rf demo/pkg && cp -r pkg demo/pkg
echo "built pkg/ ($(wc -c < pkg/isowasm_bg.wasm) bytes of wasm)"

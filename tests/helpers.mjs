import fs from "node:fs";
import { initSync } from "../pkg/isowasm.js";

let ready = false;
export function loadWasm() {
  if (!ready) {
    initSync({ module: fs.readFileSync(new URL("../pkg/isowasm_bg.wasm", import.meta.url)) });
    ready = true;
  }
}

const enc = new TextEncoder();

/**
 * Turns { "a/b.txt": "text" | Uint8Array, "empty/": null } into the
 * entries + read callback the library expects.
 */
export function tree(spec, mtime = Date.UTC(2024, 0, 2, 3, 4, 5)) {
  const entries = [], data = [];
  for (const [path, content] of Object.entries(spec)) {
    if (content === null) {
      entries.push({ path: path.replace(/\/$/, ""), dir: true });
      data.push(null);
    } else {
      const bytes = typeof content === "string" ? enc.encode(content) : content;
      entries.push({ path, size: bytes.length, mtime });
      data.push(bytes);
    }
  }
  const read = (i, offset, length) => data[i].slice(offset, offset + length);
  return { entries, data, read };
}

export function randomBytes(n, seed = 1) {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** Mimics FileSystemSyncAccessHandle, backed by a growable buffer. */
export class MemoryHandle {
  constructor() { this.buf = new Uint8Array(1 << 20); this.size = 0; this.calls = { write: 0, read: 0 }; }
  #ensure(n) {
    if (n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < n) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.size));
    this.buf = b;
  }
  write(data, { at = 0 } = {}) {
    this.calls.write++;
    this.#ensure(at + data.length);
    this.buf.set(data, at);
    this.size = Math.max(this.size, at + data.length);
    return data.length;
  }
  read(out, { at = 0 } = {}) {
    this.calls.read++;
    const n = Math.max(0, Math.min(out.length, this.size - at));
    out.set(this.buf.subarray(at, at + n));
    return n;
  }
  getSize() { return this.size; }
  truncate(n) { this.size = n; this.buf.fill(0, n); }
  flush() {}
  close() {}
  bytes() { return this.buf.slice(0, this.size); }
}

/**
 * Mimics FileSystemSyncAccessHandle but keeps only 2 KiB blocks that contain
 * non-zero bytes, so multi-GB images of mostly zeros fit in a little memory.
 */
export class SparseHandle {
  static BLOCK = 2048;
  constructor() { this.blocks = new Map(); this.size = 0; }
  write(data, { at = 0 } = {}) {
    const B = SparseHandle.BLOCK;
    let pos = 0;
    while (pos < data.length) {
      const abs = at + pos, idx = Math.floor(abs / B), inBlock = abs - idx * B;
      const n = Math.min(B - inBlock, data.length - pos);
      const chunk = data.subarray(pos, pos + n);
      let block = this.blocks.get(idx);
      if (block || !isZero(chunk)) {
        if (!block) this.blocks.set(idx, (block = new Uint8Array(B)));
        block.set(chunk, inBlock);
      }
      pos += n;
    }
    this.size = Math.max(this.size, at + data.length);
    return data.length;
  }
  read(out, { at = 0 } = {}) {
    const n = Math.max(0, Math.min(out.length, this.size - at));
    out.set(this.readAt(at, n));
    return n;
  }
  readAt(offset, length) {
    const B = SparseHandle.BLOCK, out = new Uint8Array(length);
    for (let pos = 0; pos < length; ) {
      const abs = offset + pos, idx = Math.floor(abs / B), inBlock = abs - idx * B;
      const n = Math.min(B - inBlock, length - pos);
      const block = this.blocks.get(idx);
      if (block) out.set(block.subarray(inBlock, inBlock + n), pos);
      pos += n;
    }
    return out;
  }
  getSize() { return this.size; }
  truncate(n) { this.size = n; for (const k of this.blocks.keys()) if (k * SparseHandle.BLOCK >= n) this.blocks.delete(k); }
  flush() {}
  close() {}
}

function isZero(b) {
  // Fast path over aligned 32-bit words.
  const start = (4 - (b.byteOffset % 4)) % 4;
  for (let i = 0; i < Math.min(start, b.length); i++) if (b[i]) return false;
  const words = Math.floor((b.length - start) / 4);
  const w = new Uint32Array(b.buffer, b.byteOffset + start, words);
  for (let i = 0; i < w.length; i++) if (w[i]) return false;
  for (let i = start + words * 4; i < b.length; i++) if (b[i]) return false;
  return true;
}

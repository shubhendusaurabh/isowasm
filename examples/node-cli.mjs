// Usage: node examples/node-cli.mjs <folder> <out.iso> [optionsJSON]
// Builds an ISO from a folder using the wasm module (in-memory mode).
import fs from "node:fs";
import path from "node:path";
import { initSync, buildIsoToMemory, estimateIsoSize } from "../pkg/isowasm.js";

const [dir, out, optJson] = process.argv.slice(2);
initSync({ module: fs.readFileSync(new URL("../pkg/isowasm_bg.wasm", import.meta.url)) });

const entries = [], abs = [];
(function walk(rel) {
  for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    const st = fs.statSync(path.join(dir, r));
    if (d.isDirectory()) { entries.push({ path: r, dir: true }); abs.push(null); walk(r); }
    else { entries.push({ path: r, size: st.size, mtime: st.mtimeMs }); abs.push(path.join(dir, r)); }
  }
})("");

const opts = optJson ? JSON.parse(optJson) : { volumeName: "TEST" };
const read = (i, off, len) => {
  const buf = new Uint8Array(len), fd = fs.openSync(abs[i], "r");
  let got = 0;
  while (got < len) got += fs.readSync(fd, buf, got, len - got, off + got);
  fs.closeSync(fd);
  return buf;
};
const est = estimateIsoSize(entries, opts);
const t = performance.now();
const iso = buildIsoToMemory(entries, opts, read, null);
fs.writeFileSync(out, iso);
console.log(`entries=${entries.length} estimate=${est} actual=${iso.length} time=${(performance.now() - t).toFixed(0)}ms`);

// Cross-checks images with 7-Zip, an independent ISO implementation.
// Skipped when `7z` is not installed.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIsoToMemory } from "../pkg/isowasm.js";
import { loadWasm, tree, randomBytes } from "./helpers.mjs";

loadWasm();
const has7z = (() => { try { execFileSync("7z", ["i"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("7-Zip extracts identical files", { skip: !has7z && "7z not installed" }, () => {
  const t = tree({
    "README.txt": "hello\n",
    "docs/Ünïcödé — 日本語.txt": "unicode\n",
    "docs/a long file name with spaces.md": "long\n",
    "a/b/c/d/e/f/g/h/i/j/deep.txt": "deep\n",
    "big.bin": randomBytes(5 * 1024 * 1024 + 3, 5),
    "empty folder/": null,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isowasm-"));
  try {
    const iso = path.join(dir, "t.iso");
    fs.writeFileSync(iso, buildIsoToMemory(t.entries, { volumeName: "SEVENZIP" }, t.read));
    execFileSync("7z", ["x", "-y", `-o${path.join(dir, "out")}`, iso], { stdio: "ignore" });
    for (const [i, e] of t.entries.entries()) {
      const p = path.join(dir, "out", e.path);
      if (e.dir) assert.ok(fs.statSync(p).isDirectory(), e.path);
      else assert.deepEqual(new Uint8Array(fs.readFileSync(p)), t.data[i], e.path);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

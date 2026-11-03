import test from "node:test";
import assert from "node:assert/strict";
import { buildIsoToMemory, buildIsoToHandle, estimateIsoSize } from "../pkg/isowasm.js";
import { loadWasm, tree, randomBytes, MemoryHandle, SparseHandle } from "./helpers.mjs";
import { fromBytes, IsoImage } from "./iso-reader.mjs";

loadWasm();

const MTIME = Date.UTC(2024, 0, 2, 3, 4, 5);
const sample = () => tree({
  "README.txt": "hello\n",
  "docs/guide.md": "# Guide\n",
  "docs/this is a long file name that does not fit 8.3.txt": "long\n",
  "docs/Ünïcödé — 日本語.txt": "unicode\n",
  "docs/nested/deeper/leaf.bin": randomBytes(10_000, 7),
  "Mixed Case.TXT": "case\n",
  "empty.dat": "",
  "empty folder/": null,
  "big/random.bin": randomBytes(3 * 1024 * 1024 + 17, 3), // spans several read chunks? no; one, plus tail
});

function assertTreeMatches(iso, t, which) {
  const listed = iso.list(which);
  const expectFiles = t.entries.filter((e) => !e.dir);
  for (const [i, e] of t.entries.entries()) {
    const got = listed.get(e.path);
    assert.ok(got, `${which}: missing ${e.path}`);
    if (e.dir) {
      assert.equal(got.dir, true, `${which}: ${e.path} should be a folder`);
    } else {
      assert.equal(got.size, e.size, `${which}: size of ${e.path}`);
      assert.deepEqual(iso.read(got), t.data[i], `${which}: contents of ${e.path}`);
    }
  }
  const files = [...listed].filter(([, v]) => !v.dir);
  assert.equal(files.length, expectFiles.length, `${which}: unexpected extra files`);
}

test("Joliet and Rock Ridge trees round-trip names and contents", () => {
  const t = sample();
  const iso = fromBytes(buildIsoToMemory(t.entries, { volumeName: "Test Disc" }, t.read));
  assert.equal(iso.volumeId, "TEST_DISC");
  assert.equal(iso.applicationId, "ISOWASM");
  assert.ok(iso.hasJoliet, "Joliet descriptor");
  assert.ok(iso.hasRockRidge, "Rock Ridge SP entry");
  assertTreeMatches(iso, t, "joliet");
  assertTreeMatches(iso, t, "rockridge");
});

test("Rock Ridge keeps modification times and modes", () => {
  const t = sample();
  const rr = fromBytes(buildIsoToMemory(t.entries, {}, t.read)).list("rockridge");
  const f = rr.get("README.txt");
  assert.equal(f.modified?.getTime(), MTIME);
  assert.equal(f.mode & 0o170000, 0o100000, "regular file");
  assert.equal(rr.get("docs").mode & 0o170000, 0o040000, "directory");
});

test("primary tree uses valid, unique ISO 9660 names", () => {
  const t = sample();
  const plain = fromBytes(buildIsoToMemory(t.entries, { joliet: false, rockRidge: false }, t.read));
  assert.ok(!plain.hasJoliet && !plain.hasRockRidge);
  const names = [...plain.list("primary").keys()];
  // every input entry plus the implied folders docs, docs/nested, docs/nested/deeper and big
  assert.equal(names.length, t.entries.length + 4);
  for (const p of names) {
    for (const part of p.split("/")) assert.match(part, /^[A-Z0-9_]{1,8}(\.[A-Z0-9_]{0,3})?$/, `level 1 name: ${p}`);
  }
  // contents are still readable through the 8.3 names
  const readme = plain.list("primary").get("README.TXT");
  assert.equal(new TextDecoder().decode(plain.read(readme)), "hello\n");
});

test("image is sector-aligned and the estimate is an upper bound", () => {
  const t = sample();
  for (const opts of [{}, { joliet: false }, { rockRidge: false }, { isoLevel: 2 }, { isoLevel: 3, longFilenames: true }]) {
    const iso = buildIsoToMemory(t.entries, opts, t.read);
    assert.equal(iso.length % 2048, 0);
    assert.equal(fromBytes(iso).volumeBlocks * 2048, iso.length, `volume size field ${JSON.stringify(opts)}`);
    assert.ok(estimateIsoSize(t.entries, opts) >= iso.length, `estimate >= actual for ${JSON.stringify(opts)}`);
  }
});

test("handle output matches memory output", () => {
  const t = sample();
  const handle = new MemoryHandle();
  handle.write(new Uint8Array(5_000_000).fill(9)); // stale data must be truncated away
  const size = buildIsoToHandle(t.entries, {}, t.read, handle);
  const mem = buildIsoToMemory(t.entries, {}, t.read);
  assert.equal(size, mem.length);
  assert.equal(handle.getSize(), size);
  const iso = fromBytes(handle.bytes());
  assertTreeMatches(iso, t, "joliet");
  assertTreeMatches(iso, t, "rockridge");
  assert.ok(handle.calls.write < 50, `writes are coalesced (${handle.calls.write} calls)`);
});

test("empty input and empty files produce a valid image", () => {
  const empty = fromBytes(buildIsoToMemory([], {}, () => new Uint8Array()));
  assert.equal(empty.list("joliet").size, 0);
  const t = tree({ "zero.bin": "" });
  const iso = fromBytes(buildIsoToMemory(t.entries, {}, t.read));
  assert.equal(iso.list("joliet").get("zero.bin").size, 0);
});

test("progress reports every byte, in order", () => {
  const t = tree({ "a.bin": randomBytes(9 * 1024 * 1024, 1), "b.txt": "b" });
  const calls = [];
  buildIsoToMemory(t.entries, {}, t.read, (done, total) => calls.push([done, total]));
  const total = 9 * 1024 * 1024 + 1;
  assert.ok(calls.length >= 3, "several progress calls for a 9 MiB file");
  assert.deepEqual(calls.at(-1), [total, total]);
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i][0] > calls[i - 1][0], "monotonic");
});

test("a throwing progress callback does not abort the build", () => {
  const t = tree({ "a.txt": "a" });
  const iso = buildIsoToMemory(t.entries, {}, t.read, () => { throw new Error("ui gone"); });
  assert.ok(iso.length > 0);
});

test("folders deeper than 8 levels are relocated with Rock Ridge", () => {
  const deep = "a/b/c/d/e/f/g/h/i/j";
  const t = tree({ [`${deep}/deep.txt`]: "deep\n", "top.txt": "top\n" });
  const iso = fromBytes(buildIsoToMemory(t.entries, {}, t.read));
  const rr = iso.list("rockridge");
  assert.equal(new TextDecoder().decode(iso.read(rr.get(`${deep}/deep.txt`))), "deep\n");
  // Like genisoimage, the rr_moved folder stays visible but holds nothing in the Rock Ridge view.
  assert.ok(![...rr.keys()].some((k) => k.startsWith("rr_moved/")), "moved folders only appear at their real path");
  assert.ok(iso.list("joliet").has(`${deep}/deep.txt`), "Joliet keeps the real path");
});

test("El Torito BIOS + UEFI boot catalog", () => {
  const bootImg = randomBytes(2048 * 2, 9);
  const efiImg = randomBytes(2048 * 4, 10);
  const t = tree({ "boot/boot.bin": bootImg, "efi.img": efiImg, "readme.txt": "x" });
  const iso = fromBytes(buildIsoToMemory(t.entries, {
    boot: { biosImage: "/boot/boot.bin", bootInfoTable: true, uefiImage: "efi.img" },
  }, t.read));
  const et = iso.elTorito();
  assert.ok(et, "boot record present");
  assert.ok(et.validation.checksumOk, "validation entry checksum");
  assert.deepEqual(et.validation.key, [0x55, 0xaa]);
  assert.equal(et.validation.platform, 0, "x86 default entry");
  assert.ok(et.default.bootable);
  assert.equal(et.default.media, 0, "no emulation");
  assert.equal(et.default.sectorCount, 4);

  const files = iso.list("joliet");
  const boot = files.get("boot/boot.bin");
  assert.equal(et.default.lba, boot.extents[0].lba, "default entry points at boot.bin");
  // Boot info table: PVD LBA at 8, file LBA at 12, file length at 16.
  const patched = iso.read(boot);
  const dv = new DataView(patched.buffer, patched.byteOffset);
  assert.equal(dv.getUint32(8, true), 16);
  assert.equal(dv.getUint32(12, true), boot.extents[0].lba);
  assert.equal(dv.getUint32(16, true), bootImg.length);

  const uefi = et.sections.find((s) => s.platform === 0xef);
  assert.ok(uefi, "UEFI section");
  assert.equal(uefi.lba, files.get("efi.img").extents[0].lba);
});

test("invalid input is rejected with a clear message", () => {
  const read = () => new Uint8Array();
  const cases = [
    [[{ path: "a", size: 1 }, { path: "a", size: 1 }], {}, /duplicate path/],
    [[{ path: "a", size: 1 }, { path: "a/b", size: 1 }], {}, /both a file and a folder/],
    [[{ path: "a/b", size: 1 }, { path: "a", size: 1 }], {}, /both a file and a folder/],
    [[{ path: "a", dir: true }, { path: "a", size: 1 }], {}, /both a file and a folder/],
    [[{ path: "../etc/passwd", size: 1 }], {}, /not allowed/],
    [[{ path: "", size: 1 }], {}, /empty path/],
    [[{ path: "a", size: -1 }], {}, /whole number/],
    [[{ path: "a", size: 1.5 }], {}, /whole number/],
    [[{ path: "a", size: 1 }], { isoLevel: 4 }, /isoLevel/],
    [[{ path: "a", size: 1 }], { volumename: "typo" }, /unknown field/],
    [[{ path: "a", size: 1 }], { boot: { biosImage: "a", emulation: "zip" } }, /emulation/],
  ];
  for (const [entries, opts, re] of cases) {
    assert.throws(() => estimateIsoSize(entries, opts), re, `${JSON.stringify(entries)} ${JSON.stringify(opts)}`);
    assert.throws(() => buildIsoToMemory(entries, opts, read), re);
  }
  // Only checked when building (hadris validates the tree there).
  assert.throws(() => buildIsoToMemory([{ path: "a/b/c/d/e/f/g/h/i/x", size: 0 }], { rockRidge: false }, read), /depth/);
});

test("errors from read() reach the caller unchanged", () => {
  const t = tree({ "a.txt": "abc" });
  const boom = new Error("disk unplugged");
  assert.throws(() => buildIsoToMemory(t.entries, {}, () => { throw boom; }), (e) => e === boom);
  assert.throws(() => buildIsoToMemory(t.entries, {}, () => new Uint8Array(1)), /returned 1 bytes.*expected 3/);
  assert.throws(() => buildIsoToMemory(t.entries, {}, () => "nope"), /must return a Uint8Array/);
});

test("files over 4 GiB use multiple extents (sparse, ~5 GiB image)", { skip: process.env.ISOWASM_SKIP_LARGE && "ISOWASM_SKIP_LARGE set", timeout: 300_000 }, () => {
  const big = 4.5 * 2 ** 30;
  const entries = [
    { path: "huge.bin", size: big },
    { path: "after.txt", size: 6 },
  ];
  const after = new TextEncoder().encode("after\n");
  // Mostly zeros, with markers at the start, at the 4 GiB boundary and at the end.
  const marks = new Map([[0, 0xab], [2 ** 32 - 1, 0x11], [2 ** 32, 0x22], [big - 1, 0xcd]]);
  const read = (i, offset, length) => {
    if (i === 1) return after.slice(offset, offset + length);
    const out = new Uint8Array(length);
    for (const [pos, v] of marks) if (pos >= offset && pos < offset + length) out[pos - offset] = v;
    return out;
  };
  const handle = new SparseHandle();
  const size = buildIsoToHandle(entries, {}, read, handle);
  assert.ok(size > big, "image larger than the file");

  const iso = new IsoImage((o, l) => handle.readAt(o, l));
  for (const which of ["joliet", "rockridge", "primary"]) {
    const files = iso.list(which);
    const name = which === "primary" ? "HUGE.BIN" : "huge.bin";
    const f = files.get(name);
    assert.equal(f.size, big, `${which}: size`);
    assert.ok(f.extents.length >= 2, `${which}: multi-extent`);
    const byteAt = (pos) => {
      let base = 0;
      for (const e of f.extents) {
        if (pos < base + e.size) return handle.readAt(e.lba * 2048 + (pos - base), 1)[0];
        base += e.size;
      }
      throw new Error("out of range");
    };
    for (const [pos, v] of marks) assert.equal(byteAt(pos), v, `${which}: byte at ${pos}`);
  }
  const a = iso.list("joliet").get("after.txt");
  assert.equal(new TextDecoder().decode(iso.read(a)), "after\n");
});

# isowasm

Create ISO 9660 disc images from a folder, entirely in the browser. It's a
WebAssembly wrapper around [hadris-iso](https://github.com/hxyulin/hadris), a
pure Rust ISO library.

**[Try the demo →](https://shubhendusaurabh.github.io/isowasm/)**: pick a folder and download an ISO. Nothing is uploaded.

- **Works everywhere:** Joliet (Windows long and Unicode names), Rock Ridge (Linux/macOS names, permissions, timestamps) and plain ISO 9660 in the same image
- **Large folders:** files are streamed in 4 MiB pieces and the image is written to the browser's private file system (OPFS), so neither has to fit in memory. Files over 4 GiB are supported (multi-extent).
- **Bootable images:** El Torito BIOS (no emulation, floppy, hard disk) and UEFI entries, with an optional boot info table
- **Small:** about 400 KB of WASM, no dependencies at runtime

## Using the library

Build it (see [Development](#development)), then use `pkg/` as an ES module.
It runs in a Web Worker, because file reads (`FileReaderSync`) and OPFS sync
handles are only available there:

```js
// worker.js
import init, { buildIsoToHandle, estimateIsoSize } from "./pkg/isowasm.js";
await init();

self.onmessage = async ({ data: files }) => {   // files: [{ path: "docs/a.txt", file: File }]
  const entries = files.map(({ path, file }) => ({ path, size: file.size, mtime: file.lastModified }));
  const reader = new FileReaderSync();
  const read = (i, offset, length) =>
    new Uint8Array(reader.readAsArrayBuffer(files[i].file.slice(offset, offset + length)));

  const root = await navigator.storage.getDirectory();
  const out = await root.getFileHandle("out.iso", { create: true });
  const handle = await out.createSyncAccessHandle();
  try {
    buildIsoToHandle(entries, { volumeName: "MY_DISC" }, read, handle,
      (done, total) => self.postMessage({ progress: done / total }));
  } finally {
    handle.close();
  }
  self.postMessage({ file: await out.getFile() });  // a disk-backed File, ready to download
};
```

[`demo/worker.js`](demo/worker.js) is a complete version.

### API

| Function | Description |
|---|---|
| `buildIsoToHandle(entries, options, read, handle, progress?)` | Writes the image to a `FileSystemSyncAccessHandle` (truncated first). Returns the size in bytes. Use this for anything large. |
| `buildIsoToMemory(entries, options, read, progress?)` | Returns the image as a `Uint8Array`. Fine up to a few hundred MB. |
| `estimateIsoSize(entries, options)` | Upper-bound size in bytes, without reading any files. Also validates the input. |

**`entries`**: `{ path, size, mtime? }` for files and `{ path, dir: true }` for
folders. Paths use `/`. Folders are created automatically from file paths, so
only empty ones need listing. `mtime` is in milliseconds, like `File.lastModified`.

**`read(index, offset, length)`** must synchronously return a `Uint8Array` of
exactly `length` bytes of `entries[index]`. If it throws, the build stops and
the same error is rethrown to you.

**`options`** (all optional):

| Option | Default | |
|---|---|---|
| `volumeName` | `"CDROM"` | Disc label. Converted to `A–Z 0–9 _`, max 32 chars |
| `joliet` | `true` | Unicode names up to 64 chars, read by Windows |
| `rockRidge` | `true` | POSIX names, modes and timestamps, plus folders nested more than 8 deep |
| `isoLevel` | `1` | Base ISO 9660 level (1, 2 or 3) |
| `longFilenames` | `false` | Add an ISO 9660:1999 tree (names up to 207 chars) |
| `publisherId`, `preparerId`, `applicationId`, `systemId`, `volumeSetId` | | Volume descriptor strings |
| `boot` | | `{ biosImage, emulation, loadSize, bootInfoTable, grub2BootInfo, uefiImage }`. Paths are inside the image; `emulation` is `"none"` (default), `"floppy1.2"`, `"floppy1.44"`, `"floppy2.88"` or `"hdd"` |

Misspelt option names throw rather than being ignored. TypeScript types are
included in `pkg/isowasm.d.ts`.

## Browser support

The demo needs a browser with OPFS sync access handles in workers: Chrome or
Edge 102+, Firefox 111+, or Safari 15.2+. Where these are missing it falls back
to building in memory.

## Limitations

- **Deep folders:** folders nested more than 8 levels need Rock Ridge (the default). As with genisoimage, they're relocated into an `rr_moved` folder, and hadris-iso also shows that folder in the Joliet (Windows) view.
- **Timestamps:** each file's original modification time is kept in Rock Ridge. The ISO 9660 and Joliet records use the build time.
- **Browser storage:** the image counts against the site's storage quota while it's being built. The demo checks the estimate against free space first and deletes the previous image on the next visit.
- **No hybrid USB boot yet:** isohybrid MBR/GPT boot isn't exposed. hadris-iso supports it, and it can be added.

## Development

Requirements: Rust, Node 20+, and `wasm-bindgen-cli` at the version in `Cargo.lock`.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130

./build.sh            # builds pkg/ and copies it to demo/pkg/
npm test              # node tests (set ISOWASM_SKIP_LARGE=1 to skip the 4.5 GiB test)
npm run serve         # demo at http://localhost:8765
node examples/node-cli.mjs <folder> out.iso   # build an ISO from a folder with Node
```

The tests check images with an independent ISO reader
([`tests/iso-reader.mjs`](tests/iso-reader.mjs)) rather than with hadris-iso
itself. They cover Joliet, Rock Ridge, multi-extent files, relocated folders
and El Torito. A 4.5 GiB image is built against a sparse fake OPFS handle, so
that test needs no disk space. When `7z` is installed, images are also
extracted with 7-Zip and compared byte for byte.

CI runs clippy, the Rust tests and the Node tests. Every push to `main`
deploys `demo/` to GitHub Pages (enable it under *Settings → Pages → Source:
GitHub Actions*).

### Patched hadris-iso

`vendor/hadris-iso` is hadris-iso 2.5.0 with one change
([`patches/`](patches/hadris-iso-2.5.0-wasm-clock.patch)): `DecDateTime::now()`
called `std::time::SystemTime::now()`, which panics on `wasm32-unknown-unknown`.
The patch uses `chrono::Utc::now()` instead. Once this is fixed upstream, the
vendored copy and the `[patch]` section in `Cargo.toml` can be removed.

Streaming uses hadris-iso's `unstable-streaming` feature, which is outside its
semver guarantees, so the version is pinned.

## License

ISC © Shubhendu. hadris-iso (vendored) is MIT; see
[`vendor/hadris-iso/LICENSE-MIT`](vendor/hadris-iso/LICENSE-MIT).

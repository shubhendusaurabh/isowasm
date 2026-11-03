// Builds the ISO off the main thread. Files are read lazily with
// FileReaderSync and the image is written to an OPFS file through a sync
// access handle, so neither has to fit in memory.
import init, { buildIsoToHandle, buildIsoToMemory, estimateIsoSize } from "./pkg/isowasm.js";

const OUTPUT_NAME = "isowasm-output.iso";
const ready = init();

self.onmessage = async ({ data }) => {
  try {
    await ready;
    if (data.type === "estimate") {
      self.postMessage({ id: data.id, type: "estimate", bytes: estimateIsoSize(describe(data.items), data.options) });
    } else if (data.type === "build") {
      self.postMessage({ id: data.id, ...(await build(data.items, data.options)) });
    }
  } catch (e) {
    self.postMessage({ id: data.id, type: "error", name: e?.name, message: e?.message ?? String(e) });
  }
};

/** [{ path, file? }] -> library entries (no file = folder). */
const describe = (items) => items.map(({ path, file }) =>
  file ? { path, size: file.size, mtime: file.lastModified } : { path, dir: true });

async function build(items, options) {
  const entries = describe(items);
  const reader = new FileReaderSync();
  const read = (i, offset, length) =>
    new Uint8Array(reader.readAsArrayBuffer(items[i].file.slice(offset, offset + length)));

  let last = 0;
  const progress = (done, total) => {
    const now = performance.now();
    if (now - last > 100 || done === total) {
      last = now;
      self.postMessage({ type: "progress", done, total });
    }
  };

  const started = performance.now();
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(OUTPUT_NAME, { create: true });

  if (typeof fileHandle.createSyncAccessHandle !== "function") {
    // Browsers without OPFS sync handles: build in memory instead.
    const iso = buildIsoToMemory(entries, options, read, progress);
    const blob = new Blob([iso], { type: "application/x-iso9660-image" });
    return { type: "done", blob, bytes: iso.length, ms: performance.now() - started };
  }

  const handle = await fileHandle.createSyncAccessHandle();
  try {
    const bytes = buildIsoToHandle(entries, options, read, handle, progress);
    return { type: "done", name: OUTPUT_NAME, bytes, ms: performance.now() - started };
  } catch (e) {
    handle.truncate(0); // don't leave a half-written image taking up space
    throw e;
  } finally {
    handle.close();
  }
}

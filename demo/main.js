// Folder to ISO: pick a folder, build the image in a worker, download it.
const $ = (id) => document.getElementById(id);
const OUTPUT_NAME = "isowasm-output.iso";

// Operating-system clutter that nobody wants on a disc.
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\.Spotlight-V100|\.Trashes|\.fseventsd|__MACOSX)(\/|$)/i;

/** @type {{ path: string, file?: File }[]} */
let items = [];
let folderName = "";
let downloadUrl = null;
let building = false;

// ---------- worker ----------

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const jobs = new Map();
let nextJob = 1;
let onProgress = () => {};

worker.onmessage = ({ data }) => {
  if (data.type === "progress") return onProgress(data.done, data.total);
  const job = jobs.get(data.id);
  jobs.delete(data.id);
  if (data.type === "error") job?.reject(Object.assign(new Error(data.message), { name: data.name }));
  else job?.resolve(data);
};
worker.onerror = (e) => {
  for (const job of jobs.values()) job.reject(new Error(e.message || "The image builder failed to start."));
  jobs.clear();
};
const run = (msg) => new Promise((resolve, reject) => {
  const id = nextJob++;
  jobs.set(id, { resolve, reject });
  worker.postMessage({ ...msg, id });
});

// ---------- screens ----------

function show(step) {
  for (const s of ["pick", "ready", "working", "done"]) $(`step-${s}`).hidden = s !== step;
}
function alertIn(id, message) {
  $(id).textContent = message || "";
  $(id).hidden = !message;
}

const fmtSize = (n) => {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${i ? n.toFixed(n < 10 ? 1 : 0) : n} ${units[i]}`;
};
const fmtTime = (s) => s < 60 ? `${Math.max(1, Math.round(s))} sec` : `${Math.round(s / 60)} min`;

function discName(name) {
  const n = name.toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  return n || "MY_DISC";
}

// ---------- choosing a folder ----------

function useFolder(list, name) {
  list = list.filter((i) => !JUNK.test(i.path));
  const files = list.filter((i) => i.file);
  if (!files.length) {
    alertIn("pick-error", "That folder is empty. Choose a folder that has files in it.");
    return show("pick");
  }
  items = list;
  folderName = name;
  const total = files.reduce((s, i) => s + i.file.size, 0);
  $("folder-name").textContent = name;
  $("folder-meta").textContent = `${files.length.toLocaleString()} ${files.length === 1 ? "file" : "files"} · ${fmtSize(total)}`;
  $("label").value = discName(name);
  alertIn("pick-error");
  alertIn("ready-error");
  show("ready");
}

async function pickWithDirectoryPicker() {
  const dir = await window.showDirectoryPicker();
  const out = [];
  async function walk(handle, prefix) {
    for await (const [name, child] of handle.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.kind === "file") out.push({ path, file: await child.getFile() });
      else { out.push({ path }); await walk(child, path); }
    }
  }
  await walk(dir, "");
  useFolder(out, dir.name);
}

function fromFileInput(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const root = files[0].webkitRelativePath.split("/")[0];
  useFolder(files.map((file) => ({ path: file.webkitRelativePath.split("/").slice(1).join("/"), file })), root);
}

async function fromDrop(dataTransfer) {
  const entries = [...dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return;
  const readDir = (dir) => new Promise((resolve, reject) => {
    const reader = dir.createReader(), all = [];
    const next = () => reader.readEntries((batch) => (batch.length ? (all.push(...batch), next()) : resolve(all)), reject);
    next();
  });
  const getFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));
  const out = [];
  async function walk(entry, path) {
    if (entry.isFile) return out.push({ path, file: await getFile(entry) });
    if (path) out.push({ path });
    for (const child of await readDir(entry)) await walk(child, path ? `${path}/${child.name}` : child.name);
  }
  if (entries.length === 1 && entries[0].isDirectory) {
    await walk(entries[0], "");
    useFolder(out, entries[0].name);
  } else {
    for (const e of entries) await walk(e, e.name);
    useFolder(out, entries.length === 1 ? entries[0].name.replace(/\.[^.]*$/, "") : "My disc");
  }
}

// ---------- building ----------

/** Turns technical failures into something a person can act on. */
function friendly(e) {
  const m = `${e?.name ?? ""} ${e?.message ?? e}`;
  if (/QuotaExceeded|storage is full|quota/i.test(m))
    return "Your browser ran out of storage space for the ISO. Free up disk space, or try a smaller folder.";
  if (/NotReadable|NotFound|could not be read|did the file change/i.test(m))
    return "Some files couldn't be read. They may have been moved, changed or deleted while the ISO was being made. Choose the folder again and retry.";
  if (/depth|path length/i.test(m))
    return "This folder has too many folders inside folders. Move some files up a level and try again.";
  if (/both a file and a folder|duplicate path/i.test(m))
    return "Two items in this folder have the same name. Rename one of them and try again.";
  return `Something went wrong: ${e?.message ?? e}`;
}

async function create() {
  if (building) return;
  const label = discName($("label").value || folderName);
  $("label").value = label;
  alertIn("ready-error");

  // Make sure the browser has room for the finished image.
  try {
    const { bytes } = await run({ type: "estimate", items: sizesOnly(items), options: { volumeName: label } });
    const { quota, usage } = (await navigator.storage?.estimate?.()) ?? {};
    if (quota && bytes > quota - usage) {
      return alertIn("ready-error", `This ISO needs about ${fmtSize(bytes)}, but your browser only allows ${fmtSize(quota - usage)} more. Free up disk space or choose a smaller folder.`);
    }
  } catch (e) {
    return alertIn("ready-error", friendly(e));
  }

  building = true;
  show("working");
  setProgress(0, 1);
  const started = performance.now();
  onProgress = (done, total) => {
    setProgress(done, total);
    const secs = (performance.now() - started) / 1000;
    $("eta").textContent = done > 0 && secs > 2 && done < total ? `about ${fmtTime((secs / done) * (total - done))} left` : "";
  };

  try {
    const res = await run({ type: "build", items, options: { volumeName: label } });
    const blob = res.blob ?? (await (await (await navigator.storage.getDirectory()).getFileHandle(res.name)).getFile());
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(blob);
    const a = $("download");
    a.href = downloadUrl;
    a.download = `${label}.iso`;
    a.textContent = `Download ${label}.iso`;
    $("done-text").textContent = `${fmtSize(res.bytes)} · made in ${fmtTime(res.ms / 1000)}`;
    show("done");
    a.click();
    return res;
  } catch (e) {
    show("ready");
    alertIn("ready-error", friendly(e));
    throw e;
  } finally {
    building = false;
    onProgress = () => {};
  }
}

function setProgress(done, total) {
  const pct = total ? Math.floor((done / total) * 100) : 0;
  $("bar").firstElementChild.style.width = `${pct}%`;
  $("bar").setAttribute("aria-valuenow", pct);
  $("progress-text").textContent = total > 1 ? `${pct}% · ${fmtSize(done)} of ${fmtSize(total)}` : "Starting…";
}

// The estimate only needs sizes; File objects stay on this side.
const sizesOnly = (list) => list.map(({ path, file }) =>
  file ? { path, file: { size: file.size, lastModified: file.lastModified } } : { path });

// ---------- wiring ----------

$("pick").onclick = async () => {
  alertIn("pick-error");
  if (!window.showDirectoryPicker) return $("dirInput").click();
  try {
    await pickWithDirectoryPicker();
  } catch (e) {
    if (e.name !== "AbortError") alertIn("pick-error", "That folder couldn't be opened. Try another folder, or drag it onto this page.");
  }
};
$("dirInput").onchange = (e) => { fromFileInput(e.target.files); e.target.value = ""; };
$("change").onclick = () => show("pick");
$("again").onclick = () => show("pick");
$("create").onclick = () => create().catch(() => {});
$("label").onkeydown = (e) => { if (e.key === "Enter") $("create").click(); };

const drop = $("drop");
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  fromDrop(e.dataTransfer).catch(() => alertIn("pick-error", "That couldn't be read. Try the Choose a folder button instead."));
};
// Dropping anywhere else on the page shouldn't open the file in the tab.
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => e.preventDefault());

addEventListener("beforeunload", (e) => { if (building) e.preventDefault(); });

if (!("storage" in navigator) || !navigator.storage.getDirectory || typeof Worker === "undefined") {
  $("drop").innerHTML = "<p>Your browser is too old for this page. Please use a recent version of Chrome, Edge, Firefox or Safari.</p>";
}

// Free the space used by an ISO from a previous visit.
navigator.storage?.getDirectory?.().then((root) => root.removeEntry(OUTPUT_NAME)).catch(() => {});

// Hook for automated tests.
window.isowasm = { useFolder, create };

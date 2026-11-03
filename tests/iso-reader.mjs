// A small, independent ISO 9660 reader used to verify images in tests.
// Supports Joliet, Rock Ridge (NM, PX, TF, CL/RE relocation, CE continuation),
// multi-extent files and El Torito. Reads through `readAt(offset, length)`, so
// it works on sparse in-memory images too.

const SECTOR = 2048;

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const ascii = (b, s, e) => String.fromCharCode(...b.subarray(s, e));
const utf16be = (b) => {
  let s = "";
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  return s;
};

export class IsoImage {
  /** @param {(offset: number, length: number) => Uint8Array} readAt */
  constructor(readAt) {
    this.readAt = readAt;
    this.descriptors = [];
    for (let lba = 16; lba < 64; lba++) {
      const d = readAt(lba * SECTOR, SECTOR);
      if (ascii(d, 1, 6) !== "CD001") throw new Error(`no volume descriptor at sector ${lba}`);
      const type = d[0];
      if (type === 255) break;
      const esc = ascii(d, 88, 91);
      this.descriptors.push({
        type, lba, data: d,
        joliet: type === 2 && d[6] === 1 && ["%/@", "%/C", "%/E"].includes(esc),
      });
    }
    this.pvd = this.descriptors.find((d) => d.type === 1)?.data;
    if (!this.pvd) throw new Error("no primary volume descriptor");
  }

  get volumeId() { return ascii(this.pvd, 40, 72).trimEnd(); }
  get applicationId() { return ascii(this.pvd, 574, 702).trimEnd(); }
  get volumeBlocks() { return u32(this.pvd, 80); }
  get hasJoliet() { return this.descriptors.some((d) => d.joliet); }
  get hasRockRidge() {
    // SUSP "SP" entry in the root's "." record marks Rock Ridge/SUSP use.
    const root = this.#rootRecord(this.pvd);
    const rec = this.#records(root.lba, root.size)[0];
    return rec?.su && this.#susp(rec.su).some((e) => e.sig === "SP");
  }

  #rootRecord(desc) {
    return { lba: u32(desc, 156 + 2), size: u32(desc, 156 + 10) };
  }

  /** Raw directory records of one directory extent. */
  #records(lba, size) {
    const data = this.readAt(lba * SECTOR, size);
    const out = [];
    for (let sector = 0; sector < size; sector += SECTOR) {
      let off = sector;
      while (off < sector + SECTOR && off < size) {
        const len = data[off];
        if (len === 0) break;
        const nameLen = data[off + 32];
        const suStart = off + 33 + nameLen + (nameLen % 2 === 0 ? 1 : 0);
        out.push({
          lba: u32(data, off + 2),
          size: u32(data, off + 10),
          flags: data[off + 25],
          rawName: data.subarray(off + 33, off + 33 + nameLen),
          su: data.subarray(suStart, off + len),
        });
        off += len;
      }
    }
    return out;
  }

  /** System Use Sharing Protocol entries, following CE continuation areas. */
  #susp(area) {
    const out = [];
    let b = area, guard = 0;
    while (b && guard++ < 64) {
      let next = null;
      for (let o = 0; o + 4 <= b.length; ) {
        const sig = ascii(b, o, o + 2), len = b[o + 2];
        if (len < 4 || o + len > b.length) break;
        const body = b.subarray(o, o + len);
        if (sig === "CE") next = this.readAt(u32(body, 4) * SECTOR + u32(body, 12), u32(body, 20));
        else if (sig === "ST") break;
        else out.push({ sig, body });
        o += len;
      }
      b = next;
    }
    return out;
  }

  #rockRidge(su) {
    const rr = { nameBytes: [], hasName: false };
    for (const { sig, body } of this.#susp(su)) {
      if (sig === "NM") { rr.nameBytes.push(...body.subarray(5)); rr.hasName = true; }
      else if (sig === "PX") rr.mode = u32(body, 4);
      else if (sig === "CL") rr.childLink = u32(body, 4);
      else if (sig === "RE") rr.relocated = true;
      else if (sig === "TF") {
        const flags = body[4], stamps = [];
        const long = flags & 0x80, step = long ? 17 : 7;
        for (let o = 5; o + step <= body.length; o += step) stamps.push(body.subarray(o, o + step));
        // Order: creation(1), modify(2), access(4), attributes(8), ...
        let i = 0;
        for (const [bit, key] of [[1, "created"], [2, "modified"], [4, "accessed"], [8, "attributes"]]) {
          if (flags & bit) rr[key] = long ? null : dirDate(stamps[i++]);
        }
      }
    }
    rr.name = new TextDecoder().decode(new Uint8Array(rr.nameBytes)); // Rock Ridge names are raw bytes (UTF-8)
    return rr;
  }

  /**
   * Walks one directory tree.
   * @param {"primary" | "joliet" | "rockridge"} tree
   * @returns {Map<string, {dir: boolean, size: number, extents: {lba: number, size: number}[], mode?: number, modified?: Date}>}
   */
  list(tree = "joliet") {
    const desc = tree === "joliet" ? this.descriptors.find((d) => d.joliet)?.data : this.pvd;
    if (!desc) throw new Error(`image has no ${tree} tree`);
    const entries = new Map();
    const walk = (lba, size, prefix, depth) => {
      if (depth > 64) throw new Error("directory loop");
      let pending = null; // multi-extent file being assembled
      for (const rec of this.#records(lba, size)) {
        if (rec.rawName.length === 1 && rec.rawName[0] <= 1) continue; // "." and ".."
        if (pending) {
          // Continuation of a multi-extent file: belongs to the previous record
          // whatever its name says (like the Linux driver).
          pending.entry.extents.push({ lba: rec.lba, size: rec.size });
          pending.entry.size += rec.size;
          if (!(rec.flags & 0x80)) pending = null;
          continue;
        }
        const rr = tree === "rockridge" ? this.#rockRidge(rec.su) : null;
        if (rr?.relocated) continue; // shown at its original place via CL
        let name;
        if (tree === "joliet") name = utf16be(rec.rawName).replace(/;1$/, "");
        else if (rr?.hasName) name = rr.name;
        else name = ascii(rec.rawName, 0, rec.rawName.length).replace(/;1$/, "").replace(/\.$/, "");
        const path = prefix ? `${prefix}/${name}` : name;

        let isDir = (rec.flags & 2) !== 0;
        let dirLba = rec.lba, dirSize = rec.size;
        if (rr?.childLink !== undefined) {
          isDir = true;
          dirLba = rr.childLink;
          dirSize = u32(this.readAt(dirLba * SECTOR, 34), 10); // size from the moved dir's "." record
        }
        if (isDir) {
          entries.set(path, { dir: true, size: 0, extents: [], mode: rr?.mode, modified: rr?.modified });
          walk(dirLba, dirSize, path, depth + 1);
          continue;
        }
        if (entries.has(path)) throw new Error(`duplicate name ${path} in ${tree} tree`);
        const entry = { dir: false, size: rec.size, extents: [{ lba: rec.lba, size: rec.size }], mode: rr?.mode, modified: rr?.modified };
        entries.set(path, entry);
        if (rec.flags & 0x80) pending = { entry }; // more extents follow
      }
    };
    const root = this.#rootRecord(desc);
    walk(root.lba, root.size, "", 0);
    return entries;
  }

  /** Reads a whole file from a `list()` entry. */
  read(entry) {
    const out = new Uint8Array(entry.size);
    let pos = 0;
    for (const { lba, size } of entry.extents) {
      out.set(this.readAt(lba * SECTOR, size), pos);
      pos += size;
    }
    return out;
  }

  /** El Torito boot catalog, or null. */
  elTorito() {
    const br = this.descriptors.find((d) => d.type === 0);
    if (!br || !ascii(br.data, 7, 39).startsWith("EL TORITO SPECIFICATION")) return null;
    const catalogLba = u32(br.data, 0x47);
    const cat = this.readAt(catalogLba * SECTOR, SECTOR);
    let sum = 0;
    for (let i = 0; i < 32; i += 2) sum = (sum + u16(cat, i)) & 0xffff;
    const entry = (o) => ({
      bootable: cat[o] === 0x88, media: cat[o + 1], sectorCount: u16(cat, o + 6), lba: u32(cat, o + 8),
    });
    const sections = [];
    for (let o = 64; o + 32 <= SECTOR; o += 32) {
      const h = cat[o];
      if (h !== 0x90 && h !== 0x91) break;
      const platform = cat[o + 1], count = u16(cat, o + 2);
      for (let k = 0; k < count; k++) sections.push({ platform, ...entry(o + 32 * (k + 1)) });
      o += 32 * count;
      if (h === 0x91) break;
    }
    return {
      catalogLba,
      validation: { headerId: cat[0], platform: cat[1], checksumOk: sum === 0, key: [cat[30], cat[31]] },
      default: entry(32),
      sections,
    };
  }
}

function dirDate(b) {
  // 7-byte directory record date: years since 1900, month, day, h, m, s, GMT offset (15 min units)
  const offset = (b[6] << 24 >> 24) * 15;
  return new Date(Date.UTC(1900 + b[0], b[1] - 1, b[2], b[3], b[4], b[5]) - offset * 60000);
}

/** Convenience: an IsoImage over a Uint8Array. */
export const fromBytes = (bytes) =>
  new IsoImage((offset, length) => {
    if (offset + length > bytes.length) throw new Error(`read past end (${offset}+${length} > ${bytes.length})`);
    return bytes.subarray(offset, offset + length);
  });

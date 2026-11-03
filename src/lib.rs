//! isowasm: create ISO 9660 images in the browser, powered by
//! [hadris-iso](https://github.com/hxyulin/hadris).
//!
//! File contents are pulled from JavaScript on demand, so inputs never have to
//! be in memory all at once. The image goes either to an OPFS
//! `FileSystemSyncAccessHandle` (any size, Web Worker only) or to memory.

mod input;
mod options;
mod output;

use std::io::{Cursor, Write};

use hadris_iso::write::IsoImageWriter;
use hadris_iso::write::estimator::estimate_tree;
use js_sys::{Function, Uint8Array};
use wasm_bindgen::prelude::*;
use web_sys::FileSystemSyncAccessHandle;

use input::{EntryDesc, Prepared, Shared};
use options::Options;
use output::HandleOutput;

#[wasm_bindgen(typescript_custom_section)]
const TS_TYPES: &str = r#"
/** A file (`size` in bytes, optional `mtime` in ms since epoch) or a folder (`dir: true`). */
export type IsoEntry =
  | { path: string; size: number; mtime?: number }
  | { path: string; dir: true };

export interface IsoBootOptions {
  /** Path inside the image of the BIOS El Torito boot image. */
  biosImage?: string;
  emulation?: "none" | "floppy1.2" | "floppy1.44" | "floppy2.88" | "hdd";
  /** 512-byte sectors loaded by the firmware (default 4 for "none"). */
  loadSize?: number;
  bootInfoTable?: boolean;
  grub2BootInfo?: boolean;
  /** Path inside the image of a UEFI boot image (FAT image). */
  uefiImage?: string;
}

export interface IsoOptions {
  /** Volume label; sanitised to A-Z 0-9 _ and 32 chars. Default "CDROM". */
  volumeName?: string;
  /** Unicode long names for Windows. Default true. */
  joliet?: boolean;
  /** POSIX names, permissions, timestamps, deep folders. Default true. */
  rockRidge?: boolean;
  /** Base ISO 9660 level. Default 1. */
  isoLevel?: 1 | 2 | 3;
  /** Add an ISO 9660:1999 tree (207-char names). Default false. */
  longFilenames?: boolean;
  systemId?: string;
  volumeSetId?: string;
  publisherId?: string;
  preparerId?: string;
  applicationId?: string;
  boot?: IsoBootOptions;
}

/** Must synchronously return exactly `length` bytes of `entries[index]` starting at `offset`. */
export type IsoReadFn = (index: number, offset: number, length: number) => Uint8Array;
export type IsoProgressFn = (doneBytes: number, totalBytes: number) => void;
"#;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "IsoEntry[]")]
    pub type IsoEntries;
    #[wasm_bindgen(typescript_type = "IsoOptions | undefined")]
    pub type IsoOptions;
    #[wasm_bindgen(typescript_type = "IsoReadFn")]
    pub type IsoReadFn;
    #[wasm_bindgen(typescript_type = "IsoProgressFn | undefined")]
    pub type IsoProgressFn;
}

fn err(msg: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&msg.to_string()).into()
}

/// Rejects misspelt option names instead of silently ignoring them.
fn check_keys(obj: &JsValue, allowed: &[&str], what: &str) -> Result<(), JsValue> {
    if !obj.is_object() {
        return Ok(());
    }
    for key in js_sys::Object::keys(obj.unchecked_ref::<js_sys::Object>()).iter() {
        let key = key.as_string().unwrap_or_default();
        if !allowed.contains(&key.as_str()) {
            return Err(err(format!("unknown field {key:?} in {what}; expected one of: {}", allowed.join(", "))));
        }
    }
    Ok(())
}

fn parse(entries: IsoEntries, options: IsoOptions) -> Result<(Vec<EntryDesc>, Options), JsValue> {
    let entries: Vec<EntryDesc> = serde_wasm_bindgen::from_value(entries.into())
        .map_err(|e| err(format!("invalid entries: {e}")))?;
    let options: JsValue = options.into();
    check_keys(&options, options::OPTION_KEYS, "options")?;
    if options.is_object() {
        let boot = js_sys::Reflect::get(&options, &"boot".into())?;
        check_keys(&boot, options::BOOT_KEYS, "options.boot")?;
    }
    let options = if options.is_undefined() || options.is_null() {
        Options::default()
    } else {
        serde_wasm_bindgen::from_value(options).map_err(|e| err(format!("invalid options: {e}")))?
    };
    Ok((entries, options))
}

fn setup(
    entries: IsoEntries,
    options: IsoOptions,
    read: Option<Function>,
    progress: IsoProgressFn,
) -> Result<(Prepared, hadris_iso::write::options::IsoFormatOptions), JsValue> {
    let (entries, options) = parse(entries, options)?;
    let format = options.into_format().map_err(err)?;
    let progress: JsValue = progress.into();
    let prepared = input::prepare(entries, read, progress.dyn_into().ok()).map_err(err)?;
    Ok((prepared, format))
}

/// Rethrows the original JS exception from a callback if there was one.
fn build_error(shared: &Shared, e: impl std::fmt::Display) -> JsValue {
    shared.take_error().unwrap_or_else(|| err(e))
}

/// Builds an image into an OPFS sync access handle (Web Worker only), which is
/// truncated first. Returns the image size in bytes.
#[wasm_bindgen(js_name = buildIsoToHandle)]
pub fn build_iso_to_handle(
    entries: IsoEntries,
    options: IsoOptions,
    read: IsoReadFn,
    handle: FileSystemSyncAccessHandle,
    progress: IsoProgressFn,
) -> Result<f64, JsValue> {
    let (p, format) = setup(entries, options, Some(read.unchecked_into()), progress)?;
    handle.truncate_with_f64(0.0)?;
    let mut out = IsoImageWriter::create(HandleOutput::new(handle), p.tree, format)
        .map_err(|e| build_error(&p.shared, e))?;
    out.flush().map_err(err)?;
    out.handle.get_size()
}

/// Builds an image in memory. Use for images up to a few hundred MB.
#[wasm_bindgen(js_name = buildIsoToMemory)]
pub fn build_iso_to_memory(
    entries: IsoEntries,
    options: IsoOptions,
    read: IsoReadFn,
    progress: IsoProgressFn,
) -> Result<Uint8Array, JsValue> {
    let (p, format) = setup(entries, options, Some(read.unchecked_into()), progress)?;
    let out = IsoImageWriter::create(Cursor::new(Vec::new()), p.tree, format)
        .map_err(|e| build_error(&p.shared, e))?;
    Ok(Uint8Array::from(out.into_inner().as_slice()))
}

/// Estimates the image size in bytes without reading file contents. Throws for
/// invalid entries or options (folder depth limits are only checked when building).
#[wasm_bindgen(js_name = estimateIsoSize)]
pub fn estimate_iso_size(entries: IsoEntries, options: IsoOptions) -> Result<f64, JsValue> {
    let (p, format) = setup(entries, options, None, JsValue::UNDEFINED.unchecked_into())?;
    Ok(estimate_tree(&p.tree, &format).minimum_bytes() as f64)
}

//! Input side: turns a flat JS list of paths into a hadris-iso tree whose file
//! contents are pulled from a JS `read(index, offset, length)` callback.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::io::{self, Read};
use std::sync::Arc;

use hadris_iso::read::PathSeparator;
use hadris_iso::write::{FileSource, InputEntry, InputEntryKind, InputMetadata, InputTree};
use js_sys::{Function, Uint8Array};
use serde::Deserialize;
use wasm_bindgen::{JsCast, JsValue};

/// How much of a file is requested from JS per `read` call.
const READ_CHUNK: u64 = 4 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryDesc {
    /// Path relative to the image root, separated by `/`.
    pub path: String,
    /// File size in bytes (ignored for folders).
    #[serde(default)]
    pub size: f64,
    /// Marks a folder (only needed for empty ones).
    #[serde(default)]
    pub dir: bool,
    /// Modification time in ms since the Unix epoch, like `File.lastModified`.
    pub mtime: Option<f64>,
}

/// Callbacks and counters shared by every file reader of one build.
pub struct Shared {
    read: Option<Function>,
    progress: Option<Function>,
    done: Cell<u64>,
    total: u64,
    /// First JS exception thrown by a callback, rethrown unchanged to the caller.
    error: RefCell<Option<JsValue>>,
}

// SAFETY: wasm32-unknown-unknown (without the atomics feature) is single-threaded.
// hadris-iso asks for `Send + Sync` sources only because native hosts may use threads.
unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}

impl Shared {
    pub fn take_error(&self) -> Option<JsValue> {
        self.error.borrow_mut().take()
    }

    fn fail(&self, e: JsValue) -> io::Error {
        let msg = e
            .dyn_ref::<js_sys::Error>()
            .map(|e| String::from(e.message()))
            .or_else(|| e.as_string())
            .unwrap_or_else(|| format!("{e:?}"));
        self.error.borrow_mut().get_or_insert(e);
        io::Error::other(msg)
    }

    fn fetch(&self, index: u32, offset: u64, len: u64) -> io::Result<Vec<u8>> {
        let read = self.read.as_ref().ok_or_else(|| io::Error::other("no read callback"))?;
        let res = read
            .call3(
                &JsValue::NULL,
                &JsValue::from(index),
                &JsValue::from_f64(offset as f64),
                &JsValue::from_f64(len as f64),
            )
            .map_err(|e| self.fail(e))?;
        let arr: Uint8Array = res
            .dyn_into()
            .map_err(|_| self.fail(js_sys::Error::new("read() must return a Uint8Array").into()))?;
        if u64::from(arr.length()) != len {
            let msg = format!(
                "read() returned {} bytes for entry {index} at offset {offset}, expected {len} \
                 (did the file change while the image was being built?)",
                arr.length()
            );
            return Err(self.fail(js_sys::Error::new(&msg).into()));
        }
        Ok(arr.to_vec())
    }

    fn advance(&self, n: u64) {
        let done = self.done.get() + n;
        self.done.set(done);
        if let Some(cb) = &self.progress {
            // A throwing progress callback must not abort the build.
            let _ = cb.call2(&JsValue::NULL, &(done as f64).into(), &(self.total as f64).into());
        }
    }
}

/// Streams one file from JS in `READ_CHUNK` pieces.
struct JsFileReader {
    shared: Arc<Shared>,
    index: u32,
    len: u64,
    offset: u64,
    buf: Vec<u8>,
    pos: usize,
}

impl Read for JsFileReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.pos == self.buf.len() {
            let want = (self.len - self.offset).min(READ_CHUNK);
            if want == 0 {
                return Ok(0);
            }
            self.buf = self.shared.fetch(self.index, self.offset, want)?;
            self.pos = 0;
            self.offset += want;
            self.shared.advance(want);
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

enum Node {
    File { index: u32, size: u64, mtime: Option<i64> },
    Dir(BTreeMap<String, Node>),
}

pub struct Prepared {
    pub tree: InputTree,
    pub shared: Arc<Shared>,
}

/// Validates the entry list and builds the input tree.
pub fn prepare(
    entries: Vec<EntryDesc>,
    read: Option<Function>,
    progress: Option<Function>,
) -> Result<Prepared, String> {
    let mut root = BTreeMap::new();
    let mut total = 0u64;
    for (i, e) in entries.iter().enumerate() {
        let index = u32::try_from(i).map_err(|_| "too many entries".to_string())?;
        insert(&mut root, e, index)?;
        if !e.dir {
            total += e.size as u64;
        }
    }
    let shared = Arc::new(Shared {
        read,
        progress,
        done: Cell::new(0),
        total,
        error: RefCell::new(None),
    });
    let tree = InputTree::new(PathSeparator::ForwardSlash, to_entries(root, &shared));
    Ok(Prepared { tree, shared })
}

fn insert(root: &mut BTreeMap<String, Node>, e: &EntryDesc, index: u32) -> Result<(), String> {
    let parts: Vec<&str> = e.path.split('/').filter(|p| !p.is_empty()).collect();
    if parts.iter().any(|p| *p == "." || *p == "..") {
        return Err(format!("{:?}: '.' and '..' are not allowed in paths", e.path));
    }
    let Some((name, parents)) = parts.split_last() else {
        return Err(format!("entry {index} has an empty path"));
    };
    let whole_bytes = e.size.is_finite() && e.size >= 0.0 && e.size.fract() == 0.0;
    if !e.dir && !whole_bytes {
        return Err(format!("{:?}: size must be a whole number of bytes", e.path));
    }

    let mut dir = root;
    for p in parents {
        dir = match dir.entry((*p).to_string()).or_insert_with(|| Node::Dir(BTreeMap::new())) {
            Node::Dir(children) => children,
            Node::File { .. } => return Err(format!("{:?}: {p:?} is both a file and a folder", e.path)),
        };
    }
    match (dir.get(*name), e.dir) {
        (None, true) => {
            dir.insert((*name).to_string(), Node::Dir(BTreeMap::new()));
        }
        (None, false) => {
            let mtime = e.mtime.filter(|t| t.is_finite()).map(|ms| (ms / 1000.0).floor() as i64);
            dir.insert((*name).to_string(), Node::File { index, size: e.size as u64, mtime });
        }
        (Some(Node::Dir(_)), true) => {} // folder listed twice, or after one of its files
        (Some(Node::Dir(_)), false) | (Some(Node::File { .. }), true) => {
            return Err(format!("{:?} is both a file and a folder", e.path));
        }
        (Some(Node::File { .. }), false) => return Err(format!("duplicate path {:?}", e.path)),
    }
    Ok(())
}

fn to_entries(nodes: BTreeMap<String, Node>, shared: &Arc<Shared>) -> Vec<InputEntry> {
    nodes
        .into_iter()
        .map(|(name, node)| match node {
            Node::Dir(children) => InputEntry {
                name: Arc::new(name),
                kind: InputEntryKind::Directory(to_entries(children, shared)),
                metadata: InputMetadata { mode: Some(0o40755), ..Default::default() },
            },
            Node::File { index, size, mtime } => {
                let shared = shared.clone();
                let source = FileSource::new(size, move || {
                    Ok(Box::new(JsFileReader {
                        shared: shared.clone(),
                        index,
                        len: size,
                        offset: 0,
                        buf: Vec::new(),
                        pos: 0,
                    }) as Box<dyn Read + Send>)
                });
                InputEntry {
                    name: Arc::new(name),
                    kind: InputEntryKind::Source(source),
                    metadata: InputMetadata {
                        mode: Some(0o100644),
                        created: mtime,
                        modified: mtime,
                        accessed: mtime,
                        ..Default::default()
                    },
                }
            }
        })
        .collect()
}

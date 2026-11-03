//! Output side: an OPFS `FileSystemSyncAccessHandle` as `Read + Write + Seek`.
//!
//! hadris-iso writes many small records and seeks back to patch them, so
//! contiguous writes are collected into one buffer before they reach OPFS.

use std::io::{self, Read, Seek, SeekFrom, Write};

use web_sys::{FileSystemReadWriteOptions, FileSystemSyncAccessHandle};

const WRITE_BUFFER: usize = 8 * 1024 * 1024;

pub struct HandleOutput {
    pub handle: FileSystemSyncAccessHandle,
    pos: u64,
    buf: Vec<u8>,
    buf_start: u64,
}

fn js_io(what: &str, e: wasm_bindgen::JsValue) -> io::Error {
    io::Error::other(format!("{what} failed: {e:?}"))
}

fn at(offset: u64) -> FileSystemReadWriteOptions {
    let o = FileSystemReadWriteOptions::new();
    o.set_at(offset as f64);
    o
}

impl HandleOutput {
    pub fn new(handle: FileSystemSyncAccessHandle) -> Self {
        Self { handle, pos: 0, buf: Vec::new(), buf_start: 0 }
    }

    fn flush_buf(&mut self) -> io::Result<()> {
        let mut done = 0;
        while done < self.buf.len() {
            let n = self
                .handle
                .write_with_u8_array_and_options(&self.buf[done..], &at(self.buf_start + done as u64))
                .map_err(|e| js_io("writing the image", e))? as usize;
            if n == 0 {
                return Err(io::Error::new(io::ErrorKind::WriteZero, "storage is full"));
            }
            done += n;
        }
        self.buf.clear();
        Ok(())
    }
}

impl Write for HandleOutput {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if !self.buf.is_empty() && self.buf_start + self.buf.len() as u64 != self.pos {
            self.flush_buf()?;
        }
        if self.buf.is_empty() {
            self.buf_start = self.pos;
        }
        self.buf.extend_from_slice(data);
        self.pos += data.len() as u64;
        if self.buf.len() >= WRITE_BUFFER {
            self.flush_buf()?;
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.flush_buf()?;
        self.handle.flush().map_err(|e| js_io("flushing the image", e))
    }
}

impl Read for HandleOutput {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        self.flush_buf()?;
        let n = self
            .handle
            .read_with_u8_array_and_options(out, &at(self.pos))
            .map_err(|e| js_io("reading back the image", e))? as usize;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for HandleOutput {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let new = match to {
            SeekFrom::Start(n) => Some(n),
            SeekFrom::Current(d) => self.pos.checked_add_signed(d),
            SeekFrom::End(d) => {
                self.flush_buf()?;
                let size = self.handle.get_size().map_err(|e| js_io("getSize", e))? as u64;
                size.checked_add_signed(d)
            }
        };
        self.pos = new.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "seek before start"))?;
        Ok(self.pos)
    }
}

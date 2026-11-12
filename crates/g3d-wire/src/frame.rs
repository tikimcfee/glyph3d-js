//! Frames: the 12-byte header every message carries, and the binary prefixes of the data
//! frames. PROTOCOL.md "Frames" and "Data frames".

/// The default (and 1.0's only) largest payload: 16 MiB.
pub const DEFAULT_MAX_FRAME: usize = 16 * 1024 * 1024;
/// Header bytes after `len`: type, flags, reserved, stream.
const HEADER_AFTER_LEN: usize = 8;
/// The whole header: `len` plus the eight bytes it counts.
pub const HEADER_LEN: usize = 4 + HEADER_AFTER_LEN;

/// Frame type numbers. Client → daemon below 0x80, daemon → client above.
pub mod ty {
    pub const HELLO: u8 = 0x01;
    pub const REQUEST: u8 = 0x02;
    pub const INPUT: u8 = 0x03;
    pub const WELCOME: u8 = 0x81;
    pub const REPLY: u8 = 0x82;
    pub const OUTPUT: u8 = 0x83;
    pub const EVENT: u8 = 0x84;
    pub const REPAINT: u8 = 0x85;
    pub const CELLS: u8 = 0x86;
    pub const ERROR: u8 = 0xFF;
}

/// One decoded frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    pub ty: u8,
    pub flags: u8,
    pub stream: u32,
    pub payload: Vec<u8>,
}

/// Why a byte stream is not a valid frame sequence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FrameError {
    /// `len` below 8: the header doesn't fit.
    BadLen(u32),
    /// A payload larger than the agreed `max_frame`.
    TooLarge { len: usize, max: usize },
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::BadLen(n) => write!(f, "frame len {n} is below the 8-byte header"),
            FrameError::TooLarge { len, max } => write!(f, "frame payload {len} B exceeds max_frame {max} B"),
        }
    }
}

impl std::error::Error for FrameError {}

/// Writes one frame's header into `out` for a payload of `payload_len` bytes.
pub fn put_header(out: &mut Vec<u8>, ty: u8, stream: u32, payload_len: usize) {
    let len = u32::try_from(HEADER_AFTER_LEN + payload_len).expect("frame length fits u32");
    out.extend_from_slice(&len.to_le_bytes());
    out.push(ty);
    out.push(0); // flags
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved
    out.extend_from_slice(&stream.to_le_bytes());
}

/// One whole frame as bytes.
pub fn encode(ty: u8, stream: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + payload.len());
    put_header(&mut out, ty, stream, payload.len());
    out.extend_from_slice(payload);
    out
}

/// A JSON control frame (`HELLO`, `REQUEST`, `WELCOME`, `REPLY`, `EVENT`, `ERROR`).
pub fn encode_json<T: serde::Serialize>(ty: u8, stream: u32, value: &T) -> Vec<u8> {
    let json = serde_json::to_vec(value).expect("protocol types serialize");
    encode(ty, stream, &json)
}

/// Accumulates bytes from a stream socket and yields whole frames. Partial reads are normal.
#[derive(Debug)]
pub struct FrameDecoder {
    buf: Vec<u8>,
    start: usize,
    max_frame: usize,
}

impl Default for FrameDecoder {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_FRAME)
    }
}

impl FrameDecoder {
    pub fn new(max_frame: usize) -> Self {
        Self { buf: Vec::new(), start: 0, max_frame }
    }

    pub fn set_max_frame(&mut self, max_frame: usize) {
        self.max_frame = max_frame;
    }

    /// Appends bytes read from the socket.
    pub fn feed(&mut self, bytes: &[u8]) {
        if self.start > 0 && self.start == self.buf.len() {
            self.buf.clear();
            self.start = 0;
        } else if self.start > 64 * 1024 && self.start * 2 > self.buf.len() {
            self.buf.drain(..self.start);
            self.start = 0;
        }
        self.buf.extend_from_slice(bytes);
    }

    /// The next whole frame, `None` until one is complete, or an error that ends the stream.
    pub fn next_frame(&mut self) -> Result<Option<Frame>, FrameError> {
        let avail = &self.buf[self.start..];
        if avail.len() < 4 {
            return Ok(None);
        }
        let len = u32::from_le_bytes(avail[..4].try_into().unwrap());
        if (len as usize) < HEADER_AFTER_LEN {
            return Err(FrameError::BadLen(len));
        }
        let payload_len = len as usize - HEADER_AFTER_LEN;
        if payload_len > self.max_frame {
            return Err(FrameError::TooLarge { len: payload_len, max: self.max_frame });
        }
        if avail.len() < 4 + len as usize {
            return Ok(None);
        }
        let frame = Frame {
            ty: avail[4],
            flags: avail[5],
            stream: u32::from_le_bytes(avail[8..12].try_into().unwrap()),
            payload: avail[HEADER_LEN..HEADER_LEN + payload_len].to_vec(),
        };
        self.start += 4 + len as usize;
        Ok(Some(frame))
    }

    /// Bytes held that are not yet a whole frame.
    pub fn pending(&self) -> usize {
        self.buf.len() - self.start
    }
}

/// `OUTPUT`'s prefix: the `seq` of its first byte.
pub const OUTPUT_PREFIX: usize = 8;
/// `REPAINT`'s prefix: seq, cols, rows, flags.
pub const REPAINT_PREFIX: usize = 16;
/// `REPAINT` flag bit 0: the repaint shows a scrollback view, not the live screen.
pub const REPAINT_FLAG_VIEW: u32 = 1;

/// An `OUTPUT` frame's header and prefix, for `n` raw bytes that follow.
pub fn output_head(stream: u32, seq: u64, n: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + OUTPUT_PREFIX);
    put_header(&mut out, ty::OUTPUT, stream, OUTPUT_PREFIX + n);
    out.extend_from_slice(&seq.to_le_bytes());
    out
}

/// A whole `OUTPUT` frame.
pub fn encode_output(stream: u32, seq: u64, bytes: &[u8]) -> Vec<u8> {
    let mut out = output_head(stream, seq, bytes.len());
    out.extend_from_slice(bytes);
    out
}

/// Splits an `OUTPUT` payload into its `seq` and bytes.
pub fn parse_output(payload: &[u8]) -> Option<(u64, &[u8])> {
    if payload.len() < OUTPUT_PREFIX {
        return None;
    }
    Some((u64::from_le_bytes(payload[..8].try_into().unwrap()), &payload[8..]))
}

/// A `REPAINT`'s fixed prefix.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RepaintHead {
    pub seq: u64,
    pub cols: u16,
    pub rows: u16,
    pub flags: u32,
}

/// A whole `REPAINT` frame.
pub fn encode_repaint(stream: u32, head: RepaintHead, vt: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + REPAINT_PREFIX + vt.len());
    put_header(&mut out, ty::REPAINT, stream, REPAINT_PREFIX + vt.len());
    out.extend_from_slice(&head.seq.to_le_bytes());
    out.extend_from_slice(&head.cols.to_le_bytes());
    out.extend_from_slice(&head.rows.to_le_bytes());
    out.extend_from_slice(&head.flags.to_le_bytes());
    out.extend_from_slice(vt);
    out
}

/// Splits a `REPAINT` payload into its prefix and VT bytes.
pub fn parse_repaint(payload: &[u8]) -> Option<(RepaintHead, &[u8])> {
    if payload.len() < REPAINT_PREFIX {
        return None;
    }
    let head = RepaintHead {
        seq: u64::from_le_bytes(payload[..8].try_into().unwrap()),
        cols: u16::from_le_bytes(payload[8..10].try_into().unwrap()),
        rows: u16::from_le_bytes(payload[10..12].try_into().unwrap()),
        flags: u32::from_le_bytes(payload[12..16].try_into().unwrap()),
    };
    Some((head, &payload[REPAINT_PREFIX..]))
}

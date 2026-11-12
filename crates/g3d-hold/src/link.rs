//! The hold link: holder ↔ brain over a `socketpair(AF_UNIX, SOCK_STREAM)`.
//!
//! Every message is one frame in the public header (`g3d_wire::frame`): type [`MSG`], `flags` =
//! the number of fds that ride with it, stream 0, and one JSON object as the payload. A frame's
//! fds go in `SCM_RIGHTS` on the `sendmsg` that carries its first byte, so a reader that keeps
//! received fds in arrival order holds a frame's fds by the time the frame is whole: it takes
//! `flags` of them off the front of its queue. Stream sockets work on Linux and macOS alike
//! (macOS has no `SOCK_SEQPACKET` for `AF_UNIX`, and its datagrams are capped at 2 KiB).

use g3d_wire::frame::{self, FrameDecoder};
use rustix::fd::{AsFd, BorrowedFd, OwnedFd};
use rustix::net::{
    RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags, SendAncillaryBuffer, SendAncillaryMessage, SendFlags,
};
use std::collections::VecDeque;
use std::io::{self, IoSlice, IoSliceMut};
use std::mem::MaybeUninit;

/// The one frame type the hold link uses.
pub const MSG: u8 = 0x01;
/// The most fds one message carries (a terminal's master plus its stored snapshots).
pub const MAX_FDS: usize = 16;

/// One message's bytes and its fds, encoded.
pub fn encode(msg: &serde_json::Value, nfds: usize) -> Vec<u8> {
    assert!(nfds <= MAX_FDS, "a hold message carries at most {MAX_FDS} fds");
    let json = serde_json::to_vec(msg).expect("hold messages serialize");
    let mut out = frame::encode(MSG, 0, &json);
    out[5] = nfds as u8; // flags
    out
}

/// One `sendmsg`: `bytes` (or the start of them), with `fds` attached when given. Returns how
/// many bytes went; the rest go in later calls, without fds.
pub fn send_some(sock: BorrowedFd<'_>, bytes: &[u8], fds: &[BorrowedFd<'_>]) -> io::Result<usize> {
    let mut space = [MaybeUninit::<u8>::uninit(); rustix::cmsg_space!(ScmRights(MAX_FDS))];
    let mut control = SendAncillaryBuffer::new(&mut space);
    if !fds.is_empty() && !control.push(SendAncillaryMessage::ScmRights(fds)) {
        return Err(io::Error::other("hold link: too many fds for one message"));
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let flags = SendFlags::NOSIGNAL;
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    let flags = SendFlags::empty();
    loop {
        match rustix::net::sendmsg(sock, &[IoSlice::new(bytes)], &mut control, flags) {
            Ok(n) => return Ok(n),
            Err(rustix::io::Errno::INTR) => continue,
            Err(e) => return Err(e.into()),
        }
    }
}

/// Sends a whole message on a blocking socket.
pub fn send_blocking(sock: BorrowedFd<'_>, msg: &serde_json::Value, fds: &[BorrowedFd<'_>]) -> io::Result<()> {
    let bytes = encode(msg, fds.len());
    let mut off = send_some(sock, &bytes, fds)?;
    while off < bytes.len() {
        off += send_some(sock, &bytes[off..], &[])?;
    }
    Ok(())
}

/// Sets close-on-exec on an fd that arrived without it (macOS has no `MSG_CMSG_CLOEXEC`).
#[allow(dead_code)]
fn cloexec(fd: &OwnedFd) {
    let _ = rustix::io::fcntl_setfd(fd, rustix::io::FdFlags::CLOEXEC);
}

/// The receiving side: bytes into frames, fds into a queue, messages out in order.
pub struct Reader {
    dec: FrameDecoder,
    fds: VecDeque<OwnedFd>,
}

impl Default for Reader {
    fn default() -> Self {
        Self { dec: FrameDecoder::new(frame::DEFAULT_MAX_FRAME), fds: VecDeque::new() }
    }
}

/// What one `fill` saw.
pub enum Fill {
    /// Bytes (and maybe fds) arrived.
    Data,
    /// Nothing ready (a non-blocking socket).
    Empty,
    /// The peer closed the link.
    Eof,
}

impl Reader {
    /// One `recvmsg`. Blocks on a blocking socket.
    pub fn fill(&mut self, sock: BorrowedFd<'_>) -> io::Result<Fill> {
        let mut buf = [0u8; 64 * 1024];
        let mut space = [MaybeUninit::<u8>::uninit(); rustix::cmsg_space!(ScmRights(253))];
        let mut control = RecvAncillaryBuffer::new(&mut space);
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let flags = RecvFlags::CMSG_CLOEXEC;
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        let flags = RecvFlags::empty();
        let r = loop {
            match rustix::net::recvmsg(sock, &mut [IoSliceMut::new(&mut buf)], &mut control, flags) {
                Ok(r) => break r,
                Err(rustix::io::Errno::INTR) => continue,
                Err(rustix::io::Errno::AGAIN) => return Ok(Fill::Empty),
                Err(e) => return Err(e.into()),
            }
        };
        if r.flags.contains(rustix::net::ReturnFlags::CTRUNC) {
            return Err(io::Error::other("hold link: fds were truncated (control buffer too small)"));
        }
        for m in control.drain() {
            if let RecvAncillaryMessage::ScmRights(fds) = m {
                for fd in fds {
                    #[cfg(not(any(target_os = "linux", target_os = "android")))]
                    cloexec(&fd);
                    self.fds.push_back(fd);
                }
            }
        }
        if r.bytes == 0 {
            return Ok(Fill::Eof);
        }
        self.dec.feed(&buf[..r.bytes]);
        Ok(Fill::Data)
    }

    /// The next whole message and its fds, if one is complete.
    pub fn next_msg(&mut self) -> io::Result<Option<(serde_json::Value, Vec<OwnedFd>)>> {
        let f = match self.dec.next_frame() {
            Ok(Some(f)) => f,
            Ok(None) => return Ok(None),
            Err(e) => return Err(io::Error::other(format!("hold link: {e}"))),
        };
        if f.ty != MSG {
            return Err(io::Error::other(format!("hold link: frame type {:#04x}", f.ty)));
        }
        let n = f.flags as usize;
        if self.fds.len() < n {
            return Err(io::Error::other(format!("hold link: a message names {n} fds, {} arrived", self.fds.len())));
        }
        let fds: Vec<OwnedFd> = self.fds.drain(..n).collect();
        let v: serde_json::Value =
            serde_json::from_slice(&f.payload).map_err(|e| io::Error::other(format!("hold link: {e}")))?;
        if !v.is_object() || v.get("m").and_then(|m| m.as_str()).is_none() {
            return Err(io::Error::other("hold link: a message without \"m\""));
        }
        Ok(Some((v, fds)))
    }
}

/// A connected pair, both ends close-on-exec. The holder clears it on the end a brain inherits.
pub fn pair() -> io::Result<(OwnedFd, OwnedFd)> {
    use rustix::net::{AddressFamily, SocketFlags, SocketType, socketpair};
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let (a, b) = socketpair(AddressFamily::UNIX, SocketType::STREAM, SocketFlags::CLOEXEC, None)?;
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    let (a, b) = {
        let (a, b) = socketpair(AddressFamily::UNIX, SocketType::STREAM, SocketFlags::empty(), None)?;
        cloexec(&a);
        cloexec(&b);
        (a, b)
    };
    Ok((a, b))
}

/// The message name.
pub fn name(v: &serde_json::Value) -> &str {
    v.get("m").and_then(|m| m.as_str()).unwrap_or("")
}

/// Borrows a list of fds for sending.
pub fn borrow(fds: &[OwnedFd]) -> Vec<BorrowedFd<'_>> {
    fds.iter().map(|f| f.as_fd()).collect()
}

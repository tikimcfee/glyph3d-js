//! A blocking termd client: handshake, requests matched to replies by `req`, and every
//! other frame kept in order for the caller.

use g3d_wire::frame::{self, ty};
use g3d_wire::{Frame, FrameDecoder, Hello, Op, ReplyErr, ReplyHead, Request, Welcome, WireError};
use serde::de::DeserializeOwned;
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug)]
pub enum ClientError {
    Io(io::Error),
    /// The daemon refused: a failed `REPLY`, or an `ERROR` frame (the connection is over).
    Wire(WireError),
    /// The daemon sent something this client can't read.
    Protocol(String),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::Io(e) => write!(f, "{e}"),
            ClientError::Wire(e) => write!(f, "{e}"),
            ClientError::Protocol(m) => write!(f, "protocol: {m}"),
        }
    }
}

impl std::error::Error for ClientError {}

impl From<io::Error> for ClientError {
    fn from(e: io::Error) -> Self {
        ClientError::Io(e)
    }
}

impl ClientError {
    /// The wire error code, when the daemon refused.
    pub fn code(&self) -> Option<&str> {
        match self {
            ClientError::Wire(e) => Some(&e.code),
            _ => None,
        }
    }
}

pub struct Client {
    sock: UnixStream,
    dec: FrameDecoder,
    next_req: u64,
    backlog: VecDeque<Frame>,
    pub welcome: Welcome,
}

fn check_socket_parent(path: &Path, uid: u32) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) else {
        return Ok(());
    };
    let clean: PathBuf = dir.components().collect();
    let m = std::fs::symlink_metadata(&clean)?;
    if !m.file_type().is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("termd socket parent {} is not a real directory", clean.display()),
        ));
    }
    if m.uid() != uid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("termd socket directory {} is owned by uid {}, want uid {uid}", clean.display(), m.uid()),
        ));
    }
    if m.mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "termd socket directory {} has unsafe mode {:04o} (group/other access must be 0)",
                clean.display(),
                m.mode() & 0o7777
            ),
        ));
    }
    Ok(())
}

fn peer_uid(sock: &UnixStream) -> io::Result<u32> {
    #[cfg(target_os = "linux")]
    {
        let cred = rustix::net::sockopt::socket_peercred(sock).map_err(io::Error::from)?;
        Ok(cred.uid.as_raw())
    }
    #[cfg(not(target_os = "linux"))]
    {
        use std::os::fd::AsRawFd;
        let mut uid: libc::uid_t = 0;
        let mut gid: libc::gid_t = 0;
        // SAFETY: `sock` is a valid connected Unix stream fd, and `uid`/`gid` are valid out-pointers.
        let rc = unsafe { libc::getpeereid(sock.as_raw_fd(), &mut uid, &mut gid) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(uid)
    }
}

fn verify_peer_uid(sock: &UnixStream, want_uid: u32) -> io::Result<()> {
    let got = peer_uid(sock)?;
    if got != want_uid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("termd socket peer is uid {got}, want uid {want_uid}"),
        ));
    }
    Ok(())
}

impl Client {
    /// Connects and says `HELLO` as `name`, verifying the socket directory and peer UID first.
    pub fn connect(path: &Path, name: &str) -> Result<Self, ClientError> {
        let uid = rustix::process::getuid().as_raw();
        check_socket_parent(path, uid)?;
        let sock = UnixStream::connect(path)?;
        if let Err(e) = verify_peer_uid(&sock, uid) {
            drop(sock);
            return Err(ClientError::Io(e));
        }
        Self::handshake(sock, name)
    }

    pub fn handshake(mut sock: UnixStream, name: &str) -> Result<Self, ClientError> {
        let hello = Hello { proto: g3d_wire::PROTO, client: name.to_owned() };
        // The daemon may answer before reading HELLO (ERROR brain_failed, PROTOCOL.md
        // "Handshake"): a failed write still reads what is waiting, which says why.
        let wrote = sock.write_all(&frame::encode_json(ty::HELLO, 0, &hello));
        let mut c = Client {
            sock,
            dec: FrameDecoder::default(),
            next_req: 1,
            backlog: VecDeque::new(),
            welcome: Welcome {
                proto: [0, 0],
                daemon: String::new(),
                engine: String::new(),
                ns: None,
                pid: None,
                features: Vec::new(),
                max_frame: 0,
                instance: None,
                generation: None,
                holder: None,
            },
        };
        let f = match (c.read_frame(), wrote) {
            (Ok(f), Ok(())) => f,
            (Err(e @ ClientError::Wire(_)), _) => return Err(e),
            (Err(e), Ok(())) => return Err(e),
            (_, Err(w)) => return Err(ClientError::Io(w)),
        };
        if f.ty != ty::WELCOME {
            return Err(ClientError::Protocol(format!("expected WELCOME, got frame type {:#04x}", f.ty)));
        }
        c.welcome = serde_json::from_slice(&f.payload).map_err(|e| ClientError::Protocol(format!("WELCOME: {e}")))?;
        c.dec.set_max_frame(c.welcome.max_frame as usize);
        Ok(c)
    }

    pub fn stream(&self) -> &UnixStream {
        &self.sock
    }

    /// A second handle on the socket, for a writer on another thread.
    pub fn try_clone_stream(&self) -> io::Result<UnixStream> {
        self.sock.try_clone()
    }

    pub fn set_read_timeout(&self, t: Option<Duration>) -> io::Result<()> {
        self.sock.set_read_timeout(t)
    }

    pub fn send(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.sock.write_all(bytes)
    }

    /// The next frame off the socket (not the backlog). An `ERROR` frame is returned as
    /// `ClientError::Wire`.
    pub fn read_frame(&mut self) -> Result<Frame, ClientError> {
        let mut buf = [0u8; 64 * 1024];
        loop {
            match self.dec.next_frame() {
                Ok(Some(f)) => {
                    if f.ty == ty::ERROR {
                        let e: WireError = serde_json::from_slice(&f.payload)
                            .map_err(|e| ClientError::Protocol(format!("ERROR: {e}")))?;
                        return Err(ClientError::Wire(e));
                    }
                    return Ok(f);
                }
                Ok(None) => {}
                Err(e) => return Err(ClientError::Protocol(e.to_string())),
            }
            let n = self.sock.read(&mut buf)?;
            if n == 0 {
                return Err(ClientError::Io(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "daemon closed the connection",
                )));
            }
            self.dec.feed(&buf[..n]);
        }
    }

    /// The next frame: what a request set aside first, then the socket.
    pub fn next_frame(&mut self) -> Result<Frame, ClientError> {
        match self.backlog.pop_front() {
            Some(f) => Ok(f),
            None => self.read_frame(),
        }
    }

    /// Sends a request without waiting; returns its `req`. A request larger than the daemon's
    /// `max_frame` is refused here (`too_large`) and never sent: the daemon would end the whole
    /// connection over it.
    pub fn send_request(&mut self, op: Op) -> Result<u64, ClientError> {
        let req = self.next_req;
        let bytes = frame::encode_json(ty::REQUEST, 0, &Request { req, op });
        let len = bytes.len() - frame::HEADER_LEN;
        let max = self.welcome.max_frame as usize;
        if max > 0 && len > max {
            return Err(ClientError::Wire(WireError::new(
                g3d_wire::code::TOO_LARGE,
                format!("the request is {len} B as JSON; the daemon takes at most {max} B (max_frame)"),
            )));
        }
        self.next_req += 1;
        self.sock.write_all(&bytes)?;
        Ok(req)
    }

    /// Sends a request and waits for its reply; frames that arrive first are kept for
    /// `next_frame`. Returns the reply's JSON payload.
    pub fn request_raw(&mut self, op: Op) -> Result<Vec<u8>, ClientError> {
        let req = self.send_request(op)?;
        loop {
            let f = self.read_frame()?;
            if f.ty == ty::REPLY {
                let head: ReplyHead =
                    serde_json::from_slice(&f.payload).map_err(|e| ClientError::Protocol(format!("REPLY: {e}")))?;
                if head.req == req {
                    if !head.ok {
                        let e: ReplyErr = serde_json::from_slice(&f.payload)
                            .map_err(|e| ClientError::Protocol(format!("REPLY error: {e}")))?;
                        return Err(ClientError::Wire(e.error));
                    }
                    return Ok(f.payload);
                }
            }
            self.backlog.push_back(f);
        }
    }

    pub fn request<T: DeserializeOwned>(&mut self, op: Op) -> Result<T, ClientError> {
        let payload = self.request_raw(op)?;
        serde_json::from_slice(&payload).map_err(|e| ClientError::Protocol(format!("reply body: {e}")))
    }

    /// The frames requests have set aside so far, without reading the socket.
    pub fn take_backlog(&mut self) -> Vec<Frame> {
        self.backlog.drain(..).collect()
    }

    /// Sends `INPUT` for `handle`.
    pub fn input(&mut self, handle: u32, bytes: &[u8]) -> io::Result<()> {
        self.sock.write_all(&frame::encode(ty::INPUT, handle, bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    use std::os::unix::net::UnixListener;
    use std::sync::mpsc;

    fn short_tmp_dir(tag: &str) -> PathBuf {
        let dir = PathBuf::from(format!("/tmp/g3d-cli-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).unwrap();
        dir
    }

    #[test]
    fn connect_rejects_0755_and_symlink_socket_dirs_and_verifies_peer_uid() {
        let dir755 = short_tmp_dir("755");
        std::fs::set_permissions(&dir755, std::fs::Permissions::from_mode(0o755)).unwrap();
        let sock755 = dir755.join("termd-test.sock");
        let _ln755 = UnixListener::bind(&sock755).unwrap();
        match Client::connect(&sock755, "test") {
            Err(ClientError::Io(e)) => assert_eq!(e.kind(), io::ErrorKind::PermissionDenied, "{e}"),
            other => panic!("expected PermissionDenied on 0755 dir, got {}", other.err().unwrap()),
        }
        let _ = std::fs::remove_dir_all(&dir755);

        let real = short_tmp_dir("real");
        let link_parent = short_tmp_dir("lnk");
        let link = link_parent.join("sym");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let real_sock = real.join("termd-ok.sock");
        let ln = UnixListener::bind(&real_sock).unwrap();

        match Client::connect(&link.join("termd-ok.sock"), "test") {
            Err(ClientError::Io(e)) => assert_eq!(e.kind(), io::ErrorKind::PermissionDenied, "{e}"),
            other => panic!("expected PermissionDenied on symlink dir, got {}", other.err().unwrap()),
        }

        // Missing socket directory yields NotFound so connect_or_start knows no daemon runs yet.
        let missing = real.join("nonexistent-subdir").join("termd-none.sock");
        match Client::connect(&missing, "test") {
            Err(ClientError::Io(e)) => assert_eq!(e.kind(), io::ErrorKind::NotFound, "{e}"),
            other => panic!("expected NotFound on missing dir, got {}", other.err().unwrap()),
        }

        // Valid 0700 dir + same-UID peer succeeds; verify_peer_uid rejects mismatched UID.
        let (tx, rx) = mpsc::channel();
        let handle = std::thread::spawn(move || {
            let (mut s, _) = ln.accept().unwrap();
            let mut dec = FrameDecoder::default();
            let mut buf = [0u8; 1024];
            loop {
                let n = s.read(&mut buf).unwrap();
                assert!(n > 0, "unexpected EOF before HELLO");
                dec.feed(&buf[..n]);
                if let Some(f) = dec.next_frame().unwrap() {
                    assert_eq!(f.ty, ty::HELLO);
                    tx.send(true).unwrap();
                    break;
                }
            }
            let welcome = Welcome {
                proto: g3d_wire::PROTO,
                daemon: "g3d-termd/test".into(),
                engine: "mock".into(),
                ns: Some("ok".into()),
                pid: Some(std::process::id()),
                features: vec![],
                max_frame: 16 << 20,
                instance: Some("inst-1".into()),
                generation: Some(1),
                holder: None,
            };
            s.write_all(&frame::encode_json(ty::WELCOME, 0, &welcome)).unwrap();
        });

        let c = Client::connect(&real_sock, "test").unwrap();
        assert_eq!(c.welcome.daemon, "g3d-termd/test");
        assert!(rx.recv().unwrap());
        let uid = rustix::process::getuid().as_raw();
        verify_peer_uid(c.stream(), uid).unwrap();
        let mismatch = verify_peer_uid(c.stream(), uid.wrapping_add(1)).unwrap_err();
        assert_eq!(mismatch.kind(), io::ErrorKind::PermissionDenied);
        drop(c);
        handle.join().unwrap();

        let _ = std::fs::remove_dir_all(&real);
        let _ = std::fs::remove_dir_all(&link_parent);
    }
}

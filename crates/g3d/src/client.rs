//! A blocking termd client: handshake, requests matched to replies by `req`, and every
//! other frame kept in order for the caller.

use g3d_wire::frame::{self, ty};
use g3d_wire::{Frame, FrameDecoder, Hello, Op, ReplyErr, ReplyHead, Request, Welcome, WireError};
use serde::de::DeserializeOwned;
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
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

impl Client {
    /// Connects and says `HELLO` as `name`.
    pub fn connect(path: &Path, name: &str) -> Result<Self, ClientError> {
        let sock = UnixStream::connect(path)?;
        Self::handshake(sock, name)
    }

    pub fn handshake(mut sock: UnixStream, name: &str) -> Result<Self, ClientError> {
        let hello = Hello { proto: g3d_wire::PROTO, client: name.to_owned() };
        sock.write_all(&frame::encode_json(ty::HELLO, 0, &hello))?;
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
            },
        };
        let f = c.read_frame()?;
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

    /// Sends a request without waiting; returns its `req`.
    pub fn send_request(&mut self, op: Op) -> io::Result<u64> {
        let req = self.next_req;
        self.next_req += 1;
        self.sock.write_all(&frame::encode_json(ty::REQUEST, 0, &Request { req, op }))?;
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

    /// Sends `INPUT` for `handle`.
    pub fn input(&mut self, handle: u32, bytes: &[u8]) -> io::Result<()> {
        self.sock.write_all(&frame::encode(ty::INPUT, handle, bytes))
    }
}

//! The brain's side of the hold link (DESIGN.md, "Holder and brain"): the startup handshake that
//! hands this brain the listening socket, the `seq_marks` page and every terminal, then a reader
//! thread that routes the holder's messages, and the requests the brain sends it.

use g3d_hold::link::{self, Fill, Reader};
use rustix::fd::{AsFd, FromRawFd, OwnedFd};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

/// One hold-link message and the fds that came with it.
type Msg = (Value, Vec<OwnedFd>);

/// What the holder said at `welcome`.
pub struct Welcome {
    pub instance: String,
    pub generation: u64,
    pub holder_pid: u32,
    pub holder_version: String,
    pub candidate: bool,
    pub max_terminals: usize,
    /// The holder's hold protocol version.
    pub hold: [u64; 2],
    /// When the holder started (ms since the epoch): the namespace's age.
    pub started_at: u64,
    /// (hold 2.1) Brains replaced so far, by cause; zero from an older holder.
    pub restarts: g3d_wire::BrainRestarts,
    /// (hold 2.1) Why this brain starts (`first`, `crash`, `watchdog`, `upgrade`), when, and how
    /// the last one ended; `unknown` from an older holder.
    pub reason: String,
    pub at: u64,
    pub exit: Option<g3d_wire::ExitStatus>,
}

/// One terminal the holder keeps, as it handed it to this brain.
pub struct Held {
    pub handle: u32,
    pub slot: u32,
    pub id: String,
    pub pid: u32,
    pub meta: Value,
    pub exit: Option<Exit>,
    pub master: OwnedFd,
    /// Newest first.
    pub blobs: Vec<OwnedFd>,
}

/// How a program ended, as the holder reaped it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Exit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

impl Exit {
    pub fn from_msg(m: &Value) -> Self {
        Exit {
            code: m.get("code").and_then(Value::as_i64).map(|c| c as i32),
            signal: m.get("signal").and_then(Value::as_i64).map(|s| s as i32),
        }
    }
}

/// Messages the server acts on: `candidate`, `upgrade_abort`, `commit`, `shutdown`.
pub type Ctl = mpsc::UnboundedReceiver<Value>;

pub struct Hold {
    sock: OwnedFd,
    wmu: Mutex<()>,
    next_req: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Msg>>>,
    pub welcome: Welcome,
}

/// The `seq_marks` page, mapped: each terminal's `seq` after the brain's latest read, at its slot.
pub struct Marks {
    base: *const AtomicU64,
    n: usize,
}

// SAFETY: the page is shared memory of AtomicU64s, mapped for the process's life.
unsafe impl Send for Marks {}
unsafe impl Sync for Marks {}

impl Marks {
    fn map(fd: &OwnedFd, n: usize) -> std::io::Result<Self> {
        let p = g3d_hold::shm::map(fd, n * g3d_hold::MARK_BYTES, true)?;
        Ok(Marks { base: p as *const AtomicU64, n })
    }

    pub fn get(&self, slot: u32) -> u64 {
        assert!((slot as usize) < self.n);
        // SAFETY: in bounds of a mapping that lives as long as the process.
        u64::from_le(unsafe { &*self.base.add(slot as usize) }.load(Ordering::Relaxed))
    }

    pub fn set(&self, slot: u32, seq: u64) {
        assert!((slot as usize) < self.n);
        // SAFETY: as above.
        unsafe { &*self.base.add(slot as usize) }.store(seq.to_le(), Ordering::Relaxed);
    }
}

/// Everything the startup handshake hands over.
pub struct Start {
    pub hold: Arc<Hold>,
    pub listener: OwnedFd,
    pub marks: Arc<Marks>,
    pub terms: Vec<Held>,
    pub ctl: Ctl,
    reader: Reader,
    ctl_tx: mpsc::UnboundedSender<Value>,
}

fn fail(msg: impl std::fmt::Display) -> ! {
    crate::log(&format!("hold link: {msg}; exiting"));
    std::process::exit(1);
}

/// Blocks until the next message (startup only, before the reader thread exists).
fn recv(sock: &OwnedFd, rd: &mut Reader) -> (Value, Vec<OwnedFd>) {
    loop {
        match rd.next_msg() {
            Ok(Some(m)) => return m,
            Ok(None) => {}
            Err(e) => fail(e),
        }
        match rd.fill(sock.as_fd()) {
            Ok(Fill::Data) | Ok(Fill::Empty) => {}
            Ok(Fill::Eof) => fail("the holder closed the link"),
            Err(e) => fail(e),
        }
    }
}

/// Says hello on the inherited link and takes what the holder hands a new brain: `welcome`
/// (listener, `seq_marks`), each `term`, `terms_done`.
pub fn start(fd: i32, engine: &str) -> Start {
    // SAFETY: the holder passed this fd number on the command line; nothing else owns it.
    let sock = unsafe { OwnedFd::from_raw_fd(fd) };
    let _ = rustix::io::fcntl_setfd(&sock, rustix::io::FdFlags::CLOEXEC);
    let hello = json!({"m": "hello", "hold": g3d_hold::HOLD, "engine": engine,
        "version": crate::VERSION, "pid": std::process::id()});
    if let Err(e) = link::send_blocking(sock.as_fd(), &hello, &[]) {
        fail(e);
    }
    let mut rd = Reader::default();
    let (w, fds) = recv(&sock, &mut rd);
    if link::name(&w) != "welcome" || fds.len() != 2 {
        fail(format!("expected welcome with 2 fds, got {:?} with {}", link::name(&w), fds.len()));
    }
    let s = |k: &str| w.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    let n = |k: &str| w.get(k).and_then(Value::as_u64).unwrap_or(0);
    let welcome = Welcome {
        instance: s("instance"),
        generation: n("generation"),
        holder_pid: n("holder_pid") as u32,
        holder_version: s("holder_version"),
        candidate: w.get("candidate").and_then(Value::as_bool).unwrap_or(false),
        max_terminals: n("max_terminals") as usize,
        hold: w.get("hold").and_then(|h| serde_json::from_value(h.clone()).ok()).unwrap_or([0, 0]),
        started_at: n("started_at"),
        restarts: w.get("restarts").and_then(|r| serde_json::from_value(r.clone()).ok()).unwrap_or_default(),
        reason: w.pointer("/last_start/reason").and_then(Value::as_str).unwrap_or("unknown").to_owned(),
        at: w.pointer("/last_start/at").and_then(Value::as_u64).unwrap_or(0),
        exit: w.pointer("/last_start/exit").map(|e| {
            let e = Exit::from_msg(e);
            g3d_wire::ExitStatus { code: e.code, signal: e.signal.map(crate::spawn::signal_name) }
        }),
    };
    let mut fds = fds.into_iter();
    let listener = fds.next().expect("listener");
    let marks = Marks::map(&fds.next().expect("marks"), welcome.max_terminals)
        .unwrap_or_else(|e| fail(format!("seq_marks: {e}")));
    let mut terms = Vec::new();
    loop {
        let (m, fds) = recv(&sock, &mut rd);
        match link::name(&m) {
            "term" => {
                let mut fds = fds.into_iter();
                let Some(master) = fds.next() else { fail("a term without its master fd") };
                let u = |k: &str| m.get(k).and_then(Value::as_u64).unwrap_or(0);
                terms.push(Held {
                    handle: u("handle") as u32,
                    slot: u("slot") as u32,
                    id: m.get("id").and_then(Value::as_str).unwrap_or("").to_owned(),
                    pid: u("pid") as u32,
                    meta: m.get("meta").cloned().unwrap_or(Value::Null),
                    exit: m.get("exit").map(Exit::from_msg),
                    master,
                    blobs: fds.collect(),
                });
            }
            "terms_done" => break,
            "exited" => {
                let h = m.get("handle").and_then(Value::as_u64).unwrap_or(0) as u32;
                if let Some(t) = terms.iter_mut().find(|t| t.handle == h) {
                    t.exit = Some(Exit::from_msg(&m));
                }
            }
            other => crate::log(&format!("hold link: {other:?} before terms_done; ignored")),
        }
    }
    let (ctl_tx, ctl) = mpsc::unbounded_channel();
    let hold = Arc::new(Hold {
        sock,
        wmu: Mutex::new(()),
        next_req: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
        welcome,
    });
    Start { hold, listener, marks: Arc::new(marks), terms, ctl, reader: rd, ctl_tx }
}

impl Start {
    /// Waits for `go` (the holder's word that no other brain reads the PTYs any more), passing
    /// `exited` on through `exited`, then starts the reader thread.
    pub fn wait_go(&mut self, exited: &dyn Fn(u32, Exit)) {
        loop {
            let (m, _fds) = recv(&self.hold.sock, &mut self.reader);
            match link::name(&m) {
                "go" => break,
                "exited" => exited(m.get("handle").and_then(Value::as_u64).unwrap_or(0) as u32, Exit::from_msg(&m)),
                "shutdown" => {
                    crate::log("the holder is ending the namespace before this brain started; exiting");
                    std::process::exit(0);
                }
                other => crate::log(&format!("hold link: {other:?} before go; ignored")),
            }
        }
    }

    /// Starts the thread that routes the holder's messages for the brain's life.
    pub fn spawn_reader(self, exited: Box<dyn Fn(u32, Exit) + Send>) -> (Arc<Hold>, Ctl) {
        let Start { hold, ctl, mut reader, ctl_tx, .. } = self;
        let h = hold.clone();
        std::thread::Builder::new()
            .name("hold-link".into())
            .spawn(move || {
                loop {
                    let (m, fds) = recv(&h.sock, &mut reader);
                    match link::name(&m) {
                        "spawned" => {
                            let req = m.get("req").and_then(Value::as_u64).unwrap_or(0);
                            if let Some(tx) = h.pending.lock().unwrap().remove(&req) {
                                let _ = tx.send((m, fds));
                            }
                        }
                        "exited" => {
                            exited(m.get("handle").and_then(Value::as_u64).unwrap_or(0) as u32, Exit::from_msg(&m))
                        }
                        _ => {
                            let _ = ctl_tx.send(m);
                        }
                    }
                }
            })
            .expect("hold-link thread");
        (hold, ctl)
    }
}

impl Hold {
    /// Sends a message. A failed send means the holder is gone, and with it every shell: the
    /// brain has nothing left to serve.
    pub fn send(&self, msg: &Value, fds: &[OwnedFd]) {
        let _g = self.wmu.lock().unwrap();
        if let Err(e) = link::send_blocking(self.sock.as_fd(), msg, &link::borrow(fds)) {
            fail(format!("send {:?}: {e}", link::name(msg)));
        }
    }

    /// Asks the holder to start a program; answers with `(handle, slot, pid, master)`.
    pub async fn spawn(&self, mut req: Value) -> Result<(u32, u32, u32, OwnedFd), String> {
        let n = self.next_req.fetch_add(1, Ordering::SeqCst);
        req["m"] = json!("spawn");
        req["req"] = json!(n);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(n, tx);
        self.send(&req, &[]);
        let (m, fds) = rx.await.map_err(|_| "the holder did not answer".to_owned())?;
        if let Some(e) = m.get("error").and_then(Value::as_str) {
            return Err(e.to_owned());
        }
        let u = |k: &str| m.get(k).and_then(Value::as_u64).unwrap_or(0) as u32;
        let master = fds.into_iter().next().ok_or("spawned without a master fd")?;
        Ok((u("handle"), u("slot"), u("pid"), master))
    }
}

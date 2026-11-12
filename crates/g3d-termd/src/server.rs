//! The socket side: accepting connections, the handshake, routing requests and input to
//! owner threads. No terminal state lives here (DESIGN.md, "Threading").

use crate::out::ConnOut;
use crate::owner::{self, Cmd, CreateSpec, Registry, TermOp, TermRef, reply_err, reply_ok};
use g3d_wire::frame::{self, Frame, FrameDecoder, FrameError, ty};
use g3d_wire::msg::*;
use rustix::process::Signal;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::net::UnixStream;
use tokio::sync::oneshot;

pub const ENGINE: &str = "libghostty-vt/1.0.1";

pub struct Server {
    pub reg: Arc<Registry>,
    pub socket: PathBuf,
    conns: AtomicUsize,
    next_conn: AtomicU64,
    create_lock: tokio::sync::Mutex<()>,
    uid: u32,
}

/// Removes the socket and exits the process. Terminals must already be gone.
pub fn exit_daemon(socket: &PathBuf, why: &str) -> ! {
    crate::log(&format!("exiting: {why}"));
    let _ = std::fs::remove_file(socket);
    std::process::exit(0);
}

pub async fn run(listener: std::os::unix::net::UnixListener, reg: Arc<Registry>, idle_exit: Duration, socket: PathBuf) {
    listener.set_nonblocking(true).expect("nonblocking listener");
    let listener = tokio::net::UnixListener::from_std(listener).expect("tokio listener");
    let srv = Arc::new(Server {
        reg,
        socket,
        conns: AtomicUsize::new(0),
        next_conn: AtomicU64::new(1),
        create_lock: tokio::sync::Mutex::new(()),
        uid: rustix::process::getuid().as_raw(),
    });

    // A clean shutdown: every terminal is killed and reaped, then the socket goes.
    {
        let srv = srv.clone();
        tokio::spawn(async move {
            use tokio::signal::unix::{SignalKind, signal};
            let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
            let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
            let which = tokio::select! { _ = term.recv() => "SIGTERM", _ = int.recv() => "SIGINT" };
            crate::log(&format!("{which}: killing {} terminal(s)", srv.reg.len()));
            owner::kill_all(&srv.reg).await;
            exit_daemon(&srv.socket, which);
        });
    }

    if !idle_exit.is_zero() {
        let srv = srv.clone();
        tokio::spawn(async move {
            let mut idle_since: Option<Instant> = None;
            loop {
                tokio::time::sleep(Duration::from_millis(500).min(idle_exit)).await;
                if srv.reg.len() == 0 && srv.conns.load(SeqCst) == 0 {
                    let since = *idle_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= idle_exit {
                        exit_daemon(&srv.socket, &format!("no terminals and no connections for {idle_exit:?}"));
                    }
                } else {
                    idle_since = None;
                }
            }
        });
    }

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let srv = srv.clone();
                srv.conns.fetch_add(1, SeqCst);
                tokio::spawn(async move {
                    conn_task(&srv, stream).await;
                    srv.conns.fetch_sub(1, SeqCst);
                });
            }
            Err(e) => {
                crate::log(&format!("accept: {e}"));
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

struct Conn {
    id: u64,
    out: Arc<ConnOut>,
    hello: bool,
    subs: HashMap<u32, Arc<TermRef>>,
}

enum Flow {
    Continue,
    Close,
}

fn fatal(out: &ConnOut, code: &str, message: impl Into<String>) -> Flow {
    out.frame(frame::encode_json(ty::ERROR, 0, &WireError::new(code, message)));
    out.close_after_drain();
    Flow::Close
}

async fn conn_task(srv: &Arc<Server>, stream: UnixStream) {
    let out = ConnOut::new();
    match stream.peer_cred() {
        Ok(c) if c.uid() == srv.uid => {}
        Ok(c) => {
            crate::log(&format!("refused a connection from uid {}", c.uid()));
            fatal(&out, code::AUTH, "this daemon serves its own user only");
            let (_, wr) = stream.into_split();
            out.run_writer(wr).await;
            return;
        }
        Err(e) => {
            crate::log(&format!("peer credentials: {e}"));
            return;
        }
    }
    let (mut rd, wr) = stream.into_split();
    let writer = {
        let out = out.clone();
        tokio::spawn(async move { out.run_writer(wr).await })
    };
    let mut c = Conn { id: srv.next_conn.fetch_add(1, SeqCst), out: out.clone(), hello: false, subs: HashMap::new() };
    let mut dec = FrameDecoder::default();
    let mut buf = vec![0u8; 64 * 1024];
    'conn: loop {
        let n = match rd.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        dec.feed(&buf[..n]);
        loop {
            match dec.next_frame() {
                Ok(None) => break,
                Ok(Some(f)) => {
                    if let Flow::Close = handle_frame(srv, &mut c, f).await {
                        break 'conn;
                    }
                }
                Err(e @ FrameError::TooLarge { .. }) => {
                    fatal(&out, code::TOO_LARGE, e.to_string());
                    break 'conn;
                }
                Err(e) => {
                    fatal(&out, code::BAD_FRAME, e.to_string());
                    break 'conn;
                }
            }
            if out.is_closed() {
                break 'conn;
            }
        }
    }
    for t in c.subs.values() {
        owner::detach(t, c.id);
    }
    out.close_after_drain();
    let _ = tokio::time::timeout(Duration::from_secs(5), writer).await;
}

async fn handle_frame(srv: &Arc<Server>, c: &mut Conn, f: Frame) -> Flow {
    if !c.hello {
        if f.ty != ty::HELLO {
            return fatal(&c.out, code::BAD_FRAME, format!("frame type {:#04x} before HELLO", f.ty));
        }
        let hello: Hello = match serde_json::from_slice(&f.payload) {
            Ok(h) => h,
            Err(e) => return fatal(&c.out, code::BAD_FRAME, format!("HELLO: {e}")),
        };
        if hello.proto[0] != PROTO[0] {
            return fatal(
                &c.out,
                code::VERSION,
                format!("daemon speaks {}.x; client sent {}.{}", PROTO[0], hello.proto[0], hello.proto[1]),
            );
        }
        c.hello = true;
        let w = Welcome {
            proto: PROTO,
            daemon: concat!("g3d-termd/", env!("CARGO_PKG_VERSION")).into(),
            engine: ENGINE.into(),
            ns: srv.reg.cfg.ns.clone(),
            pid: Some(std::process::id()),
            features: FEATURES.iter().map(|s| s.to_string()).collect(),
            max_frame: frame::DEFAULT_MAX_FRAME as u64,
        };
        c.out.frame(frame::encode_json(ty::WELCOME, 0, &w));
        return Flow::Continue;
    }
    match f.ty {
        ty::REQUEST => handle_request(srv, c, &f.payload).await,
        ty::INPUT => {
            let err = |code: &str, msg: String| {
                c.out.frame(frame::encode_json(ty::EVENT, f.stream, &Event::Error { code: code.into(), message: msg }));
            };
            match c.subs.get(&f.stream) {
                Some(t) => {
                    let cmd = Cmd { conn: c.id, out: c.out.clone(), req: 0, op: TermOp::Input(f.payload), done: None };
                    if t.send(cmd).is_err() {
                        c.subs.remove(&f.stream);
                        err(code::NO_TERMINAL, format!("handle {} is closed", f.stream));
                    }
                }
                None if srv.reg.by_handle(f.stream).is_some() => {
                    err(code::NOT_SUBSCRIBED, format!("INPUT for handle {} without a subscription", f.stream))
                }
                None => err(code::NO_TERMINAL, format!("no terminal with handle {}", f.stream)),
            }
            Flow::Continue
        }
        ty::HELLO => fatal(&c.out, code::BAD_FRAME, "a second HELLO"),
        other => fatal(&c.out, code::BAD_FRAME, format!("unknown frame type {other:#04x}")),
    }
}

/// Sends `op` to a terminal's owner thread and waits until it has answered.
async fn to_owner(c: &Conn, t: &TermRef, req: u64, op: TermOp) -> bool {
    let (tx, rx) = oneshot::channel();
    let cmd = Cmd { conn: c.id, out: c.out.clone(), req, op, done: Some(tx) };
    if t.send(cmd).is_err() {
        reply_err(&c.out, req, code::NO_TERMINAL, format!("terminal {} is gone", t.id));
        return false;
    }
    match rx.await {
        Ok(ok) => ok,
        Err(_) => {
            reply_err(&c.out, req, code::NO_TERMINAL, format!("terminal {} failed while handling the request", t.id));
            false
        }
    }
}

/// The terminal a handle-addressed op names, if this connection subscribes to it.
fn subscribed<'a>(srv: &Server, c: &'a Conn, req: u64, handle: u32) -> Option<&'a Arc<TermRef>> {
    match c.subs.get(&handle) {
        Some(t) => Some(t),
        None => {
            if srv.reg.by_handle(handle).is_some() {
                reply_err(&c.out, req, code::NOT_SUBSCRIBED, format!("not subscribed to handle {handle}"));
            } else {
                reply_err(&c.out, req, code::NO_TERMINAL, format!("no terminal with handle {handle}"));
            }
            None
        }
    }
}

fn by_id(srv: &Server, c: &Conn, req: u64, id: &str) -> Option<Arc<TermRef>> {
    let t = srv.reg.by_id(id);
    if t.is_none() {
        reply_err(&c.out, req, code::NO_TERMINAL, format!("no terminal {id:?}"));
    }
    t
}

async fn handle_request(srv: &Arc<Server>, c: &mut Conn, payload: &[u8]) -> Flow {
    let v: serde_json::Value = match serde_json::from_slice(payload) {
        Ok(v @ serde_json::Value::Object(_)) => v,
        Ok(_) => return fatal(&c.out, code::BAD_FRAME, "REQUEST payload is not a JSON object"),
        Err(e) => return fatal(&c.out, code::BAD_FRAME, format!("REQUEST: {e}")),
    };
    let Some(req) = v.get("req").and_then(|r| r.as_u64()) else {
        return fatal(&c.out, code::BAD_FRAME, "REQUEST without an integer req");
    };
    let Some(op) = v.get("op").and_then(|o| o.as_str()).map(str::to_owned) else {
        reply_err(&c.out, req, code::BAD_REQUEST, "REQUEST without an op");
        return Flow::Continue;
    };
    if !KNOWN_OPS.contains(&op.as_str()) {
        reply_err(&c.out, req, code::UNKNOWN_OP, format!("unknown op {op:?}"));
        return Flow::Continue;
    }
    let r: Request = match serde_json::from_value(v) {
        Ok(r) => r,
        Err(e) => {
            reply_err(&c.out, req, code::BAD_REQUEST, format!("{op}: {e}"));
            return Flow::Continue;
        }
    };
    match r.op {
        Op::Ping => reply_ok(&c.out, req, &Empty {}),
        Op::List => {
            let terminals = srv.reg.all().iter().map(|t| t.info.lock().unwrap().clone()).collect();
            reply_ok(&c.out, req, &ListReply { terminals });
        }
        Op::Create(cr) => {
            let adopt = cr.if_exists == Some(IfExists::Adopt);
            let spec = match CreateSpec::from_request(cr, &srv.reg.cfg) {
                Ok(s) => s,
                Err(e) => {
                    reply_err(&c.out, req, &e.code, e.message);
                    return Flow::Continue;
                }
            };
            let _g = srv.create_lock.lock().await;
            if let Some(t) = srv.reg.by_id(&spec.id) {
                if adopt {
                    let i = t.info.lock().unwrap().clone();
                    reply_ok(
                        &c.out,
                        req,
                        &CreateReply {
                            id: i.id,
                            handle: i.handle,
                            pid: i.pid,
                            created: false,
                            cols: i.cols,
                            rows: i.rows,
                        },
                    );
                } else {
                    reply_err(&c.out, req, code::EXISTS, format!("terminal {:?} exists", spec.id));
                }
                return Flow::Continue;
            }
            let (id, cols, rows) = (spec.id.clone(), spec.cols, spec.rows);
            match owner::create(&srv.reg, spec).await {
                Ok((t, pid)) => {
                    reply_ok(&c.out, req, &CreateReply { id, handle: t.handle, pid, created: true, cols, rows })
                }
                Err(e) => {
                    crate::log(&format!("create {id}: {e}"));
                    reply_err(&c.out, req, &e.code, e.message);
                }
            }
        }
        Op::Kill(k) => {
            let signal = match k.signal.as_deref() {
                None | Some("HUP") => Signal::HUP,
                Some("TERM") => Signal::TERM,
                Some("KILL") => Signal::KILL,
                Some(s) => {
                    reply_err(&c.out, req, code::BAD_REQUEST, format!("signal {s:?} is not HUP, TERM or KILL"));
                    return Flow::Continue;
                }
            };
            if let Some(t) = by_id(srv, c, req, &k.id) {
                to_owner(c, &t, req, TermOp::Kill { signal, reply: true }).await;
                c.subs.remove(&t.handle);
            }
        }
        Op::Subscribe(s) => {
            if let Some(t) = by_id(srv, c, req, &s.id) {
                if c.subs.contains_key(&t.handle) {
                    reply_err(&c.out, req, code::ALREADY_SUBSCRIBED, format!("already subscribed to {}", t.id));
                } else if to_owner(c, &t, req, TermOp::Subscribe(s)).await {
                    c.subs.insert(t.handle, t);
                }
            }
        }
        Op::Unsubscribe(h) => {
            if let Some(t) = subscribed(srv, c, req, h.handle).cloned() {
                to_owner(c, &t, req, TermOp::Unsubscribe).await;
                c.subs.remove(&h.handle);
            }
        }
        Op::Take(tk) => {
            if let Some(t) = subscribed(srv, c, req, tk.handle).cloned() {
                to_owner(c, &t, req, TermOp::Take { cols: tk.cols, rows: tk.rows }).await;
            }
        }
        Op::Resize(rz) => {
            if let Some(t) = subscribed(srv, c, req, rz.handle).cloned() {
                to_owner(c, &t, req, TermOp::Resize { cols: rz.cols, rows: rz.rows }).await;
            }
        }
        Op::Repaint(rp) => {
            if let Some(t) = subscribed(srv, c, req, rp.handle).cloned() {
                to_owner(c, &t, req, TermOp::Repaint { history_rows: rp.history_rows.unwrap_or(0) }).await;
            }
        }
        Op::View(vw) => {
            if vw.delta.is_none() && vw.live != Some(true) {
                reply_err(&c.out, req, code::BAD_REQUEST, "view needs delta or live: true");
                return Flow::Continue;
            }
            if let Some(t) = subscribed(srv, c, req, vw.handle).cloned() {
                to_owner(c, &t, req, TermOp::View { delta: vw.delta, live: vw.live == Some(true) }).await;
            }
        }
        Op::Capture(cp) => {
            if let Some(t) = by_id(srv, c, req, &cp.id) {
                to_owner(c, &t, req, TermOp::Capture(cp)).await;
            }
        }
        Op::Stop => {
            crate::log(&format!("stop requested: killing {} terminal(s)", srv.reg.len()));
            owner::kill_all(&srv.reg).await;
            reply_ok(&c.out, req, &Empty {});
            c.out.close_after_drain();
            let srv = srv.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(200)).await;
                exit_daemon(&srv.socket, "stop");
            });
            return Flow::Close;
        }
    }
    Flow::Continue
}

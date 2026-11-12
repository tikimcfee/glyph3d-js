//! g3d: the reference termd client. Attach to a terminal from any real terminal, watch
//! one, list, create, kill, stop (docs/termd/DESIGN.md, "`g3d`: attach from any terminal").
//!
//!   g3d [--ns NS | --socket PATH] ls
//!   g3d new <id> [--cols N --rows N] [--cwd DIR] [-- cmd...]
//!   g3d attach <id> [--take] [--detach-key ^\]
//!   g3d watch <id>
//!   g3d capture <id> [--history N] [--vt]
//!   g3d kill <id> [--signal HUP|TERM|KILL]
//!   g3d upgrade [--binary PATH]
//!   g3d stop

use clap::{Parser, Subcommand};
use g3d::client::{Client, ClientError};
use g3d::start::{self, Target};
use g3d_wire::frame::{self, ty};
use g3d_wire::*;
use rustix::termios::{self, OptionalActions, Termios};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Parser)]
#[command(name = "g3d", version, about = "Attach to, watch and manage g3d-termd terminals")]
struct Cli {
    /// The daemon's namespace.
    #[arg(long, global = true, default_value = g3d::paths::DEFAULT_NS)]
    ns: String,
    /// An explicit daemon socket instead of a namespace's.
    #[arg(long, global = true)]
    socket: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// List the terminals.
    Ls,
    /// Start a program on a new terminal (starts the daemon if needed).
    New {
        id: String,
        #[arg(long, default_value_t = 80)]
        cols: u16,
        #[arg(long, default_value_t = 24)]
        rows: u16,
        #[arg(long)]
        cwd: Option<String>,
        /// The program and its arguments (default: $SHELL).
        #[arg(last = true)]
        argv: Vec<String>,
    },
    /// Attach this terminal: see the screen, type into it.
    Attach {
        id: String,
        /// Own the size: this window's size becomes the terminal's, for every viewer.
        /// Ends when another client takes the terminal (attach again to take it back).
        #[arg(long)]
        take: bool,
        /// The key pressed twice to detach, as ^X.
        #[arg(long, default_value = "^\\")]
        detach_key: String,
    },
    /// Watch a terminal without typing into it.
    Watch {
        id: String,
        #[arg(long, default_value = "^\\")]
        detach_key: String,
    },
    /// Print the screen (and some scrollback) as text.
    Capture {
        id: String,
        #[arg(long, default_value_t = 0)]
        history: u32,
        /// Keep colours and styles (SGR).
        #[arg(long)]
        vt: bool,
    },
    /// Kill a terminal's program.
    Kill {
        id: String,
        #[arg(long)]
        signal: Option<String>,
    },
    /// Kill every terminal and stop the daemon.
    Stop,
    /// Replace the daemon's engine (its brain) without ending any terminal. With the brain
    /// failed, retries it now (SIGHUP to the holder).
    Upgrade {
        /// The new g3d-termd (default: the path the daemon was started from).
        #[arg(long)]
        binary: Option<PathBuf>,
    },
}

fn die(msg: impl std::fmt::Display) -> ! {
    eprintln!("g3d: {msg}");
    std::process::exit(1);
}

fn connect(target: &Target) -> Client {
    start::connect(target, "g3d").unwrap_or_else(|e| match &e {
        ClientError::Io(io)
            if matches!(io.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused) =>
        {
            die(format!("no daemon at {} (g3d new <id> starts one)", target.socket().display()))
        }
        _ => die(format!("{}: {e}", target.socket().display())),
    })
}

fn main() {
    let cli = Cli::parse();
    let target = match cli.socket {
        Some(p) => Target::Socket(p),
        None => {
            g3d::paths::validate_name("namespace", &cli.ns).unwrap_or_else(|m| die(m));
            Target::Ns(cli.ns)
        }
    };
    match cli.cmd {
        Cmd::Ls => {
            let mut c = connect(&target);
            let l: ListReply = c.request(Op::List).unwrap_or_else(|e| die(e));
            if l.terminals.is_empty() {
                println!("no terminals ({})", target.socket().display());
            }
            for t in l.terminals {
                let s = t.subscribers;
                println!(
                    "{:<16} {:>4}x{:<4} pid {:<8} {}{} [own {} attach {} watch {}] {}",
                    t.id,
                    t.cols,
                    t.rows,
                    t.pid,
                    if t.alt { "alt " } else { "" },
                    t.argv.join(" "),
                    s.own,
                    s.attach,
                    s.watch,
                    t.title
                );
            }
        }
        Cmd::New { id, cols, rows, cwd, argv } => {
            let mut c = start::connect_or_start(&target, "g3d", None).unwrap_or_else(|e| die(e));
            let cwd = cwd.or_else(|| std::env::current_dir().ok().map(|d| d.display().to_string()));
            let r: CreateReply = c
                .request(Op::Create(Create {
                    id,
                    argv: if argv.is_empty() { None } else { Some(argv) },
                    cols,
                    rows,
                    cwd,
                    ..Default::default()
                }))
                .unwrap_or_else(|e| die(e));
            println!("{} handle {} pid {} {}x{}", r.id, r.handle, r.pid, r.cols, r.rows);
        }
        Cmd::Capture { id, history, vt } => {
            let mut c = connect(&target);
            let r: CaptureReply = c
                .request(Op::Capture(Capture {
                    id,
                    format: Some(if vt { CaptureFormat::Vt } else { CaptureFormat::Plain }),
                    history_rows: Some(history),
                    unwrap: None,
                }))
                .unwrap_or_else(|e| die(e));
            print!("{}", r.text);
            if !r.text.ends_with('\n') {
                println!();
            }
        }
        Cmd::Kill { id, signal } => {
            let mut c = connect(&target);
            let _: Empty = c.request(Op::Kill(Kill { id, signal })).unwrap_or_else(|e| die(e));
        }
        Cmd::Stop => {
            let mut c = connect(&target);
            let _: Empty = c.request(Op::Stop).unwrap_or_else(|e| die(e));
        }
        Cmd::Upgrade { binary } => upgrade(&target, binary),
        Cmd::Attach { id, take, detach_key } => {
            let role = if take { Role::Own } else { Role::Attach };
            attach(&target, &id, role, parse_key(&detach_key));
        }
        Cmd::Watch { id, detach_key } => attach(&target, &id, Role::Watch, parse_key(&detach_key)),
    }
}

/// `^X` → the control byte; a single character → itself.
fn parse_key(s: &str) -> u8 {
    let b = s.as_bytes();
    match b {
        [b'^', c] => c.to_ascii_uppercase() ^ 0x40,
        [c] => *c,
        _ => die(format!("--detach-key {s:?}: give ^X or one character")),
    }
}

/// What the tty held before attach, put back exactly once on the way out.
static SAVED: Mutex<Option<Termios>> = Mutex::new(None);
/// Leaves the viewer's terminal as a shell expects it: main screen, modes off, cleared.
const RESET: &[u8] = b"\x1b[?1049l\x1b[!p\x1b[?7h\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\
\x1b[?1004l\x1b[?2004l\x1b[=0;1u\x1b[0m\x1b[H\x1b[2J";

fn leave(msg: &str, code: i32) -> ! {
    let mut out = std::io::stdout().lock();
    if let Some(t) = SAVED.lock().unwrap().take() {
        let _ = out.write_all(RESET);
        let _ = out.flush();
        let _ = termios::tcsetattr(std::io::stdin(), OptionalActions::Flush, &t);
    }
    drop(out);
    eprintln!("{msg}");
    std::process::exit(code);
}

fn local_size() -> Option<(u16, u16)> {
    termios::tcgetwinsize(std::io::stdout()).ok().filter(|w| w.ws_col > 0 && w.ws_row > 0).map(|w| (w.ws_col, w.ws_row))
}

static NEXT_REQ: AtomicU64 = AtomicU64::new(1 << 32);

fn send_request(w: &Mutex<UnixStream>, op: Op) {
    let req = NEXT_REQ.fetch_add(1, Ordering::SeqCst);
    let _ = w.lock().unwrap().write_all(&frame::encode_json(ty::REQUEST, 0, &Request { req, op }));
}

fn attach(target: &Target, id: &str, role: Role, detach: u8) {
    let mut c = connect(target);
    let tty = termios::isatty(std::io::stdin()) && termios::isatty(std::io::stdout());
    let size = if role == Role::Own { local_size() } else { None };
    let sub: SubscribeReply = c
        .request(Op::Subscribe(Subscribe {
            id: id.to_owned(),
            mode: Mode::Raw,
            role,
            history_rows: None,
            flow: Some(Flow::Lossy),
            cols: size.map(|s| s.0),
            rows: size.map(|s| s.1),
        }))
        .unwrap_or_else(|e| die(e));
    if role != Role::Own
        && let Some((lc, lr)) = local_size()
        && (lc < sub.cols || lr < sub.rows)
    {
        eprintln!(
            "g3d: {id} is {}x{} and this window is {lc}x{lr}: lines will wrap wrong. \
                     Enlarge the window, or attach with --take to make the terminal this size.",
            sub.cols, sub.rows
        );
        std::thread::sleep(std::time::Duration::from_millis(1500));
    }
    if tty {
        let saved = termios::tcgetattr(std::io::stdin()).unwrap_or_else(|e| die(format!("tty: {e}")));
        let mut raw = saved.clone();
        raw.make_raw();
        termios::tcsetattr(std::io::stdin(), OptionalActions::Flush, &raw).unwrap_or_else(|e| die(format!("tty: {e}")));
        *SAVED.lock().unwrap() = Some(saved);
    }
    let writer = Mutex::new(c.try_clone_stream().unwrap_or_else(|e| die(e)));
    let writer: &'static Mutex<UnixStream> = Box::leak(Box::new(writer));
    let handle = sub.handle;
    let name = id.to_owned();

    // Output: frames → query filter → this tty.
    std::thread::spawn(move || {
        let mut filter = QueryFilter::new();
        // Locked per write: leave() on the input thread needs it too.
        let out = std::io::stdout();
        let mut buf = Vec::with_capacity(64 * 1024);
        loop {
            let f = match c.next_frame() {
                Ok(f) => f,
                Err(e) => {
                    leave(&format!("g3d: lost the daemon: {e}"), 1);
                }
            };
            if f.stream != handle && f.ty != ty::REPLY {
                continue;
            }
            buf.clear();
            match f.ty {
                ty::OUTPUT => {
                    if let Some((_, b)) = frame::parse_output(&f.payload) {
                        filter.filter(b, &mut buf);
                    }
                }
                ty::REPAINT => {
                    if let Some((_, vt)) = frame::parse_repaint(&f.payload) {
                        filter = QueryFilter::new();
                        filter.filter(vt, &mut buf);
                    }
                }
                ty::EVENT => match serde_json::from_slice::<Event>(&f.payload) {
                    Ok(Event::Closed) => {
                        leave(&format!("[{name} exited]"), 0);
                    }
                    Ok(Event::Role { role: Role::Attach }) if role == Role::Own => {
                        leave(&format!("[another client took {name}; attach again]"), 0);
                    }
                    _ => {}
                },
                _ => {}
            }
            let mut o = out.lock();
            if !buf.is_empty() && (o.write_all(&buf).is_err() || o.flush().is_err()) {
                std::process::exit(1);
            }
        }
    });

    // The owner follows this window's size.
    if role == Role::Own {
        std::thread::spawn(move || {
            let mut signals = signal_hook::iterator::Signals::new([signal_hook::consts::SIGWINCH]).expect("SIGWINCH");
            let mut last = local_size();
            for _ in signals.forever() {
                let now = local_size();
                if now != last {
                    if let Some((cols, rows)) = now {
                        send_request(writer, Op::Resize(Resize { handle, cols, rows }));
                    }
                    last = now;
                }
            }
        });
    }

    // Input: stdin → INPUT, minus the detach chord (the key twice).
    let mut stdin = std::io::stdin().lock();
    let mut buf = [0u8; 4096];
    let mut armed = false;
    loop {
        let n = match stdin.read(&mut buf) {
            Ok(0) | Err(_) => leave(&format!("[detached from {id}]"), 0),
            Ok(n) => n,
        };
        let mut send = Vec::with_capacity(n + 1);
        for &b in &buf[..n] {
            if armed {
                armed = false;
                if b == detach {
                    leave(&format!("[detached from {id}]"), 0);
                }
                send.push(detach);
            }
            if b == detach {
                armed = true;
            } else {
                send.push(b);
            }
        }
        if role == Role::Watch {
            if send.contains(&0x03) {
                leave(&format!("[stopped watching {id}]"), 0);
            }
            continue;
        }
        if !send.is_empty() {
            let _ = writer.lock().unwrap().write_all(&frame::encode(ty::INPUT, handle, &send));
        }
    }
}

/// Waits up to 15 s for a brain of `instance` newer than `generation` to answer.
fn wait_brain(target: &Target, instance: Option<&str>, generation: u64) -> Client {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        match start::connect(target, "g3d") {
            Ok(c) if c.welcome.generation.unwrap_or(0) > generation => {
                if instance.is_some() && c.welcome.instance.as_deref() != instance {
                    die("a different namespace answered: the old one ended during the upgrade");
                }
                return c;
            }
            Ok(_) => {}
            Err(e) if std::time::Instant::now() >= until => die(format!("no new brain answered: {e}")),
            Err(_) => {}
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// `g3d upgrade`: the brain hands every terminal to a new one at an exact cut (DESIGN.md,
/// "Screens after an upgrade"). A failed brain is retried instead: SIGHUP to the holder.
fn upgrade(target: &Target, binary: Option<PathBuf>) {
    let binary = binary.map(|b| std::fs::canonicalize(&b).unwrap_or_else(|e| die(format!("{}: {e}", b.display()))));
    let mut c = match start::connect(target, "g3d") {
        Ok(c) => c,
        Err(e) if e.code() == Some(code::BRAIN_FAILED) => {
            let lock = format!("{}.lock", target.socket().display());
            let pid: i32 = std::fs::read_to_string(&lock)
                .ok()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or_else(|| die(format!("the brain is failed and {lock} names no holder pid")));
            eprintln!("g3d: the brain is failed ({e}); retrying it now (SIGHUP to holder pid {pid})");
            let _ = rustix::process::kill_process(
                rustix::process::Pid::from_raw(pid).unwrap_or_else(|| die("bad pid")),
                rustix::process::Signal::HUP,
            );
            let c = wait_brain(target, None, 0);
            println!(
                "brain generation {} (pid {}) serves",
                c.welcome.generation.unwrap_or(0),
                c.welcome.pid.unwrap_or(0)
            );
            return;
        }
        Err(e) => die(format!("{}: {e}", target.socket().display())),
    };
    if !c.welcome.features.iter().any(|f| f == "upgrade") {
        die(format!(
            "{} cannot upgrade itself (no feature `upgrade`); stop it and start the new one",
            c.welcome.daemon
        ));
    }
    let instance = c.welcome.instance.clone();
    let r: UpgradeReply = c
        .request(Op::Upgrade(Upgrade { binary: binary.map(|b| b.display().to_string()), holder: None }))
        .unwrap_or_else(|e| die(e));
    loop {
        match c.next_frame() {
            Ok(f) if f.ty == ty::EVENT && f.stream == 0 => {
                if let Ok(Event::UpgradeFailed { message }) = serde_json::from_slice(&f.payload) {
                    die(format!("upgrade failed; the running brain carries on: {message}"));
                }
            }
            Ok(_) => {}
            Err(e) if e.code() == Some(code::RESTART) => break,
            Err(e) => die(format!("the daemon went away during the upgrade: {e}")),
        }
    }
    let c = wait_brain(target, instance.as_deref(), r.generation);
    println!(
        "upgraded: {} brain generation {} (pid {}); every terminal carried over",
        c.welcome.daemon,
        c.welcome.generation.unwrap_or(0),
        c.welcome.pid.unwrap_or(0)
    );
}

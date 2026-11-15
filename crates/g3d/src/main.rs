//! g3d: the reference termd client. Attach to a terminal from any real terminal, watch
//! one, list, create, kill, stop (docs/termd/DESIGN.md, "`g3d`: attach from any terminal").
//!
//!   g3d [--ns NS | --socket PATH] ls
//!   g3d new <id> [--cols N --rows N] [--cwd DIR] [--clean] [-e NAME[=VALUE]]... [-- cmd...]
//!   g3d env <id> [--json]
//!   g3d attach <id> [--take] [--detach-key ^\]
//!   g3d watch <id>
//!   g3d capture <id> [--history N] [--vt]
//!   g3d send <id> [text]          (stdin when no text)
//!   g3d key [--option-as-alt auto|true|false] <id> <chord>...   (shift+enter, ctrl+c, alt+left)
//!   g3d paste <id> [text] [--unsafe]   (stdin when no text)
//!   g3d kill <id> [--signal HUP|TERM|KILL]
//!   g3d upgrade [--binary PATH]
//!   g3d status [--json] [--follow [--interval MS]]
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
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Duration;

#[derive(Parser)]
#[command(name = "g3d", version, about = "Attach to, watch and manage g3d-termd terminals")]
struct Cli {
    /// The daemon's namespace (default: the daemon of the terminal this runs in, by
    /// $G3D_TERMD_SOCKET, else "default").
    #[arg(long, global = true)]
    ns: Option<String>,
    /// An explicit daemon socket instead of a namespace's.
    #[arg(long, global = true, conflicts_with = "ns")]
    socket: Option<PathBuf>,
    /// attach, watch and status --follow ride a restart of termd's engine (a crash, an upgrade)
    /// for up to this many seconds before giving up.
    #[arg(long, global = true, default_value_t = start::RECONNECT_WINDOW.as_secs(), env = "G3D_RECONNECT_WINDOW")]
    reconnect_window: u64,
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
        /// Where it starts (default: this directory, as `tmux new` does).
        #[arg(long)]
        cwd: Option<String>,
        /// Send none of this shell's environment: the terminal starts from the desktop session's,
        /// as one the wall opens does (default: this shell's environment is the base, as a
        /// multiplexer's new session's is).
        #[arg(long)]
        clean: bool,
        /// NAME=VALUE sets a variable; NAME alone passes this shell's NAME (or removes it when
        /// this shell has none). Repeatable; wins over everything but termd's own.
        #[arg(short = 'e', long = "env", value_name = "NAME[=VALUE]")]
        env: Vec<String>,
        /// The program and its arguments (default: the account's shell, as a login shell).
        #[arg(last = true)]
        argv: Vec<String>,
    },
    /// A terminal's environment as its program started with it, each variable with its source
    /// (caller, session, fill, file, request or termd).
    Env {
        id: String,
        /// The reply as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Attach this terminal: see the screen, type into it.
    Attach {
        id: String,
        /// Own the size: this window's size becomes the terminal's, for every viewer.
        /// Ends when another client takes the terminal (attach again to take it back).
        #[arg(long)]
        take: bool,
        /// The key pressed twice to detach, as ^X (some keyboard layouts need another).
        #[arg(long, default_value = "^\\", env = "G3D_DETACH_KEY")]
        detach_key: String,
    },
    /// Watch a terminal without typing into it.
    Watch {
        id: String,
        #[arg(long, default_value = "^\\", env = "G3D_DETACH_KEY")]
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
    /// Type bytes into a terminal exactly as given (stdin when no text), as tmux send-keys -l
    /// does: no encoding, no bracketing.
    Send { id: String, text: Option<String> },
    /// Press keys in a terminal, each a chord (shift+enter, ctrl+c, alt+left, F5, a): termd
    /// encodes them as the program asked to read keys (Kitty keyboard, modifyOtherKeys, cursor
    /// key modes), as a terminal's keyboard would.
    Key {
        /// Whether Alt is Alt when it made a character (macOS Option): auto (Alt unless it typed
        /// one), true, false (Ghostty's `macos-option-as-alt`, per key event; protocol 1.3).
        #[arg(long, default_value = "auto")]
        option_as_alt: OptionAsAlt,
        id: String,
        #[arg(required = true)]
        chords: Vec<String>,
    },
    /// A pointer event in a terminal: termd encodes it as the program asked to hear the mouse
    /// (X10, normal, button-event or any-event tracking; the default, UTF-8, SGR, urxvt or
    /// SGR-pixels format), as a terminal's mouse reporting would (protocol 1.4). Says so when the
    /// program didn't ask to hear it.
    Mouse {
        id: String,
        /// press, release or move.
        #[arg(value_parser = parse_mouse_action)]
        action: MouseAction,
        /// left, middle, right, none (a move with no button), wheel-up, wheel-down, wheel-left,
        /// wheel-right, or 8..11.
        button: MouseButton,
        /// Cells from the left edge, from 0 (3.5: the middle of the fourth column).
        col: f64,
        /// Cells from the top, from 0.
        row: f64,
        /// Modifiers held, W3C names: Shift, Control, Alt, Meta (comma-separated).
        #[arg(long, value_delimiter = ',')]
        mods: Vec<String>,
    },
    /// Paste text into a terminal (stdin when no text): bracketed when the program asked for
    /// bracketed paste, refused when it could run commands (Ghostty's paste protection).
    Paste {
        id: String,
        text: Option<String>,
        /// Paste even text that could run commands: a line break the program would read as Enter,
        /// or the bracketed-paste end.
        #[arg(long = "unsafe")]
        allow_unsafe: bool,
    },
    /// Kill a terminal's program.
    Kill {
        id: String,
        #[arg(long)]
        signal: Option<String>,
    },
    /// Kill every terminal and stop the daemon.
    Stop,
    /// The daemon, its terminals and recent errors: one document from the daemon, rendered.
    Status {
        /// The document as JSON (with --follow: one per line).
        #[arg(long)]
        json: bool,
        /// Keep rendering it as the daemon pushes changes; rides a restart of its engine.
        #[arg(long)]
        follow: bool,
        /// With --follow: the least time between two documents, in ms (the daemon clamps it).
        #[arg(long)]
        interval: Option<u64>,
    },
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
    let window = Duration::from_secs(cli.reconnect_window);
    // Inside a termd terminal, its own daemon, as tmux's client finds its server through $TMUX.
    let inside = std::env::var_os("G3D_TERMD_SOCKET").filter(|v| !v.is_empty()).map(PathBuf::from);
    let target = match (cli.socket, cli.ns, inside) {
        (Some(p), _, _) => Target::Socket(p),
        (None, Some(ns), _) => {
            g3d::paths::validate_name("namespace", &ns).unwrap_or_else(|m| die(m));
            Target::Ns(ns)
        }
        (None, None, Some(p)) => Target::Socket(p),
        (None, None, None) => Target::Ns(g3d::paths::DEFAULT_NS.to_owned()),
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
        Cmd::New { id, cols, rows, cwd, clean, env, argv } => {
            let env = g3d::env::request_env(&env, |k| std::env::var_os(k)).unwrap_or_else(|e| die(e));
            let env_base = if clean {
                None
            } else {
                let (base, skipped) = g3d::env::caller_env(std::env::vars_os());
                if !skipped.is_empty() {
                    eprintln!(
                        "g3d: not sent (the protocol carries [A-Za-z_][A-Za-z0-9_]* names and UTF-8 values): {}",
                        skipped.join(" ")
                    );
                }
                Some(base)
            };
            let mut c = start::connect_or_start(&target, "g3d", None).unwrap_or_else(|e| die(e));
            let cwd = cwd.or_else(|| std::env::current_dir().ok().map(|d| d.display().to_string()));
            let r: CreateReply = c
                .request(Op::Create(Create {
                    id,
                    argv: if argv.is_empty() { None } else { Some(argv) },
                    cols,
                    rows,
                    cwd,
                    env: if env.is_empty() { None } else { Some(env) },
                    env_base,
                    ..Default::default()
                }))
                .unwrap_or_else(|e| die(e));
            println!(
                "{} handle {} pid {} {}x{}: {}{} in {}",
                r.id,
                r.handle,
                r.pid,
                r.cols,
                r.rows,
                r.argv.join(" "),
                if r.login { " (login shell)" } else { "" },
                r.cwd
            );
        }
        Cmd::Env { id, json } => {
            let mut c = connect(&target);
            let raw = c.request_raw(Op::Env(EnvQuery { id: id.clone() })).unwrap_or_else(|e| die(e));
            if json {
                println!("{}", String::from_utf8_lossy(&raw));
                return;
            }
            let r: EnvReply = serde_json::from_slice(&raw).unwrap_or_else(|e| die(format!("env: {e}")));
            if r.env.is_empty() {
                println!("{id}: no record of its environment (started under an older termd)");
            }
            print!("{}", g3d::env::render(&r.env));
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
        Cmd::Send { id, text } => {
            let bytes = text.map_or_else(stdin_all, String::into_bytes);
            let (mut c, handle) = writer(&target, &id, None);
            for chunk in bytes.chunks(1 << 20) {
                c.input(handle, chunk).unwrap_or_else(|e| die(e));
            }
            done_writing(&mut c, handle);
        }
        Cmd::Key { option_as_alt, id, chords } => {
            let keys: Vec<Key> = chords.iter().map(|k| g3d::chord::parse(k).unwrap_or_else(|e| die(e))).collect();
            let (mut c, handle) = writer(&target, &id, Some("key"));
            if !option_as_alt.is_auto() && !c.welcome.features.iter().any(|f| f == "option_as_alt") {
                die(format!("{} has no `option_as_alt` (protocol 1.3); upgrade it (g3d upgrade)", c.welcome.daemon));
            }
            for mut k in keys {
                k.handle = handle;
                k.option_as_alt = option_as_alt;
                let _: WrittenReply = c.request(Op::Key(k)).unwrap_or_else(|e| die(e));
            }
            done_writing(&mut c, handle);
        }
        Cmd::Mouse { id, action, button, col, row, mods } => {
            let (mut c, handle) = writer(&target, &id, Some("mouse"));
            let r: WrittenReply =
                c.request(Op::Mouse(Mouse { handle, action, button, col, row, mods })).unwrap_or_else(|e| die(e));
            if r.written == 0 {
                eprintln!("g3d: {id}'s program didn't ask to hear that (nothing sent)");
            }
            done_writing(&mut c, handle);
        }
        Cmd::Paste { id, text, allow_unsafe } => {
            let text = text.unwrap_or_else(|| {
                String::from_utf8(stdin_all())
                    .unwrap_or_else(|_| die("paste takes text: stdin isn't UTF-8 (g3d send writes bytes)"))
            });
            let (mut c, handle) = writer(&target, &id, Some("paste"));
            let r = c.request::<WrittenReply>(Op::Paste(Paste {
                handle,
                text,
                allow_unsafe: allow_unsafe.then_some(true),
            }));
            match r {
                Ok(_) => {}
                Err(e) if e.code() == Some(code::UNSAFE_PASTE) => die(format!("{e} (g3d paste --unsafe)")),
                Err(e) => die(e),
            }
            done_writing(&mut c, handle);
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
        Cmd::Status { json, follow, interval } => status(&target, json, follow, interval, window),
        Cmd::Attach { id, take, detach_key } => {
            let role = if take { Role::Own } else { Role::Attach };
            attach(&target, &id, role, parse_key(&detach_key), window);
        }
        Cmd::Watch { id, detach_key } => attach(&target, &id, Role::Watch, parse_key(&detach_key), window),
    }
}

fn stdin_all() -> Vec<u8> {
    let mut b = Vec::new();
    std::io::stdin().read_to_end(&mut b).unwrap_or_else(|e| die(format!("stdin: {e}")));
    b
}

/// A connection that may type into terminal `id` (an input-only `attach` subscription), and its
/// handle. `feature` is the daemon feature the command needs beyond `INPUT`.
fn writer(target: &Target, id: &str, feature: Option<&str>) -> (Client, u32) {
    let mut c = connect(target);
    if let Some(f) = feature
        && !c.welcome.features.iter().any(|x| x == f)
    {
        let since = if f == "mouse" { "1.4" } else { "1.2" };
        die(format!("{} has no `{f}` op (protocol {since}); upgrade it (g3d upgrade)", c.welcome.daemon));
    }
    let sub: SubscribeReply = c
        .request(Op::Subscribe(Subscribe {
            id: id.to_owned(),
            mode: Mode::None,
            role: Role::Attach,
            history_rows: None,
            flow: None,
            cols: None,
            rows: None,
        }))
        .unwrap_or_else(|e| die(e));
    (c, sub.handle)
}

/// Ends a write: `unsubscribe` goes through the terminal's owner after everything sent before
/// it, so its reply means the input was taken, and any `error` event about it came first.
fn done_writing(c: &mut Client, handle: u32) {
    let _: Empty = c.request(Op::Unsubscribe(HandleOnly { handle })).unwrap_or_else(|e| die(e));
    for f in c.take_backlog() {
        if f.ty == ty::EVENT
            && f.stream == handle
            && let Ok(Event::Error { code, message }) = serde_json::from_slice(&f.payload)
        {
            die(format!("{code}: {message}"));
        }
    }
}

/// A `mouse` action as typed: press, release or move.
fn parse_mouse_action(s: &str) -> Result<MouseAction, String> {
    match s {
        "press" => Ok(MouseAction::Press),
        "release" => Ok(MouseAction::Release),
        "move" => Ok(MouseAction::Move),
        _ => Err(format!("press, release or move, not {s:?}")),
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

/// The subscription `attach` holds: the same request at the start and after every reconnect.
fn subscribe(c: &mut Client, id: &str, role: Role) -> Result<SubscribeReply, ClientError> {
    let size = if role == Role::Own { local_size() } else { None };
    c.request(Op::Subscribe(Subscribe {
        id: id.to_owned(),
        mode: Mode::Raw,
        role,
        history_rows: None,
        flow: Some(Flow::Lossy),
        cols: size.map(|s| s.0),
        rows: size.map(|s| s.1),
    }))
}

/// `g3d attach` / `g3d watch`. A restart of termd's engine (a crash, an upgrade) is ridden by the
/// rule every client follows (PROTOCOL.md "Restarts"): reconnect, the same instance, subscribe
/// again by id; the `REPAINT` brings the screen back. Keys typed while it reconnects are dropped
/// (input is at most once). It ends when the terminal does, the namespace goes, or no engine
/// answers within `window`.
fn attach(target: &Target, id: &str, role: Role, detach: u8, window: Duration) {
    let mut c = connect(target);
    let tty = termios::isatty(std::io::stdin()) && termios::isatty(std::io::stdout());
    let sub = subscribe(&mut c, id, role).unwrap_or_else(|e| die(e));
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
    // The connection's write side and the subscription's handle, both replaced on a reconnect.
    let writer = Mutex::new(c.try_clone_stream().unwrap_or_else(|e| die(e)));
    let writer: &'static Mutex<UnixStream> = Box::leak(Box::new(writer));
    let handle: &'static AtomicU32 = Box::leak(Box::new(AtomicU32::new(sub.handle)));
    let name = id.to_owned();
    let target = target.clone();

    // Output: frames → query filter → this tty.
    std::thread::spawn(move || {
        let mut filter = QueryFilter::new();
        let mut instance = c.welcome.instance.clone();
        // Locked per write: leave() on the input thread needs it too.
        let out = std::io::stdout();
        let mut buf = Vec::with_capacity(64 * 1024);
        loop {
            let f = match c.next_frame() {
                Ok(f) => f,
                Err(why) => {
                    let planned = why.code() == Some(code::RESTART);
                    c = start::reconnect(&target, "g3d", planned, instance.as_deref(), window)
                        .unwrap_or_else(|gone| leave(&format!("g3d: {why}; {gone}"), 1));
                    instance = c.welcome.instance.clone();
                    match subscribe(&mut c, &name, role) {
                        Ok(s) => {
                            *writer.lock().unwrap() =
                                c.try_clone_stream().unwrap_or_else(|e| leave(&format!("g3d: {e}"), 1));
                            handle.store(s.handle, Ordering::SeqCst);
                        }
                        Err(e) if e.code() == Some(code::NO_TERMINAL) => leave(&format!("[{name} exited]"), 0),
                        Err(e) => leave(&format!("g3d: subscribe {name} again after {why}: {e}"), 1),
                    }
                    // The REPAINT that follows starts the screen over.
                    filter = QueryFilter::new();
                    continue;
                }
            };
            if f.stream != handle.load(Ordering::SeqCst) && f.ty != ty::REPLY {
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
                        send_request(writer, Op::Resize(Resize { handle: handle.load(Ordering::SeqCst), cols, rows }));
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
            // While reconnecting this writes to the closed connection and the keys are dropped.
            let _ = writer.lock().unwrap().write_all(&frame::encode(ty::INPUT, handle.load(Ordering::SeqCst), &send));
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

/// `g3d status`: the daemon's status document, rendered (or as JSON). With `--follow`, each
/// document the daemon pushes replaces the last on a terminal (appended when piped); a restart of
/// termd's engine is ridden (PROTOCOL.md "Restarts"), and the namespace leaving ends it.
fn status(target: &Target, json: bool, follow: bool, interval: Option<u64>, window: Duration) {
    let tty = termios::isatty(std::io::stdout());
    let color = tty && std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty());
    let style = if color { g3d::render::Style::SGR } else { g3d::render::Style::PLAIN };
    let show = |doc: &Status| {
        let mut o = std::io::stdout().lock();
        let text = if json {
            let mut s = serde_json::to_string(doc).expect("status serializes");
            s.push('\n');
            s
        } else if follow && tty {
            // Home, draw, then clear what the last one left below (no flash between documents).
            format!("\x1b[H{}\x1b[J", g3d::render::status(doc, style).replace('\n', "\x1b[K\n"))
        } else if follow {
            format!("{}\n", g3d::render::status(doc, style))
        } else {
            g3d::render::status(doc, style)
        };
        if o.write_all(text.as_bytes()).and_then(|_| o.flush()).is_err() {
            std::process::exit(0);
        }
    };
    let mut c = connect(target);
    if !c.welcome.features.iter().any(|f| f == "status") {
        die(format!("{} has no status document (no feature `status`); g3d ls lists its terminals", c.welcome.daemon));
    }
    if !follow {
        let r: StatusReply = c.request(Op::Status).unwrap_or_else(|e| die(e));
        show(&r.status);
        return;
    }
    if tty && !json {
        print!("\x1b[H\x1b[2J");
    }
    let mut instance = c.welcome.instance.clone();
    loop {
        let _: StatusFollowReply =
            c.request(Op::StatusFollow(StatusFollow { interval_ms: interval })).unwrap_or_else(|e| die(e));
        let why = loop {
            match c.next_frame() {
                Ok(f) if f.ty == ty::EVENT && f.stream == 0 => {
                    if let Ok(Event::Status(doc)) = serde_json::from_slice::<Event>(&f.payload) {
                        show(&doc);
                        if doc.daemon.exiting {
                            if !json {
                                eprintln!("g3d: the namespace left (empty)");
                            }
                            return;
                        }
                    }
                }
                Ok(_) => {}
                Err(e) => break e,
            }
        };
        // The engine restarted (or the connection dropped): ride it, as every client does.
        let planned = why.code() == Some(code::RESTART);
        if !json {
            eprintln!("g3d: {why}; reconnecting");
        }
        c = start::reconnect(target, "g3d", planned, instance.as_deref(), window).unwrap_or_else(|gone| die(gone));
        instance = c.welcome.instance.clone();
    }
}

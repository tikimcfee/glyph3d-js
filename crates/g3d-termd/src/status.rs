//! The status document (PROTOCOL.md "`status_follow`", DESIGN.md "Status"): one document any
//! client renders as it is: the daemon, every terminal and its subscribers, recent errors.
//!
//! Owner threads publish what only they know into each terminal's [`TermStats`] (atomics, and a
//! small mutex for what changes rarely) as it changes, and sample the rest on their own idle tick;
//! the status tick reads those and never sends an owner thread a command. One tick builds one
//! document, serializes it once, and the same bytes go to every follower that is due: pushed on
//! change, no sooner than the follower's interval, a keepalive with fresh gauges when nothing
//! changes, and dropped (never queued) for a follower still behind on its previous one.

use crate::hold::Leftover;
use crate::out::{ConnOut, Kind, SubShared, Wake};
use crate::owner::Registry;
use g3d_hold::tree::{Proc, Tree, Trees};
use g3d_wire::frame::{self, ty};
use g3d_wire::*;
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub fn ms_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// What an owner thread publishes about its terminal for the status tick.
#[derive(Default)]
pub struct TermStats {
    /// Input bytes clients have sent it, in all.
    pub in_bytes: AtomicU64,
    /// When output last arrived (ms since the epoch; 0 = never under this brain).
    pub last_output_at: AtomicU64,
    /// Input waiting for the program to read it.
    pub input_queued: AtomicU64,
    /// The crash-restore blobs the holder keeps for it (the newest two).
    pub snapshot_bytes: AtomicU64,
    pub slow: Mutex<SlowStats>,
}

/// What changes rarely, or is sampled on the owner's idle tick.
#[derive(Default)]
pub struct SlowStats {
    pub pwd: String,
    /// `live`, `blocked`, `paused`.
    pub flow: &'static str,
    pub scrollback_rows: u64,
    pub memory: TermMemory,
    /// How it came back at this brain's start; `None` when it started under this brain.
    pub restored: Option<&'static str>,
    /// With `restored`: its output the previous brain read and never saved.
    pub unseen: u64,
    pub subs: Vec<SubStat>,
}

/// One subscription as its owner thread last published it; its queue and lag are read live.
pub struct SubStat {
    pub conn: u64,
    pub role: Role,
    pub mode: Mode,
    pub flow: Flow,
    pub view: u64,
    pub shared: Arc<SubShared>,
}

/// The recent errors: the last `keep` distinct `(code, terminal)` pairs, newest first, each with
/// its first and latest time and a count (the page-side log storm brake's coalescing, applied to
/// the daemon). They are for people; nothing depends on reading them.
pub struct Errors {
    keep: usize,
    ring: Mutex<VecDeque<StatusError>>,
}

impl Errors {
    pub fn new(keep: usize) -> Self {
        Errors { keep, ring: Mutex::new(VecDeque::new()) }
    }

    pub fn record(&self, code: &str, id: Option<&str>, message: impl Into<String>) {
        self.record_at(code, id, message, ms_now());
    }

    pub fn record_at(&self, code: &str, id: Option<&str>, message: impl Into<String>, at: u64) {
        if self.keep == 0 {
            return;
        }
        let mut r = self.ring.lock().unwrap();
        let message = message.into();
        let e = match r.iter().position(|e| e.code == code && e.id.as_deref() == id) {
            Some(i) => {
                let mut e = r.remove(i).expect("in range");
                e.count += 1;
                e.at = at;
                e.message = message;
                e
            }
            None => StatusError { code: code.into(), message, first_at: at, at, count: 1, id: id.map(Into::into) },
        };
        r.push_front(e);
        r.truncate(self.keep);
    }

    fn list(&self) -> Vec<StatusError> {
        self.ring.lock().unwrap().iter().cloned().collect()
    }
}

/// Resident memory of a process, in bytes: `/proc/<pid>/statm` on Linux, `proc_pidinfo` on macOS.
#[cfg(target_os = "linux")]
pub fn rss(pid: u32) -> Option<u64> {
    let s = std::fs::read_to_string(format!("/proc/{pid}/statm")).ok()?;
    let pages: u64 = s.split_whitespace().nth(1)?.parse().ok()?;
    // SAFETY: sysconf with a valid name.
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    (page > 0).then(|| pages * page as u64)
}

/// Resident memory of a process, in bytes: `/proc/<pid>/statm` on Linux, `proc_pidinfo` on macOS.
#[cfg(target_os = "macos")]
pub fn rss(pid: u32) -> Option<u64> {
    // SAFETY: proc_pidinfo fills a proc_taskinfo we own, of exactly the size we pass.
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
    let n = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTASKINFO, 0, (&raw mut info).cast(), size) };
    (n == size).then_some(info.pti_resident_size)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn rss(_pid: u32) -> Option<u64> {
    None
}

/// What the document says about this brain and its holder that doesn't change while it runs.
pub struct BrainInfo {
    pub ns: Option<String>,
    pub socket: String,
    pub log: String,
    pub instance: String,
    pub holder_started_at: u64,
    pub holder_pid: u32,
    pub holder_version: String,
    pub hold: [u64; 2],
    pub generation: u64,
    pub started_at: u64,
    pub restarts: BrainRestarts,
    pub last_start: BrainStart,
    pub snapshot_interval_ms: u64,
    /// How the namespace knows each terminal's processes.
    pub trees: Trees,
    /// Times the holder has re-exec'd.
    pub holder_upgrades: u64,
}

/// The status settings (`--status-*`).
#[derive(Clone, Copy)]
pub struct Settings {
    /// A follower that names no interval gets this.
    pub interval: Duration,
    /// The range a follower's interval is clamped to.
    pub min: Duration,
    pub max: Duration,
    /// With nothing changing, a follower still gets a document this often (fresh gauges).
    pub keepalive: Duration,
    /// Rates are bytes over this window.
    pub rate_window: Duration,
}

/// A connection's name and peer, for its subscribers' rows.
struct ConnMeta {
    client: String,
    pid: Option<u32>,
}

struct Follower {
    out: Arc<ConnOut>,
    /// Counts this follower's queued status frame: one still unwritten means it is behind.
    shared: Arc<SubShared>,
    interval: Duration,
    last_push: Option<Instant>,
    last_key: u64,
    /// Output or input flowed since its last push: the rates moved, so the next interval counts.
    active: bool,
}

/// Rate samples per terminal: `(when, seq, input bytes)`, the window's worth.
#[derive(Default)]
struct Rates {
    samples: HashMap<u32, VecDeque<(Instant, u64, u64)>>,
}

/// The status side of the brain: who follows, the rates, the errors, the static facts.
pub struct Hub {
    pub info: BrainInfo,
    pub settings: Settings,
    pub errors: Arc<Errors>,
    conns: Mutex<HashMap<u64, ConnMeta>>,
    followers: Mutex<HashMap<u64, Follower>>,
    joined: tokio::sync::Notify,
    rates: Mutex<Rates>,
    /// What ended terminals left running, as the holder reports it.
    leftovers: Mutex<Vec<Leftover>>,
    /// The latest closes, newest first, at most `closes_max`.
    closes: Mutex<VecDeque<StatusClose>>,
    closes_max: usize,
}

fn status_procs(p: &[Proc]) -> Vec<StatusProc> {
    p.iter().map(|p| StatusProc { pid: p.pid as u32, comm: p.comm.clone() }).collect()
}

impl Hub {
    pub fn new(
        info: BrainInfo,
        settings: Settings,
        errors: Arc<Errors>,
        leftovers: Vec<Leftover>,
        closes_max: usize,
    ) -> Arc<Self> {
        Arc::new(Hub {
            info,
            settings,
            errors,
            conns: Mutex::new(HashMap::new()),
            followers: Mutex::new(HashMap::new()),
            joined: tokio::sync::Notify::new(),
            rates: Mutex::new(Rates::default()),
            leftovers: Mutex::new(leftovers),
            closes: Mutex::new(VecDeque::new()),
            closes_max,
        })
    }

    /// The holder's `killed`: one close's report.
    pub fn closed(&self, m: &serde_json::Value) {
        let steps: Vec<StatusCloseStep> = m
            .get("steps")
            .and_then(|s| s.as_array())
            .map(|a| {
                a.iter()
                    .map(|s| StatusCloseStep {
                        signal: s.get("signal").and_then(|x| x.as_str()).unwrap_or("?").to_owned(),
                        procs: s
                            .get("procs")
                            .and_then(|p| p.as_array())
                            .map(|p| {
                                p.iter()
                                    .map(|p| StatusProc {
                                        pid: p.get("pid").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
                                        comm: p.get("comm").and_then(|x| x.as_str()).unwrap_or("").to_owned(),
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let id = m.get("id").and_then(|x| x.as_str()).unwrap_or("?").to_owned();
        if let Some(k) = steps.iter().find(|s| s.signal == "KILL" && !s.procs.is_empty()) {
            let who: Vec<String> = k.procs.iter().map(|p| format!("{} {}", p.pid, p.comm)).collect();
            self.errors.record(
                "killed",
                Some(&id),
                format!("{} outlived SIGHUP and SIGTERM when it closed and was SIGKILLed: {}", id, who.join(", ")),
            );
        }
        let close = StatusClose { id, at: m.get("at").and_then(|x| x.as_u64()).unwrap_or_else(ms_now), steps };
        let mut c = self.closes.lock().unwrap();
        c.push_front(close);
        c.truncate(self.closes_max);
    }

    pub fn leftover(&self, l: Leftover) {
        let mut v = self.leftovers.lock().unwrap();
        v.retain(|x| x.handle != l.handle);
        v.push(l);
    }

    pub fn leftover_gone(&self, handle: u32) {
        self.leftovers.lock().unwrap().retain(|x| x.handle != handle);
    }

    /// Every tree the namespace holds: the live terminals' (their pids) and the leftovers'.
    pub fn all_trees(&self, reg: &Registry) -> Vec<Tree> {
        let mut t: Vec<Tree> =
            reg.all().iter().map(|t| self.info.trees.tree_of(t.handle, t.info.lock().unwrap().pid as i32)).collect();
        t.extend(self.leftovers.lock().unwrap().iter().map(|l| l.tree.clone()));
        t
    }

    pub fn conn_open(&self, conn: u64, client: &str, pid: Option<u32>) {
        self.conns.lock().unwrap().insert(conn, ConnMeta { client: client.to_owned(), pid });
    }

    pub fn conn_closed(&self, conn: u64) {
        self.conns.lock().unwrap().remove(&conn);
        self.followers.lock().unwrap().remove(&conn);
    }

    /// The interval a follower asking for `ms` gets.
    pub fn clamp(&self, ms: Option<u64>) -> Duration {
        let s = &self.settings;
        ms.map_or(s.interval, Duration::from_millis).clamp(s.min, s.max)
    }

    /// Starts (or re-times) a follower. Its first document goes out on the next tick, at once.
    pub fn follow(&self, conn: u64, out: Arc<ConnOut>, interval: Duration) {
        let mut f = self.followers.lock().unwrap();
        match f.get_mut(&conn) {
            Some(x) => x.interval = interval,
            None => {
                let shared = Arc::new(SubShared::new(Arc::new(Wake::new().expect("wake fd"))));
                f.insert(conn, Follower { out, shared, interval, last_push: None, last_key: 0, active: false });
            }
        }
        drop(f);
        self.joined.notify_one();
    }

    pub fn unfollow(&self, conn: u64) -> bool {
        self.followers.lock().unwrap().remove(&conn).is_some()
    }

    /// Takes one rate sample of every terminal and forgets the ones gone. Returns whether any
    /// terminal produced output or took input since the last sample.
    fn sample(&self, reg: &Registry) -> bool {
        let mut moved = false;
        let now = Instant::now();
        let window = self.settings.rate_window;
        let mut r = self.rates.lock().unwrap();
        let live: Vec<_> = reg.all();
        r.samples.retain(|h, _| live.iter().any(|t| t.handle == *h));
        let now_ms = ms_now();
        for t in live {
            let (seq, created_at) = {
                let i = t.info.lock().unwrap();
                (i.seq, i.created_at)
            };
            let input = t.stats.in_bytes.load(SeqCst);
            let fresh = !r.samples.contains_key(&t.handle);
            let q = r.samples.entry(t.handle).or_default();
            // A terminal started under this brain had nothing at its start: that is its first
            // sample, so a burst before the next tick still counts in its rate.
            if fresh && t.stats.slow.lock().unwrap().restored.is_none() {
                let age = Duration::from_millis(now_ms.saturating_sub(created_at));
                if let Some(at) = now.checked_sub(age).filter(|_| age < window) {
                    q.push_back((at, 0, 0));
                }
            }
            q.push_back((now, seq, input));
            if let [.., a, b] = q.make_contiguous() {
                moved |= a.1 != b.1 || a.2 != b.2;
            }
            // Keep one sample at or past the window's start, so the rate spans the whole window.
            while q.len() > 2 && now.duration_since(q[1].0) >= window {
                q.pop_front();
            }
        }
        moved
    }

    /// Bytes per second over the window: `(out, in)`. Zero exactly when nothing moved in it.
    fn rate(&self, handle: u32) -> (u64, u64) {
        let r = self.rates.lock().unwrap();
        let Some(q) = r.samples.get(&handle) else { return (0, 0) };
        let (Some(first), Some(last)) = (q.front(), q.back()) else { return (0, 0) };
        let dt = last.0.duration_since(first.0).as_secs_f64();
        if dt <= 0.0 {
            return (0, 0);
        }
        let per = |d: u64| if d == 0 { 0 } else { ((d as f64 / dt).round() as u64).max(1) };
        (per(last.1.saturating_sub(first.1)), per(last.2.saturating_sub(first.2)))
    }

    /// The document now.
    pub fn build(&self, reg: &Registry, connections: u64, env: StatusEnv, exiting: bool) -> Status {
        let live = reg.all();
        let leftovers = self.leftovers.lock().unwrap().clone();
        let mut trees: Vec<Tree> =
            live.iter().map(|t| self.info.trees.tree_of(t.handle, t.info.lock().unwrap().pid as i32)).collect();
        trees.extend(leftovers.iter().map(|l| l.tree.clone()));
        let mut members = self.info.trees.members_many(&trees).into_iter();
        let conns = self.conns.lock().unwrap();
        let mut snapshot_bytes = 0;
        let terminals = live
            .into_iter()
            .map(|t| {
                let processes = Some(members.next().map_or(0, |m| m.len() as u64));
                let i = t.info.lock().unwrap().clone();
                let s = &t.stats;
                snapshot_bytes += s.snapshot_bytes.load(SeqCst);
                let slow = s.slow.lock().unwrap();
                let (out_bps, in_bps) = self.rate(t.handle);
                let last = s.last_output_at.load(SeqCst);
                StatusTerminal {
                    id: i.id,
                    handle: i.handle,
                    pid: i.pid,
                    argv: i.argv,
                    login: t.login,
                    cwd: i.cwd,
                    pwd: (!slow.pwd.is_empty()).then(|| slow.pwd.clone()),
                    title: i.title,
                    cols: i.cols,
                    rows: i.rows,
                    alt: i.alt,
                    created_at: i.created_at,
                    seq: i.seq,
                    out_bps,
                    in_bps,
                    last_output_at: (last != 0).then_some(last),
                    flow: if slow.flow.is_empty() { "live" } else { slow.flow }.to_owned(),
                    input_queued: s.input_queued.load(SeqCst),
                    scrollback_rows: slow.scrollback_rows,
                    memory: slow.memory,
                    restored: slow.restored.map(Into::into),
                    unseen: slow.restored.map(|_| slow.unseen),
                    processes,
                    subscribers: slow
                        .subs
                        .iter()
                        .map(|x| {
                            let m = conns.get(&x.conn);
                            StatusSubscriber {
                                conn: x.conn,
                                client: m.map_or_else(String::new, |m| m.client.clone()),
                                pid: m.and_then(|m| m.pid),
                                role: x.role,
                                mode: x.mode,
                                flow: x.flow,
                                queued: x.shared.queued.load(SeqCst) as u64,
                                lagging: x.shared.lagging.load(SeqCst),
                                lags: x.shared.lags.load(SeqCst),
                                view: x.view,
                            }
                        })
                        .collect(),
                }
            })
            .collect();
        drop(conns);
        let i = &self.info;
        Status {
            at: ms_now(),
            daemon: StatusDaemon {
                version: crate::VERSION.into(),
                engine: crate::server::ENGINE.into(),
                proto: PROTO,
                ns: i.ns.clone(),
                socket: i.socket.clone(),
                log: i.log.clone(),
                exiting,
                instance: i.instance.clone(),
                started_at: i.holder_started_at,
                connections,
                holder: StatusHolder {
                    pid: i.holder_pid,
                    version: i.holder_version.clone(),
                    hold: i.hold,
                    rss: rss(i.holder_pid),
                    upgrades: i.holder_upgrades,
                },
                brain: StatusBrain {
                    pid: std::process::id(),
                    generation: i.generation,
                    started_at: i.started_at,
                    rss: rss(std::process::id()),
                    restarts: i.restarts,
                    last_start: i.last_start.clone(),
                },
                snapshots: StatusSnapshots { interval_ms: i.snapshot_interval_ms, bytes: snapshot_bytes },
                env,
                trees: Some(match &i.trees {
                    Trees::Cgroup { unit, .. } => {
                        StatusTrees { mode: "cgroup".into(), unit: Some(unit.clone()), why: None }
                    }
                    Trees::Session { why } => {
                        StatusTrees { mode: "session".into(), unit: None, why: Some(why.clone()) }
                    }
                }),
                leftovers: leftovers
                    .iter()
                    .map(|l| StatusLeftover {
                        id: l.id.clone(),
                        pid: l.pid,
                        since: l.since,
                        processes: status_procs(&members.next().unwrap_or_default()),
                    })
                    .filter(|l| !l.processes.is_empty())
                    .collect(),
                closes: self.closes.lock().unwrap().iter().cloned().collect(),
            },
            terminals,
            errors: self.errors.list(),
        }
    }

    /// One status tick: sample the rates, and when anyone follows, build the document and push
    /// it to every follower that is due. Returns how long until the next tick.
    pub fn tick(&self, reg: &Registry, connections: u64, env: impl FnOnce() -> StatusEnv) -> Duration {
        // Output or input since the last tick: an interval in which a terminal produced output or
        // took input counts as a change (its rate moved). A rate still decaying over its window
        // after the bytes stopped doesn't; its crossing to zero is a change of the key.
        let active = self.sample(reg);
        let mut f = self.followers.lock().unwrap();
        if f.is_empty() {
            return self.settings.interval;
        }
        let doc = self.build(reg, connections, env(), false);
        let key = change_key(&doc);
        let now = Instant::now();
        let mut bytes: Option<Arc<[u8]>> = None;
        for x in f.values_mut() {
            x.active |= active;
            let since = x.last_push.map(|t| now.duration_since(t));
            let due = match since {
                None => true,
                Some(d) => (d >= x.interval && (x.key_changed(key) || x.active)) || d >= self.settings.keepalive,
            };
            if !due {
                continue;
            }
            if x.shared.queued.load(SeqCst) > 0 {
                continue; // behind on its last one: this one is dropped, the next replaces it
            }
            let body = bytes.get_or_insert_with(|| encode_event(&doc)).clone();
            let mut head = Vec::with_capacity(frame::HEADER_LEN);
            frame::put_header(&mut head, ty::EVENT, 0, body.len());
            x.out.sub_frame(&x.shared, Kind::Event, head, Some(body));
            x.last_push = Some(now);
            x.last_key = key;
            x.active = false;
        }
        f.values().map(|x| x.interval).min().unwrap_or(self.settings.interval)
    }

    /// The last document every follower gets before the namespace leaves: `exiting: true`, every
    /// terminal gone. Their connections close after it.
    pub fn farewell(&self, reg: &Registry, connections: u64, env: StatusEnv) {
        let f = self.followers.lock().unwrap();
        if f.is_empty() {
            return;
        }
        let body = encode_event(&self.build(reg, connections, env, true));
        for x in f.values() {
            let mut head = Vec::with_capacity(frame::HEADER_LEN);
            frame::put_header(&mut head, ty::EVENT, 0, body.len());
            x.out.frame([head, body.to_vec()].concat());
            x.out.close_after_drain();
        }
    }

    /// Waits until someone follows (the tick sleeps longer with no one to tell).
    pub async fn joined(&self) {
        self.joined.notified().await;
    }

    pub fn has_followers(&self) -> bool {
        !self.followers.lock().unwrap().is_empty()
    }
}

impl Follower {
    fn key_changed(&self, key: u64) -> bool {
        self.last_key != key
    }
}

fn encode_event(doc: &Status) -> Arc<[u8]> {
    // `{"ev":"status", …the document}`.
    let ev = Event::Status(Box::new(doc.clone()));
    Arc::from(serde_json::to_vec(&ev).expect("status serializes"))
}

/// What "changed" compares: every field but the sampled gauges (the time, RSS, memory, the
/// snapshot store's size) and the rates, which count only as whether they are zero.
pub fn change_key(doc: &Status) -> u64 {
    let mut d = doc.clone();
    d.at = 0;
    d.daemon.holder.rss = None;
    d.daemon.brain.rss = None;
    d.daemon.snapshots.bytes = 0;
    for l in &mut d.daemon.leftovers {
        l.processes.clear();
    }
    for t in &mut d.terminals {
        // A gauge: a shell's commands come and go.
        t.processes = None;
        t.memory = TermMemory::default();
        t.out_bps = u64::from(t.out_bps > 0);
        t.in_bps = u64::from(t.in_bps > 0);
        for s in &mut t.subscribers {
            // A queue's depth moves with every frame; whether it is lagging is the state.
            s.queued = 0;
        }
    }
    let mut h = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_vec(&d).expect("status serializes").hash(&mut h);
    h.finish()
}

//! The status document (PROTOCOL.md "`status`", "`status_follow`"; DESIGN.md "Status"): its shape
//! against a golden file of keys and types, its throttling (on change, no sooner than the interval,
//! a keepalive when quiet, every interval while output flows, a rate crossing zero), the last
//! document before an empty namespace leaves, and what a brain restart and an upgrade leave in it.
//! Each test runs its own daemon on a private socket.

mod common;
use common::*;
use g3d::Client;
use g3d_wire::frame::ty;
use g3d_wire::*;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

/// A JSON value's shape: objects keep their keys, arrays their first element's shape, scalars
/// become their type's name.
fn shape(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), shape(v))).collect()),
        Value::Array(a) => Value::Array(a.first().map(shape).into_iter().collect()),
        Value::String(_) => json!("string"),
        Value::Bool(_) => json!("bool"),
        Value::Number(n) if n.is_u64() || n.is_i64() => json!("int"),
        Value::Number(_) => json!("float"),
        Value::Null => json!("null"),
    }
}

/// The next status event on `c`, with the time it arrived (within 20 s: its own read timeout, not
/// the sliver a previous [`statuses_for`] left on the socket).
fn next_status(c: &mut Client) -> (Instant, Status) {
    c.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
    loop {
        let f = c.next_frame().unwrap();
        if f.ty == ty::EVENT
            && f.stream == 0
            && let Event::Status(doc) = serde_json::from_slice::<Event>(&f.payload).unwrap()
        {
            return (Instant::now(), *doc);
        }
    }
}

/// Status events on `c` for `secs` (the read timeout bounds the wait).
fn statuses_for(c: &mut Client, secs: f64) -> Vec<(Instant, Status)> {
    let until = Instant::now() + Duration::from_secs_f64(secs);
    let mut out = Vec::new();
    loop {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return out;
        }
        c.set_read_timeout(Some(left)).unwrap();
        match c.next_frame() {
            Ok(f) if f.ty == ty::EVENT && f.stream == 0 => {
                if let Ok(Event::Status(doc)) = serde_json::from_slice::<Event>(&f.payload) {
                    out.push((Instant::now(), *doc));
                }
            }
            Ok(_) => {}
            Err(_) => return out,
        }
    }
}

fn follow(c: &mut Client, interval_ms: Option<u64>) -> u64 {
    let r: StatusFollowReply = c.request(Op::StatusFollow(StatusFollow { interval_ms })).unwrap();
    r.interval_ms
}

fn wait_for(secs: u64, what: &str, mut f: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(secs);
    while !f() {
        assert!(Instant::now() < until, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn the_status_document_has_its_documented_shape() {
    let d = Daemon::start();
    let mut c = Client::connect(&d.socket, "status-test/1").unwrap();
    c.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
    assert!(c.welcome.features.iter().any(|f| f == "status"), "{:?}", c.welcome.features);
    assert_eq!(c.welcome.proto, [1, 4]);
    create(&mut c, "t1", &["sh", "-c", "echo ready; exec sleep 100"], 100, 30);
    create(&mut c, "t2", &["sh", "-c", "echo also; exec sleep 100"], 80, 24);
    let s = subscribe(&mut c, "t1", Role::Own, None);
    // A spawn failure is a recent error, with its terminal's id.
    let bad = c.request::<CreateReply>(Op::Create(Create {
        id: "nope".into(),
        argv: Some(vec!["/no/such/program".into()]),
        cols: 80,
        rows: 24,
        ..Default::default()
    }));
    assert_eq!(bad.unwrap_err().code(), Some(code::SPAWN_FAILED));
    std::thread::sleep(Duration::from_millis(300));

    let raw = c.request_raw(Op::Status).unwrap();
    let v: Value = serde_json::from_slice(&raw).unwrap();
    let doc: StatusReply = serde_json::from_slice(&raw).unwrap();
    let doc = doc.status;
    let golden: Value = serde_json::from_str(include_str!("fixtures/status-shape.json")).unwrap();
    assert_eq!(
        shape(&v["status"]),
        golden,
        "the document's keys and types moved; PROTOCOL.md and the golden file say what they are"
    );

    let dm = &doc.daemon;
    assert_eq!((dm.proto, dm.exiting, dm.connections), ([1, 4], false, 1));
    assert_eq!(dm.holder.pid, d.pid());
    assert_eq!(dm.brain.pid, c.welcome.pid.unwrap());
    assert_eq!(dm.brain.generation, 1);
    assert_eq!(dm.brain.last_start.reason, "first");
    assert_eq!(dm.brain.restarts, BrainRestarts::default());
    assert!(dm.holder.rss.unwrap() > 0 && dm.brain.rss.unwrap() > 0);
    assert_eq!(dm.socket, d.socket.display().to_string());
    assert_eq!(dm.env.source, "daemon");
    assert!(dm.started_at <= doc.at && dm.brain.started_at <= doc.at);
    let ids: Vec<_> = doc.terminals.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, ["t1", "t2"]);
    let t1 = &doc.terminals[0];
    assert_eq!((t1.cols, t1.rows, t1.handle, t1.flow.as_str()), (100, 30, s.handle, "live"));
    assert_eq!(t1.restored, None, "started under this brain");
    assert!(t1.last_output_at.is_some() && t1.seq > 0);
    assert_eq!(t1.subscribers.len(), 1);
    let sub = &t1.subscribers[0];
    assert_eq!(
        (sub.client.as_str(), sub.role, sub.mode, sub.flow),
        ("status-test/1", Role::Own, Mode::Raw, Flow::Block)
    );
    assert_eq!(sub.pid, Some(std::process::id()), "the subscriber's pid, from its credentials");
    assert!(doc.terminals[1].subscribers.is_empty());
    let e = &doc.errors[0];
    assert_eq!((e.code.as_str(), e.id.as_deref(), e.count), ("spawn_failed", Some("nope"), 1));
}

#[test]
fn status_follow_pushes_on_change_no_sooner_than_its_interval_and_keeps_alive() {
    let d =
        Daemon::start_with(&["--idle-exit", "0", "--status-keepalive-ms", "1500", "--status-rate-window-ms", "1000"]);
    let mut c = d.client();
    create(&mut c, "quiet", &["sh", "-c", "exec sleep 100"], 80, 24);
    let mut f = d.client();
    let asked = Instant::now();
    assert_eq!(follow(&mut f, Some(10)), 250, "an interval below the floor is clamped");
    let (at, first) = next_status(&mut f);
    assert!(at - asked < Duration::from_millis(400), "the first document goes out at once ({:?})", at - asked);
    assert_eq!(first.terminals.len(), 1);

    // Quiet: nothing until the keepalive.
    let quiet = statuses_for(&mut f, 1.2);
    assert!(quiet.is_empty(), "a quiet daemon sends nothing between keepalives: {}", quiet.len());
    let (ka, _) = next_status(&mut f);
    let gap = ka - at;
    assert!(gap >= Duration::from_millis(1500) && gap < Duration::from_millis(2300), "keepalive after {gap:?}");

    // A change (a terminal starting) is pushed within an interval.
    let made = Instant::now();
    create(
        &mut c,
        "flood",
        &["sh", "-c", "sleep 0.3; i=0; while [ $i -lt 2500 ]; do seq 1 200; i=$((i+1)); done; exec sleep 100"],
        80,
        24,
    );
    let (seen, doc) = next_status(&mut f);
    assert!(seen - made < Duration::from_millis(600), "a change arrives within the interval ({:?})", seen - made);
    assert_eq!(doc.terminals.len(), 2);

    // While output flows, every interval is pushed (its rate stays current), never sooner.
    let during = statuses_for(&mut f, 2.0);
    assert!(during.len() >= 5, "only {} documents in 2 s of output", during.len());
    let mut prev = seen;
    for (t, _) in &during {
        assert!(*t - prev >= Duration::from_millis(240), "two documents {:?} apart, under the interval", *t - prev);
        prev = *t;
    }
    assert!(during.iter().any(|(_, d)| d.terminals.iter().any(|t| t.id == "flood" && t.out_bps > 0)));

    // The output ends; its rate crosses zero (a push), and then it's quiet again.
    let mut s = d.client();
    wait_for(60, "the flood to end", || {
        let r: ListReply = s.request(Op::List).unwrap();
        let t = r.terminals.iter().find(|t| t.id == "flood").unwrap();
        t.seq > 2500 * 200 * 4
    });
    let mut zero = None;
    for _ in 0..200 {
        let (t, doc) = next_status(&mut f);
        if doc.terminals.iter().any(|t| t.id == "flood" && t.out_bps == 0) {
            zero = Some(t);
            break;
        }
    }
    let zero = zero.expect("a document where the rate crossed zero");
    let after = statuses_for(&mut f, 1.2);
    assert!(after.is_empty(), "{} documents after the rate reached zero, before the keepalive", after.len());
    let _ = zero;
}

/// One burst of output counts as a change for the interval it lands in, not for the whole rate
/// window after it (PROTOCOL.md: "while any terminal produces output or takes input").
#[test]
fn a_burst_of_output_is_one_change_not_a_window_of_them() {
    let d =
        Daemon::start_with(&["--idle-exit", "0", "--status-keepalive-ms", "60000", "--status-rate-window-ms", "5000"]);
    let mut c = d.client();
    let mut f = d.client();
    assert_eq!(follow(&mut f, Some(250)), 250);
    let _ = next_status(&mut f);
    assert!(statuses_for(&mut f, 1.0).is_empty(), "an empty, quiet daemon pushed");
    create(&mut c, "hi", &["sh", "-c", "echo hi; exec sleep 100"], 80, 24);
    // The terminal appearing, and its one burst: a few documents, then quiet while the 5 s rate
    // decays (the old rule pushed every 250 ms until it reached zero: about 20).
    let docs = statuses_for(&mut f, 4.0);
    assert!(!docs.is_empty() && docs.len() <= 4, "{} documents for one burst of output", docs.len());
}

#[test]
fn status_followers_dont_keep_an_empty_daemon_and_hear_it_leave() {
    let d = Daemon::start_with(&["--idle-exit", "1"]);
    let mut f = d.client();
    follow(&mut f, None);
    let (_, first) = next_status(&mut f);
    assert!(!first.daemon.exiting);
    // Only a status follower is connected: the namespace leaves, and tells it.
    let until = Instant::now() + Duration::from_secs(10);
    let last = loop {
        assert!(Instant::now() < until, "the daemon stayed for a status follower\n{}", d.log());
        let (_, doc) = next_status(&mut f);
        if doc.daemon.exiting {
            break doc;
        }
    };
    assert!(last.terminals.is_empty());
    // The name goes with the last document: a connect finds nothing (never a socket that accepts,
    // hangs and resets), and a new daemon can take the name at once.
    let left = Instant::now();
    loop {
        match std::os::unix::net::UnixStream::connect(&d.socket) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            r => assert!(
                left.elapsed() < Duration::from_millis(300),
                "the socket outlived the last document: {r:?}\n{}",
                d.log()
            ),
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut next = std::process::Command::new(bin())
        .arg("--socket")
        .arg(&d.socket)
        .args(["--idle-exit", "0", "--env-source", "daemon"])
        .stderr(std::fs::File::create(d.dir.join("next.log")).unwrap())
        .spawn()
        .unwrap();
    let up = (|| {
        let until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < until {
            if let Some(st) = next.try_wait().unwrap() {
                return Err(format!("{st}: {}", std::fs::read_to_string(d.dir.join("next.log")).unwrap_or_default()));
            }
            if let Ok(c) = Client::connect(&d.socket, "test") {
                return Ok(c.welcome.instance);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Err("no answer".into())
    })();
    unsafe { libc::kill(next.id() as i32, libc::SIGTERM) };
    let _ = next.wait();
    let instance = up.expect("a new daemon could not take the name right after the namespace left");
    assert_ne!(instance.as_deref(), Some(first.daemon.instance.as_str()), "the old namespace answered");
    assert!(f.next_frame().is_err(), "the connection closes after the last document");
}

#[test]
fn stop_sends_followers_a_last_document_with_no_terminals() {
    let d = Daemon::start();
    let mut c = d.client();
    create(&mut c, "t", &["sh", "-c", "exec sleep 100"], 80, 24);
    let mut f = d.client();
    follow(&mut f, None);
    let (_, first) = next_status(&mut f);
    assert_eq!(first.terminals.len(), 1);
    let _: Empty = c.request(Op::Stop).unwrap();
    let last = loop {
        let (_, doc) = next_status(&mut f);
        if doc.daemon.exiting {
            break doc;
        }
    };
    assert!(last.terminals.is_empty(), "every terminal ended before the last document");
}

#[test]
fn a_brain_crash_and_an_upgrade_are_in_the_next_brains_status() {
    let d = Daemon::start();
    let mut c = d.client();
    let instance = c.welcome.instance.clone().unwrap();
    create(&mut c, "t", &["sh", "-c", "echo before; exec sleep 100"], 80, 24);
    std::thread::sleep(Duration::from_millis(2500)); // a snapshot is taken
    let brain = c.welcome.pid.unwrap();
    unsafe { libc::kill(brain as i32, libc::SIGKILL) };
    let mut c = d.reconnect(&instance);
    let doc = c.request::<StatusReply>(Op::Status).unwrap().status;
    let b = &doc.daemon.brain;
    assert_eq!((b.generation, b.restarts.crash, b.last_start.reason.as_str()), (2, 1, "crash"));
    assert_eq!(b.last_start.exit.as_ref().and_then(|e| e.signal.as_deref()), Some("KILL"));
    assert_eq!(b.last_start.restored.exact + b.last_start.restored.snapshot + b.last_start.restored.blank, 1);
    assert!(doc.terminals[0].restored.is_some(), "a restored terminal says how it came back");
    assert!(doc.daemon.snapshots.bytes > 0, "the store holds the terminal's snapshot");
    let e = doc.errors.iter().find(|e| e.code == "brain_crash").expect("the crash is a recent error");
    assert!(e.message.contains("SIGKILL"), "{}", e.message);

    let r: UpgradeReply = c.request(Op::Upgrade(Upgrade::default())).unwrap();
    assert_eq!(r.generation, 2);
    assert_eq!(c.next_frame().unwrap_err().code(), Some(code::RESTART));
    let mut c = d.reconnect(&instance);
    let doc = c.request::<StatusReply>(Op::Status).unwrap().status;
    let b = &doc.daemon.brain;
    assert_eq!((b.generation, b.restarts.crash, b.restarts.upgrade), (3, 1, 1));
    assert_eq!((b.last_start.reason.as_str(), b.last_start.exit.is_none()), ("upgrade", true));
    assert_eq!((b.last_start.restored.exact, b.last_start.unseen), (1, 0));
    assert_eq!(doc.terminals[0].restored.as_deref(), Some("exact"));
}

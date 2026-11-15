//! The holder record: everything a holder hands the holder it re-execs into (`g3d upgrade
//! --holder`, DESIGN.md "Upgrading the holder"), written to a sealed memfd whose fd, with every fd
//! it names, survives the `execve`.
//!
//! The format is frozen, as the blob's is: every record a release wrote stays decodable, and
//! `tests/fixtures/holder-record-*.bin` holds one per format version (append-only). All integers
//! are little-endian:
//!
//! ```text
//! offset size
//! 0      8    magic "G3DHREC1"
//! 8      2    major: a reader refuses a major it doesn't know
//! 10     2    minor: a newer minor only adds JSON fields, which an older reader skips
//! 12     4    CRC-32 (IEEE) of the body
//! 16     8    the body's length
//! 24     ...  the body: one JSON object (Record)
//! ```
//!
//! Fds are named by number: the numbers they have in the holder that writes the record, which
//! `execve` keeps (their close-on-exec flag is cleared just before it).

use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAGIC: &[u8; 8] = b"G3DHREC1";
const HEAD: usize = 24;
/// The record format this build writes, and the major it reads.
pub const FORMAT: [u16; 2] = [1, 0];

/// What a holder is, for the next one.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Record {
    /// The writer's version (`g3d-termd/x.y.z`) and hold protocol.
    pub version: String,
    pub hold: [u64; 2],
    /// The namespace's identity and age: fixed across re-execs.
    pub instance: String,
    pub started_at: u64,
    /// Brains started so far, and replaced by cause.
    pub generation: u64,
    pub restarts: Restarts,
    /// Times the holder has re-exec'd (this one included, once it has).
    pub upgrades: u64,
    pub next_handle: u32,
    /// The `seq_marks` page's size, in terminals: the page is the writer's, so the reader keeps it.
    pub max_terminals: usize,
    /// The soft `RLIMIT_NOFILE` the first holder started with, which programs get back.
    pub nofile: u64,
    /// The listening socket, the namespace's lock, the `seq_marks` page.
    pub listener: i32,
    pub lock: i32,
    pub marks: i32,
    /// How the namespace knows each terminal's processes (tree.rs's `Trees`).
    pub trees: Value,
    pub brain_leaves: u64,
    /// Every terminal has been handed over (`handoff` blobs newest in its store): the record a
    /// holder execs on. A trial record, written before the cut, has none.
    pub handoff: bool,
    pub terms: Vec<Term>,
    pub closing: Vec<Closing>,
    pub leftovers: Vec<Leftover>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Restarts {
    pub crash: u64,
    pub watchdog: u64,
    pub upgrade: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Term {
    pub handle: u32,
    pub slot: u32,
    pub id: String,
    pub pid: i32,
    /// The holder's copy of the PTY master; absent once `kill` closed it.
    pub master: Option<i32>,
    pub meta: Value,
    pub exit: Option<Value>,
    pub tree: Value,
    pub killed: bool,
    /// The stored blobs, newest first.
    pub snaps: Vec<i32>,
    pub released: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Closing {
    pub handle: u32,
    pub id: String,
    pub tree: Value,
    /// Since the close rule's first signal.
    pub elapsed_ms: u64,
    pub stage: u8,
    pub steps: Vec<Step>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Step {
    pub signal: String,
    pub procs: Vec<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Leftover {
    pub handle: u32,
    pub id: String,
    pub pid: i32,
    pub tree: Value,
    pub since: u64,
}

impl Record {
    /// Every fd the record names, each once.
    pub fn fds(&self) -> Vec<i32> {
        let mut v = vec![self.listener, self.lock, self.marks];
        for t in &self.terms {
            v.extend(t.master);
            v.extend(&t.snaps);
        }
        v
    }
}

/// The record's bytes.
pub fn encode(r: &Record) -> Vec<u8> {
    let body = serde_json::to_vec(r).expect("a record serializes");
    let mut out = Vec::with_capacity(HEAD + body.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&FORMAT[0].to_le_bytes());
    out.extend_from_slice(&FORMAT[1].to_le_bytes());
    out.extend_from_slice(&crc32(&body).to_le_bytes());
    out.extend_from_slice(&(body.len() as u64).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

/// Reads a record, as a holder of this build would resume from it. `major` is the format major
/// the reader takes (this build's, but for a test that plays a newer reader).
pub fn decode_as(bytes: &[u8], major: u16) -> Result<Record, String> {
    if bytes.len() < HEAD || &bytes[..8] != MAGIC {
        return Err("not a holder record (no G3DHREC1 magic)".into());
    }
    let u16_at = |o: usize| u16::from_le_bytes([bytes[o], bytes[o + 1]]);
    let (maj, min) = (u16_at(8), u16_at(10));
    if maj != major {
        return Err(format!("holder record format {maj}.{min}; this build reads {major}.x"));
    }
    let crc = u32::from_le_bytes(bytes[12..16].try_into().expect("4 bytes"));
    let len = u64::from_le_bytes(bytes[16..24].try_into().expect("8 bytes")) as usize;
    let body = bytes.get(HEAD..HEAD + len).ok_or("a truncated holder record")?;
    if crc32(body) != crc {
        return Err("the holder record's CRC doesn't match: torn or corrupt".into());
    }
    serde_json::from_slice(body).map_err(|e| format!("the holder record's body: {e}"))
}

pub fn decode(bytes: &[u8]) -> Result<Record, String> {
    decode_as(bytes, FORMAT[0])
}

/// CRC-32 (IEEE), as the blob's: the holder links no crc crate (its dependencies stay few).
fn crc32(b: &[u8]) -> u32 {
    let mut c = !0u32;
    for &x in b {
        c ^= u32::from(x);
        for _ in 0..8 {
            c = if c & 1 != 0 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
        }
    }
    !c
}

/// Checks that every fd a record names is open in this process and is what the record says: the
/// listener a listening socket, the lock a file, the page as big as its terminals, each master a
/// PTY's, each blob a non-empty memory object. What a candidate runs before anything is
/// irreversible (`g3d-termd --check-holder-record`).
pub fn check_fds(r: &Record) -> Result<(), String> {
    use rustix::fd::BorrowedFd;
    let fds = r.fds();
    let mut seen = std::collections::BTreeSet::new();
    for &fd in &fds {
        if fd < 3 || !seen.insert(fd) {
            return Err(format!("the record names fd {fd} twice, or a standard stream"));
        }
    }
    // SAFETY: borrowing an fd number the record names, for fcntl/fstat only; a closed one fails.
    let b = |fd: i32| unsafe { BorrowedFd::borrow_raw(fd) };
    for &fd in &fds {
        rustix::io::fcntl_getfd(b(fd)).map_err(|e| format!("fd {fd} the record names: {e}"))?;
    }
    // Linux says whether a socket listens; macOS declares SO_ACCEPTCONN without answering it, so
    // there a stream socket is what can be checked.
    #[cfg(not(target_vendor = "apple"))]
    let listening = rustix::net::sockopt::socket_acceptconn(b(r.listener));
    #[cfg(target_vendor = "apple")]
    let listening = rustix::net::sockopt::socket_type(b(r.listener)).map(|t| t == rustix::net::SocketType::STREAM);
    if !listening.map_err(|e| format!("the listener (fd {}): {e}", r.listener))? {
        return Err(format!("fd {} is not a listening socket", r.listener));
    }
    let st = rustix::fs::fstat(b(r.lock)).map_err(|e| format!("the lock (fd {}): {e}", r.lock))?;
    if rustix::fs::FileType::from_raw_mode(st.st_mode) != rustix::fs::FileType::RegularFile {
        return Err(format!("the lock (fd {}) is not a file", r.lock));
    }
    let marks = rustix::fs::fstat(b(r.marks)).map_err(|e| format!("seq_marks (fd {}): {e}", r.marks))?.st_size as usize;
    if marks < r.max_terminals * crate::MARK_BYTES {
        return Err(format!("seq_marks holds {marks} B, under {} terminals' worth", r.max_terminals));
    }
    for t in &r.terms {
        if let Some(m) = t.master {
            rustix::pty::ptsname(b(m), Vec::new())
                .map_err(|e| format!("terminal {}'s master (fd {m}): not a PTY: {e}", t.id))?;
        }
        for &s in &t.snaps {
            let n = rustix::fs::fstat(b(s)).map_err(|e| format!("terminal {}'s blob (fd {s}): {e}", t.id))?.st_size;
            if n <= 0 {
                return Err(format!("terminal {}'s blob (fd {s}) is empty", t.id));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn sample() -> Record {
        Record {
            version: "g3d-termd/0.1.0".into(),
            hold: [2, 2],
            instance: "8c1f0e7a9b2d4c55".into(),
            started_at: 1_794_518_713_751,
            generation: 3,
            restarts: Restarts { crash: 1, watchdog: 0, upgrade: 1 },
            upgrades: 0,
            next_handle: 3,
            max_terminals: 8192,
            nofile: 1024,
            listener: 5,
            lock: 6,
            marks: 7,
            trees: serde_json::json!({"mode": "session", "why": "this system has no cgroups"}),
            brain_leaves: 3,
            handoff: true,
            terms: vec![Term {
                handle: 1,
                slot: 0,
                id: "t1".into(),
                pid: 41234,
                master: Some(9),
                meta: serde_json::json!({"argv": ["/bin/bash"]}),
                exit: None,
                tree: serde_json::json!({"session": 41234}),
                killed: false,
                snaps: vec![10, 11],
                released: false,
            }],
            closing: vec![Closing {
                handle: 2,
                id: "t2".into(),
                tree: serde_json::json!({"session": 41300}),
                elapsed_ms: 500,
                stage: 1,
                steps: vec![Step {
                    signal: "HUP".into(),
                    procs: vec![serde_json::json!({"pid": 41300, "comm": "sh"})],
                }],
            }],
            leftovers: vec![Leftover {
                handle: 3,
                id: "t3".into(),
                pid: 41400,
                tree: serde_json::json!({"session": 41400}),
                since: 1_794_519_000_000,
            }],
        }
    }

    #[test]
    fn a_record_round_trips_and_damage_is_refused() {
        let r = sample();
        let b = encode(&r);
        assert_eq!(decode(&b).unwrap(), r);
        let mut torn = b.clone();
        let last = torn.len() - 2;
        torn[last] ^= 1;
        assert!(decode(&torn).unwrap_err().contains("CRC"));
        assert!(decode(&b[..b.len() - 1]).unwrap_err().contains("truncated"));
        assert!(decode_as(&b, 2).unwrap_err().contains("format 1.0; this build reads 2.x"));
        assert!(decode(b"G3DBLOB1 something else entirely").unwrap_err().contains("magic"));
    }

    /// Every record format a release wrote stays decodable (append-only fixtures).
    #[test]
    fn every_fixture_decodes() {
        let v1 = include_bytes!("../tests/fixtures/holder-record-v1.bin");
        assert_eq!(decode(v1).unwrap(), sample());
    }

    /// Writes the fixture of this format (once, when a format version is born:
    /// `cargo test -p g3d-hold -- --ignored write_fixture`).
    #[test]
    #[ignore]
    fn write_fixture() {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/holder-record-v1.bin");
        std::fs::create_dir_all(std::path::Path::new(p).parent().unwrap()).unwrap();
        assert!(!std::path::Path::new(p).exists(), "fixtures are append-only: {p} exists");
        std::fs::write(p, encode(&sample())).unwrap();
    }
}

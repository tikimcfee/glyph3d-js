//! `g3d-termd --check-holder-record <fd>`: what a holder upgrade's new binary runs before anything
//! is irreversible (DESIGN.md, "Upgrading the holder"). It reads the running holder's record as
//! the new holder would resume from it: the format (record.rs), every fd it names, and, for the
//! record written after the handoff, every terminal's handoff blob as the new brain would restore
//! it (exact at the terminal's mark). It answers on stdout with one JSON line, `{"ok": true,
//! "version", "engine", "hold", "record"}`, or `{"ok": false, "error"}` and exit status 1.

use crate::blob;
use g3d_hold::record;
use rustix::fd::{FromRawFd, OwnedFd};
use serde_json::json;

pub fn run(fd: i32, engine: &str) -> ! {
    match check(fd, engine) {
        Ok(()) => {
            println!(
                "{}",
                json!({"ok": true, "version": crate::VERSION, "engine": engine, "hold": g3d_hold::HOLD, "record": record::FORMAT})
            );
            std::process::exit(0);
        }
        Err(e) => {
            println!("{}", json!({"ok": false, "error": e}));
            std::process::exit(1);
        }
    }
}

fn check(fd: i32, engine: &str) -> Result<(), String> {
    // SAFETY: the fd the holder passed on the command line; nothing else owns it here.
    let rfd = unsafe { OwnedFd::from_raw_fd(fd) };
    let bytes = g3d_hold::shm::read(&rfd).map_err(|e| format!("the record (fd {fd}): {e}"))?;
    let major = record::FORMAT[0];
    // Test hook: a candidate that reads only the next format major (the incompatible-record gate).
    #[cfg(feature = "test-hooks")]
    let major = match std::env::var("G3D_TERMD_TEST_RECORD_MAJOR_FILE") {
        Ok(p) if crate::test_hooks_armed() && std::path::Path::new(&p).exists() => major + 1,
        _ => major,
    };
    let rec = record::decode_as(&bytes, major)?;
    record::check_fds(&rec)?;
    if g3d_hold::tree::Trees::from_json(&rec.trees).is_none() {
        return Err("the record's process trees".into());
    }
    if !rec.handoff {
        return Ok(());
    }
    // The handoff: each live terminal's newest blob brings it back exact, at its mark.
    // SAFETY: borrowing the marks fd the record names for a read-only mapping.
    let marks = unsafe { rustix::fd::BorrowedFd::borrow_raw(rec.marks) };
    let marks = rustix::io::dup(marks).map_err(|e| format!("seq_marks: {e}"))?;
    let page = g3d_hold::shm::read(&marks).map_err(|e| format!("seq_marks: {e}"))?;
    for t in rec.terms.iter().filter(|t| t.master.is_some() && t.exit.is_none()) {
        let at = t.slot as usize * g3d_hold::MARK_BYTES;
        let mark = page
            .get(at..at + 8)
            .map(|b| u64::from_le_bytes(b.try_into().expect("8 bytes")))
            .ok_or_else(|| format!("terminal {}'s slot {} is past seq_marks", t.id, t.slot))?;
        let newest = t.snaps.first().ok_or_else(|| format!("terminal {} was not handed over", t.id))?;
        // SAFETY: as above, a dup of an fd the record names.
        let b = rustix::io::dup(unsafe { rustix::fd::BorrowedFd::borrow_raw(*newest) })
            .map_err(|e| format!("terminal {}'s blob: {e}", t.id))?;
        let blob = blob::read(&b).map_err(|e| format!("terminal {}'s handoff: {e}", t.id))?;
        if !blob.handoff || blob.id != t.id || blob.seq != mark {
            return Err(format!(
                "terminal {}'s newest blob is not its handoff at its mark (handoff {}, id {:?}, seq {} vs {mark})",
                t.id, blob.handoff, blob.id, blob.seq
            ));
        }
        if blob.kind == blob::KIND_SNAPSHOT && blob.engine != engine {
            return Err(format!("terminal {}'s snapshot is {}; this build restores {engine}", t.id, blob.engine));
        }
    }
    Ok(())
}

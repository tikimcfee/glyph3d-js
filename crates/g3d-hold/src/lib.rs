//! g3d-hold: the holder half of g3d-termd (docs/termd/DESIGN.md, "Holder and brain").
//!
//! The holder is the shells' parent. It keeps, for a namespace's whole life: the lock, the
//! listening socket, every terminal's PTY master fd, pid and exit status, the snapshot store,
//! and the `seq_marks` page. It runs and supervises the brain (`g3d-termd --brain`), which does
//! everything else and can crash, be killed or be upgraded while every shell keeps running.
//!
//! One thread around a `poll` loop; no libghostty, no tokio; it never reads a PTY and parses no
//! client input. Its panics abort (the binary sets `panic = "abort"` for the holder's code path
//! by aborting in the panic hook): unwinding can't help a process whose death ends every shell.

pub mod holder;
pub mod link;
pub mod log;
pub mod record;
pub mod shm;
pub mod spawn;
pub mod tree;

pub use holder::{Config, resume, run};

/// A pipe, both ends close-on-exec, both nonblocking when asked. Linux sets the flags with the
/// pipe (`pipe2`); macOS has no `pipe2`, so they are set right after, which is exact in the
/// holder (one thread: no fork can come between) and leaves a brain's thread a window that
/// `spawn` doesn't reach (the holder starts every program).
pub fn pipe(nonblock: bool) -> std::io::Result<(rustix::fd::OwnedFd, rustix::fd::OwnedFd)> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use rustix::pipe::{PipeFlags, pipe_with};
        let flags = if nonblock { PipeFlags::CLOEXEC | PipeFlags::NONBLOCK } else { PipeFlags::CLOEXEC };
        Ok(pipe_with(flags)?)
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        let (rd, wr) = rustix::pipe::pipe()?;
        for fd in [&rd, &wr] {
            rustix::io::fcntl_setfd(fd, rustix::io::FdFlags::CLOEXEC)?;
            if nonblock {
                rustix::fs::fcntl_setfl(fd, rustix::fs::OFlags::NONBLOCK)?;
            }
        }
        Ok((rd, wr))
    }
}

/// The hold protocol's `[major, minor]` (holder ↔ brain). A brain speaks exactly one major; a
/// minor only adds messages and fields. 2: `spawn` names the program's `path` apart from its
/// `argv` (a login shell execs `/bin/bash` as `-bash`), and the holder no longer searches `PATH`.
/// 2.1: `welcome` carries `restarts` (brains replaced, by cause) and `last_start` (why this brain
/// starts, and how the last one ended), for the status document. 2.2: process trees (tree.rs):
/// `welcome` carries `trees` (cgroup or session) and `leftovers`; the holder tells the brain
/// `killed` (a close's report), `leftover` and `leftover_gone`; and the holder's re-exec (`upgrade`
/// with `holder`, `candidate` with `holder`; `welcome` carries `upgrades` and `upgrade_failed`).
pub const HOLD: [u64; 2] = [2, 2];

/// Bytes per terminal in the `seq_marks` page: one little-endian `u64`, the terminal's `seq`
/// after the brain's latest read.
pub const MARK_BYTES: usize = 8;

/// Unit tests that fork and ones that seal a memfd take turns: a child forked on another test's
/// thread holds a copy of a writable mapping until it execs, and sealing then fails `EBUSY`. The
/// holder is one thread, so it never meets this.
#[cfg(test)]
pub(crate) static FORKS: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
pub mod shm;
pub mod spawn;

pub use holder::{Config, run};

/// The hold protocol's `[major, minor]` (holder ↔ brain). A brain speaks exactly one major; a
/// minor only adds messages and fields. 2: `spawn` names the program's `path` apart from its
/// `argv` (a login shell execs `/bin/bash` as `-bash`), and the holder no longer searches `PATH`.
/// 2.1: `welcome` carries `restarts` (brains replaced, by cause) and `last_start` (why this brain
/// starts, and how the last one ended), for the status document.
pub const HOLD: [u64; 2] = [2, 1];

/// Bytes per terminal in the `seq_marks` page: one little-endian `u64`, the terminal's `seq`
/// after the brain's latest read.
pub const MARK_BYTES: usize = 8;

//! The Rust side of a termd client: where a namespace's socket lives, a blocking client
//! that speaks docs/termd/PROTOCOL.md, and starting the daemon when none is running.
//! `g3d` (the binary) is built on it; so are the daemon's own tests.

pub mod client;
pub mod paths;
pub mod start;

pub use client::{Client, ClientError};

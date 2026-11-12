//! A terminal saved for the next brain: a crash snapshot every `snapshot_interval`, or an
//! upgrade's handoff at the cut (DESIGN.md, "Screens after a crash", "Screens after an upgrade").
//! Each blob is one sealed shared-memory object the holder stores (newest two per terminal).
//!
//! The format is frozen (append-only fixtures in `tests/fixtures/blob-*.bin`); all integers are
//! little-endian:
//!
//! ```text
//! offset size
//! 0      8    magic "G3DBLOB1"
//! 8      1    kind: 1 = libghostty snapshot, 2 = VT repaint (any engine replays it)
//! 9      1    flags: bit 0 = an upgrade's handoff (exact at `seq`, carries pending input)
//! 10     2    0
//! 12     4    CRC-32 (IEEE) of everything after the header
//! 16     8    seq: the terminal's position the blob is at
//! 24     8    raw_len: the payload's length before LZ4
//! 32     4    comp_len: the LZ4 block's length
//! 36     4    input_len: input the program had not read yet (handoff only)
//! 40     2    engine_len
//! 42     2    id_len
//! 44     ...  engine, id, the LZ4 block, the input
//! ```

use rustix::fd::OwnedFd;
use std::io;
use std::os::unix::fs::FileExt;

const MAGIC: &[u8; 8] = b"G3DBLOB1";
const HEAD: usize = 44;
pub const KIND_SNAPSHOT: u8 = 1;
pub const KIND_VT: u8 = 2;
pub const FLAG_HANDOFF: u8 = 1;
/// The most payload a blob holds before compression (a 64 MiB history snapshots to well under
/// this; DESIGN.md "Snapshot cost").
const MAX_RAW: usize = 256 << 20;

#[derive(Debug)]
pub struct Blob {
    pub kind: u8,
    pub handoff: bool,
    pub seq: u64,
    pub engine: String,
    pub id: String,
    pub payload: Vec<u8>,
    pub input: Vec<u8>,
}

/// Encodes a blob into a new sealed shared-memory object.
pub fn write(
    kind: u8,
    handoff: bool,
    seq: u64,
    engine: &str,
    id: &str,
    raw: &[u8],
    input: &[u8],
) -> io::Result<OwnedFd> {
    let comp = lz4_flex::block::compress(raw);
    let mut body = Vec::with_capacity(engine.len() + id.len() + comp.len() + input.len());
    body.extend_from_slice(engine.as_bytes());
    body.extend_from_slice(id.as_bytes());
    body.extend_from_slice(&comp);
    body.extend_from_slice(input);
    let mut head = Vec::with_capacity(HEAD);
    head.extend_from_slice(MAGIC);
    head.push(kind);
    head.push(if handoff { FLAG_HANDOFF } else { 0 });
    head.extend_from_slice(&0u16.to_le_bytes());
    head.extend_from_slice(&crc32fast::hash(&body).to_le_bytes());
    head.extend_from_slice(&seq.to_le_bytes());
    head.extend_from_slice(&(raw.len() as u64).to_le_bytes());
    head.extend_from_slice(&(comp.len() as u32).to_le_bytes());
    head.extend_from_slice(&(input.len() as u32).to_le_bytes());
    head.extend_from_slice(&(engine.len() as u16).to_le_bytes());
    head.extend_from_slice(&(id.len() as u16).to_le_bytes());
    let fd = g3d_hold::shm::create(&format!("g3d-termd blob {id}"), HEAD + body.len())?;
    let f = std::fs::File::from(fd);
    f.write_all_at(&head, 0)?;
    f.write_all_at(&body, HEAD as u64)?;
    let fd = OwnedFd::from(f);
    g3d_hold::shm::seal(&fd)?;
    Ok(fd)
}

fn bad(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.into())
}

/// Reads and checks a blob (positional reads: the fd's offset is shared with the holder's copy).
pub fn read(fd: &OwnedFd) -> io::Result<Blob> {
    let size = g3d_hold::shm::size(fd)?;
    if size < HEAD {
        return Err(bad(format!("{size} B is shorter than the header")));
    }
    let f = std::fs::File::from(fd.try_clone()?);
    let mut all = vec![0u8; size];
    f.read_exact_at(&mut all, 0)?;
    parse(&all)
}

/// Parses a blob's bytes (the fixtures test this directly).
pub fn parse(all: &[u8]) -> io::Result<Blob> {
    if all.len() < HEAD || &all[..8] != MAGIC {
        return Err(bad("not a g3d-termd blob"));
    }
    let u16_at = |o: usize| u16::from_le_bytes(all[o..o + 2].try_into().unwrap()) as usize;
    let u32_at = |o: usize| u32::from_le_bytes(all[o..o + 4].try_into().unwrap());
    let u64_at = |o: usize| u64::from_le_bytes(all[o..o + 8].try_into().unwrap());
    let (kind, flags, crc, seq) = (all[8], all[9], u32_at(12), u64_at(16));
    let raw_len = u64_at(24) as usize;
    let (comp_len, input_len) = (u32_at(32) as usize, u32_at(36) as usize);
    let (engine_len, id_len) = (u16_at(40), u16_at(42));
    let body = &all[HEAD..];
    if body.len() != engine_len + id_len + comp_len + input_len {
        return Err(bad("lengths don't add up"));
    }
    if crc32fast::hash(body) != crc {
        return Err(bad("CRC mismatch"));
    }
    if raw_len > MAX_RAW {
        return Err(bad(format!("payload of {raw_len} B is over the {MAX_RAW} B cap")));
    }
    if kind != KIND_SNAPSHOT && kind != KIND_VT {
        return Err(bad(format!("kind {kind}")));
    }
    let engine = String::from_utf8_lossy(&body[..engine_len]).into_owned();
    let id = String::from_utf8_lossy(&body[engine_len..engine_len + id_len]).into_owned();
    let c0 = engine_len + id_len;
    let payload =
        lz4_flex::block::decompress(&body[c0..c0 + comp_len], raw_len).map_err(|e| bad(format!("LZ4: {e}")))?;
    Ok(Blob {
        kind,
        handoff: flags & FLAG_HANDOFF != 0,
        seq,
        engine,
        id,
        payload,
        input: body[c0 + comp_len..].to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_shared_memory() {
        let raw: Vec<u8> = (0..20_000u32)
            .flat_map(|i| format!("   Compiling crate-{} v0.1.0 (/src/crate-{})\r\n", i % 40, i % 40).into_bytes())
            .collect();
        let fd = write(KIND_SNAPSHOT, true, 1234, "engine/1", "t1", &raw, b"typed").unwrap();
        let b = read(&fd).unwrap();
        assert_eq!((b.kind, b.handoff, b.seq), (KIND_SNAPSHOT, true, 1234));
        assert_eq!((b.engine.as_str(), b.id.as_str()), ("engine/1", "t1"));
        assert_eq!(b.payload, raw);
        assert_eq!(b.input, b"typed");
        assert!(g3d_hold::shm::size(&fd).unwrap() < raw.len() / 2, "LZ4 shrinks text");
    }

    #[test]
    fn a_corrupt_blob_is_refused() {
        let fd = write(KIND_VT, false, 7, "e", "t", b"hello hello hello", b"").unwrap();
        let size = g3d_hold::shm::size(&fd).unwrap();
        let mut all = vec![0u8; size];
        std::fs::File::from(fd).read_exact_at(&mut all, 0).unwrap();
        assert!(parse(&all).is_ok());
        let mut flip = all.clone();
        *flip.last_mut().unwrap() ^= 1;
        assert!(parse(&flip).unwrap_err().to_string().contains("CRC"));
        assert!(parse(&all[..20]).is_err());
    }

    /// Writes this release's fixture (run once per format change, with `--ignored`; never
    /// overwrite an existing one: the set is append-only).
    #[test]
    #[ignore]
    fn write_fixture() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/blob-v1-vt.bin");
        assert!(!path.exists(), "{} exists; fixtures are append-only", path.display());
        let fd = write(
            KIND_VT,
            true,
            42,
            "libghostty-vt/1.0.1 snapshot/1",
            "fixture",
            b"\x1b[!p\x1b[H\x1b[2Jhello fixture",
            b"ls\r",
        )
        .unwrap();
        let size = g3d_hold::shm::size(&fd).unwrap();
        let mut all = vec![0u8; size];
        std::fs::File::from(fd).read_exact_at(&mut all, 0).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, all).unwrap();
    }

    /// The frozen format: every fixture a release wrote still decodes.
    #[test]
    fn fixtures_decode() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        let mut n = 0;
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with("blob-") && name.ends_with(".bin") {
                let b = parse(&std::fs::read(e.path()).unwrap()).unwrap_or_else(|e| panic!("{name}: {e}"));
                assert_eq!(b.id, "fixture", "{name}");
                n += 1;
            }
        }
        assert!(n > 0, "no blob fixtures in {}", dir.display());
    }
}

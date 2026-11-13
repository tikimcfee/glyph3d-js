//! Anonymous shared memory for snapshots, handoff blobs and the `seq_marks` page: RAM-backed,
//! never a file on disk, passed by fd (DESIGN.md, "Linux and macOS").
//!
//! - Linux: `memfd_create(MFD_CLOEXEC | MFD_ALLOW_SEALING)`; a finished blob is sealed against
//!   writes, growth and shrinking.
//! - macOS: `shm_open` of a random name, `shm_unlink` at once, sized once with `ftruncate` (macOS
//!   sizes a shm object only once), then `FD_CLOEXEC`. No seals; nothing else holds the fd.
//!
//! A blob's bytes go in and come out through a mapping ([`create_from`], [`read`]), never
//! `pwrite`/`pread`: macOS refuses both on a shm object (`ESPIPE`).

use rustix::fd::OwnedFd;
use std::io;

/// A new shared-memory object of `size` bytes, zeroed. `name` is for debugging (`/proc/<pid>/fd`).
#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn create(name: &str, size: usize) -> io::Result<OwnedFd> {
    use rustix::fs::{MemfdFlags, ftruncate, memfd_create};
    let fd = memfd_create(name, MemfdFlags::CLOEXEC | MemfdFlags::ALLOW_SEALING)?;
    ftruncate(&fd, size as u64)?;
    Ok(fd)
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
pub fn create(name: &str, size: usize) -> io::Result<OwnedFd> {
    use std::os::fd::FromRawFd;
    let _ = name;
    for attempt in 0..16u32 {
        // SAFETY: arc4random takes no arguments and cannot fail.
        let r = unsafe { libc::arc4random() };
        let path = std::ffi::CString::new(format!("/g3d-{}-{r:08x}{attempt:x}", std::process::id())).expect("no NUL");
        // SAFETY: plain libc calls on a NUL-terminated name; the fd is owned from here.
        let fd = unsafe { libc::shm_open(path.as_ptr(), libc::O_RDWR | libc::O_CREAT | libc::O_EXCL, 0o600) };
        if fd < 0 {
            let e = io::Error::last_os_error();
            if e.raw_os_error() == Some(libc::EEXIST) {
                continue;
            }
            return Err(e);
        }
        unsafe { libc::shm_unlink(path.as_ptr()) };
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        rustix::io::fcntl_setfd(&fd, rustix::io::FdFlags::CLOEXEC)?;
        rustix::fs::ftruncate(&fd, size as u64)?;
        return Ok(fd);
    }
    Err(io::Error::other("shm_open: no free name"))
}

/// Seals a finished blob so no process can change it (Linux; nothing to do on macOS).
pub fn seal(fd: &OwnedFd) -> io::Result<()> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use rustix::fs::{SealFlags, fcntl_add_seals};
        fcntl_add_seals(fd, SealFlags::WRITE | SealFlags::GROW | SealFlags::SHRINK | SealFlags::SEAL)?;
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    let _ = fd;
    Ok(())
}

/// A shared mapping of the whole object. The caller unmaps it with [`unmap`] (or never, for a
/// mapping that lives as long as the process).
pub fn map(fd: &OwnedFd, size: usize, writable: bool) -> io::Result<*mut u8> {
    use std::os::fd::AsRawFd;
    let prot = if writable { libc::PROT_READ | libc::PROT_WRITE } else { libc::PROT_READ };
    // SAFETY: a fresh shared mapping of an fd we hold; the kernel validates the arguments.
    let p = unsafe { libc::mmap(std::ptr::null_mut(), size.max(1), prot, libc::MAP_SHARED, fd.as_raw_fd(), 0) };
    if p == libc::MAP_FAILED {
        return Err(io::Error::last_os_error());
    }
    Ok(p.cast())
}

/// Undoes [`map`].
///
/// # Safety
/// `p` and `size` must come from one [`map`] call, and nothing may use the mapping afterwards.
pub unsafe fn unmap(p: *mut u8, size: usize) {
    unsafe { libc::munmap(p.cast(), size.max(1)) };
}

/// A new sealed object holding exactly `bytes`.
pub fn create_from(name: &str, bytes: &[u8]) -> io::Result<OwnedFd> {
    let fd = create(name, bytes.len())?;
    if !bytes.is_empty() {
        let p = map(&fd, bytes.len(), true)?;
        // SAFETY: `p` maps `bytes.len()` writable bytes of an object no one else holds yet.
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
            unmap(p, bytes.len());
        }
    }
    seal(&fd)?;
    Ok(fd)
}

/// A copy of the object's bytes.
pub fn read(fd: &OwnedFd) -> io::Result<Vec<u8>> {
    let n = size(fd)?;
    if n == 0 {
        return Ok(Vec::new());
    }
    let p = map(fd, n, false)?;
    // SAFETY: `p` maps `n` readable bytes; copied out, then unmapped.
    let v = unsafe { std::slice::from_raw_parts(p, n).to_vec() };
    unsafe { unmap(p, n) };
    Ok(v)
}

/// The object's size: what was asked on Linux, rounded up to a page on macOS.
pub fn size(fd: &OwnedFd) -> io::Result<usize> {
    Ok(rustix::fs::fstat(fd)?.st_size as usize)
}

#[cfg(test)]
mod tests {
    /// What goes in comes out first, then zeros up to the object's size: exact on Linux, a
    /// page multiple on macOS.
    #[test]
    fn an_object_reads_back_what_was_written() {
        for len in [1usize, 100, 4096, 70_001] {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 7) as u8).collect();
            let fd = super::create_from("test", &bytes).unwrap();
            let got = super::read(&fd).unwrap();
            assert_eq!(got.len(), super::size(&fd).unwrap());
            #[cfg(any(target_os = "linux", target_os = "android"))]
            assert_eq!(got.len(), len);
            assert_eq!(&got[..len], &bytes[..]);
            assert!(got[len..].iter().all(|&b| b == 0));
        }
    }
}

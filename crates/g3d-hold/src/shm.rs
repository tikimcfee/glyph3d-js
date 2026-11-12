//! Anonymous shared memory for snapshots, handoff blobs and the `seq_marks` page: RAM-backed,
//! never a file on disk, passed by fd (DESIGN.md, "Linux and macOS").
//!
//! - Linux: `memfd_create(MFD_CLOEXEC | MFD_ALLOW_SEALING)`; a finished blob is sealed against
//!   writes, growth and shrinking.
//! - macOS: `shm_open` of a random name, `shm_unlink` at once, sized once with `ftruncate` (macOS
//!   sizes a shm object only once), then `FD_CLOEXEC`. No seals; nothing else holds the fd.

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

/// The object's size.
pub fn size(fd: &OwnedFd) -> io::Result<usize> {
    Ok(rustix::fs::fstat(fd)?.st_size as usize)
}

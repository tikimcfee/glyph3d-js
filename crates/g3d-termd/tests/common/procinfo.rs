//! What the kernel says about another process of ours: the environment and argv it was exec'd
//! with, and its working directory. Linux reads `/proc/<pid>/{environ,cmdline,cwd}`; macOS has no
//! `/proc` and reads `sysctl(KERN_PROCARGS2)` (exec path, argv and environment, as exec'd) and
//! `proc_pidinfo(PROC_PIDVNODEPATHINFO)`. Shared by g3d-termd's and g3d's tests (`#[path]`).
//!
//! Signal masks and resource limits of another process can't be read on macOS (`ps -o sigmask`
//! is always 0); the tests that need them ask the program itself (tests/env.rs, `probe`).

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::PathBuf;

/// The environment `pid` was exec'd with.
pub fn environ(pid: u32) -> BTreeMap<String, String> {
    argv_and_env(pid, true)
        .1
        .iter()
        .filter_map(|kv| kv.split_once('=').map(|(k, v)| (k.to_owned(), v.to_owned())))
        .collect()
}

/// The argv `pid` was exec'd with (`argv[0]` as given, such as a login shell's `-zsh`). Readable
/// for any program, platform binaries included.
pub fn argv(pid: u32) -> Vec<String> {
    argv_and_env(pid, false).0
}

#[cfg(target_os = "linux")]
fn argv_and_env(pid: u32, _: bool) -> (Vec<String>, Vec<String>) {
    let split = |raw: Vec<u8>| -> Vec<String> {
        raw.split(|&b| b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect()
    };
    let argv = split(std::fs::read(format!("/proc/{pid}/cmdline")).unwrap());
    let env = split(std::fs::read(format!("/proc/{pid}/environ")).unwrap());
    (argv, env)
}

/// `KERN_PROCARGS2`: `int argc`, the exec path, NUL padding, `argc` argv strings, the
/// environment's strings, then the kernel's "apple" strings for dyld (`ptr_munge=`, `main_stack=`,
/// `executable_file=`, …). Nothing separates the last two: NUL padding sits between them only
/// sometimes. So the environment ends at an empty string or at the first name that is all lowercase
/// (the apple strings' form; no test here sets a lowercase variable).
#[cfg(target_os = "macos")]
fn argv_and_env(pid: u32, want_env: bool) -> (Vec<String>, Vec<String>) {
    let mut max: libc::c_int = 0;
    let mut len = std::mem::size_of::<libc::c_int>();
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    // SAFETY: sysctl reading an int into one we own.
    let r = unsafe { libc::sysctl(mib.as_mut_ptr(), 2, (&raw mut max).cast(), &mut len, std::ptr::null_mut(), 0) };
    assert_eq!(r, 0, "sysctl KERN_ARGMAX: {}", std::io::Error::last_os_error());
    let mut buf = vec![0u8; max as usize];
    let mut len = buf.len();
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
    // SAFETY: sysctl writing at most `len` bytes into `buf`.
    let r = unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) };
    assert_eq!(r, 0, "sysctl KERN_PROCARGS2 of {pid}: {}", std::io::Error::last_os_error());
    buf.truncate(len);
    let argc = i32::from_ne_bytes(buf[..4].try_into().unwrap()) as usize;
    let rest = &buf[4..];
    // Skip the exec path and its padding.
    let path_end = rest.iter().position(|&b| b == 0).unwrap();
    let mut at = path_end + rest[path_end..].iter().position(|&b| b != 0).unwrap_or(rest.len() - path_end);
    let mut next = || -> Option<String> {
        if at >= rest.len() {
            return None;
        }
        let end = at + rest[at..].iter().position(|&b| b == 0).unwrap_or(rest.len() - at);
        let s = String::from_utf8_lossy(&rest[at..end]).into_owned();
        at = end + 1;
        Some(s)
    };
    let argv: Vec<String> = (0..argc).map_while(|_| next()).collect();
    let apple = |s: &str| {
        let name = s.split('=').next().unwrap_or("");
        s.contains('=') && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    };
    let env: Vec<String> = std::iter::from_fn(|| next().filter(|s| !s.is_empty() && !apple(s))).collect();
    // macOS withholds the environment of Apple's platform binaries (`/bin/sleep`, `/bin/zsh`)
    // from every other process: none at all is that, never a real empty environment here.
    assert!(!want_env || !env.is_empty(), "macOS withholds the environment of {argv:?} (a platform binary?)");
    (argv, env)
}

/// The directory `pid` runs in.
#[cfg(target_os = "linux")]
pub fn cwd(pid: u32) -> PathBuf {
    std::fs::read_link(format!("/proc/{pid}/cwd")).unwrap()
}

#[cfg(target_os = "macos")]
pub fn cwd(pid: u32) -> PathBuf {
    use std::os::unix::ffi::OsStrExt;
    // SAFETY: proc_pidinfo fills a zeroed struct we own, of the size we pass.
    let mut vpi: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let n =
        unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDVNODEPATHINFO, 0, (&raw mut vpi).cast(), size) };
    assert_eq!(n, size, "proc_pidinfo PROC_PIDVNODEPATHINFO of {pid}: {}", std::io::Error::last_os_error());
    let p = &vpi.pvi_cdir.vip_path;
    // SAFETY: a c_char array viewed as bytes.
    let bytes = unsafe { std::slice::from_raw_parts(p.as_ptr().cast::<u8>(), std::mem::size_of_val(p)) };
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    PathBuf::from(std::ffi::OsStr::from_bytes(&bytes[..end]))
}

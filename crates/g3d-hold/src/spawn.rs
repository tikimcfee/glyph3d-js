//! Starting a program on a new PTY (DESIGN.md, "Spawning a terminal"). The holder is one thread,
//! so `fork` is safe here; the child makes only async-signal-safe calls before `execve`.

use rustix::fd::{AsRawFd, OwnedFd};
use std::ffi::CString;
use std::io;

/// What the brain asked to run, resolved: the path to exec, argv, the full environment.
pub struct Plan {
    pub path: CString,
    pub argv: Vec<CString>,
    pub env: Vec<CString>,
    pub cwd: Option<CString>,
    pub cols: u16,
    pub rows: u16,
}

fn cstr(s: &str, what: &str) -> io::Result<CString> {
    CString::new(s).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, format!("{what} contains NUL")))
}

fn is_executable(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

impl Plan {
    /// `argv[0]` without a slash is looked up in the environment's own `PATH` (`execvpe`
    /// semantics), not the holder's.
    pub fn new(argv: &[String], env: &[(String, String)], cwd: Option<&str>, cols: u16, rows: u16) -> io::Result<Self> {
        let Some(prog) = argv.first() else {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "argv is empty"));
        };
        let path = if prog.contains('/') {
            prog.clone()
        } else {
            let search = env
                .iter()
                .find(|(k, _)| k == "PATH")
                .map(|(_, v)| v.as_str())
                .unwrap_or("/usr/local/bin:/usr/bin:/bin");
            search
                .split(':')
                .filter(|d| !d.is_empty())
                .map(|d| std::path::Path::new(d).join(prog))
                .find(|p| is_executable(p))
                .map(|p| p.display().to_string())
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::NotFound, format!("{prog}: not found in PATH {search:?}"))
                })?
        };
        Ok(Plan {
            path: cstr(&path, "program path")?,
            argv: argv.iter().map(|a| cstr(a, "argv")).collect::<io::Result<_>>()?,
            env: env.iter().map(|(k, v)| cstr(&format!("{k}={v}"), "env")).collect::<io::Result<_>>()?,
            cwd: cwd.map(|c| cstr(c, "cwd")).transpose()?,
            cols,
            rows,
        })
    }
}

pub fn winsize(cols: u16, rows: u16) -> rustix::termios::Winsize {
    rustix::termios::Winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 }
}

/// Opens a PTY: the master close-on-exec, the slave opened before the size is set (macOS answers
/// `TIOCSWINSZ` on a master whose slave was never opened with `ENOTTY`), `IUTF8` on.
fn open_pty(cols: u16, rows: u16) -> io::Result<(OwnedFd, OwnedFd)> {
    use rustix::fs::{Mode, OFlags};
    use rustix::pty::{OpenptFlags, grantpt, openpt, ptsname, unlockpt};
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let master = openpt(OpenptFlags::RDWR | OpenptFlags::NOCTTY | OpenptFlags::CLOEXEC)?;
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    let master = {
        let m = openpt(OpenptFlags::RDWR | OpenptFlags::NOCTTY)?;
        rustix::io::fcntl_setfd(&m, rustix::io::FdFlags::CLOEXEC)?;
        m
    };
    grantpt(&master)?;
    unlockpt(&master)?;
    let name = ptsname(&master, Vec::new())?;
    let slave = rustix::fs::open(name.as_c_str(), OFlags::RDWR | OFlags::NOCTTY | OFlags::CLOEXEC, Mode::empty())?;
    // SAFETY: tcgetattr/tcsetattr on an fd we own, into a termios we own.
    unsafe {
        let mut t: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(slave.as_raw_fd(), &mut t) == 0 {
            t.c_iflag |= libc::IUTF8;
            libc::tcsetattr(slave.as_raw_fd(), libc::TCSANOW, &t);
        }
    }
    rustix::termios::tcsetwinsize(&master, winsize(cols, rows))?;
    Ok((master, slave))
}

/// The holder's open fds, listed before a fork (macOS has no `close_range`). Exact, because the
/// holder is one thread: nothing opens an fd between this and the fork.
#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn open_fds() -> Vec<i32> {
    let mut v: Vec<i32> = std::fs::read_dir("/dev/fd")
        .map(|d| d.flatten().filter_map(|e| e.file_name().to_str().and_then(|s| s.parse().ok())).collect())
        .unwrap_or_default();
    v.retain(|&fd| fd > 2);
    v
}

/// Starts `plan` on a new PTY as a session leader with the PTY as its controlling terminal.
/// `nofile` is the soft `RLIMIT_NOFILE` the holder started with. Returns the master and the pid;
/// an exec failure comes back as the child's errno.
pub fn spawn(plan: &Plan, nofile: libc::rlim_t) -> io::Result<(OwnedFd, i32)> {
    let (master, slave) = open_pty(plan.cols, plan.rows)?;
    let (err_r, err_w) = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC)?;
    let mut argv: Vec<*const libc::c_char> = plan.argv.iter().map(|a| a.as_ptr()).collect();
    argv.push(std::ptr::null());
    let mut envp: Vec<*const libc::c_char> = plan.env.iter().map(|a| a.as_ptr()).collect();
    envp.push(std::ptr::null());
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    let fds = open_fds();
    let (slave_fd, err_fd) = (slave.as_raw_fd(), err_w.as_raw_fd());

    // SAFETY: the holder is single-threaded, so the child is a faithful copy with no lock held
    // by another thread. Between fork and execve the child calls only async-signal-safe
    // functions on memory prepared above, and leaves by `_exit`.
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(io::Error::last_os_error());
    }
    if pid == 0 {
        unsafe {
            let fail = |step: i32| -> ! {
                let e = *errno_ptr();
                let msg = [step, e];
                libc::write(err_fd, msg.as_ptr().cast(), 8);
                libc::_exit(127);
            };
            // Every disposition back to default and the mask cleared: an ignored signal stays
            // ignored across exec, and the holder ignores SIGINT.
            for sig in 1..32 {
                if sig != libc::SIGKILL && sig != libc::SIGSTOP {
                    libc::signal(sig, libc::SIG_DFL);
                }
            }
            let mut set: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut set);
            libc::sigprocmask(libc::SIG_SETMASK, &set, std::ptr::null_mut());
            // The holder raised its own fd limit; programs using select() break above 1024.
            let mut rl: libc::rlimit = std::mem::zeroed();
            if libc::getrlimit(libc::RLIMIT_NOFILE, &mut rl) == 0 {
                rl.rlim_cur = nofile;
                libc::setrlimit(libc::RLIMIT_NOFILE, &rl);
            }
            if libc::setsid() < 0 {
                fail(1);
            }
            if libc::ioctl(slave_fd, libc::TIOCSCTTY as _, 0) < 0 {
                fail(2);
            }
            for fd in 0..3 {
                if libc::dup2(slave_fd, fd) < 0 {
                    fail(3);
                }
            }
            if let Some(dir) = &plan.cwd
                && libc::chdir(dir.as_ptr()) < 0
            {
                fail(4);
            }
            // Close everything above stderr but the error pipe (close-on-exec: it closes at exec).
            #[cfg(any(target_os = "linux", target_os = "android"))]
            {
                if err_fd > 3 {
                    libc::syscall(libc::SYS_close_range, 3u32, (err_fd - 1) as u32, 0u32);
                }
                libc::syscall(libc::SYS_close_range, (err_fd + 1) as u32, u32::MAX, 0u32);
            }
            #[cfg(not(any(target_os = "linux", target_os = "android")))]
            for &fd in &fds {
                if fd != err_fd {
                    libc::close(fd);
                }
            }
            libc::execve(plan.path.as_ptr(), argv.as_ptr(), envp.as_ptr());
            fail(5);
        }
    }
    drop(slave);
    drop(err_w);
    let mut msg = [0i32; 2];
    let n = loop {
        // SAFETY: reading into a buffer we own.
        let n = unsafe { libc::read(err_r.as_raw_fd(), msg.as_mut_ptr().cast(), 8) };
        if n < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        }
        break n;
    };
    if n == 8 {
        let mut status = 0;
        // SAFETY: reaping our own child, which has already called _exit.
        unsafe { libc::waitpid(pid, &mut status, 0) };
        let step = ["", "setsid", "TIOCSCTTY", "dup2", "chdir", "exec"].get(msg[0] as usize).copied().unwrap_or("?");
        let e = io::Error::from_raw_os_error(msg[1]);
        return Err(io::Error::new(e.kind(), format!("{step} {}: {e}", plan.path.to_string_lossy())));
    }
    Ok((master, pid))
}

#[cfg(any(target_os = "linux", target_os = "android"))]
unsafe fn errno_ptr() -> *mut i32 {
    unsafe { libc::__errno_location() }
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
unsafe fn errno_ptr() -> *mut i32 {
    unsafe { libc::__error() }
}

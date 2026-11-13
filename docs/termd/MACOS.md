# g3d-termd on macOS

What macOS does differently from Linux under termd, and how termd meets it. darwin-arm64 builds
natively and passes every gate: `cargo test --workspace --features g3d-termd/test-hooks`, clippy,
`go test ./...`, `termd-relay-check` and `wall-e2e`. Measured on an Apple Silicon Mac (the M2),
macOS 27.2, Rust 1.98.0 (Homebrew), Zig 0.17.0, libghostty-vt 1.0.1. The platform seams are listed
in DESIGN.md, "Linux and macOS"; this file has the why and the measurements behind them.

## Building

- `tools/termd-vendor.sh DIR` fetches the macOS Zig (`zig-aarch64-macos-0.17.0`) and the same
  libghostty tarballs. `minisign` comes from Homebrew. Every download is checked against its
  minisign signature **and** a pinned SHA-256 (Zig's are pinned per host, from ziglang.org's
  `index.json`). The script uses `sha256sum`, else `shasum -a 256`, whichever is on `PATH`.
- `make termd` (and `make build`) builds `g3d-termd` and `g3d` natively. A cold build takes about
  2 minutes, mostly libghostty's Zig build. `g3d-termd` links only libSystem and libiconv.
- `make darwin-arm64` puts both in `dist/` beside the CLI, and `make release` ships them when they
  are there.
- **darwin-amd64 is not built.** `make darwin-amd64` builds the pair only on an Intel Mac.
  Homebrew's Rust has no other targets; rustup's `x86_64-apple-darwin` (Zig can cross-compile
  libghostty to x86_64-macos) would do it on an arm64 Mac, and isn't wired.

## What macOS does differently

| | macOS | Linux | What termd does |
|---|---|---|---|
| Bytes queued on a PTY master | `FIONREAD` answers **0** whatever is queued; `TIOCOUTQ` on the master answers the slave's output queue, exactly what a read takes (700 queued, 700 read) | `FIONREAD` | The brain bounds each PTY read by the queued count, so its high-water mark (what a crash loses) is exact. With `FIONREAD`, every read on macOS took one byte and every `OUTPUT` frame carried one: floods ran about 50× slower and every flood, query and restart gate timed out. It asks `TIOCOUTQ` on macOS. |
| Shared memory (snapshots, handoffs, `seq_marks`) | No `memfd`. A `shm_open` object can be sized once, refuses `pwrite`/`pread` (`ESPIPE`), and reads back its size rounded up to a page (16 KiB) | `memfd_create`, sealed | `shm_open` of a random name, `shm_unlink` at once, `ftruncate` once. Bytes go in and out through a mapping (`shm::create_from`, `shm::read`), and a blob's length is the one in its header. No seals: nothing else holds the fd. |
| Close-on-exec at creation | No `pipe2`, `accept4`, `SOCK_CLOEXEC`, `MSG_CMSG_CLOEXEC`, or `O_CLOEXEC` for `posix_openpt` | Atomic everywhere | Set right after creation (`g3d_hold::pipe`, the PTY master, every fd the hold link receives). The holder is one thread, so nothing forks in between. The brain starts one program, `defaults` (the locale), once at start, before its other threads exist and after the handoff's fds are close-on-exec. |
| Closing fds in a child | No `close_range` | `close_range` | The holder lists its open fds (`/dev/fd`) just before the fork and the child closes them: exact, because the holder is one thread. Gate: `g3d-hold` `spawn::tests`, a pipe without close-on-exec and one with it, both closed in the program. |
| errno in a forked child | `__error` | `__errno_location` | A cfg seam in `g3d-hold`'s spawn. An exec failure comes back as `spawn_failed` naming it (`tests/status.rs`). |
| Process RSS (status document) | No `/proc` | `/proc/<pid>/statm` | `proc_pidinfo(PROC_PIDTASKINFO)`; `tests/status.rs` reads it nonzero for holder and brain. |
| Peer credentials | `getpeereid` answers `ENOTCONN` once the client has closed | `SO_PEERCRED` still answers | Such a connection is dropped without a log line (a readiness probe that only connects did this on every test). |
| `TIOCSWINSZ` on a fresh master | `ENOTTY` until the slave has been opened | Works at once | The slave is opened first, on both. |
| PTY buffer with no reader | 1,024 bytes (the slave's write blocks past it) | 13.8 KB | Nothing to change; it's why the queued count matters above. |
| Canonical-mode line length (`MAX_CANON`) | 1,023 bytes. A longer line loses its excess with a BEL per byte (`IMAXBEL`), and its line end too, so the reader keeps waiting | 4,095 | Nothing to change: it's the kernel's line discipline, and termd writes the bytes it was given, unsplit. It bites only a program reading in canonical mode (`read`, `head -n1`, Python's `input()`). Shells' line editors, vim and Claude Code run raw, and raw input of any size arrives whole (a daemon test sends one 256 KiB `INPUT`). This is the limit gomuxai hit. |
| Parent-death signal | None | `prctl` | termd uses none: the brain sees the hold link close, and shells see their PTY hang up. The relay's `agent` children are covered only by its signal handler off Linux (children.go). |
| `$XDG_RUNTIME_DIR`, `/run/user/<uid>` | Neither exists | logind's | The socket lives in `/tmp/g3d-<uid>` (next section). |
| Unix socket path | `sun_path` is 104 bytes | 108 | termd refuses a path over 100 bytes, on both. |

## The socket directory: `/tmp/g3d-<uid>`

macOS has no `/run/user/<uid>`, so the socket rule ([PROTOCOL.md](PROTOCOL.md)) always lands on
`/tmp/g3d-<uid>`, tmux's rule (`/tmp/tmux-<uid>`). It never reads `$TMPDIR`:

- **Rust and Go disagree when `$TMPDIR` is unset** (`env -i`, cron). Rust's `temp_dir()` answers
  the per-user `confstr(_CS_DARWIN_USER_TEMP_DIR)` directory, `/var/folders/…/T/`, and Go's
  `os.TempDir()` answers `/tmp`. Measured: a relay would look where the daemon it started didn't
  bind.
- **Length.** `$TMPDIR` is 49 bytes, which leaves about 32 bytes of the 100-byte cap for a
  namespace of up to 64. `/tmp/g3d-<uid>/termd-<ns>.sock` fits any name.

`/tmp` is shared and cleaned, so:

- **The holder refuses** a socket directory that is not a directory, is another user's, or that
  group or others can write, saying whose it is and its mode.
- **It re-stamps its socket and lock every hour** (`utimes`). macOS's `/usr/libexec/tmp_cleaner`
  deletes regular files under `/tmp` untouched for 3 days. The socket would survive it; the
  namespace's `.lock` would not, and a second daemon could then take the namespace and unlink
  the live one's socket.

Tests make their scratch directories under `/tmp` for the same 104 bytes: `t.TempDir()` and
`$TMPDIR`-based paths don't fit a socket.

## The environment a terminal gets

As built (DESIGN.md, "Environment"), proven here by `tests/env.rs` and `termd-relay-check`:

- **The default program is the passwd shell as a login shell**, argv0 `-zsh`, in the caller's
  directory or home. A login zsh runs `/etc/zprofile`, which on this macOS runs `path_helper`
  (`/etc/paths`, `/etc/paths.d`) and sets `LANG=C.UTF-8` when it is unset, then `~/.zprofile`
  (Homebrew's `shellenv`). A non-login shell got neither: a bare `PATH` and an ASCII locale.
- **The base is the session's variables of the holder's own environment** (no user manager on
  macOS): the account, `PATH`, `TMPDIR`, the locale, `SSH_AUTH_SOCK`, and launchd's
  `__CF_USER_TEXT_ENCODING` and `COMMAND_MODE`, which every process of a GUI session carries. A
  launching app's `XPC_SERVICE_NAME`, `XPC_FLAGS` and `OSLogRateLimit` don't pass. Then termd's
  own: `TERM_PROGRAM=g3d-termd`, `TERM_PROGRAM_VERSION`, `TERM`, `COLORTERM`, `G3D_TERMD_*`.
- **The locale when none is set** is the user's: the `AppleLocale` preference (`en_US`) as
  `en_US.UTF-8`, as Terminal.app, iTerm2 and Ghostty read it; `C.UTF-8` when it has no region
  or doesn't load.
- **What it keeps out**, measured before the policy existed:
  - The starter's terminal identity. A termd started from Terminal.app gave every shell
    `TERM_PROGRAM=Apple_Terminal`, so Apple's `/etc/zshrc` sourced `/etc/zshrc_Apple_Terminal`
    and installed Terminal.app's OSC 7 hook, and with `TERM_SESSION_ID` one tab's
    `~/.zsh_sessions` history would be shared by every terminal.
  - Live handles of another terminal. A shell in Rex (a GUI terminal) carries `REX_SERVER`,
    `REX_SESSION` and `REX_BLOCK`, handles on Rex's server and on that tab. No denylist names
    every terminal's own variables, which is why the base is a known set and not "the starter's
    minus a list".
- **ssh-agent and Keychain** work from a daemon in the GUI session: launchd's `SSH_AUTH_SOCK` is
  inherited, and a terminal's `security` reaches the unlocked login keychain.

What other terminals and daemons do on macOS (from source, 2026-11-12):

| | Login shell | Which shell | Identity it sets | `LANG` when unset |
|---|---|---|---|---|
| Terminal.app | `login -pfl <user> … exec -la <shell>` | passwd (via login) | `TERM_PROGRAM=Apple_Terminal`, `TERM_SESSION_ID` | its own setting, on by default |
| Ghostty | `/usr/bin/login -flp <user> /bin/bash --noprofile --norc -c "exec -l $SHELL"` | `getpwuid`, or `$SHELL` when launched from a CLI | `TERM_PROGRAM=ghostty` + version | from `NSLocale`, else `en_US.UTF-8` |
| iTerm2 | `login -fpl <user> ShellLauncher` → argv0 `-<shell>` | `$SHELL` (set by login) | `TERM_PROGRAM=iTerm.app`, `LC_TERMINAL`, session ids | "Set locale variables automatically" |
| WezTerm mux server | argv0 `-<shell>` | `getpwuid` | `TERM_PROGRAM=WezTerm` + version; removes `OLDPWD PWD SHLVL` and, by default, the SSH variables | from `NSLocale` |
| tmux | argv0 `-<shell>` | `$SHELL` if a real shell, else `getpwuid` | `TERM_PROGRAM=tmux`, `TMUX`, `TMUX_PANE`; `update-environment` on attach | doesn't set it |
| shpool | argv0 `-<shell>` | `getpwuid` | starts from `env_clear()`: `HOME PATH SHELL USER` + `TERM` | forwards the client's |

termd follows the daemons (argv0 `-<shell>`, no `login(1)`, which wants a login session a daemon
is not) and the GUI terminals' locale. Coming next: a terminal inherits its caller's environment
(`g3d new` sends it), and a creator with no shell gets the allowlist with the session's handles
read fresh from `launchctl getenv`.

## Testing without `/proc`

- **Process state and RSS** come from `ps -o stat=` / `ps -o rss=` on both platforms. Before
  that, the daemon tests' kill and memory-ceiling gates read `/proc`, failed silently on macOS,
  and passed without measuring.
- **Another process's exec'd environment, argv and cwd** come from `tests/common/procinfo.rs`:
  `/proc` on Linux, `sysctl(KERN_PROCARGS2)` and `proc_pidinfo(PROC_PIDVNODEPATHINFO)` on macOS.
  **macOS withholds the environment of Apple platform binaries** (`/bin/sleep`, `/bin/zsh`) from
  every other process, `ps -E` included; ours it shows. So a test that reads a terminal's
  environment runs this test binary as the terminal's program, and the reader fails loud on a
  withheld one. The login shell's `SHELL` is read from the shell itself.
- **Signal masks and fd limits** of another process can't be read on macOS: `ps -o sigmask` is
  always 0, and there is no limits file. `tests/env.rs`'s `probe` runs as the terminal's program
  and reports its own blocked and ignored signals and soft fd limit, on both platforms. It fails
  when the holder leaves the starter's ignored `SIGINT` in place (checked).
- **The passwd entry** comes from `getpwuid` (Node's `os.userInfo()` in the relay check): macOS
  has no `getent`.

## A daemon an unwritable log can't stop

`log()` used `eprintln!`, which panics when stderr can't be written: a full disk under the log
file, or a closed pipe (found here: a daemon started under `| head -1` ignored SIGTERM). In the
brain the panic ended whichever task logged, such as the SIGTERM handler or the idle-exit timer.
In the holder, whose panic hook aborts, it would hang up every shell. A failed log write is now
dropped. Gate: `an_unwritable_log_does_not_wedge_the_daemon`, which fails with `eprintln!`. Not
macOS-specific.

## Not verified here

- That an sshd session lacks `$TMPDIR` (the rule doesn't depend on it).
- Keychain access from a daemon first started over ssh, whose audit session's keychain is
  locked. The normal practice for a daemon that must outlive logins is a LaunchAgent in
  `gui/<uid>`.
- The real Terminal.app's environment: driving it with `osascript` waits on an Automation consent
  prompt, so its launch was rebuilt with `login -pfl`.
- darwin-amd64.

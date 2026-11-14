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

DESIGN.md, "Environment", is the rule: **a new terminal carries its creator's environment; a
creator with none gets the desktop session's.** On macOS only the session source differs, and
what it answers. Proven by `tests/env.rs`, `tests/attach.rs`, `termd-relay-check` and by hand.

- **The default program is the passwd shell as a login shell**, argv0 `-zsh`, in the caller's
  directory or home. A login zsh runs `/etc/zprofile`, which on this macOS runs `path_helper`
  (`/etc/paths`, `/etc/paths.d`) and sets `LANG=C.UTF-8` when it is unset, then `~/.zprofile`
  (Homebrew's `shellenv`). A non-login shell got neither: a bare `PATH` and an ASCII locale.
- **A caller with a shell** (`g3d new`) sends its whole environment; the scrub takes out what
  points back at its tab or process. Measured from a Rex tab and from Terminal.app:
  - Rex: `REX_SESSION`, `REX_BLOCK`, `REX_SERVER`, `REX_BIN_DIR` and `XPC_SERVICE_NAME` are gone,
    `TERM_PROGRAM=rex` became `g3d-termd`, and the rest (Homebrew's, the tab's `PATH`, `LANG`,
    `SSH_AUTH_SOCK`, `TMPDIR`, Rex's `__CF_USER_TEXT_ENCODING=0x0:0:0`) rode along.
  - Terminal.app: `TERM_PROGRAM=Apple_Terminal`, `TERM_PROGRAM_VERSION`, `TERM_SESSION_ID` and
    `__CFBundleIdentifier` are gone.
  - Unlisted names ride along, as in tmux: `XPC_FLAGS` and `OSLogRateLimit` (any app's child
    has them), and whatever the caller's own starter left. The Terminal.app here was evidently
    started from an agent's shell (its windows have `TMUX` and `CLAUDE_CODE_*`): they carry `AGENT_NAME`, `AGENT_HOST` (gomuxai's),
    `GIT_EDITOR=true` and `COREPACK_ENABLE_AUTO_PIN` (Claude Code's) and `SSH_CONNECTION`, and so
    did the terminal it created; `CLAUDE_CODE_*`, `CLAUDECODE`, `TMUX` and `TMUX_PANE` were
    scrubbed. That is the caller rule working as specified; whether those names belong on the
    scrub list is the lead's call.
- **`g3d new --clean`, the wall and the relay** get the session's: the allowlist, each name looked
  up at every create, then the fill (`HOME`, `USER`, `LOGNAME`, `SHELL` from passwd; `PATH` is
  macOS `login(1)`'s `/usr/bin:/bin`, which `path_helper` extends).
- **The session source is launchd**, one `/bin/sh` per create running `launchctl getenv` for each
  allowlisted name (about 90 ms for the 20 names here; `launchctl export` no longer exists, and
  `launchctl print`'s output is documented as not an API). It answers what was `launchctl
  setenv`'d and the agents' sockets (`SSH_AUTH_SOCK`), and nothing else here. Two names a Mac
  session has that `getenv` never answers come from where launchd and terminals take them:
  - `TMPDIR`: launchd gives each job `confstr(_CS_DARWIN_USER_TEMP_DIR)`, `/var/folders/…/T/`.
    Without it a daemon started stripped gave its terminals no `TMPDIR`, and programs used
    `/tmp`.
  - The locale: no Mac session sets one, so the starter's own (`LC_ALL=C` from a stripped relay)
    stood in for every no-caller terminal's. A terminal on a Mac makes `LANG` from the user's
    `AppleLocale` (`en_US` gives `en_US.UTF-8`), as Terminal.app, iTerm2 and Ghostty do, read per
    create (`defaults`, under 10 ms); the locale group rule then keeps the starter's out.

  `g3d env` tags them `session (launchd)` and `session (AppleLocale)`. A name the session lacks
  (`DISPLAY`) falls back to the daemon's start value for that name, tagged `session (daemon)`.
- **Proven by hand**, from a daemon started with `env -i HOME=… PATH=/usr/bin:/bin` and a stale
  `SSH_AUTH_SOCK`: the agent's socket and `TMPDIR` come back fresh; `DISPLAY=:42` and a passed
  `FOO` from the daemon are tagged `session (daemon)`; with `pass = ["FOO"]` in termd.toml,
  `launchctl setenv FOO bar` reached the next create with no restart (`session (launchd)`), the
  running terminal kept its value, and after `launchctl unsetenv FOO` the next one fell back to
  the daemon's. `tests/env.rs` gates the read-only part in a GUI (Aqua) session and skips,
  saying so, outside one (an ssh login, where `launchctl managername` is not `Aqua`); the
  `setenv` case stays by hand because a test would write to the person's session.
- **`__CF_USER_TEXT_ENCODING` and `COMMAND_MODE` stay off the allowlist** (measured, below).
- **ssh-agent and Keychain** work from a daemon in the GUI session: launchd's `SSH_AUTH_SOCK`, and
  a terminal's `security` reaches the unlocked login keychain.

### Why `__CF_USER_TEXT_ENCODING` and `COMMAND_MODE` aren't needed

launchd gives every GUI process `__CF_USER_TEXT_ENCODING=0x1F5:0x0:0x0` (uid, encoding, region)
and `COMMAND_MODE=unix2003`. A no-caller terminal has neither. Measured on this Mac, with each
unset and with launchd's value:

- CoreFoundation sets `__CF_USER_TEXT_ENCODING` itself when a program loads it, from the uid and
  `~/.CFUserTextEncoding` (`0x0:0x0`): a CF program removed from it by `env -u` reads
  `0x1F5:0x0:0x0` before `main`, the same value. `CFStringGetSystemEncoding` (Mac Roman, `0x0`)
  and `CFStringGetFileSystemRepresentation` of `café` are identical. A program without CF never
  reads it.
- `pbcopy` → `pbpaste` of `café ☃ 日` (on a private pasteboard), `defaults read` of a non-ASCII
  value, `defaults read -g AppleLocale` and `open`'s error naming a non-ASCII path: byte-identical,
  with `LANG=en_US.UTF-8` and with no locale at all.
- `COMMAND_MODE`: compat(5) says unset behaves as `unix2003`. `ls -n` (long), `ps -l`'s columns,
  `pr -i` and `mv dir/afile dir` (exit 2) are identical unset and `unix2003`; `legacy` changes
  all but `pr` (`ls -n` short, the 10.3 `ps -l` columns, `mv` exiting 0), so the battery sees
  the variable when it matters.
- What terminals hand their shells: Rex gives `__CF_USER_TEXT_ENCODING=0x0:0:0` (its own value)
  and no `COMMAND_MODE`; the agent-started Terminal.app here gives neither. Shells run fine
  without them.

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
is not) and the GUI terminals' locale.

## Keys and paste

termd encodes the `key` op with libghostty's encoder against the program's live modes (DESIGN.md,
"Input"). Measured on macOS with `g3d key` and `g3d paste`:

| Into | Shift+Enter | Enter | Alt+A | Ctrl+C |
|---|---|---|---|---|
| a Kitty-keyboard program (`CSI > 1 u`) | `CSI 13;2u` | `\r` | `CSI 97;3u` | `CSI 99;5u` |
| a plain program | `\r` | `\r` | `ESC a` | `0x03` |
| zsh at its prompt | runs the line | runs the line | | |

Paste: bracketed (`ESC[200~ … ESC[201~`) when the program asked for it (zsh's prompt, the Kitty
program), plain otherwise; refused (`unsafe_paste`) when it holds a line break the program would
read as Enter, or the bracket's end; `--unsafe` sends it (a line break as `\r`).

**Option on a Mac.** Chrome and Safari report Option+A on a US layout as `key: "å"`, `code:
"KeyA"`, `altKey: true`, and the wall sends exactly that (`text: "å"`, `mods: ["Alt"]`) with its
`optionAsAlt` setting (`option_as_alt`, protocol 1.3). Under `auto`, the default, an Alt that typed
another character than the key's own is Option typing it, encoded as Ghostty's default
(`macos-option-as-alt = false`); an Alt whose text is the key's own character (`g3d key alt+a`, a
Linux browser) is Alt:

| Program's mode | Option+A (`å`) | Alt+A (`a`) |
|---|---|---|
| legacy | `å` | `ESC a` |
| Kitty, disambiguate (flags 1) | `å` | `CSI 97;3u` |
| Kitty, all keys + text (flags 31) | `CSI 97;3;229u` | `CSI 97;3u` |
| modifyOtherKeys 2 | `å` | `CSI 27;3;97~` |

`wall.config optionAsAlt true` makes Option Alt (Option+A is the Alt+A column: Emacs and readline
Meta keys), `false` makes every Alt a character modifier (even Alt+A types `a`); the next key takes
it. The IDE's is Settings ▸ Terminals ▸ Option as Alt. libghostty reads its own option only in a
macOS build, so termd makes `false` itself and a Linux daemon serving a Mac browser encodes the
same bytes (DESIGN.md, "Option as Alt"). Unit tests: `keys::tests::
a_macos_option_character_is_its_text_and_alt_as_alt_is_alt` and the forced `true` / `false` ones.

## Testing without `/proc`

- **Process state and RSS** come from `ps -o stat=` / `ps -o rss=` on both platforms. Before
  that, the daemon tests' kill and memory-ceiling gates read `/proc`, failed silently on macOS,
  and passed without measuring.
- **Another process's exec'd environment, argv and cwd** come from `tests/common/procinfo.rs`:
  `/proc` on Linux, `sysctl(KERN_PROCARGS2)` and `proc_pidinfo(PROC_PIDVNODEPATHINFO)` on macOS.
  **macOS withholds the environment of Apple platform binaries** (`/bin/sleep`, `/bin/zsh`) from
  every other process, `ps -E` included; ours it shows. So a test that reads a terminal's
  environment runs this test binary as the terminal's program, and the reader fails loud on a
  withheld one. The login shell's `SHELL` is read from the shell itself. `KERN_PROCARGS2` puts the
  kernel's strings for dyld (`ptr_munge=`, `main_stack=`, `executable_file=`, …) right after the
  environment, with NUL padding between them only sometimes, so the reader ends the environment
  at the first all-lowercase name.
- **The relay check reads a platform shell's environment from `g3d env`** on macOS (termd's own
  account; `tests/env.rs` holds it to the kernel's), and argv and cwd from `ps` and `lsof`.
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

- That an sshd session lacks `$TMPDIR`, and `tests/env.rs`'s launchd test skipping in an ssh
  login (`launchctl managername` there was not measured).
- Keychain access from a daemon first started over ssh, whose audit session's keychain is
  locked. The normal practice for a daemon that must outlive logins is a LaunchAgent in
  `gui/<uid>`.
- What a Terminal.app started from the Dock hands its shells: the one here was evidently started
  from an agent's shell (above), and scripting a fresh one needs Automation consent. `SHELL_SESSION_ID`
  was empty in its window, so its scrub is proven by the tests' stand-in only.
- Shift+Enter into Claude Code itself: the Kitty-mode stand-in prints the bytes instead
  (wall-e2e and `termd-relay-check` do the same).
- darwin-amd64.

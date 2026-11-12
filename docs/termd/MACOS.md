# g3d-termd on macOS

What macOS does differently from Linux under termd, what was changed for it, and what the
child environment should be. Measured on 2026-11-12 on an Apple Silicon Mac (arm64), macOS
27.2, Rust 1.98.0 (Homebrew), Zig 0.17.0, libghostty-vt 1.0.1.

## Building

- `tools/termd-vendor.sh DIR` fetches the macOS Zig (`zig-aarch64-macos-0.17.0`) and the same
  libghostty tarballs. `minisign` comes from Homebrew. Every download is checked against its
  minisign signature **and** a pinned SHA-256. Zig's SHA-256s (from ziglang.org's
  `index.json`) are now pinned per host beside the Ghostty ones.
- The script's SHA-256 fallback was dead code: `sha256sum … | cut || shasum …` takes the
  pipeline's status, which is `cut`'s, so a Mac without `sha256sum` (before macOS 15, or a
  `PATH` without `/sbin`) compared an empty hash and failed. The script now picks
  `sha256sum`, else `shasum -a 256`, up front.
- `cargo build --workspace`: a cold build takes about 2 minutes, mostly libghostty's Zig build.
  `make build` (and `make termd`) build `g3d-termd` and `g3d` natively on darwin, as on Linux.
  `make darwin-arm64` puts them in `dist/` when run on an arm64 Mac.
- **Not done: darwin-amd64.** Homebrew's Rust has no other targets. It needs rustup's
  `x86_64-apple-darwin` target (Zig can cross-compile libghostty to x86_64-macos) or a build on
  an Intel Mac.

## What macOS does differently

| | macOS | Linux | What termd does now |
|---|---|---|---|
| Close-on-exec at creation | No `pipe2`, `accept4`, `SOCK_CLOEXEC`, or `O_CLOEXEC` for `posix_openpt`. std, tokio and termd create these fds first and set the flag after. | Atomic everywhere | The wake pipe and PTY master set `FD_CLOEXEC` right after creation. The child, before `exec`, closes every fd above 2 that lacks `FD_CLOEXEC` (`spawn::close_inherited`). Those are exactly the fds another owner thread's fork could catch mid-creation: another terminal's PTY master (whose shell would then never get its hangup), a client socket, a wake pipe. std's own exec-error pipe is close-on-exec, so it survives. tmux does `closefrom` here for the same reason. |
| `TIOCSWINSZ` on a PTY master | `ENOTTY` until the slave has been opened | Works at once | The daemon already opened the slave first. The attach test didn't, and now does. Both say why. |
| `/proc` | None | Present | The daemon never used it. Its tests did, for process state (`wait_dead`) and RSS. On macOS those reads failed **silently**: "dead" at once and RSS 0, so the kill and memory-ceiling gates passed without measuring anything. They now read `ps -o stat=` / `ps -o rss=`, which work the same on both, and fail loud if `ps` can't measure. Measured here: 16 MiB peak for the 4-terminal flood, 6 → 35 MiB under the events flood. |
| Canonical-mode line length (`MAX_CANON`) | 1024: a line over 1023 bytes loses its excess. The tty echoes BEL for each lost byte (`IMAXBEL`), and the line's end is lost too, so the reader keeps waiting. | 4095 | Nothing to change: it's the kernel's line discipline, and termd writes the bytes it was given. It only bites a program reading in canonical mode (`read`, `head -n1`, Python's `input()`). Shells' line editors, vim and Claude Code run raw. Raw-mode input of any size arrives whole: termd keeps what the PTY refuses and writes it on `POLLOUT`. A new daemon test sends one 256 KiB `INPUT`. This is the limit gomuxai hit. |
| Parent-death signal | None (`PR_SET_PDEATHSIG` is Linux-only) | `prctl` | termd uses none by design: it outlives its starter, and its children die with their PTY. The relay's `agent` children (children.go) are covered only by its SIGINT/SIGTERM handler here, as documented there. kqueue's `EVFILT_PROC`/`NOTE_EXIT` on the parent is the macOS equivalent if that ever matters. |
| `eventfd` | None | Present | The wake fd was already a pipe off Linux. Only its creation changed (row 1). |
| `setsid` + `TIOCSCTTY` | Works unchanged | | |
| Unix socket path | `sun_path` is 104 bytes | 108 | termd refuses a path over 100 bytes at start, unchanged. |
| `$XDG_RUNTIME_DIR` | Never set | Set by logind | See the next section. |

## The socket directory when `$XDG_RUNTIME_DIR` is unset

The rule's last step was `<temp dir>/g3d-<uid>`, where the temp dir was "`$TMPDIR`, else
`/tmp`". On macOS that broke in two ways:

- **Rust and Go disagree when `$TMPDIR` is unset**, as under `env -i` and, by wide report, in
  ssh sessions (not verified here). Rust's `std::env::temp_dir()` then answers the per-user
  `confstr(_CS_DARWIN_USER_TEMP_DIR)` directory, `/var/folders/…/T/`. Go's `os.TempDir()`
  answers `/tmp`. Measured: the relay (Go) would look in one place while the daemon it started
  (Rust) bound in the other.
- **Path length.** `$TMPDIR` is 49 bytes here, which leaves about 32 bytes for a namespace
  under the 100-byte cap, though names may be 64. zellij uses `$TMPDIR` and carries a
  hard-coded 104-byte guard for this reason.

The rule's last step is now **`/tmp/g3d-<uid>`**, tmux's rule (`/tmp/tmux-<uid>`). It ignores
`$TMPDIR`, so every session agrees, and it is short: 19 bytes + name + 5, so a 64-byte name fits.
`/tmp` is shared, so two things come with it:

- **Ownership.** The daemon refuses a socket directory that is not a directory, is owned by
  another user, or that group or others can write (tmux checks the same). The check applies
  to every directory it serves from, including `$G3D_TERMD_DIR` and `$XDG_RUNTIME_DIR/g3d`.
- **Cleaners.** macOS runs `/usr/libexec/tmp_cleaner` daily. It deletes regular files under
  `/tmp` that haven't been accessed, modified or changed for 3 days, and empty directories.
  Sockets survive it. The namespace's `.lock` (a regular file) would not. A second daemon
  would then create a new lock, take it, unlink the live daemon's socket and bind its own: two
  daemons, the first one's terminals unreachable. dirhelper cleans `/var/folders` on the same
  3-day rule, so `$TMPDIR` was no safer. The daemon now re-stamps its socket and lock
  (`utimes`) every hour. systemd-tmpfiles' `/tmp` rule on Linux is the same hazard at 10 days.

The log stays at `~/.local/state/g3d/termd-<ns>.log` (`$XDG_STATE_HOME`). macOS's own place
would be `~/Library/Logs`, but one rule on both systems is worth more.

## The environment a terminal gets

The task: what is the normal practice for a daemon that spawns shells on macOS, and what does a
termd terminal get today?

### What termd does today

The program's environment is the daemon's own, plus `TERM=xterm-256color`,
`COLORTERM=truecolor`, `G3D_TERMD_ID` and `G3D_TERMD_SOCKET`, minus `TMUX`/`TMUX_PANE`. The
default program is `$SHELL` with no arguments, a **non-login** shell. The relay's default
(`cli/attach.go`) is the same.

### Measured

Three environments, each captured from an interactive `zsh` running `env` (names only; values
were masked):

- **T**: Terminal.app's launch, rebuilt without the GUI: launchd's user environment, then
  `login -pfl <user> /bin/zsh -c 'exec -a -zsh /bin/zsh -i'`, which is the shape Terminal.app
  uses. Terminal.app's own additions (`TERM_PROGRAM_VERSION`, `TERM_SESSION_ID`, its `LANG`
  setting) are not in it.
- **L**: a termd terminal whose daemon was started with launchd's user environment: `PATH`
  (`/usr/bin:/bin:/usr/sbin:/sbin`), `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR` and
  `SSH_AUTH_SOCK`. This is a LaunchAgent, or anything a GUI app starts.
- **S**: a termd terminal whose daemon was started from shell T, as when the operator runs
  `tools/dev.sh` in Terminal.

| | T (Terminal.app) | L (termd, launchd env) | S (termd, started from a Terminal shell) |
|---|---|---|---|
| Shell | login, interactive | non-login, interactive | non-login, interactive |
| `PATH` | `path_helper` (`/etc/paths`, `/etc/paths.d`) + `~/.zprofile` (Homebrew's `shellenv`) + `~/.zshrc` | `/usr/bin:/bin:/usr/sbin:/sbin` + what `~/.zshrc` adds: **no Homebrew, no `/usr/local/bin`, no `paths.d`** | T's, with `~/.zshrc`'s entries added twice |
| `LANG` | `C.UTF-8`, from `/etc/zprofile`, new in this macOS: `[ -z "$LANG" ] && export LANG=C.UTF-8` | **unset**: `locale charmap` is `US-ASCII`, so zsh shows typed non-ASCII as `<…>` escapes | inherited `C.UTF-8` |
| `HOMEBREW_*`, `INFOPATH`, `FPATH` | set (`~/.zprofile`) | missing | inherited |
| `TERM_PROGRAM` | `Apple_Terminal` | unset | **`Apple_Terminal`, inherited from the starter** |
| `SSH_AUTH_SOCK` | launchd's agent socket | launchd's agent socket; `ssh-add -l` works | same |
| Keychain | | login keychain unlocked; `security add/find-generic-password` work | |
| `SHELL` | `/bin/zsh` (= `dscl . -read /Users/<user> UserShell`) | `/bin/zsh` | `/bin/zsh` |

Three defects come out of this:

1. **A non-login shell skips the system's login setup.** `/etc/zprofile` is what runs
   `path_helper` and, on this macOS, defaults `LANG`; `~/.zprofile` is where Homebrew puts its
   `shellenv`. A termd started by anything but a login shell gives its shells a bare `PATH`
   and an ASCII locale. For a glyph renderer, the ASCII locale is the worse of the two.
2. **The starter's terminal identity leaks into every terminal.** S's shells carry
   `TERM_PROGRAM=Apple_Terminal`. Apple's `/etc/zshrc` sources `/etc/zshrc_$TERM_PROGRAM`, so
   every termd shell installs Terminal.app's integration:
   - an OSC 7 `precmd` hook;
   - with Terminal.app's `TERM_SESSION_ID`, which a real Terminal.app start also carries,
     per-session history under `~/.zsh_sessions` keyed on one Terminal tab's id, shared by
     every termd terminal.

   Programs that gate features on `TERM_PROGRAM` (image protocols, keyboard setups) believe
   they're in Terminal.app, iTerm2 or Ghostty, whichever started the relay. The same holds on
   Linux.
3. **The daemon's environment is frozen at its start.** That is tmux's model too, and fine,
   but it makes defects 1 and 2 depend on who happened to start the daemon.

### What others do

From source, at the HEADs current on 2026-11-12:

| | Login shell | Which shell | Identity it sets | `LANG` when unset |
|---|---|---|---|---|
| Terminal.app | `login -pfl <user> … exec -la <shell>` | passwd (via login) | `TERM_PROGRAM=Apple_Terminal`, `TERM_SESSION_ID` | its own setting, on by default |
| Ghostty | `/usr/bin/login -flp <user> /bin/bash --noprofile --norc -c "exec -l $SHELL"` (`src/termio/Exec.zig`) | `getpwuid`, or `$SHELL` only when launched from a CLI | `TERM_PROGRAM=ghostty` + version; removes `VTE_VERSION` | from `NSLocale`, `<ll>_<CC>.UTF-8`, else `en_US.UTF-8` |
| iTerm2 | `login -fpl <user> ShellLauncher` → argv0 `-<shell>` | `$SHELL` (set by login) | `TERM_PROGRAM=iTerm.app`, `LC_TERMINAL`, session ids; drops `SHLVL` | "Set locale variables automatically" (default on) |
| WezTerm mux server | argv0 `-<shell>` (no login(1)) | `getpwuid`; drops `$SHELL` as possibly stale | `TERM_PROGRAM=WezTerm` + version; removes `OLDPWD PWD SHLVL` and, by default, `SSH_AUTH_SOCK SSH_CLIENT SSH_CONNECTION` (`mux_env_remove`) | from `NSLocale` |
| tmux | argv0 `-<shell>` | `$SHELL` if it's a real shell, else `getpwuid` | `TERM_PROGRAM=tmux` + version, `TMUX`, `TMUX_PANE`; refreshes `SSH_AUTH_SOCK` etc. on attach (`update-environment`) | doesn't set it |
| shpool | argv0 `-<shell>` | `getpwuid` | starts from `env_clear()`: `HOME PATH SHELL USER` + `TERM`; `PATH=/usr/bin:/bin:/usr/sbin:/sbin` | forwards the client's |

The common practice:

- every macOS terminal and multiplexer starts the default shell as a **login shell**;
- daemons do it with an argv0 of `-<shell>`; GUI terminals go through `login(1)` for utmp,
  `setlogin` and the PAM launchd session;
- they take the shell from the passwd entry;
- they set their own `TERM_PROGRAM` / `TERM_PROGRAM_VERSION`;
- they remove their own nesting variables.

### Recommendations (not implemented: the Linux environment work owns this)

1. **The default program is a login shell: argv0 `-<basename>`.** That is the practice of
   tmux, WezTerm's mux and shpool, the daemons, rather than the GUI terminals' `login -pfl`,
   which wants a login session (utmp, `setlogin`) that a daemon is not. It alone fixes
   `PATH` (path_helper, `/etc/paths.d`, Homebrew's `shellenv`) and, on current macOS, `LANG`,
   through the system's own files. One place: termd's default `argv`; the relay should send
   none rather than `$SHELL`. An explicit `argv` stays run as given.
2. **The shell comes from the passwd entry** (`getpwuid`, which reads the directory service:
   what `dscl … UserShell` shows), with `$SHELL` only as the fallback. Set `SHELL` to it in the
   child, as login(1) and tmux do. `chsh` then takes effect without restarting the daemon.
3. **termd states its own identity and drops its starter's.** Set
   `TERM_PROGRAM=g3d-termd` and `TERM_PROGRAM_VERSION=<version>`. Remove what names the
   terminal that started the daemon: `TERM_SESSION_ID`, `ITERM_SESSION_ID`, `ITERM_PROFILE`,
   `LC_TERMINAL`, `LC_TERMINAL_VERSION`, `COLORFGBG`, `VTE_VERSION`, `WINDOWID`, `GHOSTTY_*`,
   `KITTY_*`, `WEZTERM_*`, and `SHELL_SESSION_ID` (`TMUX`/`TMUX_PANE` already are). Also
   `SHLVL`, `PWD` and `OLDPWD`, which belong to the starter's shell (WezTerm drops them). This
   matters on Linux as much.
4. **`LANG`, when the daemon's environment has none and no `LC_ALL`/`LC_CTYPE`:** set
   `LANG=<ll>_<CC>.UTF-8` from the user's locale (macOS: the `AppleLocale` default, here
   `en_US`), else `C.UTF-8`. That is what Ghostty, WezTerm and iTerm2 do for a launchd-started
   process. It covers what (1) doesn't: a program given as `argv` runs no profile.
5. **Leave `PATH` to the login shell.** Don't run `path_helper` in the daemon or invent a
   `PATH`. A program given as `argv` gets the daemon's `PATH` (PROTOCOL.md says so), and a
   caller that wants more passes `env`.
6. **`SSH_AUTH_SOCK`: keep inheriting it.** launchd's agent socket lives as long as the GUI
   login session. The stable-symlink scheme (WezTerm, shpool), re-pointed by the client that
   attached last, matters only when clients arrive over ssh with forwarded agents. Revisit then.
7. **Keychain: start the daemon inside the user's GUI session.** Measured here, from a daemon
   in the GUI session, a terminal's `security` reaches the unlocked login keychain. A daemon
   first started from an ssh login is in that login's audit session, and its children would
   see a locked keychain (not verified here). tmux moves its server into the per-user
   bootstrap namespace after daemonizing (`compat/daemon-darwin.c`) for the related clipboard
   case. The normal practice for a daemon that must outlive logins is a LaunchAgent in
   `gui/<uid>` (shpool's Homebrew service is one). For now, start it from a Terminal shell or
   from the relay, which is how the dev loop runs.

## Not verified here

- That an sshd session lacks `$TMPDIR`. It is widely reported, but not tested here. The rule no
  longer depends on it.
- Whether dirhelper removes sockets under `/var/folders/…/T`. Moot now.
- Keychain access from a daemon first started over ssh.
- The real Terminal.app's environment. Driving it with `osascript` waits on a macOS
  Automation consent prompt, so T was rebuilt as described above. To capture it, run
  `env | sort` in a new Terminal.app window.

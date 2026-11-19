package main

// attach — live terminal adapter. Connects a g3d-termd terminal to a glyph3d display: the
// terminal's raw output streams into the display as a 3D TerminalGrid (rendered browser-side
// by a headless VT emulator), and the display's input, resizes, scrolls and repaints go back
// to termd.
//
//	glyph3d-cli attach [flags] <id> [-- <cmd...>]
//
// The adapter connects to the relay as a controller (standard ping/OK/pong handshake),
// issues `terminal.create <id> <cols> <rows>` so the browser spawns a TerminalGrid (recording
// THIS controller as the terminal's owner), then creates-or-adopts terminal <id> in termd and
// subscribes to it as its size's owner (the display owns the size). OUTPUT rides a binary
// data-plane frame; INPUT rides the existing JSON push. termd is unix-only, so the adapter
// is too (attach_windows.go says so on Windows).

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// terminalConfig is the parsed invocation, handed to the platform-specific runTerminal
// (attach_unix.go / attach_windows.go).
type terminalConfig struct {
	url          string
	id           string
	termdID      string
	noCreate     bool
	detachOnKill bool
	flow         string
	cols         int
	rows         int
	scale        float64
	cmdArgs      []string // empty: termd starts the account's shell (DESIGN.md, "The shell, and login or not")
	cwd          string   // empty: termd starts it in the account's home
}

// remoteTermdID is the terminal id addressed inside termd (--termd-id when given, else id).
// Display-facing messages always address cfg.id so a cross-namespace agent terminal (agent-foo)
// can appear under a distinct display id (gx-foo).
func (cfg terminalConfig) remoteTermdID() string {
	if cfg.termdID != "" {
		return cfg.termdID
	}
	return cfg.id
}

type attachGlobals struct {
	ns         string
	termd      string
	reconnect  time.Duration
	pasteChunk int
	pasteQueue int
}

func parseAttachArgs(raw []string, defNS string) (terminalConfig, string, error) {
	g := attachGlobals{
		ns:         defNS,
		termd:      termdBin,
		reconnect:  termdReconnectWindow,
		pasteChunk: termdPasteChunk,
		pasteQueue: termdPasteQueue,
	}
	cfg, err := parseAttachArgsWithGlobals(raw, &g)
	return cfg, g.ns, err
}

func parseAttachArgsWithGlobals(raw []string, g *attachGlobals) (terminalConfig, error) {
	fs := flag.NewFlagSet("attach", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	wsURL := fs.String("host", "ws://localhost:8080", "WebSocket relay URL")
	p := fs.Int("port", 0, "Shorthand: ws://localhost:<port>")
	cols := fs.Int("cols", 80, "Terminal columns")
	rows := fs.Int("rows", 24, "Terminal rows")
	scale := fs.Float64("scale", 2.0, "TerminalGrid size multiplier")
	termdID := fs.String("termd-id", "", "termd terminal id when distinct from <id>")
	noCreate := fs.Bool("no-create", false, "subscribe to an existing termd terminal without starting termd or calling create")
	detachOnKill := fs.Bool("detach-on-kill", false, "close the display grid without killing the termd terminal on terminal.kill")
	flow := fs.String("flow", "", "termd subscription flow control: block or lossy")
	fs.StringVar(&g.ns, "termd-ns", g.ns, "termd namespace the terminal lives in")
	fs.StringVar(&g.termd, "termd", g.termd, "g3d-termd binary to start when none runs (default: beside this binary, then PATH)")
	fs.DurationVar(&g.reconnect, "termd-reconnect", g.reconnect, "how long to ride out a termd brain restart before giving the terminal up as lost")
	fs.IntVar(&g.pasteChunk, "paste-chunk", g.pasteChunk, "the most text, in bytes, one termd paste request carries (a longer paste streams as several)")
	fs.IntVar(&g.pasteQueue, "paste-queue", g.pasteQueue, "the most of the display's pastes, in bytes, that waits here for a program that isn't reading; a paste past it is refused")
	cwd := fs.String("cwd", "", "Where a new terminal's program starts (default: the account's home)")

	// Grammar: <id> [flags...] [-- <cmd...>]. The id comes first; flags may follow it;
	// an explicit command goes after a bare "--" (or as trailing positionals). We pull
	// the id out by hand and parse flags AFTER it — a plain flag.Parse(os.Args[2:])
	// would stop dead at <id> and silently drop every flag.
	if len(raw) < 1 || strings.HasPrefix(raw[0], "-") {
		return terminalConfig{}, fmt.Errorf("missing terminal id")
	}
	id := raw[0]
	rest := raw[1:]
	var explicitCmd []string
	flagTokens := rest
	for i, t := range rest {
		if t == "--" {
			flagTokens = rest[:i]
			explicitCmd = rest[i+1:]
			break
		}
	}
	if err := fs.Parse(flagTokens); err != nil {
		return terminalConfig{}, err
	}

	cmdArgs := explicitCmd
	if len(cmdArgs) == 0 {
		cmdArgs = fs.Args() // trailing positionals, e.g. `attach t1 bash -l`
	}

	if *cols < 1 || *rows < 1 {
		return terminalConfig{}, fmt.Errorf("cols and rows must be positive")
	}
	if !validTerminalID(id) {
		return terminalConfig{}, fmt.Errorf("terminal id %q must be 1 to 64 bytes of [A-Za-z0-9._-]", id)
	}
	if *termdID != "" && !validTerminalID(*termdID) {
		return terminalConfig{}, fmt.Errorf("termd-id %q must be 1 to 64 bytes of [A-Za-z0-9._-]", *termdID)
	}
	if !validTerminalID(g.ns) {
		return terminalConfig{}, fmt.Errorf("termd-ns %q must be 1 to 64 bytes of [A-Za-z0-9._-]", g.ns)
	}
	if *flow != "" && *flow != "block" && *flow != "lossy" {
		return terminalConfig{}, fmt.Errorf("flow %q must be block or lossy", *flow)
	}
	if *noCreate && len(cmdArgs) > 0 {
		return terminalConfig{}, fmt.Errorf("--no-create cannot be combined with a command")
	}

	url := *wsURL
	if *p > 0 {
		url = fmt.Sprintf("ws://localhost:%d", *p)
	}

	return terminalConfig{
		url:          url,
		id:           id,
		termdID:      *termdID,
		noCreate:     *noCreate,
		detachOnKill: *detachOnKill,
		flow:         *flow,
		cols:         *cols,
		rows:         *rows,
		scale:        *scale,
		cmdArgs:      cmdArgs,
		cwd:          *cwd,
	}, nil
}

// attachCmd is the entry point for `glyph3d-cli attach`.
func attachCmd() {
	usage := func() {
		fmt.Fprintln(os.Stderr, "usage: glyph3d-cli attach <id> [flags] [-- <cmd...>]")
		fmt.Fprintln(os.Stderr, "  flags: --host --port --cols --rows --scale --cwd --termd-ns --termd-id --no-create --detach-on-kill --flow --termd --termd-reconnect")
		fmt.Fprintln(os.Stderr, "  with no command, termd starts the account's shell as a login shell")
		fmt.Fprintln(os.Stderr, "  e.g.:  glyph3d-cli attach t1 --cols 100 --rows 30 -- ssh host")
	}

	raw := os.Args[2:]
	if len(raw) < 1 || strings.HasPrefix(raw[0], "-") {
		usage()
		os.Exit(2)
	}
	g := attachGlobals{
		ns:         termdNS,
		termd:      termdBin,
		reconnect:  termdReconnectWindow,
		pasteChunk: termdPasteChunk,
		pasteQueue: termdPasteQueue,
	}
	cfg, err := parseAttachArgsWithGlobals(raw, &g)
	if err != nil {
		fmt.Fprintf(os.Stderr, "attach: %v\n", err)
		os.Exit(2)
	}
	termdNS = g.ns
	termdBin = g.termd
	termdReconnectWindow = g.reconnect
	termdPasteChunk = g.pasteChunk
	termdPasteQueue = g.pasteQueue

	runTerminal(cfg)
}

// decodeRelayText extracts human-readable text from a relay message that may be
// either a JSON {response,...} envelope or a plain string.
func decodeRelayText(msg []byte) string {
	var resp struct {
		Response string `json:"response"`
	}
	if json.Unmarshal(msg, &resp) == nil && resp.Response != "" {
		return resp.Response
	}
	return string(msg)
}

// validTerminalID reports whether id is a termd terminal id: 1 to 64 bytes of [A-Za-z0-9._-].
func validTerminalID(id string) bool {
	if len(id) == 0 || len(id) > 64 {
		return false
	}
	for _, r := range id {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.') {
			return false
		}
	}
	return true
}

// terminalIDPart makes a name safe inside a termd terminal id: every byte outside
// [A-Za-z0-9._-] becomes '_', and it is cut to max bytes.
func terminalIDPart(name string, max int) string {
	var b strings.Builder
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			b.WriteRune(r)
		} else {
			b.WriteRune('_')
		}
	}
	out := b.String()
	if out == "" {
		out = "default"
	}
	if len(out) > max {
		out = out[:max]
	}
	return out
}

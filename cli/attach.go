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
	"os"
	"strings"
)

// terminalConfig is the parsed invocation, handed to the platform-specific runTerminal
// (attach_unix.go / attach_windows.go).
type terminalConfig struct {
	url     string
	id      string
	cols    int
	rows    int
	scale   float64
	cmdArgs []string
}

// attachCmd is the entry point for `glyph3d-cli attach`.
func attachCmd() {
	fs := flag.NewFlagSet("attach", flag.ExitOnError)
	wsURL := fs.String("host", "ws://localhost:8080", "WebSocket relay URL")
	p := fs.Int("port", 0, "Shorthand: ws://localhost:<port>")
	cols := fs.Int("cols", 80, "Terminal columns")
	rows := fs.Int("rows", 24, "Terminal rows")
	scale := fs.Float64("scale", 2.0, "TerminalGrid size multiplier")
	fs.StringVar(&termdNS, "termd-ns", termdNS, "termd namespace the terminal lives in")
	fs.StringVar(&termdBin, "termd", termdBin, "g3d-termd binary to start when none runs (default: beside this binary, then PATH)")
	fs.DurationVar(&termdReconnectWindow, "termd-reconnect", termdReconnectWindow, "how long to ride out a termd brain restart before giving the terminal up as lost")

	usage := func() {
		fmt.Fprintln(os.Stderr, "usage: glyph3d-cli attach <id> [flags] [-- <cmd...>]")
		fmt.Fprintln(os.Stderr, "  flags: --host --port --cols --rows --scale --termd-ns --termd --termd-reconnect")
		fmt.Fprintln(os.Stderr, "  e.g.:  glyph3d-cli attach t1 --cols 100 --rows 30 -- ssh host")
	}

	// Grammar: <id> [flags...] [-- <cmd...>]. The id comes first; flags may follow it;
	// an explicit command goes after a bare "--" (or as trailing positionals). We pull
	// the id out by hand and parse flags AFTER it — a plain flag.Parse(os.Args[2:])
	// would stop dead at <id> and silently drop every flag.
	raw := os.Args[2:]
	if len(raw) < 1 || strings.HasPrefix(raw[0], "-") {
		usage()
		os.Exit(2)
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
	fs.Parse(flagTokens)

	cmdArgs := explicitCmd
	if len(cmdArgs) == 0 {
		cmdArgs = fs.Args() // trailing positionals, e.g. `attach t1 bash -l`
	}
	if len(cmdArgs) == 0 {
		shell := os.Getenv("SHELL")
		if shell == "" {
			shell = "bash"
		}
		cmdArgs = []string{shell}
	}

	if *cols < 1 || *rows < 1 {
		fmt.Fprintln(os.Stderr, "attach: cols and rows must be positive")
		os.Exit(2)
	}
	if !validTerminalID(id) {
		fmt.Fprintf(os.Stderr, "attach: terminal id %q must be 1 to 64 bytes of [A-Za-z0-9._-]\n", id)
		os.Exit(2)
	}

	url := *wsURL
	if *p > 0 {
		url = fmt.Sprintf("ws://localhost:%d", *p)
	}

	runTerminal(terminalConfig{
		url:     url,
		id:      id,
		cols:    *cols,
		rows:    *rows,
		scale:   *scale,
		cmdArgs: cmdArgs,
	})
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

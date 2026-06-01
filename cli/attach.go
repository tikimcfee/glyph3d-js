package main

// attach — live terminal adapter. Drives a tmux session over a PTY and streams its
// raw byte output into a glyph3d display as a 3D TerminalGrid (rendered browser-side
// by a headless VT emulator). Input flows back as raw bytes to the PTY master.
//
//	glyph3d-cli attach [flags] <id> [-- <cmd...>]
//
// The adapter connects to the relay as a controller (standard ping/OK/pong
// handshake), issues `terminal.create <id> <cols> <rows>` so the browser spawns a
// TerminalGrid (recording THIS controller as the terminal's owner), then attaches a
// PTY to a tmux session and pumps its byte stream both ways. OUTPUT rides a binary
// data-plane frame; INPUT rides the existing JSON push. The PTY + tmux work is
// unix-only (attach_unix.go); attach_windows.go stubs it so the CGO_ENABLED=0
// windows cross-compile stays green (terminals are a non-Windows feature).

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
)

// terminalConfig is the parsed invocation, handed to the platform-specific
// runTerminal (attach_unix.go / attach_windows.go).
type terminalConfig struct {
	url     string
	id      string
	session string
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

	usage := func() {
		fmt.Fprintln(os.Stderr, "usage: glyph3d-cli attach <id> [flags] [-- <cmd...>]")
		fmt.Fprintln(os.Stderr, "  flags: --host --port --cols --rows --scale")
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

	url := *wsURL
	if *p > 0 {
		url = fmt.Sprintf("ws://localhost:%d", *p)
	}

	runTerminal(terminalConfig{
		url:     url,
		id:      id,
		session: "glyph-" + sanitizeSession(id),
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

// sanitizeSession makes a tmux-safe session suffix from a terminal id.
func sanitizeSession(id string) string {
	var b strings.Builder
	for _, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteRune('_')
		}
	}
	if b.Len() == 0 {
		return "default"
	}
	return b.String()
}

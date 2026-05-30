package main

// attach — live terminal adapter. Drives a tmux session and streams its
// rendered screen into a glyph3d display as a 3D TerminalGrid.
//
//	glyph3d-cli attach [flags] <id> [-- <cmd...>]
//
// The adapter connects to the relay as a controller (reusing the standard
// ping/OK/pong handshake), issues `terminal.create <id> <cols> <rows>` so the
// browser display spawns a TerminalGrid (and records THIS controller as the
// terminal's owner), then spawns the command inside a detached tmux session and
// pumps `tmux capture-pane -p -e` snapshots back as `terminal.frame` commands at
// a fixed rate.
//
// Why tmux: the renderer's parser (parseCapturePaneAnsi) is a STATELESS
// full-screen snapshot consumer — it understands SGR color but discards all
// cursor-motion / scroll / alt-screen sequences. A raw PTY byte stream would
// render as garbage. tmux IS the terminal emulator; capture-pane -e gives us
// exactly the final-screen-plus-SGR snapshot the parser was built for, and we
// get session persistence and reconnect for free.
//
// This commit is display-only: it renders a live session on the canvas with NO
// browser changes. Keystroke return (canvas → tmux send-keys) is a later commit.

import (
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// attachCmd is the entry point for `glyph3d-cli attach`.
func attachCmd() {
	fs := flag.NewFlagSet("attach", flag.ExitOnError)
	wsURL := fs.String("host", "ws://localhost:8080", "WebSocket relay URL")
	p := fs.Int("port", 0, "Shorthand: ws://localhost:<port>")
	cols := fs.Int("cols", 80, "Terminal columns")
	rows := fs.Int("rows", 24, "Terminal rows")
	fps := fs.Float64("fps", 15, "Frame capture rate (Hz)")
	scale := fs.Float64("scale", 2.0, "TerminalGrid size multiplier")

	usage := func() {
		fmt.Fprintln(os.Stderr, "usage: glyph3d-cli attach <id> [flags] [-- <cmd...>]")
		fmt.Fprintln(os.Stderr, "  flags: --host --port --cols --rows --fps --scale")
		fmt.Fprintln(os.Stderr, "  e.g.:  glyph3d-cli attach t1 --cols 100 --rows 30 -- ssh host")
	}

	// Grammar: <id> [flags...] [-- <cmd...>]. The id comes first; flags may follow
	// it; an explicit command goes after a bare "--" (or as trailing positionals).
	// We pull the id out by hand and parse flags AFTER it — a plain
	// flag.Parse(os.Args[2:]) would stop dead at <id> and silently drop every flag.
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
		log.Fatalf("attach: cols and rows must be positive")
	}
	if *fps <= 0 {
		log.Fatalf("attach: fps must be positive")
	}

	url := *wsURL
	if *p > 0 {
		url = fmt.Sprintf("ws://localhost:%d", *p)
	}

	// tmux session name, namespaced to us and sanitized (tmux dislikes . and :).
	session := "glyph-" + sanitizeSession(id)

	// --- Connect as a controller (handshake consumed inside connect) ---
	conn, err := connect(url)
	if err != nil {
		log.Fatalf("attach: connect: %v", err)
	}
	defer conn.Close()

	// One write goroutine's worth of safety: all sends go through this mutex so a
	// future inbound-event handler can also write without racing the frame pump.
	var sendMu sync.Mutex
	send := func(cmd string) error {
		sendMu.Lock()
		defer sendMu.Unlock()
		return conn.WriteMessage(websocket.TextMessage, []byte(cmd))
	}

	// --- Create the TerminalGrid in the display, synchronously confirm ---
	createCmd := fmt.Sprintf("terminal.create %s %d %d --scale %g", id, *cols, *rows, *scale)
	if err := send(createCmd); err != nil {
		log.Fatalf("attach: send create: %v", err)
	}
	conn.SetReadDeadline(time.Now().Add(*timeout))
	_, ackMsg, err := conn.ReadMessage()
	conn.SetReadDeadline(time.Time{})
	if err != nil {
		log.Fatalf("attach: awaiting create ack: %v", err)
	}
	ack := decodeRelayText(ackMsg)
	if strings.HasPrefix(ack, "ERR:") {
		// Most common: no browser display connected yet. Fail loud and helpful.
		log.Fatalf("attach: terminal.create failed: %s\n  (open the viewer in a browser first so there is a display to render into)", ack)
	}
	fmt.Fprintf(os.Stderr, "[attach] %s\n", ack)

	// --- Spawn the command inside a fresh detached, sized tmux session ---
	// Kill any stale session of the same (namespaced) name first — ignore errors.
	exec.Command("tmux", "kill-session", "-t", session).Run()
	newArgs := []string{"new-session", "-d", "-s", session, "-x", strconv.Itoa(*cols), "-y", strconv.Itoa(*rows)}
	newArgs = append(newArgs, cmdArgs...)
	newSess := exec.Command("tmux", newArgs...)
	newSess.Stderr = os.Stderr
	if err := newSess.Run(); err != nil {
		log.Fatalf("attach: tmux new-session: %v", err)
	}
	fmt.Fprintf(os.Stderr, "[attach] tmux session '%s' running: %s\n", session, strings.Join(cmdArgs, " "))

	// --- Lifecycle: signals, reader, frame pump all converge on `done` ---
	done := make(chan struct{})
	var closeOnce sync.Once
	shutdown := func() { closeOnce.Do(func() { close(done) }) }

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Fprintln(os.Stderr, "\n[attach] shutting down")
		shutdown()
	}()

	// Reader: drain everything the relay sends. Carries {event:"terminal.input"}
	// keystroke pushes (→ tmux send-keys) plus command responses.
	go func() {
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				shutdown()
				return
			}
			handleInbound(msg, id, session)
		}
	}()

	// Frame pump: capture-pane on a fixed cadence, send only on change.
	go func() {
		ticker := time.NewTicker(time.Duration(float64(time.Second) / *fps))
		defer ticker.Stop()
		var last string
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				out, err := capturePane(session)
				if err != nil {
					// Session gone (shell exited / killed) → end the adapter.
					fmt.Fprintf(os.Stderr, "[attach] session ended: %v\n", err)
					shutdown()
					return
				}
				if out == last {
					continue
				}
				last = out
				b64 := base64.StdEncoding.EncodeToString([]byte(out))
				if err := send("terminal.frame " + id + " " + b64); err != nil {
					shutdown()
					return
				}
			}
		}
	}()

	<-done

	// Best-effort teardown: remove the grid from the display, kill the session.
	conn.SetWriteDeadline(time.Now().Add(time.Second))
	send("terminal.close " + id)
	exec.Command("tmux", "kill-session", "-t", session).Run()
}

// capturePane returns the rendered screen of the tmux session as text with SGR
// color escapes (-e) printed to stdout (-p). Errors when the session is gone.
func capturePane(session string) (string, error) {
	out, err := exec.Command("tmux", "capture-pane", "-p", "-e", "-t", session).Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// handleInbound dispatches a message the relay forwarded to this controller.
// The keystroke-return channel arrives as {event:"terminal.input", data:{terminalId,text}}
// (browser keydown → grid.onInput → wsbridge.push → relay passthrough → here);
// we inject the bytes into the tmux session via send-keys, closing the loop.
func handleInbound(msg []byte, termID, session string) {
	var ev struct {
		Event string `json:"event"`
		Data  struct {
			TerminalID string `json:"terminalId"`
			Text       string `json:"text"`
		} `json:"data"`
	}
	if json.Unmarshal(msg, &ev) == nil && ev.Event != "" {
		if ev.Event == "terminal.input" {
			// Ignore input addressed to a different terminal (one adapter, one id).
			if ev.Data.TerminalID != "" && ev.Data.TerminalID != termID {
				return
			}
			if err := sendKeysToTmux(session, ev.Data.Text); err != nil {
				log.Printf("[attach] send-keys: %v", err)
			}
		}
		return
	}
	// Otherwise a command response or plain text; only surface errors.
	text := decodeRelayText(msg)
	if strings.HasPrefix(text, "ERR:") {
		log.Printf("[attach] %s", text)
	}
}

// sendKeysToTmux injects raw bytes into the tmux session. Uses `send-keys -H`
// (hex) so control bytes, escape sequences (arrows/Home/End), and UTF-8 all go
// through verbatim without shell/keyname quoting ambiguity. Each byte of the
// (already UTF-8) string becomes one space-separated hex token.
func sendKeysToTmux(session, text string) error {
	if text == "" {
		return nil
	}
	args := make([]string, 0, 3+len(text))
	args = append(args, "send-keys", "-t", session, "-H")
	for i := 0; i < len(text); i++ {
		args = append(args, fmt.Sprintf("%02x", text[i]))
	}
	return exec.Command("tmux", args...).Run()
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

//go:build !windows

package main

import (
	"encoding/base64"
	"encoding/json"
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

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

// glyphdSocket is the dedicated tmux socket (`tmux -L glyphd`). Isolating our
// sessions lets us neutralize the client keymap without touching the operator's own
// tmux, and namespaces persistence/adoption.
const glyphdSocket = "glyphd"

// frameOutput is the type byte of an OUTPUT data-plane frame (adapter → display):
//
//	[frameOutput:u8][idLen:u8][id:utf8][raw VT bytes]
//
// The relay forwards these binary frames verbatim; the browser parses the header and
// feeds the payload to the terminal's headless VT emulator.
const frameOutput = 0x01

// coalesceInterval bounds the OUTPUT message rate: bytes arriving within a window are
// batched into one frame (~one display frame).
const coalesceInterval = 16 * time.Millisecond

// tmuxCmd builds a tmux command pinned to our dedicated socket.
func tmuxCmd(args ...string) *exec.Cmd {
	return exec.Command("tmux", append([]string{"-L", glyphdSocket}, args...)...)
}

// paneScrollPosition returns how many lines the pane is scrolled BACK from live
// (0 = at the bottom / live). `#{scroll_position}` is empty when not in copy-mode,
// which parses to 0 — exactly the "at live" answer we want.
func paneScrollPosition(session string) int {
	out, err := tmuxCmd("display-message", "-p", "-t", session, "#{scroll_position}").Output()
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	return n
}

// runTerminal connects to the relay, creates the display grid, attaches a PTY to a
// tmux session, and runs the bidirectional byte pump until shutdown.
func runTerminal(cfg terminalConfig) {
	conn, err := connect(cfg.url)
	if err != nil {
		log.Fatalf("attach: connect: %v", err)
	}
	defer conn.Close()

	// All WS writes (text control + binary output) serialize through one mutex —
	// gorilla/websocket permits only one concurrent writer.
	var sendMu sync.Mutex
	sendText := func(s string) error {
		sendMu.Lock()
		defer sendMu.Unlock()
		return conn.WriteMessage(websocket.TextMessage, []byte(s))
	}
	sendBytes := func(b []byte) error {
		sendMu.Lock()
		defer sendMu.Unlock()
		return conn.WriteMessage(websocket.BinaryMessage, b)
	}

	// Create the grid in the display, confirm synchronously. Idempotent browser-side,
	// so re-adoption can re-send this verbatim.
	createCmd := fmt.Sprintf("terminal.create %s %d %d --scale %g", cfg.id, cfg.cols, cfg.rows, cfg.scale)
	if err := sendText(createCmd); err != nil {
		log.Fatalf("attach: send create: %v", err)
	}
	conn.SetReadDeadline(time.Now().Add(*timeout))
	_, ackMsg, err := conn.ReadMessage()
	conn.SetReadDeadline(time.Time{})
	if err != nil {
		log.Fatalf("attach: awaiting create ack: %v", err)
	}
	if ack := decodeRelayText(ackMsg); strings.HasPrefix(ack, "ERR:") {
		log.Fatalf("attach: terminal.create failed: %s\n  (open the viewer in a browser first so there is a display to render into)", ack)
	} else {
		fmt.Fprintf(os.Stderr, "[attach] %s\n", ack)
	}

	// Create-or-adopt the tmux session, then attach a PTY to it.
	if err := ensureTmuxSession(cfg); err != nil {
		log.Fatalf("attach: tmux session: %v", err)
	}
	ptmx, err := startTmuxAttach(cfg)
	if err != nil {
		log.Fatalf("attach: pty: %v", err)
	}
	defer func() { _ = ptmx.Close() }()
	fmt.Fprintf(os.Stderr, "[attach] tmux '%s' attached over PTY: %s\n", cfg.session, strings.Join(cfg.cmdArgs, " "))

	// Lifecycle: signals, reader, liveness, and the output pump all converge on `done`.
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

	// Re-adoption: a display reload wipes its terminal registry, so terminal.ping
	// starts bouncing "ERR: no terminal <id>". Re-issue terminal.create so the fresh
	// display rebuilds the grid (owner = us → input still routes), then force tmux to
	// repaint the full screen into the new emulator. Cooldown avoids create-spam.
	var lastRecreate time.Time
	recreate := func() {
		if time.Since(lastRecreate) < 2*time.Second {
			return
		}
		lastRecreate = time.Now()
		fmt.Fprintln(os.Stderr, "[attach] display lost the terminal — re-creating")
		if err := sendText(createCmd); err != nil {
			log.Printf("[attach] re-create send failed: %v", err)
			return
		}
		tmuxCmd("refresh-client").Run() // repaint the current screen into the fresh emulator
	}

	// Scrollback is tmux-owned: wheel-gated scroll from the focused terminal arrives as
	// terminal.scroll (+lines = back into history, −lines = forward to live). scroll-up
	// enters copy-mode (it's a copy-mode-only command); scroll-down walks back toward
	// live. The resulting repaint streams back through the normal output lane.
	//
	// Two traps this handles (both because we unbound the copy-mode keytable, so the
	// user can't escape it the normal way and typing into copy-mode does NOTHING):
	//   1. scroll-down does NOT auto-exit at the bottom — it clamps at scroll_position 0
	//      and stays in copy-mode. So after a forward scroll we leave copy-mode once at
	//      the bottom, returning the pane to live + typeable.
	//   2. typing while scrolled would be swallowed → exitScroll() snaps back to live
	//      before any keystroke is written (called from the terminal.bytes path).
	// scrolledBack is touched only from the single INPUT goroutine (scroll + exitScroll
	// both run there), so no lock is needed.
	scrolledBack := false
	cancelCopyMode := func() {
		tmuxCmd("send-keys", "-t", cfg.session, "-X", "cancel").Run()
		scrolledBack = false
	}
	scroll := func(lines int) {
		if lines == 0 {
			return
		}
		if lines > 0 {
			tmuxCmd("copy-mode", "-t", cfg.session).Run()
			tmuxCmd("send-keys", "-t", cfg.session, "-X", "-N", strconv.Itoa(lines), "scroll-up").Run()
			scrolledBack = true
			return
		}
		if !scrolledBack {
			return // already live — a forward scroll is a no-op (don't enter copy-mode)
		}
		tmuxCmd("send-keys", "-t", cfg.session, "-X", "-N", strconv.Itoa(-lines), "scroll-down").Run()
		if paneScrollPosition(cfg.session) <= 0 {
			cancelCopyMode() // reached live — leave copy-mode so the shell is typeable again
		}
	}
	// Snap back to live before delivering a keystroke — otherwise the byte lands in
	// copy-mode (whose keytable we unbound) and silently vanishes.
	exitScroll := func() {
		if scrolledBack {
			cancelCopyMode()
		}
	}

	// INPUT goroutine: drain the relay. Carries terminal.bytes (→ PTY), resize,
	// shutdown, and the ping bounce that triggers re-adoption. Kept separate from the
	// output pump so a blocked output write can never stall input (deadlock).
	go func() {
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				shutdown()
				return
			}
			handleInbound(msg, cfg.id, ptmx, shutdown, recreate, scroll, exitScroll)
		}
	}()

	// LIVENESS goroutine: a cheap probe DECOUPLED from output — an idle shell emits no
	// bytes, so only this makes a reloaded display's "no terminal" reply (→ re-adopt)
	// fire. Doubles as a dead-relay detector.
	go func() {
		t := time.NewTicker(2 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				if err := sendText("terminal.ping " + cfg.id); err != nil {
					shutdown()
					return
				}
			}
		}
	}()

	// OUTPUT pump: PTY reader → coalescer → binary OUTPUT frame.
	chunks := make(chan []byte, 64)
	go func() {
		defer shutdown() // PTY EOF (tmux client gone / session killed) ends the adapter
		buf := make([]byte, 32*1024)
		for {
			n, rerr := ptmx.Read(buf)
			if n > 0 {
				c := make([]byte, n)
				copy(c, buf[:n])
				select {
				case chunks <- c:
				case <-done:
					return
				}
			}
			if rerr != nil {
				return
			}
		}
	}()
	go func() {
		ticker := time.NewTicker(coalesceInterval)
		defer ticker.Stop()
		var acc []byte
		flush := func() bool {
			if len(acc) == 0 {
				return true
			}
			if err := sendBytes(encodeOutputFrame(cfg.id, acc)); err != nil {
				return false
			}
			acc = acc[:0]
			return true
		}
		for {
			select {
			case <-done:
				return
			case c, ok := <-chunks:
				if !ok {
					return
				}
				acc = append(acc, c...)
				if len(acc) >= 16*1024 { // flush promptly under a flood, don't wait the full window
					if !flush() {
						shutdown()
						return
					}
				}
			case <-ticker.C:
				if !flush() {
					shutdown()
					return
				}
			}
		}
	}()

	<-done

	// Teardown: drop the display grid and kill the tmux session. (The session survives
	// a BROWSER reload because this adapter survives it — re-adopt handles that. We
	// only reach here on signal / terminal.kill / PTY EOF / relay loss, where killing
	// the session is the correct cleanup.)
	conn.SetWriteDeadline(time.Now().Add(time.Second))
	sendText("terminal.close " + cfg.id)
	tmuxCmd("kill-session", "-t", cfg.session).Run()
}

// ensureTmuxSession creates the session if absent (NOT `new -A -d`, which errors on
// an existing session), then neutralizes the client so the PTY is a transparent
// byte-pipe. PHASE 3: tmux -CC control mode deletes all the keymap neutralization
// (a control client has no keymap to lobotomize) — graduate to it for multi-pane.
func ensureTmuxSession(cfg terminalConfig) error {
	if err := tmuxCmd("has-session", "-t", cfg.session).Run(); err != nil {
		args := []string{"new-session", "-d", "-s", cfg.session, "-x", strconv.Itoa(cfg.cols), "-y", strconv.Itoa(cfg.rows)}
		args = append(args, cfg.cmdArgs...)
		c := tmuxCmd(args...)
		c.Stderr = os.Stderr
		if err := c.Run(); err != nil {
			return fmt.Errorf("new-session: %w", err)
		}
	}
	// Server-wide options are safe — the socket is dedicated to us.
	tmuxCmd("set-option", "-g", "status", "off").Run()
	tmuxCmd("set-option", "-g", "window-size", "latest").Run() // single client's SIGWINCH drives the window
	tmuxCmd("set-option", "-g", "prefix", "None").Run()
	tmuxCmd("set-option", "-g", "prefix2", "None").Run()
	for _, table := range []string{"prefix", "root", "copy-mode", "copy-mode-vi"} {
		tmuxCmd("unbind-key", "-a", "-T", table).Run()
	}
	return nil
}

// startTmuxAttach opens a PTY running `tmux -L glyphd attach`. TERM on the client
// determines what escape sequences tmux emits to us; xterm-256color is what
// @xterm/headless parses cleanly. Resize is SIGWINCH-only (pty.Setsize) — never
// `tmux resize-window` (it flips window-size to manual and then ignores SIGWINCH).
func startTmuxAttach(cfg terminalConfig) (*os.File, error) {
	c := tmuxCmd("attach", "-t", cfg.session)
	c.Env = append(os.Environ(), "TERM=xterm-256color")
	ptmx, err := pty.Start(c)
	if err != nil {
		return nil, err
	}
	if err := pty.Setsize(ptmx, &pty.Winsize{Cols: uint16(cfg.cols), Rows: uint16(cfg.rows)}); err != nil {
		log.Printf("[attach] initial pty size: %v", err)
	}
	return ptmx, nil
}

// encodeOutputFrame builds an OUTPUT data-plane frame: [type][idLen][id][payload].
func encodeOutputFrame(id string, payload []byte) []byte {
	idb := []byte(id)
	frame := make([]byte, 2+len(idb)+len(payload))
	frame[0] = frameOutput
	frame[1] = byte(len(idb))
	copy(frame[2:], idb)
	copy(frame[2+len(idb):], payload)
	return frame
}

// handleInbound dispatches a relay message to this adapter. Events (display →
// controller push): terminal.bytes (input → PTY), terminal.resize (→ SIGWINCH),
// terminal.shutdown (graceful teardown). Command responses also land here; an
// "ERR: no terminal" reply (to our liveness ping) means the display reloaded → re-adopt.
func handleInbound(msg []byte, termID string, ptmx *os.File, shutdown func(), recreate func(), scroll func(int), exitScroll func()) {
	var ev struct {
		Event string `json:"event"`
		Data  struct {
			TerminalID string `json:"terminalId"`
			B64        string `json:"b64"`
			Cols       int    `json:"cols"`
			Rows       int    `json:"rows"`
			Lines      int    `json:"lines"`
		} `json:"data"`
	}
	if json.Unmarshal(msg, &ev) == nil && ev.Event != "" {
		if ev.Data.TerminalID != "" && ev.Data.TerminalID != termID {
			return // an event for a different terminal is never ours (one adapter, one id)
		}
		switch ev.Event {
		case "terminal.bytes": // INPUT: raw bytes → PTY master
			if b, derr := base64.StdEncoding.DecodeString(ev.Data.B64); derr == nil {
				if exitScroll != nil {
					exitScroll() // a keystroke snaps a scrolled-back pane to live (else it's swallowed)
				}
				if _, werr := ptmx.Write(b); werr != nil {
					log.Printf("[attach] pty write: %v", werr)
				}
			}
		case "terminal.resize":
			if ev.Data.Cols > 0 && ev.Data.Rows > 0 {
				pty.Setsize(ptmx, &pty.Winsize{Cols: uint16(ev.Data.Cols), Rows: uint16(ev.Data.Rows)})
			}
		case "terminal.scroll": // wheel-gated tmux copy-mode scroll (+back / -forward)
			if scroll != nil {
				scroll(ev.Data.Lines)
			}
		case "terminal.shutdown":
			fmt.Fprintln(os.Stderr, "[attach] shutdown requested by display")
			shutdown()
		}
		return
	}
	text := decodeRelayText(msg)
	if strings.HasPrefix(text, "ERR:") {
		if recreate != nil && strings.Contains(text, "no terminal") {
			recreate()
			return
		}
		if strings.Contains(text, "no display") {
			return // expected while the browser is mid-reload; don't spam
		}
		log.Printf("[attach] %s", text)
	}
}

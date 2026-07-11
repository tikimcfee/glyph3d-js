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
	"sync/atomic"
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
//	[frameOutput:u8][idLen:u8][id:utf8][cols:u16 BE][rows:u16 BE][raw VT bytes]
//
// cols/rows are the size tmux DREW this payload at. They ride WITH the content so the display
// resizes its emulator to match right before parsing the bytes — size and redraw travel on one
// ordered channel and can never reorder. (Our emulator is in the browser and tmux is across a
// WebSocket, so a locally-applied resize used to race ahead of the redraws still in flight and
// crash xterm; tagging the content is the fix.) The relay forwards frames verbatim; the browser
// parses the header and feeds the payload to the terminal's headless VT emulator.
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

// paneScreenMode reports the pane's live VT mode straight from tmux (the source of
// truth — the app negotiated these with tmux, not with us): whether the ALTERNATE
// screen is active (a full-screen TUI), and whether the app requested SGR mouse
// reporting (DECSET 1006). The downstream display can't see these, so the decision of
// how a wheel gesture is realized has to be made here, where the flags actually live.
func paneScreenMode(session string) (alt, sgr bool) {
	out, err := tmuxCmd("display-message", "-p", "-t", session, "#{alternate_on},#{mouse_sgr_flag}").Output()
	if err != nil {
		return false, false
	}
	f := strings.Split(strings.TrimSpace(string(out)), ",")
	if len(f) == 2 {
		alt = f[0] == "1"
		sgr = f[1] == "1"
	}
	return
}

// forwardWheelToApp realizes a wheel gesture for an ALT-SCREEN app. Such apps own the
// screen and have NO tmux scrollback — driving copy-mode there is meaningless ([0/0])
// and worse, it traps the app in copy-mode and swallows its input. So the wheel goes
// straight to the app's PTY instead: SGR mouse-wheel events when the app asked for
// mouse mode (claude, vim ttymouse=sgr — it scrolls its OWN content), else arrow keys
// (pagers like less/man — the behaviour xterm calls "alternateScroll"). `lines` follows
// the scroll convention: >0 = back/up, <0 = forward/down; |lines| notches are sent.
func forwardWheelToApp(ptmx *os.File, lines int, sgr bool, cols, rows int) {
	n, up := lines, lines > 0
	if n < 0 {
		n = -n
	}
	var notch string
	if sgr {
		// SGR (1006): ESC[<btn;col;row M, press-only. Wheel up=64, down=65. The coordinate
		// barely matters for a wheel event; aim at the pane centre so it lands inside it.
		col, row := cols/2, rows/2
		if col < 1 {
			col = 1
		}
		if row < 1 {
			row = 1
		}
		btn := 65
		if up {
			btn = 64
		}
		notch = fmt.Sprintf("\x1b[<%d;%d;%dM", btn, col, row)
	} else {
		// No mouse mode → arrow keys, one line per notch (the alternateScroll fallback).
		if up {
			notch = "\x1b[A"
		} else {
			notch = "\x1b[B"
		}
	}
	var b strings.Builder
	for i := 0; i < n; i++ {
		b.WriteString(notch)
	}
	if _, err := ptmx.Write([]byte(b.String())); err != nil {
		log.Printf("[attach] wheel forward: %v", err)
	}
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

	// Create the grid in the display, confirm synchronously. Idempotent browser-side, so
	// re-adoption re-sends it. Built from cfg LIVE (not a frozen string): a browser resize updates
	// cfg.cols/rows (handleInbound → onResize below), so a re-create lands at the CURRENT size. The
	// adapter's cfg is a CACHE that mirrors the browser's decision, never a stale startup snapshot.
	makeCreateCmd := func() string {
		return fmt.Sprintf("terminal.create %s %d %d --scale %g", cfg.id, cfg.cols, cfg.rows, cfg.scale)
	}
	if err := sendText(makeCreateCmd()); err != nil {
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

	// Only an EXPLICIT kill (terminal.kill → terminal.shutdown from the display) may destroy the
	// tmux session. EVERY other path to shutdown — relay-read error, SIGINT/SIGTERM, PTY EOF, a
	// ping that can't be sent, a browser reload that drops our conn — must leave the session ALIVE
	// (detach), so running work survives an incidental disconnect and stays re-adoptable. Teardown
	// reads this; it is set ONLY by handleInbound's terminal.shutdown case.
	var killRequested atomic.Bool
	requestKill := func() { killRequested.Store(true); shutdown() }

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Fprintln(os.Stderr, "\n[attach] shutting down")
		shutdown()
	}()

	// Repaint THIS session's OWN client. A bare `refresh-client` targets tmux's most-recently-used
	// client (the focused terminal), so N re-adopting adapters would all repaint the SAME one —
	// only the focused terminal comes back, the rest stay blank (the exact reload symptom). Resolve
	// our session's client by name and refresh exactly it.
	repaint := func() {
		out, err := tmuxCmd("list-clients", "-t", cfg.session, "-F", "#{client_name}").Output()
		client := strings.TrimSpace(string(out))
		if err != nil || client == "" {
			tmuxCmd("refresh-client").Run() // best-effort fallback
			return
		}
		if i := strings.IndexByte(client, '\n'); i >= 0 {
			client = client[:i] // one client per session, but be defensive
		}
		tmuxCmd("refresh-client", "-t", client).Run()
	}

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
		if err := sendText(makeCreateCmd()); err != nil {
			log.Printf("[attach] re-create send failed: %v", err)
			return
		}
		// Repaint the fresh emulator. PRIMARY path is now a HANDSHAKE: the display pushes
		// terminal.refresh the instant it has rebuilt the grid (handled below → repaint()), so the
		// repaint lands exactly when the grid is ready — not on a timer guess. These timed retries
		// are a FALLBACK in case that push is missed; repaint() targets OUR client specifically.
		// (Old behavior — fixed-time bare refresh-client — raced grid creation AND hit the wrong
		// client under contention, so late/non-focused grids stayed blank until a manual resize.)
		go func() {
			for _, d := range []time.Duration{150 * time.Millisecond, 500 * time.Millisecond, 1200 * time.Millisecond} {
				select {
				case <-done:
					return
				case <-time.After(d):
					repaint()
				}
			}
		}()
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
		// Alt-screen TUIs (claude/vim/less) own the screen and have no tmux scrollback —
		// copy-mode there is the [0/0] dead end. Forward the wheel TO the app instead so it
		// scrolls its own content. Normal shells keep the tmux copy-mode scrollback below.
		if alt, sgr := paneScreenMode(cfg.session); alt {
			forwardWheelToApp(ptmx, lines, sgr, cfg.cols, cfg.rows)
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

	// resizeCh carries a size change to the OUTPUT pump so it can flush the old-size frame and
	// re-stamp subsequent frames — the redraw tmux emits after the SIGWINCH gets tagged at the NEW
	// size. Buffered + non-blocking send below so a burst of grip resizes never stalls the input loop.
	resizeCh := make(chan [2]int, 16)

	// A browser-driven resize updates our cached size, so a later re-create / wheel-forward uses the
	// CURRENT dimensions, not the startup ones. cfg is the adapter-local copy, mutated ONLY here and
	// read by makeCreateCmd + forwardWheelToApp — all on the single INPUT goroutine after startup, so
	// no lock is needed. It ALSO nudges the OUTPUT pump to re-stamp frames at the new size.
	onResize := func(c, r int) {
		if c > 0 && r > 0 {
			cfg.cols, cfg.rows = c, r
			select {
			case resizeCh <- [2]int{c, r}:
			default: // pump busy; a following resize (or the next flush) carries the latest size
			}
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
			handleInbound(msg, cfg.id, ptmx, requestKill, recreate, repaint, scroll, exitScroll, onResize)
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
		// curCols/curRows is the size the accumulated bytes were drawn at — stamped onto every frame
		// so the display aligns its emulator to the content. Updated on a resize, AFTER the old-size
		// bytes are flushed (below), so the boundary is exact.
		curCols, curRows := cfg.cols, cfg.rows
		flush := func() bool {
			if len(acc) == 0 {
				return true
			}
			if err := sendBytes(encodeOutputFrame(cfg.id, curCols, curRows, acc)); err != nil {
				return false
			}
			acc = acc[:0]
			return true
		}
		for {
			select {
			case <-done:
				return
			case sz := <-resizeCh:
				// A resize took effect (SIGWINCH already sent by handleInbound). Everything read so
				// far was drawn at the OLD size — drain what the PTY reader already queued into a
				// final old-size frame and ship it, THEN adopt the new size so tmux's redraw (which
				// FOLLOWS the SIGWINCH) is the first content tagged new.
			drain:
				for {
					select {
					case c, ok := <-chunks:
						if !ok {
							flush()
							return
						}
						acc = append(acc, c...)
					default:
						break drain
					}
				}
				if !flush() {
					shutdown()
					return
				}
				curCols, curRows = sz[0], sz[1]
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

	// Teardown. DETACH by default: drop the display grid, but leave the tmux session RUNNING so the
	// work in it survives ANY incidental end — relay loss, SIGINT/SIGTERM, PTY EOF, or a browser
	// reload that dropped our conn — and stays re-adoptable. ONLY an explicit terminal.kill (which
	// arrives as terminal.shutdown and set killRequested) destroys the session. (This previously
	// killed UNCONDITIONALLY, so any teardown of the adapter silently destroyed running shells —
	// a reload could wipe live Claude sessions.)
	conn.SetWriteDeadline(time.Now().Add(time.Second))
	sendText("terminal.close " + cfg.id)
	if killRequested.Load() {
		tmuxCmd("kill-session", "-t", cfg.session).Run()
	}
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

// encodeOutputFrame builds an OUTPUT data-plane frame:
// [type][idLen][id][cols:u16 BE][rows:u16 BE][payload]. cols/rows are the size the payload was
// drawn at, so the display aligns its emulator to the content before parsing it.
func encodeOutputFrame(id string, cols, rows int, payload []byte) []byte {
	idb := []byte(id)
	frame := make([]byte, 2+len(idb)+4+len(payload))
	frame[0] = frameOutput
	frame[1] = byte(len(idb))
	copy(frame[2:], idb)
	off := 2 + len(idb)
	frame[off], frame[off+1] = byte(cols>>8), byte(cols)
	frame[off+2], frame[off+3] = byte(rows>>8), byte(rows)
	copy(frame[off+4:], payload)
	return frame
}

// handleInbound dispatches a relay message to this adapter. Events (display →
// controller push): terminal.bytes (input → PTY), terminal.resize (→ SIGWINCH),
// terminal.shutdown (graceful teardown). Command responses also land here; an
// "ERR: no terminal" reply (to our liveness ping) means the display reloaded → re-adopt.
func handleInbound(msg []byte, termID string, ptmx *os.File, requestKill func(), recreate func(), repaint func(), scroll func(int), exitScroll func(), onResize func(int, int)) {
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
				if onResize != nil {
					onResize(ev.Data.Cols, ev.Data.Rows) // mirror the browser's size into cfg (re-create/wheel use it)
				}
			}
		case "terminal.scroll": // wheel-gated tmux copy-mode scroll (+back / -forward)
			if scroll != nil {
				scroll(ev.Data.Lines)
			}
		case "terminal.refresh": // display rebuilt our grid (re-adoption) + is ready — repaint into it NOW
			if repaint != nil {
				repaint()
			}
		case "terminal.shutdown":
			fmt.Fprintln(os.Stderr, "[attach] kill requested by display (terminal.kill) — destroying session")
			requestKill()
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

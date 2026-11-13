//go:build !windows

package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// frameOutput is the type byte of an OUTPUT data-plane frame (adapter → display):
//
//	[frameOutput:u8][idLen:u8][id:utf8][cols:u16 BE][rows:u16 BE][raw VT bytes]
//
// cols/rows are the size the payload was written at. They ride WITH the content so the display
// resizes its emulator to match right before parsing the bytes — size and content travel on one
// ordered channel and can never reorder. termd places each resize at an exact byte (its `size`
// event carries the seq it takes effect at), so the adapter stamps every byte with the size in
// force when termd read it. The relay forwards frames verbatim; the browser parses the header and
// feeds the payload to the terminal's headless VT emulator.
const frameOutput = 0x01

// coalesceInterval bounds the OUTPUT message rate: bytes arriving within a window are
// batched into one frame (~one display frame).
const coalesceInterval = 16 * time.Millisecond

// sizedBytes is a run of terminal bytes and the size they were written at.
type sizedBytes struct {
	b          []byte
	cols, rows int
}

// paneModes is what the last termd `modes` event said; the wheel reads it.
type paneModes struct {
	Alt      bool `json:"alt"`
	Mouse    bool `json:"mouse"`
	MouseSGR bool `json:"mouse_sgr"`
}

// wheelBytes realizes a wheel gesture for an ALT-SCREEN app. Such apps own the screen and have no
// scrollback, so the wheel goes to the app itself: SGR mouse-wheel events when it asked for SGR
// mouse reports (claude, vim ttymouse=sgr — it scrolls its OWN content), else arrow keys (pagers
// like less/man — what xterm calls "alternateScroll"). `lines` follows the scroll convention:
// >0 = back/up, <0 = forward/down; |lines| notches are sent.
func wheelBytes(lines int, sgr bool, cols, rows int) []byte {
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
	} else if up {
		notch = "\x1b[A"
	} else {
		notch = "\x1b[B"
	}
	return []byte(strings.Repeat(notch, n))
}

// runTerminal connects to the relay, creates the display grid, creates-or-adopts the termd
// terminal, subscribes to it as the size's owner, and pumps bytes both ways until shutdown.
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

	// The adapter's size is a CACHE of the display's decision: a browser resize updates it
	// (onResize below), so a re-create lands at the CURRENT size, never a stale startup one.
	var size struct {
		sync.Mutex
		cols, rows int
	}
	size.cols, size.rows = cfg.cols, cfg.rows
	makeCreateCmd := func() string {
		size.Lock()
		defer size.Unlock()
		return fmt.Sprintf("terminal.create %s %d %d --scale %g", cfg.id, size.cols, size.rows, cfg.scale)
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
	// From here a failure would leave a grid with no adapter behind; close it first.
	fail := func(format string, a ...any) {
		conn.SetWriteDeadline(time.Now().Add(time.Second))
		sendText("terminal.close " + cfg.id)
		log.Fatalf(format, a...)
	}

	tc, err := ensureTermd(termdNS)
	if err != nil {
		fail("attach: %v", err)
	}
	var created struct {
		PID     int      `json:"pid"`
		Created bool     `json:"created"`
		Argv    []string `json:"argv"`
		Login   bool     `json:"login"`
		Cwd     string   `json:"cwd"`
	}
	if err := tc.Request("create", termdCreate(cfg), &created); err != nil {
		fail("attach: termd create %s: %v", cfg.id, err)
	}
	// The display owns the size (DESIGN.md D11): subscribe as the owner, at its size.
	var sub struct {
		Handle uint32 `json:"handle"`
		Cols   int    `json:"cols"`
		Rows   int    `json:"rows"`
	}
	if err := tc.Request("subscribe", map[string]any{
		"id": cfg.id, "mode": "raw", "role": "own", "cols": cfg.cols, "rows": cfg.rows,
	}, &sub); err != nil {
		fail("attach: termd subscribe %s: %v", cfg.id, err)
	}
	// The session: termd's connection and our handle on it. A brain restart (a crash, an
	// upgrade) replaces both; everything below reads the current one.
	var sess atomic.Pointer[termdSession]
	sess.Store(&termdSession{tc: tc, handle: sub.Handle})
	verb := "created"
	if !created.Created {
		verb = "adopted" // the program is whatever the terminal was started with
	}
	login := ""
	if created.Login {
		login = " (login shell)"
	}
	fmt.Fprintf(os.Stderr, "[attach] %s %s in termd namespace %q (%s, pid %d): %s%s in %s\n",
		cfg.id, verb, termdNS, tc.Welcome.Daemon, created.PID, strings.Join(created.Argv, " "), login, created.Cwd)
	defer func() { sess.Load().tc.Close() }()

	// Lifecycle: signals, termd, the relay, liveness and the output pump all converge on `done`.
	done := make(chan struct{})
	var closeOnce sync.Once
	shutdown := func() { closeOnce.Do(func() { close(done) }) }

	// Only an EXPLICIT kill (terminal.kill → terminal.shutdown from the display) ends the termd
	// terminal. EVERY other path to shutdown — relay-read error, SIGINT/SIGTERM, a dropped termd
	// connection, a browser reload that drops our conn — leaves the terminal ALIVE (detach), so
	// running work survives an incidental disconnect and stays re-adoptable.
	var killRequested atomic.Bool
	requestKill := func() { killRequested.Store(true); shutdown() }
	var programEnded atomic.Bool

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Fprintln(os.Stderr, "\n[attach] shutting down")
		shutdown()
	}()

	// send fires a termd request and logs a refusal; nothing waits on it.
	send := func(op string, fields map[string]any) {
		ch, err := sess.Load().tc.Send(op, fields)
		if err != nil {
			log.Printf("[attach] termd %s: %v", op, err)
			return
		}
		go func() {
			if r := <-ch; r.err != nil {
				log.Printf("[attach] termd %s: %v", op, r.err)
			}
		}()
	}

	// repaint asks termd to redraw the screen into the grid (the title rides every repaint).
	repaint := func() { send("repaint", map[string]any{"handle": sess.Load().handle}) }

	// Re-adoption: a display reload wipes its terminal registry, so terminal.ping starts bouncing
	// "ERR: no terminal <id>". Re-issue terminal.create so the fresh display rebuilds the grid
	// (owner = us → input still routes); the display then pushes terminal.refresh the moment the
	// grid exists (→ repaint). The timed repaints are a fallback in case that push is missed.
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

	var modes struct {
		sync.Mutex
		m paneModes
	}

	// Scrollback is termd's: a wheel on the focused terminal arrives as terminal.scroll (+lines =
	// back into history, −lines = forward to live). On the primary screen it moves this adapter's
	// view (termd sends the viewed rows as a repaint and holds output until the view is back at
	// live, as copy-mode did); typing snaps the view back to live. An alternate-screen app has no
	// scrollback, so the wheel goes to the app.
	scroll := func(lines int) {
		if lines == 0 {
			return
		}
		modes.Lock()
		m := modes.m
		modes.Unlock()
		size.Lock()
		cols, rows := size.cols, size.rows
		size.Unlock()
		s := sess.Load()
		if m.Alt {
			if err := s.tc.Input(s.handle, wheelBytes(lines, m.Mouse && m.MouseSGR, cols, rows)); err != nil {
				log.Printf("[attach] wheel: %v", err)
			}
			return
		}
		send("view", map[string]any{"handle": s.handle, "delta": lines})
	}

	onResize := func(c, r int) {
		if c <= 0 || r <= 0 {
			return
		}
		size.Lock()
		size.cols, size.rows = c, r
		size.Unlock()
		send("resize", map[string]any{"handle": sess.Load().handle, "cols": c, "rows": r})
	}

	// INPUT goroutine: drain the relay. Carries terminal.bytes (→ termd), resize, scroll,
	// refresh, shutdown, and the ping bounce that triggers re-adoption.
	go func() {
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				shutdown()
				return
			}
			handleInbound(msg, cfg.id, inboundHandlers{
				bytes: func(b []byte) {
					// At most once: input while termd restarts is dropped, never replayed.
					s := sess.Load()
					if err := s.tc.Input(s.handle, b); err != nil {
						log.Printf("[attach] input: %v", err)
					}
				},
				resize:   onResize,
				scroll:   scroll,
				refresh:  repaint,
				kill:     requestKill,
				recreate: recreate,
			})
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

	// termd → chunks: every OUTPUT and REPAINT, stamped with the size it was written at.
	chunks := make(chan sizedBytes, 64)
	go func() {
		defer shutdown()
		cols, rows := sub.Cols, sub.Rows
		push := func(b []byte, c, r int) bool {
			select {
			case chunks <- sizedBytes{b, c, r}:
				return true
			case <-done:
				return false
			}
		}
		// pump moves one session's frames until its connection ends; true = we're finished (the
		// program ended, or we are shutting down).
		pump := func(s *termdSession) bool {
			for f := range s.tc.Frames {
				if f.Stream != s.handle {
					continue
				}
				switch f.Type {
				case termdOutput:
					if len(f.Payload) >= 8 && !push(f.Payload[8:], cols, rows) {
						return true
					}
				case termdRepaint:
					if len(f.Payload) < 16 {
						continue
					}
					cols = int(binary.LittleEndian.Uint16(f.Payload[8:]))
					rows = int(binary.LittleEndian.Uint16(f.Payload[10:]))
					if !push(f.Payload[16:], cols, rows) {
						return true
					}
				case termdEvent:
					var ev struct {
						Ev      string `json:"ev"`
						Cols    int    `json:"cols"`
						Rows    int    `json:"rows"`
						Code    *int   `json:"code"`
						Signal  string `json:"signal"`
						Message string `json:"message"`
						paneModes
					}
					if json.Unmarshal(f.Payload, &ev) != nil {
						continue
					}
					switch ev.Ev {
					case "size":
						cols, rows = ev.Cols, ev.Rows
						// The display resizes its emulator only when bytes tagged with the new size
						// arrive, and a program may write nothing after SIGWINCH (a shell running a
						// long command). A repaint is such bytes: termd's screen, reflowed.
						repaint()
					case "modes":
						modes.Lock()
						modes.m = ev.paneModes
						modes.Unlock()
					case "role":
						log.Printf("[attach] %s: another client took the size (g3d attach --take); the display follows it", cfg.id)
					case "lagged":
						log.Printf("[attach] %s: fell behind termd and was resynced", cfg.id)
					case "exit":
						if ev.Code != nil {
							fmt.Fprintf(os.Stderr, "[attach] %s: program exited %d\n", cfg.id, *ev.Code)
						} else {
							fmt.Fprintf(os.Stderr, "[attach] %s: program ended by SIG%s\n", cfg.id, ev.Signal)
						}
					case "error":
						log.Printf("[attach] %s: termd: %s", cfg.id, ev.Message)
					case "closed":
						programEnded.Store(true)
						return true
					}
				}
			}
			select {
			case <-done:
				return true // we closed it ourselves (the relay went, a signal): termd is fine
			default:
				return false
			}
		}
		for {
			s := sess.Load()
			if pump(s) {
				return
			}
			// The termd connection dropped under us: its brain restarted (crashed, or upgraded),
			// or the whole namespace went. Keep the grid, ride the restart, re-subscribe by id.
			why := s.tc.Err()
			planned := isTermdCode(why, "restart")
			s.tc.Close()
			log.Printf("[attach] %s: termd connection ended (%v); reconnecting for up to %s", cfg.id, why, termdReconnectWindow)
			nc, err := redialTermd(termdNS, s.tc.Welcome.Instance, planned)
			if err != nil {
				log.Printf("[attach] %s: LOST termd (namespace %q): %v — closing the grid", cfg.id, termdNS, err)
				return
			}
			size.Lock()
			c, r := size.cols, size.rows
			size.Unlock()
			var sub2 struct {
				Handle uint32 `json:"handle"`
				Cols   int    `json:"cols"`
				Rows   int    `json:"rows"`
			}
			if err := nc.Request("subscribe", map[string]any{
				"id": cfg.id, "mode": "raw", "role": "own", "cols": c, "rows": r,
			}, &sub2); err != nil {
				nc.Close()
				if isTermdCode(err, "no_terminal") {
					fmt.Fprintf(os.Stderr, "[attach] %s: the program ended while termd restarted\n", cfg.id)
					programEnded.Store(true)
				} else {
					log.Printf("[attach] %s: LOST termd (namespace %q): re-subscribe: %v — closing the grid", cfg.id, termdNS, err)
				}
				return
			}
			cols, rows = sub2.Cols, sub2.Rows
			sess.Store(&termdSession{tc: nc, handle: sub2.Handle})
			fmt.Fprintf(os.Stderr, "[attach] %s: back on termd (brain generation %d, pid %d); the repaint brings the screen back\n",
				cfg.id, nc.Welcome.Generation, nc.Welcome.PID)
		}
	}()

	// OUTPUT pump: chunks → coalescer → binary OUTPUT frame. A size change flushes the bytes
	// written at the old size first, so the display resizes at exactly the right byte.
	go func() {
		ticker := time.NewTicker(coalesceInterval)
		defer ticker.Stop()
		var acc []byte
		accCols, accRows := cfg.cols, cfg.rows
		flush := func() bool {
			if len(acc) == 0 {
				return true
			}
			if err := sendBytes(encodeOutputFrame(cfg.id, accCols, accRows, acc)); err != nil {
				return false
			}
			acc = acc[:0]
			return true
		}
		for {
			select {
			case <-done:
				return
			case c := <-chunks:
				if (c.cols != accCols || c.rows != accRows) && !flush() {
					shutdown()
					return
				}
				accCols, accRows = c.cols, c.rows
				acc = append(acc, c.b...)
				if len(acc) >= 16*1024 && !flush() { // flush promptly under a flood
					shutdown()
					return
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

	// Teardown. DETACH by default: drop the display grid and our subscription, leave the termd
	// terminal RUNNING. ONLY an explicit terminal.kill ends it.
	if killRequested.Load() && !programEnded.Load() {
		if err := sess.Load().tc.Request("kill", map[string]any{"id": cfg.id}, nil); err != nil {
			log.Printf("[attach] termd kill %s: %v", cfg.id, err)
		}
	}
	conn.SetWriteDeadline(time.Now().Add(time.Second))
	sendText("terminal.close " + cfg.id)
}

// termdSession is the adapter's current termd connection and its subscription's handle.
type termdSession struct {
	tc     *termdClient
	handle uint32
}

// encodeOutputFrame builds an OUTPUT data-plane frame:
// [type][idLen][id][cols:u16 BE][rows:u16 BE][payload]. cols/rows are the size the payload was
// written at, so the display aligns its emulator to the content before parsing it.
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

// inboundHandlers are what an adapter does with each relay push.
type inboundHandlers struct {
	bytes    func([]byte)
	resize   func(cols, rows int)
	scroll   func(lines int)
	refresh  func()
	kill     func()
	recreate func()
}

// handleInbound dispatches a relay message to this adapter. Events (display → controller
// push): terminal.bytes (input), terminal.resize, terminal.scroll, terminal.refresh (repaint),
// terminal.shutdown (kill). Command responses also land here; an "ERR: no terminal" reply (to
// our liveness ping) means the display reloaded → re-adopt.
func handleInbound(msg []byte, termID string, h inboundHandlers) {
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
		case "terminal.bytes":
			if b, derr := base64.StdEncoding.DecodeString(ev.Data.B64); derr == nil {
				h.bytes(b)
			}
		case "terminal.resize":
			h.resize(ev.Data.Cols, ev.Data.Rows)
		case "terminal.scroll":
			h.scroll(ev.Data.Lines)
		case "terminal.refresh": // display rebuilt our grid (re-adoption) + is ready — repaint into it NOW
			h.refresh()
		case "terminal.shutdown":
			fmt.Fprintln(os.Stderr, "[attach] kill requested by display (terminal.kill) — ending the terminal")
			h.kill()
		}
		return
	}
	text := decodeRelayText(msg)
	if strings.HasPrefix(text, "ERR:") {
		if strings.Contains(text, "no terminal") {
			h.recreate()
			return
		}
		if strings.Contains(text, "no display") {
			return // expected while the browser is mid-reload; don't spam
		}
		log.Printf("[attach] %s", text)
	}
}

// termdCreate is the adapter's termd `create` (create-or-adopt). No argv: termd starts the
// account's shell as a login shell. No cwd: the account's home. No env_base: the relay is a
// creator with no shell, so the terminal gets the desktop session's environment, never the
// relay's own (DESIGN.md, "Environment"), whatever started the relay.
func termdCreate(cfg terminalConfig) map[string]any {
	create := map[string]any{"id": cfg.id, "cols": cfg.cols, "rows": cfg.rows, "if_exists": "adopt"}
	if len(cfg.cmdArgs) > 0 {
		create["argv"] = cfg.cmdArgs
	}
	if cfg.cwd != "" {
		create["cwd"] = cfg.cwd
	}
	return create
}

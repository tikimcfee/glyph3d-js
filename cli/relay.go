package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// Relay routes WebSocket messages between one display (browser) and N controllers (CLIs).
type Relay struct {
	mu           sync.RWMutex
	display      *websocket.Conn
	displayWrite chan []byte   // control/JSON write queue (non-blocking, drop-OK — self-correcting)
	displayBytes chan []byte   // terminal OUTPUT binary frames (blocking send = lossless backpressure)
	displayDone  chan struct{} // closed on display teardown — unblocks writer + blocked byte senders
	controllers  map[string]*websocket.Conn
	nextID       atomic.Int64
	termSeq      atomic.Int64 // monotonic id source for relay-spawned terminal adapters
	upgrader     websocket.Upgrader
	fs           *FSHandler      // nil if --root not provided
	lsp          *LSPSupervisor  // nil if --root not provided; hosts language servers
	port         int             // port this relay serves on (spawned adapters connect back here)
	logs         *LogStore       // relay-resident browser-log store (SQLite :memory: + FTS5)
	logSubs      map[string]bool // controller ids subscribed via log.follow (guarded by mu)
}

func NewRelay() *Relay {
	logs, err := NewLogStore()
	if err != nil {
		log.Fatalf("[relay] log store: %v", err)
	}
	return &Relay{
		controllers: make(map[string]*websocket.Conn),
		logs:        logs,
		logSubs:     make(map[string]bool),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
}

// sendToDisplay enqueues a message for the display WebSocket writer goroutine.
// Safe to call from any goroutine. Non-blocking if channel has capacity.
func (r *Relay) sendToDisplay(data []byte) {
	r.mu.RLock()
	ch := r.displayWrite
	r.mu.RUnlock()
	if ch == nil {
		return
	}
	select {
	case ch <- data:
	default:
		log.Printf("[relay] display write queue full, dropping message")
	}
}

// sendBytesToDisplay forwards a terminal OUTPUT binary frame to the display. Unlike
// sendToDisplay this is a BLOCKING send — the byte stream must be lossless (a dropped
// mid-stream chunk desyncs the parser and corrupts the screen). When the queue is
// full the calling controller's read goroutine blocks here, which TCP-backpressures
// that adapter → its PTY read pauses → the kernel buffer backpressures tmux. The
// `done` select makes the block cancellable so display teardown can't deadlock a
// controller (and so we never close displayBytes out from under a blocked sender).
func (r *Relay) sendBytesToDisplay(data []byte) {
	r.mu.RLock()
	ch := r.displayBytes
	done := r.displayDone
	r.mu.RUnlock()
	if ch == nil {
		return // no display — drop (a controller shouldn't stream output without one)
	}
	select {
	case ch <- data:
	case <-done:
	}
}

// startDisplayWriter serializes all writes to the one display WebSocket, draining two
// queues with CONTROL PRIORITY: control/JSON (responses, FS-RPC, notifications) is
// always flushed before bulk terminal bytes, so a flood of output never head-of-line
// blocks interactive control traffic. Exits when the display tears down (`done`) or a
// write fails. The data channels are never closed (abandoned to GC) so a controller
// blocked in sendBytesToDisplay can't hit a send-on-closed panic.
func (r *Relay) startDisplayWriter(ws *websocket.Conn, control, bytesCh chan []byte, done chan struct{}) {
	go func() {
		for {
			// Priority pass: drain all available control messages first.
			select {
			case data := <-control:
				if err := ws.WriteMessage(websocket.TextMessage, data); err != nil {
					log.Printf("[relay] display write error: %v", err)
					return
				}
				continue
			default:
			}
			// Nothing pending on control — block until either queue or teardown.
			select {
			case data := <-control:
				if err := ws.WriteMessage(websocket.TextMessage, data); err != nil {
					log.Printf("[relay] display write error: %v", err)
					return
				}
			case data := <-bytesCh:
				if err := ws.WriteMessage(websocket.BinaryMessage, data); err != nil {
					log.Printf("[relay] display byte-write error: %v", err)
					return
				}
			case <-done:
				return
			}
		}
	}()
}

func (r *Relay) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	ws, err := r.upgrader.Upgrade(w, req, nil)
	if err != nil {
		log.Printf("[relay] upgrade error: %v", err)
		return
	}
	r.handleConnection(ws)
}

func (r *Relay) handleConnection(ws *websocket.Conn) {
	defer ws.Close()

	var role string
	var clientID string

	for {
		msgType, msg, err := ws.ReadMessage()
		if err != nil {
			break
		}
		// Binary frames are the terminal OUTPUT data plane (adapter → display).
		// Forward verbatim and losslessly; the frame self-describes its terminal id.
		// Everything else is text/JSON control, handled below.
		if msgType == websocket.BinaryMessage {
			if role == "controller" {
				r.sendBytesToDisplay(msg)
			}
			continue
		}
		raw := string(msg)

		// Check for relay-direct messages (from any client, any role)
		var relayProbe struct {
			Relay string `json:"relay"`
		}
		if json.Unmarshal(msg, &relayProbe) == nil && relayProbe.Relay != "" {
			r.handleRelayMessage(ws, msg, clientID, role)
			continue
		}

		// First message determines role
		if role == "" {
			if raw == "DISPLAY" {
				r.mu.Lock()
				if r.display != nil {
					r.mu.Unlock()
					ws.WriteJSON(map[string]any{"error": "display already connected"})
					return
				}
				r.display = ws
				ch := make(chan []byte, 64)       // control/JSON
				bytesCh := make(chan []byte, 256) // terminal OUTPUT (deeper: ~16ms coalesced frames)
				done := make(chan struct{})
				r.displayWrite = ch
				r.displayBytes = bytesCh
				r.displayDone = done
				role = "display"

				// Collect controller IDs
				ids := make([]string, 0, len(r.controllers))
				for id := range r.controllers {
					ids = append(ids, id)
				}
				r.mu.Unlock()

				// Start the single writer goroutine for this display connection
				r.startDisplayWriter(ws, ch, bytesCh, done)

				log.Printf("[relay] display connected from %s", ws.RemoteAddr())
				// Initial ack goes through the channel
				ack, _ := json.Marshal(map[string]any{
					"ok":          true,
					"role":        "display",
					"controllers": ids,
				})
				r.sendToDisplay(ack)
				continue
			} else {
				id := r.nextID.Add(1) - 1
				clientID = fmt.Sprintf("ctrl-%d", id)
				r.mu.Lock()
				r.controllers[clientID] = ws
				r.mu.Unlock()
				role = "controller"
				log.Printf("[relay] controller '%s' connected from %s", clientID, ws.RemoteAddr())
				ws.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("OK: connected as %s", clientID)))
				r.notifyDisplay("client_connected", clientID)
				// Fall through to process first message as command
			}
		}

		if role == "controller" {
			if raw == "" {
				continue
			}
			if raw == "ping" {
				ws.WriteMessage(websocket.TextMessage, []byte("pong"))
				continue
			}
			if raw == "whoami" {
				r.mu.RLock()
				hasDisplay := r.display != nil
				r.mu.RUnlock()
				ds := "not connected"
				if hasDisplay {
					ds = "connected"
				}
				ws.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("You are %s. Display: %s", clientID, ds)))
				continue
			}

			// Relay-resident verbs (log store, git) — answered here, never
			// forwarded. (log.tail / log.level stay display verbs and fall through.)
			if verb, rest, ok := splitRelayVerb(raw); ok {
				r.handleRelayCommand(ws, verb, rest)
				continue
			}

			r.mu.RLock()
			d := r.display
			r.mu.RUnlock()

			if d == nil {
				ws.WriteMessage(websocket.TextMessage, []byte("ERR: no display connected. Open the viewer in a browser first."))
				continue
			}

			envelope, _ := json.Marshal(map[string]string{"from": clientID, "cmd": raw})
			r.sendToDisplay(envelope)

		} else if role == "display" {
			// Browser log ingest: {"event":"browser.log","rec":{ts,level,scope,msg,attrs,page}}.
			// Every record lands in the relay-resident store; log/warn/error also
			// print to relay stdout (trace/debug/info are stored silently); the
			// stored record is pushed to every log.follow subscriber.
			var logProbe struct {
				Event string  `json:"event"`
				Rec   *LogRec `json:"rec"`
			}
			if json.Unmarshal(msg, &logProbe) == nil && logProbe.Event == "browser.log" && logProbe.Rec != nil {
				rec := logProbe.Rec
				if rec.Level == "" {
					rec.Level = "log"
				}
				rec.RTS = time.Now().UnixMilli()
				stored, err := r.logs.Ingest(rec)
				if err != nil {
					log.Printf("[relay] log ingest error: %v", err)
					continue
				}
				switch rec.Level {
				case "log", "warn", "error":
					log.Printf("[browser:%s] %s", rec.Level, rec.Msg)
				}
				r.pushLogToFollowers(stored)
				continue
			}

			// JSON-RPC 2.0 detection: route fs/* to FSHandler, lsp/* to the LSP supervisor.
			var probe struct {
				JSONRPC string `json:"jsonrpc"`
			}
			if json.Unmarshal(msg, &probe) == nil && probe.JSONRPC == "2.0" {
				var rpc rpcRequest
				if err := json.Unmarshal(msg, &rpc); err != nil {
					log.Printf("[relay] malformed JSON-RPC from display: %.100s", raw)
					continue
				}
				switch {
				case strings.HasPrefix(rpc.Method, "lsp/"):
					if r.lsp != nil {
						r.lsp.Handle(rpc.Method, rpc.ID, rpc.Params, r.sendToDisplay)
					} else {
						r.sendJSONRPCError(rpc.ID, -32003, "LSP not enabled (start relay with --root)")
					}
				case r.fs != nil:
					r.fs.Handle(rpc.Method, rpc.ID, rpc.Params, r.sendToDisplay)
				default:
					r.sendJSONRPCError(rpc.ID, -32003, "filesystem not enabled (start relay with --root)")
				}
				continue
			}

			var envelope struct {
				To       string          `json:"to"`
				Event    string          `json:"event"`
				Response string          `json:"response"`
				Data     json.RawMessage `json:"data"`
			}
			if err := json.Unmarshal(msg, &envelope); err != nil {
				log.Printf("[relay] invalid JSON from display: %.100s", raw)
				continue
			}
			if envelope.To == "" {
				continue
			}

			r.mu.RLock()
			ctrl, ok := r.controllers[envelope.To]
			r.mu.RUnlock()

			if !ok {
				log.Printf("[relay] target '%s' not found (may have disconnected)", envelope.To)
				continue
			}

			// Display→controller PUSH (e.g. terminal.input keystrokes): forward the
			// event verbatim so the owning controller's read loop can act on it.
			// Without this branch the `event` field is dropped and the controller
			// receives an empty response — this is the keystroke-return channel.
			if envelope.Event != "" {
				data := envelope.Data
				if len(data) == 0 {
					data = json.RawMessage("null")
				}
				fwd, _ := json.Marshal(map[string]any{
					"event": envelope.Event,
					"data":  data,
				})
				ctrl.WriteMessage(websocket.TextMessage, fwd)
				continue
			}

			// Command-response path (controller-initiated command → display reply).
			if len(envelope.Data) > 0 && string(envelope.Data) != "null" {
				resp, _ := json.Marshal(map[string]any{
					"response": envelope.Response,
					"data":     json.RawMessage(envelope.Data),
				})
				ctrl.WriteMessage(websocket.TextMessage, resp)
			} else {
				ctrl.WriteMessage(websocket.TextMessage, []byte(envelope.Response))
			}
		}
	}

	// Cleanup
	if role == "display" {
		r.mu.Lock()
		r.display = nil
		done := r.displayDone
		r.displayWrite = nil
		r.displayBytes = nil
		r.displayDone = nil
		r.mu.Unlock()
		// Close `done` (never sent on) to stop the writer and unblock any controller
		// parked in sendBytesToDisplay. The data channels are left for GC, not closed,
		// so a blocked sender can't panic on a closed channel.
		if done != nil {
			close(done)
		}
		log.Printf("[relay] display disconnected")
	} else if role == "controller" && clientID != "" {
		r.mu.Lock()
		delete(r.controllers, clientID)
		delete(r.logSubs, clientID)
		r.mu.Unlock()
		log.Printf("[relay] controller '%s' disconnected", clientID)
		r.notifyDisplay("client_disconnected", clientID)
	}
}

// atlasCacheDir returns ~/.glyph3d/cache/, creating it on demand for writes.
func atlasCacheDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".glyph3d", "cache")
}

// atlasCacheKey builds a slug from font + size, e.g. "atlas-menlo-2048".
func atlasCacheKey(font string, size float64) string {
	slug := strings.ToLower(font)
	slug = strings.ReplaceAll(slug, " ", "-")
	slug = strings.ReplaceAll(slug, ",", "")
	return fmt.Sprintf("atlas-%s-%d", slug, int(size))
}

func (r *Relay) handleRelayMessage(ws *websocket.Conn, msg []byte, clientID, role string) {
	var m struct {
		Relay      string          `json:"relay"`
		Font       string          `json:"font"`
		Size       float64         `json:"size"`
		PNG        string          `json:"png"`
		Descriptor json.RawMessage `json:"descriptor"`
		Cols       int             `json:"cols"`
		Rows       int             `json:"rows"`
	}
	if err := json.Unmarshal(msg, &m); err != nil {
		ws.WriteJSON(map[string]any{"error": "invalid relay message"})
		return
	}

	dir := atlasCacheDir()
	key := atlasCacheKey(m.Font, m.Size)
	pngPath := filepath.Join(dir, key+".png")
	jsonPath := filepath.Join(dir, key+".json")

	switch m.Relay {
	case "atlas.get":
		pngData, pngErr := os.ReadFile(pngPath)
		jsonData, jsonErr := os.ReadFile(jsonPath)
		if pngErr == nil && jsonErr == nil {
			log.Printf("[relay] atlas cache hit: %s", key)
			var descriptor json.RawMessage
			json.Unmarshal(jsonData, &descriptor)
			ws.WriteJSON(map[string]any{
				"event":      "atlas.result",
				"hit":        true,
				"png":        base64.StdEncoding.EncodeToString(pngData),
				"descriptor": descriptor,
			})
		} else {
			log.Printf("[relay] atlas cache miss: %s", key)
			ws.WriteJSON(map[string]any{
				"event": "atlas.result",
				"hit":   false,
			})
		}

	case "atlas.cache":
		os.MkdirAll(dir, 0755)
		pngBytes, err := base64.StdEncoding.DecodeString(m.PNG)
		if err != nil {
			ws.WriteJSON(map[string]any{"error": "invalid base64 png data"})
			return
		}
		os.WriteFile(pngPath, pngBytes, 0644)
		os.WriteFile(jsonPath, m.Descriptor, 0644)
		log.Printf("[relay] atlas cached: %s", jsonPath)
		ws.WriteJSON(map[string]any{
			"event": "atlas.cached",
			"path":  jsonPath,
		})

	case "atlas.clear":
		removed := 0
		if os.Remove(pngPath) == nil {
			removed++
		}
		if os.Remove(jsonPath) == nil {
			removed++
		}
		log.Printf("[relay] atlas cache cleared: %s (%d files)", key, removed)
		ws.WriteJSON(map[string]any{
			"event":   "atlas.cleared",
			"key":     key,
			"removed": removed,
		})

	case "terminal.spawn":
		r.spawnTerminalAdapter(ws, m.Cols, m.Rows)

	case "terminal.recover":
		r.recoverTerminals(ws)

	case "log.follow":
		if role != "controller" || clientID == "" {
			ws.WriteJSON(map[string]any{"event": "log.follow", "ok": false, "error": "log.follow requires a controller connection"})
			return
		}
		r.mu.Lock()
		r.logSubs[clientID] = true
		r.mu.Unlock()
		log.Printf("[relay] controller '%s' following logs", clientID)
		ws.WriteJSON(map[string]any{"event": "log.follow", "ok": true})

	case "log.unfollow":
		r.mu.Lock()
		delete(r.logSubs, clientID)
		r.mu.Unlock()
		ws.WriteJSON(map[string]any{"event": "log.unfollow", "ok": true})

	default:
		ws.WriteJSON(map[string]any{"error": fmt.Sprintf("unknown relay command: %s", m.Relay)})
	}
}

// pushLogToFollowers fans one stored log record out to every log.follow
// subscriber as {"event":"browser.log","data":<rec>}. Called from the display
// read goroutine after ingest, so a coalesced repeat pushes the updated record.
func (r *Relay) pushLogToFollowers(rec *LogRec) {
	r.mu.RLock()
	conns := make([]*websocket.Conn, 0, len(r.logSubs))
	for id := range r.logSubs {
		if c, ok := r.controllers[id]; ok {
			conns = append(conns, c)
		}
	}
	r.mu.RUnlock()
	if len(conns) == 0 {
		return
	}
	msg, err := json.Marshal(map[string]any{"event": "browser.log", "data": rec})
	if err != nil {
		return
	}
	for _, c := range conns {
		c.WriteMessage(websocket.TextMessage, msg)
	}
}

// relayVerbs are the controller plain-text commands answered by the relay
// itself, never forwarded to the display: the log store, and git awareness
// of the served root. log.tail and log.level are NOT here — display verbs.
var relayVerbs = map[string]bool{
	"log.query":  true,
	"log.search": true,
	"log.errors": true,
	"log.stats":  true,
	"log.dump":   true,
	"git.recent": true,
}

// splitRelayVerb splits a raw controller command into (verb, rest) when the
// first token is a relay-resident verb. rest keeps the argument string
// (for log.query, the SQL).
func splitRelayVerb(raw string) (verb, rest string, ok bool) {
	verb, rest, _ = strings.Cut(raw, " ")
	if !relayVerbs[verb] {
		return "", "", false
	}
	return verb, strings.TrimSpace(rest), true
}

// handleRelayCommand answers a relay-resident verb on the controller's
// socket using the {"response":...,"data":...} shape the CLI expects; errors
// reply as plain "ERR: ..." text.
func (r *Relay) handleRelayCommand(ws *websocket.Conn, verb, rest string) {
	fail := func(err error) {
		ws.WriteMessage(websocket.TextMessage, []byte("ERR: "+err.Error()))
	}
	reply := func(text string, data any) {
		msg, err := json.Marshal(map[string]any{"response": text, "data": data})
		if err != nil {
			fail(err)
			return
		}
		ws.WriteMessage(websocket.TextMessage, msg)
	}

	switch verb {
	case "git.recent":
		if r.fs == nil {
			fail(fmt.Errorf("git.recent needs a served root (start relay with a project dir)"))
			return
		}
		n := 5
		if f := strings.Fields(rest); len(f) > 0 {
			if v, err := strconv.Atoi(f[0]); err == nil && v > 0 && v <= 50 {
				n = v
			}
		}
		text, data, err := gitRecent(r.fs.root, n)
		if err != nil {
			fail(err)
			return
		}
		reply(text, data)

	case "log.query":
		cols, rows, err := r.logs.Query(rest)
		if err != nil {
			fail(err)
			return
		}
		reply(fmt.Sprintf("%d row(s)", len(rows)), map[string]any{"columns": cols, "rows": rows})

	case "log.search":
		expr, opts, err := parseLogSearchArgs(rest)
		if err != nil {
			fail(err)
			return
		}
		entries, err := r.logs.Search(expr, opts)
		if err != nil {
			fail(err)
			return
		}
		reply(fmt.Sprintf("%d hit(s)", len(entries)), map[string]any{"entries": entries})

	case "log.errors":
		_, opts, err := parseLogSearchArgs(rest)
		if err != nil {
			fail(err)
			return
		}
		entries, err := r.logs.Errors(opts.Since, opts.Limit)
		if err != nil {
			fail(err)
			return
		}
		reply(fmt.Sprintf("%d hit(s)", len(entries)), map[string]any{"entries": entries})

	case "log.stats":
		stats, err := r.logs.Stats()
		if err != nil {
			fail(err)
			return
		}
		reply(fmt.Sprintf("%d row(s)", stats.Rows), stats)

	case "log.dump":
		n, path, err := r.logs.Dump(rest)
		if err != nil {
			fail(err)
			return
		}
		reply(fmt.Sprintf("OK: dumped %d rows to %s", n, path), nil)
	}
}

// parseLogSearchArgs parses "expr words --since 5m --level error,warn
// --scope s --page cur --limit 50". Flags may appear in any order; non-flag
// tokens join (space-separated) into the search expression.
func parseLogSearchArgs(rest string) (string, SearchOpts, error) {
	var opts SearchOpts
	var exprParts []string
	toks := strings.Fields(rest)
	for i := 0; i < len(toks); i++ {
		t := toks[i]
		if !strings.HasPrefix(t, "--") {
			exprParts = append(exprParts, t)
			continue
		}
		if i+1 >= len(toks) {
			return "", opts, fmt.Errorf("flag %s requires a value", t)
		}
		i++
		v := toks[i]
		switch t {
		case "--since":
			d, err := parseSinceDuration(v)
			if err != nil {
				return "", opts, err
			}
			opts.Since = d
		case "--level":
			for _, l := range strings.Split(v, ",") {
				if l = strings.TrimSpace(l); l != "" {
					opts.Levels = append(opts.Levels, l)
				}
			}
		case "--scope":
			opts.Scope = v
		case "--page":
			opts.Page = v
		case "--limit":
			n, err := strconv.Atoi(v)
			if err != nil || n <= 0 {
				return "", opts, fmt.Errorf("invalid --limit %q", v)
			}
			opts.Limit = n
		default:
			return "", opts, fmt.Errorf("unknown flag %s", t)
		}
	}
	return strings.Join(exprParts, " "), opts, nil
}

// parseSinceDuration parses "<int><s|m|h|d>" (e.g. 30s, 5m, 2h, 1d).
func parseSinceDuration(s string) (time.Duration, error) {
	if len(s) < 2 {
		return 0, fmt.Errorf("invalid duration %q (want e.g. 30s, 5m, 2h, 1d)", s)
	}
	n, err := strconv.Atoi(s[:len(s)-1])
	if err != nil || n < 0 {
		return 0, fmt.Errorf("invalid duration %q (want e.g. 30s, 5m, 2h, 1d)", s)
	}
	switch s[len(s)-1] {
	case 's':
		return time.Duration(n) * time.Second, nil
	case 'm':
		return time.Duration(n) * time.Minute, nil
	case 'h':
		return time.Duration(n) * time.Hour, nil
	case 'd':
		return time.Duration(n) * 24 * time.Hour, nil
	}
	return 0, fmt.Errorf("invalid duration unit in %q (want s|m|h|d)", s)
}

// spawnTerminalAdapter forks `glyph3d-cli attach <id> --port <port>` as a child
// process. The adapter connects back to this relay as a controller, creates a
// TerminalGrid in the display, and pumps a real shell (tmux) into it. The browser
// can't spawn a host process itself, so the relay does it on request (this is the
// "+ terminal" button's backend). Single-user tool: as trusted as the command bus.
func (r *Relay) spawnTerminalAdapter(ws *websocket.Conn, cols, rows int) {
	exePath, err := os.Executable()
	if err != nil {
		ws.WriteJSON(map[string]any{"error": "cannot locate glyph3d-cli binary: " + err.Error()})
		return
	}
	id := fmt.Sprintf("term-%d", r.termSeq.Add(1))
	args := []string{"attach", id, "--port", strconv.Itoa(r.port)}
	if cols > 0 {
		args = append(args, "--cols", strconv.Itoa(cols))
	}
	if rows > 0 {
		args = append(args, "--rows", strconv.Itoa(rows))
	}
	cmd := exec.Command(exePath, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		ws.WriteJSON(map[string]any{"error": "spawn failed: " + err.Error()})
		return
	}
	pid := cmd.Process.Pid
	log.Printf("[relay] spawned terminal adapter '%s' (pid %d) → ws://localhost:%d", id, pid, r.port)
	ws.WriteJSON(map[string]any{"event": "terminal.spawning", "id": id})

	// Reap the child when it exits. The adapter's lifecycle is owned by tmux + the
	// display (terminal.kill → terminal.shutdown → graceful exit), not the relay —
	// we only Wait() to clear the process-table entry so closed terminals don't
	// pile up as <defunct> zombies, and to log the exit.
	go func() {
		err := cmd.Wait()
		log.Printf("[relay] terminal adapter '%s' (pid %d) exited: %v", id, pid, err)
	}()
}

// recoverTerminals re-adopts every live `glyph-*` tmux session that has NO attached client —
// orphaned sessions whose adapter died (e.g. a relay restart severed it, but detach-not-kill kept
// the session and its work alive). For each, fork a fresh `attach <id>` adapter so the display
// rebuilds the grid and the re-adoption handshake repaints it. Sessions that still have a client
// are skipped (already adopted). Dedup is via tmux's own client list — the relay keeps no adapter
// map — so this is idempotent, one-command recovery after any relay restart. (tmux-absent / non-unix:
// `ls` errors → nothing to recover, returned gracefully.)
func (r *Relay) recoverTerminals(ws *websocket.Conn) {
	out, err := exec.Command("tmux", "-L", "glyphd", "ls", "-F", "#{session_name}").Output()
	if err != nil {
		ws.WriteJSON(map[string]any{"event": "terminal.recovered", "ids": []string{}, "count": 0})
		return
	}
	exePath, err := os.Executable()
	if err != nil {
		ws.WriteJSON(map[string]any{"error": "cannot locate glyph3d-cli binary: " + err.Error()})
		return
	}
	recovered := []string{}
	var maxSeq int64
	for _, session := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		session = strings.TrimSpace(session)
		if !strings.HasPrefix(session, "glyph-") {
			continue
		}
		// Already adopted? A session with an attached client has a live adapter — skip it.
		clients, _ := exec.Command("tmux", "-L", "glyphd", "list-clients", "-t", session, "-F", "#{client_name}").Output()
		if strings.TrimSpace(string(clients)) != "" {
			continue
		}
		id := strings.TrimPrefix(session, "glyph-")
		args := []string{"attach", id, "--port", strconv.Itoa(r.port)}
		if sz, e := exec.Command("tmux", "-L", "glyphd", "display-message", "-t", session, "-p", "#{pane_width} #{pane_height}").Output(); e == nil {
			if f := strings.Fields(strings.TrimSpace(string(sz))); len(f) == 2 {
				args = append(args, "--cols", f[0], "--rows", f[1])
			}
		}
		cmd := exec.Command(exePath, args...)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if e := cmd.Start(); e != nil {
			log.Printf("[relay] recover: spawn %s failed: %v", id, e)
			continue
		}
		log.Printf("[relay] recovered terminal '%s' (pid %d)", id, cmd.Process.Pid)
		go func(c *exec.Cmd) { c.Wait() }(cmd)
		recovered = append(recovered, id)
		if n, e := strconv.ParseInt(strings.TrimPrefix(id, "term-"), 10, 64); e == nil && n > maxSeq {
			maxSeq = n
		}
	}
	// Don't let a post-restart seq reset later mint an id that collides with a recovered one.
	for {
		cur := r.termSeq.Load()
		if cur >= maxSeq || r.termSeq.CompareAndSwap(cur, maxSeq) {
			break
		}
	}
	log.Printf("[relay] terminal.recover: %d session(s) re-adopted", len(recovered))
	ws.WriteJSON(map[string]any{"event": "terminal.recovered", "ids": recovered, "count": len(recovered)})
}

func (r *Relay) notifyDisplay(event, clientID string) {
	msg, _ := json.Marshal(map[string]string{"event": event, "clientId": clientID})
	r.sendToDisplay(msg)
}

// sendJSONRPCError writes a JSON-RPC 2.0 error response to the display — for
// inline relay-level failures (e.g. a subsystem not being enabled).
func (r *Relay) sendJSONRPCError(id json.RawMessage, code int, message string) {
	resp, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(id),
		"error":   map[string]any{"code": code, "message": message},
	})
	r.sendToDisplay(resp)
}

// NotifyDisplayRPC sends a JSON-RPC 2.0 notification (no id) to the display.
// Used for server-initiated push events like live reload.
func (r *Relay) NotifyDisplayRPC(method string, params any) {
	msg, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
	r.sendToDisplay(msg)
}

// ServerConfig holds all options for the unified server.
type ServerConfig struct {
	Host      string     // Listen address (default "0.0.0.0")
	Port      int        // Listen port (default 8080)
	FSHandler *FSHandler // Filesystem JSON-RPC handler (nil if no --root)
	StaticFS  fs.FS      // Static file source: embedded FS or os.DirFS
	StaticTag string     // Label for logs: "embedded" or the disk path
}

// RunServer starts a unified HTTP + WebSocket server on a single port.
// WebSocket upgrade requests go to the relay; everything else serves static files.
func RunServer(cfg ServerConfig) error {
	relay := NewRelay()
	relay.fs = cfg.FSHandler
	relay.port = cfg.Port

	// Wire the fs/writeFile notify hook so successful writes echo an
	// fs/didChange to the display. Editable-3d-ide L0: lets the browser
	// round-trip-confirm a save and reload the affected grid.
	if cfg.FSHandler != nil {
		cfg.FSHandler.SetNotifyHook(relay.NotifyDisplayRPC)
		relay.lsp = NewLSPSupervisor(cfg.FSHandler)
		relay.lsp.SetNotifyHook(relay.NotifyDisplayRPC)
	}

	fileServer := http.FileServer(http.FS(cfg.StaticFS))

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// WebSocket upgrade → relay
		if isWebSocketUpgrade(r) {
			relay.ServeHTTP(w, r)
			return
		}

		// Static files — set correct MIME types for ES modules
		path := r.URL.Path
		switch {
		case strings.HasSuffix(path, ".js"), strings.HasSuffix(path, ".mjs"):
			w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		case strings.HasSuffix(path, ".css"):
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
		case strings.HasSuffix(path, ".json"):
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
		case strings.HasSuffix(path, ".wasm"):
			w.Header().Set("Content-Type", "application/wasm")
		case strings.HasSuffix(path, ".ttf"):
			w.Header().Set("Content-Type", "font/sfnt")
		case strings.HasSuffix(path, ".glsl"):
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		}
		fileServer.ServeHTTP(w, r)
	})

	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)

	// Startup banner
	log.Printf("[glyph3d] ══════════════════════════════════════")
	log.Printf("[glyph3d] glyph3d-cli — single-binary server")
	log.Printf("[glyph3d] App:     %s", cfg.StaticTag)
	if cfg.FSHandler != nil {
		root, reach := cfg.FSHandler.Roots()
		log.Printf("[glyph3d] Project: %s", root)
		if len(reach) > 0 {
			log.Printf("[glyph3d] Reach:   %s", strings.Join(reach, "  "))
		}
	}
	log.Printf("[glyph3d] ──────────────────────────────────────")
	log.Printf("[glyph3d]   http://localhost:%d/", cfg.Port)
	log.Printf("[glyph3d]   ws://localhost:%d  (relay)", cfg.Port)
	if cfg.Host == "0.0.0.0" {
		for _, a := range getLANAddresses() {
			log.Printf("[glyph3d]   http://%s:%d/", a, cfg.Port)
		}
	}
	log.Printf("[glyph3d] ══════════════════════════════════════")

	return listenAndServe(addr, mux)
}

// listenAndServe binds addr with a short retry window, then serves. The dev loop
// restarts the relay by killing the old one and starting a new one; a just-killed
// predecessor can hold the listen socket for a beat while it drains, so a fresh start
// racing it would otherwise die instantly on EADDRINUSE and drop the display + every
// terminal. Retrying the bind for ~5s turns that race into a brief wait. A genuine
// second server already up will exhaust the window and fail loudly — the honest answer
// (one port, one relay). Non-EADDRINUSE errors fail immediately (bad addr / perms).
func listenAndServe(addr string, handler http.Handler) error {
	const tries, gap = 25, 200 * time.Millisecond // ~5s total
	var ln net.Listener
	var err error
	for i := 0; i < tries; i++ {
		if ln, err = net.Listen("tcp", addr); err == nil {
			break
		}
		if !errors.Is(err, syscall.EADDRINUSE) {
			return err
		}
		if i == 0 {
			log.Printf("[serve] %s in use — waiting for the previous server to release it…", addr)
		}
		time.Sleep(gap)
	}
	if err != nil {
		return fmt.Errorf("listen %s: still in use after %v (another server already running?): %w",
			addr, time.Duration(tries)*gap, err)
	}
	return http.Serve(ln, handler)
}

func isWebSocketUpgrade(r *http.Request) bool {
	for _, v := range r.Header["Upgrade"] {
		if strings.EqualFold(v, "websocket") {
			return true
		}
	}
	return false
}

// RunRelay starts the relay-only server (no static files).
func RunRelay(host string, port int, fsHandler *FSHandler) error {
	relay := NewRelay()
	relay.fs = fsHandler
	relay.port = port
	if fsHandler != nil {
		fsHandler.SetNotifyHook(relay.NotifyDisplayRPC)
		relay.lsp = NewLSPSupervisor(fsHandler)
		relay.lsp.SetNotifyHook(relay.NotifyDisplayRPC)
	}

	addr := fmt.Sprintf("%s:%d", host, port)
	mux := http.NewServeMux()
	mux.Handle("/", relay)

	log.Printf("[relay] glyph3d WebSocket relay on %s", addr)
	return listenAndServe(addr, mux)
}

func getLANAddresses() []string {
	var addrs []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		ifAddrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range ifAddrs {
			if ipnet, ok := a.(*net.IPNet); ok && ipnet.IP.To4() != nil {
				addrs = append(addrs, ipnet.IP.String())
			}
		}
	}
	return addrs
}

// gitRecent reports the served root's recently-touched files: the working
// tree's uncommitted paths (git status --porcelain) and the files of the
// last n commits. Read-only, relay-resident (answers with no display) —
// built for drivers asking "what changed lately?".
func gitRecent(root string, n int) (string, map[string]any, error) {
	run := func(args ...string) (string, error) {
		cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("git %s: %s", args[0], strings.TrimSpace(string(out)))
		}
		return string(out), nil
	}
	status, err := run("status", "--porcelain")
	if err != nil {
		return "", nil, err
	}
	logOut, err := run("log", "-n", strconv.Itoa(n), "--name-only", "--pretty=format:@%h %ar · %s")
	if err != nil {
		return "", nil, err
	}

	var b strings.Builder
	uncommitted := []string{}
	if s := strings.TrimSpace(status); s != "" {
		b.WriteString("uncommitted:\n")
		for _, ln := range strings.Split(s, "\n") {
			b.WriteString("  " + ln + "\n")
			if len(ln) > 3 {
				uncommitted = append(uncommitted, strings.TrimSpace(ln[2:]))
			}
		}
	} else {
		b.WriteString("uncommitted: (clean)\n")
	}
	b.WriteString(fmt.Sprintf("last %d commit(s):\n", n))
	commits := []map[string]any{}
	for _, ln := range strings.Split(strings.TrimSpace(logOut), "\n") {
		if strings.HasPrefix(ln, "@") {
			head := strings.TrimPrefix(ln, "@")
			b.WriteString("  " + head + "\n")
			commits = append(commits, map[string]any{"head": head, "files": []string{}})
		} else if strings.TrimSpace(ln) != "" && len(commits) > 0 {
			b.WriteString("    " + ln + "\n")
			last := commits[len(commits)-1]
			last["files"] = append(last["files"].([]string), ln)
		}
	}
	b.WriteString("OK: git.recent")
	return b.String(), map[string]any{"root": root, "uncommitted": uncommitted, "commits": commits}, nil
}

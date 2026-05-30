package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/gorilla/websocket"
)

// Relay routes WebSocket messages between one display (browser) and N controllers (CLIs).
type Relay struct {
	mu           sync.RWMutex
	display      *websocket.Conn
	displayWrite chan []byte // serialized write queue for display WebSocket
	controllers  map[string]*websocket.Conn
	nextID       atomic.Int64
	upgrader     websocket.Upgrader
	fs           *FSHandler // nil if --root not provided
}

func NewRelay() *Relay {
	return &Relay{
		controllers: make(map[string]*websocket.Conn),
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

// startDisplayWriter drains the write channel, serializing all writes to the display WebSocket.
func (r *Relay) startDisplayWriter(ws *websocket.Conn, ch chan []byte) {
	go func() {
		for data := range ch {
			if err := ws.WriteMessage(websocket.TextMessage, data); err != nil {
				log.Printf("[relay] display write error: %v", err)
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
		_, msg, err := ws.ReadMessage()
		if err != nil {
			break
		}
		raw := string(msg)

		// Check for relay-direct messages (from any client, any role)
		var relayProbe struct {
			Relay string `json:"relay"`
		}
		if json.Unmarshal(msg, &relayProbe) == nil && relayProbe.Relay != "" {
			r.handleRelayMessage(ws, msg)
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
				ch := make(chan []byte, 64)
				r.displayWrite = ch
				role = "display"

				// Collect controller IDs
				ids := make([]string, 0, len(r.controllers))
				for id := range r.controllers {
					ids = append(ids, id)
				}
				r.mu.Unlock()

				// Start the single writer goroutine for this display connection
				r.startDisplayWriter(ws, ch)

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
			// Browser log forwarding: { event: "browser.log", level, text }
			// Print to stdout so CLI users see browser console output.
			var logProbe struct {
				Event string `json:"event"`
				Level string `json:"level"`
				Text  string `json:"text"`
			}
			if json.Unmarshal(msg, &logProbe) == nil && logProbe.Event == "browser.log" {
				level := logProbe.Level
				if level == "" {
					level = "log"
				}
				log.Printf("[browser:%s] %s", level, logProbe.Text)
				continue
			}

			// JSON-RPC 2.0 detection: route FS requests to FSHandler
			var probe struct {
				JSONRPC string `json:"jsonrpc"`
			}
			if json.Unmarshal(msg, &probe) == nil && probe.JSONRPC == "2.0" {
				if r.fs != nil {
					var rpc rpcRequest
					if err := json.Unmarshal(msg, &rpc); err == nil {
						r.fs.Handle(rpc.Method, rpc.ID, rpc.Params, r.sendToDisplay)
					} else {
						log.Printf("[relay] malformed JSON-RPC from display: %.100s", raw)
					}
				} else {
					// No FSHandler — return JSON-RPC error inline
					var rpc struct {
						ID json.RawMessage `json:"id"`
					}
					json.Unmarshal(msg, &rpc)
					errResp, _ := json.Marshal(map[string]any{
						"jsonrpc": "2.0",
						"id":      json.RawMessage(rpc.ID),
						"error":   map[string]any{"code": -32003, "message": "filesystem not enabled (start relay with --root)"},
					})
					r.sendToDisplay(errResp)
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
		ch := r.displayWrite
		r.displayWrite = nil
		r.mu.Unlock()
		if ch != nil {
			close(ch)
		}
		log.Printf("[relay] display disconnected")
	} else if role == "controller" && clientID != "" {
		r.mu.Lock()
		delete(r.controllers, clientID)
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

func (r *Relay) handleRelayMessage(ws *websocket.Conn, msg []byte) {
	var m struct {
		Relay      string          `json:"relay"`
		Font       string          `json:"font"`
		Size       float64         `json:"size"`
		PNG        string          `json:"png"`
		Descriptor json.RawMessage `json:"descriptor"`
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

	default:
		ws.WriteJSON(map[string]any{"error": fmt.Sprintf("unknown relay command: %s", m.Relay)})
	}
}

func (r *Relay) notifyDisplay(event, clientID string) {
	msg, _ := json.Marshal(map[string]string{"event": event, "clientId": clientID})
	r.sendToDisplay(msg)
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
	WatchRoot string     // Live reload: watch this directory for source changes (empty = disabled)
}

// RunServer starts a unified HTTP + WebSocket server on a single port.
// WebSocket upgrade requests go to the relay; everything else serves static files.
func RunServer(cfg ServerConfig) error {
	relay := NewRelay()
	relay.fs = cfg.FSHandler

	// Wire the fs/writeFile notify hook so successful writes echo an
	// fs/didChange to the display. Editable-3d-ide L0: lets the browser
	// round-trip-confirm a save and reload the affected grid.
	if cfg.FSHandler != nil {
		cfg.FSHandler.SetNotifyHook(relay.NotifyDisplayRPC)
	}

	// Live reload: watch source directories and push notifications to the browser
	if cfg.WatchRoot != "" {
		lr, err := NewLiveReloader(func(path string) {
			rel, _ := filepath.Rel(cfg.WatchRoot, path)
			log.Printf("[livereload] %s changed → notifying browser", rel)
			relay.NotifyDisplayRPC("fs/didChange", map[string]string{
				"path":  rel,
				"event": "change",
			})
		})
		if err != nil {
			log.Printf("[livereload] failed to start watcher: %v", err)
		} else {
			lr.Watch(
				filepath.Join(cfg.WatchRoot, "src"),
				filepath.Join(cfg.WatchRoot, "app"),
			)
			log.Printf("[livereload] watching src/, app/ for changes")
		}
	}

	fileServer := http.FileServer(http.FS(cfg.StaticFS))

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// WebSocket upgrade → relay
		if isWebSocketUpgrade(r) {
			relay.ServeHTTP(w, r)
			return
		}

		// In local/dev mode, prevent browser caching so live reload
		// always picks up the latest source files.
		if cfg.WatchRoot != "" {
			w.Header().Set("Cache-Control", "no-store")
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
		log.Printf("[glyph3d] Project: %s", cfg.FSHandler.root)
	}
	log.Printf("[glyph3d] ──────────────────────────────────────")
	log.Printf("[glyph3d]   http://localhost:%d/app/ide.html", cfg.Port)
	log.Printf("[glyph3d]   ws://localhost:%d  (relay)", cfg.Port)
	if cfg.Host == "0.0.0.0" {
		for _, a := range getLANAddresses() {
			log.Printf("[glyph3d]   http://%s:%d/app/ide.html", a, cfg.Port)
		}
	}
	log.Printf("[glyph3d] ══════════════════════════════════════")

	return http.ListenAndServe(addr, mux)
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
	if fsHandler != nil {
		fsHandler.SetNotifyHook(relay.NotifyDisplayRPC)
	}

	addr := fmt.Sprintf("%s:%d", host, port)
	mux := http.NewServeMux()
	mux.Handle("/", relay)

	log.Printf("[relay] glyph3d WebSocket relay on %s", addr)
	return http.ListenAndServe(addr, mux)
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

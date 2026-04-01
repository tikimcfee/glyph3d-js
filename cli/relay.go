package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
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

// RunRelay starts the relay server. Blocks until error.
// fsHandler may be nil if --root was not provided.
func RunRelay(host string, port int, fsHandler *FSHandler) error {
	relay := NewRelay()
	relay.fs = fsHandler

	addr := fmt.Sprintf("%s:%d", host, port)
	mux := http.NewServeMux()
	mux.Handle("/", relay)

	// Print connection info
	log.Printf("[relay] glyph3d WebSocket relay")
	log.Printf("[relay] Listening on %s", addr)
	log.Printf("[relay]   ws://localhost:%d", port)
	if host == "0.0.0.0" {
		if addrs := getLANAddresses(); len(addrs) > 0 {
			for _, a := range addrs {
				log.Printf("[relay]   ws://%s:%d", a, port)
			}
		}
	}

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

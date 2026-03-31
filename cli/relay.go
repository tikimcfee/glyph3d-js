package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"sync/atomic"

	"github.com/gorilla/websocket"
)

// Relay routes WebSocket messages between one display (browser) and N controllers (CLIs).
type Relay struct {
	mu          sync.RWMutex
	display     *websocket.Conn
	controllers map[string]*websocket.Conn
	nextID      atomic.Int64
	upgrader    websocket.Upgrader
	fs          *FSHandler // nil if --root not provided
}

func NewRelay() *Relay {
	return &Relay{
		controllers: make(map[string]*websocket.Conn),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
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
				role = "display"

				// Collect controller IDs
				ids := make([]string, 0, len(r.controllers))
				for id := range r.controllers {
					ids = append(ids, id)
				}
				r.mu.Unlock()

				log.Printf("[relay] display connected from %s", ws.RemoteAddr())
				ws.WriteJSON(map[string]any{
					"ok":          true,
					"role":        "display",
					"controllers": ids,
				})
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
			d.WriteMessage(websocket.TextMessage, envelope)

		} else if role == "display" {
			// JSON-RPC 2.0 detection: route FS requests to FSHandler
			var probe struct {
				JSONRPC string `json:"jsonrpc"`
			}
			if json.Unmarshal(msg, &probe) == nil && probe.JSONRPC == "2.0" {
				if r.fs != nil {
					var rpc rpcRequest
					if err := json.Unmarshal(msg, &rpc); err == nil {
						r.fs.Handle(rpc.Method, rpc.ID, rpc.Params, ws)
					} else {
						log.Printf("[relay] malformed JSON-RPC from display: %.100s", raw)
					}
				} else {
					// No FSHandler — return JSON-RPC error
					var rpc struct {
						ID json.RawMessage `json:"id"`
					}
					json.Unmarshal(msg, &rpc)
					sendRPCError(ws, rpc.ID, -32003, "filesystem not enabled (start relay with --root)", nil)
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
		r.mu.Unlock()
		log.Printf("[relay] display disconnected")
	} else if role == "controller" && clientID != "" {
		r.mu.Lock()
		delete(r.controllers, clientID)
		r.mu.Unlock()
		log.Printf("[relay] controller '%s' disconnected", clientID)
		r.notifyDisplay("client_disconnected", clientID)
	}
}

func (r *Relay) notifyDisplay(event, clientID string) {
	r.mu.RLock()
	d := r.display
	r.mu.RUnlock()
	if d == nil {
		return
	}
	msg, _ := json.Marshal(map[string]string{"event": event, "clientId": clientID})
	d.WriteMessage(websocket.TextMessage, msg)
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

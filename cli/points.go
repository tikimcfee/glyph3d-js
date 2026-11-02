package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Relay-resident points (docs/planes/DESIGN.md §3.8, slice 9): an agent's point (`point.show`)
// made while no display is connected — or before one has booted — is KEPT here and delivered
// when a display connects; while one is connected it reports its live points back
// (points/sync), so a reload of the page brings them back too. The relay is transport: a point
// is kept as the `point.show` arguments that recreate it, run on the display as its owner.
//
//   with no display:  point.show (an identified caller's), point.clear, point.list answered here
//   display RPCs:     points/list → the kept points; points/sync {points} → replaces them

// defaultMaxPoints is the store's cap when serve isn't told otherwise (--max-points).
const defaultMaxPoints = 64

// maxPoints is the cap a relay's store is born with (serve --max-points sets it before serving).
var maxPoints = defaultMaxPoints

// pointStores holds each relay's store (made on first use) — the relay's own state, beside it.
var pointStores sync.Map // *Relay → *pointStore

// pointStore is this relay's kept points.
func (r *Relay) pointStore() *pointStore {
	v, _ := pointStores.LoadOrStore(r, newPointStore(maxPoints))
	return v.(*pointStore)
}

// storedPoint is one agent's point as the relay keeps it.
type storedPoint struct {
	Who  string   `json:"who"`
	Args []string `json:"args"` // point.show's arguments: <ref> [--kind k] [--say s] [--with w]
	TS   int64    `json:"ts"`   // when it was made or last synced (unix ms)
}

// pointStore keeps at most one point per agent, at most max in all (the oldest leaves first).
type pointStore struct {
	mu  sync.Mutex
	max int
	by  map[string]storedPoint
}

func newPointStore(max int) *pointStore {
	return &pointStore{max: max, by: make(map[string]storedPoint)}
}

// Put keeps who's point (replacing its last), evicting the oldest past the cap.
func (s *pointStore) Put(who string, args []string, ts int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.by[who] = storedPoint{Who: who, Args: append([]string(nil), args...), TS: ts}
	for len(s.by) > s.max && s.max > 0 {
		oldest := ""
		for k, p := range s.by {
			if oldest == "" || p.TS < s.by[oldest].TS || (p.TS == s.by[oldest].TS && k < oldest) {
				oldest = k
			}
		}
		delete(s.by, oldest)
	}
}

// Clear drops who's point; "" drops every one. Returns the agents cleared.
func (s *pointStore) Clear(who string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for k := range s.by {
		if who == "" || k == who {
			out = append(out, k)
			delete(s.by, k)
		}
	}
	sort.Strings(out)
	return out
}

// Replace makes the store exactly `list` (the display's live points), capped as Put caps.
func (s *pointStore) Replace(list []storedPoint) {
	s.mu.Lock()
	s.by = make(map[string]storedPoint)
	s.mu.Unlock()
	for _, p := range list {
		if p.Who != "" && len(p.Args) > 0 {
			s.Put(p.Who, p.Args, p.TS)
		}
	}
}

// List is every kept point, newest first.
func (s *pointStore) List() []storedPoint {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]storedPoint, 0, len(s.by))
	for _, p := range s.by {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].TS != out[j].TS {
			return out[i].TS > out[j].TS
		}
		return out[i].Who < out[j].Who
	})
	return out
}

// pointCommand answers point.show / point.clear / point.list from the store (no display
// connected). ok=false: not a point verb (the caller goes on). Arguments are checked as the
// display checks them, so a point the relay keeps is one the display will take.
func (s *pointStore) pointCommand(argv []string, caller string, reply func(string, any), fail func(error)) (ok bool) {
	if len(argv) == 0 {
		return false
	}
	verb, args := argv[0], argv[1:]
	switch verb {
	case "point.show":
		if caller == "" {
			fail(fmt.Errorf("point.show needs an identified caller: glyph3d-cli --as <name> (or $AGENT_NAME) — an anonymous point has no owner or hue"))
			return true
		}
		ref, kind, with := 0, "look", false
		for i := 0; i < len(args); i++ {
			switch args[i] {
			case "--kind":
				i++
				if i < len(args) {
					kind = args[i]
				}
			case "--say":
				i++
			case "--with":
				i++
				with = true
			default:
				ref++
			}
		}
		if kind != "look" && kind != "suggest" {
			fail(fmt.Errorf("--kind is look or suggest (got '%s')", kind))
			return true
		}
		if with && kind != "suggest" {
			fail(fmt.Errorf("--with is a suggest point's proposed text (--kind suggest)"))
			return true
		}
		if ref == 0 {
			fail(fmt.Errorf("usage: point.show <ref> [--kind look|suggest] [--say <line>] [--with <proposed text>]"))
			return true
		}
		s.Put(caller, args, time.Now().UnixMilli())
		reply(fmt.Sprintf("OK: %s's point kept by the relay — no display is connected; it is shown when one connects", caller),
			map[string]any{"who": caller, "kept": true, "args": args})
	case "point.clear":
		target := ""
		if len(args) > 0 {
			target = args[0]
		}
		if caller != "" {
			if target != "" && target != caller {
				fail(fmt.Errorf("%s can clear only its own point (not '%s')", caller, target))
				return true
			}
			target = caller
		} else if target == "all" {
			target = ""
		}
		cleared := s.Clear(target)
		if cleared == nil {
			cleared = []string{}
		}
		reply(fmt.Sprintf("OK: cleared %d kept point(s)", len(cleared)), map[string]any{"cleared": cleared})
	case "point.list":
		pts := s.List()
		if len(pts) == 0 {
			reply("OK: no points (kept by the relay — no display is connected)", pts)
			return true
		}
		lines := make([]string, 0, len(pts))
		for _, p := range pts {
			lines = append(lines, fmt.Sprintf("  %s [kept] %s", p.Who, strings.Join(p.Args, " ")))
		}
		reply(fmt.Sprintf("OK: %d point(s) kept by the relay (no display connected)\n%s", len(pts), strings.Join(lines, "\n")), pts)
	default:
		return false
	}
	return true
}

// tryRelayPointWhenNoDisplay answers a point verb on the controller's socket from the store
// (called only while no display is connected). false: not a point verb.
func (r *Relay) tryRelayPointWhenNoDisplay(ws *websocket.Conn, raw, caller string) bool {
	var argv []string
	if parsed, isCall := parseCallLine(raw); isCall {
		argv = parsed
	} else {
		argv = strings.Fields(raw)
	}
	fail := func(err error) { ws.WriteMessage(websocket.TextMessage, []byte("ERR: "+err.Error())) }
	reply := func(text string, data any) {
		msg, err := json.Marshal(map[string]any{"response": text, "data": data})
		if err != nil {
			fail(err)
			return
		}
		ws.WriteMessage(websocket.TextMessage, msg)
	}
	return r.pointStore().pointCommand(argv, caller, reply, fail)
}

// handlePointsRPC answers the display's points/* calls: points/list (what to show on connect)
// and points/sync {points} (its live points — the store becomes exactly them).
func (r *Relay) handlePointsRPC(method string, rawID json.RawMessage, params json.RawMessage) {
	result, err := r.pointStore().rpc(method, params)
	if err != nil {
		r.sendJSONRPCError(rawID, -32602, err.Error())
		return
	}
	resp, mErr := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": rawID, "result": result})
	if mErr == nil {
		r.sendToDisplay(resp)
	}
}

// rpc is handlePointsRPC's logic, socket-free (tested directly).
func (s *pointStore) rpc(method string, params json.RawMessage) (any, error) {
	switch method {
	case "points/list":
		return map[string]any{"points": s.List()}, nil
	case "points/sync":
		var p struct {
			Points []storedPoint `json:"points"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, fmt.Errorf("invalid points/sync params: %v", err)
		}
		s.Replace(p.Points)
		return map[string]any{"kept": len(s.List())}, nil
	default:
		return nil, fmt.Errorf("unknown method %s", method)
	}
}

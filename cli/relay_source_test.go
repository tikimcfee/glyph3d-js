package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// The source role is the relay's third client class: sensor devices that push
// perishable frames upstream (hand landmarks from an ARKit phone, camera
// previews) rather than issuing commands. These tests lock the three properties
// the rest of the pipeline depends on:
//
//   - the SOURCE handshake is distinguishable from DISPLAY and from a controller
//   - MANY sources may connect at once, each addressable by its own id
//   - frames reach the display verbatim, stamped with provenance
//
// They drive a real httptest server so the handshake, role dispatch, writer
// goroutine, and teardown all run as they do in production.

// newTestRelay starts a relay on an httptest server and returns a dialer for it.
func newTestRelay(t *testing.T) (*Relay, func(t *testing.T) *websocket.Conn) {
	t.Helper()
	r := NewRelay()
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	url := "ws://" + strings.TrimPrefix(srv.URL, "http://")

	return r, func(t *testing.T) *websocket.Conn {
		t.Helper()
		c, _, err := websocket.DefaultDialer.Dial(url, nil)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		t.Cleanup(func() { c.Close() })
		return c
	}
}

// readJSON reads one text frame and decodes it, failing on timeout.
func readJSON(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, data, err := c.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("decode %q: %v", data, err)
	}
	return m
}

// awaitEvent reads until it sees the named event, so unrelated traffic
// (acks, other sources' notifications) can't make the test flaky.
func awaitEvent(t *testing.T, c *websocket.Conn, event string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		m := readJSON(t, c)
		if m["event"] == event {
			return m
		}
	}
	t.Fatalf("never saw event %q", event)
	return nil
}

func TestSourceHandshakeIsDistinctFromController(t *testing.T) {
	r, dial := newTestRelay(t)

	src := dial(t)
	if err := src.WriteMessage(websocket.TextMessage, []byte("SOURCE hand")); err != nil {
		t.Fatal(err)
	}
	hello := readJSON(t, src)
	if hello["role"] != "source" {
		t.Fatalf("role = %v, want source", hello["role"])
	}
	if hello["kind"] != "hand" {
		t.Fatalf("kind = %v, want hand", hello["kind"])
	}
	id, _ := hello["sourceId"].(string)
	if !strings.HasPrefix(id, "src-hand-") {
		t.Fatalf("sourceId = %q, want src-hand-* prefix", id)
	}

	// A source must NOT land in the controller map — otherwise its frames would
	// be parsed as commands and it would show up as a command target.
	r.mu.RLock()
	nCtrl, nSrc := len(r.controllers), len(r.sources)
	r.mu.RUnlock()
	if nCtrl != 0 {
		t.Errorf("source registered as controller (controllers=%d)", nCtrl)
	}
	if nSrc != 1 {
		t.Errorf("sources = %d, want 1", nSrc)
	}
}

// A bare "SOURCE" greeting is the minimum viable device; kind defaults to hand.
func TestSourceHandshakeDefaultsKind(t *testing.T) {
	_, dial := newTestRelay(t)
	src := dial(t)
	src.WriteMessage(websocket.TextMessage, []byte("SOURCE"))
	if hello := readJSON(t, src); hello["kind"] != "hand" {
		t.Fatalf("kind = %v, want hand", hello["kind"])
	}
}

// The id embeds the kind, so a device must not be able to inject separators
// into it via the handshake.
func TestSourceHandshakeRejectsUnsafeKind(t *testing.T) {
	for _, kind := range []string{"hand-evil", "a b", "../x", "hand.1"} {
		got, ok := parseSourceHandshake("SOURCE " + kind)
		if !ok {
			t.Fatalf("%q: not recognized as a source", kind)
		}
		if got != "hand" {
			t.Errorf("kind %q sanitized to %q, want hand", kind, got)
		}
	}
	if _, ok := parseSourceHandshake("DISPLAY"); ok {
		t.Error("DISPLAY parsed as a source handshake")
	}
	if _, ok := parseSourceHandshake("grid.list"); ok {
		t.Error("a command parsed as a source handshake")
	}
}

func TestSourceFrameReachesDisplayWithProvenance(t *testing.T) {
	_, dial := newTestRelay(t)

	display := dial(t)
	display.WriteMessage(websocket.TextMessage, []byte("DISPLAY"))
	ack := readJSON(t, display)
	if ack["role"] != "display" {
		t.Fatalf("display ack: %v", ack)
	}
	if _, ok := ack["sources"]; !ok {
		t.Error("display ack omits sources[] — a reloaded page can't re-adopt sensors")
	}

	src := dial(t)
	src.WriteMessage(websocket.TextMessage, []byte("SOURCE hand"))
	hello := readJSON(t, src)
	srcID := hello["sourceId"].(string)

	if ev := awaitEvent(t, display, "source_connected"); ev["sourceId"] != srcID {
		t.Fatalf("source_connected id = %v, want %s", ev["sourceId"], srcID)
	}

	// A handFrame in the shape MotionSource (the iOS app) actually sends.
	frame := `{"type":"handFrame","timestamp":12.5,` +
		`"hands":[{"handedness":"right","landmarks":[[0.5,0.25,0.4]]}],` +
		`"scene":{"trackingState":"normal","viewport":{"depthRange":[0.2,0.9]}}}`
	src.WriteMessage(websocket.TextMessage, []byte(frame))

	fwd := awaitEvent(t, display, "source.frame")
	if fwd["source"] != srcID || fwd["kind"] != "hand" {
		t.Errorf("provenance = source:%v kind:%v, want %s/hand", fwd["source"], fwd["kind"], srcID)
	}
	// The relay is deliberately schema-blind: the payload must arrive untouched
	// so a new device type never requires a Go change.
	data, ok := fwd["data"].(map[string]any)
	if !ok {
		t.Fatalf("data not an object: %v", fwd["data"])
	}
	if data["type"] != "handFrame" {
		t.Errorf("payload type = %v, want handFrame", data["type"])
	}
	scene := data["scene"].(map[string]any)["viewport"].(map[string]any)["depthRange"].([]any)
	if scene[1].(float64) != 0.9 {
		t.Errorf("nested ARKit payload mangled: %v", scene)
	}
}

// The limitation this whole change exists to remove: more than one device
// streaming at the same time, each independently addressable.
func TestManySourcesStreamConcurrently(t *testing.T) {
	r, dial := newTestRelay(t)

	display := dial(t)
	display.WriteMessage(websocket.TextMessage, []byte("DISPLAY"))
	readJSON(t, display)

	kinds := []string{"hand", "hand", "camera"}
	ids := make([]string, 0, len(kinds))
	for _, k := range kinds {
		s := dial(t)
		s.WriteMessage(websocket.TextMessage, []byte("SOURCE "+k))
		hello := readJSON(t, s)
		id := hello["sourceId"].(string)
		ids = append(ids, id)
		s.WriteMessage(websocket.TextMessage, []byte(`{"type":"handFrame","hands":[]}`))
	}

	if len(ids) != 3 {
		t.Fatalf("connected %d sources, want 3", len(ids))
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			t.Fatalf("duplicate source id %q — sources are not independently addressable", id)
		}
		seen[id] = true
	}

	r.mu.RLock()
	n := len(r.sources)
	summaries := r.sourceSummariesLocked()
	r.mu.RUnlock()
	if n != 3 {
		t.Fatalf("relay holds %d sources, want 3", n)
	}

	byKind := map[string]int{}
	for _, s := range summaries {
		byKind[s.Kind]++
	}
	if byKind["hand"] != 2 || byKind["camera"] != 1 {
		t.Errorf("kinds = %v, want 2 hand + 1 camera", byKind)
	}

	// Frames from every source must reach the display, each tagged with its origin.
	origins := map[string]bool{}
	for i := 0; i < len(ids); i++ {
		fwd := awaitEvent(t, display, "source.frame")
		origins[fwd["source"].(string)] = true
	}
	for _, id := range ids {
		if !origins[id] {
			t.Errorf("no frame arrived from source %s", id)
		}
	}
}

// Frames are perishable. Against a saturated queue the policy is DROP-OLDEST:
// the newest pose must survive and stale ones must be evicted, so rendered lag
// stays bounded at the queue depth instead of growing without limit behind a
// slow display. Driven directly against the send path — saturating a real
// socket depends on kernel buffer sizes and would be flaky.
func TestSourceFramesDropOldestWhenSaturated(t *testing.T) {
	r := NewRelay()
	const depth = 4
	r.displayFrames = make(chan []byte, depth)

	// Fill to capacity: these all fit, so none report a drop.
	for i := 0; i < depth; i++ {
		if !r.sendFrameToDisplay([]byte{byte(i)}) {
			t.Fatalf("frame %d reported a drop while the queue had room", i)
		}
	}
	// Past capacity: every send must report a drop but still be accepted.
	for i := depth; i < depth+20; i++ {
		if r.sendFrameToDisplay([]byte{byte(i)}) {
			t.Fatalf("frame %d reported no drop on a full queue", i)
		}
	}

	// The queue must hold the NEWEST frames, not the oldest — that is the whole
	// point. The last value sent is 23; it must be in the queue.
	got := make([]byte, 0, depth)
	for len(r.displayFrames) > 0 {
		got = append(got, (<-r.displayFrames)[0])
	}
	if len(got) != depth {
		t.Fatalf("queue holds %d frames, want %d", len(got), depth)
	}
	newest := byte(depth + 20 - 1)
	if got[len(got)-1] != newest {
		t.Errorf("tail of queue = %d, want newest frame %d (drop-oldest not holding)", got[len(got)-1], newest)
	}
	if got[0] == 0 {
		t.Error("oldest frame survived saturation — policy is drop-newest, want drop-oldest")
	}
}

// With no display attached a source's frames have nowhere to go; sending must
// be a harmless no-op rather than a panic or a block.
func TestSourceFramesWithNoDisplayAreHarmless(t *testing.T) {
	r := NewRelay()
	if r.sendFrameToDisplay([]byte(`{"type":"handFrame"}`)) {
		t.Error("reported delivery with no display connected")
	}
}

// End-to-end: a device firehosing far past the queue depth must never have its
// write loop blocked by a display that isn't keeping up.
func TestSourceWritesNeverBlock(t *testing.T) {
	_, dial := newTestRelay(t)

	display := dial(t)
	display.WriteMessage(websocket.TextMessage, []byte("DISPLAY"))
	readJSON(t, display)

	src := dial(t)
	src.WriteMessage(websocket.TextMessage, []byte("SOURCE hand"))
	srcID := readJSON(t, src)["sourceId"].(string)

	const burst = 500
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < burst; i++ {
			if err := src.WriteMessage(websocket.TextMessage, []byte(`{"type":"handFrame","hands":[]}`)); err != nil {
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("source write loop blocked — a slow display must not stall capture")
	}

	// Every frame must be accounted for as either delivered or dropped.
	time.Sleep(500 * time.Millisecond)
	found := false
	for _, s := range summariesOf(t, srcID, dial) {
		if s.ID != srcID {
			continue
		}
		found = true
		if s.Frames+s.Dropped == 0 {
			t.Error("no frames accounted for after the burst")
		}
	}
	if !found {
		t.Errorf("source %s missing from source.list", srcID)
	}
}

// summariesOf asks the relay for source.list over a controller connection —
// exercising the same relay-resident verb path the CLI uses.
func summariesOf(t *testing.T, _ string, dial func(t *testing.T) *websocket.Conn) []sourceSummary {
	t.Helper()
	ctrl := dial(t)
	ctrl.WriteMessage(websocket.TextMessage, []byte("source.list"))

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		ctrl.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, data, err := ctrl.ReadMessage()
		if err != nil {
			t.Fatalf("source.list read: %v", err)
		}
		var envelope struct {
			Data []sourceSummary `json:"data"`
		}
		if json.Unmarshal(data, &envelope) == nil && envelope.Data != nil {
			return envelope.Data
		}
	}
	t.Fatal("no source.list response")
	return nil
}

// source.list must answer with no display connected — that is exactly the
// situation you are in when debugging why frames aren't showing up.
func TestSourceListAnswersWithoutDisplay(t *testing.T) {
	_, dial := newTestRelay(t)

	src := dial(t)
	src.WriteMessage(websocket.TextMessage, []byte("SOURCE camera"))
	hello := readJSON(t, src)
	srcID := hello["sourceId"].(string)

	got := summariesOf(t, srcID, dial)
	if len(got) != 1 || got[0].ID != srcID || got[0].Kind != "camera" {
		t.Fatalf("source.list = %+v, want the one camera source %s", got, srcID)
	}
}

func TestSourceDisconnectNotifiesDisplay(t *testing.T) {
	r, dial := newTestRelay(t)

	display := dial(t)
	display.WriteMessage(websocket.TextMessage, []byte("DISPLAY"))
	readJSON(t, display)

	src := dial(t)
	src.WriteMessage(websocket.TextMessage, []byte("SOURCE hand"))
	srcID := readJSON(t, src)["sourceId"].(string)
	awaitEvent(t, display, "source_connected")

	src.Close()

	if ev := awaitEvent(t, display, "source_disconnected"); ev["sourceId"] != srcID {
		t.Fatalf("disconnect id = %v, want %s", ev["sourceId"], srcID)
	}
	r.mu.RLock()
	n := len(r.sources)
	r.mu.RUnlock()
	if n != 0 {
		t.Errorf("relay still holds %d sources after disconnect", n)
	}
}

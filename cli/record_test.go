package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// recordCmd runs source.record over a controller connection and returns the reply's data.
func recordCmd(t *testing.T, dial func(t *testing.T) *websocket.Conn, args string) (string, recordStatus) {
	t.Helper()
	ctrl := dial(t)
	defer ctrl.Close()
	ctrl.WriteMessage(websocket.TextMessage, []byte("source.record "+args))
	// Skip the controller greeting ("OK: connected as …"); the reply is ERR text or the JSON envelope.
	var r struct {
		Response string       `json:"response"`
		Data     recordStatus `json:"data"`
	}
	for {
		ctrl.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, msg, err := ctrl.ReadMessage()
		if err != nil {
			t.Fatalf("source.record %s: %v", args, err)
		}
		if strings.HasPrefix(string(msg), "ERR") {
			return string(msg), recordStatus{}
		}
		if json.Unmarshal(msg, &r) == nil && r.Response != "" {
			break
		}
	}
	return r.Response, r.Data
}

// A recording holds every frame a source sent — raw, with arrival times — plus the source's
// comings and goings, and it records with NO display connected (frames recorded = frames sent).
func TestSourceRecordWritesRawFrames(t *testing.T) {
	recordDir = t.TempDir()
	defer func() { recordDir = "" }()
	_, dial := newTestRelay(t)

	text, st := recordCmd(t, dial, "start ../../evil/name")
	if !st.Recording || st.Name != "evil-name" || filepath.Dir(st.Path) != recordDir {
		t.Fatalf("start: %q %+v (name must be sanitized and stay in the record dir)", text, st)
	}
	if text, _ := recordCmd(t, dial, "start again"); !strings.HasPrefix(text, "ERR") {
		t.Errorf("a second start must refuse: %q", text)
	}

	src := dial(t)
	src.WriteMessage(websocket.TextMessage, []byte("SOURCE hand"))
	srcID := readJSON(t, src)["sourceId"].(string)
	const n = 40
	for i := 0; i < n; i++ {
		src.WriteMessage(websocket.TextMessage, []byte(`{"type":"handFrame","v":2,"timestamp":`+strconv.Itoa(i)+`,"hands":[]}`))
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		_, s := recordCmd(t, dial, "status")
		if s.Frames == n || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	src.Close()
	time.Sleep(100 * time.Millisecond) // let the disconnect land
	_, st = recordCmd(t, dial, "stop")
	if st.Recording || st.Frames != n || st.Dropped != 0 {
		t.Fatalf("stop: %+v, want %d frames, 0 dropped", st, n)
	}

	f, err := os.Open(st.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	var header map[string]any
	frames, events, lastT := 0, []string{}, 0.0
	for i := 0; sc.Scan(); i++ {
		var line map[string]any
		if err := json.Unmarshal(sc.Bytes(), &line); err != nil {
			t.Fatalf("line %d not JSON: %v", i, err)
		}
		switch line["type"] {
		case "header":
			header = line
		case "frame":
			if line["source"] != srcID || line["kind"] != "hand" {
				t.Fatalf("frame line provenance: %v", line)
			}
			data := line["data"].(map[string]any)
			if int(data["timestamp"].(float64)) != frames {
				t.Fatalf("frame %d out of order or altered: %v", frames, data)
			}
			if tt := line["t"].(float64); tt < lastT {
				t.Fatalf("arrival times go backwards")
			} else {
				lastT = tt
			}
			frames++
		case "source":
			events = append(events, line["event"].(string))
		}
	}
	if header == nil || header["v"].(float64) != 1 {
		t.Errorf("missing header line")
	}
	if frames != n {
		t.Errorf("file holds %d frames, want %d", frames, n)
	}
	if strings.Join(events, ",") != "connected,disconnected" {
		t.Errorf("source events %v, want connected,disconnected", events)
	}
	if text, _ := recordCmd(t, dial, "stop"); !strings.HasPrefix(text, "ERR") {
		t.Errorf("stop when not recording must say so: %q", text)
	}
}

// Recording never overwrites: the same name twice gets a suffix.
func TestSourceRecordNeverOverwrites(t *testing.T) {
	recordDir = t.TempDir()
	defer func() { recordDir = "" }()
	_, dial := newTestRelay(t)
	_, a := recordCmd(t, dial, "start same")
	recordCmd(t, dial, "stop")
	_, b := recordCmd(t, dial, "start same")
	recordCmd(t, dial, "stop")
	if a.Path == b.Path || filepath.Base(b.Path) != "same-2.jsonl" {
		t.Errorf("second recording %q must not overwrite %q", b.Path, a.Path)
	}
}

// A full queue (a disk that can't keep up) drops frames and counts them — never blocks the caller.
func TestSourceRecordDropsRatherThanBlocks(t *testing.T) {
	r := NewRelay()
	rec := &recorder{q: make(chan []byte, 2), started: time.Now()} // no writer goroutine: the queue fills
	r.rec = rec
	done := make(chan struct{})
	go func() {
		for i := 0; i < 50; i++ {
			r.recordFrame("src-hand-0", "hand", []byte(`{}`))
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("recordFrame blocked on a full queue")
	}
	if rec.frames.Load() != 2 || rec.dropped.Load() != 48 {
		t.Errorf("frames %d dropped %d, want 2 and 48", rec.frames.Load(), rec.dropped.Load())
	}
}

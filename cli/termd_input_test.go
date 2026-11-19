package main

import (
	"encoding/json"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"glyph3d-cli/termdwire"
)

// pipeClient is a termdClient on one end of a pipe, with what the other end read.
func pipeClient(t *testing.T, features []string, maxFrame int) (*termdClient, func() int) {
	t.Helper()
	a, b := net.Pipe()
	t.Cleanup(func() { a.Close(); b.Close() })
	var mu sync.Mutex
	read := 0
	go func() {
		buf := make([]byte, 64<<10)
		for {
			n, err := b.Read(buf)
			mu.Lock()
			read += n
			mu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	c := termdwire.NewConn(a, termdwire.Welcome{
		Daemon:   "g3d-termd/test",
		Features: features,
		MaxFrame: maxFrame,
	})
	return c, func() int {
		time.Sleep(50 * time.Millisecond)
		mu.Lock()
		defer mu.Unlock()
		return read
	}
}

// TestTermdRequestOverMaxFrameIsRefusedUnsent: a paste whose request is larger than the daemon's
// max_frame (JSON makes a control character six bytes) is too_large here and never written: the
// daemon would end the whole connection over it, and the adapter's subscription with it.
func TestTermdRequestOverMaxFrameIsRefusedUnsent(t *testing.T) {
	c, read := pipeClient(t, []string{"key", "paste"}, 1024)
	_, err := c.Send("paste", map[string]any{"handle": 1, "text": strings.Repeat("\x01", 200)})
	if !isTermdCode(err, "too_large") || !strings.Contains(err.Error(), "max_frame") {
		t.Fatalf("a 1.2 KB request against max_frame 1024: %v", err)
	}
	if n := read(); n != 0 {
		t.Fatalf("%d bytes of the refused request reached the daemon", n)
	}
	if _, err := c.Send("paste", map[string]any{"handle": 1, "text": "hi"}); err != nil {
		t.Fatalf("a small paste after it: %v", err)
	}
	if read() == 0 {
		t.Fatal("the small paste never left")
	}
}

// TestInputOpsFollowTheBrainsFeatures: a brain without `key`/`paste` (protocol 1.1, a holder kept
// from an earlier build) gets no key or paste request: the adapter checks WELCOME.features, logs
// the missing op once, and the status names it for the display.
func TestInputOpsFollowTheBrainsFeatures(t *testing.T) {
	old, read := pipeClient(t, []string{"raw", "status", "upgrade"}, 0)
	s := &termdSession{tc: old, handle: 1}
	if s.offers("key") || s.offers("key") || s.offers("paste") {
		t.Fatal("an old brain offers key or paste")
	}
	if read() != 0 {
		t.Fatal("offers wrote to the daemon")
	}
	if got := old.Lacks(termdInputOps); strings.Join(got, ",") != "key,paste" {
		t.Fatalf("Lacks = %v", got)
	}
	cur, _ := pipeClient(t, []string{"raw", "key", "paste"}, 0)
	if !(&termdSession{tc: cur}).offers("key") || len(cur.Lacks(termdInputOps)) != 0 {
		t.Fatal("a 1.2 brain lacks key")
	}

	doc, _ := json.Marshal(map[string]any{"daemon": map[string]any{"version": "g3d-termd/0.1.0"}, "terminals": []any{}})
	p := termdStatusParams{Relay: termdRelayState{State: "ok", NS: "n", Lacks: []string{"key", "paste"}}, Status: doc}
	if txt := termdStatusText(p); !strings.Contains(txt, "typing can't reach it: no key, paste op") {
		t.Fatalf("the status line doesn't say typing is lost: %q", txt)
	}
	f := newTermdStatusFollower("n", func(termdStatusParams) {}, nil)
	f.state, f.lacks = "ok", []string{"key"}
	if got := f.Params().Relay.Lacks; len(got) != 1 || got[0] != "key" {
		t.Fatalf("relay.lacks = %v", got)
	}
	f.state = "restarting"
	if got := f.Params().Relay.Lacks; got == nil || len(got) != 0 {
		t.Fatalf("relay.lacks with no brain answering = %v, want []", got)
	}
}

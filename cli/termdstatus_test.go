package main

import (
	"encoding/json"
	"errors"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// statusWatch collects a follower's notifications.
type statusWatch struct {
	t  *testing.T
	ch chan termdStatusParams
}

func (w *statusWatch) publish(p termdStatusParams) { w.ch <- p }

// until waits for a notification whose relay state is `state` and that `ok` accepts.
func (w *statusWatch) until(state string, within time.Duration, ok func(doc map[string]any) bool) termdStatusParams {
	w.t.Helper()
	deadline := time.After(within)
	var seen []string
	for {
		select {
		case p := <-w.ch:
			seen = append(seen, p.Relay.State)
			if p.Relay.State != state {
				continue
			}
			var doc map[string]any
			json.Unmarshal(p.Status, &doc)
			if ok == nil || ok(doc) {
				return p
			}
		case <-deadline:
			w.t.Fatalf("no %q notification within %s (saw %v)", state, within, seen)
		}
	}
}

func terminalsIn(doc map[string]any) int {
	ts, _ := doc["terminals"].([]any)
	return len(ts)
}

func generationIn(doc map[string]any) int {
	d, _ := doc["daemon"].(map[string]any)
	b, _ := d["brain"].(map[string]any)
	g, _ := b["generation"].(float64)
	return int(g)
}

// TestTermdStatusFollowsEveryState: the relay's status connection reads each state from its side
// of the socket — absent before a daemon, ok with the document, restarting across a brain crash
// (and back to ok on the next generation), unreachable past the grace, ok again with the vacant
// terminals re-adopted, absent after a stop (the daemon's last document said exiting), and lost
// when the holder dies with terminals in it.
func TestTermdStatusFollowsEveryState(t *testing.T) {
	privateTermd(t)
	w := &statusWatch{t: t, ch: make(chan termdStatusParams, 256)}
	var back atomic.Int32
	f := newTermdStatusFollower(termdNS, w.publish, func() { back.Add(1) })
	f.interval, f.redial, f.grace = 250*time.Millisecond, 200*time.Millisecond, time.Second
	go f.Run()
	defer f.Stop()

	if p := w.until("absent", 5*time.Second, nil); string(p.Status) != "null" || p.Relay.NS != termdNS {
		t.Fatalf("before any daemon: %+v", p)
	}
	c, err := ensureTermd(termdNS)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Request("create", map[string]any{"id": "t", "argv": []string{"sleep", "60"}, "cols": 80, "rows": 24}, nil); err != nil {
		t.Fatal(err)
	}
	f.Kick()
	w.until("ok", 5*time.Second, func(d map[string]any) bool { return terminalsIn(d) == 1 && generationIn(d) == 1 })

	// A brain crash: restarting at once (the last document kept: its terminals are still there),
	// then ok on generation 2.
	syscall.Kill(c.Welcome.PID, syscall.SIGKILL)
	c.Close()
	if p := w.until("restarting", 5*time.Second, nil); string(p.Status) == "null" {
		t.Fatal("restarting dropped the document; its terminals are still there")
	}
	w.until("ok", 10*time.Second, func(d map[string]any) bool { return generationIn(d) == 2 && terminalsIn(d) == 1 })
	if back.Load() != 0 {
		t.Fatal("a restart within the grace re-adopted terminals: the adapters ride those")
	}

	// A holder that takes connections but has no brain past the grace: unreachable; when the
	// brain answers again, ok and the vacant terminals are re-adopted.
	c, err = dialTermd(termdNS)
	if err != nil {
		t.Fatal(err)
	}
	holder, brain := c.Welcome.Holder.PID, c.Welcome.PID
	c.Close()
	syscall.Kill(holder, syscall.SIGSTOP)
	syscall.Kill(brain, syscall.SIGKILL)
	w.until("restarting", 5*time.Second, nil)
	w.until("unreachable", 5*time.Second, nil)
	syscall.Kill(holder, syscall.SIGCONT)
	w.until("ok", 15*time.Second, func(d map[string]any) bool { return generationIn(d) == 3 })
	deadline := time.Now().Add(5 * time.Second)
	for back.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if back.Load() != 1 {
		t.Fatalf("brainBack ran %d times after unreachable → ok, want 1", back.Load())
	}

	// A stop: the daemon's last document says exiting, and the namespace reads absent.
	c, err = dialTermd(termdNS)
	if err != nil {
		t.Fatal(err)
	}
	c.Request("stop", nil, nil)
	c.Close()
	w.until("ok", 5*time.Second, func(d map[string]any) bool {
		dm, _ := d["daemon"].(map[string]any)
		return dm["exiting"] == true && terminalsIn(d) == 0
	})
	if p := w.until("absent", 5*time.Second, nil); string(p.Status) != "null" {
		t.Fatalf("absent carries a document: %s", p.Status)
	}

	// A holder killed with terminals in it: lost.
	for until := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if _, err := dialTermd(termdNS); errors.Is(err, errTermdNotRunning) {
			break
		} else if time.Now().After(until) {
			t.Fatalf("the stopped namespace still answers: %v", err)
		}
	}
	c, err = ensureTermd(termdNS)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Request("create", map[string]any{"id": "u", "argv": []string{"sleep", "60"}, "cols": 80, "rows": 24}, nil); err != nil {
		t.Fatal(err)
	}
	f.Kick()
	w.until("ok", 10*time.Second, func(d map[string]any) bool { return terminalsIn(d) == 1 && generationIn(d) == 1 })
	syscall.Kill(c.Welcome.Holder.PID, syscall.SIGKILL)
	c.Close()
	if p := w.until("lost", 10*time.Second, nil); string(p.Status) != "null" {
		t.Fatalf("lost carries a document: %s", p.Status)
	}
}

// TestTermdStatusPlaneKeepsTheLatest: the display's status plane holds one notification; a newer
// one replaces one not yet written, and pushing never blocks.
func TestTermdStatusPlaneKeepsTheLatest(t *testing.T) {
	r := NewRelay()
	r.displayStatus = make(chan []byte, 1)
	for _, s := range []string{"restarting", "unreachable", "ok"} {
		r.pushTermdStatus(termdStatusParams{Relay: termdRelayState{State: s}, Status: json.RawMessage("null")})
	}
	var got struct {
		Method string            `json:"method"`
		Params termdStatusParams `json:"params"`
	}
	json.Unmarshal(<-r.displayStatus, &got)
	if got.Method != "termd/status" || got.Params.Relay.State != "ok" {
		t.Fatalf("the plane held %+v, want the latest (ok)", got)
	}
	select {
	case m := <-r.displayStatus:
		t.Fatalf("a second notification waited: %s", m)
	default:
	}
}

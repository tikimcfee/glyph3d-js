package main

// termdstatus.go — the relay's status connection to its termd namespace (DESIGN.md "Status:
// through the relay"). One connection follows termd's status document (`status_follow`) and the
// relay forwards each one to the display as a `termd/status` notification on its own plane
// (latest wins: a document is a state, not a log), with the relay's own view of the socket:
//
//	ok           a brain answers
//	absent       nothing listens, and the last document listed no terminals or said exiting (or
//	             there never was one): an empty namespace that left, the normal idle state
//	restarting   a holder is there but no brain answers yet (a crash restart, an upgrade), for
//	             up to --termd-status-grace
//	unreachable  the same, past the grace
//	failed       the holder answered brain_failed: the shells are alive, frozen
//	lost         the last document listed terminals, had no exiting, and now nothing listens: the
//	             holder died, and its shells with it
//
// The display never asks termd anything per terminal: the relay keeps the last notification and
// pushes it to a display as it connects, answers its `termd/status` request with it, and answers
// the CLI's relay-resident `termd.status`. A status connection never starts termd, and termd
// doesn't count it as a reason to stay up (PROTOCOL.md "Transport"). When its brain comes back
// after being unreachable or failed — past the window every adapter rides — the relay re-adopts the
// terminals whose adapters gave up, so their grids come back with no display action.

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// The status connection's settings (`serve --termd-status-*`); DESIGN.md "Defaults" gives the reasons.
var (
	// termdStatusInterval is the interval asked of termd: at most one document this often.
	termdStatusInterval = time.Second
	// termdStatusRedial is how often the relay looks again while nothing listens or the brain is failed.
	termdStatusRedial = 5 * time.Second
	// termdStatusGrace is how long `restarting` lasts before it reads `unreachable`.
	termdStatusGrace = 5 * time.Second
)

// termdRelayState is the `relay` half of a termd/status notification.
type termdRelayState struct {
	State   string `json:"state"`
	Since   int64  `json:"since"`
	NS      string `json:"ns"`
	Bundled string `json:"bundled"`
	// Lacks: the input ops (`key`, `paste`) the running brain doesn't offer, so the display's
	// typing can't reach it (a brain from an earlier build); empty when it has them, or no brain.
	Lacks []string `json:"lacks"`
}

// termdStatusParams is a termd/status notification's params: the relay's view and the last
// document (null when there is none to show).
type termdStatusParams struct {
	Relay  termdRelayState `json:"relay"`
	Status json.RawMessage `json:"status"`
}

// termdStatusFollower is the relay's status connection to one namespace.
type termdStatusFollower struct {
	ns       string
	bundled  string
	interval time.Duration
	redial   time.Duration
	grace    time.Duration
	// publish gets every notification (the relay's status plane); brainBack runs when a brain
	// answers again after `unreachable` or `failed` (the relay's re-adoption).
	publish   func(termdStatusParams)
	brainBack func()

	mu       sync.Mutex
	state    string
	since    time.Time
	doc      json.RawMessage // the last document, while the terminals it lists may still be there
	terms    bool            // the last document listed terminals
	lacks    []string        // the input ops the brain answering now lacks
	exiting  bool            // the last document said exiting
	instance string
	epoch    int // bumps on every state change: a stale grace timer does nothing
	kick     chan struct{}
	done     chan struct{} // closed by Stop
	stopOnce sync.Once
}

func newTermdStatusFollower(ns string, publish func(termdStatusParams), brainBack func()) *termdStatusFollower {
	return &termdStatusFollower{
		ns: ns, bundled: bundledTermdVersion(),
		interval: termdStatusInterval, redial: termdStatusRedial, grace: termdStatusGrace,
		publish: publish, brainBack: brainBack,
		state: "absent", since: time.Now(), kick: make(chan struct{}, 1), done: make(chan struct{}),
	}
}

// bundledTermdVersion is the g3d-termd this relay would start (`g3d-termd --version`), as
// `g3d-termd/<version>` to compare with a running daemon's; empty when there is none.
func bundledTermdVersion() string {
	bin, err := findTermd()
	if err != nil {
		return ""
	}
	out, err := exec.Command(bin, "--version").Output()
	if err != nil {
		return ""
	}
	return strings.Replace(strings.TrimSpace(string(out)), " ", "/", 1)
}

// Params is the current notification.
func (f *termdStatusFollower) Params() termdStatusParams {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.paramsLocked()
}

func (f *termdStatusFollower) paramsLocked() termdStatusParams {
	doc := f.doc
	if doc == nil {
		doc = json.RawMessage("null")
	}
	lacks := f.lacks
	if f.state != "ok" || lacks == nil {
		lacks = []string{}
	}
	return termdStatusParams{
		Relay:  termdRelayState{State: f.state, Since: f.since.UnixMilli(), NS: f.ns, Bundled: f.bundled, Lacks: lacks},
		Status: doc,
	}
}

// Kick makes a waiting follower dial now (the relay just started the namespace's daemon).
func (f *termdStatusFollower) Kick() {
	select {
	case f.kick <- struct{}{}:
	default:
	}
}

// set moves to a state (pushed at once when it changes; a document always is) and returns the
// epoch it starts. keepDoc false clears the document.
func (f *termdStatusFollower) set(state string, keepDoc bool) int {
	f.mu.Lock()
	changed := f.state != state
	if changed {
		f.state = state
		f.since = time.Now()
		f.epoch++
		log.Printf("[termd-status] namespace %q: %s", f.ns, state)
	}
	if !keepDoc {
		f.doc = nil
	}
	epoch := f.epoch
	p := f.paramsLocked()
	f.mu.Unlock()
	if changed || !keepDoc {
		f.publish(p)
	}
	return epoch
}

// lostOrAbsent is what nothing listening means, given the last document.
func (f *termdStatusFollower) lostOrAbsent() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.terms && !f.exiting && f.state != "absent" && f.state != "lost" {
		return "lost"
	}
	if f.state == "lost" {
		return "lost" // stays lost until a brain answers again
	}
	return "absent"
}

// restarting enters `restarting` (unless it is already restarting, unreachable or failed) and
// arms the flip to `unreachable` after the grace.
func (f *termdStatusFollower) restarting() {
	f.mu.Lock()
	st, leaving := f.state, f.exiting
	f.mu.Unlock()
	// A namespace whose last word was exiting is going, not restarting: a dial that lands in its
	// backlog before the socket goes keeps it absent.
	if st == "restarting" || st == "unreachable" || st == "failed" || (st == "absent" && leaving) {
		return
	}
	epoch := f.set("restarting", true)
	time.AfterFunc(f.grace, func() {
		f.mu.Lock()
		still := f.state == "restarting" && f.epoch == epoch
		f.mu.Unlock()
		if still {
			f.set("unreachable", true)
		}
	})
}

// wait sleeps d, or less when kicked or stopped.
func (f *termdStatusFollower) wait(d time.Duration) {
	select {
	case <-time.After(d):
	case <-f.kick:
	case <-f.done:
	}
}

// Stop ends Run (and its connection).
func (f *termdStatusFollower) Stop() { f.stopOnce.Do(func() { close(f.done) }) }

func (f *termdStatusFollower) stopped() bool {
	select {
	case <-f.done:
		return true
	default:
		return false
	}
}

// Run follows the namespace until Stop (the relay's life).
func (f *termdStatusFollower) Run() {
	backoff := 100 * time.Millisecond
	for !f.stopped() {
		c, err := dialTermd(f.ns)
		switch {
		case err == nil:
			backoff = 100 * time.Millisecond
			f.follow(c)
		case errors.Is(err, errTermdNotRunning):
			f.set(f.lostOrAbsent(), false)
			f.wait(f.redial)
		case isTermdCode(err, "brain_failed"):
			f.set("failed", true)
			f.wait(f.redial)
		default:
			// A holder that takes the connection but no brain that answers (a WELCOME timeout).
			f.restarting()
			f.wait(backoff)
			if backoff < 2*time.Second {
				backoff *= 2
			}
		}
	}
}

// follow reads one connection's documents until it ends, then says what its end means.
func (f *termdStatusFollower) follow(c *termdClient) {
	defer c.Close()
	ended := make(chan struct{})
	defer close(ended)
	go func() {
		select {
		case <-f.done:
			c.Close()
		case <-ended:
		}
	}()
	f.mu.Lock()
	was, sameInstance := f.state, f.instance == c.Welcome.Instance
	f.instance = c.Welcome.Instance
	lacks := c.lacks(termdInputOps)
	f.lacks = lacks
	f.mu.Unlock()
	if len(lacks) > 0 {
		log.Printf("[termd-status] namespace %q: %s has no %s (protocol 1.2): typing from the display can't reach it until it is upgraded (g3d upgrade)", f.ns, c.Welcome.Daemon, strings.Join(lacks, ", "))
	}
	ms := f.interval.Milliseconds()
	if err := c.Request("status_follow", map[string]any{"interval_ms": ms}, nil); err != nil {
		log.Printf("[termd-status] status_follow: %v", err)
		f.restarting()
		return
	}
	if (was == "unreachable" || was == "failed") && sameInstance && f.brainBack != nil {
		go f.brainBack()
	}
	for fr := range c.Frames {
		if fr.Type != termdEvent || fr.Stream != 0 {
			continue
		}
		var doc map[string]json.RawMessage
		if json.Unmarshal(fr.Payload, &doc) != nil || string(doc["ev"]) != `"status"` {
			continue
		}
		delete(doc, "ev")
		var probe struct {
			Daemon struct {
				Exiting bool `json:"exiting"`
			} `json:"daemon"`
			Terminals []json.RawMessage `json:"terminals"`
		}
		raw, _ := json.Marshal(doc)
		json.Unmarshal(raw, &probe)
		f.mu.Lock()
		f.doc = raw
		f.terms = len(probe.Terminals) > 0
		f.exiting = probe.Daemon.Exiting
		if f.state != "ok" {
			f.state, f.since = "ok", time.Now()
			f.epoch++
			log.Printf("[termd-status] namespace %q: ok (%s, brain generation %d)", f.ns, c.Welcome.Daemon, c.Welcome.Generation)
		}
		p := f.paramsLocked()
		f.mu.Unlock()
		f.publish(p)
	}
	err := c.Err()
	f.mu.Lock()
	exiting := f.exiting
	f.mu.Unlock()
	switch {
	case f.stopped():
	case exiting:
		f.set("absent", false)
	case isTermdCode(err, "restart"):
		f.restarting() // planned: dial at once
	default:
		f.restarting()
		time.Sleep(100 * time.Millisecond)
	}
}

// termdStatusText renders a notification for the CLI's termd.status: the state, then a line per
// terminal.
func termdStatusText(p termdStatusParams) string {
	var doc struct {
		Daemon struct {
			Version string `json:"version"`
			Brain   struct {
				PID        int `json:"pid"`
				Generation int `json:"generation"`
			} `json:"brain"`
		} `json:"daemon"`
		Terminals []struct {
			ID          string            `json:"id"`
			Argv        []string          `json:"argv"`
			Cols        int               `json:"cols"`
			Rows        int               `json:"rows"`
			OutBps      int64             `json:"out_bps"`
			Flow        string            `json:"flow"`
			Subscribers []json.RawMessage `json:"subscribers"`
		} `json:"terminals"`
	}
	head := fmt.Sprintf("termd %s · ns %s", p.Relay.State, p.Relay.NS)
	if json.Unmarshal(p.Status, &doc) != nil || doc.Daemon.Version == "" {
		return head
	}
	head += fmt.Sprintf(" · %s · brain %d gen %d · %d terminal(s)", doc.Daemon.Version, doc.Daemon.Brain.PID, doc.Daemon.Brain.Generation, len(doc.Terminals))
	if p.Relay.Bundled != "" && p.Relay.Bundled != doc.Daemon.Version {
		head += fmt.Sprintf(" · the relay ships %s (g3d upgrade)", p.Relay.Bundled)
	}
	if len(p.Relay.Lacks) > 0 {
		head += fmt.Sprintf(" · typing can't reach it: no %s op (protocol 1.2; g3d upgrade)", strings.Join(p.Relay.Lacks, ", "))
	}
	lines := []string{head}
	for _, t := range doc.Terminals {
		prog := ""
		if len(t.Argv) > 0 {
			prog = t.Argv[0][strings.LastIndex(t.Argv[0], "/")+1:]
		}
		line := fmt.Sprintf("  %s  %s  %dx%d  %d subscriber(s)", t.ID, strings.TrimPrefix(prog, "-"), t.Cols, t.Rows, len(t.Subscribers))
		if t.OutBps > 0 {
			line += fmt.Sprintf("  %d B/s", t.OutBps)
		}
		if t.Flow != "live" {
			line += "  " + t.Flow
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

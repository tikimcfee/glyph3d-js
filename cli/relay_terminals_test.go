package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
	"time"
)

func TestSeedTermSeqSkipsPastLiveTermsAndNeverGoesBack(t *testing.T) {
	r := NewRelay()
	r.seedTermSeq([]string{"term-2", "gx-claude", "term-9", "term-x", "termination-40"})
	if n := r.termSeq.Load(); n != 9 {
		t.Fatalf("seeded to %d, want 9 (only term-N counts)", n)
	}
	r.termSeq.Store(14) // spawns since
	r.seedTermSeq([]string{"term-3"})
	if n := r.termSeq.Load(); n != 14 {
		t.Fatalf("a lower live id moved the counter back to %d", n)
	}
}

func TestTerminalIDPart(t *testing.T) {
	if got := gomuxTerminalID("claude code/2"); got != "gx-claude_code_2" {
		t.Fatalf("gomuxTerminalID = %q", got)
	}
	long := gomuxTerminalID(string(make([]byte, 100)))
	if !validTerminalID(long) || len(long) != 64 {
		t.Fatalf("a long name made %q (%d bytes)", long, len(long))
	}
}

var testDirs int

// privateTermd points this test at its own termd namespace in a scratch directory
// (G3D_TERMD_DIR: socket, lock and log; under $G3D_TEST_RUN_DIR when set) and stops the
// daemon — killing every terminal it holds — when the test ends. It needs a built g3d-termd:
// $G3D_TERMD_BIN, or the workspace's target/{debug,release}.
func privateTermd(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("termd is unix-only")
	}
	bin := os.Getenv("G3D_TERMD_BIN")
	if bin == "" {
		targets := []string{filepath.Join("..", "target")}
		if d := os.Getenv("CARGO_TARGET_DIR"); d != "" {
			targets = append([]string{d}, targets...)
		}
	search:
		for _, tdir := range targets {
			for _, prof := range []string{"debug", "release"} {
				p, _ := filepath.Abs(filepath.Join(tdir, prof, "g3d-termd"))
				if _, err := os.Stat(p); err == nil {
					bin = p
					break search
				}
			}
		}
	}
	if bin == "" {
		t.Fatal("no g3d-termd built: cargo build -p g3d-termd (or set G3D_TERMD_BIN)")
	}
	dir := os.Getenv("G3D_TEST_RUN_DIR")
	if dir == "" {
		dir = t.TempDir()
	} else {
		testDirs++ // short: the socket path inside must fit a sockaddr
		dir = filepath.Join(dir, fmt.Sprintf("go%d-%d", os.Getpid(), testDirs))
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.RemoveAll(dir) })
	}
	t.Setenv("G3D_TERMD_DIR", dir)
	savedNS, savedBin := termdNS, termdBin
	termdNS, termdBin = "gotest", bin
	t.Cleanup(func() {
		if c, err := dialTermd(termdNS); err == nil {
			c.Request("stop", nil, nil)
			c.Close()
		}
		termdNS, termdBin = savedNS, savedBin
	})
}

// TestLiveTerminalIDsSeedsAFreshRelay: a relay starting beside live terminals spawns past them —
// the seeding RunServer / RunRelay do at start.
func TestLiveTerminalIDsSeedsAFreshRelay(t *testing.T) {
	privateTermd(t)
	if ids, err := liveTerminalIDs(); err != nil || ids == nil || len(ids) != 0 {
		t.Fatalf("no daemon yet → %v (%v), want an empty list and no error", ids, err)
	}
	c, err := ensureTermd(termdNS)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for _, id := range []string{"term-5", "term-41", "other"} {
		if err := c.Request("create", map[string]any{"id": id, "argv": []string{"sleep", "60"}, "cols": 80, "rows": 24}, nil); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}
	ids, err := liveTerminalIDs()
	if err != nil || len(ids) != 3 {
		t.Fatalf("live ids = %v (%v), want three", ids, err)
	}
	r := NewRelay()
	r.seedTermSeqFromTermd()
	if next := fmt.Sprintf("term-%d", r.termSeq.Add(1)); next != "term-42" {
		t.Fatalf("first spawn after start mints %s, want term-42", next)
	}
}

// TestListReportsOwnersAndSizes: what terminal.recover decides by — a terminal nobody owns is
// re-adopted at its own size; one with an owner (an adapter, a `g3d attach --take`) is left.
func TestListReportsOwnersAndSizes(t *testing.T) {
	privateTermd(t)
	c, err := ensureTermd(termdNS)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for _, id := range []string{"term-1", "term-2"} {
		if err := c.Request("create", map[string]any{"id": id, "argv": []string{"sleep", "60"}, "cols": 70, "rows": 20}, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.Request("subscribe", map[string]any{"id": "term-2", "mode": "none", "role": "own"}, nil); err != nil {
		t.Fatal(err)
	}
	terms, err := termdList(termdNS)
	if err != nil || len(terms) != 2 {
		t.Fatalf("list = %v (%v)", terms, err)
	}
	owned := map[string]int{}
	for _, tt := range terms {
		owned[tt.ID] = tt.Subscribers.Own
		if tt.Cols != 70 || tt.Rows != 20 {
			t.Fatalf("%s is %dx%d", tt.ID, tt.Cols, tt.Rows)
		}
	}
	if owned["term-1"] != 0 || owned["term-2"] != 1 {
		t.Fatalf("owners = %v", owned)
	}
}

// TestHolderDeathIsLoud: when the namespace's holder dies (every shell with it), a subscriber's
// frame stream ends with the reason (the adapter logs it and closes its grid), and the namespace
// reads as not running.
func TestHolderDeathIsLoud(t *testing.T) {
	privateTermd(t)
	c, err := ensureTermd(termdNS)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Request("create", map[string]any{"id": "t", "argv": []string{"sleep", "60"}, "cols": 80, "rows": 24}, nil); err != nil {
		t.Fatal(err)
	}
	if err := c.Request("subscribe", map[string]any{"id": "t", "mode": "raw", "role": "own"}, nil); err != nil {
		t.Fatal(err)
	}
	if c.Welcome.Holder.PID == 0 || c.Welcome.Holder.PID == c.Welcome.PID {
		t.Fatalf("WELCOME names holder %d, brain %d", c.Welcome.Holder.PID, c.Welcome.PID)
	}
	if err := syscall.Kill(c.Welcome.Holder.PID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(5 * time.Second)
	for {
		select {
		case _, ok := <-c.Frames:
			if ok {
				continue
			}
			if c.Err() == nil {
				t.Fatal("frames ended without a reason")
			}
			if _, err := redialTermd(termdNS, c.Welcome.Instance, false); !errors.Is(err, errTermdNotRunning) {
				t.Fatalf("a dead holder's namespace redials as %v, want not running", err)
			}
			if ids, err := liveTerminalIDs(); err != nil || len(ids) != 0 {
				t.Fatalf("after the holder died: live = %v (%v), want empty", ids, err)
			}
			return
		case <-deadline:
			t.Fatal("the frame stream outlived the holder")
		}
	}
}

// TestBrainRestartIsRidden: a SIGKILLed brain is restarted by the holder; the adapter's redial
// finds the same namespace (instance) on a new generation, the terminal is still there, and a
// listing in between is never an empty answer (unknown is not empty).
func TestBrainRestartIsRidden(t *testing.T) {
	privateTermd(t)
	c, err := ensureTermd(termdNS)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Request("create", map[string]any{"id": "t", "argv": []string{"sleep", "60"}, "cols": 80, "rows": 24}, nil); err != nil {
		t.Fatal(err)
	}
	if err := c.Request("subscribe", map[string]any{"id": "t", "mode": "raw", "role": "own"}, nil); err != nil {
		t.Fatal(err)
	}
	instance := c.Welcome.Instance
	if err := syscall.Kill(c.Welcome.PID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	for range c.Frames {
	}
	if c.Err() == nil {
		t.Fatal("frames ended without a reason")
	}
	c.Close()
	until := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(until) {
		if terms, err := termdList(termdNS); err == nil && (len(terms) != 1 || terms[0].ID != "t") {
			t.Fatalf("a listing during the restart answered %v: unknown must not read as empty", terms)
		}
	}
	nc, err := redialTermd(termdNS, instance, false)
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	if nc.Welcome.Instance != instance || nc.Welcome.Generation != 2 {
		t.Fatalf("redialed instance %s generation %d, want %s and 2", nc.Welcome.Instance, nc.Welcome.Generation, instance)
	}
	var sub struct {
		Handle uint32 `json:"handle"`
	}
	if err := nc.Request("subscribe", map[string]any{"id": "t", "mode": "raw", "role": "own"}, &sub); err != nil || sub.Handle == 0 {
		t.Fatalf("re-subscribe by id after the restart: %v", err)
	}
}

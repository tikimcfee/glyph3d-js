package main

import (
	"fmt"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
)

func TestTerminalIDsFromSessions(t *testing.T) {
	got := terminalIDsFromSessions("glyph-term-3\nscratch\n glyph-gx-agent \nglyph-\nglyph-term-12\n")
	want := []string{"term-3", "gx-agent", "term-12"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ids = %v, want %v", got, want)
	}
	if got := terminalIDsFromSessions(""); len(got) != 0 {
		t.Fatalf("no sessions → %v, want none", got)
	}
}

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

// TestLiveTerminalIDsSeedsAFreshRelay: a relay starting beside live sessions spawns past them — the
// seeding RunServer / RunRelay do at start — on a private tmux socket, never the default one.
func TestLiveTerminalIDsSeedsAFreshRelay(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	saved := tmuxSocket
	tmuxSocket = fmt.Sprintf("glyph-relay-test-%d", os.Getpid())
	var socketPath string
	t.Cleanup(func() {
		exec.Command("tmux", "-L", tmuxSocket, "kill-server").Run()
		if socketPath != "" {
			os.Remove(socketPath) // a killed server can leave its socket file behind
		}
		tmuxSocket = saved
	})

	if ids, err := liveTerminalIDs(); err != nil || ids == nil || len(ids) != 0 {
		t.Fatalf("no server on the socket yet → %v (%v), want an empty list and no error", ids, err)
	}
	for _, s := range []string{"glyph-term-5", "glyph-term-41", "other"} {
		if out, err := exec.Command("tmux", "-L", tmuxSocket, "new-session", "-d", "-s", s, "sleep", "60").CombinedOutput(); err != nil {
			t.Fatalf("new-session %s: %v %s", s, err, out)
		}
	}
	if out, err := exec.Command("tmux", "-L", tmuxSocket, "display-message", "-p", "#{socket_path}").Output(); err == nil {
		socketPath = strings.TrimSpace(string(out))
	}
	ids, err := liveTerminalIDs()
	if err != nil || len(ids) != 2 {
		t.Fatalf("live ids = %v (%v), want term-5 and term-41", ids, err)
	}
	r := NewRelay()
	r.seedTermSeqFromSocket()
	if next := fmt.Sprintf("term-%d", r.termSeq.Add(1)); next != "term-42" {
		t.Fatalf("first spawn after start mints %s, want term-42", next)
	}
}

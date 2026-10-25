package main

import "testing"

// The shutdown path (SIGINT/SIGTERM, and the only cover off Linux) kills the children
// still running, and forgets them.
func TestChildren_ShutdownKillsThem(t *testing.T) {
	f := newAgentFixture(t)
	f.a.DisplayConnected(1)
	if err := f.a.Follow(bg, 1, "s", -1); err != nil {
		t.Fatal(err)
	}
	pid := f.pidOf(t, "s")
	if n := killChildren(); n < 1 {
		t.Fatalf("killChildren signalled %d children, want the follower", n)
	}
	waitFor(t, "the follower killed", func() bool { return !alive(pid) })
	relayChildren.Lock()
	left := len(relayChildren.procs)
	relayChildren.Unlock()
	if left != 0 {
		t.Errorf("%d children still registered", left)
	}
}

//go:build linux

package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// A fake `agent` whose long-lived runs (export --follow, transcript --follow) write their
// pid and idle; `sessions` prints an empty list.
const childrenFakeAgent = `#!/bin/sh
D="$(dirname "$0")"
case "$1" in
export) echo '{"type":"snapshot","stores":[],"agents":[]}'; echo $$ > "$D/export.pid"; exec sleep 600 ;;
transcript) echo $$ > "$D/transcript.pid"; exec sleep 600 ;;
sessions) echo '[]' ;;
esac
`

// gone: no such process, or a zombie (dead, waiting for whoever adopted it to reap it).
func gone(pid int) bool {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return true
	}
	s := string(b)
	i := strings.LastIndexByte(s, ')')
	return i < 0 || i+2 >= len(s) || s[i+2] == 'Z'
}

// A relay killed with SIGKILL (no handler runs) still takes its `agent` children with it:
// the export watcher and a transcript follower, started the way the relay starts them.
func TestChildren_DieWithASIGKILLedRelay(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "agent"), []byte(childrenFakeAgent), 0o755); err != nil {
		t.Fatal(err)
	}
	relay := exec.Command(os.Args[0], "-test.run=^TestChildren_HelperRelay$")
	relay.Env = append(os.Environ(), "GLYPH_CHILDREN_HELPER="+dir)
	if err := relay.Start(); err != nil {
		t.Fatal(err)
	}
	defer relay.Process.Kill()
	pids := map[string]int{}
	waitFor(t, "the helper relay's two agent children", func() bool {
		for _, name := range []string{"export", "transcript"} {
			b, err := os.ReadFile(filepath.Join(dir, name+".pid"))
			if err != nil {
				return false
			}
			if pids[name], err = strconv.Atoi(strings.TrimSpace(string(b))); err != nil {
				return false
			}
		}
		return true
	})
	t.Cleanup(func() { // a failing run leaves nothing behind
		for _, pid := range pids {
			syscall.Kill(pid, syscall.SIGKILL)
		}
	})
	for name, pid := range pids {
		if gone(pid) {
			t.Fatalf("%s child %d not running before the kill", name, pid)
		}
	}
	relay.Process.Signal(syscall.SIGKILL)
	relay.Wait()
	for name, pid := range pids {
		waitFor(t, name+" child gone after the relay's SIGKILL", func() bool { return gone(pid) })
	}
}

// The helper process for TestChildren_DieWithASIGKILLedRelay: a relay's agent children,
// then it waits to be killed.
func TestChildren_HelperRelay(t *testing.T) {
	dir := os.Getenv("GLYPH_CHILDREN_HELPER")
	if dir == "" {
		t.Skip("the helper process of TestChildren_DieWithASIGKILLedRelay")
	}
	bin := filepath.Join(dir, "agent")
	w := NewGomuxWatcher(nil)
	w.tmuxBin, w.agent = "", bin
	w.Start(context.Background())
	a := NewAgentEvents(time.Hour, 4)
	a.bin = bin
	a.push = func(uint64, string, any, time.Duration) error { return nil }
	a.DisplayConnected(1)
	if err := a.Follow(1, "s", -1); err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Minute)
}

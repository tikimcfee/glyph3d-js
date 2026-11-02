package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeInputAgent records its argv (one line, args NUL-joined so spaces stay visible) and answers
// by command: send → "sent", approve → refuses (exit 5) unless --expect Bash, deny → "denied".
const fakeInputAgent = `#!/bin/sh
D="$(dirname "$0")"
printf '%s\0' "$@" >> "$D/calls"; echo >> "$D/calls"
echo "AGENT_NAME=${AGENT_NAME:-} AI_AGENT=${AI_AGENT:-} CLAUDECODE=${CLAUDECODE:-}" > "$D/env"
case "$1" in
send) echo "sent to $3 (typed in at its prompt)"; exit 0 ;;
approve) [ "$3" = Bash ] && { echo "approved Bash for $5"; exit 0; }; echo "pending prompt is not $3" >&2; exit 5 ;;
deny) echo "denied $3"; exit 0 ;;
esac
exit 3
`

func newInputFixture(t *testing.T) (*AgentEvents, string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "agent"), []byte(fakeInputAgent), 0o755); err != nil {
		t.Fatal(err)
	}
	a := NewAgentEvents(0, 1)
	a.bin = filepath.Join(dir, "agent")
	return a, dir
}

func lastCall(t *testing.T, dir string) []string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "calls"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	return strings.Split(strings.TrimRight(lines[len(lines)-1], "\x00"), "\x00")
}

func TestAgentInput_SayRunsSendWithTheTextAsOneArg(t *testing.T) {
	a, dir := newInputFixture(t)
	res, err := a.Input(context.Background(), "agent/say", agentInputParams{Name: "helper-1", Text: "--force; rm -rf / and spaces"})
	if err != nil || !res.OK || !strings.Contains(res.Output, "sent to helper-1") {
		t.Fatalf("say: %+v %v", res, err)
	}
	got := lastCall(t, dir)
	want := []string{"send", "--", "helper-1", "--force; rm -rf / and spaces"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("argv %q, want %q (text one argument, after --)", got, want)
	}
}

func TestAgentInput_ApproveNeedsTheToolTheDisplayShowed(t *testing.T) {
	a, dir := newInputFixture(t)
	if _, err := a.Input(context.Background(), "agent/approve", agentInputParams{Name: "helper-1"}); err == nil || !strings.Contains(err.Error(), "never approved blind") {
		t.Fatalf("approve with no expect must be refused before running anything, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "calls")); err == nil {
		t.Fatal("a refused approve still ran agent")
	}
	res, err := a.Input(context.Background(), "agent/approve", agentInputParams{Name: "helper-1", Expect: "Bash"})
	if err != nil || !res.OK {
		t.Fatalf("approve --expect Bash: %+v %v", res, err)
	}
	if got := strings.Join(lastCall(t, dir), "|"); got != "approve|--expect|Bash|--|helper-1" {
		t.Fatalf("argv %q", got)
	}
	// gomuxai refuses (the prompt is another tool): the exit code and its words surface.
	res, err = a.Input(context.Background(), "agent/approve", agentInputParams{Name: "helper-1", Expect: "Write"})
	if err != nil || res.OK || res.Code != 5 || !strings.Contains(res.Output, "pending prompt is not Write") {
		t.Fatalf("a refused approve must report gomuxai's code and stderr, got %+v %v", res, err)
	}
}

func TestAgentInput_DenyAndBadNames(t *testing.T) {
	a, dir := newInputFixture(t)
	res, err := a.Input(context.Background(), "agent/deny", agentInputParams{Name: "helper-1@other-box"})
	if err != nil || !res.OK || strings.Join(lastCall(t, dir), "|") != "deny|--|helper-1@other-box" {
		t.Fatalf("deny: %+v %v %q", res, err, lastCall(t, dir))
	}
	for _, bad := range []string{"", "-rf", "a b", "x;y", "@host"} {
		if _, err := a.Input(context.Background(), "agent/deny", agentInputParams{Name: bad}); err == nil {
			t.Fatalf("name %q accepted", bad)
		}
	}
	if _, err := a.Input(context.Background(), "agent/say", agentInputParams{Name: "helper-1", Text: "  "}); err == nil {
		t.Fatal("an empty say accepted")
	}
	if _, err := a.Input(context.Background(), "agent/kill", agentInputParams{Name: "helper-1"}); err == nil {
		t.Fatal("an unknown method accepted")
	}
}

func TestAgentInput_SentAsThePersonNeverTheRelaysAgent(t *testing.T) {
	a, dir := newInputFixture(t)
	t.Setenv("AGENT_NAME", "some-agent")
	t.Setenv("AI_AGENT", "1")
	t.Setenv("CLAUDECODE", "1")
	if _, err := a.Input(context.Background(), "agent/say", agentInputParams{Name: "helper-1", Text: "hi"}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "env"))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(b)); got != "AGENT_NAME= AI_AGENT= CLAUDECODE=" {
		t.Fatalf("the agent child inherited a sender identity: %q (gomuxai would sign the person's reply as it)", got)
	}
}

package main

import (
	"encoding/json"
	"testing"
	"time"
)

// The PreToolUse forward is the ONE live signal that an agent is stopped waiting on a
// human: a blocking call (AskUserQuestion / ExitPlanMode) has not returned, so nothing
// else in the pipeline knows about it yet. The hook stays pure transport — it ships EVERY
// pre-tool event and holds no opinion about which tools block (that's the JS tool
// registry's `blocking` flag, read behind agent.pretool).
func TestHandlePreToolUse_ForwardsEveryToolRaw(t *testing.T) {
	conn, msgs := hookTestServer(t)

	handlePreToolUse(conn, &HookEvent{
		SessionID: "abc12345-6789-0000-1111-222233334444",
		EventName: "PreToolUse",
		ToolName:  "AskUserQuestion",
		ToolInput: json.RawMessage(`{"questions":[{"question":"Ship it?"}]}`),
		CWD:       "/home/ivan/dev/glyph3d-js",
	})

	got := drainMsgs(msgs, 300*time.Millisecond)
	if len(got) != 1 {
		t.Fatalf("got %d commands %v, want 1 (agent.pretool)", len(got), got)
	}
	argv := decodeCall(t, got[0])
	want := []string{"agent.pretool", "abc12345", "claude", "AskUserQuestion",
		`{"questions":[{"question":"Ship it?"}]}`, "/home/ivan/dev/glyph3d-js"}
	if len(argv) != len(want) {
		t.Fatalf("agent.pretool argv: %v", argv)
	}
	for i := range want {
		if argv[i] != want[i] {
			t.Fatalf("agent.pretool argv[%d] = %q, want %q (full: %v)", i, argv[i], want[i], argv)
		}
	}

	// A plain tool ships identically — the page decides it's a no-op — and trailing
	// empties trim, exactly like sendTool.
	handlePreToolUse(conn, &HookEvent{
		SessionID: "abc12345-6789-0000-1111-222233334444",
		EventName: "PreToolUse",
		ToolName:  "Read",
		ToolInput: json.RawMessage(`{"file_path":"/x/y.js"}`),
	})
	got = drainMsgs(msgs, 300*time.Millisecond)
	if len(got) != 1 {
		t.Fatalf("plain tool: got %d commands %v, want 1", len(got), got)
	}
	argv = decodeCall(t, got[0])
	if len(argv) != 5 || argv[0] != "agent.pretool" || argv[3] != "Read" || argv[4] != `{"file_path":"/x/y.js"}` {
		t.Fatalf("plain-tool argv: %v (want the cwd trimmed off)", argv)
	}
}

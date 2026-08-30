package main

import (
	"flag"
	"strings"
	"testing"
)

// The defect these lock: Go's flag package stops at the first non-flag token, so
// `serve <dir> --port 9000 --relay-only` parsed NO flags — the operator's port was
// dropped and 8080 bound in its place, silently. See cli/args.go.

func TestParseServeArgsFlagsAfterPositional(t *testing.T) {
	opts, err := parseServeArgs([]string{"/tmp/proj", "--port", "8121", "--relay-only"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if opts.port != 8121 {
		t.Errorf("port = %d, want 8121 (flag after the positional was dropped)", opts.port)
	}
	if !opts.relayOnly {
		t.Error("relayOnly = false, want true (flag after the positional was dropped)")
	}
	if opts.projectPath != "/tmp/proj" {
		t.Errorf("projectPath = %q, want /tmp/proj", opts.projectPath)
	}
}

func TestParseServeArgsFlagsBeforePositional(t *testing.T) {
	opts, err := parseServeArgs([]string{"--port", "8122", "--local", "/tmp/proj"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if opts.port != 8122 || !opts.local || opts.projectPath != "/tmp/proj" {
		t.Errorf("got %+v, want port 8122 local=true path=/tmp/proj", opts)
	}
}

func TestParseServeArgsInterleaved(t *testing.T) {
	opts, err := parseServeArgs([]string{"--listen", "127.0.0.1", "/tmp/proj", "--port", "8123",
		"--reach", "/a", "--reach", "/b"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if opts.listen != "127.0.0.1" || opts.port != 8123 || opts.projectPath != "/tmp/proj" {
		t.Errorf("got %+v", opts)
	}
	if len(opts.reach) != 2 || opts.reach[0] != "/a" || opts.reach[1] != "/b" {
		t.Errorf("reach = %v, want [/a /b]", opts.reach)
	}
}

func TestParseServeArgsDefaults(t *testing.T) {
	opts, err := parseServeArgs(nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if opts.port != 8080 || opts.listen != "0.0.0.0" || opts.projectPath != "." {
		t.Errorf("got %+v, want the documented defaults", opts)
	}
}

// An argument that looks like a flag but isn't defined must be LOUD — not ignored,
// and not (as before) collected into Args() where nothing reads it.
func TestParseServeArgsUndefinedFlagIsAnError(t *testing.T) {
	for _, args := range [][]string{
		{"/tmp/proj", "--nope"},
		{"--nope", "/tmp/proj"},
		{"/tmp/proj", "--prot", "8121"}, // the typo that used to bind 8080 in silence
	} {
		if _, err := parseServeArgs(args); err == nil {
			t.Errorf("parseServeArgs(%v) = nil error, want a refusal", args)
		}
	}
}

func TestParseServeArgsRejectsSecondPositional(t *testing.T) {
	_, err := parseServeArgs([]string{"/tmp/a", "/tmp/b"})
	if err == nil {
		t.Fatal("two directories accepted; want an error naming both")
	}
	if !strings.Contains(err.Error(), "/tmp/b") {
		t.Errorf("error %q does not name the ignored argument", err)
	}
}

func TestParseServeArgsRejectsOutOfRangePort(t *testing.T) {
	if _, err := parseServeArgs([]string{"--port", "70000"}); err == nil {
		t.Error("port 70000 accepted; want a refusal at the boundary")
	}
	if _, err := parseServeArgs([]string{"--port", "notanumber"}); err == nil {
		t.Error("non-numeric port accepted; want a refusal")
	}
}

func TestParseArgsDoubleDashIsVerbatim(t *testing.T) {
	fs := newFlagSet("t")
	n := fs.Int("n", 0, "")
	pos, err := parseArgs(fs, []string{"a", "-n", "3", "--", "-n", "9", "b"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if *n != 3 {
		t.Errorf("n = %d, want 3 (the value past -- must not be parsed)", *n)
	}
	want := []string{"a", "-n", "9", "b"}
	if len(pos) != len(want) {
		t.Fatalf("positionals = %v, want %v", pos, want)
	}
	for i := range want {
		if pos[i] != want[i] {
			t.Fatalf("positionals = %v, want %v", pos, want)
		}
	}
}

// The one-shot path cannot permute (command arguments are free-form text for the
// display's bus), so the ordering rule is enforced instead of documented.
func TestGlobalFlagInCommand(t *testing.T) {
	fs := flag.NewFlagSet("g", flag.ContinueOnError)
	fs.String("host", "", "")
	fs.Int("port", 0, "")
	fs.Bool("json", false, "")

	if got := globalFlagInCommand(fs, []string{"grid.list", "--json"}); got != "--json" {
		t.Errorf("got %q, want --json", got)
	}
	if got := globalFlagInCommand(fs, []string{"file.open", "x.js", "-port=8121"}); got != "-port=8121" {
		t.Errorf("got %q, want -port=8121", got)
	}
	// Verb arguments that merely start with "-" are none of its business.
	if got := globalFlagInCommand(fs, []string{"camera.move", "-5", "--", "-x"}); got != "" {
		t.Errorf("got %q, want \"\" (a verb argument is not a global flag)", got)
	}
	if got := globalFlagInCommand(fs, []string{"grid.list"}); got != "" {
		t.Errorf("got %q, want \"\"", got)
	}
}

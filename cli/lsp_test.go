package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// TestLSPDefinition drives the supervisor end-to-end against a real
// typescript-language-server: a within-file `greet` call must resolve to its
// declaration on line 0. Browser-free — this is the Phase 1 gate. Skips cleanly
// where the server binary isn't installed (CI without the toolchain).
func TestLSPDefinition(t *testing.T) {
	if _, err := exec.LookPath("typescript-language-server"); err != nil {
		t.Skip("typescript-language-server not installed; skipping LSP integration test")
	}

	dir := t.TempDir()
	src := "function greet(name: string): string {\n" +
		"  return \"hi \" + name;\n" +
		"}\n" +
		"const msg = greet(\"world\");\n" +
		"export { msg };\n"
	if err := os.WriteFile(filepath.Join(dir, "fixture.ts"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}

	fsh, err := NewFSHandler(dir, nil)
	if err != nil {
		t.Fatalf("NewFSHandler: %v", err)
	}
	sup := NewLSPSupervisor(fsh)
	defer sup.shutdownAll()

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()

	// `greet` call on line 3 (0-based), char 13 → its decl on line 0.
	locs, lerr := sup.definition(ctx, lspQuery{URI: "fixture.ts", Line: 3, Character: 13})
	if lerr != nil {
		t.Fatalf("definition error: code=%d msg=%s", lerr.code, lerr.msg)
	}
	if len(locs) == 0 {
		t.Fatal("definition returned no locations")
	}
	if got := locs[0].Range.Start.Line; got != 0 {
		t.Fatalf("definition resolved to line %d, want 0 (the `function greet` decl)", got)
	}
	t.Logf("✓ definition → %s @ line %d char %d", locs[0].URI, locs[0].Range.Start.Line, locs[0].Range.Start.Character)

	// Readiness/empty path: a position on whitespace resolves to nothing, and
	// must not error (empty ≠ not-found, just no symbol there).
	if _, lerr := sup.definition(ctx, lspQuery{URI: "fixture.ts", Line: 2, Character: 0}); lerr != nil {
		t.Fatalf("whitespace query errored unexpectedly: %s", lerr.msg)
	}
}

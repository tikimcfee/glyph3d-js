package main

import (
	"testing"

	"glyph3d-cli/termdwire"
)

// The socket a namespace lives at is found from the uid, never from the starter's environment:
// a relay started from `env -i` and a desktop shell's g3d find the same one.
func TestTermdSocketDirDoesNotDependOnTheEnvironment(t *testing.T) {
	t.Setenv("G3D_TERMD_DIR", "")
	t.Setenv("XDG_RUNTIME_DIR", "/nonexistent/runtime")
	t.Setenv("TMPDIR", "/nonexistent/tmp")
	desktop := termdSocketDir()
	t.Setenv("XDG_RUNTIME_DIR", "")
	t.Setenv("TMPDIR", "")
	stripped := termdSocketDir()
	if desktop != stripped {
		t.Fatalf("the socket directory follows the environment: %q vs %q", desktop, stripped)
	}
	if got := termdSocketDirFor("/run/user/1000", 1000); got != "/run/user/1000/g3d" {
		t.Fatalf("termdSocketDirFor(runtime) = %q", got)
	}
	if got := termdSocketDirFor("", 501); got != "/tmp/g3d-501" {
		t.Fatalf("termdSocketDirFor(none) = %q", got)
	}

	t.Setenv("G3D_TERMD_DIR", "/tmp/g3d-paths")
	if got, want := termdSocketPath("agents"), termdwire.SocketPath("agents"); got != want {
		t.Fatalf("termdSocketPath = %q, want %q", got, want)
	}
	if got, want := termdLogPath("agents"), termdwire.LogPath("agents"); got != want {
		t.Fatalf("termdLogPath = %q, want %q", got, want)
	}
}

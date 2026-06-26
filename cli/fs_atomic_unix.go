//go:build !windows

package main

import (
	"os"
	"path/filepath"

	"github.com/google/renameio/v2"
)

// atomicReplace durably replaces the contents of path with data.
//
// Unix: renameio writes a randomly-named temp in the target's directory, fsyncs
// it (the guarantee against a zero-length file after a crash), then renames over
// the target. WriteFile preserves the existing file's mode (exec bit, 0600
// secrets); 0644 is only the fallback for a brand-new file. The random temp name
// also retires the old fixed-".glyph3d.tmp" concurrent-write race. We fsync the
// parent directory afterward so the rename itself survives a crash.
func atomicReplace(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := renameio.WriteFile(path, data, 0o644, renameio.WithTempDir(dir)); err != nil {
		return err
	}
	syncDir(dir)
	return nil
}

// syncDir best-effort fsyncs a directory so a rename within it is durable across
// a crash. Errors are intentionally swallowed: the file data is already synced,
// this only hardens rename durability.
func syncDir(dir string) {
	d, err := os.Open(dir)
	if err != nil {
		return
	}
	defer d.Close()
	_ = d.Sync()
}

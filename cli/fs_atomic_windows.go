//go:build windows

package main

import (
	"os"
	"path/filepath"
)

// atomicReplace durably replaces the contents of path with data.
//
// Windows has no equivalent to renameio's guaranteed atomic replace (it cannot
// atomically swap an open file the way POSIX rename does; see golang/go#22397
// and renameio's own docs), so we hand-roll the closest safe approximation:
// write a uniquely-named temp in the target's directory, fsync it, then
// os.Rename over the target — Go's os.Rename uses MoveFileEx with
// MOVEFILE_REPLACE_EXISTING, which replaces in place on the same NTFS volume.
// The fsync rules out a zero-length file after a crash; if another process
// holds the target open the rename fails loudly rather than corrupting. Windows
// permission bits carry no exec semantics, so mode is not preserved here.
func atomicReplace(path string, data []byte) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".glyph3d-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp) // no-op once the rename below succeeds (tmp is gone)

	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

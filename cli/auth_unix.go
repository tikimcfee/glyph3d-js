//go:build unix

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// relayRuntimeDir returns the per-uid runtime directory for relay token files:
// /run/user/<uid>/g3d when logind's runtime dir is owned by this uid and private,
// else /tmp/g3d-<uid>. Never consults $TMPDIR or $XDG_RUNTIME_DIR so stripped
// processes and desktop shells agree on the exact same path.
func relayRuntimeDir() string {
	if r := userRuntimeDir(); r != "" {
		return filepath.Join(r, "g3d")
	}
	return fmt.Sprintf("/tmp/g3d-%d", os.Getuid())
}

func checkSecureRuntimeDir(dir string) error {
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
		return fmt.Errorf("relay runtime dir %s is not a real directory (mode %v)", dir, fi.Mode())
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("relay runtime dir %s: cannot inspect owner", dir)
	}
	if int(st.Uid) != os.Getuid() {
		return fmt.Errorf("relay runtime dir %s is owned by uid %d, want %d", dir, st.Uid, os.Getuid())
	}
	if perm := fi.Mode().Perm(); perm&0o077 != 0 {
		return fmt.Errorf("relay runtime dir %s has unsafe mode %04o (group/other access must be 0)", dir, perm)
	}
	return nil
}

func checkSecureTokenFile(path string) error {
	fi, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() {
		return fmt.Errorf("relay token file %s is not a regular file (mode %v)", path, fi.Mode())
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("relay token file %s: cannot inspect owner", path)
	}
	if int(st.Uid) != os.Getuid() {
		return fmt.Errorf("relay token file %s is owned by uid %d, want %d", path, st.Uid, os.Getuid())
	}
	if perm := fi.Mode().Perm(); perm&0o077 != 0 {
		return fmt.Errorf("relay token file %s has unsafe mode %04o (want 0600)", path, perm)
	}
	return nil
}

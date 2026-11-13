//go:build unix

package main

import (
	"fmt"
	"os"
	"syscall"
)

// userRuntimeDir is logind's (pam_systemd's) /run/user/<uid> when it exists and is this user's
// alone (owned, nothing for group or others); "" otherwise (always on macOS).
func userRuntimeDir() string {
	uid := os.Getuid()
	dir := fmt.Sprintf("/run/user/%d", uid)
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() || fi.Mode().Perm()&0o077 != 0 {
		return ""
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); !ok || int(st.Uid) != uid {
		return ""
	}
	return dir
}

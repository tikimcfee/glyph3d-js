//go:build linux

package main

import (
	"os/exec"
	"syscall"
)

// setDeathSignal makes the language-server child receive SIGKILL if the relay
// process dies, so dev-loop relay restarts (kill + respawn) don't leave orphaned
// tsserver processes piling up. Linux-only (Pdeathsig); a no-op elsewhere.
func setDeathSignal(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Pdeathsig = syscall.SIGKILL
}

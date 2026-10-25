//go:build linux

package main

import (
	"os/exec"
	"syscall"
)

// dieWithRelay asks the kernel to SIGTERM the child when the relay dies (children.go).
func dieWithRelay(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Pdeathsig = syscall.SIGTERM
}

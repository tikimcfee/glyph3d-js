//go:build !linux

package main

import "os/exec"

// setDeathSignal is a no-op on non-Linux platforms (Pdeathsig is Linux-only).
// Language servers are reaped via lspServer.stop() / process exit instead.
func setDeathSignal(cmd *exec.Cmd) {}

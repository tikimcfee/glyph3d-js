//go:build !linux

package main

import "os/exec"

// dieWithRelay: no parent-death signal off Linux; the shutdown handler is the only cover
// (children.go).
func dieWithRelay(cmd *exec.Cmd) {}

//go:build windows

package main

import "log"

// runTerminal is unix-only — it needs a PTY (creack/pty) and tmux. Stubbed on Windows
// so the CGO_ENABLED=0 windows cross-compile stays green; terminals are a non-Windows
// feature. Keeping the stub here (not an import guard) keeps creack/pty out of the
// windows build entirely.
func runTerminal(cfg terminalConfig) {
	log.Fatalf("attach: terminals require a unix PTY (not supported on this platform)")
}

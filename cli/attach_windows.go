//go:build windows

package main

import "log"

// runTerminal is unix-only: terminals live in g3d-termd, which owns PTYs and runs on unix.
// Windows relays have no terminals.
func runTerminal(cfg terminalConfig) {
	log.Fatalf("attach: terminals need g3d-termd, which runs on unix only (not on this platform)")
}

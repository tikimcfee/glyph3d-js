package main

// The relay's `agent` children die with it.
//
// The relay runs gomuxai's `agent` as long-lived readers (export --follow, transcript
// --follow) and short ones (sessions, transcript reads). None of them may outlive the
// relay: an orphaned `agent export --follow` keeps running for days with nobody reading.
// Every one starts through startChild:
//   - Linux: the kernel sends it SIGTERM when the relay dies, however it dies, SIGKILL
//     included (Pdeathsig, children_linux.go). Pdeathsig follows the OS thread that
//     forked the child; Go only retires a thread whose goroutine exits while locked to
//     it, which nothing here does.
//   - Everywhere: the relay's SIGINT/SIGTERM handler (watchShutdown) kills every child
//     still running before it exits. On darwin and windows that is the only cover: a
//     relay killed with SIGKILL (or crashing hard) still leaves its children behind.
//     A follower notices on its own (`agent transcript --follow` exits within ~250 ms of
//     its reader going away); `agent export --follow` does not.

import (
	"log"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"syscall"
)

var relayChildren = struct {
	sync.Mutex
	procs map[*os.Process]bool
}{procs: map[*os.Process]bool{}}

// startChild starts cmd as a child that dies with the relay. Call childExited after
// its Wait returns.
func startChild(cmd *exec.Cmd) error {
	dieWithRelay(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	relayChildren.Lock()
	relayChildren.procs[cmd.Process] = true
	relayChildren.Unlock()
	return nil
}

// childExited forgets a child once its Wait has returned.
func childExited(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	relayChildren.Lock()
	delete(relayChildren.procs, cmd.Process)
	relayChildren.Unlock()
}

// killChildren kills every child still running; it returns how many it signalled.
func killChildren() int {
	relayChildren.Lock()
	defer relayChildren.Unlock()
	n := 0
	for p := range relayChildren.procs {
		if p.Kill() == nil {
			n++
		}
		delete(relayChildren.procs, p)
	}
	return n
}

// watchShutdown makes SIGINT/SIGTERM kill the relay's children before the relay exits
// (128 + the signal, as the default disposition would report it).
func watchShutdown() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	go func() {
		sig := <-ch
		n := killChildren()
		log.Printf("[relay] %v: stopped %d agent child(ren), exiting", sig, n)
		code := 128 + 15
		if sig == os.Interrupt {
			code = 128 + 2
		}
		os.Exit(code)
	}()
}

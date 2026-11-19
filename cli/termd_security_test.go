//go:build unix

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"glyph3d-cli/termdwire"
)

func shortTempDir(t *testing.T, pattern string) string {
	t.Helper()
	// Short path under /tmp so Unix socket paths stay well within macOS's 104-byte SUN_LEN.
	dir, err := os.MkdirTemp("/tmp", pattern)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func TestTermdSecurity_DialAndEnsureTermdWiring(t *testing.T) {
	savedBin := termdBin
	t.Cleanup(func() { termdBin = savedBin })

	// 1. Unsafe 0755 socket directory fails fast in both dialTermd and ensureTermd without
	// consulting or executing termdBin.
	unsafeDir := shortTempDir(t, "g3d755-")
	if err := os.Chmod(unsafeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(unsafeDir, "spawned")
	fakeBin := filepath.Join(unsafeDir, "fake-termd")
	if err := os.WriteFile(fakeBin, []byte("#!/bin/sh\ntouch '"+marker+"'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	termdBin = fakeBin
	t.Setenv("G3D_TERMD_DIR", unsafeDir)

	if _, err := dialTermd("sec755"); !errors.Is(err, errUnsafeTermdSocket) {
		t.Fatalf("dialTermd(0755) = %v, want errUnsafeTermdSocket", err)
	}
	start := time.Now()
	if _, err := ensureTermd("sec755"); !errors.Is(err, errUnsafeTermdSocket) {
		t.Fatalf("ensureTermd(0755) = %v, want errUnsafeTermdSocket", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("ensureTermd(0755) took %s instead of failing fast", elapsed)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("ensureTermd executed termdBin despite unsafe 0755 socket directory")
	}

	stateCh := make(chan string, 4)
	follower := newTermdStatusFollower("sec755", func(p termdStatusParams) {
		select {
		case stateCh <- p.Relay.State:
		default:
		}
	}, nil)
	doneFollower := make(chan struct{})
	go func() {
		defer close(doneFollower)
		follower.Run()
	}()
	select {
	case st := <-stateCh:
		if st != "unreachable" {
			follower.Stop()
			<-doneFollower
			t.Fatalf("termdStatusFollower(0755) state = %q, want unreachable", st)
		}
	case <-time.After(time.Second):
		follower.Stop()
		<-doneFollower
		t.Fatal("termdStatusFollower(0755) did not publish unreachable")
	}
	follower.Stop()
	<-doneFollower

	// 2. When a valid 0700 same-UID daemon is already listening, ensureTermd connects directly
	// with glyph3d-cli's client identifier without requiring findTermd() to succeed.
	okDir := shortTempDir(t, "g3dok-")
	if err := os.Chmod(okDir, 0o700); err != nil {
		t.Fatal(err)
	}
	const ns = "secok"
	ln, err := net.Listen("unix", filepath.Join(okDir, "termd-"+ns+".sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	gotClient := make(chan string, 2)
	go func() {
		for range 2 {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			r := bufio.NewReader(conn)
			f, err := termdwire.ReadFrame(r)
			if err == nil && f.Type == termdwire.FrameHello {
				var hello struct {
					Client string `json:"client"`
				}
				_ = json.Unmarshal(f.Payload, &hello)
				gotClient <- hello.Client
				welcome, _ := json.Marshal(termdwire.Welcome{
					Proto:      termdwire.DefaultProto,
					Daemon:     "g3d-termd/mock",
					Engine:     "mock",
					NS:         ns,
					PID:        os.Getpid(),
					Features:   []string{"key", "paste"},
					MaxFrame:   termdwire.DefaultMaxFrame,
					Instance:   "inst-ok",
					Generation: 1,
				})
				_, _ = conn.Write(termdwire.EncodeFrame(termdwire.FrameWelcome, 0, welcome))
			}
			_ = conn.Close()
		}
	}()

	t.Setenv("G3D_TERMD_DIR", okDir)
	termdBin = filepath.Join(okDir, "does-not-exist")

	c1, err := dialTermd(ns)
	if err != nil {
		t.Fatalf("dialTermd(running) = %v", err)
	}
	_ = c1.Close()

	c2, err := ensureTermd(ns)
	if err != nil {
		t.Fatalf("ensureTermd(already running, missing termdBin) = %v, want nil", err)
	}
	_ = c2.Close()

	for range 2 {
		if cl := <-gotClient; cl != "glyph3d-cli/"+Version {
			t.Fatalf("HELLO client = %q, want %q", cl, "glyph3d-cli/"+Version)
		}
	}

	// 3. When nothing listens, ensureTermd locates termdBin and fails loud if missing.
	if _, err := ensureTermd("absent"); err == nil || !strings.Contains(err.Error(), "no such binary") {
		t.Fatalf("ensureTermd(absent, missing termdBin) = %v, want missing binary error", err)
	}
}

func TestTermdSecurity_AttachGomuxAgentEnsuresTermdFirst(t *testing.T) {
	storeDir := shortTempDir(t, "g3dgx-")
	logsDir := filepath.Join(storeDir, "logs")
	if err := os.MkdirAll(logsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(logsDir, "worker.log"), []byte("hello\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	fakeTmux := filepath.Join(storeDir, "tmux")
	if err := os.WriteFile(fakeTmux, []byte("#!/bin/sh\necho '80 24'\n"), 0o700); err != nil {
		t.Fatal(err)
	}

	w := NewGomuxWatcher(nil, "")
	w.tmuxBin = fakeTmux
	mustApply(t, w, `{"type":"snapshot","host":"h","stores":[{"dir":"`+storeDir+`"}],"agents":[{"name":"worker","host":"h","store":"`+storeDir+`","session":"agent-worker","live":true,"attached":true,"status":"idle"}]}`)

	// Point G3D_TERMD_DIR at an unsafe 0755 directory: attachGomuxAgent must fail at ensureTermd
	// before calling startAdapter, and must clear gxForked so a later retry isn't suppressed.
	unsafeDir := shortTempDir(t, "g3dgx755-")
	if err := os.Chmod(unsafeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("G3D_TERMD_DIR", unsafeDir)

	r := &Relay{fs: &FSHandler{gomux: w}}
	var got map[string]any
	r.attachGomuxAgent(func(msg any) {
		got, _ = msg.(map[string]any)
	}, "worker")

	errStr, _ := got["error"].(string)
	if !strings.Contains(errStr, "unsafe termd socket") {
		t.Fatalf("attachGomuxAgent error = %q, want unsafe termd socket error from ensureTermd", errStr)
	}
	r.gxMu.Lock()
	_, stillForked := r.gxForked[gomuxTerminalID("worker")]
	r.gxMu.Unlock()
	if stillForked {
		t.Fatal("attachGomuxAgent left gxForked populated after ensureTermd failure")
	}
}

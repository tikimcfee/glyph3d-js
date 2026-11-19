package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func newRelayTestServer(t *testing.T, r *Relay) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	_, portStr, _ := net.SplitHostPort(srv.Listener.Addr().String())
	fmt.Sscanf(portStr, "%d", &r.port)
	return srv
}

func dialTestController(t *testing.T, srv *httptest.Server, tok string) *websocket.Conn {
	t.Helper()
	wsURL := "ws://" + strings.TrimPrefix(srv.URL, "http://")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, http.Header{
		"Authorization": []string{"Bearer " + tok},
	})
	if err != nil {
		t.Fatalf("dial controller: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func TestSeedTermSeqSkipsPastLiveTermsAndNeverGoesBack(t *testing.T) {
	r := NewRelay(newTestAuth(t))
	r.seedTermSeq([]string{"term-2", "gx-claude", "term-9", "term-x", "termination-40"})
	if n := r.termSeq.Load(); n != 9 {
		t.Fatalf("seeded to %d, want 9 (only term-N counts)", n)
	}
	r.termSeq.Store(14) // spawns since
	r.seedTermSeq([]string{"term-3"})
	if n := r.termSeq.Load(); n != 14 {
		t.Fatalf("a lower live id moved the counter back to %d", n)
	}
}

func TestTerminalIDPart(t *testing.T) {
	if got := gomuxTerminalID("claude code/2"); got != "gx-claude_code_2" {
		t.Fatalf("gomuxTerminalID = %q", got)
	}
	long := gomuxTerminalID(string(make([]byte, 100)))
	if !validTerminalID(long) || len(long) != 64 {
		t.Fatalf("a long name made %q (%d bytes)", long, len(long))
	}
}

var testDirs int

// privateTermd points this test at its own termd namespace in a scratch directory
// (G3D_TERMD_DIR: socket, lock and log; under $G3D_TEST_RUN_DIR when set) and stops the
// daemon — killing every terminal it holds — when the test ends. It needs a built g3d-termd:
// $G3D_TERMD_BIN, or the workspace's target/{debug,release}.
func privateTermd(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("termd is unix-only")
	}
	bin := os.Getenv("G3D_TERMD_BIN")
	if bin == "" {
		targets := []string{filepath.Join("..", "target")}
		if d := os.Getenv("CARGO_TARGET_DIR"); d != "" {
			targets = append([]string{d}, targets...)
		}
	search:
		for _, tdir := range targets {
			for _, prof := range []string{"debug", "release"} {
				p, _ := filepath.Abs(filepath.Join(tdir, prof, "g3d-termd"))
				if _, err := os.Stat(p); err == nil {
					bin = p
					break search
				}
			}
		}
	}
	if bin == "" {
		t.Fatal("no g3d-termd built: cargo build -p g3d-termd (or set G3D_TERMD_BIN)")
	}
	dir := os.Getenv("G3D_TEST_RUN_DIR")
	if dir == "" {
		// Not t.TempDir(): on macOS that is under $TMPDIR (/var/folders/…, 49 bytes) plus the
		// test's name, past a sockaddr's 104 bytes.
		var err error
		if dir, err = os.MkdirTemp("/tmp", "g3dgo"); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.RemoveAll(dir) })
	} else {
		testDirs++ // short: the socket path inside must fit a sockaddr
		dir = filepath.Join(dir, fmt.Sprintf("go%d-%d", os.Getpid(), testDirs))
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.RemoveAll(dir) })
	}
	t.Setenv("G3D_TERMD_DIR", dir)
	// Terminals take the session's names from the test's own start values, never the desktop
	// session's, and no termd.toml but the test's own (absent).
	t.Setenv("G3D_TERMD_ENV_SOURCE", "daemon")
	t.Setenv("G3D_TERMD_CONFIG", filepath.Join(dir, "termd.toml"))
	savedNS, savedBin := termdNS, termdBin
	termdNS, termdBin = "gotest", bin
	t.Cleanup(func() {
		if c, err := dialTermd(termdNS); err == nil {
			c.Request("stop", nil, nil)
			c.Close()
		}
		termdNS, termdBin = savedNS, savedBin
	})
}

// TestLiveTerminalIDsSeedsAFreshRelay: a relay starting beside live terminals spawns past them —
// the seeding RunServer / RunRelay do at start.
func TestLiveTerminalIDsSeedsAFreshRelay(t *testing.T) {
	privateTermd(t)
	if ids, err := liveTerminalIDs(); err != nil || ids == nil || len(ids) != 0 {
		t.Fatalf("no daemon yet → %v (%v), want an empty list and no error", ids, err)
	}
	c, err := ensureTermd(termdNS)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for _, id := range []string{"term-5", "term-41", "other"} {
		if err := c.Request("create", map[string]any{"id": id, "argv": []string{"sleep", "60"}, "cols": 80, "rows": 24}, nil); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}
	ids, err := liveTerminalIDs()
	if err != nil || len(ids) != 3 {
		t.Fatalf("live ids = %v (%v), want three", ids, err)
	}
	r := NewRelay(newTestAuth(t))
	r.seedTermSeqFromTermd()
	if next := fmt.Sprintf("term-%d", r.termSeq.Add(1)); next != "term-42" {
		t.Fatalf("first spawn after start mints %s, want term-42", next)
	}
}

// TestListReportsOwnersAndSizes: what terminal.recover decides by — a terminal nobody owns is
// re-adopted at its own size; one with an owner (an adapter, a `g3d attach --take`) is left.
func TestListReportsOwnersAndSizes(t *testing.T) {
	privateTermd(t)
	c, err := ensureTermd(termdNS)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for _, id := range []string{"term-1", "term-2"} {
		if err := c.Request("create", map[string]any{"id": id, "argv": []string{"sleep", "60"}, "cols": 70, "rows": 20}, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.Request("subscribe", map[string]any{"id": "term-2", "mode": "none", "role": "own"}, nil); err != nil {
		t.Fatal(err)
	}
	terms, err := termdList(termdNS)
	if err != nil || len(terms) != 2 {
		t.Fatalf("list = %v (%v)", terms, err)
	}
	owned := map[string]int{}
	for _, tt := range terms {
		owned[tt.ID] = tt.Subscribers.Own
		if tt.Cols != 70 || tt.Rows != 20 {
			t.Fatalf("%s is %dx%d", tt.ID, tt.Cols, tt.Rows)
		}
	}
	if owned["term-1"] != 0 || owned["term-2"] != 1 {
		t.Fatalf("owners = %v", owned)
	}
}

// TestHolderDeathIsLoud: when the namespace's holder dies (every shell with it), a subscriber's
// frame stream ends with the reason (the adapter logs it and closes its grid), and the namespace
// reads as not running.
func TestHolderDeathIsLoud(t *testing.T) {
	privateTermd(t)
	c, err := ensureTermd(termdNS)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Request("create", map[string]any{"id": "t", "argv": []string{"sleep", "60"}, "cols": 80, "rows": 24}, nil); err != nil {
		t.Fatal(err)
	}
	if err := c.Request("subscribe", map[string]any{"id": "t", "mode": "raw", "role": "own"}, nil); err != nil {
		t.Fatal(err)
	}
	if c.Welcome.Holder.PID == 0 || c.Welcome.Holder.PID == c.Welcome.PID {
		t.Fatalf("WELCOME names holder %d, brain %d", c.Welcome.Holder.PID, c.Welcome.PID)
	}
	if err := syscall.Kill(c.Welcome.Holder.PID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(5 * time.Second)
	for {
		select {
		case _, ok := <-c.Frames:
			if ok {
				continue
			}
			if c.Err() == nil {
				t.Fatal("frames ended without a reason")
			}
			if _, err := redialTermd(termdNS, c.Welcome.Instance, false); !errors.Is(err, errTermdNotRunning) {
				t.Fatalf("a dead holder's namespace redials as %v, want not running", err)
			}
			if ids, err := liveTerminalIDs(); err != nil || len(ids) != 0 {
				t.Fatalf("after the holder died: live = %v (%v), want empty", ids, err)
			}
			return
		case <-deadline:
			t.Fatal("the frame stream outlived the holder")
		}
	}
}

// TestBrainRestartIsRidden: a SIGKILLed brain is restarted by the holder; the adapter's redial
// finds the same namespace (instance) on a new generation, the terminal is still there, and a
// listing in between is never an empty answer (unknown is not empty).
func TestBrainRestartIsRidden(t *testing.T) {
	privateTermd(t)
	c, err := ensureTermd(termdNS)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Request("create", map[string]any{"id": "t", "argv": []string{"sleep", "60"}, "cols": 80, "rows": 24}, nil); err != nil {
		t.Fatal(err)
	}
	if err := c.Request("subscribe", map[string]any{"id": "t", "mode": "raw", "role": "own"}, nil); err != nil {
		t.Fatal(err)
	}
	instance := c.Welcome.Instance
	if err := syscall.Kill(c.Welcome.PID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	for range c.Frames {
	}
	if c.Err() == nil {
		t.Fatal("frames ended without a reason")
	}
	c.Close()
	until := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(until) {
		if terms, err := termdList(termdNS); err == nil && (len(terms) != 1 || terms[0].ID != "t") {
			t.Fatalf("a listing during the restart answered %v: unknown must not read as empty", terms)
		}
	}
	nc, err := redialTermd(termdNS, instance, false)
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	if nc.Welcome.Instance != instance || nc.Welcome.Generation != 2 {
		t.Fatalf("redialed instance %s generation %d, want %s and 2", nc.Welcome.Instance, nc.Welcome.Generation, instance)
	}
	var sub struct {
		Handle uint32 `json:"handle"`
	}
	if err := nc.Request("subscribe", map[string]any{"id": "t", "mode": "raw", "role": "own"}, &sub); err != nil || sub.Handle == 0 {
		t.Fatalf("re-subscribe by id after the restart: %v", err)
	}
}

func TestCrossNamespaceGomuxAttachRecoverAndDetachOnKill(t *testing.T) {
	privateTermd(t)
	t.Cleanup(func() {
		if c, err := dialTermd("agents"); err == nil {
			_ = c.Request("stop", nil, nil)
			_ = c.Close()
		}
	})

	// Build a real glyph3d-cli binary so Relay forks actual `attach` subprocesses.
	cliBin := filepath.Join(t.TempDir(), "glyph3d-cli")
	if out, err := exec.Command("go", "build", "-o", cliBin, ".").CombinedOutput(); err != nil {
		t.Fatalf("go build glyph3d-cli: %v\n%s", err, out)
	}

	// Relay's own namespace ("gotest", standing in for "wall") holds term-1.
	wallConn, err := ensureTermd(termdNS)
	if err != nil {
		t.Fatal(err)
	}
	defer wallConn.Close()
	if err := wallConn.Request("create", map[string]any{"id": "term-1", "argv": []string{"sleep", "60"}, "cols": 80, "rows": 24}, nil); err != nil {
		t.Fatal(err)
	}

	// Separate "agents" namespace holds gomuxai's agent-worker at 132x42.
	agentsConn, err := ensureTermd("agents")
	if err != nil {
		t.Fatal(err)
	}
	defer agentsConn.Close()
	if err := agentsConn.Request("create", map[string]any{
		"id":   "agent-worker",
		"argv": []string{"sh", "-c", "printf 'HELLO_FROM_AGENTS_NS\\r\\n'; sleep 60"},
		"cols": 132,
		"rows": 42,
	}, nil); err != nil {
		t.Fatal(err)
	}

	w := NewGomuxWatcher(nil, "")
	mustApply(t, w, `{"type":"snapshot","host":"h","stores":[{"dir":"/s"}],"agents":[{"name":"worker","host":"h","store":"/s","session":"agent-worker","live":true,"attached":true,"status":"idle"}]}`)

	r := NewRelay(newTestAuth(t))
	r.exePath = cliBin
	r.fs = &FSHandler{gomux: w}
	srv := newRelayTestServer(t, r)

	// Connect a fake display that answers terminal.create / terminal.ping and records events.
	disp := dialTestController(t, srv, r.Token())
	if err := disp.WriteMessage(websocket.TextMessage, []byte("DISPLAY")); err != nil {
		t.Fatal(err)
	}

	createdCh := make(chan string, 4)
	closedCh := make(chan string, 4)
	outputCh := make(chan string, 16)
	recoverCh := make(chan map[string]any, 4)
	attachReplyCh := make(chan map[string]any, 4)
	dispWriteMu := make(chan struct{}, 1)
	dispSend := func(v any) {
		dispWriteMu <- struct{}{}
		defer func() { <-dispWriteMu }()
		b, _ := json.Marshal(v)
		_ = disp.WriteMessage(websocket.TextMessage, b)
	}

	go func() {
		for {
			mt, msg, err := disp.ReadMessage()
			if err != nil {
				return
			}
			if mt == websocket.BinaryMessage && len(msg) > 6 && msg[0] == frameOutput {
				idLen := int(msg[1])
				if len(msg) >= 2+idLen+4 {
					id := string(msg[2 : 2+idLen])
					payload := string(msg[2+idLen+4:])
					if id == "gx-worker" && strings.Contains(payload, "HELLO_FROM_AGENTS_NS") {
						select {
						case outputCh <- payload:
						default:
						}
					}
				}
				continue
			}
			var m map[string]any
			if json.Unmarshal(msg, &m) != nil {
				continue
			}
			if from, _ := m["from"].(string); from != "" {
				cmd, _ := m["cmd"].(string)
				switch {
				case strings.HasPrefix(cmd, "terminal.create gx-worker "):
					dispSend(map[string]any{"to": from, "response": "OK: created gx-worker"})
					createdCh <- from
				case strings.HasPrefix(cmd, "terminal.create "):
					dispSend(map[string]any{"to": from, "response": "OK: created"})
				case strings.HasPrefix(cmd, "terminal.ping "):
					dispSend(map[string]any{"to": from, "response": "OK: pong"})
				case strings.HasPrefix(cmd, "terminal.close gx-worker"):
					dispSend(map[string]any{"to": from, "response": "OK: closed"})
					closedCh <- from
				}
				continue
			}
			switch m["event"] {
			case "gomux.attaching":
				attachReplyCh <- m
			case "terminal.recovered":
				recoverCh <- m
			}
		}
	}()

	// 1. Display requests gomux.attach worker → gx-worker attaches across namespaces to agents/agent-worker.
	dispSend(map[string]any{"relay": "gomux.attach", "name": "worker"})
	var attachReply map[string]any
	select {
	case attachReply = <-attachReplyCh:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for gomux.attaching")
	}
	if attachReply["error"] != nil && attachReply["error"] != "" {
		t.Fatalf("gomux.attaching failed: %v", attachReply)
	}
	if attachReply["id"] != "gx-worker" || attachReply["cols"] != float64(132) || attachReply["rows"] != float64(42) {
		t.Fatalf("gomux.attaching = %v, want id=gx-worker 132x42", attachReply)
	}

	var adapterCtrlID string
	select {
	case adapterCtrlID = <-createdCh:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for terminal.create gx-worker from adapter")
	}
	select {
	case <-outputCh:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for HELLO_FROM_AGENTS_NS output from gx-worker")
	}

	// Verify wall namespace ("gotest") was NOT polluted with a gx-worker terminal.
	wallTerms, err := termdList(termdNS)
	if err != nil {
		t.Fatal(err)
	}
	for _, wt := range wallTerms {
		if wt.ID == "gx-worker" {
			t.Fatal("gx-worker was created in wall's termdNS instead of subscribing to agents/agent-worker")
		}
	}

	// 1b. Duplicate gomux.attach while live answers existing:true without spawning a second adapter.
	dispSend(map[string]any{"relay": "gomux.attach", "name": "worker"})
	select {
	case dup := <-attachReplyCh:
		if dup["existing"] != true || dup["id"] != "gx-worker" {
			t.Fatalf("duplicate gomux.attaching = %v, want existing:true", dup)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for duplicate gomux.attaching")
	}

	// 2. terminal.recover includes BOTH term-1 and live gx-worker in `live` so page reloads don't prune WallStore.
	dispSend(map[string]any{"relay": "terminal.recover"})
	var rec map[string]any
	select {
	case rec = <-recoverCh:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for terminal.recovered")
	}
	var liveIDs []string
	if rawLive, ok := rec["live"].([]any); ok {
		for _, v := range rawLive {
			if s, ok := v.(string); ok {
				liveIDs = append(liveIDs, s)
			}
		}
	}
	if !slices.Contains(liveIDs, "term-1") || !slices.Contains(liveIDs, "gx-worker") {
		t.Fatalf("terminal.recovered live = %v, want both term-1 and gx-worker", liveIDs)
	}

	// 3. Closing gx-worker on the display (terminal.shutdown / terminal.kill) detaches cleanly
	// WITHOUT killing agent-worker in namespace "agents"!
	dispSend(map[string]any{
		"to":    adapterCtrlID,
		"event": "terminal.shutdown",
		"data":  map[string]any{"terminalId": "gx-worker"},
	})
	select {
	case <-closedCh:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for terminal.close gx-worker on detach")
	}

	// Wait for adapter count to drop to 0; agent-worker must remain alive in "agents".
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		r.readoptMu.Lock()
		n := r.adapters["gx-worker"]
		r.readoptMu.Unlock()
		if n == 0 {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	agentTerms, err := termdList("agents")
	if err != nil {
		t.Fatal(err)
	}
	if len(agentTerms) != 1 || agentTerms[0].ID != "agent-worker" {
		t.Fatalf("after closing gx-worker, agents namespace terminals = %v; want agent-worker still alive!", agentTerms)
	}

	// 4. Re-attaching immediately after closing spawns a fresh adapter (not suppressed by gxForked).
	dispSend(map[string]any{"relay": "gomux.attach", "name": "worker"})
	select {
	case re := <-attachReplyCh:
		if re["existing"] == true || re["id"] != "gx-worker" {
			t.Fatalf("re-attach gomux.attaching = %v, want fresh spawn (existing!=true)", re)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for re-attach gomux.attaching")
	}
	select {
	case ctrl2 := <-createdCh:
		dispSend(map[string]any{
			"to":    ctrl2,
			"event": "terminal.shutdown",
			"data":  map[string]any{"terminalId": "gx-worker"},
		})
		<-closedCh
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for re-attached terminal.create gx-worker")
	}
}

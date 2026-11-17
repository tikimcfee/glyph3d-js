package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// newTestAuth is the auth an in-process test relay runs with: loopback, any port, no --origin.
func newTestAuth(t *testing.T) *relayAuth {
	t.Helper()
	auth, err := newRelayAuth("127.0.0.1", 0, nil, false)
	if err != nil {
		t.Fatalf("newRelayAuth: %v", err)
	}
	return auth
}

func TestServeDefaultListenIsLoopback(t *testing.T) {
	if defaultServeListen != "127.0.0.1" {
		t.Fatalf("defaultServeListen = %q, want 127.0.0.1", defaultServeListen)
	}
}

func TestNoTokenUpgradeIsRefused(t *testing.T) {
	r := NewRelay(newTestAuth(t))
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	wsURL := "ws://" + strings.TrimPrefix(srv.URL, "http://")

	for _, hdr := range []http.Header{
		nil,
		{"Origin": []string{"http://localhost:5180"}},
		{"Authorization": []string{"Bearer wrong-token"}},
		{"Sec-WebSocket-Protocol": []string{"glyph3d, g3d-token.wrong"}},
	} {
		conn, resp, err := websocket.DefaultDialer.Dial(wsURL, hdr)
		if err == nil {
			conn.Close()
			t.Fatalf("upgrade with headers %v was accepted", hdr)
		}
		if resp == nil || resp.StatusCode != http.StatusUnauthorized {
			code := 0
			if resp != nil {
				code = resp.StatusCode
			}
			t.Fatalf("headers %v status = %d, want %d", hdr, code, http.StatusUnauthorized)
		}
	}
}

func TestCrossOriginUpgradeIsRefused(t *testing.T) {
	r := NewRelay(newTestAuth(t))
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	wsURL := "ws://" + strings.TrimPrefix(srv.URL, "http://")

	// Even WITH the valid token, any Origin outside the allowlist is refused.
	for _, badOrigin := range []string{
		"https://evil.example",
		"http://evil.example:8080",
		"http://localhost:8000",
		"null",
	} {
		hdr := http.Header{
			"Origin":        []string{badOrigin},
			"Authorization": []string{"Bearer " + r.Token()},
		}
		conn, resp, err := websocket.DefaultDialer.Dial(wsURL, hdr)
		if err == nil {
			conn.Close()
			t.Fatalf("cross-origin WebSocket upgrade from Origin %q was accepted", badOrigin)
		}
		if resp == nil || resp.StatusCode != http.StatusForbidden {
			code := 0
			if resp != nil {
				code = resp.StatusCode
			}
			t.Fatalf("Origin %q status = %d, want %d", badOrigin, code, http.StatusForbidden)
		}
	}
}

func TestQueryStringTokenUpgradeIsRefused(t *testing.T) {
	r := NewRelay(newTestAuth(t))
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	wsURL := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/?token=" + r.Token()

	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, http.Header{
		"Authorization": []string{"Bearer " + r.Token()},
	})
	if err == nil {
		conn.Close()
		t.Fatal("upgrade carrying ?token= in URL query string was accepted")
	}
	if resp == nil || resp.StatusCode != http.StatusBadRequest {
		code := 0
		if resp != nil {
			code = resp.StatusCode
		}
		t.Fatalf("query-string token status = %d, want %d", code, http.StatusBadRequest)
	}
}

func TestDNSRebindingHostHeaderIsRefused(t *testing.T) {
	r := NewRelay(newTestAuth(t))
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	wsURL := "ws://" + strings.TrimPrefix(srv.URL, "http://")

	req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	req.Host = "evil.rebind.attacker:8080"
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Authorization", "Bearer "+r.Token())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("http request: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("rebound Host status = %d, want %d", resp.StatusCode, http.StatusForbidden)
	}
	_ = wsURL
}

func TestAllowedOriginsAndSubprotocolWorkAcrossAllRoles(t *testing.T) {
	auth, err := newRelayAuth("127.0.0.1", 0, []string{"http://127.0.0.1:15190"}, false)
	if err != nil {
		t.Fatalf("newRelayAuth: %v", err)
	}
	r := NewRelay(auth)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	wsURL := "ws://" + strings.TrimPrefix(srv.URL, "http://")

	// 1. Browser DISPLAY using Sec-WebSocket-Protocol + Vite :5180 Origin; response header must NOT echo token.
	dialer := websocket.Dialer{
		Subprotocols: []string{wsBaseSubprotocol, wsTokenSubprotocolPrefix + r.Token()},
	}
	disp, resp, err := dialer.Dial(wsURL, http.Header{"Origin": []string{"http://localhost:5180"}})
	if err != nil {
		t.Fatalf("display subprotocol dial: %v", err)
	}
	t.Cleanup(func() { disp.Close() })
	if gotProto := resp.Header.Get("Sec-WebSocket-Protocol"); gotProto != wsBaseSubprotocol {
		t.Fatalf("Sec-WebSocket-Protocol response = %q, want %q (must never echo secret)", gotProto, wsBaseSubprotocol)
	}
	if err := disp.WriteMessage(websocket.TextMessage, []byte("DISPLAY")); err != nil {
		t.Fatal(err)
	}
	if ack := readJSON(t, disp); ack["role"] != "display" {
		t.Fatalf("display ack = %v", ack)
	}

	// 2. SOURCE using custom --origin + Sec-WebSocket-Protocol.
	src, _, err := dialer.Dial(wsURL, http.Header{"Origin": []string{"http://127.0.0.1:15190"}})
	if err != nil {
		t.Fatalf("source dial with custom --origin: %v", err)
	}
	t.Cleanup(func() { src.Close() })
	if err := src.WriteMessage(websocket.TextMessage, []byte("SOURCE hand")); err != nil {
		t.Fatal(err)
	}
	if hello := readJSON(t, src); hello["role"] != "source" {
		t.Fatalf("source hello = %v", hello)
	}

	// 3. CONTROLLER using Authorization: Bearer <token> (CLI / adapter path).
	ctrl, _, err := websocket.DefaultDialer.Dial(wsURL, http.Header{
		"Authorization": []string{"Bearer " + r.Token()},
	})
	if err != nil {
		t.Fatalf("controller bearer dial: %v", err)
	}
	t.Cleanup(func() { ctrl.Close() })
	if err := ctrl.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
		t.Fatal(err)
	}
	_, helloMsg, err := ctrl.ReadMessage()
	if err != nil || !strings.HasPrefix(string(helloMsg), "OK: connected as ") {
		t.Fatalf("controller hello = %q (%v)", helloMsg, err)
	}
}

func TestTokenFileIs0600FreshRandomPerStartAndCleanedSafely(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "rt")
	t.Setenv("G3D_RELAY_TOKEN_DIR", dir)
	t.Setenv("G3D_RELAY_TOKEN", "")

	r1 := NewRelay(newTestAuth(t))
	r2 := NewRelay(newTestAuth(t))
	if len(r1.Token()) != 64 || r1.Token() == r2.Token() {
		t.Fatalf("expected distinct 64-hex random tokens per start, got %q and %q", r1.Token(), r2.Token())
	}

	p1, clean1, err := writeRelayTokenFile(18901, r1.Token())
	if err != nil {
		t.Fatalf("writeRelayTokenFile 1: %v", err)
	}
	got1, err := readRelayToken(18901)
	if err != nil || got1 != r1.Token() {
		t.Fatalf("readRelayToken 1 = %q (%v), want %q", got1, err, r1.Token())
	}

	if runtime.GOOS != "windows" {
		dfi, err := os.Lstat(dir)
		if err != nil || dfi.Mode().Perm() != 0o700 {
			t.Fatalf("runtime dir perm = %04o (%v), want 0700", dfi.Mode().Perm(), err)
		}
		ffi, err := os.Lstat(p1)
		if err != nil || ffi.Mode().Perm() != 0o600 {
			t.Fatalf("token file perm = %04o (%v), want 0600", ffi.Mode().Perm(), err)
		}
		// Group/world-readable token file must be refused loudly.
		if err := os.Chmod(p1, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := readRelayToken(18901); err == nil {
			t.Fatal("readRelayToken accepted a 0644 token file")
		}
	}

	// Successor writes a new random token to the same port; predecessor's late cleanup must NOT unlink it.
	_, clean2, err := writeRelayTokenFile(18901, r2.Token())
	if err != nil {
		t.Fatalf("writeRelayTokenFile 2: %v", err)
	}
	clean1()
	got2, err := readRelayToken(18901)
	if err != nil || got2 != r2.Token() {
		t.Fatalf("predecessor cleanup clobbered successor token: got %q (%v)", got2, err)
	}
	clean2()
	if _, err := os.Stat(p1); !os.IsNotExist(err) {
		t.Fatalf("token file remained after owner cleanup: %v", err)
	}
}

func TestFSRPCIsBehindUpgradeAuth(t *testing.T) {
	dir := t.TempDir()
	fsh, err := NewFSHandler(dir, nil)
	if err != nil {
		t.Fatalf("NewFSHandler: %v", err)
	}
	r := NewRelay(newTestAuth(t))
	r.fs = fsh
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	wsURL := "ws://" + strings.TrimPrefix(srv.URL, "http://")

	// 1. Unauthenticated / cross-origin caller cannot upgrade to reach fs-RPC.
	for _, hdr := range []http.Header{
		nil,
		{"Origin": []string{"https://evil.example"}, "Authorization": []string{"Bearer " + r.Token()}},
	} {
		if conn, _, err := websocket.DefaultDialer.Dial(wsURL, hdr); err == nil {
			conn.Close()
			t.Fatalf("caller with headers %v upgraded to relay holding fs-RPC", hdr)
		}
	}

	// 2. Authenticated same-origin / allowed-origin display reaches fs/roots cleanly.
	dialer := websocket.Dialer{
		Subprotocols: []string{wsBaseSubprotocol, wsTokenSubprotocolPrefix + r.Token()},
	}
	disp, _, err := dialer.Dial(wsURL, http.Header{"Origin": []string{"http://localhost:5173"}})
	if err != nil {
		t.Fatalf("authenticated display dial: %v", err)
	}
	defer disp.Close()
	if err := disp.WriteMessage(websocket.TextMessage, []byte("DISPLAY")); err != nil {
		t.Fatal(err)
	}
	_ = readJSON(t, disp) // display ack
	if err := disp.WriteMessage(websocket.TextMessage, []byte(`{"jsonrpc":"2.0","id":1,"method":"fs/roots","params":{}}`)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		msg := readJSON(t, disp)
		if msg["id"] != nil {
			res, _ := msg["result"].(map[string]any)
			if res == nil || res["root"] == nil {
				t.Fatalf("unexpected fs/roots reply: %v", msg)
			}
			return
		}
	}
	t.Fatal("timed out waiting for fs/roots reply on authenticated display")
}

func TestClientTokenResolutionAndURLFormatting(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "rt")
	t.Setenv("G3D_RELAY_TOKEN_DIR", dir)
	t.Setenv("G3D_RELAY_TOKEN", "")

	tok := strings.Repeat("b", 64)
	_, clean, err := writeRelayTokenFile(18955, tok)
	if err != nil {
		t.Fatal(err)
	}
	defer clean()

	// Loopback dial reads the 0600 runtime token file automatically.
	dialURL, hdr, err := resolveDialURLAndHeaders("ws://localhost:18955")
	if err != nil {
		t.Fatalf("resolveDialURLAndHeaders: %v", err)
	}
	if dialURL != "ws://localhost:18955" || hdr.Get("Authorization") != "Bearer "+tok {
		t.Fatalf("dialURL=%q auth=%q", dialURL, hdr.Get("Authorization"))
	}

	// #token= fragment is extracted into Authorization and stripped from dialURL.
	dialURL2, hdr2, err := resolveDialURLAndHeaders("ws://127.0.0.1:18955/#token=fragtok")
	if err != nil || dialURL2 != "ws://127.0.0.1:18955/" || hdr2.Get("Authorization") != "Bearer fragtok" {
		t.Fatalf("fragment dial: url=%q auth=%q err=%v", dialURL2, hdr2.Get("Authorization"), err)
	}

	// ?token= query string is refused loudly.
	if _, _, err := resolveDialURLAndHeaders("ws://localhost:18955/?token=leak"); err == nil {
		t.Fatal("resolveDialURLAndHeaders accepted ?token= in URL query string")
	}

	// Browser URL formatter puts token in fragment and strips any query ?token=.
	u, err := formatBrowserTokenURL("http://localhost:5180/?relay=8180&token=bad", "goodtok")
	if err != nil || u != "http://localhost:5180/?relay=8180#token=goodtok" {
		t.Fatalf("formatBrowserTokenURL = %q (%v)", u, err)
	}
}

// A port remap (ssh -L 9000:localhost:8080, docker -p 9000:8080) or a LAN hostname reaches the
// relay under a Host it can't know: refused, unless the operator names that address with --origin.
func TestHostRemapPassesOnlyWhenBlessedByOrigin(t *testing.T) {
	host := func(h string) *http.Request {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Host = h
		return req
	}
	plain, err := newRelayAuth("127.0.0.1", 8080, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := plain.checkHost(host("localhost:9000")); err == nil {
		t.Fatal("a remapped port passed the Host check with no --origin naming it")
	}
	blessed, err := newRelayAuth("127.0.0.1", 8080, []string{"http://localhost:9000", "https://box.lan"}, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, ok := range []string{"localhost:9000", "LOCALHOST:9000", "localhost:8080", "box.lan", "box.lan:443"} {
		if err := blessed.checkHost(host(ok)); err != nil {
			t.Errorf("Host %q refused: %v", ok, err)
		}
	}
	for _, bad := range []string{"localhost:9001", "127.0.0.1:9000", "evil.example:9000", "box.lan:8443", "evil.rebind.attacker"} {
		if err := blessed.checkHost(host(bad)); err == nil {
			t.Errorf("Host %q passed; only the --origin addresses are blessed", bad)
		}
	}
	req := host("localhost:9000")
	req.Header.Set("Origin", "http://localhost:9000")
	if err := blessed.checkOrigin(req); err != nil {
		t.Errorf("the blessed origin's own page refused: %v", err)
	}

	// --listen 0.0.0.0 reached by a hostname: the same blessing.
	all, err := newRelayAuth("0.0.0.0", 8080, []string{"http://box.lan:8080"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := all.checkHost(host("box.lan:8080")); err != nil {
		t.Errorf("--listen 0.0.0.0 refused its blessed hostname: %v", err)
	}
	if err := all.checkHost(host("other.lan:8080")); err == nil {
		t.Error("--listen 0.0.0.0 passed a hostname no --origin names")
	}
}

// `--listen [::1]` is the same address as `--listen ::1`: normalized once, so net.JoinHostPort
// brackets it exactly once and the bind succeeds.
func TestBracketedIPv6ListenHostBinds(t *testing.T) {
	for in, want := range map[string]string{"[::1]": "::1", " [::] ": "::", "::1": "::1", "127.0.0.1": "127.0.0.1", "[FE80::1]": "fe80::1"} {
		if got := normalizeListenHost(in); got != want {
			t.Errorf("normalizeListenHost(%q) = %q, want %q", in, got, want)
		}
	}
	if got := net.JoinHostPort(normalizeListenHost("[::1]"), "8080"); got != "[::1]:8080" {
		t.Fatalf("JoinHostPort = %q, want [::1]:8080", got)
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(normalizeListenHost("[::1]"), "0"))
	if err != nil {
		t.Skipf("no IPv6 loopback here: %v", err)
	}
	ln.Close()
}

// --keep-token: a restart on the same port adopts the token the previous start left, so an open
// page's sessionStorage token still works; without it, every start is fresh and its file goes on exit.
func TestKeepTokenSurvivesARestartAndDefaultDoesNot(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "rt")
	t.Setenv("G3D_RELAY_TOKEN_DIR", dir)
	t.Setenv("G3D_RELAY_TOKEN", "")
	const port = 18902

	start := func(keep bool) (*relayAuth, func()) {
		t.Helper()
		a, err := newRelayAuth("127.0.0.1", port, nil, keep)
		if err != nil {
			t.Fatal(err)
		}
		_, cleanup, err := a.bind(port)
		if err != nil {
			t.Fatalf("bind: %v", err)
		}
		return a, cleanup
	}

	first, stop1 := start(true)
	stop1()
	if got, err := readRelayTokenFile(port); err != nil || got != first.Token() {
		t.Fatalf("--keep-token's file after exit = %q (%v), want the token it served", got, err)
	}
	second, stop2 := start(true)
	stop2()
	if second.Token() != first.Token() {
		t.Fatal("a --keep-token restart minted a new token; open pages would be refused")
	}

	fresh, stop3 := start(false)
	if fresh.Token() == first.Token() {
		t.Fatal("a default start reused the kept token")
	}
	stop3()
	if _, err := os.Stat(relayTokenPath(port)); !os.IsNotExist(err) {
		t.Fatalf("a default start left its token file on exit: %v", err)
	}

	// A relay a network can reach doesn't keep a token alive across restarts.
	for _, host := range []string{"0.0.0.0", "::", "192.168.1.20", "[::]"} {
		if _, err := newRelayAuth(host, port, nil, true); err == nil {
			t.Errorf("--keep-token accepted with --listen %s", host)
		}
	}

	// A kept file that holds no relay token is not adopted.
	if _, _, err := writeRelayTokenFile(port, "not-a-token"); err != nil {
		t.Fatal(err)
	}
	odd, _ := start(true)
	if !isRelayTokenShape(odd.Token()) {
		t.Fatalf("--keep-token adopted %q", odd.Token())
	}
}

// A relay started from a shell that exported G3D_RELAY_TOKEN (for an earlier relay) still hands
// its adapters ITS token: the inherited value would win in the client and be refused.
func TestAdapterEnvCarriesTheRelaysOwnToken(t *testing.T) {
	env := adapterEnv([]string{"HOME=/h", "G3D_RELAY_TOKEN=stale", "G3D_RELAY_TOKEN_DIR=/d"}, "fresh")
	var toks []string
	for _, kv := range env {
		if strings.HasPrefix(kv, "G3D_RELAY_TOKEN=") {
			toks = append(toks, kv)
		}
	}
	if len(toks) != 1 || toks[0] != "G3D_RELAY_TOKEN=fresh" {
		t.Fatalf("adapter env tokens = %v, want exactly G3D_RELAY_TOKEN=fresh", toks)
	}
	if !strings.Contains(strings.Join(env, "\n"), "HOME=/h") || !strings.Contains(strings.Join(env, "\n"), "G3D_RELAY_TOKEN_DIR=/d") {
		t.Fatalf("adapter env dropped the rest of the relay's environment: %v", env)
	}

	// The command startAdapter runs, from a relay whose own environment carries a stale token.
	t.Setenv("G3D_RELAY_TOKEN", "stale")
	r := NewRelay(newTestAuth(t))
	var cmdToks []string
	for _, kv := range r.adapterCommand("glyph3d-cli", []string{"attach", "term-1"}).Env {
		if strings.HasPrefix(kv, "G3D_RELAY_TOKEN=") {
			cmdToks = append(cmdToks, kv)
		}
	}
	if len(cmdToks) != 1 || cmdToks[0] != "G3D_RELAY_TOKEN="+r.Token() {
		t.Fatalf("the adapter's command carries %v, want only this relay's token", cmdToks)
	}

	t.Setenv("G3D_RELAY_TOKEN", "fresh") // what the adapter sees
	_, hdr, err := resolveDialURLAndHeaders("ws://localhost:18903")
	if err != nil || hdr.Get("Authorization") != "Bearer fresh" {
		t.Fatalf("adapter dials with %q (%v), want Bearer fresh", hdr.Get("Authorization"), err)
	}
}

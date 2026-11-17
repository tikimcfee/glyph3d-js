package main

import (
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

func TestServeDefaultListenIsLoopback(t *testing.T) {
	if defaultServeListen != "127.0.0.1" {
		t.Fatalf("defaultServeListen = %q, want 127.0.0.1", defaultServeListen)
	}
}

func TestNoTokenUpgradeIsRefused(t *testing.T) {
	r := NewRelay()
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
	r := NewRelay()
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
	r := NewRelay()
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
	r := NewRelay()
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
	auth, err := newRelayAuth("127.0.0.1", 0, []string{"http://127.0.0.1:15190"})
	if err != nil {
		t.Fatalf("newRelayAuth: %v", err)
	}
	r := NewRelay()
	r.auth = auth
	r.upgrader.CheckOrigin = auth.checkOriginBool
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

	r1 := NewRelay()
	r2 := NewRelay()
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
	r := NewRelay()
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


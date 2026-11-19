package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/gorilla/websocket"
	"glyph3d-cli/termdwire"
)

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// newTestAuth is the auth an in-process test relay runs with: loopback, any port, no --origin, no TLS.
func newTestAuth(t *testing.T) *relayAuth {
	t.Helper()
	auth, err := newRelayAuth("127.0.0.1", 0, nil, false, "", "")
	if err != nil {
		t.Fatalf("newRelayAuth: %v", err)
	}
	return auth
}

func generateSelfSignedCertFiles(t *testing.T, hosts ...string) (certPath, keyPath string) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	tmpl := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "glyph3d-test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	for _, h := range hosts {
		if ip := net.ParseIP(h); ip != nil {
			tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
		} else {
			tmpl.DNSNames = append(tmpl.DNSNames, h)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatalf("CreateCertificate: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		t.Fatalf("MarshalECPrivateKey: %v", err)
	}
	dir := t.TempDir()
	certPath = filepath.Join(dir, "cert.pem")
	keyPath = filepath.Join(dir, "key.pem")
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	return certPath, keyPath
}

func TestServeDefaultListenIsLoopback(t *testing.T) {
	if defaultServeListen != "127.0.0.1" {
		t.Fatalf("defaultServeListen = %q, want 127.0.0.1", defaultServeListen)
	}
	if isLoopbackListenHost("") {
		t.Fatal("isLoopbackListenHost(\"\") = true, want false")
	}
	if isLoopbackListenHost("[]") {
		t.Fatal("isLoopbackListenHost(\"[]\") = true, want false")
	}
	if isLoopbackListenHost("[localhost]") {
		t.Fatal("isLoopbackListenHost(\"[localhost]\") = true, want false")
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
		// DEF-18: ambiguous / malformed header combinations must fail closed (401).
		{"Authorization": []string{"Bearer " + r.Token(), "Bearer wrong"}},
		{"Authorization": []string{"Bearer " + r.Token() + ", Bearer wrong"}},
		{"Authorization": []string{"Basic dXNlcjpwYXNz"}, "Sec-WebSocket-Protocol": []string{"glyph3d, g3d-token." + r.Token()}},
		{"Authorization": []string{"Bearer "}, "Sec-WebSocket-Protocol": []string{"glyph3d, g3d-token." + r.Token()}},
		{"Sec-WebSocket-Protocol": []string{"glyph3d, g3d-token., g3d-token." + r.Token()}},
		{"Sec-WebSocket-Protocol": []string{"glyph3d, g3d-token." + r.Token() + ", g3d-token.other"}},
		{"Sec-WebSocket-Protocol": []string{"glyph3d, g3d-token." + r.Token() + ", g3d-token." + r.Token()}},
		{"Authorization": []string{"Bearer " + r.Token()}, "Sec-WebSocket-Protocol": []string{"glyph3d, g3d-token.other"}},
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

	// Matching Bearer and g3d-token.<tok> succeeds.
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, http.Header{
		"Authorization":          []string{"Bearer " + r.Token()},
		"Sec-WebSocket-Protocol": []string{"glyph3d, g3d-token." + r.Token()},
	})
	if err != nil {
		t.Fatalf("matching Bearer + g3d-token dial failed: %v", err)
	}
	conn.Close()
	if got := resp.Header.Get("Sec-WebSocket-Protocol"); got != wsBaseSubprotocol {
		t.Fatalf("Sec-WebSocket-Protocol = %q, want %q", got, wsBaseSubprotocol)
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
		"http://[::1%25lo0]:5173",
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
	baseWS := "ws://" + strings.TrimPrefix(srv.URL, "http://")

	// DEF-14: case-insensitive, semicolon-separated, bare, percent-encoded, and invalid-escape query tokens must all fail 400.
	for _, q := range []string{
		"/?token=" + r.Token(),
		"/?TOKEN=" + r.Token(),
		"/?a=1;token=" + r.Token(),
		"/?a=1;TOKEN=" + r.Token(),
		"/?token=" + r.Token() + "%ZZ",
		"/?%74%6f%6b%65%6e=" + r.Token(),
		"/?token",
	} {
		conn, resp, err := websocket.DefaultDialer.Dial(baseWS+q, http.Header{
			"Authorization": []string{"Bearer " + r.Token()},
		})
		if err == nil {
			conn.Close()
			t.Fatalf("upgrade carrying %q in URL query string was accepted", q)
		}
		if resp == nil || resp.StatusCode != http.StatusBadRequest {
			code := 0
			if resp != nil {
				code = resp.StatusCode
			}
			t.Fatalf("query %q status = %d, want %d", q, code, http.StatusBadRequest)
		}
	}
}

func TestDNSRebindingHostHeaderIsRefused(t *testing.T) {
	r := NewRelay(newTestAuth(t))
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	for _, badHost := range []string{
		"evil.rebind.attacker:8080",
		"[localhost]",
		"[localhost]:8080",
		"[[[localhost]]]",
		"[localhost",
		"[::1]:",
		"localhost:",
		"::1",
		"[127.0.0.1]:8080",
		"localhost:0",
		"localhost:65536",
		"user@localhost:8080",
	} {
		req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
		req.Host = badHost
		req.Header.Set("Connection", "Upgrade")
		req.Header.Set("Upgrade", "websocket")
		req.Header.Set("Authorization", "Bearer "+r.Token())
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("http request (%q): %v", badHost, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("Host %q status = %d, want %d", badHost, resp.StatusCode, http.StatusForbidden)
		}
	}
}

func TestAllowedOriginsAndSubprotocolWorkAcrossAllRoles(t *testing.T) {
	auth, err := newRelayAuth("127.0.0.1", 0, []string{"http://127.0.0.1:15190"}, false, "", "")
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

	// DEF-13: Even when a successor writes the IDENTICAL token string (e.g. --keep-token restart)
	// into a fresh inode, the predecessor's cleanup must NOT unlink the successor's inode!
	_, clean3, err := writeRelayTokenFile(18901, r2.Token())
	if err != nil {
		t.Fatalf("writeRelayTokenFile 3 (same token, new inode): %v", err)
	}
	clean2()
	got3, err := readRelayToken(18901)
	if err != nil || got3 != r2.Token() {
		t.Fatalf("predecessor cleanup unlinked successor inode holding identical token: got %q (%v)", got3, err)
	}
	clean3()
	if _, err := os.Stat(p1); !os.IsNotExist(err) {
		t.Fatalf("token file remained after owner cleanup: %v", err)
	}
}

func TestUnixSymlinkFIFOAndDefaultPrivateDirs(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix-only filesystem security checks")
	}

	// DES-04: fallback runtime dir and default log dir live under <pw_dir>/.local/state/g3d/{run,logs}, never /tmp.
	if termdwire.UserRuntimeDir() == "" {
		rt := relayRuntimeDir()
		if !strings.HasSuffix(rt, filepath.Join(".local", "state", "g3d", "run")) || strings.HasPrefix(rt, "/tmp/") {
			t.Fatalf("fallback relayRuntimeDir() = %q, want <home>/.local/state/g3d/run", rt)
		}
	}
	ld := defaultLogDir()
	if !strings.HasSuffix(ld, filepath.Join(".local", "state", "g3d", "logs")) || strings.HasPrefix(ld, "/tmp/") {
		t.Fatalf("defaultLogDir() = %q, want <home>/.local/state/g3d/logs", ld)
	}

	// Symlink runtime dir must be rejected by openSecureRuntimeDir / writeRelayTokenFile / readRelayTokenFile.
	tmp := t.TempDir()
	realDir := filepath.Join(tmp, "real")
	if err := os.MkdirAll(realDir, 0o700); err != nil {
		t.Fatal(err)
	}
	linkDir := filepath.Join(tmp, "link")
	if err := os.Symlink(realDir, linkDir); err != nil {
		t.Fatal(err)
	}
	t.Setenv("G3D_RELAY_TOKEN_DIR", linkDir)
	t.Setenv("G3D_RELAY_TOKEN", "")
	if err := checkSecureRuntimeDir(linkDir); err == nil {
		t.Fatal("checkSecureRuntimeDir accepted a symlink directory")
	}
	if _, _, err := writeRelayTokenFile(18911, strings.Repeat("a", 64)); err == nil {
		t.Fatal("writeRelayTokenFile accepted a symlink G3D_RELAY_TOKEN_DIR")
	}

	// Switch to real 0700 dir; test symlink token file and FIFO token file (DEF-12).
	t.Setenv("G3D_RELAY_TOKEN_DIR", realDir)
	tokPath, clean, err := writeRelayTokenFile(18912, strings.Repeat("c", 64))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(tokPath); err != nil {
		t.Fatal(err)
	}
	otherFile := filepath.Join(tmp, "other.tok")
	if err := os.WriteFile(otherFile, []byte(strings.Repeat("d", 64)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(otherFile, tokPath); err != nil {
		t.Fatal(err)
	}
	if _, err := readRelayTokenFile(18912); err == nil {
		t.Fatal("readRelayTokenFile followed a symlink token file")
	}
	_ = os.Remove(tokPath)

	// Replace relay-18912.token with a 0600 FIFO: neither readRelayTokenFile nor cleanup() may block or unlink it!
	if out, err := exec.Command("mkfifo", "-m", "0600", tokPath).CombinedOutput(); err != nil {
		t.Fatalf("mkfifo: %v (%s)", err, out)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		if _, err := readRelayTokenFile(18912); err == nil {
			t.Error("readRelayTokenFile accepted a FIFO")
		}
		if err := checkSecureTokenFile(tokPath); err == nil {
			t.Error("checkSecureTokenFile accepted a FIFO")
		}
		clean()
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("FIFO token file hung readRelayTokenFile or cleanup()")
	}
	if fi, err := os.Lstat(tokPath); err != nil || fi.Mode()&os.ModeNamedPipe == 0 {
		t.Fatalf("cleanup() unlinked or altered FIFO of different inode: fi=%v err=%v", fi, err)
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

	// DEF-15: Missing token file (ENOENT) is non-fatal in resolveDialURLAndHeaders.
	dialURL0, hdr0, err := resolveDialURLAndHeaders("ws://localhost:18954")
	if err != nil || dialURL0 != "ws://localhost:18954" || hdr0.Get("Authorization") != "" {
		t.Fatalf("missing token file: url=%q auth=%q err=%v", dialURL0, hdr0.Get("Authorization"), err)
	}

	tok := strings.Repeat("b", 64)
	tokPath, clean, err := writeRelayTokenFile(18955, tok)
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

	// DEF-15: Explicit --port N prefers relay-N.token on disk over an exported G3D_RELAY_TOKEN
	// from another relay, while default (--port 0) still honors G3D_RELAY_TOKEN.
	t.Setenv("G3D_RELAY_TOKEN", "other_exported_token")
	if gotPref, err := readRelayTokenWithPortPref(18955, true); err != nil || gotPref != tok {
		t.Fatalf("readRelayTokenWithPortPref(18955, true) = %q (%v), want disk token %q", gotPref, err, tok)
	}
	if _, hdrPref, err := resolveDialURLAndHeadersWithPortPref("ws://localhost:18955", true); err != nil || hdrPref.Get("Authorization") != "Bearer "+tok {
		t.Fatalf("resolveDialURLAndHeadersWithPortPref(true) = %q (%v), want Bearer %s", hdrPref.Get("Authorization"), err, tok)
	}
	if gotDef, err := readRelayTokenWithPortPref(18955, false); err != nil || gotDef != "other_exported_token" {
		t.Fatalf("readRelayTokenWithPortPref(18955, false) = %q (%v), want other_exported_token", gotDef, err)
	}
	t.Setenv("G3D_RELAY_TOKEN", "")

	// DEF-15: Non-ENOENT token file error (e.g. 0644 permissions) MUST surface immediately!
	if runtime.GOOS != "windows" {
		if err := os.Chmod(tokPath, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, _, err := resolveDialURLAndHeaders("ws://localhost:18955"); err == nil {
			t.Fatal("resolveDialURLAndHeaders swallowed unsafe 0644 token file error")
		}
		if err := os.Chmod(tokPath, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	// #token= fragment is extracted into Authorization and stripped from dialURL.
	dialURL2, hdr2, err := resolveDialURLAndHeaders("ws://127.0.0.1:18955/#token=fragtok")
	if err != nil || dialURL2 != "ws://127.0.0.1:18955/" || hdr2.Get("Authorization") != "Bearer fragtok" {
		t.Fatalf("fragment dial: url=%q auth=%q err=%v", dialURL2, hdr2.Get("Authorization"), err)
	}

	// ?token= / ?TOKEN= / ;token= query strings are refused loudly and do NOT recommend #token= on argv (DEF-11, DEF-14).
	for _, bad := range []string{
		"ws://localhost:18955/?token=leak",
		"ws://localhost:18955/?TOKEN=leak",
		"ws://localhost:18955/?a=1;token=leak",
	} {
		_, _, qerr := resolveDialURLAndHeaders(bad)
		if qerr == nil {
			t.Fatalf("resolveDialURLAndHeaders accepted %q", bad)
		}
		if strings.Contains(qerr.Error(), "#token=") || strings.Contains(qerr.Error(), "leak") {
			t.Fatalf("query error leaked secret or recommended #token= on argv: %v", qerr)
		}
	}

	// DEF-11: Malformed URL error must scrub #token=secret from returned error string!
	if _, _, perr := resolveDialURLAndHeaders("ws://[::1%lo0]:18955/#token=TOPSECRET123"); perr == nil {
		t.Fatal("expected parse error")
	} else if strings.Contains(perr.Error(), "TOPSECRET123") {
		t.Fatalf("URL parse error leaked fragment secret: %v", perr)
	}

	// Browser URL formatter puts token in fragment and strips any query token case-insensitively across & and ; (DEF-14).
	for _, in := range []string{
		"http://localhost:5180/?relay=8180&token=bad",
		"http://localhost:5180/?relay=8180&TOKEN=bad",
		"http://localhost:5180/?relay=8180;Token=bad%ZZ",
		"http://localhost:5180/?%74oken=bad&relay=8180#TOKEN=old",
	} {
		u, err := formatBrowserTokenURL(in, "goodtok")
		if err != nil || u != "http://localhost:5180/?relay=8180#token=goodtok" {
			t.Fatalf("formatBrowserTokenURL(%q) = %q (%v)", in, u, err)
		}
	}
}

func TestPlaintextNetworkAndOriginBanPlusPort80And443(t *testing.T) {
	// DES-01: Plaintext non-loopback --listen is refused unless it is an active local Tailscale IP or TLS is set.
	for _, host := range []string{"0.0.0.0", "::", "[::]", "192.168.1.20", "10.0.0.73", "172.16.0.5", "box.lan", "mybox.local", "[localhost]"} {
		if _, err := newRelayAuth(host, 8080, nil, false, "", ""); err == nil {
			t.Errorf("newRelayAuth accepted plaintext non-loopback --listen %q without TLS", host)
		}
	}
	// Mismatched TLS flags must fail.
	if _, err := newRelayAuth("127.0.0.1", 8080, nil, false, "cert.pem", ""); err == nil {
		t.Fatal("accepted --tls-cert without --tls-key")
	}
	if _, err := newRelayAuth("127.0.0.1", 8080, nil, false, "", "key.pem"); err == nil {
		t.Fatal("accepted --tls-key without --tls-cert")
	}

	// Tailscale --listen: allowed without TLS ONLY when assigned to an up local interface; --keep-token still refused!
	prevCheck := localInterfaceIPCheck
	t.Cleanup(func() { localInterfaceIPCheck = prevCheck })

	localInterfaceIPCheck = func(net.IP) bool { return false }
	if _, err := newRelayAuth("100.64.1.2", 8080, nil, false, "", ""); err == nil {
		t.Fatal("accepted unassigned Tailscale IP --listen 100.64.1.2")
	}

	localInterfaceIPCheck = func(net.IP) bool { return true }
	for _, tsHost := range []string{"100.64.1.2", "100.127.255.254", "fd7a:115c:a1e0::1", "[fd7a:115c:a1e0::1]"} {
		tsAuth, err := newRelayAuth(tsHost, 8080, nil, false, "", "")
		if err != nil {
			t.Fatalf("rejected assigned local Tailscale --listen %q: %v", tsHost, err)
		}
		// DES-05: defaultViteOrigins must NOT be allowed on Tailscale listens!
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Host = net.JoinHostPort(normalizeListenHost(tsHost), "8080")
		req.Header.Set("Origin", "http://localhost:5173")
		if err := tsAuth.checkOrigin(req); err == nil {
			t.Errorf("Tailscale listen %q accepted loopback Vite origin without --origin", tsHost)
		}
		if _, err := newRelayAuth(tsHost, 8080, nil, true, "", ""); err == nil {
			t.Errorf("--keep-token accepted on Tailscale --listen %q", tsHost)
		}
	}
	// Addresses just outside 100.64.0.0/10 must still be refused even if localInterfaceIPCheck is true!
	for _, nonTS := range []string{"100.63.255.255", "100.128.0.1", "192.168.1.5"} {
		if _, err := newRelayAuth(nonTS, 8080, nil, false, "", ""); err == nil {
			t.Errorf("accepted non-Tailscale IP %q without TLS", nonTS)
		}
	}
	localInterfaceIPCheck = prevCheck

	// DES-02 & DEF-06: Plaintext http:// --origin ban and IPv6 zone-ID rejection (no panic!).
	for _, badOrigin := range []string{
		"http://[::1%25lo0]:8080",
		"http://[::1%lo0]:8080",
		"https://[::1%25lo0]:8443",
		"http://box.lan",
		"http://box.lan:8080",
		"http://mybox.local:9000",
		"http://192.168.1.20:8080",
		"http://100.128.0.1:8080",
		"https://[localhost]:8443",
		"https://box.lan:",
	} {
		if _, err := newRelayAuth("127.0.0.1", 8080, []string{badOrigin}, false, "", ""); err == nil {
			t.Errorf("newRelayAuth accepted disallowed --origin %q", badOrigin)
		}
	}
	for _, goodOrigin := range []string{
		"http://localhost:80",
		"http://127.0.0.1:5280",
		"http://[::1]:5280",
		"http://100.64.1.2:8080",
		"http://[fd7a:115c:a1e0::1]:8080",
		"https://box.lan",
		"https://box.lan:443",
		"https://mybox.local:9000",
	} {
		if _, err := newRelayAuth("127.0.0.1", 8080, []string{goodOrigin}, false, "", ""); err != nil {
			t.Errorf("newRelayAuth rejected valid --origin %q: %v", goodOrigin, err)
		}
	}

	// DEF-07: Default ports 80 and 443 and strict port matching on portless Host headers.
	auth8080, err := newRelayAuth("127.0.0.1", 8080, nil, false, "", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, portless := range []string{"localhost", "127.0.0.1", "[::1]"} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Host = portless
		if err := auth8080.checkHost(req); err == nil {
			t.Errorf("relay on :8080 accepted portless Host %q", portless)
		}
	}

	auth80, err := newRelayAuth("127.0.0.1", 80, nil, false, "", "")
	if err != nil {
		t.Fatal(err)
	}
	req80 := httptest.NewRequest(http.MethodGet, "/", nil)
	req80.Host = "localhost"
	req80.Header.Set("Origin", "http://localhost")
	if err := auth80.checkHost(req80); err != nil {
		t.Fatalf("port 80 checkHost(localhost): %v", err)
	}
	if err := auth80.checkOrigin(req80); err != nil {
		t.Fatalf("port 80 checkOrigin(http://localhost): %v", err)
	}

	auth443, err := newRelayAuth("127.0.0.1", 443, []string{"https://box.lan:443"}, false, "cert.pem", "key.pem")
	if err != nil {
		t.Fatal(err)
	}
	req443 := httptest.NewRequest(http.MethodGet, "/", nil)
	req443.Host = "localhost"
	req443.Header.Set("Origin", "https://localhost")
	if err := auth443.checkHost(req443); err != nil {
		t.Fatalf("port 443 checkHost(localhost): %v", err)
	}
	if err := auth443.checkOrigin(req443); err != nil {
		t.Fatalf("port 443 checkOrigin(https://localhost): %v", err)
	}
	// Explicit --origin https://box.lan:443 matches browser Origin: https://box.lan (default port stripped).
	reqLan := httptest.NewRequest(http.MethodGet, "/", nil)
	reqLan.Host = "box.lan"
	reqLan.Header.Set("Origin", "https://box.lan")
	if err := auth443.checkHost(reqLan); err != nil || auth443.checkOrigin(reqLan) != nil {
		t.Fatalf("https://box.lan:443 did not match browser Origin https://box.lan")
	}
}

// A port remap (ssh -L 9000:localhost:8080, docker -p 9000:8080) or a TLS hostname reaches the
// relay under a Host it can't know: refused, unless the operator names that address with --origin.
func TestHostRemapPassesOnlyWhenBlessedByOrigin(t *testing.T) {
	host := func(h string) *http.Request {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Host = h
		return req
	}
	plain, err := newRelayAuth("127.0.0.1", 8080, nil, false, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := plain.checkHost(host("localhost:9000")); err == nil {
		t.Fatal("a remapped port passed the Host check with no --origin naming it")
	}
	blessed, err := newRelayAuth("127.0.0.1", 8080, []string{"http://localhost:9000", "https://box.lan"}, false, "", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, ok := range []string{"localhost:9000", "LOCALHOST:9000", "localhost:8080", "box.lan", "box.lan:443"} {
		if err := blessed.checkHost(host(ok)); err != nil {
			t.Errorf("Host %q refused: %v", ok, err)
		}
	}
	for _, bad := range []string{"localhost:9001", "127.0.0.1:9000", "evil.example:9000", "box.lan:8443", "evil.rebind.attacker", "localhost"} {
		if err := blessed.checkHost(host(bad)); err == nil {
			t.Errorf("Host %q passed; only the --origin addresses and bound host:port are blessed", bad)
		}
	}
	req := host("localhost:9000")
	req.Header.Set("Origin", "http://localhost:9000")
	if err := blessed.checkOrigin(req); err != nil {
		t.Errorf("the blessed origin's own page refused: %v", err)
	}

	// --listen 0.0.0.0 with TLS reached by a hostname: blessed only for https://box.lan:8080, and Vite origins disabled.
	all, err := newRelayAuth("0.0.0.0", 8080, []string{"https://box.lan:8080"}, false, "cert.pem", "key.pem")
	if err != nil {
		t.Fatal(err)
	}
	if err := all.checkHost(host("box.lan:8080")); err != nil {
		t.Errorf("--listen 0.0.0.0 with TLS refused its blessed hostname: %v", err)
	}
	if err := all.checkHost(host("other.lan:8080")); err == nil {
		t.Error("--listen 0.0.0.0 passed a hostname no --origin names")
	}
	viteReq := host("localhost:8080")
	viteReq.Header.Set("Origin", "http://localhost:5173")
	if err := all.checkOrigin(viteReq); err == nil {
		t.Error("--listen 0.0.0.0 accepted defaultViteOrigins without explicit --origin")
	}
}

// `--listen [::1]` is the same address as `--listen ::1`: normalized once, while empty / `[]`
// default to 127.0.0.1 and non-IPv6 `[localhost]` keeps its brackets.
func TestBracketedIPv6AndEmptyListenHostNormalization(t *testing.T) {
	cases := map[string]string{
		"":            "127.0.0.1",
		"   ":         "127.0.0.1",
		"[]":          "127.0.0.1",
		" [] ":        "127.0.0.1",
		"[   ]":       "127.0.0.1",
		"[::1]":       "::1",
		" [::] ":      "::",
		"::1":         "::1",
		"127.0.0.1":   "127.0.0.1",
		"[FE80::1]":   "fe80::1",
		"[localhost]": "[localhost]",
		"[127.0.0.1]": "[127.0.0.1]",
		"[[::1]]":     "[[::1]]",
	}
	for in, want := range cases {
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
		a, err := newRelayAuth("127.0.0.1", port, nil, keep, "", "")
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

	// A relay a network can reach doesn't keep a token alive across restarts — even with TLS.
	for _, host := range []string{"0.0.0.0", "::", "192.168.1.20", "[::]", "100.64.1.2"} {
		if _, err := newRelayAuth(host, port, nil, true, "cert.pem", "key.pem"); err == nil {
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

func TestTLSRunServerNoBannerTokenLeakAndStaticGuards(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("relay unsupported on Windows")
	}
	tokDir := filepath.Join(t.TempDir(), "rt")
	t.Setenv("G3D_RELAY_TOKEN_DIR", tokDir)
	t.Setenv("G3D_RELAY_TOKEN", "")
	// Isolate termd status socket in scratch dir so no real daemon is touched.
	t.Setenv("G3D_TERMD_DIR", filepath.Join(t.TempDir(), "td"))

	certFile, keyFile := generateSelfSignedCertFiles(t, "127.0.0.1", "localhost")
	staticFS := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<!doctype html><title>ok</title>")},
	}

	var logBuf syncBuffer
	origOut := log.Writer()
	log.SetOutput(&logBuf)
	t.Cleanup(func() { log.SetOutput(origOut) })

	// Capture stdout to prove RunServer prints zero `#token=` URLs even if stdout were inspected.
	rPipe, wPipe, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	origStdout := os.Stdout
	os.Stdout = wPipe
	t.Cleanup(func() {
		os.Stdout = origStdout
		rPipe.Close()
	})

	// Pick a free loopback port, then let RunServer bind it with TLS.
	probeLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := probeLn.Addr().(*net.TCPAddr).Port
	probeLn.Close()

	errCh := make(chan error, 1)
	go func() {
		errCh <- RunServer(ServerConfig{
			Host:      "", // DEF-01: empty Host must normalize to 127.0.0.1, never [::]
			Port:      port,
			TLSCert:   certFile,
			TLSKey:    keyFile,
			StaticFS:  staticFS,
			StaticTag: "test-mapfs",
		})
	}()

	var tok string
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case serr := <-errCh:
			t.Fatalf("RunServer exited early: %v", serr)
		default:
		}
		if tval, rerr := readRelayTokenFile(port); rerr == nil && tval != "" {
			tok = tval
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if tok == "" {
		t.Fatal("timed out waiting for TLS RunServer to publish token file")
	}

	// Build TLS client trusting the self-signed cert.
	pemBytes, _ := os.ReadFile(certFile)
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(pemBytes)
	tlsCfg := &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	httpsClient := &http.Client{Transport: &http.Transport{TLSClientConfig: tlsCfg}}

	baseHTTPS := "https://localhost:" + strconv.Itoa(port)
	resp, err := httpsClient.Get(baseHTTPS + "/")
	if err != nil {
		t.Fatalf("HTTPS GET /: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("HTTPS GET / status = %d, want 200", resp.StatusCode)
	}
	if gotRef := resp.Header.Get("Referrer-Policy"); gotRef != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q, want no-referrer", gotRef)
	}

	// DEF-14: Static HTTP handler must refuse ?TOKEN= query secrets with 400 Bad Request.
	badResp, err := httpsClient.Get(baseHTTPS + "/?a=1;TOKEN=" + tok)
	if err != nil {
		t.Fatalf("HTTPS GET /?TOKEN=: %v", err)
	}
	badResp.Body.Close()
	if badResp.StatusCode != http.StatusBadRequest {
		t.Fatalf("HTTPS GET /?a=1;TOKEN= status = %d, want 400", badResp.StatusCode)
	}

	// Authenticated WSS upgrade succeeds over TLS.
	dialer := websocket.Dialer{
		TLSClientConfig: tlsCfg,
		Subprotocols:    []string{wsBaseSubprotocol, wsTokenSubprotocolPrefix + tok},
	}
	wsConn, _, err := dialer.Dial("wss://localhost:"+strconv.Itoa(port), http.Header{
		"Origin": []string{baseHTTPS},
	})
	if err != nil {
		t.Fatalf("WSS dial failed: %v", err)
	}
	if err := wsConn.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
		t.Fatal(err)
	}
	_, hello, err := wsConn.ReadMessage()
	wsConn.Close()
	if err != nil || !strings.HasPrefix(string(hello), "OK: connected as ") {
		t.Fatalf("WSS hello = %q (%v)", hello, err)
	}

	// Verify neither stdout nor log output leaked `#token=` or the raw capability token!
	os.Stdout = origStdout
	wPipe.Close()
	stdoutBytes, _ := io.ReadAll(rPipe)
	combined := string(stdoutBytes) + "\n" + logBuf.String()
	if strings.Contains(combined, "#token=") || strings.Contains(combined, tok) {
		t.Fatalf("startup banner/stdout leaked capability token:\n%s", combined)
	}
	if !strings.Contains(logBuf.String(), "127.0.0.1:"+strconv.Itoa(port)) {
		t.Fatalf("expected empty Host to bind 127.0.0.1:%d, logs:\n%s", port, logBuf.String())
	}
}

func TestBrowserLogIngestRedactsTokensAndDumpUsesPrivate0600File(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix-only log dump test")
	}
	var logBuf syncBuffer
	origOut := log.Writer()
	log.SetOutput(&logBuf)
	t.Cleanup(func() { log.SetOutput(origOut) })

	r, dial := newTestRelay(t)
	otherSecret := strings.Repeat("f", 64)

	disp := dial(t)
	if err := disp.WriteMessage(websocket.TextMessage, []byte("DISPLAY")); err != nil {
		t.Fatal(err)
	}
	_ = readJSON(t, disp)

	ctrl := dial(t)
	if err := ctrl.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
		t.Fatal(err)
	}
	_, _, _ = ctrl.ReadMessage() // OK: connected as ctrl-N
	_, _, _ = ctrl.ReadMessage() // pong
	if err := ctrl.WriteMessage(websocket.TextMessage, []byte(`{"relay":"log.follow"}`)); err != nil {
		t.Fatal(err)
	}
	_ = awaitEvent(t, ctrl, "log.follow")

	// Send browser.log records carrying r.Token(), #token=..., g3d-token...., and relay.token / relay.connect args.
	records := []string{
		`{"event":"browser.log","rec":{"ts":1,"level":"error","scope":"ws","msg":"connect failed http://localhost:5180/?relay=8180#token=` + r.Token() + ` proto g3d-token.` + otherSecret + `","attrs":{"raw":"` + r.Token() + `"},"page":"p1"}}`,
		`{"event":"browser.log","rec":{"ts":2,"level":"warn","scope":"command","msg":"relay.token","attrs":{"args":["` + otherSecret + `"]},"page":"p1"}}`,
		`{"event":"browser.log","rec":{"ts":3,"level":"warn","scope":"command","msg":"relay.connect","attrs":{"args":["8180","` + otherSecret + `"]},"page":"p1"}}`,
	}
	for _, line := range records {
		if err := disp.WriteMessage(websocket.TextMessage, []byte(line)); err != nil {
			t.Fatal(err)
		}
	}

	for range len(records) {
		ev := awaitEvent(t, ctrl, "browser.log")
		rawEv, _ := json.Marshal(ev)
		if bytes.Contains(rawEv, []byte(r.Token())) || bytes.Contains(rawEv, []byte(otherSecret)) {
			t.Fatalf("log.follow leaked secret: %s", rawEv)
		}
	}
	if strings.Contains(logBuf.String(), r.Token()) || strings.Contains(logBuf.String(), otherSecret) {
		t.Fatalf("relay stderr leaked secret: %s", logBuf.String())
	}

	// Verify SQLite store + FTS5 hold zero copies of either secret.
	for _, secret := range []string{r.Token(), otherSecret} {
		hits, err := r.logs.Search(secret[:16], SearchOpts{})
		if err != nil {
			t.Fatal(err)
		}
		if len(hits) != 0 {
			t.Fatalf("SQLite/FTS5 retained secret %q: %+v", secret, hits)
		}
	}

	// DEF-04: Symlink dump target must be refused without overwriting target!
	tmp := t.TempDir()
	victim := filepath.Join(tmp, "victim.txt")
	if err := os.WriteFile(victim, []byte("keep-me"), 0o600); err != nil {
		t.Fatal(err)
	}
	symDump := filepath.Join(tmp, "dump.db")
	if err := os.Symlink(victim, symDump); err != nil {
		t.Fatal(err)
	}
	if _, _, err := r.logs.Dump(symDump); err == nil {
		t.Fatal("LogStore.Dump accepted a symlink target")
	}
	if got, _ := os.ReadFile(victim); string(got) != "keep-me" {
		t.Fatalf("symlink target was modified: %q", got)
	}

	// Explicit dump writes a 0600 file in a 0700 parent dir containing zero secrets.
	okDump := filepath.Join(tmp, "private", "logs.db")
	_, outPath, err := r.logs.Dump(okDump)
	if err != nil {
		t.Fatalf("Dump: %v", err)
	}
	if fi, err := os.Lstat(outPath); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("dump file perm = %04o (%v), want 0600", fi.Mode().Perm(), err)
	}
	rawDB, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(rawDB, []byte(r.Token())) || bytes.Contains(rawDB, []byte(otherSecret)) {
		t.Fatal("dumped SQLite DB file contains unredacted token")
	}

	// Verify errors.Is(err, os.ErrNotExist) works on readRelayTokenFile when missing.
	t.Setenv("G3D_RELAY_TOKEN_DIR", filepath.Join(tmp, "missing-rt"))
	if _, err := readRelayTokenFile(19999); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing runtime dir err = %v, want errors.Is(..., os.ErrNotExist)", err)
	}
}

package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

const (
	relayTokenBytes          = 32 // 256-bit random capability token (64 hex chars)
	wsBaseSubprotocol        = "glyph3d"
	wsTokenSubprotocolPrefix = "g3d-token."
)

// defaultViteOrigins are the loopback dev-server origins for the IDE (:5173) and the wall (:5180).
var defaultViteOrigins = map[string]bool{
	"http://localhost:5173": true,
	"http://127.0.0.1:5173": true,
	"http://[::1]:5173":     true,
	"http://localhost:5180": true,
	"http://127.0.0.1:5180": true,
	"http://[::1]:5180":     true,
}

var activeTokenCleanups = struct {
	sync.Mutex
	fns []func()
}{}

func registerTokenCleanup(fn func()) {
	if fn == nil {
		return
	}
	activeTokenCleanups.Lock()
	activeTokenCleanups.fns = append(activeTokenCleanups.fns, fn)
	activeTokenCleanups.Unlock()
}

func cleanupRelayTokens() {
	activeTokenCleanups.Lock()
	fns := activeTokenCleanups.fns
	activeTokenCleanups.fns = nil
	activeTokenCleanups.Unlock()
	for _, fn := range fns {
		fn()
	}
}

func generateRelayToken() (string, error) {
	var b [relayTokenBytes]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("crypto/rand: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}

// relayTokenDir returns the private directory holding relay-<port>.token files.
// G3D_RELAY_TOKEN_DIR overrides it for isolated tests.
func relayTokenDir() string {
	if d := strings.TrimSpace(os.Getenv("G3D_RELAY_TOKEN_DIR")); d != "" {
		return d
	}
	return relayRuntimeDir()
}

func relayTokenPath(port int) string {
	return filepath.Join(relayTokenDir(), fmt.Sprintf("relay-%d.token", port))
}

// writeRelayTokenFile atomically writes token (mode 0600) into the uid-verified 0700
// runtime directory and returns the path plus an idempotent cleanup that unlinks the
// file only if it still holds this server's token.
func writeRelayTokenFile(port int, token string) (string, func(), error) {
	if port <= 0 {
		return "", nil, fmt.Errorf("invalid relay port %d", port)
	}
	dir := relayTokenDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", nil, fmt.Errorf("create relay runtime dir %s: %w", dir, err)
	}
	if err := checkSecureRuntimeDir(dir); err != nil {
		return "", nil, err
	}
	finalPath := relayTokenPath(port)
	tmp, err := os.CreateTemp(dir, fmt.Sprintf(".relay-%d-*.tmp", port))
	if err != nil {
		return "", nil, fmt.Errorf("create temp token file in %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return "", nil, fmt.Errorf("chmod token file: %w", err)
	}
	if _, err := tmp.WriteString(token + "\n"); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return "", nil, fmt.Errorf("write token file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return "", nil, fmt.Errorf("close token file: %w", err)
	}
	if err := os.Rename(tmpName, finalPath); err != nil {
		os.Remove(tmpName)
		return "", nil, fmt.Errorf("publish token file %s: %w", finalPath, err)
	}
	var once sync.Once
	cleanup := func() {
		once.Do(func() {
			b, err := os.ReadFile(finalPath)
			if err == nil && strings.TrimSpace(string(b)) == token {
				_ = os.Remove(finalPath)
			}
		})
	}
	return finalPath, cleanup, nil
}

// readRelayToken reads the token for localhost:port (or returns $G3D_RELAY_TOKEN if set).
func readRelayToken(port int) (string, error) {
	if envTok := strings.TrimSpace(os.Getenv("G3D_RELAY_TOKEN")); envTok != "" {
		return parseRelayTokenValue(envTok)
	}
	if port <= 0 {
		return "", fmt.Errorf("invalid relay port %d", port)
	}
	dir := relayTokenDir()
	if err := checkSecureRuntimeDir(dir); err != nil {
		return "", err
	}
	path := relayTokenPath(port)
	if err := checkSecureTokenFile(path); err != nil {
		return "", err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	tok := strings.TrimSpace(string(b))
	if tok == "" {
		return "", fmt.Errorf("relay token file %s is empty", path)
	}
	return tok, nil
}

// parseRelayTokenValue accepts either a raw token or a URL/fragment carrying #token=<val>.
// It refuses URLs carrying ?token= in the query string.
func parseRelayTokenValue(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", fmt.Errorf("empty relay token")
	}
	if strings.Contains(s, "://") {
		u, err := url.Parse(s)
		if err != nil {
			return "", fmt.Errorf("invalid token URL: %w", err)
		}
		if u.Query().Has("token") {
			return "", fmt.Errorf("relay token must not be passed in URL query string; use #token= fragment")
		}
		vals, err := url.ParseQuery(u.Fragment)
		if err != nil {
			return "", fmt.Errorf("invalid URL fragment: %w", err)
		}
		tok := strings.TrimSpace(vals.Get("token"))
		if tok == "" {
			return "", fmt.Errorf("URL carries no #token= fragment")
		}
		return tok, nil
	}
	if strings.HasPrefix(s, "#") {
		vals, err := url.ParseQuery(strings.TrimPrefix(s, "#"))
		if err == nil {
			if tok := strings.TrimSpace(vals.Get("token")); tok != "" {
				return tok, nil
			}
		}
	}
	return s, nil
}

// relayAuth enforces Host, Origin, and per-start capability-token checks on the relay.
type relayAuth struct {
	token           string
	listenHost      string // normalized listen host ("127.0.0.1", "0.0.0.0", "::", or specific IP/host)
	port            int    // 0 in in-process httptest servers (any port on allowed host)
	allowAllIfaces  bool   // true when listenHost is 0.0.0.0 or ::
	allowedHosts    map[string]bool
	explicitOrigins map[string]bool
}

func newRelayAuth(listenHost string, port int, extraOrigins []string) (*relayAuth, error) {
	tok, err := generateRelayToken()
	if err != nil {
		return nil, err
	}
	cleanListen := strings.ToLower(strings.Trim(strings.TrimSpace(listenHost), "[]"))
	if cleanListen == "" {
		cleanListen = "127.0.0.1"
	}
	hosts := map[string]bool{
		"localhost": true,
		"127.0.0.1": true,
		"::1":       true,
	}
	allowAllIfaces := cleanListen == "0.0.0.0" || cleanListen == "::"
	if !allowAllIfaces {
		hosts[cleanListen] = true
	}
	explicit := make(map[string]bool, len(extraOrigins))
	for _, raw := range extraOrigins {
		canon, err := canonicalOrigin(raw)
		if err != nil {
			return nil, fmt.Errorf("--origin %q: %w", raw, err)
		}
		explicit[canon] = true
	}
	return &relayAuth{
		token:           tok,
		listenHost:      cleanListen,
		port:            port,
		allowAllIfaces:  allowAllIfaces,
		allowedHosts:    hosts,
		explicitOrigins: explicit,
	}, nil
}

func (a *relayAuth) Token() string {
	return a.token
}

func canonicalOrigin(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" || strings.EqualFold(s, "null") {
		return "", fmt.Errorf("origin is %q", raw)
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", err
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", fmt.Errorf("unsupported scheme %q (want http or https)", u.Scheme)
	}
	if u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("origin must be scheme://host[:port] with no path, query, or fragment")
	}
	return scheme + "://" + strings.ToLower(u.Host), nil
}

func (a *relayAuth) isHostAllowed(host string) bool {
	h := strings.ToLower(strings.Trim(host, "[]"))
	if a.allowedHosts[h] {
		return true
	}
	if a.allowAllIfaces {
		ip := net.ParseIP(h)
		if ip != nil && isLocalInterfaceIP(ip) {
			return true
		}
	}
	return false
}

func isLocalInterfaceIP(target net.IP) bool {
	if target.IsLoopback() {
		return true
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		return false
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			switch v := addr.(type) {
			case *net.IPNet:
				if v.IP.Equal(target) {
					return true
				}
			case *net.IPAddr:
				if v.IP.Equal(target) {
					return true
				}
			}
		}
	}
	return false
}

func splitHostPortLoose(hostport string) (host, port string, err error) {
	if hostport == "" {
		return "", "", fmt.Errorf("empty Host header")
	}
	if strings.HasPrefix(hostport, "[") {
		if strings.Contains(hostport, "]:") {
			h, p, e := net.SplitHostPort(hostport)
			return strings.Trim(h, "[]"), p, e
		}
		return strings.Trim(hostport, "[]"), "", nil
	}
	if strings.Count(hostport, ":") == 1 {
		return net.SplitHostPort(hostport)
	}
	return hostport, "", nil
}

// checkHost guards both HTTP static serving and WebSocket upgrades against DNS rebinding.
func (a *relayAuth) checkHost(req *http.Request) error {
	h, p, err := splitHostPortLoose(req.Host)
	if err != nil {
		return fmt.Errorf("malformed Host %q: %w", req.Host, err)
	}
	if !a.isHostAllowed(h) {
		return fmt.Errorf("disallowed Host %q", req.Host)
	}
	if a.port > 0 && p != "" && p != strconv.Itoa(a.port) {
		return fmt.Errorf("Host %q port does not match relay port %d", req.Host, a.port)
	}
	return nil
}

// checkOrigin enforces the Origin allowlist whenever an Origin header is sent.
// Browsers attach Origin unconditionally on WebSocket upgrades (including "null"
// for opaque/sandboxed origins); non-browser CLI/adapters omit Origin and still
// authenticate with the per-start capability token.
func (a *relayAuth) checkOrigin(req *http.Request) error {
	origins, present := req.Header["Origin"]
	if !present {
		return nil
	}
	if len(origins) != 1 {
		return fmt.Errorf("expected 1 Origin header, got %d", len(origins))
	}
	canon, err := canonicalOrigin(origins[0])
	if err != nil {
		return err
	}
	if defaultViteOrigins[canon] || a.explicitOrigins[canon] {
		return nil
	}
	u, err := url.Parse(canon)
	if err != nil {
		return err
	}
	wantPort := ""
	if a.port > 0 {
		wantPort = strconv.Itoa(a.port)
	} else {
		_, reqPort, _ := splitHostPortLoose(req.Host)
		wantPort = reqPort
	}
	if a.isHostAllowed(u.Hostname()) && u.Port() == wantPort {
		return nil
	}
	return fmt.Errorf("origin %q is not allowed", origins[0])
}

func (a *relayAuth) checkOriginBool(req *http.Request) bool {
	return a.checkOrigin(req) == nil
}

// extractUpgradeToken inspects Authorization: Bearer <tok> and Sec-WebSocket-Protocol
// (`glyph3d, g3d-token.<tok>`). Query-string tokens are never accepted.
func extractUpgradeToken(req *http.Request) (token string, offeredGlyph3d bool) {
	for _, sub := range websocket.Subprotocols(req) {
		if sub == wsBaseSubprotocol {
			offeredGlyph3d = true
		} else if tok, ok := strings.CutPrefix(sub, wsTokenSubprotocolPrefix); ok && token == "" {
			token = strings.TrimSpace(tok)
		}
	}
	if auth := strings.TrimSpace(req.Header.Get("Authorization")); auth != "" {
		if len(auth) > 7 && strings.EqualFold(auth[:7], "Bearer ") {
			if bearer := strings.TrimSpace(auth[7:]); bearer != "" {
				token = bearer
			}
		}
	}
	return token, offeredGlyph3d
}

// verifyUpgrade validates query-string safety, Host, Origin, and capability token
// before upgrading to WebSocket. Never logs presented token values.
func (a *relayAuth) verifyUpgrade(w http.ResponseWriter, req *http.Request) (http.Header, bool) {
	if req.URL != nil && req.URL.Query().Has("token") {
		log.Printf("[relay] refused upgrade from %s: token in URL query string is forbidden", req.RemoteAddr)
		http.Error(w, "bad request: token in URL query string is forbidden", http.StatusBadRequest)
		return nil, false
	}
	if err := a.checkHost(req); err != nil {
		log.Printf("[relay] refused upgrade from %s: %v", req.RemoteAddr, err)
		http.Error(w, "forbidden: invalid host", http.StatusForbidden)
		return nil, false
	}
	if err := a.checkOrigin(req); err != nil {
		log.Printf("[relay] refused cross-origin upgrade from %s: %v", req.RemoteAddr, err)
		http.Error(w, "forbidden: origin not allowed", http.StatusForbidden)
		return nil, false
	}
	got, offeredGlyph3d := extractUpgradeToken(req)
	if len(got) != len(a.token) || subtle.ConstantTimeCompare([]byte(got), []byte(a.token)) != 1 {
		log.Printf("[relay] refused unauthenticated upgrade from %s", req.RemoteAddr)
		http.Error(w, "unauthorized: missing or invalid relay token", http.StatusUnauthorized)
		return nil, false
	}
	var respHdr http.Header
	if offeredGlyph3d {
		respHdr = http.Header{"Sec-WebSocket-Protocol": []string{wsBaseSubprotocol}}
	}
	return respHdr, true
}

func isCharDeviceFile(f *os.File) bool {
	if f == nil {
		return false
	}
	fi, err := f.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

// formatBrowserTokenURL returns baseURL with `#token=<tok>` set in its fragment (never query).
func formatBrowserTokenURL(baseURL, tok string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return "", err
	}
	if u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("invalid URL %q (want http://host:port/...)", baseURL)
	}
	q := u.Query()
	q.Del("token")
	u.RawQuery = q.Encode()
	frag, _ := url.ParseQuery(u.Fragment)
	frag.Set("token", tok)
	u.Fragment = frag.Encode()
	return u.String(), nil
}

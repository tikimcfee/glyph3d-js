package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
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

var errWindowsUnsupported = errors.New("glyph3d-cli relay is unsupported on Windows: secure 0700/0600 runtime directories and Unix sockets require Linux or macOS")

var (
	tailscaleV4Prefix = netip.MustParsePrefix("100.64.0.0/10")
	tailscaleV6Prefix = netip.MustParsePrefix("fd7a:115c:a1e0::/48")

	// localInterfaceIPCheck reports whether target is assigned to an up local network interface.
	// Swappable in unit tests to exercise Tailscale listen rules deterministically.
	localInterfaceIPCheck = isLocalInterfaceIP
)

// defaultViteOrigins are the loopback dev-server origins for the IDE (:5173) and the wall (:5180).
// Consulted only when the relay itself listens on loopback.
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

func relayTokenFileName(port int) string {
	return fmt.Sprintf("relay-%d.token", port)
}

func relayTokenPath(port int) string {
	return filepath.Join(relayTokenDir(), relayTokenFileName(port))
}

// writeRelayTokenFile atomically writes token (mode 0600) into the uid-verified 0700
// runtime directory and returns the path plus an idempotent cleanup that unlinks the
// file only if it is still the exact (dev, ino) this server wrote.
func writeRelayTokenFile(port int, token string) (string, func(), error) {
	if port <= 0 {
		return "", nil, fmt.Errorf("invalid relay port %d", port)
	}
	dir := relayTokenDir()
	return writeRelayTokenFileInDir(dir, port, token)
}

// readRelayToken reads the token for localhost:port (or returns $G3D_RELAY_TOKEN if set).
func readRelayToken(port int) (string, error) {
	return readRelayTokenWithPortPref(port, false)
}

// readRelayTokenWithPortPref resolves the relay token for port. When preferPortFile is true
// (an explicit `--port N` flag on the CLI), the 0600 file published by the local relay on
// that port wins over an exported $G3D_RELAY_TOKEN from another relay, falling back to
// $G3D_RELAY_TOKEN only when relay-<port>.token does not exist.
func readRelayTokenWithPortPref(port int, preferPortFile bool) (string, error) {
	if preferPortFile {
		tok, err := readRelayTokenFile(port)
		if err == nil {
			return tok, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	}
	if envTok := strings.TrimSpace(os.Getenv("G3D_RELAY_TOKEN")); envTok != "" {
		return parseRelayTokenValue(envTok)
	}
	if preferPortFile {
		// Re-return the underlying ErrNotExist from readRelayTokenFile.
		return readRelayTokenFile(port)
	}
	return readRelayTokenFile(port)
}

// readRelayTokenFile reads relay-<port>.token from the owner-checked runtime dir, ignoring
// $G3D_RELAY_TOKEN: the file is what the relay on that port published.
func readRelayTokenFile(port int) (string, error) {
	if port <= 0 {
		return "", fmt.Errorf("invalid relay port %d", port)
	}
	dir := relayTokenDir()
	return readRelayTokenFileInDir(dir, port)
}

func isTokenParamKey(key string) bool {
	if strings.EqualFold(strings.TrimSpace(key), "token") {
		return true
	}
	if unescaped, err := url.QueryUnescape(key); err == nil {
		if strings.EqualFold(strings.TrimSpace(unescaped), "token") {
			return true
		}
	}
	return false
}

// hasQueryToken reports whether rawQuery carries a `token` parameter in any case,
// splitting on both `&` and `;` and inspecting both raw and URL-unescaped keys.
func hasQueryToken(rawQuery string) bool {
	if rawQuery == "" {
		return false
	}
	for _, seg := range strings.FieldsFunc(rawQuery, func(r rune) bool { return r == '&' || r == ';' }) {
		key, _, _ := strings.Cut(seg, "=")
		if isTokenParamKey(key) {
			return true
		}
	}
	return false
}

func stripQueryTokens(rawQuery string) string {
	if rawQuery == "" {
		return ""
	}
	var kept []string
	for _, seg := range strings.FieldsFunc(rawQuery, func(r rune) bool { return r == '&' || r == ';' }) {
		key, _, _ := strings.Cut(seg, "=")
		if !isTokenParamKey(key) {
			kept = append(kept, seg)
		}
	}
	return strings.Join(kept, "&")
}

// redactURLFragment strips any `#...` fragment (and redacts any accidental `?token=` query)
// before a URL is formatted into stderr or error messages.
func redactURLFragment(raw string) string {
	if i := strings.IndexByte(raw, '#'); i >= 0 {
		raw = raw[:i]
	}
	return reSecretURLParam.ReplaceAllString(raw, "${1}[REDACTED]")
}

func sanitizeURLError(err error) error {
	if err == nil {
		return nil
	}
	var uerr *url.Error
	if errors.As(err, &uerr) {
		clean := *uerr
		clean.URL = redactURLFragment(clean.URL)
		return &clean
	}
	return err
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
			return "", fmt.Errorf("invalid token URL: %w", sanitizeURLError(err))
		}
		if hasQueryToken(u.RawQuery) {
			return "", fmt.Errorf("relay token must not be passed in URL query string; use #token= fragment")
		}
		vals, err := url.ParseQuery(u.Fragment)
		if err != nil {
			return "", fmt.Errorf("invalid URL fragment: %w", err)
		}
		var tok string
		for k, vs := range vals {
			if strings.EqualFold(strings.TrimSpace(k), "token") && len(vs) > 0 {
				tok = strings.TrimSpace(vs[0])
				break
			}
		}
		if tok == "" {
			return "", fmt.Errorf("URL carries no #token= fragment")
		}
		return tok, nil
	}
	if strings.HasPrefix(s, "#") {
		vals, err := url.ParseQuery(strings.TrimPrefix(s, "#"))
		if err == nil {
			for k, vs := range vals {
				if strings.EqualFold(strings.TrimSpace(k), "token") && len(vs) > 0 {
					if tok := strings.TrimSpace(vs[0]); tok != "" {
						return tok, nil
					}
				}
			}
		}
	}
	return s, nil
}

// relayAuth enforces Host, Origin, and capability-token checks on the relay. It is built once,
// before the relay, and completed by bind once the listener owns its port.
type relayAuth struct {
	token           string
	listenHost      string // normalized listen host ("127.0.0.1", "0.0.0.0", "::", or specific IP/host)
	port            int    // set by bind; 0 in in-process httptest servers (any port on allowed host)
	keepToken       bool   // serve --keep-token: reuse this port's token across starts
	hasTLS          bool   // true when --tls-cert and --tls-key are configured
	allowAllIfaces  bool   // true when listenHost is 0.0.0.0 or ::
	allowedHosts    map[string]bool
	explicitOrigins map[string]bool
	// explicitHosts are the host:port pairs of the --origin list. An origin the operator names is
	// an address a browser reaches this relay by (an ssh -L or docker -p remap, a TLS hostname), so
	// its Host passes as is: the one blessed way past the hostname and port checks.
	explicitHosts map[string]bool
}

// normalizeListenHost strips spaces and outer IPv6 brackets (`[::1]` → `::1`), defaulting empty
// or `[]` inputs to defaultServeListen ("127.0.0.1") so wildcard binds never happen by accident.
// Non-IPv6 bracketed strings such as `[localhost]` keep their brackets and fail validation.
func normalizeListenHost(listenHost string) string {
	s := strings.ToLower(strings.TrimSpace(listenHost))
	if s == "" || s == "[]" {
		return defaultServeListen
	}
	if strings.HasPrefix(s, "[") && strings.HasSuffix(s, "]") {
		inner := s[1 : len(s)-1]
		if strings.TrimSpace(inner) == "" {
			return defaultServeListen
		}
		if strings.Contains(inner, ":") && !strings.ContainsAny(inner, "[]") {
			return inner
		}
	}
	return s
}

// isLoopbackListenHost reports whether host is an explicit loopback host (`127.0.0.1`, `::1`,
// `[::1]`, or `localhost`). Empty strings return false — callers normalize first.
func isLoopbackListenHost(host string) bool {
	s := strings.ToLower(strings.TrimSpace(host))
	if s == "[::1]" {
		return true
	}
	return s == "127.0.0.1" || s == "localhost" || s == "::1"
}

func parseTailscaleHost(host string) (netip.Addr, bool) {
	addr, err := netip.ParseAddr(strings.TrimSpace(host))
	if err != nil || addr.Zone() != "" || addr.Is4In6() {
		return netip.Addr{}, false
	}
	if tailscaleV4Prefix.Contains(addr) || tailscaleV6Prefix.Contains(addr) {
		return addr, true
	}
	return netip.Addr{}, false
}

func isTailscaleHost(host string) bool {
	_, ok := parseTailscaleHost(host)
	return ok
}

func isLocalTailscaleHost(host string) bool {
	addr, ok := parseTailscaleHost(host)
	if !ok {
		return false
	}
	return localInterfaceIPCheck(net.IP(addr.AsSlice()))
}

func isLocalTailscaleIP(target net.IP) bool {
	if len(target) == 0 {
		return false
	}
	addr, ok := netip.AddrFromSlice(target)
	if !ok {
		return false
	}
	addr = addr.Unmap()
	if !tailscaleV4Prefix.Contains(addr) && !tailscaleV6Prefix.Contains(addr) {
		return false
	}
	return localInterfaceIPCheck(target)
}

func canonicalHostToken(host string) string {
	h := strings.ToLower(strings.TrimSpace(host))
	if addr, err := netip.ParseAddr(h); err == nil && addr.Zone() == "" && !addr.Is4In6() {
		return addr.String()
	}
	return h
}

func newRelayAuth(listenHost string, port int, extraOrigins []string, keepToken bool, tlsCert, tlsKey string) (*relayAuth, error) {
	if runtime.GOOS == "windows" {
		return nil, errWindowsUnsupported
	}
	tlsCert = strings.TrimSpace(tlsCert)
	tlsKey = strings.TrimSpace(tlsKey)
	if (tlsCert == "") != (tlsKey == "") {
		return nil, fmt.Errorf("both --tls-cert and --tls-key are required when enabling TLS")
	}
	hasTLS := tlsCert != "" && tlsKey != ""

	tok, err := generateRelayToken()
	if err != nil {
		return nil, err
	}
	cleanListen := normalizeListenHost(listenHost)
	if keepToken && !isLoopbackListenHost(cleanListen) {
		return nil, fmt.Errorf("--keep-token keeps one token alive across restarts: it is for a loopback relay, not --listen %s", listenHost)
	}
	if !hasTLS && !isLoopbackListenHost(cleanListen) && !isLocalTailscaleHost(cleanListen) {
		return nil, fmt.Errorf("refusing plaintext --listen %s: non-loopback addresses require --tls-cert and --tls-key (or an active local Tailscale IP in 100.64.0.0/10 or fd7a:115c:a1e0::/48)", cleanListen)
	}

	hosts := map[string]bool{
		"localhost": true,
		"127.0.0.1": true,
		"::1":       true,
	}
	allowAllIfaces := cleanListen == "0.0.0.0" || cleanListen == "::"
	if !allowAllIfaces {
		hosts[canonicalHostToken(cleanListen)] = true
	}
	explicit := make(map[string]bool, len(extraOrigins))
	explicitHosts := make(map[string]bool, len(extraOrigins))
	for _, raw := range extraOrigins {
		canon, err := canonicalOrigin(raw)
		if err != nil {
			return nil, fmt.Errorf("--origin %q: %w", raw, err)
		}
		explicit[canon] = true
		u, err := url.Parse(canon)
		if err != nil {
			return nil, fmt.Errorf("--origin %q: %w", raw, err)
		}
		p := u.Port()
		if p == "" {
			p = map[string]string{"http": "80", "https": "443"}[u.Scheme]
		}
		explicitHosts[hostPortKey(u.Hostname(), p)] = true
	}
	return &relayAuth{
		token:           tok,
		listenHost:      cleanListen,
		port:            port,
		keepToken:       keepToken,
		hasTLS:          hasTLS,
		allowAllIfaces:  allowAllIfaces,
		allowedHosts:    hosts,
		explicitOrigins: explicit,
		explicitHosts:   explicitHosts,
	}, nil
}

func hostPortKey(host, port string) string {
	return canonicalHostToken(strings.Trim(host, "[]")) + "|" + port
}

func (a *relayAuth) Token() string {
	return a.token
}

// bind completes the auth once the listener owns port: it records the port the Host and Origin
// checks compare against and publishes the token file. With keepToken, a valid token a previous
// start on this port left (owner-checked, 64 hex) is adopted instead of this start's fresh one, and
// the file stays on exit, so an open page reconnects across a restart without a new #token=. It runs
// before Serve: nothing reads the auth concurrently yet.
func (a *relayAuth) bind(port int) (path string, cleanup func(), err error) {
	a.port = port
	if a.keepToken {
		prev, err := readRelayTokenFile(port)
		switch {
		case err == nil && isRelayTokenShape(prev):
			a.token = prev
		case err == nil:
			log.Printf("[relay] --keep-token: relay-%d.token holds no relay token; minted a fresh one", port)
		case !errors.Is(err, os.ErrNotExist):
			log.Printf("[relay] --keep-token: not reusing relay-%d.token (%v); minted a fresh one", port, err)
		}
	}
	path, cleanup, err = writeRelayTokenFile(port, a.token)
	if err != nil {
		return "", nil, err
	}
	if a.keepToken {
		cleanup = func() {}
	}
	return path, cleanup, nil
}

// adapterEnv is the environment of an `attach` adapter the relay forks: the relay's own, with
// G3D_RELAY_TOKEN set to the token this relay checks. The client prefers that variable over the
// token file, so an inherited one (exported for an earlier relay) would otherwise win and be refused.
func adapterEnv(base []string, token string) []string {
	env := make([]string, 0, len(base)+1)
	for _, kv := range base {
		if !strings.HasPrefix(kv, "G3D_RELAY_TOKEN=") {
			env = append(env, kv)
		}
	}
	return append(env, "G3D_RELAY_TOKEN="+token)
}

// isRelayTokenShape reports whether tok looks like a token generateRelayToken minted.
func isRelayTokenShape(tok string) bool {
	if len(tok) != 2*relayTokenBytes {
		return false
	}
	_, err := hex.DecodeString(tok)
	return err == nil
}

func parseStrictPort(portStr string) (int, error) {
	if len(portStr) == 0 || len(portStr) > 5 || portStr[0] == '0' {
		return 0, fmt.Errorf("invalid port %q", portStr)
	}
	for i := 0; i < len(portStr); i++ {
		if portStr[i] < '0' || portStr[i] > '9' {
			return 0, fmt.Errorf("invalid non-numeric port %q", portStr)
		}
	}
	n, err := strconv.Atoi(portStr)
	if err != nil || n < 1 || n > 65535 {
		return 0, fmt.Errorf("port %q out of range 1..65535", portStr)
	}
	return n, nil
}

func isValidUnbracketedHost(h string) bool {
	if h == "" {
		return false
	}
	for i := 0; i < len(h); i++ {
		c := h[i]
		if c <= 0x20 || c >= 0x7f || c == '[' || c == ']' || c == '/' || c == '\\' || c == '@' || c == '%' || c == '?' || c == '#' {
			return false
		}
	}
	return true
}

// splitHostPortStrict parses an HTTP Host / RFC 3986 authority host[:port] without loose bracket
// trimming or trailing-colon leniency.
func splitHostPortStrict(hostport string) (host, port string, err error) {
	if hostport == "" {
		return "", "", fmt.Errorf("empty Host")
	}
	if strings.HasPrefix(hostport, "[") {
		closeIdx := strings.IndexByte(hostport, ']')
		if closeIdx < 0 {
			return "", "", fmt.Errorf("unclosed '[' in Host %q", hostport)
		}
		inner := hostport[1:closeIdx]
		addr, err := netip.ParseAddr(inner)
		if err != nil || !addr.Is6() || addr.Zone() != "" {
			return "", "", fmt.Errorf("invalid bracketed IPv6 literal in Host %q", hostport)
		}
		rest := hostport[closeIdx+1:]
		canonV6 := strings.ToLower(addr.String())
		if addr.Is4In6() {
			canonV6 = strings.ToLower(inner)
		}
		if rest == "" {
			return canonV6, "", nil
		}
		if !strings.HasPrefix(rest, ":") {
			return "", "", fmt.Errorf("unexpected suffix after ']' in Host %q", hostport)
		}
		p := rest[1:]
		if _, err := parseStrictPort(p); err != nil {
			return "", "", err
		}
		return canonV6, p, nil
	}
	if strings.ContainsAny(hostport, "[]") {
		return "", "", fmt.Errorf("unexpected bracket in Host %q", hostport)
	}
	colons := strings.Count(hostport, ":")
	if colons > 1 {
		return "", "", fmt.Errorf("unbracketed IPv6 or multiple colons in Host %q", hostport)
	}
	if colons == 1 {
		h, p, _ := strings.Cut(hostport, ":")
		if !isValidUnbracketedHost(h) {
			return "", "", fmt.Errorf("invalid host in %q", hostport)
		}
		if _, err := parseStrictPort(p); err != nil {
			return "", "", err
		}
		return strings.ToLower(h), p, nil
	}
	if !isValidUnbracketedHost(hostport) {
		return "", "", fmt.Errorf("invalid host %q", hostport)
	}
	return strings.ToLower(hostport), "", nil
}

func canonicalOrigin(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" || strings.EqualFold(s, "null") {
		return "", fmt.Errorf("origin is %q", raw)
	}
	if strings.Contains(s, "%") {
		return "", fmt.Errorf("percent-encoding / IPv6 zone ID is not allowed in origin %q", raw)
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", sanitizeURLError(err)
	}
	if strings.Contains(u.Host, "%") {
		return "", fmt.Errorf("IPv6 zone ID is not allowed in origin %q", raw)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", fmt.Errorf("unsupported scheme %q (want http or https)", u.Scheme)
	}
	if u.Opaque != "" || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("origin must be scheme://host[:port] with no path, query, or fragment")
	}
	h, p, err := splitHostPortStrict(u.Host)
	if err != nil {
		return "", fmt.Errorf("invalid origin host %q: %w", u.Host, err)
	}
	if scheme == "http" && !isLoopbackListenHost(h) && !isTailscaleHost(h) {
		return "", fmt.Errorf("plaintext http:// origin %q is refused for non-loopback/non-Tailscale host %q; use https://", raw, h)
	}
	if (scheme == "http" && p == "80") || (scheme == "https" && p == "443") {
		p = ""
	}
	hostPart := h
	if strings.Contains(h, ":") {
		if p != "" {
			hostPart = "[" + h + "]:" + p
		} else {
			hostPart = "[" + h + "]"
		}
	} else if p != "" {
		hostPart = h + ":" + p
	}
	return scheme + "://" + hostPart, nil
}

func (a *relayAuth) isHostAllowed(host string) bool {
	h := canonicalHostToken(host)
	if a.allowedHosts[h] {
		return true
	}
	if a.allowAllIfaces {
		ip := net.ParseIP(h)
		if ip != nil && localInterfaceIPCheck(ip) {
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

// checkHost guards both HTTP static serving and WebSocket upgrades against DNS rebinding.
func (a *relayAuth) checkHost(req *http.Request) error {
	h, p, err := splitHostPortStrict(req.Host)
	if err != nil {
		return fmt.Errorf("malformed Host %q: %w", req.Host, err)
	}
	if p == "" {
		if a.explicitHosts[hostPortKey(h, "80")] || a.explicitHosts[hostPortKey(h, "443")] {
			return nil
		}
	} else if a.explicitHosts[hostPortKey(h, p)] {
		return nil
	}
	if !a.isHostAllowed(h) {
		return fmt.Errorf("disallowed Host %q", req.Host)
	}
	effPort := p
	if effPort == "" {
		if req.TLS != nil || a.hasTLS {
			effPort = "443"
		} else {
			effPort = "80"
		}
	}
	if a.port > 0 && effPort != strconv.Itoa(a.port) {
		return fmt.Errorf("Host %q port (%s) does not match relay port %d", req.Host, effPort, a.port)
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
	if (isLoopbackListenHost(a.listenHost) && defaultViteOrigins[canon]) || a.explicitOrigins[canon] {
		return nil
	}
	u, err := url.Parse(canon)
	if err != nil {
		return err
	}
	origPort := u.Port()
	if origPort == "" {
		if u.Scheme == "https" {
			origPort = "443"
		} else {
			origPort = "80"
		}
	}
	wantScheme := "http"
	if req.TLS != nil || a.hasTLS {
		wantScheme = "https"
	}
	wantPort := ""
	if a.port > 0 {
		wantPort = strconv.Itoa(a.port)
	} else {
		_, reqPort, err := splitHostPortStrict(req.Host)
		if err != nil {
			return err
		}
		wantPort = reqPort
		if wantPort == "" {
			if wantScheme == "https" {
				wantPort = "443"
			} else {
				wantPort = "80"
			}
		}
	}
	if u.Scheme == wantScheme && a.isHostAllowed(u.Hostname()) && origPort == wantPort {
		return nil
	}
	return fmt.Errorf("origin %q is not allowed", origins[0])
}

// extractUpgradeToken inspects Authorization: Bearer <tok> and Sec-WebSocket-Protocol
// (`glyph3d, g3d-token.<tok>`). Query-string tokens are never accepted, and ambiguous
// or malformed headers fail closed.
func extractUpgradeToken(req *http.Request) (token string, offeredGlyph3d bool) {
	authVals := req.Header.Values("Authorization")
	if len(authVals) > 1 {
		return "", false
	}
	var bearerTok string
	if len(authVals) == 1 {
		auth := strings.TrimSpace(authVals[0])
		if len(auth) <= 7 || !strings.EqualFold(auth[:7], "Bearer ") {
			return "", false
		}
		bearerTok = strings.TrimSpace(auth[7:])
		if bearerTok == "" || strings.ContainsAny(bearerTok, " \t,") {
			return "", false
		}
	}

	var subTok string
	hasSubTok := false
	for _, sub := range websocket.Subprotocols(req) {
		if sub == wsBaseSubprotocol {
			offeredGlyph3d = true
		} else if tok, ok := strings.CutPrefix(sub, wsTokenSubprotocolPrefix); ok {
			tok = strings.TrimSpace(tok)
			if tok == "" || hasSubTok {
				return "", false
			}
			subTok = tok
			hasSubTok = true
		}
	}

	if bearerTok != "" && hasSubTok {
		if len(bearerTok) != len(subTok) || subtle.ConstantTimeCompare([]byte(bearerTok), []byte(subTok)) != 1 {
			return "", false
		}
		return bearerTok, offeredGlyph3d
	}
	if bearerTok != "" {
		return bearerTok, offeredGlyph3d
	}
	if hasSubTok {
		return subTok, offeredGlyph3d
	}
	return "", offeredGlyph3d
}

// verifyUpgrade validates query-string safety, Host, Origin, and capability token
// before upgrading to WebSocket. Never logs presented token values.
func (a *relayAuth) verifyUpgrade(w http.ResponseWriter, req *http.Request) (http.Header, bool) {
	if req.URL != nil && hasQueryToken(req.URL.RawQuery) {
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

// formatBrowserTokenURL returns baseURL with `#token=<tok>` set in its fragment (never query).
func formatBrowserTokenURL(baseURL, tok string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return "", sanitizeURLError(err)
	}
	if u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("invalid URL %q (want http://host:port/...)", redactURLFragment(baseURL))
	}
	u.RawQuery = stripQueryTokens(u.RawQuery)
	frag, _ := url.ParseQuery(u.Fragment)
	for k := range frag {
		if strings.EqualFold(strings.TrimSpace(k), "token") {
			frag.Del(k)
		}
	}
	frag.Set("token", tok)
	u.Fragment = frag.Encode()
	return u.String(), nil
}

var (
	reSecretURLParam = regexp.MustCompile(`(?i)([#?&;]token=)[^\s"'\\&#;,)\]}]*`)
	reSecretSubproto = regexp.MustCompile(`(?i)(g3d-token\.)[^\s"'\\,)\];}]*`)
	reSecretBearer   = regexp.MustCompile(`(?i)(\bBearer\s+)[^\s"'\\,)\];}]+`)
	reSecretTokenCmd = regexp.MustCompile(`(?i)(\b(?:relay|wall)\.token\s+)[^\s"'\\,)\];}]+`)
)

func scrubLogSecrets(s, liveTok string) string {
	if s == "" {
		return s
	}
	if liveTok != "" && strings.Contains(s, liveTok) {
		s = strings.ReplaceAll(s, liveTok, "[REDACTED]")
	}
	s = reSecretURLParam.ReplaceAllString(s, "${1}[REDACTED]")
	s = reSecretSubproto.ReplaceAllString(s, "${1}[REDACTED]")
	s = reSecretBearer.ReplaceAllString(s, "${1}[REDACTED]")
	s = reSecretTokenCmd.ReplaceAllString(s, "${1}[REDACTED]")
	return s
}

func scrubBrowserLogRec(rec *LogRec, liveTok string) {
	if rec == nil {
		return
	}
	origCmd := strings.TrimSpace(rec.Msg)
	rec.Msg = scrubLogSecrets(rec.Msg, liveTok)
	if len(rec.Attrs) == 0 || string(rec.Attrs) == "null" {
		return
	}
	// Redact command-bus `args` payloads for token-bearing commands even when the
	// presented token belongs to another relay port (not equal to liveTok).
	if strings.EqualFold(origCmd, "relay.token") || strings.EqualFold(origCmd, "wall.token") || strings.EqualFold(origCmd, "relay.connect") {
		var m map[string]any
		if json.Unmarshal(rec.Attrs, &m) == nil {
			if args, ok := m["args"].([]any); ok && len(args) > 0 {
				start := 0
				if strings.EqualFold(origCmd, "relay.connect") {
					start = 1
				}
				for i := start; i < len(args); i++ {
					args[i] = "[REDACTED]"
				}
				if b, err := json.Marshal(m); err == nil {
					rec.Attrs = json.RawMessage(b)
				}
			}
		}
	}
	rec.Attrs = json.RawMessage(scrubLogSecrets(string(rec.Attrs), liveTok))
}

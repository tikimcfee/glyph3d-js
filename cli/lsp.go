package main

// LSPSupervisor hosts language-server child processes and exposes a small,
// browser-friendly RPC surface (lsp/definition, lsp/references, lsp/status,
// lsp/shutdown) over the existing relay JSON-RPC transport. It owns the LSP
// *client* lifecycle — handshake, document sync, request correlation — by
// delegating the protocol mechanics to go.lsp.dev/protocol + jsonrpc2; the only
// logic here is the app glue no library can own: which file → which server, the
// call sequence, doc-sync bookkeeping, readiness retry, and capability gating.
//
// Positions on the wire are already LSP-encoded (UTF-16 by default): the browser
// converts codepoint↔UTF-16 before sending, so this layer passes line/character
// straight through.

import (
	"context"
	"encoding/json"
	"hash/fnv"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"go.lsp.dev/jsonrpc2"
	"go.lsp.dev/protocol"
	"go.lsp.dev/uri"
)

// LSP-layer JSON-RPC error codes (continue the fs.go space).
const (
	errLSPNotInstalled = -32010 // language server binary not on PATH
	errLSPNoLanguage   = -32011 // no server configured for this file extension
	errLSPInternal     = -32012 // server/protocol failure

	lspRPCTimeout   = 30 * time.Second       // generous: covers cold-start indexing
	lspInitTimeout  = 25 * time.Second       // initialize handshake budget
	lspReadyRetries = 20                      // empty-result retries while indexing
	lspReadyBackoff = 350 * time.Millisecond // gap between readiness retries
)

// langInfo maps a file extension to the server that handles it (the pool key)
// and the LSP languageId to declare on didOpen.
type langInfo struct {
	server     string
	languageID protocol.LanguageKind
}

// serverDef is how to launch a given server (the pool-key → command mapping).
type serverDef struct {
	command string
	args    []string
}

// v1 registry: TypeScript/JavaScript via typescript-language-server. One server
// process (key "tsls") serves all of ts/tsx/js/jsx. gopls etc. are one entry away.
var extLang = map[string]langInfo{
	".ts":  {"tsls", "typescript"},
	".tsx": {"tsls", "typescriptreact"},
	".mts": {"tsls", "typescript"},
	".cts": {"tsls", "typescript"},
	".js":  {"tsls", "javascript"},
	".jsx": {"tsls", "javascriptreact"},
	".mjs": {"tsls", "javascript"},
	".cjs": {"tsls", "javascript"},
}

var serverDefs = map[string]serverDef{
	"tsls": {"typescript-language-server", []string{"--stdio"}},
}

func installHint(command string) string {
	switch command {
	case "typescript-language-server":
		return "bun add -g typescript-language-server typescript"
	case "gopls":
		return "go install golang.org/x/tools/gopls@latest"
	}
	return ""
}

// ---- wire shapes (relay ↔ browser) ----

// lspQuery is the params for a position query. Text is the browser's live grid
// buffer (authoritative — the server answers against its in-memory doc, not
// disk); when absent (CLI / test path) the supervisor reads the file from disk.
type lspQuery struct {
	URI       string  `json:"uri"`
	Line      uint32  `json:"line"`
	Character uint32  `json:"character"`
	Text      *string `json:"text,omitempty"`
}

type lspPos struct {
	Line      uint32 `json:"line"`
	Character uint32 `json:"character"`
}
type lspRange struct {
	Start lspPos `json:"start"`
	End   lspPos `json:"end"`
}
type lspLoc struct {
	URI     string   `json:"uri"`
	Range   lspRange `json:"range"`
	Preview string   `json:"preview,omitempty"` // trimmed source line at the location, for legible chips
}

// lspError carries a JSON-RPC error back through dispatch.
type lspError struct {
	code int
	msg  string
	data any
}

// lspUnavailable signals the server binary isn't installed (→ errLSPNotInstalled
// with an install hint, instead of an opaque spawn failure).
type lspUnavailable struct{ command string }

func (e *lspUnavailable) Error() string { return "language server not on PATH: " + e.command }

// ---- supervisor ----

type LSPSupervisor struct {
	fs     *FSHandler // workspace root + resolvePath reuse
	root   string     // = fs.root, the LSP rootUri
	notify func(method string, params any)

	mu      sync.Mutex
	servers map[string]*lspServer // keyed by pool key (serverDefs key)
}

func NewLSPSupervisor(fs *FSHandler) *LSPSupervisor {
	return &LSPSupervisor{fs: fs, root: fs.root, servers: map[string]*lspServer{}}
}

// SetNotifyHook wires server-initiated pushes (diagnostics) to the display.
func (s *LSPSupervisor) SetNotifyHook(fn func(method string, params any)) { s.notify = fn }

func (s *LSPSupervisor) getServer(key string) *lspServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	srv := s.servers[key]
	if srv == nil {
		srv = &lspServer{key: key, def: serverDefs[key], sup: s, open: map[string]*docState{}}
		s.servers[key] = srv
	}
	return srv
}

// Handle is the relay dispatch entry. Mirrors FSHandler.Handle: run in a
// goroutine with a timeout so it never blocks the WebSocket read loop.
func (s *LSPSupervisor) Handle(method string, id json.RawMessage, params json.RawMessage, write writeFn) {
	go func() {
		done := make(chan struct{})
		go func() {
			defer close(done)
			s.dispatch(method, id, params, write)
		}()
		select {
		case <-done:
		case <-time.After(lspRPCTimeout):
			s.fs.sendRPCError(write, id, -32000, "lsp request timed out", nil)
		}
	}()
}

func (s *LSPSupervisor) dispatch(method string, id, params json.RawMessage, write writeFn) {
	ctx, cancel := context.WithTimeout(context.Background(), lspRPCTimeout)
	defer cancel()
	switch method {
	case "lsp/definition":
		s.locQuery(ctx, id, params, write, s.definition)
	case "lsp/references":
		s.locQuery(ctx, id, params, write, s.references)
	case "lsp/status":
		s.fs.sendRPCResult(write, id, s.status())
	case "lsp/shutdown":
		s.fs.sendRPCResult(write, id, s.shutdownAll())
	default:
		s.fs.sendRPCError(write, id, -32601, "method not found: "+method, nil)
	}
}

// locQuery unmarshals a position query, runs fn, and writes locations/errors.
func (s *LSPSupervisor) locQuery(ctx context.Context, id, params json.RawMessage, write writeFn,
	fn func(context.Context, lspQuery) ([]lspLoc, *lspError)) {
	var q lspQuery
	if err := json.Unmarshal(params, &q); err != nil {
		s.fs.sendRPCError(write, id, -32602, "invalid params", nil)
		return
	}
	locs, lerr := fn(ctx, q)
	if lerr != nil {
		s.fs.sendRPCError(write, id, lerr.code, lerr.msg, lerr.data)
		return
	}
	s.fs.sendRPCResult(write, id, map[string]any{"locations": locs})
}

// prep resolves the server, ensures it's started, syncs the document, and
// returns the handle + file URI + position for a query. The shared front half
// of every position request.
func (s *LSPSupervisor) prep(ctx context.Context, q lspQuery) (*lspServer, uri.URI, protocol.Position, *lspError) {
	ext := strings.ToLower(filepath.Ext(q.URI))
	info, ok := extLang[ext]
	if !ok {
		return nil, "", protocol.Position{}, &lspError{errLSPNoLanguage, "no language server configured for " + ext, nil}
	}
	abs, err := s.fs.resolvePath(q.URI)
	if err != nil {
		return nil, "", protocol.Position{}, &lspError{errPermissionDenied, err.Error(), map[string]string{"uri": q.URI}}
	}
	var text string
	if q.Text != nil {
		text = *q.Text
	} else {
		b, e := os.ReadFile(abs)
		if e != nil {
			return nil, "", protocol.Position{}, &lspError{errFileNotFound, "read error: " + e.Error(), map[string]string{"uri": q.URI}}
		}
		text = string(b)
	}

	srv := s.getServer(info.server)
	if err := srv.ensureStarted(); err != nil {
		if un, ok := err.(*lspUnavailable); ok {
			return nil, "", protocol.Position{}, &lspError{errLSPNotInstalled,
				"language server not installed: " + un.command,
				map[string]string{"command": un.command, "install": installHint(un.command)}}
		}
		return nil, "", protocol.Position{}, &lspError{errLSPInternal, err.Error(), nil}
	}

	fileURI := uri.File(abs)
	if err := srv.ensureDoc(ctx, fileURI, info.languageID, text); err != nil {
		return nil, "", protocol.Position{}, &lspError{errLSPInternal, "document sync: " + err.Error(), nil}
	}
	return srv, fileURI, protocol.Position{Line: q.Line, Character: q.Character}, nil
}

func (s *LSPSupervisor) definition(ctx context.Context, q lspQuery) ([]lspLoc, *lspError) {
	srv, fileURI, pos, lerr := s.prep(ctx, q)
	if lerr != nil {
		return nil, lerr
	}
	dp := &protocol.DefinitionParams{}
	dp.TextDocument = protocol.TextDocumentIdentifier{URI: fileURI}
	dp.Position = pos
	var locs []protocol.Location
	for i := 0; i < lspReadyRetries; i++ {
		r, err := srv.server.Definition(ctx, dp)
		if err != nil {
			return nil, &lspError{errLSPInternal, "definition: " + err.Error(), nil}
		}
		if locs = flattenDef(r); len(locs) > 0 {
			break
		}
		time.Sleep(lspReadyBackoff) // server still indexing → empty, not not-found
	}
	return s.toLspLocs(locs), nil
}

func (s *LSPSupervisor) references(ctx context.Context, q lspQuery) ([]lspLoc, *lspError) {
	srv, fileURI, pos, lerr := s.prep(ctx, q)
	if lerr != nil {
		return nil, lerr
	}
	rp := &protocol.ReferenceParams{}
	rp.TextDocument = protocol.TextDocumentIdentifier{URI: fileURI}
	rp.Position = pos
	rp.Context = protocol.ReferenceContext{IncludeDeclaration: true}
	var locs []protocol.Location
	for i := 0; i < lspReadyRetries; i++ {
		r, err := srv.server.References(ctx, rp)
		if err != nil {
			return nil, &lspError{errLSPInternal, "references: " + err.Error(), nil}
		}
		if len(r) > 0 {
			locs = r
			break
		}
		time.Sleep(lspReadyBackoff)
	}
	return s.toLspLocs(locs), nil
}

func (s *LSPSupervisor) status() map[string]any {
	s.mu.Lock()
	running := map[string]bool{}
	for k, v := range s.servers {
		v.mu.Lock()
		running[k] = v.server != nil
		v.mu.Unlock()
	}
	s.mu.Unlock()

	servers := make([]map[string]any, 0, len(serverDefs))
	for key, def := range serverDefs {
		_, err := exec.LookPath(def.command)
		servers = append(servers, map[string]any{
			"key":       key,
			"command":   def.command,
			"installed": err == nil,
			"running":   running[key],
		})
	}
	return map[string]any{"root": s.root, "servers": servers}
}

func (s *LSPSupervisor) shutdownAll() map[string]any {
	s.mu.Lock()
	srvs := make([]*lspServer, 0, len(s.servers))
	for _, v := range s.servers {
		srvs = append(srvs, v)
	}
	s.servers = map[string]*lspServer{}
	s.mu.Unlock()

	n := 0
	for _, srv := range srvs {
		if srv.stop() {
			n++
		}
	}
	return map[string]any{"stopped": n}
}

// ---- per-server process ----

type docState struct {
	version int32
	hash    uint64
}

type lspServer struct {
	key string
	def serverDef
	sup *LSPSupervisor

	mu     sync.Mutex
	cmd    *exec.Cmd
	conn   jsonrpc2.Conn
	server protocol.Server
	caps   protocol.ServerCapabilities
	open   map[string]*docState // uri → last-synced state
}

// ensureStarted lazily spawns the language server and runs the initialize
// handshake exactly once. Idempotent: returns nil if already running. Holds the
// per-server lock for the whole handshake so concurrent first requests serialize.
func (srv *lspServer) ensureStarted() error {
	srv.mu.Lock()
	defer srv.mu.Unlock()
	if srv.server != nil {
		return nil
	}
	bin, err := exec.LookPath(srv.def.command)
	if err != nil {
		return &lspUnavailable{command: srv.def.command}
	}

	cmd := exec.Command(bin, srv.def.args...)
	cmd.Dir = srv.sup.root
	cmd.Stderr = os.Stderr // server logs → relay stderr; stdout stays pure LSP frames
	setDeathSignal(cmd)    // unix: die with the relay so dev-loop restarts don't orphan us
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	stream := jsonrpc2.NewStream(&procStdio{in: in, out: out})
	_, conn, server := protocol.NewClient(context.Background(), &safeClient{sup: srv.sup}, stream)

	pid := int32(os.Getpid())
	ip := &protocol.InitializeParams{}
	ip.ProcessID = &pid
	rootURI := uri.File(srv.sup.root)
	ip.RootURI = &rootURI
	ictx, cancel := context.WithTimeout(context.Background(), lspInitTimeout)
	defer cancel()
	res, err := server.Initialize(ictx, ip)
	if err != nil {
		_ = cmd.Process.Kill()
		return err
	}
	if err := server.Initialized(context.Background(), &protocol.InitializedParams{}); err != nil {
		_ = cmd.Process.Kill()
		return err
	}

	srv.cmd = cmd
	srv.conn = conn
	srv.server = server
	srv.caps = res.Capabilities
	log.Printf("[lsp] started %s (pid %d) for %s", srv.def.command, cmd.Process.Pid, srv.sup.root)

	// Self-heal: when the process exits (crash or shutdown), reset so the next
	// request re-spawns from a clean slate.
	go func() {
		_ = cmd.Wait()
		srv.mu.Lock()
		if srv.cmd == cmd { // not already replaced by a newer start
			srv.server, srv.conn, srv.cmd = nil, nil, nil
			srv.open = map[string]*docState{}
		}
		srv.mu.Unlock()
		log.Printf("[lsp] %s (pid %d) exited", srv.def.command, cmd.Process.Pid)
	}()
	return nil
}

// ensureDoc opens or updates the document in the server's in-memory model.
// Versioning is derived from a content hash so it's monotonic and a no-op when
// the buffer is unchanged — works for both the browser-buffer and disk paths.
func (srv *lspServer) ensureDoc(ctx context.Context, fileURI uri.URI, lang protocol.LanguageKind, text string) error {
	srv.mu.Lock()
	defer srv.mu.Unlock()
	if srv.server == nil {
		return errLSPServerGone
	}
	k := string(fileURI)
	h := hash64(text)
	st := srv.open[k]
	if st == nil {
		srv.open[k] = &docState{version: 1, hash: h}
		return srv.server.DidOpen(ctx, &protocol.DidOpenTextDocumentParams{
			TextDocument: protocol.TextDocumentItem{URI: fileURI, LanguageID: lang, Version: 1, Text: text},
		})
	}
	if st.hash == h {
		return nil // unchanged → server's model is current
	}
	st.version++
	st.hash = h
	vid := protocol.VersionedTextDocumentIdentifier{Version: st.version}
	vid.URI = fileURI
	return srv.server.DidChange(ctx, &protocol.DidChangeTextDocumentParams{
		TextDocument:   vid,
		ContentChanges: []protocol.TextDocumentContentChangeEvent{&protocol.TextDocumentContentChangeWholeDocument{Text: text}},
	})
}

func (srv *lspServer) stop() bool {
	srv.mu.Lock()
	defer srv.mu.Unlock()
	if srv.server == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = srv.server.Shutdown(ctx)
	_ = srv.server.Exit(context.Background())
	if srv.cmd != nil && srv.cmd.Process != nil {
		_ = srv.cmd.Process.Kill()
	}
	srv.server, srv.conn = nil, nil
	return true
}

// ---- helpers ----

// procStdio adapts a child's separate stdin/stdout into one io.ReadWriteCloser
// for jsonrpc2.NewStream (LSP Content-Length framing).
type procStdio struct {
	in  interface{ Write([]byte) (int, error); Close() error }
	out interface{ Read([]byte) (int, error); Close() error }
}

func (s *procStdio) Read(p []byte) (int, error)  { return s.out.Read(p) }
func (s *procStdio) Write(p []byte) (int, error) { return s.in.Write(p) }
func (s *procStdio) Close() error                { _ = s.in.Close(); return s.out.Close() }

func flattenDef(r protocol.DefinitionResult) []protocol.Location {
	switch v := r.(type) {
	case *protocol.Location:
		if v == nil {
			return nil
		}
		return []protocol.Location{*v}
	case protocol.LocationSlice:
		return []protocol.Location(v)
	case protocol.DefinitionLinkSlice:
		out := make([]protocol.Location, 0, len(v))
		for _, l := range v {
			out = append(out, protocol.Location{URI: l.TargetURI, Range: l.TargetRange})
		}
		return out
	}
	return nil
}

func (s *LSPSupervisor) toLspLocs(locs []protocol.Location) []lspLoc {
	out := make([]lspLoc, 0, len(locs))
	cache := map[string][]string{} // abs path → lines, read once per file per result set
	for _, l := range locs {
		out = append(out, lspLoc{
			URI: s.ideURI(l.URI),
			Range: lspRange{
				Start: lspPos{l.Range.Start.Line, l.Range.Start.Character},
				End:   lspPos{l.Range.End.Line, l.Range.End.Character},
			},
			Preview: s.previewLine(string(l.URI), l.Range.Start.Line, cache),
		})
	}
	return out
}

// previewLine returns the trimmed source line at a location so a result reads as
// "file:line  <code>" instead of a bare coordinate. Files are read once per result
// set (cache) and resolved through the same sandbox as fs/*. Empty on any miss.
func (s *LSPSupervisor) previewLine(uriStr string, line uint32, cache map[string][]string) string {
	abs, err := s.fs.resolvePath(uriStr)
	if err != nil {
		return ""
	}
	lines, ok := cache[abs]
	if !ok {
		if b, e := os.ReadFile(abs); e == nil {
			lines = strings.Split(string(b), "\n")
		}
		cache[abs] = lines // cache the miss (nil) too, so a bad file isn't re-read
	}
	n := int(line)
	if n < 0 || n >= len(lines) {
		return ""
	}
	txt := strings.TrimSpace(lines[n])
	if r := []rune(txt); len(r) > 200 {
		txt = string(r[:200]) + "…"
	}
	return txt
}

// ideURI rewrites an absolute file:// URI from the language server into the
// repo-relative form the IDE addresses files by (file:///<rel>), so results
// match grid source paths. URIs outside the workspace root (rare — a dep
// resolving to an unreachable path) are left absolute for best-effort handling.
func (s *LSPSupervisor) ideURI(u uri.URI) string {
	p := strings.TrimPrefix(string(u), "file://")
	rel, err := filepath.Rel(s.root, p)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return string(u)
	}
	return "file:///" + filepath.ToSlash(rel)
}

func hash64(s string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(s))
	return h.Sum64()
}

// errLSPServerGone is returned if a doc op races a server exit.
var errLSPServerGone = &lspGoneError{}

type lspGoneError struct{}

func (*lspGoneError) Error() string { return "language server not running" }

// safeClient answers server→client requests with non-error defaults so the
// language server never blocks on us. protocol.UnimplementedClient returns
// errNotImplemented for everything, which would send error responses back — so
// we override the ones tsserver actually issues.
type safeClient struct {
	protocol.UnimplementedClient
	sup *LSPSupervisor
}

func (safeClient) Configuration(_ context.Context, p *protocol.ConfigurationParams) ([]protocol.LSPAny, error) {
	return make([]protocol.LSPAny, len(p.Items)), nil // one null per requested item
}
func (safeClient) WorkspaceFolders(context.Context) ([]protocol.WorkspaceFolder, error) { return nil, nil }
func (safeClient) RegisterCapability(context.Context, *protocol.RegistrationParams) error     { return nil }
func (safeClient) UnregisterCapability(context.Context, *protocol.UnregistrationParams) error { return nil }
func (safeClient) WorkDoneProgressCreate(context.Context, *protocol.WorkDoneProgressCreateParams) error {
	return nil
}
func (safeClient) ApplyEdit(context.Context, *protocol.ApplyWorkspaceEditParams) (*protocol.ApplyWorkspaceEditResult, error) {
	return &protocol.ApplyWorkspaceEditResult{Applied: false}, nil
}
func (safeClient) PublishDiagnostics(context.Context, *protocol.PublishDiagnosticsParams) error { return nil } // Phase 5: forward via notify
func (safeClient) LogMessage(context.Context, *protocol.LogMessageParams) error                 { return nil }
func (safeClient) ShowMessage(context.Context, *protocol.ShowMessageParams) error               { return nil }
func (safeClient) LogTrace(context.Context, *protocol.LogTraceParams) error                     { return nil }
func (safeClient) Telemetry(context.Context, protocol.LSPAny) error                             { return nil }
func (safeClient) Progress(context.Context, *protocol.ProgressParams) error                     { return nil }

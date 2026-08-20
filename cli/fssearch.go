package main

// Directory content search — the streaming half of the search subsystem.
//
// fs/search starts a walk and returns IMMEDIATELY ({id, started}); matches
// arrive as fs/searchMatch notifications on the display's existing socket and
// the run ends with exactly one fs/searchDone. fs/searchCancel kills a run by
// id. This is the same shape as the sensor plane: the RPC result is an
// acknowledgement, the data is a push stream.
//
// Why streaming rather than one big result: a real tree yields thousands of
// matches over seconds. A blocking RPC would hand the browser one late payload;
// a stream lets the page paint the first page of results while the walk is
// still running, and lets the operator cancel a bad query at once.
//
// Batching is the backpressure discipline. Matches flush per batchMs tick (or
// when a batch fills), so a query matching every line of every file costs tens
// of notifications per second, not tens of thousands. Unlike sensor frames,
// search matches are NOT perishable — they are dropped only by the explicit
// caps below, and every drop is reported in searchDone.Truncated.
//
// COORDINATES ARE GRID COORDINATES: line and col are 0-based, and col/length
// are counted in RUNES, not bytes — they are handed straight to
// CodeGrid.highlightRange on the browser side. Converting here (where the bytes
// are) is the only place the conversion can be done correctly.

import (
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Search caps. Each is a request-overridable default; every one of them, when
// hit, sets Truncated on searchDone rather than silently shortening the result
// (a silent cap reads as "that's all there is", which is a lie the operator
// would act on).
const (
	defaultSearchMaxMatches     = 5000            // total matches per run
	defaultSearchMaxFileMatches = 200             // matches from any one file
	defaultSearchMaxFileBytes   = 2 << 20         // skip files larger than this
	defaultSearchBatchMs        = 60              // flush cadence for match batches
	searchMaxBatch              = 256             // flush early once a batch fills
	searchLineTextCap           = 400             // per-match context line cap (runes)
	searchBinarySniff           = 8 << 10         // bytes examined for a NUL before deciding "binary"
)

type searchParams struct {
	ID             string `json:"id"`
	URI            string `json:"uri"`
	Query          string `json:"query"`
	Regex          bool   `json:"regex"`
	CaseSensitive  bool   `json:"caseSensitive"`
	WholeWord      bool   `json:"wholeWord"`
	MaxMatches     int    `json:"maxMatches"`
	MaxFileMatches int    `json:"maxFileMatches"`
	MaxFileBytes   int64  `json:"maxFileBytes"`
	BatchMs        int    `json:"batchMs"`
}

type searchCancelParams struct {
	ID string `json:"id"`
}

// searchMatch is one hit. Path is relative to the searched base (slash-form) so
// the browser can address it against the same base it asked for.
type searchMatch struct {
	Path   string `json:"path"`
	Line   int    `json:"line"`   // 0-based
	Col    int    `json:"col"`    // 0-based, in runes
	Length int    `json:"length"` // in runes
	Text   string `json:"text"`   // the matched line, rune-capped
}

type searchStartResult struct {
	ID      string `json:"id"`
	Base    string `json:"base"`
	Started bool   `json:"started"`
}

// buildSearchMatcher turns the request into ONE regexp — a literal query is
// quoted into a pattern rather than taking a separate bytes.Index path, so
// there is a single matching code path to reason about and whole-word/case
// behave identically for literal and regex queries.
func buildSearchMatcher(p searchParams) (*regexp.Regexp, error) {
	pat := p.Query
	if !p.Regex {
		pat = regexp.QuoteMeta(pat)
	}
	if p.WholeWord {
		pat = `\b(?:` + pat + `)\b`
	}
	if !p.CaseSensitive {
		pat = `(?i)` + pat
	}
	return regexp.Compile(pat)
}

// searchRun is one in-flight walk. gen is the ownership token: funcs aren't
// comparable in Go, so a run proves the registry entry is still ITS entry by
// generation, not by identity of the cancel func.
type searchRun struct {
	gen    uint64
	cancel context.CancelFunc
}

// registerSearch installs a run, replacing (and cancelling) any run already
// holding that id — re-issuing a search under the same id is a REFINEMENT, and
// the old walk must stop rather than interleave its matches with the new one's.
func (h *FSHandler) registerSearch(id string, cancel context.CancelFunc) uint64 {
	h.searchMu.Lock()
	prev, hadPrev := h.searches[id]
	if h.searches == nil {
		h.searches = make(map[string]searchRun)
	}
	h.searchGen++
	gen := h.searchGen
	h.searches[id] = searchRun{gen: gen, cancel: cancel}
	h.searchMu.Unlock()
	if hadPrev {
		prev.cancel() // outside the lock: cancel never blocks, but neither does it need the lock
	}
	return gen
}

// retireSearch drops a run's registration if (and only if) the entry is still
// this run's — a refinement may already have claimed the id.
func (h *FSHandler) retireSearch(id string, gen uint64) {
	h.searchMu.Lock()
	defer h.searchMu.Unlock()
	if cur, ok := h.searches[id]; ok && cur.gen == gen {
		delete(h.searches, id)
	}
}

// handleSearchCancel stops a run by id. Cancelling an unknown id is NOT an
// error — a cancel racing a natural finish is the normal case, and reporting it
// as a failure would train the caller to ignore real ones.
func (h *FSHandler) handleSearchCancel(write writeFn, id json.RawMessage, raw json.RawMessage) {
	var p searchCancelParams
	if err := json.Unmarshal(raw, &p); err != nil {
		h.sendRPCError(write, id, -32602, "invalid params", nil)
		return
	}
	h.searchMu.Lock()
	run, ok := h.searches[p.ID]
	if ok {
		delete(h.searches, p.ID)
	}
	h.searchMu.Unlock()
	if ok {
		run.cancel()
	}
	h.sendRPCResult(write, id, map[string]any{"id": p.ID, "cancelled": ok})
}

// cancelAllSearches stops every in-flight run. Called when the display
// disconnects: the only consumer of the stream is gone, so the walks are
// burning disk and CPU for nobody.
func (h *FSHandler) cancelAllSearches() {
	h.searchMu.Lock()
	runs := h.searches
	h.searches = make(map[string]searchRun)
	h.searchMu.Unlock()
	for _, run := range runs {
		run.cancel()
	}
}

func (h *FSHandler) handleSearch(write writeFn, id json.RawMessage, raw json.RawMessage) {
	var p searchParams
	if err := json.Unmarshal(raw, &p); err != nil {
		h.sendRPCError(write, id, -32602, "invalid params", nil)
		return
	}
	if strings.TrimSpace(p.ID) == "" {
		h.sendRPCError(write, id, -32602, "search id required", nil)
		return
	}
	if p.Query == "" {
		h.sendRPCError(write, id, -32602, "query required", nil)
		return
	}
	re, err := buildSearchMatcher(p)
	if err != nil {
		h.sendRPCError(write, id, -32602, "bad pattern: "+err.Error(), map[string]string{"query": p.Query})
		return
	}
	// The walk obeys the same sandbox as every other read: resolvePath, then a
	// directory check. A search is a bulk read; it gets no wider reach.
	base, err := h.resolvePath(p.URI)
	if err != nil {
		h.sendRPCError(write, id, errPermissionDenied, err.Error(), map[string]string{"uri": p.URI})
		return
	}
	info, err := os.Stat(base)
	if err != nil {
		h.sendRPCError(write, id, errFileNotFound, "not found: "+p.URI, map[string]string{"uri": p.URI})
		return
	}
	if !info.IsDir() {
		h.sendRPCError(write, id, errIsDirectory, "not a directory: "+p.URI, map[string]string{"uri": p.URI})
		return
	}
	if h.notify == nil {
		// No push channel means the matches would have nowhere to go. Fail at
		// the seam with the true cause instead of running a walk into a void.
		h.sendRPCError(write, id, -32603, "search requires a connected display (no notify channel)", nil)
		return
	}

	applySearchDefaults(&p)
	ctx, cancel := context.WithCancel(context.Background())
	gen := h.registerSearch(p.ID, cancel)

	// Acknowledge NOW — the walk owns the socket from here as notifications.
	h.sendRPCResult(write, id, searchStartResult{ID: p.ID, Base: filepath.ToSlash(base), Started: true})

	go h.runSearch(ctx, cancel, gen, p, base, re)
}

func applySearchDefaults(p *searchParams) {
	if p.MaxMatches <= 0 {
		p.MaxMatches = defaultSearchMaxMatches
	}
	if p.MaxFileMatches <= 0 {
		p.MaxFileMatches = defaultSearchMaxFileMatches
	}
	if p.MaxFileBytes <= 0 {
		p.MaxFileBytes = defaultSearchMaxFileBytes
	}
	if p.BatchMs <= 0 {
		p.BatchMs = defaultSearchBatchMs
	}
}

// runSearch walks the tree with a bounded worker pool, streams batched matches,
// and emits exactly one searchDone — on completion, on cap, or on cancel. The
// single-done guarantee is what lets the browser controller free its state in
// one place.
func (h *FSHandler) runSearch(ctx context.Context, cancel context.CancelFunc, gen uint64, p searchParams, base string, re *regexp.Regexp) {
	defer cancel()
	defer h.retireSearch(p.ID, gen)

	paths := make(chan string, 256)
	out := make(chan searchMatch, 1024)

	var scanned, matched int64
	var truncated bool
	var statMu sync.Mutex

	// -- the walk: one producer, feeding the pool -------------------------------
	go func() {
		defer close(paths)
		_ = filepath.WalkDir(base, func(path string, d fs.DirEntry, err error) error {
			if ctx.Err() != nil {
				return filepath.SkipAll
			}
			if err != nil {
				return nil // unreadable entries are skipped, never fatal
			}
			if d.IsDir() {
				if skipDirs[d.Name()] {
					return filepath.SkipDir
				}
				return nil
			}
			if !isTextFile(d.Name()) {
				return nil
			}
			if info, err := d.Info(); err == nil && info.Size() > p.MaxFileBytes {
				statMu.Lock()
				truncated = true
				statMu.Unlock()
				return nil
			}
			select {
			case paths <- path:
			case <-ctx.Done():
				return filepath.SkipAll
			}
			return nil
		})
	}()

	// -- the pool: read + scan each file ----------------------------------------
	workers := runtime.NumCPU()
	if workers < 2 {
		workers = 2
	}
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for path := range paths {
				if ctx.Err() != nil {
					return
				}
				statMu.Lock()
				scanned++
				statMu.Unlock()
				if hitCap := scanFileForMatches(ctx, path, base, re, p, out); hitCap {
					statMu.Lock()
					truncated = true
					statMu.Unlock()
				}
			}
		}()
	}
	go func() { wg.Wait(); close(out) }()

	// -- the batcher: the ONLY writer to the notify channel ---------------------
	ticker := time.NewTicker(time.Duration(p.BatchMs) * time.Millisecond)
	defer ticker.Stop()
	batch := make([]searchMatch, 0, searchMaxBatch)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		h.notify("fs/searchMatch", map[string]any{"id": p.ID, "matches": batch})
		batch = make([]searchMatch, 0, searchMaxBatch)
	}

	cancelled := false
	capped := false
	for done := false; !done; {
		select {
		case <-ctx.Done():
			cancelled = true
			done = true
		case <-ticker.C:
			flush()
		case m, ok := <-out:
			if !ok {
				done = true
				break
			}
			batch = append(batch, m)
			statMu.Lock()
			matched++
			hit := matched >= int64(p.MaxMatches)
			statMu.Unlock()
			if len(batch) >= searchMaxBatch {
				flush()
			}
			if hit {
				capped = true
				truncated = true
				cancel() // stop the walk; the pool drains on the next ctx check
				done = true
			}
		}
	}
	if !cancelled {
		flush() // a cancelled run publishes nothing further — clean stop, clean state
	}
	// Drain so the workers' sends can't block forever on an unread channel.
	cancel()
	for range out {
	}

	statMu.Lock()
	sc, mt, tr := scanned, matched, truncated
	statMu.Unlock()

	h.notify("fs/searchDone", map[string]any{
		"id": p.ID, "scanned": sc, "matched": mt,
		"truncated": tr, "capped": capped,
		"cancelled": cancelled && !capped,
	})
}

// scanFileForMatches reads one file and emits its hits. Returns true if the
// file's own match cap was hit (a truncation the caller must report).
func scanFileForMatches(ctx context.Context, path, base string, re *regexp.Regexp, p searchParams, out chan<- searchMatch) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	// Binary sniff: the extension whitelist is a good filter, not a perfect one
	// (a .json blob of base64, a .txt that is really a dump). A NUL in the head
	// means the "lines" here are noise.
	head := data
	if len(head) > searchBinarySniff {
		head = head[:searchBinarySniff]
	}
	if bytes.IndexByte(head, 0) >= 0 {
		return false
	}

	rel, relErr := filepath.Rel(base, path)
	if relErr != nil {
		rel = path
	}
	rel = filepath.ToSlash(rel)

	fileMatches := 0
	lineNo := 0
	for off := 0; off <= len(data); {
		if ctx.Err() != nil {
			return false
		}
		end := bytes.IndexByte(data[off:], '\n')
		var line []byte
		if end < 0 {
			line = data[off:]
			off = len(data) + 1
		} else {
			line = data[off : off+end]
			off += end + 1
		}
		line = bytes.TrimSuffix(line, []byte("\r"))

		if locs := re.FindAllIndex(line, p.MaxFileMatches); len(locs) > 0 {
			text := capRunes(string(line), searchLineTextCap)
			for _, loc := range locs {
				m := searchMatch{
					Path:   rel,
					Line:   lineNo,
					Col:    utf8.RuneCount(line[:loc[0]]),
					Length: utf8.RuneCount(line[loc[0]:loc[1]]),
					Text:   text,
				}
				select {
				case out <- m:
				case <-ctx.Done():
					return false
				}
				fileMatches++
				if fileMatches >= p.MaxFileMatches {
					return true
				}
			}
		}
		lineNo++
	}
	return false
}

// capRunes truncates on a rune boundary, marking that it did — a silently cut
// line would read as the file's real content.
func capRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	i, count := 0, 0
	for i < len(s) && count < n {
		_, size := utf8.DecodeRuneInString(s[i:])
		i += size
		count++
	}
	return s[:i] + "…"
}

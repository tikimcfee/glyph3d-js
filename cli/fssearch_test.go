package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// searchSink collects the notification stream a run pushes, so a test can assert
// on what the browser would actually receive (matches AND the single terminal
// done), not just on internal state.
type searchSink struct {
	mu      sync.Mutex
	matches []searchMatch
	dones   chan map[string]any
}

func newSearchSink() *searchSink {
	// Buffered: a run's done must never block the walk's goroutine, and a test
	// that only waits for one done still lets a second land.
	return &searchSink{dones: make(chan map[string]any, 8)}
}

func (s *searchSink) hook(method string, params any) {
	// Round-trip through JSON: the test must see what the wire carries, including
	// the json tags, not the in-process Go values.
	raw, err := json.Marshal(params)
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch method {
	case "fs/searchMatch":
		var p struct {
			ID      string        `json:"id"`
			Matches []searchMatch `json:"matches"`
		}
		if json.Unmarshal(raw, &p) == nil {
			s.matches = append(s.matches, p.Matches...)
		}
	case "fs/searchDone":
		var p map[string]any
		if json.Unmarshal(raw, &p) == nil {
			s.dones <- p
		}
	}
}

// wait returns the next fs/searchDone. Each run emits exactly one, so a test
// that started one run reads one here — and a test that reads more dones than
// it started runs would block out, which is the leak it wants to catch.
func (s *searchSink) wait(t *testing.T) map[string]any {
	t.Helper()
	select {
	case d := <-s.dones:
		return d
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for fs/searchDone")
		return nil
	}
}

func (s *searchSink) got() []searchMatch {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]searchMatch, len(s.matches))
	copy(out, s.matches)
	return out
}

// startSearch fires the RPC and returns the decoded ack.
func startSearch(t *testing.T, h *FSHandler, p searchParams) (*searchStartResult, map[string]any) {
	t.Helper()
	return callRPC[searchStartResult](t, h.handleSearch, p)
}

func TestSearch_FindsMatchesWithGridCoordinates(t *testing.T) {
	h, root, _ := newTestHandler(t)
	sink := newSearchSink()
	h.SetNotifyHook(sink.hook)

	writeFile(t, root, "src/a.js", "const x = 1;\nreturn needle;\n")
	writeFile(t, root, "src/b.js", "no hits here\n")
	// A non-ASCII prefix: col/length must count RUNES, not bytes, or the browser
	// would highlight the wrong glyphs.
	writeFile(t, root, "src/c.js", "// αβγ needle\n")

	res, rpcErr := startSearch(t, h, searchParams{ID: "r1", URI: "file:///", Query: "needle"})
	if rpcErr != nil {
		t.Fatalf("search errored: %v", rpcErr)
	}
	if !res.Started {
		t.Fatal("search did not report started")
	}
	done := sink.wait(t)

	got := sink.got()
	if len(got) != 2 {
		t.Fatalf("expected 2 matches, got %d: %+v", len(got), got)
	}
	byPath := map[string]searchMatch{}
	for _, m := range got {
		byPath[m.Path] = m
	}

	a, ok := byPath["src/a.js"]
	if !ok {
		t.Fatalf("no match in src/a.js: %+v", got)
	}
	if a.Line != 1 { // 0-based: the SECOND line
		t.Errorf("a.js line = %d, want 1 (0-based)", a.Line)
	}
	if a.Col != 7 || a.Length != 6 { // "return " is 7 runes
		t.Errorf("a.js col/length = %d/%d, want 7/6", a.Col, a.Length)
	}
	if a.Text != "return needle;" {
		t.Errorf("a.js text = %q", a.Text)
	}

	c, ok := byPath["src/c.js"]
	if !ok {
		t.Fatalf("no match in src/c.js: %+v", got)
	}
	// "// αβγ " is 7 runes but 10 bytes — a byte offset would report 10.
	if c.Col != 7 {
		t.Errorf("c.js col = %d, want 7 (runes, not bytes)", c.Col)
	}

	if done["matched"].(float64) != 2 {
		t.Errorf("done.matched = %v, want 2", done["matched"])
	}
	if done["truncated"].(bool) {
		t.Error("unexpected truncation")
	}
	if done["cancelled"].(bool) {
		t.Error("run reported cancelled")
	}
}

func TestSearch_LiteralQueryIsNotARegexp(t *testing.T) {
	h, root, _ := newTestHandler(t)
	sink := newSearchSink()
	h.SetNotifyHook(sink.hook)

	writeFile(t, root, "a.js", "a.b\naxb\n")

	// Literal "a.b" must match only the literal — an unquoted regexp would also
	// match "axb", the classic silent over-match.
	if _, rpcErr := startSearch(t, h, searchParams{ID: "r1", URI: "file:///", Query: "a.b"}); rpcErr != nil {
		t.Fatalf("search errored: %v", rpcErr)
	}
	sink.wait(t)
	got := sink.got()
	if len(got) != 1 || got[0].Line != 0 {
		t.Fatalf("literal query over-matched: %+v", got)
	}
}

func TestSearch_RegexAndWholeWordAndCase(t *testing.T) {
	h, root, _ := newTestHandler(t)

	writeFile(t, root, "a.js", "Needle\nneedle\nneedles\n")

	cases := []struct {
		name  string
		p     searchParams
		lines []int
	}{
		{"case-insensitive by default", searchParams{Query: "needle"}, []int{0, 1, 2}},
		{"case-sensitive", searchParams{Query: "needle", CaseSensitive: true}, []int{1, 2}},
		{"whole word", searchParams{Query: "needle", WholeWord: true}, []int{0, 1}},
		{"regex", searchParams{Query: "needle(s)", Regex: true}, []int{2}},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sink := newSearchSink()
			h.SetNotifyHook(sink.hook)
			p := tc.p
			p.ID = fmt.Sprintf("run-%d", i)
			p.URI = "file:///"
			if _, rpcErr := startSearch(t, h, p); rpcErr != nil {
				t.Fatalf("search errored: %v", rpcErr)
			}
			sink.wait(t)
			var lines []int
			for _, m := range sink.got() {
				lines = append(lines, m.Line)
			}
			if fmt.Sprint(lines) != fmt.Sprint(tc.lines) {
				t.Errorf("lines = %v, want %v", lines, tc.lines)
			}
		})
	}
}

func TestSearch_BadPatternFailsAtTheSeam(t *testing.T) {
	h, _, _ := newTestHandler(t)
	h.SetNotifyHook(newSearchSink().hook)

	_, rpcErr := startSearch(t, h, searchParams{ID: "r1", URI: "file:///", Query: "a(", Regex: true})
	if rpcErr == nil {
		t.Fatal("expected an error for an unparseable pattern, got success")
	}
}

func TestSearch_RequiresNotifyChannel(t *testing.T) {
	h, root, _ := newTestHandler(t)
	writeFile(t, root, "a.js", "needle")
	// notify unset: with nowhere to stream, starting the walk would burn a tree
	// scan into a void. It must fail loudly instead.
	_, rpcErr := startSearch(t, h, searchParams{ID: "r1", URI: "file:///", Query: "needle"})
	if rpcErr == nil {
		t.Fatal("expected an error with no notify channel, got success")
	}
}

func TestSearch_MaxMatchesCapsAndReportsTruncation(t *testing.T) {
	h, root, _ := newTestHandler(t)
	sink := newSearchSink()
	h.SetNotifyHook(sink.hook)

	var body string
	for i := 0; i < 500; i++ {
		body += "needle\n"
	}
	writeFile(t, root, "a.js", body)

	if _, rpcErr := startSearch(t, h, searchParams{
		ID: "r1", URI: "file:///", Query: "needle", MaxMatches: 10, BatchMs: 1,
	}); rpcErr != nil {
		t.Fatalf("search errored: %v", rpcErr)
	}
	done := sink.wait(t)

	if !done["truncated"].(bool) {
		t.Error("a capped run must report truncated — a silent cap reads as 'that's all there is'")
	}
	if !done["capped"].(bool) {
		t.Error("done.capped not set")
	}
	if done["cancelled"].(bool) {
		t.Error("a cap is not a cancellation")
	}
}

func TestSearch_SkipsBinaryAndNonTextFiles(t *testing.T) {
	h, root, _ := newTestHandler(t)
	sink := newSearchSink()
	h.SetNotifyHook(sink.hook)

	writeFile(t, root, "ok.js", "needle\n")
	writeFile(t, root, "blob.png", "needle\n")               // not in the text whitelist
	writeFileBytes(t, root, "sneaky.js", []byte("nee\x00dle\nneedle\n")) // whitelisted ext, binary content
	if err := os.MkdirAll(filepath.Join(root, "node_modules", "dep"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, root, "node_modules/dep/index.js", "needle\n")

	if _, rpcErr := startSearch(t, h, searchParams{ID: "r1", URI: "file:///", Query: "needle"}); rpcErr != nil {
		t.Fatalf("search errored: %v", rpcErr)
	}
	sink.wait(t)

	got := sink.got()
	if len(got) != 1 || got[0].Path != "ok.js" {
		t.Fatalf("expected only ok.js, got %+v", got)
	}
}

func TestSearch_CancelStopsTheRunAndClearsRegistry(t *testing.T) {
	h, root, _ := newTestHandler(t)
	sink := newSearchSink()
	h.SetNotifyHook(sink.hook)

	// Enough files that the walk is still going when the cancel lands.
	for i := 0; i < 400; i++ {
		writeFile(t, root, fmt.Sprintf("d%d/f.js", i), "needle\nneedle\nneedle\n")
	}

	if _, rpcErr := startSearch(t, h, searchParams{
		ID: "r1", URI: "file:///", Query: "needle", BatchMs: 1000,
	}); rpcErr != nil {
		t.Fatalf("search errored: %v", rpcErr)
	}
	cancelRes, rpcErr := callRPC[map[string]any](t, h.handleSearchCancel, searchCancelParams{ID: "r1"})
	if rpcErr != nil {
		t.Fatalf("cancel errored: %v", rpcErr)
	}
	_ = cancelRes
	done := sink.wait(t)
	if !done["cancelled"].(bool) {
		t.Error("done.cancelled not set after an explicit cancel")
	}

	// The run must retire from the registry, or a long session leaks a cancel
	// func per search ever issued.
	h.searchMu.Lock()
	n := len(h.searches)
	h.searchMu.Unlock()
	if n != 0 {
		t.Errorf("registry still holds %d run(s) after cancel", n)
	}
}

func TestSearch_RetiresRegistryOnNaturalFinish(t *testing.T) {
	h, root, _ := newTestHandler(t)
	sink := newSearchSink()
	h.SetNotifyHook(sink.hook)
	writeFile(t, root, "a.js", "needle\n")

	if _, rpcErr := startSearch(t, h, searchParams{ID: "r1", URI: "file:///", Query: "needle"}); rpcErr != nil {
		t.Fatalf("search errored: %v", rpcErr)
	}
	sink.wait(t)
	// The done notification is sent before the deferred retire runs; give it a beat.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		h.searchMu.Lock()
		n := len(h.searches)
		h.searchMu.Unlock()
		if n == 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Error("registry never retired the finished run")
}

func TestSearch_RefinementReplacesTheOldRun(t *testing.T) {
	h, root, _ := newTestHandler(t)
	for i := 0; i < 300; i++ {
		writeFile(t, root, fmt.Sprintf("d%d/f.js", i), "alpha\nbravo\n")
	}

	// Both runs share an id — issuing the second must CANCEL the first, so the
	// stream carries two dones: the superseded run's (cancelled) and the
	// refinement's (not). One sink, because they are one id: this is exactly the
	// ambiguity the browser side resolves by minting a fresh run id per start.
	sink := newSearchSink()
	h.SetNotifyHook(sink.hook)
	if _, rpcErr := startSearch(t, h, searchParams{ID: "same", URI: "file:///", Query: "alpha", BatchMs: 1000}); rpcErr != nil {
		t.Fatalf("first search errored: %v", rpcErr)
	}
	if _, rpcErr := startSearch(t, h, searchParams{ID: "same", URI: "file:///", Query: "bravo"}); rpcErr != nil {
		t.Fatalf("second search errored: %v", rpcErr)
	}

	cancelled := 0
	for i := 0; i < 2; i++ {
		if sink.wait(t)["cancelled"].(bool) {
			cancelled++
		}
	}
	if cancelled != 1 {
		t.Errorf("got %d cancelled done(s) across the two runs, want exactly 1 (the superseded one)", cancelled)
	}

	// The registry holds ONE entry for the id, not two.
	h.searchMu.Lock()
	n := len(h.searches)
	h.searchMu.Unlock()
	if n > 1 {
		t.Errorf("registry holds %d entries for one id", n)
	}
}

package main

import (
	"database/sql"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *LogStore {
	t.Helper()
	s, err := NewLogStore()
	if err != nil {
		t.Fatalf("NewLogStore: %v", err)
	}
	t.Cleanup(func() { s.db.Close() })
	return s
}

func strp(s string) *string { return &s }

func rec(level, scope, msg, page string) *LogRec {
	r := &LogRec{TS: time.Now().UnixMilli(), Level: level, Msg: msg, Page: page}
	if scope != "" {
		r.Scope = strp(scope)
	}
	return r
}

func ingest(t *testing.T, s *LogStore, r *LogRec) *LogRec {
	t.Helper()
	out, err := s.Ingest(r)
	if err != nil {
		t.Fatalf("Ingest(%q): %v", r.Msg, err)
	}
	return out
}

func rowCount(t *testing.T, s *LogStore, table string) int64 {
	t.Helper()
	var n int64
	if err := s.db.QueryRow(`SELECT count(*) FROM ` + table).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return n
}

func TestIngestSearchRoundTrip(t *testing.T) {
	s := newTestStore(t)
	r := rec("error", "picking", "PickingSystem: 24-bit id overflow at glyph 91843", "p1")
	r.Attrs = json.RawMessage(`{"glyph":91843}`)
	ingest(t, s, r)
	ingest(t, s, rec("info", "layout", "relayout complete", "p1"))

	// Trigram FTS: mid-word, wrong-case substring.
	hits, err := s.Search("ICKINGSYS", SearchOpts{})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("want 1 hit, got %d", len(hits))
	}
	h := hits[0]
	if h.Level != "error" || h.Scope == nil || *h.Scope != "picking" || h.Page != "p1" || h.Repeat != 1 {
		t.Fatalf("round-trip fields wrong: %+v", h)
	}
	if string(h.Attrs) != `{"glyph":91843}` {
		t.Fatalf("attrs round-trip wrong: %s", h.Attrs)
	}
	if h.RTS == 0 {
		t.Fatalf("rts not defaulted")
	}
}

func TestShortExprLikeFallback(t *testing.T) {
	s := newTestStore(t)
	ingest(t, s, rec("log", "", "id overflow", "p1"))
	ingest(t, s, rec("log", "", "no match here", "p1"))

	// 2-char expression: trigram FTS would silently return zero — must go LIKE.
	hits, err := s.Search("id", SearchOpts{})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 1 || hits[0].Msg != "id overflow" {
		t.Fatalf("LIKE fallback failed: %+v", hits)
	}
}

func TestFTSSyntaxErrorFallsBackToLike(t *testing.T) {
	s := newTestStore(t)
	ingest(t, s, rec("log", "", `saw "unbalanced quote in msg`, "p1"))

	// An unterminated FTS5 string is a query syntax error; the literal LIKE
	// fallback must still find the substring.
	hits, err := s.Search(`"unbalanced`, SearchOpts{})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("want 1 hit via LIKE fallback, got %d", len(hits))
	}
}

func TestCoalescing(t *testing.T) {
	s := newTestStore(t)
	var last *LogRec
	for i := 0; i < 3; i++ {
		last = ingest(t, s, rec("warn", "ws", "reconnect attempt", "p1"))
	}
	if n := rowCount(t, s, "logs"); n != 1 {
		t.Fatalf("3 identical consecutive: want 1 row, got %d", n)
	}
	if last.Repeat != 3 {
		t.Fatalf("want repeat=3 on returned rec, got %d", last.Repeat)
	}
	if n := rowCount(t, s, "logs_fts"); n != 1 {
		t.Fatalf("fts rows: want 1, got %d", n)
	}

	// Interleaved duplicates do NOT coalesce.
	s2 := newTestStore(t)
	ingest(t, s2, rec("log", "", "A", "p1"))
	ingest(t, s2, rec("log", "", "B", "p1"))
	ingest(t, s2, rec("log", "", "A", "p1"))
	if n := rowCount(t, s2, "logs"); n != 3 {
		t.Fatalf("interleaved: want 3 rows, got %d", n)
	}

	// Same msg but different scope is a different record.
	s3 := newTestStore(t)
	ingest(t, s3, rec("log", "a", "same", "p1"))
	ingest(t, s3, rec("log", "b", "same", "p1"))
	if n := rowCount(t, s3, "logs"); n != 2 {
		t.Fatalf("scope-differing: want 2 rows, got %d", n)
	}
}

func TestSinceFilter(t *testing.T) {
	s := newTestStore(t)
	old := rec("log", "", "old record", "p1")
	old.RTS = time.Now().Add(-10 * time.Minute).UnixMilli()
	ingest(t, s, old)
	ingest(t, s, rec("log", "", "fresh record", "p1"))

	hits, err := s.Search("record", SearchOpts{Since: time.Minute})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 1 || hits[0].Msg != "fresh record" {
		t.Fatalf("since filter: want only fresh, got %+v", hits)
	}
	hits, err = s.Search("record", SearchOpts{Since: time.Hour})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 2 {
		t.Fatalf("since=1h: want 2, got %d", len(hits))
	}
}

func TestLevelFilterAndErrors(t *testing.T) {
	s := newTestStore(t)
	ingest(t, s, rec("error", "", "boom", "p1"))
	ingest(t, s, rec("warn", "", "careful", "p1"))
	ingest(t, s, rec("info", "", "fine", "p1"))

	hits, err := s.Search("", SearchOpts{Levels: []string{"error"}})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 1 || hits[0].Msg != "boom" {
		t.Fatalf("level filter: %+v", hits)
	}

	entries, err := s.Errors(0, 0)
	if err != nil {
		t.Fatalf("Errors: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("Errors: want 2 (error+warn), got %d", len(entries))
	}
	// Newest first.
	if entries[0].Msg != "careful" || entries[1].Msg != "boom" {
		t.Fatalf("Errors order: %+v", entries)
	}
}

func TestPageCurFilter(t *testing.T) {
	s := newTestStore(t)
	ingest(t, s, rec("log", "", "from first load", "p1"))
	ingest(t, s, rec("log", "", "from second load", "p2"))

	hits, err := s.Search("", SearchOpts{Page: "cur"})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 1 || hits[0].Page != "p2" {
		t.Fatalf("page=cur: want only p2, got %+v", hits)
	}
}

func TestQueryReadOnlyAndCap(t *testing.T) {
	s := newTestStore(t)
	ingest(t, s, rec("log", "", "one", "p1"))

	for _, bad := range []string{
		"INSERT INTO logs(ts,rts,level,msg) VALUES (1,1,'x','y')",
		"  delete from logs",
		"DROP TABLE logs",
		"PRAGMA page_count",
	} {
		if _, _, err := s.Query(bad); err == nil || !strings.Contains(err.Error(), "only SELECT/WITH") {
			t.Fatalf("Query(%q): want SELECT/WITH rejection, got %v", bad, err)
		}
	}

	cols, rows, err := s.Query("  select msg, repeat from logs")
	if err != nil {
		t.Fatalf("Query select: %v", err)
	}
	if len(cols) != 2 || len(rows) != 1 || rows[0][0] != "one" || rows[0][1] != "1" {
		t.Fatalf("Query result: cols=%v rows=%v", cols, rows)
	}
	if _, _, err := s.Query("WITH x AS (SELECT 42 AS n) SELECT n FROM x"); err != nil {
		t.Fatalf("Query WITH: %v", err)
	}

	// Hard row cap at 1000.
	s.maxRows = 10000
	s.pruneTo = 10000
	for i := 0; i < 1100; i++ {
		ingest(t, s, rec("log", "", "row "+strings.Repeat("x", i%7)+string(rune('a'+i%26)), "p1"))
	}
	_, rows, err = s.Query("SELECT id FROM logs")
	if err != nil {
		t.Fatalf("Query cap: %v", err)
	}
	if len(rows) != 1000 {
		t.Fatalf("row cap: want 1000, got %d", len(rows))
	}
}

func TestRetentionPrune(t *testing.T) {
	s := newTestStore(t)
	s.maxRows = 50
	s.pruneTo = 40
	s.checkEvery = 10
	for i := 0; i < 60; i++ {
		ingest(t, s, rec("log", "", "distinct message number "+strings.Repeat("z", i%5)+string(rune('a'+i%26))+string(rune('a'+i/26)), "p1"))
	}
	if n := rowCount(t, s, "logs"); n != 40 {
		t.Fatalf("after prune: want 40 logs rows, got %d", n)
	}
	if n := rowCount(t, s, "logs_fts"); n != 40 {
		t.Fatalf("after prune: want 40 fts rows, got %d", n)
	}
	// Oldest ids gone, newest kept.
	var minID int64
	if err := s.db.QueryRow(`SELECT min(id) FROM logs`).Scan(&minID); err != nil {
		t.Fatalf("min id: %v", err)
	}
	if minID != 21 {
		t.Fatalf("prune boundary: want min id 21, got %d", minID)
	}
}

func TestDumpAndReopen(t *testing.T) {
	s := newTestStore(t)
	ingest(t, s, rec("error", "picking", "needlehay in the stack", "p1"))
	ingest(t, s, rec("log", "", "another record", "p1"))

	path := filepath.Join(t.TempDir(), "sub", "dump.db")
	n, outPath, err := s.Dump(path)
	if err != nil {
		t.Fatalf("Dump: %v", err)
	}
	if n != 2 || outPath != path {
		t.Fatalf("Dump: n=%d path=%s", n, outPath)
	}
	// Dump over an existing file must succeed (unlink-first).
	if _, _, err := s.Dump(path); err != nil {
		t.Fatalf("Dump over existing: %v", err)
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	var count int64
	if err := db.QueryRow(`SELECT count(*) FROM logs`).Scan(&count); err != nil {
		t.Fatalf("reopen count: %v", err)
	}
	if count != 2 {
		t.Fatalf("reopen: want 2 rows, got %d", count)
	}
	var ftsHits int64
	if err := db.QueryRow(`SELECT count(*) FROM logs_fts WHERE logs_fts MATCH 'needlehay'`).Scan(&ftsHits); err != nil {
		t.Fatalf("reopen fts: %v", err)
	}
	if ftsHits != 1 {
		t.Fatalf("reopen fts: want 1 hit, got %d", ftsHits)
	}
}

func TestStatsShape(t *testing.T) {
	s := newTestStore(t)
	base := time.Now().UnixMilli()
	recs := []*LogRec{
		rec("error", "picking", "boom", "p1"),
		rec("error", "picking", "boom again", "p1"),
		rec("info", "layout", "ok", "p2"),
		rec("trace", "", "quiet", "p2"),
	}
	for i, r := range recs {
		r.RTS = base + int64(i) // distinct rts so page ordering (min rts) is deterministic
		ingest(t, s, r)
	}

	st, err := s.Stats()
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if st.Rows != 4 {
		t.Fatalf("rows: want 4, got %d", st.Rows)
	}
	if st.ByLevel["error"] != 2 || st.ByLevel["info"] != 1 || st.ByLevel["trace"] != 1 {
		t.Fatalf("byLevel: %+v", st.ByLevel)
	}
	if len(st.TopScopes) != 2 || st.TopScopes[0].Scope != "picking" || st.TopScopes[0].Count != 2 {
		t.Fatalf("topScopes: %+v", st.TopScopes)
	}
	if len(st.Pages) != 2 || st.Pages[0].ID != "p1" || st.Pages[0].Count != 2 || st.Pages[1].ID != "p2" {
		t.Fatalf("pages: %+v", st.Pages)
	}
	if st.Pages[0].First == 0 || st.Pages[0].Last < st.Pages[0].First {
		t.Fatalf("page span: %+v", st.Pages[0])
	}
	if st.Bytes <= 0 {
		t.Fatalf("bytes: want > 0, got %d", st.Bytes)
	}

	// The JSON shape is the wire contract — keys must match exactly.
	b, err := json.Marshal(st)
	if err != nil {
		t.Fatalf("marshal stats: %v", err)
	}
	for _, key := range []string{`"rows"`, `"byLevel"`, `"topScopes"`, `"pages"`, `"bytes"`, `"first"`, `"last"`} {
		if !strings.Contains(string(b), key) {
			t.Fatalf("stats JSON missing %s: %s", key, b)
		}
	}
}

func TestSearchArgsParsing(t *testing.T) {
	expr, opts, err := parseLogSearchArgs("overflow glyph --since 5m --level error,warn --scope picking --page cur --limit 7")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if expr != "overflow glyph" {
		t.Fatalf("expr: %q", expr)
	}
	if opts.Since != 5*time.Minute || opts.Scope != "picking" || opts.Page != "cur" || opts.Limit != 7 {
		t.Fatalf("opts: %+v", opts)
	}
	if len(opts.Levels) != 2 || opts.Levels[0] != "error" || opts.Levels[1] != "warn" {
		t.Fatalf("levels: %+v", opts.Levels)
	}
	if _, _, err := parseLogSearchArgs("x --since 5x"); err == nil {
		t.Fatalf("want bad-duration error")
	}
	if d, err := parseSinceDuration("1d"); err != nil || d != 24*time.Hour {
		t.Fatalf("1d: %v %v", d, err)
	}
}

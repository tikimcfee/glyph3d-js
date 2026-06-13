// LogStore — the relay-resident store of browser log records: an in-memory
// SQLite database (modernc.org/sqlite, pure Go) with an FTS5 trigram index for
// case-insensitive substring search. The relay ingests every
// {"event":"browser.log"} record from the display and answers the
// relay-resident log.* verbs (query/search/errors/stats/dump) from here
// without round-tripping to the page.
package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// LogRec is one browser log record — the wire `rec` shape on ingest, the
// stored row on read, and the pushed `data` payload for log.follow subscribers.
type LogRec struct {
	TS     int64           `json:"ts"`     // page clock, ms epoch
	RTS    int64           `json:"rts"`    // relay receive time, ms epoch
	Level  string          `json:"level"`  // trace|debug|info|log|warn|error
	Scope  *string         `json:"scope"`  // Logger fullName, or null
	Msg    string          `json:"msg"`    // ≤4096 chars (clipped page-side)
	Attrs  json.RawMessage `json:"attrs"`  // JSON object, or null
	Page   string          `json:"page"`   // short page-load id
	Repeat int64           `json:"repeat"` // consecutive-duplicate count
}

// SearchOpts are the log.search filters. Zero values mean "no filter"
// (Page "" or "all" = all pages; Limit <= 0 = default 50).
type SearchOpts struct {
	Since  time.Duration // window over rts, relative to now
	Levels []string      // level IN (...)
	Scope  string        // exact scope match
	Page   string        // "cur" | "all" | explicit page id
	Limit  int
}

// LogStats is the log.stats reply data shape.
type LogStats struct {
	Rows      int64            `json:"rows"`
	ByLevel   map[string]int64 `json:"byLevel"`
	TopScopes []ScopeCount     `json:"topScopes"`
	Pages     []PageStat       `json:"pages"`
	Bytes     int64            `json:"bytes"` // page_count * page_size
}

// ScopeCount is one topScopes entry.
type ScopeCount struct {
	Scope string `json:"scope"`
	Count int64  `json:"count"`
}

// PageStat is one per-page-load summary (first/last are rts, ms epoch).
type PageStat struct {
	ID    string `json:"id"`
	First int64  `json:"first"`
	Last  int64  `json:"last"`
	Count int64  `json:"count"`
}

// logKey is the consecutive-duplicate coalescing identity: a record that
// matches the previous insert on all four fields bumps `repeat` in place.
type logKey struct {
	page, level, msg string
	scope            string
	scopeNull        bool
}

// LogStore wraps the :memory: SQLite database. The single pooled connection
// serializes SQL; mu guards the coalescing state and orders ingest writes.
type LogStore struct {
	db *sql.DB

	mu      sync.Mutex
	lastID  int64  // rowid of the last INSERTed record (0 = none)
	lastKey logKey // coalescing identity of that record
	inserts int64  // INSERT count (coalesced repeats excluded), drives retention checks

	// Retention knobs (test-tunable): every checkEvery inserts, if the row
	// count exceeds maxRows, the oldest rows are deleted down to pruneTo.
	maxRows    int64
	pruneTo    int64
	checkEvery int64
}

const logStoreSchema = `
CREATE TABLE logs(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, rts INTEGER NOT NULL, level TEXT NOT NULL, scope TEXT, msg TEXT NOT NULL, attrs TEXT, page TEXT, repeat INTEGER NOT NULL DEFAULT 1);
CREATE INDEX logs_ts ON logs(ts);
CREATE INDEX logs_level_ts ON logs(level, ts);
CREATE VIRTUAL TABLE logs_fts USING fts5(msg, attrs, tokenize='trigram');
`

// NewLogStore opens the in-memory database and creates the schema. The
// logs_fts rowid mirrors logs.id and is maintained manually by Ingest/prune
// (no triggers).
func NewLogStore() (*LogStore, error) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		return nil, err
	}
	// Each pooled connection to :memory: would be a separate empty database —
	// pin the pool to one connection.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(logStoreSchema); err != nil {
		db.Close()
		return nil, fmt.Errorf("log store schema: %w", err)
	}
	return &LogStore{
		db:         db,
		maxRows:    200000,
		pruneTo:    180000,
		checkEvery: 1000,
	}, nil
}

// Ingest stores one record and returns the stored row (for push fanout). A
// record matching the previous insert on (page, level, scope, msg) coalesces:
// repeat increments and ts/rts refresh in place — msg is unchanged so the FTS
// index needs no write. RTS defaults to now when unset.
func (s *LogStore) Ingest(rec *LogRec) (*LogRec, error) {
	if rec.Level == "" {
		rec.Level = "log"
	}
	if rec.RTS == 0 {
		rec.RTS = time.Now().UnixMilli()
	}
	key := logKey{page: rec.Page, level: rec.Level, msg: rec.Msg}
	if rec.Scope != nil {
		key.scope = *rec.Scope
	} else {
		key.scopeNull = true
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.lastID != 0 && key == s.lastKey {
		if _, err := s.db.Exec(`UPDATE logs SET repeat = repeat + 1, ts = ?, rts = ? WHERE id = ?`,
			rec.TS, rec.RTS, s.lastID); err != nil {
			return nil, err
		}
		out := *rec
		var attrs sql.NullString
		if err := s.db.QueryRow(`SELECT repeat, attrs FROM logs WHERE id = ?`, s.lastID).
			Scan(&out.Repeat, &attrs); err != nil {
			return nil, err
		}
		out.Attrs = nil
		if attrs.Valid {
			out.Attrs = json.RawMessage(attrs.String)
		}
		return &out, nil
	}

	var scopeVal, attrsVal any
	if rec.Scope != nil {
		scopeVal = *rec.Scope
	}
	if len(rec.Attrs) > 0 && string(rec.Attrs) != "null" {
		attrsVal = string(rec.Attrs)
	}
	res, err := s.db.Exec(`INSERT INTO logs(ts, rts, level, scope, msg, attrs, page) VALUES (?,?,?,?,?,?,?)`,
		rec.TS, rec.RTS, rec.Level, scopeVal, rec.Msg, attrsVal, rec.Page)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	if _, err := s.db.Exec(`INSERT INTO logs_fts(rowid, msg, attrs) VALUES (?,?,?)`, id, rec.Msg, attrsVal); err != nil {
		return nil, err
	}
	s.lastID = id
	s.lastKey = key
	s.inserts++
	if s.inserts%s.checkEvery == 0 {
		s.pruneLocked()
	}
	out := *rec
	out.Repeat = 1
	return &out, nil
}

// pruneLocked enforces retention: when the table exceeds maxRows, delete the
// oldest rows down to pruneTo — logs_fts first (rowid range), then logs.
// Caller holds s.mu.
func (s *LogStore) pruneLocked() {
	var n int64
	if err := s.db.QueryRow(`SELECT count(*) FROM logs`).Scan(&n); err != nil || n <= s.maxRows {
		return
	}
	var keepMin int64
	if err := s.db.QueryRow(`SELECT id FROM logs ORDER BY id DESC LIMIT 1 OFFSET ?`, s.pruneTo-1).Scan(&keepMin); err != nil {
		return
	}
	s.db.Exec(`DELETE FROM logs_fts WHERE rowid < ?`, keepMin)
	s.db.Exec(`DELETE FROM logs WHERE id < ?`, keepMin)
}

// Query runs an arbitrary read-only query (log.query). Only SELECT/WITH
// statements are accepted; rows read are hard-capped at 1000. All values come
// back as strings (or nil for NULL).
func (s *LogStore) Query(sqlText string) (columns []string, rows [][]any, err error) {
	q := strings.TrimSpace(sqlText)
	upper := strings.ToUpper(q)
	if !strings.HasPrefix(upper, "SELECT") && !strings.HasPrefix(upper, "WITH") {
		return nil, nil, fmt.Errorf("only SELECT/WITH queries")
	}
	rs, err := s.db.Query(q)
	if err != nil {
		return nil, nil, err
	}
	defer rs.Close()
	columns, err = rs.Columns()
	if err != nil {
		return nil, nil, err
	}
	rows = [][]any{}
	for len(rows) < 1000 && rs.Next() {
		raw := make([]sql.RawBytes, len(columns))
		ptrs := make([]any, len(columns))
		for i := range raw {
			ptrs[i] = &raw[i]
		}
		if err := rs.Scan(ptrs...); err != nil {
			return nil, nil, err
		}
		row := make([]any, len(columns))
		for i, rb := range raw {
			if rb != nil {
				row[i] = string(rb)
			}
		}
		rows = append(rows, row)
	}
	return columns, rows, rs.Err()
}

// Search runs log.search: expressions of 3+ characters use the FTS5 trigram
// index (full FTS5 query syntax — AND/OR/NEAR/"phrase" — passes through; a
// syntax error falls back to a literal LIKE), shorter expressions go straight
// to LIKE (trigram needs 3 chars). Results are newest-first.
func (s *LogStore) Search(expr string, opts SearchOpts) ([]LogRec, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = 50
	}
	build := func(useFTS bool) (string, []any) {
		var conds []string
		var args []any
		q := `SELECT logs.ts, logs.rts, logs.level, logs.scope, logs.msg, logs.attrs, logs.page, logs.repeat FROM logs`
		if expr != "" {
			if useFTS {
				q += ` JOIN logs_fts ON logs_fts.rowid = logs.id`
				conds = append(conds, `logs_fts MATCH ?`)
				args = append(args, expr)
			} else {
				conds = append(conds, `logs.msg LIKE ? ESCAPE '\'`)
				args = append(args, "%"+escapeLike(expr)+"%")
			}
		}
		if opts.Since > 0 {
			conds = append(conds, `logs.rts >= ?`)
			args = append(args, time.Now().Add(-opts.Since).UnixMilli())
		}
		if len(opts.Levels) > 0 {
			conds = append(conds, `logs.level IN (?`+strings.Repeat(",?", len(opts.Levels)-1)+`)`)
			for _, l := range opts.Levels {
				args = append(args, l)
			}
		}
		if opts.Scope != "" {
			conds = append(conds, `logs.scope = ?`)
			args = append(args, opts.Scope)
		}
		switch opts.Page {
		case "", "all":
		case "cur":
			conds = append(conds, `logs.page = (SELECT page FROM logs ORDER BY id DESC LIMIT 1)`)
		default:
			conds = append(conds, `logs.page = ?`)
			args = append(args, opts.Page)
		}
		if len(conds) > 0 {
			q += ` WHERE ` + strings.Join(conds, ` AND `)
		}
		q += ` ORDER BY logs.id DESC LIMIT ?`
		args = append(args, limit)
		return q, args
	}

	run := func(useFTS bool) ([]LogRec, error) {
		q, args := build(useFTS)
		rows, err := s.db.Query(q, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		return scanLogRecs(rows)
	}

	useFTS := expr != "" && len([]rune(expr)) >= 3
	out, err := run(useFTS)
	if err != nil && useFTS {
		// FTS5 query-syntax error (unbalanced quote, stray operator) — these
		// surface on the first row step, not at prepare — retry as a literal
		// substring LIKE.
		out, err = run(false)
	}
	return out, err
}

// Errors is the canned log.errors query: level IN ('error','warn'),
// newest-first. No expression, so no FTS involvement.
func (s *LogStore) Errors(since time.Duration, limit int) ([]LogRec, error) {
	if limit <= 0 {
		limit = 30
	}
	return s.Search("", SearchOpts{Since: since, Levels: []string{"error", "warn"}, Limit: limit})
}

// Stats summarizes the store: total rows, per-level counts, top scopes,
// per-page-load spans, and the database footprint in bytes.
func (s *LogStore) Stats() (*LogStats, error) {
	st := &LogStats{ByLevel: map[string]int64{}, TopScopes: []ScopeCount{}, Pages: []PageStat{}}
	if err := s.db.QueryRow(`SELECT count(*) FROM logs`).Scan(&st.Rows); err != nil {
		return nil, err
	}

	rows, err := s.db.Query(`SELECT level, count(*) FROM logs GROUP BY level`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var level string
		var count int64
		if err := rows.Scan(&level, &count); err != nil {
			rows.Close()
			return nil, err
		}
		st.ByLevel[level] = count
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = s.db.Query(`SELECT scope, count(*) AS c FROM logs WHERE scope IS NOT NULL GROUP BY scope ORDER BY c DESC LIMIT 10`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var sc ScopeCount
		if err := rows.Scan(&sc.Scope, &sc.Count); err != nil {
			rows.Close()
			return nil, err
		}
		st.TopScopes = append(st.TopScopes, sc)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = s.db.Query(`SELECT page, min(rts), max(rts), count(*) FROM logs GROUP BY page ORDER BY min(rts)`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var p PageStat
		var id sql.NullString
		if err := rows.Scan(&id, &p.First, &p.Last, &p.Count); err != nil {
			rows.Close()
			return nil, err
		}
		p.ID = id.String
		st.Pages = append(st.Pages, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var pageCount, pageSize int64
	if err := s.db.QueryRow(`PRAGMA page_count`).Scan(&pageCount); err != nil {
		return nil, err
	}
	if err := s.db.QueryRow(`PRAGMA page_size`).Scan(&pageSize); err != nil {
		return nil, err
	}
	st.Bytes = pageCount * pageSize
	return st, nil
}

// Dump snapshots the store to a file via VACUUM INTO and returns the row count
// and resolved path. Empty path defaults to /tmp/glyph3d/logs-<unix-seconds>.db.
// VACUUM INTO refuses an existing target, so any prior file is removed first.
func (s *LogStore) Dump(path string) (int64, string, error) {
	if path == "" {
		path = filepath.Join("/tmp", "glyph3d", fmt.Sprintf("logs-%d.db", time.Now().Unix()))
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return 0, "", err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return 0, "", err
	}
	var n int64
	if err := s.db.QueryRow(`SELECT count(*) FROM logs`).Scan(&n); err != nil {
		return 0, "", err
	}
	if _, err := s.db.Exec(`VACUUM INTO ?`, path); err != nil {
		return 0, "", err
	}
	return n, path, nil
}

// scanLogRecs reads (ts, rts, level, scope, msg, attrs, page, repeat) rows.
func scanLogRecs(rows *sql.Rows) ([]LogRec, error) {
	out := []LogRec{}
	for rows.Next() {
		var e LogRec
		var scope, attrs, page sql.NullString
		if err := rows.Scan(&e.TS, &e.RTS, &e.Level, &scope, &e.Msg, &attrs, &page, &e.Repeat); err != nil {
			return nil, err
		}
		if scope.Valid {
			v := scope.String
			e.Scope = &v
		}
		if attrs.Valid {
			e.Attrs = json.RawMessage(attrs.String)
		}
		e.Page = page.String
		out = append(out, e)
	}
	return out, rows.Err()
}

// escapeLike escapes LIKE wildcards so an expression matches literally
// (paired with ESCAPE '\').
func escapeLike(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	s = strings.ReplaceAll(s, `_`, `\_`)
	return s
}

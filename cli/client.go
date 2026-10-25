package main

// The relay client: dial the relay as a controller, run verbs, render the replies.
// One-shot argv rides the `call` bundle (call.go) so every argument arrives at its
// handler byte-identical; REPL and pipe lines are already bus syntax and go as typed.
// Client-side composites live beside it: screenshot (verb chain → capture → PNG),
// log.follow (the relay's live log feed), seed-history (tmux scrollback → depth
// history).

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"sort"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// --- Connection ---

// connect dials the relay and runs the controller handshake: send "ping", receive
// "OK: connected as ctrl-N", receive "pong".
func connect(url string) (*websocket.Conn, error) {
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w (is a relay up? glyph3d-cli serve)", url, err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
		conn.Close()
		return nil, fmt.Errorf("handshake ping: %w", err)
	}
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	defer conn.SetReadDeadline(time.Time{})
	_, msg, err := conn.ReadMessage()
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("handshake ack: %w", err)
	}
	ack := string(msg)
	if !strings.HasPrefix(ack, "OK:") {
		conn.Close()
		return nil, fmt.Errorf("unexpected ack: %s", ack)
	}
	fmt.Fprintf(os.Stderr, "%s\n", ack)
	if _, _, err := conn.ReadMessage(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("handshake pong: %w", err)
	}
	return conn, nil
}

// mustConnect is connect for the client commands: a relay that isn't there is fatal.
func mustConnect(url string) *websocket.Conn {
	conn, err := connect(url)
	if err != nil {
		fmt.Fprintf(os.Stderr, "connect: %v\n", err)
		os.Exit(2)
	}
	return conn
}

// --- Send/Receive ---

// Response is one verb reply: {"response": text, "data": ...} or plain text.
type Response struct {
	Text string
	Data json.RawMessage
}

func (r *Response) failed() bool { return strings.HasPrefix(r.Text, "ERR") }

// hasData reports whether the reply carried a non-null data payload.
func (r *Response) hasData() bool { return len(r.Data) > 0 && string(r.Data) != "null" }

// parseReply classifies one relay frame. A pushed event ({"event": ...} with no
// "response") is not a reply — event is true and the caller keeps waiting.
func parseReply(msg []byte) (resp *Response, event bool) {
	var probe map[string]json.RawMessage
	if json.Unmarshal(msg, &probe) == nil {
		_, hasResp := probe["response"]
		_, hasData := probe["data"]
		if _, hasEvent := probe["event"]; hasEvent && !hasResp {
			return nil, true
		}
		if hasResp || hasData {
			r := &Response{Data: probe["data"]}
			json.Unmarshal(probe["response"], &r.Text)
			return r, false
		}
	}
	return &Response{Text: string(msg)}, false
}

// sendLine writes one command line and waits up to `within` for its reply,
// skipping pushed events.
func sendLine(conn *websocket.Conn, line string, within time.Duration) (*Response, error) {
	if err := conn.WriteMessage(websocket.TextMessage, []byte(line)); err != nil {
		return nil, fmt.Errorf("write: %w", err)
	}
	conn.SetReadDeadline(time.Now().Add(within))
	defer conn.SetReadDeadline(time.Time{})
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return nil, fmt.Errorf("no reply within %s: %w", within, err)
		}
		if resp, event := parseReply(msg); !event {
			return resp, nil
		}
	}
}

// sendArgv sends argv as a `call` bundle — the lossless form for an already-split
// command (spaces, quotes, newlines and empty args all arrive intact).
func sendArgv(conn *websocket.Conn, argv []string, within time.Duration) (*Response, error) {
	line, err := callLine(argv)
	if err != nil {
		return nil, err
	}
	return sendLine(conn, line, within)
}

// verbOf is the verb of a typed line (its first token).
func verbOf(line string) string {
	if f := strings.Fields(line); len(f) > 0 {
		return f[0]
	}
	return ""
}

// --- Output ---

// printResponse renders one reply. --json prints the raw data payload. Otherwise
// log replies render their records (the reply's summary text goes to stderr) and
// every other verb prints its text.
func printResponse(verb string, resp *Response) {
	if *jsonMode && resp.hasData() {
		var pretty bytes.Buffer
		if json.Indent(&pretty, resp.Data, "", "  ") == nil {
			fmt.Println(pretty.String())
		} else {
			fmt.Println(string(resp.Data))
		}
		return
	}
	if !resp.failed() && resp.hasData() {
		rendered := true
		switch verb {
		case "log.search", "log.errors", "log.tail":
			var d struct {
				Entries []LogRec `json:"entries"`
			}
			rendered = json.Unmarshal(resp.Data, &d) == nil
			for i := range d.Entries {
				fmt.Println(renderLogRec(&d.Entries[i]))
			}
		case "log.query":
			var d struct {
				Columns []string `json:"columns"`
				Rows    [][]any  `json:"rows"`
			}
			rendered = json.Unmarshal(resp.Data, &d) == nil
			renderTable(d.Columns, d.Rows)
		case "log.stats":
			var d LogStats
			rendered = json.Unmarshal(resp.Data, &d) == nil
			renderStats(&d)
		default:
			rendered = false
		}
		if rendered {
			fmt.Fprintln(os.Stderr, resp.Text)
			return
		}
	}
	fmt.Println(resp.Text)
}

// fmtTs is a ms-epoch timestamp as local HH:MM:SS.mmm.
func fmtTs(ms int64) string {
	return time.UnixMilli(ms).Format("15:04:05.000")
}

// renderLogRec is one record as a line: HH:MM:SS.mmm level [scope] msg ×N
func renderLogRec(rec *LogRec) string {
	var b strings.Builder
	level := rec.Level
	if level == "" {
		level = "log"
	}
	fmt.Fprintf(&b, "%s %-5s", fmtTs(rec.TS), level)
	if rec.Scope != nil && *rec.Scope != "" {
		fmt.Fprintf(&b, " [%s]", *rec.Scope)
	}
	b.WriteString(" ")
	b.WriteString(rec.Msg)
	if rec.Repeat > 1 {
		fmt.Fprintf(&b, " ×%d", rec.Repeat)
	}
	return b.String()
}

// renderTable prints log.query rows as aligned columns; long cells clip at 120
// runes so alignment stays readable (--json carries every byte).
func renderTable(columns []string, rows [][]any) {
	cell := func(v any) string {
		var s string
		switch t := v.(type) {
		case nil:
			s = "∅"
		case string:
			s = t
		case float64:
			s = fmt.Sprint(t)
		default:
			j, _ := json.Marshal(t)
			s = string(j)
		}
		if r := []rune(s); len(r) > 120 {
			s = string(r[:117]) + "..."
		}
		return s
	}
	cells := make([][]string, len(rows))
	widths := make([]int, len(columns))
	for i, c := range columns {
		widths[i] = len([]rune(c))
	}
	for r, row := range rows {
		cells[r] = make([]string, len(columns))
		for i := range columns {
			if i < len(row) {
				cells[r][i] = cell(row[i])
			}
			widths[i] = max(widths[i], len([]rune(cells[r][i])))
		}
	}
	pad := func(s string, w int) string { return s + strings.Repeat(" ", w-len([]rune(s))) }
	line := func(vals []string) {
		parts := make([]string, len(vals))
		for i, v := range vals {
			parts[i] = pad(v, widths[i])
		}
		fmt.Println(strings.TrimRight(strings.Join(parts, "  "), " "))
	}
	line(columns)
	rules := make([]string, len(columns))
	for i, w := range widths {
		rules[i] = strings.Repeat("─", w)
	}
	line(rules)
	for _, row := range cells {
		line(row)
	}
}

func renderStats(d *LogStats) {
	fmt.Printf("rows    %d\n", d.Rows)
	fmt.Printf("bytes   %d (%.1f KiB)\n", d.Bytes, float64(d.Bytes)/1024)
	levels := make([]string, 0, len(d.ByLevel))
	for k := range d.ByLevel {
		levels = append(levels, k)
	}
	sort.Slice(levels, func(i, j int) bool { return d.ByLevel[levels[i]] > d.ByLevel[levels[j]] })
	lv := make([]string, len(levels))
	for i, k := range levels {
		lv[i] = fmt.Sprintf("%s %d", k, d.ByLevel[k])
	}
	fmt.Printf("levels  %s\n", orNone(strings.Join(lv, "  ·  ")))
	sc := make([]string, len(d.TopScopes))
	for i, s := range d.TopScopes {
		sc[i] = fmt.Sprintf("%s %d", orNone(s.Scope), s.Count)
	}
	fmt.Printf("scopes  %s\n", orNone(strings.Join(sc, "  ·  ")))
	for _, p := range d.Pages {
		fmt.Printf("page    %s  %s → %s  (%d)\n", p.ID, fmtTs(p.First), fmtTs(p.Last), p.Count)
	}
}

func orNone(s string) string {
	if s == "" {
		return "(none)"
	}
	return s
}

// --- REPL ---

func repl(conn *websocket.Conn) {
	fmt.Println("glyph3d-cli REPL. Type '.help' for meta commands, '.exit' to quit.")
	scanner := bufio.NewScanner(os.Stdin)
	for {
		fmt.Print("glyph3d> ")
		if !scanner.Scan() {
			break
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		switch line {
		case ".exit", ".quit":
			return
		case ".json on":
			*jsonMode = true
			fmt.Println("JSON mode on")
			continue
		case ".json off":
			*jsonMode = false
			fmt.Println("JSON mode off")
			continue
		case ".help":
			fmt.Println("  .exit / .quit   Exit REPL")
			fmt.Println("  .json on/off    Toggle JSON output")
			fmt.Println("  .help           This help")
			fmt.Println("  Any other input is sent as a command line (try: help).")
			continue
		}
		resp, err := sendLine(conn, line, *timeout)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			continue
		}
		printResponse(verbOf(line), resp)
	}
}

// --- screenshot ---

// screenshotCmd issues any --cmd verb lines in order on one connection, lets their
// async work settle, then captures the LIVE canvas through the `screenshot` verb
// (a forced render read back in the same turn) and writes the PNG. It attaches to
// whatever display holds the relay — it never launches one.
func screenshotCmd(url string, args []string) int {
	fs := flag.NewFlagSet("screenshot", flag.ExitOnError)
	out := fs.String("o", "/tmp/glyph-screenshot.png", "Output PNG path")
	var cmds stringListFlag
	fs.Var(&cmds, "cmd", "Verb line to run before the capture (repeatable, runs in order)")
	wait := fs.Duration("wait", 300*time.Millisecond, "Settle time after the last --cmd before capturing")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: glyph3d-cli [--port N] [--json] screenshot [-o out.png] [--cmd 'verb …']... [--wait 300ms]")
		fs.PrintDefaults()
	}
	fs.Parse(args)
	if fs.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "screenshot: unexpected argument %q (a verb goes in --cmd '%s')\n", fs.Arg(0), fs.Arg(0))
		return 2
	}

	conn := mustConnect(url)
	defer conn.Close()

	// Verb lines may start a load or a fly — give them the longer of --timeout and 15s.
	cmdWithin := max(*timeout, 15*time.Second)
	for _, c := range cmds {
		resp, err := sendLine(conn, c, cmdWithin)
		if err != nil {
			fmt.Fprintf(os.Stderr, "screenshot: --cmd %q: %v\n", c, err)
			return 1
		}
		fmt.Fprintf(os.Stderr, "cmd: %s → %s\n", c, lastLine(resp.Text))
		if resp.failed() {
			return 1
		}
	}
	if len(cmds) > 0 && *wait > 0 {
		time.Sleep(*wait)
	}

	resp, err := sendLine(conn, "screenshot", max(*timeout, 20*time.Second))
	if err != nil {
		fmt.Fprintf(os.Stderr, "screenshot: %v\n", err)
		return 1
	}
	if resp.failed() {
		fmt.Fprintln(os.Stderr, resp.Text)
		return 1
	}
	var data struct {
		Width  int    `json:"width"`
		Height int    `json:"height"`
		Image  string `json:"image"`
	}
	if err := json.Unmarshal(resp.Data, &data); err != nil || data.Image == "" {
		fmt.Fprintf(os.Stderr, "screenshot: reply carried no image (%s)\n", resp.Text)
		return 1
	}
	img, err := base64.StdEncoding.DecodeString(data.Image)
	if err != nil {
		fmt.Fprintf(os.Stderr, "screenshot: decode image: %v\n", err)
		return 1
	}
	if err := os.WriteFile(*out, img, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "screenshot: %v\n", err)
		return 1
	}
	// A truly blank canvas PNG-compresses to a few KB — say so rather than let an
	// empty frame pass as a capture.
	note := ""
	if len(img) < 16*1024 {
		note = "  (suspiciously small: the canvas may be blank)"
	}
	fmt.Fprintf(os.Stderr, "Saved %dx%d screenshot to %s (%d bytes)%s\n", data.Width, data.Height, *out, len(img), note)
	if *jsonMode {
		j, _ := json.Marshal(map[string]any{"out": *out, "width": data.Width, "height": data.Height, "bytes": len(img)})
		fmt.Println(string(j))
	}
	return 0
}

// lastLine is a reply's last non-empty line — a verb's text ends with its OK:/ERR: summary.
func lastLine(s string) string {
	s = strings.TrimRight(s, "\n ")
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		return s[i+1:]
	}
	return s
}

// --- log.follow ---

// logFollowCmd subscribes to the relay's live log feed ({"relay":"log.follow"}) and
// renders every stored record as it lands — a push subscription, lossless, no polling.
// The narrowing flags filter client-side; the feed itself is everything.
func logFollowCmd(url string, args []string) int {
	fs := flag.NewFlagSet("log.follow", flag.ExitOnError)
	filter := fs.String("filter", "", "Only records whose msg contains this (case-insensitive)")
	levels := fs.String("level", "", "Only these levels, comma-separated (e.g. error,warn)")
	scope := fs.String("scope", "", "Only this scope")
	levelSet := fs.String("level-set", "", "Send 'log.level <LVL>' to the page once subscribed")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: glyph3d-cli [--port N] [--json] log.follow [--filter s] [--level csv] [--scope s] [--level-set LVL]")
		fs.PrintDefaults()
	}
	fs.Parse(args)

	levelSel := map[string]bool{}
	for _, l := range strings.Split(*levels, ",") {
		if l = strings.ToLower(strings.TrimSpace(l)); l != "" {
			levelSel[l] = true
		}
	}
	needle := strings.ToLower(*filter)

	conn := mustConnect(url)
	defer conn.Close()
	if err := conn.WriteJSON(map[string]string{"relay": "log.follow"}); err != nil {
		fmt.Fprintf(os.Stderr, "log.follow: %v\n", err)
		return 1
	}
	if *levelSet != "" {
		if err := conn.WriteMessage(websocket.TextMessage, []byte("log.level "+*levelSet)); err != nil {
			fmt.Fprintf(os.Stderr, "log.level: %v\n", err)
			return 1
		}
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	go func() {
		<-stop
		conn.Close()
		os.Exit(0)
	}()

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			fmt.Fprintf(os.Stderr, "relay closed: %v\n", err)
			return 1
		}
		var m struct {
			Event string          `json:"event"`
			Data  json.RawMessage `json:"data"`
			OK    *bool           `json:"ok"`
			Error string          `json:"error"`
		}
		if json.Unmarshal(msg, &m) != nil || m.Event == "" {
			// A reply (e.g. to --level-set) rather than a record.
			resp, _ := parseReply(msg)
			fmt.Fprintln(os.Stderr, resp.Text)
			continue
		}
		switch m.Event {
		case "browser.log":
			var rec LogRec
			if json.Unmarshal(m.Data, &rec) != nil {
				continue
			}
			if len(levelSel) > 0 && !levelSel[strings.ToLower(rec.Level)] {
				continue
			}
			if *scope != "" && (rec.Scope == nil || *rec.Scope != *scope) {
				continue
			}
			if needle != "" && !strings.Contains(strings.ToLower(rec.Msg), needle) {
				continue
			}
			if *jsonMode {
				fmt.Println(string(m.Data))
			} else {
				fmt.Println(renderLogRec(&rec))
			}
		case "log.follow":
			if m.OK == nil || !*m.OK {
				fmt.Fprintf(os.Stderr, "log.follow refused: %s\n", m.Error)
				return 1
			}
			fmt.Fprintf(os.Stderr, "following %s (push feed)\n", url)
		}
	}
}

// --- seed-history ---

// seedHistoryCmd pulls each terminal's tmux scrollback and pushes it into the 3D
// terminal's depth-history ring (terminal.depth.seed), so history that already
// exists shows receding in space. The ring is in-memory — re-run after a reload;
// tmux is the durable source.
func seedHistoryCmd(url string, args []string) int {
	fs := flag.NewFlagSet("seed-history", flag.ExitOnError)
	lines := fs.Int("lines", 300, "Scrollback rows to capture per terminal")
	socket := fs.String("tmux-socket", tmuxSocket, "tmux socket (-L name) the relay's terminals live on")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: glyph3d-cli [--port N] seed-history [--lines 300] [--tmux-socket glyphd] [id ...]")
		fs.PrintDefaults()
	}
	fs.Parse(args)

	conn := mustConnect(url)
	defer conn.Close()

	ids := fs.Args()
	if len(ids) == 0 {
		resp, err := sendLine(conn, "terminal.list", *timeout)
		if err != nil || resp.failed() {
			fmt.Fprintf(os.Stderr, "seed-history: terminal.list: %v %s\n", err, respText(resp))
			return 1
		}
		var d struct {
			Terminals []struct {
				ID string `json:"id"`
			} `json:"terminals"`
		}
		json.Unmarshal(resp.Data, &d)
		for _, t := range d.Terminals {
			ids = append(ids, t.ID)
		}
	}
	if len(ids) == 0 {
		fmt.Println("seed-history: no terminals to seed")
		return 0
	}

	failed := 0
	for _, id := range ids {
		session := "glyph-" + id
		// -S -<lines>: start that many rows into scrollback; -E -1: end one row ABOVE
		// the visible screen (pure scrollback — no duplicate of the live grid).
		text, err := exec.Command("tmux", "-L", *socket, "capture-pane", "-p", "-t", session,
			"-S", fmt.Sprint(-*lines), "-E", "-1").Output()
		if err != nil {
			fmt.Printf("  ✗ %s: capture-pane failed (no session '%s' on -L %s?)\n", id, session, *socket)
			failed++
			continue
		}
		resp, err := sendArgv(conn, []string{"terminal.depth.seed", id, string(text)}, *timeout)
		if err != nil || resp.failed() {
			fmt.Printf("  ✗ %s: %v %s\n", id, err, respText(resp))
			failed++
			continue
		}
		fmt.Printf("  %s: %s\n", id, lastLine(resp.Text))
	}
	if failed > 0 {
		return 1
	}
	return 0
}

func respText(r *Response) string {
	if r == nil {
		return ""
	}
	return r.Text
}

package main

import (
	"encoding/base64"
	"reflect"
	"testing"
)

// The bundle must carry what a typed line can't: spaces, quotes, newlines, the empty
// arg, multibyte text.
func TestCallLineRoundTrip(t *testing.T) {
	argv := []string{"grid.create", "line one\nline \"two\"", "", "名前 ✓"}
	line, err := callLine(argv)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := parseCallLine(line)
	if !ok || !reflect.DeepEqual(got, argv) {
		t.Fatalf("round trip: got %q ok=%v, want %q", got, ok, argv)
	}
}

func TestParseCallLineForms(t *testing.T) {
	enc := func(s string) string { return "call " + base64.StdEncoding.EncodeToString([]byte(s)) }
	cases := []struct {
		line string
		want []string
	}{
		{enc(`{"cmd":"log.search","args":["grid list","--limit",5]}`), []string{"log.search", "grid list", "--limit", "5"}},
		{"call " + base64.URLEncoding.EncodeToString([]byte(`["a","??>"]`)), []string{"a", "??>"}},
		{"call " + base64.RawStdEncoding.EncodeToString([]byte(`["x"]`)), []string{"x"}},
	}
	for _, c := range cases {
		got, ok := parseCallLine(c.line)
		if !ok || !reflect.DeepEqual(got, c.want) {
			t.Errorf("parseCallLine(%q) = %q ok=%v, want %q", c.line, got, ok, c.want)
		}
	}
	for _, bad := range []string{"grid.list", "call !!!", enc(`[]`), enc(`[3,"x"]`), enc(`{"args":[]}`)} {
		if argv, ok := parseCallLine(bad); ok {
			t.Errorf("parseCallLine(%q) accepted: %q", bad, argv)
		}
	}
}

// A bundle naming a relay-resident verb is answered by the relay with the same rest a
// typed line carries; any other bundle is the display's.
func TestSplitRelayVerbUnwrapsCall(t *testing.T) {
	line, _ := callLine([]string{"log.query", "SELECT level, count(*) FROM logs GROUP BY level"})
	verb, rest, ok := splitRelayVerb(line)
	if !ok || verb != "log.query" || rest != "SELECT level, count(*) FROM logs GROUP BY level" {
		t.Fatalf("relay verb bundle: verb=%q rest=%q ok=%v", verb, rest, ok)
	}
	typedVerb, typedRest, _ := splitRelayVerb("log.search grid --since 5m")
	line, _ = callLine([]string{"log.search", "grid", "--since", "5m"})
	if v, r, ok := splitRelayVerb(line); !ok || v != typedVerb || r != typedRest {
		t.Fatalf("bundle and typed line disagree: (%q %q) vs (%q %q)", v, r, typedVerb, typedRest)
	}
	line, _ = callLine([]string{"grid.list"})
	if _, _, ok := splitRelayVerb(line); ok {
		t.Fatal("a display verb's bundle was claimed by the relay")
	}
}

func TestParseReplySkipsPushedEvents(t *testing.T) {
	if _, event := parseReply([]byte(`{"event":"browser.log","data":{"msg":"x"}}`)); !event {
		t.Error("a pushed browser.log was taken as a reply")
	}
	r, event := parseReply([]byte(`{"response":"3 hit(s)","data":{"entries":[]}}`))
	if event || r.Text != "3 hit(s)" || !r.hasData() {
		t.Errorf("JSON reply: %+v event=%v", r, event)
	}
	r, _ = parseReply([]byte(`ERR: no display connected.`))
	if !r.failed() || r.hasData() {
		t.Errorf("plain reply: %+v", r)
	}
}

func TestRenderLogRec(t *testing.T) {
	scope := "command"
	rec := &LogRec{TS: 0, Level: "warn", Scope: &scope, Msg: "grid.list", Repeat: 3}
	got := renderLogRec(rec)
	want := fmtTs(0) + " warn  [command] grid.list ×3"
	if got != want {
		t.Fatalf("renderLogRec = %q, want %q", got, want)
	}
}

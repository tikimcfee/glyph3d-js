package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// answer runs a point verb on a store as `caller`, returning its reply text, data and any error.
func answer(s *pointStore, caller string, argv ...string) (text string, data any, err error, ok bool) {
	ok = s.pointCommand(argv, caller, func(t string, d any) { text, data = t, d }, func(e error) { err = e })
	return
}

// TestPoints_ShowKeepsOnePerAgent: an identified point.show with no display is kept, one per
// agent (a second replaces the first), as the arguments that recreate it.
func TestPoints_ShowKeepsOnePerAgent(t *testing.T) {
	s := newPointStore(defaultMaxPoints)
	if _, _, err, ok := answer(s, "agent-a", "point.show", "src/x.js:12", "--kind", "suggest", "--with", "x = 1"); !ok || err != nil {
		t.Fatalf("point.show: ok=%v err=%v", ok, err)
	}
	answer(s, "agent-b", "point.show", "term-2 line 4")
	text, _, err, _ := answer(s, "agent-a", "point.show", "src/x.js:13", "--say", "this one")
	if err != nil || !strings.Contains(text, "kept by the relay") {
		t.Fatalf("second point.show: %q %v", text, err)
	}
	got := s.List()
	if len(got) != 2 {
		t.Fatalf("want one per agent (2), got %+v", got)
	}
	for _, p := range got {
		if p.Who == "agent-a" && strings.Join(p.Args, " ") != "src/x.js:13 --say this one" {
			t.Errorf("agent-a's point is its last: %v", p.Args)
		}
	}
}

// TestPoints_Refusals: what the display would refuse, the relay refuses (an anonymous point, a
// bad kind, --with without suggest, no ref); a non-point verb is not answered.
func TestPoints_Refusals(t *testing.T) {
	s := newPointStore(defaultMaxPoints)
	for _, c := range []struct {
		caller string
		argv   []string
	}{
		{"", []string{"point.show", "src/x.js:1"}},
		{"a", []string{"point.show", "src/x.js:1", "--kind", "glance"}},
		{"a", []string{"point.show", "src/x.js:1", "--with", "y"}},
		{"a", []string{"point.show", "--say", "hi"}},
		{"a", []string{"point.clear", "someone-else"}},
	} {
		if _, _, err, ok := answer(s, c.caller, c.argv...); !ok || err == nil {
			t.Errorf("%q as %q: want refused, got ok=%v err=%v", c.argv, c.caller, ok, err)
		}
	}
	if len(s.List()) != 0 {
		t.Errorf("nothing refused is kept: %+v", s.List())
	}
	if _, _, _, ok := answer(s, "a", "grid.list"); ok {
		t.Error("a non-point verb is not answered by the store")
	}
}

// TestPoints_ClearAndList: an agent clears its own; the person (anonymous) one by name or all.
func TestPoints_ClearAndList(t *testing.T) {
	s := newPointStore(defaultMaxPoints)
	for _, who := range []string{"a", "b", "c"} {
		answer(s, who, "point.show", fmt.Sprintf("src/%s.js:1", who))
	}
	answer(s, "a", "point.clear")
	answer(s, "", "point.clear", "b")
	text, data, _, _ := answer(s, "", "point.list")
	if pts := data.([]storedPoint); len(pts) != 1 || pts[0].Who != "c" || !strings.Contains(text, "c [kept] src/c.js:1") {
		t.Fatalf("after clears: %q %+v", text, data)
	}
	answer(s, "", "point.clear", "all")
	if len(s.List()) != 0 {
		t.Errorf("clear all: %+v", s.List())
	}
}

// TestPoints_Cap: past the cap the oldest point leaves.
func TestPoints_Cap(t *testing.T) {
	s := newPointStore(2)
	s.Put("a", []string{"x:1"}, 1)
	s.Put("b", []string{"x:2"}, 2)
	s.Put("c", []string{"x:3"}, 3)
	got := s.List()
	if len(got) != 2 || got[0].Who != "c" || got[1].Who != "b" {
		t.Fatalf("cap 2 keeps the newest two, newest first: %+v", got)
	}
}

// TestPoints_RPC: points/list delivers what was kept with no display; points/sync (the display's
// live points) replaces the store — a reload's display gets back exactly what it had.
func TestPoints_RPC(t *testing.T) {
	s := newPointStore(defaultMaxPoints)
	answer(s, "agent-a", "point.show", "src/x.js:12")
	res, err := s.rpc("points/list", nil)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(res)
	if !strings.Contains(string(b), `"who":"agent-a"`) || !strings.Contains(string(b), `"args":["src/x.js:12"]`) {
		t.Fatalf("points/list: %s", b)
	}
	sync := `{"points":[{"who":"agent-b","args":["{\"kind\":\"code\"}","--kind","look"],"ts":5}]}`
	if _, err := s.rpc("points/sync", json.RawMessage(sync)); err != nil {
		t.Fatal(err)
	}
	got := s.List()
	if len(got) != 1 || got[0].Who != "agent-b" || got[0].Args[0] != `{"kind":"code"}` {
		t.Fatalf("points/sync replaces the store with the display's live points: %+v", got)
	}
	if _, err := s.rpc("points/sync", json.RawMessage(`{bad`)); err == nil {
		t.Error("a malformed sync is an error the display hears")
	}
	if _, err := s.rpc("points/nope", nil); err == nil {
		t.Error("an unknown points/ method is an error")
	}
}

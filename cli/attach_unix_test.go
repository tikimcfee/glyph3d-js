//go:build !windows

package main

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
)

// TestWheelIsTermdsMouseOp: an alternate-screen wheel is one `mouse` wheel notch per line at the
// pointer's cell (termd reports it or makes it a cursor key); a brain without `mouse` gets none.
func TestWheelIsTermdsMouseOp(t *testing.T) {
	cur, _ := pipeClient(t, []string{"key", "paste", "option_as_alt", "mouse"}, 0)
	s := &termdSession{tc: cur, handle: 4}
	got := s.wheel(2, cellPoint{Col: 3.5, Row: 7})
	notch := map[string]any{"handle": uint32(4), "action": "press", "button": "wheel-up", "col": 3.5, "row": 7.0}
	if !reflect.DeepEqual(got, []map[string]any{notch, notch}) {
		t.Fatalf("two notches up = %v", got)
	}
	if got := s.wheel(-1, cellPoint{}); len(got) != 1 || got[0]["button"] != "wheel-down" {
		t.Fatalf("one notch down = %v", got)
	}
	if got := s.wheel(0, cellPoint{}); len(got) != 0 {
		t.Fatalf("no lines, yet %v", got)
	}
	old, read := pipeClient(t, []string{"key", "paste", "option_as_alt"}, 0)
	if got := (&termdSession{tc: old, handle: 4}).wheel(3, cellPoint{}); got != nil || read() != 0 {
		t.Fatalf("a 1.3 brain got the wheel as %v", got)
	}
}

// TestMouseFieldsAreTermdsMouseOp: a display's pointer event goes to termd as its `mouse` op, and
// only to a brain that announces it (logged once, never sent to an older one).
func TestMouseFieldsAreTermdsMouseOp(t *testing.T) {
	m := termdMouse{Action: "move", Button: "none", Col: 4.25, Row: 2, Mods: []string{"Control"}}
	want := map[string]any{"handle": uint32(9), "action": "move", "button": "none", "col": 4.25, "row": 2.0, "mods": []string{"Control"}}
	if got := m.fields(9); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	f := termdMouse{Button: float64(8)}.fields(1)
	if _, has := f["mods"]; has || f["button"] != float64(8) {
		t.Fatalf("an extra button with no mods = %v", f)
	}
	old, read := pipeClient(t, []string{"key", "paste"}, 0)
	s := &termdSession{tc: old, handle: 1}
	if s.offers("mouse") || s.offers("mouse") || read() != 0 {
		t.Fatal("a brain without `mouse` offers it")
	}
	cur, _ := pipeClient(t, []string{"key", "paste", "mouse"}, 0)
	if !(&termdSession{tc: cur}).offers("mouse") {
		t.Fatal("a 1.4 brain lacks mouse")
	}
}

func TestKeyFieldsAreTermdsKeyOp(t *testing.T) {
	k := termdKey{Code: "KeyC", Key: "c", Mods: []string{"Control"}, Text: "c"}
	got := k.fields(7, true)
	want := map[string]any{"handle": uint32(7), "code": "KeyC", "key": "c", "text": "c", "mods": []string{"Control"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if _, has := (termdKey{Code: "Enter", Key: "Enter"}).fields(1, true)["mods"]; has {
		t.Fatal("no mods is no field")
	}
}

// TestKeyOptionAsAltFollowsTheBrainsFeatures: the display's option_as_alt ("auto", true, false)
// reaches a brain that announces `option_as_alt` as sent, and a brain without it (protocol 1.2)
// gets the key without the field (which it would ignore anyway, silently).
func TestKeyOptionAsAltFollowsTheBrainsFeatures(t *testing.T) {
	var k termdKey
	if err := json.Unmarshal([]byte(`{"code":"KeyA","key":"å","mods":["Alt"],"text":"å","option_as_alt":false}`), &k); err != nil {
		t.Fatal(err)
	}
	cur, _ := pipeClient(t, []string{"key", "paste", "option_as_alt"}, 0)
	if got, ok := (&termdSession{tc: cur, handle: 3}).keyFields(k)["option_as_alt"]; !ok || got != false {
		t.Fatalf("a 1.3 brain gets option_as_alt = %v (%v), want false", got, ok)
	}
	for _, v := range []string{`"auto"`, `true`} {
		var k termdKey
		json.Unmarshal([]byte(`{"code":"KeyA","key":"a","option_as_alt":`+v+`}`), &k)
		got, _ := json.Marshal((&termdSession{tc: cur, handle: 3}).keyFields(k)["option_as_alt"])
		if string(got) != v {
			t.Fatalf("option_as_alt %s went as %s", v, got)
		}
	}
	old, _ := pipeClient(t, []string{"key", "paste"}, 0)
	if f, has := (&termdSession{tc: old, handle: 3}).keyFields(k)["option_as_alt"]; has {
		t.Fatalf("a brain without the feature got option_as_alt = %v", f)
	}
	if _, has := (&termdSession{tc: cur, handle: 3}).keyFields(termdKey{Code: "KeyA"})["option_as_alt"]; has {
		t.Fatal("an unsent option_as_alt went out")
	}
}

func TestHandleInboundRoutesOnlyItsOwnTerminal(t *testing.T) {
	var got []string
	h := inboundHandlers{
		bytes: func(b []byte) { got = append(got, "bytes:"+string(b)) },
		key: func(k termdKey) {
			got = append(got, fmt.Sprintf("key:%s/%s/%v/%q/%s", k.Code, k.Key, k.Mods, k.Text, k.Action))
		},
		paste:  func(text string) { got = append(got, "paste:"+text) },
		resize: func(c, r int) { got = append(got, "resize") },
		mouse: func(m termdMouse) {
			got = append(got, fmt.Sprintf("mouse:%s/%v/%g,%g/%v", m.Action, m.Button, m.Col, m.Row, m.Mods))
		},
		scroll: func(n int, at *cellPoint) {
			if at == nil {
				got = append(got, fmt.Sprintf("scroll:%d", n))
			} else {
				got = append(got, fmt.Sprintf("scroll:%d@%g,%g", n, at.Col, at.Row))
			}
		},
		scrollTo: func(off int) {
			got = append(got, fmt.Sprintf("scrollTo:%d", off))
		},
		refresh:  func() { got = append(got, "refresh") },
		kill:     func() { got = append(got, "kill") },
		recreate: func() { got = append(got, "recreate") },
	}
	handleInbound([]byte(`{"event":"terminal.bytes","data":{"terminalId":"t1","b64":"aGk="}}`), "t1", h)
	handleInbound([]byte(`{"event":"terminal.bytes","data":{"terminalId":"t2","b64":"aGk="}}`), "t1", h)
	handleInbound([]byte(`{"event":"terminal.key","data":{"terminalId":"t1","code":"Enter","key":"Enter","mods":["Shift"],"text":"","action":"press"}}`), "t1", h)
	handleInbound([]byte(`{"event":"terminal.key","data":{"terminalId":"t1","code":"KeyA","key":"a","mods":["Control"],"text":"a"}}`), "t1", h)
	handleInbound([]byte(`{"event":"terminal.key","data":{"terminalId":"t2","code":"KeyA","key":"a","text":"a"}}`), "t1", h)
	handleInbound([]byte(`{"event":"terminal.paste","data":{"terminalId":"t1","text":"one\ntwo"}}`), "t1", h)
	handleInbound([]byte(`{"event":"terminal.mouse","data":{"terminalId":"t1","action":"press","button":"left","col":3.5,"row":0,"mods":["Control"]}}`), "t1", h)
	handleInbound([]byte(`{"event":"terminal.mouse","data":{"terminalId":"t1","action":"move","button":"none","col":1,"row":2}}`), "t1", h)
	handleInbound([]byte(`{"event":"terminal.mouse","data":{"terminalId":"t1","action":"press","button":8}}`), "t1", h)
	handleInbound([]byte(`{"event":"terminal.mouse","data":{"terminalId":"t2","action":"press","button":"left","col":0,"row":0}}`), "t1", h)
	handleInbound([]byte(`{"event":"terminal.scroll","data":{"terminalId":"t1","lines":-2}}`), "t1", h)
	handleInbound([]byte(`{"event":"terminal.scroll","data":{"terminalId":"t1","lines":3,"col":10.5,"row":4}}`), "t1", h)
	handleInbound([]byte(`{"event":"terminal.scroll","data":{"terminalId":"t1","live":true}}`), "t1", h)
	handleInbound([]byte(`{"event":"terminal.scroll","data":{"terminalId":"t1","live":true,"offset":42}}`), "t1", h)
	handleInbound([]byte(`{"event":"terminal.scroll","data":{"terminalId":"t2","live":true,"offset":10}}`), "t1", h)
	handleInbound([]byte(`{"event":"terminal.refresh","data":{"terminalId":"t1"}}`), "t1", h)
	handleInbound([]byte(`ERR: no terminal 't1'`), "t1", h)
	want := []string{"bytes:hi", `key:Enter/Enter/[Shift]/""/press`, `key:KeyA/a/[Control]/"a"/`, "paste:one\ntwo",
		"mouse:press/left/3.5,0/[Control]", "mouse:move/none/1,2/[]", "scroll:-2", "scroll:3@10.5,4", "scrollTo:0", "scrollTo:42", "refresh", "recreate"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// The relay creates as a creator with no shell: no env_base and no env, so its terminals start
// from the desktop session's environment, never the relay's own.
func TestTermdCreateSendsNoEnvironment(t *testing.T) {
	for _, cfg := range []terminalConfig{
		{id: "t1", cols: 80, rows: 24},
		{id: "t2", cols: 80, rows: 24, cmdArgs: []string{"htop"}, cwd: "/srv"},
	} {
		c := termdCreate(cfg)
		for _, k := range []string{"env_base", "env"} {
			if _, ok := c[k]; ok {
				t.Errorf("%s: create carries %s: %v", cfg.id, k, c)
			}
		}
		if c["if_exists"] != "adopt" || c["id"] != cfg.id {
			t.Errorf("%s: %v", cfg.id, c)
		}
	}
	if _, ok := termdCreate(terminalConfig{id: "t3", cols: 1, rows: 1})["argv"]; ok {
		t.Error("no command, yet an argv: termd chooses the account's shell")
	}
}

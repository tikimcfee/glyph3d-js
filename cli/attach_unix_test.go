//go:build !windows

package main

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
)

func TestWheelBytes(t *testing.T) {
	if got := string(wheelBytes(2, true, 80, 24)); got != "\x1b[<64;40;12M\x1b[<64;40;12M" {
		t.Errorf("sgr up = %q", got)
	}
	if got := string(wheelBytes(-1, false, 80, 24)); got != "\x1b[B" {
		t.Errorf("arrows down = %q", got)
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
		paste:    func(text string) { got = append(got, "paste:"+text) },
		resize:   func(c, r int) { got = append(got, "resize") },
		scroll:   func(n int) { got = append(got, "scroll") },
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
	handleInbound([]byte(`{"event":"terminal.refresh","data":{"terminalId":"t1"}}`), "t1", h)
	handleInbound([]byte(`ERR: no terminal 't1'`), "t1", h)
	want := []string{"bytes:hi", `key:Enter/Enter/[Shift]/""/press`, `key:KeyA/a/[Control]/"a"/`, "paste:one\ntwo", "refresh", "recreate"}
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

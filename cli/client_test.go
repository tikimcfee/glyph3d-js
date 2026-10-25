package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// A one-shot keeps its old meaning wherever a typed line can carry it, and rides the
// bundle only when an argument needs carrying.
func TestOneShotLine(t *testing.T) {
	bundle := func(argv ...string) string { l, _ := callLine(argv); return l }
	cases := []struct {
		name string
		args []string
		want string
	}{
		// The whole command quoted as one arg: the caller wrote a line.
		{"quoted command", []string{"camera.fly 0 0 10"}, "camera.fly 0 0 10"},
		{"quoted command + args", []string{"camera.fly 0 0", "10"}, "camera.fly 0 0 10"},
		// Relay protocol words must reach the relay as the raw string it matches.
		{"whoami", []string{"whoami"}, "whoami"},
		{"ping", []string{"ping"}, "ping"},
		// The hatch itself, typed: never double-wrapped.
		{"call hatch", []string{"call", "WyJncmlkLmxpc3QiXQ=="}, "call WyJncmlkLmxpc3QiXQ=="},
		{"plain argv", []string{"log.search", "grid", "--since", "5m"}, "log.search grid --since 5m"},
		// An argument the tokenizer would split, strip or drop rides the bundle.
		{"spaced arg", []string{"label.create", "hello world", "0", "0", "0"}, bundle("label.create", "hello world", "0", "0", "0")},
		{"quote", []string{"grid.create", `say "hi"`}, bundle("grid.create", `say "hi"`)},
		{"backslash", []string{"grid.create", `a\nb`}, bundle("grid.create", `a\nb`)},
		{"newline", []string{"grid.create", "a\nb"}, bundle("grid.create", "a\nb")},
		{"empty arg", []string{"tour.stop", "t", "0", ""}, bundle("tour.stop", "t", "0", "")},
	}
	for _, c := range cases {
		got, err := oneShotLine(c.args)
		if err != nil || got != c.want {
			t.Errorf("%s: oneShotLine(%q) = %q, %v; want %q", c.name, c.args, got, err, c.want)
		}
	}
	if _, err := oneShotLine(nil); err == nil {
		t.Error("an empty argv was accepted")
	}
}

// fakeRelay answers the controller handshake, then each command line with
// "OK: <line>" — except lines starting with "slow", which it never answers.
func fakeRelay(t *testing.T) string {
	t.Helper()
	up := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil {
				return
			}
			line := string(msg)
			switch {
			case line == "ping":
				ws.WriteMessage(websocket.TextMessage, []byte("OK: connected as ctrl-0"))
				ws.WriteMessage(websocket.TextMessage, []byte("pong"))
			case strings.HasPrefix(line, "slow"):
			default:
				// A pushed event first: the reply reader must skip it.
				ws.WriteMessage(websocket.TextMessage, []byte(`{"event":"browser.log","data":{}}`))
				ws.WriteMessage(websocket.TextMessage, []byte("OK: "+line))
			}
		}
	}))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

// One request that outlives its deadline must not poison the requests after it.
func TestSessionSurvivesASlowRequest(t *testing.T) {
	s := openSession(fakeRelay(t))
	defer s.close()
	if _, err := s.send("slow one", 100*time.Millisecond); err == nil {
		t.Fatal("the unanswered request did not time out")
	}
	for _, line := range []string{"terminal.depth.seed a", "terminal.depth.seed b"} {
		resp, err := s.send(line, time.Second)
		if err != nil || resp.Text != "OK: "+line {
			t.Fatalf("after a timeout, %q: %+v %v", line, resp, err)
		}
	}
}

// A reply with data but no summary text prints the data, not a blank line.
func TestPrintResponseDataOnly(t *testing.T) {
	r, w, _ := os.Pipe()
	saved := os.Stdout
	os.Stdout = w
	printResponse("grid.info", &Response{Data: []byte(`{"a":1}`)})
	os.Stdout = saved
	w.Close()
	out, _ := io.ReadAll(r)
	if got := strings.TrimSpace(string(out)); got != "{\n  \"a\": 1\n}" {
		t.Fatalf("printed %q", got)
	}
}

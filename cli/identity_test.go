package main

import (
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Bus identity (identity.go): a controller that greets `AS <name>` has every command it sends
// stamped with that name on its way to the display, while its routing id stays ctrl-N (one agent
// runs parallel one-shots: two connections, one name, two addresses). An anonymous controller is
// stamped with nothing; a bad name is refused loud and the connection closed.

// TestMain keeps the package's tests hermetic: the environment's $AGENT_NAME (an agent running
// the suite) must not name every test's connection — the fake relays in client_test.go speak only
// the anonymous handshake. Tests that want a name use connectAs.
func TestMain(m *testing.M) {
	*asName = ""
	os.Exit(m.Run())
}

func identityRelay(t *testing.T) (url string, display *websocket.Conn) {
	t.Helper()
	r := NewRelay()
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	url = "ws://" + strings.TrimPrefix(srv.URL, "http://")
	d, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial display: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	if err := d.WriteMessage(websocket.TextMessage, []byte("DISPLAY")); err != nil {
		t.Fatalf("display hello: %v", err)
	}
	if ack := readJSON(t, d); ack["role"] != "display" {
		t.Fatalf("display ack: %v", ack)
	}
	return url, d
}

// nextCommand reads display traffic until a forwarded command arrives.
func nextCommand(t *testing.T, d *websocket.Conn) map[string]any {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		m := readJSON(t, d)
		if _, ok := m["cmd"]; ok {
			return m
		}
	}
	t.Fatalf("no command reached the display")
	return nil
}

func TestAsGreetingStampsTheCallerName(t *testing.T) {
	url, d := identityRelay(t)
	c, err := connectAs(url, "glyph3d-js-root-camera")
	if err != nil {
		t.Fatalf("connectAs: %v", err)
	}
	defer c.Close()
	c.WriteMessage(websocket.TextMessage, []byte("grid.list"))
	m := nextCommand(t, d)
	if m["as"] != "glyph3d-js-root-camera" || m["cmd"] != "grid.list" {
		t.Fatalf("forwarded %v, want as=glyph3d-js-root-camera cmd=grid.list", m)
	}
	if from, _ := m["from"].(string); !strings.HasPrefix(from, "ctrl-") {
		t.Fatalf("routing id %q: the name is attribution, not the address", m["from"])
	}
}

func TestAnonymousControllerCarriesNoName(t *testing.T) {
	url, d := identityRelay(t)
	c, err := connectAs(url, "")
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer c.Close()
	c.WriteMessage(websocket.TextMessage, []byte("grid.list"))
	m := nextCommand(t, d)
	if _, named := m["as"]; named {
		t.Fatalf("an anonymous controller was stamped: %v", m)
	}
}

func TestOneNameTwoConnectionsTwoAddresses(t *testing.T) {
	url, d := identityRelay(t)
	a, err := connectAs(url, "agent-x")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := connectAs(url, "agent-x")
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	a.WriteMessage(websocket.TextMessage, []byte("one"))
	ma := nextCommand(t, d)
	b.WriteMessage(websocket.TextMessage, []byte("two"))
	mb := nextCommand(t, d)
	if ma["as"] != "agent-x" || mb["as"] != "agent-x" || ma["from"] == mb["from"] {
		t.Fatalf("same name must keep distinct routing ids: %v / %v", ma, mb)
	}
}

func TestBadCallerNameIsRefused(t *testing.T) {
	url, _ := identityRelay(t)
	for _, bad := range []string{"has space", "semi;colon", strings.Repeat("x", maxCallerName+1)} {
		_, err := connectAs(url, bad)
		if err == nil {
			t.Fatalf("name %q was accepted", bad)
		}
	}
	if _, ok, err := parseAsHandshake("AS"); !ok || err == nil {
		t.Fatalf("a bare AS must be a refused greeting (ok=%v err=%v)", ok, err)
	}
	if _, ok, _ := parseAsHandshake("ASK me"); ok {
		t.Fatalf("ASK is a command, not a greeting")
	}
}

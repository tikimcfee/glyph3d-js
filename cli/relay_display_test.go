package main

import (
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// TestDisplayGoneReachesWhatItPushedTo: when the display leaves, the controllers it pushed events
// to (its terminals' adapters) hear `display.gone`, so a paste of its still arriving in pieces
// ends there rather than holding the terminal's input forever; a controller it never pushed to
// hears nothing.
func TestDisplayGoneReachesWhatItPushedTo(t *testing.T) {
	_, dial := newTestRelay(t)
	adapter := dial(t)
	adapter.WriteMessage(websocket.TextMessage, []byte("terminal.ping t1"))
	_, hello, err := adapter.ReadMessage()
	if err != nil || !strings.HasPrefix(string(hello), "OK: connected as ") {
		t.Fatalf("hello %q: %v", hello, err)
	}
	id := strings.TrimPrefix(string(hello), "OK: connected as ")
	adapter.ReadMessage() // the ping's answer: no display yet
	bystander := dial(t)
	bystander.WriteMessage(websocket.TextMessage, []byte("terminal.ping t2"))
	for range 2 { // its hello, and its ping's answer
		if _, _, err := bystander.ReadMessage(); err != nil {
			t.Fatal(err)
		}
	}

	display := dial(t)
	display.WriteMessage(websocket.TextMessage, []byte("DISPLAY"))
	if m := readJSON(t, display); m["role"] != "display" {
		t.Fatalf("display ack %v", m)
	}
	display.WriteMessage(websocket.TextMessage, []byte(`{"to":"`+id+`","event":"terminal.paste","data":{"terminalId":"t1","text":"piece","more":true}}`))
	if m := awaitEvent(t, adapter, "terminal.paste"); m["data"].(map[string]any)["text"] != "piece" {
		t.Fatalf("paste %v", m)
	}
	display.Close()
	awaitEvent(t, adapter, "display.gone")
	bystander.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	for {
		_, msg, err := bystander.ReadMessage()
		if err != nil {
			break
		}
		if strings.Contains(string(msg), "display.gone") {
			t.Fatalf("a controller the display never pushed to heard display.gone")
		}
	}
}

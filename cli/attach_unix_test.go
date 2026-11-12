//go:build !windows

package main

import (
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

func TestHandleInboundRoutesOnlyItsOwnTerminal(t *testing.T) {
	var got []string
	h := inboundHandlers{
		bytes:    func(b []byte) { got = append(got, "bytes:"+string(b)) },
		resize:   func(c, r int) { got = append(got, "resize") },
		scroll:   func(n int) { got = append(got, "scroll") },
		refresh:  func() { got = append(got, "refresh") },
		kill:     func() { got = append(got, "kill") },
		recreate: func() { got = append(got, "recreate") },
	}
	handleInbound([]byte(`{"event":"terminal.bytes","data":{"terminalId":"t1","b64":"aGk="}}`), "t1", h)
	handleInbound([]byte(`{"event":"terminal.bytes","data":{"terminalId":"t2","b64":"aGk="}}`), "t1", h)
	handleInbound([]byte(`{"event":"terminal.refresh","data":{"terminalId":"t1"}}`), "t1", h)
	handleInbound([]byte(`ERR: no terminal 't1'`), "t1", h)
	if want := []string{"bytes:hi", "refresh", "recreate"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

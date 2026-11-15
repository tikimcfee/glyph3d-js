package main

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

// fakeSink records each chunk; a chunk's reply waits for release when gate is set.
type fakeSink struct {
	mu       sync.Mutex
	chunks   []pastePiece
	stream   bool
	frame    int
	inFlight int
	most     int
	gate     chan struct{}
	fail     map[int]bool // chunk index → its reply is an error
}

func (f *fakeSink) streams() bool { return f.stream }
func (f *fakeSink) maxFrame() int { return f.frame }
func (f *fakeSink) paste(text string, more bool) (bool, error) {
	f.mu.Lock()
	f.chunks = append(f.chunks, pastePiece{text, more})
	n := len(f.chunks) - 1
	f.inFlight++
	if f.inFlight > f.most {
		f.most = f.inFlight
	}
	f.mu.Unlock()
	if f.gate != nil {
		<-f.gate
	}
	f.mu.Lock()
	f.inFlight--
	f.mu.Unlock()
	if f.fail[n] {
		return true, errors.New("termd: refused")
	}
	return true, nil
}

func (f *fakeSink) wait(t *testing.T, n int) []pastePiece {
	t.Helper()
	until := time.Now().Add(5 * time.Second)
	for {
		f.mu.Lock()
		got := append([]pastePiece(nil), f.chunks...)
		f.mu.Unlock()
		if len(got) >= n {
			return got
		}
		if time.Now().After(until) {
			t.Fatalf("%d chunks, want %d: %v", len(got), n, got)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestPasteStreamsInChunksOneAtATime: a long paste goes to termd as chunks of one paste (more on
// all but the last), each on a character's boundary and within max_frame as JSON, and the next
// chunk leaves only once termd answered the one before.
func TestPasteStreamsInChunksOneAtATime(t *testing.T) {
	old := termdPasteChunk
	termdPasteChunk = 10
	defer func() { termdPasteChunk = old }()
	gate := make(chan struct{})
	sink := &fakeSink{stream: true, frame: 16 << 20, gate: gate}
	done := make(chan struct{})
	defer close(done)
	p := newTermdPaster(sink, done)
	text := strings.Repeat("ab€", 9) // 45 bytes, a 3-byte character every 5
	p.add(text[:20], true)           // the display's own pieces: the second ends the paste
	p.add(text[20:], false)
	sink.wait(t, 1)
	time.Sleep(30 * time.Millisecond)
	if got := sink.wait(t, 1); len(got) != 1 {
		t.Fatalf("a second chunk left before the first was answered: %v", got)
	}
	go func() {
		for range 10 {
			gate <- struct{}{}
		}
	}()
	var whole strings.Builder
	got := sink.wait(t, 5) // 20 B in two, 25 B in three
	for i, c := range got {
		if len(c.text) > 10 || !utf8.ValidString(c.text) {
			t.Fatalf("chunk %d %q: over 10 B or cut inside a character", i, c.text)
		}
		if c.more != (i+1 < len(got)) {
			t.Fatalf("chunk %d more=%v of %d", i, c.more, len(got))
		}
		whole.WriteString(c.text)
	}
	if whole.String() != text || sink.most != 1 {
		t.Fatalf("got %q (at most %d in flight), want %q", whole.String(), sink.most, text)
	}
	if n := pasteChunkFor(1024 + 60); n != 10 {
		t.Fatalf("a chunk for max_frame 1084 = %d, want 10 (60/6)", n)
	}
}

// TestPasteDropsTheRestAfterAFailedChunkAndOldBrainsGetItWhole: input is at most once (a failed
// chunk ends its paste; the next paste goes), and a brain without paste_stream gets each paste
// as one request.
func TestPasteDropsTheRestAfterAFailedChunkAndOldBrainsGetItWhole(t *testing.T) {
	done := make(chan struct{})
	defer close(done)
	sink := &fakeSink{stream: true, frame: 16 << 20, fail: map[int]bool{1: true}}
	p := newTermdPaster(sink, done)
	p.add("one", true)
	p.add("two", true)
	p.add("three", false)
	p.add("next", false)
	got := sink.wait(t, 3)
	time.Sleep(30 * time.Millisecond)
	got = sink.wait(t, 3)
	if len(got) != 3 || got[0].text != "one" || got[1].text != "two" || got[2] != (pastePiece{"next", false}) {
		t.Fatalf("got %v", got)
	}

	old := &fakeSink{stream: false, frame: 16 << 20}
	q := newTermdPaster(old, done)
	q.add("a", true)
	q.add("b", false)
	if got := old.wait(t, 1); got[0] != (pastePiece{"ab", false}) {
		t.Fatalf("an old brain got %v", got)
	}
}

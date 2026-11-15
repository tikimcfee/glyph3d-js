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
	sess     int          // the session's name: a test's "brain restart" changes it
}

func (f *fakeSink) streams() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stream
}
func (f *fakeSink) session() any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sess
}

// restart stands for a brain restart: a new session, streaming or not.
func (f *fakeSink) restart(stream bool) {
	f.mu.Lock()
	f.sess++
	f.stream = stream
	f.mu.Unlock()
}

func (f *fakeSink) maxFrame() int { return f.frame }
func (f *fakeSink) paste(text string, more bool) (bool, error) {
	f.mu.Lock()
	f.chunks = append(f.chunks, pastePiece{text: text, more: more})
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
	got := sink.wait(t, 4)
	time.Sleep(30 * time.Millisecond)
	got = sink.wait(t, 4)
	// The failed chunk went with more: termd refuses the rest until a last chunk, which goes, empty.
	if len(got) != 4 || got[0].text != "one" || got[1].text != "two" || got[2] != (pastePiece{}) || got[3] != (pastePiece{text: "next"}) {
		t.Fatalf("got %v", got)
	}

	old := &fakeSink{stream: false, frame: 16 << 20}
	q := newTermdPaster(old, done)
	q.add("a", true)
	q.add("b", false)
	if got := old.wait(t, 1); got[0] != (pastePiece{text: "ab"}) {
		t.Fatalf("an old brain got %v", got)
	}
}

// settle waits for the paster to go quiet, then returns everything sent.
func (f *fakeSink) settle(t *testing.T) []pastePiece {
	t.Helper()
	time.Sleep(50 * time.Millisecond)
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]pastePiece(nil), f.chunks...)
}

func same(got []pastePiece, want ...pastePiece) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

// TestAPasteWhoseDisplayLeavesEndsWithWhatCame: the display reloads mid-paste (the relay says
// display.gone): the open paste is closed at termd, so held keys follow it and the next paste is
// its own, never inside the old one's bracket.
func TestAPasteWhoseDisplayLeavesEndsWithWhatCame(t *testing.T) {
	done := make(chan struct{})
	defer close(done)
	sink := &fakeSink{stream: true, frame: 16 << 20}
	p := newTermdPaster(sink, done)
	p.add("first piece", true)
	sink.wait(t, 1)
	p.displayGone()
	p.add("NEXT-PASTE", false)
	got := sink.wait(t, 3)
	if !same(sink.settle(t), pastePiece{text: "first piece", more: true}, pastePiece{}, pastePiece{text: "NEXT-PASTE"}) {
		t.Fatalf("got %v", got)
	}
	// A display that leaves with no paste open costs termd nothing.
	p.displayGone()
	if got := sink.settle(t); len(got) != 3 {
		t.Fatalf("got %v", got)
	}
}

// TestARestartMidPasteSendsNoneOfTheRest: a paste is one session's; the new brain gets none of
// an old session's paste (it would be a second bracket), and a stale whole-paste buffer from an
// old brain without paste_stream is dropped with it.
func TestARestartMidPasteSendsNoneOfTheRest(t *testing.T) {
	done := make(chan struct{})
	defer close(done)
	sink := &fakeSink{stream: true, frame: 16 << 20}
	p := newTermdPaster(sink, done)
	p.add("one", true)
	sink.wait(t, 1)
	sink.restart(true)
	p.add("two", true)
	p.add("three", false)
	p.add("after", false)
	if got := sink.settle(t); !same(got, pastePiece{text: "one", more: true}, pastePiece{text: "after"}) {
		t.Fatalf("got %v", got)
	}

	old := &fakeSink{stream: false, frame: 16 << 20}
	q := newTermdPaster(old, done)
	q.add("stale", true)
	old.settle(t)
	old.restart(true)
	q.add(" rest", false)
	q.add("fresh", false)
	if got := old.settle(t); !same(got, pastePiece{text: "fresh"}) {
		t.Fatalf("got %v", got)
	}
}

// TestThePasteQueueIsBounded: what waits in the adapter for a program that isn't reading is at
// most termdPasteQueue bytes; a display paste past it is refused whole.
func TestThePasteQueueIsBounded(t *testing.T) {
	old := termdPasteQueue
	termdPasteQueue = 10
	defer func() { termdPasteQueue = old }()
	done := make(chan struct{})
	defer close(done)
	gate := make(chan struct{})
	sink := &fakeSink{stream: true, frame: 16 << 20, gate: gate}
	p := newTermdPaster(sink, done)
	p.add("first", false) // in flight: the program reads nothing
	sink.wait(t, 1)
	p.add("123", true) // queued: 3 B
	p.add("456", false)
	p.add("refused", true) // 6 + 7 > 10: this paste is refused whole
	p.add("rest", false)
	p.add("ok", false)
	p.mu.Lock()
	queued := p.queued
	p.mu.Unlock()
	if queued != 8 {
		t.Fatalf("%d B queued, want 8 (\"123\" \"456\" \"ok\")", queued)
	}
	go func() {
		for range 10 {
			gate <- struct{}{}
		}
	}()
	got := sink.wait(t, 4)
	if got = sink.settle(t); !same(got, pastePiece{text: "first"}, pastePiece{text: "123", more: true}, pastePiece{text: "456"}, pastePiece{text: "ok"}) {
		t.Fatalf("got %v", got)
	}
}

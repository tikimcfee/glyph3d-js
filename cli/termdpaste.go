package main

import (
	"log"
	"sync"
	"unicode/utf8"
)

// termdPasteChunk is the most text one termd `paste` request carries (`attach --paste-chunk`). A
// paste longer than it streams as several, one paste for the program (protocol 1.5, `more`). It
// is also capped by the brain's max_frame: a control character is six bytes as JSON.
var termdPasteChunk = 1 << 20

// pasteChunkFor is the chunk size for a brain whose max_frame is maxFrame.
func pasteChunkFor(maxFrame int) int {
	n := termdPasteChunk
	if fit := (maxFrame - 1024) / 6; fit < n {
		n = fit
	}
	if n < 4 {
		n = 4 // one character, however long its UTF-8
	}
	return n
}

// splitPaste cuts text into pieces of at most max bytes, each ending on a character's boundary.
func splitPaste(text string, max int) []string {
	var out []string
	for len(text) > max {
		cut := max
		for cut > 0 && !utf8.RuneStart(text[cut]) {
			cut--
		}
		out = append(out, text[:cut])
		text = text[cut:]
	}
	return append(out, text)
}

// pastePiece is one piece of a display's paste as it arrived: the display streams a long paste
// in pieces too (terminal.paste with `more`).
type pastePiece struct {
	text string
	more bool
}

// pasteSink is where the paster sends: the current termd session (a brain restart replaces it).
type pasteSink interface {
	// paste sends one chunk and waits for its reply (nil: in the input buffer). ok is false when
	// the session has no `paste` op at all (an old brain), which is dropped as the adapter logs.
	paste(text string, more bool) (ok bool, err error)
	// streams says whether the session takes a paste in chunks (feature `paste_stream`).
	streams() bool
	// maxFrame is the session's max_frame.
	maxFrame() int
}

// termdPaster streams a display's pastes into termd in order, one chunk in flight: each is sent
// once termd has answered the one before, which it does when the bytes are in the program's
// input buffer. That is the paste's flow control: a program that stops reading holds the rest of
// the paste here, in the adapter, the size of the paste the display already held. Input is at
// most once: a chunk that fails ends its paste here (termd has closed it), and the rest of that
// paste is dropped, never replayed into a new session.
type termdPaster struct {
	mu    sync.Mutex
	queue []pastePiece
	wake  chan struct{}
	sink  pasteSink
	done  <-chan struct{}
}

func newTermdPaster(sink pasteSink, done <-chan struct{}) *termdPaster {
	p := &termdPaster{wake: make(chan struct{}, 1), sink: sink, done: done}
	go p.run()
	return p
}

// add queues one piece of a display's paste (more: another piece of the same paste follows).
func (p *termdPaster) add(text string, more bool) {
	p.mu.Lock()
	p.queue = append(p.queue, pastePiece{text, more})
	p.mu.Unlock()
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

func (p *termdPaster) next() (pastePiece, bool) {
	for {
		p.mu.Lock()
		if len(p.queue) > 0 {
			pc := p.queue[0]
			p.queue = p.queue[1:]
			p.mu.Unlock()
			return pc, true
		}
		p.mu.Unlock()
		select {
		case <-p.wake:
		case <-p.done:
			return pastePiece{}, false
		}
	}
}

func (p *termdPaster) run() {
	dropping := false // the rest of a paste whose chunk failed
	var whole []byte  // a brain without paste_stream gets each paste in one request
	for {
		pc, ok := p.next()
		if !ok {
			return
		}
		if dropping {
			dropping = pc.more
			continue
		}
		if !p.sink.streams() {
			whole = append(whole, pc.text...)
			if pc.more {
				continue
			}
			text := string(whole)
			whole = nil
			if _, err := p.sink.paste(text, false); err != nil {
				log.Printf("[attach] termd paste: %v", err)
			}
			continue
		}
		pieces := splitPaste(pc.text, pasteChunkFor(p.sink.maxFrame()))
		for i, t := range pieces {
			more := pc.more || i+1 < len(pieces)
			ok, err := p.sink.paste(t, more)
			if !ok {
				dropping = pc.more
				break
			}
			if err != nil {
				log.Printf("[attach] termd paste: %v; the rest of this paste is dropped", err)
				dropping = pc.more
				break
			}
		}
	}
}

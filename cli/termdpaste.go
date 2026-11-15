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

// termdPasteQueue is the most of the display's pastes, in bytes, that waits in the adapter for a
// program that isn't reading (`attach --paste-queue`). The display can't be held back (its pieces
// arrive as fast as the relay moves them), so this is what bounds the adapter's memory: a display
// paste that doesn't fit is refused whole, as termd refuses a whole INPUT past its input buffer
// (`input_full`), and the one streaming when it filled ends there, closed.
var termdPasteQueue = 256 << 20

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
// in pieces too (terminal.paste with `more`). Every piece of one display paste has its `serial`.
// An `end` piece has no text: the display paste `serial` ends there, with what of it came (its
// display left, or the queue refused the rest).
type pastePiece struct {
	text   string
	more   bool
	serial uint64
	end    bool
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
	// session names the current termd session: a brain restart replaces it.
	session() any
}

// termdPaster streams a display's pastes into termd in order, one chunk in flight: each is sent
// once termd has answered the one before, which it does when the bytes are in the program's
// input buffer. That is the paste's flow control: a program that stops reading holds the rest of
// the display's pastes here, in the adapter, up to termdPasteQueue bytes. Input is at most once,
// and a paste is one session's: a chunk that fails ends its paste (termd has closed it, and is
// sent the paste's last chunk, empty, so it stops refusing the rest), and a session that changes
// mid-paste (a brain restart) is sent none of the rest. Either way the rest of that display paste
// is dropped, never replayed. A display that leaves mid-paste (a reload: the relay's
// `display.gone`) ends its paste with what came, closed.
type termdPaster struct {
	mu       sync.Mutex
	queue    []pastePiece
	queued   int    // bytes of text in queue
	serial   uint64 // the display paste the next piece belongs to
	refusing bool   // the rest of the display paste `serial` is refused (the queue was full)
	wake     chan struct{}
	sink     pasteSink
	done     <-chan struct{}
}

func newTermdPaster(sink pasteSink, done <-chan struct{}) *termdPaster {
	p := &termdPaster{wake: make(chan struct{}, 1), sink: sink, done: done}
	go p.run()
	return p
}

func (p *termdPaster) poke() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// add queues one piece of a display's paste (more: another piece of the same paste follows).
func (p *termdPaster) add(text string, more bool) {
	p.mu.Lock()
	switch {
	case p.refusing:
	case p.queued+len(text) > termdPasteQueue:
		// Refused whole: its pieces still queued go, and if it is the one streaming, it ends
		// where it is.
		kept, dropped := p.queue[:0], 0
		for _, q := range p.queue {
			if q.serial == p.serial {
				dropped += len(q.text)
				continue
			}
			kept = append(kept, q)
		}
		p.queue = append(kept, pastePiece{serial: p.serial, end: true})
		p.queued -= dropped
		log.Printf("[attach] termd paste refused: %d B of the display's pastes already wait for the program (attach --paste-queue %d)", p.queued, termdPasteQueue)
		p.refusing = true
	default:
		p.queue = append(p.queue, pastePiece{text: text, more: more, serial: p.serial})
		p.queued += len(text)
	}
	if !more {
		p.serial++
		p.refusing = false
	}
	p.mu.Unlock()
	p.poke()
}

// displayGone ends the display's paste in progress with what of it came: its display left (the
// relay's `display.gone`), so the rest never will.
func (p *termdPaster) displayGone() {
	p.mu.Lock()
	p.queue = append(p.queue, pastePiece{serial: p.serial, end: true})
	p.serial++
	p.refusing = false
	p.mu.Unlock()
	p.poke()
}

func (p *termdPaster) next() (pastePiece, bool) {
	for {
		p.mu.Lock()
		if len(p.queue) > 0 {
			pc := p.queue[0]
			p.queue = p.queue[1:]
			p.queued -= len(pc.text)
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
	var (
		current  = ^uint64(0) // the display paste being sent
		on       any          // the session it streams into
		open     bool         // termd holds it open: its last chunk went with `more`
		dropping bool         // the rest of it is dropped
		whole    []byte       // a brain without paste_stream gets each paste in one request
	)
	// closeAtTermd sends the paste's last chunk, empty: it closes the bracket of a paste left
	// open, and ends termd's refusal of a refused paste's later chunks.
	closeAtTermd := func() {
		if p.sink.session() != on {
			return // that session, and its paste, are gone
		}
		if _, err := p.sink.paste("", false); err != nil {
			log.Printf("[attach] termd paste: its end: %v", err)
		}
	}
	// send sends one chunk; false: the rest of the paste is dropped.
	send := func(text string, more bool) bool {
		if p.sink.session() != on {
			log.Printf("[attach] termd paste: termd restarted during the paste; the rest of it is dropped")
			return false
		}
		ok, err := p.sink.paste(text, more)
		if !ok {
			return false
		}
		if err != nil {
			log.Printf("[attach] termd paste: %v; the rest of this paste is dropped", err)
			if more {
				closeAtTermd()
			}
			return false
		}
		open = more
		return true
	}
	for {
		pc, ok := p.next()
		if !ok {
			return
		}
		if pc.serial != current {
			current, on, open, dropping, whole = pc.serial, p.sink.session(), false, false, nil
		}
		if dropping {
			continue
		}
		if pc.end {
			if open {
				closeAtTermd()
			}
			open, dropping, whole = false, true, nil
			continue
		}
		if !p.sink.streams() {
			if p.sink.session() != on {
				log.Printf("[attach] termd paste: termd restarted during the paste; the rest of it is dropped")
				dropping, whole = true, nil
				continue
			}
			whole = append(whole, pc.text...)
			if len(whole) > p.sink.maxFrame() {
				log.Printf("[attach] termd paste: %d B, more than this brain takes in one request (max_frame %d); dropped", len(whole), p.sink.maxFrame())
				dropping, whole = true, nil
				continue
			}
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
		if len(whole) > 0 {
			// The session gained paste_stream mid-paste: it is a new one, with none of this.
			log.Printf("[attach] termd paste: termd restarted during the paste; the rest of it is dropped")
			dropping, whole = true, nil
			continue
		}
		pieces := splitPaste(pc.text, pasteChunkFor(p.sink.maxFrame()))
		for i, t := range pieces {
			if !send(t, pc.more || i+1 < len(pieces)) {
				open, dropping = false, true
				break
			}
		}
	}
}

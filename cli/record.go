package main

// Source recordings: the relay writes every sensor frame it receives — raw, exactly as the device
// sent it — to a JSONL file, so a session of real hand data can be replayed later through the
// whole browser pipeline (tools/hand-replay.mjs) without the phone or the person. No public dataset
// exists for a phone face-down under a hand; recordings are ours.
//
//   source.record start [name]   begin (one recording at a time); name → <recordDir>/<name>.jsonl
//   source.record stop           flush and close
//   source.record [status]       what's recording, frames written, frames dropped
//
// Line 1 is a header {"type":"header","v":1,"name","started","sources":[…]}; then one line per
// event: {"type":"frame","t":<relay arrival, unix ms>,"source","kind","data":<the raw frame>} or
// {"type":"source","t","event":"connected"|"disconnected","source","kind"}.
//
// Writing never touches the source's read loop: frames go through a bounded queue to a writer
// goroutine, and a full queue (a slow disk) drops the frame and counts it rather than stall capture.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"time"
)

// recordDir is where recordings go (serve --record-dir); empty = the user cache dir.
var recordDir = ""

const recordQueue = 4096

var recordNameOK = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

type recorder struct {
	name    string
	path    string
	started time.Time
	f       *os.File
	w       *bufio.Writer
	q       chan []byte
	done    chan struct{}
	frames  atomic.Int64
	dropped atomic.Int64
}

// recordStatus is source.record's data.
type recordStatus struct {
	Recording bool   `json:"recording"`
	Name      string `json:"name,omitempty"`
	Path      string `json:"path,omitempty"`
	Frames    int64  `json:"frames"`
	Dropped   int64  `json:"dropped"`
	Seconds   int64  `json:"seconds"`
}

func (rec *recorder) status() recordStatus {
	return recordStatus{
		Recording: true, Name: rec.name, Path: rec.path,
		Frames: rec.frames.Load(), Dropped: rec.dropped.Load(),
		Seconds: int64(time.Since(rec.started).Seconds()),
	}
}

// recordingDir resolves where recordings are written.
func recordingDir() (string, error) {
	if recordDir != "" {
		return recordDir, nil
	}
	base, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("no record dir: %w (set serve --record-dir)", err)
	}
	return filepath.Join(base, "glyph3d", "recordings"), nil
}

// sanitizeRecordName keeps a name to [A-Za-z0-9._-] (no path separators, no leading dots).
func sanitizeRecordName(name string) string {
	s := strings.Trim(recordNameOK.ReplaceAllString(name, "-"), ".-")
	if len(s) > 64 {
		s = s[:64]
	}
	return s
}

// startRecording begins a recording; one at a time.
func (r *Relay) startRecording(name string) (recordStatus, error) {
	r.recMu.Lock()
	defer r.recMu.Unlock()
	if r.rec != nil {
		return r.rec.status(), fmt.Errorf("already recording %q — source.record stop first", r.rec.name)
	}
	dir, err := recordingDir()
	if err != nil {
		return recordStatus{}, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return recordStatus{}, fmt.Errorf("record dir: %w", err)
	}
	name = sanitizeRecordName(name)
	if name == "" {
		name = "hand-" + time.Now().Format("20060102-150405")
	}
	path := filepath.Join(dir, name+".jsonl")
	for i := 2; ; i++ { // never overwrite a recording
		if _, err := os.Stat(path); os.IsNotExist(err) {
			break
		}
		path = filepath.Join(dir, fmt.Sprintf("%s-%d.jsonl", name, i))
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return recordStatus{}, fmt.Errorf("open recording: %w", err)
	}
	rec := &recorder{
		name: strings.TrimSuffix(filepath.Base(path), ".jsonl"), path: path, started: time.Now(),
		f: f, w: bufio.NewWriterSize(f, 1<<16), q: make(chan []byte, recordQueue), done: make(chan struct{}),
	}
	r.mu.RLock()
	srcs := r.sourceSummariesLocked()
	r.mu.RUnlock()
	header, _ := json.Marshal(map[string]any{
		"type": "header", "v": 1, "name": rec.name, "started": rec.started.UTC().Format(time.RFC3339Nano), "sources": srcs,
	})
	rec.w.Write(header)
	rec.w.WriteByte('\n')
	go rec.run()
	r.rec = rec
	return rec.status(), nil
}

// run is the writer goroutine: queue → buffered file, flushed every half second and at the end.
func (rec *recorder) run() {
	defer close(rec.done)
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case line, ok := <-rec.q:
			if !ok {
				rec.w.Flush()
				rec.f.Close()
				return
			}
			rec.w.Write(line)
			rec.w.WriteByte('\n')
		case <-tick.C:
			rec.w.Flush()
		}
	}
}

// stopRecording flushes and closes the recording.
func (r *Relay) stopRecording() (recordStatus, error) {
	r.recMu.Lock()
	rec := r.rec
	r.rec = nil
	r.recMu.Unlock()
	if rec == nil {
		return recordStatus{}, fmt.Errorf("not recording")
	}
	st := rec.status()
	close(rec.q)
	<-rec.done
	st.Recording = false
	return st, nil
}

// recordLine queues one line for the recording, if one is running. Never blocks.
func (r *Relay) recordLine(v map[string]any) {
	r.recMu.Lock()
	rec := r.rec
	r.recMu.Unlock()
	if rec == nil {
		return
	}
	line, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case rec.q <- line:
		if v["type"] == "frame" {
			rec.frames.Add(1)
		}
	default:
		rec.dropped.Add(1)
	}
}

// recordFrame records one raw source frame with its arrival time.
func (r *Relay) recordFrame(source, kind string, raw []byte) {
	r.recordLine(map[string]any{
		"type": "frame", "t": float64(time.Now().UnixMicro()) / 1000, "source": source, "kind": kind, "data": json.RawMessage(raw),
	})
}

// recordSourceEvent records a source connecting or leaving.
func (r *Relay) recordSourceEvent(event, source, kind string) {
	r.recordLine(map[string]any{
		"type": "source", "t": float64(time.Now().UnixMicro()) / 1000, "event": event, "source": source, "kind": kind,
	})
}

// recordCommand answers source.record.
func (r *Relay) recordCommand(rest string, reply func(string, any), fail func(error)) {
	args := strings.Fields(rest)
	cmd := "status"
	if len(args) > 0 {
		cmd = args[0]
	}
	switch cmd {
	case "start":
		name := ""
		if len(args) > 1 {
			name = args[1]
		}
		st, err := r.startRecording(name)
		if err != nil {
			fail(err)
			return
		}
		reply(fmt.Sprintf("recording %s → %s", st.Name, st.Path), st)
	case "stop":
		st, err := r.stopRecording()
		if err != nil {
			fail(err)
			return
		}
		reply(fmt.Sprintf("stopped %s: %d frames (%d dropped), %ds → %s", st.Name, st.Frames, st.Dropped, st.Seconds, st.Path), st)
	case "status":
		r.recMu.Lock()
		rec := r.rec
		r.recMu.Unlock()
		if rec == nil {
			reply("not recording", recordStatus{})
			return
		}
		st := rec.status()
		reply(fmt.Sprintf("recording %s: %d frames (%d dropped), %ds → %s", st.Name, st.Frames, st.Dropped, st.Seconds, st.Path), st)
	default:
		fail(fmt.Errorf("usage: source.record start [name] | stop | status"))
	}
}

package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

// binaryFrameSource is the wire type byte for binary source / desktop frames
// on the relay→display binary plane:
//
//	[0x03][idLen:u8][id:utf8][w:u16 BE][h:u16 BE][payload: raw image bytes]
//
// Matches WebSocketBridge._handleBinary's [type][idLen][id][u16 BE][u16 BE][payload]
// framing (0x01 is terminal OUTPUT, 0x02 is RPC binary result).
const binaryFrameSource byte = 0x03

// packSourceBinFrame builds a 0x03 binary source frame addressed by id with
// pixel dimensions w×h and raw image payload bytes (JPEG/PNG/WebP).
func packSourceBinFrame(id string, w, h int, payload []byte) ([]byte, error) {
	if id == "" || len(id) > 255 {
		return nil, fmt.Errorf("source frame id %q must be 1..255 bytes", id)
	}
	if w <= 0 || w > 0xFFFF || h <= 0 || h > 0xFFFF {
		return nil, fmt.Errorf("source frame dimensions %dx%d out of u16 range", w, h)
	}
	if len(payload) == 0 {
		return nil, fmt.Errorf("source frame payload is empty")
	}
	frame := make([]byte, 2+len(id)+4+len(payload))
	frame[0] = binaryFrameSource
	frame[1] = byte(len(id))
	copy(frame[2:2+len(id)], id)
	off := 2 + len(id)
	frame[off] = byte(w >> 8)
	frame[off+1] = byte(w)
	frame[off+2] = byte(h >> 8)
	frame[off+3] = byte(h)
	copy(frame[off+4:], payload)
	return frame, nil
}

// unpackSourceBinFrame parses a 0x03 binary source frame into (id, w, h, payload).
func unpackSourceBinFrame(frame []byte) (string, int, int, []byte, error) {
	if len(frame) < 2 || frame[0] != binaryFrameSource {
		return "", 0, 0, nil, errors.New("not a 0x03 binary source frame")
	}
	idLen := int(frame[1])
	if idLen == 0 || len(frame) < 2+idLen+5 {
		return "", 0, 0, nil, errors.New("truncated 0x03 binary source frame")
	}
	id := string(frame[2 : 2+idLen])
	off := 2 + idLen
	w := (int(frame[off]) << 8) | int(frame[off+1])
	h := (int(frame[off+2]) << 8) | int(frame[off+3])
	if w <= 0 || h <= 0 {
		return "", 0, 0, nil, fmt.Errorf("invalid 0x03 dimensions %dx%d", w, h)
	}
	return id, w, h, frame[off+4:], nil
}

// parseInboundSourceBinFrame normalizes a binary message sent by a role="source"
// WebSocket client into a relay-stamped 0x03 binary frame. The sender may send
// either:
//   - [w:u16 BE][h:u16 BE][payload] (raw 4-byte dimension header + image bytes), or
//   - [0x03][idLen:u8][id][w:u16 BE][h:u16 BE][payload] (pre-framed; the relay
//     overwrites id with the connection's authoritative sourceID, matching JSON
//     source provenance).
func parseInboundSourceBinFrame(sourceID string, msg []byte) ([]byte, error) {
	if len(msg) >= 2 && msg[0] == binaryFrameSource {
		idLen := int(msg[1])
		if len(msg) < 2+idLen+5 {
			return nil, errors.New("truncated 0x03 frame from source")
		}
		off := 2 + idLen
		w := (int(msg[off]) << 8) | int(msg[off+1])
		h := (int(msg[off+2]) << 8) | int(msg[off+3])
		return packSourceBinFrame(sourceID, w, h, msg[off+4:])
	}
	if len(msg) < 5 {
		return nil, errors.New("binary source frame shorter than [w:u16][h:u16][payload]")
	}
	w := (int(msg[0]) << 8) | int(msg[1])
	h := (int(msg[2]) << 8) | int(msg[3])
	return packSourceBinFrame(sourceID, w, h, msg[4:])
}

// handleSourceBinaryFrame processes one binary message from a connected SOURCE
// client and forwards it on the 0x03 binary plane through the drop-oldest
// displayFrames queue.
func (r *Relay) handleSourceBinaryFrame(clientID string, msg []byte) {
	if clientID == "" {
		return
	}
	framed, err := parseInboundSourceBinFrame(clientID, msg)
	if err != nil {
		log.Printf("[relay] source '%s' sent malformed binary frame (%d bytes): %v", clientID, len(msg), err)
		return
	}
	r.mu.RLock()
	src := r.sources[clientID]
	r.mu.RUnlock()
	if src == nil {
		return
	}
	switch r.sendFrameToDisplay(framed) {
	case frameQueued:
		src.frames.Add(1)
	case frameEvicted:
		src.frames.Add(1)
		src.dropped.Add(1)
	case frameNoDisplay:
		src.undelivered.Add(1)
	}
	src.lastTS.Store(time.Now().UnixMilli())
}

// ── Agent-owned CDP desktops (DESIGN.md §3.10, Slice 5) ───────────────────────

// DesktopSummary is the wire/CLI-facing snapshot of a relay-owned desktop producer.
type DesktopSummary struct {
	Name        string `json:"name"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	URL         string `json:"url"`
	Owner       string `json:"owner,omitempty"`
	PID         int    `json:"pid"`
	Frames      int64  `json:"frames"`
	Dropped     int64  `json:"dropped"`
	Undelivered int64  `json:"undelivered"`
	Stills      int64  `json:"stills"`
	Format      string `json:"format"`
	UptimeMs    int64  `json:"uptimeMs"`
	LastFrameTs int64  `json:"lastFrameTs"`
}

type desktopStartParams struct {
	Name     string `json:"name"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	URL      string `json:"url"`
	Chromium string `json:"chromium"`
	Owner    string `json:"owner,omitempty"`
}

type desktopStopParams struct {
	Name   string `json:"name"`
	Caller string `json:"caller,omitempty"`
}

type desktopStillParams struct {
	Name string `json:"name"`
}

type desktopGoParams struct {
	Name   string `json:"name"`
	URL    string `json:"url"`
	Caller string `json:"caller,omitempty"`
}

type desktopClickParams struct {
	Name   string  `json:"name"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Button string  `json:"button,omitempty"`
	Count  int     `json:"count,omitempty"`
	Caller string  `json:"caller,omitempty"`
}

type desktopTypeParams struct {
	Name   string `json:"name"`
	Text   string `json:"text"`
	Caller string `json:"caller,omitempty"`
}

type desktopKeyParams struct {
	Name   string `json:"name"`
	Key    string `json:"key"`
	Caller string `json:"caller,omitempty"`
}

type desktopScrollParams struct {
	Name   string   `json:"name"`
	DX     float64  `json:"dx"`
	DY     float64  `json:"dy"`
	X      *float64 `json:"x,omitempty"`
	Y      *float64 `json:"y,omitempty"`
	Caller string   `json:"caller,omitempty"`
}

type desktopActionResult struct {
	Name   string   `json:"name"`
	Action string   `json:"action"`
	URL    string   `json:"url,omitempty"`
	X      *float64 `json:"x,omitempty"`
	Y      *float64 `json:"y,omitempty"`
	DX     *float64 `json:"dx,omitempty"`
	DY     *float64 `json:"dy,omitempty"`
	Button string   `json:"button,omitempty"`
	Key    string   `json:"key,omitempty"`
	Code   string   `json:"code,omitempty"`
	Length int      `json:"length,omitempty"`
	Frames int64    `json:"frames"`
	Stills int64    `json:"stills"`
}

// desktopInputSettle is the brief pause after dispatching a CDP input event
// before capturing a commit still so synchronous DOM mutations and rAF paints
// land in the still. A var so unit tests against fake CDP endpoints can zero it.
var desktopInputSettle = 25 * time.Millisecond

type desktopStillResult struct {
	Name      string `json:"name"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Format    string `json:"format"`
	Bytes     int    `json:"bytes"`
	Stills    int64  `json:"stills"`
	PNGBase64 string `json:"pngBase64"`
}

type cdpReply struct {
	result json.RawMessage
	errMsg string
}

// desktopSpec is the persisted specification of a relay-owned desktop so a
// relay restart can re-launch it at the same size, URL, and owner.
type desktopSpec struct {
	Name     string `json:"name"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	URL      string `json:"url"`
	Owner    string `json:"owner,omitempty"`
	Chromium string `json:"chromium,omitempty"`
}

type desktopStateFile struct {
	Desktops []desktopSpec `json:"desktops"`
}

func defaultUserDesktopStatePath() string {
	if cacheDir, err := os.UserCacheDir(); err == nil && cacheDir != "" {
		return filepath.Join(cacheDir, "glyph3d", "desktops.json")
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".glyph3d", "desktops.json")
	}
	return ""
}

// resolveDesktopStatePath returns the scratch-safe path for persisting desktop
// specs: explicit override first, else <servedRoot>/.glyph3d/desktops.json when
// a root is served (never the worktree root .glyph3d-session.json file).
func (r *Relay) resolveDesktopStatePath() string {
	if r.desktopStatePath != "" {
		return r.desktopStatePath
	}
	if r.fs != nil && r.fs.root != "" {
		return filepath.Join(r.fs.root, ".glyph3d", "desktops.json")
	}
	return ""
}

func (r *Relay) writeDesktopSpecsLocked(path string) {
	if path == "" {
		return
	}
	specs := make([]desktopSpec, 0, len(r.desktopSpecs))
	for _, s := range r.desktopSpecs {
		specs = append(specs, s)
	}
	sort.Slice(specs, func(i, j int) bool { return specs[i].Name < specs[j].Name })
	data, err := json.MarshalIndent(desktopStateFile{Desktops: specs}, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return
	}
	_ = os.Rename(tmp, path)
}

func (r *Relay) saveDesktopSpec(spec desktopSpec) {
	path := r.resolveDesktopStatePath()
	r.desktopSpecsMu.Lock()
	if r.desktopSpecs == nil {
		r.desktopSpecs = make(map[string]desktopSpec)
	}
	r.desktopSpecs[spec.Name] = spec
	r.writeDesktopSpecsLocked(path)
	r.desktopSpecsMu.Unlock()
}

func (r *Relay) forgetDesktopSpec(name string) {
	path := r.resolveDesktopStatePath()
	r.desktopSpecsMu.Lock()
	delete(r.desktopSpecs, name)
	r.writeDesktopSpecsLocked(path)
	r.desktopSpecsMu.Unlock()
}

// BeginRestoreDesktops starts asynchronous restoration of persisted desktops
// once the relay listener is bound. Incoming desktop RPCs wait on waitRestore()
// so a client reconnecting right after a relay restart sees restored desktops.
func (r *Relay) BeginRestoreDesktops() {
	path := r.resolveDesktopStatePath()
	if path == "" {
		return
	}
	if _, err := os.Stat(path); err != nil {
		return
	}
	r.restoreMu.Lock()
	if r.restoreDone != nil {
		r.restoreMu.Unlock()
		return
	}
	done := make(chan struct{})
	r.restoreDone = done
	r.restoreMu.Unlock()

	go func() {
		defer close(done)
		_, _ = r.RestoreDesktops()
	}()
}

func (r *Relay) waitRestore() {
	r.restoreMu.Lock()
	done := r.restoreDone
	r.restoreMu.Unlock()
	if done == nil {
		return
	}
	select {
	case <-done:
	case <-time.After(15 * time.Second):
	}
}

// RestoreDesktops reads the persisted desktop specs from the relay's state file
// and restarts each saved desktop that is not already running.
func (r *Relay) RestoreDesktops() (int, error) {
	path := r.resolveDesktopStatePath()
	if path == "" {
		return 0, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	var state desktopStateFile
	if err := json.Unmarshal(raw, &state); err != nil {
		return 0, fmt.Errorf("parse %s: %w", path, err)
	}
	if len(state.Desktops) == 0 {
		return 0, nil
	}

	r.desktopSpecsMu.Lock()
	if r.desktopSpecs == nil {
		r.desktopSpecs = make(map[string]desktopSpec)
	}
	for _, s := range state.Desktops {
		if s.Name != "" {
			r.desktopSpecs[s.Name] = s
		}
	}
	r.desktopSpecsMu.Unlock()

	var started atomic.Int32
	var wg sync.WaitGroup
	for _, spec := range state.Desktops {
		if strings.TrimSpace(spec.Name) == "" {
			continue
		}
		r.desktopsMu.RLock()
		exists := r.desktops[spec.Name] != nil
		r.desktopsMu.RUnlock()
		if exists {
			continue
		}
		wg.Add(1)
		go func(s desktopSpec) {
			defer wg.Done()
			sum, err := r.startDesktop(desktopStartParams{
				Name:     s.Name,
				Width:    s.Width,
				Height:   s.Height,
				URL:      s.URL,
				Owner:    s.Owner,
				Chromium: s.Chromium,
			})
			if err != nil {
				log.Printf("[desktop] restore '%s' failed: %v", s.Name, err)
				return
			}
			started.Add(1)
			log.Printf("[desktop] restored '%s' (%dx%d, url=%s, owner=%s, pid=%d)",
				sum.Name, sum.Width, sum.Height, sum.URL, callerLabel(sum.Owner), sum.PID)
		}(spec)
	}
	wg.Wait()
	return int(started.Load()), nil
}

// desktopSession is one relay-owned headless Chromium producer driven over CDP.
type desktopSession struct {
	relay    *Relay
	name     string
	width    int
	height   int
	url      string
	owner    string
	chromium string
	cmd      *exec.Cmd
	tmpDir  string
	cdpWS   *websocket.Conn
	cdpMu   sync.Mutex // serializes writes to cdpWS
	src     *sourceConn
	started time.Time

	seq     atomic.Int64
	pendMu  sync.Mutex
	pending map[int64]chan cdpReply
	loadCh  chan struct{}

	frameMu        sync.RWMutex
	lastFramed     []byte // complete 0x03 wire frame for instant replay on display reload
	lastFormat     string // "jpeg" | "png"
	stillHoldUntil time.Time
	settleTimer    *time.Timer

	stills  atomic.Int64
	stopped atomic.Bool
	done    chan struct{}
}

// findChromiumBinary locates a Chromium executable:
//  1. explicit path (--chromium flag),
//  2. $GLYPH3D_CHROMIUM or $CHROME_BIN environment variables,
//  3. PATH candidates: chromium, chromium-browser, google-chrome, google-chrome-stable,
//  4. Playwright cache (~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome or macOS equivalent).
//
// Fails loud naming every candidate it checked when none exists.
func findChromiumBinary(explicit string) (string, error) {
	if explicit != "" {
		if p, err := exec.LookPath(explicit); err == nil {
			return p, nil
		}
		if st, err := os.Stat(explicit); err == nil && !st.IsDir() {
			return explicit, nil
		}
		return "", fmt.Errorf("desktop.start: explicit Chromium binary %q not found", explicit)
	}

	looked := []string{}
	for _, envKey := range []string{"GLYPH3D_CHROMIUM", "CHROME_BIN"} {
		if val := strings.TrimSpace(os.Getenv(envKey)); val != "" {
			looked = append(looked, fmt.Sprintf("$%s=%s", envKey, val))
			if p, err := exec.LookPath(val); err == nil {
				return p, nil
			}
			if st, err := os.Stat(val); err == nil && !st.IsDir() {
				return val, nil
			}
		}
	}

	pathNames := []string{"chromium", "chromium-browser", "google-chrome", "google-chrome-stable"}
	for _, name := range pathNames {
		looked = append(looked, name+" (PATH)")
		if p, err := exec.LookPath(name); err == nil {
			return p, nil
		}
	}

	if home, err := os.UserHomeDir(); err == nil && home != "" {
		patterns := []string{
			filepath.Join(home, ".cache", "ms-playwright", "chromium-*", "chrome-linux*", "chrome"),
			filepath.Join(home, "Library", "Caches", "ms-playwright", "chromium-*", "chrome-mac*", "Chromium.app", "Contents", "MacOS", "Chromium"),
		}
		for _, pat := range patterns {
			looked = append(looked, pat)
			matches, _ := filepath.Glob(pat)
			if len(matches) > 0 {
				sort.Strings(matches)
				for i := len(matches) - 1; i >= 0; i-- {
					if st, err := os.Stat(matches[i]); err == nil && !st.IsDir() {
						return matches[i], nil
					}
				}
			}
		}
	}

	return "", fmt.Errorf("desktop.start: no Chromium binary found (looked for: %s)", strings.Join(looked, ", "))
}

// startDesktop launches a headless Chromium producer owned by the relay, attaches
// CDP, configures viewport metrics, starts Page.startScreencast (JPEG first),
// navigates to the target URL, and captures a commit frame so the desktop has
// immediate pixels.
func (r *Relay) startDesktop(p desktopStartParams) (DesktopSummary, error) {
	name := strings.TrimSpace(p.Name)
	if name == "" {
		return DesktopSummary{}, errors.New("desktop.start: name is required")
	}
	if len(name) > 200 {
		return DesktopSummary{}, errors.New("desktop.start: name too long (max 200 bytes)")
	}
	width := p.Width
	height := p.Height
	if width <= 0 {
		width = 1280
	}
	if height <= 0 {
		height = 720
	}
	if width < 16 || width > 4096 || height < 16 || height > 4096 {
		return DesktopSummary{}, fmt.Errorf("desktop.start: dimensions %dx%d out of range (16..4096)", width, height)
	}
	targetURL := strings.TrimSpace(p.URL)
	if targetURL == "" {
		targetURL = "about:blank"
	}

	var bin string
	if r.testCDPDial == nil {
		var err error
		bin, err = findChromiumBinary(strings.TrimSpace(p.Chromium))
		if err != nil {
			return DesktopSummary{}, err
		}
	}

	// Replace any existing desktop of the same name cleanly so re-starting never leaks.
	r.desktopsMu.Lock()
	old := r.desktops[name]
	if old != nil {
		delete(r.desktops, name)
	}
	r.desktopsMu.Unlock()
	if old != nil {
		old.close()
	}

	var cmd *exec.Cmd
	var tmpDir string
	var cdpWS *websocket.Conn
	if r.testCDPDial != nil {
		var err error
		cdpWS, err = r.testCDPDial(p)
		if err != nil {
			return DesktopSummary{}, err
		}
	} else {
		var err error
		tmpDir, err = os.MkdirTemp("", "glyph3d-desktop-*")
		if err != nil {
			return DesktopSummary{}, fmt.Errorf("desktop.start: temp profile dir: %w", err)
		}

		args := []string{
			"--headless=new",
			"--remote-debugging-port=0",
			"--user-data-dir=" + tmpDir,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-networking",
			"--disable-sync",
			"--disable-extensions",
			"--disable-default-apps",
			"--mute-audio",
			"--hide-scrollbars",
			"--force-device-scale-factor=1",
			"--force-color-profile=srgb",
			fmt.Sprintf("--window-size=%d,%d", width, height),
			"about:blank",
		}
		cmd = exec.Command(bin, args...)
		stderrPipe, err := cmd.StderrPipe()
		if err != nil {
			os.RemoveAll(tmpDir)
			return DesktopSummary{}, fmt.Errorf("desktop.start: stderr pipe: %w", err)
		}
		if err := startChild(cmd); err != nil {
			os.RemoveAll(tmpDir)
			return DesktopSummary{}, fmt.Errorf("desktop.start: spawn %s: %w", bin, err)
		}

		wsURLCh := make(chan string, 1)
		stderrTail := make(chan string, 1)
		go func() {
			scanner := bufio.NewScanner(stderrPipe)
			var lines []string
			found := false
			for scanner.Scan() {
				line := scanner.Text()
				if !found {
					if idx := strings.Index(line, "DevTools listening on ws://"); idx >= 0 {
						wsURLCh <- strings.TrimSpace(line[idx+len("DevTools listening on "):])
						found = true
					} else if len(lines) < 20 {
						lines = append(lines, line)
					}
				}
			}
			if !found {
				stderrTail <- strings.Join(lines, "\n")
			}
			_, _ = io.Copy(io.Discard, stderrPipe)
		}()

		var browserWSURL string
		select {
		case browserWSURL = <-wsURLCh:
		case tail := <-stderrTail:
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			os.RemoveAll(tmpDir)
			return DesktopSummary{}, fmt.Errorf("desktop.start: Chromium exited before DevTools listening (%s)", strings.TrimSpace(tail))
		case <-time.After(10 * time.Second):
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			os.RemoveAll(tmpDir)
			return DesktopSummary{}, errors.New("desktop.start: timed out waiting for Chromium DevTools port")
		}

		pageWSURL, err := discoverPageTargetWS(browserWSURL, 5*time.Second)
		if err != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			os.RemoveAll(tmpDir)
			return DesktopSummary{}, fmt.Errorf("desktop.start: %w", err)
		}

		dialCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		cdpWS, _, err = websocket.DefaultDialer.DialContext(dialCtx, pageWSURL, nil)
		cancel()
		if err != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			os.RemoveAll(tmpDir)
			return DesktopSummary{}, fmt.Errorf("desktop.start: dial CDP page target: %w", err)
		}
	}

	src := &sourceConn{
		id:    name,
		kind:  "desktop",
		since: time.Now(),
	}
	d := &desktopSession{
		relay:    r,
		name:     name,
		width:    width,
		height:   height,
		url:      targetURL,
		owner:    strings.TrimSpace(p.Owner),
		chromium: strings.TrimSpace(p.Chromium),
		cmd:      cmd,
		tmpDir:   tmpDir,
		cdpWS:    cdpWS,
		src:      src,
		started:  src.since,
		pending:  make(map[int64]chan cdpReply),
		loadCh:   make(chan struct{}, 1),
		done:     make(chan struct{}),
	}

	r.mu.Lock()
	r.sources[name] = src
	r.mu.Unlock()
	r.desktopsMu.Lock()
	r.desktops[name] = d
	r.desktopsMu.Unlock()

	r.notifySourceChange("source_connected", src)
	r.recordSourceEvent("connected", name, "desktop")

	go d.readLoop()
	if cmd != nil {
		go func() {
			_ = cmd.Wait()
			d.close()
		}()
	}

	setupCtx, setupCancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer setupCancel()

	if _, err := d.call(setupCtx, "Page.enable", map[string]any{}); err != nil {
		d.close()
		return DesktopSummary{}, fmt.Errorf("desktop.start: Page.enable: %w", err)
	}
	if _, err := d.call(setupCtx, "Emulation.setDeviceMetricsOverride", map[string]any{
		"width":             width,
		"height":            height,
		"deviceScaleFactor": 1,
		"mobile":            false,
	}); err != nil {
		d.close()
		return DesktopSummary{}, fmt.Errorf("desktop.start: setDeviceMetricsOverride: %w", err)
	}
	// Start the CDP screencast (JPEG first for low-latency motion frames).
	if _, err := d.call(setupCtx, "Page.startScreencast", map[string]any{
		"format":        "jpeg",
		"quality":       90,
		"maxWidth":      width,
		"maxHeight":     height,
		"everyNthFrame": 1,
	}); err != nil {
		d.close()
		return DesktopSummary{}, fmt.Errorf("desktop.start: Page.startScreencast: %w", err)
	}

	if targetURL != "" && targetURL != "about:blank" {
		select {
		case <-d.loadCh:
		default:
		}
		if _, err := d.call(setupCtx, "Page.navigate", map[string]any{"url": targetURL}); err != nil {
			d.close()
			return DesktopSummary{}, fmt.Errorf("desktop.start: Page.navigate(%s): %w", targetURL, err)
		}
		select {
		case <-d.loadCh:
		case <-time.After(4 * time.Second):
		case <-d.done:
			return DesktopSummary{}, errors.New("desktop.start: session closed during navigation")
		}
	}

	// Fit-on-commit: capture a lossless PNG right after initial load so static pages
	// always emit a frame immediately and resting pixels are 1:1 lossless.
	_, _ = d.captureStill(setupCtx)

	r.saveDesktopSpec(desktopSpec{
		Name:     name,
		Width:    width,
		Height:   height,
		URL:      targetURL,
		Owner:    d.owner,
		Chromium: d.chromium,
	})

	sum := d.summary()
	log.Printf("[desktop] started '%s' (%dx%d, url=%s, owner=%s, pid=%d)", name, width, height, targetURL, callerLabel(d.owner), sum.PID)
	return sum, nil
}

// discoverPageTargetWS queries http://127.0.0.1:<port>/json/list until Chromium's
// initial "page" target exposes its webSocketDebuggerUrl.
func discoverPageTargetWS(browserWSURL string, timeout time.Duration) (string, error) {
	u, err := url.Parse(browserWSURL)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("invalid DevTools ws URL %q", browserWSURL)
	}
	listURL := fmt.Sprintf("http://%s/json/list", u.Host)
	client := &http.Client{Timeout: 1 * time.Second}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		resp, err := client.Get(listURL)
		if err == nil {
			var targets []struct {
				Type                 string `json:"type"`
				WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
			}
			_ = json.NewDecoder(resp.Body).Decode(&targets)
			resp.Body.Close()
			for _, t := range targets {
				if t.Type == "page" && t.WebSocketDebuggerURL != "" {
					return t.WebSocketDebuggerURL, nil
				}
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	return "", fmt.Errorf("no CDP page target found at %s", listURL)
}

func (d *desktopSession) summary() DesktopSummary {
	pid := 0
	if d.cmd != nil && d.cmd.Process != nil {
		pid = d.cmd.Process.Pid
	}
	d.frameMu.RLock()
	fmtName := d.lastFormat
	curURL := d.url
	owner := d.owner
	d.frameMu.RUnlock()
	if fmtName == "" {
		fmtName = "jpeg"
	}
	return DesktopSummary{
		Name:        d.name,
		Width:       d.width,
		Height:      d.height,
		URL:         curURL,
		Owner:       owner,
		PID:         pid,
		Frames:      d.src.frames.Load(),
		Dropped:     d.src.dropped.Load(),
		Undelivered: d.src.undelivered.Load(),
		Stills:      d.stills.Load(),
		Format:      fmtName,
		UptimeMs:    time.Since(d.started).Milliseconds(),
		LastFrameTs: d.src.lastTS.Load(),
	}
}

func (d *desktopSession) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if d.stopped.Load() {
		return nil, errors.New("desktop session stopped")
	}
	id := d.seq.Add(1)
	ch := make(chan cdpReply, 1)
	d.pendMu.Lock()
	d.pending[id] = ch
	d.pendMu.Unlock()

	defer func() {
		d.pendMu.Lock()
		delete(d.pending, id)
		d.pendMu.Unlock()
	}()

	req := map[string]any{
		"id":     id,
		"method": method,
		"params": params,
	}
	d.cdpMu.Lock()
	err := d.cdpWS.WriteJSON(req)
	d.cdpMu.Unlock()
	if err != nil {
		return nil, err
	}

	select {
	case rep := <-ch:
		if rep.errMsg != "" {
			return nil, errors.New(rep.errMsg)
		}
		return rep.result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-d.done:
		return nil, errors.New("desktop session closed")
	}
}

func (d *desktopSession) sendFireAndForget(method string, params any) {
	if d.stopped.Load() {
		return
	}
	id := d.seq.Add(1)
	req := map[string]any{
		"id":     id,
		"method": method,
		"params": params,
	}
	d.cdpMu.Lock()
	_ = d.cdpWS.WriteJSON(req)
	d.cdpMu.Unlock()
}

func (d *desktopSession) readLoop() {
	defer d.close()
	for {
		_, raw, err := d.cdpWS.ReadMessage()
		if err != nil {
			return
		}
		var env struct {
			ID     int64           `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(raw, &env) != nil {
			continue
		}
		if env.ID != 0 {
			d.pendMu.Lock()
			ch, ok := d.pending[env.ID]
			d.pendMu.Unlock()
			if ok {
				errStr := ""
				if env.Error != nil {
					errStr = env.Error.Message
				}
				select {
				case ch <- cdpReply{result: env.Result, errMsg: errStr}:
				default:
				}
			}
			continue
		}
		switch env.Method {
		case "Page.loadEventFired":
			select {
			case d.loadCh <- struct{}{}:
			default:
			}
		case "Page.screencastFrame":
			var ev struct {
				Data      string `json:"data"`
				SessionID int    `json:"sessionId"`
				Metadata  struct {
					DeviceWidth  int `json:"deviceWidth"`
					DeviceHeight int `json:"deviceHeight"`
				} `json:"metadata"`
			}
			if json.Unmarshal(env.Params, &ev) != nil {
				continue
			}
			// Always ack immediately so Chromium's compositor keeps streaming.
			d.sendFireAndForget("Page.screencastFrameAck", map[string]any{"sessionId": ev.SessionID})

			d.frameMu.RLock()
			hold := time.Now().Before(d.stillHoldUntil)
			d.frameMu.RUnlock()
			if hold {
				continue
			}

			bytes, err := base64.StdEncoding.DecodeString(ev.Data)
			if err != nil || len(bytes) == 0 {
				continue
			}
			w, h := ev.Metadata.DeviceWidth, ev.Metadata.DeviceHeight
			if w <= 0 {
				w = d.width
			}
			if h <= 0 {
				h = d.height
			}
			d.deliverFrame(bytes, w, h, "jpeg")
			d.scheduleSettleStill()
		}
	}
}

// deliverFrame packs raw image bytes into a 0x03 frame, caches it for reload
// replay, and enqueues it on the display's drop-oldest frame queue.
func (d *desktopSession) deliverFrame(payload []byte, w, h int, format string) {
	framed, err := packSourceBinFrame(d.name, w, h, payload)
	if err != nil {
		return
	}
	d.frameMu.Lock()
	d.lastFramed = framed
	d.lastFormat = format
	d.frameMu.Unlock()

	switch d.relay.sendFrameToDisplay(framed) {
	case frameQueued:
		d.src.frames.Add(1)
	case frameEvicted:
		d.src.frames.Add(1)
		d.src.dropped.Add(1)
	case frameNoDisplay:
		d.src.undelivered.Add(1)
	}
	d.src.lastTS.Store(time.Now().UnixMilli())
}

// scheduleSettleStill debounces a lossless PNG upgrade 120ms after the last JPEG
// screencast frame so motion streams fast JPEGs first and settles to a lossless
// 1:1 PNG once the page stops moving.
func (d *desktopSession) scheduleSettleStill() {
	d.frameMu.Lock()
	defer d.frameMu.Unlock()
	if d.settleTimer != nil {
		d.settleTimer.Stop()
	}
	d.settleTimer = time.AfterFunc(120*time.Millisecond, func() {
		if d.stopped.Load() {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_, _ = d.captureStill(ctx)
	})
}

// captureStill grabs a lossless PNG via CDP Page.captureScreenshot, pushes it on
// the 0x03 binary plane, caches it as the desktop's resting frame, and returns
// the still metadata + base64 PNG.
func (d *desktopSession) captureStill(ctx context.Context) (desktopStillResult, error) {
	raw, err := d.call(ctx, "Page.captureScreenshot", map[string]any{
		"format":                "png",
		"captureBeyondViewport": false,
	})
	if err != nil {
		return desktopStillResult{}, fmt.Errorf("Page.captureScreenshot: %w", err)
	}
	var res struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(raw, &res); err != nil || res.Data == "" {
		return desktopStillResult{}, errors.New("Page.captureScreenshot returned empty data")
	}
	pngBytes, err := base64.StdEncoding.DecodeString(res.Data)
	if err != nil || len(pngBytes) == 0 {
		return desktopStillResult{}, errors.New("Page.captureScreenshot returned invalid base64")
	}

	d.frameMu.Lock()
	d.stillHoldUntil = time.Now().Add(250 * time.Millisecond)
	if d.settleTimer != nil {
		d.settleTimer.Stop()
	}
	d.frameMu.Unlock()

	stills := d.stills.Add(1)
	d.deliverFrame(pngBytes, d.width, d.height, "png")

	return desktopStillResult{
		Name:      d.name,
		Width:     d.width,
		Height:    d.height,
		Format:    "png",
		Bytes:     len(pngBytes),
		Stills:    stills,
		PNGBase64: res.Data,
	}, nil
}

func (d *desktopSession) close() {
	if !d.stopped.CompareAndSwap(false, true) {
		return
	}
	close(d.done)

	d.frameMu.Lock()
	if d.settleTimer != nil {
		d.settleTimer.Stop()
	}
	d.frameMu.Unlock()

	if d.cdpWS != nil {
		_ = d.cdpWS.Close()
	}
	if d.cmd != nil && d.cmd.Process != nil {
		_ = d.cmd.Process.Kill()
	}
	if d.tmpDir != "" {
		_ = os.RemoveAll(d.tmpDir)
	}

	r := d.relay
	r.desktopsMu.Lock()
	if r.desktops[d.name] == d {
		delete(r.desktops, d.name)
	}
	r.desktopsMu.Unlock()

	r.mu.Lock()
	if r.sources[d.name] == d.src {
		delete(r.sources, d.name)
	}
	r.mu.Unlock()

	r.notifySourceChange("source_disconnected", d.src)
	r.recordSourceEvent("disconnected", d.name, "desktop")
	log.Printf("[desktop] stopped '%s' (%d frames, %d stills)", d.name, d.src.frames.Load(), d.stills.Load())
}

func (r *Relay) stopDesktop(name string) (DesktopSummary, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return DesktopSummary{}, errors.New("desktop.stop: name is required")
	}
	r.forgetDesktopSpec(name)
	r.desktopsMu.RLock()
	d := r.desktops[name]
	r.desktopsMu.RUnlock()
	if d == nil {
		return DesktopSummary{}, fmt.Errorf("desktop.stop: no desktop %q", name)
	}
	sum := d.summary()
	d.close()
	return sum, nil
}

func (r *Relay) listDesktops() []DesktopSummary {
	r.desktopsMu.RLock()
	out := make([]DesktopSummary, 0, len(r.desktops))
	for _, d := range r.desktops {
		out = append(out, d.summary())
	}
	r.desktopsMu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (r *Relay) stillDesktop(name string) (desktopStillResult, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return desktopStillResult{}, errors.New("desktop.still: name is required")
	}
	r.desktopsMu.RLock()
	d := r.desktops[name]
	r.desktopsMu.RUnlock()
	if d == nil {
		return desktopStillResult{}, fmt.Errorf("desktop.still: no desktop %q", name)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return d.captureStill(ctx)
}

func (r *Relay) lookupDesktopForDrive(verb, name, caller string) (*desktopSession, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, fmt.Errorf("%s: name is required", verb)
	}
	r.desktopsMu.RLock()
	d := r.desktops[name]
	r.desktopsMu.RUnlock()
	if d == nil {
		return nil, fmt.Errorf("%s: no desktop %q", verb, name)
	}
	if err := d.checkCaller(verb, caller); err != nil {
		return nil, err
	}
	return d, nil
}

// checkCaller enforces desktop ownership: when a desktop is owned by an agent,
// only that owning agent or the anonymous person (caller == "") may drive it;
// any other identified caller is refused.
func (d *desktopSession) checkCaller(verb, caller string) error {
	caller = strings.TrimSpace(caller)
	d.frameMu.RLock()
	owner := d.owner
	d.frameMu.RUnlock()
	if owner != "" && caller != "" && caller != owner {
		log.Printf("[desktop] %s '%s' refused for caller %s (owned by %s)", verb, d.name, caller, owner)
		return fmt.Errorf("%s: desktop %q is owned by %s (caller %s may not drive it)", verb, d.name, owner, caller)
	}
	return nil
}

func callerLabel(caller string) string {
	if c := strings.TrimSpace(caller); c != "" {
		return c
	}
	return "person"
}

func (d *desktopSession) settleAndCapture(ctx context.Context) {
	if desktopInputSettle > 0 {
		select {
		case <-time.After(desktopInputSettle):
		case <-ctx.Done():
			return
		case <-d.done:
			return
		}
	}
	_, _ = d.captureStill(ctx)
	d.scheduleSettleStill()
}

// goDesktop navigates a running desktop to a new URL via CDP Page.navigate.
func (r *Relay) goDesktop(p desktopGoParams) (DesktopSummary, error) {
	d, err := r.lookupDesktopForDrive("desktop.go", p.Name, p.Caller)
	if err != nil {
		return DesktopSummary{}, err
	}
	targetURL := strings.TrimSpace(p.URL)
	if targetURL == "" {
		return DesktopSummary{}, errors.New("desktop.go: url is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	select {
	case <-d.loadCh:
	default:
	}
	if _, err := d.call(ctx, "Page.navigate", map[string]any{"url": targetURL}); err != nil {
		return DesktopSummary{}, fmt.Errorf("desktop.go: Page.navigate(%s): %w", targetURL, err)
	}
	select {
	case <-d.loadCh:
	case <-time.After(3 * time.Second):
	case <-ctx.Done():
	case <-d.done:
		return DesktopSummary{}, errors.New("desktop.go: session closed during navigation")
	}

	d.frameMu.Lock()
	d.url = targetURL
	owner := d.owner
	chromium := d.chromium
	d.frameMu.Unlock()

	r.saveDesktopSpec(desktopSpec{
		Name:     d.name,
		Width:    d.width,
		Height:   d.height,
		URL:      targetURL,
		Owner:    owner,
		Chromium: chromium,
	})

	_, _ = d.captureStill(ctx)
	d.scheduleSettleStill()
	log.Printf("[desktop] go '%s' -> %s (caller=%s)", d.name, targetURL, callerLabel(p.Caller))
	return d.summary(), nil
}

// clickDesktop dispatches a mouse move + press + release at (x, y) in desktop pixels.
func (r *Relay) clickDesktop(p desktopClickParams) (desktopActionResult, error) {
	d, err := r.lookupDesktopForDrive("desktop.click", p.Name, p.Caller)
	if err != nil {
		return desktopActionResult{}, err
	}
	if math.IsNaN(p.X) || math.IsInf(p.X, 0) || math.IsNaN(p.Y) || math.IsInf(p.Y, 0) ||
		p.X < 0 || p.X >= float64(d.width) || p.Y < 0 || p.Y >= float64(d.height) {
		return desktopActionResult{}, fmt.Errorf("desktop.click: coordinates (%g, %g) out of desktop bounds %dx%d", p.X, p.Y, d.width, d.height)
	}
	button := strings.TrimSpace(p.Button)
	if button == "" {
		button = "left"
	}
	count := p.Count
	if count <= 0 {
		count = 1
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if _, err := d.call(ctx, "Input.dispatchMouseEvent", map[string]any{
		"type":    "mouseMoved",
		"x":       p.X,
		"y":       p.Y,
		"button":  "none",
		"buttons": 0,
	}); err != nil {
		return desktopActionResult{}, fmt.Errorf("desktop.click: mouseMoved: %w", err)
	}
	if _, err := d.call(ctx, "Input.dispatchMouseEvent", map[string]any{
		"type":       "mousePressed",
		"x":          p.X,
		"y":          p.Y,
		"button":     button,
		"buttons":    1,
		"clickCount": count,
	}); err != nil {
		return desktopActionResult{}, fmt.Errorf("desktop.click: mousePressed: %w", err)
	}
	if _, err := d.call(ctx, "Input.dispatchMouseEvent", map[string]any{
		"type":       "mouseReleased",
		"x":          p.X,
		"y":          p.Y,
		"button":     button,
		"buttons":    0,
		"clickCount": count,
	}); err != nil {
		return desktopActionResult{}, fmt.Errorf("desktop.click: mouseReleased: %w", err)
	}

	d.settleAndCapture(ctx)
	log.Printf("[desktop] click '%s' at (%g, %g) button=%s (caller=%s)", d.name, p.X, p.Y, button, callerLabel(p.Caller))
	x, y := p.X, p.Y
	return desktopActionResult{
		Name:   d.name,
		Action: "click",
		X:      &x,
		Y:      &y,
		Button: button,
		Frames: d.src.frames.Load(),
		Stills: d.stills.Load(),
	}, nil
}

// typeDesktop inserts text into the desktop's focused element via CDP Input.insertText.
func (r *Relay) typeDesktop(p desktopTypeParams) (desktopActionResult, error) {
	d, err := r.lookupDesktopForDrive("desktop.type", p.Name, p.Caller)
	if err != nil {
		return desktopActionResult{}, err
	}
	if p.Text == "" {
		return desktopActionResult{}, errors.New("desktop.type: text is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if _, err := d.call(ctx, "Input.insertText", map[string]any{"text": p.Text}); err != nil {
		return desktopActionResult{}, fmt.Errorf("desktop.type: Input.insertText: %w", err)
	}

	d.settleAndCapture(ctx)
	log.Printf("[desktop] type '%s' (%d bytes, caller=%s)", d.name, len(p.Text), callerLabel(p.Caller))
	return desktopActionResult{
		Name:   d.name,
		Action: "type",
		Length: len(p.Text),
		Frames: d.src.frames.Load(),
		Stills: d.stills.Load(),
	}, nil
}

type cdpKeySpec struct {
	key  string
	code string
	text string
	vk   int
}

func cdpKeyFor(raw string) cdpKeySpec {
	switch raw {
	case "Enter", "Return", "enter":
		return cdpKeySpec{key: "Enter", code: "Enter", text: "\r", vk: 13}
	case "Tab", "tab":
		return cdpKeySpec{key: "Tab", code: "Tab", vk: 9}
	case "Escape", "Esc", "escape", "esc":
		return cdpKeySpec{key: "Escape", code: "Escape", vk: 27}
	case "Backspace", "backspace":
		return cdpKeySpec{key: "Backspace", code: "Backspace", vk: 8}
	case "Delete", "delete":
		return cdpKeySpec{key: "Delete", code: "Delete", vk: 46}
	case "Space", "space", " ":
		return cdpKeySpec{key: " ", code: "Space", text: " ", vk: 32}
	case "ArrowUp", "Up", "up":
		return cdpKeySpec{key: "ArrowUp", code: "ArrowUp", vk: 38}
	case "ArrowDown", "Down", "down":
		return cdpKeySpec{key: "ArrowDown", code: "ArrowDown", vk: 40}
	case "ArrowLeft", "Left", "left":
		return cdpKeySpec{key: "ArrowLeft", code: "ArrowLeft", vk: 37}
	case "ArrowRight", "Right", "right":
		return cdpKeySpec{key: "ArrowRight", code: "ArrowRight", vk: 39}
	case "Home", "home":
		return cdpKeySpec{key: "Home", code: "Home", vk: 36}
	case "End", "end":
		return cdpKeySpec{key: "End", code: "End", vk: 35}
	case "PageUp", "pageup":
		return cdpKeySpec{key: "PageUp", code: "PageUp", vk: 33}
	case "PageDown", "pagedown":
		return cdpKeySpec{key: "PageDown", code: "PageDown", vk: 34}
	}
	if utf8.RuneCountInString(raw) == 1 {
		r, _ := utf8.DecodeRuneInString(raw)
		code := ""
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			code = "Key" + strings.ToUpper(string(r))
		} else if r >= '0' && r <= '9' {
			code = "Digit" + string(r)
		}
		return cdpKeySpec{
			key:  string(r),
			code: code,
			text: string(r),
			vk:   int(unicode.ToUpper(r)),
		}
	}
	return cdpKeySpec{key: raw, code: raw}
}

// keyDesktop dispatches a keyDown + keyUp pair via CDP Input.dispatchKeyEvent.
func (r *Relay) keyDesktop(p desktopKeyParams) (desktopActionResult, error) {
	d, err := r.lookupDesktopForDrive("desktop.key", p.Name, p.Caller)
	if err != nil {
		return desktopActionResult{}, err
	}
	if p.Key == "" {
		return desktopActionResult{}, errors.New("desktop.key: key is required")
	}
	spec := cdpKeyFor(p.Key)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	down := map[string]any{
		"type": "keyDown",
		"key":  spec.key,
	}
	if spec.code != "" {
		down["code"] = spec.code
	}
	if spec.vk != 0 {
		down["windowsVirtualKeyCode"] = spec.vk
		down["nativeVirtualKeyCode"] = spec.vk
	}
	if spec.text != "" {
		down["text"] = spec.text
		down["unmodifiedText"] = spec.text
	}
	if _, err := d.call(ctx, "Input.dispatchKeyEvent", down); err != nil {
		return desktopActionResult{}, fmt.Errorf("desktop.key: keyDown(%s): %w", spec.key, err)
	}

	up := map[string]any{
		"type": "keyUp",
		"key":  spec.key,
	}
	if spec.code != "" {
		up["code"] = spec.code
	}
	if spec.vk != 0 {
		up["windowsVirtualKeyCode"] = spec.vk
		up["nativeVirtualKeyCode"] = spec.vk
	}
	if _, err := d.call(ctx, "Input.dispatchKeyEvent", up); err != nil {
		return desktopActionResult{}, fmt.Errorf("desktop.key: keyUp(%s): %w", spec.key, err)
	}

	d.settleAndCapture(ctx)
	log.Printf("[desktop] key '%s' (%s, caller=%s)", d.name, spec.key, callerLabel(p.Caller))
	return desktopActionResult{
		Name:   d.name,
		Action: "key",
		Key:    spec.key,
		Code:   spec.code,
		Frames: d.src.frames.Load(),
		Stills: d.stills.Load(),
	}, nil
}

// scrollDesktop dispatches a mouseWheel event in desktop pixels via CDP Input.dispatchMouseEvent.
func (r *Relay) scrollDesktop(p desktopScrollParams) (desktopActionResult, error) {
	d, err := r.lookupDesktopForDrive("desktop.scroll", p.Name, p.Caller)
	if err != nil {
		return desktopActionResult{}, err
	}
	if math.IsNaN(p.DX) || math.IsInf(p.DX, 0) || math.IsNaN(p.DY) || math.IsInf(p.DY, 0) {
		return desktopActionResult{}, errors.New("desktop.scroll: dx and dy must be finite numbers")
	}
	x := float64(d.width) / 2
	y := float64(d.height) / 2
	if p.X != nil {
		x = *p.X
	}
	if p.Y != nil {
		y = *p.Y
	}
	if math.IsNaN(x) || math.IsInf(x, 0) || math.IsNaN(y) || math.IsInf(y, 0) ||
		x < 0 || x >= float64(d.width) || y < 0 || y >= float64(d.height) {
		return desktopActionResult{}, fmt.Errorf("desktop.scroll: coordinates (%g, %g) out of desktop bounds %dx%d", x, y, d.width, d.height)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if _, err := d.call(ctx, "Input.dispatchMouseEvent", map[string]any{
		"type":   "mouseWheel",
		"x":      x,
		"y":      y,
		"deltaX": p.DX,
		"deltaY": p.DY,
	}); err != nil {
		return desktopActionResult{}, fmt.Errorf("desktop.scroll: mouseWheel: %w", err)
	}

	d.settleAndCapture(ctx)
	log.Printf("[desktop] scroll '%s' dx=%g dy=%g at (%g, %g) (caller=%s)", d.name, p.DX, p.DY, x, y, callerLabel(p.Caller))
	dx, dy := p.DX, p.DY
	return desktopActionResult{
		Name:   d.name,
		Action: "scroll",
		X:      &x,
		Y:      &y,
		DX:     &dx,
		DY:     &dy,
		Frames: d.src.frames.Load(),
		Stills: d.stills.Load(),
	}, nil
}

// replayDesktopsToDisplay pushes the latest cached 0x03 frame of every active
// desktop when a display connects or reloads, restoring live desktop FrameGrids
// with no user gesture.
func (r *Relay) replayDesktopsToDisplay() {
	r.waitRestore()
	r.desktopsMu.RLock()
	frames := make([][]byte, 0, len(r.desktops))
	for _, d := range r.desktops {
		d.frameMu.RLock()
		if len(d.lastFramed) > 0 {
			frames = append(frames, d.lastFramed)
		}
		d.frameMu.RUnlock()
	}
	r.desktopsMu.RUnlock()
	for _, f := range frames {
		r.sendFrameToDisplay(f)
	}
}

// handleDesktopRPC dispatches JSON-RPC 2.0 desktop/* calls from the display.
func (r *Relay) handleDesktopRPC(method string, rawID json.RawMessage, params json.RawMessage) {
	go func() {
		r.waitRestore()
		replyOK := func(result any) {
			resp, err := json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(rawID),
				"result":  result,
			})
			if err == nil {
				r.sendToDisplay(resp)
			}
		}
		replyErr := func(code int, msg string) {
			r.sendJSONRPCError(rawID, code, msg)
		}

		switch method {
		case "desktop/start":
			var p desktopStartParams
			if len(params) > 0 && json.Unmarshal(params, &p) != nil {
				replyErr(-32602, "invalid desktop/start params")
				return
			}
			sum, err := r.startDesktop(p)
			if err != nil {
				replyErr(-32000, err.Error())
				return
			}
			replyOK(sum)

		case "desktop/stop":
			var p desktopStopParams
			if len(params) > 0 && json.Unmarshal(params, &p) != nil {
				replyErr(-32602, "invalid desktop/stop params")
				return
			}
			sum, err := r.stopDesktop(p.Name)
			if err != nil {
				replyErr(-32000, err.Error())
				return
			}
			replyOK(sum)

		case "desktop/list":
			replyOK(map[string]any{"desktops": r.listDesktops()})

		case "desktop/still":
			var p desktopStillParams
			if len(params) > 0 && json.Unmarshal(params, &p) != nil {
				replyErr(-32602, "invalid desktop/still params")
				return
			}
			res, err := r.stillDesktop(p.Name)
			if err != nil {
				replyErr(-32000, err.Error())
				return
			}
			replyOK(res)

		case "desktop/go":
			var p desktopGoParams
			if len(params) > 0 && json.Unmarshal(params, &p) != nil {
				replyErr(-32602, "invalid desktop/go params")
				return
			}
			sum, err := r.goDesktop(p)
			if err != nil {
				replyErr(-32000, err.Error())
				return
			}
			replyOK(sum)

		case "desktop/click":
			var p desktopClickParams
			if len(params) > 0 && json.Unmarshal(params, &p) != nil {
				replyErr(-32602, "invalid desktop/click params")
				return
			}
			res, err := r.clickDesktop(p)
			if err != nil {
				replyErr(-32000, err.Error())
				return
			}
			replyOK(res)

		case "desktop/type":
			var p desktopTypeParams
			if len(params) > 0 && json.Unmarshal(params, &p) != nil {
				replyErr(-32602, "invalid desktop/type params")
				return
			}
			res, err := r.typeDesktop(p)
			if err != nil {
				replyErr(-32000, err.Error())
				return
			}
			replyOK(res)

		case "desktop/key":
			var p desktopKeyParams
			if len(params) > 0 && json.Unmarshal(params, &p) != nil {
				replyErr(-32602, "invalid desktop/key params")
				return
			}
			res, err := r.keyDesktop(p)
			if err != nil {
				replyErr(-32000, err.Error())
				return
			}
			replyOK(res)

		case "desktop/scroll":
			var p desktopScrollParams
			if len(params) > 0 && json.Unmarshal(params, &p) != nil {
				replyErr(-32602, "invalid desktop/scroll params")
				return
			}
			res, err := r.scrollDesktop(p)
			if err != nil {
				replyErr(-32000, err.Error())
				return
			}
			replyOK(res)

		default:
			replyErr(-32601, "unknown method: "+method)
		}
	}()
}

// parseDesktopStartArgs parses `<name> [WxH] [--browser <url>] [--chromium <bin>]`.
func parseDesktopStartArgs(args []string) (desktopStartParams, error) {
	var p desktopStartParams
	p.Width = 1280
	p.Height = 720
	p.URL = "about:blank"

	for i := 0; i < len(args); i++ {
		tok := args[i]
		switch tok {
		case "--browser", "--url":
			if i+1 >= len(args) {
				return p, fmt.Errorf("desktop.start: %s requires a URL", tok)
			}
			i++
			p.URL = args[i]
		case "--chromium":
			if i+1 >= len(args) {
				return p, errors.New("desktop.start: --chromium requires a path")
			}
			i++
			p.Chromium = args[i]
		default:
			if strings.HasPrefix(tok, "--") {
				return p, fmt.Errorf("desktop.start: unknown flag %s", tok)
			}
			if w, h, ok := parseDesktopWxH(tok); ok && p.Name != "" {
				p.Width = w
				p.Height = h
			} else if p.Name == "" {
				p.Name = tok
			} else {
				return p, fmt.Errorf("desktop.start: unexpected argument %q (usage: desktop.start <name> [WxH] [--browser <url>])", tok)
			}
		}
	}
	if p.Name == "" {
		return p, errors.New("usage: desktop.start <name> [WxH] [--browser <url>]")
	}
	return p, nil
}

func parseDesktopWxH(s string) (int, int, bool) {
	a, b, ok := strings.Cut(strings.ToLower(s), "x")
	if !ok {
		return 0, 0, false
	}
	w, err1 := strconv.Atoi(a)
	h, err2 := strconv.Atoi(b)
	if err1 != nil || err2 != nil || w <= 0 || h <= 0 {
		return 0, 0, false
	}
	return w, h, true
}

// tryRelayDesktopWhenNoDisplay answers desktop.* directly on the relay when no
// display is connected, so producers can be managed and driven headlessly.
func (r *Relay) tryRelayDesktopWhenNoDisplay(ws *websocket.Conn, raw, caller string) bool {
	var argv []string
	if parsed, isCall := parseCallLine(raw); isCall {
		argv = parsed
	} else {
		argv = strings.Fields(raw)
	}
	if len(argv) == 0 {
		return false
	}
	verb := argv[0]
	args := argv[1:]
	switch verb {
	case "desktop.start", "desktop.stop", "desktop.list", "desktop.still",
		"desktop.go", "desktop.click", "desktop.type", "desktop.key", "desktop.scroll":
	default:
		return false
	}

	r.waitRestore()

	fail := func(err error) {
		ws.WriteMessage(websocket.TextMessage, []byte("ERR: "+err.Error()))
	}
	reply := func(text string, data any) {
		msg, err := json.Marshal(map[string]any{"response": text, "data": data})
		if err != nil {
			fail(err)
			return
		}
		ws.WriteMessage(websocket.TextMessage, msg)
	}

	switch verb {
	case "desktop.start":
		p, err := parseDesktopStartArgs(args)
		if err != nil {
			fail(err)
			return true
		}
		p.Owner = caller
		sum, err := r.startDesktop(p)
		if err != nil {
			fail(err)
			return true
		}
		reply(fmt.Sprintf("OK: desktop '%s' started (%dx%d, pid %d, %s)", sum.Name, sum.Width, sum.Height, sum.PID, sum.URL), sum)
		return true

	case "desktop.stop":
		if len(args) < 1 {
			fail(errors.New("usage: desktop.stop <name>"))
			return true
		}
		sum, err := r.stopDesktop(args[0])
		if err != nil {
			fail(err)
			return true
		}
		reply(fmt.Sprintf("OK: desktop '%s' stopped", sum.Name), sum)
		return true

	case "desktop.list":
		list := r.listDesktops()
		if len(list) == 0 {
			reply("no desktops running", list)
			return true
		}
		lines := make([]string, 0, len(list))
		for _, d := range list {
			lines = append(lines, fmt.Sprintf("%s  %dx%d  pid=%d  frames=%d stills=%d dropped=%d  url=%s",
				d.Name, d.Width, d.Height, d.PID, d.Frames, d.Stills, d.Dropped, d.URL))
		}
		reply(strings.Join(lines, "\n"), list)
		return true

	case "desktop.still":
		if len(args) < 1 {
			fail(errors.New("usage: desktop.still <name>"))
			return true
		}
		res, err := r.stillDesktop(args[0])
		if err != nil {
			fail(err)
			return true
		}
		reply(fmt.Sprintf("OK: desktop '%s' still #%d (%dx%d PNG, %d bytes)", res.Name, res.Stills, res.Width, res.Height, res.Bytes), res)
		return true

	case "desktop.go":
		if len(args) < 2 {
			fail(errors.New("usage: desktop.go <name> <url>"))
			return true
		}
		sum, err := r.goDesktop(desktopGoParams{Name: args[0], URL: args[1], Caller: caller})
		if err != nil {
			fail(err)
			return true
		}
		reply(fmt.Sprintf("OK: desktop '%s' -> %s", sum.Name, sum.URL), sum)
		return true

	case "desktop.click":
		if len(args) < 3 {
			fail(errors.New("usage: desktop.click <name> <x> <y>"))
			return true
		}
		x, err1 := strconv.ParseFloat(args[1], 64)
		y, err2 := strconv.ParseFloat(args[2], 64)
		if err1 != nil || err2 != nil {
			fail(errors.New("usage: desktop.click <name> <x> <y> (numeric coordinates)"))
			return true
		}
		res, err := r.clickDesktop(desktopClickParams{Name: args[0], X: x, Y: y, Caller: caller})
		if err != nil {
			fail(err)
			return true
		}
		reply(fmt.Sprintf("OK: desktop '%s' clicked (%g, %g)", res.Name, x, y), res)
		return true

	case "desktop.type":
		if len(args) < 2 {
			fail(errors.New("usage: desktop.type <name> <text>"))
			return true
		}
		text := strings.Join(args[1:], " ")
		res, err := r.typeDesktop(desktopTypeParams{Name: args[0], Text: text, Caller: caller})
		if err != nil {
			fail(err)
			return true
		}
		reply(fmt.Sprintf("OK: desktop '%s' typed %d bytes", res.Name, res.Length), res)
		return true

	case "desktop.key":
		if len(args) < 2 {
			fail(errors.New("usage: desktop.key <name> <key>"))
			return true
		}
		res, err := r.keyDesktop(desktopKeyParams{Name: args[0], Key: args[1], Caller: caller})
		if err != nil {
			fail(err)
			return true
		}
		reply(fmt.Sprintf("OK: desktop '%s' key %s", res.Name, res.Key), res)
		return true

	case "desktop.scroll":
		if len(args) < 3 {
			fail(errors.New("usage: desktop.scroll <name> <dx> <dy>"))
			return true
		}
		dx, err1 := strconv.ParseFloat(args[1], 64)
		dy, err2 := strconv.ParseFloat(args[2], 64)
		if err1 != nil || err2 != nil {
			fail(errors.New("usage: desktop.scroll <name> <dx> <dy> (numeric deltas)"))
			return true
		}
		res, err := r.scrollDesktop(desktopScrollParams{Name: args[0], DX: dx, DY: dy, Caller: caller})
		if err != nil {
			fail(err)
			return true
		}
		reply(fmt.Sprintf("OK: desktop '%s' scrolled (%g, %g)", res.Name, dx, dy), res)
		return true
	}
	return false
}

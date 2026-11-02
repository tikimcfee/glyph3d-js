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
}

type desktopStopParams struct {
	Name string `json:"name"`
}

type desktopStillParams struct {
	Name string `json:"name"`
}

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

// desktopSession is one relay-owned headless Chromium producer driven over CDP.
type desktopSession struct {
	relay   *Relay
	name    string
	width   int
	height  int
	url     string
	cmd     *exec.Cmd
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

	bin, err := findChromiumBinary(strings.TrimSpace(p.Chromium))
	if err != nil {
		return DesktopSummary{}, err
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

	tmpDir, err := os.MkdirTemp("", "glyph3d-desktop-*")
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
	cmd := exec.Command(bin, args...)
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
	cdpWS, _, err := websocket.DefaultDialer.DialContext(dialCtx, pageWSURL, nil)
	cancel()
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		os.RemoveAll(tmpDir)
		return DesktopSummary{}, fmt.Errorf("desktop.start: dial CDP page target: %w", err)
	}

	src := &sourceConn{
		id:    name,
		kind:  "desktop",
		since: time.Now(),
	}
	d := &desktopSession{
		relay:   r,
		name:    name,
		width:   width,
		height:  height,
		url:     targetURL,
		cmd:     cmd,
		tmpDir:  tmpDir,
		cdpWS:   cdpWS,
		src:     src,
		started: src.since,
		pending: make(map[int64]chan cdpReply),
		loadCh:  make(chan struct{}, 1),
		done:    make(chan struct{}),
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
	go func() {
		_ = cmd.Wait()
		d.close()
	}()

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

	log.Printf("[desktop] started '%s' (%dx%d, url=%s, pid=%d)", name, width, height, targetURL, cmd.Process.Pid)
	return d.summary(), nil
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
	d.frameMu.RUnlock()
	if fmtName == "" {
		fmtName = "jpeg"
	}
	return DesktopSummary{
		Name:        d.name,
		Width:       d.width,
		Height:      d.height,
		URL:         d.url,
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

// replayDesktopsToDisplay pushes the latest cached 0x03 frame of every active
// desktop when a display connects or reloads, restoring live desktop FrameGrids
// with no user gesture.
func (r *Relay) replayDesktopsToDisplay() {
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

// tryRelayDesktopWhenNoDisplay answers desktop.start|stop|list|still directly on
// the relay when no display is connected, so producers can be managed headlessly
// before a browser attaches.
func (r *Relay) tryRelayDesktopWhenNoDisplay(ws *websocket.Conn, raw string) bool {
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
	if verb != "desktop.start" && verb != "desktop.stop" && verb != "desktop.list" && verb != "desktop.still" {
		return false
	}

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
	}
	return false
}

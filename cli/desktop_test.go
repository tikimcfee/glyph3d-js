package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type recordedCDPCall struct {
	Method string
	Params map[string]any
}

type fakeCDPServer struct {
	srv   *httptest.Server
	wsURL string

	mu    sync.Mutex
	calls []recordedCDPCall
	conns []*websocket.Conn
}

func newFakeCDPServer(t *testing.T) *fakeCDPServer {
	t.Helper()
	// Encode a valid 2x2 PNG for Page.captureScreenshot replies.
	img := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.NRGBA{R: 255, G: 0, B: 0, A: 255})
	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, img); err != nil {
		t.Fatalf("encode test png: %v", err)
	}
	pngB64 := base64.StdEncoding.EncodeToString(pngBuf.Bytes())

	f := &fakeCDPServer{}
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		f.mu.Lock()
		f.conns = append(f.conns, ws)
		f.mu.Unlock()
		defer ws.Close()

		var writeMu sync.Mutex
		sendJSON := func(v any) {
			writeMu.Lock()
			defer writeMu.Unlock()
			_ = ws.WriteJSON(v)
		}

		for {
			_, raw, err := ws.ReadMessage()
			if err != nil {
				return
			}
			var req struct {
				ID     int64          `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if json.Unmarshal(raw, &req) != nil {
				continue
			}
			f.mu.Lock()
			f.calls = append(f.calls, recordedCDPCall{
				Method: req.Method,
				Params: req.Params,
			})
			f.mu.Unlock()

			switch req.Method {
			case "Page.captureScreenshot":
				sendJSON(map[string]any{
					"id":     req.ID,
					"result": map[string]any{"data": pngB64},
				})
			case "Page.navigate":
				sendJSON(map[string]any{
					"id":     req.ID,
					"result": map[string]any{"frameId": "main"},
				})
				sendJSON(map[string]any{
					"method": "Page.loadEventFired",
					"params": map[string]any{"timestamp": 1.0},
				})
			default:
				sendJSON(map[string]any{
					"id":     req.ID,
					"result": map[string]any{},
				})
			}
		}
	}))
	f.wsURL = "ws" + strings.TrimPrefix(f.srv.URL, "http")
	t.Cleanup(func() {
		f.mu.Lock()
		conns := append([]*websocket.Conn(nil), f.conns...)
		f.mu.Unlock()
		for _, c := range conns {
			_ = c.Close()
		}
		f.srv.Close()
	})
	return f
}

func (f *fakeCDPServer) dial(_ desktopStartParams) (*websocket.Conn, error) {
	ws, _, err := websocket.DefaultDialer.Dial(f.wsURL, nil)
	return ws, err
}

func (f *fakeCDPServer) takeCalls() []recordedCDPCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := append([]recordedCDPCall(nil), f.calls...)
	f.calls = nil
	return out
}

func filterNonScreenshotCalls(calls []recordedCDPCall) []recordedCDPCall {
	out := make([]recordedCDPCall, 0, len(calls))
	for _, c := range calls {
		if c.Method != "Page.captureScreenshot" {
			out = append(out, c)
		}
	}
	return out
}

func TestDesktopDriving_CDPShapesAndOwnership(t *testing.T) {
	oldSettle := desktopInputSettle
	desktopInputSettle = 0
	t.Cleanup(func() { desktopInputSettle = oldSettle })

	fake := newFakeCDPServer(t)
	r := NewRelay()
	r.desktopStatePath = filepath.Join(t.TempDir(), "desktops.json")
	r.testCDPDial = fake.dial

	sum, err := r.startDesktop(desktopStartParams{
		Name:   "d-drive",
		Width:  400,
		Height: 300,
		URL:    "http://127.0.0.1/init",
		Owner:  "agent-alpha",
	})
	if err != nil {
		t.Fatalf("startDesktop: %v", err)
	}
	t.Cleanup(func() { _, _ = r.stopDesktop("d-drive") })

	if sum.Owner != "agent-alpha" || sum.Width != 400 || sum.Height != 300 {
		t.Fatalf("unexpected summary: %+v", sum)
	}

	initCalls := fake.takeCalls()
	if len(initCalls) < 4 {
		t.Fatalf("expected setup CDP calls, got %d: %+v", len(initCalls), initCalls)
	}

	// 1. Ownership gate: another identified caller is refused across all drive verbs.
	if _, err := r.goDesktop(desktopGoParams{Name: "d-drive", URL: "http://127.0.0.1/bad", Caller: "agent-beta"}); err == nil || !strings.Contains(err.Error(), "owned by agent-alpha") {
		t.Fatalf("expected ownership refusal for goDesktop, got: %v", err)
	}
	if _, err := r.clickDesktop(desktopClickParams{Name: "d-drive", X: 10, Y: 10, Caller: "agent-beta"}); err == nil || !strings.Contains(err.Error(), "owned by agent-alpha") {
		t.Fatalf("expected ownership refusal for clickDesktop, got: %v", err)
	}
	if _, err := r.typeDesktop(desktopTypeParams{Name: "d-drive", Text: "nope", Caller: "agent-beta"}); err == nil || !strings.Contains(err.Error(), "owned by agent-alpha") {
		t.Fatalf("expected ownership refusal for typeDesktop, got: %v", err)
	}
	if _, err := r.keyDesktop(desktopKeyParams{Name: "d-drive", Key: "Enter", Caller: "agent-beta"}); err == nil || !strings.Contains(err.Error(), "owned by agent-alpha") {
		t.Fatalf("expected ownership refusal for keyDesktop, got: %v", err)
	}
	if _, err := r.scrollDesktop(desktopScrollParams{Name: "d-drive", DX: 0, DY: 50, Caller: "agent-beta"}); err == nil || !strings.Contains(err.Error(), "owned by agent-alpha") {
		t.Fatalf("expected ownership refusal for scrollDesktop, got: %v", err)
	}
	if got := filterNonScreenshotCalls(fake.takeCalls()); len(got) != 0 {
		t.Fatalf("refused caller must not emit CDP calls, got: %+v", got)
	}

	// 2. Coordinate bounds check: out-of-range coordinates refused before CDP.
	for _, tc := range []struct {
		x, y float64
	}{
		{-1, 10},
		{10, -1},
		{400, 10},
		{10, 300},
		{math.NaN(), 10},
	} {
		if _, err := r.clickDesktop(desktopClickParams{Name: "d-drive", X: tc.x, Y: tc.y, Caller: "agent-alpha"}); err == nil {
			t.Fatalf("expected bounds error for click (%v, %v)", tc.x, tc.y)
		}
	}
	if got := filterNonScreenshotCalls(fake.takeCalls()); len(got) != 0 {
		t.Fatalf("out-of-bounds clicks must not emit CDP calls, got: %+v", got)
	}

	// 3. desktop.go (by owning agent): Page.navigate with target URL.
	navSum, err := r.goDesktop(desktopGoParams{
		Name:   "d-drive",
		URL:    "http://127.0.0.1/page2",
		Caller: "agent-alpha",
	})
	if err != nil {
		t.Fatalf("goDesktop (owner): %v", err)
	}
	if navSum.URL != "http://127.0.0.1/page2" {
		t.Fatalf("expected URL updated to page2, got %q", navSum.URL)
	}
	navCalls := filterNonScreenshotCalls(fake.takeCalls())
	if len(navCalls) != 1 || navCalls[0].Method != "Page.navigate" || navCalls[0].Params["url"] != "http://127.0.0.1/page2" {
		t.Fatalf("unexpected goDesktop CDP calls: %+v", navCalls)
	}

	// 4. desktop.click (by owning agent): mouseMoved -> mousePressed -> mouseReleased at (120, 80).
	if _, err := r.clickDesktop(desktopClickParams{
		Name:   "d-drive",
		X:      120,
		Y:      80,
		Caller: "agent-alpha",
	}); err != nil {
		t.Fatalf("clickDesktop: %v", err)
	}
	clickCalls := filterNonScreenshotCalls(fake.takeCalls())
	if len(clickCalls) != 3 {
		t.Fatalf("expected 3 mouse CDP calls for click, got %d: %+v", len(clickCalls), clickCalls)
	}
	wantTypes := []string{"mouseMoved", "mousePressed", "mouseReleased"}
	for i, wantType := range wantTypes {
		c := clickCalls[i]
		if c.Method != "Input.dispatchMouseEvent" || c.Params["type"] != wantType || c.Params["x"] != float64(120) || c.Params["y"] != float64(80) {
			t.Fatalf("click call %d mismatch: %+v", i, c)
		}
	}

	// 5. desktop.type (by anonymous person — allowed even when owned): Input.insertText.
	if _, err := r.typeDesktop(desktopTypeParams{
		Name:   "d-drive",
		Text:   "hello planes",
		Caller: "",
	}); err != nil {
		t.Fatalf("typeDesktop (anonymous person): %v", err)
	}
	typeCalls := filterNonScreenshotCalls(fake.takeCalls())
	if len(typeCalls) != 1 || typeCalls[0].Method != "Input.insertText" || typeCalls[0].Params["text"] != "hello planes" {
		t.Fatalf("unexpected typeDesktop CDP calls: %+v", typeCalls)
	}

	// 6. desktop.key: keyDown -> keyUp with key/code/virtualKeyCode.
	if _, err := r.keyDesktop(desktopKeyParams{
		Name:   "d-drive",
		Key:    "Enter",
		Caller: "agent-alpha",
	}); err != nil {
		t.Fatalf("keyDesktop: %v", err)
	}
	keyCalls := filterNonScreenshotCalls(fake.takeCalls())
	if len(keyCalls) != 2 ||
		keyCalls[0].Method != "Input.dispatchKeyEvent" || keyCalls[0].Params["type"] != "keyDown" || keyCalls[0].Params["key"] != "Enter" ||
		keyCalls[1].Method != "Input.dispatchKeyEvent" || keyCalls[1].Params["type"] != "keyUp" || keyCalls[1].Params["key"] != "Enter" {
		t.Fatalf("unexpected keyDesktop CDP calls: %+v", keyCalls)
	}

	// 7. desktop.scroll: Input.dispatchMouseEvent mouseWheel with deltaX/deltaY at viewport center (200, 150).
	if _, err := r.scrollDesktop(desktopScrollParams{
		Name:   "d-drive",
		DX:     15,
		DY:     -120,
		Caller: "agent-alpha",
	}); err != nil {
		t.Fatalf("scrollDesktop: %v", err)
	}
	scrollCalls := filterNonScreenshotCalls(fake.takeCalls())
	if len(scrollCalls) != 1 ||
		scrollCalls[0].Method != "Input.dispatchMouseEvent" ||
		scrollCalls[0].Params["type"] != "mouseWheel" ||
		scrollCalls[0].Params["x"] != float64(200) ||
		scrollCalls[0].Params["y"] != float64(150) ||
		scrollCalls[0].Params["deltaX"] != float64(15) ||
		scrollCalls[0].Params["deltaY"] != float64(-120) {
		t.Fatalf("unexpected scrollDesktop CDP calls: %+v", scrollCalls)
	}

	// 8. desktop.eval is NOT supported (no arbitrary JS).
	if r.tryRelayDesktopWhenNoDisplay(nil, "desktop.eval d-drive 1+1", "agent-alpha") {
		t.Fatalf("desktop.eval must not be handled by tryRelayDesktopWhenNoDisplay")
	}
	r.mu.Lock()
	ch := make(chan displayMsg, 4)
	r.displayWrite = ch
	r.mu.Unlock()
	r.handleDesktopRPC("desktop/eval", json.RawMessage(`99`), json.RawMessage(`{"name":"d-drive","expression":"1+1"}`))
	select {
	case msg := <-ch:
		if !strings.Contains(string(msg.data), "-32601") || !strings.Contains(string(msg.data), "desktop/eval") {
			t.Fatalf("expected -32601 unknown method for desktop/eval, got %s", string(msg.data))
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for desktop/eval rejection")
	}
}

func TestDesktopPersistence_SurvivesRelayRestartAndStopForgets(t *testing.T) {
	oldSettle := desktopInputSettle
	desktopInputSettle = 0
	t.Cleanup(func() { desktopInputSettle = oldSettle })

	fake := newFakeCDPServer(t)
	servedRoot := t.TempDir()
	fsHandler, err := NewFSHandler(servedRoot, nil)
	if err != nil {
		t.Fatalf("NewFSHandler: %v", err)
	}
	t.Cleanup(func() { fsHandler.Close() })

	// Relay 1: start an owned desktop and navigate it to a second URL.
	r1 := NewRelay()
	r1.fs = fsHandler
	r1.testCDPDial = fake.dial

	if _, err := r1.startDesktop(desktopStartParams{
		Name:   "d-persist",
		Width:  320,
		Height: 200,
		URL:    "http://127.0.0.1/initial",
		Owner:  "agent-owner",
	}); err != nil {
		t.Fatalf("r1.startDesktop: %v", err)
	}
	if _, err := r1.goDesktop(desktopGoParams{
		Name:   "d-persist",
		URL:    "http://127.0.0.1/updated",
		Caller: "agent-owner",
	}); err != nil {
		t.Fatalf("r1.goDesktop: %v", err)
	}

	// Verify state is persisted under <servedRoot>/.glyph3d/desktops.json and never touches .glyph3d-session.json.
	statePath := filepath.Join(servedRoot, ".glyph3d", "desktops.json")
	if _, err := os.Stat(statePath); err != nil {
		t.Fatalf("expected persisted state at %s: %v", statePath, err)
	}
	if _, err := os.Stat(filepath.Join(servedRoot, ".glyph3d-session.json")); !os.IsNotExist(err) {
		t.Fatalf("desktop persistence must never write .glyph3d-session.json")
	}

	// Simulate relay termination (d.close() runs when Chromium dies, without desktop.stop).
	r1.desktopsMu.RLock()
	d1 := r1.desktops["d-persist"]
	r1.desktopsMu.RUnlock()
	if d1 != nil {
		d1.close()
	}

	// Relay 2: fresh relay pointed at the same served root restores the desktop on boot.
	r2 := NewRelay()
	r2.fs = fsHandler
	r2.testCDPDial = fake.dial

	r2.BeginRestoreDesktops()
	list := r2.listDesktops()
	r2.waitRestore()
	list = r2.listDesktops()
	if len(list) != 1 {
		t.Fatalf("expected 1 restored desktop on r2, got %d: %+v", len(list), list)
	}
	got := list[0]
	if got.Name != "d-persist" || got.Width != 320 || got.Height != 200 || got.URL != "http://127.0.0.1/updated" || got.Owner != "agent-owner" {
		t.Fatalf("restored desktop spec mismatch: %+v", got)
	}

	// Ownership is preserved on the restored desktop.
	if _, err := r2.clickDesktop(desktopClickParams{Name: "d-persist", X: 50, Y: 50, Caller: "intruder"}); err == nil {
		t.Fatalf("expected restored desktop to refuse non-owner")
	}
	if _, err := r2.clickDesktop(desktopClickParams{Name: "d-persist", X: 50, Y: 50, Caller: "agent-owner"}); err != nil {
		t.Fatalf("expected restored desktop to allow owner, got: %v", err)
	}

	// desktop.stop forgets the persisted spec.
	if _, err := r2.stopDesktop("d-persist"); err != nil {
		t.Fatalf("r2.stopDesktop: %v", err)
	}

	// Relay 3: fresh relay after desktop.stop restores nothing.
	r3 := NewRelay()
	r3.fs = fsHandler
	r3.testCDPDial = fake.dial
	restored3, err := r3.RestoreDesktops()
	if err != nil {
		t.Fatalf("r3.RestoreDesktops: %v", err)
	}
	if restored3 != 0 || len(r3.listDesktops()) != 0 {
		t.Fatalf("expected 0 desktops restored after stop, got %d (%+v)", restored3, r3.listDesktops())
	}
}

func TestDesktopDriving_RealChromiumButtonClick(t *testing.T) {
	if _, err := findChromiumBinary(""); err != nil {
		t.Skipf("skipping real Chromium test: %v", err)
	}

	pageSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<!doctype html>
<html>
<head>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: rgb(255, 0, 0); }
  #btn { position: fixed; inset: 0; width: 100%; height: 100%; border: none; background: rgb(255, 0, 0); color: #fff; font: bold 24px sans-serif; cursor: pointer; }
  body.clicked, body.clicked #btn { background: rgb(0, 255, 0); color: #000; }
</style>
</head>
<body>
  <button id="btn" onclick="document.body.classList.add('clicked'); this.textContent='CLICKED';">READY</button>
</body>
</html>`))
	}))
	defer pageSrv.Close()

	r := NewRelay()
	r.desktopStatePath = filepath.Join(t.TempDir(), "desktops.json")

	_, err := r.startDesktop(desktopStartParams{
		Name:   "d-live-btn",
		Width:  240,
		Height: 160,
		URL:    pageSrv.URL,
		Owner:  "agent-tester",
	})
	if err != nil {
		t.Fatalf("startDesktop: %v", err)
	}
	t.Cleanup(func() { _, _ = r.stopDesktop("d-live-btn") })

	sampleCenterRGB := func(b64 string) (uint8, uint8, uint8) {
		raw, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			t.Fatalf("decode still base64: %v", err)
		}
		img, err := png.Decode(bytes.NewReader(raw))
		if err != nil {
			t.Fatalf("decode still png: %v", err)
		}
		c := color.NRGBAModel.Convert(img.At(120, 80)).(color.NRGBA)
		return c.R, c.G, c.B
	}

	before, err := r.stillDesktop("d-live-btn")
	if err != nil {
		t.Fatalf("stillDesktop before: %v", err)
	}
	r0, g0, b0 := sampleCenterRGB(before.PNGBase64)
	if r0 < 200 || g0 > 40 || b0 > 40 {
		t.Fatalf("expected red pixel before click at (120,80), got RGB(%d,%d,%d)", r0, g0, b0)
	}

	if _, err := r.clickDesktop(desktopClickParams{
		Name:   "d-live-btn",
		X:      120,
		Y:      80,
		Caller: "agent-tester",
	}); err != nil {
		t.Fatalf("clickDesktop: %v", err)
	}

	after, err := r.stillDesktop("d-live-btn")
	if err != nil {
		t.Fatalf("stillDesktop after: %v", err)
	}
	r1, g1, b1 := sampleCenterRGB(after.PNGBase64)
	if g1 < 200 || r1 > 40 || b1 > 40 {
		t.Fatalf("expected green pixel after click at (120,80), got RGB(%d,%d,%d)", r1, g1, b1)
	}
}

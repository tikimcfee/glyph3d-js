// fullsnapshot — capture a real browser viewport screenshot via WebDriver BiDi.
//
// Firefox 150's --remote-debugging-port serves WebDriver BiDi (not Chrome
// DevTools Protocol). BiDi is JSON-RPC over a single WebSocket — same idea
// as CDP, different method names and an explicit session-creation step.
//
// The plain `screenshot` subcommand grabs only the WebGL canvas via the
// app's CommandRouter, missing DOM overlays (the bottom-third command bar,
// status badges, anything not in WebGL). This subcommand asks the browser
// itself to capture its viewport so the resulting PNG matches what the
// user is seeing.
//
// Usage:
//
//	# Launch Firefox with BiDi enabled (one-time per browser session):
//	mkdir -p /tmp/glyph-dev-profile
//	# (write user.js with remote.enabled=true, remote.active-protocols=3)
//	firefox --no-remote --profile /tmp/glyph-dev-profile \
//	        --remote-debugging-port=9222 \
//	        http://localhost:9876/app/home.html
//
//	# Then snapshot:
//	glyph3d-cli fullsnapshot -o /tmp/snap.png
//	glyph3d-cli fullsnapshot -port 9222 -url-substr /app/home -o /tmp/snap.png

package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/gorilla/websocket"
)

// BiDi command envelope.
type bidiCommand struct {
	ID     int                    `json:"id"`
	Method string                 `json:"method"`
	Params map[string]interface{} `json:"params"`
}

// BiDi response envelope — type is "success" for replies, "error" for
// errors, or "event" for unsolicited messages we should ignore.
type bidiResponse struct {
	Type    string          `json:"type"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   string          `json:"error,omitempty"`
	Message string          `json:"message,omitempty"`
}

type browsingContextInfo struct {
	Context  string                `json:"context"`
	URL      string                `json:"url"`
	Children []browsingContextInfo `json:"children"`
}

type getTreeResult struct {
	Contexts []browsingContextInfo `json:"contexts"`
}

type captureResult struct {
	Data string `json:"data"`
}

func fullsnapshotCmd() {
	const usage = "glyph3d-cli fullsnapshot [-o FILE] [--port N] [--url-substr S] [-v]"
	fs := newFlagSet("fullsnapshot")
	out := fs.String("o", "/tmp/glyph-fullsnapshot.png", "Output PNG file path")
	port := fs.Int("port", 9222, "Firefox remote-debugging-port (BiDi WebSocket)")
	urlSubstr := fs.String("url-substr", "home.html", "Substring to match in tab URL (picks first match)")
	verbose := fs.Bool("v", false, "Print all BiDi traffic to stderr")
	extra, perr := parseArgs(fs, os.Args[2:])
	if perr != nil {
		failParse("fullsnapshot", usage, perr)
	}
	if len(extra) > 0 {
		failParse("fullsnapshot", usage, fmt.Errorf("unexpected argument %q (the output path is -o FILE)", extra[0]))
	}

	// 1. Connect to the BiDi WebSocket. Firefox listens at /session for
	//    direct BiDi clients; the path is required.
	url := fmt.Sprintf("ws://127.0.0.1:%d/session", *port)
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		log.Fatalf("dial %s: %v\n(is Firefox running with --remote-debugging-port=%d, remote.enabled=true, remote.active-protocols=3?)", url, err, *port)
	}
	defer func() {
		// Send the WebSocket Close control frame so Firefox sees a clean
		// shutdown — otherwise it treats an abrupt TCP close as "client
		// dropped, keep the session alive in case they come back" and we
		// leak BiDi sessions until they time out.
		_ = conn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, "done"))
		conn.Close()
	}()
	if *verbose { fmt.Fprintf(os.Stderr, "connected: %s\n", url) }

	send := func(id int, method string, params map[string]interface{}) bidiResponse {
		cmd := bidiCommand{ID: id, Method: method, Params: params}
		if *verbose {
			b, _ := json.Marshal(cmd)
			fmt.Fprintf(os.Stderr, "→ %s\n", string(b))
		}
		if err := conn.WriteJSON(cmd); err != nil {
			log.Fatalf("send %s: %v", method, err)
		}
		// Read until we get the reply for this id (skip unrelated events).
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				log.Fatalf("read %s reply: %v", method, err)
			}
			var r bidiResponse
			if err := json.Unmarshal(msg, &r); err != nil { continue }
			if *verbose {
				fmt.Fprintf(os.Stderr, "← %s (type=%s id=%d)\n",
					truncate(string(msg), 200), r.Type, r.ID)
			}
			if r.Type == "event" { continue }
			if r.ID != id { continue }
			if r.Type == "error" {
				log.Fatalf("%s failed: %s — %s", method, r.Error, r.Message)
			}
			return r
		}
	}

	// 2. session.new — bootstrap a BiDi session.
	send(1, "session.new", map[string]interface{}{
		"capabilities": map[string]interface{}{
			"alwaysMatch": map[string]interface{}{},
		},
	})

	// 3. session.subscribe is not required for one-shot captures.

	// 4. browsingContext.getTree — list open tabs/windows.
	treeResp := send(2, "browsingContext.getTree", map[string]interface{}{})
	var tree getTreeResult
	if err := json.Unmarshal(treeResp.Result, &tree); err != nil {
		log.Fatalf("decode getTree result: %v", err)
	}

	// 5. Pick the context whose URL contains our substring. Walk
	//    children too — frames are nested, top-level tabs are roots.
	var targetCtx, targetURL string
	var walk func(c browsingContextInfo)
	walk = func(c browsingContextInfo) {
		if targetCtx != "" { return }
		if strings.Contains(c.URL, *urlSubstr) {
			targetCtx = c.Context
			targetURL = c.URL
			return
		}
		for _, ch := range c.Children { walk(ch) }
	}
	for _, c := range tree.Contexts { walk(c) }
	if targetCtx == "" {
		fmt.Fprintf(os.Stderr, "no context matched %q. Available:\n", *urlSubstr)
		for _, c := range tree.Contexts {
			fmt.Fprintf(os.Stderr, "  %s — %s\n", c.Context, c.URL)
			for _, ch := range c.Children {
				fmt.Fprintf(os.Stderr, "    └ %s — %s\n", ch.Context, ch.URL)
			}
		}
		os.Exit(1)
	}

	// 6. browsingContext.captureScreenshot — viewport pixels as PNG base64.
	capResp := send(3, "browsingContext.captureScreenshot", map[string]interface{}{
		"context": targetCtx,
	})
	var cap captureResult
	if err := json.Unmarshal(capResp.Result, &cap); err != nil {
		log.Fatalf("decode capture result: %v", err)
	}
	if cap.Data == "" {
		log.Fatalf("empty capture data")
	}

	imgBytes, err := base64.StdEncoding.DecodeString(cap.Data)
	if err != nil {
		log.Fatalf("decode image: %v", err)
	}
	if err := os.WriteFile(*out, imgBytes, 0644); err != nil {
		log.Fatalf("write file: %v", err)
	}

	fmt.Fprintf(os.Stderr, "Saved viewport snapshot to %s (%d bytes) — tab: %s\n",
		*out, len(imgBytes), targetURL)

	// Tear down so Firefox doesn't accumulate sessions (it caps the count
	// and rejects new connections after a few leaked).
	send(99, "session.end", map[string]interface{}{})
}

func truncate(s string, n int) string {
	if len(s) <= n { return s }
	return s[:n] + "…"
}

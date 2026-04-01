// glyph3d-cli — standalone WebSocket CLI for glyph3d-js viewer.
//
// Modes:
//
//	Relay:     glyph3d-cli serve [--port 8765] [--listen 0.0.0.0]
//	One-shot:  glyph3d-cli [--host url] <command...>
//	REPL:      glyph3d-cli [--host url]
//	Pipe:      echo "grid.list" | glyph3d-cli
//
// Build:
//
//	go build -o glyph3d-cli .
package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

var (
	host     = flag.String("host", "ws://localhost:8765", "WebSocket relay URL")
	port     = flag.Int("port", 0, "Shorthand: ws://localhost:<port>")
	jsonMode = flag.Bool("json", false, "Output raw JSON data")
	timeout  = flag.Duration("timeout", 5*time.Second, "Command response timeout")
)

// b64Commands are commands whose first text argument should be base64-encoded.
var b64Commands = map[string]bool{
	"grid.create":    true,
	"grid.text":      true,
	"window.write":   true,
	"label.create":   true,
	"scene.annotate": true,
	"terminal.input": true,
	"tour.load":      true,
	"tour.load.text": true,
}

func main() {
	// Check for subcommands before flag parsing
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "serve":
			serveCmd()
			return
		case "hook":
			hookCmdEntry()
			return
		case "screenshot":
			screenshotCmd()
			return
		}
	}

	flag.Parse()

	url := *host
	if *port > 0 {
		url = fmt.Sprintf("ws://localhost:%d", *port)
	}

	conn, err := connect(url)
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer conn.Close()

	args := flag.Args()
	if len(args) > 0 {
		// One-shot mode
		cmd := buildCommand(args)
		resp, err := sendCommand(conn, cmd)
		if err != nil {
			log.Fatalf("send: %v", err)
		}
		printResponse(resp)
		if strings.HasPrefix(resp.Text, "ERR:") {
			os.Exit(1)
		}
	} else if isInteractive() {
		// REPL mode
		repl(conn)
	} else {
		// Pipe mode
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ".") {
				continue
			}
			resp, err := sendCommand(conn, line)
			if err != nil {
				fmt.Fprintf(os.Stderr, "send error: %v\n", err)
				continue
			}
			printResponse(resp)
		}
	}
}

// --- Connection ---

func connect(url string) (*websocket.Conn, error) {
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", url, err)
	}

	// Handshake: send "ping", receive "OK: connected as ctrl-N", receive "pong"
	if err := conn.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
		conn.Close()
		return nil, fmt.Errorf("handshake ping: %w", err)
	}

	// Read ack
	_, msg, err := conn.ReadMessage()
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("handshake ack: %w", err)
	}
	ack := string(msg)
	if !strings.HasPrefix(ack, "OK:") {
		conn.Close()
		return nil, fmt.Errorf("unexpected ack: %s", ack)
	}
	fmt.Fprintf(os.Stderr, "%s\n", ack)

	// Read pong
	_, _, err = conn.ReadMessage()
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("handshake pong: %w", err)
	}

	return conn, nil
}

// --- Command Building ---

func buildCommand(args []string) string {
	if len(args) == 0 {
		return ""
	}

	cmdName := args[0]
	cmdArgs := args[1:]

	// Auto base64-encode text argument for known commands
	if b64Commands[cmdName] && len(cmdArgs) > 0 {
		cmdArgs[0] = base64.StdEncoding.EncodeToString([]byte(cmdArgs[0]))
	}

	if len(cmdArgs) == 0 {
		return cmdName
	}
	return cmdName + " " + strings.Join(cmdArgs, " ")
}

// --- Send/Receive ---

type Response struct {
	Text string          `json:"response"`
	Data json.RawMessage `json:"data"`
}

func sendCommand(conn *websocket.Conn, cmd string) (*Response, error) {
	if err := conn.WriteMessage(websocket.TextMessage, []byte(cmd)); err != nil {
		return nil, fmt.Errorf("write: %w", err)
	}

	conn.SetReadDeadline(time.Now().Add(*timeout))
	_, msg, err := conn.ReadMessage()
	conn.SetReadDeadline(time.Time{})
	if err != nil {
		return nil, fmt.Errorf("read: %w", err)
	}

	raw := string(msg)

	// Try parsing as JSON response
	var resp Response
	if err := json.Unmarshal(msg, &resp); err == nil && resp.Text != "" {
		return &resp, nil
	}

	// Plain text response
	return &Response{Text: raw}, nil
}

// --- Output ---

func printResponse(resp *Response) {
	if *jsonMode && len(resp.Data) > 0 && string(resp.Data) != "null" {
		var pretty bytes.Buffer
		if json.Indent(&pretty, resp.Data, "", "  ") == nil {
			fmt.Println(pretty.String())
		} else {
			fmt.Println(string(resp.Data))
		}
	} else {
		fmt.Println(resp.Text)
	}
}

// --- REPL ---

func repl(conn *websocket.Conn) {
	fmt.Println("glyph3d-cli REPL. Type 'help' for commands, '.exit' to quit.")

	scanner := bufio.NewScanner(os.Stdin)
	for {
		fmt.Print("glyph3d> ")
		if !scanner.Scan() {
			break
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		// Meta commands
		switch line {
		case ".exit", ".quit":
			return
		case ".json on":
			*jsonMode = true
			fmt.Println("JSON mode on")
			continue
		case ".json off":
			*jsonMode = false
			fmt.Println("JSON mode off")
			continue
		case ".help":
			fmt.Println("  .exit / .quit   Exit REPL")
			fmt.Println("  .json on/off    Toggle JSON output")
			fmt.Println("  .help           This help")
			fmt.Println("  Any other input is sent as a command to the viewer.")
			continue
		}

		resp, err := sendCommand(conn, line)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			continue
		}
		printResponse(resp)
	}
}

// screenshotCmd captures the 3D canvas and saves to a PNG file.
func screenshotCmd() {
	fs := flag.NewFlagSet("screenshot", flag.ExitOnError)
	out := fs.String("o", "/tmp/glyph-screenshot.png", "Output PNG file path")
	wsURL := fs.String("host", "ws://localhost:8765", "WebSocket relay URL")
	p := fs.Int("port", 0, "Shorthand port")
	fs.Parse(os.Args[2:])

	url := *wsURL
	if *p > 0 {
		url = fmt.Sprintf("ws://localhost:%d", *p)
	}

	conn, err := connect(url)
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer conn.Close()

	resp, err := sendCommand(conn, "screenshot")
	if err != nil {
		log.Fatalf("screenshot: %v", err)
	}

	if strings.HasPrefix(resp.Text, "ERR:") {
		fmt.Fprintln(os.Stderr, resp.Text)
		os.Exit(1)
	}

	// Extract base64 image from response data
	var data struct {
		Width  int    `json:"width"`
		Height int    `json:"height"`
		Image  string `json:"image"`
	}
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		log.Fatalf("parse response: %v", err)
	}

	imgBytes, err := base64.StdEncoding.DecodeString(data.Image)
	if err != nil {
		log.Fatalf("decode image: %v", err)
	}

	if err := os.WriteFile(*out, imgBytes, 0644); err != nil {
		log.Fatalf("write file: %v", err)
	}

	fmt.Fprintf(os.Stderr, "Saved %dx%d screenshot to %s (%d bytes)\n", data.Width, data.Height, *out, len(imgBytes))
}

func isInteractive() bool {
	fi, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

// serveCmd runs the unified HTTP + WebSocket server.
//
// The positional argument is the project directory to browse (default: cwd).
// The IDE app is always served from embedded assets unless --local is set.
//
// Usage:
//
//	glyph3d-cli serve                    Browse current directory
//	glyph3d-cli serve ~/some-project     Browse that project
//	glyph3d-cli serve --port 3000        Custom port
//	glyph3d-cli serve --local            IDE dev: serve app from disk instead of embedded
//	glyph3d-cli serve --relay-only       WebSocket relay only, no static files
func serveCmd() {
	flagSet := flag.NewFlagSet("serve", flag.ExitOnError)
	p := flagSet.Int("port", 8080, "Port to listen on")
	listen := flagSet.String("listen", "0.0.0.0", "Address to listen on")
	local := flagSet.Bool("local", false, "Serve IDE app from disk instead of embedded (dev mode)")
	relayOnly := flagSet.Bool("relay-only", false, "WebSocket relay only, no static files")
	flagSet.Parse(os.Args[2:])

	// Project path: positional arg or cwd
	projectPath := "."
	if flagSet.NArg() > 0 {
		projectPath = flagSet.Arg(0)
	}

	// Legacy relay-only mode
	if *relayOnly {
		fsHandler, err := NewFSHandler(projectPath)
		if err != nil {
			log.Fatalf("[relay] project path: %v", err)
		}
		if err := RunRelay(*listen, *p, fsHandler); err != nil {
			log.Fatalf("[relay] %v", err)
		}
		return
	}

	// Filesystem access: always on, rooted at the project path
	fsHandler, err := NewFSHandler(projectPath)
	if err != nil {
		log.Fatalf("[serve] project path: %v", err)
	}

	cfg := ServerConfig{
		Host:      *listen,
		Port:      *p,
		FSHandler: fsHandler,
	}

	if *local {
		// Dev mode: serve IDE app from disk (for hacking on glyph3d itself)
		cfg.StaticFS = os.DirFS(projectPath)
		cfg.StaticTag = fsHandler.root + " (local)"
	} else {
		// Normal mode: embedded IDE app
		webRoot, err := WebRoot()
		if err != nil {
			log.Fatalf("[serve] embedded FS: %v", err)
		}
		cfg.StaticFS = webRoot
		cfg.StaticTag = "embedded"
	}

	if err := RunServer(cfg); err != nil {
		log.Fatalf("[serve] %v", err)
	}
}

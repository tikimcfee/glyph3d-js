// glyph3d-cli — the glyph3d-js single binary: the server, and the one relay client.
//
// Server side:
//
//	glyph3d-cli serve [dir] [--port 8080] [--listen 0.0.0.0] [--tmux-socket glyphd]
//	glyph3d-cli hook [--kimi] [--debug]     (harness hook ingress: claude default, --kimi for Kimi Code)
//	glyph3d-cli attach / fullsnapshot       (terminal adapters the relay forks)
//	glyph3d-cli version
//
// Client side — global flags go BEFORE the verb or client command:
//
//	glyph3d-cli [--port N | --host url] [--json] [--timeout 5s] <verb args...>   one-shot (oneShotLine)
//	glyph3d-cli [...] screenshot [-o out.png] [--cmd 'verb …']... [--wait 300ms]
//	glyph3d-cli [...] log.follow [--filter s] [--level csv] [--scope s] [--level-set LVL]
//	glyph3d-cli [...] seed-history [--lines 300] [--tmux-socket glyphd] [id ...]
//	glyph3d-cli [...]                       REPL (interactive stdin)
//	echo "grid.list" | glyph3d-cli          pipe: one command line per input line
//
// Build:
//
//	go build -o glyph3d-cli .
package main

import (
	"bufio"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Build-time version info (set via -ldflags)
var (
	Version   = "dev"
	BuildDate = "unknown"
	Platform  = "unknown"
)

var (
	host     = flag.String("host", "ws://localhost:8080", "WebSocket relay URL")
	port     = flag.Int("port", 0, "Shorthand: ws://localhost:<port>")
	jsonMode = flag.Bool("json", false, "Output raw JSON data (log.follow: one record per line)")
	timeout  = flag.Duration("timeout", 5*time.Second, "Command response timeout")
)

func main() {
	// Server-side subcommands own their flags.
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "serve":
			serveCmd()
			return
		case "hook":
			hookCmdEntry()
			return
		case "attach":
			attachCmd()
			return
		case "fullsnapshot":
			fullsnapshotCmd()
			return
		case "version":
			versionCmd()
			return
		}
	}

	flag.Usage = clientUsage
	flag.Parse()

	url := *host
	if *port > 0 {
		url = fmt.Sprintf("ws://localhost:%d", *port)
	}

	args := flag.Args()
	if len(args) > 0 {
		switch args[0] {
		case "screenshot":
			os.Exit(screenshotCmd(url, args[1:]))
		case "log.follow":
			os.Exit(logFollowCmd(url, args[1:]))
		case "seed-history":
			os.Exit(seedHistoryCmd(url, args[1:]))
		}
	}

	s := openSession(url)
	defer s.close()

	switch {
	case len(args) > 0:
		// One-shot: a typed line when the argv is plain tokens, a `call` bundle when an
		// argument needs carrying (see oneShotLine).
		line, err := oneShotLine(args)
		if err != nil {
			log.Fatalf("%v", err)
		}
		resp, err := s.send(line, *timeout)
		if err != nil {
			log.Fatalf("%s: %v", verbOf(args[0]), err)
		}
		printResponse(verbOf(args[0]), resp)
		if resp.failed() {
			os.Exit(1)
		}
	case isInteractive():
		repl(s)
	default:
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ".") {
				continue
			}
			resp, err := s.send(line, *timeout)
			if err != nil {
				fmt.Fprintf(os.Stderr, "send error: %v\n", err)
				continue
			}
			printResponse(verbOf(line), resp)
		}
	}
}

func clientUsage() {
	fmt.Fprint(os.Stderr, `usage: glyph3d-cli [flags] <verb args...>      run one verb (try: help)
       glyph3d-cli [flags] screenshot [-o out.png] [--cmd 'verb …']... [--wait 300ms]
       glyph3d-cli [flags] log.follow [--filter s] [--level csv] [--scope s] [--level-set LVL]
       glyph3d-cli [flags] seed-history [--lines 300] [--tmux-socket glyphd] [id ...]
       glyph3d-cli [flags]                          REPL, or one line per stdin line
       glyph3d-cli serve | hook | attach | fullsnapshot | version

Log verbs render their records: log.search / log.errors / log.tail as lines,
log.query as a table, log.stats as a summary (--json prints the raw data).
log.query/search/errors/stats/dump answer relay-side, with no page attached.

flags (before the verb):
`)
	flag.PrintDefaults()
}

func versionCmd() {
	fmt.Printf("glyph3d-cli %s\n", Version)
	fmt.Printf("  built:    %s\n", BuildDate)
	fmt.Printf("  platform: %s\n", Platform)
}

func isInteractive() bool {
	fi, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

// stringListFlag collects a repeatable string flag (e.g. --reach /a --reach /b)
// into a slice. Implements flag.Value.
type stringListFlag []string

func (s *stringListFlag) String() string { return strings.Join(*s, ",") }

func (s *stringListFlag) Set(v string) error {
	*s = append(*s, v)
	return nil
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
	var reach stringListFlag
	flagSet.Var(&reach, "reach", "Extra directory the relay may read/write outside the project root (repeatable). Temp dirs are always reachable.")
	var gomuxDirs stringListFlag
	flagSet.Var(&gomuxDirs, "gomuxai", "Extra gomuxai store to watch: a .gomuxai dir, the dir holding one, or an `agent` binary (repeatable). The PATH agent's store and every live agent session's are found on their own.")
	noGomux := flagSet.Bool("no-gomuxai", false, "Don't watch gomuxai stores")
	flagSet.StringVar(&tmuxSocket, "tmux-socket", tmuxSocket, "tmux socket (-L name) terminals live on — a second relay on its own socket can't adopt or kill the first's terminals")
	flagSet.Parse(os.Args[2:])

	// Project path: positional arg or cwd
	projectPath := "."
	if flagSet.NArg() > 0 {
		projectPath = flagSet.Arg(0)
	}

	// Legacy relay-only mode
	if *relayOnly {
		fsHandler, err := NewFSHandler(projectPath, reach)
		if err != nil {
			log.Fatalf("[relay] project path: %v", err)
		}
		if !*noGomux {
			fsHandler.gomux = NewGomuxWatcher(gomuxDirs)
		}
		if err := RunRelay(*listen, *p, fsHandler); err != nil {
			log.Fatalf("[relay] %v", err)
		}
		return
	}

	// Filesystem access: always on, rooted at the project path
	fsHandler, err := NewFSHandler(projectPath, reach)
	if err != nil {
		log.Fatalf("[serve] project path: %v", err)
	}
	if !*noGomux {
		fsHandler.gomux = NewGomuxWatcher(gomuxDirs)
	}

	cfg := ServerConfig{
		Host:      *listen,
		Port:      *p,
		FSHandler: fsHandler,
	}

	if *local {
		// Dev/test: serve the BUILT app (app/dist) from disk instead of the
		// embedded copy — rebuild with `cd app && bun run build` and reload
		// without recompiling the binary. (Live source editing is the Vite dev
		// server on :5173; the Go binary only ever serves the built app.)
		// Find the repo root by looking for app/dist/index.html relative to the
		// project path or the binary, then fall back to projectPath.
		staticRoot := projectPath
		sentinel := filepath.Join("app", "dist", "index.html")
		if _, err := os.Stat(filepath.Join(staticRoot, sentinel)); err != nil {
			if exe, exeErr := os.Executable(); exeErr == nil {
				candidate := filepath.Dir(exe)
				if _, err2 := os.Stat(filepath.Join(candidate, sentinel)); err2 == nil {
					staticRoot = candidate
				}
			}
		}
		distDir := filepath.Join(staticRoot, "app", "dist")
		if _, err := os.Stat(filepath.Join(distDir, "index.html")); err != nil {
			log.Fatalf("[serve --local] no built app at %s — run: cd app && bun run build", distDir)
		}
		cfg.StaticFS = os.DirFS(distDir)
		cfg.StaticTag = distDir + " (local)"
	} else {
		// Normal mode: the embedded built app
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

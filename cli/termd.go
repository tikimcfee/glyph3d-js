package main

// termd.go — the relay and CLI adapter onto glyph3d-cli/termdwire (docs/termd/PROTOCOL.md).
// termd owns every terminal's PTY, program, and screen and outlives the relay; the relay and
// the adapters it forks reach it over its Unix socket. A namespace (`serve --termd-ns`) is an
// independent daemon with its own terminals, so a second relay on its own namespace can
// neither see nor kill the first's.

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"glyph3d-cli/termdwire"
)

// termdNS is the termd namespace this relay's terminals live in (`serve --termd-ns`, passed to
// every adapter it forks as `attach --termd-ns`).
var termdNS = "default"

// termdBin is an explicit g3d-termd binary (`serve --termd`); empty = next to this executable,
// then PATH.
var termdBin = ""

// termdReconnectWindow is how long an adapter rides out a termd brain restart (a crash, an
// upgrade) before giving its terminal up as lost (`serve --termd-reconnect`, passed to adapters).
var termdReconnectWindow = 30 * time.Second

// termdInputOps are the ops a display's typing and pasting need (protocol 1.2).
var termdInputOps = []string{"key", "paste"}

type (
	termdClient   = termdwire.Conn
	termdFrame    = termdwire.Frame
	termdError    = termdwire.WireError
	termdReplyMsg = termdwire.ReplyMsg
)

const (
	termdOutput  = termdwire.FrameOutput
	termdEvent   = termdwire.FrameEvent
	termdRepaint = termdwire.FrameRepaint
)

var (
	errTermdNotRunning   = termdwire.ErrNotRunning
	errUnsafeTermdSocket = termdwire.ErrUnsafeSocket
	isTermdCode          = termdwire.IsCode
)

func termdSocketDir() string                          { return termdwire.SocketDir() }
func termdSocketDirFor(runtime string, uid int) string { return termdwire.SocketDirFor(runtime, uid) }
func termdSocketPath(ns string) string                { return termdwire.SocketPath(ns) }
func termdLogPath(ns string) string                   { return termdwire.LogPath(ns) }

func termdDialOpts() termdwire.DialOptions {
	return termdwire.DialOptions{Client: "glyph3d-cli/" + Version}
}

// dialTermd connects to the namespace's daemon and says HELLO. It never starts one.
func dialTermd(ns string) (*termdClient, error) {
	return termdwire.Dial(ns, termdDialOpts())
}

// redialTermd rides a termd brain restart within termdReconnectWindow.
func redialTermd(ns, instance string, planned bool) (*termdClient, error) {
	return termdwire.Redial(ns, instance, termdReconnectWindow, planned, termdDialOpts())
}

// ensureTermd connects to the namespace's daemon, starting it (`g3d-termd --ns <ns> --daemon`,
// which outlives us) when nothing listens. An already-running daemon or an unsafe/refusing socket
// returns before locating the g3d-termd binary.
func ensureTermd(ns string) (*termdClient, error) {
	if c, err := dialTermd(ns); err == nil || !errors.Is(err, errTermdNotRunning) {
		return c, err
	}
	bin, err := findTermd()
	if err != nil {
		return nil, err
	}
	return termdwire.EnsureDaemon(ns, bin, termdDialOpts())
}

// termdTerminal is one entry of termd's `list` reply.
type termdTerminal struct {
	ID          string   `json:"id"`
	Handle      uint32   `json:"handle"`
	PID         int      `json:"pid"`
	Argv        []string `json:"argv"`
	Cols        int      `json:"cols"`
	Rows        int      `json:"rows"`
	Title       string   `json:"title"`
	Alt         bool     `json:"alt"`
	Subscribers struct {
		Own    int `json:"own"`
		Attach int `json:"attach"`
		Watch  int `json:"watch"`
	} `json:"subscribers"`
}

// termdList lists the namespace's live terminals. No daemon running is an empty list (nothing is
// live); any other failure is an error — the list is unknown, which is not the same as empty.
func termdList(ns string) ([]termdTerminal, error) {
	c, err := dialTermd(ns)
	if errors.Is(err, errTermdNotRunning) {
		return []termdTerminal{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer c.Close()
	var r struct {
		Terminals []termdTerminal `json:"terminals"`
	}
	if err := c.Request("list", nil, &r); err != nil {
		return nil, fmt.Errorf("termd list: %w", err)
	}
	if r.Terminals == nil {
		r.Terminals = []termdTerminal{}
	}
	return r.Terminals, nil
}

// findTermd locates the g3d-termd binary: `serve --termd`, then beside this executable, then
// PATH. Not found is an error naming every place it looked.
func findTermd() (string, error) {
	if termdBin != "" {
		if st, err := os.Stat(termdBin); err == nil && !st.IsDir() {
			return termdBin, nil
		}
		return "", fmt.Errorf("--termd %s: no such binary", termdBin)
	}
	looked := []string{}
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), "g3d-termd")
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, nil
		}
		looked = append(looked, p)
	}
	if p, err := exec.LookPath("g3d-termd"); err == nil {
		return p, nil
	}
	looked = append(looked, "$PATH")
	return "", fmt.Errorf("no g3d-termd binary (looked at %s; or pass serve --termd <path>)", strings.Join(looked, ", "))
}

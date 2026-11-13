package main

// termd.go — the relay's client of g3d-termd, the terminal daemon (docs/termd/PROTOCOL.md).
// termd owns every terminal's PTY, program and screen and outlives the relay; the relay and
// the adapters it forks reach it over its Unix socket. A namespace (`serve --termd-ns`) is an
// independent daemon with its own terminals, so a second relay on its own namespace can
// neither see nor kill the first's.
//
// The socket and log follow the daemon's rule (crates/g3d/src/paths.rs):
//
//	socket: $G3D_TERMD_DIR/termd-<ns>.sock | /run/user/<uid>/g3d/… (when it is the user's) | /tmp/g3d-<uid>/…
//	log:    $G3D_TERMD_DIR/termd-<ns>.log  | $XDG_STATE_HOME/g3d/…  | ~/.local/state/g3d/…

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// termdNS is the termd namespace this relay's terminals live in (`serve --termd-ns`, passed to
// every adapter it forks as `attach --termd-ns`).
var termdNS = "default"

// termdBin is an explicit g3d-termd binary (`serve --termd`); empty = next to this executable,
// then PATH.
var termdBin = ""

// termdReconnectWindow is how long an adapter rides out a termd brain restart (a crash, an
// upgrade) before it gives its terminal up as lost (PROTOCOL.md "Restarts"; DESIGN.md "Riding a
// restart": 30 s covers a crash restart and the first crash-loop retries). `serve
// --termd-reconnect`, passed to every adapter.
var termdReconnectWindow = 30 * time.Second

// Frame types (PROTOCOL.md "Frame types").
const (
	termdHello      = 0x01
	termdRequest    = 0x02
	termdInput      = 0x03
	termdWelcome    = 0x81
	termdReply      = 0x82
	termdOutput     = 0x83
	termdEvent      = 0x84
	termdRepaint    = 0x85
	termdErrorFrame = 0xFF
	// The largest payload 1.x allows.
	termdMaxFrame = 16 << 20
)

// termdSocketDir is $G3D_TERMD_DIR (an explicit choice, as tmux's TMUX_TMPDIR), else the rule
// below. Never $XDG_RUNTIME_DIR or $TMPDIR: a relay started from a stripped environment (env -i,
// cron, a service manager) must find the socket a desktop shell's g3d finds.
func termdSocketDir() string {
	if d := os.Getenv("G3D_TERMD_DIR"); d != "" {
		return d
	}
	return termdSocketDirFor(userRuntimeDir(), os.Getuid())
}

// termdSocketDirFor is the rule found from the uid: the user's runtime directory's g3d, else
// /tmp/g3d-<uid> (crates/g3d/src/paths.rs, socket_dir_for).
func termdSocketDirFor(runtime string, uid int) string {
	if runtime != "" {
		return filepath.Join(runtime, "g3d")
	}
	return fmt.Sprintf("/tmp/g3d-%d", uid)
}

func termdSocketPath(ns string) string {
	return filepath.Join(termdSocketDir(), "termd-"+ns+".sock")
}

func termdLogPath(ns string) string {
	dir := os.Getenv("G3D_TERMD_DIR")
	if dir == "" {
		if s := os.Getenv("XDG_STATE_HOME"); s != "" {
			dir = filepath.Join(s, "g3d")
		} else if h := os.Getenv("HOME"); h != "" {
			dir = filepath.Join(h, ".local", "state", "g3d")
		} else {
			dir = termdSocketDir()
		}
	}
	return filepath.Join(dir, "termd-"+ns+".log")
}

// termdFrame is one frame off the socket.
type termdFrame struct {
	Type    byte
	Stream  uint32
	Payload []byte
}

func encodeTermdFrame(typ byte, stream uint32, payload []byte) []byte {
	b := make([]byte, 12+len(payload))
	binary.LittleEndian.PutUint32(b[0:], uint32(8+len(payload)))
	b[4] = typ
	binary.LittleEndian.PutUint32(b[8:], stream)
	copy(b[12:], payload)
	return b
}

func readTermdFrame(r *bufio.Reader) (termdFrame, error) {
	var head [12]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return termdFrame{}, err
	}
	n := binary.LittleEndian.Uint32(head[0:])
	if n < 8 || n-8 > termdMaxFrame {
		return termdFrame{}, fmt.Errorf("termd: bad frame length %d", n)
	}
	f := termdFrame{Type: head[4], Stream: binary.LittleEndian.Uint32(head[8:]), Payload: make([]byte, n-8)}
	_, err := io.ReadFull(r, f.Payload)
	return f, err
}

// termdError is a refusal: a failed REPLY or an ERROR frame.
type termdError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *termdError) Error() string { return e.Code + ": " + e.Message }

// termdClient is one connection to the daemon. A reader goroutine matches replies to their
// requests and hands every other frame (OUTPUT, REPAINT, EVENT) to Frames, in order. A slow
// Frames consumer slows the reader, which is how a blocking owner pushes back on termd.
type termdClient struct {
	conn    net.Conn
	wmu     sync.Mutex
	nextReq atomic.Uint64
	mu      sync.Mutex
	pending map[uint64]chan termdReplyMsg
	err     error // why the connection ended, once it has
	Frames  chan termdFrame
	Welcome struct {
		Proto    [2]int   `json:"proto"`
		Daemon   string   `json:"daemon"`
		Engine   string   `json:"engine"`
		NS       string   `json:"ns"`
		PID      int      `json:"pid"`
		Features []string `json:"features"`
		// The namespace's identity (fixed for the holder's life) and which brain this is.
		Instance   string `json:"instance"`
		Generation int    `json:"generation"`
		Holder     struct {
			PID int `json:"pid"`
		} `json:"holder"`
	}
}

type termdReplyMsg struct {
	payload []byte
	err     error
}

// errTermdNotRunning: nothing listens on the namespace's socket.
var errTermdNotRunning = errors.New("termd is not running")

// isTermdCode reports whether err is termd refusing with this code (a failed REPLY or an ERROR
// frame: `restart`, `brain_failed`, `no_terminal`, …).
func isTermdCode(err error, code string) bool {
	var te *termdError
	return errors.As(err, &te) && te.Code == code
}

// redialTermd rides a termd brain restart (PROTOCOL.md "Restarts"): reconnect at once (after up
// to 100 ms of jitter) when the last connection ended with ERROR restart, else back off 100 ms
// doubling to 2 s, for up to termdReconnectWindow. Nothing listening means the holder is gone
// and every terminal with it (errTermdNotRunning, at once); a different instance is a new
// namespace (an error). The caller re-subscribes by id: never create-or-adopt, which would start
// a new program in a terminal that ended meanwhile.
func redialTermd(ns, instance string, planned bool) (*termdClient, error) {
	deadline := time.Now().Add(termdReconnectWindow)
	wait := 100 * time.Millisecond
	if planned {
		time.Sleep(time.Duration(time.Now().UnixNano() % int64(100*time.Millisecond)))
	} else {
		time.Sleep(wait)
	}
	var last error
	for {
		c, err := dialTermd(ns)
		switch {
		case err == nil && instance != "" && c.Welcome.Instance != instance:
			c.Close()
			return nil, fmt.Errorf("termd namespace %q is a new one (instance %s, was %s): its terminals are gone", ns, c.Welcome.Instance, instance)
		case err == nil:
			return c, nil
		case errors.Is(err, errTermdNotRunning):
			return nil, err
		}
		last = err
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("no termd brain answered for %s: %w", termdReconnectWindow, last)
		}
		time.Sleep(wait)
		if wait < 2*time.Second {
			wait *= 2
		}
	}
}

// dialTermd connects to the namespace's daemon and says HELLO. It never starts one.
func dialTermd(ns string) (*termdClient, error) {
	path := termdSocketPath(ns)
	conn, err := net.DialTimeout("unix", path, 2*time.Second)
	if err != nil {
		if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED) {
			return nil, fmt.Errorf("%w at %s", errTermdNotRunning, path)
		}
		return nil, fmt.Errorf("termd at %s: %w", path, err)
	}
	r := bufio.NewReaderSize(conn, 256<<10)
	hello, _ := json.Marshal(map[string]any{"proto": []int{1, 2}, "client": "glyph3d-cli/" + Version})
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	// The daemon may answer before it reads HELLO (ERROR brain_failed, PROTOCOL.md "Handshake"): a
	// failed write still reads what is waiting, which says why.
	_, werr := conn.Write(encodeTermdFrame(termdHello, 0, hello))
	f, err := readTermdFrame(r)
	conn.SetDeadline(time.Time{})
	if werr != nil && (err != nil || f.Type != termdErrorFrame) {
		conn.Close()
		return nil, fmt.Errorf("termd at %s: hello: %w", path, werr)
	}
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("termd at %s: welcome: %w", path, err)
	}
	c := &termdClient{conn: conn, pending: map[uint64]chan termdReplyMsg{}, Frames: make(chan termdFrame, 256)}
	switch f.Type {
	case termdWelcome:
		if err := json.Unmarshal(f.Payload, &c.Welcome); err != nil {
			conn.Close()
			return nil, fmt.Errorf("termd at %s: welcome: %w", path, err)
		}
	case termdErrorFrame:
		var e termdError
		json.Unmarshal(f.Payload, &e)
		conn.Close()
		return nil, fmt.Errorf("termd at %s refused us: %w", path, &e)
	default:
		conn.Close()
		return nil, fmt.Errorf("termd at %s: expected WELCOME, got frame type %#x", path, f.Type)
	}
	go c.readLoop(r)
	return c, nil
}

func (c *termdClient) readLoop(r *bufio.Reader) {
	var err error
	for {
		var f termdFrame
		f, err = readTermdFrame(r)
		if err != nil {
			break
		}
		if f.Type == termdErrorFrame {
			var e termdError
			json.Unmarshal(f.Payload, &e)
			err = &e
			break
		}
		if f.Type == termdReply {
			var head struct {
				Req   uint64      `json:"req"`
				OK    bool        `json:"ok"`
				Error *termdError `json:"error"`
			}
			if json.Unmarshal(f.Payload, &head) == nil {
				c.mu.Lock()
				ch := c.pending[head.Req]
				delete(c.pending, head.Req)
				c.mu.Unlock()
				if ch != nil {
					if !head.OK && head.Error != nil {
						ch <- termdReplyMsg{err: head.Error}
					} else {
						ch <- termdReplyMsg{payload: f.Payload}
					}
				}
			}
			continue
		}
		c.Frames <- f
	}
	if errors.Is(err, io.EOF) {
		err = errors.New("termd closed the connection")
	}
	c.mu.Lock()
	c.err = err
	for _, ch := range c.pending {
		ch <- termdReplyMsg{err: err}
	}
	c.pending = map[uint64]chan termdReplyMsg{}
	c.mu.Unlock()
	close(c.Frames)
}

func (c *termdClient) Close() error { return c.conn.Close() }

// Err is why the connection ended (nil while it's up).
func (c *termdClient) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

func (c *termdClient) write(b []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_, err := c.conn.Write(b)
	return err
}

// Send sends a request without waiting; its reply arrives on the returned channel.
func (c *termdClient) Send(op string, fields map[string]any) (<-chan termdReplyMsg, error) {
	req := c.nextReq.Add(1)
	body := map[string]any{"req": req, "op": op}
	for k, v := range fields {
		body[k] = v
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	ch := make(chan termdReplyMsg, 1)
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return nil, c.err
	}
	c.pending[req] = ch
	c.mu.Unlock()
	if err := c.write(encodeTermdFrame(termdRequest, 0, payload)); err != nil {
		c.mu.Lock()
		delete(c.pending, req)
		c.mu.Unlock()
		return nil, err
	}
	return ch, nil
}

// Request sends a request and decodes its reply into out (nil = ignore the body).
func (c *termdClient) Request(op string, fields map[string]any, out any) error {
	ch, err := c.Send(op, fields)
	if err != nil {
		return err
	}
	select {
	case r := <-ch:
		if r.err != nil {
			return r.err
		}
		if out != nil {
			return json.Unmarshal(r.payload, out)
		}
		return nil
	case <-time.After(30 * time.Second):
		return fmt.Errorf("termd: no reply to %s in 30s", op)
	}
}

// Input sends bytes to a terminal this connection subscribes to.
func (c *termdClient) Input(handle uint32, b []byte) error {
	return c.write(encodeTermdFrame(termdInput, handle, b))
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

// ensureTermd connects to the namespace's daemon, starting it (`g3d-termd --ns <ns> --daemon`,
// which double-forks and outlives us) when nothing listens, then retrying for up to 3 s. It fails
// loud with the daemon log's tail. The daemon is never a child the relay waits on or kills.
func ensureTermd(ns string) (*termdClient, error) {
	c, err := dialTermd(ns)
	if err == nil || !errors.Is(err, errTermdNotRunning) {
		return c, err
	}
	bin, err := findTermd()
	if err != nil {
		return nil, err
	}
	out, startErr := exec.Command(bin, "--ns", ns, "--daemon").CombinedOutput()
	deadline := time.Now().Add(3 * time.Second)
	wait := 20 * time.Millisecond
	for {
		c, err = dialTermd(ns)
		if err == nil {
			return c, nil
		}
		if !errors.Is(err, errTermdNotRunning) || time.Now().After(deadline) {
			break
		}
		time.Sleep(wait)
		if wait < 250*time.Millisecond {
			wait *= 2
		}
	}
	tail := ""
	if b, e := os.ReadFile(termdLogPath(ns)); e == nil {
		lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
		if len(lines) > 10 {
			lines = lines[len(lines)-10:]
		}
		tail = strings.Join(lines, "\n")
	}
	return nil, fmt.Errorf("termd did not come up for namespace %q (%v); %s --ns %s --daemon: %v %s; log %s:\n%s",
		ns, err, bin, ns, startErr, strings.TrimSpace(string(out)), termdLogPath(ns), tail)
}

package main

// Answering agents from the display (docs/planes/DESIGN.md §3.5, slice 1b): three JSON-RPC methods
// that run gomuxai's own commands — never a tmux client, never send-keys of ours:
//
//	agent/say     {name, text}    → agent send -- <name> <text>         typed in at its prompt, held
//	                                                                     while it's busy, refused at dialogs
//	agent/approve {name, expect}  → agent approve --expect <tool> -- <name>   expect is REQUIRED: the
//	                                                                     tool the display showed, so a
//	                                                                     prompt that replaced it isn't
//	                                                                     approved blind
//	agent/deny    {name}          → agent deny -- <name>
//
// Each answers {ok, code, output}: what gomuxai said (stdout + stderr) and its exit code, so the
// display's OK/ERR line reports what was actually done. The child dies with the relay (startChild),
// is bounded by agentInputTimeout, and runs WITHOUT the relay's agent identity (personEnv): gomuxai
// signs the message "[from a person on <host>]", never as whichever agent started the relay.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

const agentInputTimeout = 15 * time.Second

// maxSayBytes bounds one agent/say: a message, not a file.
const maxSayBytes = 64 << 10

// agentNameRE: a gomuxai agent name, optionally @host.
var agentNameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9][A-Za-z0-9._-]*)?$`)

type agentInputParams struct {
	Name   string `json:"name"`
	Text   string `json:"text"`
	Expect string `json:"expect"`
}

type agentInputResult struct {
	OK     bool   `json:"ok"`
	Code   int    `json:"code"`
	Output string `json:"output"`
}

// agentInputArgs builds the `agent` argv for one input method, or says why it can't.
func agentInputArgs(method string, p agentInputParams) ([]string, error) {
	if !agentNameRE.MatchString(p.Name) {
		return nil, errors.New("invalid params: want a gomuxai agent name (name or name@host)")
	}
	switch method {
	case "agent/say":
		if strings.TrimSpace(p.Text) == "" {
			return nil, errors.New("invalid params: agent/say needs {name, text}")
		}
		if len(p.Text) > maxSayBytes {
			return nil, errors.New("invalid params: agent/say text is over 64 KiB")
		}
		return []string{"send", "--", p.Name, p.Text}, nil
	case "agent/approve":
		if strings.TrimSpace(p.Expect) == "" {
			return nil, errors.New("refused: agent/approve needs {expect: <the tool the display showed>} — never approved blind")
		}
		return []string{"approve", "--expect", p.Expect, "--", p.Name}, nil
	case "agent/deny":
		return []string{"deny", "--", p.Name}, nil
	}
	return nil, errors.New("not an agent input method: " + method)
}

// Input runs one input method through gomuxai and reports what it said.
func (a *AgentEvents) Input(ctx context.Context, method string, p agentInputParams) (agentInputResult, error) {
	args, err := agentInputArgs(method, p)
	if err != nil {
		return agentInputResult{}, err
	}
	bin, err := a.binary()
	if err != nil {
		return agentInputResult{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, agentInputTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	// The answer is the PERSON's (the display's verbs refuse an identified caller): gomuxai stamps a
	// sent message by the sender's identity, so the child must not inherit the relay's — a relay
	// started from an agent's shell would otherwise sign the person's reply as that agent.
	cmd.Env = personEnv(os.Environ())
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := startChild(cmd); err != nil {
		return agentInputResult{}, err
	}
	werr := cmd.Wait()
	childExited(cmd)
	res := agentInputResult{OK: werr == nil, Output: strings.TrimSpace(out.String())}
	var ee *exec.ExitError
	switch {
	case werr == nil:
	case errors.As(werr, &ee):
		res.Code = ee.ExitCode()
	case ctx.Err() != nil:
		res.Code, res.Output = -1, strings.TrimSpace(res.Output+"\n(timed out after "+agentInputTimeout.String()+")")
	default:
		return agentInputResult{}, werr
	}
	return res, nil
}

// personEnv is env without the variables gomuxai reads as the sender's identity (AGENT_NAME — an
// agent; AI_AGENT / CLAUDECODE — an AI CLI a person started), so `agent send` signs the message
// "[from a person on <host>]".
func personEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		if k == "AGENT_NAME" || k == "AI_AGENT" || k == "CLAUDECODE" {
			continue
		}
		out = append(out, kv)
	}
	return out
}

func (h *FSHandler) handleAgentInput(write writeFn, id json.RawMessage, method string, raw json.RawMessage) {
	if h.agentEventsOff(write, id) {
		return
	}
	var p agentInputParams
	if err := json.Unmarshal(raw, &p); err != nil {
		h.sendRPCError(write, id, -32602, "invalid params: want {name, text?, expect?}", nil)
		return
	}
	res, err := h.agents.Input(context.Background(), method, p)
	if err != nil {
		h.sendRPCError(write, id, -32602, err.Error(), nil)
		return
	}
	h.sendRPCResult(write, id, res)
}

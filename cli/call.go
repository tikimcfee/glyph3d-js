package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

// The `call` bundle is the bus's structured serialization of one invocation:
//
//	call <base64(JSON ["verb", arg, ...])>
//
// base64's alphabet has no spaces or quotes, so the argv survives the bus tokenizer
// (which strips quotes and splits on spaces) byte-identical — spaces, newlines, quotes,
// empty args. The display's `call` handler (app/commands/handlers/systemCommands.js)
// decodes it to the SAME [name, ...args] vector a typed line produces, so handlers
// read plain positional strings either way. Every Go sender (the one-shot client, the
// hook, seed-history) builds lines here; the relay decodes them here to answer its
// own verbs.

// callLine serializes argv as a `call` bundle line.
func callLine(argv []string) (string, error) {
	if len(argv) == 0 {
		return "", fmt.Errorf("call: empty argv")
	}
	payload, err := json.Marshal(argv)
	if err != nil {
		return "", fmt.Errorf("call: %w", err)
	}
	return "call " + base64.StdEncoding.EncodeToString(payload), nil
}

// parseCallLine decodes a `call <base64>` line back into its argv. It accepts the
// same payloads the display's handler does — a positional array, or the object form
// {"cmd": "...", "args": [...]} — base64 or base64url, with non-string args
// stringified (the handler's String(a) coercion). ok is false for anything that is
// not a well-formed bundle.
func parseCallLine(line string) (argv []string, ok bool) {
	b64, found := strings.CutPrefix(line, "call ")
	if !found {
		return nil, false
	}
	b64 = strings.TrimSpace(b64)
	b64 = strings.NewReplacer("-", "+", "_", "/").Replace(b64)
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		if raw, err = base64.RawStdEncoding.DecodeString(b64); err != nil {
			return nil, false
		}
	}
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil {
		var obj struct {
			Cmd  string            `json:"cmd"`
			Args []json.RawMessage `json:"args"`
		}
		if json.Unmarshal(raw, &obj) != nil || obj.Cmd == "" {
			return nil, false
		}
		name, _ := json.Marshal(obj.Cmd)
		items = append([]json.RawMessage{name}, obj.Args...)
	}
	if len(items) == 0 {
		return nil, false
	}
	argv = make([]string, len(items))
	for i, it := range items {
		var s string
		if json.Unmarshal(it, &s) == nil {
			argv[i] = s
		} else if i == 0 {
			return nil, false // the verb name must be a string
		} else {
			argv[i] = string(it)
		}
	}
	return argv, true
}

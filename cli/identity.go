package main

import (
	"fmt"
	"strings"
)

// Bus identity: a controller may NAME itself before its first command with the greeting
// `AS <name>` (glyph3d-cli --as, defaulting from $AGENT_NAME). The relay keeps addressing the
// connection by its routing id (ctrl-N — one agent runs many one-shots at once, so a name is no
// address) and stamps every command it forwards with the name: {from: ctrl-N, as: <name>, cmd}.
// The display runs the command as that caller — attribution (hue, name), and the key an agent's
// points live under.

// maxCallerName bounds a caller name; gomuxai agent names are far shorter.
const maxCallerName = 64

// parseAsHandshake recognizes the controller greeting `AS <name>`. ok is false for anything
// else (a command). A greeting with a bad name returns an error: a caller that asked to be
// named must not silently run anonymous.
func parseAsHandshake(raw string) (name string, ok bool, err error) {
	head, rest, _ := strings.Cut(raw, " ")
	if head != "AS" {
		return "", false, nil
	}
	name = strings.TrimSpace(rest)
	if err := validCallerName(name); err != nil {
		return "", true, err
	}
	return name, true, nil
}

// validCallerName: 1..64 of [A-Za-z0-9._@-] — log-safe, no separators to inject.
func validCallerName(name string) error {
	if name == "" {
		return fmt.Errorf("AS needs a name")
	}
	if len(name) > maxCallerName {
		return fmt.Errorf("caller name longer than %d bytes: %q", maxCallerName, name)
	}
	for _, c := range name {
		if !(c >= 'a' && c <= 'z') && !(c >= 'A' && c <= 'Z') && !(c >= '0' && c <= '9') && !strings.ContainsRune("._@-", c) {
			return fmt.Errorf("caller name %q has %q (allowed: letters, digits, . _ @ -)", name, c)
		}
	}
	return nil
}

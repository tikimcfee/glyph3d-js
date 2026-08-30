// Argument parsing for glyph3d-cli's subcommands.
//
// Go's flag package stops parsing at the FIRST non-flag token, so
// `serve ~/project --port 9000 --relay-only` parsed zero flags: the positional
// directory ended the flag stream and everything after it landed in FlagSet.Args(),
// where nobody looked. The operator asked for :9000 and the binary bound :8080
// without a word — the exact silent-fallback shape CLAUDE.md forbids at substrate
// seams ("any fallback path logs its true cause plus the exact request it degraded
// from"). A port is a substrate seam; a default that overrides a request is a lie.
//
// parseArgs is the one parser every subcommand uses. It permutes (GNU-style): flags
// are honored wherever they appear, positionals come back in order, and a token that
// LOOKS like a flag but isn't defined is a hard error instead of silent text.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

// parseArgs parses args against fs with flags allowed before, after, or between
// positionals, returning the positionals in order. Everything after a bare "--" is
// positional verbatim (never flag-parsed).
//
// fs must be constructed with flag.ContinueOnError so the error comes back here
// instead of the flag package exiting mid-parse; output is silenced so the caller
// prints exactly one loud message (see failParse).
func parseArgs(fs *flag.FlagSet, args []string) ([]string, error) {
	// Split off an explicit "--" terminator first: flag.Parse consumes it and would
	// let the loop below resume flag-parsing on the far side of it.
	var verbatim []string
	for i, a := range args {
		if a == "--" {
			verbatim = args[i+1:]
			args = args[:i]
			break
		}
	}

	var positional []string
	rest := args
	for len(rest) > 0 {
		if err := fs.Parse(rest); err != nil {
			return nil, err
		}
		rest = fs.Args()
		if len(rest) == 0 {
			break
		}
		// The token that stopped the parse is a positional; step over it and keep
		// parsing the tail — this is the whole fix.
		positional = append(positional, rest[0])
		rest = rest[1:]
	}
	return append(positional, verbatim...), nil
}

// newFlagSet builds a silent, error-returning FlagSet for a subcommand.
func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard) // the caller owns the message; no double-print
	return fs
}

// failParse prints one loud line plus the subcommand's usage and exits non-zero.
// Never called for a condition the binary could paper over — that is the point.
func failParse(name, usage string, err error) {
	fmt.Fprintf(os.Stderr, "glyph3d-cli %s: %v\n", name, err)
	fmt.Fprintf(os.Stderr, "usage: %s\n", usage)
	os.Exit(2)
}

// globalFlagInCommand reports the first argument in a one-shot command that names a
// defined GLOBAL flag (--json, --port, --host, --timeout), or "" if none does.
//
// The one-shot path cannot permute: command arguments are free-form text bound for
// the display's command bus, and a verb argument may legitimately start with "-".
// So the ordering rule stands there — but it is now enforced instead of documented:
// `glyph3d-cli file.open x.js --json` used to ship "--json" to the browser as part
// of the command text and quietly print non-JSON.
func globalFlagInCommand(fs *flag.FlagSet, args []string) string {
	defined := map[string]bool{}
	fs.VisitAll(func(f *flag.Flag) { defined[f.Name] = true })
	for _, a := range args {
		if !strings.HasPrefix(a, "-") || a == "-" || a == "--" {
			continue
		}
		name := strings.TrimLeft(a, "-")
		if i := strings.IndexByte(name, '='); i >= 0 {
			name = name[:i]
		}
		if defined[name] {
			return a
		}
	}
	return ""
}

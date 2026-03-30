#!/usr/bin/env python3
"""
glyph-cli -- WebSocket CLI controller for glyph3d-js viewer.

Modes:
  One-shot:  glyph-cli.py [--host url] <command...>
  REPL:      glyph-cli.py [--host url]
  Pipe:      echo "grid.list" | glyph-cli.py

Flags:
  --host <url>   WebSocket URL (default ws://localhost:8765)
  --port <n>     Shorthand for ws://localhost:<n>
  --json         Output JSON data instead of TUI text

Requirements: pip install websockets
"""

import asyncio
import base64
import json
import re
import sys

from cli_connection import CliConnection


def interpret_escapes(s):
    """Interpret \\n and \\t escape sequences."""
    return s.replace("\\n", "\n").replace("\\t", "\t")


def encode_content_args(cmd):
    """Base64-encode text content for commands that take content args."""

    def b64(text):
        return base64.b64encode(interpret_escapes(text).encode()).decode()

    def extract_quoted_or_word(rest):
        """Extract text (possibly quoted) and remaining args."""
        if rest.startswith('"'):
            end = rest.find('"', 1)
            if end > 0:
                return rest[1:end], rest[end + 1:].strip()
            return rest[1:], ""
        parts = rest.split(" ", 1)
        return parts[0], parts[1].strip() if len(parts) > 1 else ""

    # grid.create <text> [name]
    m = re.match(r"^(grid\.create)\s+(.+)$", cmd)
    if m:
        text, remaining = extract_quoted_or_word(m.group(2))
        encoded = b64(text)
        return f"{m.group(1)} {encoded} {remaining}".strip() if remaining else f"{m.group(1)} {encoded}"

    # grid.text <index> <text>
    m = re.match(r"^(grid\.text)\s+(\d+)\s+(.+)$", cmd)
    if m:
        text = m.group(3).strip('"')
        return f"{m.group(1)} {m.group(2)} {b64(text)}"

    # window.write|window.append <id> <text>
    m = re.match(r"^(window\.write|window\.append)\s+(\S+)\s+(.+)$", cmd)
    if m:
        text = m.group(3).strip('"')
        return f"{m.group(1)} {m.group(2)} {b64(text)}"

    # label.create|scene.annotate <text> <x> <y> <z> [r g b]
    m = re.match(r"^(label\.create|scene\.annotate)\s+(.+)$", cmd)
    if m:
        text, remaining = extract_quoted_or_word(m.group(2))
        encoded = b64(text)
        return f"{m.group(1)} {encoded} {remaining}".strip() if remaining else f"{m.group(1)} {encoded}"

    # terminal.input <id> <text>
    m = re.match(r"^(terminal\.input)\s+(\S+)\s+(.+)$", cmd)
    if m:
        text = m.group(3).strip('"')
        return f"{m.group(1)} {m.group(2)} {b64(text)}"

    return cmd


async def exec_and_print(conn, cmd, json_mode=False):
    """Send a command and print the result. Returns True on success."""
    cmd = encode_content_args(cmd)
    try:
        text, data = await conn.send(cmd)
        if json_mode and data is not None:
            print(json.dumps(data, indent=2))
        else:
            print(text)
        return not text.startswith("ERR:")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return False


async def repl(conn, json_mode):
    """Interactive REPL mode."""
    print("Type commands (help for list, .exit to quit)\n", file=sys.stderr)
    while True:
        try:
            line = input("glyph> ")
        except (EOFError, KeyboardInterrupt):
            break

        cmd = line.strip()
        if not cmd:
            continue
        if cmd in (".exit", ".quit"):
            break
        if cmd == ".json on":
            json_mode = True
            print("Output: JSON", file=sys.stderr)
            continue
        if cmd == ".json off":
            json_mode = False
            print("Output: text", file=sys.stderr)
            continue
        if cmd == ".help":
            print("REPL commands:\n  .exit / .quit    Exit\n  .json on/off     Toggle JSON output\n  .help            This help\nAll other input is sent to the viewer.", file=sys.stderr)
            continue

        await exec_and_print(conn, cmd, json_mode)


async def main():
    # Parse CLI flags
    url = "ws://localhost:8765"
    json_mode = False
    command_args = []

    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--host" and i + 1 < len(args):
            url = args[i + 1]; i += 2; continue
        if args[i] == "--port" and i + 1 < len(args):
            url = f"ws://localhost:{args[i + 1]}"; i += 2; continue
        if args[i] == "--json":
            json_mode = True; i += 1; continue
        if args[i] == "--help":
            print(__doc__)
            return
        command_args.append(args[i])
        i += 1

    # Connect
    conn = CliConnection(url)
    print(f"Connecting to {url}...", file=sys.stderr)
    try:
        ack = await conn.connect()
        print(ack, file=sys.stderr)
    except Exception as e:
        print(f"Failed: {e}", file=sys.stderr)
        print("Ensure relay is running and viewer is open.", file=sys.stderr)
        sys.exit(2)

    try:
        # One-shot mode
        if command_args:
            cmd = " ".join(f'"{a}"' if " " in a else a for a in command_args)
            ok = await exec_and_print(conn, cmd, json_mode)
            sys.exit(0 if ok else 1)

        # Pipe mode
        if not sys.stdin.isatty():
            all_ok = True
            for line in sys.stdin:
                cmd = line.strip()
                if not cmd or cmd.startswith("#"):
                    continue
                ok = await exec_and_print(conn, cmd, json_mode)
                if not ok:
                    all_ok = False
            sys.exit(0 if all_ok else 1)

        # REPL mode
        await repl(conn, json_mode)
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())

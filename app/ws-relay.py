#!/usr/bin/env python3
"""
WebSocket relay server for glyph3d-js Command Center.

Routes messages between a single browser "display" client and N "controller" clients.
Controllers send flat string commands; the display processes them and sends responses back.

Connection modes:
  - Localhost:  ws://localhost:PORT        (same machine, e.g. Claude Code terminal)
  - LAN:       ws://192.168.x.x:PORT      (phone/tablet on same network)

Usage:
    python3 app/ws-relay.py [--port 8765] [--host 0.0.0.0]

    --host 0.0.0.0    Listen on all interfaces (LAN accessible)
    --host localhost   Listen only on localhost (default)
    --port 8765        Port number (default 8765)

Protocol:
    First message from a client determines its role:
      "DISPLAY"      -> browser viewer (only one allowed)
      anything else  -> controller, first message is a command

    Controller -> Display:  relay wraps as  {"from": id, "cmd": "..."}
    Display -> Controller:  relay parses    {"to": id, "response": "...", "data": {...}}
"""

import asyncio
import base64
import json
import socket
import sys
from pathlib import Path

try:
    import websockets
except ImportError:
    print("Missing 'websockets' package. Install with: pip install websockets")
    sys.exit(1)

CACHE_DIR = Path.home() / '.glyph3d' / 'cache'

display = None
controllers = {}  # id -> websocket
next_id = 0


def get_lan_addresses():
    """Get all LAN IP addresses for this machine."""
    addresses = []
    try:
        # Get all network interfaces
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addr = info[4][0]
            if not addr.startswith('127.'):
                addresses.append(addr)
    except Exception:
        pass

    # Fallback: create a UDP socket to detect the primary LAN address
    if not addresses:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(('8.8.8.8', 80))
            addr = s.getsockname()[0]
            s.close()
            if not addr.startswith('127.'):
                addresses.append(addr)
        except Exception:
            pass

    return list(set(addresses))


async def notify_display(event, data=None):
    """Send an event notification to the display client."""
    if display is None:
        return
    msg = {"event": event}
    if data:
        msg.update(data)
    try:
        await display.send(json.dumps(msg))
    except Exception:
        pass


def atlas_cache_key(font, size):
    """Build a cache key slug from font name and size."""
    slug = str(font).lower().replace(' ', '-')
    return f"atlas-{slug}-{size}"


async def handle_relay_message(ws, msg):
    """Handle relay-direct messages (atlas cache get/store)."""
    relay = msg.get("relay")

    if relay == "atlas.get":
        key = atlas_cache_key(msg.get("font", ""), msg.get("size", 0))
        png_path = CACHE_DIR / f"{key}.png"
        json_path = CACHE_DIR / f"{key}.json"

        if png_path.exists() and json_path.exists():
            png_b64 = base64.b64encode(png_path.read_bytes()).decode("ascii")
            descriptor = json.loads(json_path.read_text())
            print(f"[relay] atlas cache hit: {key}")
            await ws.send(json.dumps({
                "event": "atlas.result", "hit": True,
                "png": png_b64, "descriptor": descriptor
            }))
        else:
            print(f"[relay] atlas cache miss: {key}")
            await ws.send(json.dumps({"event": "atlas.result", "hit": False}))

    elif relay == "atlas.cache":
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        key = atlas_cache_key(msg.get("font", ""), msg.get("size", 0))
        png_path = CACHE_DIR / f"{key}.png"
        json_path = CACHE_DIR / f"{key}.json"

        png_path.write_bytes(base64.b64decode(msg.get("png", "")))
        json_path.write_text(json.dumps(msg.get("descriptor", {}), indent=2))
        print(f"[relay] atlas cached: {json_path}")
        await ws.send(json.dumps({
            "event": "atlas.cached", "path": str(json_path)
        }))

    elif relay == "atlas.clear":
        key = atlas_cache_key(msg.get("font", ""), msg.get("size", 0))
        png_path = CACHE_DIR / f"{key}.png"
        json_path = CACHE_DIR / f"{key}.json"
        removed = 0
        for p in (png_path, json_path):
            try:
                if p.exists():
                    p.unlink()
                    removed += 1
            except OSError:
                pass
        print(f"[relay] atlas cache cleared: {key} ({removed} files)")
        await ws.send(json.dumps({
            "event": "atlas.cleared", "key": key, "removed": removed
        }))

    else:
        await ws.send(json.dumps({"error": f"unknown relay command: {relay}"}))


async def handler(ws):
    global display, next_id

    client_id = None
    role = None

    try:
        async for raw in ws:
            # Check for relay-direct messages (from any client, any role)
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict) and 'relay' in parsed:
                    await handle_relay_message(ws, parsed)
                    continue
            except (json.JSONDecodeError, TypeError):
                pass

            # First message determines role
            if role is None:
                if raw.strip() == "DISPLAY":
                    if display is not None:
                        await ws.send(json.dumps({"error": "display already connected"}))
                        return
                    display = ws
                    role = "display"
                    print(f"[relay] display connected from {ws.remote_address}")
                    await ws.send(json.dumps({
                        "ok": True,
                        "role": "display",
                        "controllers": list(controllers.keys())
                    }))
                    continue
                else:
                    client_id = f"ctrl-{next_id}"
                    next_id += 1
                    controllers[client_id] = ws
                    role = "controller"
                    print(f"[relay] controller '{client_id}' connected from {ws.remote_address}")
                    await ws.send(f"OK: connected as {client_id}")
                    # Notify display of new controller
                    await notify_display("client_connected", {"clientId": client_id})
                    # Fall through to process first message as a command

            if role == "controller":
                cmd = raw.strip()
                if not cmd:
                    continue

                # Special controller-only commands
                if cmd.lower() == "ping":
                    await ws.send("pong")
                    continue

                if cmd.lower() == "whoami":
                    await ws.send(f"You are {client_id}. Display: {'connected' if display else 'not connected'}")
                    continue

                if display is None:
                    await ws.send("ERR: no display connected. Open the viewer in a browser first.")
                    continue

                # Forward command to display
                envelope = json.dumps({"from": client_id, "cmd": cmd})
                await display.send(envelope)

            elif role == "display":
                # Display sends responses back to a specific controller
                try:
                    msg = json.loads(raw)
                    target = msg.get("to")
                    response = msg.get("response", "")
                    if target and target in controllers:
                        # Send text response (and optionally structured data)
                        if msg.get("data"):
                            await controllers[target].send(json.dumps({
                                "response": response,
                                "data": msg["data"]
                            }))
                        else:
                            await controllers[target].send(response)
                    elif target:
                        print(f"[relay] target '{target}' not found (may have disconnected)")
                except json.JSONDecodeError:
                    print(f"[relay] invalid JSON from display: {raw[:100]}")

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        if role == "display":
            display = None
            print(f"[relay] display disconnected")
        elif role == "controller" and client_id:
            controllers.pop(client_id, None)
            print(f"[relay] controller '{client_id}' disconnected")
            await notify_display("client_disconnected", {"clientId": client_id})


async def main(host="localhost", port=8765):
    lan_addrs = get_lan_addresses()

    print(f"[relay] WebSocket Command Center Relay")
    print(f"[relay] ================================")
    print(f"[relay] Listening on {host}:{port}")
    print(f"[relay]")
    print(f"[relay] Connect from same machine:")
    print(f"[relay]   ws://localhost:{port}")
    if host == "0.0.0.0" and lan_addrs:
        print(f"[relay]")
        print(f"[relay] Connect from LAN (phone/tablet):")
        for addr in lan_addrs:
            print(f"[relay]   ws://{addr}:{port}")
    elif host != "0.0.0.0":
        print(f"[relay]")
        print(f"[relay] For LAN access, restart with: --host 0.0.0.0")
    print(f"[relay]")
    print(f"[relay] Usage:")
    print(f"[relay]   websocat ws://localhost:{port}")
    print(f"[relay]   Then type commands: help, status, camera.info, etc.")
    print(f"[relay] ================================")

    async with websockets.serve(handler, host, port):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    host = "0.0.0.0"  # Default to all interfaces for LAN access
    port = 8765

    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--port" and i + 1 < len(args):
            port = int(args[i + 1])
            i += 2
        elif args[i] == "--host" and i + 1 < len(args):
            host = args[i + 1]
            i += 2
        else:
            i += 1

    asyncio.run(main(host, port))

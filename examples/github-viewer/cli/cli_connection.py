"""
CliConnection -- Python WebSocket client for the glyph3d-js relay.
Connects as a "controller" role. Sends string commands, receives responses.

Protocol: sends `ping` as first message for clean registration
(relay assigns ctrl-N, returns ack, handles ping without forwarding to display).

Requirements: pip install websockets (or pacman -S python-websockets)
"""

import asyncio
import json

try:
    import websockets
except ImportError:
    raise ImportError("Missing 'websockets' package. Install with: pip install websockets")


class CliConnection:
    def __init__(self, url="ws://localhost:8765"):
        self.url = url
        self.ws = None
        self.connected = False
        self.client_id = None

    async def connect(self):
        """Connect to relay. Returns registration ack string."""
        self.ws = await websockets.connect(self.url)
        self.connected = True

        # Send ping to trigger registration
        await self.ws.send("ping")

        # Phase 1: registration ack "OK: connected as ctrl-N"
        ack = await asyncio.wait_for(self.ws.recv(), timeout=5)
        if ack.startswith("OK: connected as"):
            self.client_id = ack.split("OK: connected as ")[1]
        else:
            raise ConnectionError(f"Unexpected registration response: {ack}")

        # Phase 2: discard pong
        pong = await asyncio.wait_for(self.ws.recv(), timeout=5)
        # pong should be "pong", discard it

        return f"OK: connected as {self.client_id}"

    async def send(self, cmd, timeout=5):
        """Send command, wait for response. Returns (text, data) tuple."""
        if not self.connected or not self.ws:
            raise ConnectionError("Not connected")

        await self.ws.send(cmd)
        raw = await asyncio.wait_for(self.ws.recv(), timeout=timeout)

        try:
            parsed = json.loads(raw)
            text = parsed.get("response", raw)
            data = parsed.get("data", None)
            return text, data
        except (json.JSONDecodeError, TypeError):
            return raw, None

    async def close(self):
        if self.ws:
            await self.ws.close()
            self.ws = None
            self.connected = False

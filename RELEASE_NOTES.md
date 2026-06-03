**glyph3d-cli** — a single self-contained binary. Download the one for your OS,
run it, and it serves glyph3d in your browser at http://localhost:8080. No
install, no dependencies; the whole app is baked into the binary.

### macOS / Linux

```sh
chmod +x glyph3d-cli-<platform>
./glyph3d-cli-<platform> serve            # browse the current directory
./glyph3d-cli-<platform> serve ~/project  # …or point it at a repo
```

macOS is unsigned here, so Gatekeeper may say it's from an "unidentified
developer." Clear the quarantine flag once:

```sh
xattr -d com.apple.quarantine glyph3d-cli-darwin-*
```

…or right-click the binary → **Open** the first time.

### Windows

```
glyph3d-cli-windows-amd64.exe serve
```

SmartScreen may warn (unsigned) — **More info → Run anyway**.

---

Then open **http://localhost:8080**. `Ctrl-C` to stop.

| platform | file |
| --- | --- |
| macOS (Apple Silicon) | `glyph3d-cli-darwin-arm64` |
| macOS (Intel) | `glyph3d-cli-darwin-amd64` |
| Linux (x86-64) | `glyph3d-cli-linux-amd64` |
| Linux (ARM64) | `glyph3d-cli-linux-arm64` |
| Windows (x86-64) | `glyph3d-cli-windows-amd64.exe` |

#!/bin/sh
# glyph3d-cli installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/tikimcfee/glyph3d-js/main/tools/install.sh | sh
#
# Environment variables:
#   GLYPH3D_INSTALL_DIR  - Installation directory (default: ~/.local/bin)
#   GLYPH3D_REPO         - GitHub repo (default: tikimcfee/glyph3d-js)
#   GLYPH3D_VERSION      - Version tag (default: latest)

set -e

REPO="${GLYPH3D_REPO:-tikimcfee/glyph3d-js}"
VERSION="${GLYPH3D_VERSION:-latest}"
INSTALL_DIR="${GLYPH3D_INSTALL_DIR:-$HOME/.local/bin}"
BINARY="glyph3d-cli"

# ---- Platform detection ----

detect_os() {
    case "$(uname -s)" in
        Linux*)  echo "linux" ;;
        Darwin*) echo "darwin" ;;
        MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
        *)       echo "unknown" ;;
    esac
}

detect_arch() {
    case "$(uname -m)" in
        x86_64|amd64)   echo "amd64" ;;
        aarch64|arm64)  echo "arm64" ;;
        *)              echo "unknown" ;;
    esac
}

OS="$(detect_os)"
ARCH="$(detect_arch)"

if [ "$OS" = "unknown" ]; then
    echo "Error: unsupported operating system: $(uname -s)" >&2
    exit 1
fi

if [ "$ARCH" = "unknown" ]; then
    echo "Error: unsupported architecture: $(uname -m)" >&2
    exit 1
fi

# Build artifact name
if [ "$OS" = "windows" ]; then
    ARTIFACT="${BINARY}-${OS}-${ARCH}.exe"
else
    ARTIFACT="${BINARY}-${OS}-${ARCH}"
fi

echo "glyph3d-cli installer"
echo "  OS:      $OS"
echo "  Arch:    $ARCH"
echo "  Binary:  $ARTIFACT"
echo ""

# ---- Download ----

if [ "$VERSION" = "latest" ]; then
    DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ARTIFACT}"
else
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${ARTIFACT}"
fi

echo "Downloading from: $DOWNLOAD_URL"

# Create install directory
mkdir -p "$INSTALL_DIR"

DEST="$INSTALL_DIR/$BINARY"
if [ "$OS" = "windows" ]; then
    DEST="$INSTALL_DIR/${BINARY}.exe"
fi

# Download with curl or wget
if command -v curl >/dev/null 2>&1; then
    HTTP_CODE=$(curl -fsSL -w '%{http_code}' -o "$DEST" "$DOWNLOAD_URL" 2>/dev/null) || true
    if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "000" ]; then
        echo ""
        echo "Download failed (HTTP $HTTP_CODE)."
        echo ""
        echo "No GitHub release found. You can build from source instead:"
        echo "  git clone https://github.com/${REPO}.git"
        echo "  cd glyph3d-js && make"
        echo "  cp glyph3d-cli $INSTALL_DIR/"
        rm -f "$DEST"
        exit 1
    fi
elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$DEST" "$DOWNLOAD_URL" || {
        echo ""
        echo "Download failed."
        echo ""
        echo "No GitHub release found. You can build from source instead:"
        echo "  git clone https://github.com/${REPO}.git"
        echo "  cd glyph3d-js && make"
        echo "  cp glyph3d-cli $INSTALL_DIR/"
        rm -f "$DEST"
        exit 1
    }
else
    echo "Error: need curl or wget to download" >&2
    exit 1
fi

chmod +x "$DEST"

# ---- Verify ----

echo ""
if "$DEST" version >/dev/null 2>&1; then
    echo "Installed: $DEST"
    "$DEST" version
else
    echo "Installed: $DEST"
    echo "(binary downloaded but 'version' check skipped)"
fi

# ---- PATH hint ----

case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
        echo ""
        echo "Add to your PATH if not already:"
        SHELL_NAME="$(basename "$SHELL" 2>/dev/null || echo "sh")"
        case "$SHELL_NAME" in
            fish)
                echo "  fish_add_path $INSTALL_DIR"
                ;;
            zsh)
                echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc"
                ;;
            *)
                echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.bashrc"
                ;;
        esac
        ;;
esac

echo ""
echo "Get started:"
echo "  glyph3d-cli serve              # Browse current directory"
echo "  glyph3d-cli serve ~/project    # Browse a project"
echo "  open http://localhost:8080/"

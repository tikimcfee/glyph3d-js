#!/bin/sh
# termd-vendor.sh — fill vendor/ with what the Rust workspace builds libghostty-vt from: the
# libghostty-vt release source + deps tarballs and this host's Zig. `make termd` runs it before
# every build; it returns at once when vendor/ already holds the pins below.
#
# Downloads are kept once per user, in $XDG_CACHE_HOME/glyph3d/termd-vendor/ (when it is unset,
# ~/Library/Caches on macOS, ~/.cache elsewhere), so every checkout and worktree fills from it
# with no download; each checkout gets its own vendor/ (gitignored, real directories). The
# network is needed once per user and pin.
#
# Every file is checked each time it is unpacked, cached or not: its pinned SHA-256 (Zig's from
# ziglang.org/download/index.json), then its minisign signature (Ghostty's and Zig's published
# keys) through crates/g3d-vendor, a Rust check built with the workspace — nothing to install.
# A failed check unpacks nothing and removes the bad cached copy.
#
# vendor/.pins records what vendor/ holds; a changed pin here unpacks vendor/ anew. The libghostty
# build script reruns on its env (the paths in .cargo/config.toml), not on vendor/'s files: a
# libghostty-vt bump comes with libghostty-rs's rev (Cargo.toml), which rebuilds it.
set -eu

GHOSTTY_VERSION=1.0.1
ZIG_VERSION=0.17.0
GHOSTTY_KEY=RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV
ZIG_KEY=RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U
GHOSTTY_SRC_SHA256=333dfce97641ef9b536bb9e08907ad86abaaada50e8f7417b70d9284adef37aa
GHOSTTY_DEPS_SHA256=91a4e10960a52bf5bf4b15aa2a2cddaff8a89d6cd903d3055bda4fd17de3356d
GHOSTTY_URL=https://release.files.ghostty.org/libghostty-vt/$GHOSTTY_VERSION
ZIG_URL=https://ziglang.org/download/$ZIG_VERSION

die() { echo "termd-vendor: $*" >&2; exit 1; }

case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) ZIG_HOST=x86_64-linux ZIG_SHA256=1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026 ;;
    Linux-aarch64|Linux-arm64) ZIG_HOST=aarch64-linux ZIG_SHA256=9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8 ;;
    Darwin-arm64) ZIG_HOST=aarch64-macos ZIG_SHA256=b607e9b9234790a008116ae5bdb71c6243b84b9fb42a53a9e70fde41c06c536a ;;
    Darwin-x86_64) ZIG_HOST=x86_64-macos ZIG_SHA256=4f9a1c5269aa17ebda5e6d3c2b89d6cbf36f7d2b22a0306e9ab98f25f95529c6 ;;
    *) die "no Zig build pinned for $(uname -s)-$(uname -m) (pinned: x86_64/aarch64 Linux, arm64/x86_64 macOS)" ;;
esac
GHOSTTY_SRC=libghostty-vt-$GHOSTTY_VERSION.tar.gz
GHOSTTY_DEPS=libghostty-vt-$GHOSTTY_VERSION-deps.tar.gz
ZIG_TAR=zig-$ZIG_HOST-$ZIG_VERSION.tar.xz
PINS="libghostty-vt $GHOSTTY_VERSION $GHOSTTY_SRC_SHA256 $GHOSTTY_DEPS_SHA256
zig $ZIG_VERSION $ZIG_HOST $ZIG_SHA256"

ROOT=$(cd "$(dirname "$0")/.." && pwd)
VENDOR=$ROOT/vendor
[ -L "$VENDOR" ] && die "$VENDOR is a link (to $(readlink "$VENDOR")). vendor/ is this checkout's own
  directory now, filled from the per-user download cache. Remove the link (rm '$VENDOR'; what it
  points at stays) and run make termd again."
[ -f "$VENDOR/.pins" ] && [ "$(cat "$VENDOR/.pins")" = "$PINS" ] && exit 0

if [ -n "${XDG_CACHE_HOME:-}" ]; then CACHE=$XDG_CACHE_HOME
elif [ "$(uname -s)" = Darwin ]; then CACHE=$HOME/Library/Caches
else CACHE=$HOME/.cache; fi
CACHE=$CACHE/glyph3d/termd-vendor
GHOSTTY_CACHE=$CACHE/libghostty-vt-$GHOSTTY_VERSION
ZIG_CACHE=$CACHE/zig-$ZIG_VERSION

command -v curl >/dev/null 2>&1 || die "need curl on PATH to fetch libghostty-vt and Zig"
command -v cargo >/dev/null 2>&1 || die "need cargo on PATH (the signature check is built with the workspace)"
# sha256sum (Linux, macOS 15+), else shasum (Perl, every macOS). A pipeline's status is its
# last command's, so the tool is picked up front rather than by `||`.
if command -v sha256sum >/dev/null 2>&1; then SHA256="sha256sum"
elif command -v shasum >/dev/null 2>&1; then SHA256="shasum -a 256"
else die "need sha256sum or shasum on PATH to verify the downloads"; fi

cd "$ROOT"
TMP=
trap '[ -z "$TMP" ] || rm -rf "$TMP"' EXIT
trap 'exit 130' INT TERM

echo "termd-vendor: filling vendor/ (libghostty-vt $GHOSTTY_VERSION, Zig $ZIG_VERSION $ZIG_HOST) from $CACHE"
cargo build -q --release --locked -p g3d-vendor || die "could not build the signature check (crates/g3d-vendor)"

# check FILE KEY SHA256: the pin, then the signature (FILE.minisig beside it). Says why on failure.
check() {
    got=$($SHA256 "$1" | cut -d' ' -f1)
    if [ "$got" != "$3" ]; then
        echo "termd-vendor: SHA-256 mismatch for $(basename "$1"): expected $3, got $got" >&2
        return 1
    fi
    cargo run -q --release --locked -p g3d-vendor -- verify "$2" "$1" "$1.minisig"
}

# cached DIR NAME URL KEY SHA256: leave DIR/NAME and its .minisig in the cache, checked.
cached() {
    if [ -s "$1/$2" ] && [ -s "$1/$2.minisig" ]; then
        check "$1/$2" "$4" "$5" || { rm -f "$1/$2" "$1/$2.minisig"; die "the cached $1/$2 failed its check and was removed.
  Run make termd again to fetch it anew from $3/$2"; }
        return 0
    fi
    [ -n "$TMP" ] || { mkdir -p "$CACHE"; TMP=$(mktemp -d "$CACHE/.fetch.XXXXXX"); }
    for f in "$2.minisig" "$2"; do
        echo "termd-vendor: fetching $3/$f"
        curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$TMP/$f" "$3/$f" ||
            die "download failed: $3/$f
  The network is needed once per user; later builds fill from $CACHE.
  Run make termd again to retry, or put the file there yourself, as $1/$f
  ($2 must match SHA-256 $5 and its minisign signature)."
    done
    check "$TMP/$2" "$4" "$5" || die "$3/$2 failed its check (pinned SHA-256 $5, minisign key $4).
  Nothing was cached or unpacked. Run make termd again to retry; a second failure means the
  published file is not the pinned one."
    mkdir -p "$1"
    mv -f "$TMP/$2.minisig" "$1/$2.minisig"
    mv -f "$TMP/$2" "$1/$2"
}

cached "$GHOSTTY_CACHE" "$GHOSTTY_SRC" "$GHOSTTY_URL" "$GHOSTTY_KEY" "$GHOSTTY_SRC_SHA256"
cached "$GHOSTTY_CACHE" "$GHOSTTY_DEPS" "$GHOSTTY_URL" "$GHOSTTY_KEY" "$GHOSTTY_DEPS_SHA256"
cached "$ZIG_CACHE" "$ZIG_TAR" "$ZIG_URL" "$ZIG_KEY" "$ZIG_SHA256"

# Unpack into a fresh vendor/; .pins, written last, says it is whole.
rm -rf "$VENDOR"
mkdir -p "$VENDOR"
unpack() { # TARBALL TAR-FLAGS TOPDIR NAME
    tar "$2" "$1" -C "$VENDOR" || die "could not unpack $1"
    [ -d "$VENDOR/$3" ] || die "$1 did not unpack to $3/"
    mv "$VENDOR/$3" "$VENDOR/$4"
}
unpack "$GHOSTTY_CACHE/$GHOSTTY_SRC" -xzf "libghostty-vt-$GHOSTTY_VERSION" ghostty
unpack "$GHOSTTY_CACHE/$GHOSTTY_DEPS" -xzf "libghostty-vt-$GHOSTTY_VERSION-deps" ghostty-deps
unpack "$ZIG_CACHE/$ZIG_TAR" -xJf "zig-$ZIG_HOST-$ZIG_VERSION" zig
"$VENDOR/zig/zig" version | grep -q "^0\.17\." || die "the Zig in $VENDOR/zig is not 0.17.x"
printf '%s\n' "$PINS" >"$VENDOR/.pins"
echo "termd-vendor: vendor/ ready, every file checked against its pinned SHA-256 and minisign signature"

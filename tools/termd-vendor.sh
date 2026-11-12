#!/bin/sh
# termd-vendor.sh — fetch and verify what the Rust workspace builds libghostty-vt from:
# the libghostty-vt release source + deps tarballs and Zig. Nothing is fetched at build time.
#
#   tools/termd-vendor.sh            unpack into vendor/
#   tools/termd-vendor.sh DIR        unpack into DIR and link vendor/ -> DIR (keep big toolchains
#                                    out of the tree); DIR may already hold verified downloads
#
# Every download is checked against its minisign signature (Ghostty's and Zig's published keys)
# and against a pinned SHA-256 (Zig's from ziglang.org/download/index.json). It needs `minisign` or `rsign` on PATH
# (or MINISIGN=/path/to/either). A failed check stops the script and leaves nothing unpacked.
# .cargo/config.toml points GHOSTTY_SOURCE_DIR, GHOSTTY_ZIG_SYSTEM_DIR and ZIG at vendor/.
set -eu

GHOSTTY_VERSION=1.0.1
ZIG_VERSION=0.17.0
GHOSTTY_KEY=RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV
ZIG_KEY=RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U
GHOSTTY_SRC_SHA256=333dfce97641ef9b536bb9e08907ad86abaaada50e8f7417b70d9284adef37aa
GHOSTTY_DEPS_SHA256=91a4e10960a52bf5bf4b15aa2a2cddaff8a89d6cd903d3055bda4fd17de3356d
GHOSTTY_URL=https://release.files.ghostty.org/libghostty-vt/$GHOSTTY_VERSION
ZIG_URL=https://ziglang.org/download/$ZIG_VERSION

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR=${1:-$ROOT/vendor}
mkdir -p "$DIR/dl"
DIR=$(cd "$DIR" && pwd)

die() { echo "termd-vendor: $*" >&2; exit 1; }

MINISIGN=${MINISIGN:-}
if [ -z "$MINISIGN" ]; then
    if command -v minisign >/dev/null 2>&1; then MINISIGN=minisign
    elif command -v rsign >/dev/null 2>&1; then MINISIGN=rsign
    else die "need minisign or rsign on PATH (or MINISIGN=...) to verify the downloads"; fi
fi
verify_sig() { # key file
    case "$(basename "$MINISIGN")" in
        rsign*) "$MINISIGN" verify -q -P "$1" -x "$2.minisig" "$2" ;;
        *) "$MINISIGN" -Vq -P "$1" -x "$2.minisig" -m "$2" ;;
    esac || die "signature check failed: $2"
}
fetch() { # url file
    [ -s "$2" ] && return 0
    echo "termd-vendor: fetching $1"
    curl -fsSL --retry 3 -o "$2.part" "$1" || die "download failed: $1"
    mv "$2.part" "$2"
}
# sha256sum (Linux, macOS 15+), else shasum (Perl, every macOS). A pipeline's status is its
# last command's, so the tool is picked up front rather than by `||`.
if command -v sha256sum >/dev/null 2>&1; then SHA256="sha256sum"
elif command -v shasum >/dev/null 2>&1; then SHA256="shasum -a 256"
else die "need sha256sum or shasum on PATH to verify the downloads"; fi
sha256() { $SHA256 "$1" | cut -d' ' -f1; }

# libghostty-vt: source + deps tarballs.
for f in "libghostty-vt-$GHOSTTY_VERSION.tar.gz" "libghostty-vt-$GHOSTTY_VERSION-deps.tar.gz"; do
    fetch "$GHOSTTY_URL/$f" "$DIR/dl/$f"
    fetch "$GHOSTTY_URL/$f.minisig" "$DIR/dl/$f.minisig"
    verify_sig "$GHOSTTY_KEY" "$DIR/dl/$f"
done
[ "$(sha256 "$DIR/dl/libghostty-vt-$GHOSTTY_VERSION.tar.gz")" = "$GHOSTTY_SRC_SHA256" ] || die "source tarball SHA-256 mismatch"
[ "$(sha256 "$DIR/dl/libghostty-vt-$GHOSTTY_VERSION-deps.tar.gz")" = "$GHOSTTY_DEPS_SHA256" ] || die "deps tarball SHA-256 mismatch"
for f in "libghostty-vt-$GHOSTTY_VERSION" "libghostty-vt-$GHOSTTY_VERSION-deps"; do
    if [ ! -d "$DIR/$f" ]; then
        tar -xzf "$DIR/dl/$f.tar.gz" -C "$DIR"
        [ -d "$DIR/$f" ] || die "$f.tar.gz did not unpack to $f/"
    fi
done
ln -sfn "libghostty-vt-$GHOSTTY_VERSION" "$DIR/ghostty"
ln -sfn "libghostty-vt-$GHOSTTY_VERSION-deps" "$DIR/ghostty-deps"

# Zig, for this host.
case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) ZIG_HOST=x86_64-linux ZIG_SHA256=1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026 ;;
    Linux-aarch64|Linux-arm64) ZIG_HOST=aarch64-linux ZIG_SHA256=9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8 ;;
    Darwin-arm64) ZIG_HOST=aarch64-macos ZIG_SHA256=b607e9b9234790a008116ae5bdb71c6243b84b9fb42a53a9e70fde41c06c536a ;;
    Darwin-x86_64) ZIG_HOST=x86_64-macos ZIG_SHA256=4f9a1c5269aa17ebda5e6d3c2b89d6cbf36f7d2b22a0306e9ab98f25f95529c6 ;;
    *) die "no Zig build known for $(uname -s)-$(uname -m); set it up by hand at $DIR/zig/zig" ;;
esac
ZIG_TAR="zig-$ZIG_HOST-$ZIG_VERSION.tar.xz"
fetch "$ZIG_URL/$ZIG_TAR" "$DIR/dl/$ZIG_TAR"
fetch "$ZIG_URL/$ZIG_TAR.minisig" "$DIR/dl/$ZIG_TAR.minisig"
verify_sig "$ZIG_KEY" "$DIR/dl/$ZIG_TAR"
[ "$(sha256 "$DIR/dl/$ZIG_TAR")" = "$ZIG_SHA256" ] || die "$ZIG_TAR SHA-256 mismatch"
if [ ! -x "$DIR/zig-$ZIG_HOST-$ZIG_VERSION/zig" ]; then
    tar -xJf "$DIR/dl/$ZIG_TAR" -C "$DIR"
fi
ln -sfn "zig-$ZIG_HOST-$ZIG_VERSION" "$DIR/zig"
"$DIR/zig/zig" version | grep -q "^0\.17\." || die "Zig at $DIR/zig is not 0.17.x"

if [ "$DIR" != "$ROOT/vendor" ]; then
    if [ -e "$ROOT/vendor" ] && [ ! -L "$ROOT/vendor" ]; then die "$ROOT/vendor exists and is not a link"; fi
    ln -sfn "$DIR" "$ROOT/vendor"
fi
echo "termd-vendor: libghostty-vt $GHOSTTY_VERSION and Zig $ZIG_VERSION verified in $DIR"

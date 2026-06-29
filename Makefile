# glyph3d-cli — single-binary build
#
# Build:
#   make              Build for current platform
#   make all          Build for Linux, macOS, Windows (amd64 + arm64)
#   make deploy       Build linux-amd64 + show scp command
#   make release      Build all + create GitHub release
#   make clean        Remove build artifacts
#
# Run:
#   ./glyph3d-cli serve                    Browse current directory
#   ./glyph3d-cli serve ~/project          Browse a project
#   ./glyph3d-cli serve --local            IDE dev (app from disk)

BINARY   := glyph3d-cli
CLI_DIR  := cli
WEB_DIR  := $(CLI_DIR)/web
OUT_DIR  := dist
APP_DIR  := app

# Version info — override with: make VERSION=v1.2.3
VERSION    ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
BUILD_DATE := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

# Platform for default build (current machine)
HOST_PLATFORM := $(shell go env GOOS)-$(shell go env GOARCH)

# Go build flags — static, stripped, version-stamped
LDFLAGS := -s -w \
	-X main.Version=$(VERSION) \
	-X main.BuildDate=$(BUILD_DATE) \
	-X main.Platform=$(HOST_PLATFORM)
GOFLAGS := -trimpath -ldflags='$(LDFLAGS)'

.PHONY: all build clean prep bake-core prep-wasm prep-tree-sitter deploy deploy-ide release linux-amd64 linux-arm64 darwin-amd64 darwin-arm64 windows-amd64 dev dev-vite dev-relay dev-status dev-stop

# --- Default: build for current platform ---

build: prep
	cd $(CLI_DIR) && go build $(GOFLAGS) -o ../$(BINARY) .
	@echo "Built ./$(BINARY) ($$(du -h $(BINARY) | cut -f1)) — $(VERSION)"

# --- Prep: build the app (Vite) and stage it into cli/web/ for go:embed ---
# The app is a self-contained production build — it bundles @glyph3d/core + the
# r3f bindings + three + react, and emits fonts/WASM as hashed assets. Served at
# the web root: / → index.html, /assets/... → the bundle. No importmap, no raw
# /packages/ source served. Prerequisite: deps installed (`bun install` at root).

prep: bake-core
	@rm -rf $(WEB_DIR)
	@mkdir -p $(WEB_DIR)
	@echo "Building app (vite)…"
	@cd $(APP_DIR) && bun run build
	@cp -r $(APP_DIR)/dist/. $(WEB_DIR)/
	@echo "Prepared $(WEB_DIR)/ (built app) for embedding"

# --- Bake the prebaked slug-core static asset (app/public/slug-core/<key>.bin) ---
# Headless HarfBuzz encode of the LARGE_CORE for the app's font chain. Vite copies
# app/public/ into the build, so the asset ships with both the web app and (via prep
# → cli/web) the binary; at runtime a fresh device hydrates from it instead of
# encoding. Gitignored + regenerated here so it can never go stale vs the code.
# Non-fatal: a bake failure just means the runtime live-encodes (the ladder fallback),
# so the build still succeeds.
bake-core:
	@echo "Baking slug-core asset…"
	@bun tools/bake-slug-core.mjs || echo "  ⚠ slug-core bake failed — app will live-encode at runtime"

# --- Vendor HarfBuzz WASM from node_modules ---
# Run after npm install to refresh vendored harfbuzzjs files.
# The vendored files in src/shaping/vendor/ are checked into git,
# so this only needs to run when upgrading harfbuzzjs.

VENDOR := packages/glyph3d-core/src/shaping/vendor
prep-wasm:
	@echo "Vendoring harfbuzzjs files..."
	@cp node_modules/harfbuzzjs/hb.wasm $(VENDOR)/hb.wasm
	@cp node_modules/harfbuzzjs/hb.js $(VENDOR)/hb.js
	@echo 'export default createHarfBuzz;' >> $(VENDOR)/hb.js
	@cp node_modules/harfbuzzjs/hbjs.js $(VENDOR)/hbjs.js
	@echo 'export default hbjs;' >> $(VENDOR)/hbjs.js
	@echo "Vendored hb.wasm ($$(du -h $(VENDOR)/hb.wasm | cut -f1)), hb.js, hbjs.js → $(VENDOR)/"

# --- Vendor tree-sitter WASM (runtime + grammars) from node_modules ---
# Run after upgrading web-tree-sitter or a grammar package. Vendored files in
# src/parsing/vendor/ are checked into git and bundled by Vite as hashed assets,
# so they ship inside the single binary; grammars are lazy-loaded at runtime.
# Grammar wasms come from the individual tree-sitter-<lang> packages — NOT
# tree-sitter-wasms, whose prebuilts are an older ABI the 0.26 runtime can't load
# (dylink metadata mismatch). The tsx grammar ships inside tree-sitter-typescript.
TS_VENDOR := packages/glyph3d-core/src/parsing/vendor
prep-tree-sitter:
	@echo "Vendoring tree-sitter runtime + grammars..."
	@cp node_modules/web-tree-sitter/web-tree-sitter.wasm $(TS_VENDOR)/
	@cp node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm $(TS_VENDOR)/
	@cp node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm $(TS_VENDOR)/
	@cp node_modules/tree-sitter-typescript/tree-sitter-tsx.wasm $(TS_VENDOR)/
	@cp node_modules/tree-sitter-go/tree-sitter-go.wasm $(TS_VENDOR)/
	@cp node_modules/tree-sitter-python/tree-sitter-python.wasm $(TS_VENDOR)/
	@cp node_modules/tree-sitter-json/tree-sitter-json.wasm $(TS_VENDOR)/
	@echo "Vendored web-tree-sitter.wasm + 6 grammars ($$(du -sh $(TS_VENDOR) | cut -f1)) → $(TS_VENDOR)/"

# --- Cross-compilation ---
# Each target sets Platform via LDFLAGS override.

all: linux-amd64 linux-arm64 darwin-amd64 darwin-arm64 windows-amd64
	@echo "All platforms built in $(OUT_DIR)/ — $(VERSION)"

linux-amd64: prep
	@mkdir -p $(OUT_DIR)
	cd $(CLI_DIR) && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
		-ldflags='-s -w -X main.Version=$(VERSION) -X main.BuildDate=$(BUILD_DATE) -X main.Platform=linux-amd64' \
		-o ../$(OUT_DIR)/$(BINARY)-linux-amd64 .
	@echo "  → $(OUT_DIR)/$(BINARY)-linux-amd64"

linux-arm64: prep
	@mkdir -p $(OUT_DIR)
	cd $(CLI_DIR) && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath \
		-ldflags='-s -w -X main.Version=$(VERSION) -X main.BuildDate=$(BUILD_DATE) -X main.Platform=linux-arm64' \
		-o ../$(OUT_DIR)/$(BINARY)-linux-arm64 .
	@echo "  → $(OUT_DIR)/$(BINARY)-linux-arm64"

darwin-amd64: prep
	@mkdir -p $(OUT_DIR)
	cd $(CLI_DIR) && CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -trimpath \
		-ldflags='-s -w -X main.Version=$(VERSION) -X main.BuildDate=$(BUILD_DATE) -X main.Platform=darwin-amd64' \
		-o ../$(OUT_DIR)/$(BINARY)-darwin-amd64 .
	@echo "  → $(OUT_DIR)/$(BINARY)-darwin-amd64"

darwin-arm64: prep
	@mkdir -p $(OUT_DIR)
	cd $(CLI_DIR) && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath \
		-ldflags='-s -w -X main.Version=$(VERSION) -X main.BuildDate=$(BUILD_DATE) -X main.Platform=darwin-arm64' \
		-o ../$(OUT_DIR)/$(BINARY)-darwin-arm64 .
	@echo "  → $(OUT_DIR)/$(BINARY)-darwin-arm64"

windows-amd64: prep
	@mkdir -p $(OUT_DIR)
	cd $(CLI_DIR) && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath \
		-ldflags='-s -w -X main.Version=$(VERSION) -X main.BuildDate=$(BUILD_DATE) -X main.Platform=windows-amd64' \
		-o ../$(OUT_DIR)/$(BINARY)-windows-amd64.exe .
	@echo "  → $(OUT_DIR)/$(BINARY)-windows-amd64.exe"

# --- GitHub Release ---
# Build all platforms and create a GitHub release.
#
# Usage:
#   make release VERSION=v0.1.0
#   make release              # uses git describe

release: all
	@echo ""
	@echo "Creating GitHub release $(VERSION)..."
	gh release create $(VERSION) \
		$(OUT_DIR)/$(BINARY)-linux-amd64 \
		$(OUT_DIR)/$(BINARY)-linux-arm64 \
		$(OUT_DIR)/$(BINARY)-darwin-amd64 \
		$(OUT_DIR)/$(BINARY)-darwin-arm64 \
		$(OUT_DIR)/$(BINARY)-windows-amd64.exe \
		--title "$(BINARY) $(VERSION)" \
		--notes-file RELEASE_NOTES.md
	@echo ""
	@echo "Release created: https://github.com/$$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/$(VERSION)"

# --- Deploy helper ---
# Build for production target and show the deploy command.
# Set your target host:  make deploy DEPLOY_HOST=user@host

DEPLOY_HOST ?= your-server

deploy: linux-amd64
	@echo ""
	@echo "Deploy to $(DEPLOY_HOST):"
	@echo "  scp $(OUT_DIR)/$(BINARY)-linux-amd64 $(DEPLOY_HOST):/usr/local/bin/$(BINARY)"
	@echo "  ssh $(DEPLOY_HOST) '$(BINARY) serve --port 8080'"

# Promote the IDE to the hosted demo at glyph3d.dev/ide (static, GitHub-only mode).
# Builds with the /ide/ mount point and syncs to the web root.
# Set your target at call time:  make deploy-ide IDE_DEPLOY_HOST=user@host
IDE_DEPLOY_HOST ?= your-server
IDE_DEPLOY_ROOT ?= /srv/www/glyph3d-ide

deploy-ide: bake-core
	cd app && GLYPH_BASE=/ide/ bun run build
	rsync -az --delete app/dist/ $(IDE_DEPLOY_HOST):$(IDE_DEPLOY_ROOT)/
	@echo "Deployed → https://glyph3d.dev/ide/"

# --- Cleanup ---

clean:
	rm -rf $(WEB_DIR) $(OUT_DIR) $(BINARY)
	@echo "Cleaned build artifacts"

# --- Dev loop: thin aliases over tools/dev.sh (manages Vite :5173 + relay :8080) ---
# `make dev` = rebuild relay + clear Vite cache + restart both, then hard-reload
# the browser. `make dev-vite` is the common one: clears the stale-cache trap that
# bites CommandProvider / handler / router edits.

dev:
	@tools/dev.sh refresh
dev-vite:
	@tools/dev.sh vite
dev-relay:
	@tools/dev.sh relay
dev-status:
	@tools/dev.sh status
dev-stop:
	@tools/dev.sh stop

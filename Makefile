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

# Assets to embed. Paths are preserved under web/ via `cp --parents`, so the
# served URL tree matches: /packages/glyph3d-core/src/... is what the app
# importmaps ("@glyph3d/core/") resolve to.
ASSETS := packages/glyph3d-core/src app examples index.html package.json

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

.PHONY: all build clean prep prep-wasm deploy release linux-amd64 linux-arm64 darwin-amd64 darwin-arm64 windows-amd64

# --- Default: build for current platform ---

build: prep
	cd $(CLI_DIR) && go build $(GOFLAGS) -o ../$(BINARY) .
	@echo "Built ./$(BINARY) ($$(du -h $(BINARY) | cut -f1)) — $(VERSION)"

# --- Prep: copy assets into cli/web/ for go:embed ---

prep:
	@rm -rf $(WEB_DIR)
	@mkdir -p $(WEB_DIR)
	@for asset in $(ASSETS); do \
		if [ -e "$$asset" ]; then \
			cp -r --parents "$$asset" $(WEB_DIR)/; \
		fi; \
	done
	@echo "Prepared $(WEB_DIR)/ for embedding"

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
		--notes "Single-binary server for glyph3d-js IDE. Download the binary for your platform, make it executable, and run: glyph3d-cli serve"
	@echo ""
	@echo "Release created: https://github.com/$$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/$(VERSION)"

# --- Deploy helper ---
# Build for production target and show deploy command.

deploy: linux-amd64
	@echo ""
	@echo "Deploy to your-server:"
	@echo "  scp $(OUT_DIR)/$(BINARY)-linux-amd64 your-server:/usr/local/bin/$(BINARY)"
	@echo "  ssh your-server '$(BINARY) serve --port 8080'"

# --- Cleanup ---

clean:
	rm -rf $(WEB_DIR) $(OUT_DIR) $(BINARY)
	@echo "Cleaned build artifacts"

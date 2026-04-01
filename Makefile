# glyph3d-cli — single-binary build
#
# Build:
#   make              Build for current platform
#   make all          Build for Linux, macOS, Windows (amd64 + arm64)
#   make deploy       Build linux-amd64 + show scp command
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

# Assets to embed
ASSETS := src app examples index.html package.json

# Go build flags — static, stripped
GOFLAGS := -trimpath -ldflags='-s -w'

.PHONY: all build clean prep deploy linux-amd64 linux-arm64 darwin-amd64 darwin-arm64 windows-amd64

# --- Default: build for current platform ---

build: prep
	cd $(CLI_DIR) && go build $(GOFLAGS) -o ../$(BINARY) .
	@echo "Built ./$(BINARY) ($$(du -h $(BINARY) | cut -f1))"

# --- Prep: copy assets into cli/web/ for go:embed ---

prep:
	@rm -rf $(WEB_DIR)
	@mkdir -p $(WEB_DIR)
	@for asset in $(ASSETS); do \
		if [ -e "$$asset" ]; then \
			cp -r "$$asset" $(WEB_DIR)/; \
		fi; \
	done
	@echo "Prepared $(WEB_DIR)/ for embedding"

# --- Cross-compilation ---

all: linux-amd64 linux-arm64 darwin-amd64 darwin-arm64 windows-amd64
	@echo "All platforms built in $(OUT_DIR)/"

linux-amd64: prep
	@mkdir -p $(OUT_DIR)
	cd $(CLI_DIR) && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build $(GOFLAGS) -o ../$(OUT_DIR)/$(BINARY)-linux-amd64 .
	@echo "  → $(OUT_DIR)/$(BINARY)-linux-amd64"

linux-arm64: prep
	@mkdir -p $(OUT_DIR)
	cd $(CLI_DIR) && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build $(GOFLAGS) -o ../$(OUT_DIR)/$(BINARY)-linux-arm64 .
	@echo "  → $(OUT_DIR)/$(BINARY)-linux-arm64"

darwin-amd64: prep
	@mkdir -p $(OUT_DIR)
	cd $(CLI_DIR) && CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build $(GOFLAGS) -o ../$(OUT_DIR)/$(BINARY)-darwin-amd64 .
	@echo "  → $(OUT_DIR)/$(BINARY)-darwin-amd64"

darwin-arm64: prep
	@mkdir -p $(OUT_DIR)
	cd $(CLI_DIR) && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build $(GOFLAGS) -o ../$(OUT_DIR)/$(BINARY)-darwin-arm64 .
	@echo "  → $(OUT_DIR)/$(BINARY)-darwin-arm64"

windows-amd64: prep
	@mkdir -p $(OUT_DIR)
	cd $(CLI_DIR) && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build $(GOFLAGS) -o ../$(OUT_DIR)/$(BINARY)-windows-amd64.exe .
	@echo "  → $(OUT_DIR)/$(BINARY)-windows-amd64.exe"

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

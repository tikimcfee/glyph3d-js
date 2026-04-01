package main

import (
	"embed"
	"io/fs"
)

// webFS holds all static assets copied into web/ by the build script.
// The build step (Makefile) copies src/, app/, examples/, index.html, etc.
// into cli/web/ before compilation, then cleans up after.
//
//go:embed all:web
var webFS embed.FS

// WebRoot returns the embedded filesystem rooted at web/,
// stripping the "web/" prefix so paths match the URL structure.
func WebRoot() (fs.FS, error) {
	return fs.Sub(webFS, "web")
}

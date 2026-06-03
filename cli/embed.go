package main

import (
	"embed"
	"io/fs"
)

// webFS holds the built app staged into web/ by `make prep`. The build step
// runs the app's Vite production build and copies app/dist/* into cli/web/
// (index.html + assets/) before compilation, then cleans up after. The served
// tree is the app itself: / → index.html, /assets/... → the bundle.
//
//go:embed all:web
var webFS embed.FS

// WebRoot returns the embedded filesystem rooted at web/,
// stripping the "web/" prefix so paths match the URL structure.
func WebRoot() (fs.FS, error) {
	return fs.Sub(webFS, "web")
}

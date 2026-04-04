package main

import (
	"io/fs"
	"log"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// LiveReloader watches source directories and fires a callback on file changes.
// Debounces rapid events (e.g. editor write + chmod) into a single notification.
type LiveReloader struct {
	watcher  *fsnotify.Watcher
	onChange func(path string)
	debounce time.Duration
}

// watchExts are file extensions that trigger a reload.
var watchExts = map[string]bool{
	".js": true, ".mjs": true, ".css": true, ".html": true, ".glsl": true,
}

// NewLiveReloader creates a watcher. onChange is called (debounced) with the changed path.
func NewLiveReloader(onChange func(path string)) (*LiveReloader, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	return &LiveReloader{
		watcher:  w,
		onChange: onChange,
		debounce: 200 * time.Millisecond,
	}, nil
}

// Watch starts watching the given directories recursively for source file changes.
func (lr *LiveReloader) Watch(dirs ...string) {
	for _, dir := range dirs {
		if err := lr.addRecursive(dir); err != nil {
			log.Printf("[livereload] skip %s: %v", dir, err)
		}
	}
	go lr.loop()
}

// addRecursive walks a directory tree and adds each subdirectory to the watcher.
func (lr *LiveReloader) addRecursive(root string) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			name := d.Name()
			if strings.HasPrefix(name, ".") || name == "node_modules" || name == "dist" {
				return filepath.SkipDir
			}
			return lr.watcher.Add(path)
		}
		return nil
	})
}

// loop processes fsnotify events with debouncing.
func (lr *LiveReloader) loop() {
	var mu sync.Mutex
	var timer *time.Timer

	for {
		select {
		case event, ok := <-lr.watcher.Events:
			if !ok {
				return
			}
			if event.Op&(fsnotify.Write|fsnotify.Create) == 0 {
				continue
			}
			ext := strings.ToLower(filepath.Ext(event.Name))
			if !watchExts[ext] {
				continue
			}

			mu.Lock()
			if timer != nil {
				timer.Stop()
			}
			path := event.Name
			timer = time.AfterFunc(lr.debounce, func() {
				lr.onChange(path)
			})
			mu.Unlock()

		case err, ok := <-lr.watcher.Errors:
			if !ok {
				return
			}
			log.Printf("[livereload] error: %v", err)
		}
	}
}

// Close stops the file watcher.
func (lr *LiveReloader) Close() error {
	return lr.watcher.Close()
}

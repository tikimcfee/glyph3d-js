//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
)

func relayRuntimeDir() string {
	return filepath.Join(os.TempDir(), "glyph3d-relay")
}

func checkSecureRuntimeDir(dir string) error {
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("relay runtime dir %s is not a directory", dir)
	}
	return nil
}

func checkSecureTokenFile(path string) error {
	fi, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() {
		return fmt.Errorf("relay token file %s is not a regular file", path)
	}
	return nil
}

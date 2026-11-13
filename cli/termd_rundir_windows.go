package main

// userRuntimeDir: no runtime directory, and no termd, on Windows (attach_windows.go).
func userRuntimeDir() string { return "" }

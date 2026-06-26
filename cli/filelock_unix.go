//go:build !windows

package main

import (
	"os"
	"syscall"
)

// flockExclusive takes an exclusive advisory lock on f, blocking until it is
// acquired, and returns a function that releases it. Serializes the
// conversation-cursor read/update across parallel-tool hook processes so two
// hooks can't read the same offset and double-forward.
func flockExclusive(f *os.File) (func(), error) {
	fd := int(f.Fd())
	if err := syscall.Flock(fd, syscall.LOCK_EX); err != nil {
		return nil, err
	}
	return func() { _ = syscall.Flock(fd, syscall.LOCK_UN) }, nil
}

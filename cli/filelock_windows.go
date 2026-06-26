//go:build windows

package main

import (
	"os"

	"golang.org/x/sys/windows"
)

// flockExclusive takes an exclusive lock on the whole of f via LockFileEx,
// blocking until it is acquired, and returns a function that releases it
// (UnlockFileEx). The Windows analogue of the Unix flock used to serialize the
// conversation-cursor read/update across parallel-tool hook processes.
func flockExclusive(f *os.File) (func(), error) {
	h := windows.Handle(f.Fd())
	// Lock the entire conventional byte range from offset 0. A zeroed Overlapped
	// means offset 0; omitting LOCKFILE_FAIL_IMMEDIATELY makes the call block
	// until the lock is granted, matching flock(LOCK_EX) semantics.
	if err := windows.LockFileEx(h, windows.LOCKFILE_EXCLUSIVE_LOCK, 0, ^uint32(0), ^uint32(0), &windows.Overlapped{}); err != nil {
		return nil, err
	}
	return func() {
		_ = windows.UnlockFileEx(h, 0, ^uint32(0), ^uint32(0), &windows.Overlapped{})
	}, nil
}

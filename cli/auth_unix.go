//go:build unix

package main

import (
	"crypto/rand"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"glyph3d-cli/termdwire"
	"golang.org/x/sys/unix"
)

// userHomeByUID resolves the account's home directory from the OS user database by UID,
// falling back to $HOME only if the lookup fails (e.g. static CGO_ENABLED=0 binary on a
// host without /etc/passwd entries). Never falls back to /tmp.
func userHomeByUID() string {
	if u, err := user.LookupId(strconv.Itoa(os.Getuid())); err == nil {
		if h := strings.TrimSpace(u.HomeDir); h != "" {
			return h
		}
	}
	if h := strings.TrimSpace(os.Getenv("HOME")); h != "" {
		return h
	}
	return ""
}

func userStateG3DDir() string {
	h := userHomeByUID()
	if h == "" {
		return ""
	}
	return filepath.Join(h, ".local", "state", "g3d")
}

// relayRuntimeDir returns the per-uid runtime directory for relay token files:
// /run/user/<uid>/g3d when logind's runtime dir is owned by this uid and private,
// else <pw_dir>/.local/state/g3d/run. Never consults $TMPDIR or $XDG_RUNTIME_DIR,
// and never falls back to /tmp.
func relayRuntimeDir() string {
	if r := termdwire.UserRuntimeDir(); r != "" {
		return filepath.Join(r, "g3d")
	}
	if s := userStateG3DDir(); s != "" {
		return filepath.Join(s, "run")
	}
	return ""
}

// defaultLogDir returns <pw_dir>/.local/state/g3d/logs for private log dumps.
func defaultLogDir() string {
	if s := userStateG3DDir(); s != "" {
		return filepath.Join(s, "logs")
	}
	return ""
}

// ensurePrivateDir creates dir (and any missing parents such as .local/state/g3d) with
// mode 0700, and tightens .local/state/g3d to 0700 if an earlier tool created it 0755.
func ensurePrivateDir(dir string) error {
	if dir == "" {
		return fmt.Errorf("cannot determine private runtime directory: user home directory is unknown")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create runtime dir %s: %w", dir, err)
	}
	if stateG3D := userStateG3DDir(); stateG3D != "" && filepath.Dir(dir) == stateG3D {
		if pfd, err := unix.Open(stateG3D, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0); err == nil {
			var pst unix.Stat_t
			if unix.Fstat(pfd, &pst) == nil && pst.Uid == uint32(os.Getuid()) && (uint32(pst.Mode)&0o077) != 0 {
				_ = unix.Fchmod(pfd, 0o700)
			}
			_ = unix.Close(pfd)
		}
	}
	return nil
}

func openSecureRuntimeDir(dir string) (int, error) {
	if dir == "" {
		return -1, fmt.Errorf("cannot determine private runtime directory: user home directory is unknown")
	}
	fd, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, fmt.Errorf("open relay runtime dir %s: %w", dir, err)
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		_ = unix.Close(fd)
		return -1, fmt.Errorf("stat relay runtime dir %s: %w", dir, err)
	}
	if (uint32(st.Mode) & uint32(unix.S_IFMT)) != uint32(unix.S_IFDIR) {
		_ = unix.Close(fd)
		return -1, fmt.Errorf("relay runtime dir %s is not a real directory", dir)
	}
	uid := uint32(os.Getuid())
	if st.Uid != uid {
		_ = unix.Close(fd)
		return -1, fmt.Errorf("relay runtime dir %s is owned by uid %d, want %d", dir, st.Uid, uid)
	}
	if perm := uint32(st.Mode) & 0o777; perm&0o077 != 0 {
		_ = unix.Close(fd)
		return -1, fmt.Errorf("relay runtime dir %s has unsafe mode %04o (group/other access must be 0)", dir, perm)
	}
	return fd, nil
}

func checkSecureRuntimeDir(dir string) error {
	fd, err := openSecureRuntimeDir(dir)
	if err != nil {
		return err
	}
	_ = unix.Close(fd)
	return nil
}

func checkSecureTokenFile(path string) error {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("open relay token file %s: %w", path, err)
	}
	defer unix.Close(fd)
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return fmt.Errorf("stat relay token file %s: %w", path, err)
	}
	if (uint32(st.Mode) & uint32(unix.S_IFMT)) != uint32(unix.S_IFREG) {
		return fmt.Errorf("relay token file %s is not a regular file", path)
	}
	uid := uint32(os.Getuid())
	if st.Uid != uid {
		return fmt.Errorf("relay token file %s is owned by uid %d, want %d", path, st.Uid, uid)
	}
	if perm := uint32(st.Mode) & 0o777; perm&0o077 != 0 {
		return fmt.Errorf("relay token file %s has unsafe mode %04o (want 0600)", path, perm)
	}
	return nil
}

func writeRelayTokenFileInDir(dir string, port int, token string) (string, func(), error) {
	if err := ensurePrivateDir(dir); err != nil {
		return "", nil, err
	}
	dirFD, err := openSecureRuntimeDir(dir)
	if err != nil {
		return "", nil, err
	}
	defer unix.Close(dirFD)

	baseName := relayTokenFileName(port)
	finalPath := filepath.Join(dir, baseName)

	var rnd [8]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		return "", nil, fmt.Errorf("crypto/rand: %w", err)
	}
	tmpBase := fmt.Sprintf(".relay-%d-%x.tmp", port, rnd)
	tmpFD, err := unix.Openat(dirFD, tmpBase, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return "", nil, fmt.Errorf("create temp token file in %s: %w", dir, err)
	}
	if err := unix.Fchmod(tmpFD, 0o600); err != nil {
		_ = unix.Close(tmpFD)
		_ = unix.Unlinkat(dirFD, tmpBase, 0)
		return "", nil, fmt.Errorf("chmod token file: %w", err)
	}
	payload := []byte(token + "\n")
	for written := 0; written < len(payload); {
		n, werr := unix.Write(tmpFD, payload[written:])
		if n > 0 {
			written += n
		}
		if werr == unix.EINTR {
			continue
		}
		if werr != nil {
			_ = unix.Close(tmpFD)
			_ = unix.Unlinkat(dirFD, tmpBase, 0)
			return "", nil, fmt.Errorf("write token file: %w", werr)
		}
	}
	var st unix.Stat_t
	if err := unix.Fstat(tmpFD, &st); err != nil {
		_ = unix.Close(tmpFD)
		_ = unix.Unlinkat(dirFD, tmpBase, 0)
		return "", nil, fmt.Errorf("stat temp token file: %w", err)
	}
	writtenDev := uint64(st.Dev)
	writtenIno := uint64(st.Ino)
	if err := unix.Close(tmpFD); err != nil {
		_ = unix.Unlinkat(dirFD, tmpBase, 0)
		return "", nil, fmt.Errorf("close token file: %w", err)
	}
	if err := unix.Renameat(dirFD, tmpBase, dirFD, baseName); err != nil {
		_ = unix.Unlinkat(dirFD, tmpBase, 0)
		return "", nil, fmt.Errorf("publish token file %s: %w", finalPath, err)
	}

	var once sync.Once
	cleanup := func() {
		once.Do(func() {
			cfd, err := openSecureRuntimeDir(dir)
			if err != nil {
				return
			}
			defer unix.Close(cfd)
			var cst unix.Stat_t
			if err := unix.Fstatat(cfd, baseName, &cst, unix.AT_SYMLINK_NOFOLLOW); err != nil {
				return
			}
			if uint64(cst.Dev) == writtenDev && uint64(cst.Ino) == writtenIno {
				_ = unix.Unlinkat(cfd, baseName, 0)
			}
		})
	}
	return finalPath, cleanup, nil
}

func readRelayTokenFileInDir(dir string, port int) (string, error) {
	dirFD, err := openSecureRuntimeDir(dir)
	if err != nil {
		return "", err
	}
	defer unix.Close(dirFD)

	baseName := relayTokenFileName(port)
	fullPath := filepath.Join(dir, baseName)
	fd, err := unix.Openat(dirFD, baseName, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return "", fmt.Errorf("open relay token file %s: %w", fullPath, err)
	}
	defer unix.Close(fd)

	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return "", fmt.Errorf("stat relay token file %s: %w", fullPath, err)
	}
	if (uint32(st.Mode) & uint32(unix.S_IFMT)) != uint32(unix.S_IFREG) {
		return "", fmt.Errorf("relay token file %s is not a regular file", fullPath)
	}
	uid := uint32(os.Getuid())
	if st.Uid != uid {
		return "", fmt.Errorf("relay token file %s is owned by uid %d, want %d", fullPath, st.Uid, uid)
	}
	if perm := uint32(st.Mode) & 0o777; perm&0o077 != 0 {
		return "", fmt.Errorf("relay token file %s has unsafe mode %04o (want 0600)", fullPath, perm)
	}

	var buf [512]byte
	total := 0
	for total < len(buf) {
		n, rerr := unix.Read(fd, buf[total:])
		if n > 0 {
			total += n
		}
		if rerr == unix.EINTR {
			continue
		}
		if rerr != nil {
			return "", fmt.Errorf("read relay token file %s: %w", fullPath, rerr)
		}
		if n == 0 {
			break
		}
	}
	tok := strings.TrimSpace(string(buf[:total]))
	if tok == "" {
		return "", fmt.Errorf("relay token file %s is empty", fullPath)
	}
	return tok, nil
}

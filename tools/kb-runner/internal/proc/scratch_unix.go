//go:build darwin || linux

package proc

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/kb-labs/clikit/diag"
	"golang.org/x/sys/unix"
)

const (
	scratchSocketPathMax = 104
	scratchSocketNameLen = 40
	runTokenFileName     = ".run-token"
)

func createRunToken(scratch string) (*os.File, error) {
	file, err := os.OpenFile(filepath.Join(scratch, runTokenFileName), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create run ownership token: %w", err)
	}
	return file, nil
}

func runTokenIdentity(runID string) (fileIdentity, bool, error) {
	scratch, err := runScratchPath(runID)
	if err != nil {
		return fileIdentity{}, false, err
	}
	path := filepath.Join(scratch, runTokenFileName)
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return fileIdentity{}, false, nil
	}
	if err != nil {
		return fileIdentity{}, false, fmt.Errorf("inspect run ownership token: %w", err)
	}
	identity, err := resourceIdentity(path, info)
	if err != nil {
		return fileIdentity{}, false, fmt.Errorf("identify run ownership token: %w", err)
	}
	return identity, true, nil
}

func removeRunToken(runID string) error {
	scratch, err := runScratchPath(runID)
	if err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(scratch, runTokenFileName)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove run ownership token: %w", err)
	}
	return nil
}

func runScratchPath(runID string) (string, error) {
	root, err := scratchRoot()
	if err != nil {
		return "", err
	}
	return scratchPathAtRoot(root, runID)
}

func scratchPathAtRoot(root, runID string) (string, error) {
	scratch := filepath.Join(root, "kbr-"+runID)
	probe := filepath.Join(scratch, strings.Repeat("x", scratchSocketNameLen))
	pathBytes := len([]byte(probe)) + 1
	if pathBytes > scratchSocketPathMax {
		return "", diag.New(
			"KB_RUNTIME_RUN_SCRATCH_PATH_TOO_LONG",
			"The run scratch path cannot support the required Unix socket name.",
			diag.WithReason(fmt.Sprintf("the inspected scratch root %q requires %d bytes including the terminator, above the %d-byte socket path limit", root, pathBytes, scratchSocketPathMax)),
			diag.WithMeta(map[string]any{"root": root, "socketNameBytes": scratchSocketNameLen, "pathBytes": pathBytes, "maxBytes": scratchSocketPathMax}),
		)
	}
	return scratch, nil
}

// scratchDirectoryOps is the syscall boundary for creating an owned directory.
// Every implementation must preserve descriptor-relative, non-recursive removal.
type scratchDirectoryOps interface {
	Mkdirat(dirfd int, path string, mode uint32) error
	Openat(dirfd int, path string, flags int, mode uint32) (int, error)
	Fstat(fd int, stat *unix.Stat_t) error
	Fstatat(dirfd int, path string, stat *unix.Stat_t, flags int) error
}

type unixScratchDirectoryOps struct{}

func (unixScratchDirectoryOps) Mkdirat(dirfd int, path string, mode uint32) error {
	return unix.Mkdirat(dirfd, path, mode)
}

func (unixScratchDirectoryOps) Openat(dirfd int, path string, flags int, mode uint32) (int, error) {
	return unix.Openat(dirfd, path, flags, mode)
}

func (unixScratchDirectoryOps) Fstat(fd int, stat *unix.Stat_t) error {
	return unix.Fstat(fd, stat)
}

func (unixScratchDirectoryOps) Fstatat(dirfd int, path string, stat *unix.Stat_t, flags int) error {
	return unix.Fstatat(dirfd, path, stat, flags)
}

func createOwnedDirectory(path string, ops scratchDirectoryOps) (identity fileIdentity, owned bool, result error) {
	parent := filepath.Dir(path)
	name := filepath.Base(path)
	parentFD, err := unix.Open(parent, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return fileIdentity{}, false, fmt.Errorf("open directory parent %q: %w", parent, err)
	}
	defer func() { result = errors.Join(result, unix.Close(parentFD)) }()
	if err := ops.Mkdirat(parentFD, name, 0o700); err != nil {
		return fileIdentity{}, false, err
	}
	directoryFD, err := ops.Openat(parentFD, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return fileIdentity{}, false, errors.Join(fmt.Errorf("open newly created directory %q without following symlinks: %w", path, err), removeUncapturedDirectory(parentFD, name, path, err))
	}
	defer func() { result = errors.Join(result, unix.Close(directoryFD)) }()
	var opened unix.Stat_t
	if err := ops.Fstat(directoryFD, &opened); err != nil {
		return fileIdentity{}, false, errors.Join(fmt.Errorf("verify newly created directory %q: %w", path, err), removeUncapturedDirectory(parentFD, name, path, err))
	}
	identity = fileIdentity{Device: uint64(opened.Dev), Inode: opened.Ino}
	owned = true
	var current unix.Stat_t
	if err := ops.Fstatat(parentFD, name, &current, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return identity, true, fmt.Errorf("verify created directory path %q: %w", path, err)
	}
	if current.Mode&unix.S_IFMT != unix.S_IFDIR || current.Dev != opened.Dev || current.Ino != opened.Ino {
		return identity, true, fmt.Errorf("newly created directory %q changed device or inode during identity capture", path)
	}
	return identity, true, nil
}

func removeUncapturedDirectory(parentFD int, name, path string, creationErr error) error {
	removeErr := unix.Unlinkat(parentFD, name, unix.AT_REMOVEDIR)
	if removeErr == nil {
		return nil
	}
	diagnostic := diag.New(
		"KB_RUNTIME_RUN_SCRATCH_CREATE_REFUSED",
		"The run scratch directory could not be safely created.",
		diag.WithCauseAndReason(fmt.Sprintf("leftover path %q was not removed after %v because directory removal was refused: %v", path, creationErr, removeErr)),
		diag.WithMeta(map[string]any{"path": path, "creationError": creationErr.Error(), "removalError": removeErr.Error()}),
	)
	return errors.Join(diagnostic, removeErr)
}

func inspectCreatedScratch(stateDir, path string, expected fileIdentity) error {
	info, err := os.Lstat(path)
	if err != nil {
		return cleanupScratchAfterCreationFailure(stateDir, path, expected, fmt.Errorf("inspect created scratch %q: %w", path, err))
	}
	return inspectCreatedScratchInfo(stateDir, path, expected, info)
}

func inspectCreatedScratchInfo(stateDir, path string, expected fileIdentity, info os.FileInfo) error {
	actual, err := resourceIdentity(path, info)
	if err != nil {
		return cleanupScratchAfterCreationFailure(stateDir, path, expected, fmt.Errorf("identify created scratch %q: %w", path, err))
	}
	if actual != expected {
		return cleanupScratchAfterCreationFailure(stateDir, path, expected, &OwnedPathRefusalError{Reason: "path device/inode changed before scratch registration"})
	}
	return nil
}

func cleanupScratchAfterCreationFailure(stateDir, path string, expected fileIdentity, cause error) error {
	cleanupErr := removeScratchPathRelative(stateDir, path, expected, nil)
	if errors.Is(cleanupErr, errOwnedPathAlreadyGone) {
		cleanupErr = nil
	}
	return errors.Join(cause, cleanupErr)
}

func scratchRoot() (string, error) {
	root, err := filepath.EvalSymlinks("/tmp")
	if err != nil {
		return "", fmt.Errorf("resolve short run scratch root /tmp: %w", err)
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("make short run scratch root absolute: %w", err)
	}
	info, err := os.Lstat(root)
	if err != nil {
		return "", fmt.Errorf("inspect short run scratch root %q: %w", root, err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("short run scratch root %q is not a real directory; repair /tmp and retry", root)
	}
	return filepath.Clean(root), nil
}

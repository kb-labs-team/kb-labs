//go:build darwin || linux

package proc

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
	"golang.org/x/sys/unix"
)

func TestScratchPathBudgetRefusesLongSystemRoot(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), strings.Repeat("long-system-temp-root-", 5))
	path, err := scratchPathAtRoot(root, strings.Repeat("a", 32))
	var diagnostic *diag.Diag
	if !errors.As(err, &diagnostic) {
		t.Fatalf("scratch path error = %v, want path budget refusal", err)
	}
	if path != "" {
		t.Fatalf("scratch path = %q, want no fallback path", path)
	}
	if diagnostic.Code != "KB_RUNTIME_RUN_SCRATCH_PATH_TOO_LONG" {
		t.Fatalf("scratch path diagnostic code = %q", diagnostic.Code)
	}
	envelope, err := diag.ToEnvelope(diagnostic)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(envelope.Hint, root) || !strings.Contains(envelope.Hint, "104 bytes") || !strings.Contains(envelope.Hint, "realpath /tmp") {
		t.Fatalf("path budget hint = %q, want inspected root, real limit, and next command", envelope.Hint)
	}
}

func TestCreateOwnedDirectoryCapturesCreatedIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "owned")
	identity, owned, err := createOwnedDirectory(path, unixScratchDirectoryOps{})
	if err != nil {
		t.Fatal(err)
	}
	if !owned {
		t.Fatal("newly created directory identity was not owned")
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	actual, err := resourceIdentity(path, info)
	if err != nil {
		t.Fatal(err)
	}
	if actual != identity {
		t.Fatalf("captured directory identity = %+v, lstat identity = %+v", identity, actual)
	}
}

func TestCreateOwnedDirectoryOpenFailureRemovesCreatedName(t *testing.T) {
	if os.Getenv("KB_TEST_SCRATCH_OPEN_FAILURE") == "1" {
		path := os.Getenv("KB_TEST_SCRATCH_PATH")
		var limit unix.Rlimit
		if err := unix.Getrlimit(unix.RLIMIT_NOFILE, &limit); err != nil {
			t.Fatal(err)
		}
		limit.Cur = 128
		if limit.Max < limit.Cur {
			limit.Cur = limit.Max
		}
		if err := unix.Setrlimit(unix.RLIMIT_NOFILE, &limit); err != nil {
			t.Fatal(err)
		}
		var descriptors []int
		for {
			fd, err := unix.Open("/dev/null", unix.O_RDONLY|unix.O_CLOEXEC, 0)
			if err != nil {
				if err != unix.EMFILE {
					t.Fatalf("fill descriptors: %v", err)
				}
				break
			}
			descriptors = append(descriptors, fd)
		}
		if len(descriptors) == 0 {
			t.Fatal("could not reserve a descriptor slot for the parent directory")
		}
		if err := unix.Close(descriptors[len(descriptors)-1]); err != nil {
			t.Fatal(err)
		}
		identity, owned, err := createOwnedDirectory(path, unixScratchDirectoryOps{})
		if !errors.Is(err, unix.EMFILE) || owned || identity != (fileIdentity{}) {
			t.Fatalf("create under descriptor exhaustion = identity=%+v owned=%t err=%v; want EMFILE without captured identity", identity, owned, err)
		}
		var stat unix.Stat_t
		if err := unix.Fstatat(unix.AT_FDCWD, path, &stat, unix.AT_SYMLINK_NOFOLLOW); !errors.Is(err, unix.ENOENT) {
			t.Fatalf("created directory remains after Openat failure: %v", err)
		}
		return
	}
	path := filepath.Join(t.TempDir(), "open-failure")
	command := exec.Command(os.Args[0], "-test.run=^TestCreateOwnedDirectoryOpenFailureRemovesCreatedName$")
	command.Env = append(os.Environ(), "KB_TEST_SCRATCH_OPEN_FAILURE=1", "KB_TEST_SCRATCH_PATH="+path)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("descriptor-exhaustion subprocess: %v\n%s", err, output)
	}
}

func TestCreateOwnedDirectoryRefusesReplacementBeforeIdentityCapture(t *testing.T) {
	parent := t.TempDir()
	path := filepath.Join(parent, "replacement")
	ops := replacingScratchDirectoryOps{replacementPath: path}
	identity, owned, createErr := createOwnedDirectory(path, ops)
	var diagnostic *diag.Diag
	if !errors.As(createErr, &diagnostic) || diagnostic.Code != "KB_RUNTIME_RUN_SCRATCH_CREATE_REFUSED" {
		t.Fatalf("create with replaced name = identity=%+v owned=%t err=%v; want catalogued refusal", identity, owned, createErr)
	}
	if owned || identity != (fileIdentity{}) {
		t.Fatalf("replacement refusal returned unverified ownership: identity=%+v owned=%t", identity, owned)
	}
	envelope, err := diag.ToEnvelope(diagnostic)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(diagnostic.Reason, path) || !strings.Contains(diagnostic.Reason, "directory removal was refused") || !errors.Is(createErr, unix.ENOTDIR) {
		t.Fatalf("replacement refusal reason = %q, error=%v; want exact leftover path and unlink reason", diagnostic.Reason, createErr)
	}
	if !strings.Contains(envelope.Hint, path) || !strings.Contains(envelope.Hint, "ls -ld --") {
		t.Fatalf("replacement refusal hint = %q; want exact path inspection command", envelope.Hint)
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("replacement symlink = %v, %v; want preserved symlink", info, err)
	}
}

func TestCreateOwnedDirectoryFstatFailureRemovesCreatedName(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fstat-failure")
	identity, owned, err := createOwnedDirectory(path, failingFstatScratchDirectoryOps{})
	if !errors.Is(err, unix.EIO) || owned || identity != (fileIdentity{}) {
		t.Fatalf("create with Fstat failure = identity=%+v owned=%t err=%v; want EIO without captured identity", identity, owned, err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("created directory remains after Fstat failure: %v", err)
	}
}

func TestCreatedScratchLstatFailureCleansByCapturedIdentity(t *testing.T) {
	runID, err := newID()
	if err != nil {
		t.Fatal(err)
	}
	path, err := runScratchPath(runID)
	if err != nil {
		t.Fatal(err)
	}
	identity, owned, err := createOwnedDirectory(path, unixScratchDirectoryOps{})
	if err != nil || !owned {
		t.Fatalf("create scratch: identity=%+v owned=%t err=%v", identity, owned, err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(path); err != nil {
			t.Errorf("remove test scratch %s: %v", path, err)
		}
	})
	err = cleanupScratchAfterCreationFailure(t.TempDir(), path, identity, fmt.Errorf("inspect created scratch %q: %w", path, os.ErrPermission))
	if err == nil || !errors.Is(err, os.ErrPermission) {
		t.Fatalf("Lstat failure cleanup error = %v", err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("missing scratch path remains after inspection failure: %v", err)
	}
}

func TestCreatedScratchResourceIdentityFailureCleansByCapturedIdentity(t *testing.T) {
	runID, err := newID()
	if err != nil {
		t.Fatal(err)
	}
	path, err := runScratchPath(runID)
	if err != nil {
		t.Fatal(err)
	}
	identity, owned, err := createOwnedDirectory(path, unixScratchDirectoryOps{})
	if err != nil || !owned {
		t.Fatalf("create scratch: identity=%+v owned=%t err=%v", identity, owned, err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(path); err != nil {
			t.Errorf("remove test scratch %s: %v", path, err)
		}
	})
	if err := inspectCreatedScratchInfo(t.TempDir(), path, identity, invalidIdentityFileInfo{}); err == nil {
		t.Fatal("inspect invalid file identity unexpectedly succeeded")
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("scratch remains after resource identity failure: %v", err)
	}
}

type invalidIdentityFileInfo struct{ os.FileInfo }

func (invalidIdentityFileInfo) Sys() any { return "not a platform stat structure" }

type replacingScratchDirectoryOps struct {
	unixScratchDirectoryOps
	replacementPath string
}

type failingFstatScratchDirectoryOps struct{ unixScratchDirectoryOps }

func (failingFstatScratchDirectoryOps) Fstat(int, *unix.Stat_t) error { return unix.EIO }

func (ops replacingScratchDirectoryOps) Openat(dirfd int, name string, flags int, mode uint32) (int, error) {
	if err := os.Remove(ops.replacementPath); err != nil {
		return -1, err
	}
	if err := os.Symlink("missing-target", ops.replacementPath); err != nil {
		return -1, err
	}
	return -1, unix.EMFILE
}

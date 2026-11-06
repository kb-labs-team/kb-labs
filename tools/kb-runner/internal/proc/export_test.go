//go:build darwin || linux

package proc

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// StartWithHostResourceSource is available only to this package's tests so
// admission can be exercised against deterministic host snapshots.
func StartWithHostResourceSource(ctx context.Context, cfg Config, source HostResourceSource) (*Run, error) {
	return startWithHostResourceSource(ctx, cfg, source)
}

// TestExecutable identifies a test binary built with proc linked in.
type TestExecutable struct {
	path string
}

// BuildProcTestExecutable builds a test binary that imports proc and therefore
// owns keeper dispatch before its test main can run.
func BuildProcTestExecutable(t testing.TB) TestExecutable {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate proc test package")
	}
	executable := filepath.Join(t.TempDir(), "proc-test-helper")
	command := exec.Command("go", "test", "-c", "-o", executable, ".")
	command.Dir = filepath.Dir(source)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build proc-linked test helper: %v\n%s", err, output)
	}
	return TestExecutable{path: executable}
}

// BuildRetainingKeeperForTest builds a test-only keeper that passes its
// readiness descriptor to a child before exiting without a complete handshake.
func BuildRetainingKeeperForTest(t testing.TB) TestExecutable {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate proc test package")
	}
	packageDir := filepath.Dir(source)
	executable := filepath.Join(t.TempDir(), "retainingkeeper")
	command := exec.Command("go", "build", "-o", executable, "./testdata/retainingkeeper")
	command.Dir = packageDir
	for _, item := range os.Environ() {
		if !strings.HasPrefix(item, "GOFLAGS=") {
			command.Env = append(command.Env, item)
		}
	}
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build retained-writer keeper fixture: %v\n%s", err, output)
	}
	return TestExecutable{path: executable}
}

// StartWithExecutableForTest lets external package tests exercise a separately
// built executable whose proc import owns keeper dispatch.
func StartWithExecutableForTest(ctx context.Context, cfg Config, source HostResourceSource, executable TestExecutable) (*Run, error) {
	return startWithExecutable(ctx, cfg, source, executable.path)
}

// PathForTest returns the filesystem path used by replacement-image tests.
func (executable TestExecutable) PathForTest() string {
	return executable.path
}

// RunRecordFile resolves the current durable record through proc's location owner.
func RunRecordFile(stateDir, runID string) (string, error) {
	return recordLocation(stateDir, runID).currentPath()
}

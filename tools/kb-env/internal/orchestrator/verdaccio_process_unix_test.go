//go:build !windows

package orchestrator

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kb-labs/clikit/proc/child"
	"github.com/kb-labs/env/internal/env"
)

func TestStopVerdaccioTerminatesItsProcessTree(t *testing.T) {
	layout := env.Layout{Home: t.TempDir()}
	verdaccioDir := filepath.Join(layout.Home, "verdaccio")
	if err := os.MkdirAll(verdaccioDir, 0o755); err != nil {
		t.Fatal(err)
	}
	pidOutput := filepath.Join(verdaccioDir, "grandchild.pid")
	command := exec.Command("sh", "-c", "sleep 60 & echo $! > \"$1\"; wait", "sh", pidOutput)
	if err := child.Start(command, child.ProcessGroup); err != nil {
		t.Fatal(err)
	}
	pidPath := filepath.Join(verdaccioDir, "verdaccio.pid")
	if err := os.WriteFile(pidPath, []byte(strconv.Itoa(command.Process.Pid)), 0o600); err != nil {
		_ = child.KillTree(command.Process.Pid)
		_ = command.Wait()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = child.KillTree(command.Process.Pid)
		_ = command.Wait()
	})
	var grandchildPID int
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(pidOutput)
		if err == nil {
			grandchildPID, _ = strconv.Atoi(strings.TrimSpace(string(data)))
			if grandchildPID > 0 {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if grandchildPID == 0 {
		t.Fatal("Verdaccio process did not report its grandchild PID")
	}

	StopVerdaccio(layout)
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(grandchildPID, 0); err == syscall.ESRCH {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("Verdaccio stop left grandchild %d alive", grandchildPID)
}

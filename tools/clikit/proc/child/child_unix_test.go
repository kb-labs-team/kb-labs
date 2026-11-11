//go:build darwin || linux

package child

import (
	"bufio"
	"fmt"
	"github.com/kb-labs/clikit/internal/testdeadline"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestStartProcessGroupAndKillTreeKillsGrandchild(t *testing.T) {
	command := exec.Command("sh", "-c", "sleep 60 & echo $!; wait")
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := Start(command, ProcessGroup); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = KillTree(command.Process.Pid)
		_ = command.Wait()
	})
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		_ = KillTree(command.Process.Pid)
		_ = command.Wait()
		t.Fatalf("read grandchild pid: %v", err)
	}
	grandchildPID, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		t.Fatalf("parse grandchild pid %q: %v", line, err)
	}
	if err := KillTree(command.Process.Pid); err != nil {
		t.Fatalf("kill process group: %v", err)
	}
	if err := command.Wait(); err == nil {
		t.Fatal("parent wait succeeded after forced tree termination")
	}
	waitGone(t, grandchildPID)
}

func TestDetachedChildSurvivesLauncherExit(t *testing.T) {
	if os.Getenv("CHILD_DETACHED_HELPER") == "1" {
		command := exec.Command("sleep", "60")
		if err := Start(command, Detached); err != nil {
			t.Fatal(err)
		}
		fmt.Println(command.Process.Pid)
		return
	}
	launcher := exec.Command(os.Args[0], "-test.run=^TestDetachedChildSurvivesLauncherExit$")
	launcher.Env = append(os.Environ(), "CHILD_DETACHED_HELPER=1")
	output, err := launcher.Output()
	if err != nil {
		t.Fatalf("detached launcher: %v", err)
	}
	fields := strings.Fields(string(output))
	if len(fields) == 0 {
		t.Fatalf("detached launcher emitted no pid: %q", output)
	}
	pid, err := strconv.Atoi(fields[0])
	if err != nil {
		t.Fatalf("parse detached pid %q: %v", output, err)
	}
	t.Cleanup(func() { _ = KillTree(pid) })
	if !processExists(pid) {
		t.Fatalf("detached child %d did not survive launcher exit", pid)
	}
	if session, err := unix.Getsid(pid); err != nil || session != pid {
		t.Fatalf("detached child session = %d, err=%v; want its own session", session, err)
	}
}

func processExists(pid int) bool {
	process, err := os.FindProcess(pid)
	return err == nil && process.Signal(syscall.Signal(0)) == nil
}

func waitGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(testdeadline.Budget(t))
	for time.Now().Before(deadline) {
		if !processExists(pid) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("process %d remained after tree termination", pid)
}

//go:build !windows

package host

import (
	"os/exec"
	"testing"
	"time"
)

// A killed child that is not waited for stays a zombie: it must not count as
// a live process, otherwise status reports an unverifiable host instead of a
// dead one.
func TestProcessAliveIgnoresAnUnreapedZombie(t *testing.T) {
	cmd := exec.Command("sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	defer func() { _ = cmd.Wait() }()
	if !processAlive(pid) {
		t.Fatal("running child reported dead")
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for processAlive(pid) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if processAlive(pid) {
		t.Fatal("unreaped zombie reported alive")
	}
}

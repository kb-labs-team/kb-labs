//go:build darwin || linux

package testprocess

import (
	"bufio"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestBufferAllowsConcurrentOutputSnapshot(t *testing.T) {
	var buffer Buffer
	done := make(chan struct{})
	go func() {
		defer close(done)
		for index := 0; index < 1000; index++ {
			_, _ = buffer.Write([]byte("output\n"))
		}
	}()
	for index := 0; index < 1000; index++ {
		_ = buffer.Len()
		_ = buffer.String()
	}
	<-done
	if buffer.Len() == 0 {
		t.Fatal("concurrent output writer produced no bytes")
	}
}

// case: S-261.7
func TestStartKillsDescendantsAfterDirectProcessWasReaped(t *testing.T) {
	var descendantPID int
	t.Cleanup(func() {
		if descendantPID == 0 {
			t.Fatal("test child did not report its descendant PID")
		}
		deadline := time.Now().Add(2 * time.Second)
		for processExists(descendantPID) && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if processExists(descendantPID) {
			t.Errorf("descendant process %d survived process-group cleanup", descendantPID)
		}
	})

	command := exec.Command("sh", "-c", "sleep 60 & echo $!; exit 0")
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := Start(t, command); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		t.Fatalf("read descendant PID: %v", err)
	}
	descendantPID, err = strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		t.Fatalf("parse descendant PID %q: %v", line, err)
	}
	if err := command.Wait(); err != nil {
		t.Fatalf("wait for direct child: %v", err)
	}
	if !processExists(descendantPID) {
		t.Fatalf("descendant process %d exited before cleanup", descendantPID)
	}
}

func processExists(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = process.Signal(syscall.Signal(0))
	return err == nil || !errors.Is(err, os.ErrProcessDone)
}

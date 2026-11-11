package testprocess

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"sync"

	"github.com/kb-labs/clikit/proc/child"
)

type processTest interface {
	Helper()
	Cleanup(func())
	Errorf(format string, args ...any)
}

// Buffer is a synchronized bytes buffer for output copied by exec.Cmd goroutines.
type Buffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *Buffer) Write(value []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(value)
}

func (b *Buffer) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Len()
}

func (b *Buffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

// Start owns a test child process group from the moment it starts until test cleanup.
func Start(t processTest, command *exec.Cmd) error {
	t.Helper()
	if err := child.Start(command, child.ProcessGroup); err != nil {
		return err
	}
	t.Cleanup(func() {
		if err := child.KillTree(command.Process.Pid); err != nil && !errors.Is(err, os.ErrProcessDone) {
			t.Errorf("kill test process group %d: %v", command.Process.Pid, err)
		}
		if command.ProcessState == nil {
			if err := command.Wait(); err != nil {
				var exit *exec.ExitError
				if !errors.As(err, &exit) {
					t.Errorf("wait for test process group %d: %v", command.Process.Pid, err)
				}
			}
		}
	})
	return nil
}

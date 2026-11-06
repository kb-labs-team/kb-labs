// Package testutil contains test helpers for the kb-runner supervisor.
package testutil

import "os/exec"

// WaitAfterPipeRead waits for the goroutine reading a command pipe to finish
// before calling Cmd.Wait, which closes StdoutPipe and StderrPipe.
func WaitAfterPipeRead(command *exec.Cmd, readDone <-chan struct{}) error {
	<-readDone
	return command.Wait()
}

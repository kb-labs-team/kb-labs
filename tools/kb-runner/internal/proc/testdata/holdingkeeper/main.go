package main

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
)

const (
	dispatchEnv   = "KBLABS_INTERNAL_PROC_KEEPER"
	dispatchValue = "start-v1"
	readyEnv      = "KBLABS_CLIPROC_READY_FD"
	reportEnv     = "X288_HOLDING_KEEPER_REPORT"
)

// The fixture keeper spawns a long-lived command, reports its pid through the
// FIFO named by reportEnv, and then never completes the ready handshake.
func main() {
	command.Exit(run())
}

func run() diag.ExitStatus {
	if os.Getenv(dispatchEnv) != dispatchValue || os.Getenv(readyEnv) != "3" {
		return failureStatus()
	}
	spawned := exec.Command("/bin/sleep", "300")
	if err := spawned.Start(); err != nil {
		return failureStatus()
	}
	report, err := os.OpenFile(os.Getenv(reportEnv), os.O_WRONLY, 0)
	if err != nil {
		return failureStatus()
	}
	if _, err := fmt.Fprintln(report, spawned.Process.Pid); err != nil {
		return failureStatus()
	}
	if err := report.Close(); err != nil {
		return failureStatus()
	}
	select {}
}

func failureStatus() diag.ExitStatus {
	return diag.ExitCode(diag.New("KB_RUNTIME_UNEXPECTED", "The holding keeper fixture could not complete its process setup."))
}

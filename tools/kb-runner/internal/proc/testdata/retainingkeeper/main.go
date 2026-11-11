package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"

	"github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
)

const (
	dispatchEnv   = "KBLABS_INTERNAL_PROC_KEEPER"
	dispatchValue = "start-v1"
	readyEnv      = "KBLABS_CLIPROC_READY_FD"
	reportEnv     = "X199_RETAINING_KEEPER_REPORT"
	handshakeEnv  = "X199_RETAINING_KEEPER_HANDSHAKE"
)

type processReport struct {
	KeeperPID  int `json:"keeper_pid"`
	HolderPID  int `json:"holder_pid"`
	ExitStatus int `json:"exit_status"`
}

func main() {
	command.Exit(run())
}

func run() diag.ExitStatus {
	if len(os.Args) == 2 && os.Args[1] == "hold" {
		return hold()
	}
	if os.Getenv(dispatchEnv) != dispatchValue || os.Getenv(readyEnv) != "3" {
		return failureStatus()
	}
	return keeper()
}

func keeper() diag.ExitStatus {
	ready := os.NewFile(3, "proc-ready")
	if ready == nil {
		return failureStatus()
	}
	ackRead, ackWrite, err := os.Pipe()
	if err != nil {
		return failureStatus()
	}
	holdRead, holdWrite, err := os.Pipe()
	if err != nil {
		return failureStatus()
	}
	child := exec.Command(os.Args[0], "hold")
	child.ExtraFiles = []*os.File{ready, ackWrite, holdRead, holdWrite}
	child.Env = []string{}
	if err := child.Start(); err != nil {
		return failureStatus()
	}
	_ = ackWrite.Close()
	_ = holdRead.Close()
	_ = holdWrite.Close()
	var ack [1]byte
	if _, err := io.ReadFull(ackRead, ack[:]); err != nil {
		return failureStatus()
	}
	_ = ackRead.Close()
	release := make(chan os.Signal, 1)
	signal.Notify(release, syscall.SIGUSR1)
	status := diag.ExitCode(diag.New("KB_RUNTIME_INPUT_INVALID", "The retained-writer fixture selected its terminal process outcome."))
	if err := writeReport(processReport{KeeperPID: os.Getpid(), HolderPID: child.Process.Pid, ExitStatus: status.Code()}); err != nil {
		return failureStatus()
	}
	<-release
	if os.Getenv(handshakeEnv) == "partial" {
		_, _ = ready.Write([]byte(`{"record":`))
	}
	return status
}

func hold() diag.ExitStatus {
	readiness := os.NewFile(3, "retained-proc-ready")
	ack := os.NewFile(4, "holder-ready")
	read := os.NewFile(5, "hold-read")
	write := os.NewFile(6, "hold-write")
	if readiness == nil || ack == nil || read == nil || write == nil {
		return failureStatus()
	}
	if _, err := readiness.Stat(); err != nil {
		return failureStatus()
	}
	_, _ = ack.Write([]byte{1})
	_ = ack.Close()
	_, _ = io.Copy(io.Discard, read)
	runtime.KeepAlive(readiness)
	runtime.KeepAlive(write)
	return diag.SuccessStatus()
}

func failureStatus() diag.ExitStatus {
	return diag.ExitCode(diag.New("KB_RUNTIME_UNEXPECTED", "The retained-writer fixture could not complete its process setup."))
}

func writeReport(report processReport) error {
	path := os.Getenv(reportEnv)
	if path == "" {
		return nil
	}
	data, err := json.Marshal(report)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	temporary, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	if _, err := temporary.Write(data); err != nil {
		return errors.Join(err, temporary.Close(), os.Remove(temporaryPath))
	}
	if err := temporary.Close(); err != nil {
		return errors.Join(err, os.Remove(temporaryPath))
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return errors.Join(err, os.Remove(temporaryPath))
	}
	return nil
}

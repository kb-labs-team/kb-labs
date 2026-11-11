package host

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"strings"
	"time"

	"github.com/kb-labs/create/v2/contracts"
)

const ProcessIdentityEnv = "KB_CREATE_PROCESS_IDENTITY"

// ProcessIdentityStatus records whether a live PID's per-launch token was verified.
type ProcessIdentityStatus uint8

const (
	// ProcessIdentityUndetermined means the process is gone or its environment is not readable yet.
	ProcessIdentityUndetermined ProcessIdentityStatus = iota
	// ProcessIdentityMismatch means the readable process environment lacks the recorded token.
	ProcessIdentityMismatch
	// ProcessIdentityMatch means the live process carries the recorded token.
	ProcessIdentityMatch
)

const processIdentityPollInterval = time.Millisecond

var errProcessEnvironmentNotReady = errors.New("process environment is empty or not available yet")

func NewProcessIdentityToken() (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

func currentProcessIdentity() (string, error) {
	token, ok := os.LookupEnv(ProcessIdentityEnv)
	if !ok || token == "" {
		return "", errors.New("process identity token is missing from this process environment")
	}
	return token, nil
}

func ProcessEnvironmentWithIdentity(env []string, token string) []string {
	return append(ProcessEnvironmentWithoutIdentity(env), ProcessIdentityEnv+"="+token)
}

func ProcessEnvironmentWithoutIdentity(env []string) []string {
	result := make([]string, 0, len(env))
	identityPrefix := ProcessIdentityEnv + "="
	controlPrefix := contracts.HostControlCredentialEnv + "="
	for _, entry := range env {
		if !strings.HasPrefix(entry, identityPrefix) && !strings.HasPrefix(entry, controlPrefix) {
			result = append(result, entry)
		}
	}
	return result
}

func processIdentityFromEnvironment(data []byte) (string, error) {
	if len(data) == 0 {
		return "", errProcessEnvironmentNotReady
	}
	if data[len(data)-1] != 0 {
		return "", errProcessEnvironmentNotReady
	}
	prefix := []byte(ProcessIdentityEnv + "=")
	hasEntry := false
	for _, entry := range bytes.Split(data, []byte{0}) {
		if len(entry) == 0 {
			continue
		}
		hasEntry = true
		if bytes.HasPrefix(entry, prefix) {
			token := string(entry[len(prefix):])
			if token != "" {
				return token, nil
			}
		}
	}
	if !hasEntry {
		return "", errProcessEnvironmentNotReady
	}
	return "", nil
}

func processIdentityStatusWithReader(pid int, expected string, readIdentity func(int) (string, error), alive func(int) bool) ProcessIdentityStatus {
	if pid <= 0 || expected == "" || !alive(pid) {
		return ProcessIdentityUndetermined
	}
	actual, err := readIdentity(pid)
	if err != nil {
		return ProcessIdentityUndetermined
	}
	if actual != expected {
		return ProcessIdentityMismatch
	}
	return ProcessIdentityMatch
}

func signalWithProcessIdentity(pid int, expected string, signal func() error) bool {
	return signalWithIdentityReader(pid, expected, ProcessIdentityForPID, processAlive, signal)
}

func signalWithIdentityReader(pid int, expected string, readIdentity func(int) (string, error), alive func(int) bool, signal func() error) bool {
	switch processIdentityStatusWithReader(pid, expected, readIdentity, alive) {
	case ProcessIdentityMatch:
		return signal() == nil
	case ProcessIdentityMismatch:
		return false
	case ProcessIdentityUndetermined:
		return false
	default:
		return false
	}
}

// ProcessIdentityOf checks the token recorded for pid and returns its three-way status.
func ProcessIdentityOf(pid int, expected string) ProcessIdentityStatus {
	return processIdentityStatusWithReader(pid, expected, ProcessIdentityForPID, processAlive)
}

// WaitForProcessIdentityWithReader retries until the caller's startup deadline.
func WaitForProcessIdentityWithReader(pid int, expected string, exited <-chan struct{}, deadlineAt time.Time, readIdentity func(int) (string, error)) ProcessIdentityStatus {
	if readIdentity == nil {
		readIdentity = ProcessIdentityForPID
	}
	deadline := time.NewTimer(time.Until(deadlineAt))
	defer deadline.Stop()
	ticker := time.NewTicker(processIdentityPollInterval)
	defer ticker.Stop()
	return waitForProcessIdentityWith(pid, expected, func(pid int, expected string) ProcessIdentityStatus {
		return processIdentityStatusWithReader(pid, expected, readIdentity, processAlive)
	}, processAlive, func() bool {
		select {
		case <-exited:
			return false
		case <-deadline.C:
			return false
		case <-ticker.C:
			return true
		}
	})
}

// TerminateAndReapLaunchedProcess stops the exact child returned by Start and
// waits for its Wait goroutine to finish. It never resolves or signals a PID.
func TerminateAndReapLaunchedProcess(process *os.Process, exited <-chan struct{}) error {
	if process == nil {
		return errors.New("launched process handle is nil")
	}
	err := process.Kill()
	if err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	<-exited
	return err
}

func waitForProcessIdentityWith(
	pid int,
	expected string,
	identify func(int, string) ProcessIdentityStatus,
	alive func(int) bool,
	waitNext func() bool,
) ProcessIdentityStatus {
	for {
		status := identify(pid, expected)
		if status != ProcessIdentityUndetermined {
			return status
		}
		if !alive(pid) {
			return ProcessIdentityUndetermined
		}
		if !waitNext() {
			return ProcessIdentityUndetermined
		}
	}
}

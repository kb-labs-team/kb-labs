//go:build !windows

package v2cli

import (
	"fmt"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/supervisor"
)

// These tests run the real launcher as the supervisor and a real child process
// as the host, and kill the child the way ENOSPC or the OOM killer would.

func (i installation) hostPID(t *testing.T) int {
	t.Helper()
	status, _, raw := i.run("status", "--json")
	hostStatus, _ := status["host"].(map[string]any)
	pid, _ := hostStatus["pid"].(float64)
	if pid == 0 {
		t.Fatalf("no host pid in status: %s", raw)
	}
	return int(pid)
}

func (i installation) waitNewRunningHost(t *testing.T, previous int) int {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		status, _, _ := i.run("status", "--json")
		if hostStatus, _ := status["host"].(map[string]any); hostStatus != nil {
			if pid, _ := hostStatus["pid"].(float64); int(pid) != previous && int(pid) != 0 && hostStatus["state"] == "running" {
				return int(pid)
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("the supervisor did not replace killed host %d with a running one", previous)
	return 0
}

// waitHostState waits for the want state with the restart budget spent: between
// a death and the supervisor recording it, the last record is still the old one.
func (i installation) waitHostState(t *testing.T, want string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	var last string
	for time.Now().Before(deadline) {
		status, _, raw := i.run("status", "--json")
		last = raw
		if exit, _ := status["hostExit"].(map[string]any); status["hostState"] == want && exit["exhausted"] == true {
			return status
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("status never reported hostState %q: %s", want, last)
	return nil
}

// case: S-296.1
func TestSupervisorRestartsAHostChildThatDiedUnexpectedly(t *testing.T) {
	inst := newInstallation(t)
	if _, code, raw := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start: %s", raw)
	}
	first := inst.hostPID(t)
	if err := syscall.Kill(first, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	second := inst.waitNewRunningHost(t, first)
	doctor, _, raw := inst.run("doctor", "--json")
	if doctor["platform"].(map[string]any)["ok"] != true {
		t.Fatalf("doctor disagrees with status after the restart (pid %d): %s", second, raw)
	}
}

// case: S-296.2, S-296.3, S-296.4
func TestExhaustedRestartBudgetIsOneTruthAcrossStatusDoctorStartAndStop(t *testing.T) {
	inst := newInstallation(t)
	if _, code, raw := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start: %s", raw)
	}
	pid := inst.hostPID(t)
	// Three restarts are allowed; the fourth death exhausts the budget.
	for restart := 0; restart < 3; restart++ {
		if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
			t.Fatal(err)
		}
		pid = inst.waitNewRunningHost(t, pid)
	}
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}

	status := inst.waitHostState(t, "host-exited")
	startCommand := contracts.ShellCommand("kb-create", "start", "--platform-root", inst.root)
	exit, _ := status["hostExit"].(map[string]any)
	if status["running"] != false || exit == nil || exit["exhausted"] != true || exit["cause"] == "" || status["next"] != startCommand {
		t.Fatalf("status of a dead child under a live supervisor: %v", status)
	}
	doctor, _, raw := inst.run("doctor", "--json")
	var hostCheck map[string]any
	for _, item := range doctor["platform"].(map[string]any)["checks"].([]any) {
		if check, _ := item.(map[string]any); check["id"] == "host-process" {
			hostCheck = check
		}
	}
	if hostCheck == nil || hostCheck["ok"] == true || hostCheck["hint"] != fmt.Sprintf("Run `%s`.", startCommand) ||
		!containsText(hostCheck["detail"], exit["cause"]) {
		t.Fatalf("doctor disagrees with status: %s", raw)
	}

	recovered, code, raw := inst.run("start", "--json")
	if code != 0 || errorCodeFromOutput(raw) == contracts.CodeHostAlreadyRunning {
		t.Fatalf("start must recover the dead child, got %d %s", code, raw)
	}
	_ = recovered
	if state, _ := inst.hostState(t); state != "running" {
		t.Fatalf("host after start = %s", state)
	}
	if after, _, _ := inst.run("status", "--json"); after["hostState"] != "running" {
		t.Fatalf("status after recovery: %v", after)
	}

	// stop works from the dead-child state too.
	if err := syscall.Kill(inst.hostPID(t), syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	if _, code, raw := inst.run("stop", "--json"); code != 0 {
		t.Fatalf("stop: %s", raw)
	}
	if state, _ := inst.hostState(t); state != "stopped" {
		t.Fatalf("host after stop = %s", state)
	}
}

func containsText(haystack any, needle any) bool {
	text, _ := haystack.(string)
	part, _ := needle.(string)
	return part != "" && strings.Contains(text, part)
}

// Between a child's death and the supervisor recording it, status must not
// present the previous death as the cause. The supervisor is frozen so the
// window is held open deterministically.
// case: S-296.5
func TestStatusDoesNotShowAnEarlierDeathAsTheCurrentCause(t *testing.T) {
	inst := newInstallation(t)
	if _, code, raw := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start: %s", raw)
	}
	first := inst.hostPID(t)
	if err := syscall.Kill(first, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	second := inst.waitNewRunningHost(t, first)

	state, err := host.StateForRoot(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	record, ok := supervisor.ReadRecord(state)
	if !ok {
		t.Fatal("no supervisor record")
	}
	if err := syscall.Kill(record.PID, syscall.SIGSTOP); err != nil {
		t.Fatal(err)
	}
	resumed := false
	resume := func() {
		if !resumed {
			resumed = true
			_ = syscall.Kill(record.PID, syscall.SIGCONT)
		}
	}
	defer resume()
	if err := syscall.Kill(second, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(15 * time.Second)
	var status map[string]any
	for time.Now().Before(deadline) {
		status, _, _ = inst.run("status", "--json")
		if status["hostState"] == "host-exited" {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if status["hostState"] != "host-exited" {
		t.Fatalf("status never saw the dead child: %v", status)
	}
	if exit, present := status["hostExit"]; present && exit != nil {
		t.Fatalf("status shows the earlier death as the cause of this one: %v", exit)
	}
	resume()
	inst.waitNewRunningHost(t, second)
}

package proc

import (
	"github.com/kb-labs/kb-runner/internal/testdeadline"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestLinuxProcessStatesTreatZombieAndDeadAsNotLive(t *testing.T) {
	for _, test := range []struct {
		state byte
		want  bool
	}{{'R', true}, {'S', true}, {'Z', false}, {'X', false}} {
		if got := processStateIsLive(test.state); got != test.want {
			t.Errorf("state %q live=%t, want %t", test.state, got, test.want)
		}
	}
}

func TestParseProcStatUsesFinalCommDelimiter(t *testing.T) {
	data := "42 (name ) (with ) delimiters) S 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 987654 4096 42\n"
	got, err := parseProcStat(data)
	if err != nil {
		t.Fatal(err)
	}
	if got.PID != 42 || got.Comm != "name ) (with ) delimiters" || got.State != 'S' || got.PPID != 7 || got.ProcessGroupID != 8 || got.StartTicks != 987654 || got.UserTicks != 17 || got.SystemTicks != 18 || got.ResidentPages != 42 || got.Identity == "" {
		t.Fatalf("parsed stat = %+v", got)
	}
}

// The kernel prints -1 for the process group and session of a task that is
// exiting (its signal handler is gone); a fork/exec/exit storm hits this on
// Linux. Such a task is not live and must not fail the whole table snapshot.
func TestParseProcStatAcceptsExitingTaskWithUnavailableGroupAndSession(t *testing.T) {
	data := "42 (storm) S 0 -1 -1 0 -1 4194560 1 2 3 4 5 6 7 8 20 0 1 0 987654 4096 42\n"
	got, err := parseProcStat(data)
	if err != nil {
		t.Fatalf("exiting task stat must parse: %v", err)
	}
	if got.live() {
		t.Fatalf("exiting task reported live: %+v", got)
	}
	live := "42 (storm) S 1 8 8 0 -1 4194560 1 2 3 4 5 6 7 8 20 0 1 0 987654 4096 42\n"
	if row, err := parseProcStat(live); err != nil || !row.live() {
		t.Fatalf("ordinary task: live=%t err=%v", row.live(), err)
	}
	if _, err := parseProcStat("42 (x) S 1 -1 8 0 -1 4194560 1 2 3 4 5 6 7 8 20 0 1 0 987654 4096 42\n"); err == nil {
		t.Fatal("a row with only one of group/session unavailable must stay rejected")
	}
	if _, err := parseProcStat("42 (x) S 1 -2 8 0 -1 4194560 1 2 3 4 5 6 7 8 20 0 1 0 987654 4096 42\n"); err == nil {
		t.Fatal("process group below -1 must stay rejected")
	}
}

func TestParseProcBootTimeAndStartTicks(t *testing.T) {
	boot, err := parseProcBootTime("cpu 1 2 3 4\nbtime 1700000000\nprocesses 9\n")
	if err != nil {
		t.Fatal(err)
	}
	got := procStartTime(boot, 1250, 250)
	want := time.Unix(1700000005, 0)
	if !got.Equal(want) {
		t.Fatalf("start time = %s, want %s", got, want)
	}
}

func TestProcessStartBoundUsesKernelTickUnits(t *testing.T) {
	boot := time.Unix(1700000000, 0)
	bound := processStartBoundFromTicks(boot, 329, 100)
	sameTickProcess := procStartTime(boot, 329, 100)
	laterProcess := procStartTime(boot, 330, 100)
	if !bound.Equal(sameTickProcess) || laterProcess.Before(bound) {
		t.Fatalf("run start bound=%s same-tick=%s next-tick=%s; bound must share /proc start-tick units and include same-tick children", bound, sameTickProcess, laterProcess)
	}
}

// case: S-237.3
func TestRealChildSnapshotHasStableIdentityAndWallStart(t *testing.T) {
	before := time.Now()
	cmd := exec.Command("/bin/sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	deadline := time.Now().Add(testdeadline.Budget(t))
	var snapshots []Process
	var err error
	for time.Now().Before(deadline) {
		snapshots, err = ProcessTree(os.Getpid(), "")
		if processByPID(snapshots, cmd.Process.Pid) != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	first := processByPID(snapshots, cmd.Process.Pid)
	if first == nil {
		t.Fatalf("child snapshot = %+v", snapshots)
	}
	if err != nil {
		t.Logf("snapshot retained a partial table and reported an unrelated observation gap: %v", err)
	}
	if first.Identity == "" || first.ElapsedMS < 0 || first.StartedAt.Before(before.Add(-time.Second)) || first.StartedAt.After(time.Now().Add(time.Second)) {
		t.Fatalf("invalid child identity/time: %+v, started after %s", *first, before)
	}
	time.Sleep(20 * time.Millisecond)
	again, err := ProcessTree(os.Getpid(), "")
	second := processByPID(again, cmd.Process.Pid)
	if second == nil || second.Identity != first.Identity {
		t.Fatalf("identity changed across snapshots: first=%+v second=%+v error=%v", *first, again, err)
	}
	if err != nil {
		t.Logf("second snapshot retained the child and reported an unrelated observation gap: %v", err)
	}
}

func processByPID(processes []Process, pid int) *Process {
	for i := range processes {
		if processes[i].PID == pid {
			return &processes[i]
		}
	}
	return nil
}

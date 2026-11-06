//go:build darwin

package proc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"github.com/kb-labs/kb-runner/internal/testdeadline"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

type directChildSignalFixture struct {
	pidSignals    []int
	handleSignals []*os.Process
}

func (directChildSignalFixture) Snapshot(string) ([]Process, error) { return nil, nil }
func (directChildSignalFixture) Identity(int) (string, bool, error) {
	return "direct-child-start", true, nil
}
func (source *directChildSignalFixture) Signal(pid int, _ string, _ syscall.Signal) error {
	source.pidSignals = append(source.pidSignals, pid)
	return nil
}
func (source *directChildSignalFixture) SignalDirectChild(process *os.Process, _ string, _ syscall.Signal) error {
	source.handleSignals = append(source.handleSignals, process)
	return nil
}

func TestCleanupRoutesDirectChildThroughUnreapedProcessHandle(t *testing.T) {
	directChild := &os.Process{Pid: 41001}
	source := &directChildSignalFixture{}
	process := Process{PID: directChild.Pid, Identity: "direct-child-start"}
	if err := signalCleanupTarget(source, directChild, process, syscall.SIGTERM); err != nil {
		t.Fatalf("signal direct child: %v", err)
	}
	if len(source.pidSignals) != 0 {
		t.Fatalf("direct child PID signals = %v, want none", source.pidSignals)
	}
	if len(source.handleSignals) != 1 || source.handleSignals[0] != directChild {
		t.Fatalf("direct child handle signals = %v, want the retained process handle", source.handleSignals)
	}
}

func contextForTestLifetime(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return ctx
}

// case: S-237.21
func TestProcargs2ArgumentsPreserveOSArgumentBoundaries(t *testing.T) {
	want := []string{"/tmp/fixture", "unbalanced'quote", "", "first-line\nsecond-line", "one argument with spaces"}
	for padding := 0; padding <= 7; padding++ {
		t.Run("padding-"+strconv.Itoa(padding), func(t *testing.T) {
			data, environment := procargs2Fixture(want, padding, true)
			got, position, err := parseProcargs2(data)
			if err != nil {
				t.Fatalf("parse procargs2 argv: %v", err)
			}
			if !equalArguments(got, want) {
				t.Fatalf("procargs2 argv = %#v, want %#v", got, want)
			}
			if !bytes.Equal(data[position:], environment) {
				t.Fatalf("environment boundary at %d = %q, want %q", position, data[position:], environment)
			}
			if !procargs2HasEnvironment(data) {
				t.Fatal("parser did not detect environment after argv")
			}

			withoutEnvironment, _ := procargs2Fixture(want, padding, false)
			if procargs2HasEnvironment(withoutEnvironment) {
				t.Fatal("parser reported an environment when none followed argv")
			}
		})
	}
}

func procargs2Fixture(argv []string, padding int, includeEnvironment bool) ([]byte, []byte) {
	data := make([]byte, 4)
	binary.NativeEndian.PutUint32(data, uint32(len(argv)))
	data = append(data, []byte("/tmp/fixture")...)
	data = append(data, 0)
	data = append(data, bytes.Repeat([]byte{0}, padding)...)
	for _, argument := range argv {
		data = append(data, []byte(argument)...)
		data = append(data, 0)
	}
	var environment []byte
	if includeEnvironment {
		environment = []byte("X53_PROCARGS_FIXTURE=present\x00")
		data = append(data, environment...)
	}
	return data, environment
}

// case: S-237.7
func TestDarwinRunTokenFDInspectionFindsApplePlatformBinary(t *testing.T) {
	token, err := os.CreateTemp(t.TempDir(), "run-token-")
	if err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	stat, err := token.Stat()
	if err != nil {
		t.Fatal(err)
	}
	statInfo, ok := stat.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatalf("run token stat type = %T", stat.Sys())
	}
	identity := fileIdentity{Device: uint64(statInfo.Dev), Inode: uint64(statInfo.Ino)}

	child := exec.Command("/bin/sleep", "30")
	child.Env = append(os.Environ(), runEnv+"=darwin-token-probe")
	child.ExtraFiles = []*os.File{token}
	child.Stdout, child.Stderr = io.Discard, io.Discard
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = child.Process.Kill()
		_ = child.Wait()
	})
	processInfo, err := unix.SysctlKinfoProc("kern.proc.pid", child.Process.Pid)
	if err != nil {
		t.Fatalf("inspect same-UID /bin/sleep identity: %v", err)
	}
	if uint32(processInfo.Eproc.Ucred.Uid) != uint32(os.Getuid()) {
		t.Fatalf("/bin/sleep UID = %d, want test UID %d", processInfo.Eproc.Ucred.Uid, os.Getuid())
	}
	arguments, err := unix.SysctlRaw("kern.procargs2", child.Process.Pid)
	if err != nil {
		t.Fatalf("inspect same-UID /bin/sleep procargs2: %v", err)
	}
	_, envOffset, err := parseProcargs2(arguments)
	if err != nil {
		t.Fatalf("parse same-UID /bin/sleep procargs2: %v", err)
	}
	if marker := processMarkerValue(arguments[envOffset:]); marker != "" {
		t.Fatalf("platform binary exposed run marker %q; the test requires the hidden-environment case", marker)
	}
	matched, err := processHasRunTokenDescriptor(child.Process.Pid, identity)
	if err != nil {
		t.Fatalf("inspect inherited run-token descriptor for same-UID /bin/sleep: %v", err)
	}
	if !matched {
		t.Fatal("libproc did not find the inherited run-token vnode on /bin/sleep")
	}
}

// Requires real kern.procargs2 process-table access; run outside the restricted sandbox.
// case: S-237.21
func TestDarwinProcargs2ReadsLiveChildArguments(t *testing.T) {
	if os.Getenv("X53_PROCARGS2_CHILD") == "1" {
		if _, err := io.Copy(io.Discard, os.Stdin); err != nil {
			t.Fatalf("wait for parent to release procargs2 child: %v", err)
		}
		return
	}

	childTest := "^TestDarwinProcargs2ReadsLiveChildArguments$"
	want := []string{os.Args[0], "-test.run=" + childTest, "--", "unbalanced'quote", "first-line\nsecond-line", "one argument with spaces", ""}
	child := exec.Command(want[0], want[1:]...)
	childInput, err := child.StdinPipe()
	if err != nil {
		t.Fatalf("create test-owned procargs2 child input: %v", err)
	}
	child.Env = append(os.Environ(), "X53_PROCARGS2_CHILD=1", "X53_PROCARGS2_ENV_BOUNDARY=visible")
	if err := child.Start(); err != nil {
		t.Fatalf("start test-owned procargs2 child: %v", err)
	}
	t.Cleanup(func() {
		if err := childInput.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
			t.Errorf("close test-owned procargs2 child input: %v", err)
		}
		if err := child.Wait(); err != nil {
			t.Errorf("wait for test-owned procargs2 child: %v", err)
		}
	})

	raw, err := unix.SysctlRaw("kern.procargs2", child.Process.Pid)
	if err != nil {
		t.Fatalf("read test-owned child kern.procargs2 bytes: %v", err)
	}
	got, environmentStart, err := parseProcargs2(raw)
	if err != nil {
		t.Fatalf("parse live child kern.procargs2 bytes: %v", err)
	}
	if !equalArguments(got, want) {
		t.Fatalf("live kern.procargs2 argv = %#v, want exact child argv %#v", got, want)
	}
	if !bytes.Contains(raw[environmentStart:], []byte("X53_PROCARGS2_ENV_BOUNDARY=visible")) {
		t.Fatalf("environment boundary %d does not contain the child's test environment", environmentStart)
	}
	if !procargs2HasEnvironment(raw) {
		t.Fatal("live procargs2 parser did not detect child environment")
	}
}

// Requires kern.procargs2 access; verifies exec can replace environment while PID/start identity stays stable.
// case: S-237.21
func TestDarwinExecCanReplaceMarkerWithinOneProcessIdentity(t *testing.T) {
	if os.Getenv("X53_EXEC_MARKER_HELPER") == "1" {
		if os.Getenv("X53_EXEC_MARKER_IMAGE") == "1" {
			fmt.Fprintf(os.Stdout, "exec-ready %d %s\n", os.Getpid(), os.Getenv("KBLABS_CLIPROC_RUN"))
			if _, err := bufio.NewReader(os.Stdin).ReadString('\n'); err != nil {
				t.Fatalf("wait after exec: %v", err)
			}
			return
		}
		fmt.Fprintln(os.Stdout, os.Getpid())
		if _, err := bufio.NewReader(os.Stdin).ReadString('\n'); err != nil {
			t.Fatalf("wait before exec: %v", err)
		}
		if err := syscall.Exec(os.Args[0], []string{os.Args[0], "-test.run=^TestDarwinExecCanReplaceMarkerWithinOneProcessIdentity$"}, []string{
			"PATH=/usr/bin:/bin", "X53_EXEC_MARKER_HELPER=1", "X53_EXEC_MARKER_IMAGE=1", "KBLABS_CLIPROC_RUN=exec-marker",
		}); err != nil {
			t.Fatalf("exec replacement environment: %v", err)
		}
		return
	}
	command := exec.Command(os.Args[0], "-test.run=^TestDarwinExecCanReplaceMarkerWithinOneProcessIdentity$")
	command.Env = append(os.Environ(), "X53_EXEC_MARKER_HELPER=1", "KBLABS_CLIPROC_RUN=before-exec")
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = input.Close()
		if command.Process != nil && command.ProcessState == nil {
			_ = command.Process.Kill()
		}
		_ = command.Wait()
	})
	line, err := bufio.NewReader(output).ReadString('\n')
	if err != nil {
		t.Fatalf("read test child PID: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		t.Fatalf("parse test child PID %q: %v", line, err)
	}
	before, alive, err := ProcessIdentity(pid)
	if err != nil || !alive {
		t.Fatalf("inspect pre-exec identity: alive=%v err=%v", alive, err)
	}
	if _, err := io.WriteString(input, "go\n"); err != nil {
		t.Fatal(err)
	}
	execLine, err := bufio.NewReader(output).ReadString('\n')
	if err != nil {
		t.Fatalf("read post-exec environment acknowledgment: %v", err)
	}
	if want := fmt.Sprintf("exec-ready %d exec-marker\n", pid); execLine != want {
		t.Fatalf("post-exec child acknowledgment = %q, want %q", execLine, want)
	}
	deadline := time.Now().Add(testdeadline.Budget(t))
	var lastMarker string
	var lastUnverified bool
	var lastMarkerErr error
	for {
		marker, unverified, markerErr := inspectProcessMarker(pid)
		lastMarker, lastUnverified, lastMarkerErr = marker, unverified, markerErr
		if markerErr == nil && marker == "exec-marker" {
			break
		}
		if time.Now().After(deadline) {
			raw, rawErr := unix.SysctlRaw("kern.procargs2", pid)
			t.Fatalf("exec marker not visible in kern.procargs2: marker=%q unverified=%t err=%v raw_contains_marker=%t raw_len=%d raw_err=%v", lastMarker, lastUnverified, lastMarkerErr, bytes.Contains(raw, []byte("exec-marker")), len(raw), rawErr)
		}
		time.Sleep(10 * time.Millisecond)
	}
	after, alive, err := ProcessIdentity(pid)
	if err != nil || !alive || after != before {
		t.Fatalf("exec changed process identity: before=%q after=%q alive=%v err=%v", before, after, alive, err)
	}
}

func equalArguments(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}

// case: S-237.13
func TestDarwinCommandNameStopsAtNULInKinfoRecord(t *testing.T) {
	var info unix.KinfoProc
	copy(info.Proc.P_comm[:], []byte{'s', 'l', 'e', 'e', 'p', 0, ' ', 'e', 'l', 'p', 'e', 'r'})
	if got := darwinCommandName(info.Proc.P_comm[:]); got != "sleep" {
		t.Fatalf("kinfo P_comm decoded as %q, want the bytes before its first NUL", got)
	}
}

func TestDarwinCommandNameParsesLiveKinfoRecord(t *testing.T) {
	info, err := unix.SysctlKinfoProc("kern.proc.pid", os.Getpid())
	if err != nil {
		t.Fatalf("read own kern.proc record: %v", err)
	}
	comm := info.Proc.P_comm[:]
	end := bytes.IndexByte(comm, 0)
	if end < 0 {
		t.Fatalf("own kinfo P_comm has no NUL terminator: %q", comm)
	}
	if got, want := darwinCommandName(comm), string(comm[:end]); got != want {
		t.Fatalf("live kinfo P_comm decoded as %q, want %q", got, want)
	}
}

// Requires process-table access to measure another process; run outside the restricted sandbox.
// case: S-237.68
func TestIdleKeeperCPUStaysBelowOnePercent(t *testing.T) {
	state := t.TempDir()
	helper := filepath.Join(t.TempDir(), "proc-helper")
	build := exec.Command("go", "build", "-o", helper, "./testhelper")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build proc helper: %v\n%s", err, output)
	}
	run, err := StartWithHostResourceSource(contextForTestLifetime(t), Config{StateDir: state, Tag: "idle-keeper-cpu", Stall: time.Hour,
		StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
		Command: []string{"/bin/sleep", "30"},
	}, fakeHostResourceSource{sample: HostResourceSnapshot{
		PhysicalMemory: 1 << 40, AvailableMemory: 1 << 40, MemoryAvailableKnown: true,
		LogicalCPUs: 8, Pressure: "normal", PressureAvailable: true, LoadAvailable: true,
	}})
	if err != nil {
		t.Fatal(err)
	}
	rec, err := readAdmissionRecord(state, run.RunID)
	if err != nil {
		t.Fatalf("read keeper record: %v", err)
	}
	if RecordedKeeperPID(rec.PID) != run.PID || rec.StartedAt != run.StartedAt {
		t.Fatalf("run handle does not identify keeper: run=(pid %d identity %q) record=(pid %d identity %q)", run.PID, run.StartedAt, rec.PID, rec.StartedAt)
	}
	t.Cleanup(func() {
		if err := run.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			t.Errorf("stop idle keeper: %v", err)
		}
		if err := run.Wait(); err != nil {
			t.Logf("wait for stopped idle keeper: %v", err)
		}
	})
	keeperProcess := func() Process {
		t.Helper()
		snapshot, err := darwinProcessSnapshot(run.RunID)
		if err != nil {
			t.Fatalf("snapshot keeper process: %v", err)
		}
		var keeper *Process
		for index := range snapshot {
			if snapshot[index].PID == rec.PID && snapshot[index].Identity == rec.StartedAt {
				keeper = &snapshot[index]
				break
			}
		}
		if keeper == nil {
			t.Fatalf("keeper PID %d identity %q absent from process table", rec.PID, rec.StartedAt)
		}
		processes, err := darwinProcessMetrics([]Process{*keeper})
		if err != nil {
			t.Fatalf("measure keeper CPU with proc_pid_rusage: %v", err)
		}
		if len(processes) != 1 || !processes[0].MetricsAvailable || processes[0].PID != rec.PID || processes[0].Identity != rec.StartedAt {
			t.Fatalf("keeper resource metrics unavailable: %+v", processes)
		}
		return processes[0]
	}
	start := keeperProcess()
	time.Sleep(10 * time.Second)
	end := keeperProcess()
	cpu := end.CPUSeconds - start.CPUSeconds
	t.Logf("idle keeper CPU over ten seconds: %.3fs (pid=%d identity=%q command=%q)", cpu, end.PID, end.Identity, end.Command)
	if cpu >= 0.1 {
		t.Fatalf("idle keeper used %.3fs CPU over ten seconds; want under 0.100s (1%%)", cpu)
	}
}

// case: S-237.147
func TestDarwinMetricsTreatsReapedProcessAsUnavailable(t *testing.T) {
	child := exec.Command("/bin/sleep", "30")
	child.Stdout, child.Stderr = io.Discard, io.Discard
	if err := child.Start(); err != nil {
		t.Fatalf("start short-lived metrics child: %v", err)
	}
	reaped := false
	t.Cleanup(func() {
		if reaped {
			return
		}
		if err := child.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			t.Errorf("terminate metrics child during cleanup: %v", err)
		}
		if err := child.Wait(); err != nil {
			var exitErr *exec.ExitError
			status, ok := syscall.WaitStatus(0), false
			if errors.As(err, &exitErr) {
				status, ok = exitErr.Sys().(syscall.WaitStatus)
			}
			if !ok || status.Signal() != syscall.SIGKILL {
				t.Errorf("reap metrics child during cleanup: %v", err)
			}
		}
		reaped = true
	})

	snapshot, err := darwinProcessSnapshot("")
	if err != nil {
		t.Fatalf("capture process tree before child exit: %v", err)
	}
	var stale Process
	found := false
	for _, process := range snapshot {
		if process.PID == child.Process.Pid {
			stale, found = process, true
			break
		}
	}
	if !found {
		t.Fatalf("child PID %d was absent from captured process tree", child.Process.Pid)
	}
	if err := child.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		t.Fatalf("terminate metrics child: %v", err)
	}
	waitErr := child.Wait()
	reaped = true
	if waitErr != nil {
		var exitErr *exec.ExitError
		status, ok := syscall.WaitStatus(0), false
		if errors.As(waitErr, &exitErr) {
			status, ok = exitErr.Sys().(syscall.WaitStatus)
		}
		if !ok || status.Signal() != syscall.SIGKILL {
			t.Fatalf("reap metrics child after SIGKILL: %v", waitErr)
		}
	}

	measured, err := (osProcessSource{}).Metrics([]Process{stale})
	if err != nil {
		t.Fatalf("measure reaped process: %v", err)
	}
	if len(measured) != 1 || measured[0].MetricsAvailable {
		t.Fatalf("reaped process metrics = %+v, want one unavailable entry", measured)
	}
}

// case: S-237.147
func TestDarwinKinfoProcDecodeTreatsEmptyRecordAsGone(t *testing.T) {
	info, gone, err := decodeDarwinKinfoProc(nil)
	if err != nil {
		t.Fatalf("decode empty process record: %v", err)
	}
	if !gone || info != nil {
		t.Fatalf("empty process record = (%v, gone=%t), want nil and gone", info, gone)
	}
}

// case: S-237.147
func TestDarwinKinfoProcDecodeRejectsUnexpectedNonemptySize(t *testing.T) {
	info, gone, err := decodeDarwinKinfoProc(make([]byte, unix.SizeofKinfoProc-1))
	if err == nil || gone || info != nil {
		t.Fatalf("partial process record = (%v, gone=%t, err=%v), want typed size error", info, gone, err)
	}
	if !errors.Is(err, syscall.EIO) {
		t.Fatalf("partial process record error = %v, want EIO cause", err)
	}
}

// case: S-237.147
func TestDarwinLibprocMetricsErrorTreatsESRCHAsGone(t *testing.T) {
	if err := darwinProcessMetricsError(43210, int(syscall.ESRCH)); err != nil {
		t.Fatalf("disappeared libproc target error = %v, want no error", err)
	}
}

// case: S-237.147
func TestDarwinLibprocMetricsErrorPreservesInspectionErrno(t *testing.T) {
	err := darwinProcessMetricsError(43210, int(syscall.EACCES))
	if !errors.Is(err, syscall.EACCES) {
		t.Fatalf("libproc inspection error = %v, want EACCES cause", err)
	}
}

// case: S-237.13
func TestSupervisedRunObservesWholeDarwinTableWithForeignUIDs(t *testing.T) {
	truePath, err := exec.LookPath("true")
	if err != nil {
		t.Fatal(err)
	}
	infos, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		t.Fatalf("enumerate basic kern.proc.all table: %v", err)
	}
	foreign := false
	for _, info := range infos {
		if info.Eproc.Ucred.Uid != uint32(unix.Getuid()) {
			foreign = true
			break
		}
	}
	if !foreign {
		t.Fatal("macOS process table did not include the protected foreign-uid processes required by this regression")
	}
	dir, err := os.MkdirTemp("", "x53-darwin-process-table-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	_, source, _, ok := runtimeCaller(0)
	if !ok {
		t.Fatal("locate proc package")
	}
	runner := filepath.Join(dir, "kb-runner")
	buildRunner := exec.Command("go", "build", "-o", runner, ".")
	buildRunner.Dir = filepath.Join(filepath.Dir(source), "..", "..")
	if output, err := buildRunner.CombinedOutput(); err != nil {
		t.Fatalf("build kb-runner: %v\n%s", err, output)
	}
	state := filepath.Join(dir, "state")
	run, err := Start(contextForTestLifetime(t), Config{StateDir: state, Tag: "foreign-process-table", Stall: time.Hour,
		StdoutPath: filepath.Join(state, "stdout"), StderrPath: filepath.Join(state, "stderr"),
		Command: []string{truePath},
	})
	if err != nil {
		t.Fatalf("start with protected foreign-uid processes present: %v", err)
	}
	if err := run.Wait(); err != nil {
		t.Fatalf("ordinary supervised command failed on unrelated foreign-uid process: %v", err)
	}
}

// case: S-237.1
func TestDetachedDarwinMembershipRequiresHistoryOrMarker(t *testing.T) {
	dir := t.TempDir()
	helper := filepath.Join(dir, "proc-helper")
	_, source, _, ok := runtimeCaller(0)
	if !ok {
		t.Fatal("locate proc package")
	}
	build := exec.Command("go", "build", "-o", helper, "./testhelper")
	build.Dir = filepath.Dir(source)
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build proc helper: %v\n%s", err, output)
	}
	state := filepath.Join(dir, "state")
	pidFile := filepath.Join(dir, "pids")
	releaseFile := filepath.Join(dir, "release")
	var pids []int
	identities := make(map[int]string)
	run, err := Start(contextForTestLifetime(t), Config{StateDir: state, Tag: "darwin-procargs", Stall: 250 * time.Millisecond,
		StdoutPath: filepath.Join(dir, "stdout"), StderrPath: filepath.Join(dir, "stderr"),
		Command: []string{helper, "probe-detached", pidFile, releaseFile},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.WriteFile(releaseFile, nil, 0o600); err != nil {
			t.Logf("release test-owned detached process fixtures: %v", err)
		}
		_ = run.Kill()
		_ = run.Wait()
		for _, pid := range pids {
			identity, exists := processIdentityForTest(t, pid)
			if exists && identity == identities[pid] {
				if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil {
					t.Logf("cleanup test-owned process group %d: %v", pid, err)
				}
			}
		}
		deadline := time.Now().Add(testdeadline.Budget(t))
		for time.Now().Before(deadline) {
			alive := false
			for _, pid := range pids {
				if identity, exists := processIdentityForTest(t, pid); exists && identity == identities[pid] {
					alive = true
				}
			}
			if !alive {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Logf("test-owned detached process identities still exist after bounded cleanup: %v", pids)
	})
	deadline := time.Now().Add(testdeadline.Budget(t))
	for time.Now().Before(deadline) {
		data, readErr := os.ReadFile(pidFile)
		if readErr == nil {
			lines := strings.Fields(string(data))
			if len(lines) == 2 {
				for _, line := range lines {
					pid, parseErr := strconv.Atoi(line)
					if parseErr != nil {
						t.Fatal(parseErr)
					}
					identity, alive := processIdentityForTest(t, pid)
					if !alive {
						t.Fatalf("detached fixture PID %d exited before classification", pid)
					}
					pids = append(pids, pid)
					identities[pid] = identity
				}
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(pids) != 2 {
		t.Fatalf("detached fixture PIDs were not recorded: %v", pids)
	}
	runner := filepath.Join(dir, "kb-runner")
	buildRunner := exec.Command("go", "build", "-o", runner, ".")
	buildRunner.Dir = filepath.Join(filepath.Dir(source), "..", "..")
	if output, err := buildRunner.CombinedOutput(); err != nil {
		t.Fatalf("build kb-runner: %v\n%s", err, output)
	}
	for _, pid := range pids {
		raw, queryErr := unix.SysctlRaw("kern.procargs2", pid)
		markerFound := queryErr == nil && bytes.Contains(raw, []byte(runEnv+"="+run.RunID))
		environmentFound := queryErr == nil && procargs2HasEnvironment(raw)
		t.Logf("pid=%d kern.procargs2_error=%v environment=%t marker=%t", pid, queryErr, environmentFound, markerFound)
		listing := List(state)
		if listing.Error != nil {
			t.Fatalf("kb-runner process listing failed: %v", listing.Error)
		}
		var found *Process
		for _, listedRun := range listing.Runs {
			if listedRun.RunID != run.RunID {
				continue
			}
			if listedRun.Error != "" {
				t.Fatalf("process tree observation failed while checking PID %d: %s", pid, listedRun.Error)
			}
			for i := range listedRun.Tree {
				if listedRun.Tree[i].PID == pid {
					process := listedRun.Tree[i]
					found = &process
				}
			}
		}
		if markerFound && found == nil {
			t.Fatalf("readable inherited marker for PID %d was not enough to include it", pid)
		}
		if found != nil {
			if found.Unverified {
				t.Fatalf("owned detached PID %d remained unverified despite marker or sampled history: %+v", pid, *found)
			}
			identity, alive := processIdentityForTest(t, pid)
			if !alive || identity != found.Identity {
				t.Fatalf("listed detached PID %d lacks current matching identity: %+v alive=%t identity=%s", pid, *found, alive, identity)
			}
		}
		output, err := exec.Command(runner, "ps", "--state", state).CombinedOutput()
		if err != nil {
			t.Fatalf("kb-runner ps failed: %v\n%s", err, output)
		}
		listedInPS := false
		for _, line := range strings.Split(string(output), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			listedPID, parseErr := strconv.Atoi(fields[1])
			if parseErr != nil || listedPID != pid {
				continue
			}
			listedInPS = true
			for _, field := range fields[2:] {
				if field == "unverified" {
					t.Fatalf("ps marked proven marker/history PID %d unverified: %s", pid, line)
				}
			}
		}
		if listedInPS != (found != nil) {
			t.Fatalf("ps membership for PID %d = %t, tree membership = %t; output: %s", pid, listedInPS, found != nil, output)
		}
	}
}

func processIdentityForTest(t *testing.T, pid int) (string, bool) {
	t.Helper()
	identity, alive, err := ProcessIdentity(pid)
	if err != nil {
		t.Errorf("inspect process %d identity: %v", pid, err)
		return "", false
	}
	return identity, alive
}

func runtimeCaller(skip int) (uintptr, string, int, bool) { return runtime.Caller(skip + 1) }

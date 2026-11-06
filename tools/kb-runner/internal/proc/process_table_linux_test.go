//go:build linux

package proc

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// case: S-237.21
func TestProcCmdlinePreservesOSArgumentBoundaries(t *testing.T) {
	want := []string{"/tmp/fixture", "unbalanced'quote", "", "first-line\nsecond-line", "one argument with spaces"}
	data := []byte("/tmp/fixture\x00unbalanced'quote\x00\x00first-line\nsecond-line\x00one argument with spaces\x00")
	got, err := parseProcCmdline(data)
	if err != nil {
		t.Fatalf("parse non-empty /proc cmdline: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("cmdline argv length = %d, want %d: %#v", len(got), len(want), got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("cmdline argv[%d] = %q, want %q", index, got[index], want[index])
		}
	}
}

// case: S-237.24
func TestLinuxEmptyCmdlineSettlesReadableArgvForRootUID(t *testing.T) {
	process := Process{PID: 9211, Identity: "9211:root-process", uid: 0}
	reads := 0
	entry, include := inventoryEntry(process, 0, func(int) ([]string, error) {
		reads++
		if reads == 1 {
			return parseProcCmdline(nil)
		}
		return parseProcCmdline([]byte("/usr/bin/true\x00later\x00"))
	}, func(int) (string, bool, error) {
		return process.Identity, true, nil
	})
	if !include || entry.Unverified || entry.ObservationError != "" || reads != 2 ||
		len(entry.Argv) != 2 || entry.Argv[0] != "/usr/bin/true" || entry.Argv[1] != "later" {
		t.Fatalf("FAILED PREDICATE [inventory.linux-empty-cmdline-settles-readable]: reads=%d entry=%+v included=%t",
			reads, entry, include)
	}
}

// case: S-237.24
func TestLinuxEmptyCmdlineThenGoneIsOmitted(t *testing.T) {
	process := Process{PID: 9212, Identity: "9212:root-process", uid: 0}
	entry, include := inventoryEntry(process, 0, func(int) ([]string, error) {
		return parseProcCmdline(nil)
	}, func(int) (string, bool, error) {
		return "", false, nil
	})
	if include {
		t.Fatalf("FAILED PREDICATE [inventory.linux-empty-cmdline-gone-omitted]: entry=%+v", entry)
	}
}

// case: S-237.24
func TestLinuxEmptyCmdlineIsNotAnArgvObservation(t *testing.T) {
	if argv, err := parseProcCmdline(nil); err == nil || len(argv) != 0 {
		t.Fatalf("FAILED PREDICATE [inventory.linux-empty-cmdline-is-unreadable]: argv=%#v err=%v", argv, err)
	}
}

// case: S-237.21
func TestLinuxProcCmdlineReadsRewrittenLiveArgv(t *testing.T) {
	compiler, err := exec.LookPath("cc")
	if err != nil {
		t.Fatalf("C compiler required for live /proc cmdline rewrite fixture: %v", err)
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "rewrite-argv.c")
	binary := filepath.Join(dir, "rewrite-argv")
	ready := filepath.Join(dir, "ready")
	const program = `#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 4 || strlen(argv[1]) != 8) return 2;
  memcpy(argv[1], "after!!!", 8);
  puts("ready");
  fflush(stdout);
  for (;;) pause();
}`
	if err := os.WriteFile(source, []byte(program), 0o600); err != nil {
		t.Fatal(err)
	}
	build := exec.Command(compiler, "-O2", "-o", binary, source)
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("compile test-owned argv rewrite helper: %v\n%s", err, output)
	}
	child := exec.Command(binary, "before!!", ready, "")
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatalf("start test-owned argv rewrite child: %v", err)
	}
	t.Cleanup(func() {
		if child.ProcessState == nil {
			if err := child.Process.Kill(); err != nil && err != os.ErrProcessDone {
				t.Errorf("kill test-owned argv rewrite child: %v", err)
			}
		}
		if err := child.Wait(); err != nil {
			if exitErr, ok := err.(*exec.ExitError); !ok || exitErr.ExitCode() != -1 {
				t.Errorf("wait for test-owned argv rewrite child: %v", err)
			}
		}
	})
	readyLine, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		t.Fatalf("wait for child argv rewrite acknowledgement: %v", err)
	}
	if strings.TrimSpace(readyLine) != "ready" {
		t.Fatalf("child readiness line = %q, want ready", readyLine)
	}
	want := []string{binary, "after!!!", ready, ""}
	got, err := readProcessArguments(child.Process.Pid)
	if err != nil {
		t.Fatalf("read rewritten child /proc/%d/cmdline: %v", child.Process.Pid, err)
	}
	if !equalLinuxArguments(got, want) {
		t.Fatalf("rewritten /proc cmdline argv = %#v, want %#v", got, want)
	}
}

func equalLinuxArguments(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range want {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}

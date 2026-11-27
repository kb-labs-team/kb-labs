//go:build linux

package proc

import (
	"io/fs"
	"strings"
	"syscall"
	"testing"
)

func TestChildProcessVanishedCoversExitDuringRead(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"open after exit", &fs.PathError{Op: "open", Path: "/proc/1/stat", Err: syscall.ENOENT}, true},
		{"read after reap", &fs.PathError{Op: "read", Path: "/proc/1/stat", Err: syscall.ESRCH}, true},
		{"permission", &fs.PathError{Op: "open", Path: "/proc/1/stat", Err: syscall.EACCES}, false},
	}
	for _, c := range cases {
		if got := childProcessVanished(c.err); got != c.want {
			t.Errorf("%s: childProcessVanished = %v, want %v", c.name, got, c.want)
		}
	}
}

// case: S-237.1
func TestParseChildProcStatTreatsOnlyUnsetProcessGroupAsVanished(t *testing.T) {
	statLine := func(groupID, startTicks string) []byte {
		fields := make([]string, 20)
		for i := range fields {
			fields[i] = "0"
		}
		fields[0] = "S"
		fields[1] = "1"
		fields[2] = groupID
		fields[19] = startTicks
		return []byte("42 (fixture command) " + strings.Join(fields, " ") + "\n")
	}

	t.Run("kernel could not observe exiting task", func(t *testing.T) {
		_, err := parseChildProcStat(42, statLine("-1", "9876"))
		if !childProcessVanished(err) {
			t.Fatalf("parseChildProcStat error = %v, want vanished ESRCH", err)
		}
	})

	t.Run("other negative group remains invalid", func(t *testing.T) {
		_, err := parseChildProcStat(42, statLine("-2", "9876"))
		if err == nil || childProcessVanished(err) {
			t.Fatalf("parseChildProcStat error = %v, want a fatal invalid-group error", err)
		}
	})

	t.Run("owned process group remains available", func(t *testing.T) {
		got, err := parseChildProcStat(42, statLine("41", "9876"))
		if err != nil {
			t.Fatalf("parseChildProcStat returned error: %v", err)
		}
		if got.processGroupID != 41 || got.startTicks != 9876 {
			t.Fatalf("parsed stat = %+v, want process group 41 and start time 9876", got)
		}
	})

	t.Run("zero process group remains available", func(t *testing.T) {
		got, err := parseChildProcStat(42, statLine("0", "9876"))
		if err != nil {
			t.Fatalf("parseChildProcStat returned error: %v", err)
		}
		if got.processGroupID != 0 {
			t.Fatalf("parsed process group = %d, want 0", got.processGroupID)
		}
	})

	t.Run("malformed group remains invalid", func(t *testing.T) {
		_, err := parseChildProcStat(42, statLine("invalid", "9876"))
		if err == nil || childProcessVanished(err) {
			t.Fatalf("parseChildProcStat error = %v, want a fatal invalid-group error", err)
		}
	})

	t.Run("unset group does not hide invalid start time", func(t *testing.T) {
		_, err := parseChildProcStat(42, statLine("-1", "invalid"))
		if err == nil || childProcessVanished(err) {
			t.Fatalf("parseChildProcStat error = %v, want a fatal invalid-start-time error", err)
		}
	})
}

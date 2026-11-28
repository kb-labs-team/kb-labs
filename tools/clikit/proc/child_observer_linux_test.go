//go:build linux

package proc

import (
	"io/fs"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
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

func TestParseChildProcStatAcceptsUnavailableGroupSentinel(t *testing.T) {
	stat, err := parseChildProcStat(42, childProcStatLine(42, 'S', "-1"))
	if err != nil {
		t.Fatalf("parseChildProcStat: %v", err)
	}
	if stat.processGroupID != -1 || stat.state != 'S' {
		t.Fatalf("parsed stat = %+v, want unavailable group sentinel", stat)
	}
}

func TestParseChildProcStatFailsClosedForMalformedGroup(t *testing.T) {
	for _, c := range []struct{ group, want string }{
		{group: "-2", want: "group out of range"},
		{group: "hidden", want: "group unparseable"},
	} {
		_, err := parseChildProcStat(42, childProcStatLine(42, 'S', c.group))
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Fatalf("group %q: parseChildProcStat error = %v, want containing %q", c.group, err, c.want)
		}
		if c.group == "hidden" && strings.Contains(err.Error(), c.group) {
			t.Fatalf("diagnostic exposed untrusted group data: %v", err)
		}
	}
}

func TestChildProcessGroupMembersRetriesSentinelAndSkipsVanishedPID(t *testing.T) {
	rootStarted := time.Unix(0, 0)
	calls := map[int]int{}
	read := func(pid int) (childProcStat, error) {
		calls[pid]++
		switch pid {
		case 10:
			if calls[pid] == 1 {
				return childProcStat{state: 'S', processGroupID: -1, startTicks: 100}, nil
			}
			return childProcStat{state: 'R', processGroupID: 42, startTicks: 100}, nil
		case 11:
			return childProcStat{}, &fs.PathError{Op: "open", Path: "/proc/11/stat", Err: syscall.ENOENT}
		case 12:
			return childProcStat{state: 'S', processGroupID: 42, startTicks: 120}, nil
		default:
			t.Fatalf("unexpected pid %d", pid)
			return childProcStat{}, nil
		}
	}

	members, err := childProcessGroupMembersFromPIDs([]int{10, 11, 12}, 42, rootStarted, read)
	if err != nil {
		t.Fatalf("childProcessGroupMembersFromPIDs: %v", err)
	}
	if len(members) != 2 {
		t.Fatalf("member count = %d, want 2: %+v", len(members), members)
	}
	if got, want := []int{members[0].PID, members[1].PID}, []int{10, 12}; !reflect.DeepEqual(got, want) {
		t.Fatalf("member PIDs = %v, want surviving owned processes %v", got, want)
	}
	if calls[10] != 2 || calls[11] != 1 || calls[12] != 1 {
		t.Fatalf("read counts = %v, want retry sentinel once and skip vanished PID", calls)
	}
}

func TestChildProcessGroupMembersSkipsExitSentinelAndKeepsOwnedSurvivor(t *testing.T) {
	read := func(pid int) (childProcStat, error) {
		if pid == 10 {
			return childProcStat{state: 'X', processGroupID: -1, startTicks: 100}, nil
		}
		return childProcStat{state: 'S', processGroupID: 42, startTicks: 120}, nil
	}
	members, err := childProcessGroupMembersFromPIDs([]int{10, 12}, 42, time.Unix(0, 0), read)
	if err != nil {
		t.Fatalf("childProcessGroupMembersFromPIDs: %v", err)
	}
	if len(members) != 1 || members[0].PID != 12 {
		t.Fatalf("members = %+v, want only surviving owned PID 12", members)
	}
}

func TestChildProcessGroupMembersFailsClosedForUnresolvedLiveSentinel(t *testing.T) {
	calls := 0
	read := func(int) (childProcStat, error) {
		calls++
		return childProcStat{state: 'R', processGroupID: -1, startTicks: 100}, nil
	}
	_, err := childProcessGroupMembersFromPIDs([]int{10}, 42, time.Unix(0, 0), read)
	if err == nil || !strings.Contains(err.Error(), "remained unavailable") {
		t.Fatalf("error = %v, want unresolved sentinel observation failure", err)
	}
	if calls != maxUnavailableGroupReads {
		t.Fatalf("read count = %d, want bounded %d observations", calls, maxUnavailableGroupReads)
	}
}

func childProcStatLine(pid int, state byte, group string) []byte {
	fields := []string{string(state), "1", group}
	for len(fields) < 20 {
		fields = append(fields, "0")
	}
	fields[19] = "12345"
	return []byte(strings.Join([]string{strconv.Itoa(pid), "(fixture)", strings.Join(fields, " ")}, " "))
}

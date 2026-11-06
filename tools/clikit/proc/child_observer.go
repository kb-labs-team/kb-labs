//go:build darwin || linux

package proc

import (
	"fmt"
	"sort"
	"time"

	"github.com/kb-labs/clikit/proc/child"
)

type childProcessObserver struct{}

type childProcessObservation struct {
	PID       int
	GroupID   int
	Identity  string
	StartedAt time.Time
	State     byte
}

func liveOwnedGroupMembers(processes []childProcessObservation, groupID int, rootStartedAt time.Time) []child.ProcessMember {
	members := make([]child.ProcessMember, 0)
	for _, process := range processes {
		if process.GroupID != groupID || process.Identity == "" || process.StartedAt.Before(rootStartedAt) || process.State == 'Z' || process.State == 'X' {
			continue
		}
		members = append(members, child.ProcessMember{PID: process.PID, Identity: process.Identity})
	}
	sort.Slice(members, func(i, j int) bool { return members[i].PID < members[j].PID })
	return members
}

// ChildProcessObserver supplies child lifecycle code with identity data from
// the process-table owner.
func ChildProcessObserver() child.ProcessObserver { return childProcessObserver{} }

func (childProcessObserver) RootIdentity(pid int) (child.ProcessIdentity, error) {
	return childProcessIdentity(pid)
}

func (childProcessObserver) LiveMembers(groupID int, root child.ProcessIdentity) ([]child.ProcessMember, error) {
	if groupID <= 0 || root.PID <= 0 || root.Identity == "" || root.StartedAt.IsZero() {
		return nil, fmt.Errorf("observe process group: root identity and group ID are required")
	}
	return childProcessGroupMembers(groupID, root.StartedAt)
}

package versionroot

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/kb-labs/clikit/proc"
	"github.com/kb-labs/clikit/proc/child"
)

// managedStageOwner is a crash-recovery hint, not a security boundary. The
// process-group identity lets a later operation refuse to remove a candidate
// while the previous Marketplace helper or one of its package-manager children
// is still alive after the Go owner was forcibly terminated.
type managedStageOwner struct {
	PID       int       `json:"pid"`
	Identity  string    `json:"identity"`
	StartedAt time.Time `json:"startedAt"`
}

func (l Layout) managedStageOwnerPath(stage string) string {
	return stage + ".owner.json"
}

func (l Layout) recordManagedStageOwner(stage string, pid int) error {
	if pid <= 0 {
		return fmt.Errorf("managed Marketplace helper has invalid process ID")
	}
	identity, err := proc.ChildProcessObserver().RootIdentity(pid)
	if err != nil {
		return fmt.Errorf("observe managed Marketplace helper: %w", err)
	}
	owner := managedStageOwner{PID: identity.PID, Identity: identity.Identity, StartedAt: identity.StartedAt}
	data, err := json.Marshal(owner)
	if err != nil {
		return err
	}
	path := l.managedStageOwnerPath(stage)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

// managedStageOwnerLive fails closed: an unreadable or unverifiable owner
// record blocks candidate cleanup instead of assuming that writers are gone.
func (l Layout) managedStageOwnerLive(stage string) (bool, error) {
	path := l.managedStageOwnerPath(stage)
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return true, err
	}
	var owner managedStageOwner
	if err := json.Unmarshal(data, &owner); err != nil || owner.PID <= 0 || owner.Identity == "" || owner.StartedAt.IsZero() {
		return true, fmt.Errorf("managed stage owner record is invalid")
	}
	root := child.ProcessIdentity{PID: owner.PID, Identity: owner.Identity, StartedAt: owner.StartedAt}
	members, err := proc.ChildProcessObserver().LiveMembers(owner.PID, root)
	if err != nil {
		return true, fmt.Errorf("verify managed stage process group: %w", err)
	}
	if len(members) != 0 {
		return true, nil
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return true, err
	}
	if err := syncDirectory(filepath.Dir(path)); err != nil {
		return true, err
	}
	return false, nil
}

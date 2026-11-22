package versionroot

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
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
	if _, err := os.Lstat(path); err == nil {
		return fmt.Errorf("managed stage owner record already exists")
	} else if !os.IsNotExist(err) {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp-")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
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
	if err := os.Rename(temporary, path); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func (l Layout) removeManagedStageOwnerTemps(stage string) error {
	prefix := filepath.Base(l.managedStageOwnerPath(stage)) + ".tmp-"
	entries, err := os.ReadDir(filepath.Dir(stage))
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), prefix) {
			continue
		}
		path := filepath.Join(filepath.Dir(stage), entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("managed stage owner temporary %q is not a regular file", path)
		}
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	return nil
}

// managedStageOwnerLive fails closed: an unreadable or unverifiable owner
// record blocks candidate cleanup instead of assuming that writers are gone.
func (l Layout) managedStageOwnerLive(stage string) (bool, error) {
	owner, exists, err := l.readManagedStageOwner(stage)
	if err != nil || !exists {
		return false, err
	}
	observer := proc.ChildProcessObserver()
	members, err := observeManagedStageOwnerGroup(observer, owner)
	if err != nil {
		return true, err
	}
	if len(members) != 0 {
		return true, nil
	}
	if err := os.Remove(l.managedStageOwnerPath(stage)); err != nil && !os.IsNotExist(err) {
		return true, err
	}
	if err := syncDirectory(filepath.Dir(stage)); err != nil {
		return true, err
	}
	return false, nil
}

func (l Layout) stopManagedStageOwner(stage string) error {
	return l.stopManagedStageOwnerWith(stage, proc.ChildProcessObserver(), func(observer child.ProcessObserver, identity child.ProcessIdentity, signal syscall.Signal) error {
		return child.SignalIdentity(observer, identity, signal)
	})
}

type managedProcessSignaler func(child.ProcessObserver, child.ProcessIdentity, syscall.Signal) error

func (l Layout) stopManagedStageOwnerWith(stage string, observer child.ProcessObserver, signal managedProcessSignaler) error {
	owner, exists, err := l.readManagedStageOwner(stage)
	if err != nil || !exists {
		return err
	}
	members, err := observeManagedStageOwnerGroup(observer, owner)
	if err != nil {
		return fmt.Errorf("verify managed stage process group before stopping it: %w", err)
	}
	if len(members) != 0 {
		known := map[int]string{owner.PID: owner.Identity}
		for _, member := range members {
			known[member.PID] = member.Identity
		}
		if err := signalManagedStageMembers(observer, owner, known, syscall.SIGTERM, signal); err != nil {
			return fmt.Errorf("request managed Marketplace helper shutdown: %w", err)
		}
		if err := waitManagedStageGroupExit(observer, owner.PID, owner, known, syscall.SIGTERM, signal, 400*time.Millisecond); err != nil {
			if killErr := signalManagedStageMembers(observer, owner, known, syscall.SIGKILL, signal); killErr != nil {
				return errors.Join(err, fmt.Errorf("kill managed Marketplace helper process identities: %w", killErr))
			}
			if err := waitManagedStageGroupExit(observer, owner.PID, owner, known, syscall.SIGKILL, signal, 3*time.Second); err != nil {
				return err
			}
		}
	}
	if err := os.Remove(l.managedStageOwnerPath(stage)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return syncDirectory(filepath.Dir(stage))
}

func observeManagedStageOwnerGroup(observer child.ProcessObserver, owner managedStageOwner) ([]child.ProcessMember, error) {
	root := child.ProcessIdentity{PID: owner.PID, Identity: owner.Identity, StartedAt: owner.StartedAt}
	members, err := observer.LiveMembers(owner.PID, root)
	if err != nil {
		return nil, fmt.Errorf("inspect managed Marketplace process group: %w", err)
	}
	observed, rootErr := observer.RootIdentity(owner.PID)
	if rootErr != nil {
		if len(members) != 0 {
			return nil, fmt.Errorf("process-group identity is ambiguous after its owner exited; preserving the managed candidate")
		}
		return nil, nil
	}
	if observed.PID != owner.PID || observed.Identity != owner.Identity || !observed.StartedAt.Equal(owner.StartedAt) {
		if len(members) != 0 {
			return nil, fmt.Errorf("process-group ID was reused or owner identity changed; preserving the managed candidate")
		}
		return nil, nil
	}
	return members, nil
}

func signalManagedStageMembers(observer child.ProcessObserver, owner managedStageOwner, known map[int]string, signalNumber syscall.Signal, signal managedProcessSignaler) error {
	rootIdentity := child.ProcessIdentity{PID: owner.PID, Identity: owner.Identity, StartedAt: owner.StartedAt}
	members, err := observer.LiveMembers(owner.PID, rootIdentity)
	if err != nil {
		return fmt.Errorf("inspect owned process identities before signal: %w", err)
	}
	if len(members) == 0 {
		return nil
	}
	anchored := false
	for _, member := range members {
		if known[member.PID] == member.Identity {
			anchored = true
			break
		}
	}
	if !anchored {
		return fmt.Errorf("process-group identity cannot be tied to the recorded owner; refusing to signal")
	}
	for _, member := range members {
		known[member.PID] = member.Identity
		identity, err := observer.RootIdentity(member.PID)
		if err != nil {
			continue
		}
		if identity.PID != member.PID || identity.Identity != member.Identity {
			continue
		}
		if err := signal(observer, identity, signalNumber); err != nil && !errors.Is(err, syscall.ESRCH) && !errors.Is(err, os.ErrProcessDone) {
			return err
		}
	}
	return nil
}

func waitManagedStageGroupExit(observer child.ProcessObserver, groupID int, owner managedStageOwner, known map[int]string, signalNumber syscall.Signal, signal managedProcessSignaler, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		root := child.ProcessIdentity{PID: owner.PID, Identity: owner.Identity, StartedAt: owner.StartedAt}
		members, err := observer.LiveMembers(groupID, root)
		if err != nil {
			return fmt.Errorf("verify managed Marketplace helper process group exit: %w", err)
		}
		if len(members) == 0 {
			return nil
		}
		anchored := false
		for _, member := range members {
			if known[member.PID] == member.Identity {
				anchored = true
				break
			}
		}
		if !anchored {
			return fmt.Errorf("process-group ID changed while stopping owner; refusing further signals")
		}
		if err := signalManagedStageMembers(observer, owner, known, signalNumber, signal); err != nil {
			return err
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("managed Marketplace helper process group did not stop within %s", timeout)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func (l Layout) readManagedStageOwner(stage string) (managedStageOwner, bool, error) {
	path := l.managedStageOwnerPath(stage)
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return managedStageOwner{}, false, nil
	}
	if err != nil {
		return managedStageOwner{}, true, err
	}
	var owner managedStageOwner
	if err := json.Unmarshal(data, &owner); err != nil || owner.PID <= 0 || owner.Identity == "" || owner.StartedAt.IsZero() {
		return managedStageOwner{}, true, fmt.Errorf("managed stage owner record is invalid")
	}
	return owner, true, nil
}

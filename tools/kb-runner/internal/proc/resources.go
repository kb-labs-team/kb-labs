//go:build darwin || linux

package proc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	clikitproc "github.com/kb-labs/clikit/proc"
	"github.com/kb-labs/clikit/proc/child"
	"golang.org/x/sys/unix"
)

type ResourceKind string

const (
	ResourcePath         ResourceKind = "path"
	ResourceCompose      ResourceKind = "docker-compose"
	ResourceContainer    ResourceKind = "docker-container"
	ResourceNetwork      ResourceKind = "docker-network"
	ResourceVolume       ResourceKind = "docker-volume"
	ResourceRemoved                   = "removed"
	ResourceAlreadyGone               = "already-gone"
	ResourceRefused                   = "refused"
	ResourceFailed                    = "failed"
	ResourcePending                   = "pending"
	resourceStateEnv                  = "KBLABS_CLIPROC_STATE"
	composeStopTimeout                = 10 * time.Second
	composeCleanupMargin              = 5 * time.Second
)

type OwnedPathType string

const (
	OwnedDirectory OwnedPathType = "dir"
	OwnedFile      OwnedPathType = "file"
)

type PathXattrUnsupportedError struct {
	Filesystem string
	Path       string
}

type OwnedPathRefusalError struct{ Reason string }

func (err *OwnedPathRefusalError) Error() string { return err.Reason }

func (err *PathXattrUnsupportedError) Error() string {
	return fmt.Sprintf("filesystem %q at %q does not support required user xattrs; move this path to a filesystem with user xattr support", err.Filesystem, err.Path)
}

type Resource struct {
	Kind             ResourceKind `json:"kind"`
	ID               string       `json:"id"`
	Files            []string     `json:"files,omitempty"`
	ComposePrefix    []string     `json:"compose_prefix,omitempty"`
	ProtectedVolumes []string     `json:"protected_volumes,omitempty"`
	Device           uint64       `json:"device,omitempty"`
	Inode            uint64       `json:"inode,omitempty"`
	ownerToken       string       `json:"-"`
	Outcome          string       `json:"outcome,omitempty"`
	Error            string       `json:"error,omitempty"`
}

type resourceJSON Resource

type resourceWire struct {
	*resourceJSON
	OwnerToken string `json:"owner_token,omitempty"`
}

func (resource Resource) MarshalJSON() ([]byte, error) {
	value := resourceJSON(resource)
	return json.Marshal(resourceWire{resourceJSON: &value, OwnerToken: resource.ownerToken})
}

func (resource *Resource) UnmarshalJSON(data []byte) error {
	value := resourceJSON(*resource)
	wire := resourceWire{resourceJSON: &value}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*resource = Resource(value)
	resource.ownerToken = wire.OwnerToken
	return nil
}

type ResourceOutcome struct {
	Resource Resource `json:"resource"`
	Outcome  string   `json:"outcome"`
	Error    string   `json:"error,omitempty"`
	stalled  bool
	Steps    []ResourceCleanupStep `json:"steps,omitempty"`
}

type DockerCleanupStallError struct {
	Message string
	Cause   error
}

func (err *DockerCleanupStallError) Error() string {
	return fmt.Sprintf("%s: %v", err.Message, err.Cause)
}

func (err *DockerCleanupStallError) Unwrap() error { return err.Cause }

type ResourceCleanupStep struct {
	Name    string `json:"name"`
	Outcome string `json:"outcome"`
	Error   string `json:"error,omitempty"`
}

type fileIdentity struct {
	Device uint64
	Inode  uint64
}

func (identity fileIdentity) matches(resource Resource) bool {
	return identity.Device == resource.Device && identity.Inode == resource.Inode
}

func composeCleanupBound() time.Duration {
	return composeStopTimeout + composeCleanupMargin
}

var dockerCommand = func(ctx context.Context, args ...string) ([]byte, error) {
	return resourceCommand(ctx, []string{"docker"}, args...)
}

var setPathOwnerXattr = func(path string, value []byte) error {
	return unix.Lsetxattr(path, pathOwnerXattrName, value, 0)
}

var getPathOwnerXattr = func(path string) ([]byte, error) {
	size, err := unix.Lgetxattr(path, pathOwnerXattrName, nil)
	if err != nil {
		return nil, err
	}
	value := make([]byte, size)
	read, err := unix.Lgetxattr(path, pathOwnerXattrName, value)
	if err != nil {
		return nil, err
	}
	return value[:read], nil
}

var composeCommand = func(ctx context.Context, prefix []string, args ...string) ([]byte, error) {
	return resourceCommand(ctx, prefix, args...)
}

func resourceCommand(ctx context.Context, prefix []string, args ...string) ([]byte, error) {
	if len(prefix) == 0 || prefix[0] == "" {
		return nil, errors.New("resource command prefix is empty")
	}
	command := exec.Command(prefix[0], append(prefix[1:], args...)...)
	var output bytes.Buffer
	command.Stdout, command.Stderr = &output, &output
	err := child.Run(ctx, command, clikitproc.ChildProcessObserver())
	return output.Bytes(), err
}

// RegisterResource records an explicitly owned external resource in run order.
func RegisterResource(stateDir, runID string, resource Resource) error {
	return withStateLock(stateDir, func() error {
		rec, err := readRecordLocked(stateDir, runID)
		if err != nil {
			return fmt.Errorf("resource owner run %q is unavailable: %w", runID, err)
		}
		if rec.Status != StatusRunning && rec.Status != StatusStalled && rec.Status != StatusStarting && rec.Status != StatusPaused {
			return fmt.Errorf("run %q is not active; resources can only be owned during a running command", runID)
		}
		if resource.ID == "" {
			return errors.New("resource id is required")
		}
		switch resource.Kind {
		case ResourcePath:
			return errors.New("path ownership requires exclusive creation: use own path --create dir|file PATH")
		case ResourceCompose:
			if len(resource.Files) == 0 || len(resource.ComposePrefix) == 0 {
				return errors.New("docker-compose ownership requires --file PATH and a command prefix after --")
			}
			protected, err := inspectComposeVolumes(resource)
			if err != nil {
				return err
			}
			resource.ProtectedVolumes = protected
		case ResourceContainer, ResourceNetwork:
		case ResourceVolume:
			exists, err := dockerResourceExists(ResourceVolume, resource.ID)
			if err != nil {
				return fmt.Errorf("inspect Docker volume %q before ownership: %w", resource.ID, err)
			}
			if exists {
				return fmt.Errorf("refused pre-existing Docker volume %q; only volumes created by this run may be owned", resource.ID)
			}
		default:
			return fmt.Errorf("unsupported resource kind %q", resource.Kind)
		}
		entries, err := readRunResources(stateDir, runID)
		if err != nil {
			return err
		}
		resource.Outcome = ResourcePending
		entries = append(entries, resource)
		return writeRunResources(stateDir, runID, entries)
	})
}

// CreateOwnedPath atomically creates and records a path under configured cleanup roots.
func CreateOwnedPath(stateDir, runID, path string, pathType OwnedPathType) error {
	return withStateLock(stateDir, func() error {
		rec, err := readRecordLocked(stateDir, runID)
		if err != nil {
			return fmt.Errorf("resource owner run %q is unavailable: %w", runID, err)
		}
		if rec.Status != StatusRunning && rec.Status != StatusStalled && rec.Status != StatusStarting && rec.Status != StatusPaused {
			return fmt.Errorf("run %q is not active; resources can only be owned during a running command", runID)
		}
		absolute, err := filepath.Abs(path)
		if err != nil {
			return fmt.Errorf("resolve owned path: %w", err)
		}
		absolute, err = normalizeCleanupPath(stateDir, absolute)
		if err != nil {
			return fmt.Errorf("normalize owned path against cleanup roots: %w", err)
		}
		inside, err := pathUnderCleanupRoot(stateDir, runID, absolute)
		if err != nil {
			return err
		}
		if !inside {
			return fmt.Errorf("refused owned path %q: it is outside configured cleanup roots", absolute)
		}
		nonce, err := newID()
		if err != nil {
			return fmt.Errorf("create path ownership nonce: %w", err)
		}
		ownerToken := runID + ":" + nonce
		var createdInfo os.FileInfo
		switch pathType {
		case OwnedDirectory:
			err = os.Mkdir(absolute, 0o700)
		case OwnedFile:
			var file *os.File
			file, err = os.OpenFile(absolute, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
			if err == nil {
				createdInfo, err = file.Stat()
				closeErr := file.Close()
				err = errors.Join(err, closeErr)
			}
		default:
			return fmt.Errorf("unsupported owned path type %q; expected dir or file", pathType)
		}
		if err != nil {
			return fmt.Errorf("create owned path %q exclusively: %w", absolute, err)
		}
		if createdInfo == nil {
			createdInfo, err = os.Lstat(absolute)
		}
		if err != nil {
			return fmt.Errorf("inspect newly created path %q; it was left untouched because its identity could not be verified: %w", absolute, err)
		}
		if createdInfo.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refused owned path %q: symlinks are not allowed; the replacement was left untouched", absolute)
		}
		identity, err := resourceIdentity(absolute, createdInfo)
		if err != nil {
			return fmt.Errorf("inspect owned path %q; it was left untouched because its identity could not be verified: %w", absolute, err)
		}
		if err := setPathOwnerXattr(absolute, []byte(ownerToken)); err != nil {
			rollbackErr := removeCreatedPath(stateDir, runID, absolute, identity)
			if errors.Is(err, unix.EOPNOTSUPP) || errors.Is(err, unix.ENOTSUP) {
				return errors.Join(&PathXattrUnsupportedError{Filesystem: filesystemName(absolute), Path: absolute}, rollbackErr)
			}
			return errors.Join(fmt.Errorf("write path ownership xattr on %q: %w", absolute, err), rollbackErr)
		}
		resource := Resource{Kind: ResourcePath, ID: absolute, Device: identity.Device, Inode: identity.Inode, ownerToken: ownerToken, Outcome: ResourcePending}
		entries, err := readRunResources(stateDir, runID)
		if err == nil {
			entries = append(entries, resource)
			err = writeRunResources(stateDir, runID, entries)
		}
		if err != nil {
			return errors.Join(err, removeOwnedPath(stateDir, runID, resource))
		}
		return nil
	})
}

func inspectComposeVolumes(resource Resource) ([]string, error) {
	args := []string{"-p", resource.ID}
	for _, file := range resource.Files {
		args = append(args, "-f", file)
	}
	args = append(args, "config", "--format", "json")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	data, err := composeCommand(ctx, resource.ComposePrefix, args...)
	cancel()
	if err != nil {
		return nil, fmt.Errorf("read Compose volume declarations: %w: %s", err, strings.TrimSpace(string(data)))
	}
	var config struct {
		Volumes map[string]struct {
			Name     string `json:"name"`
			External bool   `json:"external"`
		} `json:"volumes"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("decode Compose volume declarations: %w", err)
	}
	var protected []string
	for key, volume := range config.Volumes {
		name := volume.Name
		if name == "" {
			return nil, fmt.Errorf("Compose config omitted the resolved name for volume %q", key)
		}
		exists, inspectErr := dockerResourceExists(ResourceVolume, name)
		if inspectErr != nil {
			return nil, fmt.Errorf("inspect Compose volume %q before ownership: %w", name, inspectErr)
		}
		if exists {
			if !volume.External {
				return nil, fmt.Errorf("refused Compose project %q: named volume %q already exists; declare pre-existing volumes external before running compose", resource.ID, name)
			}
			protected = append(protected, name)
			continue
		}
	}
	return protected, nil
}

func pathUnderCleanupRoot(stateDir, runID, path string) (bool, error) {
	path, err := normalizeCleanupPath(stateDir, path)
	if err != nil {
		return false, err
	}
	roots, err := cleanupRoots(stateDir)
	if err != nil {
		return false, err
	}
	scratch, err := runScratchPath(runID)
	if err != nil {
		return false, err
	}
	roots = append(roots, scratch)
	for _, root := range roots {
		rel, err := filepath.Rel(root, path)
		if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		current := root
		rootInfo, err := os.Lstat(current)
		if err != nil {
			return false, fmt.Errorf("inspect cleanup root %q: %w", root, err)
		}
		if rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
			return false, fmt.Errorf("refused path %q: cleanup root %q is not a real directory", path, root)
		}
		parts := strings.Split(rel, string(filepath.Separator))
		for _, part := range parts[:len(parts)-1] {
			current = filepath.Join(current, part)
			info, err := os.Lstat(current)
			if err != nil {
				return false, fmt.Errorf("inspect parent of owned path %q: %w", path, err)
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return false, fmt.Errorf("refused path %q: parent %q is a symlink", path, current)
			}
			if !info.IsDir() {
				return false, fmt.Errorf("refused path %q: parent %q is not a directory", path, current)
			}
		}
		return true, nil
	}
	return false, nil
}

func normalizeCleanupPath(stateDir, path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	absolute = filepath.Clean(absolute)
	configured, err := os.ReadFile(filepath.Join(stateDir, "cleanup-roots.json"))
	if err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("read configured cleanup roots: %w", err)
	}
	if len(configured) > 0 {
		return absolute, nil
	}
	tempRoot, err := filepath.Abs(os.TempDir())
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(tempRoot, absolute)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return absolute, nil
	}
	realTempRoot, err := filepath.EvalSymlinks(tempRoot)
	if err != nil {
		return "", fmt.Errorf("resolve default system temporary root %q: %w", tempRoot, err)
	}
	return filepath.Join(realTempRoot, relative), nil
}

func cleanupRoots(stateDir string) ([]string, error) {
	data, err := os.ReadFile(filepath.Join(stateDir, "cleanup-roots.json"))
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	var roots []string
	if len(data) > 0 {
		if err := json.Unmarshal(data, &roots); err != nil {
			return nil, fmt.Errorf("decode cleanup roots: %w", err)
		}
	} else {
		tempRoot, err := filepath.EvalSymlinks(os.TempDir())
		if err != nil {
			return nil, fmt.Errorf("resolve default system temporary root %q: %w", os.TempDir(), err)
		}
		roots = []string{stateDir, tempRoot}
	}
	for i, root := range roots {
		abs, err := filepath.Abs(root)
		if err != nil {
			return nil, err
		}
		roots[i] = filepath.Clean(abs)
	}
	return roots, nil
}

func resolveKeepPaths(scratch string, paths []string) []string {
	kept := make([]string, 0, len(paths))
	for _, path := range paths {
		if !filepath.IsAbs(path) {
			path = filepath.Join(scratch, path)
		}
		if absolute, err := filepath.Abs(path); err == nil {
			kept = append(kept, filepath.Clean(absolute))
		}
	}
	return kept
}

func cleanupScratch(stateDir, scratch string, expected fileIdentity, keepPaths []string) error {
	return removeScratchPathRelative(stateDir, scratch, expected, keepPaths)
}

func cleanupScratchOutcome(stateDir, scratch string, expected fileIdentity, keepPaths []string) (ResourceOutcome, error) {
	outcome := ResourceOutcome{Resource: Resource{Kind: "scratch", ID: scratch, Device: expected.Device, Inode: expected.Inode}}
	if scratch == "" {
		return outcome, nil
	}
	err := cleanupScratch(stateDir, scratch, expected, keepPaths)
	if errors.Is(err, errOwnedPathAlreadyGone) {
		outcome.Outcome = ResourceAlreadyGone
		return outcome, nil
	}
	if err != nil {
		var refusal *OwnedPathRefusalError
		if errors.As(err, &refusal) {
			outcome.Outcome = ResourceRefused
		} else {
			outcome.Outcome = ResourceFailed
		}
		outcome.Error = err.Error()
		return outcome, err
	}
	outcome.Outcome = ResourceRemoved
	return outcome, nil
}

func readRunResources(stateDir, runID string) ([]Resource, error) {
	rec, err := readRecordLocked(stateDir, runID)
	if err != nil {
		return nil, err
	}
	return rec.Resources, nil
}

func writeRunResources(stateDir, runID string, entries []Resource) error {
	rec, err := readRecordLocked(stateDir, runID)
	if err != nil {
		return err
	}
	rec.Resources = entries
	return writeRecordAtomic(rec)
}

// ResourceOutcomes returns the durable per-resource cleanup results for a run.
func ResourceOutcomes(stateDir, runID string) ([]Resource, error) {
	var resources []Resource
	err := withStateLock(stateDir, func() error {
		rec, err := readRecordLocked(stateDir, runID)
		if err != nil {
			return err
		}
		resources = append([]Resource(nil), rec.Resources...)
		return nil
	})
	return resources, err
}

func appendResourceOutcomeLocked(stateDir, runID string, outcome ResourceOutcome) error {
	entries, err := readRunResources(stateDir, runID)
	if err != nil {
		return err
	}
	resource := outcome.Resource
	resource.Outcome, resource.Error = outcome.Outcome, outcome.Error
	if resource.Kind == "scratch" {
		for i := range entries {
			if entries[i].Kind == resource.Kind && entries[i].ID == resource.ID {
				entries[i] = resource
				return writeRunResources(stateDir, runID, entries)
			}
		}
	}
	entries = append(entries, resource)
	return writeRunResources(stateDir, runID, entries)
}

func appendResourceOutcome(stateDir, runID string, outcome ResourceOutcome) error {
	return withStateLock(stateDir, func() error {
		return appendResourceOutcomeLocked(stateDir, runID, outcome)
	})
}

func cleanupResources(stateDir, runID string) []ResourceOutcome {
	var outcomes []ResourceOutcome
	enteredLock, cleanupFailed := false, false
	if err := withStateLock(stateDir, func() error {
		enteredLock = true
		var err error
		outcomes, err = cleanupResourcesLocked(stateDir, runID)
		if err != nil {
			cleanupFailed = true
			markErr := markRunDirtyLocked(stateDir, runID, err.Error())
			if markErr != nil {
				markErr = errors.Join(markErr, markRunLostLocked(stateDir, runID, errors.Join(err, markErr).Error()))
			}
			err = errors.Join(err, markErr)
		}
		return err
	}); err != nil {
		outcomes = mergePendingResourceFailures(outcomes, pendingResourceFailures(stateDir, runID, err))
		if len(outcomes) > 0 {
			last := len(outcomes) - 1
			if outcomes[last].Error == "" {
				outcomes[last].Error = err.Error()
			} else {
				outcomes[last].Error = errors.Join(errors.New(outcomes[last].Error), err).Error()
			}
		}
		if !enteredLock || !cleanupFailed {
			if markErr := markRunDirty(stateDir, runID, err.Error()); markErr != nil {
				if lostErr := markRunLost(stateDir, runID, errors.Join(err, markErr).Error()); lostErr != nil {
					err = errors.Join(err, markErr, lostErr)
				}
			}
		}
		if len(outcomes) == 0 {
			outcomes = []ResourceOutcome{{Outcome: ResourceFailed, Error: err.Error()}}
		}
		return outcomes
	}
	return outcomes
}

func mergePendingResourceFailures(processed, pending []ResourceOutcome) []ResourceOutcome {
	merged := append([]ResourceOutcome(nil), processed...)
	seen := make(map[string]int, len(processed))
	for _, outcome := range processed {
		seen[string(outcome.Resource.Kind)+"\x00"+outcome.Resource.ID]++
	}
	for _, outcome := range pending {
		key := string(outcome.Resource.Kind) + "\x00" + outcome.Resource.ID
		if seen[key] > 0 {
			seen[key]--
			continue
		}
		merged = append(merged, outcome)
	}
	return merged
}

func cleanupResourcesLocked(stateDir, runID string) ([]ResourceOutcome, error) {
	entries, err := readRunResources(stateDir, runID)
	if err != nil {
		return nil, errors.Join(err, markRunDirtyLocked(stateDir, runID, err.Error()))
	}
	outcomes := make([]ResourceOutcome, 0, len(entries))
	for i := len(entries) - 1; i >= 0; i-- {
		outcome := cleanupResource(stateDir, runID, entries[i])
		outcomes = append(outcomes, outcome)
		entries[i].Outcome, entries[i].Error = outcome.Outcome, outcome.Error
		if err := writeRunResources(stateDir, runID, entries); err != nil {
			markErr := markRunDirtyLocked(stateDir, runID, err.Error())
			return outcomes, errors.Join(fmt.Errorf("persist resource cleanup ledger: %w", err), markErr)
		}
		if outcome.stalled {
			if rec, err := readRecordLocked(stateDir, runID); err == nil {
				event := eventFor(rec, EventStall)
				event.Command = "docker " + string(entries[i].Kind) + " " + entries[i].ID + " cleanup"
				event.Error = outcome.Error
				if err := appendEvent(stateDir, event); err != nil {
					return outcomes, err
				}
			}
		}
	}
	if rec, err := readRecordLocked(stateDir, runID); err == nil {
		dirty := false
		for _, outcome := range outcomes {
			if outcome.Outcome == ResourceFailed || outcome.Outcome == ResourceRefused {
				dirty = true
			}
		}
		if dirty {
			rec.Status = StatusDirty
			rec.Error = "resource cleanup left entries requiring attention"
			if err := writeRecordAtomic(rec); err != nil {
				return outcomes, errors.Join(err, markRunLostLocked(stateDir, runID, err.Error()))
			}
		}
	} else {
		return outcomes, errors.Join(err, markRunDirtyLocked(stateDir, runID, err.Error()))
	}
	return outcomes, nil
}

func resourceOutcomesError(outcomes []ResourceOutcome) error {
	var failures []error
	for _, outcome := range outcomes {
		if outcome.Outcome == ResourceFailed || outcome.Outcome == ResourceRefused || outcome.Error != "" {
			failures = append(failures, fmt.Errorf("%s %s: %s", outcome.Outcome, outcome.Resource.ID, outcome.Error))
		}
	}
	return errors.Join(failures...)
}

func markRunDirty(stateDir, runID, reason string) error {
	return updateRecord(stateDir, runID, func(rec *record) error {
		rec.Status = StatusDirty
		rec.Error = reason
		return nil
	})
}

func markRunDirtyLocked(stateDir, runID, reason string) error {
	rec, err := readRecordLocked(stateDir, runID)
	if err != nil {
		return err
	}
	rec.Status, rec.Error = StatusDirty, reason
	return writeRecordAtomic(rec)
}

func markRunLostLocked(stateDir, runID, reason string) error {
	rec, err := readRecordLocked(stateDir, runID)
	if err != nil {
		return err
	}
	rec.Status, rec.Error = StatusLost, reason
	return writeRecordAtomic(rec)
}

func markRunLost(stateDir, runID, reason string) error {
	return withStateLock(stateDir, func() error {
		return markRunLostLocked(stateDir, runID, reason)
	})
}

func pendingResourceFailures(stateDir, runID string, cause error) []ResourceOutcome {
	entries, err := readRunResources(stateDir, runID)
	if err != nil {
		return nil
	}
	outcomes := make([]ResourceOutcome, 0, len(entries))
	for _, entry := range entries {
		if entry.Outcome == ResourcePending || entry.Outcome == "" {
			outcomes = append(outcomes, ResourceOutcome{Resource: entry, Outcome: ResourceFailed, Error: cause.Error()})
		}
	}
	return outcomes
}

func cleanupResource(stateDir, runID string, resource Resource) ResourceOutcome {
	result := ResourceOutcome{Resource: resource}
	var err error
	switch resource.Kind {
	case ResourcePath:
		err = removeOwnedPath(stateDir, runID, resource)
	case ResourceCompose:
		result.Steps, err = cleanupCompose(resource)
	case ResourceContainer, ResourceNetwork, ResourceVolume:
		exists, inspectErr := dockerResourceExists(resource.Kind, resource.ID)
		if inspectErr != nil {
			err = inspectErr
		} else if !exists {
			result.Outcome = ResourceAlreadyGone
			return result
		} else {
			args := map[ResourceKind][]string{
				ResourceContainer: {"rm", "-f", resource.ID},
				ResourceNetwork:   {"network", "rm", resource.ID},
				ResourceVolume:    {"volume", "rm", resource.ID},
			}[resource.Kind]
			err = dockerRemove(args...)
			if err != nil {
				stillExists, checkErr := dockerResourceExists(resource.Kind, resource.ID)
				if checkErr == nil && !stillExists {
					result.Outcome = ResourceAlreadyGone
					return result
				}
				if checkErr != nil {
					err = errors.Join(err, checkErr)
				}
			}
		}
	default:
		err = fmt.Errorf("unknown ledger resource kind %q", resource.Kind)
	}
	if err != nil {
		if errors.Is(err, errOwnedPathAlreadyGone) {
			result.Outcome = ResourceAlreadyGone
			return result
		}
		var refusal *OwnedPathRefusalError
		if errors.As(err, &refusal) {
			result.Outcome, result.Error = ResourceRefused, refusal.Error()
		} else {
			result.Outcome, result.Error = ResourceFailed, err.Error()
		}
		var stall *DockerCleanupStallError
		result.stalled = errors.As(err, &stall)
	} else {
		result.Outcome = ResourceRemoved
	}
	return result
}

func dockerResourceExists(kind ResourceKind, id string) (bool, error) {
	var args []string
	switch kind {
	case ResourceContainer:
		args = []string{"ps", "-aq", "--no-trunc", "--filter", "id=" + id}
	case ResourceNetwork:
		args = []string{"network", "ls", "-q", "--no-trunc", "--filter", "id=" + id}
	case ResourceVolume:
		args = []string{"volume", "ls", "-q", "--filter", "name=" + id}
	default:
		return false, fmt.Errorf("cannot inspect Docker resource kind %q", kind)
	}
	ctx, cancel := context.WithTimeout(context.Background(), composeCleanupBound())
	output, err := dockerCommand(ctx, args...)
	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
	cancel()
	if err != nil {
		if timedOut {
			return false, &DockerCleanupStallError{Message: fmt.Sprintf("stalled Docker cleanup (docker %s) exceeded %s: %s", strings.Join(args, " "), composeCleanupBound(), strings.TrimSpace(string(output))), Cause: err}
		}
		return false, fmt.Errorf("query Docker %s existence for %q: %w: %s", kind, id, err, strings.TrimSpace(string(output)))
	}
	for _, line := range strings.Fields(string(output)) {
		if kind == ResourceVolume {
			if line == id {
				return true, nil
			}
			continue
		}
		return true, nil
	}
	return false, nil
}

func dockerRemove(args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), composeCleanupBound())
	defer cancel()
	out, err := dockerCommand(ctx, args...)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return &DockerCleanupStallError{Message: fmt.Sprintf("stalled Docker cleanup (docker %s) exceeded %s: %s", strings.Join(args, " "), composeCleanupBound(), strings.TrimSpace(string(out))), Cause: err}
		}
		return fmt.Errorf("docker %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func cleanupCompose(resource Resource) ([]ResourceCleanupStep, error) {
	var failures []error
	steps := make([]ResourceCleanupStep, 0, 2)
	args := []string{"-p", resource.ID}
	for _, file := range resource.Files {
		args = append(args, "-f", file)
	}
	args = append(args, "down", "-v", "--remove-orphans", "--timeout", strconv.Itoa(int(composeStopTimeout/time.Second)))
	downErr := composeRemove(resource.ComposePrefix, composeCleanupBound(), args...)
	if downErr != nil {
		downErr = fmt.Errorf("Compose down failed: %w", downErr)
		failures = append(failures, downErr)
		steps = append(steps, ResourceCleanupStep{Name: "down", Outcome: ResourceFailed, Error: downErr.Error()})
	} else {
		steps = append(steps, ResourceCleanupStep{Name: "down", Outcome: ResourceRemoved})
	}
	var sweepFailures []error
	for _, kind := range []string{"container", "network", "volume"} {
		args := []string{"--filter", "label=com.docker.compose.project=" + resource.ID}
		if kind == "container" {
			args = append([]string{"ps", "-aq"}, args...)
		} else if kind == "network" {
			args = append([]string{"network", "ls", "-q"}, args...)
		} else {
			args = append([]string{"volume", "ls", "-q"}, args...)
		}
		ctx, cancel := context.WithTimeout(context.Background(), composeCleanupBound())
		ids, err := dockerCommand(ctx, args...)
		cancel()
		if err != nil {
			sweepFailures = append(sweepFailures, fmt.Errorf("list compose project %s %ss: %w: %s", resource.ID, kind, err, strings.TrimSpace(string(ids))))
			continue
		}
		for _, id := range strings.Fields(string(ids)) {
			if kind == "volume" && containsString(resource.ProtectedVolumes, id) {
				continue
			}
			remove := []string{"rm", "-f", id}
			if kind == "network" {
				remove = []string{"network", "rm", id}
			} else if kind == "volume" {
				remove = []string{"volume", "rm", id}
			}
			if err := dockerRemove(remove...); err != nil {
				sweepFailures = append(sweepFailures, fmt.Errorf("remove labeled compose %s %q: %w", kind, id, err))
			}
		}
	}
	if len(sweepFailures) > 0 {
		sweepErr := errors.Join(sweepFailures...)
		failures = append(failures, fmt.Errorf("forced label sweep failed: %w", sweepErr))
		steps = append(steps, ResourceCleanupStep{Name: "label-sweep", Outcome: ResourceFailed, Error: sweepErr.Error()})
	} else {
		steps = append(steps, ResourceCleanupStep{Name: "label-sweep", Outcome: ResourceRemoved})
	}
	return steps, errors.Join(failures...)
}

func composeRemove(prefix []string, timeout time.Duration, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := composeCommand(ctx, prefix, args...)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return &DockerCleanupStallError{Message: fmt.Sprintf("stalled Docker cleanup (%s %s) exceeded %s: %s", strings.Join(prefix, " "), strings.Join(args, " "), timeout, strings.TrimSpace(string(out))), Cause: err}
		}
		return fmt.Errorf("%s %s: %w: %s", strings.Join(prefix, " "), strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func removeOwnedPath(stateDir, runID string, resource Resource) error {
	var additionalRoots []string
	if runID != "" {
		scratch, err := runScratchPath(runID)
		if err != nil {
			return err
		}
		additionalRoots = []string{scratch}
	}
	return removeOwnedPathRelative(stateDir, resource.ID, fileIdentity{Device: resource.Device, Inode: resource.Inode}, resource.ownerToken, additionalRoots)
}

func removeCreatedPath(stateDir, runID, path string, identity fileIdentity) error {
	var additionalRoots []string
	if runID != "" {
		scratch, err := runScratchPath(runID)
		if err != nil {
			return err
		}
		additionalRoots = []string{scratch}
	}
	err := removeOwnedPathRelative(stateDir, path, identity, "", additionalRoots)
	if errors.Is(err, errOwnedPathAlreadyGone) {
		return nil
	}
	return err
}

func containsString(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

func GarbageCollect(stateDir string) ([]ResourceOutcome, error) {
	var all []ResourceOutcome
	err := withStateLock(stateDir, func() error {
		if err := pruneStateLocked(stateDir); err != nil {
			return err
		}
		records, err := readAllRecordsLocked(stateDir)
		if err != nil {
			return err
		}
		for _, rec := range records {
			if rec.Status != StatusDirty && rec.Status != StatusLost {
				continue
			}
			outcomes, err := cleanupResourcesLocked(stateDir, rec.RunID)
			if err != nil {
				return err
			}
			if rec.Scratch != "" {
				scratchOutcome, _ := cleanupScratchOutcome(stateDir, rec.Scratch, fileIdentity{Device: rec.ScratchDevice, Inode: rec.ScratchInode}, rec.Keep)
				outcomes = append(outcomes, scratchOutcome)
				if err := appendResourceOutcomeLocked(stateDir, rec.RunID, scratchOutcome); err != nil {
					return fmt.Errorf("persist scratch cleanup outcome: %w", err)
				}
			}
			all = append(all, outcomes...)
			failed := false
			for _, outcome := range outcomes {
				if outcome.Outcome == ResourceFailed || outcome.Outcome == ResourceRefused {
					failed = true
				}
			}
			stored, err := readRecordLocked(stateDir, rec.RunID)
			if err != nil {
				return err
			}
			stored.Resources, err = readRunResources(stateDir, rec.RunID)
			if err != nil {
				return err
			}
			if failed {
				stored.Status = StatusDirty
			} else {
				stored.Status = StatusDead
				stored.Error = ""
			}
			if err := writeRecordAtomic(stored); err != nil {
				return err
			}
			event := eventFor(stored, EventTeardown)
			if err := appendEvent(stateDir, event); err != nil {
				return err
			}
		}
		return nil
	})
	return all, err
}

// LeftoverEntry is the public leftovers contract: one uncleaned owned
// resource, attributed to the run that owns it. Consumers read leftovers
// through this contract instead of composing resource ledger paths.
type LeftoverEntry struct {
	RunID   string `json:"run_id"`
	Kind    string `json:"kind"`
	ID      string `json:"id"`
	Outcome string `json:"outcome"`
	Error   string `json:"error,omitempty"`
}

func Leftovers(stateDir string) ([]LeftoverEntry, error) {
	var all []LeftoverEntry
	err := withStateLock(stateDir, func() error {
		if err := pruneStateLocked(stateDir); err != nil {
			return err
		}
		records, err := readAllRecordsLocked(stateDir)
		if err != nil {
			return err
		}
		for _, rec := range records {
			entries := rec.Resources
			for _, entry := range entries {
				if entry.Outcome == ResourceFailed || entry.Outcome == ResourceRefused || entry.Outcome == ResourcePending || entry.Outcome == "" {
					all = append(all, LeftoverEntry{RunID: rec.RunID, Kind: string(entry.Kind), ID: entry.ID, Outcome: entry.Outcome, Error: entry.Error})
				}
			}
			if rec.Scratch != "" {
				unexpected, err := scratchHasUnexpected(rec.Scratch, rec.Keep)
				if err != nil {
					return err
				}
				if unexpected {
					all = append(all, LeftoverEntry{RunID: rec.RunID, Kind: "scratch", ID: rec.Scratch, Outcome: ResourceFailed, Error: "run scratch remains"})
				}
			}
		}
		return nil
	})
	return all, err
}

func scratchHasUnexpected(scratch string, keepPaths []string) (bool, error) {
	root, err := filepath.Abs(scratch)
	if err != nil {
		return false, err
	}
	info, err := os.Lstat(root)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return true, nil
	}
	kept := resolveKeepPaths(root, keepPaths)
	var inspect func(string) (bool, error)
	inspect = func(directory string) (bool, error) {
		entries, err := os.ReadDir(directory)
		if os.IsNotExist(err) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		for _, entry := range entries {
			path := filepath.Join(directory, entry.Name())
			preserved := false
			ancestor := false
			for _, keep := range kept {
				if path == keep || strings.HasPrefix(path, keep+string(filepath.Separator)) {
					preserved = true
					break
				}
				if strings.HasPrefix(keep, path+string(filepath.Separator)) {
					ancestor = true
				}
			}
			if preserved {
				continue
			}
			if ancestor && entry.IsDir() {
				unexpected, err := inspect(path)
				if err != nil || unexpected {
					return unexpected, err
				}
				continue
			}
			return true, nil
		}
		return false, nil
	}
	return inspect(root)
}

// Package versionroot owns the user's installation container, its active
// platform root, and all version-root transitions.
package versionroot

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/receipt"
)

type Layout struct{ Root string }

var ErrPlatformNotInstalled = errors.New("platform is not installed")
var ErrOwnershipPublicationConflict = errors.New("another initial install published ownership first")

type ownershipFile interface {
	Write([]byte) (int, error)
	Sync() error
	Close() error
}

type ownershipFileSystem interface {
	CreateExclusive(string, fs.FileMode) (ownershipFile, error)
	Link(string, string) error
	SyncDirectory(string) error
	Remove(string) error
}

type osOwnershipFile struct{ file *os.File }

func (f osOwnershipFile) Write(data []byte) (int, error) { return f.file.Write(data) }
func (f osOwnershipFile) Sync() error                    { return syncOwnershipFile(f.file) }
func (f osOwnershipFile) Close() error                   { return f.file.Close() }

type osOwnershipFileSystem struct{}

func (osOwnershipFileSystem) CreateExclusive(path string, mode fs.FileMode) (ownershipFile, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return nil, err
	}
	return osOwnershipFile{file: file}, nil
}
func (osOwnershipFileSystem) Link(oldPath, newPath string) error { return os.Link(oldPath, newPath) }
func (osOwnershipFileSystem) SyncDirectory(path string) error    { return syncDirectory(path) }
func (osOwnershipFileSystem) Remove(path string) error           { return os.Remove(path) }

var ownershipFS ownershipFileSystem = osOwnershipFileSystem{}

type OwnershipStagingArtifactError struct {
	Path  string
	Paths []string
	Cause error
}

func (e *OwnershipStagingArtifactError) Error() string {
	paths := e.Paths
	if len(paths) == 0 {
		paths = []string{e.Path}
	}
	return fmt.Sprintf("cannot validate ownership staging file(s) %s: %v", strings.Join(paths, ", "), e.Cause)
}

func (e *OwnershipStagingArtifactError) Unwrap() error { return e.Cause }

type OwnershipWritePoint string

const (
	OwnershipBeforeStagingCreate OwnershipWritePoint = "before-staging-create"
	OwnershipAfterStagingCreate  OwnershipWritePoint = "after-staging-create"
	OwnershipDuringStagingWrite  OwnershipWritePoint = "during-staging-write"
	OwnershipAfterStagingSync    OwnershipWritePoint = "after-staging-sync"
	OwnershipBeforePublish       OwnershipWritePoint = "before-publish"
	OwnershipAfterPublish        OwnershipWritePoint = "after-publish"
	OwnershipAfterStagingCleanup OwnershipWritePoint = "after-staging-cleanup"
)

var ownershipWriteFaultHook func(OwnershipWritePoint, string) error

type UpdateMetadata struct {
	SnapshotID string `json:"snapshotId"`
	LogPath    string `json:"logPath"`
}

type Metadata struct {
	Schema          string `json:"schema"`
	InstallationID  string `json:"installationId"`
	InitialTarget   string `json:"initialTarget,omitempty"`
	LastHealthyRoot string `json:"lastHealthyRoot,omitempty"`
	RecoveryRoot    string `json:"recoveryRoot,omitempty"`
}

type Ownership struct {
	Schema              string `json:"schema"`
	InstallationID      string `json:"installationId"`
	InitialInstallState string `json:"initialInstallState,omitempty"`
}

const LayoutMetadataSchema = "kb.create.installation-layout/v2"
const OwnershipSchema = "kb.create.installation-owner/v1"

type RetainedVersion struct {
	Version        string `json:"version"`
	Role           string `json:"role"`
	Path           string `json:"path"`
	DiskUsageBytes int64  `json:"diskUsageBytes"`
}

func New(installRoot string) (Layout, error) {
	if err := supportedOS(runtime.GOOS); err != nil {
		return Layout{}, err
	}
	abs, err := filepath.Abs(installRoot)
	if err != nil {
		return Layout{}, fmt.Errorf("resolve installation root: %w", err)
	}
	canonical, err := canonicalPath(filepath.Clean(abs))
	if err != nil {
		return Layout{}, fmt.Errorf("resolve installation root symlinks: %w", err)
	}
	return Layout{Root: canonical}, nil
}

func canonicalPath(path string) (string, error) {
	return contracts.CanonicalPath(path)
}

// IsSupportedOS reports whether the installer supports the operating system.
func IsSupportedOS(goos string) bool {
	return goos == "linux" || goos == "darwin"
}

func supportedOS(goos string) error {
	if IsSupportedOS(goos) {
		return nil
	}
	return contracts.UnsupportedPlatformDiagnostic(goos, runtime.GOARCH)
}

func (l Layout) InstallRoot() string  { return l.Root }
func (l Layout) PlatformRoot() string { return contracts.CurrentPlatformRoot(l.Root) }

// ExistingPlatformRoot resolves only a complete installed container. A
// missing, empty, or validated initial-install scaffold has no platform root;
// every other invalid shape is an error for the caller to report as an
// unsupported layout.
func (l Layout) ExistingPlatformRoot() (string, error) {
	info, err := os.Lstat(l.Root)
	if os.IsNotExist(err) {
		return "", ErrPlatformNotInstalled
	}
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("install root is not a real directory")
	}
	entries, err := os.ReadDir(l.Root)
	if err != nil {
		return "", err
	}
	if len(entries) == 0 {
		return "", ErrPlatformNotInstalled
	}
	if _, currentErr := os.Lstat(l.PlatformRoot()); os.IsNotExist(currentErr) {
		if err := l.ValidateInitialTarget(); err != nil {
			return "", err
		}
		return "", ErrPlatformNotInstalled
	} else if currentErr != nil {
		return "", currentErr
	}
	if err := l.ValidateStructure(); err != nil {
		return "", err
	}
	return l.PlatformRoot(), nil
}
func (l Layout) VersionsDir() string { return contracts.VersionRootsDirectory(l.Root) }

// CreateArtifactStaging creates private prepared-artifact storage inside the
// install container's versions directory. The returned path is owned by the
// caller and must be removed after installation or refusal.
func (l Layout) CreateArtifactStaging() (string, error) {
	if err := os.MkdirAll(l.VersionsDir(), 0o750); err != nil {
		return "", fmt.Errorf("create version roots directory: %w", err)
	}
	stage, err := os.MkdirTemp(l.VersionsDir(), ".stage-artifacts-")
	if err != nil {
		return "", fmt.Errorf("create prepared artifact staging directory: %w", err)
	}
	return stage, nil
}
func (l Layout) SharedStateDir() string    { return contracts.SharedStateDirectory(l.Root) }
func (l Layout) InstallerStateDir() string { return contracts.InstallerStateDirectory(l.Root) }
func (l Layout) HostStateDir() string      { return contracts.HostStateDirectory(l.Root) }
func (l Layout) OperationLogsDir() string {
	return contracts.InstallerRecordPath(l.Root, "operationLogs")
}
func (l Layout) FailureDossiersDir() string {
	return contracts.InstallerRecordPath(l.Root, "failureDossiers")
}
func (l Layout) SnapshotsDir() string { return contracts.InstallerRecordPath(l.Root, "snapshots") }

// ForPlatformPath maps the user-facing install root, current symlink, or a
// physical/staged version root back to the containing install root.
func ForPlatformPath(platformPath string) (Layout, error) {
	layout, err := New(platformPath)
	if err != nil {
		return Layout{}, err
	}
	for current := layout.Root; filepath.Dir(current) != current; current = filepath.Dir(current) {
		versions := filepath.Dir(current)
		container := filepath.Dir(versions)
		if filepath.Clean(contracts.VersionRootsDirectory(container)) == filepath.Clean(versions) {
			return New(container)
		}
	}
	return layout, nil
}

func (l Layout) SharedRuntimePath(platformPath string) (string, error) {
	for _, shared := range contracts.SharedRuntimeProjections() {
		if shared.PlatformPath == platformPath {
			return filepath.Join(l.Root, filepath.FromSlash(shared.StatePath)), nil
		}
	}
	return "", fmt.Errorf("platform path %q is not declared as shared runtime state", platformPath)
}

func (l Layout) PackageManagerStateDir() string {
	return contracts.PackageManagerStateDirectory(l.Root)
}

// AtomicWriteFile keeps version-root links to shared runtime files intact.
// A rename over a symlink replaces the link itself, so atomic writers must
// write beside its declared target and rename that target instead.
func AtomicWriteFile(path string, data []byte, mode fs.FileMode) error {
	return atomicWriteFile(path, data, mode, nil)
}

// AtomicWriteBoundaryHook runs after each filesystem boundary. It is used by
// store tests to inject failures while preserving the production write path.
type AtomicWriteBoundaryHook func(string) error

// AtomicWriteFileWithBoundaryHook writes with the same implementation as
// AtomicWriteFile and allows callers to inject a failure after a named boundary.
func AtomicWriteFileWithBoundaryHook(path string, data []byte, mode fs.FileMode, hook AtomicWriteBoundaryHook) error {
	return atomicWriteFile(path, data, mode, hook)
}

func atomicWriteFile(path string, data []byte, mode fs.FileMode, hook AtomicWriteBoundaryHook) error {
	failAt := func(boundary string) error {
		if hook == nil {
			return nil
		}
		return hook(boundary)
	}
	destination, err := atomicWriteDestination(path)
	if err != nil {
		return err
	}
	temporaryFile, err := os.CreateTemp(filepath.Dir(destination), "."+filepath.Base(destination)+".tmp-*")
	if err != nil {
		return err
	}
	temporary := temporaryFile.Name()
	defer os.Remove(temporary)
	if err := failAt("temporary-created"); err != nil {
		_ = temporaryFile.Close()
		return err
	}
	if err := temporaryFile.Chmod(mode); err != nil {
		_ = temporaryFile.Close()
		return err
	}
	if err := failAt("temporary-chmodded"); err != nil {
		_ = temporaryFile.Close()
		return err
	}
	if _, err := temporaryFile.Write(data); err != nil {
		_ = temporaryFile.Close()
		return err
	}
	if err := failAt("temporary-written"); err != nil {
		_ = temporaryFile.Close()
		return err
	}
	if err := errors.Join(temporaryFile.Sync(), temporaryFile.Close()); err != nil {
		return err
	}
	if err := failAt("temporary-synced-and-closed"); err != nil {
		return err
	}
	if err := os.Rename(temporary, destination); err != nil {
		return err
	}
	if err := failAt("renamed"); err != nil {
		return err
	}
	if err := syncDirectory(filepath.Dir(destination)); err != nil {
		return err
	}
	return failAt("directory-synced")
}

func atomicWriteDestination(path string) (string, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return path, nil
	}
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return path, nil
	}
	target, err := os.Readlink(path)
	if err != nil {
		return "", err
	}
	linkParent, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return "", fmt.Errorf("resolve shared runtime link parent: %w", err)
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(linkParent, target)
	}
	target = filepath.Clean(target)
	parent, err := filepath.EvalSymlinks(filepath.Dir(target))
	if err != nil {
		return "", fmt.Errorf("resolve shared runtime target: %w", err)
	}
	return filepath.Join(parent, filepath.Base(target)), nil
}

func (l Layout) metadataPath() string  { return filepath.Join(l.InstallerStateDir(), "layout.json") }
func (l Layout) ownershipPath() string { return contracts.OwnershipRecordPath(l.Root) }
func (l Layout) updateMetadataPath() string {
	return filepath.Join(l.InstallerStateDir(), "update-operation.json")
}

func (l Layout) ValidateInitialTarget() error {
	info, err := os.Lstat(l.Root)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("installation root is not a real directory")
	}
	lock, err := lockInitialRoot(l.Root)
	if err != nil {
		return err
	}
	defer lock.Close()
	entries, err := os.ReadDir(l.Root)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return nil
	}
	if _, currentErr := os.Lstat(l.PlatformRoot()); currentErr == nil {
		return l.Validate()
	} else if !os.IsNotExist(currentErr) {
		return currentErr
	}
	if err := l.validateOwnedContainerEntries(entries, true, false); err != nil {
		return err
	}
	if err := l.validatePreinstallTree(); err != nil {
		return err
	}
	owner, err := l.readOwnership()
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("read installation ownership: %w", err)
		}
		staging := ownershipStagingPaths(entries)
		if len(staging) > 0 {
			paths := make([]string, len(staging))
			for i, name := range staging {
				paths[i] = filepath.Join(l.Root, name)
			}
			return &OwnershipStagingArtifactError{Path: paths[0], Paths: paths,
				Cause: fmt.Errorf("unpublished staging files cannot prove install-root ownership; inspect and remove them before retrying")}
		}
		return fmt.Errorf("read installation ownership: %w", err)
	} else if err := l.cleanupPublishedOwnershipStaging(entries); err != nil {
		return err
	}
	if owner.InitialInstallState != "in-progress" {
		return fmt.Errorf("installation root has no valid in-progress ownership record")
	}
	// Recovery is a write. It is reached only after this same classifier has
	// validated the ownership identity, root-entry set, entry types, and tree.
	recovered, err := l.recoverInterruptedInitialActivation(owner)
	if err != nil {
		return err
	}
	if recovered {
		return nil
	}
	return nil
}

// PrepareInitialTarget is the shared write gate for pre-install state. It
// records installer ownership before a caller can persist scenario answers.
func (l Layout) PrepareInitialTarget() error {
	if err := l.ValidateInitialTarget(); err != nil {
		return err
	}
	if _, err := os.Lstat(l.PlatformRoot()); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(l.Root, 0o700); err != nil {
		return err
	}
	_, err := l.ensureOwnership()
	return err
}

func (l Layout) StageInitial() (string, error) {
	return l.stageInitial(nil)
}

func (l Layout) stageInitial(after func(HandoffPoint) error) (string, error) {
	if err := supportedOS(runtime.GOOS); err != nil {
		return "", err
	}
	if err := l.ValidateInitialTarget(); err != nil {
		return "", err
	}
	if _, err := os.Lstat(l.Root); os.IsNotExist(err) {
		if err := os.Mkdir(l.Root, 0o700); err != nil {
			return "", err
		}
	} else if err != nil {
		return "", err
	}
	if err := notifyHandoff(after, HandoffInitialRootCreated); err != nil {
		return "", err
	}
	if _, err := l.ensureOwnership(); err != nil {
		return "", err
	}
	if err := notifyHandoff(after, HandoffInitialOwnershipWritten); err != nil {
		return "", err
	}
	if err := os.MkdirAll(l.VersionsDir(), 0o700); err != nil {
		return "", err
	}
	if err := notifyHandoff(after, HandoffInitialVersionsCreated); err != nil {
		return "", err
	}
	if err := os.MkdirAll(l.SharedStateDir(), 0o700); err != nil {
		return "", err
	}
	if err := notifyHandoff(after, HandoffInitialStateCreated); err != nil {
		return "", err
	}
	if err := os.MkdirAll(l.InstallerStateDir(), 0o700); err != nil {
		return "", err
	}
	if err := notifyHandoff(after, HandoffInitialInstallerStateCreated); err != nil {
		return "", err
	}
	entries, err := os.ReadDir(l.VersionsDir())
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".stage-") && entry.IsDir() {
			if err := os.RemoveAll(filepath.Join(l.VersionsDir(), entry.Name())); err != nil {
				return "", fmt.Errorf("remove interrupted install staging tree: %w", err)
			}
		}
	}
	if err := notifyHandoff(after, HandoffInitialStaleStagesRemoved); err != nil {
		return "", err
	}
	stage, err := os.MkdirTemp(l.VersionsDir(), ".stage-")
	if err != nil {
		return "", err
	}
	if err := notifyHandoff(after, HandoffInitialStageCreated); err != nil {
		return stage, err
	}
	if err := l.prepareVersionRoot(stage, true); err != nil {
		_ = os.RemoveAll(stage)
		return "", err
	}
	if err := notifyHandoff(after, HandoffInitialStagePrepared); err != nil {
		return stage, err
	}
	return stage, nil
}

func (l Layout) ensureOwnership() (string, error) {
	lock, err := lockInitialRoot(l.Root)
	if err != nil {
		return "", err
	}
	defer lock.Close()
	if owner, err := l.readOwnership(); err == nil && owner.InstallationID != "" {
		return owner.InstallationID, nil
	} else if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	var identity [16]byte
	if _, err := rand.Read(identity[:]); err != nil {
		return "", fmt.Errorf("generate installation identity: %w", err)
	}
	owner := Ownership{Schema: OwnershipSchema, InstallationID: hex.EncodeToString(identity[:]),
		InitialInstallState: "in-progress"}
	data, err := json.Marshal(owner)
	if err != nil {
		return "", err
	}
	data = append(data, '\n')
	stagingPath := contracts.OwnershipRecordStagingPath(l.Root, owner.InstallationID)
	if err := l.ownershipWriteCheckpoint(OwnershipBeforeStagingCreate, stagingPath); err != nil {
		return "", err
	}
	file, err := ownershipFS.CreateExclusive(stagingPath, 0o600)
	if err != nil {
		if os.IsExist(err) {
			return "", &OwnershipStagingArtifactError{Path: stagingPath, Cause: fmt.Errorf("staging path already exists")}
		}
		return "", err
	}
	if err := l.ownershipWriteCheckpoint(OwnershipAfterStagingCreate, stagingPath); err != nil {
		return "", errors.Join(err, file.Close())
	}
	midpoint := len(data) / 2
	if _, err := file.Write(data[:midpoint]); err != nil {
		return "", errors.Join(err, file.Close())
	}
	if err := l.ownershipWriteCheckpoint(OwnershipDuringStagingWrite, stagingPath); err != nil {
		return "", errors.Join(err, file.Close())
	}
	if _, err := file.Write(data[midpoint:]); err != nil {
		return "", errors.Join(err, file.Close())
	}
	if err := errors.Join(file.Sync(), file.Close()); err != nil {
		return "", err
	}
	if err := l.ownershipWriteCheckpoint(OwnershipAfterStagingSync, stagingPath); err != nil {
		return "", err
	}
	if err := l.publishOwnershipStaging(stagingPath); err != nil {
		return "", err
	}
	return owner.InstallationID, nil
}

func lockInitialRoot(root string) (*os.File, error) {
	directory, err := os.Open(root)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(directory.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = directory.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, ErrOwnershipPublicationConflict
		}
		return nil, err
	}
	return directory, nil
}

func (l Layout) readOwnership() (Ownership, error) {
	return readOwnershipRecord(l.ownershipPath())
}

func readOwnershipRecord(path string) (Ownership, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Ownership{}, err
	}
	var owner Ownership
	if err := json.Unmarshal(data, &owner); err != nil {
		return Ownership{}, err
	}
	if owner.Schema != OwnershipSchema || len(owner.InstallationID) != 32 || owner.InitialInstallState != "in-progress" {
		return Ownership{}, fmt.Errorf("invalid install-root ownership record")
	}
	if _, err := hex.DecodeString(owner.InstallationID); err != nil {
		return Ownership{}, fmt.Errorf("invalid install-root ownership identity: %w", err)
	}
	return owner, nil
}

func (l Layout) ownershipWriteCheckpoint(point OwnershipWritePoint, path string) error {
	if ownershipWriteFaultHook == nil {
		return nil
	}
	return ownershipWriteFaultHook(point, path)
}

func ownershipStagingPaths(entries []os.DirEntry) []string {
	prefix := contracts.OwnershipRecordStagingPrefix()
	paths := make([]string, 0)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), prefix) {
			paths = append(paths, entry.Name())
		}
	}
	sort.Strings(paths)
	return paths
}

func (l Layout) readValidatedOwnershipStaging(name string) (Ownership, error) {
	prefix := contracts.OwnershipRecordStagingPrefix()
	if !strings.HasPrefix(name, prefix) {
		return Ownership{}, fmt.Errorf("staging filename is outside the layout contract")
	}
	installationID := strings.TrimPrefix(name, prefix)
	if len(installationID) != 32 {
		return Ownership{}, fmt.Errorf("staging filename does not contain an installation identity")
	}
	if _, err := hex.DecodeString(installationID); err != nil {
		return Ownership{}, fmt.Errorf("staging filename has an invalid installation identity: %w", err)
	}
	path := filepath.Join(l.Root, name)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return Ownership{}, fmt.Errorf("staging artifact is not a regular file")
	}
	owner, err := readOwnershipRecord(path)
	if err != nil {
		return Ownership{}, err
	}
	if owner.InstallationID != installationID {
		return Ownership{}, fmt.Errorf("staging filename and ownership identity do not match")
	}
	return owner, nil
}

func (l Layout) publishOwnershipStaging(stagingPath string) error {
	if err := l.ownershipWriteCheckpoint(OwnershipBeforePublish, stagingPath); err != nil {
		return err
	}
	if err := ownershipFS.Link(stagingPath, l.ownershipPath()); err != nil {
		if os.IsExist(err) {
			cleanupErr := ownershipFS.Remove(stagingPath)
			if cleanupErr == nil {
				cleanupErr = ownershipFS.SyncDirectory(l.Root)
			}
			return errors.Join(ErrOwnershipPublicationConflict, cleanupErr)
		}
		return err
	}
	if err := ownershipFS.SyncDirectory(l.Root); err != nil {
		return err
	}
	if err := l.ownershipWriteCheckpoint(OwnershipAfterPublish, stagingPath); err != nil {
		return err
	}
	if err := ownershipFS.Remove(stagingPath); err != nil {
		return err
	}
	if err := ownershipFS.SyncDirectory(l.Root); err != nil {
		return err
	}
	return l.ownershipWriteCheckpoint(OwnershipAfterStagingCleanup, stagingPath)
}

func (l Layout) cleanupPublishedOwnershipStaging(entries []os.DirEntry) error {
	ownerInfo, err := os.Lstat(l.ownershipPath())
	if err != nil {
		return err
	}
	for _, name := range ownershipStagingPaths(entries) {
		path := filepath.Join(l.Root, name)
		stageOwner, err := l.readValidatedOwnershipStaging(name)
		if err != nil {
			return &OwnershipStagingArtifactError{Path: path, Cause: err}
		}
		owner, err := l.readOwnership()
		if err != nil || stageOwner.InstallationID != owner.InstallationID {
			return &OwnershipStagingArtifactError{Path: path, Cause: fmt.Errorf("staging identity does not match published ownership")}
		}
		stageInfo, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if !sameValidatedOwnershipLink(ownerInfo, stageInfo) {
			return &OwnershipStagingArtifactError{Path: path, Cause: fmt.Errorf("staging file is not the sole additional link to the published ownership record")}
		}
		if err := ownershipFS.Remove(path); err != nil {
			return err
		}
		if err := ownershipFS.SyncDirectory(l.Root); err != nil {
			return err
		}
	}
	return nil
}

func sameValidatedOwnershipLink(ownerInfo, stageInfo os.FileInfo) bool {
	if !os.SameFile(ownerInfo, stageInfo) {
		return false
	}
	ownerStat, ownerOK := ownerInfo.Sys().(*syscall.Stat_t)
	stageStat, stageOK := stageInfo.Sys().(*syscall.Stat_t)
	return ownerOK && stageOK && ownerStat.Dev == stageStat.Dev && ownerStat.Ino == stageStat.Ino &&
		ownerStat.Nlink == 2 && stageStat.Nlink == 2
}

func (l Layout) hasOwnershipMarker() bool {
	_, err := os.Lstat(l.ownershipPath())
	return err == nil
}

func (l Layout) HasOwnershipMarker() bool { return l.hasOwnershipMarker() }

func InstallationIDForPath(platformRoot string) (string, error) {
	layout, err := ForPlatformPath(platformRoot)
	if err != nil {
		return "", err
	}
	owner, err := layout.readOwnership()
	if err != nil {
		return "", err
	}
	return owner.InstallationID, nil
}

// Active returns the physical root selected by the install-root current link.
func (l Layout) Active() (string, error) {
	root, err := filepath.EvalSymlinks(l.PlatformRoot())
	if err != nil {
		return "", err
	}
	return filepath.Clean(root), nil
}

// Stage creates an empty version tree populated from the target's sealed
// artifact set. Mutable state is linked once from the installation container.
func (l Layout) Stage() (string, error) {
	return l.stage(nil)
}

// StageManagedGeneration makes a disposable copy of the active version tree
// for a package-graph mutation. The caller must hold the install operation
// lock until activation or abort. Shared runtime projections are deliberately
// omitted and linked back only after the candidate is finalized.
func (l Layout) StageManagedGeneration() (string, error) {
	return l.stageManaged(nil)
}

func (l Layout) stageManaged(after func(HandoffPoint) error) (_ string, returnErr error) {
	if err := l.validateHandoffParentAndOwnership(); err != nil {
		return "", fmt.Errorf("validate managed-generation handoff owner: %w", err)
	}
	if err := l.removeStaleCurrentHandoff(); err != nil {
		return "", fmt.Errorf("remove abandoned managed-generation handoff: %w", err)
	}
	if err := l.Validate(); err != nil {
		return "", err
	}
	if err := l.removeAbandonedManagedStages(); err != nil {
		return "", fmt.Errorf("remove abandoned managed-generation stages: %w", err)
	}
	active, err := l.Active()
	if err != nil {
		return "", err
	}
	if err := l.validateVersionPath(active); err != nil {
		return "", fmt.Errorf("validate active generation before staging: %w", err)
	}
	if err := os.MkdirAll(l.VersionsDir(), 0o700); err != nil {
		return "", err
	}
	stage, err := os.MkdirTemp(l.VersionsDir(), ".stage-managed-")
	if err != nil {
		return "", err
	}
	defer func() {
		if returnErr != nil {
			if cleanupErr := os.RemoveAll(stage); cleanupErr != nil {
				returnErr = errors.Join(returnErr, fmt.Errorf("remove failed managed-generation stage: %w", cleanupErr))
			}
		}
	}()
	if err := notifyHandoff(after, HandoffManagedStageCreated); err != nil {
		return "", err
	}
	if err := copyManagedTree(active, stage); err != nil {
		return "", fmt.Errorf("copy active generation to managed stage: %w", err)
	}
	if err := notifyHandoff(after, HandoffManagedStageCopied); err != nil {
		return "", err
	}
	if err := l.validateManagedCandidateSymlinks(stage); err != nil {
		return "", fmt.Errorf("validate copied managed-generation links before writing stage metadata: %w", err)
	}
	if err := l.prepareVersionRoot(stage, false); err != nil {
		return "", err
	}
	if err := l.validateSealedVersionRoot(stage); err != nil {
		return "", fmt.Errorf("validate staged managed generation: %w", err)
	}
	if err := l.validateVersionRootSymlinks(stage); err != nil {
		return "", fmt.Errorf("validate staged managed-generation links: %w", err)
	}
	if err := l.validateManagedCandidateSymlinks(stage); err != nil {
		return "", fmt.Errorf("validate staged managed-generation containment: %w", err)
	}
	if err := notifyHandoff(after, HandoffManagedStagePrepared); err != nil {
		return "", err
	}
	return stage, nil
}

func (l Layout) validateHandoffParentAndOwnership() error {
	rootInfo, err := os.Lstat(l.Root)
	if err != nil {
		return err
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("install root is not a real directory")
	}
	entries, err := os.ReadDir(l.Root)
	if err != nil {
		return err
	}
	if err := l.validateOwnedContainerEntries(entries, false, true); err != nil {
		return err
	}
	metadata, err := l.readMetadata()
	if err != nil {
		return err
	}
	owner, err := l.readOwnership()
	if err != nil || owner.InstallationID != metadata.InstallationID {
		return fmt.Errorf("install-root ownership record does not match installer state")
	}
	relative, err := filepath.Rel(l.Root, l.InstallerStateDir())
	if err != nil || !filepath.IsLocal(relative) {
		return fmt.Errorf("installer state directory is outside the install root")
	}
	current := l.Root
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("installer state parent %s is not a real directory", current)
		}
	}
	return nil
}

// AbortManagedGeneration removes only a private managed-generation stage.
// The caller must hold the install operation lock. A finalized generation and
// the active current link are never accepted here.
func (l Layout) AbortManagedGeneration(stage string) error {
	stage, err := filepath.Abs(stage)
	if err != nil {
		return err
	}
	if !strings.HasPrefix(filepath.Base(stage), ".stage-managed-") {
		return fmt.Errorf("refusing to remove non-managed stage %q", stage)
	}
	info, err := os.Lstat(stage)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("managed stage %q is not a real directory", stage)
	}
	versions, err := filepath.EvalSymlinks(l.VersionsDir())
	if err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(stage)
	if err != nil {
		return err
	}
	inside, err := contracts.PathWithin(versions, resolved)
	if err != nil {
		return err
	}
	if !inside || filepath.Dir(resolved) != versions || !strings.HasPrefix(filepath.Base(resolved), ".stage-managed-") {
		return fmt.Errorf("managed stage %q is outside the version roots", stage)
	}
	active, err := l.Active()
	if err != nil {
		return err
	}
	if filepath.Clean(active) == filepath.Clean(resolved) {
		return fmt.Errorf("refusing to remove the active generation")
	}
	live, err := l.managedStageOwnerLive(resolved)
	if err != nil {
		return fmt.Errorf("verify managed-generation stage owner before cleanup: %w", err)
	}
	if live {
		return fmt.Errorf("refusing to remove managed-generation stage with a live Marketplace helper process group")
	}
	if err := os.RemoveAll(resolved); err != nil {
		return err
	}
	if err := l.removeManagedStageOwnerTemps(resolved); err != nil {
		return err
	}
	return syncDirectory(versions)
}

func copyManagedTree(source, target string) error {
	source, err := filepath.EvalSymlinks(source)
	if err != nil {
		return err
	}
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return err
	}
	var shared []string
	for _, projection := range contracts.SharedRuntimeProjections() {
		shared = append(shared, filepath.Clean(filepath.FromSlash(projection.PlatformPath)))
	}
	var copyEntry func(string, string, string) error
	copyEntry = func(src, dst, relative string) error {
		cleanRelative := filepath.Clean(relative)
		if cleanRelative != "." {
			for _, projection := range shared {
				if cleanRelative == projection || strings.HasPrefix(cleanRelative, projection+string(filepath.Separator)) {
					return nil
				}
			}
		}
		info, err := os.Lstat(src)
		if err != nil {
			return err
		}
		switch {
		case info.IsDir():
			if err := os.Mkdir(dst, info.Mode().Perm()); err != nil {
				return err
			}
			entries, err := os.ReadDir(src)
			if err != nil {
				return err
			}
			for _, entry := range entries {
				childRelative := entry.Name()
				if cleanRelative != "." {
					childRelative = filepath.Join(cleanRelative, entry.Name())
				}
				if err := copyEntry(filepath.Join(src, entry.Name()), filepath.Join(dst, entry.Name()), childRelative); err != nil {
					return err
				}
			}
			if err := os.Chmod(dst, info.Mode().Perm()); err != nil {
				return err
			}
			return syncDirectory(dst)
		case info.Mode()&os.ModeSymlink != 0:
			linkTarget, err := os.Readlink(src)
			if err != nil {
				return err
			}
			if filepath.IsAbs(linkTarget) {
				inside, err := contracts.PathWithin(source, filepath.Clean(linkTarget))
				if err != nil {
					return err
				}
				if inside {
					relativeTarget, err := filepath.Rel(source, linkTarget)
					if err != nil {
						return err
					}
					mappedTarget := filepath.Join(absTarget, relativeTarget)
					linkTarget, err = filepath.Rel(filepath.Dir(dst), mappedTarget)
					if err != nil {
						return err
					}
				}
			}
			return os.Symlink(linkTarget, dst)
		case info.Mode().IsRegular():
			cloned, err := cloneManagedFile(src, dst, info.Mode().Perm())
			if err != nil {
				return err
			}
			if cloned {
				return os.Chmod(dst, info.Mode().Perm())
			}
			input, err := os.Open(src)
			if err != nil {
				return err
			}
			defer input.Close()
			output, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(output, input)
			syncErr := output.Sync()
			closeErr := output.Close()
			if copyErr != nil {
				return copyErr
			}
			if syncErr != nil {
				return syncErr
			}
			if closeErr != nil {
				return closeErr
			}
			return os.Chmod(dst, info.Mode().Perm())
		default:
			return fmt.Errorf("managed generation contains unsupported filesystem entry %q", src)
		}
	}
	entries, err := os.ReadDir(source)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := copyEntry(filepath.Join(source, entry.Name()), filepath.Join(absTarget, entry.Name()), entry.Name()); err != nil {
			return err
		}
	}
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	if err := os.Chmod(absTarget, info.Mode().Perm()); err != nil {
		return err
	}
	return syncDirectory(absTarget)
}

func (l Layout) removeAbandonedManagedStages() error {
	entries, err := os.ReadDir(l.VersionsDir())
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".owner.json") || strings.Contains(entry.Name(), ".owner.json.tmp-") {
			continue
		}
		if !strings.HasPrefix(entry.Name(), ".stage-managed-") {
			continue
		}
		path := filepath.Join(l.VersionsDir(), entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("abandoned managed-generation stage %q is not a real directory", path)
		}
		live, err := l.managedStageOwnerLive(path)
		if err != nil {
			return fmt.Errorf("verify abandoned managed-generation stage owner for %q: %w", path, err)
		}
		if live {
			return fmt.Errorf("managed-generation stage %q still has a live Marketplace helper process group", path)
		}
		if err := os.RemoveAll(path); err != nil {
			return err
		}
		if err := l.removeManagedStageOwnerTemps(path); err != nil {
			return err
		}
	}
	return syncDirectory(l.VersionsDir())
}

// removeStaleCurrentHandoff may run only while the caller owns the install
// operation lock. The reserved link is written before the atomic current
// switch; after process death it is only an uncommitted handoff artifact.
func (l Layout) removeStaleCurrentHandoff() error {
	path := filepath.Join(l.InstallerStateDir(), "current-next")
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return fmt.Errorf("reserved current handoff path is not a symbolic link")
	}
	target, err := os.Readlink(path)
	if err != nil {
		return err
	}
	if filepath.IsAbs(target) {
		return fmt.Errorf("reserved current handoff link must use a relative target")
	}
	// prepareCurrentLink writes a link under installer/ that is atomically
	// moved to install-root/current, so its relative target is rooted at l.Root.
	target = filepath.Join(l.Root, target)
	inside, err := contracts.PathWithin(l.VersionsDir(), target)
	if err != nil {
		return err
	}
	if !inside {
		return fmt.Errorf("reserved current handoff link points outside managed version roots")
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	return syncDirectory(l.InstallerStateDir())
}

func (l Layout) stage(after func(HandoffPoint) error) (string, error) {
	if err := l.Validate(); err != nil {
		return "", err
	}
	if err := os.MkdirAll(l.VersionsDir(), 0o700); err != nil {
		return "", err
	}
	stage, err := os.MkdirTemp(l.VersionsDir(), ".stage-")
	if err != nil {
		return "", err
	}
	if err := notifyHandoff(after, HandoffUpdateStageCreated); err != nil {
		return stage, err
	}
	if err := l.prepareVersionRoot(stage, false); err != nil {
		_ = os.RemoveAll(stage)
		return "", err
	}
	active, err := l.Active()
	if err != nil {
		_ = os.RemoveAll(stage)
		return "", err
	}
	installed, err := receipt.Read(active)
	if err != nil {
		_ = os.RemoveAll(stage)
		return "", fmt.Errorf("read active receipt for staged update: %w", err)
	}
	if err := receipt.Write(stage, installed); err != nil {
		_ = os.RemoveAll(stage)
		return "", fmt.Errorf("seed staged receipt: %w", err)
	}
	if err := notifyHandoff(after, HandoffUpdateReceiptSeeded); err != nil {
		return stage, err
	}
	return stage, nil
}

func (l Layout) prepareVersionRoot(root string, linkSharedState bool) error {
	if err := os.MkdirAll(filepath.Join(root, ".kb", "v2"), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(root, ".kb", "v2", "platform-layout.json"), contracts.PlatformLayoutDocument(), 0o600); err != nil {
		return err
	}
	if !linkSharedState {
		return nil
	}
	for _, shared := range contracts.SharedRuntimeProjections() {
		linkPath := filepath.Join(root, filepath.FromSlash(shared.PlatformPath))
		statePath := filepath.Join(l.Root, filepath.FromSlash(shared.StatePath))
		if err := os.MkdirAll(filepath.Dir(statePath), 0o700); err != nil {
			return err
		}
		switch shared.Kind {
		case "directory":
			if err := os.MkdirAll(statePath, 0o700); err != nil {
				return err
			}
		case "file":
		default:
			return fmt.Errorf("shared runtime path %q has unsupported kind %q", shared.PlatformPath, shared.Kind)
		}
		if err := os.MkdirAll(filepath.Dir(linkPath), 0o700); err != nil {
			return err
		}
		relative, err := filepath.Rel(filepath.Dir(linkPath), statePath)
		if err != nil {
			return err
		}
		if err := os.Symlink(relative, linkPath); err != nil {
			return fmt.Errorf("link shared runtime state %s: %w", shared.PlatformPath, err)
		}
	}
	return nil
}

func (l Layout) Activate(stage, version, planHash, runningRoot string) (string, error) {
	return l.activate(stage, version, planHash, runningRoot, nil, nil)
}

func (l Layout) ActivateUpdate(stage, version, planHash, runningRoot string, metadata UpdateMetadata) (string, error) {
	return l.activate(stage, version, planHash, runningRoot, &metadata, nil)
}

// ActivateManagedGeneration commits a validated package-graph candidate by
// atomically replacing the install-root current link. The caller must hold the
// installation operation lock from StageManagedGeneration through activation;
// expectedActive prevents a stale candidate from replacing a newer generation.
func (l Layout) ActivateManagedGeneration(stage, expectedActive, runningRoot string) (string, error) {
	return l.activateManagedGeneration(stage, expectedActive, runningRoot, nil)
}

func (l Layout) activateManagedGeneration(stage, expectedActive, runningRoot string,
	after func(HandoffPoint) error) (_ string, returnErr error) {
	if err := l.Validate(); err != nil {
		return "", err
	}
	active, err := l.Active()
	if err != nil {
		return "", err
	}
	if expectedActive == "" || filepath.Clean(expectedActive) != filepath.Clean(active) {
		return "", fmt.Errorf("managed generation is stale: active root changed from %q to %q", expectedActive, active)
	}
	stage, err = filepath.Abs(stage)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(filepath.Base(stage), ".stage-managed-") {
		return "", fmt.Errorf("managed candidate %q is not an owned staging root", stage)
	}
	stageInfo, err := os.Lstat(stage)
	if err != nil {
		return "", err
	}
	if !stageInfo.IsDir() || stageInfo.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("managed candidate %q is not a real staging directory", stage)
	}
	versions, err := filepath.EvalSymlinks(l.VersionsDir())
	if err != nil {
		return "", err
	}
	inside, err := contracts.PathWithin(versions, stage)
	if err != nil {
		return "", err
	}
	if !inside || filepath.Dir(stage) != versions {
		return "", fmt.Errorf("managed candidate %q is outside the version roots", stage)
	}
	if err := l.validateSealedVersionRoot(stage); err != nil {
		return "", fmt.Errorf("validate managed candidate: %w", err)
	}
	activeReceipt, err := receipt.Read(active)
	if err != nil {
		return "", fmt.Errorf("read active generation receipt: %w", err)
	}
	candidateReceipt, err := receipt.Read(stage)
	if err != nil {
		return "", fmt.Errorf("read managed candidate receipt: %w", err)
	}
	if candidateReceipt.InstallationID != activeReceipt.InstallationID ||
		candidateReceipt.Plan.PlanHash != activeReceipt.Plan.PlanHash ||
		candidateReceipt.Plan.ServiceGraph.PlatformVersion != activeReceipt.Plan.ServiceGraph.PlatformVersion {
		return "", fmt.Errorf("managed candidate receipt does not match the active sealed platform identity")
	}
	if err := l.validateVersionRootSymlinks(stage); err != nil {
		return "", fmt.Errorf("validate managed candidate links: %w", err)
	}
	if err := l.validateManagedCandidateSymlinks(stage); err != nil {
		return "", fmt.Errorf("validate managed candidate containment: %w", err)
	}
	if err := syncManagedTree(stage); err != nil {
		return "", fmt.Errorf("sync managed candidate before finalizing: %w", err)
	}

	var idBytes [12]byte
	if _, err := rand.Read(idBytes[:]); err != nil {
		return "", fmt.Errorf("create managed-generation identity: %w", err)
	}
	target := filepath.Join(versions, "managed-"+hex.EncodeToString(idBytes[:]))
	if err := os.Rename(stage, target); err != nil {
		return "", fmt.Errorf("finalize managed generation: %w", err)
	}
	switched := false
	rollbackFailed := false
	defer func() {
		if returnErr == nil {
			return
		}
		if switched {
			link, rollbackErr := l.prepareCurrentLink(active)
			if rollbackErr == nil {
				rollbackErr = os.Rename(link, l.PlatformRoot())
				_ = os.Remove(link)
			}
			if rollbackErr == nil {
				rollbackErr = syncDirectory(l.Root)
			}
			if rollbackErr != nil {
				rollbackFailed = true
				returnErr = errors.Join(returnErr, fmt.Errorf("restore active generation after managed activation failure: %w", rollbackErr))
			}
		}
		if !rollbackFailed {
			if removeErr := os.RemoveAll(target); removeErr != nil {
				returnErr = errors.Join(returnErr, fmt.Errorf("remove failed managed generation: %w", removeErr))
			}
		}
	}()
	if err := syncDirectory(versions); err != nil {
		return "", fmt.Errorf("sync version roots after finalizing managed generation: %w", err)
	}
	if err := l.linkSharedRuntimeState(target); err != nil {
		return "", fmt.Errorf("link shared state into managed generation: %w", err)
	}
	if err := l.validateVersionTreeSymlinks(); err != nil {
		return "", fmt.Errorf("validate finalized managed generation links: %w", err)
	}
	if err := syncManagedTree(target); err != nil {
		return "", fmt.Errorf("sync finalized managed generation: %w", err)
	}
	for _, shared := range contracts.SharedRuntimeProjections() {
		statePath := filepath.Join(l.Root, filepath.FromSlash(shared.StatePath))
		sharedDir := statePath
		if shared.Kind == "file" {
			sharedDir = filepath.Dir(sharedDir)
		}
		if err := syncDirectoryChain(sharedDir, l.Root); err != nil {
			return "", fmt.Errorf("sync shared runtime projection %s: %w", shared.PlatformPath, err)
		}
	}
	if err := notifyHandoff(after, HandoffManagedTargetFinalized); err != nil {
		return "", err
	}
	link, err := l.prepareCurrentLink(target)
	if err != nil {
		return "", err
	}
	if err := notifyHandoff(after, HandoffManagedLinkPrepared); err != nil {
		_ = os.Remove(link)
		return "", err
	}
	if err := os.Rename(link, l.PlatformRoot()); err != nil {
		_ = os.Remove(link)
		return "", fmt.Errorf("switch active managed generation: %w", err)
	}
	switched = true
	if err := notifyHandoff(after, HandoffManagedLinkSwitched); err != nil {
		return "", err
	}
	if err := syncDirectory(l.Root); err != nil {
		return "", fmt.Errorf("sync installation root after managed-generation switch: %w", err)
	}
	if err := notifyHandoff(after, HandoffManagedBeforeRetention); err != nil {
		return "", err
	}
	if err := l.RetainManagedGeneration(active, runningRoot); err != nil {
		return "", fmt.Errorf("retain managed generations: %w", err)
	}
	return target, nil
}

type HandoffPoint string

const (
	HandoffInitialRootCreated           HandoffPoint = "initial-root-created"
	HandoffInitialOwnershipWritten      HandoffPoint = "initial-ownership-written"
	HandoffInitialVersionsCreated       HandoffPoint = "initial-versions-created"
	HandoffInitialStateCreated          HandoffPoint = "initial-state-created"
	HandoffInitialInstallerStateCreated HandoffPoint = "initial-installer-state-created"
	HandoffInitialStaleStagesRemoved    HandoffPoint = "initial-stale-stages-removed"
	HandoffInitialStageCreated          HandoffPoint = "initial-stage-created"
	HandoffInitialStagePrepared         HandoffPoint = "initial-stage-prepared"
	HandoffInitialMetadataWritten       HandoffPoint = "initial-metadata-written"
	HandoffInitialTargetFinalized       HandoffPoint = "initial-target-finalized"
	HandoffInitialLinkPrepared          HandoffPoint = "initial-link-prepared"
	HandoffInitialLinkSwitched          HandoffPoint = "initial-link-switched"
	HandoffUpdateStageCreated           HandoffPoint = "update-stage-created"
	HandoffUpdateReceiptSeeded          HandoffPoint = "update-receipt-seeded"
	HandoffMetadataWritten              HandoffPoint = "metadata-written"
	HandoffTargetFinalized              HandoffPoint = "target-finalized"
	HandoffLinkPrepared                 HandoffPoint = "link-prepared"
	HandoffLinkSwitched                 HandoffPoint = "link-switched"
	HandoffBeforeActiveRootSync         HandoffPoint = "before-active-root-sync"
	HandoffBeforeUpdateRecoveryWrite    HandoffPoint = "before-update-recovery-write"
	HandoffBeforeVersionRetention       HandoffPoint = "before-version-retention"
	HandoffManagedStageCreated          HandoffPoint = "managed-stage-created"
	HandoffManagedStageCopied           HandoffPoint = "managed-stage-copied"
	HandoffManagedStagePrepared         HandoffPoint = "managed-stage-prepared"
	HandoffManagedTargetFinalized       HandoffPoint = "managed-target-finalized"
	HandoffManagedLinkPrepared          HandoffPoint = "managed-link-prepared"
	HandoffManagedLinkSwitched          HandoffPoint = "managed-link-switched"
	HandoffManagedBeforeRetention       HandoffPoint = "managed-before-retention"
)

// CrashPoints is the ordered source of truth for on-disk install/update
// handoffs. Tests must iterate this list so adding a handoff point adds a
// required recovery regression.
func CrashPoints() []HandoffPoint {
	return []HandoffPoint{
		HandoffInitialRootCreated, HandoffInitialOwnershipWritten, HandoffInitialVersionsCreated,
		HandoffInitialStateCreated, HandoffInitialInstallerStateCreated, HandoffInitialStaleStagesRemoved,
		HandoffInitialStageCreated, HandoffInitialStagePrepared, HandoffInitialMetadataWritten,
		HandoffInitialTargetFinalized, HandoffInitialLinkPrepared, HandoffInitialLinkSwitched,
		HandoffUpdateStageCreated, HandoffUpdateReceiptSeeded, HandoffMetadataWritten,
		HandoffTargetFinalized, HandoffLinkPrepared, HandoffBeforeActiveRootSync,
		HandoffLinkSwitched, HandoffBeforeUpdateRecoveryWrite, HandoffBeforeVersionRetention,
		HandoffManagedStageCreated, HandoffManagedStageCopied, HandoffManagedStagePrepared,
		HandoffManagedTargetFinalized, HandoffManagedLinkPrepared, HandoffManagedLinkSwitched,
		HandoffManagedBeforeRetention,
	}
}

func notifyHandoff(after func(HandoffPoint) error, point HandoffPoint) error {
	if after == nil {
		return nil
	}
	return after(point)
}

func (l Layout) activate(stage, version, planHash, runningRoot string, updateMetadata *UpdateMetadata,
	after func(HandoffPoint) error) (activeRecoveryRoot string, returnErr error) {
	switched := false
	previous := ""
	var target string
	var err error
	defer func() {
		if returnErr == nil || !switched {
			return
		}
		link, rollbackErr := l.prepareCurrentLink(previous)
		if rollbackErr == nil {
			rollbackErr = os.Rename(link, l.PlatformRoot())
			_ = os.Remove(link)
		}
		if rollbackErr == nil {
			rollbackErr = syncDirectory(l.Root)
		}
		if rollbackErr == nil {
			rollbackErr = os.RemoveAll(target)
		}
		if rollbackErr != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("restore active version after activation failure: %w", rollbackErr))
		}
	}()
	if err := l.Validate(); err != nil {
		return "", err
	}
	if err := l.validateSealedVersionRoot(stage); err != nil {
		return "", err
	}
	var previousUpdateMetadata []byte
	updateMetadataExists := false
	updateMetadataWritten := false
	if updateMetadata != nil {
		previousUpdateMetadata, returnErr = os.ReadFile(l.updateMetadataPath())
		if returnErr == nil {
			updateMetadataExists = true
		} else if !os.IsNotExist(returnErr) {
			return "", fmt.Errorf("read previous update recovery record: %w", returnErr)
		}
		defer func() {
			if returnErr == nil || !updateMetadataWritten {
				return
			}
			var restoreErr error
			if updateMetadataExists {
				restoreErr = l.writeUpdateMetadataBytes(previousUpdateMetadata)
			} else if err := os.Remove(l.updateMetadataPath()); err != nil && !os.IsNotExist(err) {
				restoreErr = err
			}
			if restoreErr != nil {
				returnErr = errors.Join(returnErr, fmt.Errorf("restore previous update recovery record: %w", restoreErr))
			}
		}()
	}
	previous, err = l.Active()
	if err != nil {
		return "", err
	}
	metadata, err := l.readMetadata()
	if err != nil {
		return "", err
	}
	recovery := metadata.LastHealthyRoot
	if recovery == "" {
		recovery = metadata.RecoveryRoot
	}
	if recovery == "" {
		recovery = previous
	}
	if err := l.validateVersionPath(recovery); err != nil {
		return "", fmt.Errorf("recovery root is unavailable: %w", err)
	}
	metadata.RecoveryRoot = recovery
	if err := l.writeMetadata(metadata); err != nil {
		return "", fmt.Errorf("record recovery root: %w", err)
	}
	if after != nil {
		if err := after(HandoffMetadataWritten); err != nil {
			return recovery, err
		}
	}
	target = filepath.Join(l.VersionsDir(), versionKey(version, planHash))
	if _, err := os.Lstat(target); err == nil {
		installed, readErr := receipt.Read(target)
		if readErr != nil || installed.Plan.ServiceGraph.PlatformVersion != version || installed.Plan.PlanHash != planHash {
			return "", fmt.Errorf("version root already exists and is not a recoverable interrupted update: %s", target)
		}
		if filepath.Clean(target) == filepath.Clean(previous) || filepath.Clean(target) == filepath.Clean(recovery) || filepath.Clean(target) == filepath.Clean(runningRoot) {
			return "", fmt.Errorf("version root already exists and is retained for recovery: %s", target)
		}
		if err := os.RemoveAll(target); err != nil {
			return "", fmt.Errorf("remove interrupted target version root: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.Rename(stage, target); err != nil {
		return "", fmt.Errorf("finalize staged version root: %w", err)
	}
	if err := l.linkSharedRuntimeState(target); err != nil {
		return recovery, fmt.Errorf("link shared runtime state during activation: %w", err)
	}
	if after != nil {
		if err := after(HandoffTargetFinalized); err != nil {
			return recovery, err
		}
	}
	link, err := l.prepareCurrentLink(target)
	if err != nil {
		_ = os.RemoveAll(target)
		return "", err
	}
	if after != nil {
		if err := after(HandoffLinkPrepared); err != nil {
			_ = os.Remove(link)
			return recovery, err
		}
	}
	if err := os.Rename(link, l.PlatformRoot()); err != nil {
		_ = os.Remove(link)
		_ = os.RemoveAll(target)
		return "", fmt.Errorf("switch active version: %w", err)
	}
	switched = true
	if after != nil {
		if err := after(HandoffBeforeActiveRootSync); err != nil {
			return recovery, err
		}
	}
	if err := syncDirectory(l.Root); err != nil {
		return recovery, fmt.Errorf("sync installation root after switch: %w", err)
	}
	if after != nil {
		if err := after(HandoffLinkSwitched); err != nil {
			return recovery, err
		}
	}
	if updateMetadata != nil {
		if after != nil {
			if err := after(HandoffBeforeUpdateRecoveryWrite); err != nil {
				return recovery, err
			}
		}
		updateMetadataWritten = true
		if err := l.writeUpdateMetadata(*updateMetadata); err != nil {
			return recovery, fmt.Errorf("write update recovery record during activation: %w", err)
		}
	}
	if after != nil {
		if err := after(HandoffBeforeVersionRetention); err != nil {
			return recovery, err
		}
	}
	if err := l.Retain(runningRoot); err != nil {
		return recovery, fmt.Errorf("prune obsolete version roots: %w", err)
	}
	return recovery, nil
}

func (l Layout) validateSealedVersionRoot(stage string) error {
	absolute, err := filepath.Abs(stage)
	if err != nil {
		return fmt.Errorf("resolve staged version root: %w", err)
	}
	inside, err := contracts.PathWithin(l.VersionsDir(), absolute)
	if err != nil {
		return fmt.Errorf("resolve staged version containment: %w", err)
	}
	if !inside {
		return fmt.Errorf("staged version root is outside the declared version roots")
	}
	return ValidateNoSharedRuntimeProjectionEntries(absolute)
}

// ValidateNoSharedRuntimeProjectionEntries enforces the shared-state absence
// contract for a version tree before it is sealed or inspected for activation.
func ValidateNoSharedRuntimeProjectionEntries(root string) error {
	for _, shared := range contracts.SharedRuntimeProjections() {
		path := filepath.Join(root, filepath.FromSlash(shared.PlatformPath))
		if _, err := os.Lstat(path); err == nil {
			return fmt.Errorf("staged version root contains shared runtime state at %s", shared.PlatformPath)
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("inspect staged shared runtime path %s: %w", shared.PlatformPath, err)
		}
	}
	return nil
}

func (l Layout) prepareCurrentLink(target string) (string, error) {
	directory := l.InstallerStateDir()
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(directory, "current-next")
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSymlink == 0 {
			return "", fmt.Errorf("reserved current handoff path is not a symbolic link")
		}
		if err := os.Remove(path); err != nil {
			return "", err
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	relative, err := filepath.Rel(l.Root, target)
	if err != nil {
		return "", err
	}
	if err := os.Symlink(relative, path); err != nil {
		return "", fmt.Errorf("prepare relative current link: %w", err)
	}
	if err := syncDirectory(directory); err != nil {
		_ = os.Remove(path)
		return "", err
	}
	return path, nil
}

func (l Layout) linkSharedRuntimeState(root string) error {
	for _, shared := range contracts.SharedRuntimeProjections() {
		linkPath := filepath.Join(root, filepath.FromSlash(shared.PlatformPath))
		statePath := filepath.Join(l.Root, filepath.FromSlash(shared.StatePath))
		if err := os.MkdirAll(filepath.Dir(statePath), 0o700); err != nil {
			return err
		}
		switch shared.Kind {
		case "directory":
			if err := os.MkdirAll(statePath, 0o700); err != nil {
				return err
			}
		case "file":
		default:
			return fmt.Errorf("shared runtime path %q has unsupported kind %q", shared.PlatformPath, shared.Kind)
		}
		if err := os.MkdirAll(filepath.Dir(linkPath), 0o700); err != nil {
			return err
		}
		relative, err := filepath.Rel(filepath.Dir(linkPath), statePath)
		if err != nil {
			return err
		}
		if err := os.Symlink(relative, linkPath); err != nil {
			return fmt.Errorf("link shared runtime state %s: %w", shared.PlatformPath, err)
		}
	}
	return nil
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	return errors.Join(directory.Sync(), directory.Close())
}

func syncManagedTree(root string) error {
	var directories []string
	err := filepath.WalkDir(root, func(path string, _ os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.IsDir() {
			directories = append(directories, path)
			return nil
		}
		if info.Mode().IsRegular() {
			file, err := os.Open(path)
			if err != nil {
				return err
			}
			return errors.Join(file.Sync(), file.Close())
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		return fmt.Errorf("managed generation contains unsupported filesystem entry %q", path)
	})
	if err != nil {
		return err
	}
	for index := len(directories) - 1; index >= 0; index-- {
		if err := syncDirectory(directories[index]); err != nil {
			return err
		}
	}
	return nil
}

func syncDirectoryChain(path, stop string) error {
	canonicalStop, err := filepath.EvalSymlinks(stop)
	if err != nil {
		return err
	}
	canonicalPath, err := contracts.CanonicalPath(path)
	if err != nil {
		return err
	}
	inside, err := contracts.PathWithin(canonicalStop, canonicalPath)
	if err != nil {
		return err
	}
	if !inside {
		return fmt.Errorf("directory %q is outside sync boundary %q", canonicalPath, canonicalStop)
	}
	for current := canonicalPath; ; current = filepath.Dir(current) {
		if err := syncDirectory(current); err != nil {
			return err
		}
		if current == canonicalStop {
			return nil
		}
	}
}

func (l Layout) ActivateInitial(stage, version, planHash string) (string, error) {
	return l.activateInitial(stage, version, planHash, nil)
}

func (l Layout) activateInitial(stage, version, planHash string, after func(HandoffPoint) error) (string, error) {
	if err := supportedOS(runtime.GOOS); err != nil {
		return "", err
	}
	if err := l.ValidateInitialTarget(); err != nil {
		return "", err
	}
	if info, err := os.Lstat(l.Root); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("installation root changed before activation")
	}
	entries, err := os.ReadDir(l.Root)
	if err != nil {
		return "", err
	}
	if err := l.validateOwnedContainerEntries(entries, true, false); err != nil {
		return "", err
	}
	if err := os.MkdirAll(l.Root, 0o700); err != nil {
		return "", err
	}
	if err := os.MkdirAll(l.VersionsDir(), 0o700); err != nil {
		return "", err
	}
	if err := os.MkdirAll(l.SharedStateDir(), 0o700); err != nil {
		return "", err
	}
	if err := os.MkdirAll(l.InstallerStateDir(), 0o700); err != nil {
		return "", err
	}
	installed, err := receipt.Read(stage)
	if err != nil {
		return "", fmt.Errorf("read initial receipt: %w", err)
	}
	if installed.InstallationID == "" {
		return "", fmt.Errorf("initial receipt has no installation identity")
	}
	owner, err := l.readOwnership()
	if err != nil || owner.InstallationID != installed.InstallationID {
		return "", fmt.Errorf("initial receipt identity does not match the install-root ownership record")
	}
	target := filepath.Join(l.VersionsDir(), versionKey(version, planHash))
	metadata := Metadata{Schema: LayoutMetadataSchema, InstallationID: installed.InstallationID,
		InitialTarget: filepath.Base(target)}
	if err := l.writeMetadata(metadata); err != nil {
		return "", err
	}
	if after != nil {
		if err := after(HandoffInitialMetadataWritten); err != nil {
			return "", err
		}
	}
	if _, err := os.Lstat(target); err == nil {
		return "", fmt.Errorf("initial version root already exists: %s", target)
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.Rename(stage, target); err != nil {
		return "", err
	}
	if after != nil {
		if err := after(HandoffInitialTargetFinalized); err != nil {
			return "", err
		}
	}
	link, err := l.prepareCurrentLink(target)
	if err != nil {
		_ = os.RemoveAll(target)
		return "", err
	}
	if after != nil {
		if err := after(HandoffInitialLinkPrepared); err != nil {
			_ = os.Remove(link)
			return "", err
		}
	}
	if err := os.Rename(link, l.PlatformRoot()); err != nil {
		_ = os.Remove(link)
		_ = os.RemoveAll(target)
		return "", err
	}
	if err := syncDirectory(l.Root); err != nil {
		return "", err
	}
	if after != nil {
		if err := after(HandoffInitialLinkSwitched); err != nil {
			return target, err
		}
	}
	return target, nil
}

func (l Layout) recoverInterruptedInitialActivation(owner Ownership) (bool, error) {
	if _, err := os.Lstat(l.PlatformRoot()); err == nil {
		return false, nil
	} else if !os.IsNotExist(err) {
		return false, err
	}
	metadata, err := l.readMetadata()
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read interrupted install identity: %w", err)
	}
	if metadata.InitialTarget == "" || filepath.Base(metadata.InitialTarget) != metadata.InitialTarget {
		return false, nil
	}
	if owner.InitialInstallState != "in-progress" || metadata.InstallationID != owner.InstallationID {
		return false, fmt.Errorf("interrupted install identity does not match the validated ownership record")
	}
	target := filepath.Join(l.VersionsDir(), metadata.InitialTarget)
	if _, err := os.Lstat(target); os.IsNotExist(err) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	if err := l.validateVersionPath(target); err != nil {
		return false, fmt.Errorf("interrupted install target is incomplete: %w", err)
	}
	installed, err := receipt.Read(target)
	if err != nil || installed.InstallationID != metadata.InstallationID {
		return false, fmt.Errorf("interrupted install target identity does not match installer state")
	}
	contract, err := os.ReadFile(filepath.Join(target, ".kb", "v2", "platform-layout.json"))
	if err != nil || !bytes.Equal(contract, contracts.PlatformLayoutDocument()) {
		return false, fmt.Errorf("interrupted install target does not contain the declared platform layout")
	}
	link, err := l.prepareCurrentLink(target)
	if err != nil {
		return false, err
	}
	if err := os.Rename(link, l.PlatformRoot()); err != nil {
		_ = os.Remove(link)
		return false, err
	}
	if err := syncDirectory(l.Root); err != nil {
		return false, err
	}
	return true, nil
}

func (l Layout) validateOwnedContainerEntries(entries []os.DirEntry, rejectForeign, requireAll bool) error {
	kinds := contracts.OwnedInstallEntryKinds()
	present := make(map[string]bool, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		kind, declared := kinds[name]
		if !declared {
			if rejectForeign && strings.HasPrefix(name, contracts.OwnershipRecordStagingPrefix()) {
				info, err := os.Lstat(filepath.Join(l.Root, name))
				if err != nil || !info.Mode().IsRegular() {
					return &OwnershipStagingArtifactError{Path: filepath.Join(l.Root, name), Cause: fmt.Errorf("staging artifact is not a regular file")}
				}
				continue
			}
			if rejectForeign {
				return fmt.Errorf("installation root contains undeclared data at %s", name)
			}
			continue
		}
		present[name] = true
		if err := validatePathKind(filepath.Join(l.Root, name), kind, kind == "symlink"); err != nil {
			return err
		}
	}
	if requireAll {
		for entry := range kinds {
			if !present[entry] {
				return fmt.Errorf("installation root is missing declared entry %s", entry)
			}
		}
	}
	return nil
}

func validatePathKind(path, kind string, validateCurrentTarget bool) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	switch kind {
	case "directory":
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("declared install directory %s is not a real directory", path)
		}
	case "file":
		if !info.Mode().IsRegular() {
			return fmt.Errorf("declared install file %s is not a regular file", path)
		}
	case "symlink":
		if info.Mode()&os.ModeSymlink == 0 {
			return fmt.Errorf("declared install link %s is not a symbolic link", path)
		}
		if validateCurrentTarget {
			target, err := os.Readlink(path)
			if err != nil || filepath.IsAbs(target) {
				return fmt.Errorf("install-root current link must use a relative target")
			}
		}
	default:
		return fmt.Errorf("unsupported install-root entry kind %q", kind)
	}
	return nil
}

func (l Layout) validatePreinstallTree() error {
	entries, err := os.ReadDir(l.Root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		path := filepath.Join(l.Root, entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.IsDir() {
			var treeErr error
			if entry.Name() == filepath.Base(l.VersionsDir()) {
				treeErr = l.validateVersionTreeSymlinks()
			} else if path == l.SharedStateDir() {
				treeErr = l.validateSharedStateSymlinks(path)
			} else {
				treeErr = validateNoSymlinks(path)
			}
			if treeErr != nil {
				return treeErr
			}
		}
	}
	return l.validateContractStatePaths()
}

func validateNoSymlinks(root string) error {
	return validateContainerSymlinks(root, "", nil)
}

func (l Layout) validateSharedStateSymlinks(root string) error {
	return validateContainerSymlinks(root, l.Root, contracts.PackageManagerStateDirectories(l.Root))
}

func validateContainerSymlinks(root, installRoot string, packageManagerStateRoots []string) error {
	return filepath.WalkDir(root, func(path string, _ os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			insidePackageManager := false
			for _, packageManagerStateRoot := range packageManagerStateRoots {
				insidePackageManager, err = contracts.PathWithin(packageManagerStateRoot, filepath.Dir(path))
				if err != nil {
					return err
				}
				if insidePackageManager {
					break
				}
			}
			if insidePackageManager {
				linkTarget, err := os.Readlink(path)
				if err != nil {
					return fmt.Errorf("install container package-manager symlink target cannot be resolved at %s: %w", path, err)
				}
				if !filepath.IsAbs(linkTarget) {
					linkTarget = filepath.Join(filepath.Dir(path), linkTarget)
				}
				// The package manager owns the contents of its state roots, including
				// stale project registrations, which pnpm prunes itself. The container
				// guarantee here is only that no link resolves outside the install root.
				resolvedTarget, err := canonicalPath(filepath.Clean(linkTarget))
				if err != nil {
					return fmt.Errorf("install container package-manager symlink target cannot be resolved at %s: %w", path, err)
				}
				inside, err := contracts.PathWithin(installRoot, resolvedTarget)
				if err != nil {
					return err
				}
				if !inside {
					return fmt.Errorf("install container package-manager symlink target escapes install root: %s -> %s", path, resolvedTarget)
				}
				return nil
			}
			return fmt.Errorf("install container cannot contain a symbolic link at %s", path)
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return fmt.Errorf("install container entry %s is not a regular file or directory", path)
		}
		return nil
	})
}

func (l Layout) validateVersionTreeSymlinks() error {
	return l.validateVersionSymlinkTree(l.VersionsDir(), true)
}

func (l Layout) validateVersionRootSymlinks(root string) error {
	return l.validateVersionSymlinkTree(root, false)
}

// validateManagedCandidateSymlinks prevents package-manager mutations from
// traversing out of the physical candidate tree into another generation or
// shared install state. Shared projections are linked only after this check.
func (l Layout) validateManagedCandidateSymlinks(root string) error {
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	return filepath.WalkDir(canonicalRoot, func(path string, _ os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink == 0 {
			return nil
		}
		linkTarget, err := os.Readlink(path)
		if err != nil {
			return err
		}
		if err := resolveManagedCandidateLink(canonicalRoot, filepath.Dir(path), linkTarget); err != nil {
			return fmt.Errorf("resolve managed candidate link %s: %w", path, err)
		}
		return nil
	})
}

func resolveManagedCandidateLink(root, parent, target string) error {
	if filepath.IsAbs(target) {
		return fmt.Errorf("absolute symbolic-link targets are not allowed in a managed generation")
	}
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	current, err := filepath.EvalSymlinks(parent)
	if err != nil {
		return err
	}
	if !managedPathWithin(canonicalRoot, current) {
		return fmt.Errorf("symbolic-link parent resolves outside the candidate generation")
	}
	queue := strings.Split(target, string(filepath.Separator))
	linksFollowed := 0
	for len(queue) > 0 {
		component := queue[0]
		queue = queue[1:]
		switch component {
		case "", ".":
			continue
		case "..":
			current = filepath.Dir(current)
			if !managedPathWithin(canonicalRoot, current) {
				return fmt.Errorf("symbolic-link traversal escapes the candidate generation")
			}
			continue
		}
		next := filepath.Join(current, component)
		info, err := os.Lstat(next)
		if os.IsNotExist(err) {
			return fmt.Errorf("symbolic-link target is dangling at %s", next)
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			linksFollowed++
			if linksFollowed > 40 {
				return fmt.Errorf("symbolic-link target exceeds the resolution limit")
			}
			linkTarget, err := os.Readlink(next)
			if err != nil {
				return err
			}
			if filepath.IsAbs(linkTarget) {
				return fmt.Errorf("absolute symbolic-link targets are not allowed in a managed generation")
			}
			queue = append(strings.Split(linkTarget, string(filepath.Separator)), queue...)
			continue
		}
		if len(queue) > 0 && !info.IsDir() {
			return fmt.Errorf("symbolic-link traversal passes through non-directory %s", next)
		}
		current = next
		if !managedPathWithin(canonicalRoot, current) {
			return fmt.Errorf("symbolic-link traversal escapes the candidate generation")
		}
	}
	return nil
}

func managedPathWithin(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && filepath.IsLocal(relative)
}

func (l Layout) validateVersionSymlinkTree(root string, skipManagedStages bool) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if skipManagedStages && path != root && filepath.Dir(path) == root && entry.IsDir() &&
			strings.HasPrefix(entry.Name(), ".stage-managed-") {
			return filepath.SkipDir
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink == 0 {
			if !info.IsDir() && !info.Mode().IsRegular() {
				return fmt.Errorf("version tree entry %s is not a regular file or directory", path)
			}
			return nil
		}
		linkTarget, err := os.Readlink(path)
		if err != nil {
			return err
		}
		target := linkTarget
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(path), target)
		}
		target = filepath.Clean(target)
		if inside, err := contracts.PathWithin(l.Root, target); err != nil {
			return err
		} else if !inside {
			return fmt.Errorf("version tree symbolic link %s escapes the install root", path)
		}
		if resolvedParent, err := filepath.EvalSymlinks(filepath.Dir(target)); err == nil {
			if inside, err := contracts.PathWithin(l.Root, resolvedParent); err != nil {
				return err
			} else if !inside {
				return fmt.Errorf("version tree symbolic link %s escapes the install root", path)
			}
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("resolve version tree symbolic link parent %s: %w", path, err)
		}
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			if inside, err := contracts.PathWithin(l.Root, resolved); err != nil {
				return err
			} else if !inside {
				return fmt.Errorf("version tree symbolic link %s escapes the install root", path)
			}
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("resolve version tree symbolic link %s: %w", path, err)
		}
		return nil
	})
}

func (l Layout) validateContractStatePaths() error {
	check := func(relative, kind string) error {
		path := filepath.Join(l.Root, filepath.FromSlash(relative))
		info, err := os.Lstat(path)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("declared install state path %s cannot be a symbolic link", relative)
		}
		if (kind == "directory" && !info.IsDir()) || (kind == "file" && !info.Mode().IsRegular()) {
			return fmt.Errorf("declared install state path %s has the wrong filesystem type", relative)
		}
		return nil
	}
	for _, shared := range contracts.SharedRuntimeProjections() {
		if err := check(shared.StatePath, shared.Kind); err != nil {
			return err
		}
	}
	for _, path := range contracts.InstallerRecordDirectories(l.Root) {
		relative, err := filepath.Rel(l.Root, path)
		if err != nil {
			return err
		}
		if err := check(filepath.ToSlash(relative), "directory"); err != nil {
			return err
		}
	}
	return nil
}

func (l Layout) Validate() error {
	if err := l.ValidateStructure(); err != nil {
		return err
	}
	metadata, err := l.readMetadata()
	if err != nil {
		return err
	}
	active, err := l.Active()
	if err != nil {
		return err
	}
	installed, err := receipt.Read(active)
	if err != nil {
		return fmt.Errorf("read active version receipt: %w", err)
	}
	if metadata.InstallationID == "" || installed.InstallationID != metadata.InstallationID {
		return fmt.Errorf("active receipt installation identity does not match the install-root identity")
	}
	owner, err := l.readOwnership()
	if err != nil || owner.InstallationID != metadata.InstallationID {
		return fmt.Errorf("install-root ownership record does not match installer state")
	}
	for _, path := range []string{metadata.LastHealthyRoot, metadata.RecoveryRoot} {
		if path != "" {
			if err := l.validateVersionPath(path); err != nil {
				return fmt.Errorf("installation layout references an unavailable version root: %w", err)
			}
		}
	}
	return nil
}

func (l Layout) ValidateStructure() error {
	info, err := os.Lstat(l.Root)
	if err != nil {
		return fmt.Errorf("install root is not a container: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("install root %s is not a real directory", l.Root)
	}
	entries, err := os.ReadDir(l.Root)
	if err != nil {
		return err
	}
	if err := l.validateOwnedContainerEntries(entries, false, true); err != nil {
		return err
	}
	if staging := ownershipStagingPaths(entries); len(staging) > 0 {
		return &OwnershipStagingArtifactError{Path: filepath.Join(l.Root, staging[0]), Cause: fmt.Errorf("unexpected ownership staging file in an installed container")}
	}
	if err := l.validateContractStatePaths(); err != nil {
		return err
	}
	if err := l.validateSharedStateSymlinks(l.SharedStateDir()); err != nil {
		return err
	}
	if err := validateNoSymlinks(l.InstallerStateDir()); err != nil {
		return err
	}
	if err := l.validateVersionTreeSymlinks(); err != nil {
		return err
	}
	metadata, err := l.readMetadata()
	if err != nil {
		return fmt.Errorf("read installation identity: %w", err)
	}
	if metadata.InstallationID == "" {
		return fmt.Errorf("install-root identity is missing")
	}
	owner, err := l.readOwnership()
	if err != nil || owner.InstallationID != metadata.InstallationID {
		return fmt.Errorf("install-root ownership record does not match installer state")
	}
	active, err := l.Active()
	if err != nil {
		return fmt.Errorf("resolve install-root current link: %w", err)
	}
	linkTarget, err := os.Readlink(l.PlatformRoot())
	if err != nil || filepath.IsAbs(linkTarget) {
		return fmt.Errorf("install-root current link must use a relative target")
	}
	if _, err := l.resolveVersionPath(active); err != nil {
		return fmt.Errorf("active version root is outside the installation container: %w", err)
	}
	contract := filepath.Join(active, ".kb", "v2", "platform-layout.json")
	data, err := os.ReadFile(contract)
	if err != nil || !bytes.Equal(data, contracts.PlatformLayoutDocument()) {
		return fmt.Errorf("platform layout contract is missing or does not match this launcher")
	}
	return nil
}

func (l Layout) validateVersionPath(root string) error {
	abs, err := l.resolveVersionPath(root)
	if err != nil {
		return err
	}
	if _, err := receipt.Read(abs); err != nil {
		return fmt.Errorf("read version root receipt: %w", err)
	}
	return nil
}

func (l Layout) resolveVersionPath(root string) (string, error) {
	versions, err := filepath.EvalSymlinks(l.VersionsDir())
	if err != nil {
		return "", err
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	abs, err = filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	inside, err := contracts.PathWithin(versions, abs)
	if err != nil {
		return "", err
	}
	if !inside || versions == abs {
		return "", fmt.Errorf("%s is not inside %s", root, versions)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s is not a directory", abs)
	}
	return filepath.Clean(abs), nil
}

func (l Layout) readMetadata() (Metadata, error) {
	data, err := os.ReadFile(l.metadataPath())
	if err != nil {
		return Metadata{}, err
	}
	var metadata Metadata
	if err := json.Unmarshal(data, &metadata); err != nil {
		return Metadata{}, err
	}
	if metadata.Schema != LayoutMetadataSchema {
		return Metadata{}, fmt.Errorf("unsupported installation layout metadata schema %q", metadata.Schema)
	}
	return metadata, nil
}

func (l Layout) writeMetadata(metadata Metadata) error {
	if metadata.Schema == "" {
		metadata.Schema = LayoutMetadataSchema
	}
	if err := os.MkdirAll(filepath.Dir(l.metadataPath()), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	temporary := l.metadataPath() + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		return errors.Join(err, file.Close())
	}
	if err := errors.Join(file.Sync(), file.Close()); err != nil {
		return err
	}
	if err := os.Rename(temporary, l.metadataPath()); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(l.metadataPath()))
}

func (l Layout) RecoveryRoot() (string, error) {
	if err := l.ValidateStructure(); err != nil {
		return "", err
	}
	metadata, err := l.readMetadata()
	if err != nil {
		return "", err
	}
	root := metadata.LastHealthyRoot
	if root == "" {
		root = metadata.RecoveryRoot
	}
	if root == "" {
		return "", fmt.Errorf("the installation has no recovery root")
	}
	return root, l.validateVersionPath(root)
}

func (l Layout) LastHealthyRoot() (string, error) {
	metadata, err := l.readMetadata()
	if err != nil {
		return "", err
	}
	if metadata.LastHealthyRoot == "" {
		return "", nil
	}
	return metadata.LastHealthyRoot, l.validateVersionPath(metadata.LastHealthyRoot)
}

func (l Layout) RecordHealthy() error {
	active, err := l.Active()
	if err != nil {
		return err
	}
	return l.RecordHealthyRoot(active)
}

// RecordHealthyRoot records the physical tree that actually passed host health
// checks. current may have switched while an older host was restarting.
func (l Layout) RecordHealthyRoot(runningRoot string) error {
	if err := l.Validate(); err != nil {
		return err
	}
	runningRoot, err := l.resolveVersionPath(runningRoot)
	if err != nil {
		return err
	}
	running, err := receipt.Read(runningRoot)
	if err != nil {
		return err
	}
	metadata, err := l.readMetadata()
	if err != nil {
		return err
	}
	if running.InstallationID != metadata.InstallationID {
		return fmt.Errorf("running healthy generation belongs to a different installation")
	}
	metadata.LastHealthyRoot, metadata.RecoveryRoot = runningRoot, ""
	if err := l.writeMetadata(metadata); err != nil {
		return err
	}
	return l.Retain(runningRoot)
}

func (l Layout) writeUpdateMetadata(metadata UpdateMetadata) error {
	if err := os.MkdirAll(filepath.Dir(l.updateMetadataPath()), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return l.writeUpdateMetadataBytes(data)
}

func (l Layout) writeUpdateMetadataBytes(data []byte) error {
	if err := os.MkdirAll(filepath.Dir(l.updateMetadataPath()), 0o700); err != nil {
		return err
	}
	temporary := l.updateMetadataPath() + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, l.updateMetadataPath())
}

func (l Layout) UpdateMetadata() (UpdateMetadata, error) {
	data, err := os.ReadFile(l.updateMetadataPath())
	if err != nil {
		return UpdateMetadata{}, err
	}
	var metadata UpdateMetadata
	if err := json.Unmarshal(data, &metadata); err != nil {
		return UpdateMetadata{}, err
	}
	return metadata, nil
}

func (l Layout) RestorePrevious() (string, error) {
	previous, err := l.RecoveryRoot()
	if err != nil {
		return "", err
	}
	link, err := l.prepareCurrentLink(previous)
	if err != nil {
		return "", err
	}
	defer os.Remove(link)
	if err := os.Rename(link, l.PlatformRoot()); err != nil {
		return "", fmt.Errorf("atomically restore last-healthy version root: %w", err)
	}
	if err := syncDirectory(l.Root); err != nil {
		return previous, err
	}
	if err := l.Retain(""); err != nil {
		return previous, err
	}
	return previous, nil
}

func (l Layout) Retained(runningRoot string) ([]RetainedVersion, error) {
	active, err := l.Active()
	if err != nil {
		return nil, err
	}
	metadata, err := l.readMetadata()
	if err != nil {
		return nil, err
	}
	paths := []string{active}
	healthy := metadata.LastHealthyRoot
	if healthy == "" {
		healthy = metadata.RecoveryRoot
	}
	if healthy != "" && filepath.Clean(healthy) != filepath.Clean(active) {
		paths = append(paths, healthy)
	}
	if runningRoot != "" && filepath.Clean(runningRoot) != filepath.Clean(active) && filepath.Clean(runningRoot) != filepath.Clean(healthy) {
		paths = append(paths, runningRoot)
	}
	items := make([]RetainedVersion, 0, len(paths))
	for _, path := range paths {
		installed, err := receipt.Read(path)
		if err != nil {
			return nil, fmt.Errorf("read retained version receipt at %s: %w", path, err)
		}
		role := "last-healthy"
		if filepath.Clean(path) == filepath.Clean(active) {
			role = "active"
		} else if filepath.Clean(path) == filepath.Clean(runningRoot) {
			role = "running"
		}
		bytes, err := treeSize(path)
		if err != nil {
			return nil, err
		}
		items = append(items, RetainedVersion{Version: installed.Plan.ServiceGraph.PlatformVersion, Role: role, Path: path, DiskUsageBytes: bytes})
	}
	return items, nil
}

func treeSize(root string) (int64, error) {
	var total int64
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			total += info.Size()
		}
		return nil
	})
	return total, err
}

func (l Layout) Retain(runningRoot string) error {
	return l.retain(runningRoot, nil)
}

// RetainManagedGeneration protects the replaced active root through candidate
// activation so it remains the recovery target even when no host is running.
func (l Layout) RetainManagedGeneration(previousRoot, runningRoot string) error {
	return l.retainManaged(runningRoot, []string{previousRoot}, true)
}

func (l Layout) retain(runningRoot string, additional []string) error {
	return l.retainManaged(runningRoot, additional, false)
}

func (l Layout) retainManaged(runningRoot string, additional []string, pruneManaged bool) error {
	active, err := l.Active()
	if err != nil {
		return err
	}
	metadata, err := l.readMetadata()
	if err != nil {
		return err
	}
	keep := map[string]struct{}{filepath.Clean(active): {}}
	roots := []string{metadata.LastHealthyRoot, metadata.RecoveryRoot, runningRoot}
	roots = append(roots, additional...)
	for _, root := range roots {
		if root == "" {
			continue
		}
		if err := l.validateVersionPath(root); err != nil {
			return fmt.Errorf("retain version root: %w", err)
		}
		keep[filepath.Clean(root)] = struct{}{}
	}
	entries, err := os.ReadDir(l.VersionsDir())
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !pruneManaged && (strings.HasPrefix(entry.Name(), "managed-") || strings.HasPrefix(entry.Name(), ".stage-managed-")) {
			continue
		}
		path := filepath.Join(l.VersionsDir(), entry.Name())
		resolved, resolveErr := filepath.EvalSymlinks(path)
		if resolveErr == nil {
			if _, ok := keep[filepath.Clean(resolved)]; ok {
				continue
			}
		}
		if err := os.RemoveAll(path); err != nil {
			return fmt.Errorf("prune version root %s: %w", path, err)
		}
	}
	return nil
}

func (l Layout) RemoveOwned() error {
	if err := l.ValidateStructure(); err != nil {
		if !l.hasOwnershipMarker() {
			entries, readErr := os.ReadDir(l.Root)
			if os.IsNotExist(readErr) {
				return nil
			}
			if readErr != nil {
				return readErr
			}
			if len(entries) == 0 {
				return os.Remove(l.Root)
			}
			return err
		}
	}
	for _, entry := range contracts.OwnedInstallEntries() {
		path := filepath.Join(l.Root, filepath.FromSlash(entry))
		if err := os.RemoveAll(path); err != nil {
			return fmt.Errorf("remove owned install entry %s: %w", entry, err)
		}
	}
	entries, err := os.ReadDir(l.Root)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return os.Remove(l.Root)
	}
	return nil
}

func (l Layout) PreservedEntries() ([]string, error) {
	owned := contracts.OwnedInstallEntryKinds()
	entries, err := os.ReadDir(l.Root)
	if err != nil {
		return nil, err
	}
	preserved := make([]string, 0)
	for _, entry := range entries {
		name := entry.Name()
		if _, declared := owned[name]; !declared {
			preserved = append(preserved, filepath.Join(l.Root, name))
		}
	}
	if !l.hasOwnershipMarker() {
		if len(preserved) != 0 || len(entries) != 0 {
			return nil, fmt.Errorf("install root has no valid ownership record")
		}
	}
	return preserved, nil
}

func versionKey(version, planHash string) string {
	clean := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '-' {
			return r
		}
		return '-'
	}, version)
	if clean == "" {
		clean = "release"
	}
	return clean + "-" + shortHash([]byte(planHash))
}

func shortHash(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:8]) }

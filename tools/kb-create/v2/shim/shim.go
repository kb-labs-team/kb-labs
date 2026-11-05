// Package shim manages the kb command alongside the kb-create launcher.
package shim

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/versionroot"
)

// Failure identifies the filesystem operation that prevented shim creation.
type Failure struct {
	Path   string
	Reason string
	Cause  error
}

func (e *Failure) Error() string { return fmt.Sprintf("%s: %s", e.Path, e.Reason) }
func (e *Failure) Unwrap() error { return e.Cause }

func failed(path, reason string, cause error) error {
	return &Failure{Path: path, Reason: reason, Cause: cause}
}

func Path(launcher string) string { return filepath.Join(filepath.Dir(launcher), "kb") }

func Target(platformRoot string) string {
	return filepath.Join(platformRoot, ".kb", "v2", "bin", "kb")
}

type EnsureResult struct {
	Linked bool   `json:"linked"`
	Owner  string `json:"owner"`
}

type ClassificationKind string

const (
	ClassificationAbsent            ClassificationKind = "absent"
	ClassificationOwned             ClassificationKind = "owned"
	ClassificationOtherInstallation ClassificationKind = "other-installation"
	ClassificationForeign           ClassificationKind = "foreign"
)

// Classification is the single ownership view used by apply, uninstall, and
// doctor. Target is the link text when LinkIsSymlink is true; Owner and the
// private identity are populated only for a validated installation target.
type Classification struct {
	Kind           ClassificationKind
	Link           string
	Target         string
	Owner          string
	LinkIsSymlink  bool
	installationID string
}

func Classify(launcher, platformRoot string) (Classification, error) {
	link := Path(launcher)
	var requested installationOwner
	requestedValid := false
	if platformRoot != "" {
		requested, _ = installation(platformRoot)
		requestedValid = requested.id != ""
	}
	info, err := os.Lstat(link)
	if os.IsNotExist(err) {
		return Classification{Kind: ClassificationAbsent, Link: link}, nil
	}
	if err != nil {
		return Classification{}, err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return Classification{Kind: ClassificationForeign, Link: link}, nil
	}
	target, err := os.Readlink(link)
	if err != nil {
		return Classification{}, err
	}
	classification := Classification{Kind: ClassificationForeign, Link: link, Target: target, LinkIsSymlink: true}
	owner, valid := installationForTarget(target)
	if !valid {
		return classification, nil
	}
	classification.Owner = owner.root
	classification.installationID = owner.id
	if platformRoot == "" || (requestedValid && owner.id == requested.id) {
		classification.Kind = ClassificationOwned
	} else {
		classification.Kind = ClassificationOtherInstallation
	}
	return classification, nil
}

func Ensure(launcher, platformRoot string) (EnsureResult, error) {
	path := Path(launcher)
	requested, err := installation(platformRoot)
	if err != nil {
		return EnsureResult{}, failed(path, "cannot verify the installation that should own the kb command", err)
	}
	target := Target(requested.platformRoot)
	cliEntry := filepath.Join(requested.platformRoot, "node_modules", "@kb-labs", "cli-bin", "dist", "bin.js")
	if _, err := os.Stat(cliEntry); err != nil {
		return EnsureResult{}, failed(cliEntry, "cannot read the installed kb command", err)
	}
	classification, err := Classify(launcher, platformRoot)
	if err != nil {
		return EnsureResult{}, failed(path, "cannot classify the existing kb command", err)
	}
	switch classification.Kind {
	case ClassificationOtherInstallation:
		if err := ensureTarget(target, cliEntry, requested.platformRoot); err != nil {
			return EnsureResult{}, err
		}
		return EnsureResult{Linked: false, Owner: classification.Owner}, nil
	case ClassificationForeign:
		if classification.LinkIsSymlink {
			return EnsureResult{}, failed(path, fmt.Sprintf("already points to an unverified target %s; inspect it and remove it with %s before installing the kb command", classification.Target, RemoveCommand(path)), nil)
		}
		return EnsureResult{}, failed(path, fmt.Sprintf("is an existing file, not a validated kb link; inspect it and remove it with %s before installing the kb command", RemoveCommand(path)), nil)
	case ClassificationOwned:
		if err := ensureTarget(target, cliEntry, requested.platformRoot); err != nil {
			return EnsureResult{}, err
		}
		if classification.Target != target {
			if err := replaceLink(path, target); err != nil {
				return EnsureResult{}, err
			}
		}
		return EnsureResult{Linked: true, Owner: requested.root}, nil
	case ClassificationAbsent:
		if err := ensureTarget(target, cliEntry, requested.platformRoot); err != nil {
			return EnsureResult{}, err
		}
		if err := os.Symlink(target, path); err != nil {
			return EnsureResult{}, failed(path, "cannot create the launcher symlink", err)
		}
		return EnsureResult{Linked: true, Owner: requested.root}, nil
	}
	return EnsureResult{}, failed(path, "the kb command has an unknown ownership classification", nil)
}

// EnsureVersionTarget writes the active-version-local kb entry without
// changing the user's launcher symlink. Its script resolves the CLI through
// the stable current path after the version directory is activated.
func EnsureVersionTarget(platformRoot, versionRoot string) error {
	layout, err := versionroot.ForPlatformPath(platformRoot)
	if err != nil {
		return err
	}
	inside, err := contracts.PathWithin(layout.VersionsDir(), versionRoot)
	if err != nil {
		return err
	}
	if !inside {
		return fmt.Errorf("version target %s is outside the install root versions directory", versionRoot)
	}
	stableEntry := filepath.Join(layout.PlatformRoot(), "node_modules", "@kb-labs", "cli-bin", "dist", "bin.js")
	return ensureTarget(filepath.Join(versionRoot, ".kb", "v2", "bin", "kb"), stableEntry, platformRoot)
}

type installationOwner struct {
	id           string
	root         string
	platformRoot string
}

func installation(platformRoot string) (installationOwner, error) {
	layout, err := versionroot.ForPlatformPath(platformRoot)
	if err != nil {
		return installationOwner{}, err
	}
	if err := layout.Validate(); err != nil {
		return installationOwner{}, err
	}
	id, err := versionroot.InstallationIDForPath(platformRoot)
	if err != nil {
		return installationOwner{}, err
	}
	return installationOwner{id: id, root: layout.InstallRoot(), platformRoot: layout.PlatformRoot()}, nil
}

func installationForTarget(target string) (installationOwner, bool) {
	candidate, managed := managedRoot(target)
	if !managed {
		return installationOwner{}, false
	}
	owner, err := installation(candidate)
	return owner, err == nil
}

func managedRoot(target string) (string, bool) {
	clean := filepath.Clean(target)
	root := filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(clean))))
	if root == "." || Target(root) != clean {
		return "", false
	}
	return root, true
}

func replaceLink(path, target string) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".kb-shim-*")
	if err != nil {
		return failed(path, "cannot prepare an atomic launcher update", err)
	}
	temporary := file.Name()
	if err := file.Close(); err != nil {
		_ = os.Remove(temporary)
		return failed(path, "cannot prepare an atomic launcher update", err)
	}
	if err := os.Remove(temporary); err != nil {
		return failed(path, "cannot prepare an atomic launcher update", err)
	}
	if err := os.Symlink(target, temporary); err != nil {
		return failed(path, "cannot create an atomic launcher update", err)
	}
	defer os.Remove(temporary)
	if err := os.Rename(temporary, path); err != nil {
		return failed(path, "cannot replace the managed launcher symlink", err)
	}
	return nil
}

func ensureTarget(target, cliEntry, platformRoot string) error {
	home, err := host.DefaultKBHome(platformRoot)
	if err != nil {
		return failed(target, "cannot resolve installation home", err)
	}
	content := []byte(shimContent(cliEntry, home))
	if existing, err := os.ReadFile(target); err == nil {
		if string(existing) == string(content) {
			return nil
		}
		if !strings.HasPrefix(string(existing), "#!/bin/sh\n# kb-create managed shim\n") {
			return failed(target, "refusing to overwrite an unexpected kb launcher", nil)
		}
		if err := os.WriteFile(target, content, 0o750); err != nil {
			return failed(target, "cannot update the managed kb launcher", err)
		}
		return nil
	} else if !os.IsNotExist(err) {
		return failed(target, "cannot inspect the kb launcher target", err)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
		return failed(filepath.Dir(target), "cannot create the kb launcher directory", err)
	}
	if err := os.WriteFile(target, content, 0o750); err != nil {
		return failed(target, "cannot write the kb launcher target", err)
	}
	return nil
}

func shimContent(cliEntry, home string) string {
	return "#!/bin/sh\n# kb-create managed shim\nif [ -z \"${KB_HOME:-}\" ]; then KB_HOME=" + shellQuote(home) + "; export KB_HOME; fi\nexec node " + shellQuote(cliEntry) + " \"$@\"\n"
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func Remove(launcher, platformRoot string) error {
	token, owned, err := PrepareRemoval(launcher, platformRoot)
	if err != nil || !owned {
		return err
	}
	return token.Remove(launcher)
}

type Removal struct {
	target string
	id     string
}

func PrepareRemoval(launcher, platformRoot string) (Removal, bool, error) {
	classification, err := Classify(launcher, platformRoot)
	if err != nil {
		return Removal{}, false, err
	}
	removal, owned := classification.PrepareRemoval()
	return removal, owned, nil
}

func (classification Classification) PrepareRemoval() (Removal, bool) {
	if classification.Kind != ClassificationOwned || !classification.LinkIsSymlink {
		return Removal{}, false
	}
	return Removal{target: classification.Target, id: classification.installationID}, true
}

func (r Removal) Remove(launcher string) error {
	path := Path(launcher)
	existing, err := os.Readlink(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if existing != r.target || r.id == "" {
		return nil
	}
	return os.Remove(path)
}

func Correct(launcher, platformRoot string) bool {
	classification, err := Classify(launcher, platformRoot)
	return err == nil && classification.Kind == ClassificationOwned
}

// Owner returns the installed platform root currently named by the managed kb
// shim. It does not infer owners from unmanaged files or dangling symlinks.
func Owner(launcher string) (string, bool) {
	classification, err := Classify(launcher, "")
	if err != nil || classification.Kind != ClassificationOwned {
		return "", false
	}
	return classification.Owner, true
}

func RemoveCommand(path string) string { return "`rm -- " + shellQuote(path) + "`" }

package artifacts

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/versionroot"
)

// Binaries installs immutable platform tools after verifying their release
// checksum. Files are private to the V2 platform root, never global PATH.
type Binaries struct {
	Root      string
	CacheRoot string
	Offline   bool
	Client    *http.Client
}

func (b Binaries) Install(items []contracts.Artifact) error {
	verified, err := b.verify(items)
	if err != nil {
		return err
	}
	return b.installVerified(verified)
}

type verifiedBinary struct {
	item contracts.Artifact
	data []byte
}

func (b Binaries) verify(items []contracts.Artifact) ([]verifiedBinary, error) {
	verified := make([]verifiedBinary, 0, len(items))
	for _, item := range items {
		if !item.IsBinary() {
			continue
		}
		if b.CacheRoot == "" {
			return nil, fmt.Errorf("binary cache root is required")
		}
		if (!b.Offline && item.ResolvedURL == "") || item.SHA256 == "" || item.Target == "" {
			return nil, fmt.Errorf("binary %q lacks url, hash or target", item.ID)
		}
		data, err := b.download(item)
		if err != nil {
			return nil, err
		}
		sum := fmt.Sprintf("%x", sha256.Sum256(data))
		if sum != item.SHA256 {
			if b.Offline {
				return nil, fmt.Errorf("binary %s checksum mismatch in offline cache", item.ID)
			}
			target := item.ResolvedURL
			return nil, downloadFailure(item, target, fmt.Errorf("checksum mismatch"))
		}
		verified = append(verified, verifiedBinary{item: item, data: data})
	}
	return verified, nil
}

func (b Binaries) installVerified(verified []verifiedBinary) error {
	for _, binary := range verified {
		item, data := binary.item, binary.data
		if !b.Offline {
			cachePath := filepath.Join(b.CacheRoot, "binaries", item.SHA256)
			if err := os.MkdirAll(filepath.Dir(cachePath), 0o750); err != nil {
				return err
			}
			if err := os.WriteFile(cachePath, data, 0o600); err != nil {
				return err
			}
		}
		path := filepath.Join(b.Root, ".kb", "v2", "bin", filepath.Base(item.Target))
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			return err
		}
		if err := os.WriteFile(path+".tmp", data, 0o700); err != nil {
			return err
		}
		if err := os.Rename(path+".tmp", path); err != nil {
			return err
		}
	}
	return nil
}

func (b Binaries) download(item contracts.Artifact) ([]byte, error) {
	if b.Offline {
		path := filepath.Join(b.CacheRoot, "binaries", item.SHA256)
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("offline binary %s is absent from V2 cache: %w", item.ID, err)
		}
		return data, nil
	}
	return fetchArtifact(b.Client, item, item.ResolvedURL)

}

func (b Binaries) Remove(items []contracts.Artifact) error {
	for _, item := range items {
		if !item.IsBinary() {
			continue
		}
		path := filepath.Join(b.Root, ".kb", "v2", "bin", filepath.Base(item.Target))
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

type Composite struct {
	Packages Pnpm
	Binaries Binaries
}

type stagedComposite struct {
	composite Composite
	items     []contracts.Artifact
	root      string
	binaries  []verifiedBinary
	packages  map[string][]byte
}

func (c Composite) Prepare(items []contracts.Artifact) (contracts.PreparedArtifacts, error) {
	layout, err := versionroot.ForPlatformPath(c.Binaries.Root)
	if err != nil {
		return nil, fmt.Errorf("resolve install-root artifact staging owner: %w", err)
	}
	root, err := layout.CreateArtifactStaging()
	if err != nil {
		return nil, fmt.Errorf("create artifact staging directory: %w", err)
	}
	cleanup := func(cause error) (contracts.PreparedArtifacts, error) {
		return nil, errors.Join(cause, os.RemoveAll(root))
	}
	verifiedBinaries, err := c.Binaries.verify(items)
	if err != nil {
		return cleanup(err)
	}
	for index, binary := range verifiedBinaries {
		path := filepath.Join(root, "binary", fmt.Sprintf("%06d", index))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return cleanup(err)
		}
		if err := os.WriteFile(path, binary.data, 0o600); err != nil {
			return cleanup(err)
		}
		staged, err := os.ReadFile(path)
		if err != nil {
			return cleanup(err)
		}
		if actual := fmt.Sprintf("%x", sha256.Sum256(staged)); actual != binary.item.SHA256 {
			return cleanup(fmt.Errorf("staged binary %s checksum mismatch", binary.item.ID))
		}
		verifiedBinaries[index].data = staged
	}
	verifiedPackages, err := c.Packages.verifyTarballs(items)
	if err != nil {
		return cleanup(err)
	}
	for index, item := range items {
		data, ok := verifiedPackages[item.ID]
		if !ok {
			continue
		}
		path := filepath.Join(root, "package", fmt.Sprintf("%06d", index))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return cleanup(err)
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			return cleanup(err)
		}
		staged, err := os.ReadFile(path)
		if err != nil {
			return cleanup(err)
		}
		if actual := fmt.Sprintf("%x", sha256.Sum256(staged)); actual != item.SHA256 {
			return cleanup(fmt.Errorf("staged package %s checksum mismatch", item.ID))
		}
		verifiedPackages[item.ID] = staged
	}
	return &stagedComposite{composite: c, items: append([]contracts.Artifact(nil), items...), root: root,
		binaries: verifiedBinaries, packages: verifiedPackages}, nil
}

func (s *stagedComposite) Install(progress func(string, bool) error) error {
	return s.composite.installVerified(s.items, s.binaries, s.packages, progress)
}

func (s *stagedComposite) Close() error {
	return os.RemoveAll(s.root)
}

func (c Composite) Install(items []contracts.Artifact) error {
	return c.InstallWithProgress(items, nil)
}

// InstallWithProgress exposes the real download/verification and package
// installation boundaries to the shared apply engine's frontends.
func (c Composite) InstallWithProgress(items []contracts.Artifact, progress func(string, bool) error) error {
	verifiedBinaries, err := c.Binaries.verify(items)
	if err != nil {
		return err
	}
	verifiedPackages, err := c.Packages.verifyTarballs(items)
	if err != nil {
		return err
	}
	return c.installVerified(items, verifiedBinaries, verifiedPackages, progress)
}

func (c Composite) installVerified(items []contracts.Artifact, verifiedBinaries []verifiedBinary,
	verifiedPackages map[string][]byte, progress func(string, bool) error) error {
	if progress != nil {
		if err := progress("Download and verify artifacts", true); err != nil {
			return fmt.Errorf("report artifact progress: %w", err)
		}
	}
	// A binary is small and independently hash-verifiable, so install it first.
	// If pnpm then fails, remove V2-owned binaries immediately; a later update
	// additionally restores the pre-mutation snapshot and package lock state.
	if err := c.Binaries.installVerified(verifiedBinaries); err != nil {
		if progress != nil {
			if progressErr := progress("Download and verify artifacts", false); progressErr != nil {
				return errors.Join(err, fmt.Errorf("report artifact progress: %w", progressErr))
			}
		}
		return err
	}
	if progress != nil {
		if err := progress("Download and verify artifacts", false); err != nil {
			removeErr := c.Binaries.Remove(items)
			return errors.Join(fmt.Errorf("report artifact progress: %w", err), removeErr)
		}
		if err := progress("Install packages", true); err != nil {
			removeErr := c.Binaries.Remove(items)
			return errors.Join(fmt.Errorf("report artifact progress: %w", err), removeErr)
		}
	}
	if err := c.Packages.installVerified(items, verifiedPackages); err != nil {
		if progress != nil {
			if progressErr := progress("Install packages", false); progressErr != nil {
				err = errors.Join(err, fmt.Errorf("report artifact progress: %w", progressErr))
			}
		}
		if removeErr := c.Binaries.Remove(items); removeErr != nil {
			return fmt.Errorf("install packages: %w; remove staged binaries: %v", err, removeErr)
		}
		return err
	}
	if progress != nil {
		if err := progress("Install packages", false); err != nil {
			return fmt.Errorf("report artifact progress: %w", err)
		}
	}
	return nil
}
func (c Composite) Restore(plan, previous contracts.ResolvedInstallPlan) error {
	verified, err := catalog.DecodeVerified(plan.ReleaseCatalog)
	if err != nil {
		return err
	}
	previousRelease, err := catalog.DecodeVerified(previous.ReleaseCatalog)
	if err != nil {
		return err
	}
	config := c.Packages.config
	config.ReleaseCatalog = verified
	config.PreviousReleaseCatalog = &previousRelease
	packages, err := NewPnpm(config)
	if err != nil {
		return err
	}
	return packages.Restore(plan.Artifacts)
}
func (c Composite) Uninstall(items []contracts.Artifact) error {
	if err := c.Packages.Uninstall(items); err != nil {
		return err
	}
	return c.Binaries.Remove(items)
}

package v2cli

import (
	"io"

	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/versionroot"
)

func newArtifactExecutor(layout versionroot.Layout, root, registry string, offline bool, log io.Writer,
	runner artifacts.Runner, release catalog.Verified, previous *catalog.Verified, marketplaceRoot string) (artifacts.Composite, error) {
	cacheRoot, err := layout.SharedRuntimePath(".kb/v2/cache")
	if err != nil {
		return artifacts.Composite{}, err
	}
	packages, err := artifacts.NewPnpm(artifacts.PnpmConfig{
		Root: root, CacheRoot: cacheRoot, PackageManagerRoot: layout.PackageManagerStateDir(), Registry: registry,
		ReleaseCatalog: release, PreviousReleaseCatalog: previous, MarketplaceRoot: marketplaceRoot,
		Offline: offline, Log: log, Runner: runner,
	})
	if err != nil {
		return artifacts.Composite{}, err
	}
	return artifacts.Composite{
		Packages: packages,
		Binaries: artifacts.Binaries{Root: root, CacheRoot: cacheRoot, Offline: offline},
	}, nil
}

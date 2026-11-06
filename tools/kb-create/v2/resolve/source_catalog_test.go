package resolve

import (
	"path"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
)

func TestEveryCanaryIndexArtifactUsesItsSelectedSource(t *testing.T) {
	index, err := catalog.LoadFile(filepath.Join("..", "cmd", "kb-create-v2", "testdata", "x251-release-index-v3.json"))
	if err != nil {
		t.Fatal(err)
	}
	var items []contracts.Artifact
	for _, p := range index.Platforms {
		items = append(items, contracts.Artifact{ID: p.ID, Kind: "platform", Package: p.Package, Version: p.Version, Tarball: p.Tarball, SHA256: p.SHA256})
		for _, c := range p.Members {
			items = append(items, artifact(c, "platform-member"))
		}
		for _, b := range p.Binaries {
			items = append(items, contracts.Artifact{ID: b.ID, Kind: "binary", URL: b.URL, SHA256: b.SHA256, Target: b.Filename})
		}
	}
	for _, c := range index.SDKs {
		items = append(items, artifact(c, "sdk"))
	}
	for _, c := range index.Plugins {
		items = append(items, artifact(c, "plugin"))
	}
	for _, c := range index.Adapters {
		items = append(items, artifact(c.Component, "adapter"))
	}
	const registry = "http://registry.test"
	const binary = "http://binaries.test"
	for _, item := range items {
		item := item
		t.Run(item.Kind+"/"+item.ID+"/"+item.Version+"/"+item.Target, func(t *testing.T) {
			single := []contracts.Artifact{item}
			if err := annotateArtifactResolution(contracts.InstallRequest{}, single, binary, registry); err != nil {
				t.Fatal(err)
			}
			binaryArtifact, err := item.IsFetchBinary()
			if err != nil {
				t.Fatal(err)
			}
			source := registry
			if binaryArtifact {
				source = binary
			}
			if !strings.HasPrefix(single[0].ResolvedURL, source+"/") {
				t.Fatalf("%s resolved to %q", item.ID, single[0].ResolvedURL)
			}
			if !binaryArtifact {
				want := registry + "/" + item.Package + "/-/" + path.Base(item.Package) + "-" + item.Version + ".tgz"
				if single[0].ResolvedURL != want {
					t.Fatalf("%s URL=%q want=%q", item.ID, single[0].ResolvedURL, want)
				}
			}
			if single[0].SHA256 != item.SHA256 || single[0].Package != item.Package || single[0].Version != item.Version {
				t.Fatal("identity or digest changed")
			}
		})
	}
	if len(items) == 0 {
		t.Fatal("index has no artifacts")
	}
}

func TestUnknownCanaryArtifactKindIsRejected(t *testing.T) {
	items := []contracts.Artifact{{ID: "future", Kind: "unrecognized", Package: "@kb/future", Version: "1", Tarball: "https://registry.test/future.tgz"}}
	if err := annotateArtifactResolution(contracts.InstallRequest{}, items, "http://binary.test", "http://registry.test"); err == nil {
		t.Fatal("unknown artifact kind accepted")
	}
}

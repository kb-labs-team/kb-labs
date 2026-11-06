package testfixtures

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
)

// ReleaseIndexJSON returns one complete release-index fixture shared by v2
// package tests. The platform, SDK, and shipped binary relations stay valid
// together; callers can decode it and vary unrelated test inputs afterward.
func ReleaseIndexJSON(platformVersion, sdkVersion, os, arch string) []byte {
	platformID := "platform@" + platformVersion
	sdkID := "sdk@" + sdkVersion
	index := catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: platformVersion},
		Compatibility: &catalog.CompatibilityMatrix{Schema: catalog.CompatibilitySchema, Labels: []catalog.CompatibilityLabel{
			{ID: platformID, Kind: "platform", ArtifactID: "platform", Version: platformVersion,
				Requires: []catalog.CompatibilityRelation{{Label: sdkID}}, Status: "prepared", ValidatedBy: []string{"test"}},
			{ID: sdkID, Kind: "sdk", ArtifactID: "sdk", Version: sdkVersion, Status: "prepared", ValidatedBy: []string{"test"}},
			{ID: fmt.Sprintf("binary:kb-create@%s:%s/%s", platformVersion, os, arch), Kind: "binary", ArtifactID: "kb-create", Version: platformVersion,
				Requires: []catalog.CompatibilityRelation{{Label: platformID}, {Label: sdkID}}, Status: "prepared", ValidatedBy: []string{"test"}},
		}},
		Platforms: []catalog.PlatformBundle{{
			ID: "platform", Version: platformVersion, Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform",
			Host:             &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"},
			Profiles:         map[string]contracts.ServiceGraph{"default": {}},
			SupportedTargets: []catalog.BinaryTarget{{OS: os, Arch: arch}},
			Binaries:         []catalog.Binary{{ID: "kb-create", OS: os, Arch: arch, URL: "https://example.test/kb-create", SHA256: "binary", Filename: "kb-create"}},
		}},
		SDKs: []catalog.Component{{ID: "sdk", Version: sdkVersion, Package: "@kb/sdk", Tarball: "https://example.test/sdk.tgz", SHA256: "sdk"}},
	}
	sealed, err := SealCatalog(index)
	if err != nil {
		panic(fmt.Errorf("seal shared release-index fixture: %w", err))
	}
	data, err := json.Marshal(sealed)
	if err != nil {
		panic(fmt.Errorf("marshal shared release-index fixture: %w", err))
	}
	return data
}

// TargetBinary is the same binary declaration used by the shared release fixture.
func TargetBinary(osName, arch string) catalog.Binary {
	var fixture catalog.Catalog
	if err := json.Unmarshal(ReleaseIndexJSON("2.0.0", "2.0.0", osName, arch), &fixture); err != nil {
		panic(err)
	}
	binary := fixture.Platforms[0].Binaries[0]
	digest := sha256.Sum256(TargetBinaryBytes())
	binary.SHA256 = hex.EncodeToString(digest[:])
	return binary
}

// TargetBinaryBytes is the cache content for TargetBinary.
func TargetBinaryBytes() []byte { return []byte("binary:kb-create") }

// SealCatalog adds provenance generated from the same package archives that
// PackageTarball returns to tests. The production sealer remains the owner of
// package integrity and dist digests.
func SealCatalog(source catalog.Catalog) (catalog.Catalog, error) {
	return SealCatalogWithArchives(source, nil)
}

// SealCatalogWithArchives uses supplied fixture archives by package identity
// and generates the remaining package archives through PackageTarball.
func SealCatalogWithArchives(source catalog.Catalog, archives map[string][]byte) (catalog.Catalog, error) {
	packages := make(map[string]artifacts.PackageManifestInput)
	add := func(name, version string) {
		if name == "" || version == "" {
			return
		}
		packages[name+"@"+version] = artifacts.PackageManifestInput{Package: name, Version: version}
	}
	for _, platform := range source.Platforms {
		add(platform.Package, platform.Version)
		for _, member := range platform.Members {
			add(member.Package, member.Version)
		}
	}
	for _, component := range append(append([]catalog.Component(nil), source.SDKs...), source.Plugins...) {
		add(component.Package, component.Version)
	}
	for _, adapter := range source.Adapters {
		add(adapter.Package, adapter.Version)
	}
	for _, existing := range source.Provenance {
		delete(packages, existing.Package+"@"+existing.Version)
	}
	if len(packages) == 0 {
		return source, nil
	}
	root, err := os.MkdirTemp("", "kb-create-test-packages-")
	if err != nil {
		return catalog.Catalog{}, fmt.Errorf("create sealed package fixture directory: %w", err)
	}
	defer os.RemoveAll(root)
	keys := make([]string, 0, len(packages))
	for key := range packages {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	inputs := make([]artifacts.PackageManifestInput, 0, len(keys))
	archiveByIdentity := make(map[string][]byte, len(keys))
	for index, key := range keys {
		input := packages[key]
		input.Tarball = fmt.Sprintf("package-%d.tgz", index)
		archive := archives[key]
		if archive == nil {
			archive = PackageTarball(input.Package, input.Version, nil)
		}
		if err := os.WriteFile(filepath.Join(root, input.Tarball), archive, 0o600); err != nil {
			return catalog.Catalog{}, fmt.Errorf("write sealed package fixture %s: %w", key, err)
		}
		archiveByIdentity[key] = archive
		inputs = append(inputs, input)
	}
	sealed, err := artifacts.SealPackageProvenance(root, inputs, "test-fixture-revision")
	if err != nil {
		return catalog.Catalog{}, fmt.Errorf("derive sealed package fixture provenance: %w", err)
	}
	for _, item := range sealed {
		archiveDigest := sha256.Sum256(archiveByIdentity[item.Package+"@"+item.Version])
		setPackageSHA256(&source, item.Package, item.Version, hex.EncodeToString(archiveDigest[:]))
		source.Provenance = append(source.Provenance, catalog.ArtifactProvenance{
			Package: item.Package, Version: item.Version,
			ArtifactProvenance: contracts.ArtifactProvenance{SourceRevision: item.SourceRevision, Integrity: item.Integrity, DistSHA256: item.DistSHA256, ContentScope: item.ContentScope, PackageSHA256: item.PackageSHA256},
		})
	}
	return source, nil
}

func setPackageSHA256(source *catalog.Catalog, name, version, digest string) {
	set := func(component *catalog.Component) {
		if component.Package == name && component.Version == version {
			component.SHA256 = digest
		}
	}
	for platformIndex := range source.Platforms {
		platform := &source.Platforms[platformIndex]
		if platform.Package == name && platform.Version == version {
			platform.SHA256 = digest
		}
		for memberIndex := range platform.Members {
			set(&platform.Members[memberIndex])
		}
	}
	for index := range source.SDKs {
		set(&source.SDKs[index])
	}
	for index := range source.Plugins {
		set(&source.Plugins[index])
	}
	for index := range source.Adapters {
		set(&source.Adapters[index].Component)
	}
}

// PackageProvenance derives one test package's metadata with the production
// sealer. The matching installed tree is produced by WritePackage.
func PackageProvenance(name, version string) (contracts.ArtifactProvenance, error) {
	root, err := os.MkdirTemp("", "kb-create-test-package-")
	if err != nil {
		return contracts.ArtifactProvenance{}, fmt.Errorf("create sealed package fixture directory: %w", err)
	}
	defer os.RemoveAll(root)
	const tarball = "package.tgz"
	if err := os.WriteFile(filepath.Join(root, tarball), PackageTarball(name, version, nil), 0o600); err != nil {
		return contracts.ArtifactProvenance{}, fmt.Errorf("write sealed package fixture: %w", err)
	}
	sealed, err := artifacts.SealPackageProvenance(root, []artifacts.PackageManifestInput{{Package: name, Version: version, Tarball: tarball}}, "test-fixture-revision")
	if err != nil {
		return contracts.ArtifactProvenance{}, fmt.Errorf("derive sealed package fixture provenance: %w", err)
	}
	return contracts.ArtifactProvenance{SourceRevision: sealed[0].SourceRevision, Integrity: sealed[0].Integrity, DistSHA256: sealed[0].DistSHA256, ContentScope: sealed[0].ContentScope, PackageSHA256: sealed[0].PackageSHA256}, nil
}

// MustSealCatalog is for static test catalog declarations that cannot return
// errors through their existing fixture signature.
func MustSealCatalog(source catalog.Catalog) catalog.Catalog {
	sealed, err := SealCatalog(source)
	if err != nil {
		panic(fmt.Errorf("seal test catalog: %w", err))
	}
	return sealed
}

// PackageTarball creates the canonical package bytes consumed by fixture
// registries. Its dist content is deliberately stable so the catalog sealer
// can produce provenance for these exact bytes.
func PackageTarball(name, version string, files map[string][]byte) []byte {
	entries := packageFiles(name, version, files)
	paths := make([]string, 0, len(entries))
	for path := range entries {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	var data bytes.Buffer
	compressed := gzip.NewWriter(&data)
	archive := tar.NewWriter(compressed)
	for _, path := range paths {
		contents := entries[path]
		if err := archive.WriteHeader(&tar.Header{Name: path, Mode: 0o644, Size: int64(len(contents))}); err != nil {
			panic(fmt.Errorf("write package fixture header %s: %w", path, err))
		}
		if _, err := archive.Write(contents); err != nil {
			panic(fmt.Errorf("write package fixture content %s: %w", path, err))
		}
	}
	if err := archive.Close(); err != nil {
		panic(fmt.Errorf("close package fixture tar: %w", err))
	}
	if err := compressed.Close(); err != nil {
		panic(fmt.Errorf("close package fixture gzip: %w", err))
	}
	return data.Bytes()
}

// WritePackage materializes the file tree represented by PackageTarball.
func WritePackage(root, name, version string, files map[string][]byte) error {
	for path, contents := range packageFiles(name, version, files) {
		filename := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(path, "package/")))
		if err := os.MkdirAll(filepath.Dir(filename), 0o755); err != nil {
			return fmt.Errorf("create package fixture path %s: %w", filename, err)
		}
		if err := os.WriteFile(filename, contents, 0o644); err != nil {
			return fmt.Errorf("write package fixture path %s: %w", filename, err)
		}
	}
	return nil
}

func packageFiles(name, version string, files map[string][]byte) map[string][]byte {
	manifest, err := json.Marshal(map[string]string{"name": name, "version": version})
	if err != nil {
		panic(fmt.Errorf("marshal package fixture manifest: %w", err))
	}
	entries := map[string][]byte{
		"package/package.json":  manifest,
		"package/dist/index.js": []byte("// sealed package fixture\\n"),
		"package/dist/bin.js":   []byte("export {};\n"),
	}
	for path, contents := range files {
		entries["package/"+filepath.ToSlash(path)] = contents
	}
	return entries
}

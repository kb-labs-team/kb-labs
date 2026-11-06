package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
)

func TestRunSealsNormalizedReleaseExport(t *testing.T) {
	input, output, manifestRoot := validReleaseSealerFixture(t)
	if err := run(input, output, manifestRoot); err != nil {
		t.Fatal(err)
	}
	sealed, err := catalog.LoadFile(output)
	if err != nil || sealed.Digest == "" {
		t.Fatalf("sealed/error = %#v / %v", sealed, err)
	}
}

func TestRunDigestWritesVersionedOwnerJSON(t *testing.T) {
	dist := filepath.Join(t.TempDir(), "dist")
	if err := os.MkdirAll(dist, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dist, "index.js"), []byte("owner bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	expected, err := artifacts.DistDigest(dist)
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := runDigest([]string{dist}, bytes.NewReader(nil), &output); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Schema string `json:"schema"`
		Digest string `json:"digest"`
	}
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Schema != "kb-dist-digest/v1" || result.Digest != expected {
		t.Fatalf("digest JSON = %#v, want schema kb-dist-digest/v1 and digest %s", result, expected)
	}
}

func TestRunDigestPackageSetWritesVersionedOwnerJSON(t *testing.T) {
	packagesDir := t.TempDir()
	packages := []artifacts.PackageManifestInput{}
	expected, err := artifacts.PackageSetContentDigest(packagesDir, packages)
	if err != nil {
		t.Fatal(err)
	}
	input, err := json.Marshal(packages)
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := runDigest([]string{"package-set", packagesDir}, bytes.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Schema string `json:"schema"`
		Digest string `json:"digest"`
	}
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Schema != "kb-package-set-digest/v1" || result.Digest != expected {
		t.Fatalf("package set JSON = %#v, want owner digest %s", result, expected)
	}
}

func TestRunSealsProducerProvenanceBeforeComputingDigest(t *testing.T) {
	input, output, manifestRoot := validReleaseSealerFixture(t)
	data, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	var source catalog.Catalog
	if err := json.Unmarshal(data, &source); err != nil {
		t.Fatal(err)
	}
	if len(source.Provenance) == 0 {
		t.Fatal("release-index fixture omitted producer-generated provenance")
	}
	data, err = json.Marshal(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(input, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run(input, output, manifestRoot); err != nil {
		t.Fatal(err)
	}
	sealed, err := catalog.LoadFile(output)
	if err != nil || len(sealed.Provenance) != len(source.Provenance) {
		t.Fatalf("sealed provenance = %d, err = %v", len(sealed.Provenance), err)
	}
	sealed.Provenance[0].DistSHA256 = "edited-after-seal"
	if err := catalog.Verify(sealed); err == nil {
		t.Fatal("edited provenance survived the immutable digest check")
	}
}

func validReleaseSealerFixture(t *testing.T) (input, output, manifestRoot string) {
	t.Helper()
	dir := t.TempDir()
	input, output = filepath.Join(dir, "export.json"), filepath.Join(dir, "release", "index.json")
	manifestRoot = filepath.Join(dir, "staging")
	var source catalog.Catalog
	if err := json.Unmarshal([]byte(`{"channels":{"stable":"2.0.0"},"compatibility":{"schema":"kb.release-compatibility/2","labels":[{"id":"platform@2.0.0","kind":"platform","artifactId":"platform","version":"2.0.0","status":"prepared","validatedBy":["stage"]}]},"platforms":[{"id":"platform","version":"2.0.0","package":"@kb/platform","tarball":"https://example.test/platform.tgz","sha256":"artifact","host":{"command":"node_modules/.bin/kb-host","healthUrl":"http://127.0.0.1:4000/health"},"profiles":{"default":{}}}]}`), &source); err != nil {
		t.Fatal(err)
	}
	source.Platforms[0].SupportedTargets = []catalog.BinaryTarget{{OS: "linux", Arch: "amd64"}}
	source.SDKs = []catalog.Component{{ID: "sdk", Version: "2.0.0", Package: "@kb/sdk", Tarball: "https://example.test/sdk.tgz", SHA256: "sdk"}}
	source.Compatibility.Labels[0].Requires = []catalog.CompatibilityRelation{{Label: "sdk@2.0.0"}}
	source.Compatibility.Labels = append(source.Compatibility.Labels, catalog.CompatibilityLabel{ID: "sdk@2.0.0", Kind: "sdk", ArtifactID: "sdk", Version: "2.0.0", Status: "prepared", ValidatedBy: []string{"stage"}})
	source.Platforms[0].Config = []catalog.ConfigRequirement{{ID: "gateway.access.mode", Path: "/gateway/access/mode", Default: `"local"`}}
	for _, id := range []string{"@kb-labs/marketplace", "@kb-labs/review"} {
		source.Platforms[0].Members = append(source.Platforms[0].Members, catalog.Component{ID: id, Version: "2.0.0", Package: "@kb-labs/" + id[len("@kb-labs/"):], Tarball: "https://example.test/" + id + ".tgz", SHA256: id})
	}
	for _, id := range []string{"@kb-labs/commit", "@kb-labs/release"} {
		component := catalog.Component{ID: id, Version: "2.0.0", Package: "@kb-labs/" + id[len("@kb-labs/"):], Tarball: "https://example.test/" + id + ".tgz", SHA256: id}
		if id == "@kb-labs/commit" {
			component.Requires = []catalog.Requirement{{Capability: "cache"}}
		}
		source.Plugins = append(source.Plugins, component)
	}
	source.Adapters = []catalog.Adapter{
		{Component: catalog.Component{ID: "state-broker", Version: "2.0.0", Package: "@kb/state-broker", Tarball: "https://example.test/state-broker.tgz", SHA256: "state-broker"}, Provides: []string{"cache"}},
		{Component: catalog.Component{ID: "sqlite-stores", Version: "2.0.0", Package: "@kb-labs/adapters-sqlite", Tarball: "https://example.test/adapters-sqlite.tgz", SHA256: "sqlite"}, Provides: []string{"documentDatabase", "kvStore"}},
	}
	export, err := json.Marshal(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(input, export, 0o600); err != nil {
		t.Fatal(err)
	}
	components := []catalog.Component{{ID: "platform", Version: "2.0.0", Package: "@kb/platform"}}
	components = append(components, source.SDKs...)
	components = append(components, source.Platforms[0].Members...)
	components = append(components, source.Plugins...)
	for _, adapter := range source.Adapters {
		components = append(components, adapter.Component)
	}
	for _, component := range components {
		packageDir := filepath.Join(manifestRoot, "node_modules", filepath.FromSlash(component.Package))
		if err := os.MkdirAll(packageDir, 0o750); err != nil {
			t.Fatal(err)
		}
		manifestValue := map[string]any{"schema": "kb.create.artifact-manifest/v2", "id": component.ID, "package": component.Package, "version": component.Version}
		if component.ID == "platform" {
			manifestValue["requirements"] = []map[string]any{{"id": "gateway.access.mode", "path": "/gateway/access/mode", "default": json.RawMessage(`"local"`)}}
		}
		manifest, _ := json.Marshal(manifestValue)
		if err := os.WriteFile(filepath.Join(packageDir, "kb-create.manifest.json"), manifest, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	refreshFixtureProvenance(t, &source, manifestRoot)
	export, err = json.Marshal(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(input, export, 0o600); err != nil {
		t.Fatal(err)
	}
	return input, output, manifestRoot
}

func TestRunRejectsMissingPublishPaths(t *testing.T) {
	if err := run("", "", ""); err == nil {
		t.Fatal("expected missing paths")
	}
}

func TestRunRejectsInvalidHistoryIndexesWithCataloguedSealFailure(t *testing.T) {
	input, _, manifestRoot := validReleaseSealerFixture(t)
	validHistory, err := catalog.Seal(catalog.Catalog{Platforms: []catalog.PlatformBundle{{
		SupportedTargets: []catalog.BinaryTarget{{OS: "linux", Arch: "amd64"}}, ID: "platform", Version: "1.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz",
		SHA256: "platform-sha", SDKRange: "*", Host: &contracts.HostSpec{Command: "node_modules/.bin/kb-host", HealthURL: "http://127.0.0.1:4000/health"},
		Profiles: map[string]contracts.ServiceGraph{"default": {}},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	sealedBytes, err := json.Marshal(validHistory)
	if err != nil {
		t.Fatal(err)
	}

	for _, testCase := range []struct {
		name   string
		mutate func([]byte) []byte
	}{
		{name: "tampered", mutate: func(data []byte) []byte {
			var history catalog.Catalog
			if err := json.Unmarshal(data, &history); err != nil {
				t.Fatal(err)
			}
			history.Platforms[0].Version = "1.0.1"
			tampered, err := json.Marshal(history)
			if err != nil {
				t.Fatal(err)
			}
			return tampered
		}},
		{name: "unsealed", mutate: func(data []byte) []byte {
			var history catalog.Catalog
			if err := json.Unmarshal(data, &history); err != nil {
				t.Fatal(err)
			}
			history.Digest = ""
			unsealed, err := json.Marshal(history)
			if err != nil {
				t.Fatal(err)
			}
			return unsealed
		}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			dir := t.TempDir()
			historyPath := filepath.Join(dir, "history.json")
			output := filepath.Join(dir, "release", "index.json")
			if err := os.WriteFile(historyPath, testCase.mutate(sealedBytes), 0o600); err != nil {
				t.Fatal(err)
			}
			err := run(input, output, manifestRoot, historyPath)
			if err == nil {
				t.Fatal("expected history seal validation failure")
			}
			envelope, status, err := sealingFailureResult(err)
			if err != nil {
				t.Fatal(err)
			}
			if envelope.Code != "KB_RELEASE_INDEX_SEAL_FAILED" {
				t.Fatalf("diagnostic code = %q", envelope.Code)
			}
			if want := diag.ExitCode(diag.New(envelope.Code, envelope.Message)); status != want {
				t.Fatalf("process status = %d, want catalogued status %d", status.Code(), want.Code())
			}
			if _, err := os.Stat(output); !os.IsNotExist(err) {
				t.Fatalf("output index exists or could not be checked: %v", err)
			}
		})
	}
}

func TestMergeReleaseHistoryCarriesPlatformSDKAndCompatibilityEvidence(t *testing.T) {
	target := catalog.Catalog{
		Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "3.0.2"}},
		SDKs:      []catalog.Component{{ID: "sdk", Version: "3.0.2"}},
		Compatibility: &catalog.CompatibilityMatrix{Schema: catalog.CompatibilitySchema,
			Labels: []catalog.CompatibilityLabel{{ID: "platform@3.0.2"}}},
	}
	history := catalog.Catalog{
		Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "3.0.0"}, {ID: "platform", Version: "3.0.1"}},
		SDKs:      []catalog.Component{{ID: "sdk", Version: "3.0.0"}, {ID: "sdk", Version: "3.0.1"}},
		Compatibility: &catalog.CompatibilityMatrix{Schema: catalog.CompatibilitySchema,
			Labels: []catalog.CompatibilityLabel{{ID: "platform@3.0.0"}, {ID: "sdk@3.0.0"}, {ID: "platform@3.0.1"}}},
	}
	merged, err := mergeReleaseHistory(target, history)
	if err != nil {
		t.Fatal(err)
	}
	if len(merged.Platforms) != 3 || len(merged.SDKs) != 3 || len(merged.Compatibility.Labels) != 4 {
		t.Fatalf("merged history platform/sdk/label counts = %d/%d/%d", len(merged.Platforms), len(merged.SDKs), len(merged.Compatibility.Labels))
	}
	merged, err = mergeReleaseHistory(merged, history)
	if err != nil {
		t.Fatal(err)
	}
	if len(merged.Platforms) != 3 || len(merged.SDKs) != 3 || len(merged.Compatibility.Labels) != 4 {
		t.Fatalf("repeated history merge duplicated entries: platforms=%d sdks=%d labels=%d", len(merged.Platforms), len(merged.SDKs), len(merged.Compatibility.Labels))
	}
}

func TestRunSealsThreeReleaseHistoryIndexesWithoutRebindingHistoricalSDKs(t *testing.T) {
	input, _, manifestRoot := validReleaseSealerFixture(t)
	dir := t.TempDir()
	first := filepath.Join(dir, "first.json")
	update := filepath.Join(dir, "update.json")
	jump := filepath.Join(dir, "jump.json")
	for index, version := range []string{"2.120.1", "2.120.2", "2.120.3"} {
		writeSealerCandidate(t, input, manifestRoot, version, true)
		output := []string{first, update, jump}[index]
		var err error
		switch index {
		case 0:
			err = run(input, output, manifestRoot)
		case 1:
			err = run(input, output, manifestRoot, first)
		case 2:
			err = run(input, output, manifestRoot, first, update)
		}
		if err != nil {
			t.Fatalf("seal candidate %s in three-index history chain: %v", version, err)
		}
	}
	sealed, err := catalog.LoadFile(jump)
	if err != nil {
		t.Fatal(err)
	}
	if len(sealed.Platforms) != 3 || len(sealed.SDKs) != 3 {
		t.Fatalf("jump index lost carried release history: platforms=%d SDKs=%d", len(sealed.Platforms), len(sealed.SDKs))
	}
	var sharedBinary catalog.CompatibilityLabel
	for _, label := range sealed.Compatibility.Labels {
		if label.ID == "binary:kb-create@2.120.1:darwin/arm64" {
			sharedBinary = label
			break
		}
	}
	for _, version := range []string{"2.120.1", "2.120.2", "2.120.3"} {
		if !compatibilityRelationExists(sharedBinary.Requires, "platform@"+version) || !compatibilityRelationExists(sharedBinary.Requires, "sdk@"+version) {
			t.Fatalf("shared binary label did not retain platform/SDK relation for %s: %#v", version, sharedBinary.Requires)
		}
	}
}

func compatibilityRelationExists(relations []catalog.CompatibilityRelation, wanted string) bool {
	for _, relation := range relations {
		if relation.Label == wanted {
			return true
		}
	}
	return false
}

func refreshFixtureProvenance(t *testing.T, source *catalog.Catalog, manifestRoot string) {
	t.Helper()
	components := []catalog.Component{}
	for _, platform := range source.Platforms {
		components = append(components, catalog.Component{ID: platform.ID, Version: platform.Version, Package: platform.Package})
		components = append(components, platform.Members...)
	}
	components = append(components, source.SDKs...)
	components = append(components, source.Plugins...)
	for _, adapter := range source.Adapters {
		components = append(components, adapter.Component)
	}
	packagesRoot := filepath.Join(t.TempDir(), "packages")
	entries := make([]map[string]string, 0, len(components))
	for index, component := range components {
		packageDir := filepath.Join(manifestRoot, "node_modules", filepath.FromSlash(component.Package))
		packageJSON, err := json.Marshal(map[string]string{"name": component.Package, "version": component.Version})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(packageDir, "package.json"), packageJSON, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(packageDir, "dist"), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(packageDir, "dist", "index.js"), []byte("release fixture: "+component.Package), 0o600); err != nil {
			t.Fatal(err)
		}
		packageArchiveRoot := filepath.Join(packagesRoot, fmt.Sprintf("package-%03d", index))
		if err := os.MkdirAll(packageArchiveRoot, 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.CopyFS(filepath.Join(packageArchiveRoot, "package"), os.DirFS(packageDir)); err != nil {
			t.Fatal(err)
		}
		tarball := fmt.Sprintf("package-%03d.tgz", index)
		command := exec.Command("tar", "-czf", filepath.Join(packagesRoot, tarball), "-C", packageArchiveRoot, "package")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("pack release fixture %s: %v: %s", component.Package, err, output)
		}
		entries = append(entries, map[string]string{"name": component.Package, "version": component.Version, "tarball": tarball})
	}
	manifest, err := json.Marshal(entries)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packagesRoot, "manifest.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		tarball := filepath.Join(packagesRoot, entry["tarball"])
		extracted := t.TempDir()
		command := exec.Command("tar", "-xzf", tarball, "-C", extracted)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("extract provenance package: %v: %s", err, output)
		}
		distDigest, err := artifacts.DistDigest(filepath.Join(extracted, "package", "dist"))
		if err != nil {
			t.Fatal(err)
		}
		integrity, err := artifacts.TarballIntegrity(tarball)
		if err != nil {
			t.Fatal(err)
		}
		source.Provenance = append(source.Provenance, catalog.ArtifactProvenance{
			Package: entry["name"], Version: entry["version"],
			ArtifactProvenance: contracts.ArtifactProvenance{
				SourceRevision: "test-source-revision", Integrity: integrity, DistSHA256: distDigest, ContentScope: contracts.ProvenanceScopeDist,
			},
		})
	}
	lock := "lockfileVersion: '9.0'\npackages:\n"
	for _, item := range source.Provenance {
		lock += fmt.Sprintf("  '%s@%s':\n    resolution:\n      integrity: %s\n", item.Package, item.Version, item.Integrity)
	}
	if err := os.WriteFile(filepath.Join(manifestRoot, "pnpm-lock.yaml"), []byte(lock), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestRunRejectsUnrelatedTargetSDKForShippedBinary(t *testing.T) {
	input, output, manifestRoot := validReleaseSealerFixture(t)
	writeSealerCandidate(t, input, manifestRoot, "2.120.3", false)
	if err := run(input, output, manifestRoot); err == nil {
		t.Fatal("sealer accepted a target SDK unrelated to the shipped binary")
	}
	if _, err := os.Stat(output); !os.IsNotExist(err) {
		t.Fatalf("invalid target index was written: %v", err)
	}
}

func writeSealerCandidate(t *testing.T, inputPath, manifestRoot, version string, relateBinarySDK bool) {
	t.Helper()
	data, err := os.ReadFile(inputPath)
	if err != nil {
		t.Fatal(err)
	}
	var source catalog.Catalog
	if err := json.Unmarshal(data, &source); err != nil {
		t.Fatal(err)
	}
	source.Channels[contracts.ChannelStable] = version
	source.Platforms[0].Version = version
	source.Platforms[0].SDKRange = ">=2.120.0 <3.0.0"
	source.Platforms[0].Binaries = []catalog.Binary{{ID: "kb-create", OS: "darwin", Arch: "arm64", URL: "https://example.test/kb-create", SHA256: "binary-" + version, Filename: "kb-create"}}
	for i := range source.Platforms[0].Members {
		source.Platforms[0].Members[i].Version = version
	}
	for i := range source.SDKs {
		source.SDKs[i].Version = version
	}
	for i := range source.Plugins {
		source.Plugins[i].Version = version
	}
	for i := range source.Adapters {
		source.Adapters[i].Version = version
	}
	for i := range source.Adapters {
		source.Adapters[i].Component.Version = version
	}
	sdkID, platformID := "sdk@"+version, "platform@"+version
	labels := []catalog.CompatibilityLabel{
		{ID: platformID, Kind: "platform", ArtifactID: "platform", Version: version, Requires: []catalog.CompatibilityRelation{{Label: sdkID}}, Status: "prepared", ValidatedBy: []string{"stage"}},
		{ID: sdkID, Kind: "sdk", ArtifactID: "sdk", Version: version, Status: "prepared", ValidatedBy: []string{"stage"}},
	}
	binaryRequires := []catalog.CompatibilityRelation{{Label: platformID}}
	if relateBinarySDK {
		binaryRequires = append(binaryRequires, catalog.CompatibilityRelation{Label: sdkID})
	}
	labels = append(labels, catalog.CompatibilityLabel{ID: "binary:kb-create@2.120.1:darwin/arm64", Kind: "binary", ArtifactID: "kb-create", Version: "2.120.1", Requires: binaryRequires, Status: "prepared", ValidatedBy: []string{"stage"}})
	source.Compatibility = &catalog.CompatibilityMatrix{Schema: catalog.CompatibilitySchema, Labels: labels}
	err = filepath.WalkDir(manifestRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || entry.Name() != "kb-create.manifest.json" {
			return nil
		}
		manifestBytes, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var manifest map[string]any
		if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
			return err
		}
		manifest["version"] = version
		updated, err := json.Marshal(manifest)
		if err != nil {
			return err
		}
		return os.WriteFile(path, updated, 0o600)
	})
	if err != nil {
		t.Fatal(err)
	}
	refreshFixtureProvenance(t, &source, manifestRoot)
	encoded, err := json.Marshal(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(inputPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestSealingFailureEnvelopePreservesValidationReason(t *testing.T) {
	reason := "secret manifest requirement gateway.jwt must declare env and services"
	envelope, err := sealingFailureEnvelope(&sealingFailure{
		gate: "manifest validation",
		rule: reason,
		hint: "Add env and services to the secret requirement described in the cause, then rerun release-index preparation.",
		err:  errors.New(reason),
	})
	if err != nil {
		t.Fatal(err)
	}
	if envelope.Cause != reason {
		t.Fatalf("cause = %q, want %q", envelope.Cause, reason)
	}
	if envelope.Details["gate"] != "manifest validation" || envelope.Details["rule"] != reason {
		t.Fatalf("details = %#v", envelope.Details)
	}
	if envelope.Code != "KB_RELEASE_INDEX_SEAL_FAILED" {
		t.Fatalf("code = %q", envelope.Code)
	}
	if envelope.Retryable {
		t.Fatal("deterministic manifest validation must not be retryable")
	}
	if envelope.Hint == "" {
		t.Fatal("expected actionable remediation hint")
	}
}

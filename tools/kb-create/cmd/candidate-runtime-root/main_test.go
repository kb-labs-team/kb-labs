package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/toolchain"
	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/versionroot"
)

func TestRenderFailureWritesDiagnosticAndSelectsFailureStatus(t *testing.T) {
	var stderr bytes.Buffer
	hint := "Correct the cause and rerun: " + invocationCommand()
	status := renderFailure(contracts.NewDiag(contracts.CodeApplyFailed, "Candidate install failed.", hint, errors.New("verified release index is required")), &stderr)
	if status.Code() == 0 {
		t.Fatal("expected a non-zero status")
	}
	if stderr.Len() == 0 {
		t.Fatal("expected a rendered diagnostic on stderr")
	}
	if !strings.Contains(stderr.String(), contracts.CodeApplyFailed) || !strings.Contains(stderr.String(), "verified release index is required") || !strings.Contains(stderr.String(), hint) {
		t.Fatalf("rendered diagnostic lacks code, cause or next step: %q", stderr.String())
	}
}

func TestRegistryReportsMetadataEncodingFailure(t *testing.T) {
	var output bytes.Buffer
	previousWriter := log.Writer()
	log.SetOutput(&output)
	t.Cleanup(func() { log.SetOutput(previousWriter) })

	registry := &packageRegistry{packages: map[string]map[string]candidatePackage{
		"@kb-labs/broken": {
			"1.0.0": {Manifest: map[string]any{"unsupported": make(chan int)}},
		},
	}}
	response := httptest.NewRecorder()
	request := httptest.NewRequest("GET", "/@kb-labs/broken", nil)
	registry.ServeHTTP(response, request)

	if response.Code != 500 {
		t.Fatalf("expected HTTP 500 for unencodable package metadata, got %d", response.Code)
	}
	if !strings.Contains(output.String(), "encode candidate package metadata") {
		t.Fatalf("expected encoding failure in server log, got %q", output.String())
	}
}

func TestCandidatePackageInstallerConsumesLoadedVerifiedCatalog(t *testing.T) {
	layout := versionroot.Layout{Root: t.TempDir()}
	stage := filepath.Join(layout.Root, "versions", "candidate")
	const registryURL = "http://127.0.0.1:49183"
	index, err := catalog.Seal(catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Compatibility: &catalog.CompatibilityMatrix{Schema: catalog.CompatibilitySchema, Labels: []catalog.CompatibilityLabel{
			{ID: "platform@2.0.0", Kind: "platform", ArtifactID: "platform", Version: "2.0.0", Requires: []catalog.CompatibilityRelation{{Label: "sdk@2.0.0"}}, Status: "prepared", ValidatedBy: []string{"candidate-runtime-root-test"}},
			{ID: "sdk@2.0.0", Kind: "sdk", ArtifactID: "sdk", Version: "2.0.0", Status: "prepared", ValidatedBy: []string{"candidate-runtime-root-test"}},
		}},
		Platforms: []catalog.PlatformBundle{{
			ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "artifact",
			Host:     &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"},
			Profiles: map[string]contracts.ServiceGraph{"default": {}},
		}},
		SDKs: []catalog.Component{{ID: "sdk", Version: "2.0.0", Package: "@kb/sdk", Tarball: "https://example.test/sdk.tgz", SHA256: "sdk"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(t.TempDir(), "release-index.json")
	contents, err := json.Marshal(index)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	source, err := catalog.LoadFile(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	releaseCatalog, err := catalog.VerifyCatalog(source)
	if err != nil {
		t.Fatal(err)
	}
	installer, err := candidatePackageInstaller(layout, stage, registryURL, registryURL, releaseCatalog)
	if err != nil {
		t.Fatal(err)
	}
	if err := installer.Install(nil); err != nil {
		t.Fatalf("installer could not consume the verified candidate catalog: %v", err)
	}
}

func TestRunRoutesCandidateTransitivePackagesToTheirOwningRegistries(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	root := filepath.Join(t.TempDir(), "install")
	layout := versionroot.Layout{Root: root}
	if err := layout.PrepareInitialTarget(); err != nil {
		t.Fatalf("prepare isolated install root: %v", err)
	}
	_, pnpmScript, err := toolchain.PnpmExecutable()
	if err != nil {
		t.Fatalf("locate real pnpm for candidate seam: %v", err)
	}
	managerRoot := filepath.Join(layout.PackageManagerStateDir(), "corepack", "v1", "pnpm", toolchain.SupportedPnpm)
	if err := os.CopyFS(managerRoot, os.DirFS(filepath.Dir(filepath.Dir(pnpmScript)))); err != nil {
		t.Fatalf("seed the real pnpm package-manager cache: %v", err)
	}
	thirdTarball := candidateTestPackage(t, "third-party-fixture", "1.0.0", nil)
	thirdRegistry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/third-party-fixture":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"name": "third-party-fixture", "dist-tags": map[string]string{"latest": "1.0.0"},
				"versions": map[string]any{"1.0.0": map[string]any{
					"name": "third-party-fixture", "version": "1.0.0",
					"dist": map[string]string{"tarball": "http://" + r.Host + "/fixture.tgz"},
				}},
			})
		case "/fixture.tgz":
			_, _ = w.Write(thirdTarball)
		default:
			http.NotFound(w, r)
		}
	}))
	defer thirdRegistry.Close()

	candidatePackages := t.TempDir()
	platformTarball := candidateTestPackage(t, "@kb/platform", "2.0.0", map[string]string{
		"@kb-labs/cli-commands": "2.0.0",
	})
	sdkTarball := candidateTestPackage(t, "@kb/sdk", "2.0.0", nil)
	commandsTarball := candidateTestPackage(t, "@kb-labs/cli-commands", "2.0.0", map[string]string{"third-party-fixture": "1.0.0"})
	for name, data := range map[string][]byte{
		"platform.tgz": platformTarball, "sdk.tgz": sdkTarball, "cli-commands.tgz": commandsTarball,
	} {
		if err := os.WriteFile(filepath.Join(candidatePackages, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	platformHash, sdkHash := fmt.Sprintf("%x", sha256.Sum256(platformTarball)), fmt.Sprintf("%x", sha256.Sum256(sdkTarball))
	packageProvenance, err := artifacts.SealPackageProvenance(candidatePackages, []artifacts.PackageManifestInput{
		{Package: "@kb/platform", Version: "2.0.0", Tarball: "platform.tgz"},
		{Package: "@kb/sdk", Version: "2.0.0", Tarball: "sdk.tgz"},
	}, "candidate-runtime-root-test")
	if err != nil {
		t.Fatal(err)
	}
	provenanceByPackage := make(map[string]contracts.ArtifactProvenance, len(packageProvenance))
	for _, item := range packageProvenance {
		provenanceByPackage[item.Package] = contracts.ArtifactProvenance{
			SourceRevision: item.SourceRevision, Integrity: item.Integrity, DistSHA256: item.DistSHA256,
			ContentScope: item.ContentScope, PackageSHA256: item.PackageSHA256,
		}
	}
	index, err := catalog.Seal(catalog.Catalog{
		Provenance: []catalog.ArtifactProvenance{
			{Package: "@kb/platform", Version: "2.0.0", ArtifactProvenance: provenanceByPackage["@kb/platform"]},
			{Package: "@kb/sdk", Version: "2.0.0", ArtifactProvenance: provenanceByPackage["@kb/sdk"]},
		},
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Compatibility: &catalog.CompatibilityMatrix{Schema: catalog.CompatibilitySchema, Labels: []catalog.CompatibilityLabel{
			{ID: "platform@2.0.0", Kind: "platform", ArtifactID: "platform", Version: "2.0.0", Requires: []catalog.CompatibilityRelation{{Label: "sdk@2.0.0"}}, Status: "prepared", ValidatedBy: []string{"candidate-runtime-root-test"}},
			{ID: "sdk@2.0.0", Kind: "sdk", ArtifactID: "sdk", Version: "2.0.0", Status: "prepared", ValidatedBy: []string{"candidate-runtime-root-test"}},
		}},
		Platforms: []catalog.PlatformBundle{{
			ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://publisher.invalid/platform.tgz", SHA256: platformHash,
			Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}},
		}},
		SDKs: []catalog.Component{{ID: "sdk", Version: "2.0.0", Package: "@kb/sdk", Tarball: "https://publisher.invalid/sdk.tgz", SHA256: sdkHash}},
	})
	if err != nil {
		t.Fatal(err)
	}
	indexData, err := json.Marshal(index)
	if err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(t.TempDir(), "release-index.json")
	if err := os.WriteFile(indexPath, indexData, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run(indexPath, candidatePackages, root, thirdRegistry.URL); err != nil {
		var causes []string
		for cause := err; cause != nil; cause = errors.Unwrap(cause) {
			causes = append(causes, cause.Error())
		}
		t.Fatalf("candidate runtime-root install failed: %v; cause chain: %s", err, strings.Join(causes, " <- "))
	}
}

func candidateTestPackage(t *testing.T, name, version string, dependencies map[string]string) []byte {
	t.Helper()
	manifest, err := json.Marshal(map[string]any{"name": name, "version": version, "main": "dist/index.js", "dependencies": dependencies})
	if err != nil {
		t.Fatal(err)
	}
	var archive bytes.Buffer
	compressed := gzip.NewWriter(&archive)
	writer := tar.NewWriter(compressed)
	if err := writer.WriteHeader(&tar.Header{Name: "package/package.json", Mode: 0o600, Size: int64(len(manifest))}); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write(manifest); err != nil {
		t.Fatal(err)
	}
	contents := []byte("module.exports = {}\n")
	if err := writer.WriteHeader(&tar.Header{Name: "package/dist/index.js", Mode: 0o600, Size: int64(len(contents))}); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write(contents); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := compressed.Close(); err != nil {
		t.Fatal(err)
	}
	return archive.Bytes()
}

func TestCandidateArtifactResolvesAgainstRuntimeRootRegistry(t *testing.T) {
	producer := httptest.NewServer(nil)
	defer producer.Close()
	archive := filepath.Join(t.TempDir(), "adapter.tgz")
	if err := os.WriteFile(archive, []byte("candidate package bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	registry := &packageRegistry{packages: map[string]map[string]candidatePackage{
		"@kb-labs/adapters-openai": {"2.120.1": {Path: archive}},
	}}
	consumer := httptest.NewServer(registry)
	defer consumer.Close()

	item := contracts.Artifact{Package: "@kb-labs/adapters-openai", Version: "2.120.1", Tarball: producer.URL + "/@kb-labs/adapters-openai/-/adapters-openai-2.120.1.tgz"}
	got := candidateArtifactURL(consumer.URL, item)
	want := consumer.URL + "/artifact?package=%40kb-labs%2Fadapters-openai&version=2.120.1"
	if got != want {
		t.Fatalf("candidate artifact URL = %q, want %q", got, want)
	}
	response, err := http.Get(got)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || string(data) != "candidate package bytes" || producer.URL == consumer.URL {
		t.Fatalf("consumer status=%d body=%q producer=%s consumer=%s", response.StatusCode, data, producer.URL, consumer.URL)
	}
}

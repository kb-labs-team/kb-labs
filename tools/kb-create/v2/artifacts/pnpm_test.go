package artifacts

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/kb-labs/clikit/diag"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kb-labs/clikit/toolchain"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/installed"
	"github.com/kb-labs/create/v2/testworkspace"
	"gopkg.in/yaml.v3"
)

type call struct {
	name string
	args []string
}

func TestPnpmUsesVerifiedTarballInsteadOfRegistrySpec(t *testing.T) {
	payload := []byte("package-bytes")
	sum := fmt.Sprintf("%x", sha256.Sum256(payload))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(payload) }))
	defer server.Close()
	root := t.TempDir()
	cacheRoot := t.TempDir()
	items, runner := sealedTestRunner(t, contracts.Artifact{ID: "platform", Package: "@kb/platform", Version: "2.0.0", SHA256: sum, Tarball: server.URL, ResolvedURL: server.URL})
	if err := (Pnpm{Root: root, CacheRoot: cacheRoot, Runner: runner, ReleaseCatalog: testReleaseCatalog(t, items...)}).Install(items); err != nil {
		t.Fatal(err)
	}
	want := "file:" + filepath.Join(cacheRoot, "packages", sum+".tgz")
	if len(runner.calls) != 1 || !reflect.DeepEqual(runner.calls[0].args, []string{"add", "--dir", root, "--reporter=append-only", want}) {
		t.Fatalf("calls = %#v", runner.calls)
	}
}

func TestPnpmKeepsDistinctTarballsForArtifactsWithSameID(t *testing.T) {
	daemon := packageTarball(t, "@kb-labs/workflow-daemon", "2.120.1", nil)
	entry := packageTarball(t, "@kb-labs/workflow-entry", "2.120.1", nil)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data := map[string][]byte{"/daemon.tgz": daemon, "/entry.tgz": entry}[r.URL.Path]
		if len(data) == 0 {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(server.Close)
	items, runner := sealedTestRunner(t,
		contracts.Artifact{ID: "workflow", Package: "@kb-labs/workflow-daemon", Version: "2.120.1", SHA256: fmt.Sprintf("%x", sha256.Sum256(daemon)), Tarball: server.URL + "/daemon.tgz", ResolvedURL: server.URL + "/daemon.tgz"},
		contracts.Artifact{ID: "workflow", Package: "@kb-labs/workflow-entry", Version: "2.120.1", SHA256: fmt.Sprintf("%x", sha256.Sum256(entry)), Tarball: server.URL + "/entry.tgz", ResolvedURL: server.URL + "/entry.tgz"},
	)
	cacheRoot := t.TempDir()
	if err := (Pnpm{Root: t.TempDir(), CacheRoot: cacheRoot, Runner: runner, ReleaseCatalog: testReleaseCatalog(t, items...)}).Install(items); err != nil {
		t.Fatal(err)
	}
	for _, item := range items {
		path := filepath.Join(cacheRoot, "packages", item.SHA256+".tgz")
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s cache entry: %v", item.Package, err)
		}
		if actual := fmt.Sprintf("%x", sha256.Sum256(data)); actual != item.SHA256 {
			t.Fatalf("%s cache digest = %s, want %s", item.Package, actual, item.SHA256)
		}
	}
}

func TestPnpmRejectsCorruptTarballBeforeWritingSharedCache(t *testing.T) {
	valid := []byte("sealed package bytes")
	corrupt := []byte("corrupt package bytes")
	digest := fmt.Sprintf("%x", sha256.Sum256(valid))
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = writer.Write(corrupt)
	}))
	t.Cleanup(server.Close)
	cacheRoot := t.TempDir()
	item := contracts.Artifact{ID: "platform", Kind: "package", Package: "@kb/platform", Version: "2.0.0",
		SHA256: digest, Tarball: server.URL + "/platform.tgz", ResolvedURL: server.URL + "/platform.tgz"}

	if _, err := (Pnpm{CacheRoot: cacheRoot, Client: server.Client()}).tarball(item); err == nil {
		t.Fatal("corrupt sealed package tarball unexpectedly passed verification")
	}
	cachePath := filepath.Join(cacheRoot, "packages", digest+".tgz")
	if _, err := os.Stat(cachePath); !os.IsNotExist(err) {
		t.Fatalf("corrupt tarball changed shared cache at %s: %v", cachePath, err)
	}
}

func TestPnpmTarballRequiresResolvedSource(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("unresolved index URL was fetched")
	}))
	defer server.Close()
	item := contracts.Artifact{ID: "platform", Package: "@kb/platform", Version: "2.0.0", SHA256: strings.Repeat("a", 64), Tarball: server.URL}
	if _, err := (Pnpm{CacheRoot: t.TempDir()}).tarball(item); err == nil || !strings.Contains(err.Error(), "resolved download URL") {
		t.Fatalf("error = %v, want missing resolved download URL", err)
	}
}

func TestPnpmRestoreRequiresSharedCacheForSealedArtifacts(t *testing.T) {
	item := contracts.Artifact{ID: "platform", Package: "@kb/platform", Version: "2.0.0", SHA256: strings.Repeat("a", 64), Tarball: "https://registry.test/platform.tgz"}
	err := (Pnpm{Root: t.TempDir(), Runner: &fakeRunner{}, ReleaseCatalog: testReleaseCatalog(t, item)}).Restore([]contracts.Artifact{item})
	if err == nil || !strings.Contains(err.Error(), "install root shared cache") {
		t.Fatalf("restore error = %v, want missing shared cache contract", err)
	}
}

// case: S-261.6
func TestPnpmCommandKeepsPackageManagerStateInsideInstallRoot(t *testing.T) {
	testworkspace.Require(t)
	home := t.TempDir()
	root := filepath.Join(home, "kb-platform")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	cacheRoot := filepath.Join(root, "state", ".kb", "v2", "cache")
	t.Setenv("HOME", home)
	t.Setenv("PNPM_HOME", filepath.Join(home, ".local", "share", "pnpm"))
	if err := os.MkdirAll(filepath.Join(home, ".cache", "pnpm"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".cache", "pnpm", "keep"), []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := snapshotTestTree(t, home, root)
	manager := Pnpm{Root: root, CacheRoot: cacheRoot, PackageManagerRoot: filepath.Join(root, "state", "package-manager")}
	if err := manager.prepare(); err != nil {
		t.Fatal(err)
	}
	_, pnpmScript, err := toolchain.PnpmExecutable()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.CopyFS(filepath.Join(manager.corepackHome(), "v1", "pnpm", toolchain.SupportedPnpm), os.DirFS(filepath.Dir(filepath.Dir(pnpmScript)))); err != nil {
		t.Fatal(err)
	}
	fixture := filepath.Join(t.TempDir(), "fixture.tgz")
	if err := os.WriteFile(fixture, packageTarball(t, "@kb-labs/fixture", "1.0.0", nil), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := manager.run("add", "file:"+fixture); err != nil {
		t.Fatalf("pnpm add local artifact: %#v", err)
	}
	for _, command := range []string{"install", "remove"} {
		args := []string(nil)
		if command == "remove" {
			args = []string{"@kb-labs/fixture"}
		}
		if err := manager.run(command, args...); err != nil {
			t.Fatalf("pnpm %s: %v", command, err)
		}
	}
	if err := (Pnpm{Root: root, PackageManagerRoot: filepath.Join(root, "state", "package-manager")}).run("install"); err != nil {
		t.Fatalf("pnpm install without a separate artifact cache root: %v", err)
	}
	assertOutsideTestRootUnchanged(t, before, snapshotTestTree(t, home, root))
	managerRoot := filepath.Join(root, "state", "package-manager")
	for _, path := range []string{
		filepath.Join(managerRoot, "xdg-cache", "pnpm", "lockfile-verified.jsonl"),
		filepath.Join(managerRoot, "xdg-data", "pnpm", "store", "v11", "index.db"),
	} {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("package-manager state %q was not created inside the install root: %v", path, err)
		}
	}
}

func snapshotTestTree(t *testing.T, home, root string) map[string]string {
	t.Helper()
	entries := make(map[string]string)
	err := filepath.WalkDir(home, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return filepath.SkipDir
		}
		if entry.IsDir() {
			entries[path] = "directory"
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		entries[path] = string(data)
		return nil
	})
	if err != nil {
		t.Fatalf("snapshot HOME outside install root: %v", err)
	}
	return entries
}

func assertOutsideTestRootUnchanged(t *testing.T, before, after map[string]string) {
	t.Helper()
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("package-manager command changed HOME outside the install root: before=%#v after=%#v", before, after)
	}
}

// case: S-261.6
func TestPnpmMinimumReleaseAgeExemptsOnlySealedExactVersions(t *testing.T) {
	testworkspace.Require(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	packageManagerRoot := filepath.Join(home, "package-manager")
	t.Setenv("COREPACK_HOME", filepath.Join(packageManagerRoot, "corepack"))
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("pnpm 11.4.0 integration requires Node.js; node is unavailable: %v", err)
	}
	node, pnpmScript, err := toolchain.PnpmExecutable()
	if err != nil {
		t.Fatal(err)
	}
	versionCheck := exec.Command(node, pnpmScript, "--version")
	versionCheck.Env = os.Environ()
	if output, err := versionCheck.CombinedOutput(); err != nil {
		t.Fatalf("cached pnpm %s failed: %v: %s", pnpmScript, err, strings.TrimSpace(string(output)))
	} else if strings.TrimSpace(string(output)) != toolchain.SupportedPnpm {
		t.Fatalf("cached pnpm selected unexpected version: %q", strings.TrimSpace(string(output)))
	}

	// The release-age registry serves only the test packages, not pnpm itself.
	// Seed the package-manager fixture from the already verified pinned installation.
	cachedPnpm := filepath.Dir(filepath.Dir(pnpmScript))
	fixturePnpm := filepath.Join(packageManagerRoot, "corepack", "v1", "pnpm", toolchain.SupportedPnpm)
	if err := os.CopyFS(fixturePnpm, os.DirFS(cachedPnpm)); err != nil {
		t.Fatal(err)
	}

	sealedV1 := packageTarball(t, "@kb-labs/sealed", "1.0.0", nil)
	sealedV2 := packageTarball(t, "@kb-labs/sealed", "1.0.1", nil)
	sealedWithFreshDependency := packageTarball(t, "@kb-labs/sealed-fresh-dependency", "1.0.1", map[string]string{"@unrelated/fresh": "1.0.0"})
	freshDependency := packageTarball(t, "@unrelated/fresh", "1.0.0", nil)
	itemV1 := sealedArtifact(t, "1.0.0", sealedV1)
	itemV2 := sealedArtifact(t, "1.0.1", sealedV2)
	sealedFreshDependency := sealArtifactTarball(t, contracts.Artifact{
		ID: "sealed-fresh-dependency", Package: "@kb-labs/sealed-fresh-dependency", Version: "1.0.1",
	}, sealedWithFreshDependency)
	freshDependencyArtifact := sealArtifactTarball(t, contracts.Artifact{
		ID: "fresh", Package: "@unrelated/fresh", Version: "1.0.0",
	}, freshDependency)
	var requestLog []string
	var requestLogMu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestLogMu.Lock()
		requestLog = append(requestLog, r.URL.Path)
		requestLogMu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/fresh/sealed-fresh-dependency-1.0.1.tgz"):
			_, _ = w.Write(sealedWithFreshDependency)
		case strings.HasSuffix(r.URL.Path, "/fresh/fresh-1.0.0.tgz"):
			_, _ = w.Write(freshDependency)
		case strings.HasSuffix(r.URL.Path, "/sealed-1.0.0.tgz"):
			_, _ = w.Write(sealedV1)
		case strings.HasSuffix(r.URL.Path, "/sealed-1.0.1.tgz"):
			_, _ = w.Write(sealedV2)
		case strings.HasSuffix(r.URL.Path, "/fresh-1.0.0.tgz"):
			_, _ = w.Write(freshDependency)
		case strings.Contains(strings.ToLower(r.URL.Path), "kb-labs") && strings.Contains(strings.ToLower(r.URL.Path), "sealed"):
			prefix := ""
			name := "@kb-labs/sealed"
			tarballs := map[string]registryTarball{
				"1.0.0": {URL: serverURL(r) + "/sealed-1.0.0.tgz", Integrity: itemV1.Provenance.Integrity},
				"1.0.1": {URL: serverURL(r) + "/sealed-1.0.1.tgz", Integrity: itemV2.Provenance.Integrity},
			}
			if strings.HasPrefix(r.URL.Path, "/fresh/") {
				prefix = "/fresh"
				name = "@kb-labs/sealed-fresh-dependency"
				tarballs = map[string]registryTarball{"1.0.1": {
					URL:       serverURL(r) + prefix + "/sealed-fresh-dependency-1.0.1.tgz",
					Integrity: sealedFreshDependency.Provenance.Integrity,
				}}
			}
			dependencies := map[string]string(nil)
			if name == "@kb-labs/sealed-fresh-dependency" {
				dependencies = map[string]string{"@unrelated/fresh": "1.0.0"}
			}
			writeRegistryPackument(w, name, tarballs, dependencies)
		case strings.Contains(strings.ToLower(r.URL.Path), "unrelated"):
			prefix := ""
			if strings.HasPrefix(r.URL.Path, "/fresh/") {
				prefix = "/fresh"
			}
			writeRegistryPackument(w, "@unrelated/fresh", map[string]registryTarball{
				"1.0.0": {URL: serverURL(r) + prefix + "/fresh-1.0.0.tgz", Integrity: freshDependencyArtifact.Provenance.Integrity},
			}, nil)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	// Third-party metadata is served by the default registry, independently of
	// the scoped release registry.
	t.Setenv("npm_config_registry", server.URL+"/fresh")

	root := t.TempDir()
	writeMinimumReleaseAgeWorkspace(t, root)
	if err := os.WriteFile(filepath.Join(root, ".npmrc"), []byte("registry="+server.URL+"/fresh\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var provisionLog strings.Builder
	pm := Pnpm{Root: root, PackageManagerRoot: packageManagerRoot, Registry: server.URL, Log: &provisionLog, ReleaseCatalog: testReleaseCatalog(t, itemV1, itemV2)}
	if err := pm.Install([]contracts.Artifact{itemV1}); err != nil {
		t.Fatalf("install first sealed exact version: %#v; process output: %s", err, diag.RedactText(provisionLog.String()))
	}
	if err := pm.Install([]contracts.Artifact{itemV2}); err != nil {
		t.Fatalf("install second sealed exact version from the coalesced exclusion: %v", err)
	}
	workspace, err := os.ReadFile(filepath.Join(root, "pnpm-workspace.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(workspace), "@kb-labs/sealed@1.0.0 || 1.0.1") {
		t.Fatalf("workspace config did not retain both sealed exact versions: %s", workspace)
	}

	freshRoot := t.TempDir()
	writeMinimumReleaseAgeWorkspace(t, freshRoot)
	if err := os.WriteFile(filepath.Join(freshRoot, ".npmrc"), []byte("registry="+server.URL+"/fresh\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var transcript strings.Builder
	err = (Pnpm{Root: freshRoot, PackageManagerRoot: packageManagerRoot, Registry: server.URL + "/fresh", Log: &transcript, ReleaseCatalog: testReleaseCatalog(t, sealedFreshDependency)}).Install([]contracts.Artifact{sealedFreshDependency})
	if err == nil {
		requestLogMu.Lock()
		requests := append([]string(nil), requestLog...)
		requestLogMu.Unlock()
		t.Fatalf("expected the unrelated freshly published dependency to be refused; transcript=%s requests=%v", transcript.String(), requests)
	}
	if !strings.Contains(transcript.String(), "ERR_PNPM_NO_MATURE_MATCHING_VERSION") || !strings.Contains(transcript.String(), "minimumReleaseAge cutoff") {
		t.Fatalf("pnpm error did not identify the release-age refusal: err=%v transcript=%s", err, transcript.String())
	}
	foundFreshMetadata := false
	requestLogMu.Lock()
	requests := append([]string(nil), requestLog...)
	requestLogMu.Unlock()
	for _, path := range requests {
		if strings.Contains(strings.ToLower(path), "unrelated") {
			foundFreshMetadata = true
		}
	}
	if !foundFreshMetadata {
		t.Fatalf("pnpm did not resolve the unrelated dependency from the local registry: requests=%v", requests)
	}
}

func writeMinimumReleaseAgeWorkspace(t *testing.T, root string) {
	t.Helper()
	if err := os.MkdirAll(root, 0o750); err != nil {
		t.Fatal(err)
	}
	config := "minimumReleaseAge: 1440\n"
	if err := os.WriteFile(filepath.Join(root, "pnpm-workspace.yaml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
}

func sealedArtifact(t *testing.T, version string, tarball []byte) contracts.Artifact {
	t.Helper()
	return sealArtifactTarball(t, contracts.Artifact{ID: "sealed", Package: "@kb-labs/sealed", Version: version}, tarball)
}

func sealArtifactTarball(t *testing.T, item contracts.Artifact, tarball []byte) contracts.Artifact {
	t.Helper()
	packagesDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(packagesDir, "artifact.tgz"), tarball, 0o600); err != nil {
		t.Fatal(err)
	}
	sealed, err := SealPackageProvenance(packagesDir, []PackageManifestInput{{
		Package: item.Package, Version: item.Version, Tarball: "artifact.tgz",
	}}, "test-fixture-revision")
	if err != nil {
		t.Fatalf("seal fixture package provenance: %v", err)
	}
	item.Provenance = contracts.ArtifactProvenance{
		SourceRevision: sealed[0].SourceRevision,
		Integrity:      sealed[0].Integrity,
		DistSHA256:     sealed[0].DistSHA256,
		ContentScope:   sealed[0].ContentScope,
		PackageSHA256:  sealed[0].PackageSHA256,
	}
	return item
}

type registryTarball struct {
	URL       string
	Integrity string
}

func writeRegistryPackument(w http.ResponseWriter, name string, tarballs map[string]registryTarball, dependencies map[string]string) {
	versions := make(map[string]any, len(tarballs))
	times := make(map[string]string, len(tarballs))
	now := time.Now().UTC().Format(time.RFC3339)
	var latest string
	for version, tarball := range tarballs {
		metadata := map[string]any{
			"name": name, "version": version,
			"dist": map[string]string{"tarball": tarball.URL, "integrity": tarball.Integrity},
		}
		if dependencies != nil {
			metadata["dependencies"] = dependencies
		}
		versions[version] = metadata
		times[version] = now
		latest = version
	}
	w.Header().Set("Content-Type", "application/vnd.npm.install-v1+json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"name": name, "dist-tags": map[string]string{"latest": latest}, "versions": versions, "time": times,
	})
}

func packageTarball(t *testing.T, name, version string, dependencies map[string]string) []byte {
	t.Helper()
	manifestValue := map[string]any{"name": name, "version": version}
	if dependencies != nil {
		manifestValue["dependencies"] = dependencies
	}
	manifest, err := json.Marshal(manifestValue)
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	compressed := gzip.NewWriter(&output)
	archive := tar.NewWriter(compressed)
	if err := archive.WriteHeader(&tar.Header{Name: "package/package.json", Mode: 0o600, Size: int64(len(manifest))}); err != nil {
		t.Fatal(err)
	}
	if _, err := archive.Write(manifest); err != nil {
		t.Fatal(err)
	}
	distContent := []byte("fixture dist: " + name + "@" + version)
	if err := archive.WriteHeader(&tar.Header{Name: "package/dist/index.js", Mode: 0o644, Size: int64(len(distContent))}); err != nil {
		t.Fatal(err)
	}
	if _, err := archive.Write(distContent); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := compressed.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func serverURL(request *http.Request) string {
	return "http://" + request.Host
}

func TestPnpmReportsExpectedAndReceivedTarballChecksums(t *testing.T) {
	payload := []byte("unexpected-package-bytes")
	sum := fmt.Sprintf("%x", sha256.Sum256([]byte("expected-package-bytes")))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(payload) }))
	defer server.Close()
	runner := &fakeRunner{}
	err := (Pnpm{Root: t.TempDir(), CacheRoot: t.TempDir(), Runner: runner}).Install([]contracts.Artifact{{ID: "platform", Package: "@kb/platform", Version: "2.0.0", SHA256: sum, Tarball: server.URL, ResolvedURL: server.URL}})
	if err == nil || !strings.Contains(err.Error(), "expected "+sum) || !strings.Contains(err.Error(), fmt.Sprintf("got %x", sha256.Sum256(payload))) || len(runner.calls) != 0 {
		t.Fatalf("error/calls = %v / %#v", err, runner.calls)
	}
}

func TestPnpmSealedArtifactOverridesFollowInstallUpdateAndRollback(t *testing.T) {
	root := t.TempDir()
	cacheRoot := t.TempDir()
	workspace := filepath.Join(root, "pnpm-workspace.yaml")
	if err := os.WriteFile(workspace, []byte("overrides:\n  lodash: 4.17.21\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	sealed := sealedTestArtifacts(t,
		contracts.Artifact{ID: "platform", Kind: "platform-member", Package: "@kb/platform", Version: "2.0.0", SHA256: fmt.Sprintf("%x", sha256.Sum256([]byte("old"))), Tarball: "https://registry.test/platform-old.tgz"},
		contracts.Artifact{ID: "runtime", Kind: "core", Package: "@kb/runtime", Version: "2.0.0", SHA256: fmt.Sprintf("%x", sha256.Sum256([]byte("old-runtime"))), Tarball: "https://registry.test/runtime-old.tgz"},
		contracts.Artifact{ID: "platform", Kind: "platform-member", Package: "@kb/platform", Version: "2.1.0", SHA256: fmt.Sprintf("%x", sha256.Sum256([]byte("new"))), Tarball: "https://registry.test/platform-new.tgz"},
	)
	old, oldRuntime, updated := sealed[0], sealed[1], sealed[2]
	for _, payload := range [][]byte{[]byte("old"), []byte("old-runtime"), []byte("new"), []byte("new-runtime")} {
		sum := fmt.Sprintf("%x", sha256.Sum256(payload))
		cache := filepath.Join(cacheRoot, "packages")
		if err := os.MkdirAll(cache, 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(cache, sum+".tgz"), payload, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	runner := &fakeRunner{packages: []contracts.Artifact{old, oldRuntime}}
	pm := Pnpm{Root: root, CacheRoot: cacheRoot, Runner: runner, ReleaseCatalog: testReleaseCatalog(t, sealed...)}
	if err := pm.Install([]contracts.Artifact{old, oldRuntime}); err != nil {
		t.Fatalf("initial install: %v", err)
	}
	assertSealedArtifactOverrides(t, workspace, cacheRoot, []contracts.Artifact{old, oldRuntime})
	runner.packages = []contracts.Artifact{updated}
	if err := pm.Install([]contracts.Artifact{updated}); err != nil {
		t.Fatalf("update: %v", err)
	}
	assertSealedArtifactOverrides(t, workspace, cacheRoot, []contracts.Artifact{updated})
	runner.restore = []contracts.Artifact{old, oldRuntime}
	if err := pm.Restore([]contracts.Artifact{old, oldRuntime}); err != nil {
		t.Fatalf("rollback package restore: %v", err)
	}
	assertSealedArtifactOverrides(t, workspace, cacheRoot, []contracts.Artifact{old, oldRuntime})
}

func assertSealedArtifactOverrides(t *testing.T, workspace, cacheRoot string, artifacts []contracts.Artifact) {
	t.Helper()
	data, err := os.ReadFile(workspace)
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Overrides map[string]string `yaml:"overrides"`
	}
	if err := yaml.Unmarshal(data, &config); err != nil {
		t.Fatalf("parse pnpm workspace config: %v", err)
	}
	if config.Overrides["lodash"] != "4.17.21" {
		t.Fatalf("unrelated override was lost: %#v", config.Overrides)
	}
	wantNames := make(map[string]struct{}, len(artifacts))
	for _, artifact := range artifacts {
		want := "file:" + filepath.ToSlash(filepath.Join(cacheRoot, "packages", artifact.SHA256+".tgz"))
		wantNames[artifact.Package] = struct{}{}
		if config.Overrides[artifact.Package] != want {
			t.Fatalf("override for %s = %q, want %q; config: %s", artifact.Package, config.Overrides[artifact.Package], want, data)
		}
	}
	for name, value := range config.Overrides {
		managedCachePrefix := "file:" + filepath.ToSlash(filepath.Join(cacheRoot, "packages")) + "/"
		if strings.HasPrefix(value, "file:.kb/v2/cache/packages/") || strings.HasPrefix(value, managedCachePrefix) {
			if _, exists := wantNames[name]; !exists {
				t.Fatalf("stale sealed override remains for %s: %q", name, value)
			}
		}
	}
}

func TestPnpmReportsSignalTerminationAsLikelyMemoryFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("signal termination is only available on Unix")
	}
	runner := runnerFunc(func(context.Context, io.Writer, string, ...string) error {
		return exec.Command("sh", "-c", "kill -9 $$").Run()
	})
	err := (Pnpm{Root: t.TempDir(), Runner: runner, ReleaseCatalog: testReleaseCatalog(t, contracts.Artifact{ID: "a", Package: "@kb/a", Version: "1.0.0"})}).Install([]contracts.Artifact{{ID: "a", Package: "@kb/a", Version: "1.0.0"}})
	failure, ok := err.(*diag.Diag)
	if !ok || failure.Code != contracts.CodePackageManagerKilled || !strings.Contains(failure.Message, "likely out of memory") || !strings.Contains(failure.Message, "992.3 MiB RSS") || failure.Meta["requiredAvailableMemory"] != "1.20 GiB" || failure.Meta["tunedPeakMemory"] != "992.3 MiB" {
		t.Fatalf("error = %#v", err)
	}
}

type runnerFunc func(context.Context, io.Writer, string, ...string) error

func (run runnerFunc) Run(ctx context.Context, output io.Writer, name string, args ...string) error {
	return run(ctx, output, name, args...)
}

// Regression coverage for the mechanism, not just its absence from the pnpm
// invocation: pnpm 11.4.0 mis-parses a comma-joined --allow-build value as a
// single "name@version-union" spec (pnpm's invalid version-union error) the
// moment the list mixes scoped packages with others
// — confirmed directly against that pnpm version. The fix moves the
// approval list into pnpm-workspace.yaml's `allowBuilds` map instead, which
// handles scoped names correctly since it's YAML, not a CLI string.
func TestPnpmWritesWorkspaceAllowBuildsList(t *testing.T) {
	root := t.TempDir()
	items, runner := sealedTestRunner(t, contracts.Artifact{ID: "a", Package: "@kb/a", Version: "1.0.0"})
	if err := (Pnpm{Root: root, Runner: runner, ReleaseCatalog: testReleaseCatalog(t, items...)}).Install(items); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "pnpm-workspace.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	for _, setting := range []string{"autoInstallPeers: false", "childConcurrency: 1", "networkConcurrency: 4", "sideEffectsCache: false"} {
		if !strings.Contains(got, setting) {
			t.Fatalf("pnpm-workspace.yaml = %q, missing %q", got, setting)
		}
	}
	for _, name := range approvedNativeBuilds {
		want := fmt.Sprintf("%q: true", name)
		if !strings.Contains(got, want) {
			t.Fatalf("pnpm-workspace.yaml = %q, missing %q", got, want)
		}
	}
	if strings.Contains(got, "@kb-labs/devkit") {
		t.Fatalf("pnpm-workspace.yaml must not approve @kb-labs/devkit build scripts: %q", got)
	}
}

func TestPnpmMaterializesSignedArtifactManifestForDoctor(t *testing.T) {
	root := t.TempDir()
	item := contracts.Artifact{
		ID: "disk-io-storage", Kind: "adapter", Package: "@kb/data-store", Version: "2.0.0",
		Config: []contracts.ConfigRequirement{{ID: "store.path", Path: "/storage/path", Required: true, Default: `"data"`, Hint: "set a storage path"}, {ID: "gateway.jwtSecret", Secret: true, Generate: true, Env: "GATEWAY_JWT_SECRET", Services: []string{"gateway"}}},
	}
	items, runner := sealedTestRunner(t, item)
	item = items[0]
	if err := (Pnpm{Root: root, Runner: runner, ReleaseCatalog: testReleaseCatalog(t, items...)}).Install(items); err != nil {
		t.Fatal(err)
	}
	manifest, err := installed.Load(root, item)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Requirements) != 2 {
		requirements := manifest.Requirements
		t.Fatalf("requirements = %#v", requirements)
	}
	requirement := manifest.Requirements[0]
	if requirement.ID != "store.path" || requirement.Path != "/storage/path" || requirement.Hint != "set a storage path" || string(requirement.Default) != `"data"` {
		t.Fatalf("requirement = %#v", requirement)
	}
	generated := manifest.Requirements[1]
	if generated.ID != "gateway.jwtSecret" || !generated.Generate || !generated.Secret {
		t.Fatalf("generated secret requirement = %#v", generated)
	}
}

// S-024.5: package-manager restore can replace pnpm's virtual-store package
// directory, so doctor metadata must be materialized again for the receipt
// restored from the snapshot.
func TestPnpmInstallUpdateRestoreKeepsManifestsForEveryReceiptArtifact(t *testing.T) {
	root := t.TempDir()
	old := sealedTestArtifacts(t,
		contracts.Artifact{ID: "analytics-file", Kind: "adapter", Package: "@kb-labs/adapters-analytics-file", Version: "2.120.1"},
		contracts.Artifact{ID: "gateway", Kind: "platform-member", Package: "@kb-labs/gateway-app", Version: "2.120.1"},
	)
	updated := sealedTestArtifacts(t,
		contracts.Artifact{ID: "analytics-file", Kind: "adapter", Package: "@kb-labs/adapters-analytics-file", Version: "2.120.2"},
		contracts.Artifact{ID: "gateway", Kind: "platform-member", Package: "@kb-labs/gateway-app", Version: "2.120.2"},
	)
	runner := &relinkingPnpmRunner{root: root, restore: old, artifacts: append(append([]contracts.Artifact{}, old...), updated...)}
	pm := Pnpm{Root: root, Runner: runner, ReleaseCatalog: testReleaseCatalog(t, append(append([]contracts.Artifact{}, old...), updated...)...)}
	if err := pm.Install(old); err != nil {
		t.Fatalf("install initial receipt: %v", err)
	}
	assertReceiptManifestsLoad(t, root, old)
	if err := pm.Install(updated); err != nil {
		t.Fatalf("apply update: %v", err)
	}
	assertReceiptManifestsLoad(t, root, updated)

	if err := pm.Restore(old); err != nil {
		t.Fatalf("restore snapshot package state: %v", err)
	}
	assertReceiptManifestsLoad(t, root, old)
}

func assertReceiptManifestsLoad(t *testing.T, root string, artifacts []contracts.Artifact) {
	t.Helper()
	for _, artifact := range artifacts {
		if _, err := installed.Load(root, artifact); err != nil {
			t.Errorf("load manifest for receipt artifact %s (%s@%s): %v", artifact.ID, artifact.Package, artifact.Version, err)
		}
	}
}

// relinkingPnpmRunner models pnpm's node_modules symlink into the virtual
// store. Each add/install makes fresh package directories from package
// metadata, which drops files that the previous operation wrote into them.
type relinkingPnpmRunner struct {
	root      string
	restore   []contracts.Artifact
	active    []contracts.Artifact
	artifacts []contracts.Artifact
}

func (r *relinkingPnpmRunner) Run(_ context.Context, _ io.Writer, _ string, args ...string) error {
	if len(args) == 0 {
		return fmt.Errorf("pnpm command is missing")
	}
	switch args[0] {
	case "add":
		var next []contracts.Artifact
		for _, arg := range args[1:] {
			if !strings.HasPrefix(arg, "@kb-labs/") {
				continue
			}
			separator := strings.LastIndex(arg, "@")
			if separator < 0 {
				continue
			}
			for _, item := range r.artifacts {
				if item.Package == arg[:separator] && item.Version == arg[separator+1:] {
					next = append(next, item)
				}
			}
		}
		r.active = next
	case "install":
		r.active = append([]contracts.Artifact(nil), r.restore...)
	default:
		return fmt.Errorf("unexpected pnpm command %q", args[0])
	}
	for _, artifact := range r.active {
		if err := r.relink(artifact); err != nil {
			return err
		}
	}
	return writeTestPackageLock(r.root, r.active)
}

func (r *relinkingPnpmRunner) relink(artifact contracts.Artifact) error {
	packageRoot := filepath.Join(r.root, "node_modules", filepath.FromSlash(artifact.Package))
	storePackage := filepath.Join(r.root, "node_modules", ".pnpm", strings.ReplaceAll(artifact.Package, "/", "+")+"@"+artifact.Version, "node_modules", filepath.FromSlash(artifact.Package))
	if err := os.RemoveAll(storePackage); err != nil {
		return err
	}
	if err := os.MkdirAll(storePackage, 0o755); err != nil {
		return err
	}
	packageJSON, err := json.Marshal(map[string]string{"name": artifact.Package, "version": artifact.Version})
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(storePackage, "package.json"), packageJSON, 0o644); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(storePackage, "dist"), 0o755); err != nil {
		return err
	}
	content := []byte("fixture dist: " + artifact.Package + "@" + artifact.Version)
	if err := os.WriteFile(filepath.Join(storePackage, "dist", "index.js"), content, 0o644); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(packageRoot), 0o755); err != nil {
		return err
	}
	if err := os.Remove(packageRoot); err != nil && !os.IsNotExist(err) {
		return err
	}
	relative, err := filepath.Rel(filepath.Dir(packageRoot), storePackage)
	if err != nil {
		return err
	}
	return os.Symlink(relative, packageRoot)
}

func TestPnpmPersistsExplicitRegistryForLifecycleOperations(t *testing.T) {
	root := t.TempDir()
	items, runner := sealedTestRunner(t, contracts.Artifact{ID: "a", Package: "@kb/a", Version: "1.0.0"})
	if err := (Pnpm{Root: root, Registry: "https://registry.test", Runner: runner, ReleaseCatalog: testReleaseCatalog(t, items...)}).Install(items); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, ".npmrc"))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(data), "@kb-labs:registry=https://registry.test\n"; got != want {
		t.Fatalf(".npmrc = %q, want %q", got, want)
	}
}

func TestPnpmPreservesExistingNpmrc(t *testing.T) {
	root := t.TempDir()
	want := "registry=https://existing.test\n"
	if err := os.WriteFile(filepath.Join(root, ".npmrc"), []byte(want), 0o600); err != nil {
		t.Fatal(err)
	}
	items, runner := sealedTestRunner(t, contracts.Artifact{ID: "a", Package: "@kb/a", Version: "1.0.0"})
	if err := (Pnpm{Root: root, Registry: "https://registry.test", Runner: runner, ReleaseCatalog: testReleaseCatalog(t, items...)}).Install(items); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, ".npmrc"))
	if err != nil {
		t.Fatal(err)
	}
	want += "@kb-labs:registry=https://registry.test\n"
	if string(data) != want {
		t.Fatalf("existing .npmrc changed: got %q, want %q", data, want)
	}
}

// case: S-284.20
func TestPnpmUpdatesExistingScopedRegistry(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, ".npmrc")
	if err := os.WriteFile(path, []byte("registry=https://default.test\n@kb-labs:registry=https://old.test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := (Pnpm{Root: root, Registry: "https://new.test"}).prepareNpmrc(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(data), "registry=https://default.test\n@kb-labs:registry=https://new.test\n"; got != want {
		t.Fatalf("config=%q want=%q", got, want)
	}
}

// case: S-284.20
func TestPnpmExcludesOnlySealedTransitiveVersion(t *testing.T) {
	root := t.TempDir()
	writeMinimumReleaseAgeWorkspace(t, root)
	source, err := catalog.LoadFile(filepath.Join("..", "cmd", "kb-create-v2", "testdata", "x251-release-index.json"))
	if err != nil {
		t.Fatal(err)
	}
	verified, err := catalog.VerifyCatalog(source)
	if err != nil {
		t.Fatal(err)
	}
	manager := Pnpm{Root: root, ReleaseCatalog: verified}
	if err := manager.mergeMinimumReleaseAgeExclude(nil); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "pnpm-workspace.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var actual struct {
		Exclude []string `yaml:"minimumReleaseAgeExclude"`
	}
	if err := yaml.Unmarshal(data, &actual); err != nil {
		t.Fatal(err)
	}
	got := make(map[string]bool)
	for _, entry := range actual.Exclude {
		name, versions, ok := exactReleaseAgeExclusion(entry)
		if !ok {
			t.Fatalf("non-exact exclusion %q", entry)
		}
		for _, version := range versions {
			got[name+"@"+version] = true
		}
	}
	want := make(map[string]bool)
	for _, item := range source.Provenance {
		want[item.Package+"@"+item.Version] = true
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("exclusions=%v, provenance=%v", got, want)
	}
}

func TestPnpmDoesNotPinGeneratedProjectToOnePatchPnpmVersion(t *testing.T) {
	root := t.TempDir()
	items, runner := sealedTestRunner(t, contracts.Artifact{ID: "a", Package: "@kb/a", Version: "1.0.0"})
	if err := (Pnpm{Root: root, Runner: runner, ReleaseCatalog: testReleaseCatalog(t, items...)}).Install(items); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if _, exists := manifest["packageManager"]; exists {
		t.Fatalf("generated package.json must not pin packageManager: %s", data)
	}
}

func TestPnpmUninstallRemovesInstalledArtifactsByPackageName(t *testing.T) {
	root := t.TempDir()
	runner := &fakeRunner{}
	items := []contracts.Artifact{
		{ID: "platform", Package: "@kb/platform", Version: "2.0.0"},
		{ID: "duplicate", Package: "@kb/platform", Version: "2.0.0"},
		{ID: "binary", Kind: "binary", Version: "2.0.0"},
	}
	if err := (Pnpm{Root: root, Runner: runner}).Uninstall(items); err != nil {
		t.Fatal(err)
	}
	want := []string{"remove", "--dir", root, "--reporter=append-only", "--config.minimumReleaseAge=0", "@kb/platform"}
	if len(runner.calls) != 1 || !reflect.DeepEqual(runner.calls[0].args, want) {
		t.Fatalf("calls = %#v", runner.calls)
	}
}

func TestPnpmUninstallUsesRegistryConfigWithoutUnsupportedFlag(t *testing.T) {
	root := t.TempDir()
	runner := &fakeRunner{}
	if err := (Pnpm{Root: root, Registry: "https://registry.test", Runner: runner}).Uninstall([]contracts.Artifact{{ID: "platform", Package: "@kb/platform", Version: "2.0.0"}}); err != nil {
		t.Fatal(err)
	}
	want := []string{"remove", "--dir", root, "--reporter=append-only", "--config.minimumReleaseAge=0", "@kb/platform"}
	if len(runner.calls) != 1 || !reflect.DeepEqual(runner.calls[0].args, want) {
		t.Fatalf("calls = %#v, want %q", runner.calls, want)
	}
}

func TestPnpmMergesExactPlanVersionIntoExistingWorkspaceYAML(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "pnpm-workspace.yaml")
	custom := "allowBuilds:\n  \"esbuild\": true\nminimumReleaseAgeExclude:\n  - \"@kb/a@0.9.0\"\n"
	if err := os.WriteFile(path, []byte(custom), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "package.json"), []byte(`{"name":"kb-platform","private":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	items, runner := sealedTestRunner(t, contracts.Artifact{ID: "a", Package: "@kb/a", Version: "1.0.0"})
	if err := (Pnpm{Root: root, Runner: runner, ReleaseCatalog: testReleaseCatalog(t, items...)}).Install(items); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		MinimumReleaseAgeExclude []string `yaml:"minimumReleaseAgeExclude"`
	}
	if err := yaml.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(config.MinimumReleaseAgeExclude, []string{"@kb/a@0.9.0 || 1.0.0"}) {
		t.Fatalf("minimumReleaseAgeExclude = %#v, want one disjunction for the exact versions; yaml: %s", config.MinimumReleaseAgeExclude, data)
	}
}

func TestPnpmCoalescesEveryExactVersionForTheSamePackage(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "pnpm-workspace.yaml")
	if err := os.WriteFile(workspace, []byte("minimumReleaseAgeExclude:\n  - '@kb/runtime@1.0.0'\n  - '@kb/runtime@1.0.1'\n  - '@user/tool@4.2.0'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	plan, runner := sealedTestRunner(t, contracts.Artifact{ID: "runtime", Package: "@kb/runtime", Version: "1.0.2"})
	if err := (Pnpm{Root: root, Runner: runner, ReleaseCatalog: testReleaseCatalog(t, plan...)}).Install(plan); err != nil {
		t.Fatal(err)
	}
	assertReleaseAgeExclusions(t, workspace, []string{
		"@kb/runtime@1.0.0 || 1.0.1 || 1.0.2", "@user/tool@4.2.0",
	})
}

// case: S-023.7
func TestPnpmExcludesExactPlanVersionsAndPreservesWorkspaceEntries(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "pnpm-workspace.yaml")
	if err := os.WriteFile(workspace, []byte("minimumReleaseAgeExclude:\n  - '@user/tool@4.2.0'\n  - '@pnpm/tool@3.1.0'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	installedDir := filepath.Join(root, "node_modules", "@kb", "runtime")
	if err := os.MkdirAll(installedDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(installedDir, "package.json"), []byte(`{"name":"@kb/runtime","version":"2.0.0"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	payload := []byte("verified-file-artifact")
	sum := fmt.Sprintf("%x", sha256.Sum256(payload))
	cache := filepath.Join(root, ".kb", "v2", "cache", "packages")
	if err := os.MkdirAll(cache, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, sum+".tgz"), payload, 0o600); err != nil {
		t.Fatal(err)
	}
	plan, runner := sealedTestRunner(t,
		contracts.Artifact{ID: "runtime", Package: "@kb/runtime", Version: "2.0.0"},
		contracts.Artifact{ID: "new-file", Package: "@kb/new-file", Version: "1.5.0", SHA256: sum, Tarball: "https://registry.test/new-file.tgz"},
	)
	if err := (Pnpm{Root: root, CacheRoot: filepath.Join(root, ".kb", "v2", "cache"), Runner: runner, ReleaseCatalog: testReleaseCatalog(t, plan...)}).Install(plan); err != nil {
		t.Fatal(err)
	}
	assertReleaseAgeExclusions(t, workspace, []string{
		"@user/tool@4.2.0", "@pnpm/tool@3.1.0", "@kb/runtime@2.0.0", "@kb/new-file@1.5.0",
	})

	// A rollback to plan N must merge N's exact versions after the snapshot is restored.
	if err := (Pnpm{Root: root, CacheRoot: filepath.Join(root, ".kb", "v2", "cache"), Runner: runner, ReleaseCatalog: testReleaseCatalog(t, plan...)}).Restore(plan); err != nil {
		t.Fatal(err)
	}
	assertReleaseAgeExclusions(t, workspace, []string{
		"@user/tool@4.2.0", "@pnpm/tool@3.1.0", "@kb/runtime@2.0.0", "@kb/new-file@1.5.0",
	})
}

func assertReleaseAgeExclusions(t *testing.T, path string, want []string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		MinimumReleaseAgeExclude []string `yaml:"minimumReleaseAgeExclude"`
	}
	if err := yaml.Unmarshal(data, &config); err != nil {
		t.Fatalf("parse pnpm-workspace.yaml: %v", err)
	}
	got := append([]string(nil), config.MinimumReleaseAgeExclude...)
	sort.Strings(got)
	wantSorted := append([]string(nil), want...)
	sort.Strings(wantSorted)
	if !reflect.DeepEqual(got, wantSorted) {
		t.Fatalf("minimumReleaseAgeExclude = %#v, want %#v; yaml: %s", got, wantSorted, data)
	}
	for _, bare := range []string{"@kb/runtime", "@kb/new-file"} {
		for _, exclusion := range config.MinimumReleaseAgeExclude {
			if exclusion == bare {
				t.Fatalf("minimumReleaseAgeExclude widened to bare package %q", bare)
			}
		}
	}
}

type fakeRunner struct {
	calls    []call
	err      error
	packages []contracts.Artifact
	restore  []contracts.Artifact
}

type changedDistRunner struct{ delegate *fakeRunner }

func (r changedDistRunner) Run(ctx context.Context, output io.Writer, name string, args ...string) error {
	if err := r.delegate.Run(ctx, output, name, args...); err != nil {
		return err
	}
	root := ""
	for index, argument := range args {
		if argument == "--dir" && index+1 < len(args) {
			root = args[index+1]
		}
	}
	if root == "" {
		return nil
	}
	for _, item := range r.delegate.packages {
		path := filepath.Join(root, "node_modules", filepath.FromSlash(item.Package), "dist", "index.js")
		if err := os.WriteFile(path, []byte("mutated after package install"), 0o644); err != nil {
			return err
		}
	}
	return nil
}

func TestPnpmInstallRefusesChangedDistBeforeAcceptingCandidate(t *testing.T) {
	root := t.TempDir()
	items := sealedTestArtifacts(t, contracts.Artifact{ID: "sample", Package: "@kb-labs/sample", Version: "1.0.0"})
	delegate := &fakeRunner{packages: items}
	err := (Pnpm{Root: root, Registry: "https://registry.test", Runner: changedDistRunner{delegate: delegate}, ReleaseCatalog: testReleaseCatalog(t, items...)}).Install(items)
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != contracts.CodeProvenanceMismatch {
		t.Fatalf("install error = %v, want catalogued provenance mismatch", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".kb", "v2", "installed-provenance.json")); !os.IsNotExist(err) {
		t.Fatalf("install accepted or recorded the changed package provenance: %v", err)
	}
}

func (r *fakeRunner) Run(_ context.Context, _ io.Writer, name string, args ...string) error {
	r.calls = append(r.calls, call{name, args})
	if r.err != nil {
		return r.err
	}
	if name != "pnpm" || len(args) == 0 || (args[0] != "add" && args[0] != "install") {
		return nil
	}
	root := ""
	for index, argument := range args {
		if argument == "--dir" && index+1 < len(args) {
			root = args[index+1]
		}
	}
	if root == "" {
		return nil
	}
	items := r.packages
	if args[0] == "add" {
		if r.restore == nil {
			r.restore = append([]contracts.Artifact(nil), r.packages...)
		}
	} else if r.restore != nil {
		items = r.restore
	}
	return writeVerifiedPackageFixtures(root, items)
}

func sealedTestArtifacts(t *testing.T, artifacts ...contracts.Artifact) []contracts.Artifact {
	t.Helper()
	for index := range artifacts {
		item := &artifacts[index]
		if item.IsBinary() || item.Package == "" {
			continue
		}
		version := item.Version
		if version == "" {
			version = "1.0.0"
			item.Version = version
		}
		*item = sealArtifactTarball(t, *item, packageTarball(t, item.Package, version, nil))
	}
	return artifacts
}

func writeVerifiedPackageFixtures(root string, artifacts []contracts.Artifact) error {
	packages := map[string]contracts.Artifact{}
	for _, item := range artifacts {
		if !item.IsBinary() && item.Package != "" {
			packages[item.Package+"@"+item.Version] = item
		}
	}
	if len(packages) == 0 {
		return nil
	}
	keys := make([]string, 0, len(packages))
	for key := range packages {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var lock strings.Builder
	lock.WriteString("lockfileVersion: '9.0'\npackages:\n")
	for _, key := range keys {
		item := packages[key]
		packageRoot := filepath.Join(root, "node_modules", filepath.FromSlash(item.Package))
		if err := os.MkdirAll(filepath.Join(packageRoot, "dist"), 0o755); err != nil {
			return err
		}
		manifest, err := json.Marshal(map[string]string{"name": item.Package, "version": item.Version})
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(packageRoot, "package.json"), manifest, 0o644); err != nil {
			return err
		}
		content := []byte("fixture dist: " + item.Package + "@" + item.Version)
		if err := os.WriteFile(filepath.Join(packageRoot, "dist", "index.js"), content, 0o644); err != nil {
			return err
		}
		fmt.Fprintf(&lock, "  '%s':\n    resolution:\n      integrity: %s\n", key, item.Provenance.Integrity)
	}
	return os.WriteFile(filepath.Join(root, "pnpm-lock.yaml"), []byte(lock.String()), 0o600)
}

func writeTestPackageLock(root string, artifacts []contracts.Artifact) error {
	var lock strings.Builder
	lock.WriteString("lockfileVersion: '9.0'\npackages:\n")
	for _, item := range artifacts {
		if item.IsBinary() || item.Package == "" {
			continue
		}
		fmt.Fprintf(&lock, "  '%s@%s':\n    resolution:\n      integrity: %s\n", item.Package, item.Version, item.Provenance.Integrity)
	}
	return os.WriteFile(filepath.Join(root, "pnpm-lock.yaml"), []byte(lock.String()), 0o600)
}

func sealedTestRunner(t *testing.T, artifacts ...contracts.Artifact) ([]contracts.Artifact, *fakeRunner) {
	t.Helper()
	items := sealedTestArtifacts(t, artifacts...)
	return items, &fakeRunner{packages: items}
}

func TestPnpmInstallsSortedExactArtifactBatch(t *testing.T) {
	root := t.TempDir()
	items, runner := sealedTestRunner(t, contracts.Artifact{ID: "b", Package: "@kb/b", Version: "2.0.0"}, contracts.Artifact{ID: "a", Package: "@kb/a", Version: "1.0.0"}, contracts.Artifact{ID: "repeat", Package: "@kb/a", Version: "1.0.0"})
	err := (Pnpm{Root: root, Registry: "https://registry.test", Runner: runner, ReleaseCatalog: testReleaseCatalog(t, items...)}).Install(items)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"add", "--dir", root, "--reporter=append-only", "@kb/a@1.0.0", "@kb/b@2.0.0"}
	if len(runner.calls) != 1 || !reflect.DeepEqual(runner.calls[0].args, want) {
		t.Fatalf("calls = %#v, want %q", runner.calls, want)
	}
}

func TestPnpmSkipsAlreadyInstalledExactArtifact(t *testing.T) {
	root := t.TempDir()
	items, _ := sealedTestRunner(t, contracts.Artifact{ID: "a", Package: "@kb/a", Version: "1.0.0"})
	if err := writeVerifiedPackageFixtures(root, items); err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{}
	if err := (Pnpm{Root: root, Runner: runner, ReleaseCatalog: testReleaseCatalog(t, items...)}).Install(items); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("calls = %#v", runner.calls)
	}
}
func TestPnpmDoesNotRunForInvalidArtifact(t *testing.T) {
	runner := &fakeRunner{}
	err := (Pnpm{Root: t.TempDir(), Runner: runner}).Install([]contracts.Artifact{{ID: "broken", Package: "@kb/broken"}})
	if err == nil || len(runner.calls) != 0 {
		t.Fatalf("err/calls = %v / %#v", err, runner.calls)
	}
}
func TestPnpmPreservesPackageManagerFailure(t *testing.T) {
	root := t.TempDir()
	runner := &fakeRunner{err: errors.New("exit status 1")}
	err := (Pnpm{Root: root, Runner: runner, ReleaseCatalog: testReleaseCatalog(t)}).Restore(nil)
	if err == nil || !errors.Is(err, runner.err) {
		t.Fatalf("err = %v", err)
	}
}

func TestPnpmDiagnosticKeepsExitCodeAndStderrTail(t *testing.T) {
	root := t.TempDir()
	var transcript strings.Builder
	manager := Pnpm{
		Root:               root,
		PackageManagerRoot: filepath.Join(root, "state", "package-manager"),
		Log:                &transcript,
	}
	err := manager.run("command-that-does-not-exist")
	var failure *diag.Diag
	if !errors.As(err, &failure) {
		t.Fatalf("pnpm failure = %v, want catalogued diagnostic", err)
	}
	if failure.Code != contracts.CodeApplyFailed || failure.Meta["packageManagerExitCode"] == "" {
		t.Fatalf("pnpm diagnostic = code %q details %#v; want exit code and stderr tail", failure.Code, failure.Meta)
	}
	if transcript.Len() == 0 {
		t.Fatalf("installer transcript dropped pnpm output: %s", transcript.String())
	}
}
func TestPnpmSkipsReleaseManagedBinary(t *testing.T) {
	runner := &fakeRunner{}
	if err := (Pnpm{Root: t.TempDir(), Runner: runner, ReleaseCatalog: testReleaseCatalog(t)}).Install([]contracts.Artifact{{ID: "kb-dev", Kind: "binary", Version: "2.0.0"}}); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("calls = %#v", runner.calls)
	}
}

func TestPnpmUsesOfflineModeWhenRequested(t *testing.T) {
	root := t.TempDir()
	items, runner := sealedTestRunner(t, contracts.Artifact{ID: "platform", Package: "@kb/platform", Version: "2.0.0"})
	if err := (Pnpm{Root: root, Offline: true, Runner: runner, ReleaseCatalog: testReleaseCatalog(t, items...)}).Install(items); err != nil {
		t.Fatal(err)
	}
	want := []string{"add", "--dir", root, "--reporter=append-only", "--offline", "@kb/platform@2.0.0"}
	if len(runner.calls) != 1 || !reflect.DeepEqual(runner.calls[0].args, want) {
		t.Fatalf("calls = %#v", runner.calls)
	}
}

// case: S-285.18
func TestCommandFailureCrossesInstallerDiagnosticBoundary(t *testing.T) {
	program := filepath.Join(t.TempDir(), "failure")
	if err := os.WriteFile(program, []byte("#!/bin/sh\nprintf 'registry unavailable\\nAPI_TOKEN=example-secret\\n' >&2\nexit 1\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	_, err := toolchain.Run(context.Background(), toolchain.Invocation{Tool: "fixture", Executable: program, Operation: toolchain.OperationPackageManager})
	if err == nil {
		t.Fatal("expected the subprocess to fail")
	}
	failure := contracts.NewDiag(contracts.CodeApplyFailed, "fixture failed", "retry the fixture", err)
	if !strings.Contains(failure.Reason, "registry unavailable") || strings.Contains(failure.Reason, "example-secret") {
		t.Fatalf("diagnostic omitted safe subprocess stderr: %q", failure.Reason)
	}
}

func TestCommandStdoutFailureCrossesInstallerDiagnosticBoundary(t *testing.T) {
	program := filepath.Join(t.TempDir(), "failure")
	if err := os.WriteFile(program, []byte("#!/bin/sh\nprintf 'HTTP 404 registry unavailable\\n'\nexit 1\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	_, err := toolchain.Run(context.Background(), toolchain.Invocation{Tool: "fixture", Executable: program, Operation: toolchain.OperationPackageManager})
	if err == nil {
		t.Fatal("expected failure")
	}
	failure := contracts.NewDiag(contracts.CodeApplyFailed, "fixture failed", "retry", err)
	if !strings.Contains(failure.Reason, "HTTP 404") || !strings.Contains(failure.Cause, "HTTP 404") {
		t.Fatalf("diagnostic reason=%q cause=%q", failure.Reason, failure.Cause)
	}
}

// testReleaseCatalog uses the production package and index sealers for fixture identities.
func testReleaseCatalog(t *testing.T, items ...contracts.Artifact) catalog.Verified {
	t.Helper()
	source, err := catalog.LoadFile(filepath.Join("..", "cmd", "kb-create-v2", "testdata", "x251-release-index.json"))
	if err != nil {
		t.Fatal(err)
	}
	source.Provenance = nil
	seen := make(map[string]bool)
	for _, item := range items {
		if item.IsBinary() || item.Package == "" {
			continue
		}
		key := item.Package + "@" + item.Version
		if seen[key] {
			continue
		}
		seen[key] = true
		if !item.Provenance.HasContentDigest() {
			item = sealArtifactTarball(t, item, packageTarball(t, item.Package, item.Version, nil))
		}
		source.Provenance = append(source.Provenance, catalog.ArtifactProvenance{Package: item.Package, Version: item.Version, ArtifactProvenance: item.Provenance})
	}
	source, err = catalog.Seal(source)
	if err != nil {
		t.Fatal(err)
	}
	verified, err := catalog.VerifyCatalog(source)
	if err != nil {
		t.Fatal(err)
	}
	return verified
}

// case: S-284.20
func TestPnpmRejectsUnverifiedReleaseBeforeWritingExclusions(t *testing.T) {
	root := t.TempDir()
	writeMinimumReleaseAgeWorkspace(t, root)
	path := filepath.Join(root, "pnpm-workspace.yaml")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	err = (Pnpm{Root: root}).mergeMinimumReleaseAgeExclude(nil)
	if err == nil {
		t.Fatal("unverified catalog accepted")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("unverified catalog changed workspace")
	}
}

// case: S-284.20
func TestReleaseAgeRemovesPreviousCatalogContributions(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "pnpm-workspace.yaml")
	if err := os.WriteFile(path, []byte("minimumReleaseAgeExclude:\n  - '@kb-labs/transitive@1.0.1'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	current := testReleaseCatalog(t, contracts.Artifact{Package: "@kb-labs/transitive", Version: "1.0.0"})
	previous := testReleaseCatalog(t, contracts.Artifact{Package: "@kb-labs/transitive", Version: "1.0.1"})
	if err := (Pnpm{Root: root, ReleaseCatalog: current, PreviousReleaseCatalog: &previous}).mergeMinimumReleaseAgeExclude(nil); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Exclude []string `yaml:"minimumReleaseAgeExclude"`
	}
	if err := yaml.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Exclude, []string{"@kb-labs/transitive@1.0.0"}) {
		t.Fatalf("exclusions=%v", got.Exclude)
	}
}

// case: S-284.20
func TestStagedWorkspacePreservesExistingReleaseAgeSettings(t *testing.T) {
	active, stage := t.TempDir(), t.TempDir()
	config := "minimumReleaseAgeExclude:\n  - '@kb-labs/marketplace-pin@1.0.0'\ncustomSetting: true\n"
	if err := os.WriteFile(filepath.Join(active, "pnpm-workspace.yaml"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	manager := Pnpm{Root: stage, MarketplaceRoot: active}
	if err := manager.prepareWorkspaceYAML(); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(stage, "pnpm-workspace.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != config {
		t.Fatalf("staged workspace = %q, want %q", got, config)
	}
}

// case: S-284.20
func TestPnpmRoutesScopedAndThirdPartyPackagesToSeparateRegistries(t *testing.T) {
	testworkspace.Require(t)
	_, pnpmScript, err := toolchain.PnpmExecutable()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	managerRoot := filepath.Join(t.TempDir(), "package-manager")
	fixturePnpm := filepath.Join(managerRoot, "corepack", "v1", "pnpm", toolchain.SupportedPnpm)
	if err := os.CopyFS(fixturePnpm, os.DirFS(filepath.Dir(filepath.Dir(pnpmScript)))); err != nil {
		t.Fatal(err)
	}
	scopedName, thirdName := "@kb-labs/scoped-fixture", "third-party-fixture"
	scopedData := packageTarball(t, scopedName, "1.0.0", nil)
	thirdData := packageTarball(t, thirdName, "1.0.0", nil)
	scopedItem := sealArtifactTarball(t, contracts.Artifact{Package: scopedName, Version: "1.0.0"}, scopedData)
	thirdItem := sealArtifactTarball(t, contracts.Artifact{Package: thirdName, Version: "1.0.0"}, thirdData)
	var mu sync.Mutex
	seen := map[string][]string{"scoped": {}, "default": {}}
	serve := func(kind, name string, data []byte, item contracts.Artifact) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			seen[kind] = append(seen[kind], r.URL.Path)
			mu.Unlock()
			if strings.HasSuffix(r.URL.Path, ".tgz") {
				_, _ = w.Write(data)
				return
			}
			writeRegistryPackument(w, name, map[string]registryTarball{"1.0.0": {URL: serverURL(r) + "/fixture.tgz", Integrity: item.Provenance.Integrity}}, nil)
		}
	}
	scoped := httptest.NewServer(serve("scoped", scopedName, scopedData, scopedItem))
	defer scoped.Close()
	third := httptest.NewServer(serve("default", thirdName, thirdData, thirdItem))
	defer third.Close()
	t.Setenv("npm_config_registry", third.URL)
	t.Setenv("HOME", t.TempDir())
	var transcript strings.Builder
	pm := Pnpm{Root: root, PackageManagerRoot: managerRoot, Registry: scoped.URL, Log: &transcript}
	if err := os.WriteFile(filepath.Join(root, ".npmrc"), []byte("registry="+third.URL+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := pm.prepare(); err != nil {
		t.Fatal(err)
	}
	err = pm.run("add", scopedName+"@1.0.0", thirdName+"@1.0.0")
	mu.Lock()
	scopedRequests, thirdRequests := append([]string(nil), seen["scoped"]...), append([]string(nil), seen["default"]...)
	mu.Unlock()
	if len(scopedRequests) == 0 || len(thirdRequests) == 0 {
		t.Fatalf("scoped=%v default=%v pnpm error=%v", scopedRequests, thirdRequests, errors.Join(err, errors.New(transcript.String())))
	}
	contains := func(paths []string, path string) bool {
		for _, candidate := range paths {
			if candidate == path {
				return true
			}
		}
		return false
	}
	if !contains(scopedRequests, "/"+scopedName) || !contains(thirdRequests, "/"+thirdName) || contains(scopedRequests, "/"+thirdName) || contains(thirdRequests, "/"+scopedName) {
		t.Fatalf("wrong registry requests: scoped=%v default=%v", scopedRequests, thirdRequests)
	}
	if err != nil {
		t.Fatalf("pnpm routing fixture: %v; transcript: %s", err, transcript.String())
	}
}

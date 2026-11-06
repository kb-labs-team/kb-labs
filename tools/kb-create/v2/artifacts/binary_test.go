package artifacts

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
)

func TestBinariesInstallsOnlyVerifiedReleaseAsset(t *testing.T) {
	payload := []byte("kb-dev-binary")
	sum := fmt.Sprintf("%x", sha256.Sum256(payload))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(payload) }))
	defer server.Close()
	root := t.TempDir()
	if err := (Binaries{Root: root, CacheRoot: filepath.Join(root, ".kb", "v2", "cache")}).Install([]contracts.Artifact{{ID: "kb-dev", Kind: "binary", URL: server.URL, ResolvedURL: server.URL, SHA256: sum, Target: "kb-dev"}}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, ".kb", "v2", "bin", "kb-dev"))
	if err != nil || string(data) != string(payload) {
		t.Fatalf("binary/error = %q / %v", data, err)
	}
}

func TestBinariesInstallPrimesChecksumKeyedOfflineCache(t *testing.T) {
	payload := []byte("kb-dev-binary")
	sum := fmt.Sprintf("%x", sha256.Sum256(payload))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(payload) }))
	defer server.Close()
	root := t.TempDir()
	item := contracts.Artifact{ID: "kb-dev", Kind: "binary", URL: server.URL, ResolvedURL: server.URL, SHA256: sum, Target: "kb-dev"}
	cacheRoot := filepath.Join(root, ".kb", "v2", "cache")
	if err := (Binaries{Root: root, CacheRoot: cacheRoot}).Install([]contracts.Artifact{item}); err != nil {
		t.Fatal(err)
	}
	cachePath := filepath.Join(cacheRoot, "binaries", sum)
	if data, err := os.ReadFile(cachePath); err != nil || string(data) != string(payload) {
		t.Fatalf("cached binary/error = %q / %v", data, err)
	}
	if err := (Binaries{Root: root, CacheRoot: cacheRoot, Offline: true}).Install([]contracts.Artifact{item}); err != nil {
		t.Fatalf("cached binary was not available offline: %v", err)
	}
}

func TestBinariesCanUseInstallSharedCacheWhileInstallingIntoStage(t *testing.T) {
	payload := []byte("staged-kb-dev-binary")
	sum := fmt.Sprintf("%x", sha256.Sum256(payload))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(payload) }))
	defer server.Close()
	stage, sharedCache := t.TempDir(), t.TempDir()
	item := contracts.Artifact{ID: "kb-dev", Kind: "binary", URL: server.URL, ResolvedURL: server.URL, SHA256: sum, Target: "kb-dev"}
	if err := (Binaries{Root: stage, CacheRoot: sharedCache}).Install([]contracts.Artifact{item}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(stage, ".kb", "v2", "cache")); !os.IsNotExist(err) {
		t.Fatalf("staged version contains the shared cache path: %v", err)
	}
	cachePath := filepath.Join(sharedCache, "binaries", sum)
	if data, err := os.ReadFile(cachePath); err != nil || string(data) != string(payload) {
		t.Fatalf("shared cached binary/error = %q / %v", data, err)
	}
	if err := (Binaries{Root: stage, CacheRoot: sharedCache, Offline: true}).Install([]contracts.Artifact{item}); err != nil {
		t.Fatalf("staged offline install could not read shared cache: %v", err)
	}
}

func TestBinariesRejectsChecksumMismatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("wrong")) }))
	defer server.Close()
	root := t.TempDir()
	err := (Binaries{Root: root, CacheRoot: filepath.Join(root, ".kb", "v2", "cache")}).Install([]contracts.Artifact{{ID: "kb-dev", Kind: "binary", URL: server.URL, ResolvedURL: server.URL, SHA256: "bad", Target: "kb-dev"}})
	if err == nil {
		t.Fatal("expected checksum error")
	}
}

func TestBinariesVerifyEveryChecksumBeforeWritingAnyArtifact(t *testing.T) {
	root := t.TempDir()
	cacheRoot := filepath.Join(root, ".kb", "v2", "cache")
	good := []byte("valid sealed binary")
	bad := []byte("corrupt sealed binary")
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/good" {
			_, _ = writer.Write(good)
			return
		}
		_, _ = writer.Write(bad)
	}))
	t.Cleanup(server.Close)

	goodDigest := fmt.Sprintf("%x", sha256.Sum256(good))
	goodPath := filepath.Join(root, ".kb", "v2", "bin", "good")
	goodCachePath := filepath.Join(cacheRoot, "binaries", goodDigest)
	err := (Binaries{Root: root, CacheRoot: cacheRoot, Client: server.Client()}).Install([]contracts.Artifact{
		{ID: "good", Kind: "binary", URL: server.URL + "/good", ResolvedURL: server.URL + "/good", SHA256: goodDigest, Target: "good"},
		{ID: "bad", Kind: "binary", URL: server.URL + "/bad", ResolvedURL: server.URL + "/bad", SHA256: fmt.Sprintf("%x", sha256.Sum256(good)), Target: "bad"},
	})
	if err == nil {
		t.Fatal("expected checksum failure")
	}
	for _, path := range []string{goodPath, goodCachePath} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("artifact verification wrote %s before rejecting the sealed set: %v", path, err)
		}
	}
}

func TestBinariesOfflineUsesOnlyVerifiedLocalCache(t *testing.T) {
	payload := []byte("cached-kb-dev")
	sum := fmt.Sprintf("%x", sha256.Sum256(payload))
	root := t.TempDir()
	cache := filepath.Join(root, ".kb", "v2", "cache", "binaries")
	if err := os.MkdirAll(cache, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, sum), payload, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := (Binaries{Root: root, CacheRoot: filepath.Join(root, ".kb", "v2", "cache"), Offline: true}).Install([]contracts.Artifact{{ID: "kb-dev", Kind: "binary", URL: "https://must-not-be-fetched.test/kb-dev", SHA256: sum, Target: "kb-dev"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, ".kb", "v2", "bin", "kb-dev")); err != nil {
		t.Fatal(err)
	}
}

func TestBinariesOfflineFailsWithoutCache(t *testing.T) {
	root := t.TempDir()
	err := (Binaries{Root: root, CacheRoot: filepath.Join(root, ".kb", "v2", "cache"), Offline: true}).Install([]contracts.Artifact{{ID: "kb-dev", Kind: "binary", URL: "https://must-not-be-fetched.test/kb-dev", SHA256: "abc", Target: "kb-dev"}})
	if err == nil {
		t.Fatal("expected offline cache failure")
	}
}

func TestCompositeRemovesBinaryWhenPackageInstallFails(t *testing.T) {
	payload := []byte("kb-dev-binary")
	sum := fmt.Sprintf("%x", sha256.Sum256(payload))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(payload) }))
	defer server.Close()
	root := t.TempDir()
	runner := &fakeRunner{err: fmt.Errorf("pnpm failed")}
	executor := Composite{Packages: Pnpm{Root: root, Runner: runner}, Binaries: Binaries{Root: root, CacheRoot: filepath.Join(root, ".kb", "v2", "cache")}}
	err := executor.Install([]contracts.Artifact{{ID: "kb-dev", Kind: "binary", URL: server.URL, ResolvedURL: server.URL, SHA256: sum, Target: "kb-dev"}, {ID: "platform", Package: "@kb/platform", Version: "2"}})
	if err == nil {
		t.Fatal("expected package failure")
	}
	if _, err := os.Stat(filepath.Join(root, ".kb", "v2", "bin", "kb-dev")); !os.IsNotExist(err) {
		t.Fatalf("binary remains after failed package install: %v", err)
	}
}

func TestPreparedPackageInstallsTheSingleVerifiedTarballResponse(t *testing.T) {
	good := packageTarball(t, "@kb-labs/once", "1.0.0", nil)
	corrupt := []byte("second tarball response is corrupt")
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		requests++
		if requests == 1 {
			_, _ = writer.Write(good)
			return
		}
		_, _ = writer.Write(corrupt)
	}))
	t.Cleanup(server.Close)
	item := sealArtifactTarball(t, contracts.Artifact{ID: "once", Package: "@kb-labs/once", Version: "1.0.0"}, good)
	item.Tarball = server.URL
	item.ResolvedURL = server.URL
	digest := sha256.Sum256(good)
	item.SHA256 = hex.EncodeToString(digest[:])
	root := t.TempDir()
	cacheRoot := filepath.Join(root, ".kb", "v2", "cache")
	runner := &fakeRunner{packages: []contracts.Artifact{item}}
	executor := Composite{
		Packages: Pnpm{Root: root, CacheRoot: cacheRoot, Runner: runner, ReleaseCatalog: testReleaseCatalog(t, item)},
		Binaries: Binaries{Root: root, CacheRoot: cacheRoot},
	}
	prepared, err := executor.Prepare([]contracts.Artifact{item})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := prepared.Close(); err != nil {
			t.Errorf("close staged artifacts: %v", err)
		}
	})
	cachePath := filepath.Join(cacheRoot, "packages", item.SHA256+".tgz")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cachePath, corrupt, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := prepared.Install(nil); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("tarball source received %d requests; want exactly one", requests)
	}
	usedVerifiedCachePath := false
	for _, invocation := range runner.calls {
		for _, argument := range invocation.args {
			if argument == "file:"+cachePath {
				usedVerifiedCachePath = true
			}
		}
	}
	if !usedVerifiedCachePath {
		t.Fatalf("pnpm did not install from the stable cache path containing the staged verified bytes %q", cachePath)
	}
	installed, err := os.ReadFile(cachePath)
	if err != nil || string(installed) != string(good) {
		t.Fatalf("installed tarball bytes = %q, error %v; want first verified response", installed, err)
	}
}

func TestPreparedArtifactsStayInsideInstallRootWhenTMPDIRIsExternal(t *testing.T) {
	payload := []byte("staged-release-binary")
	digest := fmt.Sprintf("%x", sha256.Sum256(payload))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(payload) }))
	t.Cleanup(server.Close)
	installRoot := t.TempDir()
	sentinel := t.TempDir()
	t.Setenv("TMPDIR", sentinel)
	item := contracts.Artifact{ID: "kb-dev", Kind: "binary", URL: server.URL, ResolvedURL: server.URL, SHA256: digest, Target: "kb-dev"}
	prepared, err := (Composite{
		Binaries: Binaries{Root: installRoot, CacheRoot: filepath.Join(installRoot, ".kb", "v2", "cache"), Client: server.Client()},
	}).Prepare([]contracts.Artifact{item})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := prepared.Close(); err != nil {
			t.Errorf("close prepared artifacts: %v", err)
		}
	})
	entries, err := os.ReadDir(sentinel)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("prepared artifacts wrote outside install root to TMPDIR: %v", entries)
	}
	versions := filepath.Join(installRoot, "versions")
	entries, err = os.ReadDir(versions)
	if err != nil || len(entries) != 1 {
		t.Fatalf("install-root staging entries = %v, error = %v", entries, err)
	}
}

package v2cli

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"

	clikitcommand "github.com/kb-labs/clikit/command"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/internal/testfixtures"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/versionroot"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

type offlineApplyInstaller struct {
	root  string
	roots []string
}

func (installer *offlineApplyInstaller) Prepare(items []contracts.Artifact) (contracts.PreparedArtifacts, error) {
	return offlinePreparedArtifacts{install: func() error { return installer.Install(items) }}, nil
}

func (installer *offlineApplyInstaller) Install(items []contracts.Artifact) error {
	layout, err := versionroot.New(installer.root)
	if err != nil {
		return err
	}
	operationRoot := ""
	versions := filepath.Join(installer.root, "versions")
	entries, err := os.ReadDir(versions)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), ".stage-") {
			operationRoot = filepath.Join(versions, entry.Name())
			break
		}
	}
	if operationRoot == "" {
		operationRoot, err = layout.Active()
		if err != nil {
			return err
		}
	}
	installer.roots = append(installer.roots, operationRoot)
	packages := map[string]any{}
	for _, item := range items {
		if item.IsBinary() {
			continue
		}
		packageRoot := filepath.Join(operationRoot, "node_modules", filepath.FromSlash(item.Package))
		if err := testfixtures.WritePackage(packageRoot, item.Package, item.Version, nil); err != nil {
			return err
		}
		packages[item.Package+"@"+item.Version] = map[string]any{"resolution": map[string]string{"integrity": item.Provenance.Integrity}}
	}
	lockBytes, err := yaml.Marshal(map[string]any{"lockfileVersion": "9.0", "packages": packages})
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(operationRoot, "pnpm-lock.yaml"), lockBytes, 0o600)
}

func (*offlineApplyInstaller) Restore(contracts.ResolvedInstallPlan, contracts.ResolvedInstallPlan) error {
	return nil
}
func (*offlineApplyInstaller) Uninstall([]contracts.Artifact) error { return nil }

type offlinePreparedArtifacts struct{ install func() error }

func (prepared offlinePreparedArtifacts) Install(func(string, bool) error) error {
	return prepared.install()
}
func (offlinePreparedArtifacts) Close() error { return nil }

func installCachePath(root string, artifact contracts.Artifact) (string, error) {
	layout, err := versionroot.New(root)
	if err != nil {
		return "", err
	}
	cacheRoot, err := layout.SharedRuntimePath(".kb/v2/cache")
	if err != nil {
		return "", err
	}
	if artifact.IsBinary() {
		return filepath.Join(cacheRoot, "binaries", artifact.SHA256), nil
	}
	return filepath.Join(cacheRoot, "packages", artifact.SHA256+".tgz"), nil
}

func offlineApplyFixture(t *testing.T, root string) (string, []contracts.Artifact, string) {
	t.Helper()
	home := t.TempDir()
	indexPath := filepath.Join(home, "release-index.json")
	source := testReleaseCatalog(t, "2.0.0")
	source.Provenance = nil
	listener := testListenerWithPortHeadroom(t, 1)
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	gatewayURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	source.Platforms[0].Host = &contracts.HostSpec{Command: "kb-host", HealthURL: gatewayURL + "/health"}
	source.Platforms[0].Profiles = map[string]contracts.ServiceGraph{"default": {PlatformVersion: "2.0.0", Services: []contracts.Service{{ID: "gateway", Port: port}}}}
	source.Platforms[0].Config = []catalog.ConfigRequirement{
		{ID: "platform.adapterOptions", Path: "/platform/adapterOptions", Default: fmt.Sprintf(`{"serviceTransport":{"services":{"gateway":{"url":"%s"}}}}`, gatewayURL)},
		{ID: "fixture.generatedSecret", Secret: true, Generate: true, Env: "FIXTURE_GENERATED_SECRET", Services: []string{"gateway"}},
	}
	binaryBytes := []byte("synthetic kb-create binary for offline install test")
	binaryDigest := sha256.Sum256(binaryBytes)
	for i := range source.Platforms[0].Binaries {
		if source.Platforms[0].Binaries[i].OS == goruntime.GOOS && source.Platforms[0].Binaries[i].Arch == goruntime.GOARCH {
			source.Platforms[0].Binaries[i].URL = "https://example.test/releases/2.0.0/kb-create"
			source.Platforms[0].Binaries[i].SHA256 = hex.EncodeToString(binaryDigest[:])
			source.Platforms[0].Binaries[i].SizeBytes = int64(len(binaryBytes))
		}
	}
	release, err := sealTestCatalog(t, source)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	resolved, failure := resolvePlan(planInput{Operation: "plan", Index: indexPath,
		Direct: directRequest{PlatformRoot: root, ServiceProfile: "default"}})
	if failure != nil {
		t.Fatalf("prepare sealed offline apply artifacts: %#v", failure)
	}
	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := layout.PrepareInitialTarget(); err != nil {
		t.Fatalf("prepare installer-owned root before caching offline artifacts: %v", err)
	}
	cacheRoot, err := layout.SharedRuntimePath(".kb/v2/cache")
	if err != nil {
		t.Fatal(err)
	}
	for _, artifact := range resolved.Plan.Artifacts {
		if artifact.IsBinary() {
			path := filepath.Join(cacheRoot, "binaries", artifact.SHA256)
			if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, binaryBytes, 0o600); err != nil {
				t.Fatal(err)
			}
			continue
		}
		archive := testfixtures.PackageTarball(artifact.Package, artifact.Version, nil)
		digest := sha256.Sum256(archive)
		if hex.EncodeToString(digest[:]) != artifact.SHA256 {
			t.Fatalf("fixture package digest for %s differs from sealed release", artifact.ID)
		}
		path := filepath.Join(cacheRoot, "packages", artifact.SHA256+".tgz")
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, archive, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return indexPath, resolved.Plan.Artifacts, gatewayURL
}

func runOfflineCLI(t *testing.T, operation, root, indexPath, gatewayURL string, installer *offlineApplyInstaller) (int, string, string) {
	t.Helper()
	var installOutput bytes.Buffer
	factory := func(cmd *cobra.Command) commandDependencies {
		return commandDependencies{Command: cmd, NodeCheck: func() error { return nil },
			InstallInput: strings.NewReader(strings.Repeat("\n", 12)), InstallOutput: &installOutput,
			Runtime: &runtime.Dependencies{Artifacts: installer, Host: installHost{}}}
	}
	var stdout, stderr bytes.Buffer
	status := clikitcommand.Execute(newRootCommandWithDependencyFactory(factory),
		[]string{operation, "--json", "--offline", "--index", indexPath, "--platform-root", root, "--service-profile", "default", "--gateway-url", gatewayURL},
		&stdout, &stderr)
	return status.Code(), stdout.String(), stderr.String()
}

// case: S-181.7
func TestOfflineGeneratedSecretApplyUsesInstallCacheForInitialAndActiveRoots(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KB_HOME", filepath.Join(home, ".kb"))
	root := t.TempDir()
	indexPath, artifacts, gatewayURL := offlineApplyFixture(t, root)
	if len(artifacts) == 0 {
		t.Fatal("offline fixture resolved no artifacts")
	}
	installer := &offlineApplyInstaller{root: root}
	code, stdout, stderr := runOfflineCLI(t, "install", root, indexPath, gatewayURL, installer)
	if code != 0 {
		t.Fatalf("initial offline install failed (exit %d): stdout=%s stderr=%s", code, stdout, stderr)
	}
	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	activeRoot, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	if len(installer.roots) == 0 || !strings.Contains(installer.roots[0], ".stage-") {
		t.Fatalf("initial install package root = %v, want staged version path", installer.roots)
	}
	installedReceipt, err := receipt.Read(layout.PlatformRoot())
	if err != nil {
		t.Fatalf("read activated receipt: %v", err)
	}
	canonicalRoot, err := contracts.CanonicalPath(root)
	if err != nil || installedReceipt.Plan.Request.PlatformRoot != canonicalRoot {
		t.Fatalf("receipt request root = %q, canonical root = %q, err=%v", installedReceipt.Plan.Request.PlatformRoot, canonicalRoot, err)
	}
	if present, err := (secrets.Store{PlatformRoot: activeRoot}).Exists("fixture.generatedSecret"); err != nil || !present {
		t.Fatalf("generated requirement was not persisted in activated version: present=%v err=%v", present, err)
	}
	firstApplyCount := len(installer.roots)
	code, stdout, stderr = runOfflineCLI(t, "apply", root, indexPath, gatewayURL, installer)
	if code != 0 {
		t.Fatalf("reapply to active V2 installation failed (exit %d): stdout=%s stderr=%s", code, stdout, stderr)
	}
	if len(installer.roots) <= firstApplyCount {
		t.Fatalf("repeat apply did not execute package installation: roots=%v", installer.roots)
	}
	if installer.roots[len(installer.roots)-1] != activeRoot {
		t.Fatalf("repeat apply package root = %q, want active root %q", installer.roots[len(installer.roots)-1], activeRoot)
	}
	if _, err := receipt.Read(layout.PlatformRoot()); err != nil {
		t.Fatalf("repeat apply lost receipt: %v", err)
	}
}

// case: S-181.7
func TestOfflineApplyCLIReportsExactMissingCachePath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KB_HOME", filepath.Join(home, ".kb"))
	root := t.TempDir()
	indexPath, artifacts, gatewayURL := offlineApplyFixture(t, root)
	if len(artifacts) == 0 {
		t.Fatal("offline fixture resolved no artifacts")
	}
	for _, artifact := range artifacts {
		path, pathErr := installCachePath(root, artifact)
		if pathErr != nil {
			t.Fatal(pathErr)
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatalf("remove fixture artifact to exercise CLI diagnostic: %v", err)
		}
	}
	code, stdout, stderr := runOfflineCLI(t, "apply", root, indexPath, gatewayURL, &offlineApplyInstaller{root: root})
	if code == 0 {
		t.Fatalf("offline apply unexpectedly succeeded without cache entry: %s", stdout)
	}
	var output struct {
		Error struct {
			Code    string         `json:"code"`
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(stdout), &output); err != nil {
		t.Fatalf("CLI error was not a JSON envelope: stdout=%s stderr=%s err=%v", stdout, stderr, err)
	}
	artifactID, _ := output.Error.Details["artifact"].(string)
	var expectedPath string
	for _, artifact := range artifacts {
		if artifact.ID != artifactID {
			continue
		}
		path, pathErr := installCachePath(root, artifact)
		if pathErr != nil {
			t.Fatal(pathErr)
		}
		expectedPath = path
	}
	if output.Error.Code != contracts.CodeOfflineArtifactMissing || expectedPath == "" || output.Error.Details["cachePath"] != expectedPath {
		t.Fatalf("offline CLI error = %#v, expected artifact path %q", output.Error, expectedPath)
	}
}

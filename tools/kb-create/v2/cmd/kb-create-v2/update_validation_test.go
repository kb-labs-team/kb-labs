package v2cli

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	goruntime "runtime"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/internal/testfixtures"
	"github.com/kb-labs/create/v2/marketplace"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/versionroot"
)

func TestMarketplaceLockReadFailureIsNotReportedAsComponentIncompatibility(t *testing.T) {
	root := t.TempDir()
	kbDir := filepath.Join(root, ".kb")
	if err := os.MkdirAll(kbDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(kbDir, "marketplace.lock"), []byte("not-json\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	plan := contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{PlatformRoot: root}}
	_, failure := planUpdateWithMarketplaceLock(root, plan, catalog.Catalog{}, "kb-create update")
	if failure == nil {
		t.Fatal("invalid marketplace lock unexpectedly accepted")
	}
	if failure.Code != contracts.CodeOperationFailed {
		t.Fatalf("marketplace lock failure code = %q, want %q", failure.Code, contracts.CodeOperationFailed)
	}
	if _, err := diag.ToEnvelope(failure); err != nil {
		t.Fatalf("marketplace lock failure violated its diagnostic contract: %v", err)
	}
	if got, want := diag.ExitCode(failure).Code(), 1; got != want {
		t.Fatalf("process exit code = %d, want %d", got, want)
	}
}

func TestUpdatePreservesTheResolverCodeForMalformedRequestData(t *testing.T) {
	indexPath := filepath.Join(t.TempDir(), "release-index.json")
	source, err := sealTestCatalog(t, testReleaseCatalog(t, "2.0.0"))
	if err != nil {
		t.Fatal(err)
	}
	encodedIndex, err := json.Marshal(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, encodedIndex, 0o600); err != nil {
		t.Fatal(err)
	}
	requestPath := filepath.Join(t.TempDir(), "request.json")
	if err := os.WriteFile(requestPath, []byte(`{"platformRoot":"/tmp/update-request","policy":"not-a-policy"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	_, failure, code, _ := executeForTest(t, operationTestSetup{
		Operation: "update", Index: indexPath, Input: requestPath, JSON: true,
		NodePreflight: func() error { return nil },
	})
	if failure == nil {
		t.Fatal("invalid update request unexpectedly resolved")
	}
	if failure.Code != contracts.CodeInputRequired {
		t.Fatalf("invalid request code = %q, want %q", failure.Code, contracts.CodeInputRequired)
	}
	if code != diag.ExitCode(failure).Code() {
		t.Fatalf("invalid request process code = %d, catalog code = %d", code, diag.ExitCode(failure).Code())
	}
	if _, err := diag.ToEnvelope(failure); err != nil {
		t.Fatalf("invalid request diagnostic violated its declared contract: %v", err)
	}
}

// case: S-023.12
func TestUpdateBadChecksumIndexReturnsCataloguedApplyFailure(t *testing.T) {
	inst := newInstallation(t)
	if _, code, output := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start fixture host: %d %s", code, output)
	}
	layout, err := versionroot.New(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	activeRoot, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	activeTreeBefore, err := treeDigest(activeRoot)
	if err != nil {
		t.Fatal(err)
	}
	currentLinkBefore, err := os.Readlink(layout.PlatformRoot())
	if err != nil {
		t.Fatal(err)
	}
	state, err := host.StateForRoot(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	processIdentityBefore, err := os.ReadFile(state.HostPID())
	if err != nil {
		t.Fatal(err)
	}

	goodBinary := []byte("sealed update binary")
	corruptBinary := []byte("corrupt update binary")
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = writer.Write(corruptBinary)
	}))
	t.Cleanup(server.Close)

	source := testReleaseCatalog(t, "2.0.0")
	source.Platforms[0].Binaries[0].URL = server.URL + "/kb-create"
	digest := sha256.Sum256(goodBinary)
	source.Platforms[0].Binaries[0].SHA256 = hex.EncodeToString(digest[:])
	sealed, err := sealTestCatalog(t, source)
	if err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(t.TempDir(), "bad-checksum-release-index.json")
	encodedIndex, err := json.Marshal(sealed)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, encodedIndex, 0o600); err != nil {
		t.Fatal(err)
	}

	cacheRoot, err := layout.SharedRuntimePath(".kb/v2/cache")
	if err != nil {
		t.Fatal(err)
	}
	stateBefore := snapshotStateTree(t, filepath.Join(inst.root, "state"))
	receiptPath := receipt.Path(platformRootForTest(t, inst.root))
	receiptBefore, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	_, failure, exitCode, _ := executeForTest(t, operationTestSetup{
		Operation: "update", Index: indexPath, JSON: true,
		Direct: directRequest{PlatformRoot: inst.root, PlatformVersion: "2.0.0", SDKVersion: "2.0.0", Policy: "compatible"},
		RuntimeDeps: &runtime.Dependencies{Artifacts: artifacts.Composite{
			Binaries: artifacts.Binaries{Root: inst.root, CacheRoot: cacheRoot, Client: server.Client()},
		}},
		NodePreflight: func() error { return nil },
	})
	if failure == nil {
		t.Fatal("update accepted the checksum-corrupt artifact")
	}
	if failure.Code != contracts.CodeApplyFailed || exitCode != 1 {
		t.Fatalf("bad-checksum update = code %q / exit %d; want %q / exit 1", failure.Code, exitCode, contracts.CodeApplyFailed)
	}
	if _, err := diag.ToEnvelope(failure); err != nil {
		t.Fatalf("bad-checksum update violated the diagnostic contract: %v", err)
	}
	if got, err := os.ReadFile(receiptPath); err != nil || string(got) != string(receiptBefore) {
		t.Fatalf("bad-checksum update changed the active receipt: %v", err)
	}
	if after := snapshotStateTree(t, filepath.Join(inst.root, "state")); !reflect.DeepEqual(after, stateBefore) {
		t.Fatalf("bad-checksum update changed shared state: before=%#v after=%#v", stateBefore, after)
	}
	if activeTreeAfter, err := treeDigest(activeRoot); err != nil || activeTreeAfter != activeTreeBefore {
		t.Fatalf("bad-checksum update changed the active version root: %v", err)
	}
	if currentLinkAfter, err := os.Readlink(layout.PlatformRoot()); err != nil || currentLinkAfter != currentLinkBefore {
		t.Fatalf("bad-checksum update changed the active version link: %q %v", currentLinkAfter, err)
	}
	if processIdentityAfter, err := os.ReadFile(state.HostPID()); err != nil || string(processIdentityAfter) != string(processIdentityBefore) {
		t.Fatalf("bad-checksum update changed the running host identity: %v", err)
	}
}

// case: S-023.12
func TestUpdateBadPackageChecksumPreservesSharedStateAndReturnsOperationFailure(t *testing.T) {
	inst := newInstallation(t)
	if _, code, output := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start fixture host: %d %s", code, output)
	}
	validPackage := []byte("valid sealed cli package")
	corruptPackage := []byte("corrupt sealed cli package")
	validPlatformPackage := testfixtures.PackageTarball("@kb/platform", "2.0.0", nil)
	validSDKPackage := testfixtures.PackageTarball("@kb/sdk", "2.0.0", nil)
	validBinary := []byte("valid sealed update binary")
	validBinaryDigest := sha256.Sum256(validBinary)
	digest := sha256.Sum256(validPackage)
	platformDigest := sha256.Sum256(validPlatformPackage)
	sdkDigest := sha256.Sum256(validSDKPackage)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var payload []byte
		switch request.URL.Path {
		case "/kb-create":
			payload = validBinary
		case "/platform.tgz":
			payload = validPlatformPackage
		case "/sdk.tgz":
			payload = validSDKPackage
		default:
			payload = corruptPackage
		}
		_, _ = writer.Write(payload)
	}))
	t.Cleanup(server.Close)

	source := testReleaseCatalog(t, "2.0.0")
	source.Platforms[0].Tarball = server.URL + "/platform.tgz"
	source.Platforms[0].SHA256 = hex.EncodeToString(platformDigest[:])
	source.SDKs[0].Tarball = server.URL + "/sdk.tgz"
	source.SDKs[0].SHA256 = hex.EncodeToString(sdkDigest[:])
	source.Platforms[0].Members[0].Version = "2.1.0"
	source.Platforms[0].Members[0].Tarball = server.URL + "/cli-bin.tgz"
	source.Platforms[0].Members[0].SHA256 = hex.EncodeToString(digest[:])
	source.Platforms[0].Binaries[0].URL = server.URL + "/kb-create"
	source.Platforms[0].Binaries[0].SHA256 = hex.EncodeToString(validBinaryDigest[:])
	sealed, err := sealTestCatalog(t, source)
	if err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(t.TempDir(), "bad-package-checksum-release-index.json")
	encodedIndex, err := json.Marshal(sealed)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, encodedIndex, 0o600); err != nil {
		t.Fatal(err)
	}
	cacheRoot, err := versionroot.New(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	sharedCache, err := cacheRoot.SharedRuntimePath(".kb/v2/cache")
	if err != nil {
		t.Fatal(err)
	}
	stateBefore := snapshotStateTree(t, filepath.Join(inst.root, "state"))
	_, failure, exitCode, _ := executeForTest(t, operationTestSetup{
		Operation: "update", Index: indexPath, JSON: true,
		Direct: directRequest{PlatformRoot: inst.root, PlatformVersion: "2.0.0", SDKVersion: "2.0.0", Policy: "compatible"},
		RuntimeDeps: &runtime.Dependencies{Artifacts: artifacts.Composite{
			Packages: artifacts.Pnpm{Root: inst.root, CacheRoot: sharedCache,
				PackageManagerRoot: filepath.Join(inst.root, "state", "package-manager"), Client: server.Client()},
			Binaries: artifacts.Binaries{Root: inst.root, CacheRoot: sharedCache, Client: server.Client()},
		}},
		NodePreflight: func() error { return nil },
	})
	if failure == nil || failure.Code != contracts.CodeApplyFailed || exitCode != 1 {
		failureCode := ""
		if failure != nil {
			failureCode = failure.Code
		}
		t.Fatalf("bad-package-checksum update = code %q / exit %d; want %q / exit 1", failureCode, exitCode, contracts.CodeApplyFailed)
	}
	if !strings.Contains(failure.Cause, "checksum mismatch") {
		t.Fatalf("bad-package-checksum update cause = %q, want package checksum mismatch", failure.Cause)
	}
	if _, err := diag.ToEnvelope(failure); err != nil {
		t.Fatalf("bad-package-checksum update violated its diagnostic contract: %v", err)
	}
	if stateAfter := snapshotStateTree(t, filepath.Join(inst.root, "state")); !reflect.DeepEqual(stateAfter, stateBefore) {
		t.Fatalf("bad-package-checksum update changed shared state: before=%#v after=%#v", stateBefore, stateAfter)
	}
}

func TestPlanPreviewRetainsInstalledMarketplaceAdaptersFromActiveLock(t *testing.T) {
	inst := newInstallation(t)
	const adapterID = "vibeproxy-llm"
	_, testFile, _, ok := goruntime.Caller(0)
	if !ok {
		t.Fatal("locate update validation test source")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(testFile), "../../../../.."))
	packagePath := filepath.Join(repoRoot, "adapters", "vibeproxy", "package.json")
	packageBytes, err := os.ReadFile(packagePath)
	if err != nil {
		t.Fatalf("read shipped VibeProxy package manifest: %v", err)
	}
	var packageManifest struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(packageBytes, &packageManifest); err != nil {
		t.Fatalf("decode shipped VibeProxy package manifest: %v", err)
	}
	activeRoot := platformRootForTest(t, inst.root)
	packageJSON := filepath.Join(activeRoot, "node_modules", filepath.FromSlash(packageManifest.Name), "package.json")
	if err := os.MkdirAll(filepath.Dir(packageJSON), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(packageJSON, packageBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := marketplace.WriteLock(activeRoot, inst.root, []contracts.Artifact{
		{ID: adapterID, Kind: "adapter", Package: packageManifest.Name, Version: packageManifest.Version},
	}, time.Now()); err != nil {
		t.Fatalf("write active marketplace lock: %v", err)
	}

	source := testReleaseCatalog(t, "2.0.0")
	source.Adapters = append(source.Adapters, catalog.Adapter{Component: catalog.Component{
		ID: adapterID, Version: packageManifest.Version, Package: packageManifest.Name,
		Tarball: "https://example.test/vibeproxy.tgz", SHA256: "vibeproxy",
	}})
	sealed, err := sealTestCatalog(t, source)
	if err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(t.TempDir(), "release-index.json")
	encodedIndex, err := json.Marshal(sealed)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, encodedIndex, 0o600); err != nil {
		t.Fatal(err)
	}
	requestPath := filepath.Join(t.TempDir(), "request.json")
	request, err := json.Marshal(contracts.InstallRequest{
		PlatformRoot: inst.root,
		Platform:     contracts.VersionSelector{Version: "2.0.0"},
		SDK:          contracts.VersionSelector{Version: "2.0.0"},
		Policy:       contracts.PolicyCompatible,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(requestPath, request, 0o600); err != nil {
		t.Fatal(err)
	}

	result, failure := executePlan(context.Background(), planCommandInput{Index: indexPath, RequestFile: requestPath})
	if failure != nil {
		t.Fatalf("plan with active marketplace lock: code=%s reason=%s details=%v", failure.Code, failure.Reason, failure.Meta)
	}
	if !containsComponentRequest(result.Plan.Request.Adapters, adapterID) {
		t.Fatalf("plan request omitted installed adapter %q: %#v", adapterID, result.Plan.Request.Adapters)
	}
	if !containsArtifact(result.Plan.Artifacts, adapterID, "adapter") {
		t.Fatalf("plan omitted installed adapter artifact %q: %#v", adapterID, result.Plan.Artifacts)
	}
}

// case: S-023.12
func TestUpdateDownloadFailurePreservesActiveInstallation(t *testing.T) {
	inst := newInstallation(t)
	if _, code, output := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start fixture host: %d %s", code, output)
	}
	layout, err := versionroot.New(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	activeRoot, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	activeTreeBefore, err := treeDigest(activeRoot)
	if err != nil {
		t.Fatal(err)
	}
	currentLinkBefore, err := os.Readlink(layout.PlatformRoot())
	if err != nil {
		t.Fatal(err)
	}
	state, err := host.StateForRoot(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	processIdentityBefore, err := os.ReadFile(state.HostPID())
	if err != nil {
		t.Fatal(err)
	}
	stateBefore := snapshotStateTree(t, filepath.Join(inst.root, "state"))
	receiptPath := receipt.Path(platformRootForTest(t, inst.root))
	receiptBefore, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Error(writer, "artifact temporarily unavailable", http.StatusServiceUnavailable)
	}))
	t.Cleanup(server.Close)
	source := testReleaseCatalog(t, "2.0.0")
	source.Platforms[0].Binaries[0].URL = server.URL + "/kb-create"
	source.Platforms[0].Binaries[0].SHA256 = strings.Repeat("0", 64)
	sealed, err := sealTestCatalog(t, source)
	if err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(t.TempDir(), "download-failure-release-index.json")
	encodedIndex, err := json.Marshal(sealed)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, encodedIndex, 0o600); err != nil {
		t.Fatal(err)
	}
	cacheRoot, err := layout.SharedRuntimePath(".kb/v2/cache")
	if err != nil {
		t.Fatal(err)
	}
	_, failure, exitCode, _ := executeForTest(t, operationTestSetup{
		Operation: "update", Index: indexPath, JSON: true,
		Direct: directRequest{PlatformRoot: inst.root, PlatformVersion: "2.0.0", SDKVersion: "2.0.0", Policy: "compatible"},
		RuntimeDeps: &runtime.Dependencies{Artifacts: artifacts.Composite{
			Binaries: artifacts.Binaries{Root: inst.root, CacheRoot: cacheRoot, Client: server.Client()},
		}},
		NodePreflight: func() error { return nil },
	})
	if failure == nil || failure.Code != contracts.CodeApplyFailed || exitCode != 1 {
		t.Fatalf("download-failed update = code %v / exit %d; want %q / exit 1", failure, exitCode, contracts.CodeApplyFailed)
	}
	if _, err := diag.ToEnvelope(failure); err != nil {
		t.Fatalf("download-failed update violated the diagnostic contract: %v", err)
	}
	if got, err := os.ReadFile(receiptPath); err != nil || string(got) != string(receiptBefore) {
		t.Fatalf("download-failed update changed the active receipt: %v", err)
	}
	if after := snapshotStateTree(t, filepath.Join(inst.root, "state")); !reflect.DeepEqual(after, stateBefore) {
		t.Fatalf("download-failed update changed shared state: before=%#v after=%#v", stateBefore, after)
	}
	if activeTreeAfter, err := treeDigest(activeRoot); err != nil || activeTreeAfter != activeTreeBefore {
		t.Fatalf("download-failed update changed the active version root: %v", err)
	}
	if currentLinkAfter, err := os.Readlink(layout.PlatformRoot()); err != nil || currentLinkAfter != currentLinkBefore {
		t.Fatalf("download-failed update changed the active version link: %q %v", currentLinkAfter, err)
	}
	if processIdentityAfter, err := os.ReadFile(state.HostPID()); err != nil || string(processIdentityAfter) != string(processIdentityBefore) {
		t.Fatalf("download-failed update changed the running host identity: %v", err)
	}
	runner, err := host.NewRunner(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	statusCtx, cancelStatus := context.WithTimeout(context.Background(), 5*time.Second)
	status, err := runner.Status(statusCtx)
	cancelStatus()
	if err != nil || status.State != "running" || !status.Healthy {
		t.Fatalf("download-failed update left host status %#v, %v; want running and healthy", status, err)
	}
	versionRoots, err := os.ReadDir(layout.VersionsDir())
	if err != nil || len(versionRoots) != 1 || versionRoots[0].Name() != filepath.Base(activeRoot) {
		t.Fatalf("download-failed update left version roots %#v, %v; want only %q", versionRoots, err, filepath.Base(activeRoot))
	}
}

func containsComponentRequest(requests []contracts.ComponentRequest, id string) bool {
	for _, request := range requests {
		if request.ID == id {
			return true
		}
	}
	return false
}

func containsArtifact(artifacts []contracts.Artifact, id, kind string) bool {
	for _, artifact := range artifacts {
		if artifact.ID == id && artifact.Kind == kind {
			return true
		}
	}
	return false
}

// case: S-023.6
func TestEqualVersionUpdateReturnsBeforeSnapshotWritesOrLifecycle(t *testing.T) {
	assertEqualVersionUpdateDoesNotRequireProjectDirectory(t)
}

// case: S-187.9
func TestUpdateReceiptReplayAllowsRemovedProjectDirectory(t *testing.T) {
	assertEqualVersionUpdateDoesNotRequireProjectDirectory(t)
}

func assertEqualVersionUpdateDoesNotRequireProjectDirectory(t *testing.T) {
	t.Helper()
	inst := newInstallation(t)
	projectRoot := filepath.Join(t.TempDir(), "previously-registered-project")
	if err := os.Mkdir(projectRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	active, err := receipt.Read(platformRootForTest(t, inst.root))
	if err != nil {
		t.Fatal(err)
	}
	active.Schema, active.ID, active.InstallationID = contracts.ReceiptSchema, "active", "installation-r1"
	active.InstallationID, err = versionroot.InstallationIDForPath(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	active.Plan.Schema, active.Plan.PlatformChannel = contracts.ResolvedPlanSchema, "stable"
	active.Plan.Request = contracts.InstallRequest{PlatformRoot: inst.root, ProjectRoot: projectRoot}
	active.Plan.Request, err = active.Plan.Request.Normalize()
	if err != nil {
		t.Fatal(err)
	}
	active.Plan.ServiceGraph = contracts.ServiceGraph{PlatformVersion: "3.2.0"}
	active.Plan.Artifacts = []contracts.Artifact{{ID: "platform", Kind: "platform", Package: "@kb/platform", Version: "3.2.0"}}
	if err := receipt.Write(platformRootForTest(t, inst.root), active); err != nil {
		t.Fatal(err)
	}
	receiptPath := receipt.Path(platformRootForTest(t, inst.root))
	if err := os.Remove(projectRoot); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}

	index, err := sealTestCatalog(t, testReleaseCatalog(t, "3.2.0"))
	if err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(t.TempDir(), "release-index.json")
	encoded, err := json.Marshal(index)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	requestPath := filepath.Join(t.TempDir(), "receipt-request.json")
	receiptRequest, err := json.Marshal(active.Plan.Request)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(requestPath, receiptRequest, 0o600); err != nil {
		t.Fatal(err)
	}
	installer := &recordingInstaller{}
	result, failure, code, raw := executeForTest(t, operationTestSetup{
		Operation: "update", Index: indexPath, Input: requestPath, PlatformRoot: inst.root,
		RuntimeDeps:   &runtime.Dependencies{Artifacts: installer},
		NodePreflight: func() error { return nil },
	})
	if failure != nil || code != 0 {
		t.Fatalf("update = code %d, error %v, result %s", code, failure, raw)
	}
	output, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(output, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["alreadyUpToDate"] != true || payload["hostRestarted"] != false {
		t.Fatalf("up-to-date result = %s", output)
	}
	if len(installer.installed) != 0 || installer.restores != 0 {
		t.Fatalf("equal update invoked artifact lifecycle: %#v", installer)
	}
	after, err := os.ReadFile(receiptPath)
	if err != nil || string(before) != string(after) {
		t.Fatalf("equal update changed receipt: %v", err)
	}
	layout, err := versionroot.New(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	assertEmptyOrMissing(t, layout.SnapshotsDir())
}

func TestUpdateValidationRefusesBeforeReceiptOrSnapshotMutation(t *testing.T) {
	for _, test := range []struct {
		name, installed, target, kind, componentRange, wantCode string
		wantExit                                                int
	}{
		{"downgrade", "3.2.0", "3.1.0", "", "", "KB_UPDATE_DOWNGRADE_REFUSED", 2},
		{"installed plugin range", "3.0.0", "3.2.0", "plugin", "<3.2.0", "KB_UPDATE_INCOMPATIBLE", 1},
		{"installed adapter range", "3.0.0", "3.2.0", "adapter", "<3.2.0", "KB_UPDATE_INCOMPATIBLE", 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			inst := newInstallation(t)
			active := contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "active", InstallationID: "installation-r1", Plan: contracts.ResolvedInstallPlan{
				Schema: contracts.ResolvedPlanSchema, PlatformChannel: "stable",
				ServiceGraph: contracts.ServiceGraph{PlatformVersion: test.installed},
				Artifacts: func() []contracts.Artifact {
					if test.kind == "" {
						return nil
					}
					return []contracts.Artifact{{ID: "fixture-compat", Kind: test.kind, Version: "1.0.0", PlatformRange: test.componentRange}}
				}(),
			}}
			installationID, err := versionroot.InstallationIDForPath(inst.root)
			if err != nil {
				t.Fatal(err)
			}
			active.InstallationID = installationID
			if err := receipt.Write(platformRootForTest(t, inst.root), active); err != nil {
				t.Fatal(err)
			}
			receiptPath := receipt.Path(platformRootForTest(t, inst.root))
			before, err := os.ReadFile(receiptPath)
			if err != nil {
				t.Fatal(err)
			}

			index := testReleaseCatalog(t, test.target)
			sealed, err := sealTestCatalog(t, index)
			if err != nil {
				t.Fatal(err)
			}
			indexPath := filepath.Join(t.TempDir(), "release-index.json")
			encoded, err := json.Marshal(sealed)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(indexPath, encoded, 0o600); err != nil {
				t.Fatal(err)
			}
			requestPath := filepath.Join(t.TempDir(), "request.json")
			request, _ := json.Marshal(contracts.InstallRequest{PlatformRoot: inst.root, Platform: contracts.VersionSelector{Version: test.target}, Policy: contracts.PolicyCompatible})
			if err := os.WriteFile(requestPath, request, 0o600); err != nil {
				t.Fatal(err)
			}
			_, failure, code, _ := executeForTest(t, operationTestSetup{
				Operation: "update", Index: indexPath, Input: requestPath,
				NodePreflight: func() error { return nil },
			})
			payload := diagValue(t, failure)
			if code != test.wantExit || errorCode(payload) != test.wantCode {
				t.Fatalf("update = code %d, error %s: %#v", code, errorCode(payload), payload)
			}
			if test.kind != "" {
				errorValue, ok := payload["error"].(map[string]any)
				if !ok {
					t.Fatalf("update error = %#v", payload["error"])
				}
				details, ok := errorValue["details"].(map[string]any)
				if !ok || details["kind"] != test.kind || details["id"] != "fixture-compat" ||
					details["selectedVersion"] != test.target || details["requiredRange"] != test.componentRange {
					t.Fatalf("update details = %#v", errorValue["details"])
				}
				for _, alias := range []string{"component", "version", "range", "subject", "value"} {
					if _, exists := details[alias]; exists {
						t.Fatalf("update details contain duplicate alias %q: %#v", alias, details)
					}
				}
			}
			after, err := os.ReadFile(receiptPath)
			if err != nil {
				t.Fatal(err)
			}
			if string(before) != string(after) {
				t.Fatal("refused update changed active receipt")
			}
			layout, err := versionroot.New(inst.root)
			if err != nil {
				t.Fatal(err)
			}
			assertEmptyOrMissing(t, layout.SnapshotsDir())
		})
	}
}

func TestUpdateMapsTargetPlanCompatibilityToUpdateCode(t *testing.T) {
	inst := newInstallation(t)
	index := filepath.Join(t.TempDir(), "release-index.json")
	source := testReleaseCatalog(t, "3.2.0")
	source.Platforms[0].SDKRange = "<3.0.0"
	sealed, err := sealTestCatalog(t, source)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(sealed)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(index, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	_, failure, code, _ := executeForTest(t, operationTestSetup{
		Operation: "update", Index: index, PlatformRoot: inst.root,
		Direct:        directRequest{PlatformVersion: "3.2.0", SDKVersion: "3.2.0", Policy: "compatible"},
		NodePreflight: func() error { return nil },
	})
	payload := diagValue(t, failure)
	if code != 1 || errorCode(payload) != "KB_UPDATE_INCOMPATIBLE" {
		t.Fatalf("update target plan = code %d, error %s: %#v", code, errorCode(payload), payload)
	}
	errorValue := payload["error"].(map[string]any)
	details := errorValue["details"].(map[string]any)
	if details["kind"] != "sdk" || details["id"] != "sdk" || details["selectedVersion"] != "3.2.0" || details["requiredRange"] != "<3.0.0" {
		t.Fatalf("update target plan details = %#v", details)
	}
}

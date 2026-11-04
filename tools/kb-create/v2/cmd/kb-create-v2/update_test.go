//go:build !windows

package v2cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
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
	"github.com/kb-labs/create/v2/gateway"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/internal/testfixtures"
	"github.com/kb-labs/create/v2/marketplace"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/resolve"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/shim"
	"github.com/kb-labs/create/v2/transport"
	"github.com/kb-labs/create/v2/versionroot"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

// recordingInstaller stands in for pnpm: what an update changes for the host is
// the receipt and the generated config, which runtime.Update writes for real.
type recordingInstaller struct {
	installed []contracts.Artifact
	restores  int
	failure   error
	onInstall func([]contracts.Artifact) error
}

// case: PC-001.10, S-181.3
func TestBuiltCLIApplySecondaryRootRecordsAllocatedGateway(t *testing.T) {
	_, fakehost := binaries(t)
	inst := newEmptyInstallation(t)
	inst.port = freeAllocatedGatewayPortWithOffsets(t, 100)

	binary := []byte("built CLI fixture binary")
	binaryDigest := sha256.Sum256(binary)
	packages := map[string][]byte{
		"/platform-1.0.0.tgz": testPackageTarball("@kb/platform", "1.0.0"),
		"/sdk-1.0.0.tgz":      testPackageTarball("@kb/sdk", "1.0.0"),
		"/cli-bin-1.0.0.tgz":  testPackageTarballWithFiles("@kb-labs/cli-bin", "1.0.0", map[string][]byte{"dist/bin.js": []byte("// fixture CLI entry\n")}),
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if packageBytes, ok := packages[request.URL.Path]; ok {
			_, _ = writer.Write(packageBytes)
			return
		}
		_, _ = writer.Write(binary)
	}))
	t.Cleanup(server.Close)
	indexA, _, requestA := writeSecretCommandInputs(t, inst, fakehost, server.URL, hex.EncodeToString(binaryDigest[:]), packages, true, false)
	indexData, err := os.ReadFile(indexA)
	if err != nil {
		t.Fatal(err)
	}
	var source catalog.Catalog
	if err := json.Unmarshal(indexData, &source); err != nil {
		t.Fatal(err)
	}
	source.Platforms[0].Profiles["default"] = contracts.ServiceGraph{Services: []contracts.Service{{ID: "gateway", Command: "gateway", Port: inst.port}}}
	for index := range source.Platforms[0].Config {
		if source.Platforms[0].Config[index].ID == "gateway.token" {
			source.Platforms[0].Config[index].Services = []string{"gateway"}
		}
	}
	source.Platforms[0].Config = append(source.Platforms[0].Config, catalog.ConfigRequirement{
		ID: "platform.adapterOptions", Path: "/platform/adapterOptions",
		Default: fmt.Sprintf(`{"serviceTransport":{"services":{"gateway":{"url":"http://127.0.0.1:%d"}}}}`, inst.port),
	})
	sealedPrimary, err := sealTestCatalog(t, source)
	if err != nil {
		t.Fatal(err)
	}
	encodedPrimary, err := json.Marshal(sealedPrimary)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexA, encodedPrimary, 0o600); err != nil {
		t.Fatal(err)
	}
	source.Platforms[0].Host.Args = []string{"-port", fmt.Sprint(inst.port + 100)}
	sealed, err := sealTestCatalog(t, source)
	if err != nil {
		t.Fatal(err)
	}
	indexB := filepath.Join(t.TempDir(), "secondary-release-index.json")
	encodedIndex, err := json.Marshal(sealed)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexB, encodedIndex, 0o600); err != nil {
		t.Fatal(err)
	}

	applyRoot := func(index, requestPath string, extraEnv string) commandResult {
		return inst.runArgv([]string{"kb-create", "apply", "--index", index, "--input", requestPath,
			"--secret-env", "gateway.token=" + strings.SplitN(extraEnv, "=", 2)[0], "--json"}, extraEnv)
	}
	primary := applyRoot(indexA, requestA, "PRIMARY_SECRET=primary-secret")
	if primary.code != 0 {
		t.Fatalf("primary built CLI apply failed: %s\n%s", primary.output, installerEvidence(t, inst.root))
	}
	if _, code, output := inst.run("stop", "--json"); code != 0 {
		t.Fatalf("stop primary host before secondary apply: %s", output)
	}

	requestBytes, err := os.ReadFile(requestA)
	if err != nil {
		t.Fatal(err)
	}
	var secondaryRequest contracts.InstallRequest
	if err := json.Unmarshal(requestBytes, &secondaryRequest); err != nil {
		t.Fatal(err)
	}
	secondaryRoot := filepath.Join(t.TempDir(), "secondary-platform")
	secondaryRequest.PlatformRoot = secondaryRoot
	t.Cleanup(func() {
		command := exec.Command(inst.launcher, "stop", "--json", "--platform-root", secondaryRoot)
		command.Env = inst.childEnvironment()
		if output, err := command.CombinedOutput(); err != nil {
			t.Errorf("stop secondary test host: %v\n%s", err, output)
		}
	})
	requestB := filepath.Join(t.TempDir(), "secondary-request.json")
	encodedRequest, err := json.Marshal(secondaryRequest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(requestB, encodedRequest, 0o600); err != nil {
		t.Fatal(err)
	}
	secondary := applyRoot(indexB, requestB, "SECONDARY_SECRET=secondary-secret")
	if secondary.code != 0 {
		state, _ := host.StateForRoot(secondaryRoot)
		hostLog, _ := os.ReadFile(state.HostLog())
		launcherLog, _ := os.ReadFile(state.LauncherLog())
		activeRoot, _ := versionroot.ForPlatformPath(secondaryRoot)
		installed, receiptErr := receipt.Read(activeRoot.PlatformRoot())
		var hostArgs []string
		if installed.Plan.Host != nil {
			hostArgs = installed.Plan.Host.Args
		}
		t.Fatalf("secondary built CLI apply failed: %s\nhost args: %#v\nhost log: %s\nlauncher log: %s\nreceipt: %#v (%v)\n%s", secondary.output, hostArgs, hostLog, launcherLog, installed, receiptErr, installerEvidence(t, secondaryRoot))
	}
	installed, err := receipt.Read(platformRootForTest(t, secondaryRoot))
	if err != nil {
		t.Fatal(err)
	}
	wantHealthURL := fmt.Sprintf("http://127.0.0.1:%d/health", inst.port+100)
	if installed.Verification.HostHealthURL != wantHealthURL {
		t.Fatalf("secondary receipt Gateway = %q, want %q", installed.Verification.HostHealthURL, wantHealthURL)
	}
	encodedReceipt, err := json.Marshal(installed)
	if err != nil {
		t.Fatal(err)
	}
	for _, privateValue := range []string{"secondary-secret", "SECONDARY_SECRET"} {
		if strings.Contains(secondary.output, privateValue) || strings.Contains(string(encodedReceipt), privateValue) {
			t.Fatalf("secondary apply serialized private value %q", privateValue)
		}
	}
}

func installerEvidence(t *testing.T, root string) string {
	t.Helper()
	var evidence strings.Builder
	for _, directory := range []string{"diagnostics", "logs"} {
		files, err := filepath.Glob(filepath.Join(root, "installer", directory, "apply-*") + "*")
		if err != nil {
			t.Errorf("find installer %s: %v", directory, err)
			continue
		}
		for _, path := range files {
			data, readErr := os.ReadFile(path)
			if readErr != nil {
				t.Errorf("read installer evidence %q: %v", path, readErr)
				continue
			}
			fmt.Fprintf(&evidence, "installer evidence %s:\n%s\n", path, data)
		}
	}
	return evidence.String()
}

// case: S-023.18
func TestUpdateSecretRefusalExecutesItsSuggestedCommandSequence(t *testing.T) {
	for _, scenario := range []struct {
		name          string
		storedSecret  bool
		updateMapping string
		targetHasReq  bool
	}{
		{name: "changed stored secret", storedSecret: true, updateMapping: "gateway.token=OPERATOR_ENV_SOURCE_SENTINEL"},
		{name: "missing target secret", targetHasReq: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			launcher, fakehost := binaries(t)
			inst := newEmptyInstallation(t)
			binary := []byte("sealed test launcher binary")
			packages := map[string][]byte{
				"/platform-1.0.0.tgz": testPackageTarball("@kb/platform", "1.0.0"),
				"/platform-1.1.0.tgz": testPackageTarball("@kb/platform", "1.1.0"),
				"/sdk-1.0.0.tgz":      testPackageTarball("@kb/sdk", "1.0.0"),
				"/cli-bin-1.0.0.tgz":  testPackageTarballWithFiles("@kb-labs/cli-bin", "1.0.0", map[string][]byte{"dist/bin.js": []byte("// fixture CLI entry\n")}),
			}
			binaryDigest := sha256.Sum256(binary)
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if packageBytes, ok := packages[request.URL.Path]; ok {
					_, _ = writer.Write(packageBytes)
					return
				}
				_, _ = writer.Write(binary)
			}))
			t.Cleanup(server.Close)
			initialIndex, updateIndex, requestPath := writeSecretCommandInputs(t, inst, fakehost, server.URL, hex.EncodeToString(binaryDigest[:]), packages, scenario.storedSecret, scenario.targetHasReq)
			initialArgs := []string{launcher, "apply", "--index", initialIndex, "--input", requestPath, "--platform-root", inst.root, "--json"}
			initialEnv := []string{"INITIAL_SECRET=before-update"}
			if scenario.storedSecret {
				initialArgs = append(initialArgs, "--secret-env", "gateway.token=INITIAL_SECRET")
			}
			if result := inst.runArgv(initialArgs, initialEnv...); result.code != 0 {
				t.Fatalf("initial CLI apply failed: %s", result.output)
			}
			initialStatus, initialStatusCode, initialStatusOutput := inst.run("status", "--json")
			if initialStatusCode != 0 {
				t.Fatalf("status after initial CLI apply: %s", initialStatusOutput)
			}
			if initialStatus["running"] != true {
				if _, code, output := inst.run("start", "--json"); code != 0 {
					t.Fatalf("start installed host: %s", output)
				}
			}
			if scenario.targetHasReq {
				requestBytes, err := os.ReadFile(requestPath)
				if err != nil {
					t.Fatal(err)
				}
				var request contracts.InstallRequest
				if err := json.Unmarshal(requestBytes, &request); err != nil {
					t.Fatal(err)
				}
				request.SecretInputs = []string{"gateway.token"}
				request.Platform.Version = "1.1.0"
				requestBytes, err = json.Marshal(request)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(requestPath, requestBytes, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			stateBefore := snapshotStateTree(t, filepath.Join(inst.root, "state"))
			secretStore := secrets.Store{PlatformRoot: inst.root}
			secretBefore, secretPresentBefore, err := secretStore.Get("gateway.token")
			if err != nil {
				t.Fatal(err)
			}
			updateArgs := []string{"update", "--index", updateIndex, "--input", requestPath, "--platform-root", inst.root, "--json"}
			updateEnv := []string{"OPERATOR_ENV_SOURCE_SENTINEL=changed-after-install", "ENV_VAR=provided-after-refusal"}
			if scenario.updateMapping != "" {
				updateArgs = append(updateArgs, "--secret-env", scenario.updateMapping)
			}
			refused := inst.runCommand(updateArgs, updateEnv...)
			if refused.code == 0 || errorCode(refused.payload) != contracts.CodeUpdateSecretRefused {
				t.Fatalf("secret policy result = %d %s", refused.code, refused.output)
			}
			if strings.Contains(refused.output, "OPERATOR_ENV_SOURCE_SENTINEL") {
				t.Fatal("secret update diagnostic exposed its environment-variable name")
			}
			if got := snapshotStateTree(t, filepath.Join(inst.root, "state")); !reflect.DeepEqual(got, stateBefore) {
				t.Fatalf("secret refusal changed shared state: before=%#v after=%#v", stateBefore, got)
			}
			if stages, err := filepath.Glob(filepath.Join(inst.root, "versions", ".stage-*")); err != nil || len(stages) != 0 {
				t.Fatalf("secret refusal left staged versions: %v, %v", stages, err)
			}
			diagnostic, ok := refused.payload["error"].(map[string]any)
			if !ok {
				t.Fatalf("refusal omitted diagnostic: %s", refused.output)
			}
			hint, _ := diagnostic["hint"].(string)
			commandText := quotedCommandFromHint(t, hint)
			commands, err := contracts.ParseShellCommands(commandText)
			if err != nil || len(commands) != 2 {
				t.Fatalf("parse product hint %q: commands=%#v err=%v", commandText, commands, err)
			}
			for index, argv := range commands {
				if len(argv) == 0 || argv[0] != "kb-create" {
					t.Fatalf("hint command %d argv = %#v, want kb-create command", index, argv)
				}
				result := inst.runArgv(argv, updateEnv...)
				if result.code != 0 {
					t.Fatalf("suggested command %d (%v) failed: %s", index, argv, result.output)
				}
				if index == 0 {
					stopped, code, output := inst.run("status", "--json")
					if code != 0 || stopped["running"] == true {
						t.Fatalf("suggested stop did not stop host: code=%d %s", code, output)
					}
				}
			}
			secretAfter, secretPresentAfter, err := secretStore.Get("gateway.token")
			if err != nil || !secretPresentAfter || (secretPresentBefore && secretAfter == secretBefore) {
				t.Fatal("suggested apply did not store the intended secret through the Store API")
			}
			layout, err := versionroot.New(inst.root)
			if err != nil {
				t.Fatalf("suggested apply left an invalid installation layout: %v", err)
			}
			if err := layout.Validate(); err != nil {
				t.Fatalf("suggested apply left an invalid installation layout: %v", err)
			}
			activeAfter, err := layout.Active()
			if err != nil {
				t.Fatalf("resolve active container after apply: %v", err)
			}
			installed, err := receipt.Read(layout.PlatformRoot())
			if err != nil || installed.InstallationID == "" || activeAfter == "" {
				t.Fatalf("suggested apply did not record the active container: receipt=%#v err=%v active=%q", installed, err, activeAfter)
			}
			status, code, output := inst.run("status", "--json")
			if code != 0 || status["running"] != true || status["reachable"] != true {
				t.Fatalf("suggested apply did not restore a healthy running host: code=%d %s", code, output)
			}
			followup := []string{"update", "--index", updateIndex, "--input", requestPath, "--platform-root", inst.root, "--json", "--secret-env", "gateway.token=ENV_VAR"}
			updated := inst.runCommand(followup, updateEnv...)
			if updated.code != 0 || updated.payload["alreadyUpToDate"] != true {
				t.Fatalf("update with newly stored secret is not a no-op: code=%d %s", updated.code, updated.output)
			}
		})
	}
}

// case: S-023.10
func TestUpdateCarriesInstallOwnedSecretsWithoutRecreatingConsumedBootstrapPassword(t *testing.T) {
	launcher, fakehost := binaries(t)
	inst := newEmptyInstallation(t)
	binary := []byte("sealed test launcher binary")
	packages := map[string][]byte{
		"/platform-1.0.0.tgz": testPackageTarball("@kb/platform", "1.0.0"),
		"/platform-1.1.0.tgz": testPackageTarball("@kb/platform", "1.1.0"),
		"/sdk-1.0.0.tgz":      testPackageTarball("@kb/sdk", "1.0.0"),
		"/cli-bin-1.0.0.tgz":  testPackageTarballWithFiles("@kb-labs/cli-bin", "1.0.0", map[string][]byte{"dist/bin.js": []byte("// fixture CLI entry\n")}),
	}
	binaryDigest := sha256.Sum256(binary)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if packageBytes, ok := packages[request.URL.Path]; ok {
			_, _ = writer.Write(packageBytes)
			return
		}
		_, _ = writer.Write(binary)
	}))
	t.Cleanup(server.Close)
	initialIndex, updateIndex, requestPath := writeSecretCommandInputs(t, inst, fakehost, server.URL, hex.EncodeToString(binaryDigest[:]), packages, true, true)
	for _, indexPath := range []string{initialIndex, updateIndex} {
		indexBytes, err := os.ReadFile(indexPath)
		if err != nil {
			t.Fatal(err)
		}
		var source catalog.Catalog
		if err := json.Unmarshal(indexBytes, &source); err != nil {
			t.Fatal(err)
		}
		source.Platforms[0].Config = append(source.Platforms[0].Config, catalog.ConfigRequirement{
			ID: secrets.BootstrapPassword, Path: "/gateway/bootstrap/password", Secret: true, Required: true,
			Generate: true, Env: secrets.BootstrapPasswordEnvironment, Services: []string{"runtime"},
		})
		sealed, err := sealTestCatalog(t, source)
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(sealed)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(indexPath, encoded, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	requestBytes, err := os.ReadFile(requestPath)
	if err != nil {
		t.Fatal(err)
	}
	var request contracts.InstallRequest
	if err := json.Unmarshal(requestBytes, &request); err != nil {
		t.Fatal(err)
	}
	request.SecretInputs = append(request.SecretInputs, secrets.BootstrapPassword)
	requestBytes, err = json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(requestPath, requestBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if applied := inst.runArgv([]string{launcher, "apply", "--index", initialIndex, "--input", requestPath,
		"--platform-root", inst.root, "--json", "--secret-env", "gateway.token=INSTALL_TOKEN"}, "INSTALL_TOKEN=stable-install-secret"); applied.code != 0 {
		t.Fatalf("apply secured install fixture: %s", applied.output)
	}
	store := secrets.Store{PlatformRoot: inst.root}
	if err := store.MarkBootstrapCompleted("first-admin-ready"); err != nil {
		t.Fatalf("record successful first-admin completion: %v", err)
	}
	if err := store.MarkBootstrapDisclosed(); err != nil {
		t.Fatalf("complete first-admin secret handoff: %v", err)
	}
	if exists, err := store.Exists(secrets.BootstrapPassword); err != nil || exists {
		t.Fatalf("bootstrap password after handoff exists=%t err=%v; want consumed", exists, err)
	}
	before, present, err := store.Get("gateway.token")
	if err != nil || !present || before != "stable-install-secret" {
		t.Fatalf("installed secret value=%q present=%t err=%v", before, present, err)
	}
	requestBytes, err = os.ReadFile(requestPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(requestBytes, &request); err != nil {
		t.Fatal(err)
	}
	request.Platform.Version = "1.1.0"
	request.SecretInputs = []string{secrets.BootstrapPassword, "gateway.token"}
	requestBytes, err = json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(requestPath, requestBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if status, code, output := inst.run("status", "--json"); code != 0 {
		t.Fatalf("status before update: %s", output)
	} else if status["running"] != true {
		if _, code, output := inst.run("start", "--json"); code != 0 {
			t.Fatalf("start install before update: %s", output)
		}
	}
	updated := inst.runCommand([]string{"update", "--index", updateIndex, "--input", requestPath, "--platform-root", inst.root, "--json"})
	if updated.code != 0 {
		t.Fatalf("update required recreating an already-consumed bootstrap password: %s", updated.output)
	}
	after, present, err := store.Get("gateway.token")
	if err != nil || !present || after != before {
		t.Fatalf("update changed install-owned secret: before=%q after=%q present=%t err=%v", before, after, present, err)
	}
}

func TestUpdateReportsUnreadableSecretStoreSeparatelyFromMissingSecret(t *testing.T) {
	root := t.TempDir()
	layout, err := versionroot.ForPlatformPath(root)
	if err != nil {
		t.Fatal(err)
	}
	storePath, err := layout.SharedRuntimePath(contracts.SharedRecordPath())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(storePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(storePath, []byte("not a valid secret record"), 0o600); err != nil {
		t.Fatal(err)
	}
	active := contracts.InstallReceipt{}
	plan := contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{SecretInputs: []string{"new.secret"}}}
	updateInvocation := contracts.ShellCommand("kb-create", "update", "--index", "release index.json", "--input", "request.json", "--platform-root", root, "--json")
	failure := requireUpdateSecrets(active, plan, secrets.Store{PlatformRoot: root, ReadOnly: true}, updateCommandInput{RetryCommand: updateInvocation}, root)
	if failure == nil || failure.Code != contracts.CodeApplyFailed {
		t.Fatalf("unreadable secret store diagnostic = %#v", failure)
	}
	if failure.Message != "the installation secret store could not be read during update" {
		t.Fatalf("unreadable store message = %q", failure.Message)
	}
	doctorCommand := contracts.ShellCommand("kb-create", "doctor", "--platform-root", root, "--json")
	wantHint := "run `" + doctorCommand + "` to inspect the installation, then retry `" + updateInvocation + "`."
	if failure.Hint != wantHint {
		t.Fatalf("unreadable store hint = %q, want exact doctor and update invocations %q", failure.Hint, wantHint)
	}
}

type commandResult struct {
	payload map[string]any
	code    int
	output  string
}

func quotedCommandFromHint(t *testing.T, hint string) string {
	t.Helper()
	parts := strings.Split(hint, "`")
	if len(parts) < 3 {
		t.Fatalf("diagnostic hint has no quoted command: %q", hint)
	}
	return parts[1]
}

func writeSecretCommandInputs(t *testing.T, inst installation, fakehost, binaryURL, binaryHash string, packages map[string][]byte, storedSecret, targetRequiresSecret bool) (initialIndex, updateIndex, requestPath string) {
	t.Helper()
	makeIndex := func(required bool) string {
		platformVersion := "1.0.0"
		if required {
			platformVersion = "1.1.0"
		}
		data := testfixtures.ReleaseIndexJSON(platformVersion, "1.0.0", goruntime.GOOS, goruntime.GOARCH)
		var source catalog.Catalog
		if err := json.Unmarshal(data, &source); err != nil {
			t.Fatal(err)
		}
		source.Platforms[0].Host = &contracts.HostSpec{
			Command: fakehost, Args: []string{"-port", fmt.Sprint(inst.port)},
			HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", inst.port), ReadyTimeoutSeconds: 10, StopGraceSeconds: 5,
		}
		source.Platforms[0].Profiles["default"] = contracts.ServiceGraph{Services: []contracts.Service{{ID: "runtime", Command: "runtime", Port: inst.port}}}
		source.Platforms[0].Binaries[0].URL = binaryURL
		source.Platforms[0].Binaries[0].SHA256 = binaryHash
		platformPackage := packages["/platform-"+platformVersion+".tgz"]
		platformDigest := sha256.Sum256(platformPackage)
		source.Platforms[0].Tarball = binaryURL + "/platform-" + platformVersion + ".tgz"
		source.Platforms[0].SHA256 = hex.EncodeToString(platformDigest[:])
		source.Platforms[0].SizeBytes = int64(len(platformPackage))
		sdkPackage := packages["/sdk-1.0.0.tgz"]
		sdkDigest := sha256.Sum256(sdkPackage)
		source.SDKs[0].Tarball = binaryURL + "/sdk-1.0.0.tgz"
		source.SDKs[0].SHA256 = hex.EncodeToString(sdkDigest[:])
		source.SDKs[0].SizeBytes = int64(len(sdkPackage))
		cliPackage := packages["/cli-bin-1.0.0.tgz"]
		cliDigest := sha256.Sum256(cliPackage)
		source.Platforms[0].Members = []catalog.Component{{ID: "cli-bin", Version: "1.0.0", Package: "@kb-labs/cli-bin",
			Tarball: binaryURL + "/cli-bin-1.0.0.tgz", SHA256: hex.EncodeToString(cliDigest[:]), SizeBytes: int64(len(cliPackage))}}
		withProvenance, err := testfixtures.SealCatalogWithArchives(source, map[string][]byte{"@kb-labs/cli-bin@1.0.0": cliPackage})
		if err != nil {
			t.Fatalf("seal test package provenance: %v", err)
		}
		source = withProvenance
		requirement := catalog.ConfigRequirement{ID: "gateway.token", Secret: true, Required: required, Optional: !required,
			Env: "GATEWAY_TOKEN", Services: []string{"runtime"}}
		source.Platforms[0].Config = []catalog.ConfigRequirement{requirement}
		sealed, err := sealTestCatalog(t, source)
		if err != nil {
			t.Fatalf("seal test secret index: %v", err)
		}
		encoded, err := json.Marshal(sealed)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(t.TempDir(), "release-index.json")
		if err := os.WriteFile(path, encoded, 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	initialIndex = makeIndex(false)
	updateIndex = initialIndex
	if targetRequiresSecret {
		updateIndex = makeIndex(true)
	}
	request := contracts.InstallRequest{Schema: contracts.RequestSchema, Platform: contracts.VersionSelector{Version: "1.0.0"},
		SDK: contracts.VersionSelector{Version: "1.0.0"}, Policy: contracts.PolicyStrict, Source: contracts.SourceRegistry, PlatformRoot: inst.root}
	if storedSecret {
		request.SecretInputs = []string{"gateway.token"}
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	requestPath = filepath.Join(t.TempDir(), "request.json")
	if err := os.WriteFile(requestPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	return initialIndex, updateIndex, requestPath
}

func testPackageTarball(name, version string) []byte {
	return testPackageTarballWithFiles(name, version, nil)
}

func testPackageTarballWithFiles(name, version string, files map[string][]byte) []byte {
	return testfixtures.PackageTarball(name, version, files)
}

func fixturePackageProvenance(t *testing.T, name, version string) contracts.ArtifactProvenance {
	t.Helper()
	provenance, err := testfixtures.PackageProvenance(name, version)
	if err != nil {
		t.Fatalf("seal package fixture provenance: %v", err)
	}
	return provenance
}

func fixturePackageArtifact(t *testing.T, name, version string) contracts.Artifact {
	t.Helper()
	archive := testfixtures.PackageTarball(name, version, nil)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write(archive)
	}))
	t.Cleanup(server.Close)
	digest := sha256.Sum256(archive)
	return contracts.Artifact{
		ID: name, Kind: "plugin", Package: name, Version: version, Tarball: server.URL,
		SHA256: hex.EncodeToString(digest[:]), Provenance: fixturePackageProvenance(t, name, version),
	}
}

func (r *recordingInstaller) Install(items []contracts.Artifact) error {
	r.installed = append(r.installed, items...)
	if r.onInstall != nil {
		if err := r.onInstall(items); err != nil {
			return err
		}
	}
	return r.failure
}
func (r *recordingInstaller) Prepare(items []contracts.Artifact) (contracts.PreparedArtifacts, error) {
	return recordingPreparedArtifacts{install: func() error { return r.Install(items) }}, nil
}

type recordingPreparedArtifacts struct{ install func() error }

func (p recordingPreparedArtifacts) Install(func(string, bool) error) error { return p.install() }
func (recordingPreparedArtifacts) Close() error                             { return nil }
func (r *recordingInstaller) Restore([]contracts.Artifact) error            { r.restores++; return nil }
func (r *recordingInstaller) Uninstall([]contracts.Artifact) error          { return nil }

func treeDigest(root string) ([32]byte, error) {
	hash := sha256.New()
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		_, _ = hash.Write([]byte(relative + "\x00"))
		_, _ = hash.Write(data)
		return nil
	})
	var digest [32]byte
	copy(digest[:], hash.Sum(nil))
	return digest, err
}

func snapshotStateTree(t *testing.T, root string) map[string]string {
	t.Helper()
	snapshot := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		value := fmt.Sprintf("mode=%v;mod=%d;size=%d", info.Mode(), info.ModTime().UnixNano(), info.Size())
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			value += ";link=" + target
		}
		if info.Mode().IsRegular() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			value += ";bytes=" + string(data)
		}
		snapshot[relative] = value
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

// updatePlan is the resolved plan of platform 2.0.0 whose host is the fake host.
func updatePlan(t *testing.T, root string, port int, hostArgs ...string) contracts.ResolvedInstallPlan {
	t.Helper()
	plan := versionedReceipt(t, "2.0.0", port, hostArgs...).Plan
	plan.PlanHash = "plan-2.0.0-000000"
	plan.Request = contracts.InstallRequest{PlatformRoot: root}
	plan.Artifacts = []contracts.Artifact{{ID: "platform", Kind: "platform", Package: "@kb/platform", Version: "2.0.0"}}
	return plan
}

func versionedReceipt(t *testing.T, version string, port int, hostArgs ...string) contracts.InstallReceipt {
	t.Helper()
	_, fakehost := binaries(t)
	spec := &contracts.HostSpec{Command: fakehost,
		Args:      append([]string{"-port", fmt.Sprint(port)}, hostArgs...),
		HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 10, StopGraceSeconds: 5}
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema,
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: version, Services: []contracts.Service{{ID: "gateway", Command: "gateway"}}},
		Host:         spec}
	return contracts.InstallReceipt{ID: "receipt-" + version, InstallationID: "installation-stable", Plan: plan}
}

func TestUpdateReceiptPreservesTheResolvedPlanRootSpelling(t *testing.T) {
	inst := newInstallation(t)
	plan := updatePlan(t, inst.root, freeLoopbackPort(t))
	wantRoot := plan.Request.PlatformRoot
	state, err := host.StateForRoot(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	result, failure := runUpdateCommand(context.Background(), updateCommandInput{Executable: inst.launcher}, inst.root, plan,
		state, host.State{Dir: inst.state}, &runtime.Dependencies{Artifacts: &recordingInstaller{}})
	if failure != nil {
		t.Fatalf("update: code=%s message=%s details=%v", failure.Code, failure.Message, failure.Meta)
	}
	if got := result.Receipt.Plan.Request.PlatformRoot; got != wantRoot {
		t.Fatalf("update receipt plan root = %q, want resolved request root %q", got, wantRoot)
	}
}

// update runs the update command's orchestration and returns its JSON and status.
func (i installation) update(t *testing.T, plan contracts.ResolvedInstallPlan, installer *recordingInstaller) (map[string]any, int, string) {
	t.Helper()
	state, err := host.StateForRoot(i.root)
	if err != nil {
		t.Fatal(err)
	}
	launcherState := host.State{Dir: i.state}
	deps := runtime.Dependencies{Artifacts: installer, CorrelationID: "update-test"}
	layout, err := versionroot.New(i.root)
	if err != nil {
		t.Fatal(err)
	}
	plan.Request.PlatformRoot = layout.PlatformRoot()
	result, failure := runUpdateCommand(context.Background(), updateCommandInput{Executable: i.launcher}, i.root, plan, state, launcherState, &deps)
	if failure != nil {
		payload := diagValue(t, failure)
		return payload, diag.ExitCode(failure).Code(), fmt.Sprint(payload)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	return payload, 0, fmt.Sprint(payload)
}

func TestUpdateCommandKeepsRunningHostOnPreviousVersionAndReportsPendingRestart(t *testing.T) {
	inst := newInstallation(t)
	active, err := receipt.Read(platformRootForTest(t, inst.root))
	if err != nil {
		t.Fatal(err)
	}
	active.Plan.ServiceGraph.PlatformVersion = "1.0.0"
	active.Plan.ServiceGraph.Services = []contracts.Service{{ID: "gateway"}}
	if err := receipt.Write(platformRootForTest(t, inst.root), active); err != nil {
		t.Fatal(err)
	}
	if _, code, raw := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start: %s", raw)
	}
	installer := &recordingInstaller{}
	stateBefore := snapshotStateTree(t, filepath.Join(inst.root, "state"))
	layout, err := versionroot.New(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	oldRoot, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	oldLockPath := filepath.Join(oldRoot, ".kb", "marketplace.lock")
	if _, lockErr := os.Stat(oldLockPath); !os.IsNotExist(lockErr) {
		t.Fatalf("fixture unexpectedly contains a marketplace lock: %v", lockErr)
	}
	oldConfigPath := filepath.Join(oldRoot, ".kb", "kb.config.jsonc")
	oldConfigBefore, configErr := os.ReadFile(oldConfigPath)
	if configErr != nil {
		t.Fatal(configErr)
	}

	payload, code, raw := inst.update(t, updatePlan(t, inst.root, inst.port), installer)
	if code != 0 || payload["ok"] != true || payload["hostRestarted"] != false {
		t.Fatalf("update: %d %s", code, raw)
	}
	if len(installer.installed) != 1 || installer.restores != 0 {
		t.Fatalf("installer: %#v", installer)
	}
	if after := snapshotStateTree(t, filepath.Join(inst.root, "state")); !reflect.DeepEqual(after, stateBefore) {
		t.Fatalf("shared state changed during successful staged update:\nbefore=%#v\nafter=%#v", stateBefore, after)
	}
	if _, err := os.Stat(oldLockPath); !os.IsNotExist(err) {
		t.Fatalf("update created a marketplace lock in the still-running old host root: %v", err)
	}
	if got, err := os.ReadFile(oldConfigPath); err != nil || !reflect.DeepEqual(got, oldConfigBefore) {
		t.Fatalf("old host config view changed: %v", err)
	}
	committed := payload["receipt"].(map[string]any)
	if committed["snapshotId"] == "" || committed["snapshotId"] != payload["snapshot"].(map[string]any)["id"] {
		t.Fatalf("the committed receipt must name the recovery snapshot: %s", raw)
	}
	if state, healthURL := inst.hostState(t); state != host.StateRunning || healthURL != fmt.Sprintf("http://127.0.0.1:%d/health", inst.port) {
		t.Fatalf("the old host must keep serving: %s %s", state, healthURL)
	}
	pending, ok := payload["pendingRestart"].(map[string]any)
	if !ok || pending["installedVersion"] != "2.0.0" || pending["command"] == "" {
		t.Fatalf("pending restart = %#v", payload["pendingRestart"])
	}
	services, ok := pending["services"].([]any)
	if !ok || len(services) != 1 || services[0].(map[string]any)["runningVersion"] != "1.0.0" {
		t.Fatalf("pending restart services = %#v", pending["services"])
	}
	mutable := filepath.Join(platformRootForTest(t, inst.root), ".kb", "data", "written-after-update.txt")
	if err := os.WriteFile(mutable, []byte("written after staging\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, code, raw := inst.run("restart", "--json"); code != 0 {
		t.Fatalf("explicit restart after update: %d %s", code, raw)
	}
	if data, err := os.ReadFile(mutable); err != nil || string(data) != "written after staging\n" {
		t.Fatalf("mutable data written after staging was lost at restart: data=%q err=%v", data, err)
	}
}

// case: PC-001.7, S-023.3
func TestFreshInstallWritesCompleteRunningIdentityBeforeFirstUpdate(t *testing.T) {
	launcher, fakehost := binaries(t)
	home := t.TempDir()
	kbHome := filepath.Join(home, ".kb")
	t.Setenv(host.KBHomeEnv, kbHome)
	root := filepath.Join(home, "install")
	port := freeLoopbackPort(t)
	state, err := host.StateHome()
	if err != nil {
		t.Fatal(err)
	}
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, PlanHash: "fresh-install-identity",
		Request: contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: root},
		Host: &contracts.HostSpec{Command: fakehost, Args: []string{"-port", fmt.Sprint(port)},
			HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 10},
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0", Services: []contracts.Service{{ID: "gateway"}}}}
	resolved := resolvedPlan{Plan: plan, State: state}
	deps := commandDependencies{NodeCheck: func() error { return nil }, ArtifactRunner: operationLogTestRunner{},
		Runtime: &runtime.Dependencies{Artifacts: installArtifacts{root: root}, Host: installedHostStarter{root: root, executable: launcher}}}
	inst := installation{launcher: launcher, root: root, kbHome: kbHome, state: state.Dir, port: port, t: t}
	var processID int
	t.Cleanup(func() {
		if _, code, output := inst.run("stop", "--json"); code != 0 {
			t.Errorf("stop fresh-install host cleanup: %s", output)
		}
		status, code, output := inst.run("status", "--json")
		if code != 0 || status["running"] == true {
			t.Errorf("fresh-install cleanup left host running: %s", output)
		}
		if processID != 0 && !waitHostExit(processID, 5*time.Second) {
			t.Errorf("fresh-install host process %d did not exit", processID)
		}
	})
	runApplyForTest(t, resolved, deps)
	recorded, err := host.NewRecordedRunner(root)
	if err != nil {
		t.Fatal(err)
	}
	hostStatus, statusErr := recorded.Status(context.Background())
	if statusErr != nil {
		t.Fatal(statusErr)
	}
	processID = hostStatus.PID
	if hostStatus.PlatformVersion != "1.0.0" || hostStatus.ReceiptID == "" || len(hostStatus.ServiceIDs) != 1 || hostStatus.ServiceIDs[0] != "gateway" || hostStatus.TreeRoot == "" {
		t.Fatalf("fresh install host identity is incomplete: %#v", hostStatus)
	}
	if _, err := os.ReadFile(filepath.Join(root, "state", "kb.config.jsonc")); err != nil {
		t.Fatalf("fresh install did not persist shared runtime config at the install root: %v", err)
	}
	if _, code, raw := inst.update(t, updatePlan(t, root, port), &recordingInstaller{}); code != 0 {
		t.Fatalf("first update after fresh install: %d %s", code, raw)
	}
	status, code, raw := inst.run("status", "--json")
	if code != 0 || status["runningVersion"] != "1.0.0" || status["installedVersion"] != "2.0.0" || status["pendingRestart"] == nil {
		t.Fatalf("first update did not report pending restart from fresh identity: code=%d status=%#v raw=%s", code, status, raw)
	}
	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	activeRoot, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	for _, spelling := range []string{root, layout.PlatformRoot(), activeRoot} {
		status, code, raw = inst.runAt(spelling, "status", "--json")
		if code != 0 || status["runningVersion"] != "1.0.0" || status["installedVersion"] != "2.0.0" || status["pendingRestart"] == nil {
			t.Fatalf("status after update for %q = code %d, %#v, %s", spelling, code, status, raw)
		}
	}
}

// case: PC-001.17, S-023.17, S-223.4
func TestFreshContainerInstallUpdateUpdateRestartRollbackRepeatUpdateUninstallWritesStayInsideRoot(t *testing.T) {
	launcher, fakehost := binaries(t)
	base := t.TempDir()
	parent := filepath.Join(base, "parent")
	if err := os.Mkdir(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(parent, "install")
	kbHome := filepath.Join(base, "user-state")
	t.Setenv(host.KBHomeEnv, kbHome)
	state, err := host.StateHome()
	if err != nil {
		t.Fatal(err)
	}
	port := freeLoopbackPort(t)
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, PlanHash: "container-v1",
		Request: contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: root},
		Host: &contracts.HostSpec{Command: fakehost, Args: []string{"-port", fmt.Sprint(port)},
			HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 10},
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0", Services: []contracts.Service{{ID: "gateway"}}}}
	inst := installation{launcher: launcher, root: root, kbHome: kbHome, state: state.Dir, port: port, t: t}
	var processID int
	var installed bool
	t.Cleanup(func() {
		if installed {
			if _, code, output := inst.run("stop", "--json"); code != 0 {
				t.Errorf("container lifecycle cleanup stop: %s", output)
			}
		}
		if processID != 0 && !waitHostExit(processID, 5*time.Second) {
			t.Errorf("container lifecycle left host process %d alive", processID)
		}
	})
	resolved := resolvedPlan{Plan: plan, State: state}
	deps := commandDependencies{NodeCheck: func() error { return nil }, ArtifactRunner: operationLogTestRunner{},
		Runtime: &runtime.Dependencies{Artifacts: installArtifacts{root: root}, Host: installedHostStarter{root: root, executable: launcher}}}
	runApplyForTest(t, resolved, deps)
	installed = true
	if _, code, output := inst.run("status", "--json"); code != 0 {
		t.Fatalf("status after fresh install: %s", output)
	}
	status, _, _ := inst.run("status", "--json")
	processID = int(status["host"].(map[string]any)["pid"].(float64))
	assertContainerParent(t, parent)

	var rollbackSnapshot string
	for _, version := range []string{"2.0.0", "3.0.0"} {
		target := updatePlan(t, root, port)
		target.PlanHash = "container-" + version
		target.ServiceGraph.PlatformVersion = version
		updated, code, output := inst.update(t, target, &recordingInstaller{})
		if code != 0 {
			t.Fatalf("update to %s: %d %s", version, code, output)
		}
		if version == "2.0.0" {
			rollbackSnapshot = updated["snapshot"].(map[string]any)["id"].(string)
			if rollbackSnapshot == "" {
				t.Fatalf("update to %s omitted its rollback snapshot: %#v", version, updated)
			}
		}
		assertContainerParent(t, parent)
	}
	if running, _ := inst.hostState(t); running != host.StateRunning {
		t.Fatalf("original host stopped before explicit restart: %s", running)
	}
	assertContainerParent(t, parent)
	if _, code, output := inst.run("restart", "--json"); code != 0 {
		t.Fatalf("restart after two updates: %s", output)
	}
	assertContainerParent(t, parent)
	if _, code, output := inst.run("stop", "--json"); code != 0 {
		t.Fatalf("stop before rollback: %s", output)
	}
	rollback, rollbackCode, rollbackOutput := invoke(t, operationTestSetup{Operation: "rollback", PlatformRoot: root, Snapshot: rollbackSnapshot,
		Yes: true, JSON: true, RuntimeDeps: &runtime.Dependencies{Artifacts: &recordingInstaller{}}})
	if rollbackCode != 0 || rollback["hostRestarted"] != false {
		var details map[string]any
		if failure, ok := rollback["error"].(map[string]any); ok {
			details, _ = failure["details"].(map[string]any)
		}
		var evidence []string
		for _, key := range []string{"logPath", "diagnosticPath"} {
			if path, ok := details[key].(string); ok {
				if data, readErr := os.ReadFile(path); readErr == nil {
					evidence = append(evidence, key+": "+string(data))
				}
			}
		}
		t.Fatalf("rollback after restart: %d %s\n%s", rollbackCode, rollbackOutput, strings.Join(evidence, "\n"))
	}
	status, code, output := inst.run("status", "--json")
	if code != 0 || status["host"].(map[string]any)["state"] != host.StateStopped || status["installedVersion"] != "1.0.0" {
		t.Fatalf("status after rollback: %d %#v %s", code, status, output)
	}
	repeat := updatePlan(t, root, port)
	repeat.PlanHash, repeat.ServiceGraph.PlatformVersion = "container-after-rollback", "2.0.0"
	if _, code, output := inst.update(t, repeat, &recordingInstaller{}); code != 0 {
		t.Fatalf("repeat update after rollback: %d %s", code, output)
	}
	installed = false
	if !waitHostExit(processID, 5*time.Second) {
		t.Fatalf("host process %d did not exit before uninstall", processID)
	}
	if _, err := runtime.Uninstall(root, runtime.Dependencies{Artifacts: &recordingInstaller{}}); err != nil {
		t.Fatalf("uninstall container: %v", err)
	}
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 0 {
		t.Fatalf("parent after uninstall = %#v, %v; expected no entries", entries, err)
	}
}

// case: S-023.17, S-024.2
func TestUpdateAndRollbackPreserveOutsideRootIdentityAndCurrentShim(t *testing.T) {
	launcher, fakehost := binaries(t)
	home := filepath.Join(t.TempDir(), "home")
	packageManagerPaths := []string{
		filepath.Join(home, ".cache", "pnpm", "lockfile-verified.jsonl"),
		filepath.Join(home, ".local", "share", "pnpm", "store", "v1", "outside-root-marker"),
	}
	for _, path := range packageManagerPaths {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("outside-root package-manager state\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	launcherDir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(launcherDir, 0o700); err != nil {
		t.Fatal(err)
	}
	installedLauncher := filepath.Join(launcherDir, "kb-create")
	launcherBytes, err := os.ReadFile(launcher)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(installedLauncher, launcherBytes, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	root := filepath.Join(home, "kb-platform")
	kbHome := filepath.Join(home, ".kb")
	t.Setenv(host.KBHomeEnv, kbHome)
	state, err := host.StateHome()
	if err != nil {
		t.Fatal(err)
	}
	port := freeLoopbackPort(t)
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, PlanHash: "outside-root-v1",
		Request: contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: root},
		Host: &contracts.HostSpec{Command: fakehost, Args: []string{"-port", fmt.Sprint(port)},
			HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 10},
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0", Services: []contracts.Service{{ID: "gateway"}}}}
	inst := installation{launcher: installedLauncher, root: root, kbHome: kbHome, state: state.Dir, port: port, t: t}
	resolved := resolvedPlan{Plan: plan, State: state}
	deps := commandDependencies{NodeCheck: func() error { return nil }, ArtifactRunner: operationLogTestRunner{},
		Runtime: &runtime.Dependencies{Artifacts: installArtifacts{root: root}, Host: installedHostStarter{root: root, executable: launcher}}}
	registerTestHostProcessTreeCleanup(t, root)
	installed := false
	t.Cleanup(func() {
		if installed {
			status, statusCode, _ := inst.run("status", "--json")
			if statusCode == 0 && status["running"] == true {
				if _, code, output := inst.run("stop", "--json"); code != 0 {
					t.Errorf("outside-root lifecycle cleanup stop: %s", output)
				}
			}
		}
	})
	installed = true
	runApplyForTest(t, resolved, deps)
	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	activeRoot, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	cliEntry := filepath.Join(activeRoot, "node_modules", "@kb-labs", "cli-bin", "dist", "bin.js")
	if err := os.MkdirAll(filepath.Dir(cliEntry), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cliEntry, []byte("// installed CLI fixture\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := shim.Ensure(installedLauncher, layout.PlatformRoot()); err != nil {
		t.Fatalf("establish installed shim through its owner: %v", err)
	}
	assertShimUsesCurrentActiveCLI(t, installedLauncher, layout)
	beforeUpdate := snapshotOutsideRoot(t, home, root)
	assertPackageManagerPathsIncluded(t, beforeUpdate, packageManagerPaths)
	update := updatePlan(t, root, port)
	update.PlanHash, update.ServiceGraph.PlatformVersion = "outside-root-v2", "2.0.0"
	installer := &recordingInstaller{onInstall: func(_ []contracts.Artifact) error {
		return writeCLIEntryToUpdateStage(root)
	}}
	updated, code, output := inst.update(t, update, installer)
	if code != 0 {
		t.Fatalf("update: %d %s", code, output)
	}
	assertOutsideRootIdentity(t, beforeUpdate, snapshotOutsideRoot(t, home, root), "update")
	assertShimUsesCurrentActiveCLI(t, installedLauncher, layout)
	snapshotID := updated["snapshot"].(map[string]any)["id"].(string)
	if _, code, output := inst.run("stop", "--json"); code != 0 {
		t.Fatalf("stop before rollback: %s", output)
	}
	beforeRollback := snapshotOutsideRoot(t, home, root)
	assertPackageManagerPathsIncluded(t, beforeRollback, packageManagerPaths)
	rollback, code, output := invoke(t, operationTestSetup{Operation: "rollback", PlatformRoot: root, Snapshot: snapshotID,
		Yes: true, JSON: true, RuntimeDeps: &runtime.Dependencies{Artifacts: &recordingInstaller{}}})
	if code != 0 || rollback["hostRestarted"] != false {
		t.Fatalf("rollback: %d %#v %s", code, rollback, output)
	}
	assertOutsideRootIdentity(t, beforeRollback, snapshotOutsideRoot(t, home, root), "rollback")
	assertShimUsesCurrentActiveCLI(t, installedLauncher, layout)
}

func assertPackageManagerPathsIncluded(t *testing.T, snapshot map[string]string, paths []string) {
	t.Helper()
	for _, path := range paths {
		if _, ok := snapshot[path]; !ok {
			t.Fatalf("outside-root snapshot omitted package-manager state %q", path)
		}
	}
}

func writeCLIEntryToUpdateStage(root string) error {
	layout, err := versionroot.New(root)
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(layout.VersionsDir())
	if err != nil {
		return err
	}
	var stage string
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), ".stage-") {
			if stage != "" {
				return fmt.Errorf("multiple staged version roots exist during fixture artifact installation")
			}
			stage = filepath.Join(layout.VersionsDir(), entry.Name())
		}
	}
	if stage == "" {
		return fmt.Errorf("update fixture could not locate its staged version root")
	}
	cliEntry := filepath.Join(stage, "node_modules", "@kb-labs", "cli-bin", "dist", "bin.js")
	if err := os.MkdirAll(filepath.Dir(cliEntry), 0o700); err != nil {
		return err
	}
	return os.WriteFile(cliEntry, []byte("// updated CLI fixture\n"), 0o600)
}

func snapshotOutsideRoot(t *testing.T, home, root string) map[string]string {
	t.Helper()
	snapshot := make(map[string]string)
	err := filepath.WalkDir(home, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return filepath.SkipDir
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		identity := info.Mode().String()
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			identity += ":symlink:" + target
		} else if info.Mode().IsRegular() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			digest := sha256.Sum256(data)
			identity += ":sha256:" + hex.EncodeToString(digest[:])
		}
		snapshot[path] = identity
		return nil
	})
	if err != nil {
		t.Fatalf("snapshot paths outside install root: %v", err)
	}
	return snapshot
}

func assertOutsideRootIdentity(t *testing.T, before, after map[string]string, operation string) {
	t.Helper()
	paths := make(map[string]struct{}, len(before)+len(after))
	for path := range before {
		paths[path] = struct{}{}
	}
	for path := range after {
		paths[path] = struct{}{}
	}
	for path := range paths {
		if before[path] != after[path] {
			t.Errorf("%s changed outside-root path %s: before=%q after=%q", operation, path, before[path], after[path])
		}
	}
}

func assertShimUsesCurrentActiveCLI(t *testing.T, launcher string, layout versionroot.Layout) {
	t.Helper()
	shimPath := shim.Path(launcher)
	shimInfo, err := os.Lstat(shimPath)
	if err != nil {
		t.Fatalf("kb shim missing after lifecycle operation: %v", err)
	}
	if shimInfo.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("kb shim %s is not a symlink", shimPath)
	}
	target, err := os.Readlink(shimPath)
	if err != nil {
		t.Fatal(err)
	}
	wantTarget := shim.Target(layout.PlatformRoot())
	if target != wantTarget {
		t.Fatalf("kb shim target=%q, want stable current target %q", target, wantTarget)
	}
	activeRoot, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	resolvedTarget, err := filepath.EvalSymlinks(shimPath)
	if err != nil {
		t.Fatalf("resolve kb shim: %v", err)
	}
	wantResolved := filepath.Join(activeRoot, ".kb", "v2", "bin", "kb")
	if resolvedTarget != wantResolved {
		t.Fatalf("kb shim resolves to %q, want active current version %q", resolvedTarget, wantResolved)
	}
	shimBytes, err := os.ReadFile(resolvedTarget)
	if err != nil {
		t.Fatalf("read active kb shim target: %v", err)
	}
	stableCLIEntry := filepath.Join(layout.PlatformRoot(), "node_modules", "@kb-labs", "cli-bin", "dist", "bin.js")
	if !strings.Contains(string(shimBytes), stableCLIEntry) || strings.Contains(string(shimBytes), activeRoot) {
		t.Fatalf("active kb shim must resolve the CLI through current, not the version directory: %s", shimBytes)
	}
}

// case: S-223.6
func TestProductionArtifactWiringSharesBinaryCacheAcrossInstallAndUpdates(t *testing.T) {
	root := filepath.Join(t.TempDir(), "install")
	launcher, fakehost := binaries(t)
	port := freeLoopbackPort(t)
	kbHome := filepath.Join(t.TempDir(), ".kb")
	t.Setenv(host.KBHomeEnv, kbHome)
	hostSpec := &contracts.HostSpec{Command: fakehost, Args: []string{"-port", fmt.Sprint(port)},
		HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 10}
	fixtures := map[string][]byte{
		"install": []byte("install binary fixture"),
		"update1": []byte("first update binary fixture"),
		"update2": []byte("second update binary fixture"),
		"package": testPackageTarball("@kb-labs/fixture", "1.0.0"),
	}
	digests := make(map[string]string, len(fixtures))
	for name, data := range fixtures {
		digest := sha256.Sum256(data)
		digests[name] = hex.EncodeToString(digest[:])
	}
	var requests int
	packageRequests := 0
	var stageProjectionFailure string
	operationName := ""
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		name := strings.TrimPrefix(request.URL.Path, "/")
		data, ok := fixtures[name]
		if !ok {
			http.NotFound(writer, request)
			return
		}
		requests++
		if name == "package" {
			packageRequests++
		}
		// StageInitial links declared projections before artifact downloads. Update stages stay unprojected until activation.
		if operationName != "install" {
			entries, err := os.ReadDir(filepath.Join(root, "versions"))
			if err != nil {
				stageProjectionFailure = fmt.Sprintf("download %s: %v", name, err)
			} else {
				stages := 0
				for _, entry := range entries {
					if !strings.HasPrefix(entry.Name(), ".stage-") {
						continue
					}
					stages++
					stage := filepath.Join(root, "versions", entry.Name())
					if err := versionroot.ValidateNoSharedRuntimeProjectionEntries(stage); err != nil {
						stageProjectionFailure = fmt.Sprintf("download %s: %v in %s", name, err, stage)
						break
					}
				}
				if stages == 0 {
					stageProjectionFailure = fmt.Sprintf("download %s did not observe a staged version", name)
				}
			}
		}
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write(data)
	}))
	defer server.Close()

	installPlan := contracts.ResolvedInstallPlan{
		Schema: contracts.ResolvedPlanSchema, PlanHash: "production-artifacts-install",
		Request:      contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: root},
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0", Services: []contracts.Service{{ID: "gateway", Command: "gateway"}}},
		Host:         hostSpec,
		Artifacts: []contracts.Artifact{
			{ID: "fixture-binary", Kind: "binary", Version: "1.0.0", URL: server.URL + "/install", SHA256: digests["install"], Target: "bin/kb-create"},
			{ID: "fixture-package", Kind: "plugin", Version: "1.0.0", Package: "@kb-labs/fixture", Tarball: server.URL + "/package", SHA256: digests["package"], Provenance: fixturePackageProvenance(t, "@kb-labs/fixture", "1.0.0")},
		},
	}
	state, err := host.StateForRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	packageRunner := productionPackageFixtureRunner{}
	deps := commandDependencies{NodeCheck: func() error { return nil }, Runtime: &runtime.Dependencies{Host: installedHostStarter{root: root, executable: launcher}}, ArtifactRunner: packageRunner}
	inst := installation{launcher: launcher, root: root, kbHome: kbHome, state: state.Dir, port: port, t: t}
	t.Cleanup(func() {
		status, code, output := inst.run("status", "--json")
		if code == 0 && status["host"].(map[string]any)["state"] == host.StateRunning {
			pid := int(status["host"].(map[string]any)["pid"].(float64))
			if _, code, output := inst.run("stop", "--json"); code != 0 {
				t.Errorf("production artifact wiring test cleanup stop: %s", output)
			}
			if !waitHostExit(pid, 5*time.Second) {
				t.Errorf("production artifact wiring left host process %d alive", pid)
			}
		} else if code != 0 && !strings.Contains(output, "not running") {
			t.Errorf("production artifact wiring test cleanup status: %s", output)
		}
	})
	operationName = "install"
	runApplyForTest(t, resolvedPlan{Plan: installPlan, State: state}, deps)

	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	cacheRoot, err := layout.SharedRuntimePath(".kb/v2/cache")
	if err != nil {
		t.Fatal(err)
	}
	assertBinaryCached := func(name string) {
		t.Helper()
		cached, readErr := os.ReadFile(filepath.Join(cacheRoot, "binaries", digests[name]))
		if readErr != nil || !bytes.Equal(cached, fixtures[name]) {
			t.Fatalf("%s binary was not cached in install-root shared cache %s: %v", name, cacheRoot, readErr)
		}
	}
	assertBinaryCached("install")
	assertActiveProjectionsAreLinks := func() {
		t.Helper()
		active, activeErr := layout.Active()
		if activeErr != nil {
			t.Fatalf("resolve active version for shared projections: %v", activeErr)
		}
		for _, projection := range contracts.SharedRuntimeProjections() {
			path := filepath.Join(active, filepath.FromSlash(projection.PlatformPath))
			info, statErr := os.Lstat(path)
			if statErr != nil || info.Mode()&os.ModeSymlink == 0 {
				t.Fatalf("active version projection %s is not the activation link: mode=%v error=%v", projection.PlatformPath, info, statErr)
			}
			target, resolveErr := filepath.EvalSymlinks(path)
			if resolveErr != nil || !strings.HasPrefix(target, layout.SharedStateDir()+string(filepath.Separator)) {
				t.Fatalf("active version projection %s does not resolve into install-root shared state: target=%q error=%v", projection.PlatformPath, target, resolveErr)
			}
		}
	}
	assertActiveProjectionsAreLinks()

	launcherState, err := host.StateHome()
	if err != nil {
		t.Fatal(err)
	}
	state, err = host.StateForRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	var rollbackSnapshot string
	for _, name := range []string{"update1", "update2"} {
		version := map[string]string{"update1": "2.0.0", "update2": "3.0.0"}[name]
		plan := contracts.ResolvedInstallPlan{
			Schema: contracts.ResolvedPlanSchema, PlanHash: "production-artifacts-" + name,
			Request:      contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: root},
			ServiceGraph: contracts.ServiceGraph{PlatformVersion: version, Services: []contracts.Service{{ID: "gateway", Command: "gateway"}}},
			Host:         hostSpec,
			Artifacts: []contracts.Artifact{
				{ID: "fixture-binary", Kind: "binary", Version: version, URL: server.URL + "/" + name, SHA256: digests[name], Target: "bin/kb-create"},
				{ID: "fixture-package", Kind: "plugin", Version: "1.0.0", Package: "@kb-labs/fixture", Tarball: server.URL + "/package", SHA256: digests["package"], Provenance: fixturePackageProvenance(t, "@kb-labs/fixture", "1.0.0")},
			},
		}
		plan.Request.PlatformRoot = layout.PlatformRoot()
		operationName = name
		runner := packageRunner
		input := updateCommandInput{Executable: "kb-create", ArtifactRunner: runner}
		if name == "update2" {
			indexPath := filepath.Join(t.TempDir(), "release index.json")
			requestPath := filepath.Join(t.TempDir(), "request input.json")
			input.RetryCommand = updateTestRetryInvocation(t, indexPath, requestPath, root)
			priorRoot, priorErr := layout.Active()
			if priorErr != nil {
				t.Fatal(priorErr)
			}
			priorMetadata, readErr := os.ReadFile(filepath.Join(root, "installer", "layout.json"))
			if readErr != nil {
				t.Fatal(readErr)
			}
			priorReceipt, readErr := os.ReadFile(receipt.Path(priorRoot))
			if readErr != nil {
				t.Fatal(readErr)
			}
			priorOperation, readErr := os.ReadFile(filepath.Join(root, "installer", "update-operation.json"))
			if readErr != nil {
				t.Fatal(readErr)
			}
			input.ArtifactRunner = productionPackageFixtureRunner{injectProjection: true}
			_, refusal := runUpdateCommand(context.Background(), input, root, plan, state, launcherState, nil)
			if refusal == nil || refusal.Code != contracts.CodeApplyFailed || !strings.Contains(refusal.Cause, ".kb/v2/cache") {
				t.Fatalf("activation refusal = %#v; want shared-cache stage refusal", refusal)
			}
			if got, activeErr := layout.Active(); activeErr != nil || got != priorRoot {
				t.Fatalf("refusal changed current root: before=%q after=%q error=%v", priorRoot, got, activeErr)
			}
			if got, readErr := os.ReadFile(filepath.Join(root, "installer", "layout.json")); readErr != nil || !bytes.Equal(got, priorMetadata) {
				t.Fatalf("refusal changed layout metadata: %v", readErr)
			}
			if got, readErr := os.ReadFile(receipt.Path(priorRoot)); readErr != nil || !bytes.Equal(got, priorReceipt) {
				t.Fatalf("refusal changed active receipt: %v", readErr)
			}
			if got, readErr := os.ReadFile(filepath.Join(root, "installer", "update-operation.json")); readErr != nil || !bytes.Equal(got, priorOperation) {
				t.Fatalf("refusal changed durable update recovery record: %v", readErr)
			}
			commandText := quotedCommandFromHint(t, refusal.Hint)
			process := exec.Command("sh", "-c", "set -- "+commandText+"; printf '%s\\0' \"$@\"")
			output, processErr := process.Output()
			if processErr != nil {
				t.Fatalf("parse activation retry hint: %v", processErr)
			}
			gotArgv := strings.Split(strings.TrimSuffix(string(output), "\x00"), "\x00")
			wantArgv := []string{"kb-create", "update", "--index", indexPath, "--input", requestPath, "--platform-root", root}
			if !reflect.DeepEqual(gotArgv, wantArgv) {
				t.Fatalf("retry command argv = %#v, want original invocation %#v", gotArgv, wantArgv)
			}
			input.ArtifactRunner = runner
		}
		result, failure := runUpdateCommand(context.Background(), input, root, plan,
			state, launcherState, nil)
		if stageProjectionFailure != "" {
			t.Fatalf("shared projection existed in a staged tree during %s: %s", name, stageProjectionFailure)
		}
		if failure != nil {
			t.Fatalf("production update to %s failed: %v; cause=%s", version, failure, failure.Cause)
		}
		if name == "update1" {
			rollbackSnapshot, _ = result.Snapshot["id"].(string)
		}
		if name == "update2" {
			updatedMetadata, readErr := layout.UpdateMetadata()
			if readErr != nil || updatedMetadata.SnapshotID != result.Snapshot["id"] {
				t.Fatalf("successful retry did not publish recovery record: metadata=%#v error=%v", updatedMetadata, readErr)
			}
		}
		assertBinaryCached(name)
		assertActiveProjectionsAreLinks()
	}
	if requests != 5 || packageRequests != 1 {
		t.Fatalf("production artifact downloads = %d (package tarball %d), want install, update 1, refused update 2, retry update 2, and one shared package tarball", requests, packageRequests)
	}
	packageCache := filepath.Join(cacheRoot, "packages", digests["package"]+".tgz")
	if cached, readErr := os.ReadFile(packageCache); readErr != nil || !bytes.Equal(cached, fixtures["package"]) {
		t.Fatalf("package tarball was not reused from install-root shared cache %s: %v", packageCache, readErr)
	}
	if rollbackSnapshot == "" {
		t.Fatal("first update omitted the snapshot needed by production rollback")
	}
	if _, code, raw := inst.run("stop", "--json"); code != 0 {
		t.Fatalf("stop before production rollback: %d %s", code, raw)
	}
	if _, failure := executeRollback(context.Background(), rollbackCommandInput{
		PlatformRoot: root, Snapshot: rollbackSnapshot, Yes: true, Executable: "kb-create", ArtifactRunner: operationLogTestRunner{},
	}); failure != nil {
		t.Fatalf("production rollback construction failed: %v (reason=%s cause=%s meta=%v)", failure, failure.Reason, failure.Cause, failure.Meta)
	}
	rolledBack, err := receipt.Read(platformRootForTest(t, root))
	if err != nil || rolledBack.Plan.ServiceGraph.PlatformVersion != "1.0.0" {
		t.Fatalf("production rollback did not restore update1 snapshot: version=%q error=%v", rolledBack.Plan.ServiceGraph.PlatformVersion, err)
	}
}

// case: S-054.11
func TestFreshKbCreateInstallPinsAllowMarketplaceAdapterInstall(t *testing.T) {
	root := filepath.Join(t.TempDir(), "install")
	home := t.TempDir()
	t.Cleanup(func() {
		if err := filepath.Walk(home, func(name string, info os.FileInfo, walkErr error) error {
			if walkErr != nil {
				if errors.Is(walkErr, os.ErrNotExist) {
					return nil
				}
				return walkErr
			}
			mode := info.Mode().Perm() | 0o200
			if info.IsDir() {
				mode |= 0o100
			}
			if err := os.Chmod(name, mode); errors.Is(err, os.ErrNotExist) {
				return nil
			} else {
				return err
			}
		}); err != nil {
			t.Errorf("make isolated test HOME removable: %v", err)
		}
	})
	t.Setenv("HOME", home)
	t.Setenv("COREPACK_HOME", filepath.Join(home, "corepack"))
	launcher, fakehost := binaries(t)
	port := freeLoopbackPort(t)
	registerTestHostProcessTreeCleanup(t, root)
	sealed := fixturePackageArtifact(t, "@kb-labs/sealed-runtime", "1.0.0")
	plan := contracts.ResolvedInstallPlan{
		Schema: contracts.ResolvedPlanSchema, PlanHash: "fresh-marketplace-pin-install",
		Request: contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: root},
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0", Profile: "default",
			Services: []contracts.Service{{ID: "gateway", Command: "gateway", Port: port}}},
		Host: &contracts.HostSpec{Command: fakehost, Args: []string{"-port", fmt.Sprint(port)},
			HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 10, StopGraceSeconds: 5},
		Artifacts: []contracts.Artifact{sealed},
	}
	deps := commandDependencies{NodeCheck: func() error { return nil }, ArtifactRunner: productionPackageFixtureRunner{},
		Runtime: &runtime.Dependencies{Host: installedHostStarter{root: root, executable: launcher}}}
	if _, failure := executeApply(context.Background(), applyCommandInput{Resolved: &resolvedPlan{Plan: plan, State: host.State{Dir: t.TempDir()}}}, deps); failure != nil {
		t.Fatalf("fresh kb-create apply: code=%s reason=%s cause=%s meta=%v", failure.Code, failure.Reason, failure.Cause, failure.Meta)
	}

	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	activeRoot, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	installedReceipt, err := receipt.Read(activeRoot)
	if err != nil {
		t.Fatalf("read producer receipt from active root: %v", err)
	}
	if len(installedReceipt.Plan.Artifacts) != 1 || installedReceipt.Plan.Artifacts[0].Package != sealed.Package || installedReceipt.Plan.Artifacts[0].SHA256 != sealed.SHA256 {
		t.Fatalf("producer receipt artifacts = %#v", installedReceipt.Plan.Artifacts)
	}
	cacheRoot, err := layout.SharedRuntimePath(".kb/v2/cache")
	if err != nil {
		t.Fatal(err)
	}
	archivePath := filepath.Join(cacheRoot, "packages", sealed.SHA256+".tgz")
	if _, err := os.Stat(archivePath); err != nil {
		t.Fatalf("producer archive %q: %v", archivePath, err)
	}
	workspacePath := filepath.Join(activeRoot, "pnpm-workspace.yaml")
	workspace, err := os.ReadFile(workspacePath)
	if err != nil {
		t.Fatalf("read producer workspace: %v", err)
	}
	var workspaceConfig struct {
		Overrides map[string]string `yaml:"overrides"`
	}
	if err := yaml.Unmarshal(workspace, &workspaceConfig); err != nil {
		t.Fatalf("parse producer workspace: %v", err)
	}
	wantOverride := "file:" + filepath.ToSlash(archivePath)
	if workspaceConfig.Overrides[sealed.Package] != wantOverride {
		t.Fatalf("producer override for %s = %q, want %q", sealed.Package, workspaceConfig.Overrides[sealed.Package], wantOverride)
	}

	const adapterID = "@kb-labs/marketplace-adapter-fixture"
	adapterTarball := testPackageTarball(adapterID, "1.0.0")
	integrity := sha512.Sum512(adapterTarball)
	var registry *httptest.Server
	registry = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasSuffix(request.URL.Path, ".tgz") {
			_, _ = writer.Write(adapterTarball)
			return
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"name": adapterID, "dist-tags": map[string]string{"latest": "1.0.0"},
			"versions": map[string]any{"1.0.0": map[string]any{
				"name": adapterID, "version": "1.0.0", "kb": map[string]any{"adapter": map[string]any{}},
				"dist": map[string]string{"integrity": "sha512-" + base64.StdEncoding.EncodeToString(integrity[:]),
					"tarball": registry.URL + "/marketplace-adapter-fixture-1.0.0.tgz"},
			}},
		})
	}))
	defer registry.Close()

	nodePath, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	corepackPath, err := exec.LookPath("corepack")
	if err != nil {
		t.Fatal(err)
	}
	binDir := filepath.Join(home, "bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		t.Fatal(err)
	}
	pnpmShim := filepath.Join(binDir, "pnpm")
	if err := os.WriteFile(pnpmShim, []byte("#!/bin/sh\nexec \"$COREPACK_PATH\" pnpm@11.4.0 \"$@\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("COREPACK_PATH", corepackPath)
	t.Setenv("npm_config_store_dir", filepath.Join(home, "pnpm-store"))
	workspaceRoot, err := filepath.Abs("../../../../../")
	if err != nil {
		t.Fatal(err)
	}
	marketplaceModule := filepath.Join(workspaceRoot, "services", "marketplace", "npm", "dist", "index.js")
	const marketplaceInstall = `
const moduleURL = (await import('node:url')).pathToFileURL(process.argv[1]).href;
const { NpmPackageSource } = await import(moduleURL);
const [root, registry, packageId] = process.argv.slice(2);
const source = new NpmPackageSource({ registryUrl: registry });
const resolved = await source.resolve(packageId);
const installed = await source.install(resolved, root);
await source.commitInstall(packageId, root);
console.log(JSON.stringify({ id: installed.id, version: installed.version }));
`
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, nodePath, "--input-type=module", "-e", marketplaceInstall,
		marketplaceModule, activeRoot, registry.URL, adapterID)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("Marketplace adapter install against producer root: %v\n%s", err, output)
	}
	var installedAdapter struct {
		ID      string `json:"id"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(output, &installedAdapter); err != nil || installedAdapter.ID != adapterID || installedAdapter.Version != "1.0.0" {
		t.Fatalf("Marketplace adapter result = %#v, err=%v, output=%s", installedAdapter, err, output)
	}
}

func TestUpdatePlanRetainsInstalledMarketplaceAdapterFromActiveLock(t *testing.T) {
	root := t.TempDir()
	const adapterID = "@kb-labs/adapters-vibeproxy"
	const pluginID = "@kb-labs/commit"
	for _, packageName := range []string{adapterID, "@kb-labs/commit"} {
		packageJSON := filepath.Join(root, "node_modules", filepath.FromSlash(packageName), "package.json")
		if err := os.MkdirAll(filepath.Dir(packageJSON), 0o750); err != nil {
			t.Fatal(err)
		}
		encodedPackage, err := json.Marshal(map[string]string{"name": packageName, "version": "1.0.0"})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(packageJSON, encodedPackage, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := marketplace.WriteLock(root, root, []contracts.Artifact{
		{ID: adapterID, Kind: "adapter", Package: adapterID, Version: "1.0.0"},
		{ID: pluginID, Kind: "plugin", Package: "@kb-labs/commit", Version: "1.0.0"},
	}, time.Now()); err != nil {
		t.Fatalf("write active marketplace lock: %v", err)
	}

	var source catalog.Catalog
	if err := json.Unmarshal(testfixtures.ReleaseIndexJSON("1.0.0", "1.0.0", goruntime.GOOS, goruntime.GOARCH), &source); err != nil {
		t.Fatal(err)
	}
	source.Adapters = append(source.Adapters, catalog.Adapter{Component: catalog.Component{
		ID: adapterID, Version: "1.0.0", Package: adapterID, Tarball: "https://example.test/vibeproxy.tgz", SHA256: "vibeproxy",
	}})
	source, err := testfixtures.SealCatalog(source)
	if err != nil {
		t.Fatalf("seal update release index: %v", err)
	}
	request := contracts.InstallRequest{Schema: contracts.RequestSchema,
		Platform: contracts.VersionSelector{Version: "1.0.0"}, SDK: contracts.VersionSelector{Version: "1.0.0"},
		ServiceProfile: "default", PlatformRoot: root}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	initial := transport.PlanWith(encoded, source, resolve.Options{LauncherVersion: buildVersion})
	if !initial.OK {
		t.Fatalf("initial plan: %#v", initial.Error)
	}
	updated, failure := planUpdateWithMarketplaceLock(root, *initial.Plan, source, "kb-create update --platform-root "+root)
	if failure != nil {
		t.Fatalf("plan with active marketplace lock: code=%s reason=%s details=%v", failure.Code, failure.Reason, failure.Meta)
	}
	foundAdapter, foundPlugin := false, false
	for _, artifact := range updated.Artifacts {
		if artifact.ID == adapterID && artifact.Kind == "adapter" {
			foundAdapter = true
		}
		if artifact.ID == pluginID && artifact.Kind == "plugin" {
			foundPlugin = true
		}
	}
	if !foundAdapter || foundPlugin {
		t.Fatalf("updated plan must retain the installed adapter and keep Marketplace plugins outside the release index: adapter=%t plugin=%t artifacts=%+v", foundAdapter, foundPlugin, updated.Artifacts)
	}

	withoutAdapter := source
	withoutAdapter.Adapters = nil
	_, failure = planUpdateWithMarketplaceLock(root, *initial.Plan, withoutAdapter,
		"kb-create update --platform-root "+root)
	if failure == nil || failure.Code != contracts.CodeIncompatibleComponents || failure.Meta["id"] != adapterID {
		t.Fatalf("missing installed adapter failure = %#v; want a component-selection refusal naming %s", failure, adapterID)
	}
	if _, err := diag.ToEnvelope(failure); err != nil {
		t.Fatalf("missing installed adapter diagnostic violated its catalog contract: %v", err)
	}
}

func updateTestRetryInvocation(t *testing.T, indexPath, requestPath, platformRoot string) string {
	t.Helper()
	root := &cobra.Command{Use: "kb-create"}
	command := &cobra.Command{Use: "update"}
	root.AddCommand(command)
	descriptor, ok := lookupOperationDescriptor("update")
	if !ok {
		t.Fatal("update operation descriptor is missing")
	}
	values := make(map[string]any)
	registerLocalFlags(command, descriptor.Flags, values)
	if err := command.ParseFlags([]string{"--index", indexPath, "--input", requestPath, "--platform-root", platformRoot}); err != nil {
		t.Fatal(err)
	}
	invocation, err := newCommandFlagReader(command, values).Invocation()
	if err != nil {
		t.Fatal(err)
	}
	return invocation
}

func TestArtifactExecutorLeavesUnprojectedStageWithoutSharedProjections(t *testing.T) {
	installRoot := filepath.Join(t.TempDir(), "install")
	stage := filepath.Join(t.TempDir(), "stage")
	if err := os.MkdirAll(stage, 0o700); err != nil {
		t.Fatal(err)
	}
	layout, err := versionroot.New(installRoot)
	if err != nil {
		t.Fatal(err)
	}
	fixtures := map[string][]byte{"binary": []byte("binary fixture"), "package": testPackageTarball("@kb-labs/fixture", "1.0.0")}
	digests := make(map[string]string, len(fixtures))
	for name, data := range fixtures {
		digest := sha256.Sum256(data)
		digests[name] = hex.EncodeToString(digest[:])
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		name := strings.TrimPrefix(request.URL.Path, "/")
		data, ok := fixtures[name]
		if !ok {
			http.NotFound(writer, request)
			return
		}
		_, _ = writer.Write(data)
	}))
	defer server.Close()
	executor, err := newArtifactExecutor(layout, stage, "", false, io.Discard,
		productionPackageFixtureRunner{})
	if err != nil {
		t.Fatal(err)
	}
	items := []contracts.Artifact{
		{ID: "fixture-binary", Kind: "binary", Version: "1.0.0", URL: server.URL + "/binary", SHA256: digests["binary"], Target: "bin/kb-create"},
		{ID: "fixture-package", Kind: "plugin", Version: "1.0.0", Package: "@kb-labs/fixture", Tarball: server.URL + "/package", SHA256: digests["package"], Provenance: fixturePackageProvenance(t, "@kb-labs/fixture", "1.0.0")},
	}
	if err := executor.InstallWithProgress(items, func(_ string, start bool) error {
		if start {
			return nil
		}
		return versionroot.ValidateNoSharedRuntimeProjectionEntries(stage)
	}); err != nil {
		t.Fatalf("production artifact executor install: %v", err)
	}
	if err := versionroot.ValidateNoSharedRuntimeProjectionEntries(stage); err != nil {
		t.Fatalf("artifact executor created a shared projection in its unprojected stage: %v", err)
	}
	cacheRoot, err := layout.SharedRuntimePath(".kb/v2/cache")
	if err != nil {
		t.Fatal(err)
	}
	for name, digest := range digests {
		cachePath := filepath.Join(cacheRoot, map[string]string{"binary": "binaries/" + digest, "package": "packages/" + digest + ".tgz"}[name])
		if _, err := os.Stat(cachePath); err != nil {
			t.Errorf("%s artifact was not fetched into the install-root cache: %v", name, err)
		}
	}
}

func TestUpdateActivationRetryHintPreservesOriginalInvocation(t *testing.T) {
	for _, includePlatformRoot := range []bool{false, true} {
		name := "default root"
		if includePlatformRoot {
			name = "selected root"
		}
		t.Run(name, func(t *testing.T) {
			selectedRoot := filepath.Join(t.TempDir(), "platform root")
			index := filepath.Join(t.TempDir(), "release index.json")
			request := filepath.Join(t.TempDir(), "install request.json")
			secret := `{"adminPassword":"do-not-print"}`
			root := &cobra.Command{Use: "kb-create"}
			command := &cobra.Command{Use: "update"}
			root.AddCommand(command)
			registerPersistentFlags(root)
			values := make(map[string]any)
			descriptor, ok := lookupOperationDescriptor("update")
			if !ok {
				t.Fatal("update command descriptor is not registered")
			}
			registerLocalFlags(command, descriptor.Flags, values)
			args := []string{"--index", index, "--input", request}
			want := []string{"kb-create", "update", "--index", index, "--input", request}
			if includePlatformRoot {
				args = append(args, "--platform-root", selectedRoot)
				want = append(want, "--platform-root", selectedRoot)
			}
			args = append(args, "--scenario-answers", secret)
			if err := command.ParseFlags(args); err != nil {
				t.Fatal(err)
			}
			flags := newCommandFlagReader(command, values)
			invocation, err := flags.Invocation()
			if err != nil {
				t.Fatal(err)
			}
			hint := updateActivationRetryHint(updateCommandInput{RetryCommand: invocation})
			commandText := quotedCommandFromHint(t, hint)
			process := exec.Command("sh", "-c", "set -- "+commandText+"; printf '%s\\0' \"$@\"")
			output, err := process.Output()
			if err != nil {
				t.Fatalf("parse retry command with sh: %v", err)
			}
			parsed := strings.Split(strings.TrimSuffix(string(output), "\x00"), "\x00")
			if !reflect.DeepEqual(parsed, want) {
				t.Fatalf("retry argv = %#v, want %#v", parsed, want)
			}
			if strings.Contains(invocation, secret) {
				t.Fatal("retry invocation exposed a value declared secret")
			}
		})
	}
}

type productionPackageFixtureRunner struct {
	injectProjection bool
}

func (r productionPackageFixtureRunner) Run(ctx context.Context, output io.Writer, name string, args ...string) error {
	if err := (artifacts.CommandRunner{}).Run(ctx, output, name, args...); err != nil {
		return err
	}
	root := ""
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--dir" {
			root = args[i+1]
			break
		}
	}
	if root == "" {
		return fmt.Errorf("pnpm fixture did not receive --dir")
	}
	if r.injectProjection {
		projection := filepath.Join(root, ".kb", "v2", "cache")
		if err := os.MkdirAll(projection, 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(projection, "injected"), []byte("fault"), 0o600); err != nil {
			return err
		}
	}
	return nil
}

func assertContainerParent(t *testing.T, parent string) {
	t.Helper()
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 1 || entries[0].Name() != "install" {
		t.Fatalf("install parent entries = %#v, %v; want only install root", entries, err)
	}
}

// case: S-023.12
func TestUpdateFailureLeavesReceiptRootHostAndShimUnchanged(t *testing.T) {
	inst := newInstallation(t)
	if _, code, raw := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start: %s", raw)
	}
	installer := &recordingInstaller{failure: errors.New("injected package write failure")}
	stateBefore := snapshotStateTree(t, filepath.Join(inst.root, "state"))
	layout, err := versionroot.New(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	oldRoot, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	oldLockPath := filepath.Join(oldRoot, ".kb", "marketplace.lock")
	if _, err := os.Stat(oldLockPath); !os.IsNotExist(err) {
		t.Fatalf("fixture unexpectedly contains a marketplace lock: %v", err)
	}
	receiptBefore, err := os.ReadFile(receipt.Path(platformRootForTest(t, inst.root)))
	if err != nil {
		t.Fatal(err)
	}
	rootInfoBefore, err := os.Lstat(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	state, err := host.StateForRoot(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	pidBefore, err := os.ReadFile(state.HostPID())
	if err != nil {
		t.Fatal(err)
	}
	activeRoot := filepath.Join(inst.root, "current")
	cliEntry := filepath.Join(platformRootForTest(t, inst.root), "node_modules", "@kb-labs", "cli-bin", "dist", "bin.js")
	if err := os.MkdirAll(filepath.Dir(cliEntry), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cliEntry, []byte("export {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := shim.Ensure(inst.launcher, activeRoot); err != nil {
		t.Fatal(err)
	}
	shimPath := shim.Path(inst.launcher)
	shimBefore, shimErr := os.Readlink(shimPath)
	shimTargetBefore, err := os.ReadFile(shim.Target(activeRoot))
	if err != nil {
		t.Fatal(err)
	}
	shimInfoBefore, err := os.Lstat(shim.Target(activeRoot))
	if err != nil {
		t.Fatal(err)
	}
	layout, err = versionroot.New(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	activeBefore, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	activeInfoBefore, err := os.Lstat(activeBefore)
	if err != nil {
		t.Fatal(err)
	}
	currentLinkBefore, err := os.Readlink(layout.PlatformRoot())
	if err != nil {
		t.Fatal(err)
	}
	activeTreeBefore, err := treeDigest(activeBefore)
	if err != nil {
		t.Fatal(err)
	}
	payload, code, raw := inst.update(t, updatePlan(t, inst.root, freeLoopbackPort(t)), installer)
	if code == 0 || payload["ok"] != false {
		t.Fatalf("update unexpectedly succeeded: %s", raw)
	}
	if after := snapshotStateTree(t, filepath.Join(inst.root, "state")); !reflect.DeepEqual(after, stateBefore) {
		t.Fatalf("shared state changed during failed staged update:\nbefore=%#v\nafter=%#v", stateBefore, after)
	}
	if _, err := os.Stat(oldLockPath); !os.IsNotExist(err) {
		t.Fatalf("failed update created a marketplace lock in the still-running old host root: %v", err)
	}
	receiptAfter, err := os.ReadFile(receipt.Path(platformRootForTest(t, inst.root)))
	if err != nil || string(receiptAfter) != string(receiptBefore) {
		t.Fatalf("receipt changed: %v", err)
	}
	rootInfoAfter, err := os.Lstat(inst.root)
	if err != nil || !os.SameFile(rootInfoBefore, rootInfoAfter) {
		t.Fatalf("active root identity changed: %v", err)
	}
	activeAfter, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	activeInfoAfter, err := os.Lstat(activeAfter)
	if err != nil || !os.SameFile(activeInfoBefore, activeInfoAfter) {
		t.Fatalf("active version root identity changed: %v", err)
	}
	currentLinkAfter, err := os.Readlink(layout.PlatformRoot())
	if err != nil || currentLinkAfter != currentLinkBefore {
		t.Fatalf("current link changed before update activation: %q %v", currentLinkAfter, err)
	}
	versionRoots, err := os.ReadDir(layout.VersionsDir())
	if err != nil || len(versionRoots) != 1 || versionRoots[0].Name() != filepath.Base(activeBefore) {
		t.Fatalf("failed staged update left version roots %#v, %v; want only active version %q", versionRoots, err, filepath.Base(activeBefore))
	}
	activeTreeAfter, err := treeDigest(activeAfter)
	if err != nil || activeTreeAfter != activeTreeBefore {
		t.Fatalf("active root bytes changed: %v", err)
	}
	pidAfter, err := os.ReadFile(state.HostPID())
	if err != nil || string(pidAfter) != string(pidBefore) {
		t.Fatalf("running host identity changed: %v", err)
	}
	shimAfter, shimAfterErr := os.Readlink(shimPath)
	if shimErr != nil {
		if shimAfterErr == nil {
			t.Fatalf("shim appeared before switch: %s", shimAfter)
		}
	} else if shimAfterErr != nil || shimAfter != shimBefore {
		t.Fatalf("shim changed: %s, %v", shimAfter, shimAfterErr)
	}
	shimTargetAfter, err := os.ReadFile(shim.Target(activeRoot))
	if err != nil || string(shimTargetAfter) != string(shimTargetBefore) {
		t.Fatalf("shim target bytes changed: %v", err)
	}
	shimInfoAfter, err := os.Lstat(shim.Target(activeRoot))
	if err != nil || !os.SameFile(shimInfoBefore, shimInfoAfter) {
		t.Fatalf("shim target identity changed: %v", err)
	}
}

func TestUpdatePreparationFailureLeavesPreviousVersionActive(t *testing.T) {
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
	receiptBefore, err := os.ReadFile(receipt.Path(layout.PlatformRoot()))
	if err != nil {
		t.Fatal(err)
	}
	stateBefore := snapshotStateTree(t, filepath.Join(inst.root, "state"))
	hostState, err := host.StateForRoot(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	processIdentityBefore, err := os.ReadFile(hostState.HostPID())
	if err != nil {
		t.Fatal(err)
	}
	currentBefore, err := os.Readlink(layout.PlatformRoot())
	if err != nil {
		t.Fatal(err)
	}

	launcherState := t.TempDir()
	if err := os.Mkdir(filepath.Join(launcherState, "gateway-roots.json"), 0o700); err != nil {
		t.Fatal(err)
	}
	plan := updatePlan(t, inst.root, freeLoopbackPort(t))
	_, failure := runUpdateCommand(context.Background(), updateCommandInput{Executable: inst.launcher}, inst.root, plan,
		hostState, host.State{Dir: launcherState}, &runtime.Dependencies{Artifacts: &recordingInstaller{}})
	if failure == nil {
		t.Fatal("update unexpectedly succeeded despite an unwriteable Gateway registry")
	}
	if got, err := os.ReadFile(receipt.Path(layout.PlatformRoot())); err != nil || string(got) != string(receiptBefore) {
		t.Fatalf("failed update changed active receipt: %v", err)
	}
	if got, err := os.Readlink(layout.PlatformRoot()); err != nil || got != currentBefore {
		t.Fatalf("failed update changed current link to %q: %v", got, err)
	}
	if after := snapshotStateTree(t, filepath.Join(inst.root, "state")); !reflect.DeepEqual(after, stateBefore) {
		t.Fatalf("failed update changed shared state: before=%#v after=%#v", stateBefore, after)
	}
	processIdentityAfter, err := os.ReadFile(hostState.HostPID())
	if err != nil || string(processIdentityAfter) != string(processIdentityBefore) {
		t.Fatalf("failed update changed the still-running N host identity: %v", err)
	}
	runner, err := host.NewRunner(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	statusCtx, cancelStatus := context.WithTimeout(context.Background(), 5*time.Second)
	status, err := runner.Status(statusCtx)
	cancelStatus()
	if err != nil || status.State != "running" || !status.Healthy {
		t.Fatalf("failed update left N host status %#v, %v; want running and healthy", status, err)
	}
	activeAfter, err := layout.Active()
	if err != nil || activeAfter != activeRoot {
		t.Fatalf("failed update left active root %q, want N root %q: %v", activeAfter, activeRoot, err)
	}
	versions, err := os.ReadDir(layout.VersionsDir())
	if err != nil || len(versions) != 1 || versions[0].Name() != filepath.Base(activeRoot) {
		t.Fatalf("failed update left versions %#v, %v; want only N %q", versions, err, filepath.Base(activeRoot))
	}
}

func TestUpdateActivationFailureRestoresGatewayRegistryAndActiveIdentity(t *testing.T) {
	inst := newInstallation(t)
	layout, err := versionroot.New(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	activeBefore, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	receiptBefore, err := os.ReadFile(receipt.Path(activeBefore))
	if err != nil {
		t.Fatal(err)
	}
	activeReceipt, err := receipt.Read(activeBefore)
	if err != nil {
		t.Fatal(err)
	}
	origin, err := gateway.OriginFromHealthURL(activeReceipt.Plan.Host.HealthURL)
	if err != nil {
		t.Fatal(err)
	}
	registryPath := filepath.Join(inst.state, "gateway-roots.json")
	registry := gateway.Registry{Path: registryPath, OperationRoot: inst.root}
	if err := registry.Register(inst.root, origin); err != nil {
		t.Fatal(err)
	}
	registryBefore, err := os.ReadFile(registryPath)
	if err != nil {
		t.Fatal(err)
	}
	plan := updatePlan(t, inst.root, freeLoopbackPort(t))
	hash := sha256.Sum256([]byte(plan.PlanHash))
	target := filepath.Join(layout.VersionsDir(), "2.0.0-"+hex.EncodeToString(hash[:8]))
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "collision"), []byte("not a sealed root"), 0o600); err != nil {
		t.Fatal(err)
	}
	state, err := host.StateForRoot(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	_, failure := runUpdateCommand(context.Background(), updateCommandInput{Executable: inst.launcher}, inst.root, plan,
		state, host.State{Dir: inst.state}, &runtime.Dependencies{Artifacts: &recordingInstaller{}})
	if failure == nil {
		t.Fatal("update unexpectedly succeeded despite activation target collision")
	}
	registryAfter, err := os.ReadFile(registryPath)
	if err != nil || !bytes.Equal(registryAfter, registryBefore) {
		t.Fatalf("failed update changed Gateway registry bytes: before=%q after=%q error=%v", registryBefore, registryAfter, err)
	}
	activeAfter, err := layout.Active()
	if err != nil || activeAfter != activeBefore {
		t.Fatalf("failed update active root = %q, %v; want N %q", activeAfter, err, activeBefore)
	}
	receiptAfter, err := os.ReadFile(receipt.Path(activeAfter))
	if err != nil || !bytes.Equal(receiptAfter, receiptBefore) {
		t.Fatalf("failed update changed active N receipt bytes: %v", err)
	}
}

func TestUpdateCommandKeepsStoppedHostStoppedWithoutPendingRestart(t *testing.T) {
	inst := newInstallation(t)
	installer := &recordingInstaller{}

	payload, code, raw := inst.update(t, updatePlan(t, inst.root, freeLoopbackPort(t)), installer)
	if code != 0 || payload["ok"] != true || payload["hostRestarted"] != false {
		t.Fatalf("update: %d %s", code, raw)
	}
	if state, _ := inst.hostState(t); state != "stopped" {
		t.Fatalf("a stopped host must stay stopped, state = %s", state)
	}
	if _, exists := payload["pendingRestart"]; exists {
		t.Fatalf("stopped host update reported pendingRestart: %#v", payload["pendingRestart"])
	}
	if _, err := receipt.Read(platformRootForTest(t, inst.root)); err != nil {
		t.Fatal(err)
	}
}

func TestRepeatedUpdatesRetainLastHealthyRootUntilRestartHealthPasses(t *testing.T) {
	inst := newInstallation(t)
	active, err := receipt.Read(platformRootForTest(t, inst.root))
	if err != nil {
		t.Fatal(err)
	}
	active.ID = "receipt-v1"
	active.Plan.ServiceGraph.PlatformVersion = "1.0.0"
	active.Plan.ServiceGraph.Services = []contracts.Service{{ID: "gateway"}}
	if err := receipt.Write(platformRootForTest(t, inst.root), active); err != nil {
		t.Fatal(err)
	}
	if _, code, raw := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start v1: %d %s", code, raw)
	}
	layout, err := versionroot.New(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	v2 := updatePlan(t, inst.root, inst.port)
	v2.ServiceGraph.PlatformVersion, v2.PlanHash = "2.0.0", "plan-v2"
	if _, code, raw := inst.update(t, v2, &recordingInstaller{}); code != 0 {
		t.Fatalf("update v2: %d %s", code, raw)
	}
	v2Root, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	v3 := updatePlan(t, inst.root, inst.port, "-exit", "5")
	v3.ServiceGraph.PlatformVersion, v3.PlanHash = "3.0.0", "plan-v3-unhealthy"
	if _, code, raw := inst.update(t, v3, &recordingInstaller{}); code != 0 {
		t.Fatalf("update v3: %d %s", code, raw)
	}
	v3Root, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(v2Root); !os.IsNotExist(err) {
		t.Fatalf("never-started v2 root was not pruned: %v", err)
	}
	if _, err := os.Stat(v3Root); err != nil {
		t.Fatalf("active v3 root is missing: %v", err)
	}
	if state, _ := inst.hostState(t); state != host.StateRunning {
		t.Fatalf("v1 host stopped during repeated updates: %s", state)
	}
	recovery, err := layout.RecoveryRoot()
	if err != nil || recovery == v3Root {
		t.Fatalf("recovery root = %s, %v", recovery, err)
	}
	if restored, err := receipt.Read(recovery); err != nil || restored.Plan.ServiceGraph.PlatformVersion != "1.0.0" {
		t.Fatalf("last healthy recovery receipt = %#v, %v", restored, err)
	}
	if _, code, raw := inst.run("restart", "--json"); code != 1 || errorCodeFromOutput(raw) != contracts.CodeUpdateHostNotHealthy {
		t.Fatalf("unhealthy v3 restart did not recover: %d %s", code, raw)
	}
	if status, code, raw := inst.run("status", "--json"); code != 0 || status["runningVersion"] != "1.0.0" {
		t.Fatalf("host did not return to healthy v1: %d %s", code, raw)
	}
	healthyV3 := updatePlan(t, inst.root, inst.port)
	healthyV3.ServiceGraph.PlatformVersion, healthyV3.PlanHash = "3.0.0", "plan-v3-healthy"
	if _, code, raw := inst.update(t, healthyV3, &recordingInstaller{}); code != 0 {
		t.Fatalf("healthy v3 update: %d %s", code, raw)
	}
	if _, code, raw := inst.run("restart", "--json"); code != 0 {
		t.Fatalf("healthy v3 restart: %d %s", code, raw)
	}
	if _, err := os.Stat(recovery); !os.IsNotExist(err) {
		t.Fatalf("old last-healthy root survived successful v3 health check: %v", err)
	}
}

func errorCodeFromOutput(raw string) string {
	var payload map[string]any
	if json.Unmarshal([]byte(raw), &payload) != nil {
		return ""
	}
	return errorCode(payload)
}

// case: S-024.6
func TestRestartFailureRestoresPreviousVersionAndReportsRecoveryDetails(t *testing.T) {
	inst := newInstallation(t)
	active, err := receipt.Read(platformRootForTest(t, inst.root))
	if err != nil {
		t.Fatal(err)
	}
	active.ID = "receipt-v1"
	active.Plan.ServiceGraph.PlatformVersion = "1.0.0"
	active.Plan.ServiceGraph.Services = []contracts.Service{{ID: "gateway"}}
	if err := receipt.Write(platformRootForTest(t, inst.root), active); err != nil {
		t.Fatal(err)
	}
	if _, code, raw := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start old host: %d %s", code, raw)
	}

	badPlan := updatePlan(t, inst.root, freeLoopbackPort(t), "-exit", "5")
	badPlan.ServiceGraph.PlatformVersion = "2.0.0"
	badPlan.ServiceGraph.Services = []contracts.Service{{ID: "gateway"}}
	badPlan.PlanHash = "failed-restart-plan"
	layout, err := versionroot.New(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	stage, err := layout.Stage()
	if err != nil {
		t.Fatal(err)
	}
	failed := contracts.InstallReceipt{ID: "receipt-v2", SnapshotID: "snapshot-before-v2", InstallationID: active.InstallationID,
		Plan: badPlan, Verification: contracts.Verification{HostHealthURL: badPlan.Host.HealthURL}}
	if err := receipt.Write(stage, failed); err != nil {
		t.Fatal(err)
	}
	logRelative := filepath.Join("installer", "logs", "restart-update.log")
	if err := os.MkdirAll(layout.OperationLogsDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inst.root, logRelative), []byte("update completed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := layout.ActivateUpdate(stage, "2.0.0", badPlan.PlanHash, "",
		versionroot.UpdateMetadata{SnapshotID: "snapshot-before-v2", LogPath: logRelative}); err != nil {
		t.Fatal(err)
	}

	payload, code, raw := inst.run("restart", "--json")
	if code != 1 || errorCode(payload) != contracts.CodeUpdateHostNotHealthy {
		t.Fatalf("restart: %d %s", code, raw)
	}
	details, _ := payload["error"].(map[string]any)["details"].(map[string]any)
	if details["snapshotId"] != "snapshot-before-v2" || details["logPath"] == "" {
		t.Fatalf("recovery details = %#v", details)
	}
	restored, err := receipt.Read(platformRootForTest(t, inst.root))
	if err != nil || restored.ID != "receipt-v1" {
		t.Fatalf("restored receipt = %#v, %v", restored, err)
	}
	status, statusCode, statusRaw := inst.run("status", "--json")
	if statusCode != 0 || status["running"] != true || status["runningVersion"] != "1.0.0" || status["pendingRestart"] != nil {
		t.Fatalf("status after automatic restore: %d %s", statusCode, statusRaw)
	}
}

// case: S-223.2
func TestRestartRecoveryDirectCallerReturnsSameCataloguedResult(t *testing.T) {
	inst := newInstallation(t)
	active, err := receipt.Read(platformRootForTest(t, inst.root))
	if err != nil {
		t.Fatal(err)
	}
	active.ID = "receipt-v1"
	active.Plan.ServiceGraph.PlatformVersion = "1.0.0"
	active.Plan.ServiceGraph.Services = []contracts.Service{{ID: "gateway"}}
	if err := receipt.Write(platformRootForTest(t, inst.root), active); err != nil {
		t.Fatal(err)
	}
	layout, err := versionroot.New(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	if err := layout.RecordHealthy(); err != nil {
		t.Fatal(err)
	}
	badPlan := updatePlan(t, inst.root, inst.port, "-exit", "5")
	badPlan.ServiceGraph.PlatformVersion, badPlan.PlanHash = "2.0.0", "direct-unhealthy-v2"
	stage, err := layout.Stage()
	if err != nil {
		t.Fatal(err)
	}
	installed := contracts.InstallReceipt{ID: "receipt-v2", SnapshotID: "snapshot-direct-v2", InstallationID: active.InstallationID,
		Plan: badPlan, Verification: contracts.Verification{HostHealthURL: badPlan.Host.HealthURL}}
	if err := receipt.Write(stage, installed); err != nil {
		t.Fatal(err)
	}
	if _, err := layout.ActivateUpdate(stage, "2.0.0", badPlan.PlanHash, "",
		versionroot.UpdateMetadata{SnapshotID: "snapshot-direct-v2"}); err != nil {
		t.Fatal(err)
	}
	previous, err := host.NewRunner(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	outcome, restartErr := host.RestartWithRecovery(context.Background(), inst.root, previous,
		func(ctx context.Context, current *host.ProcessRunner) (host.Info, error) { return current.Start(ctx) })
	if outcome.Runner != nil {
		t.Cleanup(func() { _, _ = outcome.Runner.Stop(context.Background()) })
	}
	var failure *diag.Diag
	if !errors.As(restartErr, &failure) || failure.Code != contracts.CodeUpdateHostNotHealthy {
		t.Fatalf("direct restart error = %#v, want catalogued unhealthy-update error", restartErr)
	}
	if failure.Meta["recoveryStage"] != "restored-last-healthy" || failure.Meta["nextCommand"] == "" ||
		outcome.Runner == nil || outcome.Runner.Identity.PlatformVersion != "1.0.0" {
		t.Fatalf("direct restart recovery = outcome %#v, diagnostic %#v", outcome, failure.Meta)
	}
}

func restartWithRecoveryFault(t *testing.T, fault string) (installation, string) {
	t.Helper()
	inst := newInstallation(t)
	active, err := receipt.Read(platformRootForTest(t, inst.root))
	if err != nil {
		t.Fatal(err)
	}
	active.ID = "receipt-v1"
	active.Plan.ServiceGraph.PlatformVersion = "1.0.0"
	active.Plan.ServiceGraph.Services = []contracts.Service{{ID: "gateway"}}
	if err := receipt.Write(platformRootForTest(t, inst.root), active); err != nil {
		t.Fatal(err)
	}
	if _, code, raw := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start v1: %d %s", code, raw)
	}
	layout, err := versionroot.New(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	badPlan := updatePlan(t, inst.root, inst.port, "-exit", "5")
	badPlan.ServiceGraph.PlatformVersion, badPlan.PlanHash = "2.0.0", "unhealthy-v2"
	stage, err := layout.Stage()
	if err != nil {
		t.Fatal(err)
	}
	installed := contracts.InstallReceipt{ID: "receipt-v2", SnapshotID: "snapshot-v2", InstallationID: active.InstallationID,
		Plan: badPlan, Verification: contracts.Verification{HostHealthURL: badPlan.Host.HealthURL}}
	if err := receipt.Write(stage, installed); err != nil {
		t.Fatal(err)
	}
	if _, err := layout.ActivateUpdate(stage, "2.0.0", badPlan.PlanHash, "",
		versionroot.UpdateMetadata{SnapshotID: "snapshot-v2"}); err != nil {
		t.Fatal(err)
	}
	recovery, err := layout.RecoveryRoot()
	if err != nil {
		t.Fatal(err)
	}
	switch fault {
	case "restore":
		if err := os.Remove(receipt.Path(recovery)); err != nil {
			t.Fatal(err)
		}
	case "restored-start":
		old, err := receipt.Read(recovery)
		if err != nil {
			t.Fatal(err)
		}
		old.Plan.Host.Args = []string{"-exit", "5"}
		if err := receipt.Write(recovery, old); err != nil {
			t.Fatal(err)
		}
	case "metadata":
		path := filepath.Join(layout.InstallerStateDir(), "update-operation.json")
		if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
			t.Fatal(err)
		}
	default:
		t.Fatalf("unknown recovery fault %q", fault)
	}
	return inst, recovery
}

// case: S-223.2
func TestRestartRecoveryFailuresReturnCataloguedUpdateError(t *testing.T) {
	for _, test := range []struct {
		name  string
		stage string
	}{
		{name: "restore failed", stage: "restore last healthy root"},
		{name: "restored host failed to start", stage: "start restored host"},
		{name: "update metadata unreadable", stage: "read update recovery metadata"},
	} {
		t.Run(test.name, func(t *testing.T) {
			fault := map[string]string{
				"restore failed":                "restore",
				"restored host failed to start": "restored-start",
				"update metadata unreadable":    "metadata",
			}[test.name]
			inst, _ := restartWithRecoveryFault(t, fault)
			payload, code, raw := inst.run("restart", "--json")
			if code != 1 || errorCode(payload) != contracts.CodeUpdateHostNotHealthy {
				t.Fatalf("restart recovery error = %d %s", code, raw)
			}
			details, ok := payload["error"].(map[string]any)["details"].(map[string]any)
			if !ok || details["recoveryStage"] != test.stage || details["nextCommand"] == "" || details["failureReason"] == "" {
				t.Fatalf("restart recovery details = %#v", details)
			}
			if strings.Contains(raw, "errors.Join") || strings.Contains(raw, "\n\t") {
				t.Fatalf("human-facing restart output exposed joined/raw error text: %s", raw)
			}
		})
	}
}

func TestUpdateCommandNeedsAnInstallation(t *testing.T) {
	inst := newInstallation(t)
	if err := os.Remove(receipt.Path(platformRootForTest(t, inst.root))); err != nil {
		t.Fatal(err)
	}
	before, err := treeDigest(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	payload, code, raw := inst.update(t, updatePlan(t, inst.root, freeLoopbackPort(t)), &recordingInstaller{})
	if code != 1 || errorCode(payload) != contracts.CodeReceiptUnavailable {
		t.Fatalf("update: %d %s", code, raw)
	}
	after, err := treeDigest(inst.root)
	if err != nil || before != after {
		t.Fatalf("update without an active receipt changed install-root bytes: err=%v", err)
	}
}

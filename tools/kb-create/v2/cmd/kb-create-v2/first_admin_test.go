package v2cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	clikitcommand "github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	clikitresult "github.com/kb-labs/clikit/result"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/gateway"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/internal/testfixtures"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/shim"
	"github.com/kb-labs/create/v2/versionroot"
	"github.com/spf13/cobra"
)

// case: S-100.1
func TestFirstAdminCredentialIsShownOnceAndNeverPersisted(t *testing.T) {
	const password = "generated-password-that-must-not-leak"
	credential := firstAdminCredential{State: firstAdminDisclosed, Email: "admin@example.test", Password: password}
	result := applyCommandResult{
		OK: true, Operation: "install", Receipt: contracts.InstallReceipt{
			Plan: contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{Values: map[string]string{
				"gateway.access.mode": `"secured"`, "gateway.bootstrap.adminEmail": `"admin@example.test"`,
			}}},
		}, FirstAdmin: &credential,
	}
	jsonOutput, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(jsonOutput, &decoded); err != nil {
		t.Fatal(err)
	}
	admin, ok := decoded["firstAdmin"].(map[string]any)
	if !ok || admin["state"] != string(firstAdminDisclosed) || admin["email"] != credential.Email || admin["password"] != password {
		t.Fatalf("explicit one-time credential result = %#v", decoded["firstAdmin"])
	}

	human := renderApply(result)
	if strings.Count(human, password) != 1 || strings.Count(human, credential.Email) != 1 {
		t.Fatal("human output did not show the credential exactly once")
	}
}

func TestCompletedUndisclosedBootstrapReturnsStoredPasswordWithoutRecordingDisclosure(t *testing.T) {
	root := t.TempDir()
	store := secrets.Store{PlatformRoot: root}
	if err := store.PutBootstrapPassword("stored-bootstrap-password", secrets.BootstrapOriginGenerated); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkBootstrapCompleted("provisioned"); err != nil {
		t.Fatal(err)
	}

	credential, failure := firstAdminResult(store, "admin@example.test", "<platform-root>")
	if failure != nil || credential == nil || credential.State != firstAdminDisclosed || credential.Password != "stored-bootstrap-password" {
		t.Fatalf("completed bootstrap disclosure did not return the stored credential result; failure=%v", failure)
	}
	if disclosed, err := store.BootstrapDisclosed(); err != nil || disclosed {
		t.Fatalf("result construction recorded disclosure marker = %v, err %v; want the output writer to own it", disclosed, err)
	}
}

// case: S-100.1
func TestSuppliedFirstAdminPasswordIsNamedWithoutReturningValue(t *testing.T) {
	root := t.TempDir()
	store := secrets.Store{PlatformRoot: root}
	if err := store.Put(secrets.BootstrapPassword, "operator-supplied-bootstrap-secret"); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkBootstrapCompleted("provisioned"); err != nil {
		t.Fatal(err)
	}

	admin, failure := firstAdminResult(store, "admin@example.test", root)
	if failure != nil || admin == nil || admin.State != firstAdminSupplied || admin.Email != "admin@example.test" || admin.Password != "" {
		t.Fatalf("supplied first-admin result has incorrect state or fields; failure=%v", failure)
	}
	result, err := json.Marshal(applyCommandResult{FirstAdmin: admin})
	if err != nil {
		t.Fatal(err)
	}
	human := renderApply(applyCommandResult{FirstAdmin: admin})
	for _, output := range []string{string(result), human} {
		if strings.Contains(output, "operator-supplied-bootstrap-secret") || strings.Contains(output, "KB_TEST_SUPPLIED_BOOTSTRAP_PASSWORD") {
			t.Fatal("supplied first-admin result exposed secret material")
		}
	}
	if !strings.Contains(string(result), `"state":"supplied"`) || !strings.Contains(string(result), "admin@example.test") || strings.Contains(string(result), `"password"`) {
		t.Fatal("supplied first-admin result did not report the supplied state without a password field")
	}
	value := applyCommandResult{FirstAdmin: admin, disclosureStoreRoot: root,
		Receipt: contracts.InstallReceipt{Plan: contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{PlatformRoot: root}}}}
	var emitted bytes.Buffer
	if written, failure := emitFirstAdminResult(value, "apply", func() error {
		_, err := emitted.Write(result)
		return err
	}); !written || failure != nil {
		t.Fatal("supplied first-admin result was not emitted and erased")
	}
	assertSecretsAbsentFromTrees(t, []string{"operator-supplied-bootstrap-secret", "KB_TEST_SUPPLIED_BOOTSTRAP_PASSWORD"}, root)
}

func TestSecretRedactionsCoverResolvedValuesAndSourceNames(t *testing.T) {
	store := secrets.Store{PlatformRoot: t.TempDir()}
	if err := store.Put("adapter.llm.apiKey", "stored-test-secret"); err != nil {
		t.Fatal(err)
	}
	plan := contracts.ResolvedInstallPlan{Artifacts: []contracts.Artifact{{Config: []contracts.ConfigRequirement{{
		ID: "adapter.llm.apiKey", Secret: true, Env: "LLM_API_KEY",
	}}}}}
	redactions, err := secretRedactionValues(store, plan, "adapter.llm.apiKey=OPERATOR_SECRET_NAME")
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"adapter.llm.apiKey", "stored-test-secret", "LLM_API_KEY", "OPERATOR_SECRET_NAME"} {
		if !slices.Contains(redactions, expected) {
			t.Fatal("redaction values omitted a secret reference field")
		}
	}
}

// case: S-100.1, S-181.3
func TestExecuteSuppliedBootstrapPasswordNeverSerializesValueOrEnvironmentName(t *testing.T) {
	const password = "operator-supplied-bootstrap-secret"
	const environment = "KB_TEST_SUPPLIED_BOOTSTRAP_PASSWORD"
	for _, test := range []struct {
		name    string
		command string
		json    bool
	}{
		{name: "apply JSON", command: "apply", json: true},
		{name: "apply human", command: "apply"},
		{name: "install JSON", command: "install", json: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("KB_HOME", "")
			t.Setenv(environment, password)
			realRoot := filepath.Join(home, "real")
			if err := os.Mkdir(realRoot, 0o700); err != nil {
				t.Fatal(err)
			}
			link := filepath.Join(home, "linked")
			if err := os.Symlink(realRoot, link); err != nil {
				t.Fatal(err)
			}
			root := filepath.Join(link, "platform")
			stateHome, err := host.StateHome(root)
			if err != nil {
				t.Fatal(err)
			}
			inside, err := contracts.PathWithin(root, stateHome.Dir)
			if err != nil || !inside {
				t.Fatalf("state home is outside install root: %q: %v", stateHome.Dir, err)
			}
			port := freeAllocatedGatewayPortWithOffsets(t, 0)
			source := testReleaseCatalog(t, "2.0.0")
			source.Platforms[0].Host = &contracts.HostSpec{Command: "kb-host", HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 5}
			source.Platforms[0].Profiles = map[string]contracts.ServiceGraph{"default": {PlatformVersion: "2.0.0", Services: []contracts.Service{{ID: "gateway", Port: port}}}}
			source.Platforms[0].Config = []catalog.ConfigRequirement{
				{ID: "platform.adapterOptions", Path: "/platform/adapterOptions", Default: fmt.Sprintf(`{"serviceTransport":{"services":{"gateway":{"url":"http://127.0.0.1:%d"}}}}`, port)},
				{ID: "gateway.access.mode", Path: "/gateway/access/mode", Default: `"secured"`},
				{ID: "gateway.bootstrap.adminEmail", Path: "/gateway/bootstrap/adminEmail", Default: `"admin@example.test"`},
				{ID: "gateway.bootstrap.tenantId", Path: "/gateway/bootstrap/tenantId", Default: `"workspace"`},
				{ID: secrets.BootstrapPassword, Path: "/gateway/bootstrap/password", Required: true, Secret: true, Generate: true, Env: secrets.BootstrapPasswordEnvironment, Services: []string{"gateway"}},
				{ID: "gateway.jwtSecret", Path: "/gateway/jwtSecret", Required: true, Secret: true, Generate: true, Env: "GATEWAY_JWT_SECRET", Services: []string{"gateway"}},
			}
			release, err := sealTestCatalog(t, source)
			if err != nil {
				t.Fatal("seal release catalog")
			}
			indexPath := filepath.Join(home, "release-index.json")
			indexBytes, err := json.Marshal(release)
			if err != nil {
				t.Fatal("encode release catalog")
			}
			if err := os.WriteFile(indexPath, indexBytes, 0o600); err != nil {
				t.Fatal("write release catalog")
			}
			request := contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: root,
				Platform: contracts.VersionSelector{Channel: contracts.ChannelStable}, SDK: contracts.VersionSelector{Channel: contracts.ChannelStable}, ServiceProfile: "default",
				Values:       map[string]string{"gateway.access.mode": `"secured"`, "gateway.bootstrap.adminEmail": `"admin@example.test"`, "gateway.bootstrap.tenantId": `"workspace"`},
				SecretInputs: []string{secrets.BootstrapPassword, "gateway.jwtSecret"}}
			requestPath := filepath.Join(home, "request.json")
			requestBytes, err := json.Marshal(request)
			if err != nil {
				t.Fatal("encode install request")
			}
			if err := os.WriteFile(requestPath, requestBytes, 0o600); err != nil {
				t.Fatal("write install request")
			}
			starter := &bootstrapTestHost{address: fmt.Sprintf("127.0.0.1:%d", port)}
			t.Cleanup(func() {
				if starter.stop != nil {
					_ = starter.stop()
				}
			})
			factory := func(cmd *cobra.Command) commandDependencies {
				return commandDependencies{Command: cmd, NodeCheck: func() error { return nil }, ArtifactRunner: operationLogTestRunner{},
					Runtime: &runtime.Dependencies{Artifacts: installArtifacts{root: root, release: verifiedFixtureCatalog(t, release)}, Host: starter}}
			}
			args := []string{test.command, "--index", indexPath, "--input", requestPath, "--secret-env", secrets.BootstrapPassword + "=" + environment}
			if test.json {
				args = append(args, "--json")
			}
			var stdout, stderr bytes.Buffer
			if code := clikitcommand.Execute(newRootCommandWithDependencyFactory(factory), args, &stdout, &stderr).Code(); code != 0 {
				t.Fatalf("%s command failed with exit %d: stdout=%q stderr=%q", test.name, code, stdout.String(), stderr.String())
			}
			for _, output := range []string{stdout.String(), stderr.String()} {
				if strings.Contains(output, password) || strings.Contains(output, environment) {
					t.Fatal("command output exposed supplied secret material")
				}
			}
			if !strings.Contains(stdout.String(), "supplied") || strings.Contains(stdout.String(), `"password"`) {
				t.Fatal("command result did not report the supplied state without a password field")
			}
			assertSecretsAbsentFromTrees(t, []string{password, environment}, home)
			store := secrets.Store{PlatformRoot: filepath.Join(root, "current")}
			if present, err := store.Exists(secrets.BootstrapPassword); err != nil || present {
				t.Fatal("supplied bootstrap password remains in the secret store")
			}
			if starter.stop != nil {
				if err := starter.stop(); err != nil {
					t.Fatal("stop fake Gateway host")
				}
				starter.stop = nil
			}
			args = []string{test.command, "--index", indexPath, "--input", requestPath}
			if test.json {
				args = append(args, "--json")
			}
			stdout.Reset()
			stderr.Reset()
			if code := clikitcommand.Execute(newRootCommandWithDependencyFactory(factory), args, &stdout, &stderr).Code(); code != 0 {
				t.Fatalf("repeat %s command failed with exit %d", test.name, code)
			}
			if strings.Contains(stdout.String(), password) || strings.Contains(stdout.String(), environment) {
				t.Fatal("repeat command output exposed supplied secret material")
			}
			assertSecretsAbsentFromTrees(t, []string{password, environment}, home)
		})
	}
}

func TestCompletedBootstrapWithoutStoredPasswordReturnsRecoveryNotice(t *testing.T) {
	root := t.TempDir()
	store := secrets.Store{PlatformRoot: root}
	if err := store.PutBootstrapPassword("bootstrap-recovery-test-sentinel", secrets.BootstrapOriginGenerated); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkBootstrapCompleted("provisioned"); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkBootstrapDisclosed(); err != nil {
		t.Fatal(err)
	}
	admin, failure := firstAdminResult(store, "admin@example.test", root)
	if failure != nil || admin == nil || admin.State != firstAdminPreviouslyDisclosed || admin.Password != "" {
		t.Fatalf("completed bootstrap without stored password did not return a recovery notice; failure=%v", failure)
	}
	if !strings.Contains(admin.RecoveryCommand, firstAdminRecoveryCommand(root, "admin@example.test")) {
		t.Fatal("missing-password recovery notice omitted doctor command")
	}
}

// case: S-222.13
func TestExecuteRejectsUndeclaredAndLifecycleSecretIDsBeforeWriting(t *testing.T) {
	for _, test := range []struct {
		name, channel, id, command string
	}{
		{name: "provenance through environment mapping on install", channel: "secret-env", id: "gateway.bootstrap.generated", command: "install"},
		{name: "provenance through environment mapping on apply", channel: "secret-env", id: "gateway.bootstrap.generated", command: "apply"},
		{name: "provenance through environment mapping on update", channel: "secret-env", id: "gateway.bootstrap.generated", command: "update"},
		{name: "disclosure through environment mapping on install", channel: "secret-env", id: "gateway.bootstrap.disclosed", command: "install"},
		{name: "disclosure through environment mapping on apply", channel: "secret-env", id: "gateway.bootstrap.disclosed", command: "apply"},
		{name: "disclosure through environment mapping on update", channel: "secret-env", id: "gateway.bootstrap.disclosed", command: "update"},
		{name: "unknown environment mapping on install", channel: "secret-env", id: "operator.unknownSecret", command: "install"},
		{name: "unknown environment mapping on apply", channel: "secret-env", id: "operator.unknownSecret", command: "apply"},
		{name: "unknown environment mapping on update", channel: "secret-env", id: "operator.unknownSecret", command: "update"},
		{name: "unknown request input", channel: "input", id: "operator.unknownSecret", command: "apply"},
	} {
		t.Run(test.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			root := filepath.Join(home, "platform")
			const envName = "KB_TEST_INTERNAL_FACT_SENTINEL"
			const passwordEnv = "KB_TEST_SUPPLIED_BOOTSTRAP_SENTINEL"
			const value = "generated-test-secret-sentinel"
			t.Setenv(envName, value)
			t.Setenv(passwordEnv, value)
			source := testReleaseCatalog(t, "2.0.0")
			source.Platforms[0].Config = []catalog.ConfigRequirement{
				{ID: "gateway.access.mode", Path: "/gateway/access/mode", Default: `"secured"`},
				{ID: "gateway.bootstrap.adminEmail", Path: "/gateway/bootstrap/adminEmail", Default: `"admin@example.test"`},
				{ID: secrets.BootstrapPassword, Path: "/gateway/bootstrap/password", Secret: true, Generate: true, Env: secrets.BootstrapPasswordEnvironment, Services: []string{"gateway"}},
			}
			release, err := sealTestCatalog(t, source)
			if err != nil {
				t.Fatal("seal test release")
			}
			indexPath := filepath.Join(home, "release-index.json")
			indexBytes, err := json.Marshal(release)
			if err != nil {
				t.Fatal("encode test release")
			}
			if err := os.WriteFile(indexPath, indexBytes, 0o600); err != nil {
				t.Fatal("write test release")
			}
			request := contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: root,
				Platform: contracts.VersionSelector{Channel: contracts.ChannelStable}, SDK: contracts.VersionSelector{Channel: contracts.ChannelStable},
				ServiceProfile: "default", Values: map[string]string{"gateway.access.mode": `"secured"`, "gateway.bootstrap.adminEmail": `"admin@example.test"`}}
			if test.channel == "input" {
				request.SecretInputs = []string{test.id}
			}
			requestPath := filepath.Join(home, "request.json")
			requestBytes, err := json.Marshal(request)
			if err != nil {
				t.Fatal("encode test request")
			}
			if err := os.WriteFile(requestPath, requestBytes, 0o600); err != nil {
				t.Fatal("write test request")
			}
			args := []string{test.command, "--index", indexPath, "--input", requestPath, "--json"}
			if test.channel == "secret-env" {
				mapping := test.id + "=" + envName
				if test.id == "gateway.bootstrap.generated" || test.id == "gateway.bootstrap.disclosed" {
					mapping = secrets.BootstrapPassword + "=" + passwordEnv + "," + mapping
				}
				args = append(args, "--secret-env", mapping)
			}
			var stdout, stderr bytes.Buffer
			code := clikitcommand.Execute(newRootCommand(), args, &stdout, &stderr).Code()
			if code == 0 {
				t.Fatal("undeclared requirement was accepted")
			}
			output := stdout.String() + stderr.String()
			if !strings.Contains(output, contracts.CodeSecretInputInvalid) || !strings.Contains(output, test.id) {
				t.Fatal("refusal did not include the catalogued code and offending requirement ID")
			}
			if strings.Contains(output, value) || strings.Contains(output, envName) || strings.Contains(output, passwordEnv) {
				t.Fatal("refusal output exposed a secret value or environment-variable name")
			}
			if _, err := os.Stat(root); !os.IsNotExist(err) {
				t.Fatal("refused input wrote installation state")
			}
			assertSecretsAbsentFromTrees(t, []string{value, envName, passwordEnv}, home)
		})
	}
}

// case: S-222.13
func TestExecuteInteractiveInstallDoesNotPersistPromptSecretsBeforeMappingValidation(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := filepath.Join(home, "platform")
	project := filepath.Join(home, "project")
	if err := os.Mkdir(project, 0o700); err != nil {
		t.Fatal(err)
	}
	const value = "interactive-secret-test-sentinel"
	const passwordEnv = "KB_TEST_INTERACTIVE_PASSWORD"
	const markerEnv = "KB_TEST_INTERACTIVE_MARKER"
	t.Setenv(passwordEnv, value)
	t.Setenv(markerEnv, value)
	source := testReleaseCatalog(t, "2.0.0")
	source.Plugins = []catalog.Component{{ID: "@kb-labs/commit", Version: "1.0.0", Package: "@kb/commit", Tarball: "https://example.test/commit.tgz", SHA256: "commit"}}
	source.Platforms[0].Config = []catalog.ConfigRequirement{
		{ID: "gateway.access.mode", Path: "/gateway/access/mode", Default: `"local"`},
		{ID: "gateway.bootstrap.adminEmail", Path: "/gateway/bootstrap/adminEmail"},
		{ID: "gateway.bootstrap.tenantId", Path: "/gateway/bootstrap/tenantId"},
		{ID: secrets.BootstrapPassword, Path: "/gateway/bootstrap/password", Secret: true, Generate: true, Env: secrets.BootstrapPasswordEnvironment, Services: []string{"gateway"}},
		{ID: "gateway.jwtSecret", Path: "/gateway/jwtSecret", Secret: true, Generate: true, Env: "GATEWAY_JWT_SECRET", Services: []string{"gateway"}},
	}
	release, err := sealTestCatalog(t, source)
	if err != nil {
		t.Fatal("seal interactive test release")
	}
	indexPath := filepath.Join(home, "release-index.json")
	indexBytes, err := json.Marshal(release)
	if err != nil {
		t.Fatal("encode interactive test release")
	}
	if err := os.WriteFile(indexPath, indexBytes, 0o600); err != nil {
		t.Fatal("write interactive test release")
	}
	input := strings.NewReader("\n\n\nsecured\nadmin@example.test\n\n" + value + "\n" + value + "\n\n")
	factory := func(cmd *cobra.Command) commandDependencies {
		return commandDependencies{Command: cmd, NodeCheck: func() error { return nil }, InstallInput: input,
			Runtime: &runtime.Dependencies{Artifacts: installArtifacts{root: root, release: verifiedFixtureCatalog(t, release)}}}
	}
	var stdout, stderr bytes.Buffer
	args := []string{"install", "--index", indexPath, "--platform-root", root, "--project-root", project,
		"--secret-env", secrets.BootstrapPassword + "=" + passwordEnv + ",gateway.bootstrap.generated=" + markerEnv}
	if code := clikitcommand.Execute(newRootCommandWithDependencyFactory(factory), args, &stdout, &stderr).Code(); code == 0 {
		t.Fatal("interactive install accepted an installer lifecycle ID")
	}
	output := stdout.String() + stderr.String()
	if !strings.Contains(output, contracts.CodeSecretInputInvalid) || !strings.Contains(output, "gateway.bootstrap.generated") {
		phases := make([]string, 0)
		codes := make([]string, 0)
		for _, token := range strings.Fields(output) {
			if strings.HasPrefix(token, "KB_") {
				codes = append(codes, strings.Trim(token, ",:;"))
			}
		}
		for _, phrase := range []string{"Admin email", "Admin password", "Session signing secret", "Plan:", "Applying installation", "KB_INSTALL_SCENARIO_INVALID", "KB_INSTALL_INPUT_REQUIRED"} {
			if strings.Contains(output, phrase) {
				phases = append(phases, phrase)
			}
		}
		t.Fatalf("interactive refusal omitted its catalogued code or offending requirement ID (code=%v id=%v phases=%v codes=%v output_bytes=%d)", strings.Contains(output, contracts.CodeSecretInputInvalid), strings.Contains(output, "gateway.bootstrap.generated"), phases, codes, len(output))
	}
	for _, sensitive := range []string{value, passwordEnv, markerEnv} {
		if strings.Contains(output, sensitive) {
			t.Fatal("interactive refusal output exposed secret material")
		}
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatal("refused interactive install wrote platform state")
	}
	assertSecretsAbsentFromTrees(t, []string{value, passwordEnv, markerEnv}, home)
}

// case: S-222.11
func TestPreviouslyDisclosedFirstAdminProducesRecoveryNotice(t *testing.T) {
	root := t.TempDir()
	store := secrets.Store{PlatformRoot: root}
	if err := store.PutBootstrapPassword("prior-run-secret-marker", secrets.BootstrapOriginGenerated); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkBootstrapCompleted("provisioned"); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkBootstrapDisclosed(); err != nil {
		t.Fatal(err)
	}

	admin, failure := firstAdminResult(store, "admin@example.test", root)
	if failure != nil || admin == nil {
		t.Fatalf("previous disclosure did not return a successful notice result; failure=%v", failure)
	}
	if admin.State != firstAdminPreviouslyDisclosed || admin.Email != "admin@example.test" || admin.Password != "" || admin.RecoveryCommand == "" || admin.StopCommand == "" || admin.StartCommand == "" {
		t.Fatal("previously disclosed result has incorrect state or fields")
	}
	recovery := buildFirstAdminRecoveryCommands(root, "admin@example.test")
	recoveryCommand := recovery.Doctor
	if admin.RecoveryCommand != recoveryCommand {
		t.Fatalf("recovery command = %q, want %q", admin.RecoveryCommand, recoveryCommand)
	}
	if admin.StopCommand != recovery.Stop || admin.StartCommand != recovery.Start {
		t.Fatalf("host recovery commands = (%q, %q), want (%q, %q)", admin.StopCommand, admin.StartCommand, recovery.Stop, recovery.Start)
	}
	result := applyCommandResult{OK: true, Operation: "apply", FirstAdmin: admin}
	jsonOutput, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	humanOutput := renderApply(result)
	for label, output := range map[string]string{"human": humanOutput, "JSON": string(jsonOutput)} {
		if !strings.Contains(output, "issued by an earlier run") || !strings.Contains(output, "not shown again") || !strings.Contains(output, "admin@example.test") || !strings.Contains(output, recovery.Stop) || !strings.Contains(output, recoveryCommand) || !strings.Contains(output, recovery.Start) {
			t.Errorf("%s result omitted prior-disclosure notice or recovery command", label)
		}
		if strings.Contains(output, "prior-run-secret-marker") {
			t.Errorf("%s result exposed the stored bootstrap password", label)
		}
	}
	if err := assertDoctorRecoveryCommandAccepted(recoveryCommand, "admin@example.test"); err != nil {
		t.Fatalf("recovery command is not accepted by doctor: %v", err)
	}
	var payload struct {
		FirstAdmin map[string]any `json:"firstAdmin"`
	}
	if err := json.Unmarshal(jsonOutput, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.FirstAdmin["state"] != string(firstAdminPreviouslyDisclosed) || payload.FirstAdmin["email"] != "admin@example.test" || payload.FirstAdmin["recoveryCommand"] != recoveryCommand {
		t.Fatalf("JSON firstAdmin notice = %#v", payload.FirstAdmin)
	}
	if _, hasPassword := payload.FirstAdmin["password"]; hasPassword {
		t.Fatal("previously disclosed JSON result included a password field")
	}
}

func assertDoctorRecoveryCommandAccepted(recoveryCommand, adminEmail string) error {
	shell := exec.Command("sh", "-c", "set -- "+recoveryCommand+"; printf '%s\\000' \"$@\"")
	output, err := shell.Output()
	if err != nil {
		return fmt.Errorf("shell could not parse recovery command: %w", err)
	}
	fields := strings.Split(strings.TrimSuffix(string(output), "\x00"), "\x00")
	if len(fields) < 3 || fields[0] != "kb-create" {
		return fmt.Errorf("unexpected parsed command arguments %q", fields)
	}
	args := fields[1:]
	root := newRootCommand()
	command, args, err := root.Find(args)
	if err != nil {
		return err
	}
	if command.Name() != "doctor" {
		return fmt.Errorf("command name = %q, want doctor", command.Name())
	}
	if err := command.ParseFlags(args); err != nil {
		return err
	}
	if got, err := command.Flags().GetString("platform-root"); err != nil || got == "" {
		return fmt.Errorf("doctor platform-root = %q, err=%v", got, err)
	}
	for _, name := range []string{"recover", "generate", "yes"} {
		if got, err := command.Flags().GetBool(name); err != nil || !got {
			return fmt.Errorf("doctor --%s = %v, err=%v", name, got, err)
		}
	}
	if got, err := command.Flags().GetString("email"); err != nil || got != adminEmail {
		return fmt.Errorf("doctor email = %q, err=%v", got, err)
	}
	return nil
}

type bootstrapTestHost struct {
	address string
	stop    func() error
}

func (starter *bootstrapTestHost) Start(_ context.Context, spec contracts.HostSpec) (func() error, error) {
	listener, err := net.Listen("tcp", starter.address)
	if err != nil {
		return nil, err
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/health/auth" {
			_, _ = fmt.Fprint(w, `{"ok":true,"data":{"ok":true,"authEnabled":true,"tenantId":"default","activeAdmins":1,"bootstrap":"provisioned","issues":[]},"meta":{"requestId":"test"}}`)
			return
		}
		_, _ = fmt.Fprint(w, `{"ok":true}`)
	}))
	server.Listener = listener
	server.Start()
	starter.stop = func() error { server.Close(); return nil }
	return starter.stop, nil
}

func TestGatewayBootstrapContractUsesSharedSchemaAndFixture(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..", "..", "services", "gateway", "contracts", "src")
	schemaBytes, err := os.ReadFile(filepath.Join(root, "auth-health-response.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Required   []string `json:"required"`
		Properties struct {
			Bootstrap struct {
				Enum []string `json:"enum"`
			} `json:"bootstrap"`
			Issues struct {
				Items struct {
					Required   []string `json:"required"`
					Properties struct {
						Severity struct {
							Enum []string `json:"enum"`
						} `json:"severity"`
					} `json:"properties"`
				} `json:"items"`
			} `json:"issues"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(schemaBytes, &schema); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gatewayAuthHealthResponseRequiredFields[:], schema.Required) {
		t.Fatalf("generated Gateway required fields %v do not match owner schema %v", gatewayAuthHealthResponseRequiredFields, schema.Required)
	}
	if !reflect.DeepEqual(gatewayAuthHealthIssueRequiredFields[:], schema.Properties.Issues.Items.Required) {
		t.Fatalf("generated Gateway issue required fields %v do not match owner schema %v", gatewayAuthHealthIssueRequiredFields, schema.Properties.Issues.Items.Required)
	}
	want := make([]GatewayBootstrapStatus, 0, len(schema.Properties.Bootstrap.Enum))
	for _, status := range schema.Properties.Bootstrap.Enum {
		want = append(want, GatewayBootstrapStatus(status))
	}
	if !reflect.DeepEqual(gatewayBootstrapStatuses[:], want) {
		t.Fatalf("generated Gateway bootstrap values %v do not match owner schema %v", gatewayBootstrapStatuses, want)
	}
	fixture, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "core", "platform", "contracts", "ux-result", "fixtures", "valid", "gateway-auth-health.json"))
	if err != nil {
		t.Fatal(err)
	}
	var response gatewayAuthHealthResponse
	if err := clikitresult.DecodeSuccessResult(fixture, &response); err != nil {
		t.Fatalf("shared Gateway result fixture did not decode: %v", err)
	}
	if response.Bootstrap == nil || *response.Bootstrap != GatewayBootstrapStatusExistsNonActive || response.OK == nil || response.AuthEnabled == nil || response.TenantID == nil || response.ActiveAdmins == nil || response.Issues == nil || len(*response.Issues) != 1 {
		t.Fatalf("shared Gateway response fixture was incomplete: %#v", response)
	}
	issue := (*response.Issues)[0]
	if issue.Code == nil || *issue.Code != "bootstrap_user_inactive" || issue.Severity == nil || *issue.Severity != GatewayAuthHealthIssueSeverityWarning || issue.Message == nil || issue.Hint == nil {
		t.Fatalf("shared Gateway issue fixture was incomplete: %#v", issue)
	}
	severities := make([]string, 0, len(gatewayAuthHealthIssueSeverities))
	for _, severity := range gatewayAuthHealthIssueSeverities {
		severities = append(severities, string(severity))
	}
	if !reflect.DeepEqual(severities, schema.Properties.Issues.Items.Properties.Severity.Enum) {
		t.Fatalf("generated Gateway issue severities %v do not match owner schema %v", gatewayAuthHealthIssueSeverities, schema.Properties.Issues.Items.Properties.Severity.Enum)
	}
	if err := clikitresult.DecodeSuccessResult(bytes.Replace(fixture, []byte("exists-non-active"), []byte("future-state"), 1), &response); err == nil {
		t.Fatal("unknown bootstrap enum was accepted")
	}
	if err := json.Unmarshal([]byte(`"critical"`), new(GatewayAuthHealthIssueSeverity)); err == nil {
		t.Fatal("unknown Gateway auth health issue severity was accepted")
	}
}

func TestGatewayAuthHealthContractAcceptsProviderFailureDetails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, `{"ok":true,"data":{"ok":false,"authEnabled":true,"tenantId":"workspace","activeAdmins":0,"bootstrap":"not-configured","issues":[{"code":"login_provider_unavailable","severity":"error","message":"Provider is unavailable","hint":"Inspect Gateway auth readiness","providerId":"corp-sso","failure":"unreachable"}]},"meta":{"requestId":"provider-state"}}`)
	}))
	defer server.Close()
	store := secrets.Store{PlatformRoot: t.TempDir()}
	failure := readBootstrapOutcome(context.Background(), server.URL+"/health", store)
	var typed *diag.Diag
	if !errors.As(failure, &typed) || typed.Code != contracts.CodeApplyFailed || typed.Message != "Gateway did not prove first-administrator bootstrap and secured authentication are ready with a usable active administrator." {
		t.Fatalf("provider readiness response failure = %v; want typed readiness refusal, not contract mismatch", failure)
	}
	if completed, err := store.BootstrapCompleted(); err != nil || completed {
		t.Fatalf("provider readiness refusal completion marker = %v, err %v; want absent", completed, err)
	}
}

// case: S-222.9
func TestSecuredSSOInstallWithoutBootstrapEmailDoesNotRequireBootstrapCompletion(t *testing.T) {
	request := contracts.InstallRequest{Values: map[string]string{
		"gateway.access.mode":              "\"secured\"",
		"gateway.auth.providers.corp.type": "\"oidc\"",
	}}
	if email, configured := configuredFirstAdmin(request); configured || email != "" {
		t.Fatalf("SSO-only install bootstrap = %q, %v; want no first-admin bootstrap", email, configured)
	}
}

// case: S-222.1
func TestBootstrapContractFailureNamesInternalMismatchAndNextDiagnosticCommand(t *testing.T) {
	store := secrets.Store{PlatformRoot: t.TempDir()}
	err := bootstrapContractFailure("Gateway returned an invalid first-administrator health response.", "Gateway auth-health response did not match the installer contract", store.PlatformRoot)
	var diagnostic *diag.Diag
	if !errors.As(err, &diagnostic) {
		t.Fatalf("bootstrap contract diagnostic = %T; want catalogued diag", err)
	}
	if diagnostic.Message != "Gateway returned an invalid first-administrator health response." || !strings.Contains(diagnostic.Hint, "internal installer/Gateway contract mismatch") || !strings.Contains(diagnostic.Hint, contracts.ShellCommand("kb-create", "doctor", "--platform-root", store.PlatformRoot)) {
		t.Fatalf("bootstrap contract diagnostic = %#v", diagnostic)
	}
	if strings.Contains(diagnostic.Hint, "Update the Gateway") {
		t.Fatalf("bootstrap contract hint blames Gateway version: %q", diagnostic.Hint)
	}
}

// case: S-222.1
func TestUnknownGatewayBootstrapFailsWithCataloguedDiagnostic(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"ok":true,"data":{"ok":true,"authEnabled":true,"tenantId":"default","activeAdmins":0,"bootstrap":"future-state","issues":[]},"meta":{}}`)
	}))
	defer server.Close()
	store := secrets.Store{PlatformRoot: t.TempDir()}
	err := readBootstrapOutcome(context.Background(), server.URL+"/health", store)
	var diagnostic *diag.Diag
	if !errors.As(err, &diagnostic) || diagnostic.Code != contracts.CodeApplyFailed || diagnostic.Cause == "" || !strings.Contains(diagnostic.Message, "invalid first-administrator health response") || !strings.Contains(diagnostic.Hint, "internal installer/Gateway contract mismatch") || !strings.Contains(diagnostic.Hint, contracts.ShellCommand("kb-create", "doctor", "--platform-root", store.PlatformRoot)) {
		t.Fatalf("unknown bootstrap status error = %#v, want catalogued apply diagnostic with next step", err)
	}
	if _, present, err := store.BootstrapCompletedValue(); err != nil || present {
		t.Fatalf("unknown bootstrap response persisted completion: present=%v error=%v", present, err)
	}
}

// case: S-222.1
func TestMissingGatewayRequiredHealthFieldsAreInternalContractFailures(t *testing.T) {
	fixturePath := filepath.Join("..", "..", "..", "..", "..", "core", "platform", "contracts", "ux-result", "fixtures", "valid", "gateway-auth-health.json")
	fixture, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(fixture, &envelope); err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(envelope["data"], &fields); err != nil {
		t.Fatal(err)
	}
	for _, required := range gatewayAuthHealthResponseRequiredFields {
		t.Run(required, func(t *testing.T) {
			withoutField := make(map[string]json.RawMessage, len(fields)-1)
			for key, value := range fields {
				if key != required {
					withoutField[key] = value
				}
			}
			data, err := json.Marshal(withoutField)
			if err != nil {
				t.Fatal(err)
			}
			body, err := json.Marshal(map[string]any{"ok": true, "data": json.RawMessage(data), "meta": json.RawMessage(`{}`)})
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write(body)
			}))
			defer server.Close()

			store := secrets.Store{PlatformRoot: t.TempDir()}
			err = readBootstrapOutcome(context.Background(), server.URL+"/health", store)
			var diagnostic *diag.Diag
			wantDoctor := contracts.ShellCommand("kb-create", "doctor", "--platform-root", store.PlatformRoot)
			if !errors.As(err, &diagnostic) || diagnostic.Code != contracts.CodeApplyFailed || diagnostic.Cause == "" || !strings.Contains(diagnostic.Message, "invalid first-administrator health response") || !strings.Contains(diagnostic.Hint, "internal installer/Gateway contract mismatch") || !strings.Contains(diagnostic.Hint, wantDoctor) {
				t.Fatalf("missing required Gateway field %q = %#v, want internal contract mismatch", required, err)
			}
		})
	}
}

// case: S-222.1
func TestValidGatewayBootstrapFailureDirectsOperatorToAuthReadiness(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"ok":true,"data":{"ok":false,"authEnabled":true,"tenantId":"default","activeAdmins":0,"bootstrap":"failed","issues":[{"code":"bootstrap_failed","severity":"error","message":"Seeding the bootstrap admin failed at startup.","hint":"Check the gateway startup logs."}]},"meta":{}}`)
	}))
	defer server.Close()
	store := secrets.Store{PlatformRoot: t.TempDir()}
	err := readBootstrapOutcome(context.Background(), server.URL+"/health", store)
	var diagnostic *diag.Diag
	if !errors.As(err, &diagnostic) || diagnostic.Code != contracts.CodeApplyFailed || !strings.Contains(diagnostic.Message, "did not prove first-administrator bootstrap") {
		t.Fatalf("valid Gateway bootstrap failure = %#v", err)
	}
	if !strings.Contains(diagnostic.Hint, "inspect Gateway authentication readiness") || !strings.Contains(diagnostic.Hint, contracts.ShellCommand("kb-create", "doctor", "--platform-root", store.PlatformRoot)) || strings.Contains(diagnostic.Hint, "contract mismatch") || strings.Contains(diagnostic.Hint, "Update the Gateway") {
		t.Fatalf("valid Gateway bootstrap failure hint = %q", diagnostic.Hint)
	}
}

type bootstrapOutcomeTestStarter struct{ stopped int }

func (starter *bootstrapOutcomeTestStarter) Start(context.Context, contracts.HostSpec) (func() error, error) {
	return func() error {
		starter.stopped++
		return nil
	}, nil
}

// case: S-222.6, S-222.7, S-222.10
func TestGatewayWithoutUsableAdminCannotWriteBootstrapCompletion(t *testing.T) {
	const remoteSecretMarker = "REMOTE_FIRST_ADMIN_HEALTH_SECRET"
	for _, response := range []struct {
		name         string
		ready        bool
		activeAdmins int
		bootstrap    string
	}{
		{name: "readiness false with no admins", ready: false, activeAdmins: 0, bootstrap: "provisioned"},
		{name: "readiness false despite admin count", ready: false, activeAdmins: 1, bootstrap: "provisioned"},
		{name: "readiness true without admin", ready: true, activeAdmins: 0, bootstrap: "provisioned"},
		{name: "bootstrap failed despite readiness", ready: true, activeAdmins: 1, bootstrap: "failed"},
		{name: "bootstrap not configured despite readiness", ready: true, activeAdmins: 1, bootstrap: "not-configured"},
	} {
		t.Run(response.name, func(t *testing.T) {
			issue := fmt.Sprintf(`{"code":"bootstrap_failed","severity":"error","message":"%s","hint":"%s"}`, remoteSecretMarker, remoteSecretMarker)
			body := fmt.Sprintf(`{"ok":true,"data":{"ok":%t,"authEnabled":true,"tenantId":"default","activeAdmins":%d,"bootstrap":%q,"issues":[%s]},"meta":{}}`, response.ready, response.activeAdmins, response.bootstrap, issue)
			testServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, body)
			}))
			defer testServer.Close()
			store := secrets.Store{PlatformRoot: t.TempDir()}
			starter := &bootstrapOutcomeTestStarter{}
			_, err := (bootstrapOutcomeHost{starter: starter, store: store}).Start(context.Background(), contracts.HostSpec{HealthURL: testServer.URL})
			var diagnostic *diag.Diag
			if !errors.As(err, &diagnostic) || diagnostic.Code != contracts.CodeApplyFailed || diagnostic.Cause == "" {
				t.Fatalf("non-proving readiness = %#v, want typed failure with local cause", err)
			}
			if !strings.Contains(diagnostic.Message, "did not prove first-administrator bootstrap") || !strings.Contains(diagnostic.Hint, contracts.ShellCommand("kb-create", "doctor", "--platform-root", store.PlatformRoot)) {
				t.Fatalf("non-proving readiness diagnostic = %#v", diagnostic)
			}
			var jsonOutput, humanOutput bytes.Buffer
			clikitresult.RenderDiag(&jsonOutput, &humanOutput, diagnostic, clikitresult.ModeJSON)
			encoded, marshalErr := json.Marshal(diagnostic)
			if marshalErr != nil {
				t.Fatal(marshalErr)
			}
			for _, output := range []string{err.Error(), string(encoded), jsonOutput.String(), humanOutput.String()} {
				if strings.Contains(output, remoteSecretMarker) {
					t.Fatal("bootstrap refusal exposed remote health detail")
				}
			}
			if _, present, err := store.BootstrapCompletedValue(); err != nil || present {
				t.Fatalf("non-proving readiness wrote completion marker: present=%v error=%v", present, err)
			}
			if starter.stopped != 1 {
				t.Fatalf("host stop count = %d, want 1 after readiness refusal", starter.stopped)
			}
		})
	}
}

// case: S-222.2, S-224.2
func TestGatewayFailureEnvelopePreservesDiagnosticWithoutSecrets(t *testing.T) {
	const bodySecret = "BODY_TOKEN_SECRET"
	const headerSecret = "HEADER_SESSION_SECRET"
	gatewayCorrelationIDChannel := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gatewayCorrelationID := r.Header.Get("X-Request-Id")
		gatewayCorrelationIDChannel <- gatewayCorrelationID
		if !diag.IsValidCorrelationID(gatewayCorrelationID) {
			t.Errorf("bootstrap X-Request-Id = %q, want valid Gateway correlation ID", gatewayCorrelationID)
		}
		w.Header().Set("X-Debug-Credential", headerSecret)
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"ok":false,"error":{"code":"KB_AUTH_FORBIDDEN","area":"auth","stage":"run","severity":"error","retryable":false,"message":"Gateway auth health is unavailable.","hint":"Run kb-create doctor --platform-root <root>; token=`+bodySecret+`","cause":"token=`+bodySecret+`","correlationId":"`+gatewayCorrelationID+`","details":{"permission":"health:read"}}}`)
	}))
	defer server.Close()
	store := secrets.Store{PlatformRoot: t.TempDir()}
	err := readBootstrapOutcome(context.Background(), server.URL+"/health", store)
	gatewayCorrelationID := <-gatewayCorrelationIDChannel
	var diagnostic *diag.Diag
	if !errors.As(err, &diagnostic) {
		t.Fatalf("Gateway failure = %T %v, want catalogued diagnostic", err, err)
	}
	expected, expectedErr := diag.FromCatalog("KB_AUTH_FORBIDDEN", map[string]string{"permission": "health:read"})
	if expectedErr != nil {
		t.Fatal(expectedErr)
	}
	if diagnostic.Code != expected.Code || diagnostic.Message != expected.Message || diagnostic.Hint != expected.Hint {
		t.Fatalf("Gateway failure diagnostic = %#v", diagnostic)
	}
	if diagnostic.Meta["remoteCorrelationId"] != gatewayCorrelationID {
		t.Fatalf("Gateway failure remote correlation ID = %#v, want %q", diagnostic.Meta["remoteCorrelationId"], gatewayCorrelationID)
	}
	var jsonOutput, humanOutput bytes.Buffer
	clikitresult.RenderDiag(&jsonOutput, &humanOutput, diagnostic, clikitresult.ModeJSON)
	clikitresult.RenderDiag(&bytes.Buffer{}, &humanOutput, diagnostic, clikitresult.ModeHuman)
	if !strings.Contains(humanOutput.String(), "remote correlationId: "+gatewayCorrelationID) {
		t.Fatalf("human bootstrap diagnostic omitted Gateway correlation ID: %s", humanOutput.String())
	}
	var rendered struct {
		Error struct {
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(jsonOutput.Bytes(), &rendered); err != nil || rendered.Error.Details["remoteCorrelationId"] != gatewayCorrelationID {
		t.Fatalf("JSON bootstrap diagnostic omitted Gateway correlation ID: %s err=%v", jsonOutput.String(), err)
	}
	encoded, marshalErr := json.Marshal(diagnostic)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	for _, secret := range []string{bodySecret, headerSecret} {
		if strings.Contains(err.Error(), secret) || strings.Contains(string(encoded), secret) ||
			strings.Contains(jsonOutput.String(), secret) || strings.Contains(humanOutput.String(), secret) {
			t.Fatal("Gateway failure exposed credential material")
		}
	}
}

// case: S-222.3
func TestNonSuccessGatewayBodyGetsInternalMismatchWithoutSecrets(t *testing.T) {
	const bodySecret = "BODY_API_TOKEN_SECRET"
	const headerSecret = "HEADER_AUTH_SECRET"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Debug-Credential", headerSecret)
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, `{"token":"`+bodySecret+`","private":"do-not-display"}`)
	}))
	defer server.Close()
	store := secrets.Store{PlatformRoot: t.TempDir()}
	err := readBootstrapOutcome(context.Background(), server.URL+"/health", store)
	var diagnostic *diag.Diag
	if !errors.As(err, &diagnostic) || diagnostic.Code != contracts.CodeApplyFailed {
		t.Fatalf("non-success Gateway body = %#v, want catalogued internal mismatch", err)
	}
	wantDoctor := contracts.ShellCommand("kb-create", "doctor", "--platform-root", store.PlatformRoot)
	if !strings.Contains(diagnostic.Hint, wantDoctor) || !strings.Contains(diagnostic.Hint, "internal installer/Gateway contract mismatch") {
		t.Fatalf("non-success Gateway diagnostic hint = %q", diagnostic.Hint)
	}
	encoded, marshalErr := json.Marshal(diagnostic)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	for _, secret := range []string{bodySecret, headerSecret, "do-not-display"} {
		if strings.Contains(err.Error(), secret) || strings.Contains(string(encoded), secret) {
			t.Fatal("non-success Gateway response exposed private value")
		}
	}
}

// case: S-222.4
func TestGatewayTransportFailureKeepsExistingDiagnostic(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	server.Close()
	err := readBootstrapOutcome(context.Background(), server.URL+"/health", secrets.Store{PlatformRoot: t.TempDir()})
	if err == nil || err.Error() != "Gateway did not report first-admin bootstrap status" {
		t.Fatalf("transport failure = %v, want existing Gateway unavailable diagnostic", err)
	}
}

func TestApplyDisclosesGeneratedAdminOnceAcrossRepeatedInstall(t *testing.T) {
	root := t.TempDir()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	state := host.State{Dir: t.TempDir()}
	request := contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: root,
		Values:       map[string]string{"gateway.access.mode": `"secured"`, "gateway.bootstrap.adminEmail": `"admin@example.test"`},
		SecretInputs: []string{"gateway.bootstrap.password", "gateway.jwtSecret"}}
	source := testReleaseCatalog(t, "2.0.0")
	gatewayComponent := catalog.Component{ID: "gateway", Package: "@kb-labs/gateway", Version: "2.0.0", Tarball: "https://example.test/gateway.tgz", SHA256: "gateway"}
	source.Platforms[0].Members = append(source.Platforms[0].Members, gatewayComponent)
	release := testfixtures.MustSealCatalog(source)
	gateway := fixturePackageArtifact(t, gatewayComponent.Package, gatewayComponent.Version)
	gateway.ID = "gateway"
	gateway.Config = []contracts.ConfigRequirement{{ID: "gateway.bootstrap.password", Secret: true, Generate: true}, {ID: "gateway.jwtSecret", Secret: true, Generate: true}}
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, PlanHash: "admin-bootstrap-repeat",
		Request: request, Host: &contracts.HostSpec{Command: "kb-host", HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 5},
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "2.0.0", Profile: "default"},
		Artifacts:    []contracts.Artifact{gateway}}
	plan.ReleaseCatalog, err = json.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	resolved := resolvedPlan{Plan: plan, State: state}
	platformRoot := platformRootForTest(t, root)
	store := secrets.Store{PlatformRoot: filepath.Join(root, "current")}
	starter := &bootstrapTestHost{address: address}
	deps := commandDependencies{NodeCheck: func() error { return nil }, ArtifactRunner: productionPackageFixtureRunner{}, Runtime: &runtime.Dependencies{Host: starter}}
	t.Cleanup(func() {
		if starter.stop != nil {
			_ = starter.stop()
		}
	})
	firstOutput := runApplyForTest(t, resolved, deps)
	firstResult := applyResultFromJSONDocument(t, firstOutput)
	password := firstResult.FirstAdmin.Password
	if password == "" || strings.Count(firstOutput, password) != 1 {
		t.Fatalf("first result did not disclose exactly one generated password")
	}
	for _, name := range []string{"gateway.bootstrap.password", secrets.BootstrapPasswordEnvironment} {
		present, err := store.Exists(name)
		if err != nil || present {
			t.Fatalf("disclosed bootstrap secret %q present=%v, error=%v", name, present, err)
		}
	}
	assertSecretAbsentFromTree(t, root, password)
	for label, platformRoot := range map[string]string{"root": root, "current": filepath.Join(root, "current")} {
		storeAtRoot := secrets.Store{PlatformRoot: platformRoot}
		completed, completedErr := storeAtRoot.BootstrapCompleted()
		disclosed, disclosedErr := storeAtRoot.BootstrapDisclosed()
		present, presentErr := storeAtRoot.Exists("gateway.bootstrap.password")
		if !completed || completedErr != nil || !disclosed || disclosedErr != nil || present || presentErr != nil {
			t.Fatalf("first disclosure lifecycle at %s: completed=%v/%v disclosed=%v/%v passwordPresent=%v/%v", label, completed, completedErr, disclosed, disclosedErr, present, presentErr)
		}
	}
	assertSingleAdminResultRecord(t, firstOutput, "admin@example.test", password)
	logBytes, err := os.ReadFile(firstResult.LogPath)
	if err != nil {
		t.Fatalf("read operation log %q from apply result: %v", firstResult.LogPath, err)
	}
	if len(logBytes) == 0 {
		t.Fatalf("operation log %q is empty", firstResult.LogPath)
	}
	assertSecretAbsent(t, "operation log", logBytes, password)
	receiptBytes, err := os.ReadFile(receipt.Path(platformRoot))
	if err != nil {
		t.Fatalf("read apply receipt: %v", err)
	}
	if len(receiptBytes) == 0 {
		t.Fatal("apply receipt is empty")
	}
	assertSecretAbsent(t, "receipt file", receiptBytes, password)
	assertSecretAbsent(t, "plan output", mustJSON(t, firstResult.Receipt.Plan), password)
	if err := starter.stop(); err != nil {
		t.Fatal(err)
	}
	secondOutput := runApplyForTest(t, resolved, deps)
	for _, name := range []string{"gateway.bootstrap.password", secrets.BootstrapPasswordEnvironment} {
		present, err := store.Exists(name)
		if err != nil || present {
			t.Fatalf("repeat apply restored bootstrap secret %q: present=%v, error=%v", name, present, err)
		}
	}
	assertSingleAdminResultRecord(t, secondOutput, "admin@example.test", "")
	if strings.Contains(secondOutput, password) || !strings.Contains(secondOutput, "issued by an earlier run") || !strings.Contains(secondOutput, firstAdminRecoveryCommand(platformRoot, "admin@example.test")) {
		t.Fatal("repeat apply omitted prior-disclosure notice or exposed secret material")
	}
}

func TestApplyFailureBeforeResultWriteLeavesPasswordEligibleForRetry(t *testing.T) {
	root := t.TempDir()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	state := host.State{Dir: t.TempDir()}
	request := contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: root,
		Values:       map[string]string{"gateway.access.mode": `"secured"`, "gateway.bootstrap.adminEmail": `"admin@example.test"`},
		SecretInputs: []string{"gateway.bootstrap.password", "gateway.jwtSecret"}}
	source := testReleaseCatalog(t, "2.0.0")
	gatewayComponent := catalog.Component{ID: "gateway", Package: "@kb-labs/gateway", Version: "2.0.0", Tarball: "https://example.test/gateway.tgz", SHA256: "gateway"}
	source.Platforms[0].Members = append(source.Platforms[0].Members, gatewayComponent)
	release := testfixtures.MustSealCatalog(source)
	gateway := fixturePackageArtifact(t, gatewayComponent.Package, gatewayComponent.Version)
	gateway.ID = "gateway"
	gateway.Config = []contracts.ConfigRequirement{{ID: "gateway.bootstrap.password", Secret: true, Generate: true}, {ID: "gateway.jwtSecret", Secret: true, Generate: true}}
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, PlanHash: "admin-bootstrap-repeat",
		Request: request, Host: &contracts.HostSpec{Command: "kb-host", HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 5},
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "2.0.0", Profile: "default"},
		Artifacts:    []contracts.Artifact{gateway}}
	plan.ReleaseCatalog, err = json.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	resolved := resolvedPlan{Plan: plan, State: state}
	store := secrets.Store{PlatformRoot: filepath.Join(root, "current")}
	starter := &bootstrapTestHost{address: address}
	deps := commandDependencies{NodeCheck: func() error { return nil }, ArtifactRunner: productionPackageFixtureRunner{}, Runtime: &runtime.Dependencies{Host: starter}}
	t.Cleanup(func() {
		if starter.stop != nil {
			_ = starter.stop()
		}
	})
	failedAttemptInput := applyCommandInput{Resolved: &resolved, Executable: filepath.Join(t.TempDir(), "kb-create")}
	if _, failure := executeApply(context.Background(), failedAttemptInput, deps); failure == nil {
		t.Fatal("apply without the installed CLI entry unexpectedly created the kb shim")
	}
	if disclosed, err := store.BootstrapDisclosed(); err != nil || disclosed {
		t.Fatalf("apply failure before result output consumed the disclosure marker: disclosed=%v err=%v", disclosed, err)
	}
	if starter.stop != nil {
		if err := starter.stop(); err != nil {
			t.Fatal(err)
		}
		starter.stop = nil
	}
	password, present, err := store.Get("gateway.bootstrap.password")
	if err != nil || !present {
		t.Fatalf("stored password availability mismatch: present=%v, error=%v", present, err)
	}
	retryResult, retryFailure := executeApply(context.Background(), applyCommandInput{Resolved: &resolved}, deps)
	if retryFailure != nil || retryResult.FirstAdmin == nil || retryResult.FirstAdmin.State != firstAdminDisclosed || retryResult.FirstAdmin.Password != password {
		t.Fatalf("retry after completed bootstrap without a result write did not return the stored credential; failure=%v", retryFailure)
	}
	if disclosed, err := store.BootstrapDisclosed(); err != nil || disclosed {
		t.Fatalf("apply result construction recorded disclosure before output: disclosed=%v err=%v", disclosed, err)
	}
}

type failFirstAdminResultWriter struct {
	bytes.Buffer
}

func (writer *failFirstAdminResultWriter) Write(value []byte) (int, error) {
	return 0, errors.New("closed output")
}

func TestApplyResultWriteFailureLeavesDisclosureMarkerAbsentForRetry(t *testing.T) {
	root := t.TempDir()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	request := contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: root,
		Values:       map[string]string{"gateway.access.mode": `"secured"`, "gateway.bootstrap.adminEmail": `"admin@example.test"`},
		SecretInputs: []string{"gateway.bootstrap.password", "gateway.jwtSecret"}}
	source := testReleaseCatalog(t, "2.0.0")
	gatewayComponent := catalog.Component{ID: "gateway", Package: "@kb-labs/gateway", Version: "2.0.0", Tarball: "https://example.test/gateway.tgz", SHA256: "gateway"}
	source.Platforms[0].Members = append(source.Platforms[0].Members, gatewayComponent)
	release := testfixtures.MustSealCatalog(source)
	gateway := fixturePackageArtifact(t, gatewayComponent.Package, gatewayComponent.Version)
	gateway.ID = "gateway"
	gateway.Config = []contracts.ConfigRequirement{{ID: "gateway.bootstrap.password", Secret: true, Generate: true}, {ID: "gateway.jwtSecret", Secret: true, Generate: true}}
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, PlanHash: "result-write-failure",
		Request: request, Host: &contracts.HostSpec{Command: "kb-host", HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 5},
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "2.0.0", Profile: "default"},
		Artifacts:    []contracts.Artifact{gateway}}
	plan.ReleaseCatalog, err = json.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	resolved := resolvedPlan{Plan: plan, State: host.State{Dir: t.TempDir()}}
	store := secrets.Store{PlatformRoot: filepath.Join(root, "current")}
	starter := &bootstrapTestHost{address: address}
	deps := commandDependencies{NodeCheck: func() error { return nil }, ArtifactRunner: productionPackageFixtureRunner{}, Runtime: &runtime.Dependencies{Host: starter}}
	t.Cleanup(func() {
		if starter.stop != nil {
			_ = starter.stop()
		}
	})
	applied, failure := executeApply(context.Background(), applyCommandInput{Resolved: &resolved}, deps)
	if failure != nil {
		t.Fatalf("prepare apply result: %v; cause: %s", failure, failure.Cause)
	}
	var stdout, stderr failFirstAdminResultWriter
	if code := emitApplyResultForTest(t, applied, &stdout, &stderr); code == 0 {
		t.Fatal("apply with a failing result writer succeeded")
	}
	if disclosed, err := store.BootstrapDisclosed(); err != nil || disclosed {
		t.Fatalf("failed final result write recorded disclosure = %v, err %v", disclosed, err)
	}
	if starter.stop != nil {
		if err := starter.stop(); err != nil {
			t.Fatal(err)
		}
		starter.stop = nil
	}
	output := runApplyForTest(t, resolved, deps)
	result := applyResultFromJSONDocument(t, output)
	password := result.FirstAdmin.Password
	if password == "" || !strings.Contains(output, password) {
		t.Fatalf("retry after failed result write did not disclose the first-admin password")
	}
	for _, name := range []string{"gateway.bootstrap.password", secrets.BootstrapPasswordEnvironment} {
		if present, err := store.Exists(name); err != nil || present {
			t.Fatalf("successful retry retained bootstrap secret %q: present=%v err=%v", name, present, err)
		}
	}
	if disclosed, err := store.BootstrapDisclosed(); err != nil || !disclosed {
		t.Fatalf("successful retry did not record disclosure after result write: %v, err %v", disclosed, err)
	}
}

// case: S-222.11
func TestJSONInstallRegistrationFailureDefersDisclosureUntilSuccessfulRetry(t *testing.T) {
	for _, spelling := range []string{"install-root", "current", "version-root"} {
		t.Run(spelling, func(t *testing.T) {
			testJSONInstallRegistrationFailureDefersDisclosureUntilSuccessfulRetry(t, spelling)
		})
	}
}

func testJSONInstallRegistrationFailureDefersDisclosureUntilSuccessfulRetry(t *testing.T, retrySpelling string) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KB_HOME", filepath.Join(home, ".kb"))
	root := filepath.Join(home, "platform")
	testExecutable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ownedShim := shim.Path(testExecutable)
	ownedTarget := shim.Target(platformRootForTest(t, root))
	t.Cleanup(func() {
		if target, readErr := os.Readlink(ownedShim); readErr == nil && target == ownedTarget {
			if err := os.Remove(ownedShim); err != nil {
				t.Errorf("remove test-owned kb shim: %v", err)
			}
		}
	})
	project := filepath.Join(home, "project")
	if err := os.Mkdir(project, 0o755); err != nil {
		t.Fatal(err)
	}
	port := freeAllocatedGatewayPortWithOffsets(t, 0)
	indexPath := filepath.Join(home, "release-index.json")
	source := testReleaseCatalog(t, "2.0.0")
	source.Platforms[0].Host = &contracts.HostSpec{Command: "kb-host", HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 5}
	source.Platforms[0].Profiles = map[string]contracts.ServiceGraph{"default": {PlatformVersion: "2.0.0", Services: []contracts.Service{{ID: "gateway", Port: port}}}}
	source.Platforms[0].Config = []catalog.ConfigRequirement{
		{ID: "platform.adapterOptions", Path: "/platform/adapterOptions", Default: fmt.Sprintf(`{"serviceTransport":{"services":{"gateway":{"url":"http://127.0.0.1:%d"}}}}`, port)},
		{ID: "gateway.access.mode", Path: "/gateway/access/mode", Default: `"secured"`},
		{ID: "gateway.bootstrap.adminEmail", Path: "/gateway/bootstrap/adminEmail", Default: `"admin@example.test"`},
		{ID: "gateway.bootstrap.tenantId", Path: "/gateway/bootstrap/tenantId", Default: `"workspace"`},
		{ID: "gateway.bootstrap.password", Secret: true, Generate: true, Env: "GATEWAY_BOOTSTRAP_ADMIN_PASSWORD", Services: []string{"gateway"}},
		{ID: "gateway.jwtSecret", Secret: true, Generate: true, Env: "GATEWAY_JWT_SECRET", Services: []string{"gateway"}},
		{ID: "gateway.authStorage.filename", Path: "/platform/adapterOptions/documentDatabase/filename", Default: `"database/kb.sqlite"`},
	}
	source.Adapters = []catalog.Adapter{{Component: catalog.Component{ID: "sqlite-stores", Version: "1.0.0", Package: "@kb/sqlite-stores", Tarball: "https://example.test/sqlite.tgz", SHA256: "sqlite"}, Provides: []string{"documentDatabase"}}}
	release, err := sealTestCatalog(t, source)
	if err != nil {
		t.Fatal(err)
	}
	indexData, err := json.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, indexData, 0o600); err != nil {
		t.Fatal(err)
	}
	requestPath := filepath.Join(home, "request.json")
	requestData, err := json.Marshal(contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: root, ProjectRoot: project,
		ServiceProfile: "default", Values: map[string]string{"gateway.access.mode": `"secured"`, "gateway.bootstrap.adminEmail": `"admin@example.test"`, "gateway.bootstrap.tenantId": `"workspace"`},
		SecretInputs: []string{"gateway.bootstrap.password", "gateway.jwtSecret"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(requestPath, requestData, 0o600); err != nil {
		t.Fatal(err)
	}
	starter := &bootstrapTestHost{address: fmt.Sprintf("127.0.0.1:%d", port)}
	t.Cleanup(func() {
		if starter.stop != nil {
			_ = starter.stop()
		}
	})
	registrations := 0
	run := func(rootSpelling string) (int, string, string) {
		var stdout, stderr bytes.Buffer
		command := newRootCommandWithDependencyFactory(func(cmd *cobra.Command) commandDependencies {
			deps := productionCommandDependencies(cmd)
			deps.NodeCheck = func() error { return nil }
			deps.ArtifactRunner = operationLogTestRunner{}
			deps.Runtime = &runtime.Dependencies{Artifacts: installArtifacts{root: root, release: verifiedFixtureCatalog(t, release)}, Host: starter, Clock: projectRegistrationTestClock{now: time.Now()}}
			deps.ProjectRegistrar = func(platformRoot, selected string) (projectRegistrationResult, error) {
				registrations++
				if registrations == 1 {
					return projectRegistrationResult{}, errors.New("registry unavailable")
				}
				return projectRegistrationResult{ID: "prj_0123456789abcdef", CanonicalPath: selected}, nil
			}
			return deps
		})
		args := []string{"install", "--json", "--index", indexPath, "--input", requestPath}
		if rootSpelling != "" {
			args = append(args, "--platform-root", rootSpelling)
		}
		code := clikitcommand.Execute(command, args, &stdout, &stderr)
		return code.Code(), stdout.String(), stderr.String()
	}
	firstCode, firstStdout, firstStderr := run("")
	firstOutput := firstStdout + firstStderr
	activeRoot := platformRootForTest(t, root)
	store := secrets.Store{PlatformRoot: activeRoot}
	password, present, err := store.Get("gateway.bootstrap.password")
	if firstCode == 0 || !present || !strings.Contains(firstOutput, contracts.CodeProjectRegistrationFailed) || strings.Contains(firstOutput, password) {
		t.Fatalf("registration-failed JSON install did not preserve the undisclosed credential; exit=%d passwordPresent=%v", firstCode, present)
	}
	if disclosed, err := store.BootstrapDisclosed(); err != nil || disclosed {
		t.Fatalf("registration failure recorded disclosure: disclosed=%v err=%v", disclosed, err)
	}
	if starter.stop != nil {
		if err := starter.stop(); err != nil {
			t.Fatal(err)
		}
		starter.stop = nil
	}
	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	activeRoot, err = layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	rootBySpelling := map[string]string{
		"install-root": root,
		"current":      layout.PlatformRoot(),
		"version-root": activeRoot,
	}
	secondCode, secondStdout, secondStderr := run(rootBySpelling[retrySpelling])
	secondOutput := secondStdout + secondStderr
	if secondCode != 0 || !strings.Contains(secondOutput, password) || !strings.Contains(secondOutput, `"state":"disclosed"`) {
		t.Fatalf("retry after registration failure did not disclose the stored credential: exit=%d", secondCode)
	}
	secondResult := installResultFromJSONStream(t, secondStdout, secondCode)
	registrationGateway, err := gateway.OriginFromHealthURL(secondResult.Receipt.Verification.HostHealthURL)
	if err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{
		contracts.ShellCommand("kb", "auth", "login", "--gateway-url", registrationGateway, "--email", "admin@example.test"),
		contracts.ShellCommand("kb", "project", "add", project),
		contracts.ShellCommand("kb", "project", "show", project),
	} {
		if !strings.Contains(secondResult.ProjectRegistrationNotice, command) {
			t.Fatalf("completed retry notice %q omitted command %q", secondResult.ProjectRegistrationNotice, command)
		}
	}
	if registrations != 1 {
		t.Fatalf("completed repeat install attempted project registration %d times; want only the initial install attempt", registrations)
	}
	if disclosed, err := store.BootstrapDisclosed(); err != nil || !disclosed {
		t.Fatalf("successful result did not record disclosure: disclosed=%v err=%v", disclosed, err)
	}
	if starter.stop != nil {
		if err := starter.stop(); err != nil {
			t.Fatal(err)
		}
		starter.stop = nil
	}
	thirdCode, thirdStdout, thirdStderr := run(rootBySpelling[retrySpelling])
	thirdOutput := thirdStdout + thirdStderr
	if thirdCode != 0 || strings.Contains(thirdOutput, password) || !strings.Contains(thirdOutput, "previously-disclosed") || !strings.Contains(thirdOutput, "issued by an earlier run") {
		t.Fatalf("third run did not return the non-secret prior-disclosure notice: exit=%d", thirdCode)
	}
}

type operationLogTestRunner struct{}

func (operationLogTestRunner) Run(_ context.Context, output io.Writer, _ string, _ ...string) error {
	_, err := io.WriteString(output, "fake package manager operation completed\n")
	return err
}

func runApplyForTest(t *testing.T, resolved resolvedPlan, deps commandDependencies) string {
	t.Helper()
	var stdout, stderr bytes.Buffer
	applied, failure := executeApply(context.Background(), applyCommandInput{Resolved: &resolved}, deps)
	if failure != nil {
		t.Fatalf("apply failed: %v; cause: %s", failure, failure.Cause)
	}
	if code := emitApplyResultForTest(t, applied, &stdout, &stderr); code != 0 {
		t.Fatalf("apply failed: exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	return stdout.String()
}

func emitApplyResultForTest(t *testing.T, applied applyCommandResult, stdout, stderr io.Writer) int {
	t.Helper()
	descriptor, ok := lookupOperationDescriptor("apply")
	if !ok {
		t.Fatal("apply command is not registered")
	}
	descriptor.Handler = func(context.Context, *cobra.Command, *commandFlagReader, commandDependencies) (any, *diag.Diag) {
		return applied, nil
	}
	root := &cobra.Command{Use: "kb-create"}
	child := &cobra.Command{Use: "apply", RunE: func(cmd *cobra.Command, _ []string) error {
		return callDescriptor(cmd, descriptor, nil, commandDependencies{Command: cmd})
	}}
	child.Flags().Bool("json", false, "emit machine-readable output")
	root.AddCommand(child)
	return clikitcommand.Execute(root, []string{"apply", "--json"}, stdout, stderr).Code()
}

func applyResultFromJSONDocument(t *testing.T, output string) applyCommandResult {
	t.Helper()
	var envelope struct {
		OK   bool               `json:"ok"`
		Data applyCommandResult `json:"data"`
	}
	if err := json.Unmarshal([]byte(output), &envelope); err != nil {
		t.Fatalf("decode apply JSON document: %v: %s", err, output)
	}
	if !envelope.OK {
		t.Fatalf("apply JSON document is not a success envelope: %s", output)
	}
	return envelope.Data
}

func assertSecretAbsent(t *testing.T, label string, output []byte, password string) {
	t.Helper()
	if bytes.Contains(output, []byte(password)) {
		t.Errorf("generated password leaked into %s", label)
	}
	encoded, err := json.Marshal(password)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(output, encoded) {
		t.Errorf("JSON-escaped generated password leaked into %s", label)
	}
}

func assertSingleAdminResultRecord(t *testing.T, output, email, password string) {
	t.Helper()
	result := applyResultFromJSONDocument(t, output)
	if result.FirstAdmin == nil || result.FirstAdmin.Email != email || result.FirstAdmin.Password != password {
		t.Fatal("first-administrator result did not contain the expected email and credential")
	}
	if password == "" && result.FirstAdmin.State != firstAdminPreviouslyDisclosed {
		t.Fatalf("repeat first-administrator state = %q, want %q", result.FirstAdmin.State, firstAdminPreviouslyDisclosed)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

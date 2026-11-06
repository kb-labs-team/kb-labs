package v2cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	clikitcommand "github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/result"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/gateway"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/spf13/cobra"
)

// case: S-203.1, S-203.2, S-203.6, S-203.10, S-203.11, S-203.12
func TestRegisteredCommandsUseSharedResultBoundary(t *testing.T) {
	root := newRootCommand()
	commands := registeredCommands(root)
	if len(commands) == 0 {
		t.Fatal("kb-create command registry is empty")
	}

	doctor := findCommand(root, "kb-create doctor")
	if doctor == nil || doctor.RunE == nil {
		t.Fatal("doctor must be registered as the safe read-only boundary fixture")
	}
	original := doctor.RunE
	doctor.RunE = func(*cobra.Command, []string) error {
		return result.Return(map[string]any{"operation": "doctor", "ok": true})
	}
	var success bytes.Buffer
	if code := clikitcommand.Execute(root, []string{"doctor", "--json"}, &success, &bytes.Buffer{}); code.Code() != 0 {
		t.Fatalf("doctor fixture exit = %d", code.Code())
	}
	if err := result.ValidateMachineResult(success.Bytes()); err != nil {
		t.Fatalf("doctor fixture envelope: %v; output=%s", err, success.String())
	}
	doctor.RunE = original
	delete(doctor.Annotations, "clikit.sharedResultBoundary")
	clikitcommand.InstallInputBoundary(root)

	for _, command := range commands {
		if !clikitcommand.BoundaryInstalled(command) {
			t.Errorf("registered command %q is not wrapped by the shared boundary", command.CommandPath())
			continue
		}
		path := strings.Fields(strings.TrimPrefix(command.CommandPath(), root.CommandPath()))
		var help bytes.Buffer
		if code := clikitcommand.Execute(root, append(path, "--help"), &help, &bytes.Buffer{}); code.Code() != 0 {
			t.Errorf("%s --help exit = %d", command.CommandPath(), code.Code())
		}

		var invalid bytes.Buffer
		args := append(append([]string{}, path...), "--json", "--kb-contract-invalid")
		if code := clikitcommand.Execute(root, args, &invalid, &bytes.Buffer{}); code.Code() != 2 {
			t.Errorf("%s invalid flag exit = %d, want 2", command.CommandPath(), code.Code())
		}
		if err := result.ValidateMachineResult(invalid.Bytes()); err != nil {
			t.Errorf("%s invalid flag envelope: %v; output=%s", command.CommandPath(), err, invalid.String())
			continue
		}
		var failure struct {
			OK    bool `json:"ok"`
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(invalid.Bytes(), &failure); err != nil || failure.OK || failure.Error.Code != "KB_RUNTIME_INPUT_INVALID" {
			t.Errorf("%s invalid flag result = %s, want typed KB_RUNTIME_INPUT_INVALID", command.CommandPath(), invalid.String())
		}
	}
}

func TestOperationDescriptorsMatchRegisteredCommandTree(t *testing.T) {
	root := newRootCommand()
	want := make(map[string]operationDescriptor, len(operationDescriptors))
	for _, descriptor := range operationDescriptors {
		if _, exists := want[descriptor.Name]; exists {
			t.Fatalf("duplicate operation descriptor %q", descriptor.Name)
		}
		want[descriptor.Name] = descriptor
	}
	got := make(map[string]*cobra.Command)
	for _, command := range registeredCommands(root) {
		got[command.Name()] = command
	}
	if len(got) != len(want) {
		t.Fatalf("registered command count = %d, descriptor count = %d", len(got), len(want))
	}
	for name, descriptor := range want {
		command := got[name]
		if command == nil {
			t.Errorf("descriptor %q is not registered in Cobra", name)
			continue
		}
		if command.Short != descriptor.Short || command.Hidden != descriptor.Hidden {
			t.Errorf("Cobra command %q metadata does not match its descriptor", name)
		}
		if descriptor.Handler == nil {
			t.Errorf("descriptor %q has no handler", name)
		}
		gotFlags := localFlagNames(command)
		wantFlags := make([]string, len(descriptor.Flags))
		copy(wantFlags, descriptor.Flags)
		sort.Strings(gotFlags)
		sort.Strings(wantFlags)
		if !reflect.DeepEqual(gotFlags, wantFlags) {
			t.Errorf("command %q local flags = %v, descriptor flags = %v", name, gotFlags, wantFlags)
		}
	}
	for name := range got {
		if _, exists := want[name]; !exists {
			t.Errorf("Cobra command %q has no operation descriptor", name)
		}
	}
}

// case: S-203.24
func TestCommandRejectsUndeclaredFlagsAndPositionalArguments(t *testing.T) {
	for _, args := range [][]string{
		{"status", "--snapshot", "unexpected", "--json"},
		{"status", "unexpected", "--json"},
	} {
		var stdout, stderr bytes.Buffer
		code := clikitcommand.Execute(newRootCommand(), args, &stdout, &stderr)
		if code.Code() != 2 {
			t.Errorf("args %q exit = %d, want 2; stdout=%s stderr=%s", args, code.Code(), stdout.String(), stderr.String())
		}
		var envelope struct {
			OK    bool `json:"ok"`
			Error struct {
				Code string `json:"code"`
				Hint string `json:"hint"`
			} `json:"error"`
		}
		if err := json.Unmarshal(stdout.Bytes(), &envelope); err != nil || envelope.OK || envelope.Error.Code != "KB_RUNTIME_INPUT_INVALID" {
			t.Errorf("args %q result = %s, want invalid-input envelope", args, stdout.String())
		}
		if !strings.Contains(envelope.Error.Hint, "kb-create status --help") {
			t.Errorf("args %q hint = %q, want command help", args, envelope.Error.Hint)
		}
	}
}

func registeredCommands(root *cobra.Command) []*cobra.Command {
	var commands []*cobra.Command
	var visit func(*cobra.Command)
	visit = func(parent *cobra.Command) {
		for _, child := range parent.Commands() {
			if child.Run != nil || child.RunE != nil {
				commands = append(commands, child)
			}
			visit(child)
		}
	}
	visit(root)
	return commands
}

func findCommand(root *cobra.Command, path string) *cobra.Command {
	for _, command := range registeredCommands(root) {
		if command.CommandPath() == path {
			return command
		}
	}
	return nil
}

// case: S-203.11, S-203.12
func TestDoctorFailuresUseSharedHumanAndJSONBoundary(t *testing.T) {
	for _, mode := range []string{"human", "json"} {
		t.Run(mode+" typed", func(t *testing.T) {
			root := newRootCommand()
			doctor := findCommand(root, "kb-create doctor")
			doctor.RunE = func(*cobra.Command, []string) error {
				return diag.New("KB_INSTALL_DOCTOR_INPUT_INVALID", "doctor fixture root is missing")
			}
			var stdout, stderr bytes.Buffer
			args := []string{"doctor"}
			if mode == "json" {
				args = append(args, "--json")
			}
			if code := clikitcommand.Execute(root, args, &stdout, &stderr); code.Code() != 1 {
				t.Fatalf("exit = %d, want 1; out=%s err=%s", code.Code(), stdout.String(), stderr.String())
			}
			if mode == "json" {
				if err := result.ValidateMachineResult(stdout.Bytes()); err != nil {
					t.Fatalf("result: %v; out=%s", err, stdout.String())
				}
			}
			visible := stdout.String() + stderr.String()
			if !strings.Contains(visible, "KB_INSTALL_DOCTOR_INPUT_INVALID") || mode == "human" && !strings.Contains(strings.ToLower(visible), "correlation") {
				t.Fatalf("failure lacks code/correlation: %s", visible)
			}
		})
		t.Run(mode+" unexpected", func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("XDG_DATA_HOME", filepath.Join(home, "launcher-data"))
			root := newRootCommand()
			doctor := findCommand(root, "kb-create doctor")
			doctor.RunE = func(*cobra.Command, []string) error {
				return runSafely(func() error { return errors.New("raw Go error fixture") })
			}
			var stdout, stderr bytes.Buffer
			args := []string{"doctor"}
			if mode == "json" {
				args = append(args, "--json")
			}
			if code := clikitcommand.Execute(root, args, &stdout, &stderr); code.Code() != 1 {
				t.Fatalf("exit = %d, want 1", code.Code())
			}
			visible := stdout.String() + stderr.String()
			if !strings.Contains(visible, "KB_RUNTIME_UNEXPECTED") || mode == "json" && !strings.Contains(visible, "correlationId") {
				t.Fatalf("unexpected failure lacks code/id: %s", visible)
			}
			if strings.Contains(visible, "raw Go error fixture") || strings.Contains(visible, "goroutine") {
				t.Fatalf("raw failure escaped to terminal: %s", visible)
			}
			correlationID := regexp.MustCompile(`[a-f0-9]{32}`).FindString(visible)
			if correlationID == "" {
				t.Fatalf("failure has no correlation ID: %s", visible)
			}
			log, err := os.ReadFile(filepath.Join(gateway.DataDir(home), "logs", "kb-create.jsonl"))
			if err != nil || !bytes.Contains(log, []byte(correlationID)) || !bytes.Contains(log, []byte(`"stack"`)) {
				t.Fatalf("structured diagnostics lack correlation/stack: %s (%v)", log, err)
			}
			if _, err := os.Stat(filepath.Join(home, ".kb")); !os.IsNotExist(err) {
				t.Fatalf("unexpected diagnostic created legacy HOME state: %v", err)
			}
		})
	}
}

func TestNewDiagCauseIsVisibleAndRedactedAtDoctorCommandBoundary(t *testing.T) {
	for _, mode := range []string{"human", "json"} {
		t.Run(mode, func(t *testing.T) {
			root := newRootCommand()
			doctor := findCommand(root, "kb-create doctor")
			doctor.RunE = func(*cobra.Command, []string) error {
				return contracts.NewDiag("KB_INSTALL_DOCTOR_INPUT_INVALID", "doctor input could not be prepared", "fix the input and rerun doctor", errors.New("decode config: token=private-value"))
			}
			var stdout, stderr bytes.Buffer
			args := []string{"doctor"}
			if mode == "json" {
				args = append(args, "--json")
			}
			if code := clikitcommand.Execute(root, args, &stdout, &stderr); code.Code() != 1 {
				t.Fatalf("exit = %d, want 1; stdout=%s stderr=%s", code.Code(), stdout.String(), stderr.String())
			}
			visible := stdout.String() + stderr.String()
			if strings.Contains(visible, "private-value") || !strings.Contains(visible, "[REDACTED]") {
				t.Fatalf("diagnostic cause must be visible with secret material redacted: %s", visible)
			}
			if !strings.Contains(visible, "decode config") {
				t.Fatalf("diagnostic cause context missing: %s", visible)
			}
		})
	}
}

// case: S-203.11, PC-003.2
func TestDoctorMissingReceiptUsesSharedHumanAndJSONBoundary(t *testing.T) {
	for _, mode := range []string{"human", "json"} {
		t.Run(mode, func(t *testing.T) {
			root := newRootCommand()
			var stdout, stderr bytes.Buffer
			args := []string{"doctor", "--platform-root", filepath.Join(t.TempDir(), "missing-platform")}
			if mode == "json" {
				args = append(args, "--json")
			}
			if code := clikitcommand.Execute(root, args, &stdout, &stderr); code.Code() != 1 {
				t.Fatalf("exit = %d, want 1; stdout=%s stderr=%s", code.Code(), stdout.String(), stderr.String())
			}
			visible := stdout.String() + stderr.String()
			if mode == "json" {
				if err := result.ValidateMachineResult(stdout.Bytes()); err != nil {
					t.Fatalf("result: %v; stdout=%s", err, stdout.String())
				}
			}
			if !strings.Contains(visible, "KB_INSTALL_RECEIPT_UNAVAILABLE") || !strings.Contains(strings.ToLower(visible), "correlation") || !strings.Contains(visible, "Run `kb-create install`") {
				t.Fatalf("missing-receipt failure lacks code, correlation, or next step: %s", visible)
			}
		})
	}
}

// case: S-203.7, S-203.13
func TestJSONInstallProgressEndsWithTerminalRecord(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	index := filepath.Join(t.TempDir(), "release-index.json")
	source := testReleaseCatalog(t, "2.0.0")
	source.Platforms[0].Host = testHostOnFreePort(t)
	source.Platforms[0].Profiles = map[string]contracts.ServiceGraph{"default": {PlatformVersion: "2.0.0"}}
	release, err := sealTestCatalog(t, source)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(index, data, 0o600); err != nil {
		t.Fatal(err)
	}
	platformRoot := filepath.Join(t.TempDir(), "platform")
	var stdout bytes.Buffer
	cmd := &cobra.Command{Use: "kb-create install"}
	cmd.SetOut(&stdout)
	inv := operationTestSetup{Operation: "install", Index: index, JSON: true, Direct: directRequest{PlatformRoot: platformRoot}, RuntimeDeps: &runtime.Dependencies{Artifacts: installArtifacts{root: platformRoot, release: verifiedFixtureCatalog(t, release)}, Host: installHost{}}, NodePreflight: func() error { return nil }}
	descriptor, _ := lookupOperationDescriptor("install")
	err = descriptorTestCall(cmd, descriptor, inv)
	if code, ok := result.StreamExitCode(err); !ok || code != diag.SuccessStatus() {
		t.Fatalf("stream result = %v, %v; out=%s", code, ok, stdout.String())
	}
	lines := bytes.Split(bytes.TrimSpace(stdout.Bytes()), []byte("\n"))
	if len(lines) < 2 {
		t.Fatalf("expected progress and terminal records, got %s", stdout.String())
	}
	for _, line := range lines {
		var record map[string]any
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatalf("invalid JSONL record %q: %v", line, err)
		}
		if _, ok := record["ok"]; !ok {
			t.Fatalf("record is outside the shared stream schema: %s", line)
		}
	}
	var terminal struct {
		OK   bool `json:"ok"`
		Data any  `json:"data"`
		Meta struct {
			Stream struct {
				Terminal bool `json:"terminal"`
				ExitCode int  `json:"exitCode"`
			} `json:"stream"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(lines[len(lines)-1], &terminal); err != nil {
		t.Fatal(err)
	}
	if !terminal.OK || terminal.Data != nil || !terminal.Meta.Stream.Terminal || terminal.Meta.Stream.ExitCode != 0 {
		t.Fatalf("terminal record = %s", lines[len(lines)-1])
	}
}

// case: S-179.25
func TestPlanRejectsExplicitEmptyProviderValuesAtExecuteBoundary(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	index := filepath.Join(t.TempDir(), "release-index.json")
	source := testReleaseCatalog(t, "2.0.0")
	source.Platforms[0].Profiles = map[string]contracts.ServiceGraph{"default": {PlatformVersion: "2.0.0"}}
	source.Platforms[0].Host = testHostOnFreePort(t)
	release, err := sealTestCatalog(t, source)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(index, data, 0o600); err != nil {
		t.Fatal(err)
	}

	root := newRootCommand()
	base := []string{"plan", "--index", index, "--platform-root", filepath.Join(t.TempDir(), "platform"), "--platform-version", "2.0.0", "--policy", string(contracts.PolicyCompatible)}
	inputs := [][]string{{"--provider", ""}, {"--provider", "", "--provider", "x=y"}, {"--provider", "x=y", "--provider", ""}}
	var diagnosticLine string
	var humanLine string
	for _, providerArgs := range inputs {
		var stdout, stderr bytes.Buffer
		args := append(append([]string(nil), base...), providerArgs...)
		args = append(args, "--json")
		code := clikitcommand.Execute(root, args, &stdout, &stderr)
		var envelope struct {
			OK    bool `json:"ok"`
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(stdout.Bytes(), &envelope); err != nil {
			t.Fatalf("--provider input %q JSON = %s (exit %d): %v", providerArgs, stdout.String(), code.Code(), err)
		}
		if code.Code() != 2 || envelope.OK || envelope.Error.Code != "KB_RUNTIME_INPUT_INVALID" {
			t.Fatalf("--provider input %q = exit %d, result %#v, stderr=%s", providerArgs, code.Code(), envelope, stderr.String())
		}
		if diagnosticLine == "" {
			diagnosticLine = envelope.Error.Message
		} else if envelope.Error.Message != diagnosticLine {
			t.Fatalf("--provider input %q message = %q, want %q", providerArgs, envelope.Error.Message, diagnosticLine)
		}
		var humanOut, humanErr bytes.Buffer
		humanArgs := append(append([]string(nil), base...), providerArgs...)
		if code := clikitcommand.Execute(root, humanArgs, &humanOut, &humanErr); code.Code() != 2 {
			t.Fatalf("human --provider input %q exit = %d, stdout=%s stderr=%s", providerArgs, code.Code(), humanOut.String(), humanErr.String())
		}
		gotHumanLine := strings.SplitN(strings.TrimSpace(humanOut.String()+humanErr.String()), "\n", 2)[0]
		if humanLine == "" {
			humanLine = gotHumanLine
		} else if gotHumanLine != humanLine {
			t.Fatalf("human --provider input %q line = %q, want %q", providerArgs, gotHumanLine, humanLine)
		}
	}
	if !strings.Contains(humanLine, diagnosticLine) {
		t.Fatalf("human line %q does not contain diagnostic %q", humanLine, diagnosticLine)
	}

	var absentOut, absentErr bytes.Buffer
	if code := clikitcommand.Execute(root, append(append([]string(nil), base...), "--json"), &absentOut, &absentErr); code.Code() != 0 {
		t.Fatalf("absent provider plan exit = %d, stdout=%s stderr=%s", code.Code(), absentOut.String(), absentErr.String())
	}
	var planEnvelope struct {
		OK   bool `json:"ok"`
		Data struct {
			Request struct {
				ProviderPreferences map[string]string `json:"providerPreferences"`
			} `json:"request"`
		} `json:"data"`
	}
	if err := json.Unmarshal(absentOut.Bytes(), &planEnvelope); err != nil {
		t.Fatalf("absent provider plan JSON = %s: %v", absentOut.String(), err)
	}
	if !planEnvelope.OK || len(planEnvelope.Data.Request.ProviderPreferences) != 0 {
		t.Fatalf("absent provider preferences = %#v, response %s", planEnvelope.Data.Request.ProviderPreferences, absentOut.String())
	}
}

// case: S-203.7, S-203.13
func TestJSONInstallFailureEndsWithTerminalRecord(t *testing.T) {
	var stdout bytes.Buffer
	cmd := &cobra.Command{Use: "kb-create install"}
	cmd.SetOut(&stdout)
	descriptor, _ := lookupOperationDescriptor("install")
	err := descriptorTestCall(cmd, descriptor, operationTestSetup{Operation: "install", JSON: true})
	if code, ok := result.StreamExitCode(err); !ok || code != diag.ExitCode(diag.New(contracts.CodeInputRequired, "required")) {
		t.Fatalf("stream result = %v, %v; out=%s", code, ok, stdout.String())
	}
	lines := bytes.Split(bytes.TrimSpace(stdout.Bytes()), []byte("\n"))
	if len(lines) != 1 {
		t.Fatalf("expected one terminal failure record, got %s", stdout.String())
	}
	var failure struct {
		OK    bool `json:"ok"`
		Error struct {
			Code          string `json:"code"`
			CorrelationID string `json:"correlationId"`
		} `json:"error"`
	}
	if err := json.Unmarshal(lines[0], &failure); err != nil {
		t.Fatal(err)
	}
	if failure.OK || failure.Error.Code != "KB_INSTALL_INPUT_REQUIRED" || failure.Error.CorrelationID == "" {
		t.Fatalf("typed stream failure = %s", lines[0])
	}
	var terminal struct {
		Meta struct {
			Stream struct {
				Terminal bool `json:"terminal"`
				ExitCode int  `json:"exitCode"`
			} `json:"stream"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(lines[0], &terminal); err != nil {
		t.Fatal(err)
	}
	if !terminal.Meta.Stream.Terminal || terminal.Meta.Stream.ExitCode != 2 {
		t.Fatalf("terminal record = %s", lines[0])
	}
}

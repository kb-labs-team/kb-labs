package v2cli

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	clikitcommand "github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/stream"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/doctor"
	"github.com/spf13/cobra"
)

func TestCataloguedFailureUsesSharedExitStatusForEveryRegisteredCommand(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KB_HOME", filepath.Join(home, ".kb"))
	failures := []*diag.Diag{
		contracts.NewDiag("KB_RUNTIME_INPUT_INVALID", "invalid invocation", "check input", nil),
		contracts.NewDiag("KB_RUNTIME_UNEXPECTED", "operation failed", "inspect diagnostics", nil),
	}
	original := make([]func(context.Context, *cobra.Command, *commandFlagReader, commandDependencies) (any, *diag.Diag), len(operationDescriptors))
	for i := range operationDescriptors {
		original[i] = operationDescriptors[i].Handler
	}
	t.Cleanup(func() {
		for i := range operationDescriptors {
			operationDescriptors[i].Handler = original[i]
		}
	})

	root := newRootCommand()
	registered := registeredCommands(root)
	if len(registered) != len(operationDescriptors) {
		t.Fatalf("registered commands = %d, descriptors = %d", len(registered), len(operationDescriptors))
	}
	for _, failure := range failures {
		want := diag.ExitCode(failure)
		for _, command := range registered {
			command := command
			descriptor, ok := lookupOperationDescriptor(command.Name())
			if !ok {
				t.Fatalf("registered command %q has no descriptor", command.Name())
			}
			for i := range operationDescriptors {
				d := operationDescriptors[i]
				operationDescriptors[i].Handler = func(_ context.Context, cmd *cobra.Command, _ *commandFlagReader, _ commandDependencies) (any, *diag.Diag) {
					if d.JSONStream {
						writer := stream.New(clikitcommand.StreamWriter(cmd))
						if err := writer.Fail(failure); err != nil {
							return nil, diag.Wrap(err, "KB_RUNTIME_UNEXPECTED", "failure output failed")
						}
						if err := writer.Finish(writer.ExitStatus()); err != nil {
							return nil, diag.Wrap(err, "KB_RUNTIME_UNEXPECTED", "failure output failed")
						}
						return streamCompletion{ExitStatus: writer.ExitStatus()}, nil
					}
					return nil, failure
				}
			}
			t.Run(failure.Code+"/"+command.Name(), func(t *testing.T) {
				var stdout, stderr bytes.Buffer
				code := clikitcommand.Execute(newRootCommand(), []string{command.Name(), "--json"}, &stdout, &stderr)
				if code != want {
					t.Fatalf("exit = %d, want %d: stdout=%s stderr=%s", code.Code(), want.Code(), stdout.String(), stderr.String())
				}
				if descriptor.JSONStream {
					lines := bytes.Split(bytes.TrimSpace(stdout.Bytes()), []byte("\n"))
					if len(lines) != 1 {
						t.Fatalf("stream records = %d, want terminal error: %s", len(lines), stdout.String())
					}
					var records []struct {
						OK    bool `json:"ok"`
						Error struct {
							Code string `json:"code"`
						} `json:"error"`
						Meta struct {
							Stream struct {
								Terminal bool `json:"terminal"`
								ExitCode int  `json:"exitCode"`
							} `json:"stream"`
						} `json:"meta"`
					}
					for _, line := range lines {
						var record struct {
							OK    bool `json:"ok"`
							Error struct {
								Code string `json:"code"`
							} `json:"error"`
							Meta struct {
								Stream struct {
									Terminal bool `json:"terminal"`
									ExitCode int  `json:"exitCode"`
								} `json:"stream"`
							} `json:"meta"`
						}
						if err := json.Unmarshal(line, &record); err != nil {
							t.Fatal(err)
						}
						records = append(records, record)
					}
					if records[0].Error.Code != failure.Code || records[0].OK || !records[0].Meta.Stream.Terminal || records[0].Meta.Stream.ExitCode != want.Code() {
						t.Fatalf("stream records do not preserve %s/status %d: %s", failure.Code, want.Code(), stdout.String())
					}
					return
				}
				var envelope struct {
					Error struct {
						Code string `json:"code"`
					} `json:"error"`
				}
				if err := json.Unmarshal(stdout.Bytes(), &envelope); err != nil || envelope.Error.Code != failure.Code {
					t.Fatalf("document failure = %s (%v)", stdout.String(), err)
				}
			})
		}
	}
}

func TestEveryOperationUsesJSONAndHumanOutputBoundary(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KB_HOME", filepath.Join(home, ".kb"))
	t.Setenv("KB_PLATFORM_ROOT", "")
	t.Setenv("KB_NET_OFFSET", "")

	registered := make(map[string]struct{}, len(operationDescriptors))
	for _, descriptor := range operationDescriptors {
		descriptor := descriptor
		registered[descriptor.Name] = struct{}{}
		t.Run(descriptor.Name, func(t *testing.T) {
			t.Run("json", func(t *testing.T) {
				var stdout, stderr bytes.Buffer
				code := clikitcommand.Execute(newRootCommand(), []string{descriptor.Name, "--json"}, &stdout, &stderr)
				if code.Code() < 0 || code.Code() > 2 {
					t.Fatalf("exit code = %d", code.Code())
				}
				var envelope map[string]any
				if err := json.Unmarshal(stdout.Bytes(), &envelope); err != nil {
					for _, line := range bytes.Split(bytes.TrimSpace(stdout.Bytes()), []byte("\n")) {
						var record map[string]any
						if streamErr := json.Unmarshal(line, &record); streamErr != nil {
							t.Fatalf("JSON result and records are invalid: %v / %v; stdout=%q stderr=%q", err, streamErr, stdout.String(), stderr.String())
						}
						if _, ok := record["ok"]; !ok {
							t.Fatalf("JSON result record has no shared ok field: %s", line)
						}
					}
					return
				}
				if _, ok := envelope["ok"]; !ok {
					t.Fatalf("JSON result has no shared ok field: %s", stdout.String())
				}
			})

			t.Run("human", func(t *testing.T) {
				var stdout, stderr bytes.Buffer
				code := clikitcommand.Execute(newRootCommand(), []string{descriptor.Name}, &stdout, &stderr)
				if code.Code() < 0 || code.Code() > 2 {
					t.Fatalf("exit code = %d", code.Code())
				}
				output := stdout.String() + stderr.String()
				if strings.TrimSpace(output) == "" {
					t.Fatal("human result is empty")
				}
				if json.Valid(bytes.TrimSpace(stdout.Bytes())) {
					t.Fatalf("human result fell back to a raw JSON document: %s", stdout.String())
				}
			})
		})
	}
	if len(registered) != len(operationDescriptors) {
		t.Fatalf("operation output coverage has %d entries for %d registered descriptors", len(registered), len(operationDescriptors))
	}
}

func TestUpdateHumanOutputRendersPendingRestartFields(t *testing.T) {
	pending := &contracts.PendingRestart{Services: []contracts.PendingRestartService{{ID: "gateway", RunningVersion: "1.0.0"}},
		InstalledVersion: "2.0.0", Command: contracts.ShellCommand("kb-create", "restart", "--platform-root", "/opt/kb-platform")}
	got := renderUpdate(updateCommandResult{PendingRestart: pending})
	want := "Platform update completed.\nPending restart: gateway (running 1.0.0); installed 2.0.0. Run " + contracts.ShellCommand("kb-create", "restart", "--platform-root", "/opt/kb-platform")
	if got != want {
		t.Fatalf("update human output = %q, want %q", got, want)
	}
	encoded, err := json.Marshal(pending)
	if err != nil {
		t.Fatal(err)
	}
	var machine map[string]any
	if err := json.Unmarshal(encoded, &machine); err != nil {
		t.Fatal(err)
	}
	if machine["installedVersion"] != "2.0.0" || machine["command"] != pending.Command {
		t.Fatalf("pendingRestart JSON = %s", encoded)
	}
}

func TestOperationHumanRenderersMatchGoldenOutput(t *testing.T) {
	status := map[string]any{"installed": true, "running": false, "reachable": false,
		"installation": map[string]any{"platformChannel": "stable", "platformVersion": "1.2.3"}}
	diagnosis := doctorCommandResult{Status: "healthy", Response: doctor.Response{PlatformChannel: "stable", PlatformVersion: "1.2.3"}}
	goldens := map[string]struct {
		value any
		want  string
	}{
		"install":   {nil, "Platform installation completed."},
		"plan":      {planResult{}, "Install plan resolved."},
		"apply":     {applyCommandResult{}, "Platform installation completed."},
		"status":    {status, "Installed: true\nPlatform channel: stable\nPlatform version: 1.2.3\nRunning: false\nReachable: false"},
		"doctor":    {diagnosis, "Platform diagnosis completed.\nStatus: healthy\nPlatform channel: stable\nPlatform version: 1.2.3"},
		"start":     {nil, "KB Labs host started."},
		"stop":      {nil, "KB Labs host stopped."},
		"restart":   {nil, "KB Labs host restarted."},
		"update":    {nil, "Platform update completed."},
		"uninstall": {nil, "Platform uninstalled."},
		"rollback":  {nil, "Platform rollback completed."},
		"supervise": {nil, "KB Labs host supervisor started."},
		"version":   {nil, "kb-create " + buildVersion + " (commit " + buildCommit + ")"},
	}
	if len(goldens) != len(operationDescriptors) {
		t.Fatalf("golden count = %d, registered command count = %d", len(goldens), len(operationDescriptors))
	}
	for _, descriptor := range operationDescriptors {
		golden, ok := goldens[descriptor.Name]
		if !ok {
			t.Errorf("operation %q has no human renderer golden", descriptor.Name)
			continue
		}
		if got := descriptor.Human(golden.value); got != golden.want {
			t.Errorf("%s human output = %q, want %q", descriptor.Name, got, golden.want)
		}
	}
	if got := renderUpdate(updateCommandResult{AlreadyUpToDate: true}); got != "Platform is already up to date." {
		t.Fatalf("up-to-date update output = %q", got)
	}
}

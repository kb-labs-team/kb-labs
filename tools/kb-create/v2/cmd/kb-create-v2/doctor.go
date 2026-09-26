package v2cli

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/doctor"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/installed"
	"github.com/kb-labs/create/v2/lifecycle"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/supervisor"
	"github.com/kb-labs/create/v2/swap"
)

// recoverRequest is `doctor --recover`: the flags the launcher hands to the
// platform's recovery tool. The launcher validates none of them; the tool owns
// what an administrator account is.
type recoverRequest struct {
	Enabled       bool
	Email, Tenant string
	PasswordStdin bool
	Generate      bool
	Yes           bool
	JSON          bool
}

func (r recoverRequest) args() []string {
	var args []string
	if r.Email != "" {
		args = append(args, "--email", r.Email)
	}
	if r.Tenant != "" {
		args = append(args, "--tenant", r.Tenant)
	}
	for _, flag := range []struct {
		name string
		set  bool
	}{{"--password-stdin", r.PasswordStdin}, {"--generate", r.Generate}, {"--yes", r.Yes}, {"--json", r.JSON}} {
		if flag.set {
			args = append(args, flag.name)
		}
	}
	return args
}

// runDoctor reports two separate things: whether the installation on disk is
// complete and runnable, and whether the platform it runs is healthy. With
// --fix it repairs safe manifest defaults and restarts the host; with --recover
// it hands the administrator account to the platform's recovery tool.
func (i invocation) runDoctor(output *os.File) int {
	if i.Recover.Enabled {
		return i.runRecover(output)
	}
	var input doctor.Input
	var err error
	if i.DoctorInput != "" {
		data, readErr := os.ReadFile(i.DoctorInput)
		if readErr != nil {
			write(output, failure("KB_INSTALL_INPUT_REQUIRED", "doctor input could not be read", "supply a readable V2 doctor input JSON file", readErr))
			return 2
		}
		input, err = doctor.Decode(data)
	} else {
		if i.PlatformRoot == "" {
			write(output, failure("KB_INSTALL_INPUT_REQUIRED", "--platform-root is required for automatic doctor", "pass the V2 platform root or a manifest-derived --doctor-input", nil))
			return 2
		}
		input, err = automaticDoctorInput(i.PlatformRoot)
	}
	if err != nil {
		write(output, failure("KB_INSTALL_DOCTOR_INPUT_INVALID", "installed manifest diagnostics could not be prepared", "install exact V2 artifacts that ship matching V2 manifests", err))
		return 2
	}
	findings := doctor.Diagnose(input.Manifests, input.Configured)
	response := doctor.Response{Findings: findings, Repair: doctor.PlanRepair(findings)}
	if i.PlatformRoot != "" {
		state, stateErr := host.StateHome()
		if stateErr != nil {
			write(output, map[string]any{"ok": false, "error": asLauncherError(stateErr)})
			return 2
		}
		installation := doctor.InspectInstallation(i.PlatformRoot, state)
		platform := i.inspectPlatform(state)
		response.Installation, response.Platform = &installation, &platform
	}
	response.OK = len(findings) == 0 && (response.Installation == nil || response.Installation.OK) && (response.Platform == nil || response.Platform.OK)
	if i.DoctorFix {
		if i.PlatformRoot == "" {
			write(output, failure("KB_INSTALL_INPUT_REQUIRED", "--platform-root is required with --fix", "pass the V2 platform root that owns the active receipt", nil))
			return 2
		}
		return i.runDoctorFix(output, response)
	}
	write(output, response)
	if !response.OK {
		return 1
	}
	return 0
}

// inspectPlatform observes the running host. An installation whose host cannot
// even be built is reported as such rather than aborting the whole report.
func (i invocation) inspectPlatform(state host.State) doctor.Section {
	runner, err := host.NewRunner(i.PlatformRoot, state)
	if err != nil {
		return doctor.NewSection([]doctor.Check{{ID: "host-process", Detail: "The host cannot be inspected: " + err.Error(), Hint: "Repair the installation first."}})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	status, err := runner.Status(ctx)
	if err != nil {
		return doctor.NewSection([]doctor.Check{{ID: "host-process", Detail: "The host status cannot be read: " + err.Error()}})
	}
	return doctor.InspectPlatform(ctx, status, nil)
}

// runDoctorFix applies manifest-declared safe defaults under a snapshot and
// restarts the host so it reads them; a host that no longer starts is rolled
// back like a failed update.
func (i invocation) runDoctorFix(output *os.File, response doctor.Response) int {
	root := i.PlatformRoot
	state, err := host.StateHome()
	if err != nil {
		write(output, map[string]any{"ok": false, "error": asLauncherError(err)})
		return 2
	}
	release, err := state.AcquireOperation("doctor-fix")
	if err != nil {
		write(output, map[string]any{"ok": false, "error": asLauncherError(err)})
		return 2
	}
	defer release()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	correlationID := fmt.Sprintf("doctor-fix-%d", time.Now().UTC().UnixNano())
	command := hostCommand{PlatformRoot: root, Executable: i.Executable, Version: buildVersion}
	var snapshot contracts.Snapshot
	result, err := swap.Run(ctx, lifecycleHost{command: command, state: state}, swap.Operation{
		Name:            "repair",
		PreviousVersion: installedVersion(root),
		Change: func(context.Context, bool) (string, error) {
			var fixErr error
			snapshot, fixErr = runtime.DoctorFix(root, response.Repair, runtime.Dependencies{})
			return snapshot.ID, fixErr
		},
		Restore: func(_ context.Context, id string) error {
			_, restoreErr := lifecycle.Rollback(root, id, nil)
			return restoreErr
		},
	})
	if err != nil {
		writeLauncherFailure(output, root, correlationID, "", asLauncherError(err), nil)
		return 1
	}
	write(output, map[string]any{"ok": true, "operation": "doctor-fix", "findings": response.Findings, "snapshot": snapshotSummary(snapshot), "hostRestarted": result.WasRunning})
	return 0
}

// runRecover runs the platform's recovery tool with the host stopped, so the
// tool is the only writer of the platform database. The launcher supplies the
// host's environment and working directory, and the terminal (a password may
// arrive on stdin); it does not interpret the tool's result beyond its status.
func (i invocation) runRecover(output *os.File) int {
	command := i.hostCommand(output)
	command.JSON = i.Recover.JSON
	command.Err = os.Stderr
	runner, state, setupErr := command.setup()
	if setupErr != nil {
		return command.fail(2, setupErr)
	}
	release, err := state.AcquireOperation("recover")
	if err != nil {
		return command.fail(1, asLauncherError(err))
	}
	defer release()
	if runner.Spec.Recover == nil {
		return command.fail(1, contracts.NewLauncherError(contracts.CodeRecoveryUnavailable, "The installed platform does not ship a recovery tool.", "Update the platform with \"kb-create update\", then retry.", nil))
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	status, _ := runner.Status(ctx)
	if _, supervised := supervisor.LivePID(state); supervised || status.State != host.StateStopped {
		return command.fail(1, contracts.NewLauncherError(contracts.CodeRecoveryHostRunning, "Recovery needs the host to be stopped, but it is running.", "Run \"kb-create stop\", recover, then \"kb-create start\".", nil))
	}
	code, err := runner.RunTool(ctx, *runner.Spec.Recover, i.Recover.args(), os.Stdin, output, os.Stderr)
	if err != nil {
		return command.fail(1, contracts.NewLauncherError(contracts.CodeRecoveryFailed, "The platform's recovery tool could not be run.", "Inspect the platform installation with \"kb-create doctor\".", err))
	}
	return code
}

func automaticDoctorInput(platformRoot string) (doctor.Input, error) {
	active, err := receipt.Read(platformRoot)
	if err != nil {
		return doctor.Input{}, fmt.Errorf("read active V2 receipt: %w", err)
	}
	manifests, err := installed.LoadAll(platformRoot, active.Plan.Artifacts)
	if err != nil {
		return doctor.Input{}, err
	}
	paths := make([]string, 0)
	for _, manifest := range manifests {
		for _, requirement := range manifest.Requirements {
			if !requirement.Secret {
				paths = append(paths, requirement.Path)
			}
		}
	}
	configured, err := installed.ConfiguredPaths(platformRoot, paths)
	if err != nil {
		return doctor.Input{}, err
	}
	return installed.DoctorInput(platformRoot, active.Plan.Artifacts, configured)
}

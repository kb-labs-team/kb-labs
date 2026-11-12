package v2cli

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	clikitcommand "github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/supervisor"
)

type doctorRecoveryResult struct {
	OK        bool   `json:"ok"`
	Operation string `json:"operation"`
	Recovered bool   `json:"recovered"`
	Output    string `json:"output"`
}

func (doctorRecoveryResult) doctorOperationResult() {}

func executeRecover(inv doctorCommandInput) (doctorRecoveryResult, *diag.Diag) {
	command := hostCommand{PlatformRoot: inv.PlatformRoot, Foreground: inv.Foreground, Executable: inv.Executable, Version: buildVersion}
	runner, state, failure := command.setup("recover")
	if failure != nil {
		return doctorRecoveryResult{}, failure
	}
	interaction := clikitcommand.FromCommand(inv.Command)
	if !inv.Recover.Yes {
		_, confirmFailure := interaction.Confirm(fmt.Sprintf("This will run the platform's administrator recovery tool for %s. Continue? [y/N] ", inv.PlatformRoot), "rerun `"+contracts.ShellCommand("kb-create", "doctor", "--platform-root", inv.PlatformRoot, "--recover", "--yes")+"`")
		if confirmFailure != nil {
			return doctorRecoveryResult{}, confirmFailure
		}
	}
	release, err := state.AcquireOperation("recover")
	if err != nil {
		return doctorRecoveryResult{}, asDiag(err)
	}
	defer release()
	if runner.Spec.Recover == nil {
		return doctorRecoveryResult{}, contracts.NewDiag(contracts.CodeRecoveryUnavailable, "The installed platform does not ship a recovery tool.", "Update the platform with \"kb-create update\", then retry.", nil)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	truth, observeErr := supervisor.Observe(ctx, runner, state)
	if observeErr != nil {
		return doctorRecoveryResult{}, asDiag(observeErr)
	}
	if truth.Kind != supervisor.KindStopped {
		return doctorRecoveryResult{}, contracts.NewDiag(contracts.CodeRecoveryHostRunning, "Recovery needs the host to be stopped, but it is running.", "Run \"kb-create stop\", recover, then \"kb-create start\".", nil)
	}
	var toolOutput bytes.Buffer
	code, err := runner.RunTool(ctx, *runner.Spec.Recover, inv.Recover.args(), interaction.Input(), &toolOutput, interaction.ErrorWriter())
	if err != nil {
		return doctorRecoveryResult{}, contracts.NewDiag(contracts.CodeRecoveryFailed, "The platform's recovery tool could not be run.", "Inspect the platform installation with \"kb-create doctor\".", err)
	}
	if code != 0 {
		failure := contracts.NewDiag(contracts.CodeRecoveryFailed, "The platform recovery tool reported failure.", "Inspect the platform installation with `kb-create doctor`.", nil)
		return doctorRecoveryResult{}, failure
	}
	return doctorRecoveryResult{OK: true, Operation: "recover", Recovered: true, Output: strings.TrimSpace(toolOutput.String())}, nil
}

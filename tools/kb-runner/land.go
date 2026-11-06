//go:build darwin || linux

package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"
)

func landCommand(root runnerRoot, args []string, out, _ io.Writer) (status int, runErr error) {
	fs := flag.NewFlagSet("land", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	statePath := fs.String("state", defaultRunnerState(), "runner state directory")
	streamArg := ""
	remaining := args
	if len(remaining) > 0 && !strings.HasPrefix(remaining[0], "-") {
		streamArg = remaining[0]
		remaining = remaining[1:]
	}
	if err := fs.Parse(remaining); err != nil {
		return 2, fmt.Errorf("%s land: %w; next: %s land --help", root.Name(), err, root.InvocationCommand())
	}
	if streamArg == "" && len(fs.Args()) == 1 {
		streamArg = fs.Arg(0)
	}
	if streamArg == "" || len(fs.Args()) > 0 {
		return 2, fmt.Errorf("%s land: one stream is required; next: %s land --help", root.Name(), root.InvocationCommand())
	}
	resolvedState, err := resolveRunnerState(root, "land", *statePath)
	if err != nil {
		return 2, fmt.Errorf("%s land: invalid runner state path: %w; next: %s land --help", root.Name(), err, root.InvocationCommand())
	}
	*statePath = resolvedState
	store := newSchedulerStore(*statePath)
	lease, err := store.acquireRunLease()
	if err != nil {
		if errors.Is(err, errSchedulerAlreadyRunning) {
			return 2, schedulerAlreadyRunningDiagnostic(root, *statePath)
		}
		return 1, fmt.Errorf("acquire scheduler run lease for land: %w; next: %s sched ps --state %q", err, root.InvocationCommand(), *statePath)
	}
	defer func() { runErr = errors.Join(runErr, releaseRunLease(lease)) }()
	stream, err := store.stream(streamArg)
	if err != nil {
		return 1, fmt.Errorf("%s land: read stream %s: %w", root.Name(), streamArg, err)
	}
	if stream.State != SchedulerAwaitingReview || stream.Submission == nil || stream.Submission.Status != "completed" || stream.Submission.Conclusion != "success" {
		return 2, fmt.Errorf("%s land: stream %s requires accepted review and a passing latest remote verdict; next: %s sched ps --state %q", root.Name(), streamArg, root.InvocationCommand(), *statePath)
	}
	task, err := store.task(stream.TaskID)
	if err != nil {
		return 1, err
	}
	gate := schedulerReviewGate(task, stream)
	if !gate.allowsLand() {
		return 2, fmt.Errorf("%s land: stream %s %s; every required reviewer must ACCEPT; next: %s sched ps --state %q", root.Name(), streamArg, gate.refusal(), root.InvocationCommand(), *statePath)
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: root, state: *statePath})
	landed, _, err := options.landAccepted(task, stream)
	if err != nil {
		return 1, err
	}
	if landed {
		_, err = fmt.Fprintf(out, "landed stream %s\n", task.Stream)
	} else {
		_, err = fmt.Fprintf(out, "stream %s queued; inspect progress with %s sched ps --state %q\n", task.Stream, root.InvocationCommand(), *statePath)
	}
	return 0, err
}

func validateCommitGroups(commits []proposedCommit, groups [][]string) error {
	if len(commits) != 3 || len(groups) != 3 {
		return errors.New("land requires case, tests, and code commit groups")
	}
	for index, group := range groups {
		if len(group) == 0 {
			continue
		}
		subject := strings.TrimSpace(commits[index].Subject)
		if subject == "" || subject == "-" {
			return fmt.Errorf("%d %s files exist but the %s commit subject is missing", len(group), commits[index].Kind, commits[index].Kind)
		}
		if !strings.Contains(subject, ": ") {
			return fmt.Errorf("%s commit subject %q must use conventional 'type: subject' form", commits[index].Kind, subject)
		}
	}
	return nil
}

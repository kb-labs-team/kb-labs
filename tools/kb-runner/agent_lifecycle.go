//go:build darwin || linux

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func agentLifecycleCommand(root runnerRoot, args []string, out io.Writer) (int, error) {
	operation := args[0]
	if operation != "launch" && operation != "resume" && operation != "review" && operation != "rework" {
		return 2, fmt.Errorf("%s agent: unsupported operation %q; next: %s agent --help", root.Name(), operation, root.InvocationCommand())
	}
	fs := flag.NewFlagSet("agent "+operation, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	statePath := fs.String("state", defaultRunnerState(), "runner state directory")
	vendor := fs.String("vendor", "", "require the persisted task vendor")
	remaining := args[1:]
	streamArg := ""
	optionArgs := make([]string, 0, len(remaining))
	for index := 0; index < len(remaining); index++ {
		arg := remaining[index]
		if arg == "--state" || arg == "--vendor" {
			if index+1 == len(remaining) {
				return 2, fmt.Errorf("%s agent %s: %s requires a value; next: %s agent --help", root.Name(), operation, arg, root.InvocationCommand())
			}
			optionArgs = append(optionArgs, arg, remaining[index+1])
			index++
			continue
		}
		if strings.HasPrefix(arg, "-") {
			optionArgs = append(optionArgs, arg)
			continue
		}
		if streamArg != "" {
			return 2, fmt.Errorf("%s agent %s: one stream is required; next: %s agent --help", root.Name(), operation, root.InvocationCommand())
		}
		streamArg = arg
	}
	if err := fs.Parse(optionArgs); err != nil {
		return 2, fmt.Errorf("%s agent %s: %w; next: %s agent --help", root.Name(), operation, err, root.InvocationCommand())
	}
	if streamArg == "" || len(fs.Args()) > 0 {
		return 2, fmt.Errorf("%s agent %s: one stream is required; next: %s agent --help", root.Name(), operation, root.InvocationCommand())
	}
	resolvedState, err := resolveRunnerState(root, "agent "+operation, *statePath)
	if err != nil {
		return 2, err
	}
	*statePath = resolvedState
	streamName := streamArg
	store := newSchedulerStore(*statePath)
	stream, err := store.stream(streamName)
	if err != nil {
		return 1, fmt.Errorf("%s agent %s: read stream %s: %w", root.Name(), operation, streamName, err)
	}
	worker, err := store.task(stream.TaskID)
	if err != nil {
		return 1, fmt.Errorf("%s agent %s: read worker task for %s: %w", root.Name(), operation, streamName, err)
	}
	if *vendor != "" && *vendor != worker.Vendor {
		return 2, fmt.Errorf("%s agent %s: stream %s is assigned to vendor %s, not %s; next: %s sched ps --state %q", root.Name(), operation, streamName, worker.Vendor, *vendor, root.InvocationCommand(), *statePath)
	}
	selected := map[string]bool{}
	switch operation {
	case "launch", "resume", "rework":
		if worker.Role != schedulerWorkerRole || stream.State != SchedulerReady {
			return 2, fmt.Errorf("%s agent %s: stream %s must have a READY worker task; next: %s sched ps --state %q", root.Name(), operation, streamName, root.InvocationCommand(), *statePath)
		}
		if operation == "launch" && stream.ThreadID != "" {
			return 2, fmt.Errorf("%s agent launch: stream %s already has a session; use %s agent resume %s --state %q", root.Name(), streamName, root.InvocationCommand(), streamName, *statePath)
		}
		if operation == "resume" && stream.ThreadID == "" {
			return 2, fmt.Errorf("%s agent resume: stream %s has no session; use %s agent launch %s --state %q", root.Name(), streamName, root.InvocationCommand(), streamName, *statePath)
		}
		if operation == "rework" && (stream.ThreadID == "" || stream.RejectRounds == 0) {
			return 2, fmt.Errorf("%s agent rework: stream %s has no rejected session to continue; next: %s sched ps --state %q", root.Name(), streamName, root.InvocationCommand(), *statePath)
		}
		selected[worker.ID] = true
	case "review":
		if stream.State != SchedulerAwaitingReview {
			return 2, fmt.Errorf("%s agent review: stream %s is not awaiting review; next: %s sched ps --state %q", root.Name(), streamName, root.InvocationCommand(), *statePath)
		}
		tasks, err := store.tasks()
		if err != nil {
			return 1, err
		}
		for _, task := range tasks {
			if task.Role == schedulerReviewRole && len(task.DependsOn) == 1 && task.DependsOn[0] == worker.ID {
				reviewState, err := store.stream(task.Stream)
				if err != nil {
					return 1, err
				}
				if reviewState.State == SchedulerReady {
					selected[task.ID] = true
				}
			}
		}
		if len(selected) == 0 {
			return 2, fmt.Errorf("%s agent review: stream %s has no READY review task; next: %s sched ps --state %q", root.Name(), streamName, root.InvocationCommand(), *statePath)
		}
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: root, state: *statePath, slots: 5, supervisor: root.supervisor})
	ctx, cancelLifecycle := schedulerLifecycleContext(context.Background())
	defer cancelLifecycle()
	if err := options.runSelected(ctx, selected); err != nil {
		return 1, err
	}
	_, err = fmt.Fprintf(out, "completed %s for stream %s\n", operation, streamName)
	return 0, err
}

func (options schedulerRunOptions) runSelected(ctx context.Context, selected map[string]bool) error {
	if len(selected) == 0 {
		return errors.New("no scheduler tasks selected")
	}
	options.selected = selected
	results := make(chan schedulerWorkerResult, len(selected))
	started, err := options.dispatch(ctx, results, len(selected), nil)
	if err != nil {
		return err
	}
	if started != len(selected) {
		return fmt.Errorf("scheduler admitted %d of %d selected tasks", started, len(selected))
	}
	for range started {
		result := <-results
		if err := options.finishWorker(result); err != nil {
			return err
		}
	}
	return nil
}

func composeRoundPrompt(message, definition string) string {
	return strings.TrimRight(message, "\n") + "\n\n" + strings.TrimLeft(definition, "\n")
}

func prepareRoundPrompt(task SchedulerTask, state string, stateIO runnerStateStore) (string, error) {
	message, err := os.ReadFile(task.Prompt)
	if err != nil {
		return "", fmt.Errorf("read worker round message: %w", err)
	}
	definition, err := readRunnerTemplate(runnerDefinitionOfDone)
	if err != nil {
		return "", fmt.Errorf("read embedded definition of done: %w", err)
	}
	path := filepath.Join(state, "sched", "prompts", task.ID+"-round.md")
	if err := stateIO.AtomicWrite(path, []byte(composeRoundPrompt(string(message), string(definition)))); err != nil {
		return "", fmt.Errorf("render worker round prompt: %w", err)
	}
	return path, nil
}

func schedulerMessagePath(task SchedulerTask) string {
	if task.Vendor == "zcode" && task.Role == schedulerWorkerRole {
		return filepath.Join(task.Workdir, "reports", task.Stream+".md")
	}
	return ""
}

func resolveReviewVerdict(report []byte) (string, error) {
	first, body, err := readReportBytes(report)
	if err != nil {
		return "", err
	}
	if first == "ACCEPT" || first == "REJECT" {
		return first, nil
	}
	for _, line := range strings.Split(string(body), "\n") {
		verdict := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "Verdict:"))
		if verdict == "ACCEPT" || verdict == "REJECT" {
			return verdict, nil
		}
	}
	return "", errors.New("review output has no ACCEPT or REJECT verdict")
}

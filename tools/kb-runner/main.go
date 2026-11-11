//go:build darwin || linux

package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/result"
	"github.com/kb-labs/kb-runner/internal/proc"
)

const runnerVersion = "kb-runner version 1"

func main() {
	command.Exit(executeCommand(os.Args[1:], os.Stdout, os.Stderr))
}

func executeCommand(args []string, stdout, stderr io.Writer) diag.ExitStatus {
	return executeInvocation(os.Args[0], args, stdout, stderr)
}

func executeInvocation(invocation string, args []string, stdout, stderr io.Writer) diag.ExitStatus {
	root := runnerRoot{Root: command.InvocationRoot(invocation), invocation: invocation}
	if len(args) == 1 && args[0] == "--version" {
		if _, err := fmt.Fprintln(stdout, runnerVersion); err != nil {
			fmt.Fprintf(stderr, "%s --version: write version output: %v\n", root.Name(), err)
			return diag.ProcessExitStatus(1)
		}
		return diag.SuccessStatus()
	}
	if len(args) > 0 && args[0] == "__agent_worker" {
		code, err := agentStartCommand(root, args[1:], stdout, stderr)
		if err != nil {
			fmt.Fprintln(stderr, err)
		}
		return diag.ProcessExitStatus(code)
	}
	if command.HandleRootHelp(args, root, runnerUsage(), stdout) {
		return diag.SuccessStatus()
	}
	code, err := executeRoot(root, args, stdout, stderr)
	if errors.Is(err, flag.ErrHelp) {
		return diag.SuccessStatus()
	}
	if err != nil {
		var diagnostic *diag.Diag
		if errors.As(err, &diagnostic) {
			diagnostic.Binary = root.Name()
			fmt.Fprintln(stderr, renderDiagnostic(diagnostic))
		} else {
			fmt.Fprintln(stderr, err)
		}
	}
	return diag.ProcessExitStatus(code)
}

func execute(args []string, stdout, stderr io.Writer) (int, error) {
	return executeRoot(runnerRoot{Root: command.InvocationRoot(os.Args[0]), invocation: os.Args[0]}, args, stdout, stderr)
}

type runnerRoot struct {
	command.Root
	invocation string
	executable string
	supervisor schedulerJobSupervisor
}

func (root runnerRoot) Invocation() string { return root.invocation }

func (root runnerRoot) InvocationCommand() string { return shellQuote(root.invocation) }

func (root runnerRoot) startProcess(ctx context.Context, config proc.Config) (*proc.Run, error) {
	return proc.Start(ctx, config)
}

func (root runnerRoot) executablePath() (string, error) {
	if root.executable != "" {
		return root.executable, nil
	}
	return os.Executable()
}

func executeRoot(root runnerRoot, args []string, stdout, stderr io.Writer) (int, error) {
	if len(args) == 0 {
		return 2, fmt.Errorf("usage: %s %s", root.Name(), runnerUsage())
	}
	for _, registered := range runnerCommands {
		if registered.name == args[0] {
			return registered.execute(root, args[1:], stdout, stderr)
		}
	}
	status, _ := command.HandleUnknownCommand(root.Root, args, stdout, stderr, result.ResolveMode(false, false, ""), false)
	return status.Code(), nil
}

type runnerCommand struct {
	name    string
	execute func(runnerRoot, []string, io.Writer, io.Writer) (int, error)
}

var runnerCommands = []runnerCommand{
	{name: "run", execute: runCommand},
	{name: "gate", execute: gateCommand},
	{name: "ps", execute: func(root runnerRoot, args []string, stdout, _ io.Writer) (int, error) {
		return psCommand(root, args, stdout)
	}},
	{name: "wait", execute: waitCommand},
	{name: "events", execute: func(root runnerRoot, args []string, stdout, _ io.Writer) (int, error) {
		return eventsCommand(root, args, stdout)
	}},
	{name: "proc", execute: func(root runnerRoot, args []string, stdout, _ io.Writer) (int, error) {
		return procCommand(root, args, stdout)
	}},
	{name: "quota", execute: quotaCommand},
	{name: "own", execute: func(root runnerRoot, args []string, stdout, _ io.Writer) (int, error) {
		return ownCommand(root, args, stdout)
	}},
	{name: "gc", execute: func(root runnerRoot, args []string, stdout, _ io.Writer) (int, error) {
		return gcCommand(root, args, stdout)
	}},
	{name: "status", execute: statusCommand},
	{name: "limits", execute: limitsCommand},
	{name: "agent", execute: agentCommand},
	{name: "test-channel", execute: testChannelRequestCommand},
	{name: "verify", execute: verifyCommand},
	{name: "worktree", execute: worktreeCommand},
	{name: "hygiene", execute: hygieneCommand},
	{name: "land", execute: landCommand},
	{name: "sched", execute: schedulerCommand},
	{name: "streams", execute: func(root runnerRoot, args []string, stdout, _ io.Writer) (int, error) {
		return streamsCommand(root, args, stdout)
	}},
	{name: "self-install", execute: selfInstallCommand},
}

func runnerUsage() string {
	names := make([]string, len(runnerCommands))
	for index, registered := range runnerCommands {
		names[index] = registered.name
	}
	return "<" + strings.Join(names, "|") + "> [flags]"
}

func procCommand(root runnerRoot, args []string, output io.Writer) (int, error) {
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		_, err := fmt.Fprintf(output, "Usage: %s proc identity <pid> | %s proc inventory --json\n", root.Name(), root.Name())
		if err != nil {
			return 1, fmt.Errorf("kb-runner proc: write usage: %w", err)
		}
		return 0, nil
	}
	if len(args) == 2 && args[0] == "inventory" && args[1] == "--json" {
		entries, err := proc.ProcessInventory()
		if err != nil {
			return 1, procInventoryFailure(root.Name(), root.Invocation(), err)
		}
		if err := json.NewEncoder(output).Encode(entries); err != nil {
			return 1, fmt.Errorf("kb-runner proc inventory: write JSON: %w", err)
		}
		return 0, nil
	}
	if len(args) != 2 || args[0] != "identity" {
		return 2, fmt.Errorf("%s proc: usage: %s proc identity <pid> or proc inventory --json; next: %s proc --help", root.Name(), root.Name(), root.InvocationCommand())
	}
	pid, err := strconv.Atoi(args[1])
	if err != nil || pid <= 0 {
		return 2, fmt.Errorf("%s proc identity: PID %q must be a positive decimal process ID; next: %s proc --help", root.Name(), args[1], root.InvocationCommand())
	}
	identity, alive, err := proc.ProcessIdentity(pid)
	if err != nil {
		return 1, procIdentityFailure(root.Name(), root.Invocation(), pid, err)
	}
	if !alive {
		return 3, fmt.Errorf("%s proc identity: PID %d is not live\nnext: %s proc --help", root.Name(), pid, root.InvocationCommand())
	}
	if _, err := fmt.Fprintln(output, identity); err != nil {
		return 1, fmt.Errorf("kb-runner proc identity: write identity for PID %d: %w", pid, err)
	}
	return 0, nil
}

func procInventoryFailure(rootName, invocation string, err error) error {
	return fmt.Errorf("%s proc inventory: %w\nnext: %s proc --help", rootName, err, shellQuote(invocation))
}

func procIdentityFailure(rootName, invocation string, pid int, err error) error {
	return fmt.Errorf("%s proc identity: cannot inspect PID %d: %w\nnext: %s proc --help", rootName, pid, err, shellQuote(invocation))
}

func runCommand(root runnerRoot, args []string, stdout, stderr io.Writer) (int, error) {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return runCommandWithContext(ctx, root, args, stdout, stderr)
}

func runCommandWithContext(ctx context.Context, root runnerRoot, args []string, stdout, stderr io.Writer) (int, error) {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(stderr)
	tag := fs.String("tag", "", "run label")
	latestTag := fs.String("latest-tag", "", "stable stream key used to resolve the newest run record")
	state := fs.String("state", "", "directory for run records and events")
	stall := fs.Duration("stall", 0, "report no-output intervals at this duration")
	stdoutPath := fs.String("stdout", "", "tee command stdout to this file and the terminal")
	stderrPath := fs.String("stderr", "", "tee command stderr to this file and the terminal")
	stdinPath := fs.String("stdin", "", "read command stdin from this file")
	slotGroup := fs.String("slot-group", "", "serialize starts within this capacity group")
	slots := fs.Int("slots", 0, "maximum live runs allowed in the slot group")
	slotWeight := fs.Int("slot-weight", 0, "tokens acquired in the slot group (default 1)")
	waitGate := fs.String("wait-gate", "", "wait for this named gate to be released")
	holdGate := fs.String("hold-gate", "", "hold this named gate for the command tree lifetime")
	minFree := fs.String("min-free", "", "minimum free bytes on the state filesystem")
	costKey := fs.String("cost-key", "", "key used to learn completed run resource costs")
	cost := fs.String("cost", "light", "expected resource cost class: light or heavy")
	priority := fs.Int("priority", 0, "run priority; lower values are paused first under hard pressure")
	memory := fs.String("mem", "", "declared memory reservation, for example 2G")
	cpus := fs.String("cpus", "", "minimum or minimum..maximum CPU cores")
	disk := fs.String("disk", "", "declared disk growth reservation, for example 3G")
	var envVars stringListFlag
	fs.Var(&envVars, "env", "add environment entry KEY=VALUE (repeatable)")
	var keepPaths pathListFlag
	fs.Var(&keepPaths, "keep", "keep this output path after run cleanup (repeatable)")
	if err := fs.Parse(args); err != nil {
		return 2, err
	}
	command := fs.Args()
	if len(command) > 0 && command[0] == "--" {
		command = command[1:]
	}
	if len(command) == 0 {
		return 2, fmt.Errorf("%s run: provide a command after --; next: %s run --help", root.Name(), root.InvocationCommand())
	}
	if *tag == "" || *state == "" || *stall <= 0 || *stdoutPath == "" || *stderrPath == "" {
		return 2, fmt.Errorf("%s run: --tag, --state, positive --stall, --stdout, and --stderr are required; next: %s run --help", root.Name(), root.InvocationCommand())
	}
	resolvedState, err := resolveRunnerState(root, "run", *state)
	if err != nil {
		return 2, fmt.Errorf("%s run: invalid runner state path: %w; next: %s run --help", root.Name(), err, root.InvocationCommand())
	}
	*state = resolvedState
	costClass, err := proc.ParseCostClass(*cost)
	if err != nil {
		return 2, fmt.Errorf("%s run: %w; next: %s run --help", root.Name(), err, root.InvocationCommand())
	}
	var minFreeBytes uint64
	if *minFree == "" {
		minFreeBytes = 0
	} else {
		minFreeBytes, err = strconv.ParseUint(*minFree, 10, 64)
	}
	if err != nil {
		return 2, fmt.Errorf("%s run: invalid --min-free: %w; next: %s run --help", root.Name(), err, root.InvocationCommand())
	}
	memBytes, err := proc.ParseResourceSize(*memory)
	if *memory == "" {
		memBytes = 0
		err = nil
	}
	if err != nil {
		return 2, fmt.Errorf("%s run: invalid --mem: %w; next: %s run --help", root.Name(), err, root.InvocationCommand())
	}
	diskBytes, err := proc.ParseResourceSize(*disk)
	if *disk == "" {
		diskBytes = 0
		err = nil
	}
	if err != nil {
		return 2, fmt.Errorf("%s run: invalid --disk: %w; next: %s run --help", root.Name(), err, root.InvocationCommand())
	}
	cpuMin, cpuMax, err := parseCPURange(*cpus)
	if err != nil {
		return 2, fmt.Errorf("%s run: invalid --cpus: %w; next: %s run --help", root.Name(), err, root.InvocationCommand())
	}
	workdir, err := os.Getwd()
	if err != nil {
		return 1, fmt.Errorf("%s run: inspect current workdir for lease: %w", root.Name(), err)
	}
	leasePaths, err := runnerWorktreeLeasePaths(workdir)
	if err != nil {
		return 1, fmt.Errorf("%s run: acquire owned-worktree lease: %w", root.Name(), err)
	}
	keepPaths = append(keepPaths, *stdoutPath, *stderrPath)
	run, err := root.startProcess(ctx, proc.Config{StateDir: *state, Tag: *tag, LatestTag: *latestTag, Stall: *stall, StdoutPath: *stdoutPath, StderrPath: *stderrPath, StdinPath: *stdinPath, SlotGroup: *slotGroup, Slots: *slots, SlotWeight: *slotWeight, WaitGate: *waitGate, HoldGate: *holdGate, MinFree: minFreeBytes, CostKey: *costKey, CostClass: costClass, Priority: *priority, MemoryBytes: memBytes, CPUsMin: cpuMin, CPUsMax: cpuMax, DiskBytes: diskBytes, Env: envVars, Keep: keepPaths, SharedLeasePaths: leasePaths, Command: command})
	if err != nil {
		return 1, fmt.Errorf("%s run: %w\nInspect state directory access before retrying:\nnext: ls -ld %s\nnext: %s", root.Name(), err, shellQuote(*state), shellJoin(os.Args))
	}
	if err := run.Wait(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code := exitErr.ExitCode()
			if code == 0 {
				return 0, nil
			}
			return code, supervisedCommandFailure(root, *state, code)
		}
		return 1, keeperWaitFailure(root, *state, err)
	}
	completed, err := proc.WaitRunID(context.Background(), *state, run.RunID)
	if err != nil {
		return 1, keeperWaitFailure(root, *state, err)
	}
	if completed.Status != proc.StatusCompleted {
		return renderWaitOutcome(completed, *state, stdout, root.Invocation())
	}
	if _, err := fmt.Fprintf(stdout, "run %s completed\n", *tag); err != nil {
		return 1, fmt.Errorf("%s: write completion output: %w", root.Name(), err)
	}
	return 0, nil
}

func supervisedCommandFailure(root runnerRoot, state string, code int) error {
	return fmt.Errorf("%s: supervised command exited with status %d; inspect its tree and lifecycle at %s\nnext: %s ps --state %s", root.Name(), code, filepath.Join(state, "events.jsonl"), root.InvocationCommand(), shellQuote(state))
}

func keeperWaitFailure(root runnerRoot, state string, err error) error {
	return fmt.Errorf("%s: keeper wait failed: %w\nnext: %s ps --state %s", root.Name(), err, root.InvocationCommand(), shellQuote(state))
}

func parseCPURange(value string) (int, int, error) {
	if value == "" {
		return 0, 0, nil
	}
	minText, maxText, hasRange := strings.Cut(value, "..")
	minimum, err := strconv.Atoi(minText)
	if err != nil || minimum < 1 {
		return 0, 0, errors.New("CPU count must be positive")
	}
	maximum := minimum
	if hasRange {
		maximum, err = strconv.Atoi(maxText)
		if err != nil || maximum < minimum {
			return 0, 0, errors.New("CPU range maximum must be at least its minimum")
		}
	}
	return minimum, maximum, nil
}

func quotaCommand(root runnerRoot, args []string, stdout, stderr io.Writer) (int, error) {
	if len(args) == 0 {
		return 2, fmt.Errorf("%s quota: usage: quota <show|set> --state DIR; next: %s quota show --help", root.Name(), root.InvocationCommand())
	}
	action := args[0]
	fs := flag.NewFlagSet("quota "+action, flag.ContinueOnError)
	fs.SetOutput(stderr)
	state := fs.String("state", "", "state directory owning the quota")
	memory := fs.String("memory", "", "memory quota size or percentage")
	cpus := fs.String("cpus", "", "CPU quota")
	minFree := fs.String("min-free", "", "minimum free disk space")
	if err := fs.Parse(args[1:]); err != nil {
		return 2, err
	}
	if *state == "" {
		helpAction := action
		if helpAction != "show" && helpAction != "set" {
			helpAction = "show"
		}
		return 2, fmt.Errorf("%s quota: --state is required; next: %s quota %s --help", root.Name(), root.InvocationCommand(), helpAction)
	}
	resolvedState, err := resolveRunnerState(root, "quota "+action, *state)
	if err != nil {
		return 2, err
	}
	*state = resolvedState
	switch action {
	case "set":
		if *memory == "" && *cpus == "" && *minFree == "" {
			return 2, fmt.Errorf("%s quota set: provide --memory, --cpus, or --min-free; next: %s quota set --help", root.Name(), root.InvocationCommand())
		}
		if err := proc.SetQuota(*state, *memory, *cpus, *minFree); err != nil {
			return 1, fmt.Errorf("%s quota set: %w; next: ls -ld %s", root.Name(), err, shellQuote(*state))
		}
		return quotaShow(*state, stdout)
	case "show":
		return quotaShow(*state, stdout)
	default:
		return 2, fmt.Errorf("%s quota: unknown action %q; next: %s quota show --help", root.Name(), action, root.InvocationCommand())
	}
}

func quotaShow(state string, stdout io.Writer) (int, error) {
	quota, err := proc.ShowQuota(state)
	if err != nil {
		return 1, fmt.Errorf("kb-runner quota show: %w; next: ls -ld %s", err, shellQuote(state))
	}
	memSource, cpuSource, diskSource := "default", "default", "default"
	if quota.MemorySet {
		memSource = "set"
	}
	if quota.CPUsSet {
		cpuSource = "set"
	}
	if quota.MinFreeSet {
		diskSource = "set"
	}
	if _, err := fmt.Fprintf(stdout, "memory=%s (%s)\ncpus=%d (%s)\nmin-free=%s (%s)\n", proc.FormatResourceBytes(quota.MemoryBytes), memSource, quota.CPUs, cpuSource, proc.FormatResourceBytes(quota.MinFree), diskSource); err != nil {
		return 1, err
	}
	for signal, failure := range quota.Resources.Unavailable {
		if _, err := fmt.Fprintf(stdout, "signal %s unavailable: %s\n", signal, failure); err != nil {
			return 1, err
		}
	}
	return 0, nil
}

type stringListFlag []string

func (values *stringListFlag) String() string { return strings.Join(*values, ",") }

func (values *stringListFlag) Set(value string) error {
	key, _, ok := strings.Cut(value, "=")
	if !ok || key == "" {
		return fmt.Errorf("environment entry %q must be KEY=VALUE", value)
	}
	*values = append(*values, value)
	return nil
}

type pathListFlag []string

func (values *pathListFlag) String() string { return strings.Join(*values, ",") }
func (values *pathListFlag) Set(value string) error {
	if value == "" {
		return errors.New("kept path cannot be empty")
	}
	*values = append(*values, value)
	return nil
}

func psCommand(root runnerRoot, args []string, output io.Writer) (int, error) {
	fs := flag.NewFlagSet("ps", flag.ContinueOnError)
	state := fs.String("state", "", "directory containing run records")
	jsonOutput := fs.Bool("json", false, "write run and host resource state as JSON")
	leftovers := fs.Bool("leftovers", false, "list every uncleaned owned resource")
	if err := fs.Parse(args); err != nil {
		return 2, err
	}
	if *state == "" {
		return 2, fmt.Errorf("%s ps: --state is required; next: %s ps --help", root.Name(), root.InvocationCommand())
	}
	resolvedState, err := resolveRunnerState(root, "ps", *state)
	if err != nil {
		return 2, err
	}
	*state = resolvedState
	if err := reconcileJobsForState(*state); err != nil {
		return 1, fmt.Errorf("%s ps: reconcile agent jobs: %w; next: %s status --state %s --json", root.Name(), err, root.InvocationCommand(), shellQuote(*state))
	}
	if *leftovers {
		entries, err := proc.Leftovers(*state)
		if err != nil {
			return 1, fmt.Errorf("%s ps: list leftovers: %w\nnext: ls -ld %s", root.Name(), err, shellQuote(*state))
		}
		if *jsonOutput {
			if entries == nil {
				entries = []proc.LeftoverEntry{}
			}
			if err := json.NewEncoder(output).Encode(entries); err != nil {
				return 1, fmt.Errorf("kb-runner ps: write JSON: %w", err)
			}
			return 0, nil
		}
		if len(entries) == 0 {
			_, err := fmt.Fprintln(output, "No resource leftovers.")
			return 0, err
		}
		for _, entry := range entries {
			if _, err := fmt.Fprintf(output, "%s\t%s\t%s\t%s\n", entry.Kind, entry.ID, entry.Outcome, entry.Error); err != nil {
				return 1, err
			}
		}
		return 0, nil
	}
	listing := proc.List(*state)
	if listing.Error != nil {
		if older := olderEventFormatDiagnostic(root, *state, listing.Error); older != nil {
			return 1, older
		}
		return 1, fmt.Errorf("%s ps: read run state: %w\nnext: ls -ld %s", root.Name(), listing.Error, shellQuote(*state))
	}
	if *jsonOutput {
		if err := json.NewEncoder(output).Encode(listing); err != nil {
			return 1, fmt.Errorf("%s ps: write JSON: %w", root.Name(), err)
		}
		return 0, nil
	}
	if len(listing.Runs) == 0 {
		if _, err := fmt.Fprintln(output, "No supervised runs."); err != nil {
			return 1, fmt.Errorf("kb-runner ps: write output: %w", err)
		}
		return 0, nil
	}
	if _, err := fmt.Fprintln(output, "TAG\tPID\tSTATUS\tWAIT\tELAPSED\tTREE\tRESOURCES\tCOMMAND"); err != nil {
		return 1, fmt.Errorf("kb-runner ps: write output: %w", err)
	}
	for _, run := range listing.Runs {
		wait := run.WaitReason
		if run.Status == proc.StatusLost {
			wait = "lost: " + run.Error
		} else if run.Error != "" {
			wait = "observation: " + run.Error
		}
		if run.QueuePosition > 0 {
			wait = fmt.Sprintf("position=%d %s", run.QueuePosition, wait)
		}
		if run.Status == proc.StatusBlocked && wait != "" {
			wait = "blocked: " + wait
		}
		resources := fmt.Sprintf("mem=%s cpus=%d..%d grant=%d disk=%s", proc.FormatResourceBytes(run.MemoryBytes), run.CPUsMin, run.CPUsMax, run.GrantedCPUs, proc.FormatResourceBytes(run.DiskBytes))
		if run.LimitsAdvisory != "" {
			resources += " limits advisory: " + run.LimitsAdvisory
		}
		if run.OverBudget {
			resources += " over-budget"
		}
		if run.ResourceNotice != "" {
			resources += " signals: " + run.ResourceNotice
		}
		if _, err := fmt.Fprintf(output, "%s\t%d\t%s\t%s\telapsed=%dms\ttree=%d\t%s\t%s\n", run.Tag, run.PID, strings.ToUpper(string(run.Status)), wait, run.ElapsedMS, len(run.Tree), resources, strings.Join(run.Command, " ")); err != nil {
			return 1, fmt.Errorf("kb-runner ps: write output: %w", err)
		}
		for _, child := range run.Tree {
			status := ""
			if child.Unverified {
				status = "\tunverified"
			}
			if _, err := fmt.Fprintf(output, "  └─ %d\t%s\t elapsed=%s%s\n", child.PID, child.Command, time.Duration(child.ElapsedMS)*time.Millisecond, status); err != nil {
				return 1, fmt.Errorf("kb-runner ps: write output: %w", err)
			}
		}
	}
	return 0, nil
}

func eventsCommand(root runnerRoot, args []string, output io.Writer) (int, error) {
	fs := flag.NewFlagSet("events", flag.ContinueOnError)
	state := fs.String("state", "", "directory containing events.jsonl")
	follow := fs.Bool("follow", false, "continue streaming appended events")
	filter := fs.String("filter", "", "comma-separated event types to emit")
	offset := fs.Int64("offset", 0, "start reading events.jsonl at this byte offset")
	if err := fs.Parse(args); err != nil {
		return 2, err
	}
	if *state == "" {
		return 2, fmt.Errorf("%s events: --state is required; next: %s events --help", root.Name(), root.InvocationCommand())
	}
	resolvedState, err := resolveRunnerState(root, "events", *state)
	if err != nil {
		return 2, err
	}
	*state = resolvedState
	if *offset < 0 {
		return 2, fmt.Errorf("%s events: --offset must not be negative; next: %s events --help", root.Name(), root.InvocationCommand())
	}
	ctx := context.Background()
	if *follow {
		var stop context.CancelFunc
		ctx, stop = signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
		defer stop()
	}
	filters, err := proc.ParseEventFilter(*filter)
	if err != nil {
		return 2, fmt.Errorf("%s events: %w; next: %s events --help", root.Name(), err, root.InvocationCommand())
	}
	if err := reconcileJobsForState(*state); err != nil {
		return 1, fmt.Errorf("%s events: reconcile agent jobs: %w; next: %s status --state %s --json", root.Name(), err, root.InvocationCommand(), shellQuote(*state))
	}
	if err := proc.Events(ctx, *state, *follow, filters, *offset, output); err != nil && !errors.Is(err, context.Canceled) {
		if older := olderEventFormatDiagnostic(root, *state, err); older != nil {
			return 1, older
		}
		return 1, fmt.Errorf("%s events: %w\nnext: ls -l %s", root.Name(), err, shellQuote(filepath.Join(*state, "events.jsonl")))
	}
	return 0, nil
}

func gateCommand(root runnerRoot, args []string, stdout, stderr io.Writer) (int, error) {
	if len(args) > 0 && args[0] == "command" {
		return gateCommandExec(root, args, stdout, stderr)
	}
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		_, err := fmt.Fprintf(stdout, "Usage: %s gate status <name> --state <dir> | %s gate hold <name> [run flags] -- <command>\n", root.Name(), root.Name())
		if err != nil {
			return 1, fmt.Errorf("kb-runner gate: write usage: %w", err)
		}
		return 0, nil
	}
	if len(args) == 2 && args[0] == "status" && (args[1] == "--help" || args[1] == "-h") {
		_, err := fmt.Fprintf(stdout, "Usage: %s gate status <name> --state <dir>\n", root.Name())
		if err != nil {
			return 1, fmt.Errorf("kb-runner gate status: write usage: %w", err)
		}
		return 0, nil
	}
	if len(args) >= 2 && args[0] == "status" && args[1] != "" {
		fs := flag.NewFlagSet("gate status", flag.ContinueOnError)
		fs.SetOutput(stderr)
		state := fs.String("state", "", "directory containing gate records")
		if err := fs.Parse(args[2:]); err != nil {
			return 2, err
		}
		if *state == "" {
			return 2, fmt.Errorf("%s gate status: --state is required; next: %s gate status --help", root.Name(), root.InvocationCommand())
		}
		resolvedState, err := resolveRunnerState(root, "gate status", *state)
		if err != nil {
			return 2, err
		}
		*state = resolvedState
		gate, held, err := proc.GateStatus(*state, args[1])
		if err != nil {
			return 1, fmt.Errorf("%s gate status: %w; next: %s ps --state %s", root.Name(), err, root.InvocationCommand(), shellQuote(*state))
		}
		if held {
			_, err = fmt.Fprintf(stdout, "held\t%s\tpid=%d\tidentity=%s\n", gate.Tag, gate.PID, gate.Identity)
		} else {
			_, err = fmt.Fprintln(stdout, "free")
		}
		if err != nil {
			return 1, fmt.Errorf("kb-runner gate status: write output: %w", err)
		}
		return 0, nil
	}
	if len(args) < 2 || args[0] != "hold" || args[1] == "" {
		return 2, fmt.Errorf("%s gate: usage: %s gate status <name> --state <dir> or gate hold <name> [run flags] -- <command>; next: %s gate --help", root.Name(), root.InvocationCommand(), root.InvocationCommand())
	}
	name := args[1]
	runArgs := append([]string(nil), args[2:]...)
	runArgs = append([]string{"--hold-gate", name}, runArgs...)
	return runCommand(root, runArgs, stdout, stderr)
}

func waitCommand(root runnerRoot, args []string, stdout, stderr io.Writer) (int, error) {
	for _, arg := range args {
		if arg == "--any" || arg == "--all" {
			return agentWaitCommand(root, args, stdout, stderr)
		}
	}
	fs := flag.NewFlagSet("wait", flag.ContinueOnError)
	fs.SetOutput(stderr)
	tag := fs.String("tag", "", "run tag to await")
	latestTag := fs.String("latest-tag", "", "stable stream key whose newest run record to await")
	state := fs.String("state", "", "directory for run records")
	appearWithin := fs.Duration("appear-within", 2*time.Minute, "maximum time to wait for a --latest-tag run record to appear")
	if err := fs.Parse(args); err != nil {
		return 2, err
	}
	if (*tag == "") == (*latestTag == "") || *state == "" {
		return 2, fmt.Errorf("%s wait: provide exactly one of --tag or --latest-tag, and --state; next: %s wait --help", root.Name(), root.InvocationCommand())
	}
	resolvedState, err := resolveRunnerState(root, "wait", *state)
	if err != nil {
		return 2, err
	}
	*state = resolvedState
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	var run proc.RunInfo
	if *latestTag != "" {
		run, err = proc.WaitLatestTagWithin(ctx, *state, *latestTag, *appearWithin)
	} else {
		run, err = proc.WaitTag(ctx, *state, *tag)
	}
	if err != nil {
		var notFound *proc.WaitNotFoundError
		if errors.As(err, &notFound) {
			entry, ok := diag.LookupCatalog("KB_RUNTIME_JOB_NOT_FOUND")
			if !ok {
				return 1, errors.New("kb-runner wait: not-found diagnostic is missing from the platform catalog")
			}
			next := fmt.Sprintf("%s ps --state %s", root.InvocationCommand(), shellQuote(*state))
			return 1, waitDiagnosticError{diagnostic: diag.New(entry.Code, entry.Message,
				diag.WithReason(notFound.Error()),
				diag.WithHint("next: "+next),
				diag.WithBinary(root.InvocationCommand()),
			)}
		}
		return 1, fmt.Errorf("%s wait: %w; next: %s ps --state %s", root.Name(), err, root.InvocationCommand(), shellQuote(*state))
	}
	return renderWaitOutcome(run, *state, stdout, root.Invocation())
}

func renderWaitOutcome(run proc.RunInfo, state string, stdout io.Writer, executable string) (int, error) {
	if !run.Status.Terminal() {
		entry, ok := diag.LookupCatalog("KB_RUNTIME_WAIT_NOT_FINISHED")
		if !ok {
			return 1, errors.New("kb-runner wait: not-finished diagnostic is missing from the platform catalog")
		}
		inspectCommand := fmt.Sprintf("%s ps --state %s", shellQuote(executable), shellQuote(state))
		diagnostic := diag.New(
			entry.Code,
			entry.Message,
			diag.WithReason("wait received a run record before it reached a terminal state"),
			diag.WithHint(entry.Hint+"\n  "+inspectCommand),
		)
		return 1, waitDiagnosticError{diagnostic: diagnostic}
	}
	switch run.Status {
	case proc.StatusCompleted, proc.StatusFailed, proc.StatusDead:
		if _, err := fmt.Fprintf(stdout, "run %s exited after %dms\n", run.Tag, run.DurationMS); err != nil {
			return 1, fmt.Errorf("kb-runner wait: write output: %w", err)
		}
		if run.Signal != "" {
			number, _ := strconv.Atoi(run.Signal)
			return 128 + number, nil
		}
		if run.ExitCode != nil {
			return *run.ExitCode, nil
		}
		return 1, errors.New("kb-runner wait: run ended without an exit code or signal")
	case proc.StatusLost:
		return 1, fmt.Errorf("%s wait: run %s was lost: %s; next: %s ps --state %s", executable, run.Tag, run.Error, executable, shellQuote(state))
	case proc.StatusDirty:
		entry, ok := diag.LookupCatalog("KB_RUNTIME_RUN_DIRTY")
		if !ok {
			return 1, errors.New("kb-runner wait: dirty-run diagnostic is missing from the platform catalog")
		}
		commands := fmt.Sprintf("\n  %s ps --state %s\n  %s ps --leftovers --state %s\n  %s gc --state %s", shellQuote(executable), shellQuote(state), shellQuote(executable), shellQuote(state), shellQuote(executable), shellQuote(state))
		return 1, fmt.Errorf("%s: %s\nreason: %s\nhint: %s%s", entry.Code, entry.Message, run.Error, entry.Hint, commands)
	}
	return 1, fmt.Errorf("kb-runner wait: unknown run status %q", run.Status)
}

type waitDiagnosticError struct {
	diagnostic *diag.Diag
}

func olderEventFormatDiagnostic(root runnerRoot, state string, err error) error {
	var oldFormat *proc.OlderEventFormatError
	if !errors.As(err, &oldFormat) {
		return nil
	}
	entry, ok := diag.LookupCatalog("KB_RUNTIME_INPUT_INVALID")
	if !ok {
		return errors.New("kb-runner state diagnostic is missing from the platform catalog")
	}
	rotated := state + ".pre-" + time.Now().UTC().Format("20060102T150405.000000000Z")
	next := fmt.Sprintf("mv %s %s && mkdir %s", shellQuote(state), shellQuote(rotated), shellQuote(state))
	diagnostic := diag.New(entry.Code, entry.Message,
		diag.WithReason(err.Error()),
		diag.WithHint("Drain all keepers, then rotate the state directory.\nnext: "+next),
		diag.WithBinary(root.InvocationCommand()),
	)
	return waitDiagnosticError{diagnostic: diagnostic}
}

func (err waitDiagnosticError) Error() string {
	return renderDiagnostic(err.diagnostic)
}

func (err waitDiagnosticError) Unwrap() error {
	return err.diagnostic
}

func renderDiagnostic(diagnostic *diag.Diag) string {
	envelope, err := diag.ToEnvelope(diagnostic)
	if err != nil {
		return diagnostic.Error()
	}
	return fmt.Sprintf("%s: %s\nreason: %s\nhint: %s", envelope.Code, envelope.Message, envelope.Cause, envelope.Hint)
}

func shellJoin(args []string) string {
	quoted := make([]string, len(args))
	for i, arg := range args {
		quoted[i] = shellQuote(arg)
	}
	return strings.Join(quoted, " ")
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func ownCommand(root runnerRoot, args []string, output io.Writer) (int, error) {
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		_, err := fmt.Fprintf(output, "Usage: %s own path --create dir|file PATH | %s own docker-compose NAME -f FILE... -- COMPOSE-ARGV... | %s own container|network|volume ID\n", root.Name(), root.Name(), root.Name())
		if err != nil {
			return 1, fmt.Errorf("kb-runner own: write usage: %w", err)
		}
		return 0, nil
	}
	if len(args) < 2 {
		return 2, fmt.Errorf("%s own: usage: own path --create dir|file PATH or own docker-compose NAME -f FILE... -- COMPOSE-ARGV...; next: %s own --help", root.Name(), root.InvocationCommand())
	}
	runID := os.Getenv("KBLABS_CLIPROC_RUN")
	state := os.Getenv("KBLABS_CLIPROC_STATE")
	if runID == "" || state == "" {
		return 2, fmt.Errorf("%s own: no active run marker; run this command inside %s run so the resource has a cleanup owner\nnext: %s run --help", root.Name(), root.Name(), root.InvocationCommand())
	}
	resource := proc.Resource{Kind: proc.ResourceKind(args[0])}
	var ownErr error
	switch resource.Kind {
	case proc.ResourcePath:
		if len(args) != 4 || args[1] != "--create" {
			return 2, fmt.Errorf("%s own path: usage: own path --create dir|file PATH; next: %s own --help", root.Name(), root.InvocationCommand())
		}
		ownErr = proc.CreateOwnedPath(state, runID, args[3], proc.OwnedPathType(args[2]))
		resource.ID = args[3]
	case proc.ResourceCompose:
		if len(args) < 5 {
			return 2, fmt.Errorf("%s own docker-compose: usage: own docker-compose NAME -f FILE... -- COMPOSE-ARGV...; next: %s own --help", root.Name(), root.InvocationCommand())
		}
		resource.ID = args[1]
		separator := -1
		for i := 2; i < len(args); {
			if args[i] == "--" {
				separator = i
				break
			}
			if args[i] != "-f" || i+1 >= len(args) {
				return 2, fmt.Errorf("kb-runner own docker-compose: expected -f FILE before --, got %q", args[i])
			}
			resource.Files = append(resource.Files, args[i+1])
			i += 2
		}
		if separator < 0 || separator+1 >= len(args) {
			return 2, errors.New("kb-runner own docker-compose: compose argv prefix is required after --")
		}
		resource.ComposePrefix = append([]string(nil), args[separator+1:]...)
		ownErr = proc.RegisterResource(state, runID, resource)
	default:
		if len(args) != 2 {
			return 2, errors.New("kb-runner own: resource kind takes one id")
		}
		resource.ID = args[1]
		ownErr = proc.RegisterResource(state, runID, resource)
	}
	if ownErr != nil {
		return 1, ownFailure(root.Name(), root.Invocation(), args, state, resource, ownErr)
	}
	_, err := fmt.Fprintf(output, "owned %s %s\n", resource.Kind, resource.ID)
	return 0, err
}

func ownFailure(rootName, invocation string, args []string, state string, resource proc.Resource, ownErr error) error {
	var unsupported *proc.PathXattrUnsupportedError
	if errors.As(ownErr, &unsupported) {
		command := shellJoin(append([]string{invocation, "own"}, args...))
		return fmt.Errorf("%s own: %w\nCheck filesystem capacity before retrying:\nnext: df -P %s\nnext: %s", rootName, ownErr, shellQuote(unsupported.Path), command)
	}
	return fmt.Errorf("%s own: %w; correct the resource or cleanup root, then retry:\nnext: %s", rootName, ownErr, ownershipNextCommand(invocation, state, resource))
}

func ownershipNextCommand(invocation, state string, resource proc.Resource) string {
	switch resource.Kind {
	case proc.ResourcePath:
		return "ls -ld " + shellQuote(resource.ID) + " " + shellQuote(filepath.Join(state, "cleanup-roots.json"))
	case proc.ResourceCompose:
		args := append([]string(nil), resource.ComposePrefix...)
		args = append(args, "-p", resource.ID)
		for _, file := range resource.Files {
			args = append(args, "-f", file)
		}
		args = append(args, "config", "--format", "json")
		return shellJoin(args)
	case proc.ResourceContainer:
		return "docker inspect " + shellQuote(resource.ID)
	case proc.ResourceNetwork:
		return "docker network inspect " + shellQuote(resource.ID)
	case proc.ResourceVolume:
		return "docker volume inspect " + shellQuote(resource.ID)
	default:
		return shellJoin([]string{invocation, "own", "--help"})
	}
}

func gcCommand(root runnerRoot, args []string, output io.Writer) (int, error) {
	fs := flag.NewFlagSet("gc", flag.ContinueOnError)
	state := fs.String("state", "", "directory containing run records")
	if err := fs.Parse(args); err != nil {
		return 2, err
	}
	if *state == "" {
		return 2, fmt.Errorf("%s gc: --state is required; next: %s gc --help", root.Name(), root.InvocationCommand())
	}
	resolvedState, err := resolveRunnerState(root, "gc", *state)
	if err != nil {
		return 2, err
	}
	*state = resolvedState
	outcomes, err := proc.GarbageCollect(*state)
	if err != nil {
		return 1, fmt.Errorf("%s gc: cleanup failed: %w\nnext: %s ps --state %s --leftovers", root.Name(), err, root.InvocationCommand(), shellQuote(*state))
	}
	for _, outcome := range outcomes {
		if _, err := fmt.Fprintf(output, "%s\t%s\t%s", outcome.Resource.Kind, outcome.Resource.ID, outcome.Outcome); err != nil {
			return 1, err
		}
		if outcome.Error != "" {
			if _, err := fmt.Fprintf(output, "\t%s", outcome.Error); err != nil {
				return 1, err
			}
		}
		if _, err := fmt.Fprintln(output); err != nil {
			return 1, err
		}
	}
	return 0, nil
}

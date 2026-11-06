package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/kb-labs/kb-runner/internal/proc"
)

type commandPolicy struct {
	lightPrefixes [][]string
	heavyPrefixes [][]string
	heavyDefault  bool
}

// commandPolicies is the single declaration of the commands intercepted by
// agent PATH shims and the exact lightweight subcommands that pass through.
var commandPolicies = map[string]commandPolicy{
	"go": {
		lightPrefixes: [][]string{{"version"}, {"env"}},
		heavyPrefixes: [][]string{{"build"}, {"test"}},
		heavyDefault:  true,
	},
	"pnpm": {
		lightPrefixes: [][]string{{"--version"}, {"-v"}, {"--help"}, {"help"}},
		heavyPrefixes: [][]string{{"build"}, {"test"}, {"type-check"}, {"run", "build"}, {"run", "test"}, {"run", "type-check"}},
		heavyDefault:  true,
	},
	"kb-devkit": {
		lightPrefixes: [][]string{{"--version"}, {"version"}, {"--help"}, {"help"}},
		heavyPrefixes: [][]string{{"run", "build"}, {"run", "test"}, {"run", "type-check"}},
		heavyDefault:  true,
	},
	"tsc": {
		lightPrefixes: [][]string{{"--version"}, {"-v"}, {"--help"}},
		heavyDefault:  true,
	},
	"vitest": {
		lightPrefixes: [][]string{{"--version"}, {"-v"}, {"--help"}, {"--help=all"}},
		heavyDefault:  true,
	},
	"git": {
		lightPrefixes: [][]string{{}},
	},
}

func installCommandShims(state, jobID, runner string) (string, error) {
	if !filepath.IsAbs(runner) {
		return "", errors.New("kb-runner command shim target must be an absolute path")
	}
	directory := filepath.Join(state, "jobs", jobID, "bin")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", fmt.Errorf("create agent command shim directory: %w", err)
	}
	for tool := range commandPolicies {
		if tool == "git" {
			continue
		}
		script := strings.Join([]string{
			"#!/bin/sh",
			"shim_dir=" + shellQuote(directory),
			"PATH=\"${PATH#\"$shim_dir\":}\"",
			"export PATH",
			"real=$(command -v " + shellQuote(tool) + ") || { echo 'kb-runner: command not found outside admission shims' >&2; exit 127; }",
			"exec " + shellQuote(runner) + " gate command --tool " + shellQuote(tool) + " --real \"$real\" --state " + shellQuote(state) + " --shim-dir \"$shim_dir\" -- \"$@\"",
			"",
		}, "\n")
		path := filepath.Join(directory, tool)
		tmp := path + ".tmp"
		if err := os.WriteFile(tmp, []byte(script), 0o700); err != nil {
			return "", fmt.Errorf("write %s command shim: %w", tool, err)
		}
		if err := os.Rename(tmp, path); err != nil {
			return "", fmt.Errorf("install %s command shim: %w", tool, err)
		}
	}
	spool := filepath.Join(state, "jobs", jobID, "test-channel", "spool")
	info, spoolErr := os.Stat(spool)
	if spoolErr == nil && !info.IsDir() {
		return "", fmt.Errorf("agent test-channel spool %q is not a directory", spool)
	}
	if spoolErr != nil && !errors.Is(spoolErr, os.ErrNotExist) {
		return "", fmt.Errorf("inspect agent test-channel spool: %w", spoolErr)
	}
	if spoolErr == nil {
		script := strings.Join([]string{
			"#!/bin/sh",
			"exec " + shellQuote(runner) + " test-channel request --spool " + shellQuote(spool) + " -- \"$@\"",
			"",
		}, "\n")
		path := filepath.Join(directory, "kb-test")
		tmp := path + ".tmp"
		if err := os.WriteFile(tmp, []byte(script), 0o700); err != nil {
			return "", fmt.Errorf("write kb-test command shim: %w", err)
		}
		if err := os.Rename(tmp, path); err != nil {
			return "", fmt.Errorf("install kb-test command shim: %w", err)
		}
	}
	return directory, nil
}

func prefixMatches(args, prefix []string) bool {
	if len(args) < len(prefix) {
		return false
	}
	for index := range prefix {
		if args[index] != prefix[index] {
			return false
		}
	}
	return true
}

func commandNeedsTokens(tool string, args []string) (bool, error) {
	policy, ok := commandPolicies[tool]
	if !ok {
		return false, fmt.Errorf("unsupported command shim %q", tool)
	}
	for _, prefix := range policy.lightPrefixes {
		if prefixMatches(args, prefix) {
			return false, nil
		}
	}
	for _, prefix := range policy.heavyPrefixes {
		if prefixMatches(args, prefix) {
			return true, nil
		}
	}
	return policy.heavyDefault, nil
}

func prepareTokenCommand(tool string, args []string, grant int) ([]string, []string, error) {
	if grant < 1 {
		return nil, nil, errors.New("CPU token grant must be positive")
	}
	command := append([]string(nil), args...)
	env := []string{
		"GOMAXPROCS=" + strconv.Itoa(grant),
		"npm_config_workspace_concurrency=" + strconv.Itoa(grant),
		"TURBO_CONCURRENCY=" + strconv.Itoa(grant),
		"VITEST_MAX_FORKS=" + strconv.Itoa(grant),
	}
	switch tool {
	case "go":
		if len(command) == 0 || (command[0] != "build" && command[0] != "test") {
			return nil, nil, fmt.Errorf("go command %q is not a tokenized build or test", strings.Join(command, " "))
		}
		filtered := command[:1]
		for index := 1; index < len(command); index++ {
			arg := command[index]
			if arg == "-p" {
				index++
				continue
			}
			if strings.HasPrefix(arg, "-p=") {
				continue
			}
			filtered = append(filtered, arg)
		}
		command = append(filtered[:1], append([]string{"-p=" + strconv.Itoa(grant)}, filtered[1:]...)...)
	case "pnpm", "kb-devkit", "tsc":
	case "vitest":
		command = setFlagValue(command, "--maxWorkers", strconv.Itoa(grant))
	default:
		return nil, nil, fmt.Errorf("command %q has no token grant policy", tool)
	}
	return command, env, nil
}

func setFlagValue(args []string, flag, value string) []string {
	filtered := make([]string, 0, len(args)+1)
	for index := 0; index < len(args); index++ {
		if args[index] == flag {
			index++
			continue
		}
		if strings.HasPrefix(args[index], flag+"=") {
			continue
		}
		filtered = append(filtered, args[index])
	}
	return append(filtered, flag+"="+value)
}

func gateCommandExec(root runnerRoot, args []string, stdout, stderr io.Writer) (int, error) {
	if len(args) < 2 || args[0] != "command" {
		return 2, fmt.Errorf("%s gate: expected command shim invocation; next: %s gate --help", root.Name(), root.InvocationCommand())
	}
	fs := flag.NewFlagSet("gate command", flag.ContinueOnError)
	fs.SetOutput(stderr)
	tool := fs.String("tool", "", "shim command name")
	real := fs.String("real", "", "resolved command outside the shim directory")
	state := fs.String("state", "", "runner state directory")
	shimDir := fs.String("shim-dir", "", "agent command shim directory")
	if err := fs.Parse(args[1:]); err != nil {
		return 2, err
	}
	command := fs.Args()
	if len(command) > 0 && command[0] == "--" {
		command = command[1:]
	}
	if *tool == "" || *real == "" || *state == "" || *shimDir == "" || len(command) == 0 || !filepath.IsAbs(*real) || !filepath.IsAbs(*shimDir) {
		return 2, fmt.Errorf("%s gate command: tool, absolute real path, state, shim directory, and arguments are required; next: %s gate --help", root.Name(), root.InvocationCommand())
	}
	heavy, err := commandNeedsTokens(*tool, command)
	if err != nil {
		return 2, fmt.Errorf("%s gate command: %w; next: %s gate --help", root.Name(), err, root.InvocationCommand())
	}
	if !heavy {
		return runDirectCommand(*tool, *real, command, nil, stdout, stderr)
	}
	if os.Getenv("KBLABS_COMMAND_TOKEN_ACTIVE") == "1" {
		grant, err := strconv.Atoi(os.Getenv("KBLABS_COMMAND_TOKEN_GRANT"))
		if err != nil || grant < 1 {
			return 1, errors.New("kb-runner gate command: active token grant is missing or invalid")
		}
		grantDir := os.Getenv("KBLABS_COMMAND_TOKEN_GRANT_DIR")
		if !filepath.IsAbs(grantDir) {
			return 1, errors.New("kb-runner gate command: active token grant directory is missing or not absolute")
		}
		prepared, env, err := prepareTokenCommand(*tool, command, grant)
		if err != nil {
			return 2, fmt.Errorf("%s gate command: prepare nested token command: %w", root.Name(), err)
		}
		code, runErr := runUnderLocalGrant(grantDir, grant, func() (int, error) {
			return runDirectCommand(*tool, *real, prepared, env, stdout, stderr)
		})
		if runErr != nil {
			return code, fmt.Errorf("%s gate command: nested command under outer grant: %w", root.Name(), runErr)
		}
		return code, nil
	}
	grant, err := proc.CPUCommandTokenCapacity(*state)
	if err != nil {
		return 1, fmt.Errorf("%s gate command: %w; next: %s quota show --state %s", root.Name(), err, root.InvocationCommand(), shellQuote(*state))
	}
	prepared, env, err := prepareTokenCommand(*tool, command, 1)
	if err != nil {
		return 2, fmt.Errorf("%s gate command: prepare token command: %w", root.Name(), err)
	}
	command = prepared
	logDir, err := os.MkdirTemp("", "kb-runner-command-")
	if err != nil {
		return 1, fmt.Errorf("%s gate command: create command logs: %w", root.Name(), err)
	}
	defer os.RemoveAll(logDir)
	pid := os.Getpid()
	runArgs := []string{
		"--tag", fmt.Sprintf("heavy-command-%s-%d", *tool, pid), "--state", *state, "--stall", "30m",
		"--stdout", filepath.Join(logDir, "stdout.log"), "--stderr", filepath.Join(logDir, "stderr.log"),
		"--slot-group", proc.CPUCommandTokenGroup, "--slots", strconv.Itoa(grant), "--slot-weight", "1", "--cost", "heavy",
	}
	for _, entry := range env {
		runArgs = append(runArgs, "--env", entry)
	}
	childPath := *shimDir + string(os.PathListSeparator) + os.Getenv("PATH")
	for _, entry := range []string{"KBLABS_COMMAND_TOKEN_ACTIVE=1", "KBLABS_COMMAND_TOKEN_GRANT=1", "KBLABS_COMMAND_TOKEN_GRANT_DIR=" + logDir, "PATH=" + childPath} {
		runArgs = append(runArgs, "--env", entry)
	}
	runArgs = append(runArgs, "--", *real)
	runArgs = append(runArgs, command...)
	return runCommand(root, runArgs, stdout, stderr)
}

// runUnderLocalGrant schedules nested heavy commands within the outer command's
// grant. These locks are local to one outer run; nested work never requests a
// second global token and therefore cannot deadlock while its parent holds one.
func runUnderLocalGrant(grantDir string, grant int, run func() (int, error)) (int, error) {
	if !filepath.IsAbs(grantDir) || grant < 1 || run == nil {
		return 1, errors.New("nested command requires an absolute grant directory, a positive grant, and a command")
	}
	if err := os.MkdirAll(grantDir, 0o700); err != nil {
		return 1, fmt.Errorf("create outer grant queue: %w", err)
	}
	ticket, err := enqueueNestedGrant(grantDir)
	if err != nil {
		return 1, err
	}
	for {
		acquired, err := tryAcquireNestedGrant(grantDir, ticket, grant)
		if err != nil {
			return 1, errors.Join(err, removeNestedGrantRequest(grantDir, ticket))
		}
		if acquired {
			code, runErr := run()
			return code, errors.Join(runErr, releaseNestedGrant(grantDir, ticket))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

type nestedGrantRequest struct {
	Ticket   uint64 `json:"ticket"`
	PID      int    `json:"pid"`
	Identity string `json:"identity"`
}

type nestedGrantQueueState struct {
	NextTicket uint64               `json:"next_ticket"`
	Active     []nestedGrantRequest `json:"active"`
	Waiting    []nestedGrantRequest `json:"waiting"`
}

func readNestedGrantQueueState(grantDir string) (nestedGrantQueueState, error) {
	var state nestedGrantQueueState
	data, err := os.ReadFile(filepath.Join(grantDir, "queue.json"))
	if errors.Is(err, os.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return nestedGrantQueueState{}, fmt.Errorf("decode outer grant queue: %w", err)
	}
	return state, nil
}

func writeNestedGrantQueueState(grantDir string, state nestedGrantQueueState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	path := filepath.Join(grantDir, "queue.json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return errors.Join(err, os.Remove(tmp))
	}
	return nil
}

func lockNestedGrantQueue(grantDir string) (*os.File, nestedGrantQueueState, error) {
	file, err := os.OpenFile(filepath.Join(grantDir, "queue.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, nestedGrantQueueState{}, fmt.Errorf("open outer grant queue lock: %w", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		return nil, nestedGrantQueueState{}, errors.Join(fmt.Errorf("lock outer grant queue: %w", err), file.Close())
	}
	state, err := readNestedGrantQueueState(grantDir)
	if err != nil {
		return nil, nestedGrantQueueState{}, errors.Join(err, syscall.Flock(int(file.Fd()), syscall.LOCK_UN), file.Close())
	}
	return file, state, nil
}

func unlockNestedGrantQueue(file *os.File) error {
	return errors.Join(syscall.Flock(int(file.Fd()), syscall.LOCK_UN), file.Close())
}

func enqueueNestedGrant(grantDir string) (uint64, error) {
	identity, alive, err := proc.ProcessIdentity(os.Getpid())
	if err != nil || !alive {
		return 0, errors.Join(errors.New("identify nested command for outer grant queue"), err)
	}
	file, state, err := lockNestedGrantQueue(grantDir)
	if err != nil {
		return 0, err
	}
	state.NextTicket++
	ticket := state.NextTicket
	state.Waiting = append(state.Waiting, nestedGrantRequest{Ticket: ticket, PID: os.Getpid(), Identity: identity})
	return ticket, errors.Join(writeNestedGrantQueueState(grantDir, state), unlockNestedGrantQueue(file))
}

func pruneNestedGrantRequests(requests []nestedGrantRequest) ([]nestedGrantRequest, error) {
	kept := requests[:0]
	for _, request := range requests {
		identity, alive, err := proc.ProcessIdentity(request.PID)
		if err != nil {
			return nil, fmt.Errorf("verify nested grant request %d: %w", request.Ticket, err)
		}
		if alive && identity == request.Identity {
			kept = append(kept, request)
		}
	}
	return kept, nil
}

func tryAcquireNestedGrant(grantDir string, ticket uint64, grant int) (bool, error) {
	file, state, err := lockNestedGrantQueue(grantDir)
	if err != nil {
		return false, err
	}
	state.Active, err = pruneNestedGrantRequests(state.Active)
	if err == nil {
		state.Waiting, err = pruneNestedGrantRequests(state.Waiting)
	}
	if err != nil {
		return false, errors.Join(err, unlockNestedGrantQueue(file))
	}
	waitingIndex := -1
	for index, request := range state.Waiting {
		if request.Ticket == ticket {
			waitingIndex = index
			break
		}
	}
	if waitingIndex < 0 {
		return false, errors.Join(fmt.Errorf("nested grant request %d disappeared", ticket), unlockNestedGrantQueue(file))
	}
	if waitingIndex == 0 && len(state.Active) < grant {
		request := state.Waiting[0]
		state.Waiting = state.Waiting[1:]
		state.Active = append(state.Active, request)
		if err := writeNestedGrantQueueState(grantDir, state); err != nil {
			return false, errors.Join(err, unlockNestedGrantQueue(file))
		}
		return true, unlockNestedGrantQueue(file)
	}
	if err := writeNestedGrantQueueState(grantDir, state); err != nil {
		return false, errors.Join(err, unlockNestedGrantQueue(file))
	}
	return false, unlockNestedGrantQueue(file)
}

func removeNestedGrantRequest(grantDir string, ticket uint64) error {
	file, state, err := lockNestedGrantQueue(grantDir)
	if err != nil {
		return err
	}
	state.Waiting = removeNestedGrantTicket(state.Waiting, ticket)
	return errors.Join(writeNestedGrantQueueState(grantDir, state), unlockNestedGrantQueue(file))
}

func releaseNestedGrant(grantDir string, ticket uint64) error {
	file, state, err := lockNestedGrantQueue(grantDir)
	if err != nil {
		return err
	}
	activeCount := len(state.Active)
	state.Active = removeNestedGrantTicket(state.Active, ticket)
	if len(state.Active) == activeCount {
		return errors.Join(fmt.Errorf("active nested grant %d disappeared", ticket), unlockNestedGrantQueue(file))
	}
	return errors.Join(writeNestedGrantQueueState(grantDir, state), unlockNestedGrantQueue(file))
}

func removeNestedGrantTicket(requests []nestedGrantRequest, ticket uint64) []nestedGrantRequest {
	for index, request := range requests {
		if request.Ticket == ticket {
			return append(requests[:index], requests[index+1:]...)
		}
	}
	return requests
}

func runDirectCommand(tool, real string, args, extraEnv []string, stdout, stderr io.Writer) (int, error) {
	cmd := exec.Command(real, args...)
	cmd.Stdout, cmd.Stderr, cmd.Stdin = stdout, stderr, os.Stdin
	var err error
	cmd.Dir, err = os.Getwd()
	if err != nil {
		return 1, err
	}
	cmd.Env = append(os.Environ(), extraEnv...)
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode(), nil
		}
		return 1, fmt.Errorf("run %s command: %w", tool, err)
	}
	return 0, nil
}

//go:build darwin || linux

package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/proc/child"
	"github.com/kb-labs/kb-runner/internal/proc"
)

const schedulerTestSHA = "0123456789abcdef0123456789abcdef01234567"

//go:embed scheduler-policy.json
var schedulerPolicyFixture []byte

type schedulerFixture struct {
	home        string
	state       string
	repo        string
	worktrees   string
	bin         string
	runList     string
	gitCalls    string
	ghCalls     string
	launchCalls string
	verdict     string
	supervisor  *fakeSchedulerSupervisor
	childEnv    []string
}

func newSchedulerFixture(t *testing.T, runList, verdict string) schedulerFixture {
	return newSchedulerFixtureWithEnv(t, runList, verdict, false)
}

func newSchedulerFixtureWithEnv(t *testing.T, runList, verdict string, isolated bool) schedulerFixture {
	t.Helper()
	fixture := schedulerFixture{
		home:        t.TempDir(),
		state:       filepath.Join(t.TempDir(), "state"),
		repo:        t.TempDir(),
		bin:         t.TempDir(),
		runList:     filepath.Join(t.TempDir(), "runs.json"),
		gitCalls:    filepath.Join(t.TempDir(), "git.calls"),
		ghCalls:     filepath.Join(t.TempDir(), "gh.calls"),
		launchCalls: filepath.Join(t.TempDir(), "agent.calls"),
		verdict:     filepath.Join(t.TempDir(), "verdict.json"),
		supervisor:  newFakeSchedulerSupervisor(),
	}
	fixture.worktrees = filepath.Join(fixture.home, "Desktop", "work", "kb-labs-workspace-worktrees")
	if err := os.WriteFile(fixture.runList, []byte(runList), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fixture.verdict, []byte(verdict), 0o600); err != nil {
		t.Fatal(err)
	}
	repoSource, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(fixture.repo, "scripts"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(fixture.repo, "tools"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(repoSource, "scripts", "ci"), filepath.Join(fixture.repo, "scripts", "ci")); err != nil {
		t.Fatal(err)
	}
	fixtureRunnerDir := filepath.Join(fixture.repo, "tools", "kb-runner")
	if err := os.MkdirAll(fixtureRunnerDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixtureRunnerDir, "scheduler-policy.json"), schedulerPolicyFixture, 0o600); err != nil {
		t.Fatal(err)
	}
	fixture.writeCommand(t, "git", `#!/bin/sh
selected=""
if [ "$1" = "-C" ]; then selected="$2"; shift 2; fi
printf '%s|%s|%s\n' "$selected" "$PWD" "$*" >> "$FAKE_GIT_CALLS"
case "$1" in
  rev-parse) if [ "$2" = "--show-toplevel" ]; then if [ -z "$selected" ]; then printf '%s\n' "$FAKE_REPO"; elif [ "$selected" = "$FAKE_REPO" ]; then printf '%s\n' "$FAKE_REPO"; elif case "$selected" in "$FAKE_WORKTREE_ROOT"/*) true ;; *) false ;; esac; then printf '%s\n' "$selected"; else exit 128; fi; elif [ "$2" = "HEAD" ] && [ -n "${FAKE_WORKTREE_HEAD_STATE:-}" ] && [ -f "$FAKE_WORKTREE_HEAD_STATE" ]; then cat "$FAKE_WORKTREE_HEAD_STATE"; elif [ "$2" = "--verify" ] && [ "$3" = "main" ] && [ -n "${FAKE_BASE_COMMIT:-}" ]; then printf '%s\n' "$FAKE_BASE_COMMIT"; elif [ "$2" = "--verify" ] && case "${3:-}" in refs/heads/agent/*) [ -n "${FAKE_OLD_SHA:-}" ] ;; *) false ;; esac; then if [ -n "${FAKE_REF_STATE:-}" ] && [ -f "$FAKE_REF_STATE" ]; then cat "$FAKE_REF_STATE"; else printf '%s\n' "$FAKE_OLD_SHA"; fi; elif [ "$2" = "${FAKE_OLD_SHA:-no-old-sha}^{tree}" ] && [ -n "${FAKE_OLD_TREE:-}" ]; then printf '%s\n' "$FAKE_OLD_TREE"; elif [ "$2" = "${FAKE_BASE_COMMIT:-no-base-commit}^{tree}" ] && [ -n "${FAKE_BASE_TREE:-}" ]; then printf '%s\n' "$FAKE_BASE_TREE"; elif [ "$2" = "${FAKE_SHA:-no-sha}^{tree}" ] && [ -n "${FAKE_OLD_TREE:-}" ]; then printf '%s\n' "$FAKE_OLD_TREE"; else printf '%s\n' "$FAKE_SHA"; fi ;;
  remote) printf '%s\n' 'https://github.com/kb-labs/backup.git' ;;
  merge-base) printf '%s\n' "$FAKE_SHA" ;;
  worktree) if [ "$2" = "add" ]; then mkdir -p "$5"; fi ;;
  for-each-ref) ;;
  check-ref-format) ;;
  ls-files) if [ "$2" = "-u" ]; then printf '%s\n' "${FAKE_INDEX_UNMERGED:-}"; elif [ "$2" = "--others" ]; then printf '%s\n' "${FAKE_UNTRACKED_FILES:-}"; elif [ "$2" = "-z" ]; then printf '%s\n' "$FAKE_CHANGED_FILES" | tr ' ' '\n' | while IFS= read -r file; do [ -z "$file" ] || printf '%s\0' "$file"; done; else printf '%s\n' "$FAKE_CHANGED_FILES"; fi ;;
  show) object_path="$2"; object_path="${object_path#*:}"; if [ -f "$selected/$object_path" ]; then cat "$selected/$object_path"; else for candidate in "$FAKE_WORKTREE_ROOT"/*/"$object_path"; do if [ -f "$candidate" ]; then cat "$candidate"; exit 0; fi; done; exit 1; fi ;;
  ls-tree) if [ -n "${FAKE_LANDING_ENTRIES:-}" ]; then printf '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tdocs/qa/scenarios/S-237-process-tree-supervision.md\0'; printf '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\ttools/kb-runner/scheduler_test.go\0'; printf '100644 blob cccccccccccccccccccccccccccccccccccccccc\ttools/kb-runner/scheduler.go\0'; fi ;;
  read-tree|update-index) ;;
  reset) if [ -n "${FAKE_WORKTREE_HEAD_STATE:-}" ] && [ "$2" = "--mixed" ]; then printf '%s\n' "$3" > "$FAKE_WORKTREE_HEAD_STATE"; fi ;;
  update-ref) if [ -n "${FAKE_REF_STATE:-}" ]; then current="$FAKE_OLD_SHA"; [ ! -f "$FAKE_REF_STATE" ] || current=$(cat "$FAKE_REF_STATE"); [ "$current" = "$4" ] || exit 1; printf '%s\n' "$3" > "$FAKE_REF_STATE"; fi ;;
  write-tree|commit-tree) printf '%s\n' "$FAKE_SHA" ;;
  merge-tree) if [ "${FAKE_MERGE_CONFLICT:-0}" = "1" ] && [ "$selected" = "$FAKE_INTEGRATION" ]; then printf '%s\n' 'CONFLICT (content): fake conflict' >&2; exit 1; else printf '%s\n' "$FAKE_SHA"; fi ;;
  status|add|rm|commit|merge|revert) if [ "$1" = "merge" ] && [ "$2" != "--abort" ] && [ "${FAKE_MERGE_CONFLICT:-0}" = "1" ] && [ "$selected" = "$FAKE_INTEGRATION" ]; then printf '%s\n' 'CONFLICT (content): fake conflict' >&2; exit 1; fi ;;
  diff)
    case "$*" in
      *--diff-filter=U*) printf '%s\n' "$FAKE_UNMERGED" ;;
      *' :(glob)docs/qa/**'*) printf 'docs/qa/scenarios/S-237-process-tree-supervision.md\0' ;;
      *' :(glob)**/*_test.go'*) printf 'tools/kb-runner/scheduler_test.go\0' ;;
      *--no-renames\ --name-only\ -z*) if [ -n "${FAKE_LANDING_ENTRIES:-}" ]; then printf '%s\0' 'docs/qa/scenarios/S-237-process-tree-supervision.md' 'tools/kb-runner/scheduler_test.go' 'tools/kb-runner/scheduler.go'; fi ;;
      *--name-only\ -z*) printf '%s\n' "$FAKE_CHANGED_FILES" | tr ' ' '\n' | while IFS= read -r file; do [ -z "$file" ] || printf '%s\0' "$file"; done ;;
      *) printf '%s\n' "$FAKE_CHANGED_FILES" ;;
    esac
    ;;
  branch) printf '%s\n' "$FAKE_INTEGRATION_BRANCH" ;;
  push) ;;
  *) printf 'unexpected fake git command: %s\n' "$*" >&2; exit 91 ;;
esac
`)
	fixture.writeCommand(t, "gh", `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_GH_CALLS"
case "$1 $2" in
  "run list") if [ "${FAKE_GH_BLOCK:-0}" = "1" ]; then : > "$FAKE_GH_STARTED"; IFS= read -r _ < "$FAKE_GH_FIFO"; fi; cat "$FAKE_RUN_LIST" ;;
  "run view") [ "${FAKE_GH_VIEW_FAIL:-0}" = "1" ] && exit 97; printf '%s\n' '{"status":"completed","conclusion":"success","jobs":[]}' ;;
  "run download")
    run_id="$3"
    shift 2
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--dir" ]; then dir="$2"; shift 2; else shift; fi
    done
    mkdir -p "$dir"
    if [ -f "$FAKE_VERDICT_DIR/$run_id.json" ]; then cp "$FAKE_VERDICT_DIR/$run_id.json" "$dir/verdict.json"; else cp "$FAKE_VERDICT" "$dir/verdict.json"; fi
    ;;
  "run cancel"|"run rerun") ;;
  *) printf 'unexpected fake gh command: %s\n' "$*" >&2; exit 92 ;;
esac
`)
	fixture.writeCommand(t, "fake-review-result", `#!/bin/sh
vendor="$1"
model="$2"
mkdir -p "$FAKE_REVIEW_CALLS"
call=1
while [ -e "$FAKE_REVIEW_CALLS/$call" ]; do call=$((call + 1)); done
if [ -n "${FAKE_REVIEW_PLAN:-}" ]; then
  scripted=$(sed -n "${call}p" "$FAKE_REVIEW_PLAN")
  expected_vendor=$(printf '%s' "$scripted" | cut -d '|' -f1)
  expected_model=$(printf '%s' "$scripted" | cut -d '|' -f2)
  verdict=$(printf '%s' "$scripted" | cut -d '|' -f3)
else
  expected_vendor="$vendor"
  expected_model="$model"
  verdict="${FAKE_REVIEW_VERDICT:-ACCEPT}"
  if [ "$call" -eq 2 ]; then verdict="${FAKE_REVIEW_VERDICT_2:-$verdict}"; fi
fi
if [ "$vendor" != "$expected_vendor" ] || [ "$model" != "$expected_model" ] || { [ "$verdict" != "REJECT" ] && [ "$verdict" != "ACCEPT" ] && [ "$verdict" != "VENDOR_LIMIT" ]; }; then
  printf 'review plan mismatch at call %s: got %s/%s, expected %s/%s\n' "$call" "$vendor" "$model" "$expected_vendor" "$expected_model" >&2
  exit 64
fi
printf '%s|%s|%s\n' "$vendor" "$model" "$verdict" > "$FAKE_REVIEW_CALLS/$call"
if [ -n "${FAKE_REVIEW_EVENTS:-}" ]; then printf '%s|%s|%s\n' "$vendor" "$model" "$verdict" >> "$FAKE_REVIEW_EVENTS"; fi
if [ "$verdict" = "VENDOR_LIMIT" ]; then printf '429 quota limit\n' >&2; exit 75; fi
printf 'Verdict: %s\n\n' "$verdict"
printf '%b\n' "${FAKE_REVIEW_BODY:-## Defects\n\n- scripted review finding\n\n## Verification\n\nPASS}"
`)
	fixture.writeCommand(t, "gem", `#!/bin/sh
model=""
while [ "$#" -gt 0 ]; do if [ "$1" = "-m" ]; then model="$2"; shift 2; else shift; fi; done
cat > "$FAKE_GEM_INPUT"
printf 'model=%s\n' "$model" >> "$FAKE_GEM_CALLS"
if [ -n "${FAKE_REVIEW_PLAN:-}" ]; then
  fake-review-result gem "$model"
else
  printf 'Verdict: %s\n\n## Defects\n\nNo defects.\n\n## Verification\n\nPASS\n' "${FAKE_GEM_VERDICT:-ACCEPT}"
fi
`)
	fixture.writeCommand(t, "kb-runner", `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_AGENT_CALLS"
if [ "$1" = "run" ]; then
  shift
  stdin_path=""
  tag=""
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do if [ "$1" = "--stdin" ]; then stdin_path="$2"; shift 2; elif [ "$1" = "--tag" ]; then tag="$2"; shift 2; else shift; fi; done
  [ "$#" -gt 0 ] && shift
  if [ -n "$stdin_path" ]; then exec "$@" < "$stdin_path"; else exec "$@"; fi
fi
if [ "$1" = "verify" ] && [ "$2" = "outside" ]; then
  printf '{"worktree":"%s","modules":[{"module":"kb-runner","log":"%s","exit_code":%s,"failures":%s,"failed_tests":[]}]}' "$3" "${FAKE_VERIFY_LOG:-$FAKE_REPO/runner.jsonl}" "${FAKE_VERIFY_EXIT:-0}" "${FAKE_VERIFY_FAILURES:-0}"
  printf '\n'
  exit "${FAKE_VERIFY_EXIT:-0}"
fi
[ "$1" = "agent" ] && [ "$2" = "start" ] || exit 93
shift 2
while [ "$#" -gt 0 ]; do
  case "$1" in
    --state) state="$2"; shift 2 ;;
    --stream) stream="$2"; shift 2 ;;
    --vendor) vendor="$2"; shift 2 ;;
    --model) model="$2"; shift 2 ;;
    --workdir) workdir="$2"; shift 2 ;;
    --prompt-file) prompt="$2"; shift 2 ;;
    --message) message="$2"; shift 2 ;;
    --job-id) job_id="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$workdir" "$state/jobs"
if [ -n "${FAKE_AGENT_STARTED_FIFO:-}" ]; then
  printf '%s\n' "$stream" > "$FAKE_AGENT_STARTED_FIFO"
fi
if [ -n "${FAKE_AGENT_BLOCK_STREAM:-}" ] && [ "$stream" = "$FAKE_AGENT_BLOCK_STREAM" ]; then
  IFS= read -r _ < "$FAKE_AGENT_RELEASE_FIFO"
fi
case "$stream" in
  *-review*) report="$message"; [ -n "$report" ] || { printf 'review has no run-owned output path\n' >&2; exit 65; }; mkdir -p "$(dirname "$report")"; if [ "$vendor" = "zcode" ] && [ "${FAKE_ZCODE_FAIL:-0}" = "1" ]; then exit 71; fi; fake-review-result "$vendor" "$model" > "$report" ;;
  *) report="$workdir/.agent-report.md"; [ -z "$message" ] || report="$message"; mkdir -p "$(dirname "$report")"; call=1; if [ -n "${FAKE_WORKER_CALLS:-}" ]; then [ ! -f "$FAKE_WORKER_CALLS" ] || call=$(( $(wc -l < "$FAKE_WORKER_CALLS") + 1 )); printf '%s|%s|%s\n' "$call" "$stream" "$vendor" >> "$FAKE_WORKER_CALLS"; fi; status="${FAKE_AGENT_STATUS:-Status: DONE}"; if [ -n "${FAKE_AGENT_STATUS_PLAN:-}" ]; then status=$(sed -n "${call}p" "$FAKE_AGENT_STATUS_PLAN"); fi; if [ "$status" = "Status: DONE" ] && [ -n "${FAKE_AGENT_REPORT:-}" ]; then cp "$FAKE_AGENT_REPORT" "$report"; else printf '%s\n' "$status" > "$report"; printf '%s\n' "$FAKE_AGENT_PROPOSALS" >> "$report"; fi; if [ -n "$FAKE_AGENT_QUESTION" ]; then printf '%s\n' "$FAKE_AGENT_QUESTION" >> "$report"; fi ;;
esac
printf '{"id":"%s","stream":"%s","sessionId":"fixture-thread"}\n' "$job_id" "$stream" > "$state/jobs/$job_id.json"
printf 'job %s completed\n' "$job_id"
`)
	if err := os.MkdirAll(filepath.Join(fixture.worktrees, "bin"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture.worktrees, "bin", "kb-runner-zcode"), []byte(`#!/bin/sh
[ "${FAKE_ZCODE_FAIL:-0}" = "1" ] && exit 1
printf '%s\n' "${FAKE_ZCODE_VERDICT:-ACCEPT}" > "$FAKE_ZCODE_REPORT"
`), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(fixture.worktrees, "prompts"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture.worktrees, "prompts", "00-rules.md"), []byte("fixture-owned review rules"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(fixture.worktrees, "reports"), 0o700); err != nil {
		t.Fatal(err)
	}
	setSchedulerFixtureEnv(t, &fixture, isolated, "PATH", fixture.bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	setSchedulerFixtureEnv(t, &fixture, isolated, "KB_RUNNER_FIXTURE_BINARY", filepath.Join(fixture.bin, "kb-runner"))
	setSchedulerFixtureEnv(t, &fixture, isolated, "HOME", fixture.home)
	setSchedulerFixtureEnv(t, &fixture, isolated, "KBLABS_WORKTREES_ROOT", fixture.worktrees)
	setSchedulerFixtureEnv(t, &fixture, isolated, "GOCACHE", filepath.Join(fixture.worktrees, "go-build-cache"))
	setSchedulerFixtureEnv(t, &fixture, isolated, "FAKE_REPO", fixture.repo)
	setSchedulerFixtureEnv(t, &fixture, isolated, "FAKE_WORKTREE_ROOT", fixture.worktrees)
	setSchedulerFixtureEnv(t, &fixture, isolated, "FAKE_CHANGED_FILES", "docs/qa/scenarios/S-237-process-tree-supervision.md README.md")
	setSchedulerFixtureEnv(t, &fixture, isolated, "FAKE_SHA", schedulerTestSHA)
	setSchedulerFixtureEnv(t, &fixture, isolated, "FAKE_INTEGRATION", filepath.Join(fixture.worktrees, "j90-integration"))
	setSchedulerFixtureEnv(t, &fixture, isolated, "FAKE_INTEGRATION_BRANCH", "agent/j90-integration")
	setSchedulerFixtureEnv(t, &fixture, isolated, "FAKE_GIT_CALLS", fixture.gitCalls)
	setSchedulerFixtureEnv(t, &fixture, isolated, "FAKE_RUN_LIST", fixture.runList)
	setSchedulerFixtureEnv(t, &fixture, isolated, "FAKE_GH_CALLS", fixture.ghCalls)
	setSchedulerFixtureEnv(t, &fixture, isolated, "FAKE_AGENT_CALLS", fixture.launchCalls)
	setSchedulerFixtureEnv(t, &fixture, isolated, "FAKE_GEM_INPUT", filepath.Join(t.TempDir(), "gem-input.md"))
	setSchedulerFixtureEnv(t, &fixture, isolated, "FAKE_GEM_CALLS", filepath.Join(t.TempDir(), "gem.calls"))
	setSchedulerFixtureEnv(t, &fixture, isolated, "FAKE_REVIEW_CALLS", filepath.Join(t.TempDir(), "review-calls"))
	setSchedulerFixtureEnv(t, &fixture, isolated, "FAKE_VERDICT", fixture.verdict)
	setSchedulerFixtureEnv(t, &fixture, isolated, "FAKE_VERDICT_DIR", fixture.bin)
	setSchedulerFixtureEnv(t, &fixture, isolated, "FAKE_AGENT_PROPOSALS", "## Proposed commits\n```json\n[{\"kind\":\"case\",\"subject\":\"docs(qa): update scheduler case\",\"body\":\"\"},{\"kind\":\"tests\",\"subject\":\"test(kb-runner): cover scheduler lifecycle\",\"body\":\"\"},{\"kind\":\"code\",\"subject\":\"feat(kb-runner): schedule agent work\",\"body\":\"Scheduler implementation details.\"}]\n```")
	return fixture
}

func setSchedulerFixtureEnv(t *testing.T, fixture *schedulerFixture, isolated bool, key, value string) {
	t.Helper()
	if !isolated {
		t.Setenv(key, value)
		return
	}
	fixture.childEnv = append(fixture.childEnv, key+"="+value)
}

func fixtureEnvironment(fixture schedulerFixture, key string) string {
	for index := len(fixture.childEnv) - 1; index >= 0; index-- {
		name, value, ok := strings.Cut(fixture.childEnv[index], "=")
		if ok && name == key {
			return value
		}
	}
	return os.Getenv(key)
}

func executeInvocationWithSupervisor(f schedulerFixture, args []string, stdout, stderr io.Writer) (int, error) {
	root := f.invocationRoot()
	root.supervisor = f.supervisor
	return executeRoot(root, args, stdout, stderr)
}

func seedSchedulerWorkerSession(t *testing.T, store *schedulerStore, stream *SchedulerStream, sessionID string) {
	t.Helper()
	job, err := newJobStore(filepath.Dir(store.dir)).Create(Job{ID: stream.Stream + "-worker-job", Stream: stream.Stream, Vendor: "codex", State: JobOK, Phase: PhaseRun, SessionID: sessionID})
	if err != nil {
		t.Fatalf("seed durable worker job: %v", err)
	}
	stream.JobID = job.ID
	stream.ThreadID = "stale-session"
	if err := store.writeStreamObserved(*stream); err != nil {
		t.Fatalf("persist worker stream job identity: %v", err)
	}
}

func agentDispatchDiagnostics(t *testing.T, fixture schedulerFixture, runnerStderr string, streamNames ...string) string {
	t.Helper()

	var diagnostics strings.Builder
	store := newSchedulerStore(fixture.state)
	jobs := newJobStore(fixture.state)
	for _, streamName := range streamNames {
		stream, err := store.stream(streamName)
		if err != nil {
			fmt.Fprintf(&diagnostics, "stream %s: read error=%v; ", streamName, err)
			continue
		}
		fmt.Fprintf(&diagnostics, "stream %s state=%s cause=%q jobID=%s; ", streamName, stream.State, stream.Cause, stream.JobID)
		if stream.JobID == "" {
			continue
		}
		job, err := jobs.Get(stream.JobID)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				fmt.Fprintf(&diagnostics, "job %s record=missing; ", stream.JobID)
			} else {
				fmt.Fprintf(&diagnostics, "job %s: read error=%v; ", stream.JobID, err)
			}
		} else {
			finalError := ""
			if job.Final != nil {
				finalError = job.Final.Error
			}
			fmt.Fprintf(&diagnostics, "job %s state=%s reason=%s cause=%q; ", job.ID, job.State, job.Reason, finalError)
		}
		_, stderrPath := schedulerAgentLogPaths(fixture.state, stream.JobID)
		output, readErr := os.ReadFile(stderrPath)
		if readErr == nil {
			fmt.Fprintf(&diagnostics, "%s=%q; ", filepath.Base(stderrPath), output)
		} else {
			fmt.Fprintf(&diagnostics, "%s read error=%v; ", filepath.Base(stderrPath), readErr)
		}
	}
	for _, run := range fixture.supervisor.List(fixture.state).Runs {
		fmt.Fprintf(&diagnostics, "run %s tag=%s state=%s exit=%v error=%q; ", run.RunID, run.Tag, run.Status, run.ExitCode, run.Error)
	}
	if tasks, err := store.tasks(); err == nil {
		for _, task := range tasks {
			stream, streamErr := store.stream(task.Stream)
			if streamErr != nil {
				fmt.Fprintf(&diagnostics, "task %s role=%s stream_error=%v; ", task.ID, task.Role, streamErr)
				continue
			}
			fmt.Fprintf(&diagnostics, "task %s role=%s stream=%s state=%s run=%s depends=%v; ", task.ID, task.Role, task.Stream, stream.State, stream.RunID, task.DependsOn)
		}
	}
	return fmt.Sprintf("diagnostics={%s} runner stderr=%q", diagnostics.String(), runnerStderr)
}

func TestSchedulerFixtureUsesIsolatedPolicyAndWorktreeRoot(t *testing.T) {
	fixture := newSchedulerFixture(t, `[]`, `{}`)
	fixtureRunnerDir := filepath.Join(fixture.repo, "tools", "kb-runner")
	info, err := os.Lstat(fixtureRunnerDir)
	if err != nil {
		t.Fatalf("stat scheduler fixture runner directory: %v", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("scheduler fixture runner directory is not isolated: mode=%s", info.Mode())
	}
	if got := os.Getenv("KBLABS_WORKTREES_ROOT"); got != fixture.worktrees {
		t.Fatalf("scheduler fixture worktree root = %q, want %q", got, fixture.worktrees)
	}
}

// case: S-237.114
func TestSchedulerRenderingLeavesEveryPromptTemplateUnchanged(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	options := newSchedulerRunOptions(newSchedulerStore(f.state), schedulerRunOptionsConfig{state: f.state, supervisor: f.supervisor})
	for _, name := range []string{runnerReviewTemplate, runnerMergeTemplate, runnerDefinitionOfDone} {
		before, err := readRunnerTemplate(name)
		if err != nil {
			t.Fatal(err)
		}
		if name != runnerDefinitionOfDone {
			task := SchedulerTask{ID: name, Stream: "stream-a", PromptTemplate: name}
			if name == runnerReviewTemplate {
				task.Role = schedulerReviewRole
			} else {
				task.Role = schedulerMergeRole
			}
			reviewStream := SchedulerStream{Stream: task.Stream, TaskID: task.ID, RunID: "run-render"}
			parentStream := SchedulerStream{Stream: task.Stream, TaskID: task.ID}
			rendered, err := options.persistReviewPrompt(task, reviewStream, parentStream)
			if err != nil {
				t.Fatalf("render %s: %v", name, err)
			}
			if rendered == filepath.Join(f.repo, "prompts", name) {
				t.Fatalf("rendered %s into template path", name)
			}
		}
		after, err := readRunnerTemplate(name)
		if err != nil || string(after) != string(before) {
			t.Fatalf("rendering changed embedded %s: before=%q after=%q err=%v", name, before, after, err)
		}
	}
}

// case: S-237.111
func TestSnapshotUsesPrivateIndexAndLeavesWorktreeStateUntouched(t *testing.T) {
	worktree := t.TempDir()
	runGit := func(args ...string) string {
		t.Helper()
		command := exec.Command("git", append([]string{"-C", worktree}, args...)...)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %s: %v", args, output, err)
		}
		return strings.TrimSpace(string(output))
	}
	for _, args := range [][]string{{"init", "-q"}, {"config", "user.name", "Fixture"}, {"config", "user.email", "fixture@example.test"}} {
		runGit(args...)
	}
	if err := os.WriteFile(filepath.Join(worktree, "tracked.txt"), []byte("base\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit("add", "tracked.txt")
	runGit("commit", "-m", "base")
	if err := os.WriteFile(filepath.Join(worktree, "tracked.txt"), []byte("working tree\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit("add", "tracked.txt")
	if err := os.WriteFile(filepath.Join(worktree, "new.txt"), []byte("untracked\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	beforeHead := runGit("rev-parse", "HEAD")
	beforeTree := runGit("write-tree")
	beforeStatus := runGit("status", "--porcelain", "--untracked-files=all")
	sha, ref, err := snapshotWorktree(filesystemRunnerStateStore{}, worktree, "fixture-stream")
	if err != nil {
		t.Fatal(err)
	}
	if len(sha) != 40 || !strings.HasPrefix(ref, "refs/snapshots/fixture-stream/") {
		t.Fatalf("snapshot identity sha=%q ref=%q", sha, ref)
	}
	if got := runGit("rev-parse", "HEAD"); got != beforeHead {
		t.Fatalf("snapshot moved HEAD: before=%s after=%s", beforeHead, got)
	}
	if got := runGit("write-tree"); got != beforeTree {
		t.Fatalf("snapshot changed the real index: before=%s after=%s", beforeTree, got)
	}
	if got := runGit("status", "--porcelain", "--untracked-files=all"); got != beforeStatus {
		t.Fatalf("snapshot changed worktree status: before=%q after=%q", beforeStatus, got)
	}
	if parent := runGit("rev-parse", sha.String()+"^1"); parent != beforeHead {
		t.Fatalf("snapshot commit parent=%s want HEAD=%s", parent, beforeHead)
	}
	if got := runGit("show", sha.String()+":new.txt"); got != "untracked" {
		t.Fatalf("snapshot omitted untracked file: %q", got)
	}
}

// case: S-237.111
func TestSnapshotRefusesUnmergedIndexWithoutChangingIt(t *testing.T) {
	worktree := t.TempDir()
	runGit := func(args ...string) string {
		t.Helper()
		command := exec.Command("git", append([]string{"-C", worktree}, args...)...)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %s: %v", args, output, err)
		}
		return strings.TrimSpace(string(output))
	}
	for _, args := range [][]string{{"init", "-q", "--initial-branch=main"}, {"config", "user.name", "Fixture"}, {"config", "user.email", "fixture@example.test"}} {
		runGit(args...)
	}
	if err := os.WriteFile(filepath.Join(worktree, "conflict.txt"), []byte("base\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit("add", "conflict.txt")
	runGit("commit", "-m", "base")
	runGit("checkout", "-b", "side")
	if err := os.WriteFile(filepath.Join(worktree, "conflict.txt"), []byte("side\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit("commit", "-am", "side")
	runGit("checkout", "main")
	if err := os.WriteFile(filepath.Join(worktree, "conflict.txt"), []byte("main\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit("commit", "-am", "main")
	merge := exec.Command("git", "-C", worktree, "merge", "side")
	if output, err := merge.CombinedOutput(); err == nil {
		t.Fatalf("fixture merge did not conflict: %s", output)
	}
	beforeHead := runGit("rev-parse", "HEAD")
	beforeIndex := runGit("ls-files", "--stage")
	beforeStatus := runGit("status", "--porcelain")
	if _, _, err := snapshotWorktree(filesystemRunnerStateStore{}, worktree, "conflict-stream"); err == nil {
		t.Fatal("snapshot accepted unresolved merge entries")
	}
	if got := runGit("rev-parse", "HEAD"); got != beforeHead {
		t.Fatalf("refusal moved HEAD: before=%s after=%s", beforeHead, got)
	}
	if got := runGit("ls-files", "--stage"); got != beforeIndex {
		t.Fatalf("refusal changed the merge index: before=%q after=%q", beforeIndex, got)
	}
	if got := runGit("status", "--porcelain"); got != beforeStatus {
		t.Fatalf("refusal changed worktree status: before=%q after=%q", beforeStatus, got)
	}
}

func (f schedulerFixture) writeCommand(t *testing.T, name, body string) {
	t.Helper()
	path := filepath.Join(f.bin, name)
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
}

func (f schedulerFixture) invocationRoot() runnerRoot {
	return runnerRootFromFixturePath(filepath.Join(f.bin, "kb-runner"))
}

func runnerRootFromFixtureEnv(t *testing.T) runnerRoot {
	t.Helper()
	path := os.Getenv("KB_RUNNER_FIXTURE_BINARY")
	if !filepath.IsAbs(path) {
		t.Fatalf("scheduler fixture binary path %q is not absolute", path)
	}
	return runnerRootFromFixturePath(path)
}

func runnerRootFromFixturePath(path string) runnerRoot {
	return runnerRoot{Root: command.InvocationRoot(path), invocation: path}
}

func (f schedulerFixture) addTask(t *testing.T, stream, role string, deps ...string) SchedulerTask {
	t.Helper()
	prompt := filepath.Join(f.repo, stream+".md")
	if err := os.WriteFile(prompt, []byte("task for "+stream), 0o600); err != nil {
		t.Fatal(err)
	}
	args := []string{"sched", "add", "--state", f.state, "--stream", stream, "--prompt", prompt, "--base", "main", "--priority", "4", "--vendor", "codex", "--effort", "high", "--worktree-root", f.worktrees, "--review", "single", "--reviewer", "codex"}
	if role == "review" {
		args = append(args, "--role", "review", "--prompt-template", runnerReviewTemplate, "--workdir", filepath.Join(f.worktrees, stream))
	}
	for _, dep := range deps {
		args = append(args, "--depends-on", dep)
	}
	var out, errOut bytes.Buffer
	status := executeInvocation("kb-runner", args, &out, &errOut)
	if status.Code() != 0 {
		t.Fatalf("sched add %s exit=%d stdout=%s stderr=%s", stream, status.Code(), out.String(), errOut.String())
	}
	var task SchedulerTask
	if err := json.Unmarshal(out.Bytes(), &task); err != nil {
		t.Fatalf("decode task: %v; output=%s", err, out.String())
	}
	return task
}

func (f schedulerFixture) runOnce(t *testing.T, extra ...string) (int, string) {
	t.Helper()
	if len(extra) != 0 {
		t.Fatalf("scheduler fixture direct run does not accept CLI arguments: %v", extra)
	}
	root := f.invocationRoot()
	code, err := runSchedulerUsingDependencies(context.Background(), root, f.state, 1, true, filesystemRunnerStateStore{}, f.supervisor)
	if err != nil {
		return code, err.Error()
	}
	return code, ""
}

func (f schedulerFixture) addAwaitingRemote(t *testing.T, task SchedulerTask, submission SchedulerSubmission) {
	t.Helper()
	store := newSchedulerStore(f.state)
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	stream.Submission = &submission
	if err := store.transition(stream, SchedulerRunning, "agent round", "await remote submit"); err != nil {
		t.Fatal(err)
	}
	stream, err = store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(stream, SchedulerAwaitingRemote, "GitHub Actions", "wait for the remote watcher"); err != nil {
		t.Fatal(err)
	}
}

// case: S-237.77
func TestSchedulerTaskBacklogPersistsResolvedWorkdirAndRole(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	worker := f.addTask(t, "worker-a", "worker")
	review := f.addTask(t, "worker-b-review", "review", worker.ID)
	cancelled := f.addTask(t, "worker-c", "worker")
	if worker.Workdir != filepath.Join(f.worktrees, "worker-a") || !filepath.IsAbs(worker.Workdir) || worker.Role != "worker" || worker.RepoRoot != f.repo {
		t.Fatalf("worker task lacks persisted worktree contract: %+v", worker)
	}
	if review.Workdir != filepath.Join(f.worktrees, "worker-b-review") || review.Role != "review" || review.PromptTemplate != runnerReviewTemplate {
		t.Fatalf("review task lacks persisted role/template contract: %+v", review)
	}
	var cancelOutput bytes.Buffer
	status := executeInvocation("kb-runner", []string{"sched", "cancel", "--state", f.state, cancelled.ID}, &cancelOutput, &bytes.Buffer{})
	if status.Code() != 0 {
		t.Fatalf("sched cancel exit=%d output=%s", status.Code(), cancelOutput.String())
	}
	var listing bytes.Buffer
	status = executeInvocation("kb-runner", []string{"sched", "ls", "--state", f.state, "--json"}, &listing, &bytes.Buffer{})
	if status.Code() != 0 {
		t.Fatalf("sched ls exit=%d output=%s", status.Code(), listing.String())
	}
	var tasks []SchedulerTask
	if err := json.Unmarshal(listing.Bytes(), &tasks); err != nil || len(tasks) != 2 || tasks[1].DependsOn[0] != worker.ID {
		t.Fatalf("task records=%+v decode=%v output=%s", tasks, err, listing.String())
	}
	if _, err := newSchedulerStore(f.state).task(cancelled.ID); !os.IsNotExist(err) {
		t.Fatalf("cancelled task remains in the backlog: %v", err)
	}
}

func TestSchedulerRejectsTransitionsThatWouldLoseRemoteOwnership(t *testing.T) {
	if !validSchedulerTransition(SchedulerAwaitingRemote, SchedulerDone) {
		t.Fatal("a passing candidate verdict must complete an awaiting-remote stream")
	}
}

// case: S-237.89
func TestSchedulerTaskPersistsExplicitReviewPolicy(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	task := f.addTask(t, "policy-worker", "worker")
	if task.Review != "single" || len(task.Reviewers) != 1 || task.Reviewers[0] != "codex" {
		t.Fatalf("task review policy=%+v", task)
	}
	var out bytes.Buffer
	var errOut bytes.Buffer
	if err := os.WriteFile(filepath.Join(f.repo, "cross-worker.md"), []byte("cross policy"), 0o600); err != nil {
		t.Fatal(err)
	}
	status := executeInvocation("kb-runner", []string{"sched", "add", "--state", f.state, "--stream", "cross-worker", "--prompt", filepath.Join(f.repo, "cross-worker.md"), "--base", "main", "--worktree-root", f.worktrees, "--review", "cross", "--reviewer", "codex", "--reviewer", "gemini"}, &out, &errOut)
	if status.Code() != 0 {
		t.Fatalf("cross review sched add exit=%d stdout=%s stderr=%s", status.Code(), out.String(), errOut.String())
	}
	var cross SchedulerTask
	if err := json.Unmarshal(out.Bytes(), &cross); err != nil || cross.Review != "cross" || strings.Join(cross.Reviewers, ",") != "codex,gemini" {
		t.Fatalf("cross review policy=%+v decode=%v", cross, err)
	}
}

// case: S-237.149
func TestSchedulerAutoAdvanceTaskHasNoManualReviewerPolicy(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	base := f.addTask(t, "policy-auto-base", "worker")
	auto := base
	auto.ID, auto.Stream = "", "policy-auto"
	auto.OutsideSuites = []string{"kb-runner:./..."}
	auto.Review, auto.Reviewers = "", nil
	stored, err := newSchedulerStore(f.state).add(auto)
	if err != nil {
		t.Fatalf("add role-routed auto-advance task: %v", err)
	}
	if stored.Review != "" || len(stored.Reviewers) != 0 {
		t.Fatalf("auto-advance task declares ignored manual review policy: review=%q reviewers=%v", stored.Review, stored.Reviewers)
	}
	conflictingUpdate := stored
	conflictingUpdate.Reviewers = []string{"codex"}
	if err := newSchedulerStore(f.state).updateTask(conflictingUpdate); err == nil {
		t.Fatal("task update accepted manual reviewers that auto-advance ignores")
	}

	for name, configure := range map[string]func(*SchedulerTask){
		"review mode":   func(task *SchedulerTask) { task.Review = "single" },
		"reviewer list": func(task *SchedulerTask) { task.Reviewers = []string{"codex"} },
	} {
		t.Run(name, func(t *testing.T) {
			conflict := auto
			conflict.ID, conflict.Stream = "", "policy-auto-"+strings.ReplaceAll(name, " ", "-")
			configure(&conflict)
			if _, err := newSchedulerStore(f.state).add(conflict); err == nil {
				t.Fatal("conflicting manual review policy was accepted for role-routed auto-advance")
			}
		})
	}
}

// case: S-237.88
func TestSchedulerInitialTransitionWritesOneHandoffLine(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	f.addTask(t, "worker-a", "worker")
	data, err := os.ReadFile(filepath.Join(f.worktrees, "HANDOFF.md"))
	if err != nil || strings.Count(string(data), "scheduler=") != 1 || !strings.Contains(string(data), "worker-a") {
		t.Fatalf("initial scheduler handoff=%q err=%v", data, err)
	}
}

// case: S-237.88, S-237.91
func TestSchedulerHandoffProjectionIsIdempotentAndDecisionCausesAreClosed(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	task := f.addTask(t, "handoff-worker", "worker")
	store := newSchedulerStore(f.state)
	event := map[string]any{"kind": "scheduler.verdict", "stream": task.Stream, "task_id": task.ID, "status": "pass", "time": "stable-fixture-time"}
	if err := store.appendEvent(event); err != nil {
		t.Fatal(err)
	}
	if err := store.appendEvent(event); err != nil {
		t.Fatal(err)
	}
	handoff, err := os.ReadFile(filepath.Join(f.worktrees, "HANDOFF.md"))
	if err != nil || strings.Count(string(handoff), "stable-fixture-time") != 1 {
		t.Fatalf("duplicate event projection=%q err=%v", handoff, err)
	}
	for _, cause := range []string{"plan-question", "review-disagreement", "review-missing", "review-unavailable", "third-reject", "outage-after-retries", "no-proposed-commits", "bisect-inconclusive"} {
		if !validSchedulerDecisionCause(cause) {
			t.Fatalf("decision cause %q is not in the scheduler contract", cause)
		}
	}
	if validSchedulerDecisionCause("raw-provider-error") {
		t.Fatal("orchestrator queue accepted an unowned free-form cause")
	}
	ready := f.addTask(t, "aaa-ready", "worker")
	decision := f.addTask(t, "needs-decision", "worker")
	decisionStream, err := store.stream(decision.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(decisionStream, SchedulerRunning, "review", "resolve review"); err != nil {
		t.Fatal(err)
	}
	decisionStream, _ = store.stream(decision.Stream)
	decisionStream.Cause = "review-unavailable"
	if err := store.transition(decisionStream, SchedulerAwaitingOrchestrator, "reviewer", "choose fallback"); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	status := executeInvocation("kb-runner", []string{"sched", "ps", "--state", f.state, "--json"}, &output, &bytes.Buffer{})
	var listed []SchedulerStream
	if status.Code() != 0 || json.Unmarshal(output.Bytes(), &listed) != nil || len(listed) < 3 || listed[0].Stream != decision.Stream || listed[1].Stream != ready.Stream {
		t.Fatalf("ps did not sort decision-needed streams first: exit=%d streams=%+v output=%s", status.Code(), listed, output.String())
	}
}

// case: S-237.87
func TestSchedulerCandidateFailureBisectsPrefixesAndRevertsFirstFailingMerge(t *testing.T) {
	f, _, store := newCandidateBisectFixture(t, false)
	if code, output := f.runOnce(t); code != 0 {
		t.Fatalf("candidate failure cycle exit=%d output=%s", code, output)
	}
	integration, err := store.integration()
	if err != nil || integration.Bisect == nil || len(integration.Bisect.Prefixes) != 2 {
		t.Fatalf("candidate did not persist both prefix submissions: integration=%+v err=%v", integration, err)
	}
	gitCalls, err := os.ReadFile(f.gitCalls)
	if err != nil || !strings.Contains(string(gitCalls), integration.Bisect.Prefixes[0].Ref) || !strings.Contains(string(gitCalls), integration.Bisect.Prefixes[1].Ref) {
		t.Fatalf("prefix verifications were not submitted together: calls=%q err=%v", gitCalls, err)
	}
	if err := f.completeBisectPrefixes(t, integration.Bisect.Prefixes, false); err != nil {
		t.Fatal(err)
	}
	if code, output := f.runOnce(t); code != 0 {
		calls, _ := os.ReadFile(f.gitCalls)
		t.Fatalf("prefix verdict cycle exit=%d output=%s git=%s", code, output, calls)
	}
	events, err := os.ReadFile(filepath.Join(store.dir, "events.jsonl"))
	if err != nil || !strings.Contains(string(events), `"to":"ready"`) || !strings.Contains(string(events), `"cause":"candidate failures: TestCandidateRegression"`) {
		t.Fatalf("first failing prefix did not return stream to READY with candidate failures: events=%s err=%v", events, err)
	}
	calls, err := os.ReadFile(f.gitCalls)
	if err != nil || !strings.Contains(string(calls), "revert -m 1 --no-edit "+integration.Bisect.Prefixes[0].MergeSHA) {
		t.Fatalf("scheduler did not revert the first failing merge: calls=%q err=%v", calls, err)
	}
	completed, err := store.integration()
	if err != nil || completed.Bisect != nil || completed.LastBisect == nil {
		t.Fatalf("completed bisect was not archived: integration=%+v err=%v", completed, err)
	}
}

// case: S-237.87
func TestSchedulerCandidateBisectUsesInconclusiveOnlyWhenFinalPrefixDisagrees(t *testing.T) {
	f, task, store := newCandidateBisectFixture(t, true)
	if code, output := f.runOnce(t); code != 0 {
		t.Fatalf("candidate failure cycle exit=%d output=%s", code, output)
	}
	integration, err := store.integration()
	if err != nil || integration.Bisect == nil {
		t.Fatalf("candidate bisect record=%+v err=%v", integration, err)
	}
	if err := f.completeBisectPrefixes(t, integration.Bisect.Prefixes, true); err != nil {
		t.Fatal(err)
	}
	if code, output := f.runOnce(t); code != 0 {
		t.Fatalf("flake prefix cycle exit=%d output=%s", code, output)
	}
	stream, err := store.stream(task.Stream)
	if err != nil || stream.State != SchedulerAwaitingOrchestrator || stream.Cause != "bisect-inconclusive" {
		t.Fatalf("candidate/prefix disagreement state=%+v err=%v", stream, err)
	}
	completed, err := store.integration()
	if err != nil || completed.Bisect != nil || completed.LastBisect == nil {
		t.Fatalf("inconclusive bisect remained active: integration=%+v err=%v", completed, err)
	}
	if code, output := f.runOnce(t); code != 0 {
		t.Fatalf("scheduler restart after inconclusive result exit=%d output=%s", code, output)
	}
	calls, err := os.ReadFile(f.gitCalls)
	if err != nil || strings.Contains(string(calls), "revert -m 1") {
		t.Fatalf("inconclusive prefixes must not select a revert: calls=%q err=%v", calls, err)
	}
}

// case: S-237.87
func TestSchedulerCandidatePrefixOutageRerunsTwiceThenTerminates(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	options := newSchedulerRunOptions(newSchedulerStore(f.state), schedulerRunOptionsConfig{})
	prefix := SchedulerBisectPrefix{Ref: "verify/bisect-worker-a-0123456", RunID: "21"}
	for attempt := 1; attempt <= schedulerOutageLimit; attempt++ {
		if err := options.retryBisectPrefix(&prefix, "kb-labs/backup", fmt.Errorf("temporary outage %d", attempt)); err != nil {
			t.Fatal(err)
		}
		if prefix.Attempts != attempt || prefix.Status != "pending" {
			t.Fatalf("prefix retry %d state=%+v", attempt, prefix)
		}
	}
	if err := options.retryBisectPrefix(&prefix, "kb-labs/backup", errors.New("outage after reruns")); err != nil {
		t.Fatal(err)
	}
	if prefix.Attempts != schedulerOutageLimit || prefix.Status != "outage" {
		t.Fatalf("prefix outage did not stop after bounded reruns: %+v", prefix)
	}
	calls, err := os.ReadFile(f.ghCalls)
	if err != nil || strings.Count(string(calls), "run rerun") != schedulerOutageLimit {
		t.Fatalf("prefix rerun count=%q err=%v", calls, err)
	}
}

func newCandidateBisectFixture(t *testing.T, finalPrefixPass bool) (schedulerFixture, SchedulerTask, *schedulerStore) {
	t.Helper()
	sha1 := strings.Repeat("1", 40)
	candidate := schedulerTestSHA
	runs := fmt.Sprintf(`[{"databaseId":11,"event":"push","path":".github/workflows/remote-verify.yml","headBranch":"verify/candidate-worker-a-%s","headSha":"%s","status":"completed","conclusion":"failure"}]`, candidate[:7], candidate)
	verdict := `{"schemaVersion":1,"sha":"` + candidate + `","status":"fail","jobs":[{"name":"unit","status":"fail","failures":["TestCandidateRegression"],"logTail":"candidate failure"}],"diagnostics":["candidate verification failed"]}`
	f := newSchedulerFixture(t, runs, verdict)
	if err := os.MkdirAll(filepath.Join(f.worktrees, "j90-integration"), 0o700); err != nil {
		t.Fatal(err)
	}
	task := f.addTask(t, "worker-a", "worker")
	store := newSchedulerStore(f.state)
	f.addAwaitingRemote(t, task, SchedulerSubmission{SHA: candidate, Ref: "verify/candidate-worker-a-" + candidate[:7], Purpose: "candidate", RunID: "11", DeadlineAt: time.Now().UTC().Add(time.Hour)})
	for _, merge := range []SchedulerMergeRecord{
		{CommitSHA: sha1, Stream: "worker-a", ParentSHA: strings.Repeat("0", 40)},
		{CommitSHA: candidate, Stream: "worker-b", ParentSHA: sha1},
	} {
		if err := store.recordIntegrationMerge(merge); err != nil {
			t.Fatal(err)
		}
	}
	return f, task, store
}

func (f schedulerFixture) completeBisectPrefixes(t *testing.T, prefixes []SchedulerBisectPrefix, finalPrefixPass bool) error {
	t.Helper()
	runs := make([]string, 0, len(prefixes))
	for index, prefix := range prefixes {
		runID := fmt.Sprint(21 + index)
		conclusion := "failure"
		status := "fail"
		if finalPrefixPass && index == len(prefixes)-1 {
			conclusion, status = "success", "pass"
		}
		runs = append(runs, fmt.Sprintf(`{"databaseId":%s,"event":"push","path":".github/workflows/remote-verify.yml","headBranch":%q,"headSha":%q,"status":"completed","conclusion":%q}`, runID, prefix.Ref, prefix.SHA, conclusion))
		verdict := fmt.Sprintf(`{"schemaVersion":1,"sha":%q,"status":%q,"jobs":[],"diagnostics":[]}`, prefix.SHA, status)
		if err := os.WriteFile(filepath.Join(f.bin, runID+".json"), []byte(verdict), 0o600); err != nil {
			return err
		}
	}
	if err := os.WriteFile(f.runList, []byte("["+strings.Join(runs, ",")+"]"), 0o600); err != nil {
		return err
	}
	return nil
}

// case: S-237.116
func TestSchedulerRunReplaysMissingHandoffProjectionIdempotently(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	task := f.addTask(t, "handoff-replay", "worker")
	store := newSchedulerStore(f.state)
	if err := store.cancel(task.ID); err != nil {
		t.Fatal(err)
	}
	handoff := filepath.Join(f.worktrees, "HANDOFF.md")
	if err := os.Remove(handoff); err != nil {
		t.Fatal(err)
	}
	if code, output := f.runOnce(t); code != 0 {
		t.Fatalf("scheduler recovery run exit=%d output=%s", code, output)
	}
	restored, err := os.ReadFile(handoff)
	eventLog, eventErr := os.ReadFile(filepath.Join(store.dir, "events.jsonl"))
	streamEvents := 0
	for _, line := range strings.Split(string(eventLog), "\n") {
		if strings.Contains(line, `"stream":"`+task.Stream+`"`) {
			streamEvents++
		}
	}
	if err != nil || eventErr != nil || strings.Count(string(restored), "scheduler=") != streamEvents {
		t.Fatalf("replayed HANDOFF=%q err=%v", restored, err)
	}
	if code, output := f.runOnce(t); code != 0 {
		t.Fatalf("second scheduler recovery run exit=%d output=%s", code, output)
	}
	second, err := os.ReadFile(handoff)
	if err != nil || string(second) != string(restored) {
		t.Fatalf("HANDOFF replay was not idempotent: before=%q after=%q err=%v", restored, second, err)
	}
}

// case: S-237.85
func TestSchedulerMissingCommitProposalsStopsWithNamedCause(t *testing.T) {
	runs := `[{"databaseId":11,"event":"push","path":".github/workflows/remote-verify.yml","headBranch":"verify/worker-a-0123456","headSha":"` + schedulerTestSHA + `","status":"completed","conclusion":"success"}]`
	f := newSchedulerFixture(t, runs, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	f.addTask(t, "worker-a", "worker")
	t.Setenv("FAKE_AGENT_PROPOSALS", "")
	code, output := f.runOnce(t)
	if code != 0 {
		t.Fatalf("scheduler run exit=%d output=%s", code, output)
	}
	stream, err := newSchedulerStore(f.state).stream("worker-a")
	if err != nil || stream.State != SchedulerAwaitingOrchestrator || stream.Cause != "no-proposed-commits" {
		t.Fatalf("missing proposals state=%+v err=%v %s", stream, err, agentDispatchDiagnostics(t, f, "", "worker-a"))
	}
	if _, err := os.Stat(filepath.Join(f.worktrees, "prompts", "land.calls")); !os.IsNotExist(err) {
		t.Fatalf("land owner called without proposals: %v", err)
	}
}

// case: S-237.149
func TestAutoAdvanceQueuesReviewAfterVerificationTransition(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	f.state = filepath.Join(f.home, "runner-state")
	task := f.addTask(t, "auto-worker", "worker")
	task.OutsideSuites = []string{"kb-runner:./..."}
	task.Review, task.Reviewers = "", nil
	if err := os.MkdirAll(task.Workdir, 0o700); err != nil {
		t.Fatal(err)
	}
	store := newSchedulerStore(f.state)
	if err := store.updateTask(task); err != nil {
		t.Fatal(err)
	}
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(stream, SchedulerRunning, "agent round", "wait for agent report"); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(task.Stream, AdvanceWorking, "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(task.Stream, AdvanceVerifying, "", "", schedulerTestSHA); err != nil {
		t.Fatal(err)
	}
	report := "Status: DONE\n\n## Design gate\n| root cause | single owner (package/module/file) | rail type | why it is not a shape rail or a copy |\n|---|---|---|---|\n| cause | owner | contract | shared owner |\n\n## Verification\nPASS\n\n## Open issues\nNone\n\n## Unrequested behaviour changes\nNone\n\n## Debt self-scan\nNone\n\n## Self-review\nComplete\n\n## Proposed commits\n```json\n[{\"kind\":\"case\",\"subject\":\"docs(qa): update case\",\"body\":\"\"},{\"kind\":\"tests\",\"subject\":\"test(kb-runner): cover auto advance\",\"body\":\"\"},{\"kind\":\"code\",\"subject\":\"feat(kb-runner): auto advance streams\",\"body\":\"\"}]\n```\n"
	reportPath := filepath.Join(f.repo, "auto-worker-report.md")
	if err := os.WriteFile(reportPath, []byte(report), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(task.Stream, AdvanceVerifying, "", "", schedulerTestSHA); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(task.Stream, AdvanceReviewing, "", "", schedulerTestSHA); err != nil {
		t.Fatal(err)
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: f.invocationRoot(), state: f.state, supervisor: f.supervisor})
	if err := options.queueAutoReview(task, ReviewStandard); err != nil {
		t.Fatal(err)
	}
	stream, err = store.stream(task.Stream)
	if err != nil || stream.Advance == nil || stream.Advance.State != AdvanceReviewing || stream.State != SchedulerAwaitingReview {
		t.Fatalf("auto-advance outcome=%+v advance=%+v err=%v", stream, stream.Advance, err)
	}
	journal, err := os.ReadDir(filepath.Join(store.dir, "auto-transitions"))
	if err != nil {
		t.Fatal(err)
	}
	var latest autoTransitionRecord
	if err := readSchedulerJSON(filepath.Join(store.dir, "auto-transitions", journal[len(journal)-1].Name()), &latest); err != nil {
		t.Fatal(err)
	}
	workerReviewing, reviewRunJournaled := false, false
	if len(latest.Tasks) == 1 && latest.Tasks[0].ReviewerKind == ReviewStandard {
		for _, snapshot := range latest.Streams {
			if snapshot.Stream == task.Stream && snapshot.Advance != nil && snapshot.Advance.State == AdvanceReviewing {
				workerReviewing = true
			}
			if snapshot.Stream == latest.Tasks[0].Stream && snapshot.RunID != "" {
				reviewRunJournaled = true
			}
		}
	}
	if len(latest.Tasks) != 1 || len(latest.Streams) != 2 || !workerReviewing || !reviewRunJournaled {
		t.Fatalf("review dispatch identity and Reviewing state were not journaled together: %+v", latest)
	}
	tasks, err := store.tasks()
	if err != nil {
		t.Fatal(err)
	}
	for _, candidate := range tasks {
		if candidate.ReviewerKind == ReviewStandard && candidate.Vendor == "zcode" && candidate.Model == "GLM-5.3-flash" {
			return
		}
	}
	t.Fatal("standard review was not queued from the role table")
}

func TestExistingReviewTaskRepairsReviewingAndRunIdentityInOneTransition(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	worker := f.addTask(t, "existing-review-transition", "worker")
	worker.OutsideSuites = []string{"kb-runner:./..."}
	worker.Review, worker.Reviewers = "", nil
	store := newSchedulerStore(f.state)
	if err := store.updateTask(worker); err != nil {
		t.Fatal(err)
	}
	workerStream, err := store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(workerStream, SchedulerRunning, "worker", "finish worker"); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(worker.Stream, AdvanceWorking, "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(worker.Stream, AdvanceVerifying, "", "", schedulerTestSHA); err != nil {
		t.Fatal(err)
	}
	workerStream, err = store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(workerStream, SchedulerAwaitingReview, "review", "recover existing review"); err != nil {
		t.Fatal(err)
	}
	_, err = store.add(SchedulerTask{ID: worker.Stream + "-review-standard-r1", Stream: worker.Stream + "-review-standard-r1", PromptTemplate: runnerReviewTemplate, Workdir: worker.Workdir, WorktreeRoot: worker.WorktreeRoot, RepoRoot: worker.RepoRoot, Base: worker.Base, Vendor: "codex", Effort: "medium", Role: schedulerReviewRole, ReviewerKind: ReviewStandard, ReviewTreeHash: schedulerTestSHA, DependsOn: []string{worker.ID}})
	if err != nil {
		t.Fatal(err)
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: f.invocationRoot(), state: f.state, supervisor: f.supervisor})
	if err := options.queueAutoReview(worker, ReviewStandard); err != nil {
		t.Fatal(err)
	}
	workerAfter, err := store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	reviewAfter, err := store.stream(worker.Stream + "-review-standard-r1")
	if err != nil {
		t.Fatal(err)
	}
	if workerAfter.Advance == nil || workerAfter.Advance.State != AdvanceReviewing || reviewAfter.RunID == "" {
		t.Fatalf("existing review recovery omitted Reviewing state or run ID: worker=%+v review=%+v", workerAfter, reviewAfter)
	}
	entries, err := os.ReadDir(filepath.Join(store.dir, "auto-transitions"))
	if err != nil {
		t.Fatal(err)
	}
	var transition autoTransitionRecord
	if err := readSchedulerJSON(filepath.Join(store.dir, "auto-transitions", entries[len(entries)-1].Name()), &transition); err != nil {
		t.Fatal(err)
	}
	workerJournaled, reviewIdentityJournaled := false, false
	for _, snapshot := range transition.Streams {
		workerJournaled = workerJournaled || (snapshot.Stream == worker.Stream && snapshot.Advance != nil && snapshot.Advance.State == AdvanceReviewing)
		reviewIdentityJournaled = reviewIdentityJournaled || (snapshot.Stream == reviewAfter.Stream && snapshot.RunID == reviewAfter.RunID)
	}
	if len(transition.Streams) != 2 || !workerJournaled || !reviewIdentityJournaled {
		t.Fatalf("reviewer result could start without journaled Reviewing/run identity: %+v", transition)
	}
}

func TestAutoAdvanceFakeSchedulerReviewAcceptsAndLandsOnce(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	f.state = filepath.Join(f.home, "runner-state")
	task := f.addTask(t, "auto-scheduler-journey", "worker")
	task.OutsideSuites = []string{"kb-runner:./..."}
	task.Review, task.Reviewers = "", nil
	store := newSchedulerStore(f.state)
	if err := store.updateTask(task); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(task.Workdir, 0o700); err != nil {
		t.Fatal(err)
	}
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(stream, SchedulerRunning, "fixture worker", "verify fake worker result"); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(task.Stream, AdvanceWorking, "", "", ""); err != nil {
		t.Fatal(err)
	}
	report := "Status: DONE\n\n## Design gate\n| root cause | single owner (package/module/file) | rail type | why it is not a shape rail or a copy |\n|---|---|---|---|\n| cause | owner | structured data or contract | owner |\n\n## Verification\nPASS\n\n## Open issues\nNone\n\n## Unrequested behaviour changes\nNone\n\n## Debt self-scan\nNone\n\n## Self-review\nComplete\n\n## Proposed commits\n```json\n[{\"kind\":\"case\",\"subject\":\"docs(qa): case\",\"body\":\"\"},{\"kind\":\"tests\",\"subject\":\"test(kb-runner): test\",\"body\":\"\"},{\"kind\":\"code\",\"subject\":\"feat(kb-runner): change\",\"body\":\"\"}]\n```\n"
	if err := os.WriteFile(filepath.Join(task.Workdir, ".agent-report.md"), []byte(report), 0o600); err != nil {
		t.Fatal(err)
	}
	lifecycle, cancelLifecycle := schedulerLifecycleContext(context.Background())
	defer cancelLifecycle()
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: f.invocationRoot(), state: f.state, supervisor: f.supervisor, lifecycle: lifecycle})
	if err := store.advance(task.Stream, AdvanceVerifying, "", "", schedulerTestSHA); err != nil {
		t.Fatal(err)
	}
	stream, err = store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := options.finishAutoWorker(task, stream, "Status: DONE", []byte(report)); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_REVIEW_VERDICT", "ACCEPT")
	if code, output := f.runOnce(t); code != 0 {
		t.Fatalf("fake review scheduler exit=%d output=%s", code, output)
	}
	accepted, err := store.stream(task.Stream)
	if err != nil || accepted.State != SchedulerDone || accepted.Advance.State != AdvanceAccepted {
		t.Fatalf("auto scheduler acceptance=%+v err=%v %s", accepted, err, agentDispatchDiagnostics(t, f, "", task.Stream))
	}
	branch := "refs/heads/agent/" + task.Stream
	first, err := schedulerCommandOutput(task.RepoRoot, "git", "-C", task.RepoRoot, "rev-parse", "--verify", branch)
	if err != nil {
		t.Fatalf("read landed stream branch: %v", err)
	}
	if code, output := f.runOnce(t); code != 0 {
		t.Fatalf("restarted scheduler exit=%d output=%s", code, output)
	}
	second, err := schedulerCommandOutput(task.RepoRoot, "git", "-C", task.RepoRoot, "rev-parse", "--verify", branch)
	if err != nil || first != second {
		t.Fatalf("restarted scheduler duplicated or changed landing: first=%q second=%q err=%v", first, second, err)
	}
}

func TestReworkDispatchJournalsWorkerRunWithWorkingState(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	task := f.addTask(t, "rework-dispatch-boundary", "worker")
	task.OutsideSuites = []string{"kb-runner:./..."}
	task.Review, task.Reviewers = "", nil
	store := newSchedulerStore(f.state)
	if err := store.updateTask(task); err != nil {
		t.Fatal(err)
	}
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	stream.Advance = &StreamAdvance{State: AdvanceRework, Round: 1, TreeHash: schedulerTestSHA}
	stream.State = SchedulerReady
	if err := store.commitAutoTransition([]SchedulerStream{stream}); err != nil {
		t.Fatal(err)
	}
	claimed, ok, err := store.claimForDispatch(task.Stream, task.ID, "rework-job", "")
	if err != nil || !ok {
		t.Fatalf("claim rework worker: claimed=%t err=%v", ok, err)
	}
	if claimed.State != SchedulerRunning || claimed.Advance.State != AdvanceWorking || claimed.Advance.RunID != claimed.RunID || claimed.RunID == "" {
		t.Fatalf("rework claim split worker identity and state across journal writes: %+v", claimed)
	}
}

func TestAutoReviewMissingVerdictEscalatesParentAndChildInOneTransition(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	worker := f.addTask(t, "missing-verdict-parent", "worker")
	worker.OutsideSuites = []string{"kb-runner:./..."}
	worker.Review, worker.Reviewers = "", nil
	store := newSchedulerStore(f.state)
	if err := store.updateTask(worker); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(worker.Workdir, 0o700); err != nil {
		t.Fatal(err)
	}
	parentStream, err := store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(parentStream, SchedulerRunning, "worker", "queue review"); err != nil {
		t.Fatal(err)
	}
	parentStream, _ = store.stream(worker.Stream)
	if err := store.transition(parentStream, SchedulerAwaitingReview, "review task", "run the READY review task"); err != nil {
		t.Fatal(err)
	}
	for _, next := range []StreamAdvanceState{AdvanceWorking, AdvanceVerifying, AdvanceReviewing} {
		if err := store.advance(worker.Stream, next, "", "", schedulerTestSHA); err != nil {
			t.Fatal(err)
		}
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: f.invocationRoot(), state: f.state, supervisor: f.supervisor})
	if err := options.queueAutoReview(worker, ReviewStandard); err != nil {
		t.Fatal(err)
	}
	reviewTask, err := store.task(worker.Stream + "-review-standard-r1")
	if err != nil {
		t.Fatal(err)
	}
	review, err := store.stream(reviewTask.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(review, SchedulerRunning, "review", "record missing verdict"); err != nil {
		t.Fatal(err)
	}
	badReport := "\n## Defects\n\nFindings truncated before verdict.\n"
	runTestReviewJob(t, f.supervisor, f.state, review.RunID, badReport)
	review, _ = store.stream(review.Stream)
	if err := options.finishAutoReview(reviewTask, review); err != nil {
		t.Fatal(err)
	}
	parent, err := store.stream(worker.Stream)
	if err != nil || parent.State != SchedulerAwaitingOrchestrator || parent.Advance.State != AdvanceEscalated || parent.Cause != "review-missing" {
		t.Fatalf("missing verdict did not durably escalate parent: %+v err=%v", parent, err)
	}
	child, err := store.stream(review.Stream)
	if err != nil || child.State != SchedulerAwaitingOrchestrator || child.Cause != "review-missing" {
		t.Fatalf("missing verdict child state=%+v err=%v", child, err)
	}
	for range 2 {
		if err := options.recoverAutoStreams(); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(filepath.Join(store.dir, "auto-transitions"))
	if err != nil {
		t.Fatal(err)
	}
	var last autoTransitionRecord
	if err := readSchedulerJSON(filepath.Join(store.dir, "auto-transitions", entries[len(entries)-1].Name()), &last); err != nil {
		t.Fatal(err)
	}
	if len(last.Streams) != 2 || last.Streams[0].Advance == nil || last.Streams[0].Advance.State != AdvanceEscalated {
		t.Fatalf("parent and review child were not journaled atomically: %+v", last)
	}
	events, err := os.ReadFile(filepath.Join(store.dir, "events.jsonl"))
	if err != nil || strings.Count(string(events), `"status":"escalated"`) != 1 {
		t.Fatalf("missing verdict escalation event count=%d events=%s err=%v", strings.Count(string(events), `"status":"escalated"`), events, err)
	}
}

func TestAutoReviewRecoveryEscalatesParentForAlreadyEscalatedChild(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	worker := f.addTask(t, "recovery-missing-verdict", "worker")
	worker.OutsideSuites = []string{"kb-runner:./..."}
	worker.Review, worker.Reviewers = "", nil
	store := newSchedulerStore(f.state)
	if err := store.updateTask(worker); err != nil {
		t.Fatal(err)
	}
	parent, err := store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(parent, SchedulerRunning, "worker", "queue review"); err != nil {
		t.Fatal(err)
	}
	parent, _ = store.stream(worker.Stream)
	if err := store.transition(parent, SchedulerAwaitingReview, "review task", "run the READY review task"); err != nil {
		t.Fatal(err)
	}
	for _, next := range []StreamAdvanceState{AdvanceWorking, AdvanceVerifying, AdvanceReviewing} {
		if err := store.advance(worker.Stream, next, "", "", schedulerTestSHA); err != nil {
			t.Fatal(err)
		}
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: f.invocationRoot(), state: f.state, supervisor: f.supervisor})
	if err := options.queueAutoReview(worker, ReviewStandard); err != nil {
		t.Fatal(err)
	}
	reviewTask, err := store.task(worker.Stream + "-review-standard-r1")
	if err != nil {
		t.Fatal(err)
	}
	child, err := store.stream(reviewTask.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(child, SchedulerRunning, "review", "simulate prior child-only persistence"); err != nil {
		t.Fatal(err)
	}
	child, _ = store.stream(reviewTask.Stream)
	child.Cause = "review-missing"
	if err := store.transition(child, SchedulerAwaitingOrchestrator, "private review verdict", "inspect the review task report and persisted job record"); err != nil {
		t.Fatal(err)
	}
	if err := options.recoverAutoStreams(); err != nil {
		t.Fatal(err)
	}
	parent, err = store.stream(worker.Stream)
	if err != nil || parent.Advance.State != AdvanceEscalated || parent.State != SchedulerAwaitingOrchestrator {
		t.Fatalf("recovery did not escalate parent for terminal review child: stream=%+v err=%v", parent, err)
	}
	events, err := os.ReadFile(filepath.Join(store.dir, "events.jsonl"))
	if err != nil || strings.Count(string(events), `"status":"escalated"`) != 1 {
		t.Fatalf("recovery escalation event count=%d events=%s err=%v", strings.Count(string(events), `"status":"escalated"`), events, err)
	}
}

func TestAutoLandingRefusalCannotPublishAccepted(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	task := f.addTask(t, "landing-refusal", "worker")
	task.OutsideSuites = []string{"kb-runner:./..."}
	task.Review, task.Reviewers = "", nil
	f.state = filepath.Join(f.repo, "runner-state")
	store := newSchedulerStore(f.state)
	if _, err := store.add(task); err != nil {
		t.Fatal(err)
	}
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(stream, SchedulerRunning, "worker", "seed review-complete state"); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(task.Stream)
	if err := store.transition(stream, SchedulerAwaitingReview, "review task", "run the READY review task"); err != nil {
		t.Fatal(err)
	}
	for _, next := range []StreamAdvanceState{AdvanceWorking, AdvanceVerifying, AdvanceReviewing} {
		if err := store.advance(task.Stream, next, "", "", schedulerTestSHA); err != nil {
			t.Fatal(err)
		}
	}
	stream, _ = store.stream(task.Stream)
	stream.Advance.LastVerdict = "ACCEPT"
	if err := store.commitAutoTransition([]SchedulerStream{stream}); err != nil {
		t.Fatal(err)
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: f.invocationRoot(), state: f.state, supervisor: f.supervisor})
	if err := options.acceptAutoStream(task, stream); err != nil {
		t.Fatal(err)
	}
	got, err := store.stream(task.Stream)
	if err != nil || got.Advance.State != AdvanceEscalated || got.State != SchedulerAwaitingOrchestrator || got.Cause != "landing-refused" {
		t.Fatalf("landing refusal state=%+v err=%v", got, err)
	}
	events, err := os.ReadFile(filepath.Join(store.dir, "events.jsonl"))
	if err != nil || strings.Contains(string(events), `"status":"accepted"`) || strings.Count(string(events), `"status":"escalated"`) != 1 {
		t.Fatalf("landing refusal published acceptance or missed escalation: events=%s err=%v", events, err)
	}
}

type observedJobStoreWrites struct {
	filesystemRunnerStateStore
	writes []string
}

func (store *observedJobStoreWrites) AtomicWrite(path string, data []byte) error {
	store.writes = append(store.writes, path)
	return store.filesystemRunnerStateStore.AtomicWrite(path, data)
}

func TestJobStorePersistsThroughRunnerStateStore(t *testing.T) {
	stateIO := &observedJobStoreWrites{}
	store := newJobStoreWithStateIO(t.TempDir(), stateIO)
	job, err := store.Create(Job{ID: "observed-job", Stream: "observed", Vendor: "codex", State: JobQueued, Phase: PhaseWorktree})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Update(job.ID, func(current *Job) error { current.State = JobRunning; return nil }); err != nil {
		t.Fatal(err)
	}
	if err := store.Terminate(job.ID, JobTerminal{State: JobOK, Phase: PhaseRun, Next: "kb-runner status"}); err != nil {
		t.Fatal(err)
	}
	if len(stateIO.writes) != 3 || !strings.HasSuffix(stateIO.writes[0], "observed-job.json") || !strings.HasSuffix(stateIO.writes[2], "observed-job.json") {
		t.Fatalf("job-store durable writes bypassed runnerStateStore: %v", stateIO.writes)
	}
}

// case: S-237.149
func TestAutoAdvanceFakeSchedulerReworkRecordsBothReviewCallsAndRecoversOnce(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	f.state = filepath.Join(f.home, "runner-state")
	task := f.addTask(t, "auto-scheduler-reject-rework", "worker")
	task.OutsideSuites = []string{"kb-runner:./..."}
	task.Review, task.Reviewers = "", nil
	store := newSchedulerStore(f.state)
	if err := store.updateTask(task); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(task.Workdir, 0o700); err != nil {
		t.Fatal(err)
	}
	report := "Status: DONE\n\n## Design gate\n| root cause | single owner (package/module/file) | rail type | why it is not a shape rail or a copy |\n|---|---|---|---|\n| cause | owner | structured data or contract | owner |\n\n## Verification\nPASS\n\n## Open issues\nNone\n\n## Unrequested behaviour changes\nNone\n\n## Debt self-scan\nNone\n\n## Self-review\nComplete\n\n## Proposed commits\n```json\n[{\"kind\":\"case\",\"subject\":\"docs(qa): specify scheduler lifecycle\",\"body\":\"\"},{\"kind\":\"tests\",\"subject\":\"test(kb-runner): cover review rework\",\"body\":\"\"},{\"kind\":\"code\",\"subject\":\"feat(kb-runner): resume review rework\",\"body\":\"\"}]\n```\n"
	reportPath := filepath.Join(f.home, "complete-worker-report.md")
	if err := os.WriteFile(reportPath, []byte(report), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(task.Workdir, ".agent-report.md"), []byte(report), 0o600); err != nil {
		t.Fatal(err)
	}
	reviewPlan := filepath.Join(f.home, "review-plan.txt")
	if err := os.WriteFile(reviewPlan, []byte("zcode|GLM-5.3-flash|REJECT\ngem|claude-sonnet-4-6|ACCEPT\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_REVIEW_PLAN", reviewPlan)
	t.Setenv("FAKE_AGENT_REPORT", reportPath)
	t.Setenv("FAKE_LANDING_ENTRIES", "1")
	t.Setenv("FAKE_CHANGED_FILES", "docs/qa/scenarios/S-237-process-tree-supervision.md tools/kb-runner/scheduler_test.go tools/kb-runner/scheduler.go")
	t.Setenv("FAKE_BASE_COMMIT", "1111111111111111111111111111111111111111")
	t.Setenv("FAKE_BASE_TREE", "2222222222222222222222222222222222222222")
	t.Setenv("FAKE_OLD_SHA", "3333333333333333333333333333333333333333")
	t.Setenv("FAKE_OLD_TREE", schedulerTestSHA)
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	seedSchedulerWorkerSession(t, store, &stream, "auto-scheduler-rework-session")
	if err := store.transition(stream, SchedulerRunning, "fixture worker", "verify completed worker"); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(task.Stream, AdvanceWorking, "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(task.Stream, AdvanceVerifying, "", "", schedulerTestSHA); err != nil {
		t.Fatal(err)
	}
	stream, err = store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	lifecycle, cancelLifecycle := schedulerLifecycleContext(context.Background())
	defer cancelLifecycle()
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: f.invocationRoot(), state: f.state, supervisor: f.supervisor, lifecycle: lifecycle})
	if err := options.finishAutoWorker(task, stream, "Status: DONE", []byte(report)); err != nil {
		t.Fatal(err)
	}
	if code, output := f.runOnce(t); code != 0 {
		t.Fatalf("reject/rework/accept scheduler exit=%d output=%s", code, output)
	}
	accepted, err := newSchedulerStore(f.state).stream(task.Stream)
	if err != nil || accepted.State != SchedulerDone || accepted.Advance.State != AdvanceAccepted || accepted.Advance.Round != 1 || accepted.ReviewResults[string(ReviewDelta)] != "ACCEPT" {
		t.Fatalf("persisted REJECT did not lead through rework to delta ACCEPT: stream=%+v err=%v %s", accepted, err, agentDispatchDiagnostics(t, f, "", task.Stream))
	}
	firstCall, err := os.ReadFile(filepath.Join(os.Getenv("FAKE_REVIEW_CALLS"), "1"))
	if err != nil || string(firstCall) != "zcode|GLM-5.3-flash|REJECT\n" {
		t.Fatalf("first durable review call=%q err=%v", firstCall, err)
	}
	secondCall, err := os.ReadFile(filepath.Join(os.Getenv("FAKE_REVIEW_CALLS"), "2"))
	if err != nil || string(secondCall) != "gem|claude-sonnet-4-6|ACCEPT\n" {
		t.Fatalf("second durable review call=%q err=%v", secondCall, err)
	}
	launches, err := os.ReadFile(f.launchCalls)
	if err != nil || strings.Count(string(launches), "--stream "+task.Stream+" ") != 1 {
		t.Fatalf("rejected worker was not resumed exactly once: launches=%q err=%v", launches, err)
	}
	gitCalls, err := os.ReadFile(f.gitCalls)
	if err != nil || strings.Count(string(gitCalls), "commit-tree") != 3 {
		t.Fatalf("landed commit set count=%d git calls=%q err=%v", strings.Count(string(gitCalls), "commit-tree"), gitCalls, err)
	}
	restarted := newSchedulerRunOptions(newSchedulerStore(f.state), schedulerRunOptionsConfig{root: f.invocationRoot(), state: f.state, supervisor: f.supervisor})
	for range 2 {
		if err := restarted.recoverAutoStreams(); err != nil {
			t.Fatalf("fresh scheduler recovery: %v", err)
		}
	}
	if got, err := newSchedulerStore(f.state).stream(task.Stream); err != nil || got.State != SchedulerDone || got.Advance.State != AdvanceAccepted {
		t.Fatalf("fresh recovery changed accepted state: stream=%+v err=%v", got, err)
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("FAKE_REVIEW_CALLS"), "3")); !os.IsNotExist(err) {
		t.Fatalf("fresh recovery duplicated a review call: stat error=%v", err)
	}
	gitCallsAfterRecovery, err := os.ReadFile(f.gitCalls)
	if err != nil || strings.Count(string(gitCallsAfterRecovery), "commit-tree") != 3 {
		t.Fatalf("fresh recovery duplicated commit set: git calls=%q err=%v", gitCallsAfterRecovery, err)
	}
}

func TestAutoTransitionReplayRestoresProjectionAndDeliversOutboxOnce(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	task := f.addTask(t, "transactional-auto-stream", "worker")
	store := newSchedulerStore(f.state)
	if err := store.advance(task.Stream, AdvanceWorking, "", "", ""); err != nil {
		t.Fatal(err)
	}
	before, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	accepted := before
	accepted.Advance.State = AdvanceAccepted
	accepted.Advance.LastVerdict = "ACCEPT"
	accepted.Advance.Reason = "all reviews accepted"
	event := streamAdvanceEvent{Kind: "orchestrator.event", Status: "accepted", Stream: accepted.Stream, State: string(AdvanceAccepted), LastVerdict: "ACCEPT"}
	if err := store.commitAutoTransition([]SchedulerStream{accepted}, event); err != nil {
		t.Fatal(err)
	}
	if err := store.writeJSON(store.streamPath(before.Stream), before); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(store.dir, "events.jsonl")); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := newSchedulerStore(f.state).replayAutoTransitions(); err != nil {
			t.Fatal(err)
		}
	}
	recovered, err := newSchedulerStore(f.state).stream(task.Stream)
	if err != nil || recovered.Advance == nil || recovered.Advance.State != AdvanceAccepted {
		t.Fatalf("transaction projection not recovered: stream=%+v err=%v", recovered, err)
	}
	events, err := os.ReadFile(filepath.Join(store.dir, "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(events), `"status":"accepted"`); got != 1 || !strings.Contains(string(events), `"event_id":"00000000000000000003-0"`) {
		t.Fatalf("outbox accepted-event delivery count=%d log=%s", got, events)
	}
}

func TestAutoTransitionRecoveryAfterEachProjectionWrite(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	task := f.addTask(t, "projection-crash-recovery", "worker")
	store := newSchedulerStore(f.state)
	if err := store.advance(task.Stream, AdvanceWorking, "", "", ""); err != nil {
		t.Fatal(err)
	}
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	stream.Advance.State = AdvanceAccepted
	stream.Advance.LastVerdict = "ACCEPT"
	if err := store.commitAutoTransition([]SchedulerStream{stream}, streamAdvanceEvent{Kind: "orchestrator.event", Status: "accepted", Stream: stream.Stream, State: string(AdvanceAccepted), LastVerdict: "ACCEPT"}); err != nil {
		t.Fatal(err)
	}
	journal := filepath.Join(store.dir, "auto-transitions")
	entries, err := os.ReadDir(journal)
	if err != nil {
		t.Fatal(err)
	}
	writes := []struct {
		name string
		path string
	}{}
	outboxWrites := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		var record autoTransitionRecord
		if err := readSchedulerJSON(filepath.Join(journal, entry.Name()), &record); err != nil {
			t.Fatal(err)
		}
		for _, projectedTask := range record.Tasks {
			writes = append(writes, struct{ name, path string }{name: entry.Name() + " task " + projectedTask.ID, path: store.taskPath(projectedTask.ID)})
		}
		for _, projectedStream := range record.Streams {
			writes = append(writes, struct{ name, path string }{name: entry.Name() + " stream " + projectedStream.Stream, path: store.streamPath(projectedStream.Stream)})
		}
		outboxWrites += len(record.Events)
	}
	for index := 0; index < outboxWrites; index++ {
		writes = append(writes, struct{ name, path string }{name: fmt.Sprintf("outbox delivery %d", index+1), path: filepath.Join(store.dir, "events.jsonl")})
	}
	for _, write := range writes {
		t.Run(write.name, func(t *testing.T) {
			if err := os.Remove(write.path); err != nil {
				t.Fatal(err)
			}
			fresh := newSchedulerStore(f.state)
			if err := fresh.replayAutoTransitions(); err != nil {
				t.Fatalf("fresh scheduler recovery after interrupted %s write: %v", write.name, err)
			}
			if err := fresh.replayAutoTransitions(); err != nil {
				t.Fatalf("second recovery after interrupted %s write: %v", write.name, err)
			}
			if _, err := fresh.task(task.ID); err != nil {
				t.Fatalf("task projection not recovered: %v", err)
			}
			got, err := fresh.stream(task.Stream)
			if err != nil || got.Advance == nil || got.Advance.State != AdvanceAccepted {
				t.Fatalf("accepted stream not recovered: stream=%+v err=%v", got, err)
			}
			events, err := os.ReadFile(filepath.Join(fresh.dir, "events.jsonl"))
			seenIDs := map[string]bool{}
			for _, line := range strings.Split(string(events), "\n") {
				var event struct {
					EventID string `json:"event_id"`
				}
				if json.Unmarshal([]byte(line), &event) == nil && event.EventID != "" {
					if seenIDs[event.EventID] {
						t.Fatalf("outbox ID %s was delivered more than once", event.EventID)
					}
					seenIDs[event.EventID] = true
				}
			}
			if err != nil || len(seenIDs) != outboxWrites || strings.Count(string(events), `"status":"accepted"`) != 1 {
				t.Fatalf("accepted outbox event was lost or duplicated: events=%s err=%v", events, err)
			}
		})
	}
}

type observedDurableWrite struct {
	Ordinal    int      `json:"ordinal"`
	Handler    string   `json:"handler"`
	Transition string   `json:"transition"`
	Kind       string   `json:"kind"`
	Path       string   `json:"path,omitempty"`
	PathClass  string   `json:"path_class,omitempty"`
	RunClass   string   `json:"run_class,omitempty"`
	Args       []string `json:"args,omitempty"`
}

type lifecycleCrashStore struct {
	delegate runnerStateStore
	logPath  string
	crashAt  int
	ordinal  int
	mu       sync.Mutex
}

func (store *lifecycleCrashStore) record(write observedDurableWrite) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.ordinal++
	write.Ordinal = store.ordinal
	encoded, err := json.Marshal(write)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(store.logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(append(encoded, '\n'))
	syncErr := file.Sync()
	closeErr := file.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		return err
	}
	if store.crashAt == store.ordinal {
		fmt.Fprintf(os.Stdout, "CRASH %d %s %s\n", store.ordinal, write.Kind, write.Path)
		if err := syscall.Kill(os.Getpid(), syscall.SIGSTOP); err != nil {
			return fmt.Errorf("stop lifecycle child after observed durable write: %w", err)
		}
		select {}
	}
	return nil
}

type lifecycleCrashSupervisor struct {
	schedulerJobSupervisor
	store *lifecycleCrashStore
}

type lifecycleRealSupervisor struct{ clikitSchedulerSupervisor }

func (lifecycleRealSupervisor) Start(ctx context.Context, config proc.Config) (schedulerJobRun, error) {
	return proc.Start(ctx, config)
}

func (supervisor lifecycleCrashSupervisor) Start(ctx context.Context, config proc.Config) (schedulerJobRun, error) {
	write := observedDurableWrite{Kind: "process-owner-absent", Path: config.RunID}
	runClass, err := lifecycleConfiguredRunClass(config)
	if err != nil {
		return nil, err
	}
	write.RunClass = runClass
	if err := supervisor.store.record(supervisor.store.label(write, "kb-runner/internal/proc-boundary")); err != nil {
		return nil, err
	}
	run, err := supervisor.schedulerJobSupervisor.Start(ctx, config)
	if err != nil {
		return nil, err
	}
	if _, err := proc.ReadRunRecord(config.StateDir, config.RunID); err != nil {
		return nil, fmt.Errorf("Start returned before process-owner record became readable for %s: %w", config.RunID, err)
	}
	write.Kind = "process-owner-present"
	runRecord, err := proc.ReadRunRecord(config.StateDir, config.RunID)
	if err != nil {
		return nil, fmt.Errorf("read process-owner record after Start for %s: %w", config.RunID, err)
	}
	write.RunClass, err = schedulerLifecycleRunClass(config.StateDir, runRecord)
	if err != nil {
		return nil, err
	}
	if err := supervisor.store.record(supervisor.store.label(write, "kb-runner/internal/proc-boundary")); err != nil {
		return nil, err
	}
	return run, nil
}

func lifecycleConfiguredRunClass(config proc.Config) (string, error) {
	store := newSchedulerStore(config.StateDir)
	streams, err := store.streams()
	if err != nil {
		return "", fmt.Errorf("classify configured run %s from scheduler journal: %w", config.RunID, err)
	}
	for _, stream := range streams {
		if stream.Advance != nil && stream.Advance.RunID == config.RunID {
			return "advance:" + string(stream.Advance.State), nil
		}
		if stream.RunID == config.RunID {
			task, taskErr := store.task(stream.TaskID)
			if taskErr != nil {
				return "", fmt.Errorf("classify configured run %s from task %s: %w", config.RunID, stream.TaskID, taskErr)
			}
			return "scheduler:" + task.Role + ":" + string(task.ReviewerKind) + ":" + task.Vendor, nil
		}
	}
	return string(config.CostClass) + ":" + config.CostKey, nil
}

func TestLifecycleCrashSupervisorRecordsStartErrorBoundary(t *testing.T) {
	state := t.TempDir()
	writeLog := filepath.Join(t.TempDir(), "process-owner-boundary.jsonl")
	observer := &lifecycleCrashStore{delegate: filesystemRunnerStateStore{}, logPath: writeLog}
	supervisor := lifecycleCrashSupervisor{schedulerJobSupervisor: lifecycleRealSupervisor{}, store: observer}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	run, err := supervisor.Start(ctx, proc.Config{
		StateDir: state, Tag: "start-error", RunID: "start-error-run", Stall: time.Minute,
		StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
	})
	if err == nil || run != nil {
		if run != nil {
			_ = run.Wait()
		}
		t.Fatalf("invalid Start returned run=%v err=%v; want Start error", run, err)
	}
	if _, readErr := proc.ReadRunRecord(state, "start-error-run"); !errors.Is(readErr, os.ErrNotExist) {
		t.Fatalf("failed Start published a process-owner record: %v", readErr)
	}
	data, readErr := os.ReadFile(writeLog)
	if readErr != nil {
		t.Fatal(readErr)
	}
	var writes []observedDurableWrite
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var write observedDurableWrite
		if decodeErr := json.Unmarshal([]byte(line), &write); decodeErr != nil {
			t.Fatalf("decode process-owner boundary %q: %v", line, decodeErr)
		}
		writes = append(writes, write)
	}
	if len(writes) != 1 || writes[0].Kind != "process-owner-absent" || writes[0].Path != "start-error-run" {
		t.Fatalf("Start-error process-owner observations=%+v; want only absent-before-Start", writes)
	}
}

func (store *lifecycleCrashStore) AtomicWrite(path string, data []byte) error {
	if err := store.delegate.AtomicWrite(path, data); err != nil {
		return err
	}
	return store.record(store.label(observedDurableWrite{Kind: "atomic-write", Path: path}, "AtomicWrite"))
}

func (store *lifecycleCrashStore) Append(path string, data []byte, mode os.FileMode) error {
	if err := store.delegate.Append(path, data, mode); err != nil {
		return err
	}
	return store.record(store.label(observedDurableWrite{Kind: "append", Path: path}, "Append"))
}

func (store *lifecycleCrashStore) GitMutation(dir string, environment []string, args ...string) (string, error) {
	output, err := store.delegate.GitMutation(dir, environment, args...)
	if err != nil {
		return output, err
	}
	if err := store.record(store.label(observedDurableWrite{Kind: "git-mutation", Path: dir, Args: append([]string(nil), args...)}, "GitMutation")); err != nil {
		return "", err
	}
	return output, nil
}

func (store *lifecycleCrashStore) label(write observedDurableWrite, handler string) observedDurableWrite {
	write.Handler = handler
	write.Transition = os.Getenv("KB_RUNNER_LIFECYCLE_CRASH_STREAM")
	if write.Path != "" && write.PathClass == "" {
		write.PathClass = filepath.Ext(write.Path)
	}
	return write
}

func TestSchedulerLifecycleCrashChild(t *testing.T) {
	mode := os.Getenv("KB_RUNNER_LIFECYCLE_CRASH_MODE")
	if mode == "" {
		return
	}
	state := os.Getenv("KB_RUNNER_LIFECYCLE_CRASH_STATE")
	stream := os.Getenv("KB_RUNNER_LIFECYCLE_CRASH_STREAM")
	storeIO := &lifecycleCrashStore{delegate: filesystemRunnerStateStore{}, logPath: os.Getenv("KB_RUNNER_LIFECYCLE_CRASH_WRITES")}
	if mode == "crash" {
		var err error
		storeIO.crashAt, err = strconv.Atoi(os.Getenv("KB_RUNNER_LIFECYCLE_CRASH_ORDINAL"))
		if err != nil || storeIO.crashAt < 1 {
			t.Fatalf("invalid crash ordinal: %q", os.Getenv("KB_RUNNER_LIFECYCLE_CRASH_ORDINAL"))
		}
	} else if mode != "record" && mode != "recover" {
		t.Fatalf("unknown lifecycle crash mode %q", mode)
	}
	if mode != "recover" {
		prompt := os.Getenv("KB_RUNNER_LIFECYCLE_CRASH_PROMPT")
		task := SchedulerTask{
			ID: stream + "-worker", Stream: stream, Prompt: prompt,
			Workdir:      filepath.Join(os.Getenv("KBLABS_WORKTREES_ROOT"), stream),
			WorktreeRoot: os.Getenv("KBLABS_WORKTREES_ROOT"), RepoRoot: os.Getenv("FAKE_REPO"),
			Base: "main", Priority: 4, Vendor: "codex", Effort: "high", Role: schedulerWorkerRole,
			OutsideSuites: []string{"kb-runner:./..."},
		}
		if _, err := newSchedulerStoreWithStateIO(state, storeIO).add(task); err != nil {
			t.Fatalf("enqueue lifecycle worker: %v", err)
		}
	}
	var supervisor schedulerJobSupervisor
	switch os.Getenv("KB_RUNNER_LIFECYCLE_SUPERVISOR") {
	case "", "fake":
		supervisor = newFakeSchedulerSupervisor()
	case "real":
		supervisor = lifecycleRealSupervisor{}
	default:
		t.Fatalf("unknown lifecycle supervisor %q", os.Getenv("KB_RUNNER_LIFECYCLE_SUPERVISOR"))
	}
	if mode == "recover" {
		supervisor = lifecycleCrashSupervisor{schedulerJobSupervisor: supervisor, store: storeIO}
		if err := runLifecycleUntilTerminal(t, runnerRootFromFixtureEnv(t), state, stream, filesystemRunnerStateStore{}, supervisor); err != nil {
			t.Fatal(err)
		}
		return
	}
	watchContext, stopWatching := context.WithCancel(context.Background())
	watchResult := make(chan error, 1)
	supervisor = lifecycleCrashSupervisor{schedulerJobSupervisor: supervisor, store: storeIO}
	go func() { watchResult <- observeLifecycleRunCompletions(watchContext, state, storeIO, supervisor) }()
	runErr := runLifecycleUntilTerminal(t, runnerRootFromFixtureEnv(t), state, stream, storeIO, supervisor)
	stopWatching()
	watchErr := <-watchResult
	if runErr != nil {
		t.Fatalf("run real scheduler lifecycle: %v", runErr)
	}
	if watchErr != nil {
		t.Fatalf("observe completed external jobs: %v", watchErr)
	}
}

func observeLifecycleRunCompletions(ctx context.Context, state string, store *lifecycleCrashStore, supervisor schedulerJobSupervisor) error {
	seen := make(map[string]struct{})
	observe := func() error {
		listing := supervisor.List(state)
		if listing.Error != nil {
			return fmt.Errorf("inspect durable external job records: %w", listing.Error)
		}
		runs := append([]proc.RunInfo(nil), listing.Runs...)
		sort.Slice(runs, func(i, j int) bool { return runs[i].RunID < runs[j].RunID })
		for _, run := range runs {
			if !run.Status.Terminal() {
				continue
			}
			if _, exists := seen[run.RunID]; exists {
				continue
			}
			seen[run.RunID] = struct{}{}
			class, err := schedulerLifecycleRunClass(state, run)
			if err != nil {
				return err
			}
			write := observedDurableWrite{Kind: "job-completion-record", Path: run.RunID, PathClass: class}
			if err := store.record(store.label(write, "kb-runner/internal/proc")); err != nil {
				return err
			}
		}
		return nil
	}
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := observe(); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return observe()
		case <-ticker.C:
		}
	}
}

func schedulerLifecycleRunClass(state string, run proc.RunInfo) (string, error) {
	store := newSchedulerStore(state)
	streams, err := store.streams()
	if err != nil {
		return "", fmt.Errorf("classify completed run %s from scheduler journal: %w", run.RunID, err)
	}
	for _, stream := range streams {
		task, err := store.task(stream.TaskID)
		if err != nil {
			return "", fmt.Errorf("classify completed run %s from task %s: %w", run.RunID, stream.TaskID, err)
		}
		if stream.Advance != nil && stream.Advance.RunID == run.RunID {
			return "advance:" + string(stream.Advance.State), nil
		}
		if stream.RunID == run.RunID {
			return "scheduler:" + task.Role + ":" + string(task.ReviewerKind) + ":" + task.Vendor, nil
		}
		if stream.JobID != "" {
			job, err := newJobStore(state).Get(stream.JobID)
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return "", fmt.Errorf("classify completed run %s from job %s: %w", run.RunID, stream.JobID, err)
			}
			if err == nil && job.RunID == run.RunID {
				return "job:" + task.Role + ":" + string(task.ReviewerKind), nil
			}
		}
	}
	return string(run.CostClass) + ":" + run.CostKey, nil
}

func runLifecycleUntilTerminal(t *testing.T, root runnerRoot, state, stream string, storeIO runnerStateStore, supervisor schedulerJobSupervisor) error {
	t.Helper()
	for attempt := 0; attempt < 16; attempt++ {
		code, err := runSchedulerUsingDependencies(context.Background(), root, state, 1, true, storeIO, supervisor)
		if err != nil || code != 0 {
			streams, streamsErr := newSchedulerStore(state).streams()
			tasks, tasksErr := newSchedulerStore(state).tasks()
			return fmt.Errorf("scheduler pass %d exited %d: %w; streams=%+v streams_error=%v tasks=%+v tasks_error=%v", attempt+1, code, err, streams, streamsErr, tasks, tasksErr)
		}
		current, err := newSchedulerStore(state).stream(stream)
		if err != nil {
			return err
		}
		if current.State == SchedulerDone || current.State == SchedulerAwaitingOrchestrator || current.State == SchedulerFailed {
			return nil
		}
	}
	current, streamErr := newSchedulerStore(state).stream(stream)
	tasks, tasksErr := newSchedulerStore(state).tasks()
	return fmt.Errorf("scheduler lifecycle for %s did not reach a terminal state after %d passes: stream=%+v stream_error=%v tasks=%+v tasks_error=%v", stream, 16, current, streamErr, tasks, tasksErr)
}

type lifecycleCrashScenario struct {
	name           string
	workerStatuses []string
	reviewPlan     []string
	terminalState  SchedulerStreamState
	advanceState   StreamAdvanceState
}

const lifecycleChildOutputLimit = 16 * 1024

type lifecycleOutputTail struct {
	data []byte
}

func (tail *lifecycleOutputTail) Write(data []byte) (int, error) {
	if len(data) >= lifecycleChildOutputLimit {
		tail.data = append(tail.data[:0], data[len(data)-lifecycleChildOutputLimit:]...)
		return len(data), nil
	}
	tail.data = append(tail.data, data...)
	if len(tail.data) > lifecycleChildOutputLimit {
		tail.data = append(tail.data[:0], tail.data[len(tail.data)-lifecycleChildOutputLimit:]...)
	}
	return len(data), nil
}

func (tail *lifecycleOutputTail) String() string { return string(tail.data) }

func TestLifecycleChildOutputTailIsBounded(t *testing.T) {
	tail := lifecycleOutputTail{}
	input := bytes.Repeat([]byte("x"), lifecycleChildOutputLimit+7)
	if written, err := tail.Write(input); err != nil || written != len(input) {
		t.Fatalf("write child output tail: written=%d err=%v", written, err)
	}
	if len(tail.data) != lifecycleChildOutputLimit || tail.String() != string(input[len(input)-lifecycleChildOutputLimit:]) {
		t.Fatalf("child output tail length=%d, want %d and final bytes preserved", len(tail.data), lifecycleChildOutputLimit)
	}
}

func TestLifecycleChildFailureDetailsIncludeAdmissionReasons(t *testing.T) {
	fixture := newSchedulerFixture(t, `[]`, `{}`)
	if err := os.MkdirAll(fixture.state, 0o700); err != nil {
		t.Fatal(err)
	}
	queued, err := json.Marshal(proc.Event{Type: proc.EventQueued, RunID: "run-queued", Tag: "outside-suite", Reason: "host pressure: memory warn"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture.state, "events.jsonl"), append(queued, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr lifecycleOutputTail
	details := lifecycleChildFailureDetails(fixture, "stream", &stdout, &stderr)
	if !strings.Contains(details, "host pressure: memory warn") {
		t.Fatalf("lifecycle child failure diagnostics omit queued admission reason: %s", details)
	}
}

func TestLifecycleChildFailureDetailsPutRecoveryDiagnosticFirst(t *testing.T) {
	fixture := newSchedulerFixture(t, `[]`, `{}`)
	stdout := &lifecycleOutputTail{}
	stderr := &lifecycleOutputTail{}
	if _, err := stderr.Write([]byte("run record lost; next: kb-runner sched ps --state /state --json")); err != nil {
		t.Fatal(err)
	}
	details := lifecycleChildFailureDetails(fixture, "stream", stdout, stderr)
	if strings.Index(details, "run record lost") < 0 || strings.Index(details, "next:") < 0 || strings.Index(details, "recovery_stderr_tail=") > strings.Index(details, "admission_runs=") {
		t.Fatalf("recovery diagnostic/next command is not emitted before verbose process records: %s", details)
	}
}

func TestLifecycleCrashBoundaryDiagnosticIncludesWriteOwner(t *testing.T) {
	write := observedDurableWrite{Ordinal: 42, Handler: "Append", Transition: "reviewing", Kind: "append", Path: "sched/events.jsonl"}
	details := lifecycleCrashBoundaryDiagnostic(write)
	for _, want := range []string{"Ordinal:42", "Handler:Append", "Transition:reviewing", "Path:sched/events.jsonl"} {
		if !strings.Contains(details, want) {
			t.Fatalf("crash boundary diagnostic missing %q: %s", want, details)
		}
	}
}

func TestAutoAdvanceRecoveryRequeuesLostExternalRunsWithFreshIDs(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	f.state = filepath.Join(f.home, "runner-state")
	store := newSchedulerStore(f.state)
	worker := f.addTask(t, "lost-external-run", "worker")
	if err := os.MkdirAll(worker.Workdir, 0o700); err != nil {
		t.Fatal(err)
	}
	worker.OutsideSuites = []string{"kb-runner:./..."}
	worker.Review, worker.Reviewers = "", nil
	if err := store.updateTask(worker); err != nil {
		t.Fatal(err)
	}
	workerStream, err := store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(workerStream, SchedulerRunning, "fixture", "worker report persisted"); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(worker.Stream, AdvanceWorking, "", "", ""); err != nil {
		t.Fatal(err)
	}
	oldVerificationRunID, err := proc.AllocateRunID()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.advanceWithRunID(worker.Stream, AdvanceVerifying, "", "", schedulerTestSHA, oldVerificationRunID); err != nil {
		t.Fatal(err)
	}
	if err := proc.WriteRunRecord(f.state, proc.RunInfo{RunID: oldVerificationRunID, Tag: oldVerificationRunID, PID: 123, Identity: "gone", Status: proc.StatusLost, Error: "process disappeared"}); err != nil {
		t.Fatal(err)
	}
	report := []byte("Status: DONE\n\n## Design gate\n| root cause | single owner (package/module/file) | rail type | why it is not a shape rail or a copy |\n|---|---|---|---|\n| cause | owner | structured data or contract | owner |\n\n## Verification\nPASS\n\n## Open issues\nNone\n\n## Unrequested behaviour changes\nNone\n\n## Debt self-scan\nNone\n\n## Self-review\nComplete\n")
	if err := os.WriteFile(workerReportPath(worker), report, 0o600); err != nil {
		t.Fatal(err)
	}

	reviewWorker := f.addTask(t, "lost-review-run", "worker")
	reviewWorker.OutsideSuites = []string{"kb-runner:./..."}
	reviewWorker.Review, reviewWorker.Reviewers = "", nil
	if err := store.updateTask(reviewWorker); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(reviewWorker.Workdir, 0o700); err != nil {
		t.Fatal(err)
	}
	workerStream, err = store.stream(reviewWorker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(workerStream, SchedulerRunning, "fixture", "worker report persisted"); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(reviewWorker.Stream, AdvanceWorking, "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(reviewWorker.Stream, AdvanceVerifying, "", "", schedulerTestSHA); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(reviewWorker.Stream, AdvanceReviewing, "", "", schedulerTestSHA); err != nil {
		t.Fatal(err)
	}
	workerStream, err = store.stream(reviewWorker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(workerStream, SchedulerAwaitingReview, "fixture", "review task persisted"); err != nil {
		t.Fatal(err)
	}
	review, err := store.add(SchedulerTask{Stream: reviewWorker.Stream + "-review-standard-r1", PromptTemplate: runnerReviewTemplate, Workdir: reviewWorker.Workdir, WorktreeRoot: reviewWorker.WorktreeRoot, RepoRoot: reviewWorker.RepoRoot, Base: reviewWorker.Base, Vendor: "zcode", Model: "GLM-5.3-flash", Effort: reviewWorker.Effort, Role: schedulerReviewRole, ReviewerKind: ReviewStandard, DependsOn: []string{reviewWorker.ID}})
	if err != nil {
		t.Fatal(err)
	}
	reviewStream, err := store.stream(review.Stream)
	if err != nil {
		t.Fatal(err)
	}
	oldReviewRunID, err := proc.AllocateRunID()
	if err != nil {
		t.Fatal(err)
	}
	reviewStream.RunID = oldReviewRunID
	if err := store.commitAutoTransition([]SchedulerStream{reviewStream}); err != nil {
		t.Fatal(err)
	}
	reviewStream, err = store.stream(review.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(reviewStream, SchedulerRunning, "review dispatch", "review task started"); err != nil {
		t.Fatal(err)
	}
	if err := proc.WriteRunRecord(f.state, proc.RunInfo{RunID: oldReviewRunID, Tag: oldReviewRunID, PID: 123, Identity: "gone", Status: proc.StatusLost, Error: "process disappeared"}); err != nil {
		t.Fatal(err)
	}
	workerLost := f.addTask(t, "lost-worker-run", "worker")
	workerLost.OutsideSuites = []string{"kb-runner:./..."}
	workerLost.Review, workerLost.Reviewers = "", nil
	if err := store.updateTask(workerLost); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(workerLost.Workdir, 0o700); err != nil {
		t.Fatal(err)
	}
	workerLostStream, err := store.stream(workerLost.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(workerLostStream, SchedulerRunning, "fixture", "worker started"); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(workerLost.Stream, AdvanceWorking, "", "", ""); err != nil {
		t.Fatal(err)
	}
	workerLostRunID, err := proc.AllocateRunID()
	if err != nil {
		t.Fatal(err)
	}
	workerLostStream, err = store.stream(workerLost.Stream)
	if err != nil {
		t.Fatal(err)
	}
	workerLostStream.RunID = workerLostRunID
	if err := store.commitAutoTransition([]SchedulerStream{workerLostStream}); err != nil {
		t.Fatal(err)
	}
	if err := proc.WriteRunRecord(f.state, proc.RunInfo{RunID: workerLostRunID, Tag: workerLostRunID, PID: 123, Identity: "gone", Status: proc.StatusLost, Error: "process disappeared"}); err != nil {
		t.Fatal(err)
	}
	lifecycle, cancelLifecycle := schedulerLifecycleContext(context.Background())
	defer cancelLifecycle()
	options := newSchedulerRunOptions(newSchedulerStore(f.state), schedulerRunOptionsConfig{root: f.invocationRoot(), state: f.state, supervisor: f.supervisor, lifecycle: lifecycle})
	if err := options.recoverAutoStreams(); err != nil {
		t.Fatalf("recover lost external run identities: %v", err)
	}
	gotWorker, err := newSchedulerStore(f.state).stream(worker.Stream)
	if err != nil || gotWorker.Advance.State != AdvanceVerifying || gotWorker.Advance.RunID == oldVerificationRunID || gotWorker.Advance.RunID == "" {
		t.Fatalf("lost verification identity was not replaced durably: stream=%+v err=%v", gotWorker, err)
	}
	gotReview, err := newSchedulerStore(f.state).stream(review.Stream)
	if err != nil || gotReview.State != SchedulerRunning || gotReview.RunID == oldReviewRunID || gotReview.RunID == "" {
		t.Fatalf("lost review did not retain its running task with a fresh run identity: stream=%+v err=%v", gotReview, err)
	}
	if record, exists, err := f.supervisor.RunByID(f.state, gotReview.RunID); err != nil || exists || record.RunID != "" {
		t.Fatalf("replacement review run must remain unstarted until dispatch: record=%+v exists=%t err=%v", record, exists, err)
	}
	gotWorkerLost, err := newSchedulerStore(f.state).stream(workerLost.Stream)
	if err != nil || gotWorkerLost.State != SchedulerReady || gotWorkerLost.RunID == workerLostRunID || gotWorkerLost.RunID == "" {
		t.Fatalf("lost worker was not returned to READY with a fresh run identity: stream=%+v err=%v", gotWorkerLost, err)
	}
}

func TestLifecycleChildCancellationIncludesSIGQUITDump(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestLifecycleSIGQUITChild$")
	if err := configureLifecycleChildCancellation(child); err != nil {
		t.Fatal(err)
	}
	child.Env = append(os.Environ(), "KB_RUNNER_LIFECYCLE_SIGQUIT_CHILD=1")
	var stdout, stderr lifecycleOutputTail
	child.Stdout, child.Stderr = &stdout, &stderr
	err := child.Run()
	if err == nil || !strings.Contains(stderr.String(), "goroutine") {
		t.Fatalf("timed lifecycle child err=%v stdout_tail=%q stderr_goroutine_dump_tail=%q; expected SIGQUIT dump", err, stdout.String(), stderr.String())
	}
}

func TestLifecycleSIGQUITChild(t *testing.T) {
	if os.Getenv("KB_RUNNER_LIFECYCLE_SIGQUIT_CHILD") != "1" {
		return
	}
	select {}
}

func TestSchedulerTransitionCrashMatrix(t *testing.T) {
	// The default tier is class-reduced; T3/T4 enumerate every observed
	// runner-store write. Process-owner coverage is at the supervisor API
	// boundary: absent before Start, readable after Start returns, and Start
	// errors leave no record. The writer failure contract is tested by the
	// kb-runner internal supervisor at its record-owner boundary.
	// T3 is a nightly tier with a declared 20-minute budget.
	scenarios := []lifecycleCrashScenario{
		{name: "reject-rework-accept-land", workerStatuses: []string{"Status: DONE", "Status: DONE"}, reviewPlan: []string{"zcode|GLM-5.3-flash|REJECT", "gem|claude-sonnet-4-6|ACCEPT"}, terminalState: SchedulerDone, advanceState: AdvanceAccepted},
		{name: "partial-resume", workerStatuses: []string{"Status: PARTIAL", "Status: DONE"}, reviewPlan: []string{"zcode|GLM-5.3-flash|ACCEPT"}, terminalState: SchedulerDone, advanceState: AdvanceAccepted},
		{name: "escalation", workerStatuses: []string{"Status: BLOCKED"}, terminalState: SchedulerAwaitingOrchestrator, advanceState: AdvanceEscalated},
		{name: "vendor-limit-fallback", workerStatuses: []string{"Status: DONE", "Status: DONE"}, reviewPlan: []string{"zcode|GLM-5.3-flash|REJECT", "gem|claude-sonnet-4-6|VENDOR_LIMIT", "zcode|GLM-5.3-flash|ACCEPT"}, terminalState: SchedulerDone, advanceState: AdvanceAccepted},
	}
	for _, scenario := range scenarios {
		scenario := scenario
		t.Run(scenario.name, func(t *testing.T) {
			t.Parallel()
			reference := runLifecycleReference(t, scenario)
			if reference.observations == 0 {
				t.Fatal("real scheduler lifecycle produced no observed durable writes")
			}
			started := time.Now()
			tier := testTier()
			ordinals, classes := lifecycleCrashOrdinals(t, scenario, reference.writes, tier)
			selectedWrites := make(map[int]bool, len(ordinals))
			for _, ordinal := range ordinals {
				selectedWrites[ordinal] = true
			}
			seenProcessOwnerClasses := make(map[string]bool)
			for _, write := range reference.writes {
				if write.Kind != "process-owner-present" || write.RunClass == "" || seenProcessOwnerClasses[write.RunClass] {
					continue
				}
				seenProcessOwnerClasses[write.RunClass] = true
				if !selectedWrites[write.Ordinal] {
					t.Fatalf("default crash tier omitted process-owner run class %q at its first observed boundary", write.RunClass)
				}
			}
			t.Logf("crash matrix tier=%s scenario=%s classes=%d selected=%d of %d observed writes", tier, scenario.name, classes, len(ordinals), reference.observations)
			for _, ordinal := range ordinals {
				t.Run(fmt.Sprintf("after-write-%d", ordinal), func(t *testing.T) {
					fixture := prepareLifecycleCrashFixture(t, scenario)
					writeLog := filepath.Join(fixture.home, "crash-writes.jsonl")
					ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
					defer cancel()
					child, err := lifecycleChildCommand(ctx, fixture, scenario, "crash", writeLog, ordinal)
					if err != nil {
						t.Fatal(err)
					}
					var stdout, stderr lifecycleOutputTail
					child.Stdout = &stdout
					child.Stderr = &stderr
					if err := child.Start(); err != nil {
						t.Fatalf("start lifecycle child: %v; %s", err, lifecycleChildFailureDetails(fixture, scenario.name, &stdout, &stderr))
					}
					childDone := make(chan error, 1)
					go func() { childDone <- child.Wait() }()
					childWaited := false
					t.Cleanup(func() {
						if !childWaited {
							_ = syscall.Kill(-child.Process.Pid, syscall.SIGQUIT)
							select {
							case <-childDone:
							case <-time.After(3 * time.Second):
								_ = syscall.Kill(-child.Process.Pid, syscall.SIGKILL)
								<-childDone
							}
						}
					})
					ticker := time.NewTicker(5 * time.Millisecond)
					defer ticker.Stop()
					timeout := time.NewTimer(15 * time.Second)
					defer timeout.Stop()
					observed := false
					for {
						data, readErr := os.ReadFile(writeLog)
						if readErr == nil && countCrashWriteLines(data) >= ordinal {
							observed = true
							break
						}
						select {
						case childErr := <-childDone:
							childWaited = true
							t.Fatalf("child exited before durable write %d: %v; %s", ordinal, childErr, lifecycleChildFailureDetails(fixture, scenario.name, &stdout, &stderr))
						case <-ticker.C:
						case <-timeout.C:
							t.Fatalf("child did not reach durable write %d in 15s: log=%s; %s", ordinal, data, lifecycleChildFailureDetails(fixture, scenario.name, &stdout, &stderr))
						}
					}
					if !observed {
						t.Fatalf("child did not observe durable write %d", ordinal)
					}
					if err := syscall.Kill(-child.Process.Pid, syscall.SIGKILL); err != nil {
						t.Fatalf("kill scheduler process group after durable write %d: %v; %s", ordinal, err, lifecycleChildFailureDetails(fixture, scenario.name, &stdout, &stderr))
					}
					<-childDone
					childWaited = true
					recoveryLog := filepath.Join(fixture.home, fmt.Sprintf("recovery-writes-%d.jsonl", ordinal))
					observedWrite, err := lifecycleWriteAt(writeLog, ordinal)
					if err != nil {
						t.Fatalf("read crash boundary %d: %v", ordinal, err)
					}
					crashedStream, streamErr := newSchedulerStore(fixture.state).stream(scenario.name)
					t.Logf("crash boundary=%+v persisted_stream=%+v stream_error=%v", observedWrite, crashedStream, streamErr)
					if err := runLifecycleRecoveryChild(t, fixture, scenario, recoveryLog); err != nil {
						t.Fatalf("fresh scheduler recovery after durable write %d (%s): %v; %s", ordinal, lifecycleCrashBoundaryDiagnostic(observedWrite), err, lifecycleChildFailureDetails(fixture, scenario.name, &stdout, &stderr))
					}
					if observedWrite.Kind == "process-owner-absent" {
						runIDs, err := lifecycleBoundaryRunIDs(recoveryLog, "process-owner-absent")
						found := false
						for _, runID := range runIDs {
							found = found || runID == observedWrite.Path
						}
						if err != nil || !found {
							t.Fatalf("never-started claim was not retried with journaled run ID %s: found=%t observed=%v err=%v", observedWrite.Path, found, runIDs, err)
						}
					}
					got := snapshotLifecycleResult(t, fixture, scenario)
					if !reflect.DeepEqual(reference.result, got) {
						t.Fatalf("recovered lifecycle differs from uncrashed reference after durable write %d (%s)\nreference=%s\nrecovered=%s\n%s", ordinal, lifecycleCrashBoundaryDiagnostic(observedWrite), reference.result, got, lifecycleChildFailureDetails(fixture, scenario.name, &stdout, &stderr))
					}
					before := got
					if err := runLifecycleRecoveryChild(t, fixture, scenario, filepath.Join(fixture.home, fmt.Sprintf("second-recovery-writes-%d.jsonl", ordinal))); err != nil {
						t.Fatalf("second fresh recovery: %v; %s", err, lifecycleChildFailureDetails(fixture, scenario.name, &stdout, &stderr))
					}
					if after := snapshotLifecycleResult(t, fixture, scenario); !reflect.DeepEqual(before, after) {
						t.Fatalf("second recovery changed lifecycle state\nbefore=%s\nafter=%s\n%s", before, after, lifecycleChildFailureDetails(fixture, scenario.name, &stdout, &stderr))
					}
				})
			}
			t.Logf("crash matrix scenario=%s matrix-wall=%s", scenario.name, time.Since(started))
		})
	}
}

// case: S-237.149
func TestSchedulerUnknownRunRecordCrashRecoveryContinuesOtherStreams(t *testing.T) {
	scenario := lifecycleCrashScenario{name: "unknown-run-crash", workerStatuses: []string{"Status: DONE"}, terminalState: SchedulerAwaitingOrchestrator, advanceState: AdvanceEscalated}
	fixture := prepareLifecycleCrashFixture(t, scenario)
	releaseFIFO := filepath.Join(fixture.home, "release-blocked-agent.fifo")
	if err := syscall.Mkfifo(releaseFIFO, 0o600); err != nil {
		t.Fatal(err)
	}
	setSchedulerFixtureEnv(t, &fixture, true, "FAKE_AGENT_BLOCK_STREAM", scenario.name)
	setSchedulerFixtureEnv(t, &fixture, true, "FAKE_AGENT_RELEASE_FIFO", releaseFIFO)
	writeLog := filepath.Join(fixture.home, "unknown-run-crash-writes.jsonl")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	child, err := lifecycleChildCommand(ctx, fixture, scenario, "record", writeLog, 0)
	if err != nil {
		t.Fatal(err)
	}
	var stdout, stderr lifecycleOutputTail
	child.Stdout, child.Stderr = &stdout, &stderr
	if err := child.Start(); err != nil {
		t.Fatalf("start lifecycle before corrupt-record crash: %v", err)
	}
	childDone := make(chan error, 1)
	go func() { childDone <- child.Wait() }()
	childWaited := false
	t.Cleanup(func() {
		if !childWaited {
			_ = syscall.Kill(-child.Process.Pid, syscall.SIGQUIT)
			select {
			case <-childDone:
			case <-time.After(3 * time.Second):
				_ = syscall.Kill(-child.Process.Pid, syscall.SIGKILL)
				<-childDone
			}
		}
	})
	deadline := time.NewTimer(15 * time.Second)
	ticker := time.NewTicker(5 * time.Millisecond)
	defer deadline.Stop()
	defer ticker.Stop()
	var runID string
	for runID == "" {
		if runIDs, err := lifecycleBoundaryRunIDs(writeLog, "process-owner-present"); err == nil && len(runIDs) > 0 {
			runID = runIDs[0]
			break
		}
		select {
		case childErr := <-childDone:
			childWaited = true
			t.Fatalf("lifecycle exited before process-owner Start boundary: %v; %s", childErr, lifecycleChildFailureDetails(fixture, scenario.name, &stdout, &stderr))
		case <-ticker.C:
		case <-deadline.C:
			t.Fatalf("lifecycle did not publish process-owner Start boundary; %s", lifecycleChildFailureDetails(fixture, scenario.name, &stdout, &stderr))
		}
	}
	if err := syscall.Kill(-child.Process.Pid, syscall.SIGKILL); err != nil {
		t.Fatalf("crash lifecycle after process-owner Start boundary: %v", err)
	}
	<-childDone
	childWaited = true
	corruptExistingProcessOwnerRunRecord(t, fixture.state, runID)

	store := newSchedulerStore(fixture.state)
	otherPrompt := filepath.Join(fixture.repo, "z-independent-stream.md")
	if err := os.WriteFile(otherPrompt, []byte("other stream recovery fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	otherTask, err := store.add(SchedulerTask{
		Stream: "z-independent-stream", Prompt: otherPrompt, Workdir: filepath.Join(fixture.worktrees, "z-independent-stream"),
		WorktreeRoot: fixture.worktrees, RepoRoot: fixture.repo, Base: "main", Priority: 4, Vendor: "codex", Effort: "high", Role: schedulerWorkerRole,
	})
	if err != nil {
		t.Fatal(err)
	}
	otherTask.OutsideSuites = []string{"kb-runner:./..."}
	otherTask.Review, otherTask.Reviewers = "", nil
	if err := store.updateTask(otherTask); err != nil {
		t.Fatal(err)
	}
	other, err := store.stream(otherTask.Stream)
	if err != nil {
		t.Fatal(err)
	}
	other.State, other.Cause = SchedulerRunning, "blocked"
	other.Advance = &StreamAdvance{State: AdvanceEscalated, Reason: "pending independent transition"}
	if err := store.commitAutoTransition([]SchedulerStream{other}); err != nil {
		t.Fatal(err)
	}
	if err := runLifecycleRecoveryChild(t, fixture, scenario, filepath.Join(fixture.home, "unknown-run-recovery-writes.jsonl")); err != nil {
		t.Fatalf("restart scheduler after corrupt run record: %v", err)
	}
	restarted := newSchedulerStore(fixture.state)
	assertUnknownRunEscalated(t, restarted, scenario.name)
	otherRecovered, err := restarted.stream(otherTask.Stream)
	if err != nil || otherRecovered.State != SchedulerAwaitingOrchestrator {
		t.Fatalf("independent stream did not advance during recovery: stream=%+v err=%v", otherRecovered, err)
	}
	assertUnknownRunEventCount(t, restarted, scenario.name, 1)
}

func runLifecycleRecoveryChild(t *testing.T, fixture schedulerFixture, scenario lifecycleCrashScenario, writeLog string) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	command, err := lifecycleChildCommand(ctx, fixture, scenario, "recover", writeLog, 0)
	if err != nil {
		return err
	}
	var stdout, stderr lifecycleOutputTail
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := command.Run(); err != nil {
		return fmt.Errorf("recovery child: %w; %s", err, lifecycleChildFailureDetails(fixture, scenario.name, &stdout, &stderr))
	}
	return nil
}

func lifecycleBoundaryRunIDs(logPath, boundary string) ([]string, error) {
	data, err := os.ReadFile(logPath)
	if err != nil {
		return nil, err
	}
	var runIDs []string
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var write observedDurableWrite
		if err := json.Unmarshal([]byte(line), &write); err != nil {
			return nil, err
		}
		if write.Kind == boundary {
			runIDs = append(runIDs, write.Path)
		}
	}
	return runIDs, nil
}

func lifecycleWriteAt(logPath string, ordinal int) (observedDurableWrite, error) {
	data, err := os.ReadFile(logPath)
	if err != nil {
		return observedDurableWrite{}, err
	}
	var writes []observedDurableWrite
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var write observedDurableWrite
		if err := json.Unmarshal([]byte(line), &write); err != nil {
			return observedDurableWrite{}, err
		}
		writes = append(writes, write)
	}
	if ordinal < 1 || ordinal > len(writes) {
		return observedDurableWrite{}, fmt.Errorf("crash boundary ordinal %d outside observed writes %d", ordinal, len(writes))
	}
	return writes[ordinal-1], nil
}

func TestSchedulerRealSupervisorAcceptAndLandSmoke(t *testing.T) {
	scenario := lifecycleCrashScenario{name: "real-supervisor-accept-land", workerStatuses: []string{"Status: DONE"}, reviewPlan: []string{"zcode|GLM-5.3-flash|ACCEPT"}, terminalState: SchedulerDone, advanceState: AdvanceAccepted}
	runSchedulerRealSupervisorLifecycleSmoke(t, scenario, 1, 1)
}

func TestSchedulerRealSupervisorRejectReworkAcceptSmoke(t *testing.T) {
	scenario := lifecycleCrashScenario{name: "real-supervisor-reject-rework-accept", workerStatuses: []string{"Status: DONE", "Status: DONE"}, reviewPlan: []string{"zcode|GLM-5.3-flash|REJECT", "gem|claude-sonnet-4-6|ACCEPT"}, terminalState: SchedulerDone, advanceState: AdvanceAccepted}
	runSchedulerRealSupervisorLifecycleSmoke(t, scenario, 2, 2)
}

func runSchedulerRealSupervisorLifecycleSmoke(t *testing.T, scenario lifecycleCrashScenario, workerCalls, reviewCalls int) {
	t.Helper()
	fixture := prepareLifecycleCrashFixture(t, scenario)
	writeLog := filepath.Join(fixture.home, "real-supervisor-writes.jsonl")
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	child, err := lifecycleChildCommand(ctx, fixture, scenario, "record", writeLog, 0, "real")
	if err != nil {
		t.Fatal(err)
	}
	var stdout, stderr lifecycleOutputTail
	child.Stdout, child.Stderr = &stdout, &stderr
	if err := child.Run(); err != nil {
		t.Fatalf("real-supervisor lifecycle %s: %v; %s", scenario.name, err, lifecycleChildFailureDetails(fixture, scenario.name, &stdout, &stderr))
	}
	stream, err := newSchedulerStore(fixture.state).stream(scenario.name)
	if err != nil || stream.State != scenario.terminalState || stream.Advance == nil || stream.Advance.State != scenario.advanceState {
		t.Fatalf("real-supervisor lifecycle state=%+v err=%v; %s; %s", stream, err, realSupervisorLifecycleDiagnostic(fixture, stream), lifecycleChildFailureDetails(fixture, scenario.name, &stdout, &stderr))
	}
	workers, err := os.ReadFile(filepath.Join(fixture.home, "worker-calls.jsonl"))
	if err != nil || countNonemptyLines(workers) != workerCalls {
		t.Fatalf("real-supervisor worker calls=%q err=%v, want %d; %s", workers, err, workerCalls, lifecycleChildFailureDetails(fixture, scenario.name, &stdout, &stderr))
	}
	reviews, err := os.ReadFile(filepath.Join(fixture.home, "review-events.jsonl"))
	if err != nil || countNonemptyLines(reviews) != reviewCalls {
		t.Fatalf("real-supervisor review calls=%q err=%v, want %d; %s", reviews, err, reviewCalls, lifecycleChildFailureDetails(fixture, scenario.name, &stdout, &stderr))
	}
}

func realSupervisorLifecycleDiagnostic(fixture schedulerFixture, stream SchedulerStream) string {
	job, jobErr := newJobStore(fixture.state).Get(stream.JobID)
	run, runErr := proc.ReadRunRecord(fixture.state, stream.RunID)
	listing := clikitSchedulerSupervisor{}.List(fixture.state)
	exitCode := "unknown"
	if run.ExitCode != nil {
		exitCode = strconv.Itoa(*run.ExitCode)
	}
	stdoutPath, stderrPath := schedulerAgentLogPaths(fixture.state, stream.JobID)
	stdout, stdoutErr := os.ReadFile(stdoutPath)
	stderr, stderrErr := os.ReadFile(stderrPath)
	launches, launchErr := os.ReadFile(fixture.launchCalls)
	return fmt.Sprintf("job=%+v job_error=%v run=%+v run_exit_code=%s run_error=%v process_table_error=%v stdout=%q stdout_error=%v stderr_path=%s stderr=%q stderr_error=%v launches=%q launch_error=%v", job, jobErr, run, exitCode, runErr, listing.Error, stdout, stdoutErr, stderrPath, stderr, stderrErr, launches, launchErr)
}

func lifecycleChildFailureDetails(fixture schedulerFixture, streamName string, stdout, stderr *lifecycleOutputTail) string {
	stream, streamErr := newSchedulerStore(fixture.state).stream(streamName)
	listing := clikitSchedulerSupervisor{}.List(fixture.state)
	var admissionEvents lifecycleOutputTail
	eventErr := proc.Events(context.Background(), fixture.state, false, []proc.EventType{proc.EventQueued, proc.EventBlocked}, 0, &admissionEvents)
	return fmt.Sprintf("recovery_stderr_tail=%q recovery_stdout_tail=%q stream_projection=%+v stream_error=%v admission_events_tail=%q admission_events_error=%v admission_runs=%+v admission_list_error=%v", stderr.String(), stdout.String(), stream, streamErr, admissionEvents.String(), eventErr, listing.Runs, listing.Error)
}

func lifecycleCrashBoundaryDiagnostic(write observedDurableWrite) string {
	return fmt.Sprintf("%+v", write)
}

func countNonemptyLines(data []byte) int {
	count := 0
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) != "" {
			count++
		}
	}
	return count
}

type lifecycleReference struct {
	result       []byte
	observations int
	writes       []observedDurableWrite
}

func lifecycleCrashOrdinals(t *testing.T, scenario lifecycleCrashScenario, writes []observedDurableWrite, tier runnerTestTier) ([]int, int) {
	t.Helper()
	type writeClass struct {
		handler, transition, kind, pathClass, runClass string
	}
	firstByClass := make(map[writeClass]struct{})
	selected := make(map[int]struct{})
	lastByTransition := make(map[string]int)
	for _, write := range writes {
		if write.Transition != scenario.name {
			t.Fatalf("reference write has transition %q, want scenario transition %q", write.Transition, scenario.name)
		}
		class := writeClass{handler: write.Handler, transition: write.Transition, kind: write.Kind, pathClass: write.PathClass, runClass: write.RunClass}
		if _, exists := firstByClass[class]; !exists {
			firstByClass[class] = struct{}{}
			selected[write.Ordinal] = struct{}{}
		}
		lastByTransition[write.Transition] = write.Ordinal
	}
	if tier == runnerTestTierExhaustive {
		ordinals := make([]int, len(writes))
		for index := range writes {
			ordinals[index] = writes[index].Ordinal
		}
		return ordinals, len(firstByClass)
	}
	for index, write := range writes {
		if write.Kind != "git-mutation" || len(write.Args) == 0 || write.Args[0] != "update-ref" {
			continue
		}
		selected[write.Ordinal] = struct{}{}
		if index > 0 {
			selected[writes[index-1].Ordinal] = struct{}{}
		}
	}
	for _, ordinal := range lastByTransition {
		selected[ordinal] = struct{}{}
	}
	ordinals := make([]int, 0, len(selected))
	for ordinal := range selected {
		ordinals = append(ordinals, ordinal)
	}
	sort.Ints(ordinals)
	return ordinals, len(firstByClass)
}

func runLifecycleReference(t *testing.T, scenario lifecycleCrashScenario) lifecycleReference {
	t.Helper()
	fixture := prepareLifecycleCrashFixture(t, scenario)
	writeLog := filepath.Join(fixture.home, "reference-writes.jsonl")
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	child, err := lifecycleChildCommand(ctx, fixture, scenario, "record", writeLog, 0)
	if err != nil {
		t.Fatal(err)
	}
	var stdout, stderr lifecycleOutputTail
	child.Stdout, child.Stderr = &stdout, &stderr
	if err := child.Run(); err != nil {
		t.Fatalf("uncrashed scheduler reference lifecycle: %v; %s", err, lifecycleChildFailureDetails(fixture, scenario.name, &stdout, &stderr))
	}
	data, err := os.ReadFile(writeLog)
	if err != nil {
		t.Fatalf("read reference lifecycle write log: %v; child stdout=%q stderr=%q", err, stdout.String(), stderr.String())
	}
	var writes []observedDurableWrite
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		var write observedDurableWrite
		if err := json.Unmarshal([]byte(line), &write); err != nil {
			t.Fatalf("decode observed durable write %q: %v; child stdout=%q stderr=%q", line, err, stdout.String(), stderr.String())
		}
		writes = append(writes, write)
	}
	if len(writes) == 0 {
		t.Fatalf("reference lifecycle emitted no durable writes; child stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
	return lifecycleReference{result: snapshotLifecycleResult(t, fixture, scenario), observations: len(writes), writes: writes}
}

func prepareLifecycleCrashFixture(t *testing.T, scenario lifecycleCrashScenario) schedulerFixture {
	t.Helper()
	fixture := newSchedulerFixtureWithEnv(t, `[]`, `{}`, true)
	fixture.state = filepath.Join(fixture.home, "runner-state")
	stream := scenario.name
	prompt := filepath.Join(fixture.repo, stream+".md")
	if err := os.WriteFile(prompt, []byte("exercise the scheduler lifecycle for "+stream+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	report := "Status: DONE\n\n## Design gate\n| root cause | single owner (package/module/file) | rail type | why it is not a shape rail or a copy |\n|---|---|---|---|\n| cause | owner | structured data or contract | owner |\n\n## Verification\nPASS\n\n## Open issues\nNone\n\n## Unrequested behaviour changes\nNone\n\n## Debt self-scan\nNone\n\n## Self-review\nComplete\n\n## Proposed commits\n```json\n[{\"kind\":\"case\",\"subject\":\"docs(qa): exercise scheduler lifecycle\",\"body\":\"\"},{\"kind\":\"tests\",\"subject\":\"test(kb-runner): cover lifecycle recovery\",\"body\":\"\"},{\"kind\":\"code\",\"subject\":\"feat(kb-runner): persist scheduler state\",\"body\":\"\"}]\n```\n"
	reportPath := filepath.Join(fixture.home, "worker-report.md")
	if err := os.WriteFile(reportPath, []byte(report), 0o600); err != nil {
		t.Fatal(err)
	}
	statusPlan := filepath.Join(fixture.home, "worker-status-plan.txt")
	if err := os.WriteFile(statusPlan, []byte(strings.Join(scenario.workerStatuses, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	reviewPlan := filepath.Join(fixture.home, "review-plan.txt")
	if err := os.WriteFile(reviewPlan, []byte(strings.Join(scenario.reviewPlan, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	setSchedulerFixtureEnv(t, &fixture, true, "FAKE_AGENT_REPORT", reportPath)
	setSchedulerFixtureEnv(t, &fixture, true, "FAKE_AGENT_STATUS_PLAN", statusPlan)
	setSchedulerFixtureEnv(t, &fixture, true, "FAKE_REVIEW_PLAN", reviewPlan)
	setSchedulerFixtureEnv(t, &fixture, true, "FAKE_WORKER_CALLS", filepath.Join(fixture.home, "worker-calls.jsonl"))
	setSchedulerFixtureEnv(t, &fixture, true, "FAKE_REVIEW_CALLS", filepath.Join(fixture.home, "review-calls"))
	setSchedulerFixtureEnv(t, &fixture, true, "FAKE_REVIEW_EVENTS", filepath.Join(fixture.home, "review-events.jsonl"))
	setSchedulerFixtureEnv(t, &fixture, true, "FAKE_CHANGED_FILES", "README.md")
	setSchedulerFixtureEnv(t, &fixture, true, "FAKE_LANDING_ENTRIES", "1")
	setSchedulerFixtureEnv(t, &fixture, true, "FAKE_BASE_COMMIT", "1111111111111111111111111111111111111111")
	setSchedulerFixtureEnv(t, &fixture, true, "FAKE_BASE_TREE", "2222222222222222222222222222222222222222")
	setSchedulerFixtureEnv(t, &fixture, true, "FAKE_OLD_SHA", "3333333333333333333333333333333333333333")
	setSchedulerFixtureEnv(t, &fixture, true, "FAKE_OLD_TREE", schedulerTestSHA)
	setSchedulerFixtureEnv(t, &fixture, true, "FAKE_REF_STATE", filepath.Join(fixture.home, "stream-ref.sha"))
	setSchedulerFixtureEnv(t, &fixture, true, "FAKE_WORKTREE_HEAD_STATE", filepath.Join(fixture.home, "worker-head.sha"))
	return fixture
}

func lifecycleChildCommand(ctx context.Context, fixture schedulerFixture, scenario lifecycleCrashScenario, mode, writeLog string, ordinal int, supervisorMode ...string) (*exec.Cmd, error) {
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestSchedulerLifecycleCrashChild$")
	if err := configureLifecycleChildCancellation(command); err != nil {
		return nil, err
	}
	modeValue := "fake"
	if len(supervisorMode) == 1 {
		modeValue = supervisorMode[0]
	}
	command.Env = append(os.Environ(), fixture.childEnv...)
	command.Env = append(command.Env,
		"KB_RUNNER_LIFECYCLE_CRASH_MODE="+mode,
		"KB_RUNNER_LIFECYCLE_SUPERVISOR="+modeValue,
		"KB_RUNNER_LIFECYCLE_CRASH_STATE="+fixture.state,
		"KB_RUNNER_LIFECYCLE_CRASH_STREAM="+scenario.name,
		"KB_RUNNER_LIFECYCLE_CRASH_PROMPT="+filepath.Join(fixture.repo, scenario.name+".md"),
		"KB_RUNNER_LIFECYCLE_CRASH_WRITES="+writeLog,
		"KB_RUNNER_LIFECYCLE_CRASH_ORDINAL="+strconv.Itoa(ordinal),
	)
	return command, nil
}

func configureLifecycleChildCancellation(command *exec.Cmd) error {
	if err := child.Configure(command, child.ProcessGroup); err != nil {
		return fmt.Errorf("configure lifecycle test child process group: %w", err)
	}
	command.Cancel = func() error {
		if command.Process == nil {
			return nil
		}
		return syscall.Kill(-command.Process.Pid, syscall.SIGQUIT)
	}
	command.WaitDelay = 3 * time.Second
	return nil
}

func countCrashWriteLines(data []byte) int {
	count := 0
	for _, line := range strings.Split(string(data), "\n") {
		if line != "" {
			count++
		}
	}
	return count
}

type normalizedLifecycleTask struct {
	ID         string
	Role       string
	State      SchedulerStreamState
	Vendor     string
	Reviewer   ReviewRole
	DependsOn  []string
	PromptBase string
}

type normalizedLifecycleStream struct {
	Stream         string
	State          SchedulerStreamState
	Cause          string
	AdvanceState   StreamAdvanceState
	Round          int
	PartialResumes int
	LastVerdict    string
	LastReview     string
	TreeHash       string
	LandingCommit  string
	LandingRef     string
	WorkerHead     string
}

type normalizedReviewCall struct {
	Stream  string     `json:"stream"`
	Role    ReviewRole `json:"role"`
	Tree    string     `json:"tree"`
	Vendor  string     `json:"vendor"`
	Model   string     `json:"model"`
	Verdict string     `json:"verdict"`
}

func testReviewOutputPath(t *testing.T, state string, task SchedulerTask) string {
	t.Helper()
	stream, err := newSchedulerStore(state).stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	path, err := reviewRunReportPath(state, stream.RunID)
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func runTestReviewJob(t *testing.T, supervisor schedulerJobSupervisor, state, runID, report string) {
	t.Helper()
	stdoutPath, stderrPath := schedulerRunOutputPaths(state, runID)
	reportPath, err := reviewRunReportPath(state, runID)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	run, err := supervisor.Start(ctx, proc.Config{
		StateDir: state, Tag: runID, RunID: runID, Stall: defaultAgentStall, StdoutPath: stdoutPath, StderrPath: stderrPath,
		Command: []string{"/bin/sh", "-c", "printf '%s' \"$1\"; if [ \"$2\" != \"$3\" ]; then printf '%s' \"$1\" > \"$3\"; fi", "review-fixture", report, stdoutPath, reportPath},
	})
	if err != nil {
		cancel()
		t.Fatalf("start fixture review job %s: %v", runID, err)
	}
	t.Cleanup(func() {
		cancel()
		if err := run.Wait(); err != nil {
			t.Errorf("reap fixture review job %s: %v", runID, err)
		}
	})
	if err := run.Wait(); err != nil {
		t.Fatalf("complete fixture review job %s: %v", runID, err)
	}
}

func snapshotLifecycleResult(t *testing.T, fixture schedulerFixture, scenario lifecycleCrashScenario) []byte {
	t.Helper()
	store := newSchedulerStore(fixture.state)
	tasks, err := store.tasks()
	if err != nil {
		t.Fatal(err)
	}
	streams, err := store.streams()
	if err != nil {
		t.Fatal(err)
	}
	normalizedTasks := make([]normalizedLifecycleTask, 0, len(tasks))
	for _, task := range tasks {
		stream, err := store.stream(task.Stream)
		if err != nil {
			t.Fatal(err)
		}
		normalizedTasks = append(normalizedTasks, normalizedLifecycleTask{ID: task.ID, Role: task.Role, State: stream.State, Vendor: task.Vendor, Reviewer: task.ReviewerKind, DependsOn: task.DependsOn, PromptBase: filepath.Base(task.Prompt)})
	}
	normalizedStreams := make([]normalizedLifecycleStream, 0, len(streams))
	for _, stream := range streams {
		item := normalizedLifecycleStream{Stream: stream.Stream, State: stream.State, Cause: stream.Cause}
		if stream.Advance != nil {
			item.AdvanceState = stream.Advance.State
			item.Round = stream.Advance.Round
			item.PartialResumes = stream.Advance.PartialResumes
			item.LastVerdict = stream.Advance.LastVerdict
			item.LastReview = stream.Advance.LastReviewVerdict
			item.TreeHash = stream.Advance.TreeHash
			item.LandingCommit = stream.Advance.LandingCommit
		}
		normalizedStreams = append(normalizedStreams, item)
	}
	eventsPath := filepath.Join(store.dir, "events.jsonl")
	eventData, err := os.ReadFile(eventsPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	type normalizedEvent struct {
		EventID string `json:"-"`
		Kind    string `json:"kind"`
		Status  string `json:"status"`
		Stream  string `json:"stream"`
		State   string `json:"state"`
	}
	var events []normalizedEvent
	seen := map[string]bool{}
	for _, line := range strings.Split(string(eventData), "\n") {
		if line == "" {
			continue
		}
		var event normalizedEvent
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("decode event line: %v", err)
		}
		if event.Kind == "scheduler.transition" {
			continue
		}
		if event.EventID != "" {
			if seen[event.EventID] {
				t.Fatalf("outbox event %s delivered more than once", event.EventID)
			}
			seen[event.EventID] = true
		}
		events = append(events, event)
	}
	var reviews []normalizedReviewCall
	seenReviewKeys := map[string]bool{}
	for _, reviewTask := range tasks {
		if reviewTask.Role != schedulerReviewRole || reviewTask.ReviewerKind == "" || len(reviewTask.DependsOn) != 1 {
			continue
		}
		reviewStream, err := store.stream(reviewTask.Stream)
		if err != nil {
			t.Fatal(err)
		}
		if reviewStream.RunID == "" {
			continue
		}
		run, exists, err := fixture.supervisor.RunByID(fixture.state, reviewStream.RunID)
		if err != nil {
			t.Fatalf("read review run %s from journaled task %s: %v", reviewStream.RunID, reviewTask.ID, err)
		}
		if !exists || !run.Status.Terminal() {
			continue
		}
		var verdict string
		if run.Status == proc.StatusCompleted {
			reportPath, err := reviewRunReportPath(fixture.state, reviewStream.RunID)
			if err != nil {
				t.Fatal(err)
			}
			report, err := os.ReadFile(reportPath)
			if err != nil {
				t.Fatalf("read completed review run %s output: %v", reviewStream.RunID, err)
			}
			verdict, err = resolveReviewVerdict(report)
			if err != nil {
				t.Fatalf("resolve verdict from review run %s: %v", reviewStream.RunID, err)
			}
		} else if run.Status == proc.StatusFailed {
			_, stderrPath := schedulerRunOutputPaths(fixture.state, reviewStream.RunID)
			stderr, err := os.ReadFile(stderrPath)
			if err != nil {
				t.Fatalf("read failed review run %s stderr: %v", reviewStream.RunID, err)
			}
			if gemVendorLimitOutput(stderr) {
				verdict = "VENDOR_LIMIT"
			} else {
				continue
			}
		} else {
			continue
		}
		if reviewTask.ReviewTreeHash == "" {
			t.Fatalf("review task %s has no immutable reviewed tree identity", reviewTask.ID)
		}
		worker, err := store.task(reviewTask.DependsOn[0])
		if err != nil {
			t.Fatalf("resolve reviewed worker from journaled task %s: %v", reviewTask.ID, err)
		}
		key := strings.Join([]string{worker.Stream, string(reviewTask.ReviewerKind), reviewTask.ReviewTreeHash, reviewTask.Vendor}, "\x00")
		if seenReviewKeys[key] {
			t.Fatalf("review invocation duplicated for stream/role/tree %s/%s/%s", worker.Stream, reviewTask.ReviewerKind, reviewTask.ReviewTreeHash)
		}
		seenReviewKeys[key] = true
		model := reviewTask.Model
		reviews = append(reviews, normalizedReviewCall{Stream: worker.Stream, Role: reviewTask.ReviewerKind, Tree: reviewTask.ReviewTreeHash, Vendor: reviewTask.Vendor, Model: model, Verdict: verdict})
	}
	reviewEvents, err := os.ReadFile(fixtureEnvironment(fixture, "FAKE_REVIEW_EVENTS"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	transcript := make([]string, 0)
	for _, line := range strings.Split(strings.TrimSpace(string(reviewEvents)), "\n") {
		if line == "" {
			continue
		}
		fields := strings.Split(line, "|")
		if len(fields) != 3 {
			t.Fatalf("malformed fake review outcome transcript line %q", line)
		}
		transcript = append(transcript, strings.Join(fields, "|"))
	}
	if len(transcript) != len(reviews) {
		t.Fatalf("review outcome transcript has %d calls, journal has %d completed review runs", len(transcript), len(reviews))
	}
	transcriptCounts := map[string]int{}
	for _, outcome := range transcript {
		transcriptCounts[outcome]++
	}
	journalCounts := map[string]int{}
	for _, review := range reviews {
		journalCounts[strings.Join([]string{review.Vendor, review.Model, review.Verdict}, "|")]++
	}
	if !reflect.DeepEqual(transcriptCounts, journalCounts) {
		t.Fatalf("fake review outcome transcript differs from journaled run records: transcript=%v journal=%v", transcriptCounts, journalCounts)
	}
	sort.Slice(reviews, func(i, j int) bool {
		left, _ := json.Marshal(reviews[i])
		right, _ := json.Marshal(reviews[j])
		return string(left) < string(right)
	})
	workers := []string{}
	if data, err := os.ReadFile(fixtureEnvironment(fixture, "FAKE_WORKER_CALLS")); err == nil {
		for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
			if line != "" {
				workers = append(workers, line)
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	gitCalls, err := os.ReadFile(fixture.gitCalls)
	if err != nil {
		t.Fatal(err)
	}
	commitObjects := strings.Count(string(gitCalls), "commit-tree")
	refUpdates := strings.Count(string(gitCalls), "update-ref")
	landedRef, err := os.ReadFile(fixtureEnvironment(fixture, "FAKE_REF_STATE"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	if stream, err := store.stream(scenario.name); err != nil || stream.State != scenario.terminalState || stream.Advance == nil || stream.Advance.State != scenario.advanceState {
		var reportStatus string
		var reportErr error
		var run proc.RunInfo
		var runErr error
		if task, taskErr := store.task(stream.TaskID); taskErr == nil {
			reportStatus, _, reportErr = readReport(workerReportPath(task))
		} else {
			reportErr = taskErr
		}
		if stream.RunID != "" {
			run, runErr = proc.ReadRunRecord(fixture.state, stream.RunID)
		}
		t.Fatalf("scenario did not reach expected terminal state: stream=%+v err=%v worker_report_status=%q worker_report_error=%v run_record=%+v run_record_error=%v", stream, err, reportStatus, reportErr, run, runErr)
	}
	if scenario.terminalState == SchedulerDone && (commitObjects < 3 || refUpdates != 1) {
		t.Fatalf("commit-only landing produced commit-tree operations=%d and ref updates=%d; want at least three proposals and one landed ref", commitObjects, refUpdates)
	}
	if scenario.terminalState == SchedulerDone {
		stream, err := store.stream(scenario.name)
		if err != nil || stream.Advance == nil || strings.TrimSpace(string(landedRef)) != stream.Advance.LandingCommit {
			t.Fatalf("landed ref identity does not match persisted accepted commit: ref=%q stream=%+v err=%v", strings.TrimSpace(string(landedRef)), stream, err)
		}
		worktreeHead, readErr := os.ReadFile(fixtureEnvironment(fixture, "FAKE_WORKTREE_HEAD_STATE"))
		if readErr != nil || strings.TrimSpace(string(worktreeHead)) != stream.Advance.LandingCommit {
			t.Fatalf("worker worktree HEAD does not match landed ref: head=%q ref=%q err=%v", strings.TrimSpace(string(worktreeHead)), strings.TrimSpace(string(landedRef)), readErr)
		}
		for index := range normalizedStreams {
			if normalizedStreams[index].Stream == scenario.name {
				normalizedStreams[index].LandingRef = strings.TrimSpace(string(landedRef))
				normalizedStreams[index].WorkerHead = strings.TrimSpace(string(worktreeHead))
			}
		}
	}
	handoff, err := os.ReadFile(filepath.Join(fixture.worktrees, "HANDOFF.md"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	result := struct {
		Tasks      []normalizedLifecycleTask   `json:"tasks"`
		Streams    []normalizedLifecycleStream `json:"streams"`
		Reviews    []normalizedReviewCall      `json:"reviews"`
		Workers    []string                    `json:"workers"`
		Events     []normalizedEvent           `json:"events"`
		Handoff    string                      `json:"handoff"`
		RefUpdates int                         `json:"ref_updates"`
		LandedRef  string                      `json:"landed_ref"`
	}{normalizedTasks, normalizedStreams, reviews, workers, events, normalizeLifecycleHandoff(t, handoff, fixture.home), refUpdates, strings.TrimSpace(string(landedRef))}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func normalizeLifecycleHandoff(t *testing.T, data []byte, fixtureRoot string) string {
	t.Helper()
	var normalized []string
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		prefix, raw, ok := strings.Cut(line, " ")
		if !ok || !strings.HasPrefix(prefix, "scheduler=") {
			t.Fatalf("unexpected HANDOFF projection line %q", line)
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(raw), &event); err != nil {
			t.Fatalf("decode HANDOFF projection: %v", err)
		}
		delete(event, "time")
		if path, ok := event["handoff_path"].(string); ok {
			event["handoff_path"] = strings.ReplaceAll(path, fixtureRoot, "$FIXTURE")
		}
		encoded, err := json.Marshal(event)
		if err != nil {
			t.Fatal(err)
		}
		normalized = append(normalized, prefix+" "+string(encoded))
	}
	sort.Strings(normalized)
	return strings.Join(normalized, "\n")
}

func TestAutoAdvanceStandardAcceptRearmsPersistedHighRiskReviewOnce(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	worker := f.addTask(t, "high-risk-rearm", "worker")
	workerState, err := newSchedulerStore(f.state).stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := newSchedulerStore(f.state).transition(workerState, SchedulerRunning, "worker", "complete worker"); err != nil {
		t.Fatal(err)
	}
	workerState, _ = newSchedulerStore(f.state).stream(worker.Stream)
	if err := newSchedulerStore(f.state).transition(workerState, SchedulerAwaitingReview, "review", "queue reviewer"); err != nil {
		t.Fatal(err)
	}
	promptPath := filepath.Join(f.repo, "prompts", worker.Stream+"-review-adv.md")
	if err := os.MkdirAll(filepath.Dir(promptPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(promptPath, []byte("check boundary conditions"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := newSchedulerStore(f.state)
	worker.OutsideSuites = []string{"kb-runner:./..."}
	worker.Review, worker.Reviewers = "", nil
	if err := store.updateTask(worker); err != nil {
		t.Fatal(err)
	}
	for _, next := range []StreamAdvanceState{AdvanceWorking, AdvanceVerifying, AdvanceReviewing} {
		if err := store.advance(worker.Stream, next, "", "", schedulerTestSHA); err != nil {
			t.Fatal(err)
		}
	}
	workerState, err = store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	workerState.Advance.HighRisk = true
	if err := store.commitAutoTransition([]SchedulerStream{workerState}); err != nil {
		t.Fatal(err)
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: f.invocationRoot(), state: f.state, supervisor: f.supervisor})
	if err := options.queueAutoReview(worker, ReviewStandard); err != nil {
		t.Fatal(err)
	}
	standard, err := store.task(worker.Stream + "-review-standard-r1")
	if err != nil {
		t.Fatal(err)
	}
	standardState, err := store.stream(standard.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(standardState, SchedulerRunning, "review", "record result"); err != nil {
		t.Fatal(err)
	}
	runTestReviewJob(t, f.supervisor, f.state, standardState.RunID, "Verdict: ACCEPT\n\n## Defects\n\nNone.\n\n## Verification\n\nPASS\n")
	standardState, _ = store.stream(standard.Stream)
	if err := options.finishAutoReview(standard, standardState); err != nil {
		t.Fatal(err)
	}
	adversarial, err := store.task(worker.Stream + "-review-adversarial-r1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(adversarial.ReviewerFocus, "check boundary conditions") {
		t.Fatalf("configured adversarial prompt was omitted: %q", adversarial.ReviewerFocus)
	}
	adversarialState, err := store.stream(adversarial.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(adversarialState, SchedulerRunning, "review", "simulate crash"); err != nil {
		t.Fatal(err)
	}
	restarted := newSchedulerRunOptions(newSchedulerStore(f.state), schedulerRunOptionsConfig{root: f.invocationRoot(), state: f.state, supervisor: f.supervisor})
	if err := restarted.recoverAutoStreams(); err != nil {
		t.Fatal(err)
	}
	got, err := newSchedulerStore(f.state).stream(adversarial.Stream)
	if err != nil || got.State != SchedulerReady {
		t.Fatalf("high-risk next review was not re-armed: state=%s err=%v", got.State, err)
	}
	tasks, err := newSchedulerStore(f.state).tasks()
	if err != nil || countReviewRole(tasks, ReviewAdversarial) != 1 {
		t.Fatalf("restart duplicated adversarial task: count=%d err=%v", countReviewRole(tasks, ReviewAdversarial), err)
	}
}

func TestAutoReviewRejectAndReworkShareOneJournalTransaction(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	worker := f.addTask(t, "atomic-review-reject", "worker")
	worker.OutsideSuites = []string{"kb-runner:./..."}
	worker.Review, worker.Reviewers = "", nil
	store := newSchedulerStore(f.state)
	if err := store.updateTask(worker); err != nil {
		t.Fatal(err)
	}
	workerState, err := store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	seedSchedulerWorkerSession(t, store, &workerState, "atomic-review-session")
	if err := store.transition(workerState, SchedulerRunning, "worker", "finish worker"); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(worker.Stream, AdvanceWorking, "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(worker.Stream, AdvanceVerifying, "", "", schedulerTestSHA); err != nil {
		t.Fatal(err)
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: f.invocationRoot(), state: f.state, supervisor: f.supervisor})
	if err := options.queueAutoReview(worker, ReviewStandard); err != nil {
		t.Fatal(err)
	}
	reviewTask, err := store.task(worker.Stream + "-review-standard-r1")
	if err != nil {
		t.Fatal(err)
	}
	reviewStream, err := store.stream(reviewTask.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(reviewStream, SchedulerRunning, "review", "record verdict"); err != nil {
		t.Fatal(err)
	}
	runTestReviewJob(t, f.supervisor, f.state, reviewStream.RunID, "Verdict: REJECT\n\n## Defects\n\n- preserve this finding\n\n## Verification\n\nReviewed exact tree.\n")
	reviewStream, err = store.stream(reviewTask.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := options.finishAutoReview(reviewTask, reviewStream); err != nil {
		t.Fatal(err)
	}
	workerAfter, err := store.stream(worker.Stream)
	if err != nil || workerAfter.Advance.State != AdvanceRework || workerAfter.Advance.Round != 1 || workerAfter.Advance.LastReviewVerdict != "REJECT" || workerAfter.Advance.PreviousTreeHash != schedulerTestSHA || len(workerAfter.ReviewRunIDs) != 0 {
		t.Fatalf("rejected verdict/rework state was not committed: stream=%+v err=%v", workerAfter, err)
	}
	updatedTask, err := store.task(worker.ID)
	if err != nil || updatedTask.Prompt == worker.Prompt {
		t.Fatalf("rework prompt was not committed with rejection: task=%+v err=%v", updatedTask, err)
	}
	reviewAfter, err := store.stream(reviewTask.Stream)
	if err != nil || reviewAfter.State != SchedulerDone {
		t.Fatalf("review task completion was not committed with rejection: stream=%+v err=%v", reviewAfter, err)
	}
	entries, err := os.ReadDir(filepath.Join(store.dir, "auto-transitions"))
	if err != nil {
		t.Fatal(err)
	}
	var final autoTransitionRecord
	if err := readSchedulerJSON(filepath.Join(store.dir, "auto-transitions", entries[len(entries)-1].Name()), &final); err != nil {
		t.Fatal(err)
	}
	if len(final.Tasks) != 1 || final.Tasks[0].ID != worker.ID || len(final.Streams) != 2 || len(final.Events) != 1 {
		t.Fatalf("review REJECT and rework were split across journal records: record=%+v", final)
	}
}

func TestAutoReworkTransitionRetainsVerdictAndReviewedTreeWithoutReportCache(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	worker := f.addTask(t, "atomic-rework-tree", "worker")
	worker.OutsideSuites = []string{"kb-runner:./..."}
	worker.Review, worker.Reviewers = "", nil
	store := newSchedulerStore(f.state)
	if err := store.updateTask(worker); err != nil {
		t.Fatal(err)
	}
	workerStream, err := store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(workerStream, SchedulerRunning, "worker", "finish worker"); err != nil {
		t.Fatal(err)
	}
	for _, state := range []StreamAdvanceState{AdvanceWorking, AdvanceVerifying, AdvanceReviewing} {
		if err := store.advance(worker.Stream, state, "", "", schedulerTestSHA); err != nil {
			t.Fatal(err)
		}
	}
	workerStream, err = store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	seedSchedulerWorkerSession(t, store, &workerStream, "atomic-rework-session")
	if err := store.transition(workerStream, SchedulerAwaitingReview, "review", "consume review result"); err != nil {
		t.Fatal(err)
	}
	review, err := store.add(SchedulerTask{Stream: worker.Stream + "-review", PromptTemplate: runnerReviewTemplate, Workdir: worker.Workdir, WorktreeRoot: worker.WorktreeRoot, RepoRoot: worker.RepoRoot, Base: worker.Base, Vendor: "codex", Effort: "medium", Role: schedulerReviewRole, DependsOn: []string{worker.ID}})
	if err != nil {
		t.Fatal(err)
	}
	reviewStream, err := store.stream(review.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(reviewStream, SchedulerRunning, "review", "record REJECT"); err != nil {
		t.Fatal(err)
	}
	reviewStream, err = store.stream(review.Stream)
	if err != nil {
		t.Fatal(err)
	}
	reviewStream, _, err = schedulerTransitionSnapshot(reviewStream, SchedulerDone, "", "review result recorded")
	if err != nil {
		t.Fatal(err)
	}
	workerStream, err = store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{state: f.state, supervisor: f.supervisor})
	if err := options.queueAutoReworkSnapshots(worker, "review rejected", workerStream, []SchedulerStream{reviewStream}); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(store.dir, "auto-transitions"))
	if err != nil {
		t.Fatal(err)
	}
	var latest autoTransitionRecord
	if err := readSchedulerJSON(filepath.Join(store.dir, "auto-transitions", entries[len(entries)-1].Name()), &latest); err != nil {
		t.Fatal(err)
	}
	if len(latest.Streams) != 2 || len(latest.Tasks) != 1 || latest.Tasks[0].ID != worker.ID {
		t.Fatalf("rework journal does not contain the worker, review and task snapshots: %+v", latest)
	}
	gotWorker, gotReview := SchedulerStream{}, SchedulerStream{}
	for _, snapshot := range latest.Streams {
		if snapshot.Stream == worker.Stream {
			gotWorker = snapshot
		}
		if snapshot.Stream == review.Stream {
			gotReview = snapshot
		}
	}
	if gotWorker.Advance == nil || gotWorker.Advance.LastVerdict != "REJECT" || gotWorker.Advance.PreviousTreeHash != schedulerTestSHA || gotReview.State != SchedulerDone || len(latest.Events) == 0 {
		t.Fatalf("REJECT and reviewed tree were not persisted in the same rework transition: worker=%+v review=%+v events=%s", gotWorker, gotReview, latest.Events)
	}
}

func TestGemReviewUsesGoAssembledInputAndPersistsFirstPartyReport(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	worker := f.addTask(t, "gem-review-worker", "worker")
	if err := os.MkdirAll(worker.Workdir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worker.Workdir, ".agent-report.md"), []byte("Status: DONE\nworker report\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	casePath := filepath.Join(worker.Workdir, "docs", "qa", "scenarios", "S-237-case.md")
	if err := os.MkdirAll(filepath.Dir(casePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(casePath, []byte("case expectation body\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	repoCasePath := filepath.Join(f.repo, "docs", "qa", "scenarios", "S-237-case.md")
	if err := os.MkdirAll(filepath.Dir(repoCasePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(repoCasePath, []byte("case expectation body\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := newSchedulerStore(f.state)
	if err := store.advance(worker.Stream, AdvanceWorking, "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(worker.Stream, AdvanceVerifying, "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(worker.Stream, AdvanceReviewing, "", "", schedulerTestSHA); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worker.Workdir, "untracked.go"), []byte("package sample\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_CHANGED_FILES", "docs/qa/scenarios/S-237-case.md\nuntracked.go")
	t.Setenv("FAKE_UNTRACKED_FILES", "untracked.go")
	runID, err := proc.AllocateRunID()
	if err != nil {
		t.Fatal(err)
	}
	review, err := newSchedulerStore(f.state).addWithSnapshotsAndRunID(SchedulerTask{Stream: "gem-review-task", Prompt: worker.Prompt, PromptTemplate: runnerReviewTemplate, Workdir: worker.Workdir, WorktreeRoot: f.worktrees, RepoRoot: f.repo, Base: "main", Vendor: "gem", Model: "claude-sonnet-4-6", Effort: "medium", Role: schedulerReviewRole, ReviewerKind: ReviewDelta, ReviewerFocus: "delta focus", DependsOn: []string{worker.ID}}, runID, nil)
	if err != nil {
		t.Fatal(err)
	}
	options := newSchedulerRunOptions(newSchedulerStore(f.state), schedulerRunOptionsConfig{root: f.invocationRoot(), state: f.state, supervisor: f.supervisor, slots: 1})
	lifecycle, cancelLifecycle := schedulerLifecycleContext(context.Background())
	defer cancelLifecycle()
	if _, err := options.runGemReview(lifecycle, review, runID); err != nil {
		t.Fatal(err)
	}
	firstCalls, err := os.ReadFile(os.Getenv("FAKE_GEM_CALLS"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (newSchedulerRunOptions(newSchedulerStore(f.state), schedulerRunOptionsConfig{root: options.root, state: f.state, supervisor: f.supervisor, slots: 1})).runGemReview(lifecycle, review, runID); err != nil {
		t.Fatal(err)
	}
	secondCalls, err := os.ReadFile(os.Getenv("FAKE_GEM_CALLS"))
	if err != nil || string(secondCalls) != string(firstCalls) {
		t.Fatalf("fresh scheduler repeated a completed gem invocation: before=%q after=%q err=%v", firstCalls, secondCalls, err)
	}
	input, err := os.ReadFile(os.Getenv("FAKE_GEM_INPUT"))
	if err != nil {
		t.Fatal(err)
	}
	for _, fragment := range []string{"delta focus", "task for gem-review-worker", "worker report", "# Stream diff", "case expectation body", "untracked.go", "fixture-owned review rules"} {
		if !strings.Contains(string(input), fragment) {
			t.Fatalf("Gem review input omitted %q: %s", fragment, input)
		}
	}
	report, err := os.ReadFile(testReviewOutputPath(t, f.state, review))
	verdict, ok := firstGemVerdict(report)
	if err != nil || !ok || verdict != "ACCEPT" {
		t.Fatalf("Gem report=%q err=%v", report, err)
	}
	callData, err := os.ReadFile(os.Getenv("FAKE_GEM_CALLS"))
	if err != nil || !strings.Contains(string(callData), "claude-sonnet-4-6") {
		t.Fatalf("Gem CLI model calls=%q err=%v", callData, err)
	}
}

func TestSchedulerFinalAdversarialRunsOnceOnlyAfterStandardAccept(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	worker := f.addTask(t, "high-risk-review", "worker")
	worker.OutsideSuites = []string{"kb-runner:./..."}
	worker.Review, worker.Reviewers = "", nil
	store := newSchedulerStore(f.state)
	if err := store.updateTask(worker); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(worker.Workdir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worker.Workdir, ".agent-report.md"), []byte("Status: DONE\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	advPrompt := filepath.Join(f.repo, "prompts", worker.Stream+"-review-adv.md")
	if err := os.MkdirAll(filepath.Dir(advPrompt), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(advPrompt, []byte("adversarial criteria\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stream, err := store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(stream, SchedulerRunning, "fixture", "complete worker"); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(worker.Stream, AdvanceWorking, "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(worker.Stream, AdvanceVerifying, "", "", schedulerTestSHA); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(worker.Stream)
	stream.Advance.HighRisk = true
	if err := store.commitAutoTransition([]SchedulerStream{stream}); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(worker.Stream, AdvanceReviewing, "", "", schedulerTestSHA); err != nil {
		t.Fatal(err)
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: f.invocationRoot(), state: f.state, supervisor: f.supervisor})
	if err := options.queueAutoReview(worker, ReviewStandard); err != nil {
		t.Fatal(err)
	}
	complete := func(role ReviewRole) {
		t.Helper()
		taskID := fmt.Sprintf("%s-review-%s-r1", worker.Stream, role)
		reviewTask, taskErr := store.task(taskID)
		if taskErr != nil {
			t.Fatal(taskErr)
		}
		reviewState, stateErr := store.stream(reviewTask.Stream)
		if stateErr != nil {
			t.Fatal(stateErr)
		}
		if err := store.transition(reviewState, SchedulerRunning, "fake reviewer", "record verdict"); err != nil {
			t.Fatal(err)
		}
		runTestReviewJob(t, f.supervisor, f.state, reviewState.RunID, "Verdict: ACCEPT\n\n## Defects\n\nNo defects.\n\n## Verification\n\nPASS\n")
		reviewState, _ = store.stream(reviewTask.Stream)
		if err := options.finishAutoReview(reviewTask, reviewState); err != nil {
			t.Fatal(err)
		}
	}
	complete(ReviewStandard)
	tasks, err := store.tasks()
	if err != nil {
		t.Fatal(err)
	}
	if countReviewRole(tasks, ReviewAdversarial) != 1 || countReviewRole(tasks, ReviewFinal) != 0 {
		t.Fatalf("after standard ACCEPT review tasks=%+v", tasks)
	}
	for i := 0; i < 2; i++ {
		if err := options.recoverAutoStreams(); err != nil {
			t.Fatal(err)
		}
	}
	tasks, err = store.tasks()
	if err != nil || countReviewRole(tasks, ReviewAdversarial) != 1 {
		t.Fatalf("restart duplicated adversarial review: count=%d err=%v", countReviewRole(tasks, ReviewAdversarial), err)
	}
	complete(ReviewAdversarial)
	tasks, err = store.tasks()
	if err != nil {
		t.Fatal(err)
	}
	if countReviewRole(tasks, ReviewFinal) != 1 {
		t.Fatalf("Codex final review did not follow standard and adversarial ACCEPT: %+v", tasks)
	}
	for i := 0; i < 2; i++ {
		if err := options.recoverAutoStreams(); err != nil {
			t.Fatal(err)
		}
	}
	tasks, err = store.tasks()
	if err != nil || countReviewRole(tasks, ReviewFinal) != 1 {
		t.Fatalf("restart duplicated final adversarial: count=%d err=%v", countReviewRole(tasks, ReviewFinal), err)
	}
	for _, task := range tasks {
		if task.ReviewerKind == ReviewFinal && task.Vendor != "codex" {
			t.Fatalf("final adversarial vendor=%s, want codex", task.Vendor)
		}
	}
}

func TestGemVendorLimitRoutesToZcodeAndEmitsOnlyVendorLimitEvent(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	worker := f.addTask(t, "gem-limit-worker", "worker")
	advPrompt := filepath.Join(f.repo, "prompts", worker.Stream+"-review-adv.md")
	if err := os.MkdirAll(filepath.Dir(advPrompt), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(advPrompt, []byte("adversarial prompt"), 0o600); err != nil {
		t.Fatal(err)
	}
	worker.OutsideSuites = []string{"kb-runner:./..."}
	worker.Review, worker.Reviewers = "", nil
	store := newSchedulerStore(f.state)
	if err := store.updateTask(worker); err != nil {
		t.Fatal(err)
	}
	stream, err := store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.advance(worker.Stream, AdvanceWorking, "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(worker.Stream, AdvanceVerifying, "", "", schedulerTestSHA); err != nil {
		t.Fatal(err)
	}
	stream, err = store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	stream.Advance.HighRisk = true
	if err := store.commitAutoTransition([]SchedulerStream{stream}); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(worker.Stream, AdvanceReviewing, "", "", schedulerTestSHA); err != nil {
		t.Fatal(err)
	}
	stream, err = store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(stream, SchedulerRunning, "finish verification", "queue adversarial review"); err != nil {
		t.Fatal(err)
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{state: f.state, supervisor: f.supervisor})
	if err := options.queueAutoReview(worker, ReviewAdversarial); err != nil {
		t.Fatal(err)
	}
	gemTask, err := store.task(worker.Stream + "-review-adversarial-r1")
	if err != nil {
		t.Fatal(err)
	}
	if gemTask.Vendor != "gem" {
		t.Fatalf("adversarial vendor=%q", gemTask.Vendor)
	}
	gemStream, err := store.stream(gemTask.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(gemStream, SchedulerRunning, "review invocation", "route vendor limit"); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"429 Too Many Requests", "quota exceeded", "location not supported"} {
		if !gemVendorLimitOutput([]byte(text)) {
			t.Errorf("vendor-limit output not recognized: %q", text)
		}
	}
	queued, err := options.fallbackAutoReview(gemTask, "unused", errGemReviewVendorLimit, "429 quota")
	if err != nil || !queued {
		t.Fatalf("Gem vendor-limit fallback queued=%v err=%v", queued, err)
	}
	fallback, err := store.task(worker.Stream + "-review-fallback-adversarial-r1")
	if err != nil || fallback.Vendor != "zcode" || fallback.Model != "GLM-5.3-flash" {
		t.Fatalf("fallback=%+v err=%v", fallback, err)
	}
	fallbackStream, err := store.stream(fallback.Stream)
	if err != nil || fallbackStream.State != SchedulerReady || fallbackStream.RunID == "" {
		t.Fatalf("fallback review stream was not projected with its preallocated run ID: stream=%+v err=%v", fallbackStream, err)
	}
	workerAfter, err := store.stream(worker.Stream)
	if err != nil || workerAfter.State != SchedulerAwaitingReview || workerAfter.Advance == nil || workerAfter.Advance.State != AdvanceReviewing {
		t.Fatalf("fallback creation lost the worker transition projection: stream=%+v err=%v", workerAfter, err)
	}
	transitions, err := os.ReadDir(filepath.Join(store.dir, "auto-transitions"))
	if err != nil {
		t.Fatal(err)
	}
	var fallbackTransition autoTransitionRecord
	if err := readSchedulerJSON(filepath.Join(store.dir, "auto-transitions", transitions[len(transitions)-1].Name()), &fallbackTransition); err != nil {
		t.Fatal(err)
	}
	projected := map[string]bool{}
	for _, snapshot := range fallbackTransition.Streams {
		projected[snapshot.Stream] = snapshot.RunID != "" || snapshot.Stream == worker.Stream
	}
	if len(fallbackTransition.Tasks) != 1 || fallbackTransition.Tasks[0].ID != fallback.ID || !projected[worker.Stream] || !projected[fallback.Stream] {
		t.Fatalf("fallback task and related projections were not committed in one transition: %+v", fallbackTransition)
	}
	events, err := os.ReadFile(filepath.Join(f.state, "sched", "events.jsonl"))
	if err != nil || !strings.Contains(string(events), `"status":"vendor-limit"`) {
		t.Fatalf("vendor-limit event log=%s err=%v", events, err)
	}
}

func TestUnusableStandardReportFallsBackToGem(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	worker := f.addTask(t, "unusable-standard-report", "worker")
	worker.OutsideSuites = []string{"kb-runner:./..."}
	worker.Review, worker.Reviewers = "", nil
	store := newSchedulerStore(f.state)
	if err := store.updateTask(worker); err != nil {
		t.Fatal(err)
	}
	for _, state := range []StreamAdvanceState{AdvanceWorking, AdvanceVerifying, AdvanceReviewing} {
		if err := store.advance(worker.Stream, state, "", "", schedulerTestSHA); err != nil {
			t.Fatal(err)
		}
	}
	review, err := store.add(SchedulerTask{Stream: worker.Stream + "-review-standard-r1", PromptTemplate: runnerReviewTemplate, Workdir: worker.Workdir, WorktreeRoot: worker.WorktreeRoot, RepoRoot: worker.RepoRoot, Base: worker.Base, Vendor: "zcode", Model: "GLM-5.3-flash", Effort: worker.Effort, Role: schedulerReviewRole, ReviewerKind: ReviewStandard, DependsOn: []string{worker.ID}})
	if err != nil {
		t.Fatal(err)
	}
	reviewStream, err := store.stream(review.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(reviewStream, SchedulerRunning, "review invocation", "route unusable report"); err != nil {
		t.Fatal(err)
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{state: f.state, supervisor: f.supervisor})
	queued, err := options.fallbackAutoReview(review, "", errReviewUnusable, "Verdict: ACCEPT\n")
	if err != nil || !queued {
		t.Fatalf("unusable standard report fallback queued=%v err=%v", queued, err)
	}
	fallback, err := store.task(worker.Stream + "-review-fallback-standard-r1")
	if err != nil || fallback.Vendor != "gem" || fallback.Model != "claude-sonnet-4-6" {
		t.Fatalf("standard fallback=%+v err=%v", fallback, err)
	}
}

func TestAutoAdvanceRestartResumesPersistedWorkingVerifyingReworkAndEscalatedStates(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	f.state = filepath.Join(f.home, "runner-state")
	makeTask := func(name string) (SchedulerTask, *schedulerStore, SchedulerStream) {
		t.Helper()
		task := f.addTask(t, name, "worker")
		task.OutsideSuites = []string{"kb-runner:./..."}
		task.Review, task.Reviewers = "", nil
		store := newSchedulerStore(f.state)
		if err := store.updateTask(task); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(task.Workdir, 0o700); err != nil {
			t.Fatal(err)
		}
		stream, err := store.stream(task.Stream)
		if err != nil {
			t.Fatal(err)
		}
		if err := store.transition(stream, SchedulerRunning, "fixture", "persist worker state"); err != nil {
			t.Fatal(err)
		}
		if err := store.advance(task.Stream, AdvanceWorking, "", "", ""); err != nil {
			t.Fatal(err)
		}
		stream, err = store.stream(task.Stream)
		if err != nil {
			t.Fatal(err)
		}
		return task, store, stream
	}
	lifecycle, cancelLifecycle := schedulerLifecycleContext(context.Background())
	defer cancelLifecycle()
	options := func() schedulerRunOptions {
		return newSchedulerRunOptions(newSchedulerStore(f.state), schedulerRunOptionsConfig{root: f.invocationRoot(), state: f.state, supervisor: f.supervisor, lifecycle: lifecycle})
	}
	working, _, _ := makeTask("restart-working")
	for range 2 {
		if err := options().recoverAutoStreams(); err != nil {
			t.Fatal(err)
		}
	}
	if state, err := newSchedulerStore(f.state).stream(working.Stream); err != nil || state.State != SchedulerReady || state.Advance.State != AdvanceWorking {
		t.Fatalf("working recovery=%+v err=%v", state, err)
	}
	verifying, verifyingStore, _ := makeTask("restart-verifying")
	runID, err := proc.AllocateRunID()
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyingStore.advanceWithRunID(verifying.Stream, AdvanceVerifying, "", "", schedulerTestSHA, runID); err != nil {
		t.Fatal(err)
	}
	verifyingState, err := verifyingStore.stream(verifying.Stream)
	if err != nil || verifyingState.Advance.RunID != runID {
		t.Fatalf("verification transition did not persist its run identity: stream=%+v err=%v", verifyingState, err)
	}
	report := []byte("Status: DONE\n\n## Design gate\n| root cause | single owner (package/module/file) | rail type | why it is not a shape rail or a copy |\n|---|---|---|---|\n| cause | owner | structured data or contract | owner |\n\n## Verification\nPASS\n\n## Open issues\nNone\n\n## Unrequested behaviour changes\nNone\n\n## Debt self-scan\nNone\n\n## Self-review\nComplete\n")
	if err := os.WriteFile(filepath.Join(verifying.Workdir, ".agent-report.md"), report, 0o600); err != nil {
		t.Fatal(err)
	}
	rework, reworkStore, reworkState := makeTask("restart-rework")
	if err := reworkStore.advance(rework.Stream, AdvanceVerifying, "", "", schedulerTestSHA); err != nil {
		t.Fatal(err)
	}
	if err := reworkStore.advance(rework.Stream, AdvanceRework, "verification retry", "REJECT", ""); err != nil {
		t.Fatal(err)
	}
	reworkState, err = reworkStore.stream(rework.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := reworkStore.transition(reworkState, SchedulerReady, "rework", "resume worker"); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := options().recoverAutoStreams(); err != nil {
			t.Fatal(err)
		}
	}
	if state, err := newSchedulerStore(f.state).stream(rework.Stream); err != nil || state.State != SchedulerReady || state.Advance.State != AdvanceRework {
		t.Fatalf("rework recovery=%+v err=%v", state, err)
	}
	escalated, escalatedStore, _ := makeTask("restart-escalated")
	if err := escalatedStore.advance(escalated.Stream, AdvanceEscalated, "blocked", "", ""); err != nil {
		t.Fatal(err)
	}
	escalatedState, err := escalatedStore.stream(escalated.Stream)
	if err != nil {
		t.Fatal(err)
	}
	escalatedState.Cause = "blocked"
	if err := escalatedStore.commitAutoTransition([]SchedulerStream{escalatedState}); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := options().recoverAutoStreams(); err != nil {
			t.Fatal(err)
		}
	}
	if state, err := newSchedulerStore(f.state).stream(escalated.Stream); err != nil || state.State != SchedulerAwaitingOrchestrator || state.Advance.State != AdvanceEscalated {
		t.Fatalf("escalated recovery=%+v err=%v", state, err)
	}
}

// case: S-237.149
func TestAutoAdvanceFreshSchedulerRestartsEachReviewingRoleOnce(t *testing.T) {
	for _, role := range []ReviewRole{ReviewStandard, ReviewDelta, ReviewFinal} {
		t.Run(string(role), func(t *testing.T) {
			f := newSchedulerFixture(t, `[]`, `{}`)
			f.state = filepath.Join(f.home, "runner-state")
			worker := f.addTask(t, "restart-"+string(role), "worker")
			worker.OutsideSuites = []string{"kb-runner:./..."}
			worker.Review, worker.Reviewers = "", nil
			store := newSchedulerStore(f.state)
			if err := store.updateTask(worker); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(worker.Workdir, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(worker.Workdir, ".agent-report.md"), []byte("Status: DONE\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			stream, err := store.stream(worker.Stream)
			if err != nil {
				t.Fatal(err)
			}
			if err := store.transition(stream, SchedulerRunning, "fixture worker", "finish verification"); err != nil {
				t.Fatal(err)
			}
			if err := store.advance(worker.Stream, AdvanceWorking, "", "", ""); err != nil {
				t.Fatal(err)
			}
			if err := store.advance(worker.Stream, AdvanceVerifying, "", "", schedulerTestSHA); err != nil {
				t.Fatal(err)
			}
			if err := store.advance(worker.Stream, AdvanceReviewing, "", "", schedulerTestSHA); err != nil {
				t.Fatal(err)
			}
			parent, err := store.stream(worker.Stream)
			if err != nil {
				t.Fatal(err)
			}
			if role == ReviewDelta {
				parent.Advance.Round = 1
				parent.Advance.PreviousTreeHash = strings.Repeat("a", 40)
				parent.Advance.PreviousFindings = "prior reviewer finding"
			}
			if role == ReviewFinal {
				parent.Advance.HighRisk = true
			}
			if err := store.commitAutoTransition([]SchedulerStream{parent}); err != nil {
				t.Fatal(err)
			}
			options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: f.invocationRoot(), state: f.state, supervisor: f.supervisor})
			if err := options.queueAutoReview(worker, role); err != nil {
				t.Fatal(err)
			}
			reviewID := fmt.Sprintf("%s-review-%s-r%d", worker.Stream, role, parent.Advance.Round+1)
			reviewStream, err := store.stream(reviewID)
			if err != nil {
				t.Fatal(err)
			}
			if err := store.transition(reviewStream, SchedulerRunning, "fake reviewer started", "persist in-flight review"); err != nil {
				t.Fatal(err)
			}
			for range 2 {
				restarted := newSchedulerRunOptions(newSchedulerStore(f.state), schedulerRunOptionsConfig{root: f.invocationRoot(), state: f.state, supervisor: f.supervisor})
				if err := restarted.recoverAutoStreams(); err != nil {
					t.Fatalf("fresh %s recovery: %v", role, err)
				}
			}
			tasks, err := newSchedulerStore(f.state).tasks()
			if err != nil {
				t.Fatal(err)
			}
			count := 0
			for _, candidate := range tasks {
				if candidate.Role == schedulerReviewRole && candidate.ReviewerKind == role && candidate.DependsOn[0] == worker.ID {
					count++
					if candidate.ID != reviewID {
						t.Errorf("recovery changed review task identity %s to %s", reviewID, candidate.ID)
					}
				}
			}
			if count != 1 {
				t.Fatalf("fresh recovery created %d %s review tasks, want exactly one", count, role)
			}
			resumed, err := newSchedulerStore(f.state).stream(reviewID)
			if err != nil || resumed.State != SchedulerReady {
				t.Fatalf("fresh recovery state=%+v err=%v, want same task READY", resumed, err)
			}
		})
	}
}

func countReviewRole(tasks []SchedulerTask, role ReviewRole) int {
	count := 0
	for _, task := range tasks {
		if task.ReviewerKind == role {
			count++
		}
	}
	return count
}

func TestSchedulerLifecycleContextIsCancellableForSupervision(t *testing.T) {
	parent, cancelParent := context.WithCancel(context.Background())
	defer cancelParent()

	lifecycle, stop := schedulerLifecycleContext(parent)
	defer stop()
	if lifecycle.Done() == nil {
		t.Fatal("scheduler lifecycle context has no cancellation signal")
	}
	if err := lifecycle.Err(); err != nil {
		t.Fatalf("scheduler lifecycle context started cancelled: %v", err)
	}

	cancelParent()
	select {
	case <-lifecycle.Done():
	case <-time.After(time.Second):
		t.Fatal("scheduler lifecycle context did not follow shutdown cancellation")
	}
}

func TestSchedulerAgentLaunchInheritsClikitRunID(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(root, "state")
	if err := os.MkdirAll(state, 0o700); err != nil {
		t.Fatal(err)
	}
	runner := filepath.Join(root, "runner fixture")
	script := "#!/bin/sh\nprintf 'run-id=%s\\nscheduler-agent-output\\n' \"$KBLABS_CLIPROC_RUN\"\n"
	if err := os.WriteFile(runner, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	prompt := filepath.Join(root, "prompt.md")
	if err := os.WriteFile(prompt, []byte("launch scheduler agent for the run identity test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	task := SchedulerTask{ID: "dispatch-task", Stream: "dispatch-stream", Role: schedulerWorkerRole, Vendor: "codex", Effort: "high", Base: "main", Prompt: prompt, RepoRoot: root, Workdir: root, WorktreeRoot: root}
	store := newSchedulerStore(state)
	if _, err := store.add(task); err != nil {
		t.Fatalf("create scheduler stream for agent launch: %v", err)
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: runnerRoot{invocation: runner}, state: state})
	output, err := options.runSchedulerAgent(ctx, task, "dispatch-job", "dispatch-run", "")
	if err != nil || !strings.Contains(string(output), "scheduler-agent-output") {
		t.Fatalf("supervised scheduler child result = %q err=%v", output, err)
	}
	if !strings.Contains(string(output), "run-id=") || strings.HasSuffix(strings.TrimSpace(string(output)), "run-id=") {
		t.Fatalf("scheduler child has no inherited clikit run identity: %q", output)
	}
}

func TestDrainSchedulerResultsWaitsForEveryActiveRun(t *testing.T) {
	results := make(chan schedulerWorkerResult, 2)
	done := make(chan struct{})
	go func() {
		drainSchedulerWorkerResults(results, 2)
		close(done)
	}()
	select {
	case <-done:
		t.Fatal("scheduler returned before active run results arrived")
	default:
	}
	results <- schedulerWorkerResult{task: SchedulerTask{ID: "first"}}
	select {
	case <-done:
		t.Fatal("scheduler returned before every active run result arrived")
	default:
	}
	results <- schedulerWorkerResult{task: SchedulerTask{ID: "second"}}
	<-done
}

func TestClaimForDispatchJournalsRunIdentityBeforeStart(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	task := f.addTask(t, "dispatch-identity", "worker")
	stream, claimed, err := newSchedulerStore(f.state).claimForDispatch(task.Stream, task.ID, "job-identity", "")
	if err != nil || !claimed {
		t.Fatalf("claim dispatch = stream=%+v claimed=%t err=%v", stream, claimed, err)
	}
	if stream.State != SchedulerRunning || stream.JobID != "job-identity" || stream.RunID == "" {
		t.Fatalf("dispatch transition did not atomically persist the job identity: %+v", stream)
	}
	reloaded, err := newSchedulerStore(f.state).stream(task.Stream)
	if err != nil || reloaded.RunID != stream.RunID || reloaded.JobID != stream.JobID || reloaded.State != SchedulerRunning {
		t.Fatalf("fresh store lost pre-dispatch identity: %+v err=%v", reloaded, err)
	}
}

func TestClaimForDispatchAllocatesMissingReviewRunIdentity(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	worker := f.addTask(t, "manual-review-identity", "worker")
	store := newSchedulerStore(f.state)
	workerStream, err := store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(workerStream, SchedulerRunning, "worker", "finish worker"); err != nil {
		t.Fatal(err)
	}
	workerStream, err = store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(workerStream, SchedulerAwaitingReview, "review", "dispatch manual review"); err != nil {
		t.Fatal(err)
	}
	review, err := store.add(SchedulerTask{Stream: "manual-review-identity-review", PromptTemplate: runnerReviewTemplate, Workdir: worker.Workdir, WorktreeRoot: worker.WorktreeRoot, RepoRoot: worker.RepoRoot, Base: worker.Base, Vendor: "codex", Effort: "medium", Role: schedulerReviewRole, DependsOn: []string{worker.ID}})
	if err != nil {
		t.Fatal(err)
	}
	claimed, didClaim, err := store.claimForDispatch(review.Stream, review.ID, "manual-review-job", "")
	if err != nil || !didClaim {
		t.Fatalf("manual review claim=%+v claimed=%t err=%v", claimed, didClaim, err)
	}
	if claimed.State != SchedulerRunning || claimed.RunID == "" || claimed.JobID != "manual-review-job" {
		t.Fatalf("manual review dispatch did not allocate and journal run identity: %+v", claimed)
	}
}

func TestSchedulerRunLookupPreservesUnknownRegistryState(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing-process-registry")
	supervisor := newFakeSchedulerSupervisor()
	supervisor.SetReadError(missing, "preallocated-run", errors.New("run record unreadable"))
	_, found, err := supervisor.RunByID(missing, "preallocated-run")
	var unknown schedulerRunUnknownError
	if found || !errors.As(err, &unknown) || unknown.RunID != "preallocated-run" {
		t.Fatalf("run lookup = found %t, error %#v; want typed unknown for preallocated-run", found, err)
	}
}

// case: S-237.149
func TestAutoAdvanceRecoveryEscalatesCorruptRunRecordAndContinues(t *testing.T) {
	fixture := newSchedulerFixture(t, `[]`, `{}`)
	store := newSchedulerStore(fixture.state)
	unknownTask := fixture.addTask(t, "a-unknown-run", schedulerWorkerRole)
	unknownTask.OutsideSuites = []string{"kb-runner:./..."}
	unknownTask.Review, unknownTask.Reviewers = "", nil
	if err := store.updateTask(unknownTask); err != nil {
		t.Fatal(err)
	}
	claimed, ok, err := store.claimForDispatch(unknownTask.Stream, unknownTask.ID, "unknown-run-job", "")
	if err != nil || !ok {
		t.Fatalf("claim worker before simulated crash: claimed=%t err=%v", ok, err)
	}
	if err := store.advance(unknownTask.Stream, AdvanceWorking, "agent round", "", ""); err != nil {
		t.Fatal(err)
	}
	corruptProcessOwnerRunRecord(t, fixture.state, claimed.RunID)

	otherTask := fixture.addTask(t, "z-other-stream", schedulerWorkerRole)
	otherTask.OutsideSuites = []string{"kb-runner:./..."}
	otherTask.Review, otherTask.Reviewers = "", nil
	if err := store.updateTask(otherTask); err != nil {
		t.Fatal(err)
	}
	other, err := store.stream(otherTask.Stream)
	if err != nil {
		t.Fatal(err)
	}
	other.State = SchedulerRunning
	other.Cause = "blocked"
	other.Advance = &StreamAdvance{State: AdvanceEscalated, Reason: "previous durable escalation"}
	if err := store.commitAutoTransition([]SchedulerStream{other}); err != nil {
		t.Fatalf("seed the second stream's pending projection: %v", err)
	}

	// Recovery uses fresh store and supervisor instances, as it would after a
	// scheduler process crash. The corrupt durable record must be unknown, not
	// treated as absent or allowed to abort recovery of the other stream.
	restartedStore := newSchedulerStore(fixture.state)
	options := newSchedulerRunOptions(restartedStore, schedulerRunOptionsConfig{
		root: fixture.invocationRoot(), state: fixture.state, supervisor: newFakeSchedulerSupervisor(),
	})
	if err := options.recoverAutoStreams(); err != nil {
		t.Fatalf("recover streams after corrupt run record: %v", err)
	}
	assertUnknownRunEscalated(t, restartedStore, unknownTask.Stream)
	advanced, err := restartedStore.stream(otherTask.Stream)
	if err != nil || advanced.State != SchedulerAwaitingOrchestrator {
		t.Fatalf("recovery did not continue to the other stream: state=%+v err=%v", advanced, err)
	}
	assertUnknownRunEventCount(t, restartedStore, unknownTask.Stream, 1)

	secondRestart := newSchedulerRunOptions(newSchedulerStore(fixture.state), schedulerRunOptionsConfig{
		root: fixture.invocationRoot(), state: fixture.state, supervisor: newFakeSchedulerSupervisor(),
	})
	if err := secondRestart.recoverAutoStreams(); err != nil {
		t.Fatalf("repeat recovery of durable unknown escalation: %v", err)
	}
	assertUnknownRunEventCount(t, secondRestart.store, unknownTask.Stream, 1)
}

// case: S-237.149
func TestAutoAdvanceRecoveryEscalatesCorruptVerificationRun(t *testing.T) {
	fixture := newSchedulerFixture(t, `[]`, `{}`)
	store := newSchedulerStore(fixture.state)
	task := fixture.addTask(t, "verification-unknown", schedulerWorkerRole)
	task.OutsideSuites = []string{"kb-runner:./..."}
	task.Review, task.Reviewers = "", nil
	if err := store.updateTask(task); err != nil {
		t.Fatal(err)
	}
	claimed, ok, err := store.claimForDispatch(task.Stream, task.ID, "verification-unknown-job", "")
	if err != nil || !ok {
		t.Fatalf("claim worker: claimed=%t err=%v", ok, err)
	}
	if err := store.advanceWithRunID(task.Stream, AdvanceWorking, "", "", "", claimed.RunID); err != nil {
		t.Fatal(err)
	}
	if err := store.advanceWithRunID(task.Stream, AdvanceVerifying, "", "", schedulerTestSHA, claimed.RunID); err != nil {
		t.Fatal(err)
	}
	corruptProcessOwnerRunRecord(t, fixture.state, claimed.RunID)
	options := newSchedulerRunOptions(newSchedulerStore(fixture.state), schedulerRunOptionsConfig{state: fixture.state, supervisor: newFakeSchedulerSupervisor()})
	if err := options.recoverAutoStreams(); err != nil {
		t.Fatalf("recover corrupt verification run: %v", err)
	}
	assertUnknownRunEscalated(t, options.store, task.Stream)
	assertUnknownRunEventCount(t, options.store, task.Stream, 1)
}

// case: S-237.149
func TestAutoAdvanceRecoveryEscalatesCorruptReviewRun(t *testing.T) {
	fixture := newSchedulerFixture(t, `[]`, `{}`)
	store := newSchedulerStore(fixture.state)
	worker := fixture.addTask(t, "review-unknown-worker", schedulerWorkerRole)
	worker.OutsideSuites = []string{"kb-runner:./..."}
	worker.Review, worker.Reviewers = "", nil
	if err := store.updateTask(worker); err != nil {
		t.Fatal(err)
	}
	claimedWorker, ok, err := store.claimForDispatch(worker.Stream, worker.ID, "review-unknown-worker-job", "")
	if err != nil || !ok {
		t.Fatalf("claim worker: claimed=%t err=%v", ok, err)
	}
	for _, advance := range []StreamAdvanceState{AdvanceWorking, AdvanceVerifying, AdvanceReviewing} {
		if err := store.advanceWithRunID(worker.Stream, advance, "", "", schedulerTestSHA, claimedWorker.RunID); err != nil {
			t.Fatalf("advance worker to %s: %v", advance, err)
		}
	}
	workerStream, err := store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(workerStream, SchedulerAwaitingReview, "review", "dispatch reviewer"); err != nil {
		t.Fatal(err)
	}
	review, err := store.add(SchedulerTask{
		Stream: worker.Stream + "-review", PromptTemplate: runnerReviewTemplate, Workdir: worker.Workdir,
		WorktreeRoot: worker.WorktreeRoot, RepoRoot: worker.RepoRoot, Base: worker.Base, Vendor: "codex", Effort: "high",
		Role: schedulerReviewRole, ReviewerKind: ReviewStandard, DependsOn: []string{worker.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	claimedReview, ok, err := store.claimForDispatch(review.Stream, review.ID, "review-unknown-job", "")
	if err != nil || !ok {
		t.Fatalf("claim review: claimed=%t err=%v", ok, err)
	}
	corruptProcessOwnerRunRecord(t, fixture.state, claimedReview.RunID)
	options := newSchedulerRunOptions(newSchedulerStore(fixture.state), schedulerRunOptionsConfig{state: fixture.state, supervisor: newFakeSchedulerSupervisor()})
	if err := options.recoverAutoStreams(); err != nil {
		t.Fatalf("recover corrupt review run: %v", err)
	}
	assertUnknownRunEscalated(t, options.store, worker.Stream)
	assertUnknownRunEventCount(t, options.store, worker.Stream, 1)
}

func corruptProcessOwnerRunRecord(t *testing.T, state, runID string) {
	t.Helper()
	if err := proc.WriteRunRecord(state, proc.RunInfo{RunID: runID, Tag: runID, Status: proc.StatusRunning, Command: []string{"fixture-job"}}); err != nil {
		t.Fatalf("write process-owner record before simulated crash: %v", err)
	}
	corruptExistingProcessOwnerRunRecord(t, state, runID)
}

func corruptExistingProcessOwnerRunRecord(t *testing.T, state, runID string) {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(state, "runs", "*.json"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("find process-owner record after Start boundary: paths=%v err=%v", paths, err)
	}
	for _, path := range paths {
		if filepath.Base(path) == runID+".json" {
			if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
				t.Fatalf("corrupt process-owner record before restart: %v", err)
			}
			return
		}
	}
	t.Fatalf("proc did not publish run record %s in its live-record listing %v", runID, paths)
}

func assertUnknownRunEscalated(t *testing.T, store *schedulerStore, streamName string) {
	t.Helper()
	stream, err := store.stream(streamName)
	if err != nil || stream.State != SchedulerAwaitingOrchestrator || stream.Cause != "unknown-run" || stream.Advance == nil || stream.Advance.State != AdvanceEscalated {
		t.Fatalf("corrupt run recovery state=%+v err=%v; want durable unknown escalation", stream, err)
	}
}

func assertUnknownRunEventCount(t *testing.T, store *schedulerStore, stream string, want int) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(store.dir, "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			continue
		}
		var event struct {
			Kind   string `json:"kind"`
			Status string `json:"status"`
			Stream string `json:"stream"`
			Cause  string `json:"cause"`
		}
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("decode scheduler event %q: %v", line, err)
		}
		if event.Kind == "orchestrator.event" && event.Status == "escalated" && event.Stream == stream {
			count++
		}
	}
	if count != want {
		t.Fatalf("unknown run escalation event count for %s=%d, want %d", stream, count, want)
	}
}

func TestCarryWorkerSessionClassifiesMissingJobRecordAsAbsent(t *testing.T) {
	state := t.TempDir()
	stream := SchedulerStream{Stream: "missing-worker-record", JobID: "preallocated-job"}
	stateResult, err := carryWorkerSessionFromJob(state, &stream)
	if err != nil || stateResult != workerJobRecordAbsent {
		t.Fatalf("missing worker job record result=%v err=%v; want typed absent outcome", stateResult, err)
	}
}

// case: S-237.149
func TestAutoAdvanceRecoveryNoOpsTerminalDoneStream(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	task := f.addTask(t, "terminal-recovery", "worker")
	task.OutsideSuites = []string{"kb-runner:./..."}
	task.Review, task.Reviewers = "", nil
	t.Setenv("FAKE_OLD_SHA", schedulerTestSHA)
	store := newSchedulerStore(f.state)
	if err := store.updateTask(task); err != nil {
		t.Fatal(err)
	}
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	stream.State = SchedulerDone
	stream.Advance = &StreamAdvance{State: AdvanceAccepted, TreeHash: schedulerTestSHA, LandingCommit: schedulerTestSHA}
	if err := store.commitAutoTransition([]SchedulerStream{stream}); err != nil {
		t.Fatal(err)
	}
	eventsPath := filepath.Join(store.dir, "events.jsonl")
	before, err := os.ReadFile(eventsPath)
	if err != nil {
		t.Fatal(err)
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: f.invocationRoot(), state: f.state, supervisor: f.supervisor})
	if err := options.recoverAutoStreams(); err != nil {
		t.Fatalf("recovery of an already-done stream: %v", err)
	}
	after, err := os.ReadFile(eventsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(after, before) {
		t.Fatalf("terminal recovery wrote another transition: before=%s after=%s", before, after)
	}
}

// case: S-237.149
func TestAutoAdvanceResumesOnePartialAndEscalatesTheSecond(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	f.state = filepath.Join(f.home, "runner-state")
	task := f.addTask(t, "partial-worker", "worker")
	task.OutsideSuites = []string{"kb-runner:./..."}
	task.Review, task.Reviewers = "", nil
	store := newSchedulerStore(f.state)
	if err := store.updateTask(task); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(task.Workdir, 0o700); err != nil {
		t.Fatal(err)
	}
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	seedSchedulerWorkerSession(t, store, &stream, "partial-worker-session")
	if err := store.transition(stream, SchedulerRunning, "agent round", "wait for agent report"); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(task.Stream, AdvanceWorking, "", "", ""); err != nil {
		t.Fatal(err)
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{state: f.state, supervisor: f.supervisor})
	partial := []byte("Status: PARTIAL\n")
	if err := options.finishAutoWorker(task, stream, "Status: PARTIAL", partial); err != nil {
		t.Fatal(err)
	}
	stream, err = store.stream(task.Stream)
	if err != nil || stream.State != SchedulerReady || stream.Advance.PartialResumes != 1 {
		t.Fatalf("first partial state=%+v advance=%+v err=%v", stream, stream.Advance, err)
	}
	resumedTask, err := store.task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	continuation, err := os.ReadFile(resumedTask.Prompt)
	if err != nil || string(continuation) != "PARTIAL is not a stopping point; finish to DONE per the task prompt\n" {
		t.Fatalf("partial continuation=%q err=%v", continuation, err)
	}
	if err := store.transition(stream, SchedulerRunning, "agent round", "wait for agent report"); err != nil {
		t.Fatal(err)
	}
	if err := options.finishAutoWorker(resumedTask, stream, "Status: PARTIAL", partial); err != nil {
		t.Fatal(err)
	}
	stream, err = store.stream(task.Stream)
	if err != nil || stream.State != SchedulerAwaitingOrchestrator || stream.Advance.State != AdvanceEscalated || stream.Cause != "partial-twice" {
		t.Fatalf("second partial state=%+v advance=%+v err=%v", stream, stream.Advance, err)
	}
}

// case: S-237.149
func TestAutoAdvanceProjectsOnlyOrchestratorEventStatusesToHandoff(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{}`)
	f.state = filepath.Join(f.home, "runner-state")
	task := f.addTask(t, "event-worker", "worker")
	task.OutsideSuites = []string{"kb-runner:./..."}
	task.Review, task.Reviewers = "", nil
	store := newSchedulerStore(f.state)
	if err := store.updateTask(task); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(task.Stream, AdvanceWorking, "", "", ""); err != nil {
		t.Fatal(err)
	}
	stream := filepath.Join(f.worktrees, "HANDOFF.md")
	before, err := os.ReadFile(stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.appendEvent(streamAdvanceEvent{Kind: "scheduler.advance", Status: "progress", Stream: task.Stream, State: string(AdvanceWorking)}); err != nil {
		t.Fatal(err)
	}
	afterProgress, err := os.ReadFile(stream)
	if err != nil || string(afterProgress) != string(before) {
		t.Fatalf("routine event changed HANDOFF: before=%q after=%q err=%v", before, afterProgress, err)
	}
	if err := store.appendOrchestratorEvent(streamAdvanceEvent{Kind: "orchestrator.event", Status: "disk", Stream: task.Stream, State: string(AdvanceWorking), Reason: "low disk"}); err != nil {
		t.Fatal(err)
	}
	afterDisk, err := os.ReadFile(stream)
	if err != nil || !strings.Contains(string(afterDisk), `"status":"disk"`) {
		t.Fatalf("disk event missing from HANDOFF: %q err=%v", afterDisk, err)
	}
	if err := store.appendOrchestratorEvent(streamAdvanceEvent{Kind: "orchestrator.event", Status: "progress", Stream: task.Stream}); err == nil {
		t.Fatal("routine progress was accepted as an orchestrator event")
	}
}

// case: S-237.89
func TestSchedulerRiskPolicyEscalatesChangedRiskZone(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	t.Setenv("FAKE_CHANGED_FILES", "tools/kb-runner/scheduler.go")
	policy, err := os.ReadFile(filepath.Join(f.repo, "tools", "kb-runner", "scheduler-policy.json"))
	if err != nil {
		t.Fatal(err)
	}
	var configured schedulerPolicy
	if err := json.Unmarshal(policy, &configured); err != nil {
		t.Fatalf("decode policy: %v", err)
	}
	if len(configured.RiskZones) == 0 || !containsSchedulerPath(configured.RiskZones, "tools/kb-runner/scheduler.go") {
		t.Fatalf("risk policy does not cover scheduler implementation: %s", policy)
	}
	if !strings.Contains(string(policy), "tools/kb-create/**") || !strings.Contains(string(policy), "scripts/ci/**") {
		t.Fatalf("policy omitted requested risk zones: %s", policy)
	}
	task := f.addTask(t, "risk-worker", "worker")
	if err := os.MkdirAll(task.Workdir, 0o700); err != nil {
		t.Fatal(err)
	}
	stream := SchedulerStream{Stream: task.Stream, TaskID: task.ID, Submission: &SchedulerSubmission{SHA: schedulerTestSHA}}
	options := newSchedulerRunOptions(newSchedulerStore(f.state), schedulerRunOptionsConfig{})
	mode, reviewers, err := options.reviewPolicy(task, stream)
	if err != nil || mode != "cross" || len(reviewers) != 2 {
		t.Fatalf("risk-zone policy mode=%s reviewers=%v err=%v", mode, reviewers, err)
	}
}

// case: S-237.86
func TestSchedulerMergeConflictQueuesResolverOnlyWithUnmergedFiles(t *testing.T) {
	runs := `[{"databaseId":11,"event":"push","path":".github/workflows/remote-verify.yml","headBranch":"verify/worker-a-0123456","headSha":"` + schedulerTestSHA + `","status":"completed","conclusion":"success"}]`
	f := newSchedulerFixture(t, runs, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	f.addTask(t, "worker-a", "worker")
	t.Setenv("FAKE_MERGE_CONFLICT", "1")
	t.Setenv("FAKE_UNMERGED", "tools/kb-runner/scheduler.go")
	code, output := f.runOnce(t)
	if code != 0 {
		t.Fatalf("conflicting land cycle exit=%d output=%s", code, output)
	}
	mergeTask, err := newSchedulerStore(f.state).task("worker-a-merge")
	if err != nil || mergeTask.Role != schedulerMergeRole || mergeTask.Vendor != "codex" || mergeTask.PromptTemplate != runnerMergeTemplate {
		t.Fatalf("conflict did not enqueue persisted merge resolver: task=%+v err=%v", mergeTask, err)
	}
}

// case: S-237.90, S-237.91
func TestSchedulerCrossReviewDisagreementNamesBothReports(t *testing.T) {
	runs := `[{"databaseId":11,"event":"push","path":".github/workflows/remote-verify.yml","headBranch":"verify/worker-a-0123456","headSha":"` + schedulerTestSHA + `","status":"completed","conclusion":"success"}]`
	f := newSchedulerFixture(t, runs, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	task := f.addTask(t, "worker-a", "worker")
	task.Review, task.Reviewers = "cross", []string{"codex", "gemini"}
	if err := newSchedulerStore(f.state).updateTask(task); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_REVIEW_VERDICT", "ACCEPT")
	t.Setenv("FAKE_REVIEW_VERDICT_2", "REJECT")
	code, output := f.runOnce(t)
	if code != 0 {
		t.Fatalf("cross review cycle exit=%d output=%s", code, output)
	}
	for _, run := range f.supervisor.List(f.state).Runs {
		if len(run.Command) == 0 || run.Command[0] != filepath.Join(f.bin, "kb-runner") {
			t.Fatalf("scheduler child command = %q, want fixture executable %q", run.Command, filepath.Join(f.bin, "kb-runner"))
		}
	}
	stream, err := newSchedulerStore(f.state).stream(task.Stream)
	if err != nil || stream.State != SchedulerAwaitingOrchestrator || stream.Cause != "review-disagreement" || len(stream.ReviewRunIDs) != 2 {
		tasks, _ := newSchedulerStore(f.state).tasks()
		launches, _ := os.ReadFile(f.launchCalls)
		second, secondErr := newSchedulerStore(f.state).stream("worker-a-review-2")
		reports, _ := filepath.Glob(filepath.Join(f.state, "jobs", "*.review.md"))
		t.Fatalf("disagreement was not routed with both reports: %+v second=%+v secondErr=%v reports=%v tasks=%+v launches=%s err=%v", stream, second, secondErr, reports, tasks, launches, err)
	}
	if stream.ReviewRunIDs[0] == stream.ReviewRunIDs[1] {
		t.Fatalf("cross reviewers shared a run identity: %v", stream.ReviewRunIDs)
	}
}

// case: S-237.92
func TestSchedulerZCodeReviewUsesNativeAgentAndSkipsUnavailableAccount(t *testing.T) {
	runs := `[{"databaseId":11,"event":"push","path":".github/workflows/remote-verify.yml","headBranch":"verify/worker-a-0123456","headSha":"` + schedulerTestSHA + `","status":"completed","conclusion":"success"}]`
	f := newSchedulerFixture(t, runs, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	task := f.addTask(t, "worker-a", "worker")
	task.Review, task.Reviewers = "cross", []string{"codex", "zcode"}
	if err := newSchedulerStore(f.state).updateTask(task); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_ZCODE_FAIL", "0")
	code, output := f.runOnce(t)
	if code != 0 {
		t.Fatalf("ZCode active review cycle exit=%d output=%s", code, output)
	}
	reviewTask, err := newSchedulerStore(f.state).task("worker-a-review-2")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(testReviewOutputPath(t, f.state, reviewTask)); err != nil {
		t.Fatalf("active native ZCode agent did not write its private report: %v", err)
	}
	activeCalls, err := os.ReadFile(f.launchCalls)
	if err != nil || !strings.Contains(string(activeCalls), "--vendor zcode") || !strings.Contains(string(activeCalls), "--slot-group agent-scheduler") {
		t.Fatalf("ZCode review bypassed native admission: calls=%q err=%v", activeCalls, err)
	}

	runsB := `[{"databaseId":12,"event":"push","path":".github/workflows/remote-verify.yml","headBranch":"verify/worker-b-0123456","headSha":"` + schedulerTestSHA + `","status":"completed","conclusion":"success"}]`
	f2 := newSchedulerFixture(t, runsB, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	task2 := f2.addTask(t, "worker-b", "worker")
	task2.Review, task2.Reviewers = "cross", []string{"codex", "zcode"}
	if err := newSchedulerStore(f2.state).updateTask(task2); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_ZCODE_FAIL", "1")
	code, output = f2.runOnce(t)
	if code != 0 {
		t.Fatalf("ZCode unavailable review cycle exit=%d output=%s", code, output)
	}
	stream, err := newSchedulerStore(f2.state).stream(task2.Stream)
	if err != nil || stream.State != SchedulerAwaitingRemote || stream.ReviewResults["zcode-2"] != "ACCEPT" {
		t.Fatalf("independent configured reviewer did not replace the skipped ZCode vote: %+v err=%v", stream, err)
	}
	zcodeState, err := newSchedulerStore(f2.state).stream("worker-b-review-2")
	if err != nil || zcodeState.State != SchedulerDone || !strings.Contains(zcodeState.Cause, "ZCode unavailable") {
		t.Fatalf("unavailable ZCode cause was not recorded: %+v err=%v", zcodeState, err)
	}
	fallback, err := newSchedulerStore(f2.state).task("worker-b-review-fallback-codex-zcode-2")
	if err != nil || fallback.ReviewerKey != "zcode-2" || fallback.Vendor != "codex" {
		t.Fatalf("skipped ZCode slot did not receive an independent Codex verdict: %+v err=%v", fallback, err)
	}
}

// case: S-237.78
func TestSchedulerPartialReportStopsAtOrchestrator(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	f.addTask(t, "worker-a", "worker")
	t.Setenv("FAKE_AGENT_STATUS", "Status: PARTIAL")
	code, output := f.runOnce(t)
	if code != 0 {
		t.Fatalf("sched run exit=%d output=%s", code, output)
	}
	data, err := os.ReadFile(filepath.Join(f.state, "sched", "streams", "worker-a.json"))
	if err != nil {
		t.Fatal(err)
	}
	var stream SchedulerStream
	if err := json.Unmarshal(data, &stream); err != nil || stream.State != SchedulerAwaitingOrchestrator {
		t.Fatalf("partial worker report state=%+v decode=%v", stream, err)
	}
	if _, err := os.Stat(f.ghCalls); !os.IsNotExist(err) {
		t.Fatalf("partial report submitted remote verification: %v", err)
	}
}

// case: S-237.78
func TestSchedulerPlanQuestionStopsAtOrchestrator(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	f.addTask(t, "worker-a", "worker")
	t.Setenv("FAKE_AGENT_QUESTION", "PLAN-QUESTION: confirm the intended boundary")
	code, output := f.runOnce(t)
	if code != 0 {
		t.Fatalf("sched run exit=%d output=%s", code, output)
	}
	stream, err := newSchedulerStore(f.state).stream("worker-a")
	if err != nil || stream.State != SchedulerAwaitingOrchestrator {
		t.Fatalf("questioned report state=%+v err=%v", stream, err)
	}
	if _, err := os.Stat(f.ghCalls); !os.IsNotExist(err) {
		t.Fatalf("questioned report submitted remote verification: %v", err)
	}
}

// case: S-237.78, S-237.80
func TestSchedulerReleasesWorkerSlotAndOneWatcherCoversPendingRuns(t *testing.T) {
	runs := `[{"databaseId":11,"event":"push","path":".github/workflows/remote-verify.yml","headBranch":"verify/worker-a-0123456","headSha":"` + schedulerTestSHA + `","status":"queued","conclusion":null},{"databaseId":12,"event":"push","path":".github/workflows/remote-verify.yml","headBranch":"verify/worker-b-0123456","headSha":"` + schedulerTestSHA + `","status":"queued","conclusion":null}]`
	f := newSchedulerFixture(t, runs, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	f.addTask(t, "worker-a", "worker")
	f.addTask(t, "worker-b", "worker")
	code, output := f.runOnce(t)
	if code != 0 {
		t.Fatalf("sched run --once exit=%d output=%s", code, output)
	}
	launches, err := os.ReadFile(f.launchCalls)
	if err != nil || strings.Count(string(launches), "agent start") != 2 {
		t.Fatalf("worker launches=%q err=%v", launches, err)
	}
	ghCalls, err := os.ReadFile(f.ghCalls)
	if err != nil || strings.Count(string(ghCalls), "run list") != 1 || strings.Contains(string(ghCalls), "run view") {
		t.Fatalf("watcher calls=%q err=%v", ghCalls, err)
	}
	gitCalls, err := os.ReadFile(f.gitCalls)
	if err != nil || !strings.Contains(string(gitCalls), "worktree add -B agent/worker-a") || !strings.Contains(string(gitCalls), "push backup "+schedulerTestSHA+":refs/heads/verify/worker-a-"+schedulerTestSHA[:7]) {
		t.Fatalf("worktree or verification push arguments=%q err=%v", gitCalls, err)
	}
	for _, stream := range []string{"worker-a", "worker-b"} {
		data, err := os.ReadFile(filepath.Join(f.state, "sched", "streams", stream+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var got SchedulerStream
		if err := json.Unmarshal(data, &got); err != nil || got.State != SchedulerAwaitingRemote {
			t.Fatalf("stream %s=%+v decode=%v", stream, got, err)
		}
	}
}

// case: S-237.79
func TestSchedulerRejectedReviewArchivesReportAndResumesWorker(t *testing.T) {
	runs := `[{"databaseId":11,"event":"push","path":".github/workflows/remote-verify.yml","headBranch":"verify/worker-a-0123456","headSha":"` + schedulerTestSHA + `","status":"completed","conclusion":"success"}]`
	verdict := `{"schemaVersion":1,"sha":"` + schedulerTestSHA + `","status":"pass","jobs":[],"diagnostics":[]}`
	f := newSchedulerFixture(t, runs, verdict)
	f.addTask(t, "worker-a", "worker")
	t.Setenv("FAKE_REVIEW_VERDICT", "REJECT")
	code, output := f.runOnce(t)
	if code != 0 {
		t.Fatalf("scheduler review cycle exit=%d output=%s", code, output)
	}
	worker, err := newSchedulerStore(f.state).stream("worker-a")
	if err != nil || worker.State != SchedulerReady || worker.ThreadID != "fixture-thread" {
		t.Fatalf("rejected review did not ready the original thread: %+v err=%v", worker, err)
	}
	task, err := newSchedulerStore(f.state).task(worker.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	prompt, err := os.ReadFile(task.Prompt)
	if err != nil || !strings.Contains(string(prompt), "archived review") {
		t.Fatalf("resume prompt does not point to archived review: %q err=%v", prompt, err)
	}
	archives, err := filepath.Glob(filepath.Join(task.Workdir, "reports", task.Stream+".review.*.md"))
	if err != nil || len(archives) != 1 {
		t.Fatalf("archived review paths=%v err=%v", archives, err)
	}
	reviewState, err := newSchedulerStore(f.state).stream("worker-a-review")
	if err != nil || reviewState.State != SchedulerDone {
		t.Fatalf("rejected review task did not retain its completed verdict: %+v err=%v", reviewState, err)
	}
	t.Setenv("FAKE_REVIEW_VERDICT", "ACCEPT")
	code, output = f.runOnce(t)
	if code != 0 {
		t.Fatalf("second review cycle exit=%d output=%s", code, output)
	}
	worker, err = newSchedulerStore(f.state).stream("worker-a")
	if err != nil || worker.State != SchedulerAwaitingRemote {
		t.Fatalf("accepted review did not submit an integration candidate: %+v err=%v", worker, err)
	}
}

// case: S-237.81
func TestSchedulerDeadlinePersistsTimeoutVerdict(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	task := f.addTask(t, "worker-a", "worker")
	f.addAwaitingRemote(t, task, SchedulerSubmission{SHA: schedulerTestSHA, Ref: "verify/worker-a-0123456", RunID: "11", DeadlineAt: time.Now().UTC().Add(-time.Second)})
	code, output := f.runOnce(t)
	if code != 0 {
		t.Fatalf("deadline watcher exit=%d output=%s", code, output)
	}
	stream, err := newSchedulerStore(f.state).stream(task.Stream)
	if err != nil || stream.State != SchedulerAwaitingOrchestrator || stream.Cause != "outage-after-retries" || stream.WaitingFor != "remote deadline" {
		t.Fatalf("deadline stream=%+v err=%v", stream, err)
	}
	path := filepath.Join(filepath.Dir(task.RepoRoot), "reports", task.Stream+".remote."+schedulerTestSHA[:7]+".json")
	data, err := os.ReadFile(path)
	var verdict map[string]any
	if err != nil || json.Unmarshal(data, &verdict) != nil || verdict["status"] != "timeout" {
		t.Fatalf("timeout verdict=%s err=%v", data, err)
	}
}

// case: S-237.82
func TestSchedulerOutageRerunsAtMostTwice(t *testing.T) {
	runs := `[{"databaseId":11,"event":"push","path":".github/workflows/remote-verify.yml","headBranch":"verify/worker-a-0123456","headSha":"` + schedulerTestSHA + `","status":"completed","conclusion":"failure"}]`
	verdict := `{"schemaVersion":1,"sha":"` + schedulerTestSHA + `","status":"outage","jobs":[],"diagnostics":["remote outage"]}`
	f := newSchedulerFixture(t, runs, verdict)
	task := f.addTask(t, "worker-a", "worker")
	f.addAwaitingRemote(t, task, SchedulerSubmission{SHA: schedulerTestSHA, Ref: "verify/worker-a-0123456", RunID: "11", DeadlineAt: time.Now().UTC().Add(time.Hour)})
	for range 3 {
		code, output := f.runOnce(t)
		if code != 0 {
			t.Fatalf("outage watcher exit=%d output=%s", code, output)
		}
	}
	stream, err := newSchedulerStore(f.state).stream(task.Stream)
	if err != nil || stream.State != SchedulerAwaitingOrchestrator || stream.Submission.Attempts != 2 {
		t.Fatalf("outage attempts were not bounded: stream=%+v err=%v", stream, err)
	}
	calls, err := os.ReadFile(f.ghCalls)
	if err != nil || strings.Count(string(calls), "run rerun") != 2 {
		t.Fatalf("remote rerun calls=%q err=%v", calls, err)
	}
}

// case: S-237.83
func TestSchedulerSupersedeCancelsOlderRunAndUsesNewSHA(t *testing.T) {
	oldSHA := strings.Repeat("a", 40)
	runs := `[{"databaseId":23,"event":"push","path":".github/workflows/remote-verify.yml","headBranch":"verify/worker-a-` + oldSHA[:7] + `","headSha":"` + oldSHA + `","status":"queued","conclusion":null}]`
	f := newSchedulerFixture(t, runs, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	task := f.addTask(t, "worker-a", "worker")
	t.Setenv("FAKE_SHA", schedulerTestSHA)
	stream, err := newSchedulerStore(f.state).stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	stream.Submission = &SchedulerSubmission{SHA: oldSHA, Ref: "verify/worker-a-" + oldSHA[:7], RunID: "23", DeadlineAt: time.Now().UTC().Add(time.Hour)}
	if err := newSchedulerStore(f.state).commitAutoTransition([]SchedulerStream{stream}); err != nil {
		t.Fatal(err)
	}
	code, output := f.runOnce(t)
	if code != 0 {
		t.Fatalf("superseding scheduler run exit=%d output=%s", code, output)
	}
	stream, err = newSchedulerStore(f.state).stream(task.Stream)
	if err != nil || stream.State != SchedulerAwaitingRemote || stream.Submission.SHA != schedulerTestSHA {
		t.Fatalf("new submission did not supersede old: stream=%+v err=%v", stream, err)
	}
	calls, err := os.ReadFile(f.ghCalls)
	if err != nil || !strings.Contains(string(calls), "run cancel 23") {
		t.Fatalf("old verification run was not cancelled: calls=%q err=%v", calls, err)
	}
}

// case: S-237.84
func TestSchedulerDependencyReleasesAfterOrchestratorCompletes(t *testing.T) {
	runs := `[{"databaseId":11,"event":"push","path":".github/workflows/remote-verify.yml","headBranch":"verify/worker-a-0123456","headSha":"` + schedulerTestSHA + `","status":"completed","conclusion":"success"},{"databaseId":12,"event":"push","path":".github/workflows/remote-verify.yml","headBranch":"verify/candidate-worker-a-0123456","headSha":"` + schedulerTestSHA + `","status":"completed","conclusion":"success"}]`
	verdict := `{"schemaVersion":1,"sha":"` + schedulerTestSHA + `","status":"pass","jobs":[],"diagnostics":[]}`
	f := newSchedulerFixture(t, runs, verdict)
	parent := f.addTask(t, "worker-a", "worker")
	f.addTask(t, "worker-b", "worker", parent.ID)
	code, output := f.runOnce(t)
	if code != 0 {
		t.Fatalf("parent verification and review exit=%d output=%s", code, output)
	}
	parentState, err := newSchedulerStore(f.state).stream(parent.Stream)
	if err != nil || parentState.State != SchedulerAwaitingRemote {
		t.Fatalf("accepted parent candidate=%+v err=%v", parentState, err)
	}
	reviewTask, err := newSchedulerStore(f.state).task("worker-a-review")
	if err != nil || reviewTask.Role != schedulerReviewRole || reviewTask.Vendor != "codex" || reviewTask.PromptTemplate != runnerReviewTemplate {
		t.Fatalf("passing verdict did not create the configured review task: %+v err=%v", reviewTask, err)
	}
	reviewPrompt, err := os.ReadFile(filepath.Join(f.state, "sched", "prompts", "worker-a-review.md"))
	if err != nil || !strings.Contains(string(reviewPrompt), "Review the completed stream worker-a") || !strings.Contains(string(reviewPrompt), "Reviewer focus: independent review") {
		t.Fatalf("review template was not rendered with the stream: %q err=%v", reviewPrompt, err)
	}
	templateBefore, err := readRunnerTemplate(runnerReviewTemplate)
	if err != nil {
		t.Fatal(err)
	}
	templateAfter, err := readRunnerTemplate(runnerReviewTemplate)
	if err != nil || string(templateAfter) != string(templateBefore) {
		t.Fatalf("template changed during rendering: %q err=%v", templateAfter, err)
	}
	launches, err := os.ReadFile(f.launchCalls)
	if err != nil || strings.Contains(string(launches), "--stream worker-b ") {
		t.Fatalf("dependent task started before orchestrator completion: %q err=%v", launches, err)
	}
	code, output = f.runOnce(t)
	if code != 0 {
		t.Fatalf("dependent dispatch exit=%d output=%s", code, output)
	}
	launches, err = os.ReadFile(f.launchCalls)
	if err != nil || !strings.Contains(string(launches), "--stream worker-b ") {
		t.Fatalf("dependent task did not dispatch after completion: %q err=%v", launches, err)
	}
}

// case: S-237.79
func TestSchedulerFailureVerdictResumesOriginalThreadWithNamedFailures(t *testing.T) {
	runs := `[{"databaseId":11,"event":"push","path":".github/workflows/remote-verify.yml","headBranch":"verify/worker-a-0123456","headSha":"` + schedulerTestSHA + `","status":"completed","conclusion":"failure"}]`
	verdict := `{"schemaVersion":1,"sha":"` + schedulerTestSHA + `","status":"fail","jobs":[{"name":"unit","status":"fail","failures":["TestSchedulerRegression"],"logTail":"assertion failed"}],"diagnostics":["verification failed"]}`
	f := newSchedulerFixture(t, runs, verdict)
	task := f.addTask(t, "worker-a", "worker")
	code, output := f.runOnce(t)
	if code != 0 {
		t.Fatalf("initial scheduler cycle exit=%d output=%s", code, output)
	}
	data, err := os.ReadFile(filepath.Join(f.state, "sched", "streams", "worker-a.json"))
	if err != nil {
		t.Fatal(err)
	}
	var failed SchedulerStream
	if err := json.Unmarshal(data, &failed); err != nil || failed.State != SchedulerReady || failed.ThreadID != "fixture-thread" {
		t.Fatalf("failure did not route to original READY stream: %+v decode=%v", failed, err)
	}
	savedTask, err := newSchedulerStore(f.state).task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	prompt, err := os.ReadFile(savedTask.Prompt)
	if err != nil || !strings.Contains(string(prompt), "TestSchedulerRegression") || !strings.Contains(string(prompt), "assertion failed") {
		t.Fatalf("failure message was not retained in resume prompt: %q err=%v", prompt, err)
	}
	code, output = f.runOnce(t)
	if code != 0 {
		t.Fatalf("resume cycle exit=%d output=%s", code, output)
	}
	launches, err := os.ReadFile(f.launchCalls)
	if err != nil || !strings.Contains(string(launches), "--session fixture-thread") {
		t.Fatalf("resume did not use original thread: %q err=%v", launches, err)
	}
}

// case: S-237.117
func TestRoundPromptCombinesMessageAndDefinitionOfDone(t *testing.T) {
	message := "continue the task\n"
	definition := "report every proposed commit\n"
	got := composeRoundPrompt(message, definition)
	if got != message+"\n"+definition {
		t.Fatalf("round prompt=%q, want message followed by definition of done", got)
	}
}

// case: S-237.118
func TestReviewVerdictParsesOnlySuppliedRunOutput(t *testing.T) {
	got, err := resolveReviewVerdict([]byte("Verdict: ACCEPT\n\n## Defects\n\nNone.\n"))
	if err != nil || got != "ACCEPT" {
		t.Fatalf("resolveReviewVerdict=%q,%v", got, err)
	}
}

// case: S-237.123
func TestProposedCommitGroupsRejectMissingPopulatedSubjectBeforeCommit(t *testing.T) {
	commits, err := parseProposedCommits([]byte("## Proposed commits\n```json\n[{\"kind\":\"case\",\"subject\":\"-\"},{\"kind\":\"tests\",\"subject\":\"test: focused\"},{\"kind\":\"code\",\"subject\":\"fix: code\"}]\n```\n"))
	if err != nil {
		t.Fatalf("empty group marker should parse: %v", err)
	}
	if err := validateCommitGroups(commits, [][]string{{"docs/qa/scenarios/case.md"}, {"tools/kb-runner/main_test.go"}, {"tools/kb-runner/main.go"}}); err == nil {
		t.Fatal("populated case group accepted a missing commit subject")
	}
}

// case: S-237.123
func TestProposedCommitGroupsAllowMissingSubjectOnlyForEmptyGroup(t *testing.T) {
	commits := []proposedCommit{{Kind: "case", Subject: "-"}, {Kind: "tests", Subject: "test(runner): cover case"}, {Kind: "code", Subject: "fix(runner): implement behavior"}}
	groups := [][]string{{}, {"tools/kb-runner/main_test.go"}, {"tools/kb-runner/main.go"}}
	if err := validateCommitGroups(commits, groups); err != nil {
		t.Fatalf("empty case group must be skipped: %v", err)
	}
}

// case: S-237.122
func TestSchedulerAgentArgsUsesGovernorAndZCodeReportLocation(t *testing.T) {
	task := SchedulerTask{Stream: "stream-a", Vendor: "zcode", Effort: "high", Workdir: "/work/stream-a", Role: schedulerWorkerRole, Prompt: "/tmp/prompt"}
	args, err := schedulerAgentArgs(task, "/tmp/state", "job-a", "run-a", 2, "")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--slot-group agent-scheduler --slots 2") {
		t.Fatalf("scheduler agent args omit governor admission: %v", args)
	}
	if got := schedulerMessagePath(task); got != filepath.Join(task.Workdir, "reports", task.Stream+".md") {
		t.Fatalf("ZCode report=%q", got)
	}
	reviewTask := SchedulerTask{Stream: "stream-review", Vendor: "codex", Effort: "medium", Workdir: "/work/stream-a", Role: schedulerReviewRole, Prompt: "/tmp/review-prompt"}
	reviewArgs, err := schedulerAgentArgs(reviewTask, "/tmp/state", "job-review", "run-review", 2, "")
	if err != nil {
		t.Fatal(err)
	}
	reviewPath, err := reviewRunReportPath("/tmp/state", "run-review")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(reviewArgs, " "), "--message "+reviewPath) {
		t.Fatalf("review writer path does not use run-owned path %s: %v", reviewPath, reviewArgs)
	}
	for _, arg := range args {
		if strings.Contains(arg, "bypass") {
			t.Fatalf("scheduler passed a bypass input: %q", arg)
		}
	}
}

// case: S-237.117, S-237.122
func TestAgentLaunchUsesRenderedRoundPromptAndGovernor(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	task := f.addTask(t, "launch-a", "worker")
	var out, errOut bytes.Buffer
	code, err := executeInvocationWithSupervisor(f, []string{"agent", "launch", task.Stream, "--state", f.state}, &out, &errOut)
	if code != 0 || err != nil {
		diagnostics := agentDispatchDiagnostics(t, f, errOut.String(), task.Stream)
		t.Fatalf("agent launch exit=%d err=%v stdout=%s %s", code, err, out.String(), diagnostics)
	}
	calls, err := os.ReadFile(f.launchCalls)
	if err != nil || len(calls) == 0 {
		diagnostics := agentDispatchDiagnostics(t, f, errOut.String(), task.Stream)
		t.Fatalf("fake agent was not invoked: calls=%q err=%v %s", calls, err, diagnostics)
	}
	if !strings.Contains(string(calls), "--slot-group agent-scheduler --slots") {
		diagnostics := agentDispatchDiagnostics(t, f, errOut.String(), task.Stream)
		t.Fatalf("agent launch skipped scheduler admission: calls=%s %s", calls, diagnostics)
	}
	rendered := filepath.Join(f.state, "sched", "prompts", task.ID+"-round.md")
	prompt, err := os.ReadFile(rendered)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(prompt), "task for launch-a\n\n# Definition of done") {
		t.Fatalf("rendered round prompt=%q", prompt)
	}
}

// case: S-237.118
func TestResumeRefusesToLaunchWhenSnapshotGateFindsUnmergedIndex(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	task := f.addTask(t, "resume-a", "worker")
	store := newSchedulerStore(f.state)
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	stream.ThreadID = "fixture-thread"
	if err := store.writeStreamObserved(stream); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_INDEX_UNMERGED", "100644 1 deadbeef 1\tconflict.txt")
	t.Setenv("FAKE_AGENT_CALLS", f.gitCalls)
	var out, errOut bytes.Buffer
	status := executeInvocation("kb-runner", []string{"agent", "resume", task.Stream, "--state", f.state}, &out, &errOut)
	if status.Code() == 0 || !strings.Contains(errOut.String(), "cannot snapshot a worktree with unresolved merge entries") {
		t.Fatalf("resume snapshot refusal exit=%d stdout=%s stderr=%s", status.Code(), out.String(), errOut.String())
	}
	calls, err := os.ReadFile(f.gitCalls)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(calls), "agent start") {
		t.Fatalf("resume launched before snapshot gate: %s", calls)
	}
}

// case: S-237.119, S-237.120
func TestFinishReviewUsesRunOwnedOutputForRework(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	worker := f.addTask(t, "review-fallback", "worker")
	review := f.addTask(t, worker.Stream+"-review", "review", worker.ID)
	store := newSchedulerStore(f.state)
	worker.Review = "cross"
	worker.Reviewers = []string{"codex", "codex"}
	if err := store.updateTask(worker); err != nil {
		t.Fatal(err)
	}
	review.Workdir = worker.Workdir
	review.ReviewerKey = "codex-1"
	if err := store.updateTask(review); err != nil {
		t.Fatal(err)
	}
	workerState, err := store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	seedSchedulerWorkerSession(t, store, &workerState, "review-rework-session")
	workerState.Submission = &SchedulerSubmission{SHA: schedulerTestSHA}
	workerState.ReviewResults = map[string]string{"codex-2": "REJECT"}
	if err := store.writeStreamObserved(workerState); err != nil {
		t.Fatal(err)
	}
	workerState, err = store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(workerState, SchedulerRunning, "agent round", "finish worker"); err != nil {
		t.Fatal(err)
	}
	workerState, err = store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(workerState, SchedulerAwaitingReview, "review task", "run review"); err != nil {
		t.Fatal(err)
	}
	reviewState, err := store.stream(review.Stream)
	if err != nil {
		t.Fatal(err)
	}
	runID, err := proc.AllocateRunID()
	if err != nil {
		t.Fatal(err)
	}
	reviewState.RunID = runID
	if err := store.commitAutoTransition([]SchedulerStream{reviewState}); err != nil {
		t.Fatal(err)
	}
	reviewState, err = store.stream(review.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(reviewState, SchedulerRunning, "agent round", "finish review"); err != nil {
		t.Fatal(err)
	}
	reviewState, err = store.stream(review.Stream)
	if err != nil {
		t.Fatal(err)
	}
	runTestReviewJob(t, f.supervisor, f.state, reviewState.RunID, "Verdict: REJECT\n\n## Defects\n\nplease fix the report path\n\n## Verification\n\nPASS\n")
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{state: f.state, supervisor: f.supervisor})
	if err := options.finishReview(review, reviewState); err != nil {
		t.Fatal(err)
	}
	updated, err := store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if updated.State != SchedulerReady || updated.RejectRounds != 1 || len(updated.ReviewRunIDs) != 0 {
		t.Fatalf("review rejection did not return worker to READY: %+v", updated)
	}
	outputPath, output, err := readReviewRunOutput(f.supervisor, f.state, reviewState.RunID)
	if err != nil || string(output) != "Verdict: REJECT\n\n## Defects\n\nplease fix the report path\n\n## Verification\n\nPASS\n" {
		t.Fatalf("run-owned review output path=%s body=%q err=%v", outputPath, output, err)
	}
	archives, err := filepath.Glob(filepath.Join(worker.Workdir, "reports", worker.Stream+".review.*.md"))
	if err != nil || len(archives) != 1 {
		t.Fatalf("review output was not archived once: paths=%v err=%v", archives, err)
	}
	updatedTask, err := store.task(worker.ID)
	if err != nil {
		t.Fatal(err)
	}
	resumePrompt, err := os.ReadFile(updatedTask.Prompt)
	archivePath, pathErr := reviewArchivePath(worker, reviewState.RunID)
	if err != nil || pathErr != nil || !strings.Contains(string(resumePrompt), archivePath) || strings.Contains(string(resumePrompt), outputPath) {
		t.Fatalf("rework prompt does not name only archived output %s: %s err=%v pathErr=%v", archivePath, resumePrompt, err, pathErr)
	}
}

// case: S-237.121
func TestZCodeWorkerReportComesFromReportsStreamPath(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	task := f.addTask(t, "zcode-report", "worker")
	task.Vendor = "zcode"
	store := newSchedulerStore(f.state)
	if err := store.updateTask(task); err != nil {
		t.Fatal(err)
	}
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(stream, SchedulerRunning, "agent round", "wait for report"); err != nil {
		t.Fatal(err)
	}
	path := schedulerMessagePath(task)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("Status: PARTIAL\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	job := Job{ID: "zcode-job", Stream: task.Stream, Vendor: "zcode", State: JobOK, Phase: PhaseRun, SessionID: "zcode-session", MessagePath: path}
	if _, err := newJobStore(f.state).Create(job); err != nil {
		t.Fatal(err)
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{state: f.state, supervisor: f.supervisor})
	if err := options.finishWorker(schedulerWorkerResult{task: task, jobID: job.ID}); err != nil {
		t.Fatal(err)
	}
	updated, err := store.stream(task.Stream)
	if err != nil || updated.State != SchedulerAwaitingOrchestrator {
		t.Fatalf("ZCode reports/<stream>.md did not control worker outcome: stream=%+v err=%v", updated, err)
	}
}

// case: S-237.125
func TestZCodeLifecycleUsesPerStreamReportAndResumesSessionAfterSnapshot(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	task := f.addTask(t, "zcode-lifecycle", "worker")
	task.Vendor = "zcode"
	store := newSchedulerStore(f.state)
	if err := store.updateTask(task); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_AGENT_STATUS", "Status: PARTIAL")
	var out, errOut bytes.Buffer
	code, err := executeInvocationWithSupervisor(f, []string{"agent", "launch", "--vendor", "zcode", task.Stream, "--state", f.state}, &out, &errOut)
	if code != 0 || err != nil {
		diagnostics := agentDispatchDiagnostics(t, f, errOut.String(), task.Stream)
		t.Fatalf("ZCode launch exit=%d err=%v stdout=%s %s", code, err, out.String(), diagnostics)
	}
	launches, launchErr := os.ReadFile(f.launchCalls)
	if launchErr != nil || !strings.Contains(string(launches), "agent start") {
		diagnostics := agentDispatchDiagnostics(t, f, errOut.String(), task.Stream)
		t.Fatalf("ZCode fake agent was not invoked: calls=%q err=%v %s", launches, launchErr, diagnostics)
	}
	message := filepath.Join(task.Workdir, "reports", task.Stream+".md")
	if _, err := os.Stat(message); err != nil {
		diagnostics := agentDispatchDiagnostics(t, f, errOut.String(), task.Stream)
		t.Fatalf("ZCode worker message was not written at %s: %v %s", message, err, diagnostics)
	}
	stream, err := store.stream(task.Stream)
	if err != nil || stream.ThreadID != "fixture-thread" {
		t.Fatalf("ZCode session was not persisted: %+v err=%v", stream, err)
	}
	if err := store.transition(stream, SchedulerReady, "test resume", "run resume"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_CHANGED_FILES", "")
	if err := os.WriteFile(f.gitCalls, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_AGENT_CALLS", f.gitCalls)
	t.Setenv("FAKE_GIT_CALLS", f.gitCalls)
	code, err = executeInvocationWithSupervisor(f, []string{"agent", "resume", "--vendor", "zcode", task.Stream, "--state", f.state}, &out, &errOut)
	if code != 0 || err != nil {
		t.Fatalf("ZCode resume exit=%d err=%v stdout=%s stderr=%s", code, err, out.String(), errOut.String())
	}
	calls, err := os.ReadFile(f.launchCalls)
	roundPrompt := filepath.Join(f.state, "sched", "prompts", task.ID+"-round.md")
	resumeSequence, sequenceErr := os.ReadFile(f.gitCalls)
	if err != nil || strings.Count(string(calls), "--vendor zcode") != 1 || !strings.Contains(string(calls), "--prompt-file "+roundPrompt) || !strings.Contains(string(calls), "--message "+message) || sequenceErr != nil || !strings.Contains(string(resumeSequence), "--vendor zcode") || !strings.Contains(string(resumeSequence), "--prompt-file "+roundPrompt) || !strings.Contains(string(resumeSequence), "--session fixture-thread") {
		t.Fatalf("ZCode launch/resume arguments=%q err=%v", calls, err)
	}
	round, err := os.ReadFile(roundPrompt)
	if err != nil || !strings.Contains(string(round), "task for "+task.Stream) || !strings.Contains(string(round), "Definition of done") {
		t.Fatalf("ZCode per-stream task message=%q err=%v", round, err)
	}
	if strings.Index(string(resumeSequence), "status --porcelain") < 0 || strings.Index(string(resumeSequence), "status --porcelain") > strings.Index(string(resumeSequence), "agent start") {
		t.Fatalf("ZCode resume did not snapshot before agent launch: sequence=%q", resumeSequence)
	}
}

// case: S-237.119
func TestAgentReviewDispatchesPersistedReviewTask(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	worker := f.addTask(t, "review-command", "worker")
	review := f.addTask(t, worker.Stream+"-review", "review", worker.ID)
	store := newSchedulerStore(f.state)
	worker.Review = "cross"
	worker.Reviewers = []string{"codex", "codex"}
	if err := store.updateTask(worker); err != nil {
		t.Fatal(err)
	}
	review.Workdir = worker.Workdir
	review.ReviewerKey = "codex-1"
	if err := store.updateTask(review); err != nil {
		t.Fatal(err)
	}
	workerState, err := store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	seedSchedulerWorkerSession(t, store, &workerState, "review-fallback-session")
	workerState.Submission = &SchedulerSubmission{SHA: schedulerTestSHA}
	workerState.ReviewResults = map[string]string{"codex-2": "REJECT"}
	if err := store.writeStreamObserved(workerState); err != nil {
		t.Fatal(err)
	}
	workerState, err = store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(workerState, SchedulerRunning, "agent round", "finish worker"); err != nil {
		t.Fatal(err)
	}
	workerState, err = store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(workerState, SchedulerAwaitingReview, "review task", "run review"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_REVIEW_VERDICT", "REJECT")
	var out, errOut bytes.Buffer
	root := f.invocationRoot()
	root.supervisor = f.supervisor
	code, err := executeRoot(root, []string{"agent", "review", worker.Stream, "--state", f.state}, &out, &errOut)
	if code != 0 || err != nil {
		diagnostics := agentDispatchDiagnostics(t, f, errOut.String(), worker.Stream, review.Stream)
		t.Fatalf("agent review exit=%d err=%v stdout=%s %s", code, err, out.String(), diagnostics)
	}
	calls, err := os.ReadFile(f.launchCalls)
	if err != nil || !strings.Contains(string(calls), "--stream "+review.Stream) {
		diagnostics := agentDispatchDiagnostics(t, f, errOut.String(), worker.Stream, review.Stream)
		t.Fatalf("review task was not dispatched through agent start: calls=%q err=%v %s", calls, err, diagnostics)
	}
	updated, err := store.stream(worker.Stream)
	if err != nil || updated.State != SchedulerReady || updated.RejectRounds != 1 {
		reviewOutcome, reviewErr := store.stream(review.Stream)
		report, readErr := os.ReadFile(testReviewOutputPath(t, f.state, review))
		calls, callsErr := os.ReadFile(f.launchCalls)
		t.Fatalf("review did not schedule rework: stream=%+v err=%v review=%+v reviewErr=%v report=%q readErr=%v calls=%q callsErr=%v", updated, err, reviewOutcome, reviewErr, report, readErr, calls, callsErr)
	}
}

// case: S-237.120
func TestAgentReworkResumesRejectedWorkerThread(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	task := f.addTask(t, "rework-command", "worker")
	store := newSchedulerStore(f.state)
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	stream.ThreadID = "original-thread"
	stream.RejectRounds = 1
	stream.State = SchedulerReady
	if err := store.writeStreamObserved(stream); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	code, err := executeInvocationWithSupervisor(f, []string{"agent", "rework", task.Stream, "--state", f.state}, &out, &errOut)
	if code != 0 || err != nil {
		diagnostics := agentDispatchDiagnostics(t, f, errOut.String(), task.Stream)
		t.Fatalf("agent rework exit=%d err=%v stdout=%s %s", code, err, out.String(), diagnostics)
	}
	calls, err := os.ReadFile(f.launchCalls)
	if err != nil || !strings.Contains(string(calls), "--session original-thread") {
		diagnostics := agentDispatchDiagnostics(t, f, errOut.String(), task.Stream)
		t.Fatalf("rework did not resume original thread: calls=%q err=%v %s", calls, err, diagnostics)
	}
}

// case: S-237.123, S-237.134
func TestLandCreatesOrderedCommitGroupsInNativeGit(t *testing.T) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	repo := t.TempDir()
	t.Setenv("PATH", filepath.Dir(gitPath)+string(os.PathListSeparator)+os.Getenv("PATH"))
	run := func(args ...string) string {
		t.Helper()
		command := exec.Command(gitPath, append([]string{"-C", repo}, args...)...)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %s: %v", args, output, err)
		}
		return strings.TrimSpace(string(output))
	}
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"config", "user.name", "Fixture"}, {"config", "user.email", "fixture@example.test"}} {
		run(args...)
	}
	for name, body := range map[string]string{"base.txt": "base\n"} {
		if err := os.WriteFile(filepath.Join(repo, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	run("add", "-A")
	run("commit", "-m", "chore: base")
	run("checkout", "-b", "agent/land-a")
	for name, body := range map[string]string{"docs/qa/case.md": "case\n", "tools/runner/runner_test.go": "test\n", "tools/runner/runner.go": "code\n"} {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(repo, name)), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(repo, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	verifiedSHA, _, err := snapshotWorktree(filesystemRunnerStateStore{}, repo, "land-a")
	if err != nil {
		t.Fatal(err)
	}
	verifiedTree, err := treeSHAForCommit(repo, verifiedSHA.String())
	if err != nil {
		t.Fatal(err)
	}
	task := SchedulerTask{Stream: "land-a", Workdir: repo}
	expectedOld := run("rev-parse", "HEAD")
	commits := []proposedCommit{{Kind: "case", Subject: "docs(qa): add case"}, {Kind: "tests", Subject: "test(runner): cover case"}, {Kind: "code", Subject: "fix(runner): implement behavior", Body: "details"}}
	object, err := buildLandingObjects(filesystemRunnerStateStore{}, repo, task.Stream, verifiedTree.String(), expectedOld, commits, t.TempDir(), "kb-runner land land-a --state /tmp/state")
	if err != nil {
		t.Fatal(err)
	}
	if err := moveLandingRef(filesystemRunnerStateStore{}, repo, task.Stream, object, expectedOld); err != nil {
		t.Fatal(err)
	}
	if err := refreshLandingWorktree(filesystemRunnerStateStore{}, repo, repo, object.CommitSHA.String()); err != nil {
		t.Fatal(err)
	}
	log := run("log", "-3", "--format=%s")
	want := "fix(runner): implement behavior\ntest(runner): cover case\ndocs(qa): add case"
	if log != want {
		t.Fatalf("commit order newest-first=%q want %q", log, want)
	}
	committedTree, err := treeSHAForCommit(repo, run("rev-parse", "HEAD"))
	if err != nil || committedTree != verifiedTree {
		t.Fatalf("grouped commits tree=%s want verified tree=%s err=%v", committedTree, verifiedTree, err)
	}
}

// case: S-237.123
func TestLandCommandRequiresPassingRemoteAndAcceptedReview(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	f.addTask(t, "land-gate", "worker")
	var out, errOut bytes.Buffer
	status := executeInvocation("kb-runner", []string{"land", "land-gate", "--state", f.state}, &out, &errOut)
	if status.Code() != 2 || !strings.Contains(errOut.String(), "requires accepted review and a passing latest remote verdict") {
		t.Fatalf("land readiness gate exit=%d stdout=%s stderr=%s", status.Code(), out.String(), errOut.String())
	}
}

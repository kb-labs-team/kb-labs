package cache

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	command := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"}, args...)...)
	command.Dir = dir
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
}

// case: S-179.45
func TestSharedRootIsOneStoreForEveryWorktreeOfARepository(t *testing.T) {
	t.Setenv(ciSharedRootOverrideEnv, "")
	base := t.TempDir()
	main := filepath.Join(base, "main")
	if err := os.MkdirAll(main, 0o755); err != nil {
		t.Fatal(err)
	}
	gitIn(t, main, "init", "-q")
	gitIn(t, main, "commit", "-q", "--allow-empty", "-m", "init")
	second := filepath.Join(base, "second")
	gitIn(t, main, "worktree", "add", "-q", second, "-b", "second")

	fromMain, err := SharedRoot(main)
	if err != nil {
		t.Fatal(err)
	}
	fromSecond, err := SharedRoot(second)
	if err != nil {
		t.Fatal(err)
	}
	if fromMain != fromSecond {
		t.Fatalf("worktrees resolve different stores: %s != %s", fromMain, fromSecond)
	}
	if want := filepath.Join(main, ".git", SharedDirName); fromMain != want {
		t.Fatalf("shared store = %s, want %s inside the git common directory", fromMain, want)
	}
}

func TestSharedRootOfAWorkspaceNestedInAnotherRepositoryStaysInsideTheWorkspace(t *testing.T) {
	t.Setenv(ciSharedRootOverrideEnv, "")
	outer := t.TempDir()
	gitIn(t, outer, "init", "-q")
	nested := filepath.Join(outer, "fixture")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	root, err := SharedRoot(nested)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(nested, ".kb", "devkit", "shared"); root != want {
		t.Fatalf("shared store = %s, want %s: a nested workspace must not write into the outer repository's git directory", root, want)
	}
}

func setCISharedRoot(t *testing.T, runnerTemp string) string {
	t.Helper()
	store := filepath.Join(runnerTemp, "kb-devkit-cas")
	t.Setenv("RUNNER_TEMP", runnerTemp)
	t.Setenv(ciSharedRootOverrideEnv, store)
	return store
}

func TestSharedRootUsesOnlyRunnerTempCIOverride(t *testing.T) {
	runnerTemp := t.TempDir()
	setCISharedRoot(t, runnerTemp)
	got, err := SharedRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	resolvedTemp, err := filepath.EvalSymlinks(runnerTemp)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(resolvedTemp, "kb-devkit-cas"); got != want {
		t.Fatalf("shared root = %s, want trusted runner-temp path %s", got, want)
	}
}

func TestSharedRootRejectsCIOverrideOutsideRunnerTemp(t *testing.T) {
	runnerTemp := t.TempDir()
	t.Setenv("RUNNER_TEMP", runnerTemp)
	t.Setenv(ciSharedRootOverrideEnv, t.TempDir())

	if _, err := SharedRoot(t.TempDir()); err == nil || !strings.Contains(err.Error(), "must stay inside RUNNER_TEMP") {
		t.Fatalf("SharedRoot error = %v, want a runner-temp-bound path error", err)
	}
}

func TestSharedRootRejectsSymlinkInCASPathComponents(t *testing.T) {
	runnerTemp := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(runnerTemp, "linked")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RUNNER_TEMP", runnerTemp)
	t.Setenv(ciSharedRootOverrideEnv, filepath.Join(runnerTemp, "linked", "cas"))

	if _, err := SharedRoot(t.TempDir()); err == nil || !strings.Contains(err.Error(), "path contains a symlink") {
		t.Fatalf("SharedRoot error = %v, want a symlink-path error", err)
	}
}

func TestSharedRootRejectsRecursiveSymlinksFromRestoredCache(t *testing.T) {
	runnerTemp := t.TempDir()
	store := setCISharedRoot(t, runnerTemp)
	if err := os.MkdirAll(filepath.Join(store, "objects"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(store, "objects", "poisoned")); err != nil {
		t.Fatal(err)
	}

	if _, err := SharedRoot(t.TempDir()); err == nil || !strings.Contains(err.Error(), "store contains a symlink") {
		t.Fatalf("SharedRoot error = %v, want a recursive restored-cache symlink error", err)
	}
}

func TestSharedRootRejectsWorkspaceTaskStateSymlinks(t *testing.T) {
	workspace := t.TempDir()
	runnerTemp := t.TempDir()
	setCISharedRoot(t, runnerTemp)
	devkitState := filepath.Join(workspace, ".kb", "devkit", "state")
	if err := os.MkdirAll(filepath.Dir(devkitState), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), devkitState); err != nil {
		t.Fatal(err)
	}

	if _, err := SharedRoot(workspace); err == nil || !strings.Contains(err.Error(), "workspace devkit state") {
		t.Fatalf("SharedRoot error = %v, want a workspace task-state symlink error", err)
	}
}

func TestSharedRootRejectsSymlinkedWorkspaceStateParent(t *testing.T) {
	workspace := t.TempDir()
	runnerTemp := t.TempDir()
	setCISharedRoot(t, runnerTemp)
	if err := os.Symlink(t.TempDir(), filepath.Join(workspace, ".kb")); err != nil {
		t.Fatal(err)
	}

	if _, err := SharedRoot(workspace); err == nil || !strings.Contains(err.Error(), "workspace devkit state path") {
		t.Fatalf("SharedRoot error = %v, want an ancestor-symlink error", err)
	}
}

func TestRestoredFilesCannotMutateTheSharedStore(t *testing.T) {
	root := filepath.Join(t.TempDir(), "shared")
	store, err := NewLocalStore(root)
	if err != nil {
		t.Fatal(err)
	}
	sha, err := store.Put(strings.NewReader("immutable"))
	if err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "out.txt")
	if err := store.RestoreFile(sha, dest, 0o644); err != nil {
		t.Fatal(err)
	}
	// A later build rewrites its restored output in place.
	file, err := os.OpenFile(dest, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("rewritten by a later build"); err != nil {
		t.Fatal(err)
	}
	file.Close()
	problems, err := Verify(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(problems) != 0 {
		t.Fatalf("store changed through a restored file: %v", problems)
	}
	stored, _ := os.ReadFile(filepath.Join(root, "objects", sha[:2], sha[2:]))
	if string(stored) != "immutable" {
		t.Fatalf("stored object = %q, want immutable", stored)
	}
}

func TestVerifyReportsCorruptObjectsAndDanglingManifests(t *testing.T) {
	root := filepath.Join(t.TempDir(), "shared")
	store, err := NewLocalStore(root)
	if err != nil {
		t.Fatal(err)
	}
	sha, err := store.Put(strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	mode := uint32(0o644)
	manifests := NewManifestStore(root)
	if err := manifests.Put("@fixture/a", "build", &Manifest{InputHash: "h1", Outputs: []OutputRef{{Path: "out", Object: sha, Mode: &mode}}}); err != nil {
		t.Fatal(err)
	}
	if problems, err := Verify(root); err != nil || len(problems) != 0 {
		t.Fatalf("healthy store: problems=%v err=%v", problems, err)
	}
	if err := os.WriteFile(filepath.Join(root, "objects", sha[:2], sha[2:]), []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := manifests.Put("@fixture/a", "build", &Manifest{InputHash: "h2", Outputs: []OutputRef{{Path: "out", Object: strings.Repeat("ab", 32), Mode: &mode}}}); err != nil {
		t.Fatal(err)
	}
	problems, err := Verify(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(problems) != 2 {
		t.Fatalf("problems = %v, want the corrupt object and the dangling reference", problems)
	}
}

// case: S-179.46
func TestManifestPutIsAtomicUnderConcurrentWriters(t *testing.T) {
	root := t.TempDir()
	manifests := NewManifestStore(root)
	mode := uint32(0o644)
	outputs := make([]OutputRef, 4000)
	for i := range outputs {
		outputs[i] = OutputRef{Path: fmt.Sprintf("dist/file-%d.js", i), Object: strings.Repeat("ab", 32), Mode: &mode}
	}
	manifest := &Manifest{InputHash: "same-key", Outputs: outputs}
	if err := manifests.Put("@fixture/a", "build", manifest); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	stop := make(chan struct{})
	torn := make(chan string, 1)
	for reader := 0; reader < 4; reader++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				if got, ok := manifests.Get("@fixture/a", "build", "same-key"); !ok || len(got.Outputs) != len(outputs) {
					select {
					case torn <- "reader saw a missing or partial manifest while writers rewrote the same key":
					default:
					}
					return
				}
			}
		}()
	}
	var writers sync.WaitGroup
	for writer := 0; writer < 4; writer++ {
		writers.Add(1)
		go func() {
			defer writers.Done()
			for i := 0; i < 40; i++ {
				if err := manifests.Put("@fixture/a", "build", manifest); err != nil {
					select {
					case torn <- err.Error():
					default:
					}
					return
				}
			}
		}()
	}
	writers.Wait()
	close(stop)
	wg.Wait()
	select {
	case message := <-torn:
		t.Fatal(message)
	default:
	}
}

func TestIdenticalObjectsWrittenConcurrentlyLeaveOneIntactObject(t *testing.T) {
	root := filepath.Join(t.TempDir(), "shared")
	store, err := NewLocalStore(root)
	if err != nil {
		t.Fatal(err)
	}
	payload := strings.Repeat("content-addressed ", 100000)
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for writer := 0; writer < 8; writer++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := store.Put(strings.NewReader(payload)); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if problems, err := Verify(root); err != nil || len(problems) != 0 {
		t.Fatalf("problems=%v err=%v", problems, err)
	}
	usage, err := Describe(root)
	if err != nil || usage.Objects != 1 {
		t.Fatalf("usage=%+v err=%v, want exactly one object", usage, err)
	}
}

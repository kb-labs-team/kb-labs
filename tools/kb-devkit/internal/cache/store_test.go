package cache

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalStorePutGetAndRestoreFile(t *testing.T) {
	store, err := NewLocalStore(filepath.Join(t.TempDir(), ".kb", "devkit"))
	if err != nil {
		t.Fatalf("NewLocalStore error: %v", err)
	}

	sha, err := store.Put(strings.NewReader("hello world"))
	if err != nil {
		t.Fatalf("Put error: %v", err)
	}
	if !store.Has(sha) {
		t.Fatalf("Has(%q) = false, want true", sha)
	}

	r, err := store.Get(sha)
	if err != nil {
		t.Fatalf("Get error: %v", err)
	}
	data, err := io.ReadAll(r)
	r.Close()
	if err != nil {
		t.Fatalf("ReadAll error: %v", err)
	}
	if string(data) != "hello world" {
		t.Fatalf("stored content = %q, want hello world", data)
	}

	restorePath := filepath.Join(t.TempDir(), "restored", "artifact.txt")
	if err := store.RestoreFile(sha, restorePath, 0o644); err != nil {
		t.Fatalf("RestoreFile error: %v", err)
	}
	restored, err := os.ReadFile(restorePath)
	if err != nil {
		t.Fatalf("read restored file: %v", err)
	}
	if string(restored) != "hello world" {
		t.Fatalf("restored content = %q, want hello world", restored)
	}
}

func TestLocalStoreDeduplicatesAndPutFile(t *testing.T) {
	storeRoot := filepath.Join(t.TempDir(), ".kb", "devkit")
	store, err := NewLocalStore(storeRoot)
	if err != nil {
		t.Fatalf("NewLocalStore error: %v", err)
	}

	input := filepath.Join(t.TempDir(), "input.txt")
	if err := os.WriteFile(input, []byte("same content"), 0o644); err != nil {
		t.Fatalf("write input: %v", err)
	}

	sha1, err := store.PutFile(input)
	if err != nil {
		t.Fatalf("PutFile error: %v", err)
	}
	sha2, err := store.Put(strings.NewReader("same content"))
	if err != nil {
		t.Fatalf("Put error: %v", err)
	}
	if sha1 != sha2 {
		t.Fatalf("dedupe sha mismatch: %q vs %q", sha1, sha2)
	}

	objectDir := filepath.Join(storeRoot, "objects", sha1[:2])
	entries, err := os.ReadDir(objectDir)
	if err != nil {
		t.Fatalf("ReadDir error: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("objects count = %d, want 1", len(entries))
	}
}

func TestHashInputsIsDeterministicAndSkipsIgnoredDirs(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "src", "a.ts"), "export const a = 1\n")
	mustWriteFile(t, filepath.Join(root, "src", "b.ts"), "export const b = 2\n")
	mustWriteFile(t, filepath.Join(root, "node_modules", "leftpad", "index.js"), "ignored\n")
	mustWriteFile(t, filepath.Join(root, ".git", "HEAD"), "ignored\n")

	hash1, err := HashInputs(root, nil, []string{"src/**/*.ts", "src/*.ts"})
	if err != nil {
		t.Fatalf("HashInputs error: %v", err)
	}
	hash2, err := HashInputs(root, nil, []string{"src/*.ts", "src/**/*.ts"})
	if err != nil {
		t.Fatalf("HashInputs error: %v", err)
	}
	if hash1 != hash2 {
		t.Fatalf("hashes differ for same logical inputs: %q vs %q", hash1, hash2)
	}

	mustWriteFile(t, filepath.Join(root, "node_modules", "leftpad", "index.js"), "changed but ignored\n")
	hash3, err := HashInputs(root, nil, []string{"src/**/*.ts", "src/*.ts"})
	if err != nil {
		t.Fatalf("HashInputs error: %v", err)
	}
	if hash1 != hash3 {
		t.Fatalf("ignored dir changed hash: %q vs %q", hash1, hash3)
	}
}

func TestHashLocalInputsSkipsGeneratedDistUnlessExplicitlyDeclared(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "src", "index.ts"), "export const value = 1\n")
	mustWriteFile(t, filepath.Join(root, "dist", "generated.ts"), "generated v1\n")

	broadBefore, err := HashLocalInputs(root, []string{"**"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	mustWriteFile(t, filepath.Join(root, "dist", "generated.ts"), "generated v2\n")
	broadAfter, err := HashLocalInputs(root, []string{"**"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if broadBefore != broadAfter {
		t.Fatal("broad local glob included dist output; want generated output excluded by default")
	}
	explicitBefore, err := HashLocalInputs(root, []string{"dist/**"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	mustWriteFile(t, filepath.Join(root, "dist", "generated.ts"), "generated v3\n")
	explicitAfter, err := HashLocalInputs(root, []string{"dist/**"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if explicitBefore == explicitAfter {
		t.Fatal("explicit dist input did not change its hash")
	}
}

func TestHashLocalInputsIncludesExplicitHiddenAndCoveragePaths(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "nested", ".config", "app", "settings.json"), "one\n")
	mustWriteFile(t, filepath.Join(root, "nested", "coverage", "report.json"), "one\n")
	for _, pattern := range []string{"**/.config/**", "**/coverage/**"} {
		before, err := HashLocalInputs(root, []string{pattern}, nil)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(root, filepath.FromSlash(strings.TrimSuffix(pattern, "**")))
		if strings.Contains(pattern, ".config") {
			path = filepath.Join(root, "nested", ".config", "app", "settings.json")
		} else {
			path = filepath.Join(root, "nested", "coverage", "report.json")
		}
		mustWriteFile(t, path, "two\n")
		after, err := HashLocalInputs(root, []string{pattern}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if before == after {
			t.Fatalf("explicit input pattern %q did not include its file", pattern)
		}
	}
}

func TestHashLocalInputsUsesGitModeForTrackedFiles(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "src", "tracked.ts")
	mustWriteFile(t, path, "same contents\n")
	tracked := map[string]TrackedFile{filepath.Clean(path): {Mode: 0100644}}
	before, err := HashLocalInputsWithTrackedMetadata(root, tracked, []string{"src/**"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o755); err != nil {
		t.Fatal(err)
	}
	after, err := HashLocalInputsWithTrackedMetadata(root, tracked, []string{"src/**"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("tracked local input hash changed with checkout permissions; want Git index mode")
	}
}

func TestHashLocalInputsNormalizesEmptyAndExcludesOwnOutput(t *testing.T) {
	root := t.TempDir()
	before, err := HashLocalInputs(root, []string{"dist/generated.txt"}, []string{"dist/generated.txt"})
	if err != nil {
		t.Fatal(err)
	}
	mustWriteFile(t, filepath.Join(root, "dist", "generated.txt"), "created output\n")
	after, err := HashLocalInputs(root, []string{"dist/generated.txt"}, []string{"dist/generated.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if before != after || before != "" {
		t.Fatalf("hash before=%q after=%q; own output must stay absent from inputs", before, after)
	}
	trackedOutput, err := HashUntrackedInputs(root, nil, []string{"dist/generated.txt"}, []string{"dist/generated.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if trackedOutput != "" {
		t.Fatalf("untracked hash of excluded output = %q, want empty", trackedOutput)
	}
}

func TestHashUntrackedInputsExcludingDoesNotWalkNestedPackages(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("permission-denied traversal is not observable when running as root")
	}
	root := t.TempDir()
	child := filepath.Join(root, "packages", "child")
	mustWriteFile(t, filepath.Join(child, "src", "owned.ts"), "child-owned source\n")
	if err := os.Chmod(child, 0); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(child, 0o755)

	if _, err := HashUntrackedInputsExcluding(root, nil, []string{"**"}, nil, []string{child}); err != nil {
		t.Fatalf("hashing aggregate inputs traversed excluded nested package: %v", err)
	}
}

func TestHashLocalInputsIncludesExplicitNestedDist(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "vendor", "dist", "generated.js")
	mustWriteFile(t, file, "one\n")
	before, err := HashLocalInputs(root, []string{"vendor/dist/**"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	mustWriteFile(t, file, "two\n")
	after, err := HashLocalInputs(root, []string{"vendor/dist/**"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if before == after {
		t.Fatal("explicit nested dist input did not affect local hash")
	}
}

func TestHashDependencyInputsTracksGeneratedOutputMode(t *testing.T) {
	root := t.TempDir()
	output := filepath.Join(root, "dist", "helper")
	mustWriteFile(t, output, "same bytes\n")
	input := DependencyInput{Package: "@fixture/a", Task: "generate", Dir: root, Outputs: []string{"dist/helper"}}
	before, err := HashDependencyInputs(t.TempDir(), []DependencyInput{input})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(output, 0o755); err != nil {
		t.Fatal(err)
	}
	after, err := HashDependencyInputs(t.TempDir(), []DependencyInput{input})
	if err != nil {
		t.Fatal(err)
	}
	if before == after {
		t.Fatal("generated output mode change did not affect dependent input hash")
	}
}

func TestHashDependencyInputsSkipsWorkspacePrefixedPrerequisiteInputs(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "upstream.txt"), "one\n")
	mustWriteFile(t, filepath.Join(root, "dist", "helper"), "generated\n")
	input := DependencyInput{Package: "@fixture/a", Task: "generate", Dir: root, Inputs: []string{"^upstream.txt"}, Outputs: []string{"dist/helper"}}
	before, err := HashDependencyInputs(t.TempDir(), []DependencyInput{input})
	if err != nil {
		t.Fatal(err)
	}
	mustWriteFile(t, filepath.Join(root, "upstream.txt"), "two\n")
	after, err := HashDependencyInputs(t.TempDir(), []DependencyInput{input})
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("producer workspace-prefixed input was hashed as producer-local content")
	}
}

func TestHashInputsWithFingerprintPartitionsTaskSemantics(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "src", "index.ts"), "export const value = 1\n")

	first, err := HashInputsWithFingerprint(root, nil, []string{"src/**"}, "command=tsup")
	if err != nil {
		t.Fatalf("HashInputsWithFingerprint error: %v", err)
	}
	second, err := HashInputsWithFingerprint(root, nil, []string{"src/**"}, "command=pnpm build")
	if err != nil {
		t.Fatalf("HashInputsWithFingerprint error: %v", err)
	}
	if first == second {
		t.Fatal("task fingerprints must partition identical file inputs")
	}
}

func TestHashInputsDepPatternInvalidatesOnDepChange(t *testing.T) {
	pkgDir := t.TempDir()
	dep1Dir := t.TempDir()
	dep2Dir := t.TempDir()

	mustWriteFile(t, filepath.Join(pkgDir, "src", "index.ts"), "export {}\n")
	mustWriteFile(t, filepath.Join(dep1Dir, "dist", "index.js"), "v1\n")
	mustWriteFile(t, filepath.Join(dep2Dir, "dist", "index.js"), "v1\n")

	depDirs := []string{dep1Dir, dep2Dir}

	hash1, err := HashInputs(pkgDir, depDirs, []string{"src/**", "^dist/**"})
	if err != nil {
		t.Fatalf("HashInputs error: %v", err)
	}

	// Change a dep output — hash must change.
	mustWriteFile(t, filepath.Join(dep1Dir, "dist", "index.js"), "v2\n")

	hash2, err := HashInputs(pkgDir, depDirs, []string{"src/**", "^dist/**"})
	if err != nil {
		t.Fatalf("HashInputs error: %v", err)
	}
	if hash1 == hash2 {
		t.Fatal("hash unchanged after dep output change, want different")
	}

	// Changing local src — hash must also change.
	mustWriteFile(t, filepath.Join(pkgDir, "src", "index.ts"), "export { x }\n")

	hash3, err := HashInputs(pkgDir, depDirs, []string{"src/**", "^dist/**"})
	if err != nil {
		t.Fatalf("HashInputs error: %v", err)
	}
	if hash2 == hash3 {
		t.Fatal("hash unchanged after local src change, want different")
	}
}

func TestHashInputsDepPatternWithNilDepDirsIsNoop(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "src", "a.ts"), "export const a = 1\n")

	// "^dist/**" with nil depDirs should match nothing — hash equals local-only hash.
	hashWithDep, err := HashInputs(root, nil, []string{"src/**", "^dist/**"})
	if err != nil {
		t.Fatalf("HashInputs error: %v", err)
	}
	hashLocalOnly, err := HashInputs(root, nil, []string{"src/**"})
	if err != nil {
		t.Fatalf("HashInputs error: %v", err)
	}
	if hashWithDep != hashLocalOnly {
		t.Fatal("nil depDirs: ^dist/** should contribute nothing, hashes must match")
	}
}

func TestHashInputsWithOwnershipTracksPackageAndDependencyDigests(t *testing.T) {
	root := t.TempDir()
	packageInput := filepath.Join(root, "packages", "lib", "tests", "input.test.ts")
	dependencyInput := filepath.Join(root, "packages", "base", "tsconfig.base.json")
	mustWriteFile(t, packageInput, "expect(true).toBe(true)\n")
	mustWriteFile(t, dependencyInput, `{"compilerOptions":{"strict":true}}`)
	own, err := ContentDigest(root, []string{packageInput}, testTrackedFiles(packageInput))
	if err != nil {
		t.Fatal(err)
	}
	dep, err := ContentDigest(root, []string{dependencyInput}, testTrackedFiles(dependencyInput))
	if err != nil {
		t.Fatal(err)
	}
	first, err := HashInputsWithOwnership(root, nil, nil, "test-task", "global", own, CombineContentDigests(map[string]string{"@fixture/base": dep}))
	if err != nil {
		t.Fatal(err)
	}
	mustWriteFile(t, packageInput, "expect(false).toBe(true)\n")
	own, err = ContentDigest(root, []string{packageInput}, testTrackedFiles(packageInput))
	if err != nil {
		t.Fatal(err)
	}
	second, err := HashInputsWithOwnership(root, nil, nil, "test-task", "global", own, CombineContentDigests(map[string]string{"@fixture/base": dep}))
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("task hash unchanged after package-owned test file changed")
	}
	mustWriteFile(t, dependencyInput, `{"compilerOptions":{"strict":false}}`)
	dep, err = ContentDigest(root, []string{dependencyInput}, testTrackedFiles(dependencyInput))
	if err != nil {
		t.Fatal(err)
	}
	third, err := HashInputsWithOwnership(root, nil, nil, "test-task", "global", own, CombineContentDigests(map[string]string{"@fixture/base": dep}))
	if err != nil {
		t.Fatal(err)
	}
	if second == third {
		t.Fatal("task hash unchanged after workspace dependency digest changed")
	}
}

func TestContentDigestTracksProvidedContentOnly(t *testing.T) {
	root := t.TempDir()
	lockfile := filepath.Join(root, "pnpm-lock.yaml")
	untracked := filepath.Join(root, "untracked.txt")
	mustWriteFile(t, lockfile, "lockfileVersion: 9\n")
	mustWriteFile(t, untracked, "first\n")

	first, err := ContentDigest(root, []string{lockfile}, testTrackedFiles(lockfile))
	if err != nil {
		t.Fatalf("global input digest: %v", err)
	}
	mustWriteFile(t, untracked, "second\n")
	second, err := ContentDigest(root, []string{lockfile}, testTrackedFiles(lockfile))
	if err != nil {
		t.Fatalf("global input digest after untracked change: %v", err)
	}
	if first != second {
		t.Fatal("global digest changed when only an untracked path changed")
	}
	mustWriteFile(t, lockfile, "lockfileVersion: 9\n# tracked edit\n")
	third, err := ContentDigest(root, []string{lockfile}, testTrackedFiles(lockfile))
	if err != nil {
		t.Fatalf("global input digest after tracked content change: %v", err)
	}
	if second == third {
		t.Fatal("global digest unchanged after tracked lockfile content changed")
	}
}

func TestContentDigestFramesRecordsWithoutNULCollisions(t *testing.T) {
	root := t.TempDir()
	singlePath := filepath.Join(root, "a")
	if err := os.WriteFile(singlePath, []byte{'x', 0, 'b', 0, '1', '0', '0', '6', '4', '4', 0, 'y'}, 0o644); err != nil {
		t.Fatal(err)
	}
	single, err := ContentDigest(root, []string{singlePath}, testTrackedFiles(singlePath))
	if err != nil {
		t.Fatalf("digest single-file collision fixture: %v", err)
	}

	pairRoot := t.TempDir()
	pathA := filepath.Join(pairRoot, "a")
	pathB := filepath.Join(pairRoot, "b")
	mustWriteFile(t, pathA, "x")
	mustWriteFile(t, pathB, "y")
	pair, err := ContentDigest(pairRoot, []string{pathA, pathB}, testTrackedFiles(pathA, pathB))
	if err != nil {
		t.Fatalf("digest two-file collision fixture: %v", err)
	}
	if single == pair {
		t.Fatalf("different tracked-file sets produced the same digest %s", single)
	}
}

func testTrackedFiles(paths ...string) map[string]TrackedFile {
	tracked := make(map[string]TrackedFile, len(paths))
	for _, path := range paths {
		tracked[filepath.Clean(path)] = TrackedFile{Mode: 0100644, ObjectID: "fixture-object"}
	}
	return tracked
}

func mustWriteFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

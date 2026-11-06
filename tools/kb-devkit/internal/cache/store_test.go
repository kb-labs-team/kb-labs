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

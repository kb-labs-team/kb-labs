package engine

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/kb-labs/devkit/internal/cache"
	"github.com/kb-labs/devkit/internal/workspace"
)

// The cache store is shared by every worktree, so an entry written by one
// devkit is selected by every other devkit that computes the same key. The
// runtime fingerprint covers cache.FormatVersion instead of the devkit
// executable, which is only sound if a change to how keys are computed is
// always accompanied by a FormatVersion bump. This test pins one key per
// FormatVersion: changing the input-hash algorithm without bumping the version
// fails here, and bumping the version requires recording its new key.
// case: S-179.45
func TestInputHashIsPinnedPerCacheFormatVersion(t *testing.T) {
	root := t.TempDir()
	pkgDir := filepath.Join(root, "pkg")
	if err := os.MkdirAll(filepath.Join(pkgDir, "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	pkg := workspace.Package{Name: "@fixture/pinned", Dir: pkgDir, RelPath: "pkg"}
	def := TaskDef{Name: "build", Command: "tsup", Inputs: []string{"src/**", "^dist/**"}, Outputs: []string{"dist/**"}, Deps: []string{"^build"}, Cache: true}

	key, err := hashTaskInputs(pkg, def, nil, "fingerprint", "global-digest", "owned-digest", "dependency-digest")
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join("testdata", "input-hash-golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var golden map[string]string
	if err := json.Unmarshal(data, &golden); err != nil {
		t.Fatal(err)
	}
	want, ok := golden[cache.FormatVersion]
	if !ok {
		t.Fatalf("testdata/input-hash-golden.json has no entry for %s; record %q for it", cache.FormatVersion, key)
	}
	if key != want {
		t.Fatalf("input hash for %s changed (%s, pinned %s): bump cache.FormatVersion and record the new key, or the shared store will serve entries computed by the old algorithm", cache.FormatVersion, key, want)
	}
}

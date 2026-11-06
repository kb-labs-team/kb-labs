package checks

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/kb-labs/devkit/internal/workspace"
)

func TestDetectCircularIncludesEveryWorkspaceDependencyKind(t *testing.T) {
	dependencyKinds := []string{"dependencies", "devDependencies", "optionalDependencies", "peerDependencies"}
	for _, dependencyKind := range dependencyKinds {
		t.Run(dependencyKind, func(t *testing.T) {
			root := t.TempDir()
			leftDir := filepath.Join(root, "left")
			rightDir := filepath.Join(root, "right")
			writeCircularPackage(t, leftDir, "@kb-labs/left", map[string]map[string]string{
				dependencyKind: {"@kb-labs/right": "workspace:*"},
			})
			writeCircularPackage(t, rightDir, "@kb-labs/right", map[string]map[string]string{
				"dependencies": {"@kb-labs/left": "workspace:*"},
			})

			packages := []workspace.Package{
				{Name: "@kb-labs/left", Dir: leftDir},
				{Name: "@kb-labs/right", Dir: rightDir},
			}
			result := DetectCircular(packages)
			if len(result[leftDir]) == 0 || len(result[rightDir]) == 0 {
				t.Fatalf("circular results = %#v, want both packages reported for %s cycle", result, dependencyKind)
			}
		})
	}
}

func writeCircularPackage(t *testing.T, dir, name string, dependencyGroups map[string]map[string]string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir package: %v", err)
	}
	manifest := map[string]any{"name": name}
	for key, value := range dependencyGroups {
		manifest[key] = value
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal package: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), data, 0o644); err != nil {
		t.Fatalf("write package.json: %v", err)
	}
}

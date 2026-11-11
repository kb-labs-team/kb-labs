// Package testworkspace marks tests that require the repository workspace.
package testworkspace

import (
	"os"
	"path/filepath"
	"testing"
)

// Require verifies a test is running within the KB Labs workspace and marks
// its package as unsuitable for the isolated deterministic V2 shards.
func Require(t testing.TB) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("find workspace for test precondition: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "pnpm-workspace.yaml")); err == nil {
			if _, err := os.Stat(filepath.Join(dir, "tools", "kb-create", "go.mod")); err == nil {
				return dir
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("test requires the KB Labs workspace root")
		}
		dir = parent
	}
}

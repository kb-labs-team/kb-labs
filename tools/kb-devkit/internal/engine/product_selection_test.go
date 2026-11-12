package engine

import (
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"github.com/kb-labs/devkit/internal/config"
)

// case: S-179.48
func TestDefaultSelectionLeavesProductAppBuildsOutUnlessTargeted(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*", "sites/*"})
	writePkg(t, filepath.Join(root, "packages", "lib"), `{"name":"@fixture/lib"}`)
	writePkg(t, filepath.Join(root, "sites", "marketing"), `{"name":"@fixture/marketing","dependencies":{"@fixture/lib":"workspace:*"}}`)
	writeEngineFile(t, filepath.Join(root, "packages", "lib", "src", "index.ts"), "export {}\n")
	notDefault := false
	cfg := testConfig([]config.NamedCategory{
		{Name: "lib", Category: config.CategoryConfig{Match: []string{"packages/lib"}, Preset: "node-lib"}},
		{Name: "site", Category: config.CategoryConfig{Match: []string{"sites/*"}, Preset: "node-lib", DefaultBuild: &notDefault}},
	})
	cfg.Tasks = map[string]config.TaskConfig{
		"build": {{Command: "true", Inputs: []string{"src/**", "package.json"}, Deps: []string{"^build"}}},
		"lint":  {{Command: "true", Inputs: []string{"src/**"}}},
	}
	ws := mustWorkspace(t, root, cfg)
	run := func(opts RunOptions) (RunResult, []string) {
		t.Helper()
		opts.WSRoot, opts.CacheRoot, opts.Concurrency = root, filepath.Join(root, ".kb", "devkit"), 1
		result, err := Run(ws, cfg, opts)
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		var ran []string
		for _, r := range result.Results {
			ran = append(ran, r.Package+":"+r.Task)
		}
		sort.Strings(ran)
		return result, ran
	}

	result, ran := run(RunOptions{Tasks: []string{"build"}, DefaultSelection: true})
	if want := []string{"@fixture/lib:build"}; !reflect.DeepEqual(ran, want) {
		t.Fatalf("plain build ran %v, want %v", ran, want)
	}
	if want := []string{"@fixture/marketing"}; !reflect.DeepEqual(result.SkippedBuilds, want) {
		t.Fatalf("skipped = %v, want %v (never silent)", result.SkippedBuilds, want)
	}

	// Only the build task is left out: the product app is still linted.
	_, ran = run(RunOptions{Tasks: []string{"build", "lint"}, DefaultSelection: true})
	if want := []string{"@fixture/lib:build", "@fixture/lib:lint", "@fixture/marketing:lint"}; !reflect.DeepEqual(ran, want) {
		t.Fatalf("plain build+lint ran %v, want %v", ran, want)
	}

	// Targeting the package (not a default selection) builds it.
	targeted, ran := run(RunOptions{Tasks: []string{"build"}, Packages: ws.FilterByName([]string{"@fixture/marketing"})})
	if want := []string{"@fixture/lib:build", "@fixture/marketing:build"}; !reflect.DeepEqual(ran, want) {
		t.Fatalf("targeted build ran %v, want %v", ran, want)
	}
	if len(targeted.SkippedBuilds) != 0 {
		t.Fatalf("targeted build reported skips: %v", targeted.SkippedBuilds)
	}
}

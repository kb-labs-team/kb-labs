package shardrail

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

const workspacePreconditionImport = "github.com/kb-labs/create/v2/testworkspace"

type workflow struct {
	Jobs map[string]struct {
		Strategy struct {
			Matrix struct {
				Include []struct {
					Shard    string `yaml:"shard"`
					Packages string `yaml:"packages"`
				} `yaml:"include"`
			} `yaml:"matrix"`
		} `yaml:"strategy"`
	} `yaml:"jobs"`
}

func TestV2ShardMatrixMatchesAndExcludesWorkspacePreconditions(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate shard rail source")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	moduleRoot := filepath.Join(repoRoot, "tools", "kb-create")
	pr := readShardMatrix(t, filepath.Join(repoRoot, ".github", "workflows", "ci-pr.yml"))
	main := readShardMatrix(t, filepath.Join(repoRoot, ".github", "workflows", "ci.yml"))
	if strings.Join(pr, "\n") != strings.Join(main, "\n") {
		t.Fatalf("V2 shard matrices differ:\nci-pr.yml: %q\nci.yml: %q", pr, main)
	}

	for _, entry := range pr {
		fields := strings.SplitN(entry, "\t", 2)
		if len(fields) != 2 {
			t.Fatalf("invalid parsed shard entry %q", entry)
		}
		for _, pattern := range strings.Fields(fields[1]) {
			for _, pkgDir := range packageDirs(t, moduleRoot, pattern) {
				if importsWorkspacePrecondition(t, pkgDir) {
					rel, err := filepath.Rel(moduleRoot, pkgDir)
					if err != nil {
						t.Fatal(err)
					}
					t.Errorf("V2 shard %q includes workspace-dependent test package ./%s", fields[0], filepath.ToSlash(rel))
				}
			}
		}
	}
}

func readShardMatrix(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var parsed workflow
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	var entries []string
	job, ok := parsed.Jobs["launcher-v2-contracts"]
	if !ok {
		t.Fatalf("%s has no launcher-v2-contracts job", path)
	}
	for _, item := range job.Strategy.Matrix.Include {
		if item.Shard != "" || item.Packages != "" {
			entries = append(entries, item.Shard+"\t"+item.Packages)
		}
	}
	if len(entries) == 0 {
		t.Fatalf("%s has no parsed V2 shard matrix", path)
	}
	return entries
}

func packageDirs(t *testing.T, moduleRoot, pattern string) []string {
	t.Helper()
	clean := strings.TrimPrefix(pattern, "./")
	if !strings.HasSuffix(clean, "/...") {
		return []string{filepath.Join(moduleRoot, filepath.FromSlash(clean))}
	}
	root := filepath.Join(moduleRoot, filepath.FromSlash(strings.TrimSuffix(clean, "/...")))
	var dirs []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			return nil
		}
		files, err := filepath.Glob(filepath.Join(path, "*_test.go"))
		if err != nil {
			return err
		}
		if len(files) > 0 {
			dirs = append(dirs, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("expand Go package pattern %q: %v", pattern, err)
	}
	return dirs
}

func importsWorkspacePrecondition(t *testing.T, pkgDir string) bool {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(pkgDir, "*_test.go"))
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	for _, file := range files {
		parsed, err := parser.ParseFile(fset, file, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatalf("parse test imports in %s: %v", file, err)
		}
		for _, imported := range parsed.Imports {
			if imported.Path.Value == `"`+workspacePreconditionImport+`"` {
				return true
			}
		}
	}
	return false
}

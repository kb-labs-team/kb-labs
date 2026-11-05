package artifacts

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

type releaseBuildConfig struct {
	Dir    string   `yaml:"dir"`
	GoOS   []string `yaml:"goos"`
	GoArch []string `yaml:"goarch"`
	Ignore []struct {
		GoOS   string `yaml:"goos"`
		GoArch string `yaml:"goarch"`
	} `yaml:"ignore"`
}

type releaseConfig struct {
	Builds []releaseBuildConfig `yaml:"builds"`
}

// case: S-284.10
func TestGoReleaserTargetsMatchBinaryManifestTargets(t *testing.T) {
	repoRoot := filepath.Clean(filepath.Join("..", "..", "..", ".."))
	configBytes, err := os.ReadFile(filepath.Join(repoRoot, ".goreleaser.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var config releaseConfig
	if err := yaml.Unmarshal(configBytes, &config); err != nil {
		t.Fatal(err)
	}
	if len(config.Builds) == 0 {
		t.Fatal("GoReleaser config declares no builds")
	}

	declared := releaseTargets(config.Builds[0])
	if len(declared) == 0 {
		t.Fatal("GoReleaser config declares no supported targets")
	}
	for buildIndex, build := range config.Builds[1:] {
		buildTargets := releaseTargets(build)
		if !sameTargetSet(declared, buildTargets) {
			t.Fatalf("GoReleaser build %d targets %v; first build declares %v", buildIndex+1, sortedTargets(buildTargets), sortedTargets(declared))
		}
	}
	for _, build := range config.Builds {
		standaloneConfigPath := filepath.Join(repoRoot, build.Dir, ".goreleaser.yaml")
		if _, err := os.Stat(standaloneConfigPath); os.IsNotExist(err) {
			continue
		} else if err != nil {
			t.Fatal(err)
		}
		standaloneBytes, err := os.ReadFile(standaloneConfigPath)
		if err != nil {
			t.Fatal(err)
		}
		var standalone releaseConfig
		if err := yaml.Unmarshal(standaloneBytes, &standalone); err != nil {
			t.Fatalf("parse %s: %v", standaloneConfigPath, err)
		}
		if len(standalone.Builds) == 0 {
			t.Fatalf("%s declares no builds", standaloneConfigPath)
		}
		for index, standaloneBuild := range standalone.Builds {
			if targets := releaseTargets(standaloneBuild); !sameTargetSet(declared, targets) {
				t.Fatalf("%s build %d targets %v; shared release config declares %v", standaloneConfigPath, index, sortedTargets(targets), sortedTargets(declared))
			}
		}
	}

	root := t.TempDir()
	checksumsPath := filepath.Join(root, "checksums.txt")
	manifestPath := filepath.Join(root, "binary-manifest.json")
	targets := sortedTargets(declared)
	var checksums strings.Builder
	for _, target := range targets {
		filename := "kb-create-" + strings.ReplaceAll(target, "/", "-")
		if err := os.WriteFile(filepath.Join(root, filename), []byte(target), 0o600); err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&checksums, "%s  %s\n", strings.Repeat("a", 64), filename)
	}
	if err := os.WriteFile(checksumsPath, []byte(checksums.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("node", filepath.Join(repoRoot, "tools", "kb-create", "scripts", "prepare-binary-manifest.mjs"),
		"--checksums", checksumsPath, "--repository", "kb-labs-team/kb-labs", "--release-tag", "candidate", "--version", "2.0.0", "--output", manifestPath)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("binary manifest generator failed: %v\n%s", err, output)
	}
	var manifest struct {
		Binaries []struct {
			OS   string `json:"os"`
			Arch string `json:"arch"`
		} `json:"binaries"`
	}
	manifestBytes, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatal(err)
	}
	produced := make(map[string]struct{}, len(manifest.Binaries))
	for _, binary := range manifest.Binaries {
		produced[binary.OS+"/"+binary.Arch] = struct{}{}
	}
	if !sameTargetSet(declared, produced) {
		t.Fatalf("GoReleaser targets %v differ from binary manifest targets %v", sortedTargets(declared), sortedTargets(produced))
	}
}

func releaseTargets(build releaseBuildConfig) map[string]struct{} {
	targets := make(map[string]struct{})
	for _, goos := range build.GoOS {
		for _, goarch := range build.GoArch {
			ignored := false
			for _, target := range build.Ignore {
				if target.GoOS == goos && target.GoArch == goarch {
					ignored = true
					break
				}
			}
			if !ignored {
				targets[goos+"/"+goarch] = struct{}{}
			}
		}
	}
	return targets
}

func sameTargetSet(left, right map[string]struct{}) bool {
	if len(left) != len(right) {
		return false
	}
	for target := range left {
		if _, ok := right[target]; !ok {
			return false
		}
	}
	return true
}

func sortedTargets(targets map[string]struct{}) []string {
	result := make([]string, 0, len(targets))
	for target := range targets {
		result = append(result, target)
	}
	sort.Strings(result)
	return result
}

package artifacts

import (
	"os"
	"path/filepath"
	"sort"
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
func TestGoReleaserTargetConfigurationsMatch(t *testing.T) {
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

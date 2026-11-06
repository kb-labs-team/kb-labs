//go:build (darwin || linux) && docker

package proc

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/kb-runner/internal/testdeadline"
)

// Run only with `go test -tags docker ./proc -run '^TestDockerComposeCleanupRemovesOnlyUniqueProject$'`.
func TestDockerComposeCleanupRemovesOnlyUniqueProject(t *testing.T) {
	id, err := newID()
	if err != nil {
		t.Fatal(err)
	}
	project := "x56-cleanup-" + strings.ToLower(strings.ReplaceAll(id, "_", "a"))
	prefix := composePrefixFromOwner(t)
	composeFile := filepath.Join(t.TempDir(), "compose.yaml")
	compose := "services:\n  sleeper:\n    image: busybox:latest\n    command: [\"sh\", \"-c\", \"trap '' TERM; exec sleep 3600\"]\n"
	if err := os.WriteFile(composeFile, []byte(compose), 0o600); err != nil {
		t.Fatal(err)
	}
	resource := Resource{Kind: ResourceCompose, ID: project, Files: []string{composeFile}, ComposePrefix: prefix}
	cleaned := false
	t.Cleanup(func() {
		if !cleaned {
			if _, err := cleanupCompose(resource); err != nil {
				t.Errorf("clean isolated compose project after test: %v", err)
			}
		}
	})
	args := []string{"-p", project, "-f", composeFile, "up", "-d"}
	ctx, cancel := context.WithTimeout(context.Background(), testdeadline.Budget(t))
	output, err := composeCommand(ctx, prefix, args...)
	cancel()
	if err != nil {
		t.Fatalf("start isolated compose project: %v: %s", err, strings.TrimSpace(string(output)))
	}
	steps, err := cleanupCompose(resource)
	if err != nil {
		t.Fatalf("clean isolated compose project: %v", err)
	}
	if len(steps) != 2 || steps[0].Name != "down" || steps[0].Outcome != ResourceRemoved || steps[1].Name != "label-sweep" || steps[1].Outcome != ResourceRemoved {
		t.Fatalf("real Compose cleanup outcomes = %+v", steps)
	}
	cleaned = true
	for _, args := range [][]string{
		{"ps", "-aq", "--filter", "label=com.docker.compose.project=" + project},
		{"network", "ls", "-q", "--filter", "label=com.docker.compose.project=" + project},
		{"volume", "ls", "-q", "--filter", "label=com.docker.compose.project=" + project},
	} {
		ctx, cancel = context.WithTimeout(context.Background(), testdeadline.Budget(t))
		remaining, err := dockerCommand(ctx, args...)
		cancel()
		if err != nil {
			t.Fatalf("verify isolated project cleanup (%s): %v: %s", strings.Join(args[:2], " "), err, strings.TrimSpace(string(remaining)))
		}
		if strings.TrimSpace(string(remaining)) != "" {
			t.Fatalf("isolated project left labeled resources (%s): %s", strings.Join(args[:2], " "), strings.TrimSpace(string(remaining)))
		}
	}
}

func composePrefixFromOwner(t *testing.T) []string {
	t.Helper()
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatalf("locate Compose owner from test directory: %v", err)
	}
	rootOutput, err := exec.Command("git", "-C", workingDirectory, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		t.Fatalf("locate workspace root for Compose owner: %v", err)
	}
	ownerPath := filepath.Join(strings.TrimSpace(string(rootOutput)), "e2e", "compose-owner.sh")
	if _, err := os.Stat(ownerPath); err != nil {
		t.Fatalf("locate workspace Compose owner at %s: %v", ownerPath, err)
	}
	command := exec.Command("bash", ownerPath, "resolve")
	output, err := command.Output()
	if err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) && exitError.ExitCode() == 127 && len(exitError.Stderr) > 0 {
			t.Skip(strings.TrimSpace(string(exitError.Stderr)))
		}
		t.Fatalf("resolve Compose command using workspace owner: %v", err)
	}
	var prefix []string
	if err := json.Unmarshal(output, &prefix); err != nil {
		t.Fatalf("decode Compose command from workspace owner: %v", err)
	}
	if len(prefix) == 0 {
		t.Fatal("workspace Compose owner resolved an empty command prefix")
	}
	return prefix
}

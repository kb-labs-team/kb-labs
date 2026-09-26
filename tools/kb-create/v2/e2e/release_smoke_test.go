// Package e2e contains the published-artifact V2 journey. It is deliberately
// outside the deterministic contract tests: it consumes the exact sealed
// release index and registry artifacts supplied by the promotion workflow.
package e2e

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"testing"
	"time"
)

// packageTagPattern matches the immutable candidate tag the delivery workflow
// stamps on every publish: "candidate-<flow>-<version>-<channel>-<sha>" (for
// example "candidate-platform-2.119.0-stable-30310c8f10a2"). The channel
// segment is release-deliver-candidate.yml's *build* channel input — which is
// embedded in the candidate/tag identity before the delivery job later
// chooses a rollout target — and it is also the only channel the sealed
// release index actually declares (see prepare-release-index.mjs, which
// writes `channels: { [buildChannel]: version }`). The smoke test must
// resolve against that same channel; requesting a different one always fails
// resolve with KB_INSTALL_INCOMPATIBLE_COMPONENTS because the release index
// simply has no entry for it.
var packageTagPattern = regexp.MustCompile(`^candidate-(?:platform|sdk)-\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?-(canary|stable)-[0-9a-f]+$`)

// channelFromPackageTag extracts the release channel encoded in a
// KB_CREATE_PACKAGE_TAG-style candidate tag. It returns "" when the tag is
// empty or does not match the expected shape, letting the caller fall back to
// a sane default instead of resolving against a fabricated channel.
func channelFromPackageTag(tag string) string {
	match := packageTagPattern.FindStringSubmatch(tag)
	if match == nil {
		return ""
	}
	return match[1]
}

// TestChannelFromPackageTagMatchesDeliveredCandidateFormat guards against a
// regression to the bug this file previously shipped: the smoke test used to
// hardcode "--platform-channel canary" regardless of the candidate actually
// under test, so a real build delivered under a "stable" candidate tag (e.g.
// v2.119.0-binaries / candidate-platform-2.119.0-stable-30310c8f10a2, whose
// published release-index.json declares only "stable" in its channels map)
// made resolve.Plan fail closed with KB_INSTALL_INCOMPATIBLE_COMPONENTS and an
// empty subject value, because "canary" was never a key in that index at all.
func TestChannelFromPackageTagMatchesDeliveredCandidateFormat(t *testing.T) {
	cases := []struct {
		name string
		tag  string
		want string
	}{
		{name: "real stable candidate from v2.119.0-binaries", tag: "candidate-platform-2.119.0-stable-30310c8f10a2", want: "stable"},
		{name: "canary candidate", tag: "candidate-platform-2.119.0-canary-30310c8f10a2", want: "canary"},
		{name: "sdk flow", tag: "candidate-sdk-1.2.3-canary-abcdef0123456789", want: "canary"},
		{name: "prerelease version segment", tag: "candidate-platform-2.119.0-rc.1-stable-30310c8f10a2", want: "stable"},
		{name: "empty tag falls back to caller default", tag: "", want: ""},
		{name: "unrecognized shape falls back to caller default", tag: "not-a-candidate-tag", want: ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := channelFromPackageTag(testCase.tag); got != testCase.want {
				t.Fatalf("channelFromPackageTag(%q) = %q, want %q", testCase.tag, got, testCase.want)
			}
		})
	}
}

func TestPublishedV2JourneyInstallsUpdatesAndRunsTheHost(t *testing.T) {
	if testing.Short() {
		t.Skip("published-artifact V2 journey requires a registry and starts the installed host")
	}
	index := os.Getenv("KB_CREATE_RELEASE_INDEX")
	if index == "" {
		root, err := filepath.Abs("../..")
		if err != nil {
			t.Fatal(err)
		}
		index = filepath.Join(root, ".kb", "release", "release-index.json")
	}
	if _, err := os.Stat(index); err != nil {
		t.Skipf("published V2 release index is unavailable: %v", err)
	}

	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	launcher := os.Getenv("KB_CREATE_BINARY")
	if launcher == "" {
		launcher = filepath.Join(t.TempDir(), "kb-create")
		build := exec.Command("go", "build", "-trimpath", "-o", launcher, ".")
		build.Dir = root
		if output, err := build.CombinedOutput(); err != nil {
			t.Fatalf("build V2 root launcher: %v\n%s", err, output)
		}
	} else if info, err := os.Stat(launcher); err != nil || info.Mode()&0o111 == 0 {
		t.Fatalf("published kb-create binary is not executable: %s (%v)", launcher, err)
	}
	// The launcher keeps its per-user state under KB_HOME; never the real one.
	t.Setenv("KB_HOME", t.TempDir())
	platform, project := filepath.Join(t.TempDir(), "platform"), filepath.Join(t.TempDir(), "project")
	if err := os.MkdirAll(project, 0o750); err != nil {
		t.Fatal(err)
	}

	// The sealed release index only declares the channel the candidate was
	// actually built under (see channelFromPackageTag above), which need not
	// be "canary" — resolve.Plan fails closed with an empty subject value
	// whenever the requested channel is absent from the index, so requesting
	// a channel the index doesn't have is not a resolvable configuration.
	channel := channelFromPackageTag(os.Getenv("KB_CREATE_PACKAGE_TAG"))
	if channel == "" {
		channel = "canary"
	}

	args := []string{"apply", "--index", index, "--request-platform-root", platform, "--project-root", project, "--platform-channel", channel, "--policy", "strict"}
	if registry := os.Getenv("KB_REGISTRY_URL"); registry != "" {
		args = append(args, "--registry", registry)
	}
	if output, code := run(t, launcher, args...); code != 0 {
		t.Fatalf("V2 apply exited %d:\n%s", code, output)
	}
	for _, path := range []string{filepath.Join(platform, ".kb", "v2", "receipt.json"), filepath.Join(platform, ".kb", "kb.config.jsonc"), filepath.Join(project, ".kb", "kb.config.jsonc")} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("V2 install artifact %s is missing: %v", path, err)
		}
	}
	if output, code := run(t, launcher, "status", "--platform-root", platform); code != 0 {
		t.Fatalf("V2 status exited %d:\n%s", code, output)
	}
	updateOutput, updateCode := run(t, launcher, "update", "--index", index, "--request-platform-root", platform, "--project-root", project, "--platform-channel", channel, "--policy", "strict")
	if updateCode != 0 {
		t.Fatalf("V2 update exited %d: %s", updateCode, updateOutput)
	}
	var updateResponse struct {
		OK      bool `json:"ok"`
		Receipt struct {
			SnapshotID string `json:"snapshotId"`
		} `json:"receipt"`
	}
	if err := json.Unmarshal([]byte(updateOutput), &updateResponse); err != nil || !updateResponse.OK || updateResponse.Receipt.SnapshotID == "" {
		t.Fatalf("V2 update did not commit a recovery snapshot: %s", updateOutput)
	}
	// The installed platform runs as one supervised host. Start it through the
	// launcher, require it to be healthy and reported as running, and stop it:
	// this is the user path (there is no kb-dev in it), against the published
	// artifacts.
	if output, code := run(t, launcher, "start", "--json", "--platform-root", platform); code != 0 {
		t.Fatalf("V2 start exited %d:\n%s", code, output)
	}
	t.Cleanup(func() { _, _ = run(t, launcher, "stop", "--json", "--platform-root", platform) })
	statusOutput, statusCode := run(t, launcher, "status", "--platform-root", platform)
	if statusCode != 0 {
		t.Fatalf("V2 status of a started host exited %d:\n%s", statusCode, statusOutput)
	}
	var running struct {
		OK   bool `json:"ok"`
		Host struct {
			State   string `json:"state"`
			Healthy bool   `json:"healthy"`
		} `json:"host"`
	}
	if err := json.Unmarshal([]byte(statusOutput), &running); err != nil || !running.OK || running.Host.State != "running" || !running.Host.Healthy {
		t.Fatalf("the started host is not running and healthy: %s", statusOutput)
	}

	// doctor separates the installation from the platform; the installation
	// the launcher just wrote must be complete whatever the platform reports.
	doctorOutput, _ := run(t, launcher, "doctor", "--platform-root", platform)
	var diagnosis struct {
		Installation struct {
			OK bool `json:"ok"`
		} `json:"installation"`
		Platform struct {
			Checks []struct {
				ID string `json:"id"`
			} `json:"checks"`
		} `json:"platform"`
	}
	if err := json.Unmarshal([]byte(doctorOutput), &diagnosis); err != nil || !diagnosis.Installation.OK || len(diagnosis.Platform.Checks) == 0 {
		t.Fatalf("doctor must report a complete installation and inspect the running platform: %s", doctorOutput)
	}

	if output, code := run(t, launcher, "stop", "--json", "--platform-root", platform); code != 0 {
		t.Fatalf("V2 stop exited %d:\n%s", code, output)
	}
}

func run(t *testing.T, binary string, args ...string) (string, int) {
	return runIn(t, "", binary, args...)
}

func runIn(t *testing.T, dir, command string, args ...string) (string, int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, command, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	cmd.Env = os.Environ()
	output, err := cmd.CombinedOutput()
	if err == nil {
		return string(output), 0
	}
	if exit, ok := err.(*exec.ExitError); ok {
		return string(output), exit.ExitCode()
	}
	t.Fatalf("command %s failed: %v\n%s", command, err, output)
	return string(output), 1
}

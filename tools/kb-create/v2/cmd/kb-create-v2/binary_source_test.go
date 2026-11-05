package v2cli

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"

	clikitcommand "github.com/kb-labs/clikit/command"
	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/spf13/cobra"
)

// writeInstallerSource exercises the installer, the owner of the source record.
func writeInstallerSource(t *testing.T, home, source string) {
	t.Helper()
	fixtureDir := t.TempDir()
	index, err := os.ReadFile(filepath.Join(home, ".local/share/kb-create/release-index.json"))
	if err != nil {
		t.Fatal(err)
	}
	binary := []byte("installer fixture")
	binaryPath := filepath.Join(fixtureDir, "binary")
	indexPath := filepath.Join(fixtureDir, "index")
	sumsPath := filepath.Join(fixtureDir, "checksums")
	name := "kb-create-" + goruntime.GOOS + "-" + goruntime.GOARCH
	sums := fmt.Sprintf("%x  %s\n%x  release-index.json\n", sha256.Sum256(binary), name, sha256.Sum256(index))
	for path, data := range map[string][]byte{binaryPath: binary, indexPath: index, sumsPath: []byte(sums)} {
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	curl := `#!/bin/sh
url= out=
while [ "$#" -gt 0 ]; do case "$1" in -o) out=$2; shift;; http*) url=$1;; esac; shift; done
case "$url" in */checksums.txt) input=$FIXTURE_SUMS;; */release-index.json) input=$FIXTURE_INDEX;; *) input=$FIXTURE_BINARY;; esac
if [ -n "$out" ]; then cp "$input" "$out"; else cat "$input"; fi
`
	mktemp := `#!/bin/sh
if [ "$#" -eq 0 ]; then exec /usr/bin/mktemp "$TMPDIR/x251.XXXXXXXX"; fi
if [ "$#" -eq 1 ] && [ "$1" = -d ]; then exec /usr/bin/mktemp -d "$TMPDIR/x251.XXXXXXXX"; fi
exec /usr/bin/mktemp "$@"
`
	for name, script := range map[string]string{"curl": curl, "mktemp": mktemp} {
		if err := os.WriteFile(filepath.Join(fixtureDir, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	script := filepath.Join("..", "..", "..", "install.sh")
	cmd := exec.Command("/bin/sh", script, "--version", "vfixture-binaries")
	cmd.Env = append(os.Environ(), "HOME="+home, "PATH="+fixtureDir+string(os.PathListSeparator)+os.Getenv("PATH"), "TMPDIR="+fixtureDir, "KB_CREATE_DOWNLOAD_BASE_URL="+source, "FIXTURE_SUMS="+sumsPath, "FIXTURE_INDEX="+indexPath, "FIXTURE_BINARY="+binaryPath)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("installer source fixture: %v: %s", err, output)
	}
}

func TestCanaryBinarySourcePlan(t *testing.T) {
	for _, mode := range []string{"flag", "env", "recorded"} {
		t.Run(mode, func(t *testing.T) {
			home := installCanaryIndex(t)
			mirror := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) }))
			defer mirror.Close()
			t.Setenv("KB_CREATE_DOWNLOAD_BASE_URL", "")
			recorded := "http://recorded.invalid"
			if mode == "recorded" {
				recorded = mirror.URL
			}
			writeInstallerSource(t, home, recorded)
			if mode == "flag" {
				t.Setenv("KB_CREATE_DOWNLOAD_BASE_URL", "http://environment.invalid")
			}
			args := []string{"plan", "--platform-root", filepath.Join(home, "platform"), "--platform-version", "2.121.0-canary.cec6dacc6", "--registry", "http://127.0.0.1:4873", "--json"}
			switch mode {
			case "flag":
				args = append(args, "--binary-source", mirror.URL)
			case "env":
				t.Setenv("KB_CREATE_DOWNLOAD_BASE_URL", mirror.URL)
			case "recorded":

			}
			var out, errout bytes.Buffer
			status := clikitcommand.Execute(newRootCommand(), args, &out, &errout)
			if status.Code() != 0 {
				t.Fatalf("exit %d: %s %s", status.Code(), out.String(), errout.String())
			}
			var payload struct {
				Data struct {
					Plan contracts.ResolvedInstallPlan `json:"plan"`
				} `json:"data"`
			}
			if err := json.Unmarshal(out.Bytes(), &payload); err != nil {
				t.Fatal(err)
			}
			if payload.Data.Plan.BinarySource != mirror.URL {
				t.Fatalf("binary source %q", payload.Data.Plan.BinarySource)
			}
			found := false
			for _, item := range payload.Data.Plan.Artifacts {
				if item.IsBinary() {
					found = true
					if !strings.HasPrefix(item.ResolvedURL, mirror.URL+"/v2.121.0-canary.cec6dacc6-binaries/") {
						t.Fatalf("resolved URL %q", item.ResolvedURL)
					}
				}
			}
			if !found {
				t.Fatal("no binary in plan")
			}
		})
	}
}

type binaryDownloadProbe struct{ root string }

func (p binaryDownloadProbe) Prepare(items []contracts.Artifact) (contracts.PreparedArtifacts, error) {
	err := (artifacts.Binaries{Root: p.root, CacheRoot: filepath.Join(p.root, "cache")}).Install(items)
	if err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("binary probe completed")
}
func (p binaryDownloadProbe) Install(items []contracts.Artifact) error {
	_, err := p.Prepare(items)
	return err
}
func (p binaryDownloadProbe) Restore([]contracts.Artifact) error { return nil }

func TestCanaryBinaryMirrorApplyCommand(t *testing.T) {
	data := []byte("x251 mirror binary fixture")
	for _, tc := range []struct{ mode, response string }{{"flag", "good"}, {"env", "good"}, {"recorded", "good"}, {"flag", "bad"}, {"flag", "404"}} {
		t.Run(tc.mode+"_"+tc.response, func(t *testing.T) {
			home := installCanaryIndex(t)
			indexPath := filepath.Join(home, ".local/share/kb-create/release-index.json")
			source, err := catalog.LoadFile(indexPath)
			if err != nil {
				t.Fatal(err)
			}
			digest := fmt.Sprintf("%x", sha256.Sum256(data))
			for i := range source.Platforms {
				for j := range source.Platforms[i].Binaries {
					source.Platforms[i].Binaries[j].SHA256 = digest
				}
			}
			source, err = catalog.Seal(source)
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(source)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(indexPath, encoded, 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("KB_CREATE_DOWNLOAD_BASE_URL", "")
			var requests []string
			mirror := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests = append(requests, r.URL.Path)
				if tc.response == "404" {
					http.NotFound(w, r)
					return
				}
				if tc.response == "bad" {
					_, _ = w.Write([]byte("incorrect binary"))
					return
				}
				_, _ = w.Write(data)
			}))
			defer mirror.Close()
			root := filepath.Join(home, "platform")
			args := []string{"apply", "--platform-root", root, "--platform-version", "2.121.0-canary.cec6dacc6", "--gateway-url", "http://127.0.0.1:5500", "--json"}
			switch tc.mode {
			case "flag":
				args = append(args, "--binary-source", mirror.URL)
			case "env":
				t.Setenv("KB_CREATE_DOWNLOAD_BASE_URL", mirror.URL)
			case "recorded":
				writeInstallerSource(t, home, mirror.URL)
			}
			factory := func(cmd *cobra.Command) commandDependencies {
				return commandDependencies{Command: cmd, NodeCheck: func() error { return nil }, Runtime: &runtime.Dependencies{Artifacts: binaryDownloadProbe{root: filepath.Join(home, "probe")}}}
			}
			var out, errout bytes.Buffer
			code := clikitcommand.Execute(newRootCommandWithDependencyFactory(factory), args, &out, &errout)
			output := out.String() + errout.String()
			if code.Code() == 0 {
				t.Fatalf("expected probe failure: %s", output)
			}
			if len(requests) != 1 || !strings.HasPrefix(requests[0], "/v2.121.0-canary.cec6dacc6-binaries/") {
				t.Fatalf("requests=%v output=%s", requests, output)
			}
			switch tc.response {
			case "good":
				if !strings.Contains(output, "binary probe completed") {
					t.Fatalf("verified mirror binary did not reach probe: %s", output)
				}
			case "bad":
				if !strings.Contains(output, "checksum mismatch") {
					t.Fatalf("digest mismatch not reported: %s", output)
				}
			case "404":
				if !strings.Contains(output, mirror.URL+requests[0]) || !strings.Contains(output, "--binary-source") || !strings.Contains(output, "KB_CREATE_DOWNLOAD_BASE_URL") || strings.Contains(output, "doctor --fix") || !strings.Contains(output, contracts.ShellCommand(append([]string{"kb-create"}, args...)...)) {
					t.Fatalf("download diagnostic: %s", output)
				}
			}
		})
	}
}

func TestCanaryBinarySourceDefaultsToIndexAndRejectsCredentials(t *testing.T) {
	home := installCanaryIndex(t)
	t.Setenv("KB_CREATE_DOWNLOAD_BASE_URL", "")
	args := []string{"plan", "--platform-root", filepath.Join(home, "platform"), "--platform-version", "2.121.0-canary.cec6dacc6", "--json"}
	var out, errout bytes.Buffer
	status := clikitcommand.Execute(newRootCommand(), args, &out, &errout)
	if status.Code() != 0 {
		t.Fatalf("%s %s", out.String(), errout.String())
	}
	var payload struct {
		Data struct {
			Plan contracts.ResolvedInstallPlan `json:"plan"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	for _, a := range payload.Data.Plan.Artifacts {
		if a.IsBinary() && a.ResolvedURL != a.URL {
			t.Fatalf("source default=%q index=%q", a.ResolvedURL, a.URL)
		}
	}
	out.Reset()
	errout.Reset()
	args = append(args, "--binary-source", "http://user:private-password@example.test")
	status = clikitcommand.Execute(newRootCommand(), args, &out, &errout)
	if status.Code() == 0 || strings.Contains(out.String()+errout.String(), "private-password") {
		t.Fatalf("credential URL should fail without disclosing it: %s %s", out.String(), errout.String())
	}
}

func TestCanaryPlanUsesRegistryForEverySelectedPackage(t *testing.T) {
	home := installCanaryIndex(t)
	t.Setenv("npm_config_registry", "http://environment.invalid")
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()
	args := []string{"plan", "--platform-root", filepath.Join(home, "platform"), "--platform-version", "2.121.0-canary.cec6dacc6", "--registry", server.URL, "--binary-source", server.URL, "--json"}
	var out, errout bytes.Buffer
	result := clikitcommand.Execute(newRootCommand(), args, &out, &errout)
	if result.Code() != 0 {
		t.Fatalf("exit=%d: %s %s", result.Code(), out.String(), errout.String())
	}
	var payload struct {
		Data struct {
			Plan contracts.ResolvedInstallPlan `json:"plan"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	for _, item := range payload.Data.Plan.Artifacts {
		if !strings.HasPrefix(item.ResolvedURL, server.URL+"/") {
			t.Errorf("%s %s URL=%s", item.Kind, item.ID, item.ResolvedURL)
		}
	}
}

func TestCanaryDownloadPhaseUsesBothSources(t *testing.T) {
	home := installCanaryIndex(t)
	indexPath := filepath.Join(home, ".local/share/kb-create/release-index.json")
	source, err := catalog.LoadFile(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("sealed download-phase fixture")
	hash := fmt.Sprintf("%x", sha256.Sum256(data))
	for i := range source.Platforms {
		p := &source.Platforms[i]
		p.SHA256 = hash
		for j := range p.Members {
			p.Members[j].SHA256 = hash
		}
		for j := range p.Binaries {
			p.Binaries[j].SHA256 = hash
		}
	}
	for i := range source.SDKs {
		source.SDKs[i].SHA256 = hash
	}
	for i := range source.Plugins {
		source.Plugins[i].SHA256 = hash
	}
	for i := range source.Adapters {
		source.Adapters[i].SHA256 = hash
	}
	source, err = catalog.Seal(source)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, encoded, 0600); err != nil {
		t.Fatal(err)
	}
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.URL.Path)
		_, _ = w.Write(data)
	}))
	defer server.Close()
	args := []string{"apply", "--platform-root", filepath.Join(home, "platform"), "--platform-version", "2.121.0-canary.cec6dacc6", "--gateway-url", "http://127.0.0.1:5500", "--registry", server.URL, "--binary-source", server.URL, "--json"}
	var planOut, planErr bytes.Buffer
	planArgs := append([]string(nil), args...)
	planArgs[0] = "plan"
	if status := clikitcommand.Execute(newRootCommand(), planArgs, &planOut, &planErr); status.Code() != 0 {
		t.Fatalf("plan: %s %s", planOut.String(), planErr.String())
	}
	var planResult struct {
		Data struct {
			Plan contracts.ResolvedInstallPlan `json:"plan"`
		} `json:"data"`
	}
	if err := json.Unmarshal(planOut.Bytes(), &planResult); err != nil {
		t.Fatal(err)
	}
	expectedPackages, expectedBinaries := 0, 0
	for _, item := range planResult.Data.Plan.Artifacts {
		if item.IsBinary() {
			expectedBinaries++
		} else {
			expectedPackages++
		}
	}
	factory := func(cmd *cobra.Command) commandDependencies {
		return commandDependencies{Command: cmd, NodeCheck: func() error { return nil }}
	}
	var out, errout bytes.Buffer
	code := clikitcommand.Execute(newRootCommandWithDependencyFactory(factory), args, &out, &errout)
	output := out.String() + errout.String()
	if code.Code() == 0 {
		t.Fatal("fixture packages should not be installable")
	}
	var binaries, packages int
	for _, path := range requests {
		if strings.Contains(path, "-binaries/") {
			binaries++
		} else {
			packages++
		}
	}
	seen := map[string]bool{}
	for _, path := range requests {
		seen[path] = true
	}
	for _, item := range planResult.Data.Plan.Artifacts {
		parsed, err := url.Parse(item.ResolvedURL)
		if err != nil {
			t.Fatal(err)
		}
		if !seen[parsed.Path] {
			t.Errorf("artifact %s not downloaded at %s", item.ID, parsed.Path)
		}
	}
	if binaries < expectedBinaries || packages < expectedPackages || strings.Contains(output, "download artifact") || strings.Contains(output, "checksum mismatch") {
		t.Fatalf("download phase not completed: binary=%d/%d packages=%d/%d output=%s", binaries, expectedBinaries, packages, expectedPackages, output)
	}
	t.Logf("download phase passed: %d binary, %d packages; later failure: %s", binaries, packages, output)
}

func TestCanaryInstallNpm404IsOneSourceAwareFailure(t *testing.T) {
	home := installCanaryIndex(t)
	indexPath := filepath.Join(home, ".local/share/kb-create/release-index.json")
	source, err := catalog.LoadFile(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("binary fixture")
	for i := range source.Platforms {
		for j := range source.Platforms[i].Binaries {
			source.Platforms[i].Binaries[j].SHA256 = fmt.Sprintf("%x", sha256.Sum256(data))
		}
	}
	source, err = catalog.Seal(source)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, encoded, 0600); err != nil {
		t.Fatal(err)
	}
	var attempted string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "-binaries/") {
			_, _ = w.Write(data)
			return
		}
		attempted = r.URL.Path
		http.NotFound(w, r)
	}))
	defer server.Close()
	args := []string{"install", "--platform-root", filepath.Join(home, "platform"), "--platform-version", "2.121.0-canary.cec6dacc6", "--gateway-url", "http://127.0.0.1:5500", "--registry", server.URL, "--binary-source", server.URL, "--json"}
	factory := func(cmd *cobra.Command) commandDependencies {
		return commandDependencies{Command: cmd, NodeCheck: func() error { return nil }, Runtime: &runtime.Dependencies{}}
	}
	var out, errout bytes.Buffer
	code := clikitcommand.Execute(newRootCommandWithDependencyFactory(factory), args, &out, &errout)
	if code.Code() == 0 || attempted == "" {
		t.Fatalf("package download did not fail: %s %s", out.String(), errout.String())
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	count := 0
	for _, line := range lines {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		if record["error"] != nil {
			count++
		}
	}
	if count != 1 || errout.Len() != 0 || !strings.Contains(out.String(), server.URL+attempted) || !strings.Contains(out.String(), "--registry") || !strings.Contains(out.String(), "npm_config_registry") || strings.Contains(out.String(), "doctor --fix") {
		t.Fatalf("diagnostic count=%d stdout=%s stderr=%s", count, out.String(), errout.String())
	}
}

func TestCanaryRegistryEnvironmentDefault(t *testing.T) {
	home := installCanaryIndex(t)
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()
	t.Setenv("npm_config_registry", server.URL)
	args := []string{"plan", "--platform-root", filepath.Join(home, "platform"), "--platform-version", "2.121.0-canary.cec6dacc6", "--json"}
	var out, errout bytes.Buffer
	code := clikitcommand.Execute(newRootCommand(), args, &out, &errout)
	if code.Code() != 0 {
		t.Fatalf("%s %s", out.String(), errout.String())
	}
	var payload struct {
		Data struct {
			Plan contracts.ResolvedInstallPlan `json:"plan"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Data.Plan.Registry != server.URL {
		t.Fatalf("registry=%q", payload.Data.Plan.Registry)
	}
	for _, item := range payload.Data.Plan.Artifacts {
		if !item.IsBinary() && !strings.HasPrefix(item.ResolvedURL, server.URL+"/") {
			t.Fatalf("%s: %s", item.ID, item.ResolvedURL)
		}
	}
}

func TestCanaryRegistryDefaultsToRecordedReceipt(t *testing.T) {
	home := installCanaryIndex(t)
	t.Setenv("npm_config_registry", "")
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()
	root := filepath.Join(home, "platform")
	args := []string{"plan", "--platform-root", root, "--platform-version", "2.121.0-canary.cec6dacc6", "--registry", server.URL, "--json"}
	var out, errout bytes.Buffer
	if code := clikitcommand.Execute(newRootCommand(), args, &out, &errout); code.Code() != 0 {
		t.Fatalf("first plan: %s %s", out.String(), errout.String())
	}
	var payload struct {
		Data struct {
			Plan contracts.ResolvedInstallPlan `json:"plan"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	writeVersionedReceipt(t, root, contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "test-receipt", Plan: payload.Data.Plan})
	out.Reset()
	errout.Reset()
	args = []string{"plan", "--platform-root", root, "--platform-version", "2.121.0-canary.cec6dacc6", "--json"}
	if code := clikitcommand.Execute(newRootCommand(), args, &out, &errout); code.Code() != 0 {
		t.Fatalf("recorded plan: %s %s", out.String(), errout.String())
	}
	payload.Data.Plan = contracts.ResolvedInstallPlan{}
	if err := json.Unmarshal(out.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Data.Plan.Registry != server.URL {
		t.Fatalf("recorded registry = %q", payload.Data.Plan.Registry)
	}
	requestBytes, err := json.Marshal(payload.Data.Plan.Request)
	if err != nil {
		t.Fatal(err)
	}
	requestPath := filepath.Join(home, "request.json")
	if err := os.WriteFile(requestPath, requestBytes, 0600); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	errout.Reset()
	if code := clikitcommand.Execute(newRootCommand(), []string{"plan", "--input", requestPath, "--json"}, &out, &errout); code.Code() != 0 {
		t.Fatalf("request file plan: %s %s", out.String(), errout.String())
	}
	payload.Data.Plan = contracts.ResolvedInstallPlan{}
	if err := json.Unmarshal(out.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Data.Plan.Registry != server.URL {
		t.Fatalf("request file recorded registry = %q", payload.Data.Plan.Registry)
	}
}

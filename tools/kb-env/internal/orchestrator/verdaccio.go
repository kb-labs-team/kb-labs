package orchestrator

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/kb-labs/clikit/proc/child"

	"github.com/kb-labs/env/internal/env"
)

// RegistryURL is the host-local Verdaccio endpoint kb-env publishes to and
// installs from. Anonymous publish is allowed by the generated config.
const RegistryURL = "http://localhost:4873"

// verdaccioConfigTmpl is a host-friendly Verdaccio config: @kb-labs/* are served
// locally (no uplink so npmjs can't shadow them), everything else proxies to
// npmjs. htpasswd auth backs a throwaway publish user. storage + htpasswd live
// per-env under KB_ENV_HOME. Args: storage dir (used twice).
const verdaccioConfigTmpl = `storage: %s
auth:
  htpasswd:
    file: %s/htpasswd
    max_users: 1000
uplinks:
  npmjs:
    url: https://registry.npmjs.org
    cache: true
packages:
  '@kb-labs/*':
    access: $all
    publish: $all
    unpublish: $all
  '**':
    access: $all
    publish: $all
    proxy: npmjs
log: { type: stdout, level: warn }
`

// EnsureVerdaccio starts a clean native Verdaccio (pnpm dlx) for this run: any
// previous instance is stopped and its storage wiped, so the registry serves
// exactly the tarballs this run publishes (avoiding stale same-version tarballs
// with mismatched integrity). The process is detached; its PID is recorded
// under KB_ENV_HOME for teardown.
func EnsureVerdaccio(l env.Layout) (string, error) {
	StopVerdaccio(l)
	// Give the old listener a moment to release the port.
	for i := 0; i < 10 && pingRegistry(RegistryURL); i++ {
		time.Sleep(300 * time.Millisecond)
	}

	vdir := filepath.Join(l.Home, "verdaccio")
	storage := filepath.Join(vdir, "storage")
	_ = os.RemoveAll(storage)
	if err := os.MkdirAll(storage, 0o755); err != nil {
		return "", err
	}
	cfgPath := filepath.Join(vdir, "config.yaml")
	if err := os.WriteFile(cfgPath, []byte(fmt.Sprintf(verdaccioConfigTmpl, storage, storage)), 0o600); err != nil {
		return "", err
	}

	logFile, err := os.Create(filepath.Join(vdir, "verdaccio.log"))
	if err != nil {
		return "", err
	}
	defer logFile.Close()

	cmd := exec.Command("pnpm", "dlx", "verdaccio@5", "--config", cfgPath, "--listen", "4873")
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if err := child.Start(cmd, child.ProcessGroup); err != nil {
		return "", fmt.Errorf("start verdaccio: %w", err)
	}
	_ = os.WriteFile(filepath.Join(vdir, "verdaccio.pid"), []byte(strconv.Itoa(cmd.Process.Pid)), 0o600)

	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		if pingRegistry(RegistryURL) {
			return RegistryURL, nil
		}
		time.Sleep(time.Second)
	}
	return "", fmt.Errorf("verdaccio did not become ready (log: %s)", filepath.Join(vdir, "verdaccio.log"))
}

// StopVerdaccio kills the kb-env-started Verdaccio process group, if any.
func StopVerdaccio(l env.Layout) {
	pidFile := filepath.Join(l.Home, "verdaccio", "verdaccio.pid")
	data, err := os.ReadFile(pidFile)
	if err != nil {
		return
	}
	if pid, perr := strconv.Atoi(strings.TrimSpace(string(data))); perr == nil {
		_ = child.TerminateTree(pid)
	}
	_ = os.Remove(pidFile)
}

func pingRegistry(url string) bool {
	c := &http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get(url + "/-/ping")
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// PackAll runs e2e/scripts/pack-all.sh, packing every built @kb-labs/* package
// into e2e/packages/*.tgz. Requires dist to be built.
func PackAll(workspaceRoot string) error {
	script := filepath.Join(workspaceRoot, "e2e", "scripts", "pack-all.sh")
	cmd := exec.Command("bash", script)
	cmd.Dir = workspaceRoot
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr // progress to stderr; stdout stays clean for --json
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("pack-all: %w", err)
	}
	return nil
}

// publishWorkers bounds concurrent pnpm publish processes.
const publishWorkers = 4

// PublishAll publishes every packed tarball to the registry. It first obtains an
// auth token (Verdaccio requires _authToken even when access is anonymous),
// writes a scoped .npmrc, then publishes in parallel. A tarball that already
// exists (409 / EPUBLISHCONFLICT) is treated as success — publish is idempotent.
func PublishAll(l env.Layout, workspaceRoot, registry string) error {
	pkgDir := filepath.Join(workspaceRoot, "e2e", "packages")
	tarballs, err := filepath.Glob(filepath.Join(pkgDir, "*.tgz"))
	if err != nil {
		return err
	}
	if len(tarballs) == 0 {
		return fmt.Errorf("no tarballs in %s (did pack-all run?)", pkgDir)
	}

	npmrc, err := writeAuthNpmrc(l, registry)
	if err != nil {
		return err
	}
	userconfig := "npm_config_userconfig=" + npmrc

	// Publish from a neutral cwd OUTSIDE the workspace: inside the monorepo a
	// pnpm-workspace.yaml above would put pnpm in workspace mode and make it
	// ignore the tarball arg (publishing nothing). Verdaccio dir is neutral.
	neutralDir := filepath.Join(l.Home, "verdaccio")

	sem := make(chan struct{}, publishWorkers)
	errc := make(chan error, len(tarballs))
	for _, tgz := range tarballs {
		sem <- struct{}{}
		go func(tgz string) {
			defer func() { <-sem }()
			cmd := newPublishCmd(tgz, registry, neutralDir, userconfig)
			out, perr := cmd.CombinedOutput()
			if perr != nil && !strings.Contains(string(out), "EPUBLISHCONFLICT") && !strings.Contains(string(out), "409") {
				errc <- fmt.Errorf("publish %s: %v\n%s", filepath.Base(tgz), perr, string(out))
				return
			}
			errc <- nil
		}(tgz)
	}
	for range tarballs {
		if e := <-errc; e != nil {
			return e
		}
	}
	return nil
}

// newPublishCmd builds the command that publishes one pre-packed tarball.
//
// It uses npm (not pnpm): `npm publish <tgz>` reads the package.json from
// *inside* the tarball, so it works from a neutral cwd. `pnpm publish <tgz>`
// instead resolves the package from cwd and on a CI runner fails with ENOENT on
// the (absent) neutralDir/package.json. --no-git-checks is pnpm-only and
// unneeded here. Auth + registry come from the scoped .npmrc via userconfig.
func newPublishCmd(tgz, registry, dir, userconfig string) *exec.Cmd {
	cmd := exec.Command("npm", "publish", tgz, "--registry", registry)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), userconfig)
	return cmd
}

const (
	verdaccioUser = "kbenv"
	verdaccioPass = "kbenv"
)

// writeAuthNpmrc ensures the publish user exists, then writes a registry-scoped
// .npmrc with HTTP basic auth that pnpm publish picks up via userconfig. Basic
// auth validates against htpasswd and is robust across re-runs (unlike a token
// that must be re-issued).
func writeAuthNpmrc(l env.Layout, registry string) (string, error) {
	if err := ensureUser(registry); err != nil {
		return "", err
	}
	host := strings.TrimPrefix(strings.TrimPrefix(registry, "http://"), "https://")
	b64 := base64.StdEncoding.EncodeToString([]byte(verdaccioUser + ":" + verdaccioPass))
	npmrc := filepath.Join(l.Home, "verdaccio", ".npmrc")
	content := fmt.Sprintf("//%s/:_auth=%s\n//%s/:always-auth=true\nregistry=%s/\n", host, b64, host, registry)
	if err := os.WriteFile(npmrc, []byte(content), 0o600); err != nil {
		return "", err
	}
	return npmrc, nil
}

// ensureUser PUTs the throwaway publish user to Verdaccio. A 201 (created) or
// 409 (already exists) both leave a valid htpasswd entry for basic auth.
func ensureUser(registry string) error {
	body := fmt.Sprintf(`{"name":%q,"password":%q,"email":"kbenv@local"}`, verdaccioUser, verdaccioPass)
	req, err := http.NewRequest(http.MethodPut, registry+"/-/user/org.couchdb.user:"+verdaccioUser, strings.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("register verdaccio user: %w", err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusCreated, http.StatusOK, http.StatusConflict:
		return nil
	default:
		return fmt.Errorf("verdaccio user registration failed (status %d)", resp.StatusCode)
	}
}

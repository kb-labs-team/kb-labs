// Package env owns the on-disk layout of a sandbox environment and the
// isolation guarantees (external dir, clean PATH, KB_HOME).
package env

import (
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Layout is the directory layout of the single live environment.
//
//	<Home>/current/
//	  platform/   kb-create --platform target (node_modules, bin, .kb)
//	  project/    kb-create project cwd (.kb/plugins, .env, user code)
//	  state/      KB_HOME — isolates per-user KB Labs state (launcher, project registry)
//	  logs/       orchestration logs
type Layout struct {
	Home     string
	Root     string // <Home>/current
	Platform string
	Project  string
	State    string
	Logs     string
}

// Resolve computes the layout from KB_ENV_HOME (default ~/.kb-env).
func Resolve() (Layout, error) {
	home := os.Getenv("KB_ENV_HOME")
	if home == "" {
		uh, err := os.UserHomeDir()
		if err != nil {
			return Layout{}, fmt.Errorf("resolve home dir: %w", err)
		}
		home = filepath.Join(uh, ".kb-env")
	}
	root := filepath.Join(home, "current")
	return Layout{
		Home:     home,
		Root:     root,
		Platform: filepath.Join(root, "platform"),
		Project:  filepath.Join(root, "project"),
		State:    filepath.Join(root, "state"),
		Logs:     filepath.Join(root, "logs"),
	}, nil
}

// Ensure creates the environment directory tree.
func (l Layout) Ensure() error {
	for _, d := range []string{l.Platform, l.Project, l.State, l.Logs} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fmt.Errorf("create %s: %w", d, err)
		}
	}
	return nil
}

// Remove deletes the whole current environment.
func (l Layout) Remove() error { return os.RemoveAll(l.Root) }

// Exists reports whether an environment is currently provisioned.
func (l Layout) Exists() bool {
	_, err := os.Stat(l.Platform)
	return err == nil
}

// DevservicesPath returns the devservices.yaml kb-dev should use: the project's
// (absolute paths) if present, else the platform's.
func (l Layout) DevservicesPath() string {
	proj := filepath.Join(l.Project, ".kb", "devservices.yaml")
	if _, err := os.Stat(proj); err == nil {
		return proj
	}
	return filepath.Join(l.Platform, ".kb", "devservices.yaml")
}

// SocketDir mirrors kb-dev's md5(projectDir)[:8] socket directory, so `down`
// can clean it up. kb-dev computes the hash from the devservices project root,
// which is l.Project (RootDir steps out of .kb).
func (l Layout) SocketDir() string {
	sum := md5.Sum([]byte(l.Project))
	return filepath.Join(os.TempDir(), "kb-"+hex.EncodeToString(sum[:])[:8])
}

// CleanPath returns a PATH with the installed platform binaries first and any
// workspace node_modules/.bin entries removed — so `kb` resolves to the
// installed binary, never the `pnpm kb` dev alias.
func (l Layout) CleanPath() string {
	binDir := filepath.Join(l.Platform, "bin")
	var kept []string
	for _, p := range filepath.SplitList(os.Getenv("PATH")) {
		if strings.Contains(p, "node_modules/.bin") {
			continue
		}
		kept = append(kept, p)
	}
	return strings.Join(append([]string{binDir}, kept...), string(os.PathListSeparator))
}

// ExecEnv builds the environment for commands run inside the sandbox: clean
// PATH, isolated KB_HOME, KB_PROJECT_ROOT, plus any extras. Any
// inherited KB_HOME is stripped so it can never leak in.
func (l Layout) ExecEnv(extra map[string]string) []string {
	base := os.Environ()
	out := make([]string, 0, len(base)+4)
	for _, kv := range base {
		if strings.HasPrefix(kv, "KB_HOME=") || strings.HasPrefix(kv, "PATH=") {
			continue
		}
		out = append(out, kv)
	}
	out = append(out,
		"PATH="+l.CleanPath(),
		"KB_HOME="+l.State,
		"KB_PROJECT_ROOT="+l.Project,
	)
	for k, v := range extra {
		out = append(out, k+"="+v)
	}
	return out
}

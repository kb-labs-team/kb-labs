package engine

import (
	"os"
	"sort"
)

// alwaysPassedEnv is the toolchain's own environment, passed to every task
// whether or not it is declared and never hashed:
//
//   - PATH finds node, pnpm, go and the workspace binaries;
//   - HOME is where pnpm/corepack/go keep their caches and config;
//   - TMPDIR, TMP and TEMP are where tools write scratch files.
//
// Their values are machine-specific by nature (a different checkout, user or
// runner) and describe where tools live, not what they produce: toolchain
// versions are keyed by cache.RuntimeFingerprint. Hashing them would split a
// shared store per machine, so a task that needs any other host variable (for
// example NODE_ENV) must declare it in devkit.yaml `env`.
//
// CI=true is not passed by this list and does not need to be: devkit reads it
// itself, in its own process, to print whole failure logs (cmd/run.go
// failLineLimit). A task whose behaviour depends on CI declares it.
var alwaysPassedEnv = []string{"PATH", "HOME", "TMPDIR", "TMP", "TEMP"}

// toolchainLocationEnv is the part of each toolchain's environment that says
// where its caches and installs live. It is passed to every task when set and
// never hashed, for the reason above: a different location is a different
// machine, not a different output.
//
//   - go: GOCACHE (build cache), GOMODCACHE and GOPATH (module cache and
//     workspace), GOROOT (the SDK actions/setup-go selects);
//   - node: COREPACK_HOME and PNPM_HOME (where corepack and pnpm are installed),
//     XDG_CACHE_HOME and XDG_CONFIG_HOME (where they look for caches and config).
var toolchainLocationEnv = []string{
	"GOCACHE", "GOMODCACHE", "GOPATH", "GOROOT",
	"COREPACK_HOME", "PNPM_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
}

// toolchainOutputEnv is the part of each toolchain's environment that changes
// what a build produces. It is passed to every task when set and hashed into
// the key (when unset it is absent from the key, so a host that sets none of
// them keeps the same keys):
//
//   - go: GOFLAGS (build flags such as -mod or -tags), GOOS and GOARCH (target),
//     CGO_ENABLED, GOTOOLCHAIN (which compiler version), GOEXPERIMENT.
//
// Node's output-changing variables (NODE_ENV and the like) are task-specific
// and stay declared in devkit.yaml `env`.
var toolchainOutputEnv = []string{"GOFLAGS", "GOOS", "GOARCH", "CGO_ENABLED", "GOTOOLCHAIN", "GOEXPERIMENT"}

// taskEnv is the one description of a task's environment: run is the exact
// KEY=value list the command receives (before devkit's own NODE_PATH), hashed
// the declared variables that enter the task key.
type taskEnv struct {
	run    []string
	hashed []string
}

// taskEnvironment resolves the environment for def from the host process.
// Hashing and execution both read this single result, so what a task is keyed
// on is exactly what it can see.
func taskEnvironment(def TaskDef) taskEnv {
	declared := append([]string(nil), def.Env...)
	sort.Strings(declared)
	var env taskEnv
	seen := make(map[string]bool, len(declared)+len(alwaysPassedEnv))
	for _, name := range declared {
		if seen[name] {
			continue
		}
		seen[name] = true
		if value, ok := os.LookupEnv(name); ok {
			env.run = append(env.run, name+"="+value)
			env.hashed = append(env.hashed, name+"="+value)
		} else {
			// An unset variable and an empty one are different inputs.
			env.hashed = append(env.hashed, name)
		}
	}
	for _, name := range alwaysPassedEnv {
		if seen[name] {
			continue
		}
		seen[name] = true
		if value, ok := os.LookupEnv(name); ok {
			env.run = append(env.run, name+"="+value)
		}
	}
	for _, name := range toolchainLocationEnv {
		if seen[name] {
			continue
		}
		seen[name] = true
		if value, ok := os.LookupEnv(name); ok {
			env.run = append(env.run, name+"="+value)
		}
	}
	for _, name := range toolchainOutputEnv {
		if seen[name] {
			continue
		}
		seen[name] = true
		if value, ok := os.LookupEnv(name); ok {
			env.run = append(env.run, name+"="+value)
			env.hashed = append(env.hashed, name+"="+value)
		}
	}
	return env
}

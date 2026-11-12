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
	return env
}

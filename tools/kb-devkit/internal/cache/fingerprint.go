package cache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"github.com/kb-labs/clikit/toolchain"
)

// FormatVersion is part of every task fingerprint. Bump it whenever the
// on-disk manifest/object format, the input-hash algorithm, or the way outputs
// are collected or restored changes: that is what makes entries written by an
// older devkit unselectable. engine's input-hash golden test fails until the
// bump is made.
const FormatVersion = "kb-devkit-cas-v3"

// RuntimeFingerprint describes what can change generated output when the
// workspace inputs are identical: the cache format and the toolchains that
// run the declared commands. A missing executable is represented explicitly,
// so this function remains deterministic for commands that do not require
// Node or Go.
//
// It deliberately does not cover the devkit executable. The store is shared by
// every worktree of a repository, and worktrees routinely run differently
// built devkit binaries (a different checkout, flags or Go release); keying on
// binary bytes would split the shared store on every such difference even when
// build semantics are identical. Devkit never produces output itself: the
// declared command, inputs and outputs are hashed into the task key, and
// FormatVersion covers devkit's own hashing and restore behaviour.
func RuntimeFingerprint() string {
	parts := []string{FormatVersion}
	for _, command := range [][]string{{"node", "--version"}, {"go", "version"}} {
		output, err := toolchain.Run(context.Background(), toolchain.Invocation{Tool: command[0], Executable: command[0], Args: command[1:], Operation: toolchain.OperationVersionProbe})
		if err != nil {
			parts = append(parts, command[0]+":missing")
			continue
		}
		parts = append(parts, command[0]+":"+strings.TrimSpace(output.Stdout))
	}
	parts = append(parts, "pnpm:"+toolchain.SupportedPnpm)

	digest := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(digest[:])
}

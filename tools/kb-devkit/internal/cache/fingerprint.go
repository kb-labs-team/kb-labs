package cache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"runtime"
	"strings"

	"github.com/kb-labs/clikit/toolchain"
)

// FormatVersion is part of every task fingerprint. Bump it only when the
// on-disk manifest/object format changes incompatibly; old entries remain
// harmless but cannot be selected by a newer devkit.
const FormatVersion = "kb-devkit-cas-v1"

// RuntimeFingerprint describes the tools that can affect generated output.
// A missing executable is represented explicitly, so this function remains
// deterministic for commands that do not require Node or Go.
func RuntimeFingerprint() string {
	parts := []string{FormatVersion, runtime.Version()}
	for _, command := range [][]string{{"node", "--version"}, {"go", "version"}} {
		output, err := toolchain.Run(context.Background(), toolchain.Invocation{Tool: command[0], Executable: command[0], Args: command[1:], Operation: toolchain.OperationVersionProbe})
		if err != nil {
			parts = append(parts, command[0]+":missing")
			continue
		}
		parts = append(parts, command[0]+":"+strings.TrimSpace(output.Stdout))
	}
	parts = append(parts, "pnpm:"+toolchain.SupportedPnpm)

	// The executable hash invalidates entries when the devkit implementation
	// changes even if devkit.yaml stays identical.
	if executable, err := os.Executable(); err == nil {
		if bytes, err := os.ReadFile(executable); err == nil {
			digest := sha256.Sum256(bytes)
			parts = append(parts, "devkit:"+hex.EncodeToString(digest[:]))
		}
	}

	digest := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(digest[:])
}

package catalog

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/kb-labs/create/v2/contracts"
)

// SupportedSchemas lists every release-index schema this launcher can read.
// It is an explicit allow-list: an index whose schema is newer (for example a
// future v3 with a different topology) or simply unknown is rejected before
// any resolution work instead of being half-understood.
var SupportedSchemas = []string{Schema}

const indexInvalidHint = "Retry the command; if it persists report the correlationId (this is a KB Labs problem)."

// CheckSchema rejects an index schema this launcher does not support.
func CheckSchema(schema string) error {
	for _, supported := range SupportedSchemas {
		if schema == supported {
			return nil
		}
	}
	err := contracts.NewLauncherError(contracts.CodeIndexSchemaUnsupported,
		fmt.Sprintf("The release index uses schema %q, which this launcher does not support (supported: %s).", schema, strings.Join(SupportedSchemas, ", ")),
		"Update the launcher (kb-create update, or download the current launcher) and retry.", nil)
	err.Details = map[string]string{"schema": schema, "supported": strings.Join(SupportedSchemas, ",")}
	return err
}

// peekSchema reads only the schema field so that an index of a newer shape is
// rejected on its schema, not on an incidental decode failure.
func peekSchema(data []byte) (string, error) {
	var head struct {
		Schema string `json:"schema"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return "", err
	}
	return head.Schema, nil
}

// wrapIndexError keeps a typed launcher error intact so its code reaches the
// user; any other failure becomes a generic invalid-index error.
func wrapIndexError(prefix string, err error) error {
	var typed *contracts.LauncherError
	if errors.As(err, &typed) {
		return typed
	}
	return contracts.NewLauncherError(contracts.CodeReleaseIndexInvalid, "The release index is corrupted or invalid.", indexInvalidHint, fmt.Errorf("%s: %w", prefix, err))
}

// CheckLauncher enforces the platform's optional minLauncherVersion. An empty
// constraint means no constraint. A launcher without a parsable release
// version (a local "dev" build) is not constrained.
func CheckLauncher(platform PlatformBundle, launcherVersion string) error {
	if platform.MinLauncherVersion == "" {
		return nil
	}
	minimum, ok := parseSemver(platform.MinLauncherVersion)
	if !ok {
		return contracts.NewLauncherError(contracts.CodeReleaseIndexInvalid,
			fmt.Sprintf("Platform %s declares an invalid minLauncherVersion %q.", platform.Version, platform.MinLauncherVersion), indexInvalidHint, nil)
	}
	current, ok := parseSemver(launcherVersion)
	if !ok || compareSemver(current, minimum) >= 0 {
		return nil
	}
	err := contracts.NewLauncherError(contracts.CodeLauncherTooOld,
		fmt.Sprintf("Platform %s requires launcher %s or newer, but this is %s.", platform.Version, platform.MinLauncherVersion, launcherVersion),
		"Run kb-create update, or download the current launcher, then retry.", nil)
	err.Details = map[string]string{"platform": platform.Version, "minLauncherVersion": platform.MinLauncherVersion, "launcher": launcherVersion}
	return err
}

type semver struct {
	core       [3]int
	prerelease string
}

func parseSemver(value string) (semver, bool) {
	value = strings.TrimPrefix(strings.TrimSpace(value), "v")
	if at := strings.Index(value, "+"); at >= 0 {
		value = value[:at]
	}
	var result semver
	if at := strings.Index(value, "-"); at >= 0 {
		result.prerelease, value = value[at+1:], value[:at]
	}
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return semver{}, false
	}
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return semver{}, false
		}
		result.core[i] = n
	}
	return result, true
}

func compareSemver(a, b semver) int {
	for i := range a.core {
		if a.core[i] != b.core[i] {
			if a.core[i] > b.core[i] {
				return 1
			}
			return -1
		}
	}
	switch {
	case a.prerelease == b.prerelease:
		return 0
	case a.prerelease == "":
		return 1
	case b.prerelease == "":
		return -1
	case a.prerelease > b.prerelease:
		return 1
	default:
		return -1
	}
}

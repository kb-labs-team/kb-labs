// Package tempdirguard fails a test binary whose run leaves new entries under
// temp prefixes it owns in the shared temp directory. TestMain takes the
// guard before m.Run and checks it after its own cleanup; helper children the
// suite re-execs share the same temp directory, so the parent's check observes
// their leaks too.
package tempdirguard

import (
	"fmt"
	"os"
	"sort"
	"strings"
)

// Own records the temp directory entries whose names start with one of the
// owned prefixes and returns a check that reports the new entries remaining
// once the suite's own cleanup has run. The check returns sorted names; an
// audit of the temp directory itself that fails is reported as its single
// element so the package still fails with the reason.
func Own(ownedPrefixes ...string) func() []string {
	snapshot, snapshotErr := ownedEntries(ownedPrefixes)
	before := make(map[string]bool, len(snapshot))
	for _, name := range snapshot {
		before[name] = true
	}
	return func() []string {
		after, afterErr := ownedEntries(ownedPrefixes)
		if snapshotErr != nil {
			return []string{snapshotErr.Error()}
		}
		if afterErr != nil {
			return []string{afterErr.Error()}
		}
		var leaked []string
		for _, name := range after {
			if !before[name] {
				leaked = append(leaked, name)
			}
		}
		return leaked
	}
}

func ownedEntries(ownedPrefixes []string) ([]string, error) {
	entries, err := os.ReadDir(os.TempDir())
	if err != nil {
		return nil, fmt.Errorf("audit temp dir %s: %w", os.TempDir(), err)
	}
	var owned []string
	for _, entry := range entries {
		for _, prefix := range ownedPrefixes {
			if strings.HasPrefix(entry.Name(), prefix) {
				owned = append(owned, entry.Name())
				break
			}
		}
	}
	sort.Strings(owned)
	return owned, nil
}

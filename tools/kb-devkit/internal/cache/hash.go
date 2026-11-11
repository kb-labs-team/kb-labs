// Package cache implements content-addressable caching for task execution.
package cache

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// HashInputs computes a deterministic SHA256 hash over all files matching
// the given glob patterns.
//
// Patterns without a leading "^" are resolved relative to pkgDir.
// Patterns with a leading "^" are resolved relative to each dir in depDirs —
// this makes the hash sensitive to workspace dependency outputs (e.g. dist/).
// depDirs may be nil; "^" patterns are then no-ops (no files matched).
//
// Hash keys for dep files are expressed as paths relative to pkgDir
// (e.g. "../../../core/dist/index.js") so the hash is machine-independent
// and safe to use with future remote cache backends.
//
// Hash input: sorted list of (unique path key + content) for every matched file.
// Skips node_modules, .git, dist, .turbo, coverage automatically.
func HashInputs(pkgDir string, depDirs []string, patterns []string) (string, error) {
	return HashInputsWithFingerprint(pkgDir, depDirs, patterns, "")
}

// HashInputsWithFingerprint is HashInputs with an additional stable task
// fingerprint. The fingerprint is used for inputs which aren't files in a
// package (the command, cache format, and toolchain). Keeping it in the same
// digest prevents a remote CAS entry from surviving a semantic task change.
func HashInputsWithFingerprint(pkgDir string, depDirs []string, patterns []string, fingerprint string) (string, error) {
	return hashInputs(pkgDir, depDirs, patterns, fingerprint, "", "", "")
}

// HashInputsWithOwnership includes global and package-owned tracked-file
// digests in addition to generated dependency outputs and task semantics.
func HashInputsWithOwnership(pkgDir string, depDirs []string, patterns []string, fingerprint, globalDigest, ownedDigest, dependencyDigest string) (string, error) {
	return hashInputs(pkgDir, depDirs, patterns, fingerprint, globalDigest, ownedDigest, dependencyDigest)
}

// TrackedFile records Git's index mode and object ID for one tracked path.
// Mode comes from ls-files, never from checkout filesystem permissions.
type TrackedFile struct {
	Mode     uint32
	ObjectID string
}

// ContentDigest hashes supplied tracked paths, Git modes, and current
// working-tree contents. A deleted tracked path contributes a deletion marker.
func ContentDigest(workspaceRoot string, files []string, tracked map[string]TrackedFile) (string, error) {
	files = uniqueSorted(files)
	h := sha256.New()
	for _, file := range files {
		rel, err := filepath.Rel(workspaceRoot, file)
		if err != nil {
			return "", err
		}
		path := filepath.ToSlash(rel)
		entry, ok := tracked[filepath.Clean(file)]
		if !ok {
			return "", fmt.Errorf("tracked metadata missing for %s", file)
		}
		switch entry.Mode {
		case 0100644, 0100755, 0120000, 0160000:
		default:
			return "", fmt.Errorf("unsupported Git mode %o for %s", entry.Mode, file)
		}
		var content []byte
		if entry.Mode == 0160000 {
			content = []byte(entry.ObjectID)
		} else {
			_, err = os.Lstat(file)
			if os.IsNotExist(err) {
				content = []byte("deleted")
			} else if err != nil {
				return "", err
			} else {
				switch entry.Mode {
				case 0120000:
					link, err := os.Readlink(file)
					if err != nil {
						return "", err
					}
					content = []byte(link)
				case 0100644, 0100755:
					content, err = os.ReadFile(file)
					if err != nil {
						return "", err
					}
				}
			}
		}
		contentDigest := sha256.Sum256(content)
		var pathLength [8]byte
		binary.BigEndian.PutUint64(pathLength[:], uint64(len(path)))
		var mode [4]byte
		binary.BigEndian.PutUint32(mode[:], entry.Mode)
		_, _ = h.Write(pathLength[:])
		_, _ = io.WriteString(h, path)
		_, _ = h.Write(mode[:])
		_, _ = h.Write(contentDigest[:])
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func hashInputs(pkgDir string, depDirs []string, patterns []string, fingerprint, globalDigest, ownedDigest, dependencyDigest string) (string, error) {
	type entry struct {
		key  string // sort key written into hash (unique across local + dep files)
		path string // absolute path for reading
	}

	seen := make(map[string]entry)

	// Partition patterns once to avoid per-pattern WalkDir calls.
	var localPatterns, depPatterns []string
	for _, p := range patterns {
		if strings.HasPrefix(p, "^") {
			depPatterns = append(depPatterns, strings.TrimPrefix(p, "^"))
		} else {
			localPatterns = append(localPatterns, p)
		}
	}

	// One expandGlobs call for all local patterns (single WalkDir over pkgDir).
	if len(localPatterns) > 0 {
		rels, err := expandGlobs(pkgDir, localPatterns, true)
		if err != nil {
			return "", err
		}
		for _, rel := range rels {
			if _, dup := seen[rel]; !dup {
				seen[rel] = entry{key: rel, path: filepath.Join(pkgDir, rel)}
			}
		}
	}

	// One expandGlobs call per dep dir for declared dependency output patterns.
	for _, depDir := range depDirs {
		if len(depPatterns) == 0 {
			break
		}
		rels, err := expandGlobs(depDir, depPatterns, false)
		if err != nil {
			return "", err
		}
		for _, rel := range rels {
			absPath := filepath.Join(depDir, rel)
			// Key is relative to pkgDir — machine-independent across checkouts.
			// Falls back to absPath only if the two dirs are on different drives (Windows).
			relKey, err := filepath.Rel(pkgDir, absPath)
			if err != nil {
				relKey = absPath
			}
			relKey = filepath.ToSlash(relKey)
			if _, dup := seen[relKey]; !dup {
				seen[relKey] = entry{key: relKey, path: absPath}
			}
		}
	}

	keys := make([]string, 0, len(seen))
	for k := range seen {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	h := sha256.New()
	if fingerprint != "" {
		_, _ = io.WriteString(h, "task-fingerprint\x00")
		_, _ = io.WriteString(h, fingerprint)
		_, _ = io.WriteString(h, "\x00")
	}
	if globalDigest != "" {
		_, _ = io.WriteString(h, "global-inputs\x00")
		_, _ = io.WriteString(h, globalDigest)
		_, _ = io.WriteString(h, "\x00")
	}
	if ownedDigest != "" {
		_, _ = io.WriteString(h, "owned-inputs\x00"+ownedDigest+"\x00")
	}
	if dependencyDigest != "" {
		_, _ = io.WriteString(h, "dependency-inputs\x00"+dependencyDigest+"\x00")
	}
	for _, key := range keys {
		e := seen[key]
		_, _ = io.WriteString(h, e.key+"\x00")

		f, err := os.Open(e.path)
		if err != nil {
			return "", err
		}
		_, err = io.Copy(h, f)
		f.Close()
		if err != nil {
			return "", err
		}
		_, _ = io.WriteString(h, "\x00")
	}

	return hex.EncodeToString(h.Sum(nil)), nil
}

func uniqueSorted(files []string) []string {
	seen := make(map[string]struct{}, len(files))
	result := make([]string, 0, len(files))
	for _, file := range files {
		file = filepath.Clean(file)
		if _, ok := seen[file]; ok {
			continue
		}
		seen[file] = struct{}{}
		result = append(result, file)
	}
	sort.Strings(result)
	return result
}

// CombineContentDigests hashes named package digests in a stable order.
func CombineContentDigests(digests map[string]string) string {
	names := make([]string, 0, len(digests))
	for name := range digests {
		names = append(names, name)
	}
	sort.Strings(names)
	h := sha256.New()
	for _, name := range names {
		_, _ = io.WriteString(h, name+"\x00"+digests[name]+"\x00")
	}
	return hex.EncodeToString(h.Sum(nil))
}

func expandGlobs(root string, patterns []string, skipDist bool) ([]string, error) {
	seen := make(map[string]bool)

	for _, pattern := range patterns {
		err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}

			rel, _ := filepath.Rel(root, path)

			if d.IsDir() {
				if shouldSkipDir(d.Name(), skipDist) {
					return filepath.SkipDir
				}
				return nil
			}

			if matchGlob(pattern, rel) {
				seen[rel] = true
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}

	result := make([]string, 0, len(seen))
	for rel := range seen {
		result = append(result, rel)
	}
	sort.Strings(result)
	return result, nil
}

// matchGlob matches a path against a glob pattern.
// Supports: *, **, literal segments.
// Uses / as separator regardless of OS.
func matchGlob(pattern, path string) bool {
	// Normalize to forward slashes.
	pattern = filepath.ToSlash(pattern)
	path = filepath.ToSlash(path)

	return matchGlobParts(strings.Split(pattern, "/"), strings.Split(path, "/"))
}

func matchGlobParts(patParts, pathParts []string) bool {
	for len(patParts) > 0 {
		pat := patParts[0]
		patParts = patParts[1:]

		if pat == "**" {
			// ** matches zero or more path segments.
			// Try matching the rest of pattern against every suffix of pathParts.
			for i := 0; i <= len(pathParts); i++ {
				if matchGlobParts(patParts, pathParts[i:]) {
					return true
				}
			}
			return false
		}

		if len(pathParts) == 0 {
			return false
		}

		if !matchSingleSeg(pat, pathParts[0]) {
			return false
		}
		pathParts = pathParts[1:]
	}

	return len(pathParts) == 0
}

// matchSingleSeg matches a single path segment against a pattern segment.
// Supports * as wildcard within one segment.
func matchSingleSeg(pat, seg string) bool {
	if pat == "*" {
		return true
	}
	// filepath.Match handles * within a single segment.
	ok, _ := filepath.Match(pat, seg)
	return ok
}

func shouldSkipDir(name string, skipDist bool) bool {
	switch name {
	case "node_modules", ".git", ".turbo", "coverage", "__pycache__", ".cache":
		return true
	case "dist":
		return skipDist
	}
	return strings.HasPrefix(name, ".")
}

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

// DependencyInput records one declared task prerequisite whose local inputs
// and outputs participate in the consumer's cache key.
type DependencyInput struct {
	Package     string
	Task        string
	Dir         string
	Inputs      []string
	Outputs     []string
	Fingerprint string
	Tracked     map[string]TrackedFile
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

// HashUntrackedInputs hashes untracked files matched by the task's
// package-local input patterns. Tracked files are already covered by workspace
// ownership digests. Output paths are excluded so a generated file cannot
// become its own input when the input and output patterns overlap. Git-ignored
// files remain eligible inputs unless the task declares them as outputs.
func HashUntrackedInputs(pkgDir string, trackedFiles []string, inputPatterns, outputPatterns []string) (string, error) {
	return HashUntrackedInputsExcluding(pkgDir, trackedFiles, inputPatterns, outputPatterns, nil)
}

// HashUntrackedInputsExcluding hashes declared local inputs while excluding
// nested workspace package roots owned by another package.
func HashUntrackedInputsExcluding(pkgDir string, trackedFiles []string, inputPatterns, outputPatterns, excludedDirs []string) (string, error) {
	return hashLocalInputs(pkgDir, trackedFiles, nil, inputPatterns, outputPatterns, true, excludedDirs)
}

// HashLocalInputs hashes task-local inputs from the current package contents.
// Unlike the workspace ownership digest, this is evaluated when the task is
// ready, after its prerequisites may have generated inputs.
func HashLocalInputs(pkgDir string, inputPatterns, outputPatterns []string) (string, error) {
	return HashLocalInputsWithTrackedMetadata(pkgDir, nil, inputPatterns, outputPatterns)
}

// HashLocalInputsWithTrackedMetadata hashes current local inputs while using
// the Git index mode for tracked paths. This allows generated inputs to be
// read after prerequisites without making chmod-only checkout differences
// alter tracked-file keys.
func HashLocalInputsWithTrackedMetadata(pkgDir string, trackedMetadata map[string]TrackedFile, inputPatterns, outputPatterns []string) (string, error) {
	return hashLocalInputs(pkgDir, nil, trackedMetadata, inputPatterns, outputPatterns, false, nil)
}

func hashLocalInputs(pkgDir string, trackedFiles []string, trackedMetadata map[string]TrackedFile, inputPatterns, outputPatterns []string, onlyUntracked bool, excludedDirs []string) (string, error) {
	var localPatterns, explicitDistPatterns []string
	for _, pattern := range inputPatterns {
		if strings.HasPrefix(pattern, "^") {
			continue
		}
		if patternHasDirSegment(pattern, "dist") {
			explicitDistPatterns = append(explicitDistPatterns, pattern)
		} else {
			localPatterns = append(localPatterns, pattern)
		}
	}
	if len(localPatterns) == 0 && len(explicitDistPatterns) == 0 {
		return "", nil
	}
	matchedSet := make(map[string]struct{})
	for _, group := range []struct {
		patterns []string
		skipDist bool
	}{{patterns: localPatterns, skipDist: true}, {patterns: explicitDistPatterns, skipDist: false}} {
		if len(group.patterns) == 0 {
			continue
		}
		files, err := expandGlobsExcluding(pkgDir, group.patterns, group.skipDist, excludedDirs)
		if err != nil {
			return "", err
		}
		for _, file := range files {
			matchedSet[file] = struct{}{}
		}
	}
	matched := make([]string, 0, len(matchedSet))
	for file := range matchedSet {
		matched = append(matched, file)
	}
	sort.Strings(matched)
	if len(matched) == 0 {
		return "", nil
	}

	tracked := make(map[string]struct{}, len(trackedFiles))
	for _, file := range trackedFiles {
		rel, err := filepath.Rel(pkgDir, file)
		if err != nil {
			return "", err
		}
		tracked[filepath.ToSlash(filepath.Clean(rel))] = struct{}{}
	}

	files := make([]string, 0, len(matched))
	metadata := make(map[string]TrackedFile)
	for _, rel := range matched {
		rel = filepath.ToSlash(filepath.Clean(rel))
		abs := filepath.Join(pkgDir, filepath.FromSlash(rel))
		if isUnderAnyDir(abs, excludedDirs) {
			continue
		}
		if _, ok := tracked[rel]; onlyUntracked && ok {
			continue
		}
		isOutput := false
		for _, pattern := range outputPatterns {
			if !strings.HasPrefix(pattern, "^") && matchGlob(pattern, rel) {
				isOutput = true
				break
			}
		}
		if isOutput {
			continue
		}
		info, err := os.Lstat(abs)
		if err != nil {
			return "", err
		}
		mode := uint32(0100644)
		if info.Mode()&os.ModeSymlink != 0 {
			mode = 0120000
		} else if info.Mode().Perm()&0111 != 0 {
			mode = 0100755
		}
		files = append(files, abs)
		if trackedMode, ok := trackedMetadata[filepath.Clean(abs)]; ok {
			mode = trackedMode.Mode
		}
		metadata[filepath.Clean(abs)] = TrackedFile{Mode: mode}
	}
	if len(files) == 0 {
		return "", nil
	}
	return ContentDigest(pkgDir, files, metadata)
}

func isUnderAnyDir(file string, dirs []string) bool {
	for _, dir := range dirs {
		rel, err := filepath.Rel(dir, file)
		if err == nil && (rel == "." || (!filepath.IsAbs(rel) && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))) {
			return true
		}
	}
	return false
}

func patternHasDirSegment(pattern, name string) bool {
	for _, segment := range strings.Split(filepath.ToSlash(filepath.Clean(pattern)), "/") {
		if segment == name {
			return true
		}
	}
	return false
}

// HashDependencyInputs hashes each prerequisite's declared local inputs and
// outputs. Dependency files may live in dist/ and are read after the producer
// finishes.
func HashDependencyInputs(pkgDir string, inputs []DependencyInput) (string, error) {
	if len(inputs) == 0 {
		return "", nil
	}
	digests := make(map[string]string, len(inputs))
	for _, input := range inputs {
		patterns := make([]string, 0, len(input.Inputs))
		for _, pattern := range input.Inputs {
			patterns = append(patterns, pattern)
		}
		localDigest, err := HashLocalInputsWithTrackedMetadata(input.Dir, input.Tracked, patterns, input.Outputs)
		if err != nil {
			return "", err
		}
		outputDigest, err := HashLocalInputs(input.Dir, input.Outputs, nil)
		if err != nil {
			return "", err
		}
		digests[input.Package+"\x00"+input.Task] = CombineContentDigests(map[string]string{
			"fingerprint": input.Fingerprint,
			"inputs":      localDigest,
			"outputs":     outputDigest,
		})
	}
	if len(digests) == 0 {
		return "", nil
	}
	return CombineContentDigests(digests), nil
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
	return expandGlobsExcluding(root, patterns, skipDist, nil)
}

func expandGlobsExcluding(root string, patterns []string, skipDist bool, excludedDirs []string) ([]string, error) {
	seen := make(map[string]bool)
	patterns = uniqueSorted(patterns)
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}

		rel, _ := filepath.Rel(root, path)

		if d.IsDir() {
			if isUnderAnyDir(path, excludedDirs) {
				return filepath.SkipDir
			}
			if shouldSkipDir(d.Name(), skipDist, filepath.ToSlash(rel), patterns) {
				return filepath.SkipDir
			}
			return nil
		}

		for _, pattern := range patterns {
			if matchGlob(pattern, rel) {
				seen[rel] = true
				break
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
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

func shouldSkipDir(name string, skipDist bool, relDir string, patterns []string) bool {
	switch name {
	case "node_modules", ".git", ".turbo", "__pycache__":
		return true
	case "dist":
		return skipDist
	case "coverage", ".cache":
		if !patternExplicitDir(patterns, relDir) {
			return true
		}
	}
	if !strings.HasPrefix(name, ".") {
		return false
	}
	return !patternExplicitDir(patterns, relDir)
}

func patternExplicitDir(patterns []string, relDir string) bool {
	for _, pattern := range patterns {
		pattern = filepath.ToSlash(pattern)
		patternSegments := strings.Split(pattern, "/")
		for _, dirSegment := range strings.Split(filepath.ToSlash(relDir), "/") {
			if !strings.HasPrefix(dirSegment, ".") && dirSegment != "coverage" && dirSegment != ".cache" {
				continue
			}
			for _, patternSegment := range patternSegments {
				if patternSegment == dirSegment {
					return true
				}
			}
		}
	}
	return false
}

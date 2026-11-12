package cache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/kb-labs/clikit/toolchain"
)

// SharedDirName is the directory, inside the repository's git common
// directory, that holds the object and manifest store shared by every worktree.
const SharedDirName = "kb-devkit"

// SharedRoot returns the location of the content-addressed store (objects and
// manifests) for the repository that owns wsRoot.
//
// Every worktree of one repository reports the same git common directory, so
// the store is shared without configuration. The common directory is not part
// of any checkout: removing a worktree never removes cached outputs, and the
// store is never committed or cloned. A workspace root that is not itself the
// top level of a git repository is its own repository: its store lives under
// <wsRoot>/.kb/devkit/shared, so a fixture nested in another repository never
// writes into that repository's git directory.
func SharedRoot(wsRoot string) (string, error) {
	top, err := gitOutput(wsRoot, "rev-parse", "--show-toplevel")
	if err != nil || !sameDir(top, wsRoot) {
		return filepath.Join(wsRoot, ".kb", "devkit", "shared"), nil
	}
	common, err := gitOutput(wsRoot, "rev-parse", "--git-common-dir")
	if err != nil {
		return "", fmt.Errorf("resolve git common directory of %s: %w", wsRoot, err)
	}
	if !filepath.IsAbs(common) {
		common = filepath.Join(wsRoot, common)
	}
	return filepath.Join(filepath.Clean(common), SharedDirName), nil
}

func gitOutput(dir string, args ...string) (string, error) {
	result, err := toolchain.Run(context.Background(), toolchain.Invocation{Tool: "git", Executable: "git", Args: args, Dir: dir, Operation: toolchain.OperationVersionProbe})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(result.Stdout), nil
}

func sameDir(a, b string) bool {
	left, err := filepath.EvalSymlinks(a)
	if err != nil {
		return false
	}
	right, err := filepath.EvalSymlinks(b)
	if err != nil {
		return false
	}
	return left == right
}

// Usage describes the size of a store, for status and doctor output.
type Usage struct {
	Root      string `json:"root"`
	Objects   int    `json:"objects"`
	Manifests int    `json:"manifests"`
	Bytes     int64  `json:"bytes"`
}

// Describe measures the store at root. A store that does not exist yet is empty.
func Describe(root string) (Usage, error) {
	usage := Usage{Root: root}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if os.IsNotExist(walkErr) && path == root {
				return filepath.SkipAll
			}
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		usage.Bytes += info.Size()
		rel, _ := filepath.Rel(root, path)
		switch strings.SplitN(filepath.ToSlash(rel), "/", 2)[0] {
		case "objects":
			usage.Objects++
		case "tasks":
			usage.Manifests++
		}
		return nil
	})
	return usage, err
}

// Verify proves the store is internally consistent: every object's content
// matches its address and every manifest parses and references only objects
// that exist. It returns one message per problem found.
func Verify(root string) ([]string, error) {
	var problems []string
	objectsRoot := filepath.Join(root, "objects")
	err := filepath.WalkDir(objectsRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if os.IsNotExist(walkErr) && path == objectsRoot {
				return filepath.SkipAll
			}
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(objectsRoot, path)
		address := strings.ReplaceAll(filepath.ToSlash(rel), "/", "")
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		digest := sha256.New()
		if _, err := io.Copy(digest, file); err != nil {
			return err
		}
		if got := hex.EncodeToString(digest.Sum(nil)); got != address {
			problems = append(problems, fmt.Sprintf("object %s has content hash %s", address, got))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	tasksRoot := filepath.Join(root, "tasks")
	err = filepath.WalkDir(tasksRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if os.IsNotExist(walkErr) && path == tasksRoot {
				return filepath.SkipAll
			}
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var manifest Manifest
		if err := json.Unmarshal(data, &manifest); err != nil {
			problems = append(problems, fmt.Sprintf("manifest %s does not parse: %v", filepath.ToSlash(rel), err))
			return nil
		}
		for _, ref := range manifest.Outputs {
			if _, err := os.Stat(filepath.Join(objectsRoot, ref.Object[:2], ref.Object[2:])); err != nil {
				problems = append(problems, fmt.Sprintf("manifest %s references missing object %s", filepath.ToSlash(rel), ref.Object))
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return problems, nil
}

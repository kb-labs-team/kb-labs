package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// ObjectStore is the content-addressable storage backend.
// Objects are immutable and keyed by SHA256 of their content.
// The same content stored twice → same key, no duplication.
//
// Future implementations: S3Store, R2Store, GCSStore — zero engine changes.
type ObjectStore interface {
	// Has returns true if the object exists.
	Has(sha256hex string) bool

	// Get returns a reader for the object content.
	// Caller must close the reader.
	Get(sha256hex string) (io.ReadCloser, error)

	// Put stores content under its SHA256 key.
	// Computes the hash while writing — caller does not need to pre-compute.
	// Returns the SHA256 hex of stored content.
	Put(r io.Reader) (sha256hex string, err error)

	// PutFile stores a file by path. Returns its SHA256 hex.
	PutFile(path string) (sha256hex string, err error)

	// RestoreFile writes the object to destPath, creating parent dirs.
	RestoreFile(sha256hex, destPath string, mode os.FileMode) error
}

// LocalStore is a file-system content-addressable store.
// Layout: <root>/objects/<ab>/<cdef...>
// Atomic writes: stage in <root>/tmp/, rename on success.
type LocalStore struct {
	root string // e.g. .kb/devkit
}

// NewLocalStore creates (or opens) a LocalStore at root.
func NewLocalStore(root string) (*LocalStore, error) {
	for _, sub := range []string{"objects", "tasks", "tmp"} {
		if err := os.MkdirAll(filepath.Join(root, sub), 0o755); err != nil {
			return nil, fmt.Errorf("cache init: %w", err)
		}
	}
	return &LocalStore{root: root}, nil
}

func (s *LocalStore) objectPath(sha256hex string) string {
	if len(sha256hex) < 4 {
		return filepath.Join(s.root, "objects", sha256hex)
	}
	return filepath.Join(s.root, "objects", sha256hex[:2], sha256hex[2:])
}

func (s *LocalStore) Has(sha256hex string) bool {
	_, err := os.Stat(s.objectPath(sha256hex))
	return err == nil
}

func (s *LocalStore) Get(sha256hex string) (io.ReadCloser, error) {
	f, err := os.Open(s.objectPath(sha256hex))
	if err != nil {
		return nil, fmt.Errorf("cache get %s: %w", sha256hex[:8], err)
	}
	return f, nil
}

func (s *LocalStore) Put(r io.Reader) (string, error) {
	// Stage: write to tmp file while computing hash.
	tmp, err := os.CreateTemp(filepath.Join(s.root, "tmp"), "obj-")
	if err != nil {
		return "", fmt.Errorf("cache stage: %w", err)
	}
	tmpPath := tmp.Name()

	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), r); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return "", fmt.Errorf("cache write: %w", err)
	}
	tmp.Close()

	hex := hex.EncodeToString(h.Sum(nil))
	dest := s.objectPath(hex)

	if s.Has(hex) {
		// Already exists — dedup, discard tmp.
		os.Remove(tmpPath)
		return hex, nil
	}

	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		os.Remove(tmpPath)
		return "", err
	}

	// Atomic rename.
	if err := os.Rename(tmpPath, dest); err != nil {
		os.Remove(tmpPath)
		return "", fmt.Errorf("cache commit: %w", err)
	}

	return hex, nil
}

func (s *LocalStore) PutFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("cache put file %s: %w", path, err)
	}
	defer f.Close()
	return s.Put(f)
}

func (s *LocalStore) RestoreFile(sha256hex, destPath string, mode os.FileMode) error {
	src, err := s.Get(sha256hex)
	if err != nil {
		return err
	}
	defer src.Close()

	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return err
	}

	// Stage then rename for atomicity.
	tmp, err := os.CreateTemp(filepath.Dir(destPath), ".restore-")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()

	if _, err := io.Copy(tmp, src); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	tmp.Close()

	return os.Rename(tmpPath, destPath)
}

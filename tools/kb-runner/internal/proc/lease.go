//go:build darwin || linux

package proc

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"syscall"
)

type LeaseMode string

const (
	LeaseShared       LeaseMode = "shared"
	LeaseExclusive    LeaseMode = "exclusive"
	LeaseExclusiveTry LeaseMode = "exclusive-try"
)

var ErrLeaseBusy = errors.New("proc: lease is held")

type FileLease struct {
	file *os.File
	once sync.Once
	err  error
}

func AcquireFileLease(path string, mode LeaseMode) (*FileLease, bool, error) {
	if path == "" {
		return nil, false, errors.New("proc: lease path is required")
	}
	var operation int
	switch mode {
	case LeaseShared:
		operation = syscall.LOCK_SH
	case LeaseExclusive:
		operation = syscall.LOCK_EX
	case LeaseExclusiveTry:
		operation = syscall.LOCK_EX | syscall.LOCK_NB
	default:
		return nil, false, fmt.Errorf("proc: unsupported lease mode %q", mode)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, false, fmt.Errorf("proc: create lease directory: %w", err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, false, fmt.Errorf("proc: open lease file %s: %w", path, err)
	}
	if err := syscall.Flock(int(file.Fd()), operation); err != nil {
		closeErr := file.Close()
		if mode == LeaseExclusiveTry && (errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN)) {
			return nil, false, errors.Join(closeErr)
		}
		return nil, false, errors.Join(fmt.Errorf("proc: acquire %s lease %s: %w", mode, path, err), closeErr)
	}
	return &FileLease{file: file}, true, nil
}

func (lease *FileLease) Close() error {
	if lease == nil {
		return nil
	}
	lease.once.Do(func() {
		if lease.file != nil {
			lease.err = lease.file.Close()
		}
	})
	return lease.err
}

func CostKeyLeasePath(stateDir, key string) string {
	digest := sha256.Sum256([]byte(key))
	return filepath.Join(stateDir, "cost-key-leases", fmt.Sprintf("%x.lock", digest))
}

type leaseRequest struct {
	path string
	mode LeaseMode
}

func acquireConfigLeases(cfg Config) ([]*FileLease, error) {
	requests := make([]leaseRequest, 0, len(cfg.SharedLeasePaths)+1)
	for _, path := range cfg.SharedLeasePaths {
		requests = append(requests, leaseRequest{path: path, mode: LeaseShared})
	}
	if cfg.CostKey != "" {
		mode := cfg.CostKeyLeaseMode
		if mode == "" {
			mode = LeaseShared
		}
		requests = append(requests, leaseRequest{path: CostKeyLeasePath(cfg.StateDir, cfg.CostKey), mode: mode})
	} else if cfg.CostKeyLeaseMode != "" {
		return nil, errors.New("proc: cost-key lease mode requires a cost key")
	}
	sort.Slice(requests, func(i, j int) bool { return requests[i].path < requests[j].path })
	leases := make([]*FileLease, 0, len(requests))
	seen := map[string]LeaseMode{}
	for _, request := range requests {
		if prior, exists := seen[request.path]; exists {
			if prior != request.mode {
				return nil, errors.Join(fmt.Errorf("proc: conflicting lease modes for %s", request.path), closeFileLeases(leases))
			}
			continue
		}
		lease, acquired, err := AcquireFileLease(request.path, request.mode)
		if err != nil {
			return nil, errors.Join(err, closeFileLeases(leases))
		}
		if !acquired {
			return nil, errors.Join(ErrLeaseBusy, closeFileLeases(leases))
		}
		leases = append(leases, lease)
		seen[request.path] = request.mode
	}
	return leases, nil
}

func closeFileLeases(leases []*FileLease) error {
	var closeErr error
	for index := len(leases) - 1; index >= 0; index-- {
		closeErr = errors.Join(closeErr, leases[index].Close())
	}
	return closeErr
}

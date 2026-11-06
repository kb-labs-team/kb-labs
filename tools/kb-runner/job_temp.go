//go:build darwin || linux

package main

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

func reapJobTemp(jobsDir, id string) (uint64, bool, string, string) {
	tempDir := zcodeJobTemp(AgentRequest{StateDir: filepath.Dir(jobsDir), JobID: id})
	info, err := os.Lstat(tempDir)
	if os.IsNotExist(err) {
		return 0, false, "", ""
	}
	if err != nil {
		return 0, true, err.Error(), tempDir
	}
	var reclaimed uint64
	var failure error
	failurePath := tempDir
	if info.IsDir() {
		err = filepath.WalkDir(tempDir, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				failure = fmt.Errorf("%s: %w", path, walkErr)
				failurePath = path
				return fs.SkipAll
			}
			entryInfo, err := entry.Info()
			if err != nil {
				failure = fmt.Errorf("%s: %w", path, err)
				failurePath = path
				return fs.SkipAll
			}
			if entry.IsDir() {
				if err := os.Chmod(path, 0o700); err != nil {
					failure = fmt.Errorf("%s: %w", path, err)
					failurePath = path
					return fs.SkipAll
				}
			} else if entryInfo.Mode().IsRegular() {
				reclaimed += uint64(entryInfo.Size())
				if err := os.Chmod(path, 0o600); err != nil {
					failure = fmt.Errorf("%s: %w", path, err)
					failurePath = path
					return fs.SkipAll
				}
			}
			return nil
		})
		if err != nil && failure == nil {
			failure = err
		}
	} else if info.Mode().IsRegular() {
		reclaimed = uint64(info.Size())
		if err := os.Chmod(tempDir, 0o600); err != nil {
			failure = err
		}
	}
	if failure != nil {
		return reclaimed, true, failure.Error(), failurePath
	}
	if err := os.RemoveAll(tempDir); err != nil {
		return reclaimed, true, err.Error(), tempDir
	}
	return reclaimed, true, "", ""
}

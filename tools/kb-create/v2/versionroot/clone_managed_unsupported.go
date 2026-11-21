//go:build !darwin && !linux

package versionroot

import "io/fs"

func cloneManagedFile(string, string, fs.FileMode) (bool, error) { return false, nil }

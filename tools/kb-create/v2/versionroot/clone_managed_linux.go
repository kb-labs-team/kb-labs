//go:build linux

package versionroot

import (
	"io/fs"
	"os"

	"golang.org/x/sys/unix"
)

func cloneManagedFile(source, target string, mode fs.FileMode) (bool, error) {
	sourceFile, err := os.Open(source)
	if err != nil {
		return false, nil
	}
	defer sourceFile.Close()
	targetFile, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return false, nil
	}
	if err := unix.IoctlFileClone(int(targetFile.Fd()), int(sourceFile.Fd())); err != nil {
		_ = targetFile.Close()
		_ = os.Remove(target)
		return false, nil
	}
	if err := targetFile.Sync(); err != nil {
		_ = targetFile.Close()
		_ = os.Remove(target)
		return false, nil
	}
	if err := targetFile.Close(); err != nil {
		_ = os.Remove(target)
		return false, nil
	}
	return true, nil
}

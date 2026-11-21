//go:build darwin

package versionroot

import (
	"io/fs"
	"os"

	"golang.org/x/sys/unix"
)

func cloneManagedFile(source, target string, mode fs.FileMode) (bool, error) {
	if err := unix.Clonefile(source, target, 0); err != nil {
		_ = os.Remove(target)
		return false, nil
	}
	file, err := os.OpenFile(target, os.O_WRONLY, mode)
	if err != nil {
		_ = os.Remove(target)
		return false, nil
	}
	err = file.Sync()
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		_ = os.Remove(target)
		return false, nil
	}
	return true, nil
}

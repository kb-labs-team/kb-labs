//go:build darwin

package proc

import (
	"errors"
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

func resourceIdentity(_ string, info os.FileInfo) (fileIdentity, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fileIdentity{}, os.ErrInvalid
	}
	return fileIdentity{Device: uint64(stat.Dev), Inode: uint64(stat.Ino)}, nil
}

func ownerXattrMissing(err error) bool { return errors.Is(err, unix.ENOATTR) }

func directoryDescriptorPath(fd int) (string, error) {
	var path [1024]byte
	_, _, errno := unix.Syscall(unix.SYS_FCNTL, uintptr(fd), uintptr(unix.F_GETPATH), uintptr(unsafe.Pointer(&path[0])))
	if errno != 0 {
		return "", errno
	}
	return unix.ByteSliceToString(path[:]), nil
}

const pathOwnerXattrName = "com.kb-runner.owner"

func filesystemName(path string) string {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return "filesystem containing " + path
	}
	return unix.ByteSliceToString(stat.Fstypename[:])
}

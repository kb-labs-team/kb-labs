//go:build linux

package proc

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

func resourceIdentity(_ string, info os.FileInfo) (fileIdentity, error) {
	statInfo, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fileIdentity{}, os.ErrInvalid
	}
	return fileIdentity{Device: uint64(statInfo.Dev), Inode: statInfo.Ino}, nil
}

func ownerXattrMissing(err error) bool { return errors.Is(err, unix.ENODATA) }

func directoryDescriptorPath(fd int) (string, error) {
	return os.Readlink(filepath.Join("/proc/self/fd", strconv.Itoa(fd)))
}

const pathOwnerXattrName = "user.kb-runner.owner"

func filesystemName(path string) string {
	absolute, err := filepath.Abs(path)
	if err != nil {
		absolute = filepath.Clean(path)
	}
	if data, err := os.ReadFile("/proc/self/mountinfo"); err == nil {
		bestLength := -1
		bestName := ""
		for _, line := range strings.Split(string(data), "\n") {
			sections := strings.SplitN(line, " - ", 2)
			if len(sections) != 2 {
				continue
			}
			mountFields, fsFields := strings.Fields(sections[0]), strings.Fields(sections[1])
			if len(mountFields) < 5 || len(fsFields) < 1 {
				continue
			}
			mountpoint := filepath.Clean(unescapeMountField(mountFields[4]))
			relative, err := filepath.Rel(mountpoint, absolute)
			if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || len(mountpoint) <= bestLength {
				continue
			}
			bestLength, bestName = len(mountpoint), fsFields[0]
		}
		if bestName != "" {
			return bestName
		}
	}
	var stat unix.Statfs_t
	if err := unix.Statfs(absolute, &stat); err == nil {
		return fmt.Sprintf("filesystem type 0x%x", stat.Type)
	}
	return "filesystem containing " + absolute
}

func unescapeMountField(value string) string {
	return strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`).Replace(value)
}

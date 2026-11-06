//go:build darwin || linux

package proc

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

var errOwnedPathAlreadyGone = errors.New("owned path is already gone")

func removeOwnedPathRelative(stateDir, path string, expected fileIdentity, ownerToken string, additionalRoots []string) error {
	return removePathRelative(stateDir, path, &expected, ownerToken, nil, additionalRoots)
}

func removeScratchPathRelative(stateDir, path string, expected fileIdentity, keepPaths []string) error {
	root, err := scratchRoot()
	if err != nil {
		return err
	}
	return removePathRelative(stateDir, path, &expected, "", keepPaths, []string{root})
}

func removePathRelative(stateDir, path string, expected *fileIdentity, ownerToken string, keepPaths []string, additionalRoots []string) (result error) {
	root, relative, err := cleanupRootForPath(stateDir, path, additionalRoots)
	if err != nil {
		return err
	}
	rootFD, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
			return &OwnedPathRefusalError{Reason: fmt.Sprintf("cleanup root %q became a symlink", root)}
		}
		return fmt.Errorf("open cleanup root %q: %w", root, err)
	}
	defer func() { result = errors.Join(result, unix.Close(rootFD)) }()

	parts := strings.Split(relative, string(filepath.Separator))
	parentFD := rootFD
	opened := make([]int, 0, len(parts))
	defer func() {
		for _, fd := range opened {
			result = errors.Join(result, unix.Close(fd))
		}
	}()
	for _, part := range parts[:len(parts)-1] {
		fd, err := unix.Openat(parentFD, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
		if err != nil {
			if errors.Is(err, unix.ENOENT) {
				return errOwnedPathAlreadyGone
			}
			if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
				return &OwnedPathRefusalError{Reason: fmt.Sprintf("owned path parent %q is not a real directory", part)}
			}
			return fmt.Errorf("open owned path parent %q without following symlinks: %w", part, err)
		}
		opened = append(opened, fd)
		parentFD = fd
	}
	name := parts[len(parts)-1]
	var before unix.Stat_t
	if err := unix.Fstatat(parentFD, name, &before, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return errOwnedPathAlreadyGone
		}
		return fmt.Errorf("inspect owned path without following symlinks: %w", err)
	}
	if before.Mode&unix.S_IFMT == unix.S_IFLNK {
		return &OwnedPathRefusalError{Reason: "owned path became a symlink before cleanup"}
	}
	if expected != nil && !statIdentityMatches(before, *expected) {
		return &OwnedPathRefusalError{Reason: "path device/inode changed after registration"}
	}
	flags := unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW
	if before.Mode&unix.S_IFMT == unix.S_IFDIR {
		flags |= unix.O_DIRECTORY
	}
	objectFD, err := unix.Openat(parentFD, name, flags, 0)
	if err != nil {
		if errors.Is(err, unix.ELOOP) {
			return &OwnedPathRefusalError{Reason: "path became a symlink while opening for cleanup"}
		}
		return fmt.Errorf("open owned path without following symlinks: %w", err)
	}
	defer func() { result = errors.Join(result, unix.Close(objectFD)) }()
	var openedStat unix.Stat_t
	if err := unix.Fstat(objectFD, &openedStat); err != nil {
		return fmt.Errorf("inspect opened owned path: %w", err)
	}
	if (expected != nil && !statIdentityMatches(openedStat, *expected)) || openedStat.Dev != before.Dev || openedStat.Ino != before.Ino {
		return &OwnedPathRefusalError{Reason: "path device/inode changed while opening for cleanup"}
	}
	if ownerToken != "" {
		size, err := unix.Fgetxattr(objectFD, pathOwnerXattrName, nil)
		if err != nil {
			if ownerXattrMissing(err) {
				return &OwnedPathRefusalError{Reason: "path ownership xattr is missing after registration"}
			}
			return fmt.Errorf("read path ownership xattr: %w", err)
		}
		token := make([]byte, size)
		read, err := unix.Fgetxattr(objectFD, pathOwnerXattrName, token)
		if err != nil {
			if ownerXattrMissing(err) {
				return &OwnedPathRefusalError{Reason: "path ownership xattr is missing after registration"}
			}
			return fmt.Errorf("read path ownership xattr: %w", err)
		}
		if string(token[:read]) != ownerToken {
			return &OwnedPathRefusalError{Reason: "path ownership xattr does not match the registered owner nonce"}
		}
	}
	if len(keepPaths) > 0 {
		keepPaths, err = existingKeepPaths(objectFD, path, keepPaths)
		if err != nil {
			return err
		}
	}

	if err := requireDescriptorWithinRoot(rootFD, parentFD); err != nil {
		return err
	}
	if openedStat.Mode&unix.S_IFMT == unix.S_IFDIR {
		if err := removeDirectoryContents(rootFD, objectFD, path, keepPaths, unixOwnedDirectoryModeOps{}); err != nil {
			return err
		}
		if preserve, _ := keptScratchPath(path, keepPaths); preserve {
			return nil
		}
	}
	if err := requireDescriptorWithinRoot(rootFD, parentFD); err != nil {
		return err
	}
	var final unix.Stat_t
	if err := unix.Fstatat(parentFD, name, &final, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return fmt.Errorf("recheck owned path before unlink: %w", err)
	}
	if final.Mode&unix.S_IFMT == unix.S_IFLNK || final.Dev != openedStat.Dev || final.Ino != openedStat.Ino {
		return &OwnedPathRefusalError{Reason: "path changed after ownership verification"}
	}
	flags = 0
	if openedStat.Mode&unix.S_IFMT == unix.S_IFDIR {
		flags = unix.AT_REMOVEDIR
	}
	if err := unix.Unlinkat(parentFD, name, flags); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return nil
		}
		return fmt.Errorf("remove owned path relative to cleanup root: %w", err)
	}
	return nil
}

func existingKeepPaths(rootFD int, rootPath string, candidates []string) ([]string, error) {
	var existing []string
	rootPath = filepath.Clean(rootPath)
	for _, candidate := range candidates {
		absolute, err := filepath.Abs(candidate)
		if err != nil {
			return nil, fmt.Errorf("resolve kept scratch path: %w", err)
		}
		absolute = filepath.Clean(absolute)
		relative, err := filepath.Rel(rootPath, absolute)
		if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
			continue
		}
		parts := strings.Split(relative, string(filepath.Separator))
		fd, err := unix.Dup(rootFD)
		if err != nil {
			return nil, fmt.Errorf("duplicate scratch descriptor while checking keep path: %w", err)
		}
		found := true
		for index, part := range parts {
			var entry unix.Stat_t
			if err := unix.Fstatat(fd, part, &entry, unix.AT_SYMLINK_NOFOLLOW); err != nil {
				if errors.Is(err, unix.ENOENT) {
					found = false
					break
				}
				closeErr := unix.Close(fd)
				return nil, errors.Join(fmt.Errorf("inspect kept scratch path %q: %w", absolute, err), closeErr)
			}
			if index == len(parts)-1 {
				break
			}
			if entry.Mode&unix.S_IFMT == unix.S_IFLNK || entry.Mode&unix.S_IFMT != unix.S_IFDIR {
				closeErr := unix.Close(fd)
				return nil, errors.Join(&OwnedPathRefusalError{Reason: fmt.Sprintf("kept scratch path parent %q is not a real directory", part)}, closeErr)
			}
			next, err := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
			if err != nil {
				closeErr := unix.Close(fd)
				return nil, errors.Join(fmt.Errorf("open kept scratch path parent %q without following symlinks: %w", part, err), closeErr)
			}
			if err := unix.Close(fd); err != nil {
				nextCloseErr := unix.Close(next)
				return nil, errors.Join(fmt.Errorf("close kept scratch path parent: %w", err), nextCloseErr)
			}
			fd = next
		}
		if err := unix.Close(fd); err != nil {
			return nil, fmt.Errorf("close kept scratch path descriptor: %w", err)
		}
		if found {
			existing = append(existing, absolute)
		}
	}
	return existing, nil
}

func cleanupRootForPath(stateDir, path string, additionalRoots []string) (string, string, error) {
	absolute, err := normalizeCleanupPath(stateDir, path)
	if err != nil {
		return "", "", err
	}
	roots, err := cleanupRoots(stateDir)
	if err != nil {
		return "", "", fmt.Errorf("read configured cleanup roots: %w", err)
	}
	roots = append(roots, additionalRoots...)
	for _, root := range roots {
		relative, err := filepath.Rel(root, filepath.Clean(absolute))
		if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			continue
		}
		if filepath.IsAbs(relative) {
			continue
		}
		return root, relative, nil
	}
	return "", "", fmt.Errorf("path %q is outside configured cleanup roots", absolute)
}

func statIdentityMatches(stat unix.Stat_t, expected fileIdentity) bool {
	return uint64(stat.Dev) == expected.Device && uint64(stat.Ino) == expected.Inode
}

func requireDescriptorWithinRoot(rootFD, directoryFD int) error {
	rootPath, err := directoryDescriptorPath(rootFD)
	if err != nil {
		return fmt.Errorf("resolve cleanup root descriptor: %w", err)
	}
	directoryPath, err := directoryDescriptorPath(directoryFD)
	if err != nil {
		return fmt.Errorf("resolve owned directory descriptor: %w", err)
	}
	relative, err := filepath.Rel(rootPath, directoryPath)
	if err != nil {
		return fmt.Errorf("compare owned directory with cleanup root: %w", err)
	}
	if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return &OwnedPathRefusalError{Reason: "owned path parent moved outside configured cleanup root"}
	}
	return nil
}

type ownedDirectoryModeOps interface {
	Fchmod(fd int, mode uint32) error
}

type unixOwnedDirectoryModeOps struct{}

func (unixOwnedDirectoryModeOps) Fchmod(fd int, mode uint32) error {
	return unix.Fchmod(fd, mode)
}

func removeDirectoryContents(rootFD, fd int, path string, keepPaths []string, modeOps ownedDirectoryModeOps) (result error) {
	if err := requireDescriptorWithinRoot(rootFD, fd); err != nil {
		return err
	}
	var before unix.Stat_t
	if err := unix.Fstat(fd, &before); err != nil {
		return fmt.Errorf("inspect owned directory permissions %q: %w", path, err)
	}
	preserve, _ := keptScratchPath(path, keepPaths)
	modeChanged := before.Mode&0o700 != 0o700
	if modeChanged {
		if err := modeOps.Fchmod(fd, uint32(before.Mode|0o700)); err != nil {
			return fmt.Errorf("restore owner access to owned directory %q: %w", path, err)
		}
	}
	if modeChanged {
		defer func() {
			if !preserve && result == nil {
				return
			}
			if err := modeOps.Fchmod(fd, uint32(before.Mode&0o7777)); err != nil {
				result = errors.Join(result, fmt.Errorf("restore owned directory permissions %q: %w", path, err))
			}
		}()
	}
	duplicate, err := unix.Dup(fd)
	if err != nil {
		return fmt.Errorf("duplicate owned directory descriptor: %w", err)
	}
	unix.CloseOnExec(duplicate)
	directory := os.NewFile(uintptr(duplicate), "owned directory")
	names, err := directory.Readdirnames(-1)
	closeErr := directory.Close()
	if err != nil || closeErr != nil {
		return errors.Join(err, closeErr)
	}
	for _, name := range names {
		childPath := filepath.Join(path, name)
		preserve, exactKeep := keptScratchPath(childPath, keepPaths)
		if exactKeep {
			continue
		}
		if err := requireDescriptorWithinRoot(rootFD, fd); err != nil {
			return err
		}
		var child unix.Stat_t
		if err := unix.Fstatat(fd, name, &child, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			if errors.Is(err, unix.ENOENT) {
				continue
			}
			return fmt.Errorf("inspect owned directory child %q: %w", name, err)
		}
		if child.Mode&unix.S_IFMT == unix.S_IFDIR {
			childFD, err := unix.Openat(fd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
			if err != nil {
				return fmt.Errorf("open owned directory child %q: %w", name, err)
			}
			childKeeps := keepPaths
			if !preserve {
				childKeeps = nil
			}
			err = removeDirectoryContents(rootFD, childFD, childPath, childKeeps, modeOps)
			closeErr := unix.Close(childFD)
			if err != nil || closeErr != nil {
				return errors.Join(err, closeErr)
			}
			if err := requireDescriptorWithinRoot(rootFD, fd); err != nil {
				return err
			}
			if err := unix.Unlinkat(fd, name, unix.AT_REMOVEDIR); err != nil && !errors.Is(err, unix.ENOENT) {
				return fmt.Errorf("remove owned directory child %q: %w", name, err)
			}
			continue
		}
		if preserve {
			return &OwnedPathRefusalError{Reason: fmt.Sprintf("kept scratch path %q is not a real directory", childPath)}
		}
		if err := requireDescriptorWithinRoot(rootFD, fd); err != nil {
			return err
		}
		if err := unix.Unlinkat(fd, name, 0); err != nil && !errors.Is(err, unix.ENOENT) {
			return fmt.Errorf("remove owned file child %q: %w", name, err)
		}
	}
	return nil
}

func keptScratchPath(path string, keepPaths []string) (preserve, exact bool) {
	for _, keep := range keepPaths {
		if path == keep {
			return true, true
		}
		if strings.HasPrefix(keep, path+string(filepath.Separator)) {
			preserve = true
		}
	}
	return preserve, false
}

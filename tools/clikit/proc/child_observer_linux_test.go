//go:build linux

package proc

import (
	"io/fs"
	"syscall"
	"testing"
)

func TestChildProcessVanishedCoversExitDuringRead(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"open after exit", &fs.PathError{Op: "open", Path: "/proc/1/stat", Err: syscall.ENOENT}, true},
		{"read after reap", &fs.PathError{Op: "read", Path: "/proc/1/stat", Err: syscall.ESRCH}, true},
		{"permission", &fs.PathError{Op: "open", Path: "/proc/1/stat", Err: syscall.EACCES}, false},
	}
	for _, c := range cases {
		if got := childProcessVanished(c.err); got != c.want {
			t.Errorf("%s: childProcessVanished = %v, want %v", c.name, got, c.want)
		}
	}
}

//go:build linux

package host

import (
	"bytes"
	"os"
	"strconv"
)

// processZombie reports whether pid is dead and only waiting for its parent
// to reap it. The state letter follows the last ")" of /proc/<pid>/stat,
// because the command name before it may itself contain spaces or parentheses.
func processZombie(pid int) bool {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return false
	}
	end := bytes.LastIndexByte(data, ')')
	return end >= 0 && end+2 < len(data) && data[end+2] == 'Z'
}
